import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CLAUDE_BIN, SESSIONS_ROOT, projectSlug } from './config.js';
import { markActive, markInactive } from './activity.js';

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
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
/**
 * Feed the prompt to the CLI over stdin instead of as a command-line argument, so
 * newlines and shell metacharacters (#, &, |, %, <, >, quotes, backticks…) pass
 * through verbatim — no shell quoting, nothing for cmd.exe to mis-split.
 */
function feedPrompt(child: ChildProcess, prompt: string): void {
  const stdin = child.stdin;
  if (!stdin) return;
  stdin.on('error', () => {}); // swallow EPIPE if the child exits before we finish writing
  stdin.write(prompt);
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
  permissionMode?: string; // default | plan | acceptEdits | bypassPermissions
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
  if (!req.prompt?.trim()) throw new Error('prompt is required');
  validateModelMode(req.model, req.permissionMode);
  const id = crypto.randomUUID();
  const cwd = req.cwd || os.homedir();
  // Validate up front: an invalid cwd makes spawn fail ASYNChronously (ENOENT on the
  // 'error' event) after we've already told the client spawned:true — i.e. the prompt
  // is silently lost. Fail synchronously with a clear 400 instead.
  if (!isDir(cwd)) throw new Error(`working directory does not exist: ${cwd}`);
  const projectDir = projectSlug(cwd);
  const filePath = path.join(SESSIONS_ROOT, projectDir, `${id}.jsonl`);

  // Prompt is NOT an arg — it's piped via stdin (see feedPrompt). Only safe flag
  // tokens go on the command line.
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--session-id', id];
  if (req.model) args.push('--model', req.model);
  if (req.permissionMode) args.push('--permission-mode', req.permissionMode);

  // CLAUDE_BIN is quoted too: a real install path with spaces (C:\Program Files\…\
  // claude.cmd) would otherwise split into a wrong argv and the launch would fail.
  const command = `${quoteArg(CLAUDE_BIN)} ${args.map(quoteArg).join(' ')}`;

  if (req.dryRun) {
    return { id, cwd, projectDir, filePath, command, spawned: false };
  }

  // shell:true so the Windows `claude.cmd` shim resolves; the (safe) flag args are
  // pre-quoted. The prompt is written to stdin, bypassing the shell entirely.
  const child = spawn(command, { cwd, shell: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  feedPrompt(child, req.prompt);
  trackChild(child, id, 'launch');
  pendingPaths.set(id, filePath); // let the stream route tail it before the file exists

  return { id, cwd, projectDir, filePath, command, spawned: true };
}

export interface ResumeRequest {
  prompt: string;
  cwd: string; // the existing session's cwd — resume must run in the same dir
  model?: string;
  permissionMode?: string;
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
  if (!req.prompt?.trim()) throw new Error('prompt is required');
  if (!id) throw new Error('session id is required');
  validateModelMode(req.model, req.permissionMode);
  if (!isDir(req.cwd)) throw new Error(`working directory does not exist: ${req.cwd}`);

  // Prompt piped via stdin (see feedPrompt); only safe flag tokens on the command line.
  const args = ['-p', '--resume', id, '--output-format', 'stream-json', '--verbose'];
  if (req.model) args.push('--model', req.model);
  if (req.permissionMode) args.push('--permission-mode', req.permissionMode);

  const command = `${quoteArg(CLAUDE_BIN)} ${args.map(quoteArg).join(' ')}`;
  if (req.dryRun) return { id, command, spawned: false };

  const child = spawn(command, { cwd: req.cwd, shell: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  feedPrompt(child, req.prompt);
  trackChild(child, id, 'resume');

  return { id, command, spawned: true };
}

// Only the prompt is attacker-controlled and it's on stdin. The remaining args
// must still be validated so nothing dangerous reaches the shell command line:
//  - model: must look like a claude model id (charset has NO shell metacharacters).
//  - permissionMode: strict enum.
// (session id is server-generated; resume id is route-validated as a UUID.)
const MODEL_RE = /^claude-[a-z0-9][a-z0-9._-]{0,60}$/i;
const PERMISSION_MODES = new Set(['default', 'plan', 'acceptEdits', 'bypassPermissions']);

export function validateModelMode(model?: string, permissionMode?: string): void {
  if (model && !MODEL_RE.test(model)) throw new Error(`invalid model: ${model}`);
  if (permissionMode && !PERMISSION_MODES.has(permissionMode))
    throw new Error(`invalid permissionMode: ${permissionMode}`);
}

// Quote for spawn(command, { shell: true }), which on Windows is cmd.exe. The safe
// charset (flags, UUIDs, validated model ids, install paths without spaces) passes
// through verbatim; anything else is wrapped in double quotes with embedded quotes
// doubled — cmd.exe's own convention (NOT POSIX backslash-escaping).
function quoteArg(a: string): string {
  if (/^[A-Za-z0-9_\-./:\\]+$/.test(a)) return a;
  return `"${a.replace(/"/g, '""')}"`;
}
