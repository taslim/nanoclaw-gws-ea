/**
 * Failure notices in main's own conversations (R38, Slice 5 R25): the
 * principal hears of a failure only when what failed was their own message,
 * one plain sentence in their direct message; anything else in main's
 * conversations (a note from the host, a look, the morning, another agent's
 * message) reaches main as a fact that wakes nothing. A failure in
 * external-email's conversations goes to main instead (external-email.test.ts).
 *
 * Drives the real core paths that report a failure (delivery, reconcile, and
 * the runner's `turn_failed` action) with this module registered on their
 * hooks, against a real central DB and real session DBs, the runner's rows
 * written as it writes them. Only the container runner and the wake are mocked.
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
  registerSessionAdmissionPolicy: vi.fn(),
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
import { resolveSession, resolveTaskSession, writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import '../gws-ea-inbox/index.js';
import { createThread } from '../gws-ea-inbox/thread-map.js';
import { getMatter, openMatter } from '../gws-ea-matters/db.js';
import '../gws-ea-matters/index.js';
import { lookSeries, openMatterWithLook } from '../gws-ea-matters/looks.js';
import { keepMattersOnTime } from '../gws-ea-matters/loop.js';
import { liveTaskRows, mainSession, runOccurrence, seedMain } from '../gws-ea-matters/testing/main-conversation.js';
import '../gws-ea-people/index.js';
import '../gws-ea-preferences/index.js';
import { recordExternalEmailAgentGroupId } from '../gws-ea-profile/db.js';
import '../gws-ea-profile/index.js';
import { noteNames, writeNoteForMain, type NotePiece } from '../gws-ea-profile/main-note.js';
import './index.js';

const TEST_DIR = '/tmp/nanoclaw-test-gws-ea-notices';
const ZONE = 'America/New_York';
const NOTICE = "Something went wrong on my side and I couldn't finish that. Please send it again.";
const OUTAGE =
  "I can't do anything at the moment: something on my side needs fixing first, and it isn't anything you need to do. Please send this again later.";
/** Morgan Ellery's direct message with main, as `seedMain` wires it. */
const DM = { channelType: 'gchat', platformId: 'gchat:spaces/morgan' } as const;
const DM_THREAD = 'spaces/morgan/threads/t7';
const EMAIL_THREAD = { channelType: 'email', platformId: 'email:thread-1' } as const;
const NO_ROUTE = { channelType: null, platformId: null, threadId: null } as const;
const MAX_TRIES = 5;
const MORGAN = 'morgan@ellery.example';
const THREAD_JUNO = 'mail-8d1f2c34-5b6a-4e7f-9a01-23456789abcd';
const REVIEW: NotePiece = { kind: 'event', reference: `${MORGAN}/review1` };

interface Sent {
  channelType: string;
  platformId: string;
  threadId: string | null;
  kind: string;
  content: string;
  instance: string | undefined;
}

interface Route {
  readonly channelType: string | null;
  readonly platformId: string | null;
  readonly threadId: string | null;
}

let sent: Sent[];
let main: Session;
/** The notes this file's tests wrote for main themselves, as the host's modules do. */
let ownNotes: Set<string>;

function now(): string {
  return new Date().toISOString();
}

function isNotice(send: Sent): boolean {
  const { text } = JSON.parse(send.content) as { text?: unknown };
  return text === NOTICE || text === OUTAGE;
}

function notices(): Sent[] {
  return sent.filter(isNotice);
}

/** The notice as Morgan's direct message receives it. */
function noticeInDm(threadId: string | null, text: string = NOTICE): Sent {
  return { ...DM, threadId, kind: 'chat', content: JSON.stringify({ text }), instance: 'gchat' };
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

/** external-email, working one counterpart's email thread. */
async function seedExternalEmail(): Promise<Session> {
  await createAgentGroup({
    id: 'ag-external',
    name: 'external-email',
    folder: 'external-email',
    agent_provider: null,
    created_at: now(),
  });
  await createMessagingGroup({
    id: 'mg-email',
    channel_type: EMAIL_THREAD.channelType,
    platform_id: EMAIL_THREAD.platformId,
    name: 'Remy Vance',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  await recordExternalEmailAgentGroupId('ag-external');
  return (await resolveSession('ag-external', 'mg-email', null, 'shared')).session;
}

/** Morgan's own message in their direct message, as the router writes it. */
async function fromMorgan(id: string, threadId: string | null = null): Promise<string> {
  await writeSessionMessage(main.agent_group_id, main.id, {
    id,
    kind: 'chat-sdk',
    timestamp: now(),
    ...DM,
    threadId,
    content: JSON.stringify({
      text: 'Find me an hour with Juno Hale on Friday.',
      sender: 'Morgan Ellery',
      senderId: 'users/morgan',
    }),
  });
  return id;
}

/** A note for main, as every host module writes one. */
async function hostNote(id: string, text: string, pieces: readonly NotePiece[], wake = true): Promise<string> {
  await writeNoteForMain({ id, timestamp: now(), text, wake, pieces });
  ownNotes.add(id);
  return id;
}

/** A row the runner queued for delivery; bound for Morgan's direct message unless said otherwise. */
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

/** A reply main wrote to Morgan, naming the batch its turn answered, as the runner writes it. */
function reply(id: string, batch: readonly string[], threadId: string | null = null): void {
  queue(main, { id, content: { text: 'Friday at 2 works.', batch }, threadId });
}

/** The runner's report that a turn failed, naming the batch it answered. */
function turnFailed(
  session: Session,
  report: { route?: Route; batch: readonly string[]; error?: string; failure?: string },
): void {
  queue(session, {
    id: `turn-${Math.random().toString(36).slice(2)}`,
    kind: 'system',
    content: {
      action: 'turn_failed',
      ...(report.route ?? NO_ROUTE),
      ...(report.error === undefined ? {} : { error: report.error }),
      ...(report.failure === undefined ? {} : { failure: report.failure }),
      batch: report.batch,
    },
  });
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

/** The id of the one turn_failed report queued in `session`. */
function reportId(session: Session): string {
  const db = new Database(outboundDbPath(session.agent_group_id, session.id), { readonly: true });
  const row = db.prepare("SELECT id FROM messages_out WHERE kind = 'system'").get() as { id: string };
  db.close();
  return row.id;
}

/** Where a seeded inbound message came from, and what it says. */
interface Origin {
  readonly kind: string;
  readonly channelType: string;
  readonly platformId: string;
  readonly threadId: string | null;
  readonly content: Record<string, unknown>;
}

const FROM_MORGAN: Origin = {
  kind: 'chat-sdk',
  ...DM,
  threadId: null,
  content: { text: 'Find me an hour with Juno Hale on Friday.', sender: 'Morgan Ellery', senderId: 'users/morgan' },
};

/** An inbound message the dead container had claimed `claimAgeMs` ago, on its `tries`-th retry. */
function seedClaimed(
  session: Session,
  id: string,
  seq: number,
  tries: number,
  origin: Origin = FROM_MORGAN,
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
      JSON.stringify(origin.content),
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

interface Fact {
  readonly id: string;
  readonly text: string;
  readonly trigger: number;
  readonly content: string;
}

/** What this module wrote for main, oldest first: every host note but the ones the test wrote itself. */
function facts(): Fact[] {
  const db = new Database(inboundDbPath(main.agent_group_id, main.id), { readonly: true });
  const rows = db.prepare('SELECT id, trigger, content FROM messages_in ORDER BY seq').all() as Array<{
    id: string;
    trigger: number;
    content: string;
  }>;
  db.close();
  return rows.flatMap((row) => {
    const content = JSON.parse(row.content) as { text?: string; senderId?: string };
    if (content.senderId !== 'system' || ownNotes.has(row.id)) return [];
    return [{ id: row.id, text: content.text ?? '', trigger: row.trigger, content: row.content }];
  });
}

/** The one fact main has, which wakes nothing: it rides on main's next turn. */
function onlyFact(): Fact {
  const [fact, ...others] = facts();
  expect(others).toEqual([]);
  if (fact === undefined) throw new Error('main has no fact');
  expect(fact.trigger).toBe(0);
  return fact;
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb());
  vi.mocked(isContainerRunning).mockReturnValue(false);
  vi.mocked(killContainer).mockReset();
  sent = [];
  ownNotes = new Set();
  channel();
  await seedMain(ZONE);
  main = await mainSession();
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('a reply that fails permanently', () => {
  it('answering Morgan, sends them one plain sentence in the thread of their conversation, and main nothing', async () => {
    await fromMorgan('in-ask', DM_THREAD);
    reply('out-a', ['in-ask'], DM_THREAD);
    reply('out-b', ['in-ask'], DM_THREAD);
    channel((send) => !isNotice(send));

    await drain(main, 4);

    expect(notices()).toEqual([noticeInDm(DM_THREAD)]);
    // Each failed reply was still tried exactly MAX_DELIVERY_ATTEMPTS times.
    expect(sent.filter((send) => !isNotice(send))).toHaveLength(6);
    expect(facts()).toEqual([]);
  });

  it('tells Morgan once when delivery reports the same failed reply again after a stop', async () => {
    await fromMorgan('in-ask');
    reply('out-again', ['in-ask']);
    channel((send) => !isNotice(send));
    await drain(main, 3);
    expect(notices()).toHaveLength(1);

    await forgetOutcome(main, 'out-again', 3);

    await drain(main, 1);
    expect(notices()).toHaveLength(1);
    expect(sent.filter((send) => !isNotice(send))).toHaveLength(3);
  });

  it("of an unprompted reminder, tells Morgan nothing, and main, waking nothing, with the look's matter", async () => {
    const { matter } = await openMatterWithLook(
      { title: "Juno Hale's birthday", openLoop: 'Morgan wants flowers sent.', links: [] },
      { kind: 'once', at: new Date(Date.now() + 60_000).toISOString() },
    );
    if (matter.look_task_id === null) throw new Error('The matter has no look');
    reply('out-reminder', [matter.look_task_id]);
    channel((send) => !isNotice(send));

    await drain(main, 3);

    expect(notices()).toEqual([]);
    const fact = onlyFact();
    expect(fact.text).toMatch(
      new RegExp(`^A message you wrote didn't go out, even after retrying\\.\\n\\nMatter ${matter.id}, open: `, 'u'),
    );
    expect(noteNames(fact.content)).toEqual({ pieces: [], matters: [matter.id] });
  });

  it('answering Morgan’s message and a note from the host, tells each once: Morgan of theirs, main of the note', async () => {
    await fromMorgan('in-ask');
    const calendarNote = await hostNote('note-cal', 'Google Calendar reports a change.', [REVIEW], false);
    reply('out-both', [calendarNote, 'in-ask']);
    channel((send) => !isNotice(send));
    await drain(main, 3);

    await forgetOutcome(main, 'out-both', 3);
    await drain(main, 1);

    expect(notices()).toEqual([noticeInDm(null)]);
    expect(onlyFact().text).toBe(
      `A message you wrote didn't go out, even after retrying. It was about event ${REVIEW.reference}.`,
    );
  });

  it('sends nothing for an email external-email could not send: Morgan asked for nothing there', async () => {
    const external = await seedExternalEmail();
    queue(external, { id: 'out-email', content: { text: 'Does Tuesday work?' }, route: EMAIL_THREAD, threadId: 'm-1' });
    channel((send) => !isNotice(send));

    await drain(external, 3);

    expect(sent.filter((send) => send.channelType === 'email')).toHaveLength(3);
    expect(notices()).toEqual([]);
  });

  it('sends nothing for any session but main’s', async () => {
    await fromMorgan('in-ask');
    await createAgentGroup({ id: 'ag-other', name: 'other', folder: 'other', agent_provider: null, created_at: now() });
    await getDb().run("UPDATE gws_ea_profile SET main_agent_group_id = 'ag-other' WHERE singleton = 1");
    reply('out-a', ['in-ask']);
    channel((send) => !isNotice(send));

    await drain(main, 3);

    expect(notices()).toEqual([]);
  });

  it('sends nothing for a system message that fails permanently', async () => {
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
    expect(facts()).toEqual([]);
  });

  it('sends nothing when a reaction the agent placed cannot be delivered', async () => {
    await fromMorgan('in-ask');
    queue(main, {
      id: 'out-reaction',
      content: { operation: 'reaction', messageId: 'plat-1', emoji: 'thumbs_up', batch: ['in-ask'] },
    });
    channel((send) => !isNotice(send));

    await drain(main, 3);

    expect(notices()).toEqual([]);
    expect(facts()).toEqual([]);
  });

  it('sends nothing from a task session', async () => {
    const { session } = await resolveTaskSession('ag-main', 'daily-digest-a1b2');
    queue(session, { id: 'out-task', content: { text: 'digest', batch: ['daily-digest-a1b2'] } });
    channel((send) => !isNotice(send));

    await drain(session, 3);

    expect(notices()).toEqual([]);
    expect(facts()).toEqual([]);
  });

  it('sends nothing into a direct message the bot was removed from', async () => {
    await fromMorgan('in-ask');
    reply('out-a', ['in-ask']);
    await setMessagingGroupDetachedAt('mg-dm', now());

    await drain(main, 3);

    expect(sent).toEqual([]);
  });

  it('tells no one before a principal is verified', async () => {
    await fromMorgan('in-ask');
    await getDb().run('DELETE FROM gws_ea_principal_users');
    reply('out-a', ['in-ask']);
    channel((send) => !isNotice(send));

    await drain(main, 3);

    expect(notices()).toEqual([]);
    expect(facts()).toEqual([]);
  });

  it('stays best effort when the notice cannot be sent either', async () => {
    await fromMorgan('in-ask');
    reply('out-a', ['in-ask']);
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
  it('of Morgan’s, produces the sentence in their direct message once', async () => {
    seedClaimed(main, 'in-1', 2, MAX_TRIES);

    await reconcileSession(main.id);
    await reconcileSession(main.id);

    expect(inboundStatus(main, 'in-1')).toBe('failed');
    expect(sent).toEqual([noticeInDm(null)]);
    expect(facts()).toEqual([]);
  });

  it('produces one sentence when several messages fail in the same pass', async () => {
    seedClaimed(main, 'in-1', 2, MAX_TRIES);
    seedClaimed(main, 'in-2', 4, MAX_TRIES);

    await reconcileSession(main.id);

    expect(sent).toHaveLength(1);
  });

  it('produces the sentence when a running container is killed on its last retry', async () => {
    vi.mocked(isContainerRunning).mockReturnValue(true);
    seedClaimed(main, 'in-1', 2, MAX_TRIES, FROM_MORGAN, 2 * 60 * 1000);

    await reconcileSession(main.id);

    expect(killContainer).toHaveBeenCalledWith(main.id, 'claim-stuck');
    expect(sent).toEqual([noticeInDm(null)]);
  });

  it('answers in the thread of main’s own conversation the message came from', async () => {
    seedClaimed(main, 'in-thread', 2, MAX_TRIES, { ...FROM_MORGAN, threadId: DM_THREAD });

    await reconcileSession(main.id);

    expect(sent).toEqual([noticeInDm(DM_THREAD)]);
  });

  it('of Morgan’s email to the assistant, produces the sentence at the top of their direct message', async () => {
    seedClaimed(main, 'in-mail', 2, MAX_TRIES, {
      kind: 'chat',
      channelType: 'email',
      platformId: 'email:principal',
      threadId: THREAD_JUNO,
      content: { text: 'Can you move my 3pm?', sender: MORGAN },
    });

    await reconcileSession(main.id);

    expect(sent).toEqual([noticeInDm(null)]);
  });

  it('sends nothing for an email external-email could not handle, and never writes to the counterpart', async () => {
    const external = await seedExternalEmail();
    seedClaimed(external, 'in-email', 2, MAX_TRIES, {
      kind: 'chat',
      ...EMAIL_THREAD,
      threadId: 'm-1',
      content: { text: 'Does Tuesday work?', sender: 'Remy Vance' },
    });

    await reconcileSession(external.id);

    expect(inboundStatus(external, 'in-email')).toBe('failed');
    expect(sent).toEqual([]);
  });

  it('of a note from the host, tells Morgan nothing, and main, waking nothing, what the note was about', async () => {
    seedClaimed(main, 'in-note', 2, MAX_TRIES, {
      kind: 'chat',
      ...DM,
      threadId: null,
      content: { text: 'Juno Hale accepted the review.', sender: 'system', senderId: 'system', pieces: [REVIEW] },
    });
    ownNotes.add('in-note');

    await reconcileSession(main.id);

    expect(inboundStatus(main, 'in-note')).toBe('failed');
    expect(sent).toEqual([]);
    expect(onlyFact().text).toBe(
      `Something that came to you couldn't be processed, even after retrying. It was about event ${REVIEW.reference}.`,
    );
  });

  it('says nothing while the message still has retries left', async () => {
    seedClaimed(main, 'in-1', 2, MAX_TRIES - 1);

    await reconcileSession(main.id);

    expect(sent).toEqual([]);
    expect(facts()).toEqual([]);
  });

  it('says nothing for a task session', async () => {
    const { session } = await resolveTaskSession('ag-main', 'daily-digest-a1b2');
    seedClaimed(session, 'in-task', 2, MAX_TRIES);

    await reconcileSession(session.id);

    expect(inboundStatus(session, 'in-task')).toBe('failed');
    expect(sent).toEqual([]);
    expect(facts()).toEqual([]);
  });
});

describe('a failed turn the runner reports', () => {
  it.each([
    ['credentials', 'Not logged in · Please run /login', OUTAGE],
    ['billing', 'Credit balance is too low', OUTAGE],
    ['an unrecognized cause', 'API Error: 529 overloaded', NOTICE],
  ] as const)(
    'answering Morgan, for %s, tells them what a resend can do, and keeps the provider error in the host log alone',
    async (failure, error, text) => {
      await fromMorgan('in-ask', DM_THREAD);
      const warned = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
      try {
        turnFailed(main, { route: { ...DM, threadId: DM_THREAD }, batch: ['in-ask'], error, failure });

        await drain(main, 1);

        expect(sent).toEqual([noticeInDm(DM_THREAD, text)]);
        expect(sent.map((send) => send.content).join('\n')).not.toContain(error);
        expect(warned).toHaveBeenCalledWith(
          'Agent turn failed',
          expect.objectContaining({
            sessionId: main.id,
            error,
            failure: failure === 'an unrecognized cause' ? undefined : failure,
          }),
        );
        expect(facts()).toEqual([]);
      } finally {
        warned.mockRestore();
      }
    },
  );

  it('logs at most the bounded head of a long provider error', async () => {
    const warned = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    try {
      turnFailed(main, { batch: [], error: 'x'.repeat(5000) });

      await drain(main, 1);

      expect(warned).toHaveBeenCalledWith('Agent turn failed', expect.objectContaining({ error: 'x'.repeat(2000) }));
      expect(sent).toEqual([]);
    } finally {
      warned.mockRestore();
    }
  });

  it('answering Morgan, tells them once however often the report comes again', async () => {
    await fromMorgan('in-ask');
    turnFailed(main, { route: { ...DM, threadId: null }, batch: ['in-ask'] });
    await drain(main, 1);

    await forgetOutcome(main, reportId(main), 0);
    await drain(main, 1);

    expect(sent).toEqual([noticeInDm(null)]);
  });

  it('in an external-email conversation sends nothing, to Morgan or the thread (main hears instead)', async () => {
    const external = await seedExternalEmail();
    turnFailed(external, { route: { ...EMAIL_THREAD, threadId: 'm-1' }, batch: ['in-email'] });

    await drain(external, 1);

    expect(sent).toEqual([]);
  });

  it('of the morning, tells Morgan nothing, and the look it was serving comes back at the next morning (AE12)', async () => {
    const { matter } = await openMatterWithLook(
      { title: 'Acme renewal', openLoop: 'Morgan wants it signed this quarter.', links: [] },
      { kind: 'once', at: new Date(Date.now() + 60_000).toISOString() },
    );
    await keepMattersOnTime();
    const rows = liveTaskRows(main);
    const morning = rows.find((row) => row.series_id.startsWith('gws-ea-morning-'));
    const look = rows.find((row) => row.series_id === matter.look_task_id);
    if (morning === undefined || look === undefined) throw new Error('No morning or no look');
    // The runner answered both in one turn, which failed.
    await runOccurrence(main, morning.id, 'completed');
    await runOccurrence(main, look.id, 'completed');
    turnFailed(main, { batch: [morning.id, look.id], error: 'API Error: 529 overloaded' });

    await drain(main, 1);
    await keepMattersOnTime();

    expect(sent).toEqual([]);
    const handedBack = (await getMatter(matter.id))?.look_task_id ?? '';
    expect(lookSeries(handedBack)).toEqual({ matterId: matter.id, handedBack: true });
    const nextMorning = liveTaskRows(main).find((row) => row.series_id === morning.series_id)?.process_after;
    expect(liveTaskRows(main).find((row) => row.series_id === handedBack)?.process_after).toBe(nextMorning);
    expect(onlyFact().text).toBe('Your turn failed before it finished, so what it was handling may be left undone.');
  });

  it("of a repeating look, brings it back at the next morning and keeps next year's date", async () => {
    const yearly = '0 9 14 3 *';
    const { matter } = await openMatterWithLook(
      { title: "Juno Hale's birthday", openLoop: 'Remind Morgan a few days ahead.', links: [] },
      { kind: 'repeat', cron: yearly },
    );
    await keepMattersOnTime();
    const look = liveTaskRows(main).find((row) => row.series_id === matter.look_task_id);
    if (look === undefined) throw new Error('No look');
    // The runner acks a failed turn's rows as done, so the series re-arms on next year's date.
    await runOccurrence(main, look.id, 'completed');
    turnFailed(main, { batch: [look.id], error: 'API Error: 529 overloaded' });

    await drain(main, 1);
    await keepMattersOnTime();

    const morning = liveTaskRows(main).find((row) => row.series_id.startsWith('gws-ea-morning-'))?.process_after;
    const retry = liveTaskRows(main).find((row) => row.series_id === matter.look_task_id);
    expect(retry).toMatchObject({ recurrence: yearly, process_after: morning });
    expect(sent).toEqual([]);

    // Once taken, it is back on its yearly date, and a later pass leaves it there.
    await runOccurrence(main, retry?.id ?? '', 'completed');
    await keepMattersOnTime();
    expect(liveTaskRows(main).find((row) => row.series_id === matter.look_task_id)?.process_after).not.toBe(morning);
  });

  it('holding a calendar note and a waking tell_main, puts both with their matters on main’s next turn as one note, and tells Morgan nothing', async () => {
    await createThread('g-juno', now(), THREAD_JUNO);
    const renewal = (
      await openMatter({
        title: 'Acme renewal',
        openLoop: 'Morgan wants it signed this quarter.',
        links: [{ kind: 'thread', reference: THREAD_JUNO }],
      })
    ).matter;
    const review = (
      await openMatter({ title: 'Quarterly review', openLoop: 'Morgan presents the numbers.', links: [REVIEW] })
    ).matter;
    const calendarNote = await hostNote('note-cal', 'Google Calendar reports a change.', [REVIEW], false);
    const account = await hostNote('note-account', 'external-email wrote to you.', [
      { kind: 'thread', reference: THREAD_JUNO },
    ]);
    turnFailed(main, { route: { ...DM, threadId: null }, batch: [calendarNote, account], error: 'stream closed' });

    await drain(main, 1);

    expect(sent).toEqual([]);
    const fact = onlyFact();
    expect(fact.text).toMatch(
      new RegExp(
        `^Your turn failed before it finished, so what it was handling may be left undone\\. ` +
          `It was about event ${REVIEW.reference} and thread ${THREAD_JUNO}\\.\\n\\n` +
          `Matter ${review.id}, open: Quarterly review\\n[\\s\\S]*\\n\\nMatter ${renewal.id}, open: Acme renewal\\n`,
        'u',
      ),
    );
    // A turn that fails reading it names them again.
    expect(noteNames(fact.content).pieces).toEqual([REVIEW, { kind: 'thread', reference: THREAD_JUNO }]);
  });

  it('mixing Morgan’s message with a note from the host, tells Morgan once, and main of the note', async () => {
    await fromMorgan('in-ask');
    const calendarNote = await hostNote('note-cal', 'Google Calendar reports a change.', [REVIEW], false);
    turnFailed(main, { route: { ...DM, threadId: null }, batch: [calendarNote, 'in-ask'] });

    await drain(main, 1);
    await forgetOutcome(main, reportId(main), 0);
    await drain(main, 1);

    expect(sent).toEqual([noticeInDm(null)]);
    expect(onlyFact().text).toBe(
      `Your turn failed before it finished, so what it was handling may be left undone. It was about event ${REVIEW.reference}.`,
    );
  });

  it('answering another agent, tells Morgan nothing, and main that its turn failed', async () => {
    await writeSessionMessage(main.agent_group_id, main.id, {
      id: 'in-a2a',
      kind: 'chat',
      timestamp: now(),
      channelType: 'agent',
      platformId: 'ag-external',
      threadId: null,
      content: JSON.stringify({ text: 'Remy Vance asked for the deck.', sender: 'external-email' }),
    });
    turnFailed(main, { route: { channelType: 'agent', platformId: 'ag-external', threadId: null }, batch: ['in-a2a'] });

    await drain(main, 1);

    expect(sent).toEqual([]);
    expect(onlyFact().text).toBe('Your turn failed before it finished, so what it was handling may be left undone.');
  });
});
