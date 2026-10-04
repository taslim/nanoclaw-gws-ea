/**
 * Inbound-failed hooks: the reconcile tells registered modules about the
 * inbound messages it gave up on after their last retry. Drives the real
 * reconcile against a real central DB and real session DBs; only the
 * container runner and the wake are mocked.
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
import { log } from './log.js';
import { inboundDbPath, outboundDbPath } from './mailbox/sqlite/paths.js';
import type { MessageRetry } from './mailbox/index.js';
import { reconcileSession, registerInboundFailedHook } from './reconcile-session.js';
import { resolveSession, withExistingMailboxSession } from './session-manager.js';
import type { Session } from './types.js';

const TEST_DIR = '/tmp/nanoclaw-test-reconcile-session';
const MAX_TRIES = 5;

let sent: string[];

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

/** Each pass's report for one session, as the hook heard it. */
function listen(session: Session): Array<Array<Omit<MessageRetry, 'processAfter'>>> {
  const heard: Array<Array<Omit<MessageRetry, 'processAfter'>>> = [];
  registerInboundFailedHook((failed, s) => {
    if (s.id !== session.id) return;
    heard.push(
      failed.map(({ id, tries, kind, channelType, platformId, threadId }) => ({
        id,
        tries,
        kind,
        channelType,
        platformId,
        threadId,
      })),
    );
  });
  return heard;
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
    async deliver(_channelType, _platformId, _threadId, _kind, content) {
      sent.push(content);
      return 'spaces/dm/messages/sent';
    },
  });
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('inbound-failed hooks', () => {
  it('hear once per pass about every message given up on, with where each came from', async () => {
    const session = await seedChatSession();
    const heard = listen(session);
    seedClaimedMessage(session, 'in-1', 2, MAX_TRIES, 0, { ...PRINCIPAL_CHAT, threadId: 'spaces/dm/threads/t1' });
    seedClaimedMessage(session, 'in-note', 4, MAX_TRIES, 0, {
      kind: 'chat',
      channelType: 'agent',
      platformId: 'ag-1',
      threadId: null,
    });

    await reconcileSession(session.id);
    await reconcileSession(session.id);

    expect(inboundStatus(session, 'in-1').status).toBe('failed');
    expect(inboundStatus(session, 'in-note').status).toBe('failed');
    expect(heard).toEqual([
      [
        {
          id: 'in-1',
          tries: MAX_TRIES,
          kind: 'chat-sdk',
          channelType: 'gchat',
          platformId: 'gchat:spaces/dm',
          threadId: 'spaces/dm/threads/t1',
        },
        { id: 'in-note', tries: MAX_TRIES, kind: 'chat', channelType: 'agent', platformId: 'ag-1', threadId: null },
      ],
    ]);
  });

  it('hear about a message given up when a running container is killed on its last retry', async () => {
    const session = await seedChatSession();
    const heard = listen(session);
    vi.mocked(isContainerRunning).mockReturnValue(true);
    seedClaimedMessage(session, 'in-1', 2, MAX_TRIES, 2 * 60 * 1000);

    await reconcileSession(session.id);

    expect(killContainer).toHaveBeenCalledWith(session.id, 'claim-stuck');
    expect(heard.map((pass) => pass.map((message) => message.id))).toEqual([['in-1']]);
  });

  it('hear nothing while the message still has retries left', async () => {
    const session = await seedChatSession();
    const heard = listen(session);
    seedClaimedMessage(session, 'in-1', 2, MAX_TRIES - 1);

    await reconcileSession(session.id);

    expect(inboundStatus(session, 'in-1')).toEqual({ status: 'pending', tries: MAX_TRIES });
    expect(heard).toEqual([]);
  });

  it('run outside the mailbox session, once its work has committed', async () => {
    const session = await seedChatSession();
    const seenStatus: string[] = [];
    registerInboundFailedHook(async (failed, s) => {
      if (s.id !== session.id) return;
      // Opening the same session from inside it throws (a serialized mailbox would deadlock).
      await withExistingMailboxSession(s.agent_group_id, s.id, (mailbox) => mailbox.countDueMessages());
      for (const message of failed) seenStatus.push(inboundStatus(s, message.id).status);
    });
    seedClaimedMessage(session, 'in-1', 2, MAX_TRIES);

    await reconcileSession(session.id);

    expect(seenStatus).toEqual(['failed']);
  });

  it('a throwing hook never breaks the reconcile or the hooks after it', async () => {
    const session = await seedChatSession();
    registerInboundFailedHook((_failed, s) => {
      if (s.id === session.id) throw new Error('hook exploded');
    });
    const heard = listen(session);
    const warned = vi.spyOn(log, 'warn');
    seedClaimedMessage(session, 'in-1', 2, MAX_TRIES);

    await expect(reconcileSession(session.id)).resolves.toBeUndefined();

    expect(heard.map((pass) => pass.map((message) => message.id))).toEqual([['in-1']]);
    expect(warned).toHaveBeenCalledWith(
      'Inbound-failed hook failed',
      expect.objectContaining({ sessionId: session.id }),
    );
    warned.mockRestore();
  });

  it('sends nothing on its own: giving up is upstream behavior until a hook acts on it', async () => {
    const session = await seedChatSession();
    seedClaimedMessage(session, 'in-1', 2, MAX_TRIES);

    await reconcileSession(session.id);

    expect(inboundStatus(session, 'in-1').status).toBe('failed');
    expect(sent).toEqual([]);
  });
});
