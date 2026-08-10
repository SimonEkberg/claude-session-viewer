import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { FullSession } from '../types';
import { MODELS, PERMISSION_MODES } from '../constants';

const LS_MODEL = 'csv.model';
const LS_MODE = 'csv.permissionMode';

/**
 * Compose a follow-up prompt for the open session (resume).
 *  - Enter sends; Shift+Enter inserts a newline (auto-growing textarea).
 *  - Model and permission mode are set here and applied to the resume. Permission
 *    mode is where file-write permission is granted (before the prompt runs).
 * Last-used model/mode persist in localStorage.
 */
export function FollowUpBar({ session, onSent }: { session: FullSession; onSent: () => void }) {
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState(() => localStorage.getItem(LS_MODEL) ?? '');
  const [mode, setMode] = useState(() => localStorage.getItem(LS_MODE) ?? 'default');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => localStorage.setItem(LS_MODEL, model), [model]);
  useEffect(() => localStorage.setItem(LS_MODE, mode), [mode]);

  // Auto-grow the textarea up to a cap.
  const grow = () => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 180) + 'px';
  };
  useEffect(grow, [prompt]);

  const canWrite = PERMISSION_MODES.find((m) => m.v === mode)?.writes;

  const send = async () => {
    if (!prompt.trim()) return;
    setError('');
    setBusy(true);
    try {
      await api.resume(session.id, {
        prompt,
        cwd: session.cwd || undefined,
        model: model || undefined,
        permissionMode: mode,
      });
      setPrompt('');
      onSent();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="followup">
      {error && <div className="followup-error">{error}</div>}
      <div className="followup-controls">
        <label className="ctl">
          <span className="ctl-k">Model</span>
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            {MODELS.map((m) => (
              <option key={m.v} value={m.v}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label className="ctl">
          <span className="ctl-k">
            Permission {canWrite ? <span className="write-on" title="File writes allowed">✎ can write</span> : <span className="write-off" title="Read-only">read-only</span>}
          </span>
          <select value={mode} onChange={(e) => setMode(e.target.value)} title={PERMISSION_MODES.find((m) => m.v === mode)?.hint}>
            {PERMISSION_MODES.map((m) => (
              <option key={m.v} value={m.v} title={m.hint}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="followup-row">
        <textarea
          ref={taRef}
          className="followup-input"
          rows={1}
          placeholder="Send a follow-up prompt…  (Enter to send · Shift+Enter for newline)"
          value={prompt}
          disabled={busy}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button className="btn primary send" disabled={busy || !prompt.trim()} onClick={send}>
          {busy ? 'Sending…' : 'Send ↵'}
        </button>
      </div>
    </div>
  );
}
