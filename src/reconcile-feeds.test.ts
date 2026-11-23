import { afterEach, describe, expect, it, vi } from 'vitest';

import { clearScheduledReconciles, registerReconcileEnqueue, scheduleSessionReconcile } from './reconcile-feeds.js';

describe('scheduleSessionReconcile', () => {
  afterEach(() => {
    registerReconcileEnqueue(null);
    clearScheduledReconciles();
    vi.useRealTimers();
  });

  it('enqueues once after the earliest requested delay and cancels cleanly on stop', () => {
    vi.useFakeTimers();
    const enqueued: string[] = [];
    registerReconcileEnqueue((sessionId) => enqueued.push(sessionId));

    scheduleSessionReconcile('sess-1', 15_000);
    // A later deadline for the same session keeps the earlier timer.
    scheduleSessionReconcile('sess-1', 60_000);
    vi.advanceTimersByTime(15_000);
    expect(enqueued).toEqual([]);
    vi.advanceTimersByTime(50);
    expect(enqueued).toEqual(['sess-1']);

    // A sooner deadline replaces a later pending timer.
    scheduleSessionReconcile('sess-2', 60_000);
    scheduleSessionReconcile('sess-2', 1_000);
    vi.advanceTimersByTime(1_050);
    expect(enqueued).toEqual(['sess-1', 'sess-2']);

    // Clearing registration cancels pending timers.
    scheduleSessionReconcile('sess-3', 5_000);
    registerReconcileEnqueue(null);
    vi.advanceTimersByTime(10_000);
    expect(enqueued).toEqual(['sess-1', 'sess-2']);
  });
});
