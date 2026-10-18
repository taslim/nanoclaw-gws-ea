/**
 * Pins the slack-agent-flow hot-start seam in channel-registry.ts:
 * the `hotStartSetupFn` capture in initChannelAdapters plus the
 * `startChannelAdapter` export. The seam is installed by the
 * slack-agent-flow skill's registry edit — a red run here means that
 * edit is missing (or an upstream update dropped it).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type { ChannelAdapter, ChannelSetup } from './adapter.js';

/** Fake adapter recording every setup() config so tests can assert identity
 *  with the object the captured setupFn produced. */
function createFakeAdapter(channelType: string, instance?: string): ChannelAdapter & { setupConfigs: ChannelSetup[] } {
  const setupConfigs: ChannelSetup[] = [];
  return {
    name: instance ?? channelType,
    channelType,
    instance,
    supportsThreads: false,
    setupConfigs,
    async setup(config: ChannelSetup) {
      setupConfigs.push(config);
    },
    async teardown() {},
    isConnected() {
      return setupConfigs.length > 0;
    },
    async deliver() {
      return undefined;
    },
  };
}

/** setupFn stand-in that memoizes its per-adapter return value, so tests can
 *  assert the adapter's setup() received exactly setupFn(adapter)'s result. */
function createSetupFn() {
  const byAdapter = new Map<ChannelAdapter, ChannelSetup>();
  const setupFn = (adapter: ChannelAdapter): ChannelSetup => {
    const setup: ChannelSetup = {
      onInbound() {},
      onInboundEvent() {},
      onMetadata() {},
      onAction() {},
    };
    byAdapter.set(adapter, setup);
    return setup;
  };
  return { setupFn, byAdapter };
}

describe('startChannelAdapter (hot-start seam)', () => {
  // The registry and activeAdapters maps are module-level, as is the captured
  // hotStartSetupFn — fresh module per test so ordering can't leak state.
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(async () => {
    vi.useRealTimers();
    const { teardownChannelAdapters } = await import('./channel-registry.js');
    await teardownChannelAdapters();
    vi.resetModules();
  });

  it('throws before initChannelAdapters has run', async () => {
    const reg = await import('./channel-registry.js');
    reg.registerChannelAdapter('slack-hot', { factory: () => createFakeAdapter('slack', 'slack-hot') });

    await expect(reg.startChannelAdapter('slack-hot')).rejects.toThrow(
      'startChannelAdapter: initChannelAdapters has not run',
    );
  });

  it('throws on a key with no registration', async () => {
    const reg = await import('./channel-registry.js');
    await reg.initChannelAdapters(createSetupFn().setupFn);

    await expect(reg.startChannelAdapter('slack-ghost')).rejects.toThrow(
      "startChannelAdapter: no registration for 'slack-ghost'",
    );
  });

  it('hot-starts a post-init registration with the captured setupFn', async () => {
    const reg = await import('./channel-registry.js');
    const { setupFn, byAdapter } = createSetupFn();
    await reg.initChannelAdapters(setupFn);

    // Registered AFTER boot — the exact shape of a freshly provisioned instance.
    const adapter = createFakeAdapter('slack', 'slack-hot');
    reg.registerChannelAdapter('slack-hot', { factory: () => adapter });

    await expect(reg.startChannelAdapter('slack-hot')).resolves.toBe('started');
    expect(reg.getChannelAdapterExact('slack-hot')).toBe(adapter);
    expect(adapter.setupConfigs).toHaveLength(1);
    expect(adapter.setupConfigs[0]).toBe(byAdapter.get(adapter));
  });

  it('returns already-active on a second call without re-running setup', async () => {
    const reg = await import('./channel-registry.js');
    await reg.initChannelAdapters(createSetupFn().setupFn);
    const adapter = createFakeAdapter('slack', 'slack-hot');
    reg.registerChannelAdapter('slack-hot', { factory: () => adapter });

    await expect(reg.startChannelAdapter('slack-hot')).resolves.toBe('started');
    await expect(reg.startChannelAdapter('slack-hot')).resolves.toBe('already-active');
    expect(adapter.setupConfigs).toHaveLength(1);
  });

  it('returns no-credentials when the factory yields null', async () => {
    const reg = await import('./channel-registry.js');
    await reg.initChannelAdapters(createSetupFn().setupFn);
    reg.registerChannelAdapter('slack-nocreds', { factory: () => null });

    await expect(reg.startChannelAdapter('slack-nocreds')).resolves.toBe('no-credentials');
    expect(reg.getChannelAdapterExact('slack-nocreds')).toBeUndefined();
  });

  it('stops only the exact instance before awaiting teardown and can start a fresh one', async () => {
    const reg = await import('./channel-registry.js');
    const { setupFn, byAdapter } = createSetupFn();
    const first = createFakeAdapter('whatsapp', 'wa-main');
    const second = createFakeAdapter('whatsapp', 'wa-main');
    const sibling = createFakeAdapter('whatsapp', 'wa-other');
    let finishTeardown: (() => void) | undefined;
    first.teardown = () =>
      new Promise<void>((resolve) => {
        finishTeardown = resolve;
      });
    let created = 0;
    reg.registerChannelAdapter('wa-main', { factory: () => (created++ === 0 ? first : second) });
    reg.registerChannelAdapter('wa-other', { factory: () => sibling });
    await reg.initChannelAdapters(setupFn);

    try {
      await expect(reg.stopChannelAdapter('whatsapp')).resolves.toBe('not-active');
      const stopped = reg.stopChannelAdapter('wa-main');
      expect(reg.getChannelAdapterExact('wa-main')).toBeUndefined();
      expect(reg.getChannelAdapterExact('wa-other')).toBe(sibling);
      expect(finishTeardown).toBeTypeOf('function');
      finishTeardown!();
      await expect(stopped).resolves.toBe('stopped');
      await expect(reg.startChannelAdapter('wa-main')).resolves.toBe('started');
      expect(reg.getChannelAdapterExact('wa-main')).toBe(second);
      expect(second.setupConfigs).toEqual([byAdapter.get(second)]);
    } finally {
      finishTeardown?.();
      first.teardown = async () => {};
    }
  });

  it('propagates teardown failure after withdrawing the exact instance', async () => {
    const reg = await import('./channel-registry.js');
    const adapter = createFakeAdapter('whatsapp');
    const failure = new Error('socket did not close');
    adapter.teardown = async () => {
      throw failure;
    };
    reg.registerChannelAdapter('whatsapp', { factory: () => adapter });
    await reg.initChannelAdapters(createSetupFn().setupFn);

    await expect(reg.stopChannelAdapter('whatsapp')).rejects.toBe(failure);
    expect(reg.getChannelAdapterExact('whatsapp')).toBeUndefined();
  });

  it('retries setup on NetworkError and still starts', async () => {
    vi.useFakeTimers();
    const reg = await import('./channel-registry.js');
    await reg.initChannelAdapters(createSetupFn().setupFn);

    const base = createFakeAdapter('slack', 'slack-flaky');
    let attempts = 0;
    const adapter: typeof base = {
      ...base,
      async setup(config: ChannelSetup) {
        attempts += 1;
        if (attempts === 1) {
          const err = new Error('socket hiccup');
          err.name = 'NetworkError';
          throw err;
        }
        base.setupConfigs.push(config);
      },
    };
    reg.registerChannelAdapter('slack-flaky', { factory: () => adapter });

    const pending = reg.startChannelAdapter('slack-flaky');
    // First retry delay is 2000ms — advance past it so the second attempt runs.
    await vi.advanceTimersByTimeAsync(2000);
    await expect(pending).resolves.toBe('started');
    expect(attempts).toBe(2);
    expect(reg.getChannelAdapterExact('slack-flaky')).toBe(adapter);
  });
});
