import { listSessions } from './index-store.js';

/**
 * What the model picker can offer = a curated list of the current lineup PLUS every
 * model actually observed in the local transcripts. The observed half is the part
 * that keeps this honest over time: a model that ships tomorrow becomes selectable
 * the first time any session on this machine runs it, with no code change — the
 * exact staleness that made the picker say "Opus 4.8" while sessions ran Opus 5.
 *
 * Curated snapshot refreshed 2026-10-17 from the models overview at
 * platform.claude.com/docs/en/about-claude/models/overview.
 */
export interface ModelOption {
  id: string;
  label: string;
  /** Caveat worth surfacing in the picker (e.g. a minimum Claude Code version). */
  note?: string;
}

const CURATED: ModelOption[] = [
  // Verified against the live CLI 2026-10-17: the API rejects claude-opus-5-5 from
  // Claude Code < 2.1.280 with a clear "run claude update" error.
  { id: 'claude-opus-5-5', label: 'Opus 5.5', note: 'needs Claude Code ≥ 2.1.280 (run: claude update)' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
  { id: 'claude-opus-5', label: 'Opus 5' },
  { id: 'claude-fable-5', label: 'Fable 5' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
];

// Mirrors the launch validator: only ids that could actually be passed to --model
// belong in a picker ("<synthetic>" and malformed ids stay out).
const LAUNCHABLE = /^claude-[a-z0-9][a-z0-9._-]{0,60}$/i;

/** e.g. claude-haiku-4-5-20251001 → "Haiku 4.5" (same prettifier the web uses). */
function labelFor(id: string): string {
  const m = /^claude-([a-z]+)-(\d+(?:-\d+)?)/i.exec(id);
  if (!m) return id;
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2].replace('-', '.')}`;
}

export function modelOptions(): { curated: ModelOption[]; observed: ModelOption[] } {
  // Newest-seen first, from the already-cached session summaries (no extra file I/O).
  const seen = new Map<string, number>(); // id -> most recent session mtime
  for (const s of listSessions()) {
    const ids = new Set<string>(Object.keys(s.usage.byModel));
    if (s.model) ids.add(s.model);
    for (const id of ids) {
      if (!LAUNCHABLE.test(id)) continue;
      seen.set(id, Math.max(seen.get(id) ?? 0, s.mtimeMs));
    }
  }
  for (const c of CURATED) seen.delete(c.id);
  const observed = [...seen.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => ({ id, label: labelFor(id) }));
  return { curated: CURATED, observed };
}
