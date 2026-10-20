import express from 'express';
import cors from 'cors';
import chokidar from 'chokidar';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORT, HOST, CORS_ORIGINS, SESSIONS_ROOT, AUTH_MODE, ALLOWED_LOGINS } from './config.js';
import { deleteSession, findFile, getSession, listProjects, listSessions, loadFile } from './index-store.js';
import { buildReview, reviewToMarkdown } from './review.js';
import { launchSession, resumeSession, expectedFilePath, stopSession, validateModelMode } from './launch.js';
import { clearQueued, getQueued, queuedCount, setQueued, startQueueRunner } from './queue.js';
import { modelOptions } from './models.js';
import { getPeers, setPeers } from './peers.js';
import { listDir } from './fsbrowse.js';
import { revealInFileManager } from './reveal.js';
import { assertSafeExposure } from './startup.js';
import { usageWindows } from './usage.js';
import { activityBus, isActive, activeIds } from './activity.js';

const app = express();
// Only the app's own UI origin may call this API from a browser (not arbitrary
// sites). Same-origin / no-Origin requests (the Vite proxy, curl) are unaffected.
app.use(cors({ origin: CORS_ORIGINS, credentials: true }));
// 25mb: prompts can now carry base64 screenshot(s) (launch.ts caps each ~5MB and the
// count at 10). Bad/oversized bodies still surface as JSON via the error handler.
app.use(express.json({ limit: '25mb' }));

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
  // `reveal` tells the UI whether the "reveal in file manager" action is available
  // (loopback only — see the /api/reveal route). `home` lets the New-session dialog
  // warn when the chosen working directory is just your home folder.
  res.json({ sessionsRoot: SESSIONS_ROOT, home: os.homedir(), projects: listProjects(), reveal: AUTH_MODE === 'off' });
});

// Models the composer can offer: current curated lineup + everything observed in
// the local transcripts (so new models appear without a code change).
app.get('/api/models', (_req, res) => {
  res.json(modelOptions());
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
  // A freshly launched session's transcript file may not exist yet (CLI startup
  // takes ~1-3s). Fall back to its expected path and watch for the file to appear
  // rather than 404ing, which the EventSource would treat as a permanent failure.
  const file = findFile(id) || expectedFilePath(id);
  if (!file) return res.status(404).json({ error: 'session not found' });

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders?.();

  const send = () => {
    try {
      if (!fs.existsSync(file)) return; // not created yet (freshly launched)
      const session = loadFile(file);
      res.write(`event: session\ndata: ${JSON.stringify(session)}\n\n`);
    } catch (err) {
      // Named 'srv-error' so it doesn't collide with EventSource's built-in
      // connection 'error' event on the client.
      res.write(`event: srv-error\ndata: ${JSON.stringify({ message: String(err) })}\n\n`);
    }
  };

  // Authoritative "Claude is working" signal: whether a claude process for this
  // session is currently running (survives the thinking phase, where the file is
  // quiet). Pushed on connect and whenever it flips.
  const sendActivity = () =>
    res.write(`event: activity\ndata: ${JSON.stringify({ active: isActive(id), queued: queuedCount(id) })}\n\n`);

  send();
  sendActivity();

  // Coalesce bursty appends: parseSession re-reads the whole file synchronously, so
  // firing on every change during an active turn would starve the event loop and
  // every other SSE client. A trailing debounce bounds that to ~1 parse / interval,
  // and the interval grows with the file: a 25 MB transcript parses in ~120 ms, so
  // re-parsing it every 150 ms during a busy turn would eat a core for no visible
  // gain. ~50 KB/ms keeps small sessions snappy and big ones at ≲1 parse/second.
  let pending: ReturnType<typeof setTimeout> | null = null;
  const debounceMs = () => {
    try {
      return Math.min(1000, Math.max(150, Math.round(fs.statSync(file).size / 50_000)));
    } catch {
      return 150; // file not created yet
    }
  };
  const scheduleSend = () => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      send();
    }, debounceMs());
  };

  // ignoreInitial + watching a path that may not exist yet: 'add' fires when the CLI
  // creates the transcript, 'change' on every append, 'unlink' if it's deleted.
  const watcher = chokidar.watch(file, { ignoreInitial: true });
  watcher.on('add', scheduleSend);
  watcher.on('change', scheduleSend);
  watcher.on('unlink', () => {
    res.write(`event: deleted\ndata: {}\n\n`); // tell the client to leave live mode
    res.end(); // triggers the req 'close' cleanup below
  });

  const onActivity = (changedId: string) => {
    if (changedId !== id) return;
    sendActivity();
    scheduleSend(); // the turn just started/ended — refresh the snapshot too
  };
  activityBus.on('change', onActivity);

  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);

  req.on('close', () => {
    if (pending) clearTimeout(pending);
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
  const id = req.params.id;
  // Validate the id (the launch.ts comment claims this) and refuse to resume while a
  // turn is already running — two `claude --resume <id>` children appending the same
  // transcript concurrently corrupt it. (Same guard the DELETE route uses.)
  if (!/^[0-9a-fA-F-]{8,64}$/.test(id)) return res.status(400).json({ error: 'invalid session id' });
  const session = getSession(id);
  if (!session) return res.status(404).json({ error: 'session not found' });

  // A turn is already running. Two `claude --resume <id>` children appending the same
  // transcript corrupt it, so we can't just send — but the follow-up doesn't have to be
  // thrown away either: park it and send it the moment this turn's process exits.
  if (isActive(id)) {
    if (!req.body?.queueIfBusy) {
      return res.status(409).json({ error: 'a turn is already running for this session' });
    }
    const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt : '';
    const images = Array.isArray(req.body?.images) ? req.body.images : undefined;
    if (!prompt.trim() && !images?.length) {
      return res.status(400).json({ error: 'prompt or an image is required' });
    }
    try {
      // Validate now, so a bad model/effort fails while you're looking at it rather
      // than silently at fire time, minutes later.
      validateModelMode(req.body?.model, req.body?.permissionMode, req.body?.effort);
    } catch (err) {
      return res.status(400).json({ error: String(err instanceof Error ? err.message : err) });
    }
    const q = setQueued(id, {
      prompt,
      cwd: req.body?.cwd || session.cwd || process.cwd(),
      model: req.body?.model,
      effort: req.body?.effort,
      permissionMode: req.body?.permissionMode,
      images,
    });
    return res.json({ id, queued: true, queuedAt: q.queuedAt, spawned: false });
  }

  try {
    const result = resumeSession(id, {
      prompt: req.body?.prompt,
      cwd: req.body?.cwd || session.cwd || process.cwd(),
      model: req.body?.model,
      effort: req.body?.effort,
      permissionMode: req.body?.permissionMode,
      images: req.body?.images,
      dryRun: req.body?.dryRun,
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: String(err instanceof Error ? err.message : err) });
  }
});

// Stop an in-flight turn: kill the claude process (tree) the viewer spawned for this
// session. Only turns started through this server can be stopped — it kills the
// child it is holding, never an arbitrary pid. Note a queued follow-up still sends
// when the killed turn's process exits, exactly as the queue chip promises.
app.post('/api/sessions/:id/stop', (req, res) => {
  const id = req.params.id;
  if (!/^[0-9a-fA-F-]{8,64}$/.test(id)) return res.status(400).json({ error: 'invalid session id' });
  if (!isActive(id)) return res.status(409).json({ error: 'no turn is running for this session' });
  const stopped = stopSession(id);
  if (!stopped) {
    // Active per the counter but no child on hand (shouldn't happen — both are
    // maintained by trackChild). Say so honestly rather than claiming success.
    return res.status(500).json({ error: 'turn is active but its process handle is gone' });
  }
  res.json({ stopped: true });
});

// The follow-up parked while a turn runs: what's waiting, and a way to call it off
// before it fires.
app.get('/api/sessions/:id/queue', (req, res) => {
  const id = req.params.id;
  if (!/^[0-9a-fA-F-]{8,64}$/.test(id)) return res.status(400).json({ error: 'invalid session id' });
  const q = getQueued(id);
  res.json({
    queued: q
      ? {
          prompt: q.prompt,
          queuedAt: q.queuedAt,
          model: q.model ?? null,
          effort: q.effort ?? null,
          permissionMode: q.permissionMode ?? null,
          images: q.images?.length ?? 0, // count only — the payload can be megabytes
        }
      : null,
  });
});

app.delete('/api/sessions/:id/queue', (req, res) => {
  const id = req.params.id;
  if (!/^[0-9a-fA-F-]{8,64}$/.test(id)) return res.status(400).json({ error: 'invalid session id' });
  res.json({ cleared: clearQueued(id) });
});

// Session collaboration allowlist (read-only peek). GET returns the current peers +
// the candidate sessions to choose from; PUT replaces the allowlist (takes effect on
// the session's next turn, since the MCP server is attached at launch/resume).
app.get('/api/sessions/:id/peers', (req, res) => {
  const id = req.params.id;
  if (!/^[0-9a-fA-F-]{8,64}$/.test(id)) return res.status(400).json({ error: 'invalid session id' });
  const candidates = listSessions()
    .filter((s) => s.id !== id)
    .map((s) => ({ id: s.id, title: s.title, cwd: s.cwd, projectDir: s.projectDir, updatedAt: s.updatedAt }));
  res.json({ peers: getPeers(id), candidates });
});

app.put('/api/sessions/:id/peers', (req, res) => {
  const id = req.params.id;
  if (!/^[0-9a-fA-F-]{8,64}$/.test(id)) return res.status(400).json({ error: 'invalid session id' });
  if (!Array.isArray(req.body?.peers)) return res.status(400).json({ error: 'peers must be an array of session ids' });
  res.json({ peers: setPeers(id, req.body.peers.map(String)) });
});

// Directory browser for the New Session working-directory picker.
app.get('/api/fs', (req, res) => {
  const p = typeof req.query.path === 'string' ? req.query.path : undefined;
  res.json(listDir(p));
});

// Reveal a file in the OS file manager. Loopback only: it spawns a process on the
// HOST, which is meaningless (and an unnecessary surface) once exposed via tailscale.
app.post('/api/reveal', (req, res) => {
  if (AUTH_MODE !== 'off') {
    return res.status(403).json({ error: 'reveal is available only for local (loopback) access' });
  }
  const p = typeof req.body?.path === 'string' ? req.body.path : '';
  try {
    revealInFileManager(p);
    res.json({ ok: true });
  } catch (err) {
    const code = (err as { code?: number })?.code;
    res.status(code === 400 ? 400 : 500).json({ error: String(err instanceof Error ? err.message : err) });
  }
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

// Unmatched /api paths return JSON (not the SPA's HTML, and not Express's default
// HTML 404), so API clients always get a JSON body.
app.use('/api', (_req, res) => res.status(404).json({ error: 'not found' }));

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

// Final error handler: bad JSON / oversized bodies (express.json throws
// SyntaxError / PayloadTooLargeError) surface as JSON with the right status, not
// Express's default HTML error page.
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = err?.status || err?.statusCode || 500;
  res.status(status).json({ error: String(err?.message || err) });
});

// Fail closed before binding if the RCE endpoints would be exposed without the gate.
assertSafeExposure();

// Send parked follow-ups as soon as the turn they were waiting on exits.
startQueueRunner();

app.listen(PORT, HOST, () => {
  console.log(`claude-session-viewer server on http://${HOST}:${PORT}`);
  console.log(`  bound to: ${HOST}${HOST === '127.0.0.1' ? ' (loopback only)' : ''}`);
  console.log(
    `  auth: ${AUTH_MODE === 'tailscale' ? `tailscale identity gate (${ALLOWED_LOGINS.length} login(s) allowed)` : 'off — local loopback only'}`,
  );
  console.log(`  sessions root: ${SESSIONS_ROOT}`);
});
