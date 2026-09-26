import { describe, expect, it, vi } from 'vitest';

import { pollUntil } from './poll.js';

const EVERY_10_FOR_30 = { intervalMs: 10, limitMs: 30 } as const;

describe('polling until an answer holds', () => {
  it('returns an answer that already holds without sleeping', async () => {
    const probe = vi.fn(async () => true);
    const sleep = vi.fn(async () => undefined);

    await expect(pollUntil(probe, (ready) => ready, { ...EVERY_10_FOR_30, sleep })).resolves.toBe(true);
    expect(probe).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('probes after each sleep until the limit is waited, then returns the last answer', async () => {
    let probes = 0;
    const probe = async () => (probes += 1);
    const sleep = vi.fn(async () => undefined);

    await expect(pollUntil(probe, () => false, { ...EVERY_10_FOR_30, sleep })).resolves.toBe(4);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it('hands the signal to each sleep and probes no more once it aborts', async () => {
    const waiting = new AbortController();
    const probe = vi.fn(async () => false);
    const sleep = vi.fn(async () => waiting.abort());

    await expect(
      pollUntil(probe, (ready) => ready, { ...EVERY_10_FOR_30, sleep, signal: waiting.signal }),
    ).resolves.toBe(false);
    expect(probe).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledExactlyOnceWith(10, waiting.signal);
  });
});
