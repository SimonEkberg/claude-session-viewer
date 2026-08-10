import { EventEmitter } from 'node:events';

/**
 * Tracks which sessions have a live `claude` process running (launched or resumed
 * through this tool). This is the authoritative "Claude is working" signal — the
 * CLI process stays alive for the whole turn (thinking + tools + final response)
 * and exits only when the turn is done. It does NOT depend on transcript-file
 * writes, so it stays true through the thinking phase where the file is quiet.
 */
const running = new Map<string, number>(); // sessionId -> live process count
export const activityBus = new EventEmitter();
activityBus.setMaxListeners(0); // one listener per open SSE connection; don't warn

export function markActive(id: string): void {
  const n = (running.get(id) || 0) + 1;
  running.set(id, n);
  if (n === 1) activityBus.emit('change', id, true);
}

export function markInactive(id: string): void {
  const n = (running.get(id) || 0) - 1;
  if (n <= 0) {
    running.delete(id);
    activityBus.emit('change', id, false);
  } else {
    running.set(id, n);
  }
}

export function isActive(id: string): boolean {
  return (running.get(id) || 0) > 0;
}

/** All sessions with a live claude process right now. */
export function activeIds(): string[] {
  return [...running.keys()];
}
