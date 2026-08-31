import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { LaunchResult, PeerCandidate } from '../types';
import { DirectoryBrowser } from './DirectoryBrowser';
import { PeerPicker } from './PeerPicker';
import { EFFORTS, MODELS, PERMISSION_MODES } from '../constants';
import { useAttachedImages, ImageStrip } from '../attachments';

/** Windows-friendly dir comparison: case-insensitive, slash- and trailing-sep-agnostic. */
function sameDir(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase();
  return !!a && !!b && norm(a) === norm(b);
}

export function NewSessionDialog({
  defaultCwd,
  home,
  onCwdChosen,
  onClose,
  onLaunched,
}: {
  defaultCwd: string;
  home?: string; // the user's home dir, to warn when the cwd is just home
  onCwdChosen?: (cwd: string) => void; // remember the launched cwd as the next default
  onClose: () => void;
  onLaunched: (id: string) => void;
}) {
  const [prompt, setPrompt] = useState('');
  const [cwd, setCwd] = useState(defaultCwd);
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [permissionMode, setPermissionMode] = useState('plan');
  const [dryRun, setDryRun] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<LaunchResult | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [collab, setCollab] = useState(false);
  const [candidates, setCandidates] = useState<PeerCandidate[]>([]);
  const [peers, setPeers] = useState<string[]>([]);
  const att = useAttachedImages();
  const fileRef = useRef<HTMLInputElement>(null);

  // Candidate sessions this new one could read (read-only collaboration).
  useEffect(() => {
    api
      .sessions()
      .then((r) =>
        setCandidates(
          r.sessions.map((s) => ({ id: s.id, title: s.title, cwd: s.cwd, projectDir: s.projectDir, updatedAt: s.updatedAt })),
        ),
      )
      .catch(() => setCandidates([]));
  }, []);

  // The preview is a snapshot of one input set; invalidate it whenever an input
  // changes so we never show a command that differs from what would actually run.
  const clearPreview = () => setPreview(null);

  const submit = async () => {
    setError('');
    setBusy(true);
    try {
      const res = await api.launch({
        prompt,
        cwd,
        model: model || undefined,
        effort: effort || undefined,
        permissionMode,
        peers: collab && peers.length ? peers : undefined,
        images: att.images.length ? att.payload() : undefined,
        dryRun,
      });
      if (dryRun) {
        setPreview(res);
      } else {
        onCwdChosen?.(cwd); // remember this dir as the next New Session default
        onLaunched(res.id);
      }
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Start a new Claude session</h2>
        <p className="muted">
          Spawns the <code>claude</code> CLI with a pre-assigned id, then opens it here and live-tails
          the transcript as it works.
        </p>

        <label>
          Prompt
          <button
            type="button"
            className="attach-btn inline"
            title="Attach image (or just paste a screenshot into the prompt)"
            onClick={() => fileRef.current?.click()}
          >
            📎 image
          </button>
        </label>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) att.addFiles(e.target.files);
            e.target.value = '';
            clearPreview();
          }}
        />
        <textarea
          rows={5}
          value={prompt}
          placeholder="e.g. Investigate the failing auth test and propose a fix  (paste a screenshot to attach it)"
          onChange={(e) => {
            setPrompt(e.target.value);
            clearPreview();
          }}
          onPaste={(e) => {
            att.onPaste(e);
            clearPreview();
          }}
          onDrop={(e) => {
            att.onDrop(e);
            clearPreview();
          }}
          onDragOver={(e) => e.preventDefault()}
        />
        <ImageStrip
          images={att.images}
          onRemove={(id) => {
            att.remove(id);
            clearPreview();
          }}
        />
        {att.note && <div className="attach-note">{att.note}</div>}

        <label>Working directory</label>
        <div className="cwd-row">
          <input
            value={cwd}
            onChange={(e) => {
              setCwd(e.target.value);
              clearPreview();
            }}
            className="mono"
          />
          <button className="btn" onClick={() => setBrowsing(true)}>
            Browse…
          </button>
        </div>
        <div className={`cwd-note ${home && sameDir(cwd, home) ? 'warn' : 'muted'}`}>
          {home && sameDir(cwd, home)
            ? '⚠ This is your home folder — Claude reads & writes files here, not in a project. Pick your repo (e.g. C:\\Eplicta\\Eplicta) unless you really mean home.'
            : 'Claude runs here — it reads & writes files relative to this directory. Remembered as the default for your next session.'}
        </div>

        <div className="row3">
          <div>
            <label>Model</label>
            <select
              value={model}
              onChange={(e) => {
                setModel(e.target.value);
                clearPreview();
              }}
            >
              {MODELS.map((m) => (
                <option key={m.v} value={m.v}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label>Effort</label>
            <select
              value={effort}
              title={EFFORTS.find((e) => e.v === effort)?.hint}
              onChange={(e) => {
                setEffort(e.target.value);
                clearPreview();
              }}
            >
              {EFFORTS.map((e) => (
                <option key={e.v} value={e.v} title={e.hint}>
                  {e.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label>Permission mode</label>
            <select
              value={permissionMode}
              onChange={(e) => {
                setPermissionMode(e.target.value);
                clearPreview();
              }}
            >
              {PERMISSION_MODES.map((m) => (
                <option key={m.v} value={m.v}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="muted effort-note">
          Effort is passed as <code>--effort</code> and recorded per turn by the 5-family models; models
          without effort levels (e.g. Haiku 4.5) accept the flag and ignore it, so no effort shows on the session.
        </div>

        <label className="checkline">
          <input
            type="checkbox"
            checked={collab}
            onChange={(e) => {
              setCollab(e.target.checked);
              clearPreview();
            }}
          />
          Collaboration — let this session <b>read</b> other sessions (read-only)
        </label>
        {collab && (
          <>
            <PeerPicker
              candidates={candidates}
              selected={peers}
              onChange={(ids) => {
                setPeers(ids);
                clearPreview();
              }}
            />
            <p className={`collab-hint ${permissionMode === 'plan' ? 'warn' : 'muted'}`}>
              {permissionMode === 'plan'
                ? '⚠ Plan mode blocks MCP tools — choose "Default" (or higher) above so peer reading works.'
                : 'Peer reading adds MCP tools a capable model loads on demand; small models may not use them reliably.'}
            </p>
          </>
        )}

        <label className="checkline">
          <input
            type="checkbox"
            checked={dryRun}
            onChange={(e) => {
              setDryRun(e.target.checked);
              clearPreview();
            }}
          />
          Dry run — just show the command, don't spawn
        </label>

        {preview && (
          <div className="cmd-preview">
            <div className="muted">Would run (cwd: {preview.cwd}):</div>
            <code>{preview.command}</code>
            <div className="muted">Your prompt is piped to the CLI via stdin (handles newlines &amp; special characters).</div>
            {att.images.length > 0 && (
              <div className="muted">
                + {att.images.length} image{att.images.length === 1 ? '' : 's'} sent as content blocks (stdin, stream-json).
              </div>
            )}
            <div className="muted">Transcript → {preview.filePath}</div>
          </div>
        )}
        {error && <div className="error-box">{error}</div>}

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || (!prompt.trim() && !att.images.length)} onClick={submit}>
            {busy ? 'Working…' : dryRun ? 'Preview command' : 'Launch & watch'}
          </button>
        </div>
      </div>

      {browsing && (
        <DirectoryBrowser
          start={cwd}
          onPick={(p) => {
            setCwd(p);
            clearPreview();
            setBrowsing(false);
          }}
          onClose={() => setBrowsing(false)}
        />
      )}
    </div>
  );
}
