import fs from 'node:fs';
import path from 'node:path';
import { SESSIONS_ROOT } from './config.js';
import { priceUsage, type RawUsage } from './pricing.js';

/**
 * Rolling-window usage across ALL sessions on this machine.
 *
 * IMPORTANT: this is a *local estimate* computed by summing token usage from the
 * transcripts over the last N hours — NOT Anthropic's official 5-hour / weekly
 * limit meter, which is enforced server-side and isn't written to any local file
 * (the transcripts' own rateLimits fields are always null). It answers "how much
 * have I consumed recently on this machine", which tracks the real limit windows
 * closely but is not authoritative.
 */
export interface UsageWindow {
  label: string;
  hours: number;
  costUsd: number;
  totalTokens: number;
  sessions: number;
  hasUnpriced: boolean;
}

const WINDOWS: { label: string; hours: number }[] = [
  { label: '5h', hours: 5 },
  { label: '24h', hours: 24 },
  { label: '7d', hours: 24 * 7 },
];

function transcriptFiles(): string[] {
  if (!fs.existsSync(SESSIONS_ROOT)) return [];
  const out: string[] = [];
  for (const dir of fs.readdirSync(SESSIONS_ROOT)) {
    const full = path.join(SESSIONS_ROOT, dir);
    try {
      if (!fs.statSync(full).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const f of fs.readdirSync(full)) if (f.endsWith('.jsonl')) out.push(path.join(full, f));
  }
  return out;
}

export function usageWindows(nowMs: number): { computedAt: string; windows: UsageWindow[] } {
  const acc = WINDOWS.map((w) => ({
    ...w,
    costUsd: 0,
    totalTokens: 0,
    hasUnpriced: false,
    sessionSet: new Set<string>(),
  }));

  for (const file of transcriptFiles()) {
    // Skip files not modified within the largest window — cheap prefilter.
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      continue;
    }
    if (nowMs - mtimeMs > WINDOWS[WINDOWS.length - 1].hours * 3_600_000) continue;

    const id = path.basename(file).replace(/\.jsonl$/, '');
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let o: any;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o.type !== 'assistant' || !o.message?.usage || !o.timestamp) continue;
      const t = Date.parse(o.timestamp);
      if (isNaN(t)) continue;
      const ageH = (nowMs - t) / 3_600_000;
      const d = priceUsage(o.message.model, o.message.usage as RawUsage);
      const toks = d.inputTokens + d.outputTokens + d.cacheReadTokens + d.cacheWrite5mTokens + d.cacheWrite1hTokens;
      for (const w of acc) {
        if (ageH <= w.hours) {
          w.costUsd += d.costUsd;
          w.totalTokens += toks;
          w.sessionSet.add(id);
          if (!d.priced && (d.inputTokens || d.outputTokens)) w.hasUnpriced = true;
        }
      }
    }
  }

  return {
    computedAt: new Date(nowMs).toISOString(),
    windows: acc.map((w) => ({
      label: w.label,
      hours: w.hours,
      costUsd: w.costUsd,
      totalTokens: w.totalTokens,
      sessions: w.sessionSet.size,
      hasUnpriced: w.hasUnpriced,
    })),
  };
}
