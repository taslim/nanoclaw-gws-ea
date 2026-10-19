import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WhatsAppAuthStore } from './auth-store.js';
import { logoutWhatsAppAccount } from './logout.js';
import { readWhatsAppLink, writeWhatsAppLink } from './paths.js';
import { FakeSocket } from './testing/fake-socket.js';

let root: string;
let directory: string;
let socket: FakeSocket | undefined;
const account = '15550000000@s.whatsapp.net';
const resolveVersion = async (): Promise<[number, number, number]> => [2, 3000, 123456];
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-logout-'));
  directory = path.join(root, 'secrets/whatsapp');
  socket = undefined;
  await writeWhatsAppLink(directory, {
    schema_version: 1,
    state: 'connected',
    number: '+15550000000',
    account: { lid: '999000', phoneJid: account },
  });
  const auth = new WhatsAppAuthStore(directory);
  auth.saveCreds({ registered: true, me: { id: '15550000000:1@s.whatsapp.net', name: 'Aya' } });
  auth.close();
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(root, { recursive: true, force: true });
});
function logout() {
  return logoutWhatsAppAccount({
    directory,
    resolveVersion,
    makeSocket: () => {
      socket = new FakeSocket();
      return socket;
    },
  });
}
async function ready() {
  await vi.waitFor(() => expect(socket).toBeDefined());
  return socket!;
}
function saved() {
  const auth = new WhatsAppAuthStore(directory);
  const result = { registered: auth.state.creds.registered, proof: auth.loggedOut(account) };
  auth.close();
  return result;
}
it('signs out through the native socket, closes it, and makes interrupted removal safe to retry without another socket', async () => {
  const pending = logout();
  const native = await ready();
  await native.emit('connection.update', { connection: 'open' });
  await pending;
  expect(native.loggedOut).toBe(true);
  expect(native.ended).toBe(true);
  expect(native.sends).toEqual([]);
  expect(saved()).toEqual({ registered: false, proof: true });
  socket = undefined;
  await logout();
  expect(socket).toBeUndefined();
  expect((await readWhatsAppLink(directory))?.number).toBe('+15550000000');
});
it('accepts a server loggedOut response as native proof without sending a second logout', async () => {
  const pending = logout();
  const native = await ready();
  await native.emit('connection.update', {
    connection: 'close',
    lastDisconnect: {
      error: Object.assign(new Error('server logged out'), { output: { statusCode: 401 } }),
      date: new Date(),
    },
  });
  await pending;
  expect(native.loggedOut).toBe(false);
  expect(native.ended).toBe(true);
  expect(saved()).toEqual({ registered: false, proof: true });
});
it.each(['registered', 'account'] as const)(
  'preserves native %s credentials on logout failure, and a fresh pairing cannot borrow an older proof',
  async (kind) => {
    let pending = logout();
    let native = await ready();
    await native.emit('connection.update', { connection: 'open' });
    await pending;
    const auth = new WhatsAppAuthStore(directory);
    auth.saveCreds({
      ...(kind === 'registered'
        ? { registered: true }
        : { account: { details: Buffer.from('native paired account') } }),
      me: { id: '15550000000:2@s.whatsapp.net', name: 'Aya' },
    });
    auth.close();
    socket = undefined;
    pending = logout();
    native = await ready();
    vi.spyOn(native, 'logout').mockRejectedValueOnce(new Error('Platform refused logout'));
    const refusal = expect(pending).rejects.toThrow('Platform refused logout');
    await native.emit('connection.update', { connection: 'open' });
    await refusal;
    expect(native.ended).toBe(true);
    expect(saved()).toEqual({ registered: kind === 'registered', proof: false });
  },
);
it('does not erase credentials if a native logout completes after its deadline', async () => {
  vi.useFakeTimers();
  const pending = logout();
  const refusal = expect(pending).rejects.toThrow('timed out');
  const native = await ready();
  let complete: (() => void) | undefined;
  vi.spyOn(native, 'logout').mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
  );
  const clear = vi.spyOn(WhatsAppAuthStore.prototype, 'clear');
  try {
    await native.emit('connection.update', { connection: 'open' });
    await vi.waitFor(() => expect(complete).toBeDefined());
    await vi.advanceTimersByTimeAsync(30_000);
    await refusal;
    complete!();
    await vi.advanceTimersByTimeAsync(0);
    expect(clear).not.toHaveBeenCalled();
    expect(saved()).toEqual({ registered: true, proof: false });
    expect(native.ended).toBe(true);
  } finally {
    clear.mockRestore();
  }
});
it('does not turn needs-relink or missing credentials into logout proof', async () => {
  await writeWhatsAppLink(directory, { schema_version: 1, state: 'needs-relink', number: '+15550000000' });
  const auth = new WhatsAppAuthStore(directory);
  auth.clear({ kind: 'discarded' });
  auth.close();
  await expect(logout()).rejects.toThrow('no registered credentials or native logout proof');
  fs.rmSync(path.join(directory, 'auth.sqlite'));
  await expect(logout()).rejects.toThrow('credentials are missing');
  expect((await readWhatsAppLink(directory))?.state).toBe('needs-relink');
  expect(socket).toBeUndefined();
});
it('bounds a socket that never opens and keeps its credentials for retry', async () => {
  vi.useFakeTimers();
  const pending = logout();
  const refusal = expect(pending).rejects.toThrow('timed out');
  await ready();
  await vi.advanceTimersByTimeAsync(30_000);
  await refusal;
  expect(socket?.ended).toBe(true);
  expect(saved()).toEqual({ registered: true, proof: false });
});
it('settles an unregistered pending pairing without a socket', async () => {
  await writeWhatsAppLink(directory, { schema_version: 1, state: 'linking', number: '+15550000000' });
  const auth = new WhatsAppAuthStore(directory);
  auth.clear({ kind: 'discarded' });
  auth.saveCreds();
  auth.close();
  await logout();
  expect(socket).toBeUndefined();
  expect(saved().proof).toBe(false);
});
