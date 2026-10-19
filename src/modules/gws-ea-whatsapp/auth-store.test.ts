import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { transportHarness, type TransportHarness } from './testing/harness.js';
import { WhatsAppAuthStore } from './auth-store.js';

let h: TransportHarness;
beforeEach(async () => {
  h = await transportHarness();
});
afterEach(async () => {
  vi.useRealTimers();
  await h.close();
});
describe('the private transactional Baileys auth state', () => {
  it('persists credentials and Signal bytes across restart with owner-only files', async () => {
    const adapter = await h.start();
    const auth = h.socketConfigs[0].auth;
    expect(auth).toBeDefined();
    await h.socket().emit('creds.update', { registered: true });
    await auth?.keys.set({ session: { peer: Buffer.from([1, 2, 3]) }, 'sender-key': { group: Buffer.from([4, 5]) } });
    await adapter.teardown();
    await h.start();
    expect(h.socketConfigs[1].auth?.creds.registered).toBe(true);
    expect(await h.socketConfigs[1].auth?.keys.get('session', ['peer'])).toEqual({ peer: Buffer.from([1, 2, 3]) });
    expect(await h.socketConfigs[1].auth?.keys.get('sender-key', ['group'])).toEqual({ group: Buffer.from([4, 5]) });
    expect(fs.statSync(path.join(h.directory, 'auth.sqlite')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(h.directory).mode & 0o777).toBe(0o700);
  });
  it('keeps the initial Signal identity when keys persist before the first creds.update', async () => {
    const adapter = await h.start({}, false);
    const firstIdentity = h.socketConfigs[0].auth?.creds.signedIdentityKey.public;
    await h.socketConfigs[0].auth?.keys.set({ session: { peer: Buffer.from('session for first identity') } });
    await adapter.teardown();
    await h.start({}, false);
    expect(h.socketConfigs[1].auth?.creds.signedIdentityKey.public).toEqual(firstIdentity);
    expect(await h.socketConfigs[1].auth?.keys.get('session', ['peer'])).toEqual({
      peer: Buffer.from('session for first identity'),
    });
  });

  it('erases persisted auth and resets in-memory identity before relinking the retained adapter', async () => {
    const adapter = await h.start();
    const oldIdentity = h.socketConfigs[0].auth?.creds.signedIdentityKey.public;
    await h.socket().emit('creds.update', { registered: true });
    await h.socketConfigs[0].auth?.keys.set({ session: { peer: Buffer.from('private') } });
    await h.socket().emit('connection.update', {
      connection: 'close',
      lastDisconnect: {
        date: new Date(),
        error: Object.assign(new Error('logged out'), { output: { statusCode: 401 } }),
      },
    });
    const disk = new Database(path.join(h.directory, 'auth.sqlite'), { readonly: true });
    expect(disk.prepare('SELECT count(*) AS n FROM auth').get()).toEqual({ n: 0 });
    disk.close();
    const loggedOut = new WhatsAppAuthStore(h.directory);
    expect(loggedOut.loggedOut('15550000000@s.whatsapp.net')).toBe(true);
    loggedOut.close();
    await h.writeLink({ schema_version: 1, state: 'linking' });
    expect(await adapter.requestPairingCode('15551112222')).toBe('12345678');
    expect(h.socketConfigs).toHaveLength(2);
    expect(h.socketConfigs[1].auth?.creds.registered).toBe(false);
    expect(h.socketConfigs[1].auth?.creds.signedIdentityKey.public).not.toEqual(oldIdentity);
    expect(await h.socketConfigs[1].auth?.keys.get('session', ['peer'])).toEqual({});
    const relink = new WhatsAppAuthStore(h.directory);
    expect(relink.loggedOut('15550000000@s.whatsapp.net')).toBe(true);
    relink.close();
    await h.socket().emit('creds.update', {
      account: { details: Buffer.from('native paired account') },
      me: { id: '15550000000:2@s.whatsapp.net', name: 'Assistant' },
    });
    const paired = new WhatsAppAuthStore(h.directory);
    expect(paired.loggedOut('15550000000@s.whatsapp.net')).toBe(false);
    paired.close();
  });
  it('re-resolves the Web version for each linked reconnect with backoff', async () => {
    vi.useFakeTimers();
    const resolveVersion = vi.fn(async (): Promise<[number, number, number]> => [2, 3000, 123456]);
    await h.start({ resolveVersion });
    await h.socket().emit('connection.update', { connection: 'close' });
    expect(h.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(h.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(h.sockets).toHaveLength(2));
    expect(resolveVersion).toHaveBeenCalledTimes(2);
  });
  it('never reconnects a pairing socket on its own', async () => {
    vi.useFakeTimers();
    await h.writeLink({ schema_version: 1, state: 'linking' });
    await h.start({}, false);
    await h.socket().emit('connection.update', { connection: 'close' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.sockets).toHaveLength(1);
  });
});
