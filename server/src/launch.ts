import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CLAUDE_BIN, SESSIONS_ROOT, DATA_DIR, projectSlug } from './config.js';
import { markActive, markInactive } from './activity.js';
import { getPeers, setPeers } from './peers.js';

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ── Session collaboration: attach the read-only `peers` MCP server ──────────────
// When a session has an allowlist, we give its launched CLI a `peers` MCP server
// (list_peers / read_peer) and auto-approve those tools with --allowedTools. The
// server runs the same way this server does (node + the tsx loader, absolute paths
// so it's cwd-independent) and gets the caller's id via env.
const HERE = path.dirname(fileURLToPath(import.meta.url)); // server/src
const REPO_ROOT = path.resolve(HERE, '../..');
const TSX_PREFLIGHT = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'preflight.cjs');
const TSX_LOADER = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs');
const MCP_SCRIPT = path.join(HERE, 'mcp-peers.ts');

function mcpConfigPath(id: string): string {
  return path.join(DATA_DIR, 'mcp', `${id}.json`);
}

function writeMcpConfig(id: string): void {
  const cfg = {
    mcpServers: {
      peers: {
        command: process.execPath, // absolute node — the CLI can exec it from any cwd
        args: ['--require', TSX_PREFLIGHT, '--import', pathToFileURL(TSX_LOADER).href, MCP_SCRIPT],
        env: { CSV_CALLER_ID: id, CSV_DATA_DIR: DATA_DIR, SESSIONS_ROOT },
      },
    },
  };
  fs.mkdirSync(path.dirname(mcpConfigPath(id)), { recursive: true });
  fs.writeFileSync(mcpConfigPath(id), JSON.stringify(cfg, null, 2));
}

/** CLI flags that attach the peers server + auto-allow its tools (empty if no peers). */
function collabFlags(id: string): string[] {
  return ['--mcp-config', mcpConfigPath(id), '--allowedTools', 'mcp__peers__*'];
}

/**
 * Transcript paths of freshly-launched sessions whose file the CLI hasn't created
 * yet. The stream route consults this so it can watch the expected path and begin
 * tailing the moment the file appears, instead of 404ing during CLI startup.
 */
const pendingPaths = new Map<string, string>();
export function expectedFilePath(id: string): string | undefined {
  return pendingPaths.get(id);
}

/**
 * Wire a spawned child's lifetime to the session's active state, and quiet the
 * very high-frequency `thinking_tokens` stdout events (kept for other output).
 */
export interface PromptImage {
  media_type: string; // image/png | image/jpeg | image/gif | image/webp
  data: string; // base64, no "data:" prefix
}

const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_IMAGES = 10;
const MAX_IMAGE_B64 = 7_400_000; // ~5.5 MB decoded — Claude's per-image ceiling, with headroom

/**
 * Validate attached images before they reach the CLI. The data never touches the
 * shell command line (it's written to stdin), so this guards resource use / bad
 * input, not injection: allowed type, sane count, sane per-image size.
 */
function validateImages(images: unknown): PromptImage[] {
  if (images == null) return [];
  if (!Array.isArray(images)) throw new Error('images must be an array');
  if (images.length > MAX_IMAGES) throw new Error(`too many images (max ${MAX_IMAGES})`);
  return images.map((img, i) => {
    const mt = (img as any)?.media_type;
    const data = (img as any)?.data;
    if (!ALLOWED_IMAGE_TYPES.has(mt)) throw new Error(`image ${i}: unsupported type ${mt}`);
    if (typeof data !== 'string' || !data) throw new Error(`image ${i}: missing base64 data`);
    if (data.length > MAX_IMAGE_B64) throw new Error(`image ${i}: too large (max ~5 MB)`);
    return { media_type: mt, data };
  });
}

/**
 * Feed the turn's input to the CLI over stdin (never as a command-line argument), so
 * newlines and shell metacharacters (#, &, |, %, <, >, quotes, backticks…) pass
 * through verbatim — no shell quoting, nothing for cmd.exe to mis-split.
 *
 * With no images this is the plain-text path (default --input-format=text). With
 * images we switch to a single stream-json user message whose content is the text
 * plus one image block each — the native multimodal input the CLI accepts under
 * --input-format=stream-json (verified against claude 2.1.220).
 */
function feedInput(child: ChildProcess, prompt: string, images: PromptImage[]): void {
  const stdin = child.stdin;
  if (!stdin) return;
  stdin.on('error', () => {}); // swallow EPIPE if the child exits before we finish writing
  if (images.length) {
    const content: unknown[] = [];
    if (prompt && prompt.trim()) content.push({ type: 'text', text: prompt });
    for (const img of images) {
      content.push({ type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data } });
    }
    stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n');
  } else {
    stdin.write(prompt);
  }
  stdin.end();
}

function trackChild(child: ChildProcess, id: string, tag: string): void {
  markActive(id);
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    markInactive(id);
  };
  child.stdout?.on('data', (d) => {
    const s = d.toString();
    if (s.includes('"subtype":"thinking_tokens"')) return; // noisy per-100-token deltas
    process.stdout.write(`[${tag} ${id.slice(0, 8)}] ${s}`);
  });
  child.stderr?.on('data', (d) => process.stderr.write(`[${tag} ${id.slice(0, 8)}!] ${d}`));
  child.on('exit', (code) => {
    console.log(`[${tag}] session ${id} turn exited with ${code}`);
    finish();
  });
  child.on('error', (err) => {
    console.error(`[${tag}] failed to spawn claude:`, err);
    finish();
  });
}

export interface LaunchRequest {
  prompt: string;
  cwd?: string;
  model?: string;
  effort?: string; // low | medium | high | xhigh | max (CLI --effort)
  permissionMode?: string; // default | plan | acceptEdits | bypassPermissions
  peers?: string[]; // session ids this new session may read (read-only collaboration)
  images?: PromptImage[]; // pasted/attached screenshots, sent as image content blocks
  dryRun?: boolean;
}

export interface LaunchResult {
  id: string;
  cwd: string;
  projectDir: string;
  filePath: string;
  command: string;
  spawned: boolean;
}

/**
 * Starts a new Claude Code session by shelling out to the CLI in non-interactive
 * (`-p`) streaming mode. We pre-assign the session id with --session-id so we can
 * compute exactly which transcript file it will write, and hand that back to the
 * client to open + live-tail immediately.
 *
 * The child's stdout/stderr is logged server-side; the *content* the UI shows comes
 * from the transcript file it writes, not from the pipe — that keeps live and
 * historical sessions on one identical code path.
 */
export function launchSession(req: LaunchRequest): LaunchResult {
  const images = validateImages(req.images);
  if (!req.prompt?.trim() && !images.length) throw new Error('prompt or an image is required');
  validateModelMode(req.model, req.permissionMode, req.effort);
  const id = crypto.randomUUID();
  const cwd = req.cwd || os.homedir();
  // Validate up front: an invalid cwd makes spawn fail ASYNChronously (ENOENT on the
  // 'error' event) after we've already told the client spawned:true — i.e. the prompt
  // is silently lost. Fail synchronously with a clear 400 instead.
  if (!isDir(cwd)) throw new Error(`working directory does not exist: ${cwd}`);
  const projectDir = projectSlug(cwd);
  const filePath = path.join(SESSIONS_ROOT, projectDir, `${id}.jsonl`);

  // Prompt/images are NOT args — they're piped via stdin (see feedInput). Only safe
  // flag tokens go on the command line.
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--session-id', id];
  if (images.length) args.push('--input-format', 'stream-json'); // enable image content blocks on stdin
  if (req.model) args.push('--model', req.model);
  if (req.effort) args.push('--effort', req.effort);
  if (req.permissionMode) args.push('--permission-mode', req.permissionMode);

  const peers = req.peers ? [...new Set(req.peers.filter((p) => p && p !== id))] : [];
  if (peers.length) args.push(...collabFlags(id)); // preview shows the flags too

  // CLAUDE_BIN is quoted too: a real install path with spaces (C:\Program Files\…\
  // claude.cmd) would otherwise split into a wrong argv and the launch would fail.
  const command = `${quoteArg(CLAUDE_BIN)} ${args.map(quoteArg).join(' ')}`;

  if (req.dryRun) {
    return { id, cwd, projectDir, filePath, command, spawned: false };
  }

  // Persist the allowlist + write the per-session MCP config only on a real launch.
  if (peers.length) {
    setPeers(id, peers);
    writeMcpConfig(id);
  }

  // shell:true so the Windows `claude.cmd` shim resolves; the (safe) flag args are
  // pre-quoted. The prompt is written to stdin, bypassing the shell entirely.
  const child = spawn(command, { cwd, shell: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  feedInput(child, req.prompt, images);
  trackChild(child, id, 'launch');
  pendingPaths.set(id, filePath); // let the stream route tail it before the file exists

  return { id, cwd, projectDir, filePath, command, spawned: true };
}

export interface ResumeRequest {
  prompt: string;
  cwd: string; // the existing session's cwd — resume must run in the same dir
  model?: string;
  effort?: string; // low | medium | high | xhigh | max (CLI --effort)
  permissionMode?: string;
  images?: PromptImage[]; // pasted/attached screenshots, sent as image content blocks
  dryRun?: boolean;
}

export interface ResumeResult {
  id: string;
  command: string;
  spawned: boolean;
}

/**
 * Sends a follow-up prompt into an existing session by resuming it with the CLI.
 * The turn appends to the same transcript file, so the viewer's live tail shows the
 * continuation with no extra wiring.
 */
export function resumeSession(id: string, req: ResumeRequest): ResumeResult {
  const images = validateImages(req.images);
  if (!req.prompt?.trim() && !images.length) throw new Error('prompt or an image is required');
  if (!id) throw new Error('session id is required');
  validateModelMode(req.model, req.permissionMode, req.effort);
  if (!isDir(req.cwd)) throw new Error(`working directory does not exist: ${req.cwd}`);

  // Prompt/images piped via stdin (see feedInput); only safe flag tokens on the command line.
  const args = ['-p', '--resume', id, '--output-format', 'stream-json', '--verbose'];
  if (images.length) args.push('--input-format', 'stream-json'); // enable image content blocks on stdin
  if (req.model) args.push('--model', req.model);
  if (req.effort) args.push('--effort', req.effort);
  if (req.permissionMode) args.push('--permission-mode', req.permissionMode);

  // Re-attach the peers MCP server if this session has an allowlist (so collaboration
  // works on follow-ups too, and picks up allowlist edits made since launch).
  const hasPeers = getPeers(id).length > 0;
  if (hasPeers) args.push(...collabFlags(id));

  const command = `${quoteArg(CLAUDE_BIN)} ${args.map(quoteArg).join(' ')}`;
  if (req.dryRun) return { id, command, spawned: false };

  if (hasPeers) writeMcpConfig(id);

  const child = spawn(command, { cwd: req.cwd, shell: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  feedInput(child, req.prompt, images);
  trackChild(child, id, 'resume');

  return { id, command, spawned: true };
}

// Only the prompt is attacker-controlled and it's on stdin. The remaining args
// must still be validated so nothing dangerous reaches the shell command line:
//  - model: must look like a claude model id (charset has NO shell metacharacters).
//  - permissionMode: strict enum.
//  - effort: strict enum.
// (session id is server-generated; resume id is route-validated as a UUID.)
const MODEL_RE = /^claude-[a-z0-9][a-z0-9._-]{0,60}$/i;
const PERMISSION_MODES = new Set(['default', 'plan', 'acceptEdits', 'bypassPermissions']);
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const EFFORTS = new Set<string>(EFFORT_LEVELS);

export function validateModelMode(model?: string, permissionMode?: string, effort?: string): void {
  if (model && !MODEL_RE.test(model)) throw new Error(`invalid model: ${model}`);
  if (permissionMode && !PERMISSION_MODES.has(permissionMode))
    throw new Error(`invalid permissionMode: ${permissionMode}`);
  if (effort && !EFFORTS.has(effort)) throw new Error(`invalid effort: ${effort}`);
}

// Quote for spawn(command, { shell: true }), which on Windows is cmd.exe. The safe
// charset (flags, UUIDs, validated model ids, install paths without spaces) passes
// through verbatim; anything else is wrapped in double quotes with embedded quotes
// doubled — cmd.exe's own convention (NOT POSIX backslash-escaping).
function quoteArg(a: string): string {
  if (/^[A-Za-z0-9_\-./:\\]+$/.test(a)) return a;
  return `"${a.replace(/"/g, '""')}"`;
}
