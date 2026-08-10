// Mirrors server/src/transcript.ts + review.ts (kept in sync by hand — small surface).

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
  text?: string;
  injected?: boolean;
  tool?: string;
  target?: string;
  targetKind?: string;
  input?: unknown;
  toolUseId?: string;
  forToolUseId?: string;
  ok?: boolean;
  preview?: string;
  bytes?: number;
}

export interface FileTouch {
  path: string;
  ops: string[];
  count: number;
}

export interface SessionCounts {
  prompts: number;
  assistantText: number;
  reasoning: number;
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
  hasUnpriced: boolean;
  hasEstimated: boolean;
  byModel: Record<string, { tokens: number; costUsd: number }>;
}

export interface SessionContext {
  tokens: number;
  model: string | null;
  window: number;
  usedPct: number;
  autoCompactTokens: number;
  autoCompactPct: number;
  toCompactPct: number;
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

export interface ProjectInfo {
  dir: string;
  cwdGuess: string;
  sessionCount: number;
}

export interface LaunchResult {
  id: string;
  cwd: string;
  projectDir: string;
  filePath: string;
  command: string;
  spawned: boolean;
}

export interface FsEntry {
  name: string;
  path: string;
  isDir: boolean;
}

export interface FsListing {
  path: string;
  parent: string | null;
  sep: string;
  home: string;
  roots: string[];
  entries: FsEntry[];
}

export interface ResumeResult {
  id: string;
  command: string;
  spawned: boolean;
}

export interface UsageWindow {
  label: string;
  hours: number;
  costUsd: number;
  totalTokens: number;
  sessions: number;
  hasUnpriced: boolean;
}

export interface UsageWindowsResponse {
  computedAt: string;
  windows: UsageWindow[];
}

/** What a clicked stat/badge focuses the timeline on. */
export type Focus =
  | { type: 'kind'; kind: EventKind; label: string }
  | { type: 'prompts'; label: string }
  | { type: 'errors'; label: string }
  | { type: 'tool'; tool: string; label: string };
