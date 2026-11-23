import { describe, expect, it } from 'vitest';

import { withAppLock } from './locks.js';

describe('app locks', () => {
  it('runs one app’s work in order and lets other apps proceed', async () => {
    const order: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = withAppLock('one', async () => {
      await gate;
      order.push('one:first');
    });
    const second = withAppLock('one', async () => {
      order.push('one:second');
    });
    const other = withAppLock('two', async () => {
      order.push('two');
    });
    await other;
    expect(order).toEqual(['two']);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['two', 'one:first', 'one:second']);
  });

  it('keeps the queue moving after a failure and returns each result', async () => {
    const failed = withAppLock('one', async () => {
      throw new Error('boom');
    });
    const next = withAppLock('one', async () => 'ok');
    await expect(failed).rejects.toThrow('boom');
    await expect(next).resolves.toBe('ok');
  });
});
