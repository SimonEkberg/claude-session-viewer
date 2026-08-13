import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SESSIONS_ROOT, AUTH_MODE, BROWSE_ROOTS } from './config.js';

/** Confine browsing when the server is exposed beyond loopback (see BROWSE_ROOTS). */
const CONFINED = AUTH_MODE !== 'off';

function allowedRoots(home: string): string[] {
  return [home, SESSIONS_ROOT, path.dirname(SESSIONS_ROOT), ...BROWSE_ROOTS].map((r) => path.resolve(r));
}

function within(target: string, roots: string[]): boolean {
  const t = path.resolve(target);
  return roots.some((r) => {
    const rel = path.relative(r, t);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
}

/**
 * Minimal server-side directory browser for the "New session" working-directory
 * picker. A browser can't read the filesystem, so the UI walks directories through
 * this endpoint. Lists sub-directories (the only thing a cwd picker needs), plus a
 * few common roots as shortcuts. Read-only; no writes, no globbing, no file bodies.
 */
export interface FsEntry {
  name: string;
  path: string;
  isDir: boolean;
}

export interface FsListing {
  path: string;
  parent: string | null;
  sep: string;
  home: string;
  roots: string[];
  entries: FsEntry[];
}

export function listDir(input?: string): FsListing {
  const home = os.homedir();
  let dir = input && input.trim() ? path.resolve(input) : home;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(dir);
    if (!stat.isDirectory()) dir = path.dirname(dir);
  } catch {
    dir = home; // fall back rather than error on a bad path
  }

  // When exposed beyond loopback, deny anything outside the allowed roots.
  if (CONFINED && !within(dir, allowedRoots(home))) dir = home;

  const entries: FsEntry[] = [];
  try {
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith('.')) continue; // hide dotfiles/dirs for signal
      const full = path.join(dir, name);
      let s: fs.Stats;
      try {
        s = fs.statSync(full);
      } catch {
        continue;
      }
      entries.push({ name, path: full, isDir: s.isDirectory() });
    }
  } catch {
    // unreadable dir → empty listing
  }

  entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));

  const parent = path.dirname(dir);
  return {
    path: dir,
    parent: parent === dir ? null : parent,
    sep: path.sep,
    home,
    roots: commonRoots(home),
    entries,
  };
}

function commonRoots(home: string): string[] {
  // When confined, advertise only the allowed roots (no drive-letter shortcuts).
  if (CONFINED) return allowedRoots(home).filter(safeIsDir);
  const roots = new Set<string>([home]);
  const desktop = path.join(home, 'Desktop');
  if (safeIsDir(desktop)) roots.add(desktop);
  if (process.platform === 'win32') {
    for (const letter of ['C:\\', 'D:\\']) if (safeIsDir(letter)) roots.add(letter);
  } else {
    roots.add('/');
  }
  return [...roots];
}

function safeIsDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
