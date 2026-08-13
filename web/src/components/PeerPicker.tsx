import { useMemo, useState } from 'react';
import type { PeerCandidate } from '../types';
import { timeAgo } from '../util';

/**
 * A searchable checkbox list of sessions to add to a read-only peer allowlist.
 * Controlled: parent owns the selected ids.
 */
export function PeerPicker({
  candidates,
  selected,
  onChange,
}: {
  candidates: PeerCandidate[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const [q, setQ] = useState('');
  const sel = new Set(selected);

  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase();
    const list = n
      ? candidates.filter(
          (c) => c.title.toLowerCase().includes(n) || c.id.includes(n) || (c.cwd || '').toLowerCase().includes(n),
        )
      : candidates;
    // selected first, then by recency
    return [...list].sort((a, b) => {
      const sa = sel.has(a.id) ? 1 : 0;
      const sb = sel.has(b.id) ? 1 : 0;
      if (sa !== sb) return sb - sa;
      return (b.updatedAt || '').localeCompare(a.updatedAt || '');
    });
  }, [candidates, q, selected]);

  const toggle = (id: string) => {
    const next = new Set(sel);
    next.has(id) ? next.delete(id) : next.add(id);
    onChange([...next]);
  };

  if (!candidates.length) return <div className="muted pad">No other sessions to link to yet.</div>;

  return (
    <div className="peer-picker">
      <div className="peer-picker-top">
        <input
          className="search"
          placeholder="Search sessions by title / id / path…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <span className="muted">{selected.length} selected</span>
      </div>
      <div className="peer-list">
        {filtered.map((c) => (
          <label key={c.id} className={`peer-row ${sel.has(c.id) ? 'on' : ''}`}>
            <input type="checkbox" checked={sel.has(c.id)} onChange={() => toggle(c.id)} />
            <span className="peer-body">
              <span className="peer-title">{c.title || c.id.slice(0, 8)}</span>
              <span className="peer-sub mono">
                {c.id.slice(0, 8)}… · {c.cwd || c.projectDir} · {timeAgo(c.updatedAt)}
              </span>
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}
