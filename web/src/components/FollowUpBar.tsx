import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { FullSession } from '../types';
import { EFFORTS, MODELS, PERMISSION_MODES } from '../constants';
import { useAttachedImages, ImageStrip } from '../attachments';

// Model and effort are remembered PER SESSION (keyed by id) so a choice in one
// session never bleeds into another. Permission mode stays a global preference.
const modelKey = (id: string) => `csv.model.${id}`;
const effortKey = (id: string) => `csv.effort.${id}`;
const LS_MODE = 'csv.permissionMode';

/**
 * Compose a follow-up prompt for the open session (resume).
 *  - Enter sends; Shift+Enter inserts a newline (auto-growing textarea).
 *  - Model and permission mode are set here and applied to the resume. Permission
 *    mode is where file-write permission is granted (before the prompt runs).
 * Last-used model/mode persist in localStorage.
 */
export function FollowUpBar({
  session,
  onSent,
  active,
}: {
  session: FullSession;
  onSent: () => void;
  active?: boolean; // a turn is already running for this session
}) {
  const [prompt, setPrompt] = useState('');
  // Defaults to '' = "Session default" (keep whatever model this session runs). A
  // per-session choice is remembered under this session's own key.
  const [model, setModel] = useState(() => localStorage.getItem(modelKey(session.id)) ?? '');
  const [effort, setEffort] = useState(() => localStorage.getItem(effortKey(session.id)) ?? '');
  const [mode, setMode] = useState(() => localStorage.getItem(LS_MODE) ?? 'default');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const att = useAttachedImages();
  // Block sending while a turn is in flight: two `claude --resume` processes
  // appending the same transcript concurrently corrupt it (the server also rejects
  // this with 409, but disabling here makes it obvious instead of an error).
  const blocked = busy || !!active;

  useEffect(() => localStorage.setItem(modelKey(session.id), model), [model, session.id]);
  useEffect(() => localStorage.setItem(effortKey(session.id), effort), [effort, session.id]);
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
    if ((!prompt.trim() && !att.images.length) || blocked) return;
    setError('');
    setBusy(true);
    try {
      await api.resume(session.id, {
        prompt,
        cwd: session.cwd || undefined,
        model: model || undefined,
        effort: effort || undefined,
        permissionMode: mode,
        images: att.images.length ? att.payload() : undefined,
      });
      setPrompt('');
      att.clear();
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
          <span className="ctl-k">Effort</span>
          <select
            value={effort}
            title={EFFORTS.find((e) => e.v === effort)?.hint}
            onChange={(e) => setEffort(e.target.value)}
          >
            {EFFORTS.map((e) => (
              <option key={e.v} value={e.v} title={e.hint}>
                {e.label}
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
      <ImageStrip images={att.images} onRemove={att.remove} />
      {att.note && <div className="followup-note">{att.note}</div>}
      <div className="followup-row" onDrop={att.onDrop} onDragOver={(e) => e.preventDefault()}>
        <button
          className="attach-btn"
          title="Attach image (or just paste a screenshot)"
          disabled={blocked}
          onClick={() => fileRef.current?.click()}
        >
          📎
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) att.addFiles(e.target.files);
            e.target.value = ''; // let re-picking the same file fire onChange again
          }}
        />
        <textarea
          ref={taRef}
          className="followup-input"
          rows={1}
          placeholder={
            active
              ? 'A turn is running… wait for it to finish'
              : 'Send a follow-up prompt…  (Enter to send · Shift+Enter for newline · paste a screenshot)'
          }
          value={prompt}
          disabled={blocked}
          onChange={(e) => setPrompt(e.target.value)}
          onPaste={att.onPaste}
          onKeyDown={(e) => {
            // Don't send on the Enter that COMMITS an IME composition (dead keys,
            // CJK candidates) — that Enter isn't "submit", it's "accept character".
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button
          className="btn primary send"
          disabled={blocked || (!prompt.trim() && !att.images.length)}
          onClick={send}
        >
          {busy ? 'Sending…' : active ? 'Running…' : 'Send ↵'}
        </button>
      </div>
    </div>
  );
}
