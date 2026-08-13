import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { Focus, FullSession, UsageWindow } from '../types';
import { fileName, usd, tokens, copyText } from '../util';
import { DiffDialog } from './DiffDialog';
import type { SessionUsage } from '../types';

// "$X+" when some models have no known price (lower bound); "≈$X" when priced via
// family-estimate; plain "$X" when all exact.
function costLabel(u: SessionUsage): string {
  if (u.hasUnpriced) return `${usd(u.costUsd)}+`;
  if (u.hasEstimated) return `≈${usd(u.costUsd)}`;
  return usd(u.costUsd);
}

// Whether the current focus is the same one a stat/badge would set — used to make
// each stat/badge a toggle (click again to deselect).
function sameFocus(a: Focus | null, b: Focus): boolean {
  if (!a || a.type !== b.type) return false;
  if (a.type === 'kind' && b.type === 'kind') return a.kind === b.kind;
  if (a.type === 'tool' && b.type === 'tool') return a.tool === b.tool;
  return true; // 'prompts' | 'errors' have no extra discriminator
}

type Tab = 'timeline' | 'files' | 'review';

export function SessionHeader({
  session,
  live,
  working,
  onBack,
  onToggleLive,
  tab,
  onTab,
  focus,
  onInspect,
}: {
  session: FullSession;
  live: boolean;
  working: boolean;
  onBack: () => void;
  onToggleLive: () => void;
  tab: Tab;
  onTab: (t: Tab) => void;
  focus: Focus | null;
  onInspect: (f: Focus | null) => void;
}) {
  const c = session.counts;
  const u = session.usage;
  const [showUsage, setShowUsage] = useState(false);
  const topTools = Object.entries(c.byTool).sort((a, b) => b[1] - a[1]);

  // A stat is "active" when the timeline is currently focused on it (and we're on the timeline tab).
  const activeKind = tab === 'timeline' && focus?.type === 'kind' ? focus.kind : null;
  const activeSpecial = tab === 'timeline' ? focus?.type : null;

  // Set the focus, or clear it if it's already the active one (click-to-toggle).
  // The "clear" banner in the timeline still works too.
  const applyFocus = (f: Focus) => {
    const isActive = tab === 'timeline' && sameFocus(focus, f);
    onTab('timeline');
    onInspect(isActive ? null : f);
  };

  return (
    <header className="session-header">
      <div className="sh-title-row">
        <button className="mobile-back" onClick={onBack} title="Back to sessions">
          ‹ Sessions
        </button>
        <h1 title={session.id}>{session.title}</h1>
        <div className="sh-status">
          {live && (
            <span className={`work-chip ${working ? 'working' : 'idle'}`}>
              {working ? (
                <>
                  <span className="spinner" /> working…
                </>
              ) : (
                <>
                  <span className="idle-dot" /> idle
                </>
              )}
            </span>
          )}
          <button className={`live-toggle ${live ? 'on' : ''}`} onClick={onToggleLive}>
            <span className="live-dot" /> {live ? 'Live' : 'Go live'}
          </button>
        </div>
      </div>

      <div className="sh-meta">
        <CopyIdChip id={session.id} />
        {session.cwd && <span className="mono" title={session.cwd}>📁 {session.cwd}</span>}
        {session.gitBranch && <span className="mono">⑂ {session.gitBranch}</span>}
        {session.model && <span className="pill">{session.model}</span>}
        {session.version && <span className="muted">cc {session.version}</span>}
        {c.reasoning === 0 && c.reasoningRedacted > 0 && (
          <span className="redacted-note" title="Thinking blocks are present but carry only an encrypted signature, so the private reasoning text isn't in the transcript. The narrated 'why' is in the 'Claude says' cards.">
            🔒 reasoning redacted ({c.reasoningRedacted})
          </span>
        )}
      </div>

      <div className="stat-row">
        <Stat n={c.prompts} label="prompts" active={activeSpecial === 'prompts'} onClick={() => applyFocus({ type: 'prompts', label: 'Prompts' })} />
        <Stat n={c.reasoning} label="reasoning" active={activeKind === 'reasoning'} onClick={() => applyFocus({ type: 'kind', kind: 'reasoning', label: 'Reasoning' })} />
        <Stat n={c.toolCalls} label="tool calls" active={activeKind === 'tool_call'} onClick={() => applyFocus({ type: 'kind', kind: 'tool_call', label: 'Tool calls' })} />
        <Stat n={session.filesTouched.length} label="files" active={tab === 'files'} onClick={() => onTab(tab === 'files' ? 'timeline' : 'files')} />
        {c.errors > 0 && <Stat n={c.errors} label="errors" bad active={activeSpecial === 'errors'} onClick={() => applyFocus({ type: 'errors', label: 'Errors' })} />}
        <Stat
          n={costLabel(u)}
          label={`${tokens(u.totalTokens)} tokens`}
          active={showUsage}
          onClick={() => setShowUsage((s) => !s)}
        />
      </div>

      <ContextMeter session={session} />

      {showUsage && <UsagePanel session={session} />}

      <div className="tool-badges">
        {topTools.map(([t, n]) => (
          <button
            key={t}
            className={`tool-badge clickable ${focus?.type === 'tool' && focus.tool === t && tab === 'timeline' ? 'active' : ''}`}
            onClick={() => applyFocus({ type: 'tool', tool: t, label: t })}
          >
            {t} <b>{n}</b>
          </button>
        ))}
      </div>

      <nav className="tabs">
        {(['timeline', 'files', 'review'] as const).map((t) => (
          <button key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => onTab(t)}>
            {t === 'timeline' ? 'Decision map' : t === 'files' ? `Files (${session.filesTouched.length})` : 'Review export'}
          </button>
        ))}
      </nav>
    </header>
  );
}

function Stat({
  n,
  label,
  bad,
  active,
  onClick,
}: {
  n: number | string;
  label: string;
  bad?: boolean;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button className={`stat ${bad ? 'bad' : ''} ${active ? 'active' : ''}`} onClick={onClick} disabled={!onClick}>
      <span className="stat-n">{n}</span>
      <span className="stat-l">{label}</span>
    </button>
  );
}

function ContextMeter({ session }: { session: FullSession }) {
  const c = session.context;
  if (!c || !c.tokens) return null;

  const toCompact = Math.min(1, c.toCompactPct);
  const level = toCompact < 0.7 ? 'ok' : toCompact < 0.9 ? 'warn' : 'hot';
  const remainingPct = Math.max(0, Math.round((1 - c.toCompactPct) * 100));

  return (
    <div className="ctx-meter">
      <div className="ctx-row">
        <span className="ctx-label">context</span>
        <div className="ctx-bar" title={`${c.tokens.toLocaleString()} / ${c.window.toLocaleString()} tokens`}>
          <div className={`ctx-fill ${level}`} style={{ width: `${Math.min(100, c.usedPct * 100)}%` }} />
          <div className="ctx-mark" style={{ left: `${c.autoCompactPct * 100}%` }} title={`auto-compact ≈ ${Math.round(c.autoCompactPct * 100)}% of window (estimate)`} />
        </div>
        <span className={`ctx-num ${level}`}>
          {tokens(c.tokens)} / {tokens(c.window)}
        </span>
      </div>
      <div className="ctx-sub">
        <b className={level}>{remainingPct}%</b> of context left before auto-compact
        <span
          className="est"
          title="Auto-compact fires when Claude Code decides the context is nearly full; the exact trigger isn't stored locally, so this uses an estimated threshold (~92% of the window, set via AUTO_COMPACT_PCT)."
        >
          estimate ⓘ
        </span>
      </div>
    </div>
  );
}

function UsagePanel({ session }: { session: FullSession }) {
  const u = session.usage;
  const rows: [string, number][] = [
    ['Input', u.inputTokens],
    ['Output', u.outputTokens],
    ['Cache read', u.cacheReadTokens],
    ['Cache write', u.cacheWriteTokens],
  ];
  return (
    <div className="usage-panel">
      <div className="usage-tokens">
        {rows.map(([k, v]) => (
          <div key={k} className="usage-cell">
            <span className="usage-v">{tokens(v)}</span>
            <span className="usage-k">{k.toLowerCase()}</span>
          </div>
        ))}
        <div className="usage-cell cost">
          <span className="usage-v">{costLabel(u)}</span>
          <span className="usage-k">est. cost</span>
        </div>
      </div>
      <div className="usage-bymodel">
        {Object.entries(u.byModel)
          .sort((a, b) => b[1].costUsd - a[1].costUsd)
          .map(([model, m]) => (
            <span key={model} className="usage-model">
              {model} · {tokens(m.tokens)} · {usd(m.costUsd)}
            </span>
          ))}
      </div>
      {u.hasUnpriced && (
        <div className="usage-note">
          Some turns ran on a model with no known price (e.g. <code>&lt;synthetic&gt;</code>) — cost is a lower bound.
        </div>
      )}
      {u.hasEstimated && (
        <div className="usage-note">
          ≈ Some models were priced by tier (a newer model not in the exact price table) — cost is an estimate.
        </div>
      )}
      <UsageWindows />
    </div>
  );
}

function UsageWindows() {
  const [windows, setWindows] = useState<UsageWindow[] | null>(null);
  useEffect(() => {
    api.usageWindows().then((r) => setWindows(r.windows)).catch(() => setWindows([]));
  }, []);
  if (!windows) return <div className="usage-windows-title">Loading rolling usage…</div>;
  return (
    <>
      <div className="usage-windows-title">
        Rolling usage · all sessions
        <span
          className="est"
          title="Local estimate summed from transcripts over each window — not Anthropic's official 5-hour / weekly limit meter (that's server-side and not stored locally)."
        >
          estimate ⓘ
        </span>
      </div>
      <div className="usage-windows">
        {windows.map((w) => (
          <div key={w.label} className="usage-window">
            <span className="uw-label">last {w.label}</span>
            <span className="uw-cost">{w.hasUnpriced ? `${usd(w.costUsd)}+` : usd(w.costUsd)}</span>
            <span className="uw-sub">
              {tokens(w.totalTokens)} tok · {w.sessions} {w.sessions === 1 ? 'session' : 'sessions'}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

type OpFilter = 'all' | 'write' | 'edit' | 'read';

/** Session id shown short, with a one-click copy of the FULL id (for MCP wiring). */
function CopyIdChip({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  const doCopy = async () => {
    if (await copyText(id)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }
  };
  return (
    <span className="sess-id mono" title={id}>
      <span className="sess-id-k">id</span> {id.slice(0, 8)}…
      <button className="copy-id" title="Copy full session id" onClick={doCopy}>
        {copied ? '✓' : '⧉'}
      </button>
    </span>
  );
}

export function FilesPanel({ session, canReveal }: { session: FullSession; canReveal?: boolean }) {
  const [op, setOp] = useState<OpFilter>('all');
  const [sort, setSort] = useState<'count' | 'name'>('count');
  const [diffPath, setDiffPath] = useState<string | null>(null);
  const [note, setNote] = useState(''); // transient feedback (copied / reveal error)

  const flash = (msg: string) => {
    setNote(msg);
    window.setTimeout(() => setNote(''), 1600);
  };

  const counts = useMemo(() => {
    const c = { write: 0, edit: 0, read: 0 };
    for (const f of session.filesTouched) for (const o of f.ops) if (o in c) (c as any)[o]++;
    return c;
  }, [session]);

  // Files this session actually changed on disk (write/edit) — the cleanup set.
  const changedPaths = useMemo(
    () => session.filesTouched.filter((f) => f.ops.includes('write') || f.ops.includes('edit')).map((f) => f.path),
    [session],
  );

  const files = useMemo(() => {
    let fs = session.filesTouched.filter((f) => op === 'all' || f.ops.includes(op));
    fs = [...fs].sort((a, b) => (sort === 'name' ? fileName(a.path).localeCompare(fileName(b.path)) : b.count - a.count));
    return fs;
  }, [session, op, sort]);

  if (!session.filesTouched.length) return <div className="muted pad">No files read or written.</div>;

  const copyOne = async (p: string) => flash((await copyText(p)) ? 'Copied path' : 'Copy failed');
  const copyChanged = async () =>
    flash(
      (await copyText(changedPaths.join('\n')))
        ? `Copied ${changedPaths.length} path${changedPaths.length === 1 ? '' : 's'}`
        : 'Copy failed',
    );
  const reveal = async (p: string) => {
    try {
      await api.reveal(p);
    } catch (e) {
      flash(String(e instanceof Error ? e.message : e));
    }
  };

  return (
    <div className="files-panel">
      <div className="files-toolbar">
        {(['all', 'write', 'edit', 'read'] as OpFilter[]).map((k) => (
          <button key={k} className={`chip ${op === k ? 'on' : ''}`} onClick={() => setOp(k)}>
            {k === 'all' ? `All (${session.filesTouched.length})` : `${k} (${(counts as any)[k]})`}
          </button>
        ))}
        <span className="files-sort">
          sort:
          <button className={`linkbtn ${sort === 'count' ? 'on' : ''}`} onClick={() => setSort('count')}>
            count
          </button>
          <button className={`linkbtn ${sort === 'name' ? 'on' : ''}`} onClick={() => setSort('name')}>
            name
          </button>
        </span>
        {note && <span className="files-note">{note}</span>}
      </div>

      {changedPaths.length > 0 && (
        <div className="files-cleanup">
          <span className="muted">
            {changedPaths.length} file{changedPaths.length === 1 ? '' : 's'} changed on disk — deleting this session removes only its
            transcript, not these. Copy the paths to review or revert them in git yourself.
          </span>
          <button className="btn tiny" onClick={copyChanged}>
            ⧉ copy changed paths
          </button>
        </div>
      )}

      {files.map((f) => {
        const changed = f.ops.includes('write') || f.ops.includes('edit');
        return (
          <div className="file-row" key={f.path}>
            <div className="file-ops">
              {f.ops.map((o) => (
                <span key={o} className={`op op-${o}`}>
                  {o}
                </span>
              ))}
            </div>
            <div className="file-name">{fileName(f.path)}</div>
            <div className="file-path mono" title={f.path}>
              {f.path}
            </div>
            <div className="file-actions">
              <span className="file-count">×{f.count}</span>
              <button className="btn tiny" title="Copy full path" onClick={() => copyOne(f.path)}>
                ⧉
              </button>
              {canReveal && (
                <button className="btn tiny" title="Reveal in file manager (local only)" onClick={() => reveal(f.path)}>
                  📂
                </button>
              )}
              {changed && (
                <button className="btn tiny" onClick={() => setDiffPath(f.path)}>
                  ⇄ changes
                </button>
              )}
            </div>
          </div>
        );
      })}

      {diffPath && <DiffDialog session={session} path={diffPath} onClose={() => setDiffPath(null)} />}
    </div>
  );
}
