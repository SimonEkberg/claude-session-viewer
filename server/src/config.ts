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

/** Path to the Claude Code CLI used to launch new sessions. */
export const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

/**
 * Claude Code encodes a session's working directory into its project folder name
 * by replacing every '/', '\' and ':' with '-'.  e.g.  C:\Users\simon -> C--Users-simon
 * We reproduce that so a launched session's transcript file is known up-front.
 */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[/\\:]/g, '-');
}
