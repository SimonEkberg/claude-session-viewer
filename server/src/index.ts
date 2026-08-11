import express from 'express';
import cors from 'cors';
import chokidar from 'chokidar';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORT, HOST, CORS_ORIGINS, SESSIONS_ROOT, AUTH_MODE, ALLOWED_LOGINS } from './config.js';
import { deleteSession, findFile, getSession, listProjects, listSessions, loadFile } from './index-store.js';
import { buildReview, reviewToMarkdown } from './review.js';
import { launchSession, resumeSession } from './launch.js';
import { listDir } from './fsbrowse.js';
import { usageWindows } from './usage.js';
import { activityBus, isActive, activeIds } from './activity.js';

const app = express();
// Only the app's own UI origin may call this API from a browser (not arbitrary
// sites). Same-origin / no-Origin requests (the Vite proxy, curl) are unaffected.
app.use(cors({ origin: CORS_ORIGINS, credentials: true }));
app.use(express.json({ limit: '1mb' }));

// Tailscale-identity gate (enabled with AUTH_MODE=tailscale). Gates EVERY request
// — the UI and the API — so viewing is protected too, not just mutations. The
// header is set by `tailscale serve` and cannot be forged from the tailnet.
if (AUTH_MODE === 'tailscale') {
  if (ALLOWED_LOGINS.length === 0) {
    console.warn('  auth: AUTH_MODE=tailscale but ALLOWED_LOGINS is empty — DENYING ALL requests (set ALLOWED_LOGINS).');
  }
  app.use((req, res, next) => {
    const login = String(req.header('Tailscale-User-Login') || '').toLowerCase();
    if (login && ALLOWED_LOGINS.includes(login)) {
      (req as express.Request & { tsUser?: string }).tsUser = login;
      return next();
    }
    res.status(401).json({ error: 'unauthorized — Tailscale identity required' });
  });
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, sessionsRoot: SESSIONS_ROOT });
});

app.get('/api/projects', (_req, res) => {
  res.json({ sessionsRoot: SESSIONS_ROOT, projects: listProjects() });
});

app.get('/api/sessions', (req, res) => {
  const project = typeof req.query.project === 'string' ? req.query.project : undefined;
  res.json({ sessions: listSessions(project) });
});

app.get('/api/sessions/:id', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  res.json(session);
});

// Delete a session's transcript. Guards: strict id format (no path chars), and
// refuse while a claude process for it is still running.
app.delete('/api/sessions/:id', (req, res) => {
  const id = req.params.id;
  if (!/^[0-9a-fA-F-]{8,64}$/.test(id)) return res.status(400).json({ error: 'invalid session id' });
  if (isActive(id)) return res.status(409).json({ error: 'session is running — stop it before deleting' });
  try {
    const result = deleteSession(id);
    res.json({ ok: true, ...result });
  } catch (err) {
    const code = (err as { code?: number })?.code;
    res.status(code === 404 ? 404 : code === 400 ? 400 : 500).json({
      error: String(err instanceof Error ? err.message : err),
    });
  }
});

app.get('/api/sessions/:id/review', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  res.json(buildReview(session));
});

app.get('/api/sessions/:id/review.md', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).send('session not found');
  res.type('text/markdown').send(reviewToMarkdown(buildReview(session)));
});

/**
 * Live decision map. Sends the full parsed session immediately, then re-parses and
 * re-sends whenever the transcript file changes on disk. Simple and robust: the
 * payload is small enough that a full snapshot per change beats delta bookkeeping.
 */
app.get('/api/sessions/:id/stream', (req, res) => {
  const id = req.params.id;
  const file = findFile(id);
  if (!file) return res.status(404).json({ error: 'session not found' });

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders?.();

  const send = () => {
    try {
      const session = loadFile(file);
      res.write(`event: session\ndata: ${JSON.stringify(session)}\n\n`);
    } catch (err) {
      res.write(`event: error\ndata: ${JSON.stringify({ message: String(err) })}\n\n`);
    }
  };

  // Authoritative "Claude is working" signal: whether a claude process for this
  // session is currently running (survives the thinking phase, where the file is
  // quiet). Pushed on connect and whenever it flips.
  const sendActivity = () => res.write(`event: activity\ndata: ${JSON.stringify({ active: isActive(id) })}\n\n`);

  send();
  sendActivity();

  const watcher = chokidar.watch(file, { ignoreInitial: true });
  watcher.on('change', send);

  const onActivity = (changedId: string) => {
    if (changedId !== id) return;
    sendActivity();
    send(); // the turn just started/ended — refresh the snapshot too
  };
  activityBus.on('change', onActivity);

  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    watcher.close();
    activityBus.off('change', onActivity);
  });
});

app.post('/api/sessions', (req, res) => {
  try {
    const result = launchSession(req.body || {});
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: String(err instanceof Error ? err.message : err) });
  }
});

// Send a follow-up prompt into an existing session (resume). Runs in the session's cwd.
app.post('/api/sessions/:id/prompt', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  try {
    const result = resumeSession(req.params.id, {
      prompt: req.body?.prompt,
      cwd: req.body?.cwd || session.cwd || process.cwd(),
      model: req.body?.model,
      permissionMode: req.body?.permissionMode,
      dryRun: req.body?.dryRun,
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: String(err instanceof Error ? err.message : err) });
  }
});

// Directory browser for the New Session working-directory picker.
app.get('/api/fs', (req, res) => {
  const p = typeof req.query.path === 'string' ? req.query.path : undefined;
  res.json(listDir(p));
});

// Rolling-window usage across all sessions (local estimate, not the official meter).
app.get('/api/usage/windows', (_req, res) => {
  res.json(usageWindows(Date.now()));
});

// Which sessions have a live claude process right now (for the sidebar).
app.get('/api/activity', (_req, res) => {
  res.json({ active: activeIds() });
});

// Live feed of running sessions across the whole machine.
app.get('/api/activity/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders?.();
  const send = () => res.write(`event: activity\ndata: ${JSON.stringify({ active: activeIds() })}\n\n`);
  send();
  const onChange = () => send();
  activityBus.on('change', onChange);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => {
    clearInterval(heartbeat);
    activityBus.off('change', onChange);
  });
});

// Serve the built web app so ONE server (this one) hosts both the UI and the API
// on a single origin — the right shape for `tailscale serve` / a persistent deploy.
// (In dev you still use Vite on :5273; this only kicks in after `npm run build`.)
const WEB_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
if (fs.existsSync(WEB_DIST)) {
  app.use(express.static(WEB_DIST));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(WEB_DIST, 'index.html'));
  });
  console.log(`  serving web UI from: ${WEB_DIST}`);
}

app.listen(PORT, HOST, () => {
  console.log(`claude-session-viewer server on http://${HOST}:${PORT}`);
  console.log(`  bound to: ${HOST}${HOST === '127.0.0.1' ? ' (loopback only — set HOST to the tailnet IP for remote access)' : ''}`);
  console.log(`  sessions root: ${SESSIONS_ROOT}`);
});
