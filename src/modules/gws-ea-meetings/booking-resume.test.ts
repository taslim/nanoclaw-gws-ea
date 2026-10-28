import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const ROOT = vi.hoisted(() => `/tmp/booking-resume-${process.pid}`);
vi.mock('../../config.js', async (original) => ({
  ...(await original<typeof import('../../config.js')>()),
  DATA_DIR: ROOT,
}));
vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn(async () => true) }));

import '../gws-ea-inbox/index.js';
import '../gws-ea-preferences/index.js';
import { sessionDir } from '../../session-manager.js';
import * as sessionMessages from '../../session-manager.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import { getDb } from '../../db/connection.js';
import { ensureContainerConfig, updateContainerConfigScalars } from '../../db/container-configs.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { resolveSession } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { addPrincipalAddress, recordExternalEmailAgentGroupId } from '../gws-ea-profile/db.js';
import { replacePrincipalCalendars } from '../gws-ea-inbox/db.js';
import { createThread, recordThreadAddresses } from '../gws-ea-inbox/thread-map.js';
import { cleanChatDelivery, seedChatDelivery } from '../gws-ea-chats/testing/chat-delivery-fixture.js';
import { setChatMemberEmail } from '../gws-ea-chats/roster.js';
import { setChatCalendar } from '../gws-ea-chats/handoffs.js';
import { FakeCalendar } from './testing/fake-calendar.js';
import { setThreadBookingCalendar } from './thread-calendar.js';
import { createBookingTools } from './booking.js';
import * as bookingStorage from './bookings-db.js';
import * as calendarModule from './calendar-api.js';
import { getHostStartCallbacks, getHostShutdownCallbacks } from '../../host-lifecycle.js';
import { requestWake } from '../../request-wake.js';
import type { ResponseFrame } from '../../cli/frame.js';
import { bookingsMigration } from './bookings-migration.js';
import { getBooking, getBookingRequest } from './bookings-db.js';
import { chatBookingRequestsMigration } from './chat-booking-migration.js';
import { chatBookingReportsMigration } from './chat-booking-report-migration.js';
import * as mainNotesModule from '../gws-ea-profile/main-note.js';
import { GoogleNotSignedInError } from '../gws-ea-google/tokens.js';
import { ANSWER_LATER, writeActionResponse } from '../../cli/delivery-action.js';

const PRINCIPAL = 'juno@example.com';
const ASSISTANT = 'avery@example.com';
const MIRA = 'mira@example.com';
const TEAM = 'visits@group.calendar.google.com';
const BOOK = { start: '2026-10-20T12:00:00Z', minutes: 30, title: 'Venue visit' };
const LATER = '2026-10-21T12:00:00Z';
let calendar: FakeCalendar;
let thread: string;
let chat: string;
let emailSession: Session;
let chatSession: Session;
let reads: ReturnType<typeof createBookingTools>;

beforeEach(async () => {
  vi.mocked(requestWake).mockClear();
  vi.useFakeTimers({ now: new Date('2026-10-18T12:00:00Z'), toFake: ['Date'] });
  const seeded = await seedChatDelivery();
  for (const migration of [chatBookingRequestsMigration, chatBookingReportsMigration, bookingsMigration]) {
    if (migration.sqliteOnly) throw new Error('Expected portable migration');
    await migration.up(getDb());
  }
  chatSession = seeded.session;
  chat = chatSession.messaging_group_id ?? '';
  await createAgentGroup({
    id: 'email',
    name: 'email',
    folder: 'email',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  await createMessagingGroup({
    id: 'mail',
    channel_type: 'email',
    platform_id: 'mail',
    name: 'Mail',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: new Date().toISOString(),
  });
  await recordExternalEmailAgentGroupId('email');
  await addPrincipalAddress(PRINCIPAL);
  await getDb().run('UPDATE gws_ea_profile SET assistant_workspace_email=? WHERE singleton=1', ASSISTANT);
  await replacePrincipalCalendars([PRINCIPAL], new Date().toISOString());
  ({ threadKey: thread } = await createThread(null, new Date().toISOString()));
  await recordThreadAddresses(thread, [PRINCIPAL, ASSISTANT, MIRA], 'message', new Date().toISOString());
  emailSession = (await resolveSession('email', 'mail', thread, 'per-thread')).session;
  await setThreadBookingCalendar(thread, TEAM);
  await setChatCalendar(chat, TEAM);
  await setChatMemberEmail(chat, 'whatsapp:22', MIRA, 'main');
  await setChatMemberEmail(chat, 'whatsapp:11', PRINCIPAL, 'main');
  calendar = new FakeCalendar();
  calendar.calendars.set(PRINCIPAL, { id: PRINCIPAL, accessRole: 'writer' });
  calendar.calendars.set(TEAM, {
    id: TEAM,
    dataOwner: PRINCIPAL,
    accessRole: 'writer',
    conferenceTypes: ['hangoutsMeet'],
  });
  reads = createBookingTools({ calendar: () => calendar });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await cleanChatDelivery(ROOT);
});

async function mainSession(): Promise<Session> {
  const now = new Date().toISOString();
  await ensureContainerConfig('main');
  await updateContainerConfigScalars('main', { timezone: 'Europe/Paris' });
  await getDb().run("INSERT INTO users(id,kind,display_name,created_at) VALUES('gchat:juno','gchat','Juno',?)", now);
  await getDb().run("INSERT INTO gws_ea_principal_users(user_id,verified_at) VALUES('gchat:juno',?)", now);
  await createMessagingGroup({
    id: 'principal-dm',
    channel_type: 'gchat',
    platform_id: 'spaces/juno',
    name: 'Juno',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now,
  });
  await getDb().run(
    "INSERT INTO user_dms(user_id,channel_type,messaging_group_id,resolved_at) VALUES('gchat:juno','gchat','principal-dm',?)",
    now,
  );
  return (await resolveSession('main', 'principal-dm', null, 'agent-shared')).session;
}
function notesIn(session: Session): string[] {
  const db = new Database(inboundDbPath(session.agent_group_id, session.id), { readonly: true });
  try {
    return (
      db.prepare("SELECT content FROM messages_in WHERE id LIKE 'gws-ea-booking-%'").all() as { content: string }[]
    ).map((row) => row.content);
  } finally {
    db.close();
  }
}
function answerData(answer: Awaited<ReturnType<typeof reads.book>>): Record<string, unknown> {
  if (answer === ANSWER_LATER) throw new Error('The booking still awaits settlement');
  return answer;
}
async function booked(session = chatSession): Promise<string> {
  return String(answerData(await reads.book(BOOK, session, 'initial')).booking);
}

interface InboundRow {
  id: string;
  content: string;
  seq: number;
  trigger: number;
}
function messagesIn(session: Session): InboundRow[] {
  const db = new Database(inboundDbPath(session.agent_group_id, session.id), { readonly: true });
  try {
    return db.prepare('SELECT id,content,seq,trigger FROM messages_in ORDER BY seq').all() as InboundRow[];
  } finally {
    db.close();
  }
}
function responseIn(session: Session, requestId: string): ResponseFrame | undefined {
  const row = messagesIn(session).find((message) => message.id === `action-resp-${requestId}`);
  return row ? (JSON.parse(row.content) as { frame: ResponseFrame }).frame : undefined;
}
it('resumes a lost thread insert, reports main and answers the waiting tool without another invitation', async () => {
  const main = await mainSession();
  calendar.failNext({ op: 'insert', error: new Error('Google answer lost'), afterApplying: true });
  expect(await reads.book(BOOK, emailSession, 'lost-thread')).toBe(ANSWER_LATER);
  await reads.resumePending();
  expect(responseIn(emailSession, 'lost-thread')).toMatchObject({ ok: true, data: { booking: calendar.live()[0].id } });
  expect(notesIn(main)).toHaveLength(1);
  expect(calendar.writes.map((write) => write.op)).toEqual(['insert']);
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function holdLiveBooking() {
  const entered = deferred<void>();
  const release = deferred<void>();
  const get = calendar.getCalendar.bind(calendar);
  vi.spyOn(calendar, 'getCalendar').mockImplementationOnce(async (...args) => {
    entered.resolve();
    await release.promise;
    return get(...args);
  });
  const done = expect(reads.book({ ...BOOK, minutes: 1 }, chatSession, 'queue-holder')).rejects.toThrow(
    'minutes must be a whole number from 5 to 480',
  );
  await entered.promise;
  return { release, done };
}
function bookingWakes(session: Session) {
  return vi.mocked(requestWake).mock.calls.filter(([target]) => target.id === session.id);
}
function wakeMessages(session: Session) {
  return messagesIn(session).filter((message) => message.id.startsWith('gws-ea-booking-answer-'));
}
async function pendingBook(session: Session, id: string, applied = true, start = BOOK.start) {
  calendar.failNext({ op: 'insert', error: new Error('Google answer lost'), afterApplying: applied });
  expect(await reads.book({ ...BOOK, start }, session, id)).toBe(ANSWER_LATER);
  const row = await getBookingRequest(session.id, id);
  if (!row) throw new Error('No durable booking request');
  return row;
}

it('reports an already-applied request after a crash without reading Google and then removes its details', async () => {
  const main = await mainSession();
  const write = mainNotesModule.writeNoteForMain;
  vi.spyOn(mainNotesModule, 'writeNoteForMain')
    .mockRejectedValueOnce(new Error('Host interrupted'))
    .mockImplementation(write);
  expect(await reads.book(BOOK, emailSession, 'applied-before-crash')).toBe(ANSWER_LATER);
  expect(await getBookingRequest(emailSession.id, 'applied-before-crash')).toMatchObject({
    applied: true,
    reported: false,
  });
  calendar.failure = new Error('Google unavailable');
  vi.setSystemTime(Date.now() + 120_001);
  await reads.resumePending();
  expect(responseIn(emailSession, 'applied-before-crash')).toMatchObject({ ok: true });
  expect(notesIn(main)[0]).toContain('Booked a meeting with mira@example.com');
  expect(await getBookingRequest(emailSession.id, 'applied-before-crash')).toBeUndefined();
  const response = messagesIn(emailSession).find((message) => message.id === 'action-resp-applied-before-crash');
  const wakes = wakeMessages(emailSession);
  expect(wakes).toHaveLength(1);
  expect(wakes[0]).toMatchObject({ trigger: 1 });
  expect(wakes[0].content).toContain('Booking request applied-before-crash: Booked:');
  expect(response?.seq).toBeLessThan(wakes[0].seq);
  expect(bookingWakes(emailSession)).toHaveLength(1);
  await reads.resumePending();
  expect(wakeMessages(emailSession)).toHaveLength(1);
  expect(bookingWakes(emailSession)).toHaveLength(1);
});

it('answers a resumed request within the tool wait without waking the session', async () => {
  await mainSession();
  await pendingBook(emailSession, 'still-waiting');
  vi.setSystemTime(Date.now() + 119_999);
  await reads.resumePending();
  expect(responseIn(emailSession, 'still-waiting')).toMatchObject({ ok: true });
  expect(wakeMessages(emailSession)).toEqual([]);
  expect(bookingWakes(emailSession)).toEqual([]);
});

it('settles an insert that landed then was removed, answering the refusal without restoring it', async () => {
  const main = await mainSession();
  const row = await pendingBook(emailSession, 'removed-after-insert');
  const event = calendar.event(TEAM, row.eventId);
  if (!event) throw new Error('No event');
  calendar.put({ ...event, status: 'cancelled' });
  vi.setSystemTime(Date.now() + 120_001);
  await reads.resumePending();
  expect(responseIn(emailSession, row.requestId)).toMatchObject({
    ok: false,
    error: { code: 'forbidden', message: expect.stringContaining('no longer on the calendar') },
  });
  expect(notesIn(main)[0]).toContain('Booked a meeting with mira@example.com');
  expect(notesIn(main)[0]).toContain('then it was removed');
  expect(calendar.live()).toEqual([]);
  expect(calendar.writes.map((write) => write.op)).toEqual(['insert']);
  expect(wakeMessages(emailSession)[0].content).toContain('no longer on the calendar');
  expect(await getBookingRequest(emailSession.id, row.requestId)).toBeUndefined();
});

it.each([true, false])('settles a purged thread’s request by read-back only (Google applied: %s)', async (applied) => {
  const main = await mainSession();
  const row = await pendingBook(emailSession, 'forgotten-thread', applied);
  await getDb().run('DELETE FROM sessions WHERE id=?', emailSession.id);
  fs.rmSync(sessionDir(emailSession.agent_group_id, emailSession.id), { recursive: true });
  await reads.resumePending();
  expect(notesIn(main)[0]).toContain(
    applied ? 'Booked a meeting with mira@example.com' : 'pending booking request was not carried out',
  );
  expect(calendar.live()).toHaveLength(applied ? 1 : 0);
  expect(calendar.writes).toHaveLength(applied ? 1 : 0);
  expect(await getBookingRequest(emailSession.id, row.requestId)).toBeUndefined();
  expect(fs.existsSync(sessionDir(emailSession.agent_group_id, emailSession.id))).toBe(false);
  expect(bookingWakes(emailSession)).toEqual([]);
});

it.each(['closed', 'foreign-thread', 'foreign-agent', 'new-chat-owner'] as const)(
  'makes no new write for an obsolete %s session',
  async (state) => {
    const main = await mainSession();
    const session = state === 'new-chat-owner' ? chatSession : emailSession;
    const row = await pendingBook(session, 'obsolete', false);
    if (state === 'closed') await getDb().run("UPDATE sessions SET status='closed' WHERE id=?", session.id);
    if (state === 'foreign-thread')
      await getDb().run("UPDATE sessions SET thread_id='another-thread' WHERE id=?", session.id);
    if (state === 'foreign-agent')
      await getDb().run("UPDATE sessions SET agent_group_id='peer' WHERE id=?", session.id);
    if (state === 'new-chat-owner')
      await getDb().run("UPDATE gws_ea_chats SET serving_agent_group_id='peer' WHERE messaging_group_id=?", chat);
    vi.setSystemTime(Date.now() + 120_001);
    await reads.resumePending();
    expect(calendar.writes).toEqual([]);
    expect(notesIn(main)[0]).toContain('pending booking request was not carried out');
    expect(await getBookingRequest(session.id, row.requestId)).toBeUndefined();
    if (state === 'closed') expect(bookingWakes(session)).toEqual([]);
  },
);

it.each([new Error('Read connection interrupted'), new GoogleNotSignedInError('Sign-in stopped')])(
  'isolates a failed read and retries that row next sweep (%s)',
  async (error) => {
    const main = await mainSession();
    await pendingBook(emailSession, 'first-read-fails');
    vi.setSystemTime(Date.now() + 1);
    await pendingBook(chatSession, 'second-can-finish', true, LATER);
    vi.spyOn(calendar, 'getEvent').mockRejectedValueOnce(error);
    await reads.resumePending();
    expect(responseIn(emailSession, 'first-read-fails')).toBeUndefined();
    expect(await getBookingRequest(emailSession.id, 'first-read-fails')).toMatchObject({ applied: false });
    expect(responseIn(chatSession, 'second-can-finish')).toMatchObject({ ok: true });
    expect(notesIn(main)).toHaveLength(1);
    await reads.resumePending();
    expect(responseIn(emailSession, 'first-read-fails')).toMatchObject({ ok: true });
    expect(await bookingStorage.listPendingBookingRequests()).toEqual([]);
    expect(notesIn(main)).toHaveLength(2);
    expect(calendar.writes.map((write) => write.op)).toEqual(['insert', 'insert']);
  },
);

it('retains a replay when its availability read finds the Google connection down', async () => {
  await mainSession();
  await pendingBook(emailSession, 'read-during-recheck', false);
  vi.spyOn(calendar, 'listEvents').mockRejectedValueOnce(new GoogleNotSignedInError('Sign-in stopped'));
  await reads.resumePending();
  expect(await getBookingRequest(emailSession.id, 'read-during-recheck')).toMatchObject({ applied: false });
  expect(responseIn(emailSession, 'read-during-recheck')).toBeUndefined();
  await reads.resumePending();
  expect(responseIn(emailSession, 'read-during-recheck')).toMatchObject({ ok: true });
  expect(calendar.writes.map((write) => write.op)).toEqual(['insert']);
});

it('serializes chat recovery with a live write to the same chat without deadlock', async () => {
  await mainSession();
  await pendingBook(chatSession, 'resumed-chat');
  const entered = deferred<void>();
  const release = deferred<void>();
  const get = calendar.getEvent.bind(calendar);
  vi.spyOn(calendar, 'getEvent').mockImplementationOnce(async (...args) => {
    entered.resolve();
    await release.promise;
    return get(...args);
  });
  const recovering = reads.resumePending();
  await entered.promise;
  const live = reads.book({ ...BOOK, start: LATER }, chatSession, 'live-chat');
  expect(calendar.live()).toHaveLength(1);
  release.resolve();
  await recovering;
  expect(answerData(await live).message).toContain('Booked:');
  expect(responseIn(chatSession, 'resumed-chat')).toMatchObject({ ok: true });
  expect(calendar.live()).toHaveLength(2);
  expect(calendar.writes.map((write) => write.op)).toEqual(['insert', 'insert']);
});

it('reports a carried-over applied book without reading Google or replaying it', async () => {
  const main = await mainSession();
  const result = answerData(await reads.book(BOOK, chatSession, 'legacy-book'));
  await getDb().run(
    'UPDATE gws_ea_booking_requests SET carried_over=1,reported=0,request_json=?,result_json=? WHERE session_id=? AND request_id=?',
    JSON.stringify(BOOK),
    JSON.stringify(result),
    chatSession.id,
    'legacy-book',
  );
  calendar.failure = new Error('Google down');
  await reads.resumePending();
  expect(responseIn(chatSession, 'legacy-book')).toMatchObject({ ok: true, data: result });
  expect(notesIn(main)).toHaveLength(1);
  expect(await getBookingRequest(chatSession.id, 'legacy-book')).toBeUndefined();
  expect(calendar.writes.map((write) => write.op)).toEqual(['insert']);
});

it('keeps a carried-over change without a version unconfirmed through a reporting retry', async () => {
  const main = await mainSession();
  const id = await booked();
  calendar.failNext({ op: 'patch', error: new Error('Lost answer') });
  expect(await reads.changeBooking({ booking: id, start: LATER }, chatSession, 'legacy-change')).toBe(ANSWER_LATER);
  await getDb().run(
    'UPDATE gws_ea_booking_requests SET carried_over=1,event_etag=NULL,request_mark=NULL,request_json=? WHERE session_id=? AND request_id=?',
    JSON.stringify({ booking: id, start: LATER }),
    chatSession.id,
    'legacy-change',
  );
  const write = mainNotesModule.writeNoteForMain;
  vi.spyOn(mainNotesModule, 'writeNoteForMain')
    .mockRejectedValueOnce(new Error('Main unavailable'))
    .mockImplementation(write);
  await reads.resumePending();
  expect(await getBookingRequest(chatSession.id, 'legacy-change')).toMatchObject({ applied: true, reported: false });
  expect(responseIn(chatSession, 'legacy-change')).toBeUndefined();
  await reads.resumePending();
  expect(responseIn(chatSession, 'legacy-change')).toMatchObject({
    ok: true,
    data: { message: expect.stringContaining('may or may not have gone through') },
  });
  expect(notesIn(main)[1]).toContain('may or may not have gone through');
  expect(calendar.writes.map((write) => write.op)).toEqual(['insert']);
  expect(calendar.event(TEAM, id)?.start?.dateTime).toBe('2026-10-20T12:00:00.000Z');
});

it('cleans a stale booking entry before retrying an already-applied cancellation’s main note', async () => {
  const main = await mainSession();
  const id = await booked();
  const write = mainNotesModule.writeNoteForMain;
  vi.spyOn(mainNotesModule, 'writeNoteForMain').mockRejectedValue(new Error('Main unavailable'));
  expect(await reads.cancelBooking({ booking: id }, chatSession, 'applied-cancel')).toBe(ANSWER_LATER);
  await bookingStorage.recordBooking({
    owner: { kind: 'chat', key: chat },
    calendarId: TEAM,
    eventId: id,
    bookedAt: new Date().toISOString(),
  });
  await reads.resumePending();
  expect(await getBooking({ kind: 'chat', key: chat }, id)).toBeUndefined();
  expect(await getBookingRequest(chatSession.id, 'applied-cancel')).toMatchObject({ applied: true, reported: false });
  expect(responseIn(chatSession, 'applied-cancel')).toBeUndefined();
  vi.mocked(mainNotesModule.writeNoteForMain).mockImplementation(write);
  await reads.resumePending();
  expect(responseIn(chatSession, 'applied-cancel')).toMatchObject({
    ok: true,
    data: { message: expect.stringContaining('Cancelled:') },
  });
  expect(notesIn(main)[1]).toContain('Cancelled the meeting');
  expect(calendar.writes.map((write) => write.op)).toEqual(['insert', 'delete']);
  expect(await getBookingRequest(chatSession.id, 'applied-cancel')).toBeUndefined();
});

it('skips a durable request still owned by its live handler', async () => {
  await mainSession();
  const entered = deferred<void>();
  const release = deferred<void>();
  const insert = calendar.insertEvent.bind(calendar);
  vi.spyOn(calendar, 'insertEvent').mockImplementationOnce(async (...args) => {
    const result = await insert(...args);
    entered.resolve();
    await release.promise;
    return result;
  });
  const live = reads.book(BOOK, emailSession, 'still-live');
  await entered.promise;
  await reads.resumePending();
  expect(responseIn(emailSession, 'still-live')).toBeUndefined();
  expect(await getBookingRequest(emailSession.id, 'still-live')).toMatchObject({ applied: false });
  release.resolve();
  expect(answerData(await live).message).toContain('Booked:');
  expect(calendar.writes.map((write) => write.op)).toEqual(['insert']);
});

it('keeps a duplicate live handler owned until its last sibling finishes', async () => {
  await mainSession();
  const entered = deferred<void>();
  const release = deferred<void>();
  const insert = calendar.insertEvent.bind(calendar);
  vi.spyOn(calendar, 'insertEvent').mockImplementationOnce(async (...args) => {
    const result = await insert(...args);
    entered.resolve();
    await release.promise;
    return result;
  });
  const first = reads.book(BOOK, emailSession, 'duplicate-live');
  await entered.promise;
  const second = reads.book(BOOK, emailSession, 'duplicate-live');
  const secondEntered = deferred<void>();
  const secondRelease = deferred<void>();
  const get = bookingStorage.getBookingRequest;
  vi.spyOn(bookingStorage, 'getBookingRequest').mockImplementation(async (...args) => {
    const row = await get(...args);
    if (row?.requestId === 'duplicate-live' && row.reported) {
      secondEntered.resolve();
      await secondRelease.promise;
    }
    return row;
  });
  release.resolve();
  await first;
  await secondEntered.promise;
  try {
    await reads.resumePending();
    expect(responseIn(emailSession, 'duplicate-live')).toBeUndefined();
  } finally {
    secondRelease.resolve();
  }
  await second;
  expect(calendar.writes.map((write) => write.op)).toEqual(['insert']);
  expect(await getBookingRequest(emailSession.id, 'duplicate-live')).toMatchObject({ applied: true, reported: true });
});

it('re-reads the request after waiting for the scheduling turn and leaves a completed request alone', async () => {
  const main = await mainSession();
  const row = await pendingBook(emailSession, 'already-finished');
  const blocker = await holdLiveBooking();
  const listed = deferred<void>();
  const list = bookingStorage.listPendingBookingRequests;
  vi.spyOn(bookingStorage, 'listPendingBookingRequests').mockImplementationOnce(async () => {
    const rows = await list();
    listed.resolve();
    return rows;
  });
  const recovery = reads.resumePending();
  await listed.promise;
  await bookingStorage.deleteBookingRequest(row.sessionId, row.requestId);
  blocker.release.resolve();
  await blocker.done;
  await recovery;
  expect(notesIn(main)).toEqual([]);
  expect(await getBooking({ kind: 'thread', key: thread }, row.eventId)).toBeUndefined();
  expect(responseIn(emailSession, row.requestId)).toBeUndefined();
  expect(calendar.writes.map((write) => write.op)).toEqual(['insert']);
});

it('measures a live late answer from entry before the scheduling queue and publishes its answer before one wake', async () => {
  await mainSession();
  const blocker = await holdLiveBooking();
  const startedAt = new Date().toISOString();
  const live = reads.book(BOOK, emailSession, 'queued-late');
  vi.setSystemTime(Date.now() + 120_001);
  blocker.release.resolve();
  await blocker.done;
  const result = answerData(await live);
  expect(await getBookingRequest(emailSession.id, 'queued-late')).toMatchObject({
    createdAt: startedAt,
    reported: true,
  });
  expect(responseIn(emailSession, 'queued-late')).toMatchObject({ ok: true, data: result });
  expect(wakeMessages(emailSession)).toHaveLength(1);
  expect(wakeMessages(emailSession)[0].content).toBe(`Booking request queued-late: ${String(result.message)}`);
  const response = messagesIn(emailSession).find((message) => message.id === 'action-resp-queued-late');
  expect(response?.seq).toBeLessThan(wakeMessages(emailSession)[0].seq);
  expect(bookingWakes(emailSession)).toHaveLength(1);
  await reads.resumePending();
  expect(await getBookingRequest(emailSession.id, 'queued-late')).toBeUndefined();
  expect(bookingWakes(emailSession)).toHaveLength(1);
});

it.each([true, false])(
  'wakes a quick live replay whose original request’s tool wait has elapsed (still on calendar: %s)',
  async (present) => {
    await mainSession();
    const row = await pendingBook(emailSession, 'late-live-replay');
    if (!present) {
      const event = calendar.event(TEAM, row.eventId);
      if (!event) throw new Error('No event');
      calendar.put({ ...event, status: 'cancelled' });
    }
    vi.setSystemTime(Date.now() + 120_001);
    const replay = reads.book(BOOK, emailSession, 'late-live-replay');
    if (present) expect(answerData(await replay).message).toContain('Booked:');
    else await expect(replay).rejects.toThrow('no longer on the calendar');
    expect(responseIn(emailSession, row.requestId)).toMatchObject({ ok: present });
    expect(wakeMessages(emailSession)).toHaveLength(1);
    expect(wakeMessages(emailSession)[0].content).toContain(present ? 'Booked:' : 'no longer on the calendar');
    expect(bookingWakes(emailSession)).toHaveLength(1);
    expect(calendar.writes.map((entry) => entry.op)).toEqual(['insert']);
  },
);

it('cleans an answered row and staged files without turning an early answer into a later wake', async () => {
  await mainSession();
  const result = answerData(await reads.book(BOOK, emailSession, 'answered'));
  await writeActionResponse(emailSession, 'answered', { id: 'answered', ok: true, data: result });
  const outbox = path.join(sessionDir(emailSession.agent_group_id, emailSession.id), 'outbox', 'answered');
  fs.mkdirSync(outbox, { recursive: true });
  fs.writeFileSync(path.join(outbox, 'staged.txt'), 'Invitation attachment');
  vi.setSystemTime(Date.now() + 120_001);
  await reads.resumePending();
  expect(await getBookingRequest(emailSession.id, 'answered')).toBeUndefined();
  expect(fs.existsSync(outbox)).toBe(false);
  expect(wakeMessages(emailSession)).toEqual([]);
  expect(bookingWakes(emailSession)).toEqual([]);
  expect(calendar.writes.map((write) => write.op)).toEqual(['insert']);
});

it('never replays an unanswered operation once its mailbox already contains an answer, but still reports main', async () => {
  const main = await mainSession();
  await pendingBook(emailSession, 'answered-before-recovery', false);
  await writeActionResponse(emailSession, 'answered-before-recovery', {
    id: 'answered-before-recovery',
    ok: false,
    error: { code: 'forbidden', message: 'The original request was refused.' },
  });
  await reads.resumePending();
  expect(responseIn(emailSession, 'answered-before-recovery')).toMatchObject({
    ok: false,
    error: { message: 'The original request was refused.' },
  });
  expect(calendar.writes).toEqual([]);
  expect(notesIn(main)[0]).toContain('pending booking request was not carried out');
  expect(await getBookingRequest(emailSession.id, 'answered-before-recovery')).toBeUndefined();
});

it('delivers a late live refusal before its wake and preserves the refusal frame', async () => {
  await mainSession();
  const blocker = await holdLiveBooking();
  const live = reads.cancelBooking({ booking: 'a'.repeat(64) }, emailSession, 'late-refusal');
  vi.setSystemTime(Date.now() + 120_001);
  blocker.release.resolve();
  await blocker.done;
  await expect(live).rejects.toThrow('There is no such booking for this thread');
  expect(responseIn(emailSession, 'late-refusal')).toMatchObject({ ok: false, error: { code: 'forbidden' } });
  expect(wakeMessages(emailSession)[0].content).toContain('There is no such booking for this thread');
  expect(bookingWakes(emailSession)).toHaveLength(1);
});

it('retries a failed wake-message write after the response was published without losing the answer', async () => {
  await mainSession();
  await pendingBook(emailSession, 'late-partial-delivery');
  vi.setSystemTime(Date.now() + 120_001);
  const write = sessionMessages.writeSessionMessage;
  let refuseWake = true;
  vi.spyOn(sessionMessages, 'writeSessionMessage').mockImplementation(async (...args) => {
    if (args[2].id.startsWith('gws-ea-booking-answer-') && refuseWake) {
      refuseWake = false;
      throw new Error('Mailbox writer unavailable');
    }
    return write(...args);
  });
  await reads.resumePending();
  expect(responseIn(emailSession, 'late-partial-delivery')).toMatchObject({ ok: true });
  expect(await getBookingRequest(emailSession.id, 'late-partial-delivery')).toMatchObject({
    applied: true,
    reported: true,
  });
  expect(wakeMessages(emailSession)).toEqual([]);
  await reads.resumePending();
  expect(wakeMessages(emailSession)).toHaveLength(1);
  expect(bookingWakes(emailSession)).toHaveLength(1);
  expect(await getBookingRequest(emailSession.id, 'late-partial-delivery')).toBeUndefined();
  expect(calendar.writes.map((entry) => entry.op)).toEqual(['insert']);
});

it('puts the mailbox’s actual late answer in the wake even when read-back settles differently', async () => {
  await mainSession();
  await pendingBook(emailSession, 'actual-answer', false);
  vi.setSystemTime(Date.now() + 120_001);
  await writeActionResponse(emailSession, 'actual-answer', {
    id: 'actual-answer',
    ok: false,
    error: { code: 'forbidden', message: 'The original answer.' },
  });
  await reads.resumePending();
  expect(wakeMessages(emailSession)[0].content).toBe('Booking request actual-answer: The original answer.');
  expect(calendar.writes).toEqual([]);
});

it('starts recovery without blocking host startup, serializes 60-second sweeps and awaits shutdown', async () => {
  await mainSession();
  await pendingBook(emailSession, 'startup-outage');
  const entered = deferred<void>();
  const release = deferred<void>();
  const get = calendar.getEvent.bind(calendar);
  const getEvent = vi
    .spyOn(calendar, 'getEvent')
    .mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      throw new GoogleNotSignedInError('Google unreachable');
    })
    .mockImplementation(get);
  vi.spyOn(calendarModule, 'createMeetingsCalendarApi').mockReturnValue(calendar);
  const beforeStart = getHostStartCallbacks().length;
  const beforeStop = getHostShutdownCallbacks().length;
  await import('./index.js');
  const start = getHostStartCallbacks()[beforeStart];
  const stop = getHostShutdownCallbacks()[beforeStop];
  if (!start || !stop) throw new Error('No meetings lifecycle callbacks');
  vi.useFakeTimers();
  try {
    await expect(
      Promise.resolve(
        start({
          db: getDb(),
          signal: new AbortController().signal,
          deliveryAdapter: { deliver: async () => undefined },
        }),
      ),
    ).resolves.toBeUndefined();
    await entered.promise;
    await vi.advanceTimersByTimeAsync(180_000);
    expect(getEvent).toHaveBeenCalledTimes(1);
    release.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(await getBookingRequest(emailSession.id, 'startup-outage')).toBeDefined();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(responseIn(emailSession, 'startup-outage')).toMatchObject({ ok: true });
    await pendingBook(emailSession, 'shutdown-running', true, LATER);
    const shutdownEntered = deferred<void>();
    const shutdownRelease = deferred<void>();
    getEvent.mockImplementationOnce(async (...args) => {
      shutdownEntered.resolve();
      await shutdownRelease.promise;
      return get(...args);
    });
    const ticking = vi.advanceTimersByTimeAsync(60_000);
    await shutdownEntered.promise;
    let stopped = false;
    const stopping = Promise.resolve(stop()).then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    shutdownRelease.resolve();
    await stopping;
    await ticking;
    expect(responseIn(emailSession, 'shutdown-running')).toMatchObject({ ok: true });
    const afterSweep = getEvent.mock.calls.length;
    await vi.advanceTimersByTimeAsync(180_000);
    expect(getEvent).toHaveBeenCalledTimes(afterSweep);
  } finally {
    release.resolve();
    await stop();
  }
});
