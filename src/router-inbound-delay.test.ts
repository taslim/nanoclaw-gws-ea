/**
 * Router inbound-delay hook: a registered module names the time before which
 * a session must not read a routed message, and the router writes it as the
 * row's `process_after`. A delayed message does not wake the container; the
 * host sweep wakes the session once it is due. A module may instead hold the
 * message until it releases it: the row is written `held`, and nothing reads,
 * counts, copies or wakes for it until the release makes it due.
 *
 * Exercised through the REAL routeInbound path (adapter registry + seeded
 * wiring), the real session mailbox and the real sweep.
 */
import fs from 'fs';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  initTestDb,
  closeDb,
  runMigrations,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
} from './db/index.js';
import { findSessionForAgent } from './db/sessions.js';
import { initChannelAdapters, registerChannelAdapter, teardownChannelAdapters } from './channels/channel-registry.js';
import { inboundDbPath } from './mailbox/sqlite/paths.js';
import { settleEchoFans } from './modules/cross-session-context/index.js';
import { reconcileSession } from './reconcile-session.js';
import { HOLD_UNTIL_RELEASED, registerInboundDelay, routeInbound, type InboundDelay } from './router.js';
import { withExistingMailboxSession } from './session-manager.js';
import type { ChannelAdapter, ChannelDefaults, InboundEvent } from './channels/adapter.js';
import type { Session } from './types.js';

// Mock container runner to prevent actual Docker spawning
vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

// Override DATA_DIR for tests
vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-inbound-delay' };
});

const TEST_DIR = '/tmp/nanoclaw-test-inbound-delay';

/** What each of the two registered delays answers for a message, by its id; null when absent. */
const answers = new Map<string, readonly [InboundDelay, InboundDelay]>();
const asked: Array<{ messageId: string; session: Session }> = [];

registerInboundDelay((event, session) => {
  asked.push({ messageId: event.message.id, session });
  return answers.get(event.message.id)?.[0] ?? null;
});
registerInboundDelay(async (event) => answers.get(event.message.id)?.[1] ?? null);

function now(): string {
  return new Date().toISOString();
}

function inMinutes(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

const channelDefaults: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: true, unknownSenderPolicy: 'public' },
  group: { engageMode: 'pattern', engagePattern: '.', threads: true, unknownSenderPolicy: 'public' },
  mentions: 'platform',
};

function makeAdapter(): ChannelAdapter {
  return {
    name: 'testchat',
    channelType: 'testchat',
    supportsThreads: true,
    defaults: channelDefaults,
    setup: async () => {},
    teardown: async () => {},
    isConnected: () => true,
    deliver: async () => undefined,
  };
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb());
  answers.clear();
  asked.length = 0;
  const { wakeContainer } = await import('./container-runner.js');
  vi.mocked(wakeContainer).mockClear();

  registerChannelAdapter('testchat', { factory: () => makeAdapter(), defaults: channelDefaults });
  await initChannelAdapters(() => ({
    onInbound: () => {},
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  }));
  await createAgentGroup({
    id: 'ag-1',
    name: 'Test Agent',
    folder: 'test-agent',
    agent_provider: null,
    created_at: now(),
  });
  await createMessagingGroup({
    id: 'mg-1',
    channel_type: 'testchat',
    platform_id: 'testchat:C1',
    instance: 'testchat',
    name: 'Test Chat',
    is_group: 1,
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
    session_mode: 'per-thread',
    priority: 0,
    threads: 1,
    created_at: now(),
  });
});

afterEach(async () => {
  await teardownChannelAdapters();
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

async function inbound(id: string, threadId = 'testchat:C1:1', text = 'hello'): Promise<void> {
  const event: InboundEvent = {
    channelType: 'testchat',
    platformId: 'testchat:C1',
    threadId,
    message: {
      id,
      kind: 'chat',
      content: JSON.stringify({ sender: 'Alex', text }),
      timestamp: now(),
      isMention: true,
      isGroup: true,
    },
  };
  await routeInbound(event);
}

async function sessionOf(threadId = 'testchat:C1:1'): Promise<Session> {
  const session = await findSessionForAgent('ag-1', 'mg-1', threadId);
  if (!session) throw new Error('No session for the thread');
  return session;
}

/** What the session's inbound mailbox holds, read as the runner and the sweep would see it. */
function readInbound<T>(session: Session, read: (db: Database.Database) => T): T {
  const db = new Database(inboundDbPath(session.agent_group_id, session.id), { readonly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

/** The routed message's row: its status, the time it waits for, and whether it is a trigger. */
async function rowOf(
  id: string,
  threadId = 'testchat:C1:1',
): Promise<{ status: string; process_after: string | null; trigger: number }> {
  const row = readInbound(await sessionOf(threadId), (db) =>
    db.prepare('SELECT status, process_after, trigger FROM messages_in WHERE id = ?').get(`${id}:ag-1`),
  ) as { status: string; process_after: string | null; trigger: number } | undefined;
  if (!row) throw new Error(`${id} was not written`);
  return row;
}

/** The time the routed message's row waits for, as the session's inbound mailbox holds it. */
async function processAfterOf(id: string, threadId = 'testchat:C1:1'): Promise<string | null> {
  return (await rowOf(id, threadId)).process_after;
}

/** The text of every message copied into the thread's session from the conversation's other sessions. */
async function copiedTexts(threadId: string): Promise<string[]> {
  const rows = readInbound(await sessionOf(threadId), (db) =>
    db.prepare("SELECT content FROM messages_in WHERE channel_type = 'session-echo' ORDER BY seq").all(),
  ) as Array<{ content: string }>;
  return rows.map((row) => (JSON.parse(row.content) as { text: string }).text);
}

async function dueCount(session: Session): Promise<number | undefined> {
  return withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) => mailbox.countDueMessages());
}

async function release(session: Session, processAfter: string | null): Promise<number | undefined> {
  return withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
    mailbox.releaseHeldMessages(processAfter),
  );
}

describe('registerInboundDelay', () => {
  it('holds a message until the time a delay names, without waking the container', async () => {
    const until = inMinutes(4);
    answers.set('held', [until, null]);
    const { wakeContainer } = await import('./container-runner.js');

    await inbound('held');

    expect(await processAfterOf('held')).toBe(until);
    expect(vi.mocked(wakeContainer)).not.toHaveBeenCalled();
  });

  it('leaves a message no delay holds due now, and wakes the container for it', async () => {
    const { wakeContainer } = await import('./container-runner.js');

    await inbound('due');

    expect(await processAfterOf('due')).toBeNull();
    expect(vi.mocked(wakeContainer)).toHaveBeenCalledTimes(1);
  });

  it('waits for the latest time any delay names', async () => {
    const sooner = inMinutes(3);
    const later = inMinutes(5);
    answers.set('both', [later, sooner]);
    answers.set('reversed', [sooner, later]);
    answers.set('second', [null, sooner]);

    await inbound('both');
    await inbound('reversed', 'testchat:C1:3');
    await inbound('second', 'testchat:C1:2');

    expect(await processAfterOf('both')).toBe(later);
    expect(await processAfterOf('reversed', 'testchat:C1:3')).toBe(later);
    expect(await processAfterOf('second', 'testchat:C1:2')).toBe(sooner);
  });

  it('asks with the message and the session it resolved', async () => {
    await inbound('m1', 'testchat:C1:7');

    const session = await findSessionForAgent('ag-1', 'mg-1', 'testchat:C1:7');
    expect(asked).toEqual([
      { messageId: 'm1', session: expect.objectContaining({ id: session?.id, thread_id: 'testchat:C1:7' }) },
    ]);
  });
});

describe('holding a message until a module releases it', () => {
  it('stores a held message that nothing counts as due and nothing wakes for, the sweep included', async () => {
    answers.set('held', [HOLD_UNTIL_RELEASED, null]);
    const { wakeContainer } = await import('./container-runner.js');

    await inbound('held');
    const session = await sessionOf();
    await reconcileSession(session.id);

    expect(await rowOf('held')).toEqual({ status: 'held', process_after: null, trigger: 1 });
    expect(await dueCount(session)).toBe(0);
    expect(vi.mocked(wakeContainer)).not.toHaveBeenCalled();
  });

  it('holds a message whatever time another delay names', async () => {
    answers.set('hold-first', [HOLD_UNTIL_RELEASED, inMinutes(4)]);
    answers.set('hold-second', [inMinutes(4), HOLD_UNTIL_RELEASED]);

    await inbound('hold-first');
    await inbound('hold-second', 'testchat:C1:2');

    expect(await rowOf('hold-first')).toMatchObject({ status: 'held', process_after: null });
    expect(await rowOf('hold-second', 'testchat:C1:2')).toMatchObject({ status: 'held', process_after: null });
  });

  it('leaves a held message unread when a later message comes due in the same session and wakes it', async () => {
    answers.set('held', [HOLD_UNTIL_RELEASED, null]);
    const { wakeContainer } = await import('./container-runner.js');

    await inbound('held');
    await inbound('due');

    expect(vi.mocked(wakeContainer)).toHaveBeenCalledTimes(1);
    expect((await rowOf('held')).status).toBe('held');
    expect((await rowOf('due')).status).toBe('pending');
    expect(await dueCount(await sessionOf())).toBe(1);
  });

  it("copies a held message into none of the conversation's other sessions", async () => {
    answers.set('held', [HOLD_UNTIL_RELEASED, null]);

    await inbound('opener', 'testchat:C1:1', 'Morgan Ellery opened the conversation');
    await inbound('held', 'testchat:C1:2', 'Juno Hale asked for the contract terms');
    await inbound('seen', 'testchat:C1:3', 'Remy Vance confirmed Thursday');
    await settleEchoFans();

    // The live copy reaches the conversation's other sessions; the held message reaches none.
    expect(await copiedTexts('testchat:C1:1')).toEqual(['Remy Vance confirmed Thursday']);
    // A session born later is seeded with the conversation's openers, not with the held one.
    expect(await copiedTexts('testchat:C1:3')).toEqual(['Morgan Ellery opened the conversation']);
  });

  it('releases every message held in the session, each a trigger due at the time the release names', async () => {
    answers.set('held', [HOLD_UNTIL_RELEASED, null]);
    answers.set('also-held', [HOLD_UNTIL_RELEASED, null]);
    answers.set('held-elsewhere', [HOLD_UNTIL_RELEASED, null]);
    const { wakeContainer } = await import('./container-runner.js');
    await inbound('held');
    await inbound('also-held');
    await inbound('held-elsewhere', 'testchat:C1:2');
    const session = await sessionOf();
    const later = inMinutes(4);

    expect(await release(session, later)).toBe(2);
    await reconcileSession(session.id);

    expect(await rowOf('held')).toEqual({ status: 'pending', process_after: later, trigger: 1 });
    expect(await rowOf('also-held')).toEqual({ status: 'pending', process_after: later, trigger: 1 });
    expect((await rowOf('held-elsewhere', 'testchat:C1:2')).status).toBe('held');
    expect(
      await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) => mailbox.getWaitingMessages()),
    ).toEqual([
      { id: 'held:ag-1', tries: 0, processAfter: later },
      { id: 'also-held:ag-1', tries: 0, processAfter: later },
    ]);
    expect(vi.mocked(wakeContainer)).not.toHaveBeenCalled();
    expect(await release(session, null)).toBe(0);
  });

  it('wakes the session on the sweep once a released message is due', async () => {
    answers.set('held', [HOLD_UNTIL_RELEASED, null]);
    const { wakeContainer } = await import('./container-runner.js');
    await inbound('held');
    const session = await sessionOf();

    expect(await release(session, null)).toBe(1);
    await reconcileSession(session.id);

    expect(await rowOf('held')).toEqual({ status: 'pending', process_after: null, trigger: 1 });
    expect(vi.mocked(wakeContainer)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(wakeContainer)).toHaveBeenCalledWith(expect.objectContaining({ id: session.id }));
  });
});
