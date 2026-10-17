import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { FullSession, QueuedTurn } from '../types';
import { EFFORTS, MODELS, PERMISSION_MODES, type ModelChoice } from '../constants';
import { useAttachedImages, ImageStrip } from '../attachments';

// Model, effort and the unsent draft are remembered PER SESSION (keyed by id) so a
// choice — or a half-written prompt — in one session never bleeds into another.
// Permission mode stays a global preference.
const modelKey = (id: string) => `csv.model.${id}`;
const effortKey = (id: string) => `csv.effort.${id}`;
const draftKey = (id: string) => `csv.draft.${id}`;
const LS_MODE = 'csv.permissionMode';

/**
 * Compose a follow-up prompt for the open session (resume).
 *  - Enter sends; Shift+Enter inserts a newline (auto-growing textarea).
 *  - You can always type, even mid-turn: the CLI can't take a second prompt while one
 *    is running (two `claude --resume` children would corrupt the transcript), so the
 *    server parks it and sends it the moment the running turn's process exits.
 *  - The draft survives switching to another session and coming back — it's saved per
 *    session id, so you never have to retype what you'd already written.
 *  - Model and permission mode are applied to the resume. Permission mode is where
 *    file-write permission is granted (before the prompt runs).
 */
export function FollowUpBar({
  session,
  onSent,
  active,
  queuedHint,
  models = MODELS,
}: {
  session: FullSession;
  onSent: () => void;
  active?: boolean; // a turn is already running for this session
  queuedHint?: number; // queue size per the live activity feed — triggers a refresh
  models?: ModelChoice[]; // live list from /api/models; static fallback otherwise
}) {
  const [prompt, setPrompt] = useState(() => localStorage.getItem(draftKey(session.id)) ?? '');
  // Defaults to '' = "Session default" (keep whatever model this session runs). A
  // per-session choice is remembered under this session's own key.
  const [model, setModel] = useState(() => localStorage.getItem(modelKey(session.id)) ?? '');
  const [effort, setEffort] = useState(() => localStorage.getItem(effortKey(session.id)) ?? '');
  const [mode, setMode] = useState(() => localStorage.getItem(LS_MODE) ?? 'default');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [queued, setQueued] = useState<QueuedTurn | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const att = useAttachedImages();

  useEffect(() => localStorage.setItem(modelKey(session.id), model), [model, session.id]);
  useEffect(() => localStorage.setItem(effortKey(session.id), effort), [effort, session.id]);
  useEffect(() => localStorage.setItem(LS_MODE, mode), [mode]);
  // Persist the draft as you type. Cleared only once the turn is actually accepted.
  useEffect(() => {
    if (prompt) localStorage.setItem(draftKey(session.id), prompt);
    else localStorage.removeItem(draftKey(session.id));
  }, [prompt, session.id]);

  // What's parked for this session. Re-read when the turn state changes, since that's
  // exactly when a queued follow-up fires and stops being queued.
  const refreshQueue = useCallback(() => {
    api
      .queue(session.id)
      .then((r) => setQueued(r.queued))
      .catch(() => {
        /* transient — the chip just stays as it was */
      });
  }, [session.id]);
  useEffect(refreshQueue, [refreshQueue, active, queuedHint]);

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
    if ((!prompt.trim() && !att.images.length) || busy) return;
    setError('');
    setBusy(true);
    try {
      const res = await api.resume(session.id, {
        prompt,
        cwd: session.cwd || undefined,
        model: model || undefined,
        effort: effort || undefined,
        permissionMode: mode,
        images: att.images.length ? att.payload() : undefined,
        // Never bounce a follow-up just because the session is mid-turn — park it.
        queueIfBusy: true,
      });
      setPrompt('');
      localStorage.removeItem(draftKey(session.id));
      att.clear();
      if (res.queued) refreshQueue();
      else onSent();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };

  const cancelQueued = async () => {
    try {
      await api.clearQueue(session.id);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
    refreshQueue();
  };

  return (
    <div className="followup">
      {error && <div className="followup-error">{error}</div>}
      {queued && (
        <div className="queued-bar">
          <span className="queued-tag">queued</span>
          <span className="queued-text" title={queued.prompt}>
            {queued.prompt || `${queued.images} image${queued.images === 1 ? '' : 's'}`}
          </span>
          <span className="queued-note">sends when this turn finishes</span>
          <button className="queued-cancel" title="Don't send this after all" onClick={cancelQueued}>
            ✕
          </button>
        </div>
      )}
      <div className="followup-controls">
        <label className="ctl">
          <span className="ctl-k">Model</span>
          <select
            value={model}
            title={models.find((m) => m.v === model)?.hint}
            onChange={(e) => setModel(e.target.value)}
          >
            {models.map((m) => (
              <option key={m.v} value={m.v} title={m.hint}>
                {m.label}
                {m.hint ? ' *' : ''}
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
          disabled={busy}
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
              ? 'Write the next prompt now — it sends when this turn finishes…  (Enter to queue)'
              : 'Send a follow-up prompt…  (Enter to send · Shift+Enter for newline · paste a screenshot)'
          }
          value={prompt}
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
          disabled={busy || (!prompt.trim() && !att.images.length)}
          onClick={send}
          title={active ? 'Queued now, sent when the running turn finishes' : undefined}
        >
          {busy ? 'Sending…' : active ? 'Queue ↵' : 'Send ↵'}
        </button>
      </div>
    </div>
  );
}
