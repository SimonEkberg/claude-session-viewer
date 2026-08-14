import { useMemo, useState } from 'react';
import type { ProjectInfo, SessionSummary } from '../types';
import { timeAgo } from '../util';

export function Sidebar({
  sessions,
  projects,
  selectedId,
  activeIds,
  onSelect,
  onNew,
  onDelete,
  onToggleCollapse,
  loading,
}: {
  sessions: SessionSummary[];
  projects: ProjectInfo[];
  selectedId: string | null;
  activeIds: Set<string>;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onToggleCollapse?: () => void;
  loading: boolean;
}) {
  const [q, setQ] = useState('');
  const [project, setProject] = useState<string>('');
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const needle = q.toLowerCase();
    const list = sessions.filter(
      (s) =>
        (!project || s.projectDir === project) &&
        (!needle ||
          s.title.toLowerCase().includes(needle) ||
          s.id.includes(needle) ||
          (s.cwd || '').toLowerCase().includes(needle)),
    );
    // Running sessions float to the top so you can watch several at once.
    return [...list].sort((a, b) => {
      const ra = activeIds.has(a.id) ? 1 : 0;
      const rb = activeIds.has(b.id) ? 1 : 0;
      return ra !== rb ? rb - ra : b.mtimeMs - a.mtimeMs;
    });
  }, [sessions, q, project, activeIds]);

  const runningCount = sessions.filter((s) => activeIds.has(s.id)).length;

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <div className="brand-row">
          <div className="brand">
            <span className="logo">◈</span> Session Viewer
          </div>
          {onToggleCollapse && (
            <button className="sidebar-collapse-btn" onClick={onToggleCollapse} title="Collapse the sidebar">
              ◀
            </button>
          )}
        </div>
        <button className="btn primary" onClick={onNew}>
          + New session
        </button>
        {runningCount > 0 && (
          <div className="running-count">
            <span className="spinner" /> {runningCount} running
          </div>
        )}
      </div>

      <input
        className="search"
        placeholder="Search title / id / path…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />

      <select className="project-select" value={project} onChange={(e) => setProject(e.target.value)}>
        <option value="">All projects ({sessions.length})</option>
        {projects.map((p) => (
          <option key={p.dir} value={p.dir}>
            {p.cwdGuess} ({p.sessionCount})
          </option>
        ))}
      </select>

      <div className="session-list">
        {loading && <div className="muted pad">Loading…</div>}
        {!loading && filtered.length === 0 && <div className="muted pad">No sessions.</div>}
        {filtered.map((s) => {
          const running = activeIds.has(s.id);
          const pending = confirmId === s.id;
          return (
            <div
              key={s.id}
              className={`session-item ${s.id === selectedId ? 'active' : ''} ${running ? 'running' : ''}`}
            >
              <div className="si-main" role="button" tabIndex={0} onClick={() => onSelect(s.id)}>
                <div className="si-title">
                  {running && <span className="spinner si-spin" />}
                  {s.title}
                </div>
                <div className="si-meta">
                  <span>{timeAgo(s.updatedAt)}</span>
                  <span className="dotsep">·</span>
                  <span>{s.counts.toolCalls} tools</span>
                  {s.counts.errors > 0 && <span className="err">· {s.counts.errors} err</span>}
                </div>
                <div className="si-cwd" title={s.cwd || ''}>
                  {s.cwd || s.projectDir}
                </div>
              </div>

              {pending ? (
                <div className="si-confirm" onClick={(e) => e.stopPropagation()}>
                  <span>Delete?</span>
                  <button
                    className="si-del-yes"
                    onClick={() => {
                      setConfirmId(null);
                      onDelete(s.id);
                    }}
                  >
                    Delete
                  </button>
                  <button className="si-del-no" onClick={() => setConfirmId(null)}>
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  className="si-delete"
                  title={running ? 'Stop the running session before deleting' : 'Delete session'}
                  disabled={running}
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirmId(s.id);
                  }}
                >
                  🗑
                </button>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
