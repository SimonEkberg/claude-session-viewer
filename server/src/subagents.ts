import fs from 'node:fs';
import path from 'node:path';

/**
 * Did a background sub-agent actually finish?
 *
 * Claude Code writes each sub-agent's own transcript to
 * `<project>/<session-id>/subagents/agent-<agentId>.jsonl`. That file answers the
 * question directly, and much sooner than a <task-notification> does — a "stopped"
 * notice is only produced when the session is next resumed, so a session that is
 * never picked up again never reports its orphans at all.
 *
 * An agent that finished signs off with an assistant TEXT block (its report). One
 * that was killed mid-run just stops, with the last thing on file being a tool call
 * or its result. Combined with "nothing has been written for a while", that
 * distinguishes a dead agent from one still working.
 */

const TAIL_BYTES = 128 * 1024; // plenty for the last few events, bounded for big transcripts
const STALE_MS = 2 * 60 * 1000; // no writes for this long ⇒ not running any more

export interface AgentOutcome {
  outcome: 'completed' | 'incomplete' | 'unknown';
  lastWriteMs: number | null;
  /** Incomplete AND quiet long enough that it cannot still be working. */
  stale: boolean;
}

function subagentFile(sessionFilePath: string, agentId: string): string {
  const dir = path.dirname(sessionFilePath);
  const sessionId = path.basename(sessionFilePath, '.jsonl');
  return path.join(dir, sessionId, 'subagents', `agent-${agentId}.jsonl`);
}

/** Read only the last TAIL_BYTES of a file, dropping a partial leading line. */
function readTail(file: string, size: number): string {
  const start = Math.max(0, size - TAIL_BYTES);
  const len = size - start;
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buf, 0, len, start);
  } finally {
    fs.closeSync(fd);
  }
  const text = buf.toString('utf8');
  return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
}

export function agentOutcome(sessionFilePath: string, agentId: string, now = Date.now()): AgentOutcome {
  const file = subagentFile(sessionFilePath, agentId);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    // No transcript at all: the agent may not have started, or this session's
    // companion directory was cleaned up. Claim nothing.
    return { outcome: 'unknown', lastWriteMs: null, stale: false };
  }

  let lines: string[];
  try {
    lines = readTail(file, stat.size).split(/\r?\n/).filter((l) => l.trim());
  } catch {
    return { outcome: 'unknown', lastWriteMs: stat.mtimeMs, stale: false };
  }

  const quiet = now - stat.mtimeMs > STALE_MS;
  for (let i = lines.length - 1; i >= 0; i--) {
    let o: any;
    try {
      o = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (o.type !== 'assistant' && o.type !== 'user') continue; // skip bookkeeping lines
    // The sign-off: an assistant turn carrying prose. A turn that only fired tools,
    // or a tool_result, means it was still in the loop when the writing stopped.
    const content = o.message?.content;
    const signedOff =
      o.type === 'assistant' &&
      Array.isArray(content) &&
      content.some((b: any) => b?.type === 'text' && String(b.text || '').trim());
    return {
      outcome: signedOff ? 'completed' : 'incomplete',
      lastWriteMs: stat.mtimeMs,
      stale: !signedOff && quiet,
    };
  }
  return { outcome: 'unknown', lastWriteMs: stat.mtimeMs, stale: false };
}
