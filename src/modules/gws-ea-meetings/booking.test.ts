import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ROOT = vi.hoisted(() => `/tmp/booking-reads-${process.pid}`);
vi.mock('../../config.js', async (original) => ({
  ...(await original<typeof import('../../config.js')>()),
  DATA_DIR: ROOT,
}));
vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn(async () => true) }));

import '../gws-ea-inbox/index.js';
import '../gws-ea-preferences/index.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import { getDb } from '../../db/connection.js';
import { ensureContainerConfig, updateContainerConfigScalars } from '../../db/container-configs.js';
import * as bookingStorage from './bookings-db.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { resolveSession } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { addPrincipalAddress, recordExternalEmailAgentGroupId } from '../gws-ea-profile/db.js';
import { replacePrincipalCalendars } from '../gws-ea-inbox/db.js';
import { createThread, recordThreadAddresses } from '../gws-ea-inbox/thread-map.js';
import { cleanChatDelivery, platformMembers, seedChatDelivery } from '../gws-ea-chats/testing/chat-delivery-fixture.js';
import { setChatMemberEmail } from '../gws-ea-chats/roster.js';
import { setChatCalendar } from '../gws-ea-chats/handoffs.js';
import { placeInMatter, openMatter } from '../gws-ea-matters/db.js';
import { FakeCalendar } from './testing/fake-calendar.js';
import { setThreadBookingCalendar } from './thread-calendar.js';
import { createBookingTools } from './booking.js';
import { bookingsMigration } from './bookings-migration.js';
import { getBooking, getBookingRequest } from './bookings-db.js';
import { chatBookingRequestsMigration } from './chat-booking-migration.js';
import { chatBookingReportsMigration } from './chat-booking-report-migration.js';
import * as mainNotesModule from '../gws-ea-profile/main-note.js';
import { addPrivateValue } from '../gws-ea-privacy/db.js';
import { recordChatClearances } from '../gws-ea-privacy/clearance.js';
import { GoogleApiError } from '../gws-ea-inbox/gmail-api.js';
import { GoogleNotSignedInError } from '../gws-ea-google/tokens.js';
import { log } from '../../log.js';
import { ANSWER_LATER } from '../../cli/delivery-action.js';
import { bookingSurfaceFor, resolveBookingSurface } from './booking-surface.js';

const PRINCIPAL = 'juno@example.com';
const ASSISTANT = 'avery@example.com';
const MIRA = 'mira@example.com';
const TEAM = 'visits@group.calendar.google.com';
const BOOK = { start: '2026-10-20T12:00:00Z', minutes: 30, title: 'Venue visit' };
const LATER = '2026-10-21T12:00:00Z';
const RANGE = { from: '2026-10-20T09:00:00Z', to: '2026-10-20T17:00:00Z', minutes: 30, timezone: 'Europe/Paris' };
let calendar: FakeCalendar;
let thread: string;
let chat: string;
let matterId: string;
let emailSession: Session;
let chatSession: Session;
let reads: ReturnType<typeof createBookingTools>;

beforeEach(async () => {
  vi.useFakeTimers({ now: new Date('2026-10-18T12:00:00Z'), toFake: ['Date'] });
  const seeded = await seedChatDelivery();
  for (const migration of [chatBookingRequestsMigration, chatBookingReportsMigration, bookingsMigration]) {
    if (migration.sqliteOnly) throw new Error('Expected portable migration');
    await migration.up(getDb());
  }
  chatSession = seeded.session;
  matterId = seeded.matter.id;
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

it('offers the same windows in text with both-zone labels from either real surface, including the booking calendar', async () => {
  calendar.put({
    calendarId: PRINCIPAL,
    id: 'private-principal',
    summary: 'Private therapy',
    start: { dateTime: '2026-10-20T12:00:00Z' },
    end: { dateTime: '2026-10-20T13:00:00Z' },
  });
  calendar.put({
    calendarId: TEAM,
    id: 'private-booking-calendar',
    summary: 'Private review',
    start: { dateTime: '2026-10-20T14:00:00Z' },
    end: { dateTime: '2026-10-20T15:00:00Z' },
  });
  const details = vi.spyOn(calendar, 'listEventDetails');
  const email = await reads.freeTime(RANGE, emailSession, 'email-free');
  const spoken = await reads.freeTime(RANGE, chatSession, 'chat-free');
  expect(email).toEqual(spoken);
  expect(email.windows).toEqual([
    {
      start: '2026-10-20T09:00:00.000Z',
      end: '2026-10-20T12:00:00.000Z',
      principal_time: 'Tuesday, Oct 20, 9:00 AM–12:00 PM UTC',
      their_time: 'Tuesday, Oct 20, 11:00 AM–2:00 PM CEST',
      fit: 'acceptable',
    },
    {
      start: '2026-10-20T13:00:00.000Z',
      end: '2026-10-20T14:00:00.000Z',
      principal_time: 'Tuesday, Oct 20, 1:00–2:00 PM UTC',
      their_time: 'Tuesday, Oct 20, 3:00–4:00 PM CEST',
      fit: 'acceptable',
    },
    {
      start: '2026-10-20T15:00:00.000Z',
      end: '2026-10-20T17:00:00.000Z',
      principal_time: 'Tuesday, Oct 20, 3:00–5:00 PM UTC',
      their_time: 'Tuesday, Oct 20, 5:00–7:00 PM CEST',
      fit: 'acceptable',
    },
  ]);
  expect(email.message).toContain("Free for 30 minutes: any start that ends by a window's end.");
  expect(email.message).toContain('for them, Tuesday, Oct 20, 11:00 AM–2:00 PM CEST');
  expect(JSON.stringify(email)).not.toMatch(
    /Private therapy|Private review|private-principal|private-booking-calendar/,
  );
  expect(details).not.toHaveBeenCalled();
});

it('refuses a missing booking calendar on both surfaces before making any Calendar call', async () => {
  await getDb().run('UPDATE gws_ea_threads SET booking_calendar_id=NULL WHERE thread_key=?', thread);
  await getDb().run('UPDATE gws_ea_chats SET calendar_id=NULL WHERE messaging_group_id=?', chat);
  for (const session of [emailSession, chatSession])
    await expect(reads.freeTime(RANGE, session, 'missing')).rejects.toThrow(
      'wake main once with tell_main to ask which calendar to book on, and offer no time until it answers',
    );
  expect(calendar.calls).toBe(0);
});

it('refuses a booking calendar that is no longer bookable separately from an unset calendar', async () => {
  calendar.calendars.set(TEAM, { id: TEAM, dataOwner: PRINCIPAL, accessRole: 'reader' });
  const listing = vi.spyOn(calendar, 'listEvents');
  for (const session of [emailSession, chatSession])
    await expect(reads.freeTime(RANGE, session, 'unbookable')).rejects.toThrow(
      'no longer one the assistant can book on',
    );
  expect(listing).not.toHaveBeenCalled();
});

it('reads a principal calendar and the same booking calendar in another case only once', async () => {
  await replacePrincipalCalendars([PRINCIPAL.toUpperCase()], new Date().toISOString());
  await setThreadBookingCalendar(thread, PRINCIPAL);
  await setChatCalendar(chat, PRINCIPAL);
  const listing = vi.spyOn(calendar, 'listEvents');
  for (const session of [emailSession, chatSession]) {
    listing.mockClear();
    await reads.freeTime(RANGE, session, 'dedupe');
    expect(listing).toHaveBeenCalledTimes(1);
    expect(listing.mock.calls[0][0].toLowerCase()).toBe(PRINCIPAL);
  }
});

it('refuses caller-supplied source fields on both surfaces before any Calendar call', async () => {
  for (const session of [emailSession, chatSession])
    await expect(reads.freeTime({ ...RANGE, owner: 'another-owner' }, session, 'foreign-field')).rejects.toThrow(
      'Unknown field owner',
    );
  expect(calendar.calls).toBe(0);
});

describe.each([
  ['to before from', { ...RANGE, to: '2026-10-20T08:00:00Z' }, 'to must come after from'],
  ['more than sixty days', { ...RANGE, to: '2026-12-20T17:00:00Z' }, 'The range may span at most 60 days'],
  [
    'past range',
    { ...RANGE, from: '2026-10-15T09:00:00Z', to: '2026-10-15T17:00:00Z' },
    'That range has already passed: ask for one in the future.',
  ],
] as const)('%s', (_name, range, message) => {
  it('has its own refusal on both surfaces without a Calendar read', async () => {
    for (const session of [emailSession, chatSession])
      await expect(reads.freeTime(range, session, 'range')).rejects.toThrow(message);
    expect(calendar.calls).toBe(0);
  });
});

it('requires the actual stored serving session and refuses a fabricated thread binding or an old chat owner', async () => {
  await expect(resolveBookingSurface({ ...emailSession, thread_id: 'another-thread' })).rejects.toThrow();
  await expect(resolveBookingSurface({ ...chatSession, agent_group_id: 'peer' })).rejects.toThrow('serving');
  await getDb().run("UPDATE sessions SET status='closed' WHERE id=?", emailSession.id);
  await expect(resolveBookingSurface(emailSession)).rejects.toThrow();
  await getDb().run("UPDATE gws_ea_chats SET serving_agent_group_id='peer' WHERE messaging_group_id=?", chat);
  await expect(resolveBookingSurface(chatSession)).rejects.toThrow('serving');
});

it('keeps owner-bound calendars and linked conversations available after its session disappears', async () => {
  await placeInMatter(matterId, [{ kind: 'thread', reference: thread }]);
  const email = bookingSurfaceFor({ kind: 'thread', key: thread });
  const spoken = bookingSurfaceFor({ kind: 'chat', key: chat });
  await getDb().run('DELETE FROM sessions WHERE id IN (?,?)', emailSession.id, chatSession.id);
  expect(await email.calendarId()).toBe(TEAM);
  expect(await spoken.calendarId()).toBe(TEAM);
  expect(await email.openMatters()).toEqual([{ id: matterId, conversations: [{ kind: 'chat', key: chat }] }]);
  expect(await spoken.openMatters()).toEqual([{ id: matterId, conversations: [{ kind: 'thread', key: thread }] }]);
  expect(await email.stillServing(emailSession)).toBe(false);
  expect(await spoken.stillServing(chatSession)).toBe(false);
});

it('uses job privacy and supplies chat clearances only for recipients who are all current members with email', async () => {
  await createAgentGroup({
    id: 'job',
    name: 'job',
    folder: 'job',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  await getDb().run(
    "INSERT INTO gws_ea_job_agents(agent_group_id,messaging_group_id,state,created_at,updated_at) VALUES('job',?,'active',?,?)",
    chat,
    new Date().toISOString(),
    new Date().toISOString(),
  );
  await getDb().run(
    "UPDATE gws_ea_chats SET state='job',serving_agent_group_id='job' WHERE messaging_group_id=?",
    chat,
  );
  const session = (await resolveSession('job', chat, null, 'shared')).session;
  const { surface, writer } = await resolveBookingSurface(session);
  expect(writer).toBe('job');
  expect(await surface.privacyFor([MIRA], writer)).toEqual({ writer: 'job', chatId: chat });
  expect(await surface.privacyFor([MIRA, 'guest@outside.example'], writer)).toEqual({ writer: 'job' });
  platformMembers([{ key: 'whatsapp:11', name: 'Juno', isPrincipal: true }]);
  await surface.beforeWrite();
  expect(await surface.privacyFor([MIRA], writer)).toEqual({ writer: 'job' });
});

it('uses each surface’s invitation authority and excludes the principal and assistant from invitations', async () => {
  const onlyWritten = 'remy@friends.example';
  await recordThreadAddresses(thread, [onlyWritten], 'written', new Date().toISOString());
  await reads.book({ ...BOOK, invitees: [onlyWritten] }, emailSession, 'thread-named');
  expect(calendar.live()[0].attendees?.map((guest) => guest.email)).toEqual([TEAM, onlyWritten]);
  await expect(reads.book({ ...BOOK, invitees: [onlyWritten] }, chatSession, 'chat-outside')).rejects.toThrow(
    'current members',
  );
  await expect(
    reads.book({ ...BOOK, invitees: ['nobody@outside.example'] }, emailSession, 'thread-outside'),
  ).rejects.toThrow('is not on this thread');
  await reads.book({ ...BOOK, start: LATER }, chatSession, 'chat-default');
  expect(calendar.live()[1].attendees?.map((guest) => guest.email)).toEqual([TEAM, MIRA]);
});

it('names every taken time without exposing the events in the shared availability refusal', async () => {
  calendar.put({
    calendarId: PRINCIPAL,
    id: 'personal-busy',
    summary: 'Private therapy',
    start: { dateTime: '2026-10-20T12:00:00Z' },
    end: { dateTime: '2026-10-20T13:00:00Z' },
  });
  calendar.put({
    calendarId: TEAM,
    id: 'booking-busy',
    summary: 'Private review',
    start: { dateTime: '2026-10-20T14:00:00Z' },
    end: { dateTime: '2026-10-20T15:00:00Z' },
  });
  for (const session of [emailSession, chatSession]) {
    await expect(reads.book(BOOK, session, 'busy')).rejects.toThrow(
      'Tuesday, Oct 20, 12:00–12:30 PM UTC: no longer free. Call free_time for times to offer instead.',
    );
    await expect(reads.book({ ...BOOK, start: '2026-10-20T14:00:00Z' }, session, 'also-busy')).rejects.toThrow(
      'Tuesday, Oct 20, 2:00–2:30 PM UTC: no longer free. Call free_time for times to offer instead.',
    );
  }
  expect(calendar.writes).toEqual([]);
});

it('refreshes the platform roster before entering the chat wrapper and authorizing a write', async () => {
  platformMembers([{ key: 'whatsapp:11', name: 'Juno', isPrincipal: true }]);
  await expect(reads.book({ ...BOOK, invitees: [MIRA] }, chatSession, 'refresh-first')).rejects.toThrow(
    'current members',
  );
  expect(calendar.writes).toEqual([]);
});

it('retains a timed-out insert that Google applied and never withdraws its invitation', async () => {
  calendar.failNext({ op: 'insert', error: new Error('Google answer lost'), afterApplying: true });
  const result = await reads.book(
    { start: '2026-10-20T12:00:00Z', minutes: 30, title: 'Venue visit' },
    chatSession,
    'lost-insert',
  );
  expect(result).toBe(ANSWER_LATER);
  expect(calendar.live()).toHaveLength(1);
  expect(calendar.writes.map((write) => write.op)).toEqual(['insert']);
  expect(await getBookingRequest(chatSession.id, 'lost-insert')).toMatchObject({ applied: false, reported: false });
  const resumed = await reads.book(BOOK, chatSession, 'lost-insert');
  expect(resumed).toMatchObject({ booking: calendar.live()[0].id });
  expect(await getBooking({ kind: 'chat', key: chat }, calendar.live()[0].id)).toBeDefined();
  expect(await getBookingRequest(chatSession.id, 'lost-insert')).toMatchObject({ applied: true, reported: true });
  expect(calendar.writes.map((write) => write.op)).toEqual(['insert']);
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

it.each(['thread', 'chat'] as const)(
  'books a %s meeting with its owner label, durable ownership and a full main note before success',
  async (kind) => {
    const main = await mainSession();
    const session = kind === 'thread' ? emailSession : chatSession;
    if (kind === 'thread') await placeInMatter(matterId, [{ kind: 'thread', reference: thread }]);
    const answer = answerData(await reads.book({ ...BOOK, video_call: true }, session, 'book-note'));
    const event = calendar.live()[0];
    expect(answer.booking).toBe(event.id);
    expect(event.tags).toEqual({
      gwsEaRole: 'booking',
      [kind === 'thread' ? 'gwsEaThread' : 'gwsEaChat']: kind === 'thread' ? thread : chat,
    });
    expect(await getBooking({ kind, key: kind === 'thread' ? thread : chat }, event.id)).toMatchObject({
      calendarId: TEAM,
      eventId: event.id,
    });
    expect(await getBookingRequest(session.id, 'book-note')).toMatchObject({ applied: true, reported: true });
    expect(notesIn(main)).toHaveLength(1);
    expect(notesIn(main)[0]).toContain(
      'Booked a meeting with mira@example.com for Tuesday, Oct 20, 2:00–2:30 PM CEST (30 minutes), by video call',
    );
    expect(notesIn(main)[0]).toContain('untrusted');
    expect(notesIn(main)[0]).toContain('Venue visit');
    expect(
      await getDb().get(
        "SELECT matter_id FROM gws_ea_matter_links WHERE kind='event' AND reference=?",
        `${TEAM}/${event.id}`,
      ),
    ).toEqual({ matter_id: matterId });
  },
);

it('does not place a chat booking when its owner has two open matters', async () => {
  await openMatter({ title: 'Cabin', openLoop: 'Choose dates', links: [{ kind: 'chat', reference: chat }] });
  const id = await booked();
  expect(
    await getDb().get("SELECT matter_id FROM gws_ea_matter_links WHERE kind='event' AND reference=?", `${TEAM}/${id}`),
  ).toBeUndefined();
});

it('keeps a reporting failure pending and preserves main’s later matter relocation on retry', async () => {
  const main = await mainSession();
  const write = mainNotesModule.writeNoteForMain;
  const note = vi
    .spyOn(mainNotesModule, 'writeNoteForMain')
    .mockImplementationOnce(async () => {
      throw new Error('Mailbox write interrupted');
    })
    .mockImplementation(write);
  expect(await reads.book(BOOK, chatSession, 'note-failed')).toBe(ANSWER_LATER);
  const event = calendar.live()[0];
  expect(await getBookingRequest(chatSession.id, 'note-failed')).toMatchObject({ applied: true, reported: false });
  const moved = await openMatter({ title: 'A new plan', openLoop: 'Find dates', links: [] });
  await placeInMatter(moved.matter.id, [{ kind: 'event', reference: `${TEAM}/${event.id}` }]);
  expect(answerData(await reads.book(BOOK, chatSession, 'note-failed')).booking).toBe(event.id);
  expect(notesIn(main)).toHaveLength(1);
  expect(calendar.writes.map((entry) => entry.op)).toEqual(['insert']);
  expect(note).toHaveBeenCalledTimes(2);
  expect(
    await getDb().get(
      "SELECT matter_id FROM gws_ea_matter_links WHERE kind='event' AND reference=? AND matter_open=1",
      `${TEAM}/${event.id}`,
    ),
  ).toEqual({ matter_id: moved.matter.id });
});

it('counts and logs no main as reported, allowing the tool to finish', async () => {
  await getDb().run('UPDATE gws_ea_profile SET main_agent_group_id=NULL WHERE singleton=1');
  const warning = vi.spyOn(log, 'warn');
  await booked();
  expect(await getBookingRequest(chatSession.id, 'initial')).toMatchObject({ applied: true, reported: true });
  expect(warning).toHaveBeenCalledWith(
    'Nobody to tell of a booking change',
    expect.objectContaining({ result: 'no-main' }),
  );
});

it.each([false, true])(
  'rechecks an insert that did not apply, refusing only if the requested time is now taken (%s)',
  async (taken) => {
    calendar.failNext({ op: 'insert', error: new Error('Network timed out'), afterApplying: false });
    expect(await reads.book(BOOK, emailSession, 'not-inserted')).toBe(ANSWER_LATER);
    expect(calendar.live()).toEqual([]);
    if (taken)
      calendar.put({
        calendarId: PRINCIPAL,
        id: 'principal-new-plan',
        start: { dateTime: BOOK.start },
        end: { dateTime: '2026-10-20T13:00:00Z' },
      });
    if (taken) {
      await expect(reads.book(BOOK, emailSession, 'not-inserted')).rejects.toThrow('no longer free');
      expect(await getBookingRequest(emailSession.id, 'not-inserted')).toBeUndefined();
      expect(calendar.live(TEAM)).toEqual([]);
    } else {
      expect(answerData(await reads.book(BOOK, emailSession, 'not-inserted')).booking).toBe(calendar.live()[0].id);
      expect(calendar.writes.map((entry) => entry.op)).toEqual(['insert']);
    }
  },
);

it('settles an applied insert that was subsequently removed without restoring the event', async () => {
  const main = await mainSession();
  calendar.failNext({ op: 'insert', error: new Error('Network timed out'), afterApplying: true });
  expect(await reads.book(BOOK, chatSession, 'removed-insert')).toBe(ANSWER_LATER);
  const event = calendar.live()[0];
  calendar.put({ ...event, status: 'cancelled' });
  await expect(reads.book(BOOK, chatSession, 'removed-insert')).rejects.toThrow(
    'principal or main may have removed it',
  );
  await expect(reads.book(BOOK, chatSession, 'removed-insert')).rejects.toThrow(
    'principal or main may have removed it',
  );
  expect(calendar.live()).toEqual([]);
  expect(calendar.writes.map((entry) => entry.op)).toEqual(['insert']);
  expect(notesIn(main)).toHaveLength(1);
  expect(notesIn(main)[0]).toContain('then it was removed');
});

it.each(['patch', 'delete'] as const)(
  'defers an uncertain %s and settles exactly once from Google’s resulting event',
  async (op) => {
    const main = await mainSession();
    const id = await booked(emailSession);
    calendar.failNext({ op, error: new Error('Google answer lost'), afterApplying: true });
    const content = { booking: id, ...(op === 'patch' ? { start: LATER } : {}) };
    const action = op === 'patch' ? reads.changeBooking : reads.cancelBooking;
    expect(await action(content, emailSession, 'lost-write')).toBe(ANSWER_LATER);
    const result = answerData(await action(content, emailSession, 'lost-write'));
    expect(result.message).toContain(op === 'patch' ? 'booking stands at' : 'Cancelled:');
    expect(await getBookingRequest(emailSession.id, 'lost-write')).toMatchObject({ applied: true, reported: true });
    expect(calendar.writes.filter((entry) => entry.op === op)).toHaveLength(1);
    expect(notesIn(main)).toHaveLength(2);
    if (op === 'delete') {
      expect(await getBooking({ kind: 'thread', key: thread }, id)).toBeUndefined();
      expect(notesIn(main)[1]).toContain('Cancelled the meeting with mira@example.com');
      answerData(await action(content, emailSession, 'lost-write'));
      expect(await getBooking({ kind: 'thread', key: thread }, id)).toBeUndefined();
    }
  },
);

it('reports the current time when a marked change landed and the principal subsequently moved it', async () => {
  const main = await mainSession();
  const id = await booked();
  calendar.failNext({ op: 'patch', error: new Error('Google answer lost'), afterApplying: true });
  const content = { booking: id, start: LATER };
  expect(await reads.changeBooking(content, chatSession, 'marked-change')).toBe(ANSWER_LATER);
  const event = calendar.event(TEAM, id);
  if (!event) throw new Error('No event');
  calendar.put({ ...event, start: { dateTime: '2026-10-22T13:00:00Z' }, end: { dateTime: '2026-10-22T13:30:00Z' } });
  const result = answerData(await reads.changeBooking(content, chatSession, 'marked-change'));
  expect(result.start).toBe('2026-10-22T13:00:00.000Z');
  expect(notesIn(main)[1]).toContain('Thursday, Oct 22, 3:00–3:30 PM CEST');
  expect(calendar.writes.filter((entry) => entry.op === 'patch')).toHaveLength(1);
});

it.each(['patch', 'delete'] as const)('uses If-Match to preserve an edit that races the %s write', async (op) => {
  const main = await mainSession();
  const id = await booked();
  const original = calendar[op === 'patch' ? 'patchEvent' : 'deleteEvent'].bind(calendar);
  const move = (): void => {
    const event = calendar.event(TEAM, id);
    if (!event) throw new Error('No event');
    calendar.put({ ...event, start: { dateTime: '2026-10-22T14:00:00Z' }, end: { dateTime: '2026-10-22T14:30:00Z' } });
  };
  if (op === 'patch') {
    const patch = calendar.patchEvent.bind(calendar);
    vi.spyOn(calendar, 'patchEvent').mockImplementationOnce(async (...args) => {
      move();
      return patch(...args);
    });
  } else {
    const remove = calendar.deleteEvent.bind(calendar);
    vi.spyOn(calendar, 'deleteEvent').mockImplementationOnce(async (...args) => {
      move();
      return remove(...args);
    });
  }
  void original;
  const action = op === 'patch' ? reads.changeBooking : reads.cancelBooking;
  const content = { booking: id, ...(op === 'patch' ? { start: LATER } : {}) };
  await expect(action(content, chatSession, 'race')).rejects.toThrow(
    'It now stands at Thursday, Oct 22, 2:00–2:30 PM UTC. Ask main',
  );
  await expect(action(content, chatSession, 'race')).rejects.toThrow('meeting changed since it was checked');
  expect(calendar.event(TEAM, id)?.start?.dateTime).toBe('2026-10-22T14:00:00Z');
  expect(calendar.writes.map((entry) => entry.op)).toEqual(['insert']);
  expect(notesIn(main)[1]).toContain('was not written again');
});

it.each(['free', 'taken', 'moved'] as const)('rechecks an unapplied change when the target is %s', async (state) => {
  const id = await booked(emailSession);
  calendar.failNext({ op: 'patch', error: new Error('Network timed out'), afterApplying: false });
  const content = { booking: id, start: LATER };
  expect(await reads.changeBooking(content, emailSession, 'unapplied-change')).toBe(ANSWER_LATER);
  if (state === 'taken')
    calendar.put({
      calendarId: PRINCIPAL,
      id: 'new-plan',
      start: { dateTime: LATER },
      end: { dateTime: '2026-10-21T13:00:00Z' },
    });
  if (state === 'moved') {
    const event = calendar.event(TEAM, id);
    if (!event) throw new Error('No event');
    calendar.put({ ...event, start: { dateTime: '2026-10-22T14:00:00Z' }, end: { dateTime: '2026-10-22T14:30:00Z' } });
  }
  if (state === 'free') {
    expect(answerData(await reads.changeBooking(content, emailSession, 'unapplied-change')).start).toBe(
      '2026-10-21T12:00:00.000Z',
    );
    expect(calendar.writes.map((entry) => entry.op)).toEqual(['insert', 'patch']);
  } else {
    await expect(reads.changeBooking(content, emailSession, 'unapplied-change')).rejects.toThrow(
      state === 'taken' ? 'no longer free' : 'meeting changed since it was checked',
    );
    expect(calendar.writes.map((entry) => entry.op)).toEqual(['insert']);
    if (state === 'taken') expect(await getBookingRequest(emailSession.id, 'unapplied-change')).toBeUndefined();
    if (state === 'moved') expect(calendar.event(TEAM, id)?.start?.dateTime).toBe('2026-10-22T14:00:00Z');
  }
});

it('refuses new work while the booking has an unreported request, and refuses changed content for one request id', async () => {
  const id = await booked();
  calendar.failNext({ op: 'patch', error: new Error('Network timed out') });
  expect(await reads.changeBooking({ booking: id, start: LATER }, chatSession, 'first')).toBe(ANSWER_LATER);
  await expect(reads.changeBooking({ booking: id, title: 'Another plan' }, chatSession, 'second')).rejects.toThrow(
    'Its first answer will reach you',
  );
  await expect(
    reads.changeBooking({ booking: id, start: '2026-10-22T12:00:00Z' }, chatSession, 'first'),
  ).rejects.toThrow('already used for different work');
  await expect(reads.cancelBooking({ booking: id }, chatSession, 'first')).rejects.toThrow(
    'already used for different work',
  );
  expect(calendar.writes.map((entry) => entry.op)).toEqual(['insert']);
});

it.each([true, false])(
  'confirms an absent cancellation only while the calendar remains readable (%s)',
  async (readable) => {
    const main = await mainSession();
    const id = await booked();
    calendar.failNext({ op: 'delete', error: new Error('Google answer lost') });
    expect(await reads.cancelBooking({ booking: id }, chatSession, 'cancel-gone')).toBe(ANSWER_LATER);
    calendar.remove(TEAM, id);
    if (!readable) calendar.calendars.delete(TEAM);
    const result = answerData(await reads.cancelBooking({ booking: id }, chatSession, 'cancel-gone'));
    expect(result.message).toContain(readable ? 'Cancelled:' : 'may or may not have gone through');
    expect(notesIn(main)[1]).toContain(readable ? 'Cancelled the meeting' : 'may or may not have gone through');
    expect(await getBooking({ kind: 'chat', key: chat }, id)).toEqual(
      readable ? undefined : expect.objectContaining({ eventId: id }),
    );
  },
);

it.each([
  new GoogleApiError(403, 'Quota exhausted', { reason: 'rateLimitExceeded' }),
  new GoogleApiError(429, 'Slow down'),
])('retains a locally classified rate-limit response (%s)', async (error) => {
  calendar.failNext({ op: 'insert', error });
  expect(await reads.book(BOOK, emailSession, 'rate-limit')).toBe(ANSWER_LATER);
  expect(await getBookingRequest(emailSession.id, 'rate-limit')).toMatchObject({ applied: false, reported: false });
  expect(calendar.writes).toEqual([]);
});

it('drops a request refused with no Google token after recording, and gives the surface’s connection step', async () => {
  calendar.failNext({ op: 'insert', error: new GoogleNotSignedInError('No token') });
  await expect(reads.book(BOOK, emailSession, 'no-token')).rejects.toThrow("couldn't do on this thread");
  expect(await getBookingRequest(emailSession.id, 'no-token')).toBeUndefined();
  expect(calendar.writes).toEqual([]);
});

it.each(['missing-label', 'foreign-label', 'removed'] as const)(
  'refuses a change when the stored event is %s',
  async (state) => {
    const id = await booked(emailSession);
    const event = calendar.event(TEAM, id);
    if (!event) throw new Error('No event');
    calendar.put({
      ...event,
      ...(state === 'removed'
        ? { status: 'cancelled' }
        : { tags: { gwsEaRole: 'booking', ...(state === 'foreign-label' ? { gwsEaThread: 'another-thread' } : {}) } }),
    });
    await expect(reads.changeBooking({ booking: id, start: LATER }, emailSession, 'not-owned')).rejects.toThrow(
      state === 'removed' ? 'no longer on the calendar' : 'no longer belongs',
    );
    expect(calendar.writes.map((entry) => entry.op)).toEqual(['insert']);
  },
);

it.each(['thread', 'chat'] as const)(
  'lets a %s time-only change keep guests main added, while checking new text against every guest',
  async (kind) => {
    const secret = await addPrivateValue({ kind: 'phone', label: 'Private phone', value: '+14155550123' });
    if (kind === 'chat') {
      await getDb().run(
        "INSERT INTO gws_ea_principal_messages(message_id,messaging_group_id,user_id,timestamp,text) VALUES('share-phone',?,'whatsapp:11',?,'Share my phone number for this meeting.')",
        chat,
        new Date().toISOString(),
      );
      await recordChatClearances({ messagingGroupId: chat, principalMessageId: 'share-phone', values: [secret] });
    }
    const session = kind === 'thread' ? emailSession : chatSession;
    const id = await booked(session);
    const event = calendar.event(TEAM, id);
    if (!event) throw new Error('No event');
    calendar.put({ ...event, attendees: [...(event.attendees ?? []), { email: 'morgan@outside.example' }] });
    await expect(
      reads.changeBooking({ booking: id, notes: 'Call +14155550123' }, session, 'private-note'),
    ).rejects.toThrow('private phone');
    expect(answerData(await reads.changeBooking({ booking: id, start: LATER }, session, 'time-only')).start).toBe(
      '2026-10-21T12:00:00.000Z',
    );
    expect(calendar.event(TEAM, id)?.attendees?.map((guest) => guest.email)).toContain('morgan@outside.example');
  },
);

it('refuses another cancellation while the first cancellation is applied but its main note is still pending', async () => {
  await mainSession();
  const id = await booked();
  const write = mainNotesModule.writeNoteForMain;
  vi.spyOn(mainNotesModule, 'writeNoteForMain')
    .mockImplementationOnce(async () => {
      throw new Error('Main mailbox unavailable');
    })
    .mockImplementation(write);
  expect(await reads.cancelBooking({ booking: id }, chatSession, 'cancel-report')).toBe(ANSWER_LATER);
  expect(await getBooking({ kind: 'chat', key: chat }, id)).toBeUndefined();
  expect(await getBookingRequest(chatSession.id, 'cancel-report')).toMatchObject({ applied: true, reported: false });
  await expect(reads.cancelBooking({ booking: id }, chatSession, 'second-cancel')).rejects.toThrow(
    'Its first answer will reach you',
  );
  expect(answerData(await reads.cancelBooking({ booking: id }, chatSession, 'cancel-report')).message).toContain(
    'Cancelled:',
  );
  expect(calendar.writes.map((entry) => entry.op)).toEqual(['insert', 'delete']);
});

it.each(['insert', 'patch', 'delete'] as const)(
  'defers a local applied-state failure after a successful %s and recovers without another Google write',
  async (op) => {
    const id = op === 'insert' ? undefined : await booked();
    const mark = bookingStorage.markBookingRequestApplied;
    vi.spyOn(bookingStorage, 'markBookingRequestApplied')
      .mockImplementationOnce(async () => {
        throw new Error('Local transaction interrupted');
      })
      .mockImplementation(mark);
    const action = op === 'insert' ? reads.book : op === 'patch' ? reads.changeBooking : reads.cancelBooking;
    const content = op === 'insert' ? BOOK : { booking: id, ...(op === 'patch' ? { start: LATER } : {}) };
    expect(await action(content, chatSession, 'local-failure')).toBe(ANSWER_LATER);
    expect(await getBookingRequest(chatSession.id, 'local-failure')).toMatchObject({ applied: false, reported: false });
    if (op === 'delete') expect(await getBooking({ kind: 'chat', key: chat }, String(id))).toBeDefined();
    expect(answerData(await action(content, chatSession, 'local-failure')).booking).toBe(calendar.events[0].id);
    expect(calendar.writes.filter((entry) => entry.op === op)).toHaveLength(1);
    expect(await getBookingRequest(chatSession.id, 'local-failure')).toMatchObject({ applied: true, reported: true });
    if (op === 'delete') expect(await getBooking({ kind: 'chat', key: chat }, String(id))).toBeUndefined();
  },
);

it('retries a main-note state failure through the real idempotent mailbox and records one note', async () => {
  const main = await mainSession();
  const mark = bookingStorage.markBookingRequestReported;
  vi.spyOn(bookingStorage, 'markBookingRequestReported')
    .mockImplementationOnce(async () => {
      throw new Error('Local state write interrupted');
    })
    .mockImplementation(mark);
  expect(await reads.book(BOOK, emailSession, 'reported-state')).toBe(ANSWER_LATER);
  expect(notesIn(main)).toHaveLength(1);
  expect(await getBookingRequest(emailSession.id, 'reported-state')).toMatchObject({ applied: true, reported: false });
  expect(answerData(await reads.book(BOOK, emailSession, 'reported-state')).booking).toBe(calendar.live()[0].id);
  expect(notesIn(main)).toHaveLength(1);
  expect(await getBookingRequest(emailSession.id, 'reported-state')).toMatchObject({ applied: true, reported: true });
});

it.each(['book', 'change', 'cancel'] as const)(
  'refuses caller-controlled source fields for %s on both surfaces before Google is called',
  async (action) => {
    for (const session of [emailSession, chatSession]) {
      const run = action === 'book' ? reads.book : action === 'change' ? reads.changeBooking : reads.cancelBooking;
      await expect(
        run(
          { ...(action === 'book' ? BOOK : { booking: 'a'.repeat(64) }), owner: 'foreign' },
          session,
          'foreign-fields',
        ),
      ).rejects.toThrow('Unknown field owner');
    }
    expect(calendar.calls).toBe(0);
  },
);

it('keeps a carried-over unknown result unknown after reporting fails and is retried', async () => {
  const main = await mainSession();
  const id = await booked();
  calendar.failNext({ op: 'patch', error: new Error('Answer lost') });
  const content = { booking: id, start: LATER };
  expect(await reads.changeBooking(content, chatSession, 'carry-change')).toBe(ANSWER_LATER);
  await getDb().run(
    'UPDATE gws_ea_booking_requests SET carried_over=1,event_etag=NULL,request_mark=NULL,request_json=? WHERE session_id=? AND request_id=?',
    JSON.stringify(content),
    chatSession.id,
    'carry-change',
  );
  const write = mainNotesModule.writeNoteForMain;
  vi.spyOn(mainNotesModule, 'writeNoteForMain')
    .mockImplementationOnce(async () => {
      throw new Error('Mailbox down');
    })
    .mockImplementation(write);
  expect(await reads.changeBooking(content, chatSession, 'carry-change')).toBe(ANSWER_LATER);
  const result = answerData(await reads.changeBooking(content, chatSession, 'carry-change'));
  expect(result.message).toContain('may or may not have gone through');
  expect(result).not.toHaveProperty('result');
  expect(notesIn(main)[1]).toContain('may or may not have gone through');
  expect(calendar.writes.map((entry) => entry.op)).toEqual(['insert']);
});

it('reports a carried-over absent book as not carried out and keeps that refusal across retries', async () => {
  const main = await mainSession();
  calendar.failNext({ op: 'insert', error: new Error('Answer lost') });
  expect(await reads.book(BOOK, chatSession, 'carry-book')).toBe(ANSWER_LATER);
  await getDb().run(
    'UPDATE gws_ea_booking_requests SET carried_over=1,request_json=? WHERE session_id=? AND request_id=?',
    JSON.stringify(BOOK),
    chatSession.id,
    'carry-book',
  );
  await expect(reads.book(BOOK, chatSession, 'carry-book')).rejects.toThrow(
    'pending booking request was not carried out',
  );
  await expect(reads.book(BOOK, chatSession, 'carry-book')).rejects.toThrow(
    'pending booking request was not carried out',
  );
  expect(notesIn(main)).toHaveLength(1);
  expect(notesIn(main)[0]).toContain('pending booking request was not carried out');
  expect(notesIn(main)[0]).not.toContain('may or may not');
  expect(calendar.writes).toEqual([]);
});

it('does not call a 412 with lost calendar access a confirmed removal', async () => {
  const main = await mainSession();
  const id = await booked();
  const patch = calendar.patchEvent.bind(calendar);
  calendar.failNext({ op: 'patch', error: new GoogleApiError(412, 'Changed before write') });
  vi.spyOn(calendar, 'patchEvent').mockImplementationOnce(async (...args) => {
    calendar.remove(TEAM, id);
    calendar.calendars.delete(TEAM);
    return patch(...args);
  });
  const result = answerData(await reads.changeBooking({ booking: id, start: LATER }, chatSession, 'lost-access'));
  expect(result.message).toContain('may or may not have gone through');
  expect(notesIn(main)[1]).toContain('may or may not have gone through');
  expect(notesIn(main)[1]).not.toContain('was removed');
});

it('gives a no-change answer with its current video link without sending an update or recording work', async () => {
  const id = String(answerData(await reads.book({ ...BOOK, video_call: true }, chatSession, 'with-video')).booking);
  const result = answerData(await reads.changeBooking({ booking: id, start: BOOK.start }, chatSession, 'unchanged'));
  expect(result.message).toContain('Google Meet link');
  expect(result.message).toContain('nothing changed');
  expect(calendar.writes.map((entry) => entry.op)).toEqual(['insert']);
  expect(await getBookingRequest(chatSession.id, 'unchanged')).toBeUndefined();
});

it('keeps a same-time change quiet when the booking already stands at the requested time', async () => {
  const main = await mainSession();
  const booked = await reads.book(BOOK, emailSession, 'quiet-original');
  if (booked === ANSWER_LATER) throw new Error('Expected the initial booking to finish');
  const writes = calendar.writes.length;
  const notes = notesIn(main).length;
  const result = await reads.changeBooking(
    { booking: booked.booking, start: BOOK.start },
    emailSession,
    'quiet-change',
  );
  expect(result).toMatchObject({ message: expect.stringContaining('nothing changed') });
  expect(calendar.writes).toHaveLength(writes);
  expect(notesIn(main)).toHaveLength(notes);
});

it('changes only text without rescheduling when an existing booking now overlaps another event', async () => {
  const booked = await reads.book(BOOK, emailSession, 'text-original');
  if (booked === ANSWER_LATER) throw new Error('Expected the initial booking to finish');
  calendar.put({
    calendarId: TEAM,
    id: 'new-overlap',
    start: { dateTime: BOOK.start },
    end: { dateTime: '2026-10-20T13:00:00Z' },
  });
  await expect(
    reads.changeBooking({ booking: booked.booking, title: 'New venue title' }, emailSession, 'text-only-change'),
  ).resolves.not.toBe(ANSWER_LATER);
  expect(calendar.event(TEAM, String(booked.booking))).toMatchObject({
    summary: 'New venue title',
    start: { dateTime: BOOK.start.replace('Z', '.000Z') },
  });
});

it.each(['book', 'change'] as const)(
  'reports an unreadable calendar after a confirmed %s without claiming the meeting was removed',
  async (action) => {
    const loseAccess = () => {
      calendar.calendars.delete(TEAM);
      vi.spyOn(calendar, 'getEvent').mockResolvedValueOnce(undefined);
    };
    let result: Awaited<ReturnType<typeof reads.book>>;
    if (action === 'book') {
      const insert = calendar.insertEvent.bind(calendar);
      vi.spyOn(calendar, 'insertEvent').mockImplementationOnce(async (...args) => {
        const written = await insert(...args);
        loseAccess();
        return written;
      });
      result = await reads.book(BOOK, emailSession, 'write-then-unreadable');
    } else {
      const booked = await reads.book(BOOK, emailSession, 'before-unreadable');
      if (booked === ANSWER_LATER) throw new Error('Expected the initial booking to finish');
      const patch = calendar.patchEvent.bind(calendar);
      vi.spyOn(calendar, 'patchEvent').mockImplementationOnce(async (...args) => {
        await patch(...args);
        loseAccess();
      });
      result = await reads.changeBooking(
        { booking: booked.booking, title: 'Updated venue title' },
        emailSession,
        'write-then-unreadable',
      );
    }
    expect(result).toMatchObject({ message: expect.stringContaining('may or may not have gone through') });
    expect(calendar.live()).toHaveLength(1);
    expect(await getBookingRequest(emailSession.id, 'write-then-unreadable')).toMatchObject({ reported: true });
  },
);
