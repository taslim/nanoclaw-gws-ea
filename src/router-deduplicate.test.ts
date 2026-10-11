/**
 * Retry-safe inbound IDs: an event its source may deliver again (a routed
 * admin message, or a Chat event Pub/Sub hands out twice) carries
 * `deduplicate`. A copy of one already queued in the session is dropped
 * there, before anything a routed message sets off: no second row, no
 * typing, no wake, and no fan-out to sibling sessions.
 */
import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DIR, requestWake, startTypingRefresh, fanInboundMessage } = vi.hoisted(() => ({
  TEST_DIR: `/tmp/nanoclaw-router-deduplicate-${process.pid}`,
  requestWake: vi.fn(async () => true),
  startTypingRefresh: vi.fn(),
  fanInboundMessage: vi.fn(async () => undefined),
}));
vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: TEST_DIR };
});
vi.mock('./request-wake.js', () => ({ requestWake }));
vi.mock('./modules/typing/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./modules/typing/index.js')>()),
  startTypingRefresh,
}));
vi.mock('./modules/cross-session-context/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./modules/cross-session-context/index.js')>()),
  fanInboundMessage,
}));

import type { InboundEvent } from './channels/adapter.js';
import { createAgentGroup } from './db/agent-groups.js';
import { closeDb, getDb, initSqliteTestDb } from './db/connection.js';
import { createMessagingGroup, createMessagingGroupAgent } from './db/messaging-groups.js';
import { runMigrations } from './db/migrations/index.js';
import { routeInbound } from './router.js';

const now = () => new Date().toISOString();

beforeEach(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initSqliteTestDb());
  await createAgentGroup({ id: 'ag-1', name: 'main', folder: 'main', agent_provider: null, created_at: now() });
  await createMessagingGroup({
    id: 'mg-1',
    channel_type: 'testchat',
    platform_id: 'dm-1',
    instance: 'testchat',
    name: null,
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  await createMessagingGroupAgent({
    id: 'mga-1',
    messaging_group_id: 'mg-1',
    agent_group_id: 'ag-1',
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'agent-shared',
    priority: 0,
    created_at: now(),
  });
  requestWake.mockClear();
  startTypingRefresh.mockClear();
  fanInboundMessage.mockClear();
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

function event(id: string, text: string, deduplicate: boolean | undefined): InboundEvent {
  return {
    channelType: 'testchat',
    instance: 'testchat',
    platformId: 'dm-1',
    threadId: null,
    message: {
      id,
      kind: 'chat-sdk',
      content: JSON.stringify({ text, senderId: 'testchat:principal' }),
      timestamp: now(),
      isMention: true,
      isGroup: false,
      ...(deduplicate === undefined ? {} : { deduplicate }),
    },
  };
}

async function queuedIds(): Promise<unknown[]> {
  const session = await getDb().get<{ id: string }>('SELECT id FROM sessions WHERE agent_group_id = ?', 'ag-1');
  expect(session).toBeDefined();
  const inbound = new Database(path.join(TEST_DIR, 'v2-sessions', 'ag-1', session!.id, 'inbound.db'), {
    readonly: true,
  });
  try {
    return inbound.prepare('SELECT id FROM messages_in ORDER BY seq').all();
  } finally {
    inbound.close();
  }
}

describe('retry-safe routed inbound IDs', () => {
  it('stores a retried welcome once and sets nothing off for the copy', async () => {
    const welcome = event('gws-ea-welcome:stable', 'welcome', true);
    await routeInbound(welcome);
    await routeInbound(welcome);

    expect(await queuedIds()).toEqual([{ id: 'gws-ea-welcome:stable:ag-1' }]);
    expect(requestWake).toHaveBeenCalledTimes(1);
  });

  it('drops a redelivered Chat message already routed: no second row, typing, wake, or fan-out', async () => {
    const message = event('spaces/AAAAjuno/messages/remy.1', 'Can you move Thursday?', true);
    await routeInbound(message);
    expect(requestWake).toHaveBeenCalledTimes(1);
    expect(startTypingRefresh).toHaveBeenCalledTimes(1);
    expect(fanInboundMessage).toHaveBeenCalledTimes(1);

    await routeInbound(message);

    expect(await queuedIds()).toEqual([{ id: 'spaces/AAAAjuno/messages/remy.1:ag-1' }]);
    expect(requestWake).toHaveBeenCalledTimes(1);
    expect(startTypingRefresh).toHaveBeenCalledTimes(1);
    expect(fanInboundMessage).toHaveBeenCalledTimes(1);
  });

  it('routes the next message after a dropped copy as usual', async () => {
    const first = event('spaces/AAAAjuno/messages/remy.1', 'Can you move Thursday?', true);
    await routeInbound(first);
    await routeInbound(first);
    await routeInbound(event('spaces/AAAAjuno/messages/remy.2', 'To Friday, please.', true));

    expect(await queuedIds()).toEqual([
      { id: 'spaces/AAAAjuno/messages/remy.1:ag-1' },
      { id: 'spaces/AAAAjuno/messages/remy.2:ag-1' },
    ]);
    expect(requestWake).toHaveBeenCalledTimes(2);
  });

  it('refuses a repeated id from a source that never marks its messages retry-safe', async () => {
    const message = event('spaces/AAAAjuno/messages/remy.1', 'Can you move Thursday?', undefined);
    await routeInbound(message);

    await expect(routeInbound(message)).rejects.toThrow(/messages_in\.id/u);
    expect(requestWake).toHaveBeenCalledTimes(1);
  });
});
