import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DIR, requestWake } = vi.hoisted(() => ({
  TEST_DIR: `/tmp/nanoclaw-router-deduplicate-${process.pid}`,
  requestWake: vi.fn(async () => true),
}));
vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: TEST_DIR };
});
vi.mock('./request-wake.js', () => ({ requestWake }));

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
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('retry-safe routed inbound IDs', () => {
  it('stores one welcome but still wakes the existing session after a confirmed duplicate retry', async () => {
    const event = {
      channelType: 'testchat',
      instance: 'testchat',
      platformId: 'dm-1',
      threadId: null,
      message: {
        id: 'gws-ea-welcome:stable',
        kind: 'chat' as const,
        content: JSON.stringify({ text: 'welcome', senderId: 'testchat:principal' }),
        timestamp: now(),
        isGroup: false,
        deduplicate: true,
      },
    };
    await routeInbound(event);
    await routeInbound(event);

    const session = await getDb().get<{ id: string }>('SELECT id FROM sessions WHERE agent_group_id = ?', 'ag-1');
    expect(session).toBeDefined();
    const inbound = new Database(path.join(TEST_DIR, 'v2-sessions', 'ag-1', session!.id, 'inbound.db'), {
      readonly: true,
    });
    try {
      expect(inbound.prepare('SELECT id FROM messages_in').all()).toEqual([{ id: 'gws-ea-welcome:stable:ag-1' }]);
    } finally {
      inbound.close();
    }
    expect(requestWake).toHaveBeenCalledTimes(2);
  });
});
