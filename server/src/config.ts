import os from 'node:os';
import path from 'node:path';

/**
 * Root that holds one folder per project, each containing <session-id>.jsonl transcripts.
 * Override with SESSIONS_ROOT to point the viewer at any machine/user.
 * Default is Claude Code's own transcript store: ~/.claude/projects
 */
export const SESSIONS_ROOT =
  process.env.SESSIONS_ROOT || path.join(os.homedir(), '.claude', 'projects');

export const PORT = Number(process.env.PORT || 3737);

/**
 * Interface to bind. Defaults to loopback so the RCE-capable endpoints are NOT
 * reachable from other devices on the network. For remote access, set HOST to the
 * Tailscale interface IP (never 0.0.0.0) so only the tailnet can reach it.
 */
export const HOST = process.env.HOST || '127.0.0.1';

/** Allowed browser origins (CORS). Arbitrary sites must not call this API. */
export const CORS_ORIGINS = (
  process.env.CORS_ORIGINS || 'http://localhost:5273,http://127.0.0.1:5273'
).split(',').map((s) => s.trim()).filter(Boolean);

/**
 * Auth. `off` (default) = no gate, for local loopback dev. `tailscale` = require a
 * `Tailscale-User-Login` header whose value is in ALLOWED_LOGINS. That header is
 * injected by `tailscale serve` and STRIPPED from any client-supplied value by
 * Tailscale, so a remote caller can't forge it. Fails closed: if ALLOWED_LOGINS is
 * empty in tailscale mode, every request is denied.
 */
export const AUTH_MODE = (process.env.AUTH_MODE || 'off').toLowerCase();
export const ALLOWED_LOGINS = (process.env.ALLOWED_LOGINS || '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

/** Path to the Claude Code CLI used to launch new sessions. */
export const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

/**
 * Where the viewer keeps its own data: per-session peer allowlists (session
 * collaboration) and the generated per-session MCP config files. Kept out of the
 * repo and out of the transcript store.
 */
export const DATA_DIR = process.env.CSV_DATA_DIR || path.join(os.homedir(), '.claude-session-viewer');

/**
 * Extra directories the New-Session cwd picker may browse. Only enforced when
 * AUTH_MODE !== 'off' (i.e. the server is exposed beyond loopback): in that mode
 * the browse endpoint is confined to home + the sessions root + these roots, so a
 * remote caller can't enumerate the whole filesystem. Loopback-only stays
 * unrestricted so the picker can reach any working directory on your own machine.
 */
export const BROWSE_ROOTS = (process.env.BROWSE_ROOTS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

/**
 * Claude Code encodes a session's working directory into its project folder name
 * by replacing every '/', '\' and ':' with '-'.  e.g.  C:\Users\simon -> C--Users-simon
 * We reproduce that so a launched session's transcript file is known up-front.
 */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[/\\:]/g, '-');
}
