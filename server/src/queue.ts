import { activityBus, isActive } from './activity.js';
import { resumeSession, type PromptImage } from './launch.js';

/**
 * One pending follow-up per session.
 *
 * The CLI cannot take a second prompt mid-turn: two `claude --resume <id>` children
 * appending the same transcript corrupt it, which is why the prompt route 409s while
 * a turn is running. So a follow-up written during a turn is parked here and sent the
 * moment that turn's process exits — you get to type as soon as you have the thought,
 * without racing the running turn.
 *
 * Deliberately in-memory: a queued turn is short-lived intent, and if the server
 * restarts the child processes it was waiting on are gone anyway.
 */
export interface QueuedTurn {
  prompt: string;
  cwd: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
  images?: PromptImage[];
  queuedAt: string;
}

const pending = new Map<string, QueuedTurn>();

export function getQueued(id: string): QueuedTurn | null {
  return pending.get(id) ?? null;
}

export function setQueued(id: string, turn: Omit<QueuedTurn, 'queuedAt'>): QueuedTurn {
  const q: QueuedTurn = { ...turn, queuedAt: new Date().toISOString() };
  pending.set(id, q);
  return q;
}

export function clearQueued(id: string): boolean {
  return pending.delete(id);
}

/** Small enough to ship on every activity event. */
export function queuedCount(id: string): number {
  return pending.has(id) ? 1 : 0;
}

/**
 * Send a session's queued follow-up as soon as its running turn exits. Driven by the
 * same activity signal the UI uses, so it fires on the real process lifetime rather
 * than on a transcript write.
 */
export function startQueueRunner(): void {
  activityBus.on('change', (id: string) => {
    if (isActive(id)) return; // a turn is (still) running — wait for its exit
    const turn = pending.get(id);
    if (!turn) return;
    // Pop BEFORE spawning: resumeSession marks the session active synchronously,
    // re-entering this handler, and a second send would corrupt the transcript.
    pending.delete(id);
    try {
      resumeSession(id, turn);
      console.log(`[queue] follow-up queued at ${turn.queuedAt} sent to session ${id}`);
    } catch (err) {
      console.error(`[queue] failed to send queued follow-up for ${id}:`, err);
    }
  });
}
