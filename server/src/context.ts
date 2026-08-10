/**
 * Context-window occupancy = how full the current conversation is, which is what
 * drives Claude Code's auto-compaction.
 *
 * The window size is exact (per model). The auto-compact *threshold* is NOT stored
 * anywhere locally — Claude Code decides it at runtime — so we treat it as a
 * configurable estimate (default 92% of the window) via AUTO_COMPACT_PCT, and the
 * UI labels it as an estimate. Override a model's window via CONTEXT_WINDOW_OVERRIDES
 * (JSON) if a new model appears.
 */
const WINDOWS: Record<string, number> = {
  'claude-opus-5': 1_000_000,
  'claude-opus-4-8': 1_000_000,
  'claude-opus-4-7': 1_000_000,
  'claude-opus-4-6': 1_000_000,
  'claude-opus-4-5': 200_000,
  'claude-sonnet-5': 1_000_000,
  'claude-sonnet-4-6': 1_000_000,
  'claude-fable-5': 1_000_000,
  'claude-mythos-5': 1_000_000,
  'claude-haiku-4-5': 200_000,
};

const OVERRIDES: Record<string, number> = (() => {
  try {
    return process.env.CONTEXT_WINDOW_OVERRIDES ? JSON.parse(process.env.CONTEXT_WINDOW_OVERRIDES) : {};
  } catch {
    return {};
  }
})();

export const AUTO_COMPACT_FRACTION = Math.min(
  0.99,
  Math.max(0.5, Number(process.env.AUTO_COMPACT_PCT) || 0.92),
);

export function contextWindowFor(model: string | null | undefined): number {
  if (!model) return 200_000;
  if (OVERRIDES[model]) return OVERRIDES[model];
  if (WINDOWS[model]) return WINDOWS[model];
  if (/haiku/i.test(model)) return 200_000;
  if (/opus|sonnet|fable|mythos/i.test(model)) return 1_000_000;
  return 200_000; // conservative default for an unknown model
}

export interface SessionContext {
  tokens: number; // current context size (last assistant turn)
  model: string | null;
  window: number; // model context window
  usedPct: number; // tokens / window  (0..1)
  autoCompactTokens: number; // estimated auto-compact trigger, in tokens
  autoCompactPct: number; // the fraction used for the estimate (e.g. 0.92)
  toCompactPct: number; // tokens / autoCompactTokens  (0..1+, how close to auto-compact)
}

export function computeContext(tokens: number, model: string | null): SessionContext {
  const window = contextWindowFor(model);
  const autoCompactTokens = Math.round(window * AUTO_COMPACT_FRACTION);
  return {
    tokens,
    model,
    window,
    usedPct: window ? tokens / window : 0,
    autoCompactTokens,
    autoCompactPct: AUTO_COMPACT_FRACTION,
    toCompactPct: autoCompactTokens ? tokens / autoCompactTokens : 0,
  };
}
