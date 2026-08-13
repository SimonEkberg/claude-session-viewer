import { useEffect, useMemo, useRef, useState } from 'react';
import type { Focus, FullSession, NormEvent } from '../types';
import { clock, fileName, bytes, TOOL_ICON } from '../util';
import { DiffDialog } from './DiffDialog';

type Filters = {
  reasoning: boolean;
  tools: boolean;
  text: boolean;
  prompts: boolean;
  injected: boolean;
};

const DEFAULT_FILTERS: Filters = {
  reasoning: true,
  tools: true,
  text: true,
  prompts: true,
  injected: false,
};

export function Timeline({
  session,
  focus,
  onClearFocus,
}: {
  session: FullSession;
  focus: Focus | null;
  onClearFocus: () => void;
}) {
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [diffPath, setDiffPath] = useState<string | null>(null); // Write/Edit preview

  // Pair each tool_result to its originating tool_call so we render action→result as one unit.
  const resultFor = useMemo(() => {
    const m = new Map<string, NormEvent>();
    for (const e of session.events)
      if (e.kind === 'tool_result' && e.forToolUseId) m.set(e.forToolUseId, e);
    return m;
  }, [session]);

  // tool_result events are always folded into their tool_call and never shown on
  // their own, so exclude them from the "N / M events" denominator — otherwise the
  // count implies filters are hiding rows that were never displayable.
  const shownable = useMemo(
    () => session.events.filter((e) => e.kind !== 'tool_result').length,
    [session],
  );

  const matchesFocus = (e: NormEvent): boolean => {
    if (!focus) return true;
    switch (focus.type) {
      case 'prompts':
        return e.kind === 'user_prompt' && !e.injected;
      case 'kind':
        return e.kind === focus.kind;
      case 'errors':
        return e.kind === 'tool_call' && !!e.toolUseId && resultFor.get(e.toolUseId)?.ok === false;
      case 'tool':
        return e.kind === 'tool_call' && e.tool === focus.tool;
    }
  };

  const visible = session.events.filter((e) => {
    if (e.kind === 'tool_result') return false; // folded into its tool_call
    if (focus) return matchesFocus(e); // focus overrides the chip filters
    if (e.kind === 'reasoning') return filters.reasoning;
    if (e.kind === 'tool_call') return filters.tools;
    if (e.kind === 'assistant_text') return filters.text;
    if (e.kind === 'user_prompt') return e.injected ? filters.injected : filters.prompts;
    return true;
  });

  // --- Land on the latest row automatically ---------------------------------
  const endRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true); // whether new content should keep us pinned to the bottom
  const prevTotal = useRef(session.events.length);
  const [atBottom, setAtBottom] = useState(true);

  const scrollToEnd = (behavior: ScrollBehavior = 'auto') =>
    requestAnimationFrame(() => endRef.current?.scrollIntoView({ block: 'end', behavior }));

  // On session change (and initial mount / tab return, which remounts): jump to latest.
  useEffect(() => {
    stick.current = true;
    setAtBottom(true);
    scrollToEnd('auto');
    prevTotal.current = session.events.length;
  }, [session.id]);

  // Live growth: only auto-follow if the user is pinned to the bottom. Filtering
  // (which also changes `visible`) does NOT move the viewport — we key off the raw
  // event count so a filter change never yanks the scroll position.
  useEffect(() => {
    if (session.events.length > prevTotal.current && stick.current) scrollToEnd('smooth');
    prevTotal.current = session.events.length;
  }, [session.events.length]);

  // Track scroll position to toggle the follow behaviour + the jump button.
  useEffect(() => {
    const el = endRef.current?.closest('.content-area') as HTMLElement | null;
    if (!el) return;
    const onScroll = () => {
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
      const near = dist < 140;
      stick.current = near;
      setAtBottom(near);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => el.removeEventListener('scroll', onScroll);
  }, [session.id]);

  return (
    <div className="timeline">
      {focus && (
        <div className="focus-banner">
          <span>
            Inspecting <b>{focus.label}</b> — {visible.length} {visible.length === 1 ? 'event' : 'events'}
          </span>
          <button className="chip on" onClick={onClearFocus}>
            ✕ clear
          </button>
        </div>
      )}
      <div className={`filters ${focus ? 'dimmed' : ''}`}>
        {(
          [
            ['prompts', 'Prompts'],
            ['reasoning', 'Reasoning'],
            ['tools', 'Tools'],
            ['text', 'Says'],
            ['injected', 'System'],
          ] as [keyof Filters, string][]
        ).map(([k, label]) => (
          <button
            key={k}
            className={`chip ${!focus && filters[k] ? 'on' : ''}`}
            onClick={() => {
              onClearFocus();
              setFilters((f) => ({ ...f, [k]: !f[k] }));
            }}
          >
            {label}
          </button>
        ))}
        <span className="filters-count">
          {visible.length} / {shownable} events
        </span>
      </div>

      <div className="rail">
        {visible.map((e) => (
          <Row
            key={e.seq}
            e={e}
            result={e.toolUseId ? resultFor.get(e.toolUseId) : undefined}
            onPreview={setDiffPath}
          />
        ))}
        <div ref={endRef} className="rail-end" />
      </div>

      {!atBottom && (
        <button
          className="jump-latest"
          onClick={() => {
            stick.current = true;
            setAtBottom(true);
            scrollToEnd('smooth');
          }}
        >
          ↓ latest
        </button>
      )}

      {diffPath && <DiffDialog session={session} path={diffPath} onClose={() => setDiffPath(null)} />}
    </div>
  );
}

function Row({ e, result, onPreview }: { e: NormEvent; result?: NormEvent; onPreview?: (path: string) => void }) {
  if (e.kind === 'user_prompt') {
    return (
      <Node dotClass={e.injected ? 'dot-system' : 'dot-prompt'} sidechain={e.isSidechain} ts={e.ts}>
        <div className={`card ${e.injected ? 'card-system' : 'card-prompt'}`}>
          <div className="card-head">
            <span className="glyph">{e.injected ? '⚙' : '👤'}</span>
            <span className="card-title">{e.injected ? 'System / injected' : 'User prompt'}</span>
          </div>
          <Collapsible text={e.text || ''} lines={e.injected ? 2 : 8} />
        </div>
      </Node>
    );
  }

  if (e.kind === 'reasoning') {
    return (
      <Node dotClass="dot-reason" sidechain={e.isSidechain} ts={e.ts}>
        <div className="card card-reason">
          <div className="card-head">
            <span className="glyph">💭</span>
            <span className="card-title">Reasoning — why</span>
          </div>
          <Collapsible text={e.text || ''} lines={4} />
        </div>
      </Node>
    );
  }

  if (e.kind === 'assistant_text') {
    return (
      <Node dotClass="dot-say" sidechain={e.isSidechain} ts={e.ts}>
        <div className="card card-say">
          <div className="card-head">
            <span className="glyph">💬</span>
            <span className="card-title">Claude says</span>
          </div>
          <Collapsible text={e.text || ''} lines={8} />
        </div>
      </Node>
    );
  }

  // tool_call (+ folded result)
  const ok = result?.ok;
  const status = ok === undefined ? 'pending' : ok ? 'ok' : 'error';
  // Write/Edit inputs carry the content, so we can reconstruct + preview the file
  // (same diff view the Files tab uses) straight from the decision map.
  const canPreview = (e.tool === 'Write' || e.tool === 'Edit') && e.targetKind === 'file' && !!e.target && !!onPreview;
  return (
    <Node dotClass={`dot-tool ${status}`} spinning={status === 'pending'} sidechain={e.isSidechain} ts={e.ts}>
      <div className={`card card-tool ${status}`}>
        <div className="card-head">
          <span className="glyph">{TOOL_ICON[e.targetKind || 'other'] || '🔧'}</span>
          <span className="tool-name">{e.tool}</span>
          {e.targetKind === 'file' ? (
            <span
              className={`target ${canPreview ? 'clickable' : ''}`}
              title={canPreview ? `Preview ${e.target}` : e.target}
              onClick={canPreview ? () => onPreview!(e.target!) : undefined}
            >
              {fileName(e.target)}
            </span>
          ) : (
            <span className="target mono" title={e.target}>
              {e.target}
            </span>
          )}
          <span className={`status-pill ${status}`}>
            {status === 'pending' ? (
              <>
                <span className="spinner" /> running…
              </>
            ) : status === 'ok' ? (
              '✓'
            ) : (
              '✗ error'
            )}
            {result?.bytes ? ` ${bytes(result.bytes)}` : ''}
          </span>
          {canPreview && (
            <button className="btn tiny preview-btn" title="Preview file changes" onClick={() => onPreview!(e.target!)}>
              ⇄ preview
            </button>
          )}
        </div>
        {result?.preview ? <Collapsible text={result.preview} lines={3} mono /> : null}
      </div>
    </Node>
  );
}

function Node({
  children,
  dotClass,
  spinning,
  sidechain,
  ts,
}: {
  children: React.ReactNode;
  dotClass: string;
  spinning?: boolean;
  sidechain: boolean;
  ts: string | null;
}) {
  return (
    <div className={`node ${sidechain ? 'sidechain' : ''}`}>
      <div className="gutter">
        {spinning ? <span className="spinner gutter-spinner" /> : <span className={`dot ${dotClass}`} />}
        <span className="ts">{clock(ts)}</span>
      </div>
      <div className="body">
        {sidechain && <span className="sub-badge">sub-agent</span>}
        {children}
      </div>
    </div>
  );
}

function Collapsible({
  text,
  lines,
  mono,
}: {
  text: string;
  lines: number;
  mono?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const isLong = text.split('\n').length > lines || text.length > lines * 90;
  return (
    <div className={`content ${mono ? 'mono' : ''} ${open || !isLong ? 'open' : 'clamped'}`}
         style={!open && isLong ? ({ ['--lines' as any]: lines }) : undefined}>
      <pre>{text}</pre>
      {isLong && (
        <button className="more" onClick={() => setOpen((o) => !o)}>
          {open ? '▲ less' : '▼ more'}
        </button>
      )}
    </div>
  );
}
