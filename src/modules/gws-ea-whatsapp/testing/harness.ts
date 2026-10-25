import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { UserFacingSocketConfig } from '@whiskeysockets/baileys';
import { vi } from 'vitest';

import type { ChannelSetup } from '../../../channels/adapter.js';
import { closeDb, initTestDb, runMigrations } from '../../../db/index.js';
import { createWhatsAppAdapter, type WhatsAppAdapter, type WhatsAppAdapterOptions } from '../adapter.js';
import type { WhatsAppContent } from '../inbound.js';
import { writeWhatsAppLink, type WhatsAppLink } from '../paths.js';
import { FakeSocket } from './fake-socket.js';

export async function transportHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-contract-'));
  const directory = path.join(root, 'secrets', 'whatsapp');
  await runMigrations(await initTestDb());
  await writeWhatsAppLink(directory, { schema_version: 1, state: 'connected' });
  const sockets: FakeSocket[] = [];
  const socketConfigs: UserFacingSocketConfig[] = [];
  const adapters: WhatsAppAdapter[] = [];
  const setup: ChannelSetup = {
    onInbound: vi.fn(async () => undefined),
    onInboundEvent: vi.fn(),
    onMetadata: vi.fn(),
    onAction: vi.fn(async () => undefined),
  };
  const download = vi.fn(async () => Buffer.from('real media boundary bytes'));
  const now = { value: Date.parse('2026-10-18T12:00:00.000Z') };
  async function start(options: Partial<WhatsAppAdapterOptions> = {}, open = true): Promise<WhatsAppAdapter> {
    const adapter = createWhatsAppAdapter({
      directory,
      resolveVersion: async () => [2, 3000, 123456],
      makeSocket: (config) => {
        socketConfigs.push(config);
        const socket = new FakeSocket();
        sockets.push(socket);
        // As Baileys does a moment after the socket opens, for credentials with no `me` to log in as.
        if (!config.auth?.creds.me) setTimeout(() => void socket.announcePairing(), 0);
        return socket;
      },
      downloadMedia: download,
      now: () => now.value,
      ...options,
    });
    adapters.push(adapter);
    await adapter.setup(setup);
    await adapter.reconnect();
    if (open) await sockets[sockets.length - 1].emit('connection.update', { connection: 'open' });
    return adapter;
  }
  return {
    root,
    directory,
    sockets,
    socketConfigs,
    setup,
    download,
    now,
    start,
    socket: () => sockets[sockets.length - 1],
    messages: () => vi.mocked(setup.onInbound).mock.calls.map((call) => call[2]),
    content: () => vi.mocked(setup.onInbound).mock.calls.map((call) => call[2].content as WhatsAppContent),
    writeLink: (link: WhatsAppLink) => writeWhatsAppLink(directory, link),
    async close() {
      for (const adapter of adapters) await adapter.teardown();
      await closeDb();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
export type TransportHarness = Awaited<ReturnType<typeof transportHarness>>;
