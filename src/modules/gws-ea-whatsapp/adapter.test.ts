import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChannelNotConnectedError, type ChannelSetup } from '../../channels/adapter.js';
import { initTestDb, closeDb, runMigrations } from '../../db/index.js';
import { createWhatsAppAdapter } from './adapter.js';
import { WhatsAppIndex } from './index-store.js';
import { readWhatsAppLink, writeWhatsAppLink } from './paths.js';
import { FakeSocket, incoming } from './testing/fake-socket.js';

let directory: string;
let sockets: FakeSocket[];
const setup = (): ChannelSetup => ({
  onInbound: vi.fn(),
  onInboundEvent: vi.fn(),
  onMetadata: vi.fn(),
  onAction: vi.fn(),
});
function create(resolveVersion = async (): Promise<[number, number, number]> => [2, 3000, 123456]) {
  return createWhatsAppAdapter({
    directory,
    resolveVersion,
    makeSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    downloadMedia: async () => Buffer.from('recording'),
  });
}
beforeEach(async () => {
  directory = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wa-transport-')), 'secrets', 'whatsapp');
  sockets = [];
  await runMigrations(await initTestDb());
  await writeWhatsAppLink(directory, { schema_version: 1, state: 'connected' });
});
afterEach(async () => {
  await closeDb();
  vi.useRealTimers();
  fs.rmSync(path.dirname(path.dirname(directory)), { recursive: true, force: true });
});

describe('WhatsApp transport lifecycle', () => {
  it('starts without waiting for an open socket and holds offline sends', async () => {
    const adapter = create();
    await adapter.setup(setup());
    await adapter.reconnect();
    await expect(
      adapter.deliver('12000@lid', null, { kind: 'chat', content: { text: 'Hi' } }, 'row-1'),
    ).rejects.toBeInstanceOf(ChannelNotConnectedError);
    expect(sockets[0].sends).toEqual([]);
    await sockets[0].emit('connection.update', { connection: 'open' });
    await adapter.deliver('12000@lid', null, { kind: 'chat', content: { text: 'Hi' } }, 'row-1');
    expect(sockets[0].sends).toHaveLength(1);
    await adapter.teardown();
  });

  it('finishes setup while the Web version lookup is still pending', async () => {
    let release!: (value: [number, number, number]) => void;
    const version = new Promise<[number, number, number]>((resolve) => {
      release = resolve;
    });
    const adapter = create(() => version);
    await adapter.setup(setup());
    expect(sockets).toEqual([]);
    release([2, 3000, 123456]);
    await adapter.reconnect();
    expect(sockets).toHaveLength(1);
    await adapter.teardown();
  });

  it('awaits routing, deduplicates notify and append, and ignores history sync', async () => {
    const adapter = create();
    const config = setup();
    await adapter.setup(config);
    await adapter.reconnect();
    await sockets[0].emit('connection.update', { connection: 'open' });
    const msg = incoming('live');
    await sockets[0].emit('messages.upsert', { type: 'notify', messages: [msg] });
    await sockets[0].emit('messages.upsert', { type: 'append', messages: [msg, incoming('offline')] });
    await sockets[0].emit('messaging-history.set', {
      chats: [],
      contacts: [],
      messages: [incoming('history')],
      isLatest: true,
      syncType: 0,
    });
    expect(config.onInbound).toHaveBeenCalledTimes(2);
    expect(vi.mocked(config.onInbound).mock.calls[0][2].authenticatedSender).toEqual({
      userId: 'whatsapp:12000',
      displayName: 'Pat',
      kind: 'human',
    });
    await adapter.teardown();
  });

  it('replays an unrouted record after a route failure and after restart', async () => {
    let adapter = create();
    const broken = setup();
    vi.mocked(broken.onInbound).mockRejectedValue(new Error('mailbox unavailable'));
    await adapter.setup(broken);
    await adapter.reconnect();
    await sockets[0].emit('connection.update', { connection: 'open' });
    await sockets[0].emit('messages.upsert', { type: 'notify', messages: [incoming('unrouted')] });
    await adapter.teardown();
    adapter = create();
    const recovered = setup();
    await adapter.setup(recovered);
    await adapter.reconnect();
    await sockets[1].emit('connection.update', { connection: 'open' });
    expect(recovered.onInbound).toHaveBeenCalledTimes(1);
    await sockets[1].emit('messages.upsert', { type: 'append', messages: [incoming('unrouted')] });
    expect(recovered.onInbound).toHaveBeenCalledTimes(1);
    await adapter.teardown();
  });

  it('persists the entire incoming batch before identity lookup or an earlier route completes', async () => {
    const adapter = create();
    const config = setup();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(config.onInbound).mockImplementation(() => blocked);
    await adapter.setup(config);
    await adapter.reconnect();
    await sockets[0].emit('connection.update', { connection: 'open' });
    const first = sockets[0].emit('messages.upsert', { type: 'notify', messages: [incoming('held-first')] });
    await vi.waitFor(() => expect(config.onInbound).toHaveBeenCalledTimes(1));
    const second = sockets[0].emit('messages.upsert', {
      type: 'notify',
      messages: [incoming('queued-second'), incoming('queued-third')],
    });
    const disk = new WhatsAppIndex(directory, () => '15550000000@s.whatsapp.net');
    try {
      expect(disk.unrouted().map((message) => message.key.id)).toEqual(['held-first', 'queued-second', 'queued-third']);
    } finally {
      disk.close();
      release();
      await Promise.all([first, second]);
      await adapter.teardown();
    }
  });

  it('reports a failed version lookup and never uses a built-in version', async () => {
    const adapter = create(async () => {
      throw new Error('version unavailable');
    });
    await adapter.setup(setup());
    await adapter.reconnect();
    expect(sockets).toEqual([]);
    expect((await readWhatsAppLink(directory))?.error?.message).toContain('version unavailable');
    await adapter.teardown();
  });

  it('clears auth on logout, keeps a needs-relink adapter, and holds its sends after restart', async () => {
    let adapter = create();
    await adapter.setup(setup());
    await adapter.reconnect();
    await sockets[0].emit('creds.update', { registered: true });
    await sockets[0].emit('connection.update', {
      connection: 'close',
      lastDisconnect: {
        error: Object.assign(new Error('logged out'), { output: { statusCode: 401 } }),
        date: new Date(),
      },
    });
    expect((await readWhatsAppLink(directory))?.state).toBe('needs-relink');
    await adapter.teardown();
    adapter = create();
    await adapter.setup(setup());
    await adapter.reconnect();
    expect(sockets).toHaveLength(1);
    await expect(
      adapter.deliver('12000@lid', null, { kind: 'chat', content: { text: 'Hi' } }, 'row'),
    ).rejects.toBeInstanceOf(ChannelNotConnectedError);
    await adapter.teardown();
  });
});

it('leaves exactly the requested group through the live native socket, and propagates failures', async () => {
  const adapter = create();
  await adapter.setup(setup());
  await adapter.reconnect();
  await sockets[0].emit('connection.update', { connection: 'open' });
  await adapter.leaveGroup('trip@g.us');
  expect(sockets[0].leftGroups).toEqual(['trip@g.us']);
  sockets[0].leaveError = new Error('leave refused');
  await expect(adapter.leaveGroup('other@g.us')).rejects.toThrow('leave refused');
  await expect(adapter.leaveGroup('12000@lid')).rejects.toThrow(/group/);
  await adapter.teardown();
});
