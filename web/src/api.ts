import type {
  FsListing,
  FullSession,
  LaunchResult,
  ProjectInfo,
  ResumeResult,
  SessionSummary,
  UsageWindowsResponse,
} from './types';

async function j<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(await errText(r));
  return r.json() as Promise<T>;
}

/**
 * Extract a human error from a failed Response. Reads the body as text first so a
 * non-JSON error (a 413 "PayloadTooLargeError", a proxy's 502 HTML) doesn't turn
 * into a misleading "Unexpected token" JSON.parse error.
 */
async function errText(r: Response): Promise<string> {
  const t = await r.text().catch(() => '');
  try {
    return JSON.parse(t).error || t || r.statusText;
  } catch {
    return t || `${r.status} ${r.statusText}`;
  }
}

export const api = {
  projects: () => j<{ sessionsRoot: string; projects: ProjectInfo[]; reveal: boolean }>('/api/projects'),
  /** Open a file in the OS file manager on the host (loopback-only; 403 otherwise). */
  reveal: async (path: string): Promise<void> => {
    const r = await fetch('/api/reveal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    if (!r.ok) throw new Error(await errText(r));
  },
  sessions: (project?: string) =>
    j<{ sessions: SessionSummary[] }>(`/api/sessions${project ? `?project=${encodeURIComponent(project)}` : ''}`),
  session: (id: string) => j<FullSession>(`/api/sessions/${id}`),
  reviewUrl: (id: string) => `/api/sessions/${id}/review.md`,
  reviewMarkdown: async (id: string) => {
    const r = await fetch(`/api/sessions/${id}/review.md`);
    if (!r.ok) throw new Error(`${r.status}`);
    return r.text();
  },
  launch: async (body: {
    prompt: string;
    cwd?: string;
    model?: string;
    permissionMode?: string;
    dryRun?: boolean;
  }): Promise<LaunchResult> => {
    const r = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(await errText(r));
    return (await r.json()) as LaunchResult;
  },
  deleteSession: async (id: string): Promise<{ ok: true; deleted: string[] }> => {
    const r = await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
    if (!r.ok) throw new Error(await errText(r));
    return r.json();
  },
  fs: (path?: string) => j<FsListing>(`/api/fs${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  usageWindows: () => j<UsageWindowsResponse>('/api/usage/windows'),
  /** Live feed of which sessions have a running claude process. Returns unsubscribe. */
  activityStream(onActive: (ids: string[]) => void): () => void {
    const es = new EventSource('/api/activity/stream');
    es.addEventListener('activity', (ev) => {
      try {
        onActive(JSON.parse((ev as MessageEvent).data).active);
      } catch {
        /* ignore */
      }
    });
    return () => es.close();
  },
  resume: async (
    id: string,
    body: { prompt: string; cwd?: string; model?: string; permissionMode?: string; dryRun?: boolean },
  ): Promise<ResumeResult> => {
    const r = await fetch(`/api/sessions/${id}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(await errText(r));
    return (await r.json()) as ResumeResult;
  },
  /** Subscribe to live session updates via SSE. Returns an unsubscribe fn. */
  stream(
    id: string,
    onSession: (s: FullSession) => void,
    onActivity?: (active: boolean) => void,
    onError?: (e: string) => void,
  ): () => void {
    const es = new EventSource(`/api/sessions/${id}/stream`);
    es.addEventListener('session', (ev) => {
      try {
        onSession(JSON.parse((ev as MessageEvent).data));
      } catch (e) {
        onError?.(String(e));
      }
    });
    es.addEventListener('activity', (ev) => {
      try {
        onActivity?.(JSON.parse((ev as MessageEvent).data).active);
      } catch {
        /* ignore */
      }
    });
    // Server-side data error (named to avoid colliding with the built-in 'error').
    es.addEventListener('srv-error', (ev) => {
      try {
        onError?.(JSON.parse((ev as MessageEvent).data).message || 'server error');
      } catch {
        onError?.('server error');
      }
    });
    // The session's transcript was deleted out from under this stream.
    es.addEventListener('deleted', () => onError?.('deleted'));
    // Built-in connection error: transient blips auto-reconnect (readyState
    // CONNECTING); only a permanent CLOSED (e.g. the endpoint now 404s) is terminal.
    es.addEventListener('error', () => {
      if (es.readyState === EventSource.CLOSED) onError?.('closed');
    });
    return () => es.close();
  },
};
