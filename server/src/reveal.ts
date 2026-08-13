import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Open the OS file manager with a file selected (or its folder). Read-only
 * convenience for the "clean these up yourself" workflow — it never modifies
 * anything, it just shows you where a file is.
 *
 * Runs an OS command on the SERVER host, so the caller must gate this to loopback
 * (AUTH_MODE==='off'): revealing on the host is meaningless over Tailscale (it would
 * pop Explorer on the laptop, not your phone) and there's no reason to expose a
 * process-spawn there. We use execFile (NOT a shell), so the path — even one from a
 * transcript — is a single argv element and can't be interpreted as a command.
 *
 * Throws {code:400} if the path doesn't exist on disk.
 */
export function revealInFileManager(target: string): void {
  if (!target || !fs.existsSync(target)) {
    throw Object.assign(new Error('path not found'), { code: 400 });
  }
  const p = path.resolve(target);
  if (process.platform === 'win32') {
    // explorer returns exit code 1 even on success — ignore the callback error.
    execFile('explorer.exe', [`/select,${p}`], () => {});
  } else if (process.platform === 'darwin') {
    execFile('open', ['-R', p], () => {});
  } else {
    // No portable "select file" on Linux — open the containing directory.
    execFile('xdg-open', [path.dirname(p)], () => {});
  }
}
