/**
 * Router inbound-delay hook: a registered module names the time before which
 * a session must not read a routed message, and the router writes it as the
 * row's `process_after`. A delayed message does not wake the container; the
 * host sweep wakes the session once it is due.
 *
 * Exercised through the REAL routeInbound path (adapter registry + seeded
 * wiring) and the real session mailbox.
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
import { registerInboundDelay, routeInbound } from './router.js';
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
const answers = new Map<string, readonly [string | null, string | null]>();
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

async function inbound(id: string, threadId = 'testchat:C1:1'): Promise<void> {
  const event: InboundEvent = {
    channelType: 'testchat',
    platformId: 'testchat:C1',
    threadId,
    message: {
      id,
      kind: 'chat',
      content: JSON.stringify({ sender: 'Alex', text: 'hello' }),
      timestamp: now(),
      isMention: true,
      isGroup: true,
    },
  };
  await routeInbound(event);
}

/** The time the routed message's row waits for, as the session's inbound mailbox holds it. */
async function processAfterOf(id: string, threadId = 'testchat:C1:1'): Promise<string | null> {
  const session = await findSessionForAgent('ag-1', 'mg-1', threadId);
  if (!session) throw new Error('No session for the thread');
  const db = new Database(inboundDbPath(session.agent_group_id, session.id), { readonly: true });
  try {
    const row = db.prepare('SELECT process_after FROM messages_in WHERE id = ?').get(`${id}:ag-1`) as
      | { process_after: string | null }
      | undefined;
    if (!row) throw new Error(`${id} was not written`);
    return row.process_after;
  } finally {
    db.close();
  }
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
    answers.set('second', [null, sooner]);

    await inbound('both');
    await inbound('second', 'testchat:C1:2');

    expect(await processAfterOf('both')).toBe(later);
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
