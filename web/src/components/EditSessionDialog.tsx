import { useEffect, useState } from 'react';
import { api } from '../api';
import type { PeerCandidate } from '../types';
import { PeerPicker } from './PeerPicker';

/**
 * Edit which sessions THIS session may read (read-only collaboration). Loads the
 * current allowlist + candidates, saves via PUT. Takes effect on the next turn.
 */
export function EditSessionDialog({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const [candidates, setCandidates] = useState<PeerCandidate[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let live = true;
    api
      .peers(sessionId)
      .then((r) => {
        if (!live) return;
        setCandidates(r.candidates);
        setSelected(r.peers);
        setLoading(false);
      })
      .catch((e) => {
        if (live) {
          setError(String(e instanceof Error ? e.message : e));
          setLoading(false);
        }
      });
    return () => {
      live = false;
    };
  }, [sessionId]);

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api.setPeers(sessionId, selected);
      setSelected(r.peers);
      setSaved(true);
      setTimeout(onClose, 700);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Session collaboration</h2>
        <p className="muted">
          Choose the sessions <b>this</b> session may <b>read</b> (read-only). It gains the MCP tools{' '}
          <code>list_peers</code> and <code>read_peer</code>. Reading is one-way and never spawns the peer.
          Changes take effect on this session's next turn — sent in a <b>non-plan</b> permission mode with a
          capable model (plan mode blocks MCP tools).
        </p>
        {loading ? (
          <div className="muted pad">Loading…</div>
        ) : (
          <PeerPicker candidates={candidates} selected={selected} onChange={setSelected} />
        )}
        {error && <div className="error-box">{error}</div>}
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || loading} onClick={save}>
            {saved ? 'Saved ✓' : busy ? 'Saving…' : 'Save allowlist'}
          </button>
        </div>
      </div>
    </div>
  );
}
