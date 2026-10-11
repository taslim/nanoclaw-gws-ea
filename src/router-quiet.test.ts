/**
 * The router's quiet path (KTD10), driven as the Chat bridge drives it.
 *
 * A reaction on the assistant's own message wakes the conversation's agent
 * the way a mention does (R4). Any other reaction, and any event marked
 * quiet, is context: stored with trigger=0 in the session the conversation
 * already has, waking nothing and creating no session. Both reach an agent
 * only when the person may (membership, or a public conversation), and a
 * refusal leaves no trace: no stored row, no drop record, no approval
 * request, and no DM.
 */
import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DIR, requestWake, startTypingRefresh, fanInboundMessage, backfillSession, deliver } = vi.hoisted(() => ({
  TEST_DIR: `/tmp/nanoclaw-router-quiet-${process.pid}`,
  requestWake: vi.fn(async () => true),
  startTypingRefresh: vi.fn(),
  fanInboundMessage: vi.fn(async () => 0),
  backfillSession: vi.fn(async () => undefined),
  deliver: vi.fn(async () => 'posted'),
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
  backfillSession,
}));
vi.mock('./delivery.js', () => ({ getDeliveryAdapter: () => ({ deliver }) }));

import './modules/permissions/index.js';
import type { ChannelAdapter, ChannelDefaults, InboundEvent } from './channels/adapter.js';
import { initChannelAdapters, registerChannelAdapter, teardownChannelAdapters } from './channels/channel-registry.js';
import { createAgentGroup } from './db/agent-groups.js';
import { closeDb, getDb, initSqliteTestDb } from './db/connection.js';
import { createMessagingGroup, createMessagingGroupAgent } from './db/messaging-groups.js';
import { runMigrations } from './db/migrations/index.js';
import { addMember } from './modules/permissions/db/agent-group-members.js';
import { upsertUserDm } from './modules/permissions/db/user-dms.js';
import { grantRole } from './modules/permissions/db/user-roles.js';
import { upsertUser } from './modules/permissions/db/users.js';
import { routeInbound } from './router.js';
import { resolveSession } from './session-manager.js';
import type { MessagingGroup, MessagingGroupAgent } from './types.js';

// Google Chat's declared defaults: DMs collapse to one session, a group space
// keeps a session per thread.
const DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'request_approval' },
  group: { engageMode: 'mention', threads: true, unknownSenderPolicy: 'request_approval' },
  mentions: 'platform',
};
const fixtureChannel: ChannelAdapter = {
  name: 'gchat',
  channelType: 'gchat',
  supportsThreads: true,
  defaults: DEFAULTS,
  setup: async () => undefined,
  teardown: async () => undefined,
  isConnected: () => true,
  deliver: async () => undefined,
};
registerChannelAdapter('gchat', { factory: () => fixtureChannel, defaults: DEFAULTS });

const MAIN = 'ag-main';
const JUNO = { id: 'users/1001', name: 'Juno Hale' }; // the principal
const REMY = { id: 'users/2002', name: 'Remy Vance' }; // a member of main
const KIT = { id: 'users/3003', name: 'Kit Moreau' }; // nobody main knows
const DM = 'gchat:spaces/AAAAjuno';
const DM_THREAD = `${DM}:dm`;
const ROOM = 'gchat:spaces/AAAAroom';
const ROOM_THREAD = `${ROOM}:thread-lunch`;

const now = () => new Date().toISOString();

beforeAll(async () => {
  await initChannelAdapters(() => ({
    onInbound: () => undefined,
    onInboundEvent: () => undefined,
    onMetadata: () => undefined,
    onAction: () => undefined,
  }));
});

afterAll(async () => {
  await teardownChannelAdapters();
});

beforeEach(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initSqliteTestDb());
  await createAgentGroup({ id: MAIN, name: 'main', folder: 'main', agent_provider: null, created_at: now() });

  for (const person of [JUNO, REMY, KIT]) {
    await upsertUser({ id: `gchat:${person.id}`, kind: 'gchat', display_name: person.name, created_at: now() });
  }
  await grantRole({
    user_id: `gchat:${JUNO.id}`,
    role: 'owner',
    agent_group_id: null,
    granted_by: null,
    granted_at: now(),
  });
  await addMember({ user_id: `gchat:${REMY.id}`, agent_group_id: MAIN, added_by: null, added_at: now() });

  await conversation({ id: 'mg-dm', platformId: DM, isGroup: false }, { session_mode: 'agent-shared' });
  await upsertUserDm({
    user_id: `gchat:${JUNO.id}`,
    channel_type: 'gchat',
    messaging_group_id: 'mg-dm',
    resolved_at: now(),
  });
  await conversation({ id: 'mg-room', platformId: ROOM, isGroup: true }, { engage_mode: 'mention' });

  for (const mock of [requestWake, startTypingRefresh, fanInboundMessage, backfillSession, deliver]) mock.mockClear();
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

async function conversation(
  mg: {
    id: string;
    platformId: string;
    isGroup: boolean;
    channelType?: string;
    policy?: MessagingGroup['unknown_sender_policy'];
  },
  wiring: Partial<MessagingGroupAgent> = {},
): Promise<void> {
  await createMessagingGroup({
    id: mg.id,
    channel_type: mg.channelType ?? 'gchat',
    platform_id: mg.platformId,
    instance: mg.channelType ?? 'gchat',
    name: null,
    is_group: mg.isGroup ? 1 : 0,
    unknown_sender_policy: mg.policy ?? 'request_approval',
    created_at: now(),
  });
  await createMessagingGroupAgent({
    id: `mga-${mg.id}`,
    messaging_group_id: mg.id,
    agent_group_id: MAIN,
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'known',
    ignored_message_policy: 'accumulate',
    session_mode: 'shared',
    priority: 0,
    created_at: now(),
    ...wiring,
  });
}

interface ReactionInput {
  readonly by: { id: string; name: string };
  readonly platformId: string;
  readonly threadId: string;
  /** Whose message it is on: the assistant's own wakes it, anyone else's is quiet. */
  readonly on: 'assistant' | { id: string; name: string };
  readonly name?: string;
}

/** A 👍 as the Chat bridge hands it to the router. */
function reaction({ by, platformId, threadId, on, name = `${platformId}/reactions/r1` }: ReactionInput): InboundEvent {
  const self = on === 'assistant';
  return {
    channelType: 'gchat',
    instance: 'gchat',
    platformId,
    threadId,
    message: {
      id: name,
      kind: 'chat-sdk',
      content: JSON.stringify({
        sender: by.name,
        senderId: by.id,
        senderName: by.name,
        reaction: {
          emoji: 'thumbs_up',
          target: { self, sender: self ? 'Morgan' : on.name, excerpt: "I'd book Tuesday 3pm with Juno, shall I?" },
        },
      }),
      timestamp: now(),
      isMention: false,
      isGroup: platformId === ROOM,
      authenticatedSender: { userId: by.id, displayName: by.name, kind: 'human' },
      reaction: true,
      ...(self ? {} : { quiet: true }),
      deduplicate: true,
    },
  };
}

/** A written message, as the bridge hands one over. */
function written(by: { id: string; name: string }, platformId: string, threadId: string, id: string): InboundEvent {
  return {
    channelType: 'gchat',
    instance: 'gchat',
    platformId,
    threadId,
    message: {
      id,
      kind: 'chat-sdk',
      content: JSON.stringify({ text: '@Morgan lunch at 1?', sender: by.name, senderId: by.id }),
      timestamp: now(),
      isMention: true,
      isGroup: platformId === ROOM,
      authenticatedSender: { userId: by.id, displayName: by.name, kind: 'human' },
      deduplicate: true,
    },
  };
}

interface StoredRow {
  readonly id: string;
  readonly trigger: number;
  readonly content: string;
}

async function sessions(): Promise<Array<{ id: string; messaging_group_id: string | null; thread_id: string | null }>> {
  return getDb().all('SELECT id, messaging_group_id, thread_id FROM sessions ORDER BY created_at, id');
}

function rowsOf(sessionId: string): StoredRow[] {
  const inbound = new Database(path.join(TEST_DIR, 'v2-sessions', MAIN, sessionId, 'inbound.db'), { readonly: true });
  try {
    return inbound.prepare('SELECT id, trigger, content FROM messages_in ORDER BY seq').all() as StoredRow[];
  } finally {
    inbound.close();
  }
}

async function count(table: string): Promise<number> {
  return (await getDb().get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))!.n;
}

describe("a reaction on the assistant's own message", () => {
  it("wakes main for the principal's 👍 in the DM, with the reaction as the waking row (AE4)", async () => {
    await routeInbound(reaction({ by: JUNO, platformId: DM, threadId: DM_THREAD, on: 'assistant' }));

    const [session] = await sessions();
    const rows = rowsOf(session!.id);
    expect(rows).toEqual([expect.objectContaining({ id: `${DM}/reactions/r1:${MAIN}`, trigger: 1 })]);
    expect(JSON.parse(rows[0]!.content)).toMatchObject({
      sender: JUNO.name,
      reaction: { emoji: 'thumbs_up', target: { self: true, excerpt: "I'd book Tuesday 3pm with Juno, shall I?" } },
    });
    expect(requestWake).toHaveBeenCalledTimes(1);
    // A reaction is no one's message, so the turn it wakes has no typing anchor.
    expect(startTypingRefresh).toHaveBeenCalledExactlyOnceWith(
      session!.id,
      MAIN,
      'gchat',
      DM,
      null,
      'gchat',
      undefined,
    );
  });

  it("engages a group's mention wiring as a mention would, in the thread it is in", async () => {
    await routeInbound(reaction({ by: REMY, platformId: ROOM, threadId: ROOM_THREAD, on: 'assistant' }));

    expect(await sessions()).toEqual([
      expect.objectContaining({ messaging_group_id: 'mg-room', thread_id: ROOM_THREAD }),
    ]);
    expect(requestWake).toHaveBeenCalledTimes(1);
  });
});

describe("a reaction on someone else's message (quiet)", () => {
  it("is stored with trigger=0 in the thread's existing session, and nothing wakes", async () => {
    await routeInbound(written(REMY, ROOM, ROOM_THREAD, `${ROOM}/messages/remy.1`));
    expect(requestWake).toHaveBeenCalledTimes(1);
    for (const mock of [requestWake, startTypingRefresh, fanInboundMessage, backfillSession]) mock.mockClear();

    await routeInbound(reaction({ by: JUNO, platformId: ROOM, threadId: ROOM_THREAD, on: REMY }));

    const all = await sessions();
    expect(all).toHaveLength(1);
    expect(rowsOf(all[0]!.id)).toEqual([
      expect.objectContaining({ id: `${ROOM}/messages/remy.1:${MAIN}`, trigger: 1 }),
      expect.objectContaining({ id: `${ROOM}/reactions/r1:${MAIN}`, trigger: 0 }),
    ]);
    expect(requestWake).not.toHaveBeenCalled();
    expect(startTypingRefresh).not.toHaveBeenCalled();
    expect(fanInboundMessage).not.toHaveBeenCalled();
    expect(backfillSession).not.toHaveBeenCalled();
  });

  it("finds main's shared session for the DM when an email started it", async () => {
    await conversation(
      { id: 'mg-email', platformId: 'email:principal', isGroup: false, channelType: 'email' },
      { session_mode: 'agent-shared' },
    );
    const { session: shared } = await resolveSession(MAIN, 'mg-email', null, 'agent-shared');

    await routeInbound(reaction({ by: JUNO, platformId: DM, threadId: DM_THREAD, on: JUNO }));

    expect(await sessions()).toEqual([expect.objectContaining({ id: shared.id })]);
    expect(rowsOf(shared.id)).toEqual([expect.objectContaining({ id: `${DM}/reactions/r1:${MAIN}`, trigger: 0 })]);
    expect(requestWake).not.toHaveBeenCalled();
  });

  it('is dropped where the conversation has no session yet, and creates none', async () => {
    await routeInbound(reaction({ by: JUNO, platformId: ROOM, threadId: ROOM_THREAD, on: REMY }));

    expect(await sessions()).toEqual([]);
    expect(await count('unregistered_senders')).toBe(0);
    expect(requestWake).not.toHaveBeenCalled();
  });

  it('is dropped in a thread with no session of its own, though the space has another', async () => {
    await routeInbound(written(REMY, ROOM, ROOM_THREAD, `${ROOM}/messages/remy.1`));
    const before = await sessions();

    await routeInbound(reaction({ by: JUNO, platformId: ROOM, threadId: `${ROOM}:thread-other`, on: REMY }));

    expect(await sessions()).toEqual(before);
    expect(rowsOf(before[0]!.id)).toHaveLength(1);
  });

  it('stores a redelivered quiet reaction once', async () => {
    await routeInbound(written(REMY, ROOM, ROOM_THREAD, `${ROOM}/messages/remy.1`));
    const thumbsUp = reaction({ by: JUNO, platformId: ROOM, threadId: ROOM_THREAD, on: REMY });
    await routeInbound(thumbsUp);
    await routeInbound(thumbsUp);

    const [session] = await sessions();
    expect(rowsOf(session!.id).map((row) => row.trigger)).toEqual([1, 0]);
  });
});

describe('who a reaction reaches', () => {
  it("drops a non-member's reactions without a trace: no row, drop record, approval request, or DM (AE10)", async () => {
    await routeInbound(written(REMY, ROOM, ROOM_THREAD, `${ROOM}/messages/remy.1`));
    const [session] = await sessions();
    requestWake.mockClear();

    await routeInbound(
      reaction({ by: KIT, platformId: ROOM, threadId: ROOM_THREAD, on: 'assistant', name: `${ROOM}/reactions/kit.1` }),
    );
    await routeInbound(
      reaction({ by: KIT, platformId: ROOM, threadId: ROOM_THREAD, on: REMY, name: `${ROOM}/reactions/kit.2` }),
    );

    expect(rowsOf(session!.id)).toHaveLength(1);
    expect(await sessions()).toHaveLength(1);
    expect(await count('unregistered_senders')).toBe(0);
    expect(await count('pending_sender_approvals')).toBe(0);
    expect(deliver).not.toHaveBeenCalled();
    expect(requestWake).not.toHaveBeenCalled();

    // What a written message from them still sets off, so the silence above is the quiet path's.
    await routeInbound(written(KIT, ROOM, ROOM_THREAD, `${ROOM}/messages/kit.1`));
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    expect(await count('pending_sender_approvals')).toBe(1);
  });

  it('creates no conversation and asks no channel approval for a reaction where nothing is wired', async () => {
    const unknown = 'gchat:spaces/AAAAunknown';
    await routeInbound(reaction({ by: JUNO, platformId: unknown, threadId: `${unknown}:dm`, on: 'assistant' }));

    expect(await getDb().get('SELECT id FROM messaging_groups WHERE platform_id = ?', unknown)).toBeUndefined();
    expect(await count('pending_channel_approvals')).toBe(0);
    expect(await count('unregistered_senders')).toBe(0);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("admits anyone's reaction in a public conversation, unless its wiring takes known senders only", async () => {
    const lobby = 'gchat:spaces/AAAAlobby';
    await conversation(
      { id: 'mg-lobby', platformId: lobby, isGroup: true, policy: 'public' },
      { engage_mode: 'mention', sender_scope: 'all' },
    );
    await routeInbound(reaction({ by: KIT, platformId: lobby, threadId: `${lobby}:thread-1`, on: 'assistant' }));
    expect(requestWake).toHaveBeenCalledTimes(1);

    await getDb().run("UPDATE messaging_group_agents SET sender_scope = 'known' WHERE id = 'mga-mg-lobby'");
    await routeInbound(
      reaction({
        by: KIT,
        platformId: lobby,
        threadId: `${lobby}:thread-2`,
        on: 'assistant',
        name: `${lobby}/reactions/r2`,
      }),
    );
    expect(requestWake).toHaveBeenCalledTimes(1);
    expect(await count('pending_sender_approvals')).toBe(0);
  });
});

describe('the message a woken turn works on (its typing anchor)', () => {
  it('is the written message that woke it', async () => {
    await routeInbound(written(JUNO, DM, DM_THREAD, 'spaces/AAAAjuno/messages/juno.1'));

    const [session] = await sessions();
    expect(startTypingRefresh).toHaveBeenCalledWith(
      session!.id,
      MAIN,
      'gchat',
      DM,
      null,
      'gchat',
      'spaces/AAAAjuno/messages/juno.1',
    );
  });
});
