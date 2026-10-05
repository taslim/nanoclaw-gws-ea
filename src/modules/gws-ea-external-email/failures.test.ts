/**
 * external-email's failures reach main (R38: quiet never hides a problem).
 * When delivery gives up on an email it wrote, the host gives up on what
 * arrived in its thread, or its work on a thread fails, main hears one fact
 * naming who the conversation is with and the thread, and decides what the
 * principal needs to hear.
 *
 * Drives the real core paths that report a failure (delivery, reconcile, and
 * the runner's `turn_failed` action) against a real central DB and real
 * session DBs. Only the container runner and the wake are mocked.
 */
import fs from 'node:fs';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_DIR = '/tmp/nanoclaw-test-gws-ea-external-email-failures';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-gws-ea-external-email-failures',
    GROUPS_DIR: '/tmp/nanoclaw-test-gws-ea-external-email-failures/groups',
  };
});

vi.mock('../../container-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../container-runner.js')>()),
  getContainerStartedAtMs: vi.fn(() => Date.now()),
  isContainerRunning: vi.fn(() => false),
  killContainer: vi.fn(),
  wakeContainer: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn().mockResolvedValue(true) }));

import { getDb } from '../../db/connection.js';
import { recordDeliveryAttempt } from '../../db/coordination.js';
import { closeDb, createAgentGroup, createMessagingGroup, initTestDb, runMigrations } from '../../db/index.js';
import { deliverSessionMessages, registerDeliveryAction, setDeliveryAdapter } from '../../delivery.js';
import { unguarded } from '../../guard/index.js';
import { inboundDbPath, outboundDbPath } from '../../mailbox/sqlite/paths.js';
import { reconcileSession } from '../../reconcile-session.js';
import { requestWake } from '../../request-wake.js';
import { resolveSession, writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import '../permissions/index.js';
import { upsertUserDm } from '../permissions/db/user-dms.js';
import { upsertUser } from '../permissions/db/users.js';
import '../gws-ea-profile/index.js';
import {
  addPrincipalAddress,
  bindVerifiedPrincipalUser,
  recordExternalEmailAgentGroupId,
} from '../gws-ea-profile/db.js';
import { ensureInbox, ensurePrincipalConversation } from '../gws-ea-inbox/index.js';
import { EMAIL_CHANNEL_TYPE, INBOX_PLATFORM_ID, PRINCIPAL_PLATFORM_ID } from '../gws-ea-inbox/runtime.js';
import { createThread, recordThreadAddresses } from '../gws-ea-inbox/thread-map.js';
import './index.js';

const PRINCIPAL_USER = 'gchat:users/pat';
const PAT = 'pat@northwind.example';
const JUNO = 'juno@northwind.example';
const DANA = 'dana@acme.example';
const NOEL = 'noel@acme.example';
/** Someone Dana only wrote about: not in the conversation. */
const SAM = 'sam@acme.example';
const MAX_TRIES = 5;
const EMAIL_WORDS = 'Does Tuesday at 3 work for you?';

let main: Session;
let inbox: string;
let gmailThreads = 0;

function now(): string {
  return new Date().toISOString();
}

interface Fact {
  readonly id: string;
  readonly text: string;
  readonly sender?: string;
}

/** What the host wrote in main's session, oldest first: here, only failure facts. */
function facts(): Fact[] {
  const db = new Database(inboundDbPath(main.agent_group_id, main.id), { readonly: true });
  const rows = db.prepare('SELECT id, content FROM messages_in ORDER BY seq').all() as Array<{
    id: string;
    content: string;
  }>;
  db.close();
  return rows
    .map((row) => ({ id: row.id, ...(JSON.parse(row.content) as Omit<Fact, 'id'>) }))
    .filter((row) => row.sender === 'system');
}

/** How often main was woken for something written into its session. */
function mainWakes(): number {
  return vi
    .mocked(requestWake)
    .mock.calls.filter(([session, reason]) => session.id === main.id && reason === 'inbound-message').length;
}

/**
 * A thread external-email works, and the session the router opened for it:
 * by default Dana and Noel wrote with the principal and the assistant, and
 * Dana mentioned Sam.
 */
async function emailThread(people: readonly string[] = [DANA, NOEL, PAT, JUNO]): Promise<{
  key: string;
  session: Session;
}> {
  const { threadKey } = await createThread(`gmail-thread-${++gmailThreads}`, now());
  if (people.length > 0) {
    await recordThreadAddresses(threadKey, people, 'message', now());
    await recordThreadAddresses(threadKey, [SAM], 'written', now());
  }
  const { session } = await resolveSession('ag-external', inbox, threadKey, 'per-thread');
  return { key: threadKey, session };
}

interface Route {
  readonly channelType: string;
  readonly platformId: string;
  readonly threadId: string | null;
}

/** An external-email session's own email thread. */
function threadRoute(session: Session): Route {
  return { channelType: EMAIL_CHANNEL_TYPE, platformId: INBOX_PLATFORM_ID, threadId: session.thread_id };
}

/** A row the agent queued for delivery. */
function queue(session: Session, row: { id: string; kind?: string; content: Record<string, unknown>; route: Route }) {
  const db = new Database(outboundDbPath(session.agent_group_id, session.id));
  db.prepare(
    `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, thread_id, content)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    now(),
    row.kind ?? 'chat',
    row.route.platformId,
    row.route.channelType,
    row.route.threadId,
    JSON.stringify(row.content),
  );
  db.close();
}

/** The runner's report that a turn failed, answering `route`. */
function queueTurnFailed(session: Session, id: string, route: Route): void {
  queue(session, { id, kind: 'system', content: { action: 'turn_failed', ...route }, route });
}

async function drain(session: Session, times: number): Promise<void> {
  for (let i = 0; i < times; i++) await deliverSessionMessages(session);
}

/** As if the host stopped after reporting a row and before recording it: the next pass reports it again. */
async function forgetOutcome(session: Session, id: string, attempts: number): Promise<void> {
  const inbound = new Database(inboundDbPath(session.agent_group_id, session.id));
  inbound.prepare('DELETE FROM delivered WHERE message_out_id = ?').run(id);
  inbound.close();
  for (let attempt = 0; attempt < attempts; attempt++) {
    await recordDeliveryAttempt({ messageId: id, sessionId: session.id, now: now(), nextAttemptAt: null });
  }
}

/** A message that arrived, which the dead container had claimed, on its last retry. */
function seedClaimed(session: Session, id: string, seq: number, route: Route): void {
  const inbound = new Database(inboundDbPath(session.agent_group_id, session.id));
  inbound
    .prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, tries, platform_id, channel_type, thread_id, content)
       VALUES (?, ?, 'chat', ?, 'pending', ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      seq,
      now(),
      MAX_TRIES,
      route.platformId,
      route.channelType,
      route.threadId,
      JSON.stringify({ text: EMAIL_WORDS }),
    );
  inbound.close();
  const outbound = new Database(outboundDbPath(session.agent_group_id, session.id));
  outbound
    .prepare("INSERT INTO processing_ack (message_id, status, status_changed) VALUES (?, 'processing', ?)")
    .run(id, now());
  outbound.close();
}

/** As if the host reported a give-up and never recorded it: the message is claimed again on its last retry. */
function reclaim(session: Session, id: string): void {
  const inbound = new Database(inboundDbPath(session.agent_group_id, session.id));
  inbound.prepare("UPDATE messages_in SET status = 'pending', tries = ? WHERE id = ?").run(MAX_TRIES, id);
  inbound.close();
  const outbound = new Database(outboundDbPath(session.agent_group_id, session.id));
  outbound
    .prepare(
      "INSERT INTO processing_ack (message_id, status, status_changed) VALUES (?, 'processing', ?) " +
        "ON CONFLICT (message_id) DO UPDATE SET status = 'processing', status_changed = excluded.status_changed",
    )
    .run(id, now());
  outbound.close();
}

/** An email arriving in a thread's session, as the router writes it. */
async function arrive(session: Session, id: string): Promise<void> {
  await writeSessionMessage(session.agent_group_id, session.id, {
    id,
    kind: 'chat',
    timestamp: now(),
    platformId: INBOX_PLATFORM_ID,
    channelType: EMAIL_CHANNEL_TYPE,
    threadId: session.thread_id,
    content: JSON.stringify({ text: EMAIL_WORDS }),
  });
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb());
  vi.mocked(requestWake).mockClear();
  // Every send fails: the channel is down.
  setDeliveryAdapter({
    async deliver() {
      throw new Error('Gmail is unreachable');
    },
  });

  for (const [id, name] of [
    ['ag-main', 'main'],
    ['ag-external', 'external-email'],
    ['ag-other', 'other'],
  ] as const) {
    await createAgentGroup({ id, name, folder: name, agent_provider: null, created_at: now() });
  }
  for (const [id, platformId] of [
    ['mg-dm', 'spaces/dm'],
    ['mg-other', 'spaces/other'],
  ] as const) {
    await createMessagingGroup({
      id,
      channel_type: 'gchat',
      platform_id: platformId,
      name: id,
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
  }
  await upsertUser({ id: PRINCIPAL_USER, kind: 'gchat', display_name: 'Pat', created_at: now() });
  await bindVerifiedPrincipalUser(PRINCIPAL_USER, now());
  await upsertUserDm({
    user_id: PRINCIPAL_USER,
    channel_type: 'gchat',
    messaging_group_id: 'mg-dm',
    resolved_at: now(),
  });
  await getDb().run(
    "UPDATE gws_ea_profile SET main_agent_group_id = 'ag-main', assistant_workspace_email = ? WHERE singleton = 1",
    JUNO,
  );
  await recordExternalEmailAgentGroupId('ag-external');
  await addPrincipalAddress(PAT);

  inbox = await ensureInbox('ag-external');
  main = (await resolveSession('ag-main', 'mg-dm', null, 'agent-shared')).session;
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('an email external-email wrote that delivery gave up on', () => {
  it('tells main who the email was for and which thread, once, and wakes it, with none of the email', async () => {
    const { key, session } = await emailThread();
    queue(session, { id: 'out-email', content: { text: EMAIL_WORDS }, route: threadRoute(session) });

    await drain(session, 3);

    const [fact, ...others] = facts();
    expect(others).toEqual([]);
    // Its words are all main reads: nothing typed rides beside them.
    expect(Object.keys(fact).sort()).toEqual(['id', 'sender', 'senderId', 'text']);
    expect(fact.text).toBe(
      `An email external-email wrote in the conversation with ${DANA} and ${NOEL} didn't go out, even after retrying. (thread ${key})`,
    );
    expect(mainWakes()).toBe(1);
  });

  it('adds nothing when delivery reports the same email again after a stop', async () => {
    const { session } = await emailThread();
    queue(session, { id: 'out-again', content: { text: EMAIL_WORDS }, route: threadRoute(session) });
    await drain(session, 3);
    expect(facts()).toHaveLength(1);

    await forgetOutcome(session, 'out-again', 3);
    await drain(session, 1);

    expect(facts()).toHaveLength(1);
    expect(mainWakes()).toBe(1);
  });

  it('says nothing for a failed system action or reaction: no person missed an email', async () => {
    const { session } = await emailThread();
    registerDeliveryAction(
      'test_gws_ea_external_email_explodes',
      async () => {
        throw new Error('system action failed');
      },
      unguarded('test action'),
    );
    const route = threadRoute(session);
    queue(session, {
      id: 'out-sys',
      kind: 'system',
      content: { action: 'test_gws_ea_external_email_explodes' },
      route,
    });
    queue(session, { id: 'out-reaction', content: { operation: 'reaction', messageId: 'm-1', emoji: 'ok' }, route });

    await drain(session, 3);

    expect(facts()).toEqual([]);
  });
});

describe('what arrived in a thread, given up after its last retry', () => {
  it('tells main whose conversation went unanswered and which thread, once, and wakes it; a replayed report adds nothing', async () => {
    const { key, session } = await emailThread();
    seedClaimed(session, 'in-email', 2, threadRoute(session));

    await reconcileSession(session.id);

    const [fact, ...others] = facts();
    expect(others).toEqual([]);
    expect(fact.text).toBe(
      `external-email hasn't answered something that arrived in the conversation with ${DANA} and ${NOEL}: ` +
        `it couldn't be processed, even after retrying. (thread ${key})`,
    );
    expect(mainWakes()).toBe(1);

    reclaim(session, 'in-email');
    await reconcileSession(session.id);

    expect(facts()).toHaveLength(1);
    expect(mainWakes()).toBe(1);
  });
});

describe('a failed turn in a thread', () => {
  it('tells main whose conversation may go unanswered and which thread, once, and wakes it; a replayed report adds nothing', async () => {
    const { key, session } = await emailThread();
    await arrive(session, 'in-email');
    queueTurnFailed(session, 'turn-1', threadRoute(session));

    await drain(session, 1);

    const [fact, ...others] = facts();
    expect(others).toEqual([]);
    expect(fact.text).toBe(
      `The conversation with ${DANA} and ${NOEL} may be left unanswered: ` +
        `external-email's work on it failed before it finished. (thread ${key})`,
    );
    expect(mainWakes()).toBe(1);

    await forgetOutcome(session, 'turn-1', 0);
    await drain(session, 1);

    expect(facts()).toHaveLength(1);
    expect(mainWakes()).toBe(1);
  });

  it('tells main again when its work fails on something new in the thread', async () => {
    const { session } = await emailThread();
    await arrive(session, 'in-first');
    queueTurnFailed(session, 'turn-1', threadRoute(session));
    await drain(session, 1);

    await arrive(session, 'in-second');
    queueTurnFailed(session, 'turn-2', threadRoute(session));
    await drain(session, 1);

    expect(facts()).toHaveLength(2);
    expect(mainWakes()).toBe(2);
  });

  it('names the thread by its key alone while nobody else is on it', async () => {
    const { key, session } = await emailThread([]);
    await arrive(session, 'in-email');
    queueTurnFailed(session, 'turn-1', threadRoute(session));

    await drain(session, 1);

    expect(facts().map((fact) => fact.text)).toEqual([
      `An email conversation may be left unanswered: external-email's work on it failed before it finished. (thread ${key})`,
    ]);
  });
});

describe('failures outside external-email’s threads', () => {
  it('leaves main’s own conversations and another agent’s threads to their owners', async () => {
    await ensurePrincipalConversation('ag-main');
    const { key } = await emailThread();
    const other = (await resolveSession('ag-other', 'mg-other', 'spaces/other/threads/t1', 'per-thread')).session;
    const failures: ReadonlyArray<{ readonly session: Session; readonly route: Route }> = [
      // main's one session, in the principal's direct message and in one of their email threads.
      { session: main, route: { channelType: 'gchat', platformId: 'spaces/dm', threadId: null } },
      { session: main, route: { channelType: EMAIL_CHANNEL_TYPE, platformId: PRINCIPAL_PLATFORM_ID, threadId: key } },
      { session: other, route: { channelType: 'gchat', platformId: 'spaces/other', threadId: other.thread_id } },
    ];

    for (const [i, { session, route }] of failures.entries()) {
      queue(session, { id: `out-${i}`, content: { text: EMAIL_WORDS }, route });
      queueTurnFailed(session, `turn-${i}`, route);
      await drain(session, 3);
      seedClaimed(session, `in-${i}`, 1_000 + 2 * i, route);
      await reconcileSession(session.id);
    }

    expect(facts()).toEqual([]);
  });
});
