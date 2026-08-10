import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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
