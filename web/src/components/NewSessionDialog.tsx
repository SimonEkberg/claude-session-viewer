import { useState } from 'react';
import { api } from '../api';
import type { LaunchResult } from '../types';
import { DirectoryBrowser } from './DirectoryBrowser';
import { MODELS, PERMISSION_MODES } from '../constants';

export function NewSessionDialog({
  defaultCwd,
  onClose,
  onLaunched,
}: {
  defaultCwd: string;
  onClose: () => void;
  onLaunched: (id: string) => void;
}) {
  const [prompt, setPrompt] = useState('');
  const [cwd, setCwd] = useState(defaultCwd);
  const [model, setModel] = useState('');
  const [permissionMode, setPermissionMode] = useState('plan');
  const [dryRun, setDryRun] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<LaunchResult | null>(null);
  const [browsing, setBrowsing] = useState(false);

  const submit = async () => {
    setError('');
    setBusy(true);
    try {
      const res = await api.launch({ prompt, cwd, model: model || undefined, permissionMode, dryRun });
      if (dryRun) {
        setPreview(res);
      } else {
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

        <label>Prompt</label>
        <textarea
          rows={5}
          value={prompt}
          placeholder="e.g. Investigate the failing auth test and propose a fix"
          onChange={(e) => setPrompt(e.target.value)}
        />

        <label>Working directory</label>
        <div className="cwd-row">
          <input value={cwd} onChange={(e) => setCwd(e.target.value)} className="mono" />
          <button className="btn" onClick={() => setBrowsing(true)}>
            Browse…
          </button>
        </div>

        <div className="row2">
          <div>
            <label>Model</label>
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              {MODELS.map((m) => (
                <option key={m.v} value={m.v}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label>Permission mode</label>
            <select value={permissionMode} onChange={(e) => setPermissionMode(e.target.value)}>
              {PERMISSION_MODES.map((m) => (
                <option key={m.v} value={m.v}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <label className="checkline">
          <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
          Dry run — just show the command, don't spawn
        </label>

        {preview && (
          <div className="cmd-preview">
            <div className="muted">Would run (cwd: {preview.cwd}):</div>
            <code>{preview.command}</code>
            <div className="muted">Your prompt is piped to the CLI via stdin (handles newlines &amp; special characters).</div>
            <div className="muted">Transcript → {preview.filePath}</div>
          </div>
        )}
        {error && <div className="error-box">{error}</div>}

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !prompt.trim()} onClick={submit}>
            {busy ? 'Working…' : dryRun ? 'Preview command' : 'Launch & watch'}
          </button>
        </div>
      </div>

      {browsing && (
        <DirectoryBrowser
          start={cwd}
          onPick={(p) => {
            setCwd(p);
            setBrowsing(false);
          }}
          onClose={() => setBrowsing(false)}
        />
      )}
    </div>
  );
}
