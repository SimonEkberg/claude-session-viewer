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
  const wanted = `${id}.jsonl`;
  // Fast path: a previously-parsed file — but verify it still exists. If it was
  // deleted or moved outside this tool, drop the stale cache entry and fall
  // through, so callers get a clean null → 404 instead of a later ENOENT → 500.
  for (const file of cache.keys()) {
    if (path.basename(file) === wanted) {
      if (fs.existsSync(file)) return file;
      cache.delete(file);
    }
  }
  for (const file of listTranscriptFiles()) {
    if (path.basename(file) === wanted) return file;
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

// projectSlug is lossy (it replaces '/', '\' and ':' all with '-'), so a project
// folder name can't be reliably turned back into a real path — any directory that
// genuinely contains '-' gets mangled. Every session in one project folder shares
// the same cwd (the folder name is derived from it), so we read the REAL cwd out of
// one transcript instead. Cached by that file's mtime so it costs ~nothing per call.
const projectCwdCache = new Map<string, { mtimeMs: number; cwd: string | null }>();

/** Best-effort inverse of projectSlug — only correct for paths without a real '-'. */
function slugToPath(dir: string): string {
  return dir.replace(/^([A-Za-z])-/, '$1:\\').replace(/-/g, '\\');
}

/** The cwd recorded in a transcript's first lines (Claude Code stamps it per line). */
function sampleCwd(file: string): string | null {
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
  const hit = projectCwdCache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.cwd;

  let cwd: string | null = null;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(65536); // the cwd is on the first line(s); no need to read the whole file
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      for (const line of buf.toString('utf8', 0, n).split('\n')) {
        if (!line.trim()) continue;
        try {
          const o = JSON.parse(line);
          if (typeof o.cwd === 'string' && o.cwd) {
            cwd = o.cwd;
            break;
          }
        } catch {
          /* a truncated final line in the chunk — earlier lines already tried */
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* unreadable — fall back to the slug */
  }
  projectCwdCache.set(file, { mtimeMs, cwd });
  return cwd;
}

export function listProjects(): ProjectInfo[] {
  // One sample transcript per project is enough to recover its real cwd.
  const info = new Map<string, { count: number; sample: string }>();
  for (const f of listTranscriptFiles()) {
    const dir = path.basename(path.dirname(f));
    const e = info.get(dir);
    if (e) e.count++;
    else info.set(dir, { count: 1, sample: f });
  }
  return [...info.entries()]
    .map(([dir, e]) => ({
      dir,
      cwdGuess: sampleCwd(e.sample) || slugToPath(dir),
      sessionCount: e.count,
    }))
    .sort((a, b) => b.sessionCount - a.sessionCount);
}
