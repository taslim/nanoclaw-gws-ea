import Database from 'better-sqlite3';
import { mkdir, rm } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn(),
  isContainerRunning: () => false,
  killContainer: vi.fn(),
}));
vi.mock('./config.js', async (original) => ({
  ...(await original<typeof import('./config.js')>()),
  DATA_DIR: '/tmp/nanoclaw-delivery-not-connected',
  GROUPS_DIR: '/tmp/nanoclaw-delivery-not-connected/groups',
}));

import { ChannelNotConnectedError } from './channels/adapter.js';
import type { ChannelAdapter } from './channels/adapter.js';
import {
  createChannelDeliveryAdapter,
  initChannelAdapters,
  registerChannelAdapter,
  teardownChannelAdapters,
} from './channels/channel-registry.js';
import { closeDb, createAgentGroup, createMessagingGroup, initTestDb, runMigrations } from './db/index.js';
import { getDeliveryAttempt } from './db/coordination.js';
import { getSession } from './db/sessions.js';
import { deliverSessionMessages, registerDeliveryAction, setDeliveryAdapter } from './delivery.js';
import { unguarded } from './guard/index.js';
import { outboundDbPath } from './mailbox/sqlite/paths.js';
import { reconcileSession } from './reconcile-session.js';
import { createDestination } from './modules/agent-to-agent/db/agent-destinations.js';
import { resolveSession, withMailboxSession } from './session-manager.js';
import type { Session } from './types.js';

const directory = '/tmp/nanoclaw-delivery-not-connected';

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-18T12:00:00.000Z'));
  await mkdir(directory, { recursive: true });
  await runMigrations(await initTestDb());
});

afterEach(async () => {
  await teardownChannelAdapters();
  await closeDb();
  await rm(directory, { recursive: true, force: true });
  vi.useRealTimers();
});

async function conversation(): Promise<Session> {
  const created_at = new Date().toISOString();
  await createAgentGroup({ id: 'main', name: 'Robin', folder: 'main', agent_provider: null, created_at });
  for (const channel_type of ['whatsapp', 'gchat']) {
    await createMessagingGroup({
      id: channel_type,
      channel_type,
      platform_id: `${channel_type}-dm`,
      name: 'Principal',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at,
    });
  }
  await createDestination({
    agent_group_id: 'main',
    local_name: 'principal-gchat',
    target_type: 'channel',
    target_id: 'gchat',
    created_at,
  });
  return (await resolveSession('main', 'whatsapp', null, 'agent-shared')).session;
}

function enqueue(session: Session, id: string, channel: string | null, kind = 'chat'): void {
  const db = new Database(outboundDbPath('main', session.id));
  try {
    db.prepare(
      'INSERT INTO messages_out (id, timestamp, kind, channel_type, platform_id, content) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      id,
      new Date().toISOString(),
      kind,
      channel,
      channel === null ? null : `${channel}-dm`,
      JSON.stringify(kind === 'system' ? { action: id } : { text: id }),
    );
  } finally {
    db.close();
  }
}

describe('delivery during a channel outage', () => {
  it('keeps disconnected rows and attempts intact while other channels and host actions deliver', async () => {
    const session = await conversation();
    enqueue(session, 'wa-first', 'whatsapp');
    enqueue(session, 'wa-second', 'whatsapp');
    enqueue(session, 'gchat-reply', 'gchat');
    enqueue(session, 'offline-test-action', null, 'system');
    let actionRuns = 0;
    registerDeliveryAction(
      'offline-test-action',
      async () => {
        actionRuns += 1;
      },
      unguarded('test action'),
    );
    let connected = false;
    const attempted: string[] = [];
    const sent: string[] = [];
    setDeliveryAdapter({
      async deliver(channel, _platform, _thread, _kind, content, _files, _instance, messageId) {
        attempted.push(channel);
        if (channel === 'whatsapp' && !connected) throw new ChannelNotConnectedError();
        const value: unknown = JSON.parse(content);
        expect(value).toEqual({ text: messageId });
        sent.push(messageId!);
        return `platform-${messageId}`;
      },
    });
    for (let poll = 0; poll < 5; poll += 1) {
      await deliverSessionMessages(session);
      const delivered = await withMailboxSession('main', session.id, (mailbox) => mailbox.getDeliveredIds());
      expect(delivered.has('wa-first')).toBe(false);
      expect(delivered.has('wa-second')).toBe(false);
      expect(await getDeliveryAttempt('wa-first')).toBeUndefined();
      expect(await getDeliveryAttempt('wa-second')).toBeUndefined();
      expect(sent).toEqual(['gchat-reply']);
      expect(actionRuns).toBe(1);
      vi.setSystemTime(Date.now() + 1_000);
    }
    expect(attempted.filter((channel) => channel === 'whatsapp')).toHaveLength(5);
    connected = true;
    await deliverSessionMessages(session);
    await deliverSessionMessages(session);
    expect(sent).toEqual(['gchat-reply', 'wa-first', 'wa-second']);
  });

  it('keeps a spent task session open until its waiting reply is delivered', async () => {
    await conversation();
    const task = (await resolveSession('main', 'whatsapp', 'system:tasks:reminder', 'per-thread')).session;
    enqueue(task, 'task-reply', 'whatsapp');
    let connected = false;
    const sent: string[] = [];
    setDeliveryAdapter({
      async deliver(channel, _platform, _thread, _kind, _content, _files, _instance, messageId) {
        if (channel === 'whatsapp' && !connected) throw new ChannelNotConnectedError();
        sent.push(messageId!);
        return `platform-${messageId}`;
      },
    });
    await deliverSessionMessages(task);
    await reconcileSession(task.id);
    expect((await getSession(task.id))?.status).toBe('active');
    connected = true;
    vi.setSystemTime(Date.now() + 1_000);
    await deliverSessionMessages(task);
    expect(sent).toEqual(['task-reply']);
    await reconcileSession(task.id);
    expect((await getSession(task.id))?.status).toBe('closed');
  });

  it('passes the durable outbound id and original time through the real registry bridge', async () => {
    const session = await conversation();
    enqueue(session, 'durable-row', 'whatsapp');
    vi.setSystemTime(Date.now() + 5 * 60 * 60 * 1_000);
    const received: Array<{ id?: string; timestamp?: string }> = [];
    const adapter: ChannelAdapter = {
      name: 'whatsapp',
      channelType: 'whatsapp',
      supportsThreads: false,
      async setup() {},
      async teardown() {},
      isConnected: () => true,
      async deliver(_platform, _thread, message, messageId) {
        received.push({ id: messageId, timestamp: message.timestamp });
        return 'platform-id';
      },
    };
    registerChannelAdapter('whatsapp', { factory: () => adapter });
    await initChannelAdapters(() => ({ onInbound() {}, onInboundEvent() {}, onMetadata() {}, onAction() {} }));
    setDeliveryAdapter(createChannelDeliveryAdapter());
    await deliverSessionMessages(session);
    expect(received).toEqual([{ id: 'durable-row', timestamp: '2026-10-18T12:00:00.000Z' }]);
  });
});
