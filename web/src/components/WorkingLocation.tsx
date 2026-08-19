import { useMemo } from 'react';
import type { FullSession, NormEvent } from '../types';

/**
 * A live "where is Claude working" card, shown while a session is actively working.
 *
 * It reads like a terminal prompt: the session's working directory — the real cwd
 * every Bash/file tool runs from — followed by whatever Claude is doing right now.
 * The point is to let you glance and confirm Claude is poking around the directory
 * you expect (e.g. searching the right repo), not somewhere unexpected.
 */
export function WorkingLocation({ session }: { session: FullSession }) {
  const cwd = session.cwd || '(working directory unknown)';

  // The most recent tool call is what Claude is doing right now (still pending) or
  // just did (between tools, while it thinks / writes). Fold in whether its result
  // has landed so we can show a live spinner only while it's genuinely in-flight.
  const { action, pending } = useMemo(() => {
    let last: NormEvent | undefined;
    const done = new Set<string>();
    for (const e of session.events) {
      if (e.kind === 'tool_result' && e.forToolUseId) done.add(e.forToolUseId);
      if (e.kind === 'tool_call') last = e;
    }
    return { action: last, pending: !!last?.toolUseId && !done.has(last.toolUseId) };
  }, [session.events]);

  return (
    <div className="work-loc" role="status" aria-live="polite">
      <div className="work-loc-head">
        <span className="spinner" /> working in
      </div>
      <div className="work-loc-line">
        <span className="wl-path" title={cwd}>
          {cwd}
        </span>
        <span className="wl-sep">&gt;</span>
        {action ? (
          <span className={`wl-action ${pending ? 'pending' : 'done'}`}>
            <span className="wl-tool">{action.tool}</span>
            {action.target ? (
              <span className="wl-target" title={action.target}>
                {action.target}
              </span>
            ) : null}
            {pending ? <span className="spinner wl-spin" /> : null}
          </span>
        ) : (
          <span className="wl-cursor" aria-hidden />
        )}
      </div>
    </div>
  );
}
