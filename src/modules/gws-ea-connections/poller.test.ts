import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { createPendingPoller } from './poller.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it('keeps polling for the current arming when an earlier arming’s signal aborts', async () => {
  const runs: string[] = [];
  const poller = createPendingPoller<string>({
    intervalMs: 1000,
    run: async (context) => {
      runs.push(context);
      return true;
    },
    onError: () => {},
  });
  const first = new AbortController();
  const second = new AbortController();
  poller.arm('first', first.signal);
  poller.arm('second', second.signal);
  poller.soon();
  await vi.advanceTimersByTimeAsync(0);

  first.abort();
  await vi.advanceTimersByTimeAsync(2000);

  expect(runs).toEqual(['second', 'second', 'second']);
  second.abort();
  await vi.advanceTimersByTimeAsync(2000);
  expect(runs).toHaveLength(3);
  await poller.stop();
});
