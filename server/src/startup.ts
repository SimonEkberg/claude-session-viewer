import { execFileSync } from 'node:child_process';
import { HOST, PORT, AUTH_MODE } from './config.js';

/**
 * Startup safety guard: refuse to boot in a configuration that exposes the
 * RCE-capable endpoints (New-session / resume / fs) beyond loopback WITHOUT the
 * identity gate. Two exposure vectors:
 *   1. HOST binds a non-loopback interface (0.0.0.0, a LAN/tailnet IP, …).
 *   2. `tailscale serve` proxies the tailnet to our loopback port (the server only
 *      sees a loopback bind, so we detect the proxy via `tailscale serve status`).
 * Either one while AUTH_MODE=off is a hole; fail closed. ALLOW_INSECURE_EXPOSURE=1
 * bypasses the check for the rare deliberate case.
 */
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

/** Best-effort: is `tailscale serve` currently proxying `port` to the tailnet? */
function tailscaleServesPort(port: number): boolean {
  const bins =
    process.platform === 'win32'
      ? ['tailscale', 'C:\\Program Files\\Tailscale\\tailscale.exe']
      : ['tailscale', '/usr/local/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];
  for (const bin of bins) {
    try {
      const out = execFileSync(bin, ['serve', 'status'], {
        encoding: 'utf8',
        timeout: 2500,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      // A proxy line looks like:  |-- / proxy http://127.0.0.1:3737
      return out.split('\n').some((l) => /proxy/i.test(l) && l.includes(`:${port}`));
    } catch {
      // not installed at this path, or `serve status` errored — try the next candidate
    }
  }
  return false;
}

export function assertSafeExposure(): void {
  const gated = AUTH_MODE === 'tailscale';
  const override = process.env.ALLOW_INSECURE_EXPOSURE === '1';
  if (gated) return; // an identity gate is in front of every request
  if (override) {
    console.warn('  ⚠ ALLOW_INSECURE_EXPOSURE=1 — exposure safety check bypassed.');
    return;
  }

  const die = (what: string, fix: string): never => {
    console.error(`\n✖ REFUSING TO START — insecure exposure detected.`);
    console.error(`  ${what}`);
    console.error(`  The New-session / resume / fs endpoints are effectively remote code execution as your user.`);
    console.error(`  Fix: ${fix}`);
    console.error(`  (To start anyway — not recommended — set ALLOW_INSECURE_EXPOSURE=1.)\n`);
    process.exit(1);
  };

  if (!LOOPBACK.has(HOST)) {
    die(
      `HOST=${HOST} binds a non-loopback interface, but AUTH_MODE=off (no identity gate).`,
      `set AUTH_MODE=tailscale + ALLOWED_LOGINS, or bind HOST=127.0.0.1.`,
    );
  }
  if (tailscaleServesPort(PORT)) {
    die(
      `'tailscale serve' is proxying your tailnet to port ${PORT}, but AUTH_MODE=off (no identity gate) — every device on your tailnet could reach it.`,
      `restart with AUTH_MODE=tailscale + ALLOWED_LOGINS=<your tailnet login>, or run 'tailscale serve reset' first.`,
    );
  }

  // Loopback + ungated + not fronted by tailscale serve: the normal safe local case.
  console.warn(
    '  auth: AUTH_MODE=off — no identity gate. Safe for LOCAL loopback use only; do not expose via tailscale serve, a reverse proxy, or a port-forward.',
  );
}
