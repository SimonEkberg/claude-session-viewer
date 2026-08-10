import type { NormEvent } from './types';

export type DiffLine = { type: 'ctx' | 'add' | 'del'; text: string };

/**
 * Minimal line-level diff (LCS). Good enough for a git-style side view; caps size
 * so a pathological input can't lock the tab.
 */
export function lineDiff(a: string, b: string): DiffLine[] {
  const A = a.length ? a.split('\n') : [];
  const B = b.length ? b.split('\n') : [];
  const n = A.length;
  const m = B.length;

  if (n === 0) return B.map((text) => ({ type: 'add' as const, text }));
  if (m === 0) return A.map((text) => ({ type: 'del' as const, text }));
  if (n * m > 4_000_000) {
    // too large for the O(n·m) table — fall back to a coarse replace-all view
    return [...A.map((text) => ({ type: 'del' as const, text })), ...B.map((text) => ({ type: 'add' as const, text }))];
  }

  const dp: Int32Array[] = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      out.push({ type: 'ctx', text: A[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: 'del', text: A[i] });
      i++;
    } else {
      out.push({ type: 'add', text: B[j] });
      j++;
    }
  }
  while (i < n) out.push({ type: 'del', text: A[i++] });
  while (j < m) out.push({ type: 'add', text: B[j++] });
  return out;
}

export interface FileChange {
  kind: 'write' | 'edit';
  ts: string | null;
  seq: number;
  isNewFile: boolean; // write with no prior in-session version
  before: string;
  after: string;
}

/**
 * Reconstructs the sequence of changes to a file from the session's Write/Edit tool
 * inputs, tracking the running in-session content so a Write can be diffed against
 * the version that preceded it. Edits carry their own exact old→new strings.
 */
export function fileChanges(events: NormEvent[], target: string): FileChange[] {
  const current = new Map<string, string>();
  const changes: FileChange[] = [];

  for (const e of events) {
    if (e.kind !== 'tool_call') continue;
    const inp = e.input as any;
    const p: string | undefined = inp?.file_path;
    if (!p) continue;

    if (e.tool === 'Write') {
      const before = current.get(p);
      const after = String(inp.content ?? '');
      if (p === target)
        changes.push({ kind: 'write', ts: e.ts, seq: e.seq, isNewFile: before === undefined, before: before ?? '', after });
      current.set(p, after);
    } else if (e.tool === 'Edit') {
      const before = current.get(p);
      const oldS = String(inp.old_string ?? '');
      const newS = String(inp.new_string ?? '');
      if (p === target)
        changes.push({ kind: 'edit', ts: e.ts, seq: e.seq, isNewFile: false, before: oldS, after: newS });
      if (before !== undefined) {
        const updated = inp.replace_all ? before.split(oldS).join(newS) : before.replace(oldS, newS);
        current.set(p, updated);
      }
    }
  }
  return changes;
}
