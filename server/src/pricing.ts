/**
 * Token pricing, USD per million tokens. Base input/output rates; cache rates are
 * derived (Anthropic standard multipliers): 5-minute cache write = 1.25× input,
 * 1-hour cache write = 2× input, cache read = 0.1× input.
 *
 * Snapshot as of 2026-08-10. Sonnet 5 is on introductory pricing ($2/$10) through
 * 2026-08-31; standard is $3/$15. Override any of these via PRICING_OVERRIDES env
 * (JSON) if rates change so you don't have to touch code.
 */
export interface ModelRate {
  input: number;
  output: number;
}

const BASE: Record<string, ModelRate> = {
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 }, // intro through 2026-08-31; standard 3/15
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-fable-5': { input: 10, output: 50 },
  'claude-mythos-5': { input: 10, output: 50 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

const OVERRIDES: Record<string, ModelRate> = (() => {
  try {
    return process.env.PRICING_OVERRIDES ? JSON.parse(process.env.PRICING_OVERRIDES) : {};
  } catch {
    return {};
  }
})();

export const CACHE_WRITE_5M = 1.25;
export const CACHE_WRITE_1H = 2;
export const CACHE_READ = 0.1;

// Family fallback so a NEW model (e.g. claude-opus-5) is priced by its tier
// instead of silently showing $0. Marked `estimated` so the UI can flag it.
const FAMILY: [RegExp, ModelRate][] = [
  [/haiku/i, { input: 1, output: 5 }],
  [/(fable|mythos)/i, { input: 10, output: 50 }],
  [/opus/i, { input: 5, output: 25 }],
  [/sonnet/i, { input: 3, output: 15 }],
];

export function rateFor(model: string | undefined | null): { rate: ModelRate; estimated: boolean } | null {
  if (!model) return null;
  if (OVERRIDES[model]) return { rate: OVERRIDES[model], estimated: false };
  if (BASE[model]) return { rate: BASE[model], estimated: false };
  for (const [re, rate] of FAMILY) if (re.test(model)) return { rate, estimated: true };
  return null; // e.g. "<synthetic>" — no real cost
}

export interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
}

export interface UsageDelta {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  costUsd: number;
  priced: boolean; // false when the model has no known rate at all (e.g. <synthetic>)
  estimated: boolean; // true when priced via family fallback (unknown exact rate)
}

/** Compute a per-message usage + cost delta from a raw usage object and its model. */
export function priceUsage(model: string | undefined | null, u: RawUsage): UsageDelta {
  const input = u.input_tokens || 0;
  const output = u.output_tokens || 0;
  const cacheRead = u.cache_read_input_tokens || 0;
  const cw5m = u.cache_creation?.ephemeral_5m_input_tokens ?? u.cache_creation_input_tokens ?? 0;
  const cw1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;

  const found = rateFor(model);
  let cost = 0;
  if (found) {
    const rate = found.rate;
    cost =
      (input * rate.input +
        output * rate.output +
        cacheRead * rate.input * CACHE_READ +
        cw5m * rate.input * CACHE_WRITE_5M +
        cw1h * rate.input * CACHE_WRITE_1H) /
      1_000_000;
  }

  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWrite5mTokens: cw5m,
    cacheWrite1hTokens: cw1h,
    costUsd: cost,
    priced: !!found,
    estimated: !!found && found.estimated,
  };
}
