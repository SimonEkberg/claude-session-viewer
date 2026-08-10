// Shared option lists for the composer and New Session dialog.

export const MODELS: { v: string; label: string }[] = [
  { v: '', label: 'Session default' },
  { v: 'claude-opus-4-8', label: 'Opus 4.8' },
  { v: 'claude-sonnet-5', label: 'Sonnet 5' },
  { v: 'claude-fable-5', label: 'Fable 5' },
  { v: 'claude-haiku-4-5', label: 'Haiku 4.5' },
];

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
