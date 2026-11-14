import { describe, expect, it, vi } from 'vitest';

import type {
  GatewayCredentialTarget,
  GatewayRuntimeCredentialConnection,
} from '../../gateway-providers/credential-connection.js';
import { appCredentialTarget, publishAppCredential, removeAppCredential } from './credentials.js';
import { withAppLock } from './locks.js';

const app = { id: 'a1b2c3', url: 'https://homeboard.nownow.ai/mcp' };

function fakeConnection(stored: boolean) {
  const entry = {
    find: vi.fn(async () => (stored ? { reusable: true } : null)),
    save: vi.fn(async () => undefined),
    keep: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
  } satisfies GatewayRuntimeCredentialConnection;
  const targets: GatewayCredentialTarget[] = [];
  const connection = (target: GatewayCredentialTarget): GatewayRuntimeCredentialConnection => {
    targets.push(target);
    return entry;
  };
  return { entry, targets, connection };
}

describe('app credentials', () => {
  it('scopes the bearer to the app host and path under the app’s own name', () => {
    expect(appCredentialTarget(app)).toEqual({
      kind: 'api-key',
      name: 'gws-ea-app-a1b2c3',
      host: 'homeboard.nownow.ai',
      path: '/mcp',
      proxyValue: 'gateway-managed',
      injection: { headerName: 'Authorization', valueFormat: 'Bearer {value}' },
    });
  });

  it('publishes through find then save', async () => {
    const fake = fakeConnection(false);
    await publishAppCredential(app, 'access-token-1', fake.connection);
    expect(fake.entry.find).toHaveBeenCalledOnce();
    expect(fake.entry.save).toHaveBeenCalledWith('access-token-1');
    // A gateway saves into the entry find() observed, so the order is the contract.
    expect(fake.entry.find.mock.invocationCallOrder[0]).toBeLessThan(fake.entry.save.mock.invocationCallOrder[0]);
  });

  it('removes only what the gateway holds', async () => {
    const held = fakeConnection(true);
    await removeAppCredential(app, held.connection);
    expect(held.entry.remove).toHaveBeenCalledOnce();

    const absent = fakeConnection(false);
    await removeAppCredential(app, absent.connection);
    expect(absent.entry.remove).not.toHaveBeenCalled();
  });
});

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
