import fs from 'node:fs';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DIR, requestWake, startTypingRefresh } = vi.hoisted(() => ({
  TEST_DIR: `/tmp/nanoclaw-router-engage-module-${process.pid}`,
  requestWake: vi.fn(async () => true),
  startTypingRefresh: vi.fn(),
}));
vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  DATA_DIR: TEST_DIR,
}));
vi.mock('./request-wake.js', () => ({ requestWake }));
vi.mock('./modules/typing/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./modules/typing/index.js')>()),
  startTypingRefresh,
}));

import type { InboundEvent } from './channels/adapter.js';
import { createAgentGroup } from './db/agent-groups.js';
import { closeDb, getDb, initSqliteTestDb } from './db/connection.js';
import { createMessagingGroup, createMessagingGroupAgent } from './db/messaging-groups.js';
import { runMigrations } from './db/migrations/index.js';
import { registerInboundPreparer, type InboundPreparationRequest } from './inbound-preparation.js';
import { inboundDbPath } from './mailbox/sqlite/paths.js';
import * as router from './router.js';
import type { EngageMode } from './types.js';

const timestamp = '2026-10-18T18:30:00.000Z';
const prepare = vi.fn<(request: InboundPreparationRequest) => Promise<string>>();
registerInboundPreparer((request) => prepare(request));
let refused = false;
let scopedOut = false;
router.setAccessGate(() => (refused ? { allowed: false, reason: 'refused' } : { allowed: true }));
router.setSenderScopeGate(() => (scopedOut ? { allowed: false, reason: 'scope' } : { allowed: true }));
let channelNumber = 0;
let channelType: string;

function event(id: string, text = '', platformId = 'room'): InboundEvent {
  return {
    channelType,
    platformId,
    threadId: null,
    message: {
      id,
      kind: 'chat',
      content: JSON.stringify({ text, sender: 'Juno Hale', replyTo: { id: 'previous-send', text: 'Thursday?' } }),
      timestamp,
      isGroup: true,
      authenticatedSender: { userId: `${channelType}:juno`, displayName: 'Juno Hale', kind: 'human' },
      deduplicate: true,
    },
  };
}

async function seed(platformId = 'room', mode: EngageMode = 'module'): Promise<void> {
  await createMessagingGroup({
    id: `mg-${platformId}`,
    channel_type: channelType,
    platform_id: platformId,
    name: 'Lake trip',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: timestamp,
  });
  await createMessagingGroupAgent({
    id: `wiring-${platformId}`,
    messaging_group_id: `mg-${platformId}`,
    agent_group_id: 'ag-1',
    engage_mode: mode,
    engage_pattern: '^Robin',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: timestamp,
  });
}

async function rows(platformId = 'room'): Promise<Array<{ id: string; trigger: number; content: string }>> {
  const session = await getDb().get<{ id: string }>(
    'SELECT id FROM sessions WHERE agent_group_id = ? AND messaging_group_id = ?',
    'ag-1',
    `mg-${platformId}`,
  );
  if (!session) return [];
  const inbound = new Database(inboundDbPath('ag-1', session.id), { readonly: true });
  try {
    return inbound.prepare('SELECT id, trigger, content FROM messages_in ORDER BY seq').all() as Array<{
      id: string;
      trigger: number;
      content: string;
    }>;
  } finally {
    inbound.close();
  }
}

function latch(): { wait: Promise<void>; release: () => void } {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}

beforeEach(async () => {
  channelType = `module-chat-${++channelNumber}`;
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initSqliteTestDb());
  await createAgentGroup({ id: 'ag-1', name: 'Robin', folder: 'ag-1', agent_provider: null, created_at: timestamp });
  refused = false;
  scopedOut = false;
  requestWake.mockClear();
  startTypingRefresh.mockClear();
  prepare.mockReset();
  prepare.mockImplementation(async (request) => request.content);
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('module engagement after preparation', () => {
  it('stores unaddressed context without a wake or typing when no decider is registered', async () => {
    await seed();
    await router.routeInbound(event('banter', 'Funny video.'));

    expect((await rows()).map(({ id, trigger }) => ({ id, trigger }))).toEqual([{ id: 'banter:ag-1', trigger: 0 }]);
    expect(requestWake).not.toHaveBeenCalled();
    expect(startTypingRefresh).not.toHaveBeenCalled();
  });

  it('lets the channel decline a prepared message while retaining its conversation context', async () => {
    await seed();
    router.registerEngagementDecider(channelType, () => false);
    await router.routeInbound(event('banter', 'Funny video.'));

    expect((await rows()).map(({ id, trigger }) => ({ id, trigger }))).toEqual([{ id: 'banter:ag-1', trigger: 0 }]);
    expect(requestWake).not.toHaveBeenCalled();
    expect(startTypingRefresh).not.toHaveBeenCalled();
  });

  it('decides from recognized speech while preserving authenticated sender and quote metadata', async () => {
    await seed();
    const original = event('voice');
    prepare.mockImplementation(async ({ content }) =>
      JSON.stringify({
        ...(JSON.parse(content) as Record<string, unknown>),
        attachments: [{ type: 'audio', speech: { status: 'recognized', text: 'Robin, check Thursday.' } }],
      }),
    );
    let decided: InboundEvent | undefined;
    router.registerEngagementDecider(channelType, ({ event: prepared, session, messagingGroup, wiring }) => {
      decided = prepared;
      expect(session.agent_group_id).toBe('ag-1');
      expect(messagingGroup.id).toBe('mg-room');
      expect(wiring.id).toBe('wiring-room');
      return prepared.message.content.includes('Robin, check Thursday.');
    });
    await router.routeInbound(original);

    expect(decided?.message.authenticatedSender).toEqual(original.message.authenticatedSender);
    expect(JSON.parse(decided!.message.content)).toMatchObject({ replyTo: { id: 'previous-send', text: 'Thursday?' } });
    expect((await rows()).map(({ trigger }) => trigger)).toEqual([1]);
    expect(requestWake).toHaveBeenCalledTimes(1);
    expect(startTypingRefresh).toHaveBeenCalledTimes(1);
    expect(original.message.content).not.toContain('recognized');
  });

  it('refuses unauthorized senders before preparing or evaluating their message', async () => {
    await seed();
    const decide = vi.fn(() => true);
    router.registerEngagementDecider(channelType, decide);
    refused = true;
    await router.routeInbound(event('refused', 'Robin?'));
    refused = false;
    scopedOut = true;
    await router.routeInbound(event('scoped-out', 'Robin?'));

    expect(await rows()).toEqual([]);
    expect(prepare).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
    expect(requestWake).not.toHaveBeenCalled();
    expect(startTypingRefresh).not.toHaveBeenCalled();
  });

  it('leaves pattern engagement on its existing path', async () => {
    await seed('room', 'pattern');
    const decide = vi.fn(() => false);
    router.registerEngagementDecider(channelType, decide);
    await router.routeInbound(event('banter', 'Funny video.'));
    await router.routeInbound(event('addressed', 'Robin, check Thursday.'));

    expect((await rows()).map(({ id, trigger }) => ({ id, trigger }))).toEqual([{ id: 'addressed:ag-1', trigger: 1 }]);
    expect(decide).not.toHaveBeenCalled();
    expect(requestWake).toHaveBeenCalledTimes(1);
  });

  it('keeps a new expected reply when a retry-safe old message is delivered again', async () => {
    await seed();
    let waiting = false;
    router.registerEngagementDecider(channelType, () => {
      const expected = waiting;
      waiting = false;
      return expected;
    });
    await router.routeInbound(event('old-banter', 'Funny video.'));
    waiting = true;
    await router.routeInbound(event('old-banter', 'Funny video.'));
    await router.routeInbound(event('new-answer', 'Thursday.'));

    expect((await rows()).map(({ id, trigger }) => ({ id, trigger }))).toEqual([
      { id: 'old-banter:ag-1', trigger: 0 },
      { id: 'new-answer:ag-1', trigger: 1 },
    ]);
    expect(requestWake).toHaveBeenCalledTimes(1);
    expect(startTypingRefresh).toHaveBeenCalledTimes(1);
  });
});

describe('conversation-tail work', () => {
  it('runs a cutover after the current message and before the next while other chats proceed', async () => {
    await seed('room', 'pattern');
    await seed('other', 'pattern');
    const started = latch();
    const release = latch();
    prepare.mockImplementation(async (request) => {
      if (request.messageId === 'first') {
        started.release();
        await release.wait;
      }
      return request.content;
    });
    const first = router.routeInbound(event('first', 'Robin, plan the trip.'));
    await started.wait;
    const cutover = router.runInConversationTail({ channelType, platformId: 'room' }, async () => {
      expect((await rows()).map(({ id }) => id)).toEqual(['first:ag-1']);
      return 'moved';
    });
    const next = router.routeInbound(event('next', 'Robin, add Friday.'));
    try {
      await router.routeInbound(event('unrelated', 'Robin?', 'other'));
      expect((await rows('other')).map(({ id }) => id)).toEqual(['unrelated:ag-1']);
      expect(await rows()).toEqual([]);
    } finally {
      release.release();
      await first;
    }
    expect(await cutover).toBe('moved');
    await next;
    expect((await rows()).map(({ id }) => id)).toEqual(['first:ag-1', 'next:ag-1']);
  });

  it('reports failed work to its caller without poisoning subsequent messages', async () => {
    await seed('room', 'pattern');
    await expect(
      router.runInConversationTail({ channelType, platformId: 'room' }, async () => {
        throw new Error('cutover failed');
      }),
    ).rejects.toThrow('cutover failed');
    await router.routeInbound(event('next', 'Robin?'));
    expect((await rows()).map(({ id }) => id)).toEqual(['next:ag-1']);
  });
});
