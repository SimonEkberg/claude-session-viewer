import fs from 'node:fs';
import path from 'node:path';
import { priceUsage, type RawUsage } from './pricing.js';
import { computeContext, type SessionContext } from './context.js';

/**
 * The transcript parser + normalizer.
 *
 * A Claude Code transcript is JSONL: one event per line. Most lines are bookkeeping
 * (queue-operation, file-history-snapshot, ai-title, last-prompt, attachment). The
 * events that carry the actual decision-making live in `type: "assistant"` and
 * `type: "user"` messages, whose `message.content[]` is an array of typed blocks:
 *
 *   assistant → thinking  (the WHY — stated reasoning)
 *             → text      (conclusions / explanations to the user)
 *             → tool_use  (the WHAT — {name, input, id})
 *   user      → tool_result ({tool_use_id, content, is_error})  ← result of a tool_use
 *             → text        (a real user prompt, or an injected system-reminder)
 *
 * We flatten those into a single ordered stream of NormEvent — the "decision map".
 * A tool_result links back to its tool_use via forToolUseId, so the UI can render
 * action→result as one unit and other agents can follow cause→effect.
 */

export type EventKind =
  | 'user_prompt'
  | 'reasoning'
  | 'assistant_text'
  | 'tool_call'
  | 'tool_result';

export interface NormEvent {
  seq: number;
  uuid: string | null;
  parentUuid: string | null;
  ts: string | null;
  isSidechain: boolean;
  kind: EventKind;
  model?: string;

  // user_prompt / assistant_text / reasoning
  text?: string;
  injected?: boolean; // user_prompt that is actually a system-reminder / slash-command scaffold

  // tool_call
  tool?: string;
  target?: string; // human summary of what the tool acted on (file path, command, url, query…)
  targetKind?: string; // file | command | url | query | pattern | agent | workflow | meta | other
  input?: unknown;
  toolUseId?: string;

  // tool_result
  forToolUseId?: string;
  ok?: boolean;
  preview?: string;
  bytes?: number;
}

export interface FileTouch {
  path: string;
  ops: string[]; // read | edit | write
  count: number;
}

export interface SessionCounts {
  prompts: number;
  assistantText: number;
  reasoning: number;
  /** thinking blocks present but empty (encrypted/redacted signature-only) — no plaintext to show */
  reasoningRedacted: number;
  toolCalls: number;
  errors: number;
  byTool: Record<string, number>;
}

export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
  /** true if any assistant message used a model with no known price at all (cost is a lower bound) */
  hasUnpriced: boolean;
  /** true if any cost was priced via family fallback (an unknown model priced by tier) */
  hasEstimated: boolean;
  byModel: Record<string, { tokens: number; costUsd: number }>;
}

export interface SessionSummary {
  id: string;
  projectDir: string;
  filePath: string;
  title: string;
  cwd: string | null;
  gitBranch: string | null;
  version: string | null;
  model: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  mtimeMs: number;
  sizeBytes: number;
  counts: SessionCounts;
  usage: SessionUsage;
  context: SessionContext;
}

export interface FullSession extends SessionSummary {
  events: NormEvent[];
  filesTouched: FileTouch[];
}

const RESULT_PREVIEW_MAX = 4000;

function firstLine(s: unknown, max = 200): string {
  return String(s ?? '').split('\n')[0].slice(0, max);
}

/** Reduce a tool_use input to a one-line human summary + a kind for iconography. */
function summarizeTool(name: string, input: any): { target?: string; targetKind?: string } {
  if (!input || typeof input !== 'object') return { targetKind: 'meta' };
  switch (name) {
    case 'Read':
    case 'Edit':
    case 'Write':
      return { target: input.file_path, targetKind: 'file' };
    case 'NotebookEdit':
      return { target: input.notebook_path, targetKind: 'file' };
    case 'Grep':
      return {
        target: `${input.pattern}${input.glob ? ` (${input.glob})` : ''}${input.path ? ` in ${input.path}` : ''}`,
        targetKind: 'pattern',
      };
    case 'Glob':
      return { target: `${input.pattern}${input.path ? ` in ${input.path}` : ''}`, targetKind: 'pattern' };
    case 'Bash':
    case 'PowerShell':
      return { target: firstLine(input.command), targetKind: 'command' };
    case 'WebFetch':
      return { target: input.url, targetKind: 'url' };
    case 'WebSearch':
      return { target: input.query, targetKind: 'query' };
    case 'Task':
    case 'Agent':
      return { target: input.description || input.subagent_type || 'sub-agent', targetKind: 'agent' };
    case 'ToolSearch':
      return { target: input.query, targetKind: 'query' };
    case 'TodoWrite':
      return { target: `${(input.todos || []).length} todos`, targetKind: 'meta' };
    case 'Workflow':
      return { target: input.name || 'inline script', targetKind: 'workflow' };
    case 'Skill':
      return { target: input.skill, targetKind: 'meta' };
    default:
      try {
        return { target: firstLine(JSON.stringify(input), 160), targetKind: 'other' };
      } catch {
        return { targetKind: 'other' };
      }
  }
}

/** tool_result.content is either a string or an array of blocks; flatten to text. */
function resultText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        typeof b === 'string'
          ? b
          : b?.type === 'text'
            ? b.text
            : b?.type === 'image'
              ? '[image]'
              : JSON.stringify(b),
      )
      .join('\n');
  }
  if (content == null) return '';
  return JSON.stringify(content);
}

export function parseSession(filePath: string): FullSession {
  const raw = fs.readFileSync(filePath, 'utf8');
  const stat = fs.statSync(filePath);
  const lines = raw.split(/\r?\n/);

  const events: NormEvent[] = [];
  let title = '';
  let cwd: string | null = null;
  let gitBranch: string | null = null;
  let version: string | null = null;
  let model: string | null = null;
  let createdAt: string | null = null;
  let updatedAt: string | null = null;

  const byTool: Record<string, number> = {};
  let toolCalls = 0;
  let errors = 0;
  let prompts = 0;
  let assistantText = 0;
  let reasoning = 0;
  let reasoningRedacted = 0;
  const files: Record<string, { path: string; ops: Set<string>; count: number }> = {};

  let seq = 0;

  const usage: SessionUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    hasUnpriced: false,
    hasEstimated: false,
    byModel: {},
  };
  let lastCtxTokens = 0; // current context size = last assistant turn's prompt
  let lastModel: string | null = null;

  for (const line of lines) {
    if (!line.trim()) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }

    const ts: string | null = o.timestamp || null;
    if (ts) {
      if (!createdAt) createdAt = ts;
      updatedAt = ts;
    }
    if (o.cwd && !cwd) cwd = o.cwd;
    if (o.gitBranch != null && gitBranch == null) gitBranch = o.gitBranch;
    if (o.version && !version) version = o.version;
    if (o.type === 'ai-title' && o.aiTitle) title = o.aiTitle;

    const msg = o.message;
    if (msg?.model && !model) model = msg.model;

    if (o.type === 'assistant' && msg) {
      if (msg.usage) {
        const d = priceUsage(msg.model, msg.usage as RawUsage);
        usage.inputTokens += d.inputTokens;
        usage.outputTokens += d.outputTokens;
        usage.cacheReadTokens += d.cacheReadTokens;
        usage.cacheWriteTokens += d.cacheWrite5mTokens + d.cacheWrite1hTokens;
        usage.costUsd += d.costUsd;
        if (!d.priced && (d.inputTokens || d.outputTokens)) usage.hasUnpriced = true;
        if (d.estimated) usage.hasEstimated = true;
        // current context = the prompt this turn saw (input + both cache buckets)
        lastCtxTokens = d.inputTokens + d.cacheReadTokens + d.cacheWrite5mTokens + d.cacheWrite1hTokens;
        lastModel = msg.model || lastModel;
        const mkey = msg.model || 'unknown';
        const tokens = d.inputTokens + d.outputTokens + d.cacheReadTokens + d.cacheWrite5mTokens + d.cacheWrite1hTokens;
        const bm = (usage.byModel[mkey] ||= { tokens: 0, costUsd: 0 });
        bm.tokens += tokens;
        bm.costUsd += d.costUsd;
      }
    }

    if (o.type === 'assistant' && msg && Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b.type === 'thinking') {
          const t = (b.thinking || '').trim();
          if (!t) {
            // block exists but carries only an encrypted signature — reasoning is redacted
            if (b.signature) reasoningRedacted++;
            continue;
          }
          events.push(base('reasoning', o, ts, seq++, { text: t, model: msg.model }));
          reasoning++;
        } else if (b.type === 'text') {
          const t = (b.text || '').trim();
          if (!t) continue;
          events.push(base('assistant_text', o, ts, seq++, { text: t, model: msg.model }));
          assistantText++;
        } else if (b.type === 'tool_use') {
          const { target, targetKind } = summarizeTool(b.name, b.input);
          events.push(
            base('tool_call', o, ts, seq++, {
              tool: b.name,
              target,
              targetKind,
              input: b.input,
              toolUseId: b.id,
              model: msg.model,
            }),
          );
          toolCalls++;
          byTool[b.name] = (byTool[b.name] || 0) + 1;
          const p = b.input?.file_path || b.input?.notebook_path;
          if (p && ['Read', 'Edit', 'Write', 'NotebookEdit'].includes(b.name)) {
            const op = b.name === 'Read' ? 'read' : b.name === 'Write' ? 'write' : 'edit';
            const f = (files[p] ||= { path: p, ops: new Set(), count: 0 });
            f.ops.add(op);
            f.count++;
          }
        }
      }
    } else if (o.type === 'user' && msg) {
      const content = msg.content;
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b.type === 'tool_result') {
            const txt = resultText(b.content);
            events.push(
              base('tool_result', o, ts, seq++, {
                forToolUseId: b.tool_use_id,
                ok: !b.is_error,
                preview: txt.slice(0, RESULT_PREVIEW_MAX),
                bytes: txt.length,
              }),
            );
            if (b.is_error) errors++;
          } else if (b.type === 'text') {
            pushPrompt(b.text);
          }
        }
      } else if (typeof content === 'string') {
        pushPrompt(content);
      }
    }

    function pushPrompt(text: string) {
      const t = (text || '').trim();
      if (!t) return;
      const injected = t.startsWith('<system-reminder>') || t.startsWith('<command-') || t.startsWith('<local-command');
      events.push(base('user_prompt', o, ts, seq++, { text: t, injected }));
      if (!injected) prompts++;
    }
  }

  const id = path.basename(filePath).replace(/\.jsonl$/, '');
  if (!title) {
    const firstPrompt = events.find((e) => e.kind === 'user_prompt' && !e.injected);
    title = firstPrompt?.text?.slice(0, 80) || id.slice(0, 8);
  }

  usage.totalTokens =
    usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;

  const filesTouched: FileTouch[] = Object.values(files)
    .map((f) => ({ path: f.path, ops: [...f.ops], count: f.count }))
    .sort((a, b) => b.count - a.count);

  return {
    id,
    filePath,
    projectDir: path.basename(path.dirname(filePath)),
    title,
    cwd,
    gitBranch,
    version,
    model,
    createdAt,
    updatedAt,
    mtimeMs: stat.mtimeMs,
    sizeBytes: stat.size,
    counts: { prompts, assistantText, reasoning, reasoningRedacted, toolCalls, errors, byTool },
    usage,
    context: computeContext(lastCtxTokens, lastModel || model),
    events,
    filesTouched,
  };
}

/** Cheap summary (drops the events array) for the session list. */
export function summarize(s: FullSession): SessionSummary {
  const { events, filesTouched, ...summary } = s;
  return summary;
}

function base(
  kind: EventKind,
  o: any,
  ts: string | null,
  seq: number,
  extra: Partial<NormEvent>,
): NormEvent {
  return {
    seq,
    uuid: o.uuid ?? null,
    parentUuid: o.parentUuid ?? null,
    ts,
    isSidechain: !!o.isSidechain,
    kind,
    ...extra,
  };
}
