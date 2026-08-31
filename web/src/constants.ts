// Shared option lists for the composer and New Session dialog.

export const MODELS: { v: string; label: string }[] = [
  { v: '', label: 'Session default' },
  { v: 'claude-opus-5', label: 'Opus 5' },
  { v: 'claude-sonnet-5', label: 'Sonnet 5' },
  { v: 'claude-fable-5', label: 'Fable 5' },
  { v: 'claude-haiku-4-5', label: 'Haiku 4.5' },
  { v: 'claude-opus-4-8', label: 'Opus 4.8' },
];

/**
 * Friendly name for a model id read back out of a transcript. The picker above only
 * holds the ids you can *choose*; a session can be running anything (a dated id, a
 * model newer than this list, `<synthetic>`), so unknown ids are prettified by shape
 * rather than shown raw — and never silently mapped to a different model.
 * e.g. claude-haiku-4-5-20251001 → "Haiku 4.5", claude-opus-5 → "Opus 5".
 */
export function modelLabel(id?: string | null): string {
  if (!id) return '';
  const hit = MODELS.find((m) => m.v && m.v === id);
  if (hit) return hit.label;
  const m = /^claude-([a-z]+)-(\d+(?:-\d+)?)/i.exec(id);
  if (!m) return id;
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2].replace('-', '.')}`;
}

/**
 * Reasoning effort (CLI `--effort`). Higher = more thinking per turn, more tokens,
 * slower. '' leaves the CLI's own default alone.
 */
export const EFFORTS: { v: string; label: string; hint: string }[] = [
  { v: '', label: 'Session default', hint: "Don't pass --effort; the CLI decides." },
  { v: 'low', label: 'Low', hint: 'Minimal reasoning — fastest, cheapest.' },
  { v: 'medium', label: 'Medium', hint: 'Balanced reasoning.' },
  { v: 'high', label: 'High', hint: 'More reasoning per turn.' },
  { v: 'xhigh', label: 'Extra high', hint: 'Deep reasoning — slower, more tokens.' },
  { v: 'max', label: 'Max', hint: 'Maximum reasoning — slowest, most expensive.' },
];

export function effortLabel(v?: string | null): string {
  if (!v) return '';
  return EFFORTS.find((e) => e.v === v)?.label ?? v;
}

/**
 * Permission modes — this is where file-write permission is configured.
 * `plan` never writes; `acceptEdits` and `bypassPermissions` allow writes.
 * (In non-interactive `-p` mode the CLI can't prompt mid-run, so the write
 * decision is made here, before the prompt is sent.)
 */
export const PERMISSION_MODES: { v: string; label: string; writes: boolean; hint: string }[] = [
  { v: 'plan', label: 'Plan — read-only', writes: false, hint: 'No file writes. Safe for investigation.' },
  { v: 'default', label: 'Default — ask', writes: false, hint: 'Standard gating; writes not pre-approved.' },
  { v: 'acceptEdits', label: 'Accept edits — can write', writes: true, hint: 'Auto-approves file edits/writes.' },
  { v: 'bypassPermissions', label: 'Bypass — no prompts', writes: true, hint: 'All actions allowed. Use with care.' },
];
