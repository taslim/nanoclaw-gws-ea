/**
 * An inbound message the host gives up on after its last retry reaches the
 * principal as one plain sentence in their chat. Drives the real reconcile
 * against a real central DB and real session DBs; only the container runner
 * and the wake are mocked.
 */
import fs from 'fs';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-reconcile-session',
    GROUPS_DIR: '/tmp/nanoclaw-test-reconcile-session/groups',
  };
});

vi.mock('./container-runner.js', () => ({
  getContainerStartedAtMs: vi.fn(() => Date.now()),
  isContainerRunning: vi.fn(() => false),
  killContainer: vi.fn(),
  wakeContainer: vi.fn().mockResolvedValue(true),
}));

vi.mock('./request-wake.js', () => ({ requestWake: vi.fn().mockResolvedValue(true) }));

import { isContainerRunning, killContainer } from './container-runner.js';
import { closeDb, createAgentGroup, createMessagingGroup, initTestDb, runMigrations } from './db/index.js';
import { setDeliveryAdapter } from './delivery.js';
import { inboundDbPath, outboundDbPath } from './mailbox/sqlite/paths.js';
import { reconcileSession } from './reconcile-session.js';
import { resolveSession, resolveTaskSession } from './session-manager.js';
import type { Session } from './types.js';

const TEST_DIR = '/tmp/nanoclaw-test-reconcile-session';
const FAILURE_NOTICE = "Something went wrong on my side and I couldn't finish that. Please send it again.";
const MAX_TRIES = 5;

interface Sent {
  channelType: string;
  platformId: string;
  threadId: string | null;
  kind: string;
  content: string;
  instance: string | undefined;
}

let sent: Sent[];

function now(): string {
  return new Date().toISOString();
}

async function seedChatSession(): Promise<Session> {
  await createAgentGroup({ id: 'ag-1', name: 'Main', folder: 'main', agent_provider: null, created_at: now() });
  await createMessagingGroup({
    id: 'mg-1',
    channel_type: 'gchat',
    platform_id: 'gchat:spaces/dm',
    name: 'Principal',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  return (await resolveSession('ag-1', 'mg-1', null, 'shared')).session;
}

/** Where a seeded message came from; the principal's own chat by default. */
interface MessageOrigin {
  readonly kind: string;
  readonly channelType: string;
  readonly platformId: string;
  readonly threadId: string | null;
}

const PRINCIPAL_CHAT: MessageOrigin = {
  kind: 'chat-sdk',
  channelType: 'gchat',
  platformId: 'gchat:spaces/dm',
  threadId: null,
};

/** A message the dead container had claimed, on its `tries`-th retry. */
function seedClaimedMessage(
  session: Session,
  id: string,
  seq: number,
  tries: number,
  claimAgeMs = 0,
  origin: MessageOrigin = PRINCIPAL_CHAT,
): void {
  const inbound = new Database(inboundDbPath(session.agent_group_id, session.id));
  inbound
    .prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, tries, platform_id, channel_type, thread_id, content)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      seq,
      origin.kind,
      now(),
      tries,
      origin.platformId,
      origin.channelType,
      origin.threadId,
      JSON.stringify({ text: 'find me an hour on Friday' }),
    );
  inbound.close();
  const outbound = new Database(outboundDbPath(session.agent_group_id, session.id));
  outbound
    .prepare("INSERT INTO processing_ack (message_id, status, status_changed) VALUES (?, 'processing', ?)")
    .run(id, new Date(Date.now() - claimAgeMs).toISOString());
  outbound.close();
}

function inboundStatus(session: Session, id: string): { status: string; tries: number } {
  const inbound = new Database(inboundDbPath(session.agent_group_id, session.id), { readonly: true });
  const row = inbound.prepare('SELECT status, tries FROM messages_in WHERE id = ?').get(id) as {
    status: string;
    tries: number;
  };
  inbound.close();
  return row;
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = await initTestDb();
  await runMigrations(db);
  vi.mocked(isContainerRunning).mockReturnValue(false);
  vi.mocked(killContainer).mockReset();
  sent = [];
  setDeliveryAdapter({
    async deliver(channelType, platformId, threadId, kind, content, _files, instance) {
      sent.push({ channelType, platformId, threadId, kind, content, instance });
      return 'spaces/dm/messages/notice';
    },
  });
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('an inbound message failed after its last retry', () => {
  it('produces the fixed sentence in the principal’s chat once', async () => {
    const session = await seedChatSession();
    seedClaimedMessage(session, 'in-1', 2, MAX_TRIES);

    await reconcileSession(session.id);
    await reconcileSession(session.id);

    expect(inboundStatus(session, 'in-1').status).toBe('failed');
    expect(sent).toEqual([
      {
        channelType: 'gchat',
        platformId: 'gchat:spaces/dm',
        threadId: null,
        kind: 'chat',
        content: JSON.stringify({ text: FAILURE_NOTICE }),
        instance: 'gchat',
      },
    ]);
  });

  it('produces one sentence when several messages fail in the same pass', async () => {
    const session = await seedChatSession();
    seedClaimedMessage(session, 'in-1', 2, MAX_TRIES);
    seedClaimedMessage(session, 'in-2', 4, MAX_TRIES);

    await reconcileSession(session.id);

    expect(inboundStatus(session, 'in-1').status).toBe('failed');
    expect(inboundStatus(session, 'in-2').status).toBe('failed');
    expect(sent).toHaveLength(1);
  });

  it('produces the sentence when a running container is killed on its last retry', async () => {
    const session = await seedChatSession();
    vi.mocked(isContainerRunning).mockReturnValue(true);
    seedClaimedMessage(session, 'in-1', 2, MAX_TRIES, 2 * 60 * 1000);

    await reconcileSession(session.id);

    expect(killContainer).toHaveBeenCalledWith(session.id, 'claim-stuck');
    expect(inboundStatus(session, 'in-1').status).toBe('failed');
    expect(sent.map((notice) => JSON.parse(notice.content) as unknown)).toEqual([{ text: FAILURE_NOTICE }]);
  });

  it('says nothing when the failed message came from the host, not the principal', async () => {
    const session = await seedChatSession();
    seedClaimedMessage(session, 'in-note', 2, MAX_TRIES, 0, {
      kind: 'chat',
      channelType: 'agent',
      platformId: 'ag-1',
      threadId: null,
    });

    await reconcileSession(session.id);

    expect(inboundStatus(session, 'in-note').status).toBe('failed');
    expect(sent).toEqual([]);
  });

  it('answers in the thread the failed message came from', async () => {
    const session = await seedChatSession();
    seedClaimedMessage(session, 'in-thread', 2, MAX_TRIES, 0, { ...PRINCIPAL_CHAT, threadId: 'spaces/dm/threads/t1' });

    await reconcileSession(session.id);

    expect(sent.map((notice) => notice.threadId)).toEqual(['spaces/dm/threads/t1']);
  });

  it('says nothing while the message still has retries left', async () => {
    const session = await seedChatSession();
    seedClaimedMessage(session, 'in-1', 2, MAX_TRIES - 1);

    await reconcileSession(session.id);

    expect(inboundStatus(session, 'in-1')).toEqual({ status: 'pending', tries: MAX_TRIES });
    expect(sent).toEqual([]);
  });

  it('says nothing for a task session, which has no chat', async () => {
    await seedChatSession();
    const { session } = await resolveTaskSession('ag-1', 'daily-digest-a1b2');
    seedClaimedMessage(session, 'in-task', 2, MAX_TRIES);

    await reconcileSession(session.id);

    expect(inboundStatus(session, 'in-task').status).toBe('failed');
    expect(sent).toEqual([]);
  });
});
