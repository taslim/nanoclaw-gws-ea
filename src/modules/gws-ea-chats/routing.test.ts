import fs from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const { ROOT, send } = vi.hoisted(() => ({
  ROOT: `/tmp/wa-routing-fixes-${process.pid}`,
  send: vi.fn(async () => 'sent'),
}));
vi.mock('../../config.js', async (original) => ({
  ...(await original<typeof import('../../config.js')>()),
  DATA_DIR: ROOT,
}));
vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn(async () => true) }));
vi.mock('../../log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
}));
import { seedU11, cleanU11 } from './testing/u11-fixture.js';
import { registerChannelAdapter } from '../../channels/channel-registry.js';
import { GCHAT_DEFAULTS } from '../gws-ea-chat/adapter.js';
import { getDb } from '../../db/connection.js';
import { dispatch } from '../../cli/dispatch.js';
import '../../cli/resources/messaging-groups.js';
import '../../cli/resources/wirings.js';
import { setDeliveryAdapter } from '../../delivery.js';
import { routeInbound } from '../../router.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import { requestWake } from '../../request-wake.js';
import { getChat } from './db.js';
import type { InboundEvent } from '../../channels/adapter.js';
registerChannelAdapter('gchat', {
  defaults: GCHAT_DEFAULTS,
  factory: () => ({
    name: 'gchat',
    channelType: 'gchat',
    supportsThreads: true,
    defaults: GCHAT_DEFAULTS,
    setup: async () => {},
    teardown: async () => {},
    isConnected: () => true,
    deliver: async () => undefined,
  }),
});
let chatId: string;
beforeEach(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  chatId = (await seedU11()).chat.messaging_group_id;
  send.mockClear();
  vi.mocked(requestWake).mockClear();
  setDeliveryAdapter({ deliver: send });
});
afterEach(async () => cleanU11(ROOT));
function clear(platform: string, group: boolean, addressed = false, person = '22'): InboundEvent {
  return {
    channelType: 'whatsapp',
    platformId: platform,
    message: {
      id: `clear-${platform}`,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      isGroup: group,
      isMention: addressed,
      content: JSON.stringify({ text: '/clear', senderId: `whatsapp:${person}`, sender: 'Mira' }),
      authenticatedSender: { userId: `whatsapp:${person}`, displayName: 'Mira', kind: 'human' },
    },
  };
}
it('keeps an unknown private chat silent when its first message is an admin command', async () => {
  await routeInbound(clear('33', false, false, '33'));
  const group = await getDb().get<{ id: string }>("SELECT id FROM messaging_groups WHERE platform_id='33'");
  expect(await getChat(group!.id)).toMatchObject({ state: 'asking' });
  expect(send).not.toHaveBeenCalled();
  expect(requestWake).not.toHaveBeenCalled();
});
it('keeps an unaddressed admin command silent in an active group', async () => {
  expect(await getChat(chatId)).toMatchObject({ state: 'connected' });
  await routeInbound(clear('context@g.us', true));
  expect(send).not.toHaveBeenCalled();
  expect(requestWake).not.toHaveBeenCalled();
});
it('still denies an addressed non-admin command in an admitted group', async () => {
  await routeInbound(clear('context@g.us', true, true));
  expect(send).toHaveBeenCalledOnce();
  expect(send.mock.calls[0]).toContain(JSON.stringify({ text: 'Permission denied: /clear requires admin access.' }));
  expect(requestWake).not.toHaveBeenCalled();
});
it('native manual Google Chat wiring keeps mention engagement and wakes on a mention', async () => {
  const host = { caller: 'host' as const };
  const created = await dispatch(
    {
      id: 'mg',
      command: 'messaging-groups-create',
      args: {
        channel_type: 'gchat',
        platform_id: 'spaces/manual',
        is_group: 1,
      },
    },
    host,
  );
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error(created.error.message);
  const mg = created.data as { id: string; unknown_sender_policy: string };
  expect(mg.unknown_sender_policy).toBe('request_approval');
  const wired = await dispatch(
    {
      id: 'wire',
      command: 'wirings-create',
      args: {
        channel_type: 'gchat',
        platform_id: 'spaces/manual',
        agent_group: 'peer',
      },
    },
    host,
  );
  expect(wired.ok).toBe(true);
  if (!wired.ok) throw new Error(wired.error.message);
  expect(wired.data).toMatchObject({ engage_mode: 'mention' });
  // Sender admission is independent of the wiring defaults under test.
  await getDb().run("UPDATE messaging_groups SET unknown_sender_policy='public' WHERE id=?", mg.id);
  await routeInbound({
    channelType: 'gchat',
    platformId: 'spaces/manual',
    threadId: 'thread',
    message: {
      id: 'mentioned',
      kind: 'chat',
      timestamp: new Date().toISOString(),
      isGroup: true,
      isMention: true,
      content: JSON.stringify({ text: 'Hello', sender: 'Mira', senderId: 'gchat:users/22' }),
      authenticatedSender: { userId: 'gchat:users/22', displayName: 'Mira', kind: 'human' },
    },
  });
  expect(await getChat(mg.id)).toBeUndefined();
  expect(requestWake).toHaveBeenCalledOnce();
  const session = await getDb().get<{ id: string }>('SELECT id FROM sessions WHERE messaging_group_id=?', mg.id);
  const messages = await withExistingMailboxSession('peer', session!.id, (mailbox) =>
    mailbox.getInboundRecords({ status: 'pending' }),
  );
  expect(messages.find((row) => row.id === 'mentioned:peer')).toMatchObject({ threadId: 'thread' });
});
