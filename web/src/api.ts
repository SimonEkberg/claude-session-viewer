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
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json() as Promise<T>;
}

export const api = {
  projects: () => j<{ sessionsRoot: string; projects: ProjectInfo[] }>('/api/projects'),
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
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || r.statusText);
    return data as LaunchResult;
  },
  deleteSession: async (id: string): Promise<{ ok: true; deleted: string[] }> => {
    const r = await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || r.statusText);
    return data;
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
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || r.statusText);
    return data as ResumeResult;
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
    es.addEventListener('error', () => onError?.('stream error'));
    return () => es.close();
  },
};
