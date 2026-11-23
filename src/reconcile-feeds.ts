/**
 * Reconcile enqueue feed — the narrow bridge between "something changed for
 * this session" and the sweep's workqueue, with no import edge back into the
 * sweep. Producers (the inbound mail writer, the runtime watch feed) call
 * `enqueueSessionReconcile`; the sweep registers the real enqueue while it
 * runs and clears it on stop, so producers are always safe to call — an
 * unregistered feed is a no-op and the periodic resync still covers the
 * change. Extra enqueues are free: the queue coalesces and the reconcile body
 * is level-triggered, so a spurious call costs one no-op re-read, never a
 * behavior change.
 */
import { log } from './log.js';

let enqueue: ((sessionId: string) => void) | null = null;
const scheduled = new Map<string, { readonly at: number; readonly timer: NodeJS.Timeout }>();

/** Cancel every pending delayed reconcile enqueue. */
export function clearScheduledReconciles(): void {
  for (const entry of scheduled.values()) clearTimeout(entry.timer);
  scheduled.clear();
}

/** The sweep's hook. Last registration wins; null clears. */
export function registerReconcileEnqueue(fn: ((sessionId: string) => void) | null): void {
  enqueue = fn;
  if (fn === null) clearScheduledReconciles();
}

/**
 * Ask for a prompt reconcile of one session. Fire-and-forget and never
 * throws — a feed must never break the write path that called it.
 */
export function enqueueSessionReconcile(sessionId: string): void {
  if (!enqueue) return;
  /* eslint-disable no-catch-all/no-catch-all -- a failed enqueue costs latency (the resync floor covers it), never the caller's write */
  try {
    enqueue(sessionId);
  } catch (err) {
    log.warn('Reconcile enqueue failed', { sessionId, err });
  }
  /* eslint-enable no-catch-all/no-catch-all */
}

/**
 * Ask for a prompt reconcile of one session once `delayMs` has elapsed.
 * Keeps the earliest pending wake for a session, unrefs the timer so shutdown
 * never hangs, and relies on the periodic sweep as the durable fallback.
 */
export function scheduleSessionReconcile(sessionId: string, delayMs: number): void {
  if (delayMs <= 0) {
    enqueueSessionReconcile(sessionId);
    return;
  }
  const wait = Math.ceil(delayMs) + 50;
  const at = Date.now() + wait;
  const existing = scheduled.get(sessionId);
  if (existing && existing.at <= at) return;
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    scheduled.delete(sessionId);
    enqueueSessionReconcile(sessionId);
  }, wait);
  timer.unref();
  scheduled.set(sessionId, { at, timer });
}
