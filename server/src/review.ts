import type { FullSession, NormEvent } from './transcript.js';

/**
 * Produces a de-noised, linear trace of a session aimed at *another agent* (or a
 * human reviewer): prompt → reasoning → action(target) → result(ok/preview) →
 * conclusion. Injected system-reminders are dropped, reasoning and tool results
 * are truncated. Returned both as structured JSON and as Markdown so a reviewing
 * agent can either parse it or read it.
 */

const REASONING_MAX = 600;
const RESULT_MAX = 400;

export interface ReviewStep {
  seq: number;
  kind: NormEvent['kind'];
  ts: string | null;
  isSidechain: boolean;
  text?: string;
  tool?: string;
  target?: string;
  ok?: boolean;
  preview?: string;
}

export interface Review {
  id: string;
  title: string;
  cwd: string | null;
  gitBranch: string | null;
  model: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  counts: FullSession['counts'];
  filesTouched: FullSession['filesTouched'];
  steps: ReviewStep[];
}

export function buildReview(s: FullSession): Review {
  const resultsByToolUse = new Map<string, NormEvent>();
  for (const e of s.events) if (e.kind === 'tool_result' && e.forToolUseId) resultsByToolUse.set(e.forToolUseId, e);

  const steps: ReviewStep[] = [];
  for (const e of s.events) {
    if (e.kind === 'user_prompt') {
      if (e.injected) continue;
      steps.push({ seq: e.seq, kind: e.kind, ts: e.ts, isSidechain: e.isSidechain, text: e.text });
    } else if (e.kind === 'assistant_text') {
      steps.push({ seq: e.seq, kind: e.kind, ts: e.ts, isSidechain: e.isSidechain, text: e.text });
    } else if (e.kind === 'reasoning') {
      steps.push({
        seq: e.seq,
        kind: e.kind,
        ts: e.ts,
        isSidechain: e.isSidechain,
        text: truncate(e.text, REASONING_MAX),
      });
    } else if (e.kind === 'tool_call') {
      const res = e.toolUseId ? resultsByToolUse.get(e.toolUseId) : undefined;
      steps.push({
        seq: e.seq,
        kind: e.kind,
        ts: e.ts,
        isSidechain: e.isSidechain,
        tool: e.tool,
        target: e.target,
        ok: res?.ok,
        preview: truncate(res?.preview, RESULT_MAX),
      });
    }
    // standalone tool_result rows are folded into their tool_call above
  }

  return {
    id: s.id,
    title: s.title,
    cwd: s.cwd,
    gitBranch: s.gitBranch,
    model: s.model,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    counts: s.counts,
    filesTouched: s.filesTouched,
    steps,
  };
}

export function reviewToMarkdown(r: Review): string {
  const L: string[] = [];
  L.push(`# Session review — ${r.title}`);
  L.push('');
  L.push(`- **id**: \`${r.id}\``);
  if (r.cwd) L.push(`- **cwd**: \`${r.cwd}\`${r.gitBranch ? ` (branch \`${r.gitBranch}\`)` : ''}`);
  if (r.model) L.push(`- **model**: ${r.model}`);
  if (r.createdAt) L.push(`- **span**: ${r.createdAt} → ${r.updatedAt}`);
  const tools = Object.entries(r.counts.byTool)
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `${t}×${n}`)
    .join(', ');
  L.push(
    `- **activity**: ${r.counts.prompts} prompts, ${r.counts.reasoning} reasoning steps, ${r.counts.toolCalls} tool calls${r.counts.errors ? `, ${r.counts.errors} errors` : ''}`,
  );
  if (r.counts.reasoning === 0 && r.counts.reasoningRedacted > 0)
    L.push(
      `- **note**: private reasoning is redacted in this transcript (${r.counts.reasoningRedacted} encrypted thinking blocks); the narrated rationale is in the "Says" steps below.`,
    );
  if (tools) L.push(`- **tools**: ${tools}`);
  if (r.filesTouched.length) {
    L.push('');
    L.push('**Files touched**');
    for (const f of r.filesTouched.slice(0, 40)) L.push(`- \`${f.path}\` — ${f.ops.join('/')} ×${f.count}`);
  }
  L.push('');
  L.push('## Trace');
  for (const s of r.steps) {
    const lane = s.isSidechain ? '↳ (sub-agent) ' : '';
    if (s.kind === 'user_prompt') {
      L.push('', `### 👤 ${lane}Prompt`, '', quote(s.text));
    } else if (s.kind === 'reasoning') {
      L.push('', `#### 💭 ${lane}Reasoning`, '', quote(s.text));
    } else if (s.kind === 'assistant_text') {
      L.push('', `#### 💬 ${lane}Says`, '', quote(s.text));
    } else if (s.kind === 'tool_call') {
      const status = s.ok === undefined ? '' : s.ok ? ' ✓' : ' ✗';
      L.push('', `#### 🔧 ${lane}${s.tool}${status} — \`${s.target ?? ''}\``);
      if (s.preview) L.push('', '```', s.preview, '```');
    }
  }
  return L.join('\n');
}

function truncate(s: string | undefined, max: number): string | undefined {
  if (!s) return s;
  return s.length > max ? s.slice(0, max) + ` …[+${s.length - max} chars]` : s;
}

function quote(s?: string): string {
  return (s || '')
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');
}
