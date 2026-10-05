/**
 * Reminders (KTD8, R73): an agent comes back to its own conversation at a
 * time it chooses. Drives the real delivery actions, the real session
 * mailboxes and the real reconcile that wakes a session; only the container
 * runner and the wake are mocked.
 */
import fs from 'fs';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-gws-ea-reminders',
    GROUPS_DIR: '/tmp/nanoclaw-test-gws-ea-reminders/groups',
  };
});

vi.mock('../../container-runner.js', () => ({
  getContainerStartedAtMs: vi.fn(() => Date.now()),
  isContainerRunning: vi.fn(() => false),
  killContainer: vi.fn(),
  wakeContainer: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn().mockResolvedValue(true) }));

import type { ResponseFrame } from '../../cli/frame.js';
import { isContainerRunning } from '../../container-runner.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { closeDb, createAgentGroup, createMessagingGroup, initTestDb, runMigrations } from '../../db/index.js';
import { getSession } from '../../db/sessions.js';
import { getDeliveryAction } from '../../delivery.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import { reconcileSession } from '../../reconcile-session.js';
import { requestWake } from '../../request-wake.js';
import { resolveSession, resolveTaskSession, withExistingMailboxSession } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { isReminderId } from './index.js';

const TEST_DIR = '/tmp/nanoclaw-test-gws-ea-reminders';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function now(): string {
  return new Date().toISOString();
}

function inFuture(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

/** `main`'s one shared session, which every conversation with the principal goes through. */
async function mainSession(): Promise<Session> {
  await createAgentGroup({ id: 'ag-main', name: 'main', folder: 'main', agent_provider: null, created_at: now() });
  await createMessagingGroup({
    id: 'mg-dm',
    channel_type: 'gchat',
    platform_id: 'gchat:spaces/dm',
    name: 'Principal',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  return (await resolveSession('ag-main', 'mg-dm', null, 'agent-shared')).session;
}

/** One `external-email` session per email thread. */
async function threadSession(threadKey: string): Promise<Session> {
  if (!(await getAgentGroup('ag-ee'))) {
    await createAgentGroup({
      id: 'ag-ee',
      name: 'external-email',
      folder: 'external-email',
      agent_provider: null,
      created_at: now(),
    });
    await createMessagingGroup({
      id: 'mg-inbox',
      channel_type: 'email',
      platform_id: 'email:inbox',
      name: 'Inbox',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
  }
  return (await resolveSession('ag-ee', 'mg-inbox', threadKey, 'per-thread')).session;
}

let requests = 0;

/** Send one request as the runner's tool would, and read the host's answer from the session's mailbox. */
async function send(session: Session, action: string, fields: Record<string, unknown>): Promise<ResponseFrame> {
  const requestId = `act-test-${++requests}`;
  return replay(session, action, { ...fields, requestId });
}

/** Deliver a request exactly as given, request id included. */
async function replay(session: Session, action: string, request: Record<string, unknown>): Promise<ResponseFrame> {
  const handler = getDeliveryAction(action);
  if (!handler) throw new Error(`${action} is not a registered delivery action`);
  await handler({ ...request, action }, session);
  const answer = inbound(session)
    .prepare('SELECT content FROM messages_in WHERE id = ?')
    .get(`action-resp-${String(request.requestId)}`) as { content: string } | undefined;
  if (!answer) throw new Error(`${action} was not answered`);
  return (JSON.parse(answer.content) as { frame: ResponseFrame }).frame;
}

function remind(session: Session, at: string, note: string): Promise<ResponseFrame> {
  return send(session, 'remind_me', { at, note });
}

function reminderIdOf(frame: ResponseFrame): string {
  if (!frame.ok) throw new Error(`refused: ${frame.error.message}`);
  return (frame.data as { reminder_id: string }).reminder_id;
}

interface InboundRow {
  id: string;
  kind: string;
  timestamp: string;
  status: string;
  process_after: string | null;
  trigger: number;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  source_session_id: string | null;
  content: string;
}

const openDbs: Database.Database[] = [];

function inbound(session: Session): Database.Database {
  const db = new Database(inboundDbPath(session.agent_group_id, session.id));
  openDbs.push(db);
  return db;
}

function row(session: Session, id: string): InboundRow {
  return inbound(session).prepare('SELECT * FROM messages_in WHERE id = ?').get(id) as InboundRow;
}

function reminderIds(session: Session): string[] {
  return (inbound(session).prepare('SELECT id FROM messages_in ORDER BY seq').all() as Array<{ id: string }>)
    .map(({ id }) => id)
    .filter(isReminderId);
}

/**
 * The clock reaches a reminder: its time moves to just past. SQLite's `now`,
 * which decides what is due, is the real clock, so a test cannot advance it.
 */
function reach(session: Session, id: string): void {
  inbound(session)
    .prepare('UPDATE messages_in SET process_after = ? WHERE id = ?')
    .run(new Date(Date.now() - 1_000).toISOString(), id);
}

async function dueCount(session: Session): Promise<number> {
  return (await withExistingMailboxSession(session.agent_group_id, session.id, (m) => m.countDueMessages())) ?? 0;
}

function wokenSessions(): string[] {
  return vi.mocked(requestWake).mock.calls.map(([session, reason]) => `${session.id}:${reason}`);
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb());
  vi.mocked(isContainerRunning).mockReturnValue(false);
  vi.mocked(requestWake).mockClear();
});

afterEach(async () => {
  for (const db of openDbs.splice(0)) db.close();
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('remind_me', () => {
  it('wakes the session it was set in at its time, carrying its note', async () => {
    const thread = await threadSession('mail-remy');
    const other = await threadSession('mail-ada');
    const at = inFuture(2 * HOUR);
    const set = await remind(thread, at, 'Nudge Remy once if he has not replied.');
    const id = reminderIdOf(set);

    await reconcileSession(thread.id);
    await reconcileSession(other.id);
    expect(wokenSessions()).toEqual([]);

    reach(thread, id);
    await reconcileSession(thread.id);
    await reconcileSession(other.id);

    expect(wokenSessions()).toEqual([`${thread.id}:due-message`]);
    const reminder = row(thread, id);
    expect(reminder).toMatchObject({ kind: 'chat', status: 'pending', trigger: 1, timestamp: at });
    expect((JSON.parse(reminder.content) as { text: string }).text).toContain('Nudge Remy once if he has not replied.');
  });

  it('writes no sender identity, principal mark or route', async () => {
    const main = await mainSession();
    const reminder = row(main, reminderIdOf(await remind(main, inFuture(HOUR), 'Ask about the Lagos trip.')));

    expect(reminder).toMatchObject({
      kind: 'chat',
      platform_id: null,
      channel_type: null,
      thread_id: null,
      source_session_id: null,
    });
    const content = JSON.parse(reminder.content) as Record<string, unknown>;
    // The text and how it reads; nothing that names a person, a verified sender or the principal.
    expect(Object.keys(content).sort()).toEqual(['sender', 'text']);
    // Never the host's own voice: the note is the agent's, possibly drawn from an email.
    expect(content.sender).not.toBe('system');
  });

  it('refuses a time more than 30 days ahead, one already past, or one without its offset', async () => {
    const main = await mainSession();

    expect(await remind(main, inFuture(30 * DAY + HOUR), 'Too far.')).toMatchObject({
      ok: false,
      error: { code: 'invalid-args', message: expect.stringContaining('30 days') },
    });
    expect(await remind(main, inFuture(-HOUR), 'Too late.')).toMatchObject({
      ok: false,
      error: { code: 'invalid-args', message: expect.stringContaining('future') },
    });
    expect(await remind(main, '2026-12-01T09:00', 'Whose 9am?')).toMatchObject({
      ok: false,
      error: { code: 'invalid-args', message: expect.stringContaining('offset') },
    });
    expect(reminderIds(main)).toEqual([]);

    expect(await remind(main, inFuture(30 * DAY - HOUR), 'Just in range.')).toMatchObject({ ok: true });
    expect(reminderIds(main)).toHaveLength(1);
  });

  it('survives the session going idle in between', async () => {
    const thread = await threadSession('mail-remy');
    vi.mocked(isContainerRunning).mockReturnValue(true);
    const id = reminderIdOf(await remind(thread, inFuture(2 * DAY), 'Nudge Remy once.'));

    // The container exits, and the sweep passes over the idle session.
    vi.mocked(isContainerRunning).mockReturnValue(false);
    for (let pass = 0; pass < 3; pass++) await reconcileSession(thread.id);
    expect(await getSession(thread.id)).toMatchObject({ status: 'active' });
    expect(row(thread, id).status).toBe('pending');
    expect(wokenSessions()).toEqual([]);

    reach(thread, id);
    await reconcileSession(thread.id);
    expect(wokenSessions()).toEqual([`${thread.id}:due-message`]);
  });

  it('sets a replayed request once, with the same answer', async () => {
    const main = await mainSession();
    const request = { requestId: 'act-replayed', at: inFuture(HOUR), note: 'Check the deck went out.' };

    const first = await replay(main, 'remind_me', request);
    // The host stopped before it answered, so the replay's own answer is the one read.
    inbound(main).prepare('DELETE FROM messages_in WHERE id = ?').run(`action-resp-${request.requestId}`);
    const second = await replay(main, 'remind_me', request);

    expect(second).toEqual(first);
    expect(reminderIds(main)).toEqual([reminderIdOf(first)]);
  });

  it('refuses a scheduled task run, which has no conversation to come back to', async () => {
    await mainSession();
    const { session: task } = await resolveTaskSession('ag-main', 'daily-brief');

    expect(await remind(task, inFuture(HOUR), 'Never comes back.')).toMatchObject({
      ok: false,
      error: { code: 'forbidden' },
    });
    expect(reminderIds(task)).toEqual([]);
  });
});

describe('clear_reminder', () => {
  it("keeps several in main's session, and clearing one leaves the others to fire", async () => {
    const main = await mainSession();
    const lagos = reminderIdOf(await remind(main, inFuture(HOUR), 'Ask about the Lagos trip.'));
    const deck = reminderIdOf(await remind(main, inFuture(2 * HOUR), 'Check the deck went out.'));
    const visa = reminderIdOf(await remind(main, inFuture(3 * HOUR), 'Chase the visa letter.'));

    expect(await send(main, 'clear_reminder', { reminder_id: deck })).toMatchObject({ ok: true });
    for (const id of [lagos, deck, visa]) reach(main, id);

    expect(await dueCount(main)).toBe(2);
    expect(row(main, deck).status).not.toBe('pending');
    await reconcileSession(main.id);
    expect(wokenSessions()).toEqual([`${main.id}:due-message`]);
    // One that has come due is the agent's to read, not to clear.
    expect(await send(main, 'clear_reminder', { reminder_id: lagos })).toMatchObject({
      ok: false,
      error: { code: 'invalid-args', message: expect.stringContaining('come due') },
    });
  });

  it("refuses another session's reminder, which still fires", async () => {
    const remy = await threadSession('mail-remy');
    const ada = await threadSession('mail-ada');
    const id = reminderIdOf(await remind(remy, inFuture(HOUR), 'Nudge Remy once.'));

    expect(await send(ada, 'clear_reminder', { reminder_id: id })).toMatchObject({
      ok: false,
      error: { code: 'invalid-args' },
    });

    reach(remy, id);
    expect(await dueCount(remy)).toBe(1);
  });
});
