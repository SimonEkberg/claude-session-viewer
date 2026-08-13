import { useMemo, useState } from 'react';
import type { FullSession } from '../types';
import { fileChanges, lineDiff } from '../diff';
import { fileName, clock } from '../util';

// Cap how many diff lines we render per change. A generated file (a big
// package-lock.json, say) can produce tens of thousands of lines; mounting them all
// freezes the tab (and OOMs the mobile layout). Show the rest behind a button.
const LINE_CAP = 800;

/**
 * Git-style change viewer for a single file: every Write/Edit to it in this session,
 * newest last, each rendered as a red/green line diff. Edits show old_string→new_string
 * exactly; Writes diff against the prior in-session version (or all-added for a new file).
 */
export function DiffDialog({
  session,
  path,
  onClose,
}: {
  session: FullSession;
  path: string;
  onClose: () => void;
}) {
  // Key on the event count, not the session object: during live streaming a new
  // session snapshot arrives every tick with a fresh array, but the recorded
  // changes only differ when an event is actually appended.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const changes = useMemo(() => fileChanges(session.events, path), [session.events.length, path]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal diff-modal" onClick={(e) => e.stopPropagation()}>
        <div className="diff-head">
          <div>
            <h2>{fileName(path)}</h2>
            <div className="muted mono diff-path">{path}</div>
          </div>
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="diff-body">
          {changes.length === 0 && <div className="muted pad">No Write/Edit changes recorded for this file.</div>}
          {changes.map((c, idx) => (
            <ChangeCard
              key={c.seq}
              index={idx + 1}
              kind={c.kind}
              ts={c.ts}
              isNewFile={c.isNewFile}
              before={c.before}
              after={c.after}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function ChangeCard({
  index,
  kind,
  ts,
  isNewFile,
  before,
  after,
}: {
  index: number;
  kind: 'write' | 'edit';
  ts: string | null;
  isNewFile: boolean;
  before: string;
  after: string;
}) {
  // Compute the (potentially expensive O(n·m)) diff once per content pair, not on
  // every live re-render of the dialog while streaming.
  const lines = useMemo(() => lineDiff(before, after), [before, after]);
  const [showAll, setShowAll] = useState(false);
  const adds = lines.filter((l) => l.type === 'add').length;
  const dels = lines.filter((l) => l.type === 'del').length;
  const shown = showAll ? lines : lines.slice(0, LINE_CAP);
  return (
    <div className="change-card">
      <div className="change-head">
        <span className={`op op-${kind === 'write' ? 'write' : 'edit'}`}>{kind}</span>
        <span className="change-title">
          #{index}
          {isNewFile ? ' · new file' : ''}
        </span>
        <span className="change-stat">
          <span className="add">+{adds}</span> <span className="del">−{dels}</span>
        </span>
        <span className="change-ts mono">{clock(ts)}</span>
      </div>
      <div className="diff-lines">
        {shown.map((l, i) => (
          <div key={i} className={`dl dl-${l.type}`}>
            <span className="gutter-sign">{l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '}</span>
            <span className="dl-text">{l.text || ' '}</span>
          </div>
        ))}
      </div>
      {lines.length > LINE_CAP && !showAll && (
        <button className="more" onClick={() => setShowAll(true)}>
          ▼ show all {lines.length.toLocaleString()} lines
        </button>
      )}
    </div>
  );
}
