/**
 * Human pace (KTD3, R62, AE62): an outside thread is worked 3 to 6 minutes
 * after its first message not yet answered, all at once.
 *
 * Drives the real router, with pace registered as the inbox registers it,
 * the real session mailboxes and the real reconcile that wakes a session.
 * What the agent runner reads is its own due-row query, run by Bun as in the
 * container. Only the container runner and the wake are mocked, and
 * external-email's group pointer.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_DIR = '/tmp/nanoclaw-test-gws-ea-pace';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-gws-ea-pace', GROUPS_DIR: '/tmp/nanoclaw-test-gws-ea-pace/groups' };
});

vi.mock('../../container-runner.js', () => ({
  getContainerStartedAtMs: vi.fn(() => Date.now()),
  isContainerRunning: vi.fn(() => false),
  killContainer: vi.fn(),
  wakeContainer: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn().mockResolvedValue(true) }));

vi.mock('../gws-ea-external-email/index.js', () => ({
  getExternalEmailAgentGroupId: vi.fn(async () => 'ag-external'),
}));

import type { ChannelAdapter } from '../../channels/adapter.js';
import {
  initChannelAdapters,
  registerChannelAdapter,
  teardownChannelAdapters,
} from '../../channels/channel-registry.js';
import { getDb } from '../../db/connection.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { findSessionForAgent } from '../../db/sessions.js';
import { parseIsoTimestamp } from '../../mailbox/model.js';
import { inboundDbPath, outboundDbPath } from '../../mailbox/sqlite/paths.js';
import { reconcileSession } from '../../reconcile-session.js';
import { requestWake } from '../../request-wake.js';
import { routeInbound } from '../../router.js';
import { withExistingMailboxSession, writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import '../gws-ea-profile/index.js';
import { REMINDER_ID_PREFIX } from '../gws-ea-reminders/index.js';
import { EMAIL_CHANNEL_DEFAULTS, ensureInbox, ensurePrincipalConversation } from './index.js';
import { emailMessagingGroupIds } from './db.js';
import { paceDeadline } from './pace.js';
import { INBOX_PLATFORM_ID, PRINCIPAL_PLATFORM_ID } from './runtime.js';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

function now(): string {
  return new Date().toISOString();
}

/** One email row, as route-mail hands it to the host for the thread's session. */
async function mail(id: string, threadKey: string, platformId = INBOX_PLATFORM_ID): Promise<void> {
  await routeInbound({
    channelType: 'email',
    instance: 'email',
    platformId,
    threadId: threadKey,
    message: {
      id,
      kind: 'chat',
      content: JSON.stringify({ text: `Email ${id}` }),
      timestamp: now(),
      isMention: false,
      isGroup: platformId === INBOX_PLATFORM_ID,
    },
  });
}

async function threadSession(threadKey: string): Promise<Session> {
  const { inbox } = await emailMessagingGroupIds();
  const session = await findSessionForAgent('ag-external', inbox ?? '', threadKey);
  if (!session) throw new Error(`No session for ${threadKey}`);
  return session;
}

async function mainSession(): Promise<Session> {
  const { principal } = await emailMessagingGroupIds();
  const session = await findSessionForAgent('ag-main', principal ?? '', null);
  if (!session) throw new Error("No session for the principal's email");
  return session;
}

function inbound(session: Session): Database.Database {
  return new Database(inboundDbPath(session.agent_group_id, session.id));
}

/** The time a row waits for; null when it is due as written. */
function processAfter(session: Session, id: string): string | null {
  const db = inbound(session);
  try {
    const row = db.prepare('SELECT process_after FROM messages_in WHERE id = ?').get(id) as
      | { process_after: string | null }
      | undefined;
    if (!row) throw new Error(`${id} is not in the session`);
    return row.process_after;
  } finally {
    db.close();
  }
}

/** A routed email's row in its session. */
const rowId = (id: string, agentGroupId = 'ag-external') => `${id}:${agentGroupId}`;

/** A new wait: 3 to 6 minutes after a message that arrived between `before` and `after`. */
function expectFreshWait(at: string | null, before: number, after: number): void {
  expect(at).not.toBeNull();
  const ms = Date.parse(at ?? '');
  expect(ms).toBeGreaterThanOrEqual(before + 3 * MINUTE);
  expect(ms).toBeLessThanOrEqual(after + 6 * MINUTE);
}

/**
 * The clock moves on by `ms`: every waiting time comes that much closer.
 * SQLite's `now`, which decides what is due, is the real clock, so a test
 * cannot advance it.
 */
function clockMovesOn(session: Session, ms: number): void {
  const db = inbound(session);
  try {
    for (const { id, process_after } of db
      .prepare('SELECT id, process_after FROM messages_in WHERE process_after IS NOT NULL')
      .all() as Array<{ id: string; process_after: string }>) {
      db.prepare('UPDATE messages_in SET process_after = ? WHERE id = ?').run(
        new Date(Date.parse(process_after) - ms).toISOString(),
        id,
      );
    }
  } finally {
    db.close();
  }
}

/** The clock reaches the thread's wait: it moves on to a second past it. */
function reachWait(session: Session, at: string): void {
  clockMovesOn(session, Date.parse(at) - Date.now() + 1_000);
}

/** The agent answered: the host settles the rows it read as handled. */
async function answered(session: Session, ...ids: string[]): Promise<void> {
  await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
    mailbox.applyProcessingAcks(
      ids.map((messageId) => ({ messageId, status: 'completed', statusChanged: parseIsoTimestamp(now()) })),
    ),
  );
}

/** The runner claims rows for its agent's turn, as its poll loop does. */
function runnerClaims(session: Session, ...ids: string[]): void {
  const db = new Database(outboundDbPath(session.agent_group_id, session.id));
  try {
    const claim = db.prepare(
      "INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, 'processing', ?)",
    );
    for (const id of ids) claim.run(id, now());
  } finally {
    db.close();
  }
}

const RUNNER_MAILBOX = path.join(process.cwd(), 'container/agent-runner/src/mailbox/sqlite');
const RUNNER_COLUMNS =
  'id, seq, kind, timestamp, status, process_after, recurrence, series_id, tries, "trigger", platform_id, channel_type, thread_id, content, on_wake';

/**
 * The rows the agent runner's next poll hands its agent: the runner's own
 * due-row query, run by Bun as in the container, over the session's inbound
 * rows and the runner's claims.
 */
function runnerPoll(session: Session): string[] {
  const script = [
    `import { initTestSessionDb } from ${JSON.stringify(path.join(RUNNER_MAILBOX, 'connection.ts'))};`,
    `import { sqliteGetPendingMessages } from ${JSON.stringify(path.join(RUNNER_MAILBOX, 'operations.ts'))};`,
    'const { inbound, outbound } = initTestSessionDb();',
    "inbound.prepare('ATTACH DATABASE ? AS host').run(process.env.PACE_INBOUND_DB);",
    `inbound.exec('INSERT INTO messages_in (${RUNNER_COLUMNS}) SELECT ${RUNNER_COLUMNS} FROM host.messages_in');`,
    "outbound.prepare('ATTACH DATABASE ? AS host').run(process.env.PACE_OUTBOUND_DB);",
    "outbound.exec('INSERT INTO processing_ack SELECT message_id, status, status_changed FROM host.processing_ack');",
    'console.log(JSON.stringify(sqliteGetPendingMessages(false, 10).map(({ id }) => id)));',
  ].join('\n');
  const output = execFileSync('bun', ['-e', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PACE_INBOUND_DB: inboundDbPath(session.agent_group_id, session.id),
      PACE_OUTBOUND_DB: outboundDbPath(session.agent_group_id, session.id),
    },
  });
  return JSON.parse(output) as string[];
}

function wokenSessions(): string[] {
  return vi.mocked(requestWake).mock.calls.map(([session, reason]) => `${session.id}:${reason}`);
}

function emailAdapter(): ChannelAdapter {
  return {
    name: 'email',
    channelType: 'email',
    supportsThreads: true,
    defaults: EMAIL_CHANNEL_DEFAULTS,
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
  vi.mocked(requestWake).mockClear();
  for (const [id, name] of [
    ['ag-main', 'main'],
    ['ag-external', 'external-email'],
  ] as const) {
    await createAgentGroup({ id, name, folder: name, agent_provider: null, created_at: now() });
  }
  await getDb().run('UPDATE gws_ea_profile SET main_agent_group_id = ? WHERE singleton = 1', 'ag-main');
  await ensureInbox('ag-external');
  await ensurePrincipalConversation('ag-main');
  registerChannelAdapter('email', { factory: emailAdapter, defaults: EMAIL_CHANNEL_DEFAULTS });
  await initChannelAdapters(() => ({
    onInbound: () => undefined,
    onInboundEvent: () => undefined,
    onMetadata: () => undefined,
    onAction: () => undefined,
  }));
});

afterEach(async () => {
  await teardownChannelAdapters();
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('human pace', () => {
  it('gives the first message a wait of 3 to 6 minutes, which a message a minute later joins', async () => {
    const before = Date.now();
    await mail('m1', 'mail-acme');
    const after = Date.now();
    const thread = await threadSession('mail-acme');
    const wait = processAfter(thread, rowId('m1'));
    expectFreshWait(wait, before, after);

    clockMovesOn(thread, MINUTE);
    await mail('m2', 'mail-acme');

    expect(processAfter(thread, rowId('m2'))).toBe(processAfter(thread, rowId('m1')));
    expect(wokenSessions()).toEqual([]);
  });

  it('chooses each wait at random across the whole of 3 to 6 minutes', async () => {
    await mail('m1', 'mail-acme');
    const thread = await threadSession('mail-acme');
    reachWait(thread, processAfter(thread, rowId('m1')) ?? '');
    await answered(thread, rowId('m1'));

    const random = vi.spyOn(Math, 'random');
    try {
      for (const [draw, minutes] of [
        [0, 3],
        [0.999_999, 6],
      ] as const) {
        random.mockReturnValue(draw);
        const before = Date.now();
        const at = Date.parse((await paceDeadline(thread)) ?? '');
        const after = Date.now();
        expect(at).toBeGreaterThanOrEqual(before + minutes * MINUTE - 1_000);
        expect(at).toBeLessThanOrEqual(after + minutes * MINUTE);
      }
    } finally {
      random.mockRestore();
    }
  });

  it('starts a new wait once the agent has answered', async () => {
    await mail('m1', 'mail-acme');
    const thread = await threadSession('mail-acme');
    const first = processAfter(thread, rowId('m1')) ?? '';
    reachWait(thread, first);
    await answered(thread, rowId('m1'));

    const before = Date.now();
    await mail('m2', 'mail-acme');

    expectFreshWait(processAfter(thread, rowId('m2')), before, Date.now());
  });

  it('works a reply within 3 to 6 minutes while a reminder waits two days out', async () => {
    await mail('m1', 'mail-acme');
    const thread = await threadSession('mail-acme');
    reachWait(thread, processAfter(thread, rowId('m1')) ?? '');
    await answered(thread, rowId('m1'));
    await writeSessionMessage(thread.agent_group_id, thread.id, {
      id: `${REMINDER_ID_PREFIX}nudge`,
      kind: 'chat',
      timestamp: now(),
      content: JSON.stringify({ text: 'Nudge Acme once if they have not replied.' }),
      processAfter: new Date(Date.now() + 2 * DAY).toISOString(),
    });

    const before = Date.now();
    await mail('m2', 'mail-acme');

    expectFreshWait(processAfter(thread, rowId('m2')), before, Date.now());
  });

  it('gives mail a wait of its own while a retried message waits out its backoff', async () => {
    await mail('m1', 'mail-acme');
    const thread = await threadSession('mail-acme');
    reachWait(thread, processAfter(thread, rowId('m1')) ?? '');
    await withExistingMailboxSession(thread.agent_group_id, thread.id, (mailbox) =>
      mailbox.retryWithBackoff(rowId('m1'), 30),
    );

    const before = Date.now();
    await mail('m2', 'mail-acme');

    expectFreshWait(processAfter(thread, rowId('m2')), before, Date.now());
  });

  it("never delays the principal's own email, or anything else written to main", async () => {
    await mail('p1', 'mail-private', PRINCIPAL_PLATFORM_ID);
    const main = await mainSession();

    expect(processAfter(main, rowId('p1', 'ag-main'))).toBeNull();
    expect(wokenSessions()).toEqual([`${main.id}:inbound-message`]);
    expect(await paceDeadline(main)).toBeNull();
  });

  it('wakes once for a batch, which the agent reads together, and mail after the batch waits anew', async () => {
    await mail('m1', 'mail-acme');
    clockMovesOn(await threadSession('mail-acme'), MINUTE);
    await mail('m2', 'mail-acme');
    const thread = await threadSession('mail-acme');

    await reconcileSession(thread.id);
    expect(runnerPoll(thread)).toEqual([]);
    expect(wokenSessions()).toEqual([]);

    reachWait(thread, processAfter(thread, rowId('m1')) ?? '');
    await reconcileSession(thread.id);

    expect(wokenSessions()).toEqual([`${thread.id}:due-message`]);
    expect(runnerPoll(thread)).toEqual([rowId('m1'), rowId('m2')]);

    runnerClaims(thread, rowId('m1'), rowId('m2'));
    const before = Date.now();
    await mail('m3', 'mail-acme');

    expectFreshWait(processAfter(thread, rowId('m3')), before, Date.now());
    expect(runnerPoll(thread)).toEqual([]);
    expect(wokenSessions()).toEqual([`${thread.id}:due-message`]);
  });
});
