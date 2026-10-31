/**
 * Host module lifecycle registry.
 *
 * Modules register callbacks at import time. Registration is deliberately
 * inert: startup work begins only after the database and delivery adapter are
 * ready, and shutdown work begins only from the host's graceful-shutdown path.
 */
import type { DbDriver } from './db/driver.js';
import type { ChannelDeliveryAdapter } from './delivery.js';
import { log } from './log.js';

export interface HostStartContext {
  db: DbDriver;
  deliveryAdapter: ChannelDeliveryAdapter;
  signal: AbortSignal;
}

export type HostStartCallback = (ctx: HostStartContext) => void | Promise<void>;
export type HostShutdownCallback = () => void | Promise<void>;

const startCallbacks: HostStartCallback[] = [];
const shutdownCallbacks: HostShutdownCallback[] = [];
const containerStoppedCallbacks: Array<(sessionId: string) => void | Promise<void>> = [];

export function onContainerStopped(callback: (sessionId: string) => void | Promise<void>): void {
  containerStoppedCallbacks.push(callback);
}

/** Called after fenced teardown releases the session's runtime. */
export async function notifyContainerStopped(sessionId: string): Promise<void> {
  for (const callback of containerStoppedCallbacks) {
    try {
      await callback(sessionId);
      // eslint-disable-next-line no-catch-all/no-catch-all -- optional cleanup must not prevent session finalization or other modules
    } catch (err) {
      log.error('Container cleanup callback threw', { sessionId, err });
    }
  }
}

export function onHostStart(cb: HostStartCallback): void {
  startCallbacks.push(cb);
}

export function onHostShutdown(cb: HostShutdownCallback): void {
  shutdownCallbacks.push(cb);
}

export function getHostStartCallbacks(): readonly HostStartCallback[] {
  return [...startCallbacks];
}

export function getHostShutdownCallbacks(): readonly HostShutdownCallback[] {
  return [...shutdownCallbacks];
}

/** Start registered modules serially. A failed start aborts host startup. */
export async function startHostModules(ctx: HostStartContext): Promise<void> {
  for (const cb of [...startCallbacks]) {
    try {
      await cb(ctx);
    } catch (err) {
      log.error('Host module startup callback threw', { err });
      throw err;
    }
  }
}

export async function runHostCleanup(callbacks: readonly HostShutdownCallback[]): Promise<void> {
  const errors: unknown[] = [];
  for (const cb of callbacks) {
    /* eslint-disable no-catch-all/no-catch-all -- graceful shutdown must continue through every registered cleanup */
    try {
      await cb();
    } catch (err) {
      errors.push(err);
      log.error('Shutdown callback threw', { err });
    }
    /* eslint-enable no-catch-all/no-catch-all */
  }
  if (errors.length) throw new AggregateError(errors, 'Host cleanup failed');
}

/**
 * Stop registered modules serially in reverse registration order. One failed
 * cleanup must not prevent later callbacks or host cleanup.
 */
export async function stopHostModules(): Promise<void> {
  await runHostCleanup([...shutdownCallbacks].reverse());
}
