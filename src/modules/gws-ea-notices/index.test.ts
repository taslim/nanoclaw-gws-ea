/**
 * Failure notices reach only the principal, in their direct message (R38),
 * and only for main's own conversations: a failure in external-email's is
 * the external-email module's to report to main.
 *
 * Drives the real core paths that report a failure (delivery, reconcile, and
 * the runner's `turn_failed` action) with this module registered on their
 * hooks, against a real central DB and real session DBs. Only the container
 * runner and the wake are mocked.
 */
import fs from 'fs';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-gws-ea-notices',
    GROUPS_DIR: '/tmp/nanoclaw-test-gws-ea-notices/groups',
  };
});

vi.mock('../../container-runner.js', () => ({
  getContainerStartedAtMs: vi.fn(() => Date.now()),
  isContainerRunning: vi.fn(() => false),
  killContainer: vi.fn(),
  wakeContainer: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn().mockResolvedValue(true) }));

import { isContainerRunning, killContainer } from '../../container-runner.js';
import { getDb } from '../../db/connection.js';
import { recordDeliveryAttempt } from '../../db/coordination.js';
import { closeDb, createAgentGroup, createMessagingGroup, initTestDb, runMigrations } from '../../db/index.js';
import { setMessagingGroupDetachedAt } from '../../db/messaging-groups.js';
import { deliverSessionMessages, registerDeliveryAction, setDeliveryAdapter } from '../../delivery.js';
import { unguarded } from '../../guard/index.js';
import { log } from '../../log.js';
import { inboundDbPath, outboundDbPath } from '../../mailbox/sqlite/paths.js';
import { reconcileSession } from '../../reconcile-session.js';
import { resolveSession, resolveTaskSession } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { bindVerifiedPrincipalUser, recordExternalEmailAgentGroupId } from '../gws-ea-profile/db.js';
import { upsertUserDm } from '../permissions/db/user-dms.js';
import { upsertUser } from '../permissions/db/users.js';
import '../gws-ea-profile/index.js';
import { registerTurnFailedHook } from './index.js';

const TEST_DIR = '/tmp/nanoclaw-test-gws-ea-notices';
const NOTICE = "Something went wrong on my side and I couldn't finish that. Please send it again.";
const PRINCIPAL = 'gchat:users/principal';
const DM = { channelType: 'gchat', platformId: 'gchat:spaces/dm' } as const;
const EMAIL_THREAD = { channelType: 'email', platformId: 'email:thread-1' } as const;
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

/** Every failed turn the notices module handed on: another module's to report. */
const handedOn: Array<{ sessionId: string; threadId: string | null }> = [];
registerTurnFailedHook('gws-ea-notices-test:record', async (route, session) => {
  handedOn.push({ sessionId: session.id, threadId: route.threadId });
});

function now(): string {
  return new Date().toISOString();
}

function isNotice(send: Sent): boolean {
  return (JSON.parse(send.content) as { text?: unknown }).text === NOTICE;
}

function notices(): Sent[] {
  return sent.filter(isNotice);
}

/** The notice as the principal's direct message receives it. */
function noticeInDm(threadId: string | null): Sent {
  return { ...DM, threadId, kind: 'chat', content: JSON.stringify({ text: NOTICE }), instance: 'gchat' };
}

/** The channel: records every send and rejects the ones `fails` picks. */
function channel(fails: (send: Sent) => boolean = () => false): void {
  setDeliveryAdapter({
    async deliver(channelType, platformId, threadId, kind, content, _files, instance) {
      const send = { channelType, platformId, threadId, kind, content, instance };
      sent.push(send);
      if (fails(send)) throw new Error('message too long');
      return 'platform-message';
    },
  });
}

/** Main, wired to the principal's verified direct message, and external-email on one counterpart's thread. */
async function seedAssistant(): Promise<{ main: Session; external: Session }> {
  for (const [id, name] of [
    ['ag-main', 'main'],
    ['ag-external', 'external-email'],
  ] as const) {
    await createAgentGroup({ id, name, folder: name, agent_provider: null, created_at: now() });
  }
  await createMessagingGroup({
    id: 'mg-dm',
    channel_type: DM.channelType,
    platform_id: DM.platformId,
    name: 'Principal',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
  await createMessagingGroup({
    id: 'mg-email',
    channel_type: EMAIL_THREAD.channelType,
    platform_id: EMAIL_THREAD.platformId,
    name: 'Sam',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  await upsertUser({ id: PRINCIPAL, kind: 'gchat', display_name: 'Pat', created_at: now() });
  await bindVerifiedPrincipalUser(PRINCIPAL, now());
  await upsertUserDm({ user_id: PRINCIPAL, channel_type: 'gchat', messaging_group_id: 'mg-dm', resolved_at: now() });
  await getDb().run("UPDATE gws_ea_profile SET main_agent_group_id = 'ag-main' WHERE singleton = 1");
  await recordExternalEmailAgentGroupId('ag-external');
  return {
    main: (await resolveSession('ag-main', 'mg-dm', null, 'shared')).session,
    external: (await resolveSession('ag-external', 'mg-email', null, 'shared')).session,
  };
}

/** A row the agent queued for delivery; bound for the principal's direct message unless said otherwise. */
function queue(
  session: Session,
  row: {
    id: string;
    kind?: string;
    content: Record<string, unknown>;
    route?: { channelType: string; platformId: string };
    threadId?: string | null;
  },
): void {
  const route = row.route ?? DM;
  const db = new Database(outboundDbPath(session.agent_group_id, session.id));
  db.prepare(
    `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, thread_id, content)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    now(),
    row.kind ?? 'chat',
    route.platformId,
    route.channelType,
    row.threadId ?? null,
    JSON.stringify(row.content),
  );
  db.close();
}

async function drain(session: Session, times: number): Promise<void> {
  for (let i = 0; i < times; i++) await deliverSessionMessages(session);
}

/** Where a seeded inbound message came from; the principal's direct message by default. */
interface Origin {
  readonly kind: string;
  readonly channelType: string;
  readonly platformId: string;
  readonly threadId: string | null;
}

const FROM_PRINCIPAL: Origin = { kind: 'chat-sdk', ...DM, threadId: null };

/** An inbound message the dead container had claimed `claimAgeMs` ago, on its `tries`-th retry. */
function seedClaimed(
  session: Session,
  id: string,
  seq: number,
  tries: number,
  origin: Origin = FROM_PRINCIPAL,
  claimAgeMs = 0,
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

function inboundStatus(session: Session, id: string): string {
  const inbound = new Database(inboundDbPath(session.agent_group_id, session.id), { readonly: true });
  const row = inbound.prepare('SELECT status FROM messages_in WHERE id = ?').get(id) as { status: string };
  inbound.close();
  return row.status;
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb());
  vi.mocked(isContainerRunning).mockReturnValue(false);
  vi.mocked(killContainer).mockReset();
  sent = [];
  handedOn.length = 0;
  channel();
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('a reply that fails permanently', () => {
  it('sends the principal one plain sentence, in the thread of main’s own conversation', async () => {
    const { main } = await seedAssistant();
    queue(main, { id: 'out-a', content: { text: 'A' }, threadId: 'spaces/dm/threads/t7' });
    queue(main, { id: 'out-b', content: { text: 'B' }, threadId: 'spaces/dm/threads/t7' });
    channel((send) => !isNotice(send));

    await drain(main, 4);

    expect(notices()).toEqual([noticeInDm('spaces/dm/threads/t7')]);
    // Each failed reply was still tried exactly MAX_DELIVERY_ATTEMPTS times.
    expect(sent.filter((send) => !isNotice(send))).toHaveLength(6);
  });

  it('tells the principal once when delivery reports the same failed reply again after a stop', async () => {
    const { main } = await seedAssistant();
    queue(main, { id: 'out-again', content: { text: 'A' } });
    channel((send) => !isNotice(send));
    await drain(main, 3);
    expect(notices()).toHaveLength(1);

    // The host stopped after the report and before recording the failure: the next pass reports it again.
    const inbound = new Database(inboundDbPath(main.agent_group_id, main.id));
    inbound.prepare('DELETE FROM delivered WHERE message_out_id = ?').run('out-again');
    inbound.close();
    for (let attempt = 0; attempt < 3; attempt++) {
      await recordDeliveryAttempt({ messageId: 'out-again', sessionId: main.id, now: now(), nextAttemptAt: null });
    }

    await drain(main, 1);
    expect(notices()).toHaveLength(1);
    expect(sent.filter((send) => !isNotice(send))).toHaveLength(3);
  });

  it('sends nothing for an email external-email could not send: the principal asked for nothing there', async () => {
    const { external } = await seedAssistant();
    queue(external, { id: 'out-email', content: { text: 'Does Tuesday work?' }, route: EMAIL_THREAD, threadId: 'm-1' });
    channel((send) => !isNotice(send));

    await drain(external, 3);

    expect(sent.filter((send) => send.channelType === 'email')).toHaveLength(3);
    expect(notices()).toEqual([]);
  });

  it('sends nothing for any session but main’s', async () => {
    const { main } = await seedAssistant();
    await getDb().run("UPDATE gws_ea_profile SET main_agent_group_id = 'ag-external' WHERE singleton = 1");
    queue(main, { id: 'out-a', content: { text: 'A' } });
    channel((send) => !isNotice(send));

    await drain(main, 3);

    expect(notices()).toEqual([]);
  });

  it('sends nothing for a system message that fails permanently', async () => {
    const { main } = await seedAssistant();
    registerDeliveryAction(
      'test_gws_ea_notice_explodes',
      async () => {
        throw new Error('system action failed');
      },
      unguarded('test action'),
    );
    queue(main, { id: 'out-sys', kind: 'system', content: { action: 'test_gws_ea_notice_explodes' } });

    await drain(main, 3);

    expect(sent).toEqual([]);
  });

  it('sends nothing when a reaction the agent placed cannot be delivered', async () => {
    const { main } = await seedAssistant();
    queue(main, { id: 'out-reaction', content: { operation: 'reaction', messageId: 'plat-1', emoji: 'thumbs_up' } });
    channel((send) => !isNotice(send));

    await drain(main, 3);

    expect(notices()).toEqual([]);
  });

  it('sends nothing from a task session', async () => {
    await seedAssistant();
    const { session } = await resolveTaskSession('ag-main', 'daily-digest-a1b2');
    queue(session, { id: 'out-task', content: { text: 'digest' } });
    channel((send) => !isNotice(send));

    await drain(session, 3);

    expect(notices()).toEqual([]);
  });

  it('sends nothing into a direct message the bot was removed from', async () => {
    const { main } = await seedAssistant();
    queue(main, { id: 'out-a', content: { text: 'A' } });
    await setMessagingGroupDetachedAt('mg-dm', now());

    await drain(main, 3);

    expect(sent).toEqual([]);
  });

  it('tells no one before a principal is verified', async () => {
    const { main } = await seedAssistant();
    await getDb().run('DELETE FROM gws_ea_principal_users');
    queue(main, { id: 'out-a', content: { text: 'A' } });
    channel((send) => !isNotice(send));

    await drain(main, 3);

    expect(notices()).toEqual([]);
  });

  it('stays best effort when the notice cannot be sent either', async () => {
    const { main } = await seedAssistant();
    queue(main, { id: 'out-a', content: { text: 'A' } });
    channel(() => true);
    const logged = vi.spyOn(log, 'error').mockImplementation(() => undefined);

    try {
      await expect(drain(main, 4)).resolves.toBeUndefined();

      expect(notices()).toHaveLength(1);
      expect(logged).toHaveBeenCalledWith(
        'Failure notice could not be delivered',
        expect.objectContaining({ sessionId: main.id, cause: 'delivery-failed' }),
      );
    } finally {
      logged.mockRestore();
    }
  });
});

describe('an inbound message given up after its last retry', () => {
  it('produces the sentence in the principal’s direct message once', async () => {
    const { main } = await seedAssistant();
    seedClaimed(main, 'in-1', 2, MAX_TRIES);

    await reconcileSession(main.id);
    await reconcileSession(main.id);

    expect(inboundStatus(main, 'in-1')).toBe('failed');
    expect(sent).toEqual([noticeInDm(null)]);
  });

  it('produces one sentence when several messages fail in the same pass', async () => {
    const { main } = await seedAssistant();
    seedClaimed(main, 'in-1', 2, MAX_TRIES);
    seedClaimed(main, 'in-2', 4, MAX_TRIES);

    await reconcileSession(main.id);

    expect(sent).toHaveLength(1);
  });

  it('produces the sentence when a running container is killed on its last retry', async () => {
    const { main } = await seedAssistant();
    vi.mocked(isContainerRunning).mockReturnValue(true);
    seedClaimed(main, 'in-1', 2, MAX_TRIES, FROM_PRINCIPAL, 2 * 60 * 1000);

    await reconcileSession(main.id);

    expect(killContainer).toHaveBeenCalledWith(main.id, 'claim-stuck');
    expect(sent).toEqual([noticeInDm(null)]);
  });

  it('answers in the thread of main’s own conversation the message came from', async () => {
    const { main } = await seedAssistant();
    seedClaimed(main, 'in-thread', 2, MAX_TRIES, { ...FROM_PRINCIPAL, threadId: 'spaces/dm/threads/t1' });

    await reconcileSession(main.id);

    expect(sent).toEqual([noticeInDm('spaces/dm/threads/t1')]);
  });

  it('sends nothing for an email external-email could not handle, and never writes to the counterpart', async () => {
    const { external } = await seedAssistant();
    seedClaimed(external, 'in-email', 2, MAX_TRIES, { kind: 'chat-sdk', ...EMAIL_THREAD, threadId: 'm-1' });

    await reconcileSession(external.id);

    expect(inboundStatus(external, 'in-email')).toBe('failed');
    expect(sent).toEqual([]);
  });

  it('says nothing when the message came from the host, not a person', async () => {
    const { main } = await seedAssistant();
    seedClaimed(main, 'in-note', 2, MAX_TRIES, {
      kind: 'chat',
      channelType: 'agent',
      platformId: 'ag-main',
      threadId: null,
    });

    await reconcileSession(main.id);

    expect(inboundStatus(main, 'in-note')).toBe('failed');
    expect(sent).toEqual([]);
  });

  it('says nothing while the message still has retries left', async () => {
    const { main } = await seedAssistant();
    seedClaimed(main, 'in-1', 2, MAX_TRIES - 1);

    await reconcileSession(main.id);

    expect(sent).toEqual([]);
  });

  it('says nothing for a task session', async () => {
    await seedAssistant();
    const { session } = await resolveTaskSession('ag-main', 'daily-digest-a1b2');
    seedClaimed(session, 'in-task', 2, MAX_TRIES);

    await reconcileSession(session.id);

    expect(inboundStatus(session, 'in-task')).toBe('failed');
    expect(sent).toEqual([]);
  });
});

describe('a failed turn the runner reports', () => {
  function reportTurnFailed(
    session: Session,
    route: { channelType: string | null; platformId: string | null; threadId: string | null },
  ): void {
    queue(session, {
      id: `turn-${Math.random().toString(36).slice(2)}`,
      kind: 'system',
      content: { action: 'turn_failed', ...route },
    });
  }

  it('produces the sentence in the thread of main’s own conversation, and hands nothing on', async () => {
    const { main } = await seedAssistant();
    reportTurnFailed(main, { ...DM, threadId: 'spaces/dm/threads/t1' });

    await drain(main, 1);

    expect(sent).toEqual([noticeInDm('spaces/dm/threads/t1')]);
    expect(handedOn).toEqual([]);
  });

  it('in an external-email thread sends nothing, to the principal or the thread, and hands it to its owner', async () => {
    const { external } = await seedAssistant();
    reportTurnFailed(external, { ...EMAIL_THREAD, threadId: 'm-1' });

    await drain(external, 1);

    expect(sent).toEqual([]);
    expect(handedOn).toEqual([{ sessionId: external.id, threadId: 'm-1' }]);
  });

  it('hands on a failed turn even when one owner’s hook fails', async () => {
    const { external } = await seedAssistant();
    const logged = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    registerTurnFailedHook('gws-ea-notices-test:explodes', async () => {
      throw new Error('owner failed');
    });
    try {
      reportTurnFailed(external, { ...EMAIL_THREAD, threadId: 'm-2' });

      await drain(external, 1);

      expect(handedOn).toEqual([{ sessionId: external.id, threadId: 'm-2' }]);
      expect(logged).toHaveBeenCalledWith(
        'Turn-failed hook failed',
        expect.objectContaining({ hookId: 'gws-ea-notices-test:explodes' }),
      );
    } finally {
      logged.mockRestore();
    }
  });

  it('refuses a second hook under the same id', () => {
    expect(() => registerTurnFailedHook('gws-ea-notices-test:record', async () => undefined)).toThrow(/already/);
  });

  it('says nothing for a turn another agent or the host started', async () => {
    const { main } = await seedAssistant();
    reportTurnFailed(main, { channelType: 'agent', platformId: 'ag-external', threadId: null });

    await drain(main, 1);

    expect(sent).toEqual([]);
  });

  it('says nothing for a report without a route', async () => {
    const { main } = await seedAssistant();
    reportTurnFailed(main, { channelType: null, platformId: null, threadId: null });

    await drain(main, 1);

    expect(sent).toEqual([]);
  });
});
