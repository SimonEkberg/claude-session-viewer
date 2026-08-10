import fs from 'node:fs';
import path from 'node:path';
import { SESSIONS_ROOT } from './config.js';
import { parseSession, summarize, type FullSession, type SessionSummary } from './transcript.js';

/**
 * Discovers <project>/<session-id>.jsonl files under SESSIONS_ROOT and parses them
 * on demand. Parsed sessions are cached by mtime so re-opening a session (or the
 * SSE tail re-reading after a change) is cheap; a changed file re-parses.
 */

const cache = new Map<string, { mtimeMs: number; session: FullSession }>();

export interface ProjectInfo {
  dir: string;
  cwdGuess: string;
  sessionCount: number;
}

function listTranscriptFiles(): string[] {
  if (!fs.existsSync(SESSIONS_ROOT)) return [];
  const out: string[] = [];
  for (const projectDir of fs.readdirSync(SESSIONS_ROOT)) {
    const full = path.join(SESSIONS_ROOT, projectDir);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    for (const f of fs.readdirSync(full)) {
      if (f.endsWith('.jsonl')) out.push(path.join(full, f));
    }
  }
  return out;
}

export function getSession(id: string): FullSession | null {
  const file = findFile(id);
  if (!file) return null;
  return loadFile(file);
}

export function loadFile(file: string): FullSession {
  const mtimeMs = fs.statSync(file).mtimeMs;
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.session;
  const session = parseSession(file);
  cache.set(file, { mtimeMs, session });
  return session;
}

export function findFile(id: string): string | null {
  // Fast path: derive from cache
  for (const file of cache.keys()) {
    if (path.basename(file) === `${id}.jsonl`) return file;
  }
  for (const file of listTranscriptFiles()) {
    if (path.basename(file) === `${id}.jsonl`) return file;
  }
  return null;
}

export function listSessions(projectDir?: string): SessionSummary[] {
  const files = listTranscriptFiles().filter(
    (f) => !projectDir || path.basename(path.dirname(f)) === projectDir,
  );
  const summaries = files.map((f) => {
    try {
      return summarize(loadFile(f));
    } catch {
      return null;
    }
  });
  return summaries
    .filter((s): s is SessionSummary => !!s)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Deletes a session's transcript (and its companion <id>/ dir if present). Safe by
 * construction: we never build a path from the raw id — we resolve it via findFile
 * (which only matches real files under SESSIONS_ROOT), then re-check containment
 * before any rm. Throws {code} on not-found / out-of-root.
 */
export function deleteSession(id: string): { deleted: string[] } {
  const file = findFile(id);
  if (!file) throw Object.assign(new Error('session not found'), { code: 404 });

  const root = path.resolve(SESSIONS_ROOT) + path.sep;
  const resolved = path.resolve(file);
  if (!resolved.startsWith(root)) {
    throw Object.assign(new Error('refusing to delete outside the sessions root'), { code: 400 });
  }

  const deleted: string[] = [];
  fs.rmSync(resolved, { force: true });
  cache.delete(file);
  deleted.push(resolved);

  // Some sessions have a companion "<id>/" directory next to the .jsonl.
  const dir = path.resolve(path.join(path.dirname(resolved), id));
  if (dir.startsWith(root) && fs.existsSync(dir)) {
    try {
      if (fs.statSync(dir).isDirectory()) {
        fs.rmSync(dir, { recursive: true, force: true });
        deleted.push(dir);
      }
    } catch {
      /* ignore companion-dir failures */
    }
  }
  return { deleted };
}

export function listProjects(): ProjectInfo[] {
  const counts = new Map<string, number>();
  for (const f of listTranscriptFiles()) {
    const dir = path.basename(path.dirname(f));
    counts.set(dir, (counts.get(dir) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([dir, sessionCount]) => ({
      dir,
      // best-effort inverse of the projectSlug encoding for display
      cwdGuess: dir.replace(/^([A-Za-z])-/, '$1:\\').replace(/-/g, '\\'),
      sessionCount,
    }))
    .sort((a, b) => b.sessionCount - a.sessionCount);
}
