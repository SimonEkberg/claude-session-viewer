import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { priceUsage, rateFor, cacheReadMultFor } from '../src/pricing.js';
import { contextWindowFor } from '../src/context.js';
import { validateModelMode } from '../src/launch.js';
import { parseSession } from '../src/transcript.js';
import { agentOutcome } from '../src/subagents.js';
import { getQueued, setQueued, clearQueued, queuedCount } from '../src/queue.js';

// ─────────────────────────────── pricing ────────────────────────────────────────

describe('pricing', () => {
  test('exact rate for a known model, standard cache-read multiplier', () => {
    const d = priceUsage('claude-opus-5', {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 1_000,
    });
    // (100·$5 + 50·$25 + 1000·$5·0.1) / 1M
    assert.equal(d.priced, true);
    assert.equal(d.estimated, false);
    assert.ok(Math.abs(d.costUsd - (100 * 5 + 50 * 25 + 1000 * 5 * 0.1) / 1e6) < 1e-12);
  });

  test('per-model cache-read rates: Fable 5.1 reads at 2.5%, Opus 5.5 at 5%', () => {
    assert.equal(cacheReadMultFor('claude-fable-5-1'), 0.025);
    assert.equal(cacheReadMultFor('claude-opus-5-5'), 0.05);
    assert.equal(cacheReadMultFor('claude-opus-5'), 0.1);
    const d = priceUsage('claude-fable-5-1', { cache_read_input_tokens: 1_000_000 });
    assert.ok(Math.abs(d.costUsd - 10 * 0.025) < 1e-9); // $10/MTok input · 2.5%
  });

  test('unknown model ids are priced by tier and flagged estimated', () => {
    const r = rateFor('claude-opus-9-9');
    assert.ok(r);
    assert.equal(r!.estimated, true);
    assert.deepEqual(r!.rate, { input: 4, output: 20 }); // newest opus tier
  });

  test('<synthetic> has no price at all', () => {
    const d = priceUsage('<synthetic>', { input_tokens: 10, output_tokens: 10 });
    assert.equal(d.priced, false);
    assert.equal(d.costUsd, 0);
  });

  test('model-fallback turns price each iteration by its own model', () => {
    const d = priceUsage('claude-opus-5', {
      input_tokens: 999_999, // top-level must be ignored when iterations exist
      iterations: [
        { model: 'claude-opus-5', input_tokens: 1_000_000 }, // $5
        { model: 'claude-haiku-4-5', output_tokens: 1_000_000 }, // $5
      ],
    });
    assert.ok(Math.abs(d.costUsd - 10) < 1e-9);
    assert.equal(d.inputTokens, 1_000_000);
  });
});

// ─────────────────────────────── context windows ────────────────────────────────

describe('context windows', () => {
  test('Haiku 5.5 is the first 1M haiku; Haiku 4.5 stays 200K', () => {
    assert.equal(contextWindowFor('claude-haiku-5-5'), 1_000_000);
    assert.equal(contextWindowFor('claude-haiku-4-5'), 200_000);
  });
  test('family fallbacks for unknown ids', () => {
    assert.equal(contextWindowFor('claude-opus-9'), 1_000_000);
    assert.equal(contextWindowFor('claude-haiku-9'), 200_000); // conservative
    assert.equal(contextWindowFor(null), 200_000);
  });
});

// ─────────────────────────────── launch validation ──────────────────────────────

describe('launch validation', () => {
  test('accepts valid combinations', () => {
    validateModelMode('claude-opus-5-5', 'plan', 'xhigh');
    validateModelMode(undefined, undefined, undefined);
  });
  test('rejects shell metacharacters and unknown enums', () => {
    assert.throws(() => validateModelMode('claude-opus-5 & calc'), /invalid model/);
    assert.throws(() => validateModelMode(undefined, 'yolo'), /invalid permissionMode/);
    assert.throws(() => validateModelMode(undefined, undefined, 'ultra'), /invalid effort/);
    assert.throws(() => validateModelMode(undefined, undefined, 'high; calc'), /invalid effort/);
  });
});

// ─────────────────────────────── transcript parser ──────────────────────────────

/** Build a fixture transcript + companion subagent files in a temp dir. */
function fixture(): { file: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-test-'));
  const id = '11111111-2222-3333-4444-555555555555';
  const file = path.join(dir, `${id}.jsonl`);
  const ts = (m: number) => new Date(Date.UTC(2026, 9, 17, 10, m)).toISOString();
  const usage1 = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000 };

  const lines = [
    // real human prompt
    { type: 'user', timestamp: ts(0), cwd: 'C:\\proj', version: '2.1.263', gitBranch: 'main',
      message: { role: 'user', content: 'do the thing' } },
    // ONE api message split over TWO jsonl lines (same message.id) — usage must count once
    { type: 'assistant', timestamp: ts(1), effort: 'high',
      message: { id: 'msg_1', model: 'claude-opus-5', usage: usage1,
        content: [{ type: 'text', text: 'starting' }] } },
    { type: 'assistant', timestamp: ts(1), effort: 'high',
      message: { id: 'msg_1', model: 'claude-opus-5', usage: usage1,
        content: [{ type: 'tool_use', id: 'toolu_bg', name: 'Agent',
          input: { description: 'Review the branch', subagent_type: 'reviewer' } }] } },
    // async dispatch result (background agent)
    { type: 'user', timestamp: ts(2), message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'toolu_bg',
        content: 'Async agent launched successfully. agentId: aaaa1111bbbb2222c' } ] } },
    // a foreground agent: dispatch + the finished report as its result
    { type: 'assistant', timestamp: ts(3),
      message: { id: 'msg_2', model: 'claude-opus-5', usage: { input_tokens: 10, output_tokens: 5 },
        content: [{ type: 'tool_use', id: 'toolu_fg', name: 'Agent',
          input: { description: 'Quick check', subagent_type: 'reviewer', run_in_background: false } }] } },
    { type: 'user', timestamp: ts(4), message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'toolu_fg', content: 'PASS — all good' } ] } },
    // harness notification: the background agent was killed with the process
    { type: 'user', timestamp: ts(5), isMeta: true, message: { role: 'user', content: [
      { type: 'text', text: '<task-notification>\n<task-id>aaaa1111bbbb2222c</task-id>\n<status>stopped</status>\n<summary>No completion record…</summary>\n</task-notification>' } ] } },
    // a synthetic API error line — must not become the model or pollute usage
    { type: 'assistant', timestamp: ts(6), isApiErrorMessage: true,
      message: { id: 'msg_err', model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0 },
        content: [{ type: 'text', text: 'API error: rate limited' }] } },
    // a sidechain (sub-agent) turn on another model — usage counts, identity does not
    { type: 'assistant', timestamp: ts(7), isSidechain: true, effort: 'low',
      message: { id: 'msg_side', model: 'claude-haiku-4-5', usage: { input_tokens: 7, output_tokens: 3 },
        content: [{ type: 'text', text: 'sidechain says hi' }] } },
    // the newest real turn decides the session's current model + effort
    { type: 'assistant', timestamp: ts(8), effort: 'max',
      message: { id: 'msg_3', model: 'claude-fable-5-1', usage: { input_tokens: 20, output_tokens: 10 },
        content: [{ type: 'text', text: 'done' }] } },
    { type: 'ai-title', aiTitle: 'Fixture session' },
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { file, dir };
}

describe('transcript parser', () => {
  const { file } = fixture();
  const s = parseSession(file);

  test('bills one API message once, no matter how many jsonl lines it spans', () => {
    // msg_1 (100/50) + msg_2 (10/5) + sidechain msg_side (7/3) + msg_3 (20/10)
    assert.equal(s.usage.inputTokens, 100 + 10 + 7 + 20);
    assert.equal(s.usage.outputTokens, 50 + 5 + 3 + 10);
  });

  test('model and effort come from the newest REAL turn (no sidechain, no synthetic)', () => {
    assert.equal(s.model, 'claude-fable-5-1');
    assert.equal(s.effort, 'max');
  });

  test('synthetic error lines never enter byModel', () => {
    assert.ok(!('<synthetic>' in s.usage.byModel));
  });

  test('harness notifications are injected, not human prompts', () => {
    assert.equal(s.counts.prompts, 1); // only "do the thing"
    assert.equal(s.title, 'Fixture session');
  });

  test('background agent killed with the process is flagged orphaned; foreground completed', () => {
    assert.equal(s.agents.length, 2);
    const bg = s.agents.find((a) => a.background)!;
    const fg = s.agents.find((a) => !a.background)!;
    assert.equal(bg.status, 'stopped');
    assert.equal(bg.orphaned, true);
    assert.equal(bg.agentId, 'aaaa1111bbbb2222c');
    assert.equal(fg.status, 'completed');
    assert.equal(fg.orphaned, false);
  });
});

// ─────────────────────────────── subagent outcome ───────────────────────────────

describe('subagent outcome (orphan detection without a notification)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-sub-'));
  const sessionFile = path.join(dir, 'abcd1234-0000-0000-0000-000000000000.jsonl');
  fs.writeFileSync(sessionFile, '');
  const subDir = path.join(dir, 'abcd1234-0000-0000-0000-000000000000', 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  const write = (agentId: string, lines: unknown[], ageMin: number) => {
    const f = path.join(subDir, `agent-${agentId}.jsonl`);
    fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const t = new Date(Date.now() - ageMin * 60_000);
    fs.utimesSync(f, t, t); // backdate so the staleness check sees a quiet file
  };

  test('an agent that signed off with prose is completed', () => {
    write('done1', [
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'FINAL REPORT: all good' }] } },
    ], 30);
    const o = agentOutcome(sessionFile, 'done1');
    assert.equal(o.outcome, 'completed');
    assert.equal(o.stale, false);
  });

  test('an agent whose file ends mid-loop and has been quiet is stale (killed)', () => {
    write('dead1', [
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
    ], 30);
    const o = agentOutcome(sessionFile, 'dead1');
    assert.equal(o.outcome, 'incomplete');
    assert.equal(o.stale, true);
  });

  test('a mid-loop agent with recent writes is NOT stale — it is still working', () => {
    write('live1', [
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } },
    ], 0);
    const o = agentOutcome(sessionFile, 'live1');
    assert.equal(o.outcome, 'incomplete');
    assert.equal(o.stale, false);
  });

  test('a missing transcript claims nothing', () => {
    assert.equal(agentOutcome(sessionFile, 'nope').outcome, 'unknown');
  });
});

// ─────────────────────────────── follow-up queue ────────────────────────────────

describe('follow-up queue', () => {
  const id = 'q-test-session';
  test('one pending turn per session; clear removes it', () => {
    assert.equal(getQueued(id), null);
    setQueued(id, { prompt: 'first', cwd: 'C:\\proj' });
    setQueued(id, { prompt: 'second', cwd: 'C:\\proj' }); // replaces, not appends
    assert.equal(getQueued(id)!.prompt, 'second');
    assert.equal(queuedCount(id), 1);
    assert.equal(clearQueued(id), true);
    assert.equal(getQueued(id), null);
    assert.equal(queuedCount(id), 0);
  });
});
