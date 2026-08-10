#!/usr/bin/env node
// Compatibility preflight. Run `npm run check` on any machine to see what's ready
// before `npm run dev`. Dependency-free, read-only.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ok = (m) => console.log(`  ✓ ${m}`);
const warn = (m) => console.log(`  ⚠ ${m}`);
const bad = (m) => console.log(`  ✗ ${m}`);

let hardFail = false;
console.log('\nClaude Session Viewer — compatibility check\n');

// --- OS ---
console.log(`Platform: ${process.platform} (${process.arch})`);
if (process.platform === 'win32') ok('Windows — fully tested (reading + launching/resuming).');
else warn(`${process.platform} — reading/visualizing works; launching/resuming sessions is Windows-tested, not yet verified here. Test the "New session" button before relying on it.`);

// --- Node ---
const major = Number(process.versions.node.split('.')[0]);
console.log(`\nNode: v${process.versions.node}`);
if (major >= 18) ok('Node >= 18.');
else { bad('Node 18+ required.'); hardFail = true; }

// --- claude CLI (only needed to START/RESUME sessions) ---
const bin = process.env.CLAUDE_BIN || 'claude';
console.log(`\nClaude CLI (${bin}):`);
try {
  const r = spawnSync(bin, ['--version'], { shell: true, encoding: 'utf8', timeout: 15000 });
  const out = (r.stdout || r.stderr || '').trim().split('\n')[0];
  if (r.status === 0 && out) ok(`found — ${out}`);
  else warn('not found on PATH. Reading/visualizing still works; launching/resuming sessions needs it (set CLAUDE_BIN if it lives elsewhere).');
} catch {
  warn('not found on PATH. Reading works; launching/resuming needs it.');
}

// --- transcript store ---
const root = process.env.SESSIONS_ROOT || path.join(os.homedir(), '.claude', 'projects');
console.log(`\nSessions root: ${root}`);
if (fs.existsSync(root)) {
  let n = 0;
  try {
    for (const d of fs.readdirSync(root)) {
      const full = path.join(root, d);
      if (fs.statSync(full).isDirectory()) n += fs.readdirSync(full).filter((f) => f.endsWith('.jsonl')).length;
    }
  } catch { /* ignore */ }
  if (n > 0) ok(`found ${n} session transcript(s).`);
  else warn('exists but no .jsonl transcripts yet — run Claude Code once, or set SESSIONS_ROOT.');
} else {
  warn('does not exist yet. It appears after you use Claude Code, or set SESSIONS_ROOT to point elsewhere.');
}

console.log(`\n${hardFail ? '✗ Not ready — fix the ✗ items above.' : '✓ Ready. Run: npm run dev'}\n`);
process.exit(hardFail ? 1 : 0);
