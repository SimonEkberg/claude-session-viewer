#!/usr/bin/env node
/**
 * `npm run serve` — the one command that starts the viewer for real use.
 *
 * It exists because starting this thing by hand has three ways to go wrong, and all
 * three fail in ways that look like "nothing happened":
 *   1. Forget AUTH_MODE/ALLOWED_LOGINS → the startup guard refuses to boot, because
 *      `tailscale serve` is publishing the RCE endpoints to your tailnet ungated.
 *   2. Run `npm run dev` instead → same refusal, but buried under Vite's output, and
 *      Vite keeps running so the terminal looks alive.
 *   3. Forget `npm run build` → the browser gets a stale bundle.
 * So: derive the identity from Tailscale itself (no magic string to remember), build,
 * check the port, then start gated. Ctrl+C stops it.
 *
 * Flags: --no-build (skip the web build)   --force (take port 3737 from whatever holds it)
 */
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 3737);
const args = process.argv.slice(2);
const checkDevOnly = args.includes('--check-dev');

const TS_BINS =
  process.platform === 'win32'
    ? ['tailscale', 'C:\\Program Files\\Tailscale\\tailscale.exe']
    : ['tailscale', '/usr/local/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];

function tailscale(argv) {
  for (const bin of TS_BINS) {
    try {
      return execFileSync(bin, argv, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      /* try the next candidate path */
    }
  }
  return null;
}

/** Your tailnet login + the hostname `tailscale serve` publishes, straight from the daemon. */
function tailnetIdentity() {
  const out = tailscale(['status', '--json']);
  if (!out) return null;
  try {
    const j = JSON.parse(out);
    const login = j.User?.[j.Self?.UserID]?.LoginName;
    const host = String(j.Self?.DNSName || '').replace(/\.$/, '');
    return login ? { login, host } : null;
  } catch {
    return null;
  }
}

/** Is `tailscale serve` proxying the tailnet to our port right now? */
function serveProxiesPort(port) {
  const out = tailscale(['serve', 'status']);
  if (!out) return false;
  return out.split('\n').some((l) => /proxy/i.test(l) && l.includes(`:${port}`));
}

/** PIDs listening on a TCP port (Windows netstat / POSIX lsof). */
function listenerPids(port) {
  const r =
    process.platform === 'win32'
      ? spawnSync('netstat', ['-ano'], { encoding: 'utf8' })
      : spawnSync('lsof', ['-ti', `tcp:${port}`], { encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout) return [];
  if (process.platform !== 'win32') return r.stdout.split('\n').filter(Boolean);
  return [
    ...new Set(
      r.stdout
        .split('\n')
        .filter((l) => l.includes(`:${port}`) && /LISTENING/i.test(l))
        .map((l) => l.trim().split(/\s+/).pop())
        .filter(Boolean),
    ),
  ];
}

function kill(pid) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  else spawnSync('kill', ['-9', String(pid)], { stdio: 'ignore' });
}

const id = tailnetIdentity();
const proxied = serveProxiesPort(PORT);

// ── `npm run dev` preflight ──────────────────────────────────────────────────────
// Dev mode never passes the gate env, so while the tailnet proxy is up the server
// half cannot start. Say so loudly HERE, before Vite starts and hides it.
if (checkDevOnly) {
  if (!proxied) process.exit(0); // nothing in the way — carry on
  console.error(`
✖  npm run dev cannot start the API right now.

   'tailscale serve' is publishing your tailnet to port ${PORT}, and dev mode runs the
   server WITHOUT the identity gate — so it refuses to boot (it would expose the
   new-session / resume / fs endpoints, which are remote code execution as you).
   Vite would still start, which is why this looks like "nothing happened".

   Pick one:
     npm run serve            ← use the app (gated, ${id ? `https://${id.host}` : 'tailnet URL'})
     tailscale serve reset    ← then npm run dev for hot reload at http://localhost:5273
`);
  process.exit(1);
}

// ── the real thing ───────────────────────────────────────────────────────────────
console.log('claude-session-viewer · starting\n');

const held = listenerPids(PORT);
if (held.length) {
  if (!args.includes('--force')) {
    console.error(`✖  Port ${PORT} is already in use (pid ${held.join(', ')}).`);
    console.error(`   It's probably an older server still running — open http://127.0.0.1:${PORT} to check,`);
    console.error(`   or take the port with:  npm run serve -- --force\n`);
    process.exit(1);
  }
  for (const pid of held) {
    console.log(`   --force: stopping pid ${pid} on port ${PORT}`);
    kill(pid);
  }
}

if (!args.includes('--no-build')) {
  console.log('   building web/dist …');
  const b = spawnSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit', shell: true });
  if (b.status !== 0) {
    console.error('\n✖  build failed — not starting. Fix the error above, then run it again.\n');
    process.exit(b.status || 1);
  }
}

const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' };
if (id) {
  // Gate every request on the Tailscale identity that `tailscale serve` injects.
  env.AUTH_MODE = 'tailscale';
  env.ALLOWED_LOGINS = id.login;
  console.log(`   identity : ${id.login}  (read from Tailscale, not hardcoded)`);
  console.log(`   phone/browser: https://${id.host}`);
  if (!proxied) {
    console.log(`\n   ⚠ 'tailscale serve' isn't proxying port ${PORT}, so that URL won't resolve yet.`);
    console.log(`     Run once:  tailscale serve --bg ${PORT}\n`);
  }
} else {
  // No Tailscale: loopback only, and the startup guard still refuses anything riskier.
  console.log('   Tailscale not available → local only, no identity gate (loopback bind).');
  console.log(`   local: http://127.0.0.1:${PORT}`);
}

console.log('\n   Ctrl+C to stop.\n');
const child = spawn('npm', ['run', 'start', '-w', 'server'], { cwd: ROOT, stdio: 'inherit', shell: true, env });
child.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
