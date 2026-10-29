import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ROOT = vi.hoisted(() => `/tmp/booking-reads-${process.pid}`);
vi.mock('../../config.js', async (original) => ({
  ...(await original<typeof import('../../config.js')>()),
  DATA_DIR: ROOT,
}));
vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn(async () => true) }));

import { getDb } from '../../db/connection.js';
import * as bookingStorage from './bookings-db.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { resolveSession } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { replacePrincipalCalendars } from '../gws-ea-inbox/db.js';
import { recordThreadAddresses, recordAuthenticatedThreadSender } from '../gws-ea-inbox/thread-map.js';
import { platformMembers } from '../gws-ea-chats/testing/chat-delivery-fixture.js';
import { setChatCalendar } from '../gws-ea-chats/handoffs.js';
import { placeInMatter, openMatter } from '../gws-ea-matters/db.js';
import type { FakeCalendar } from './testing/fake-calendar.js';
import {
  answerData,
  BOOK,
  cleanBookingFixture,
  LATER,
  mainSession,
  MIRA,
  notesIn,
  PRINCIPAL,
  seedBookingFixture,
  responseIn,
  TEAM,
  type BookingTools,
} from './testing/booking-fixture.js';
import { setThreadBookingCalendar } from './thread-calendar.js';
import { getBooking, getBookingRequest } from './bookings-db.js';
import * as mainNotesModule from '../gws-ea-profile/main-note.js';
import { addPrivateValue } from '../gws-ea-privacy/db.js';
import { recordChatClearances } from '../gws-ea-privacy/clearance.js';
import { GoogleApiError } from '../gws-ea-inbox/gmail-api.js';
import { GoogleNotSignedInError } from '../gws-ea-google/tokens.js';
import { log } from '../../log.js';
import { ANSWER_LATER } from '../../cli/delivery-action.js';
import { bookingSurfaceFor, resolveBookingSurface } from './booking-surface.js';
import '../gws-ea-whereabouts/index.js';
import { addPlace, addStay, setBase, setPlacePair, setRhythm } from '../gws-ea-whereabouts/db.js';
import { addPerson } from '../gws-ea-people/db.js';
import { setSchedulingPreference } from '../gws-ea-preferences/db.js';

const RANGE = { from: '2026-10-20T09:00:00Z', to: '2026-10-20T17:00:00Z', minutes: 30, timezone: 'Europe/Paris' };
let calendar: FakeCalendar;
let thread: string;
let chat: string;
let matterId: string;
let emailSession: Session;
let chatSession: Session;
let reads: BookingTools;

beforeEach(async () => {
  ({ calendar, thread, chat, matterId, emailSession, chatSession, tools: reads } = await seedBookingFixture());
});
afterEach(cleanBookingFixture);

describe('outward availability in the principal’s days', () => {
  const november = { from: '2026-11-12T07:00:00Z', to: '2026-11-12T21:00:00Z', minutes: 30 };
  async function home() {
    await getDb().run("UPDATE gws_ea_profile SET principal_timezone='America/Los_Angeles' WHERE singleton=1");
    const place = await addPlace({ label: 'Home', locality: 'San Francisco', home: true });
    await setBase({ placeId: place.id });
    return place;
  }

  it('offers Brussels time on both surfaces, without revealing the stay when an in-person San Francisco offer cannot fit', async () => {
    await home();
    await addStay({
      locality: 'Brussels',
      zone: 'Europe/Brussels',
      start: '2026-11-10',
      end: '2026-11-15',
      source: 'said',
      certainty: 'certain',
    });
    const sf = await addPlace({ label: 'Remy’s office', locality: 'San Francisco', zone: 'America/Los_Angeles' });
    for (const session of [emailSession, chatSession]) {
      const remote = await reads.freeTime(november, session, 'brussels');
      expect(remote.windows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ principal_time: expect.stringContaining('CET'), zone: 'Europe/Brussels' }),
        ]),
      );
      const local = await reads.freeTime({ ...november, place: sf.id }, session, 'san-francisco');
      expect(local.windows).toEqual([]);
      expect(JSON.stringify(local)).not.toMatch(/Brussels|Nov 10|Nov 15|stay|trip/iu);
    }
  });

  it('keeps tentative stays as window notes, and fits a Lagos stay on Pacific hours', async () => {
    await home();
    await addStay({
      locality: 'New York',
      zone: 'America/New_York',
      start: '2026-11-10',
      end: '2026-11-15',
      source: 'said',
      certainty: 'tentative',
    });
    const tentative = await reads.freeTime(november, emailSession, 'tentative');
    expect(tentative.windows).toEqual(
      expect.arrayContaining([expect.objectContaining({ fit_notes: ['tentative stay'] })]),
    );
    await addStay({
      locality: 'Lagos',
      zone: 'Africa/Lagos',
      start: '2026-11-12',
      end: '2026-11-12',
      source: 'said',
      certainty: 'certain',
      workingHours: 'home',
    });
    const lagos = await reads.freeTime(november, emailSession, 'home-hours');
    expect(lagos.windows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ start: '2026-11-12T17:00:00.000Z', fit: 'acceptable', zone: 'Africa/Lagos' }),
      ]),
    );
    expect(lagos.message).toContain('outside usual hours');
  });

  it('offers each instant once across a stay’s zone boundary, using the clock in effect at that instant', async () => {
    await home();
    await addStay({
      locality: 'Brussels',
      zone: 'Europe/Brussels',
      start: '2026-11-12',
      end: '2026-11-12',
      source: 'said',
      certainty: 'certain',
    });
    const answer = await reads.freeTime(
      { from: '2026-11-11T20:00:00Z', to: '2026-11-12T10:00:00Z', minutes: 30 },
      emailSession,
      'zone-boundary',
    );
    expect(answer.windows).toEqual([
      expect.objectContaining({
        start: '2026-11-11T20:00:00.000Z',
        end: '2026-11-11T23:00:00.000Z',
        zone: 'America/Los_Angeles',
      }),
      expect.objectContaining({
        start: '2026-11-12T06:00:00.000Z',
        end: '2026-11-12T08:00:00.000Z',
        zone: 'Europe/Brussels',
      }),
      expect.objectContaining({
        start: '2026-11-12T08:00:00.000Z',
        end: '2026-11-12T10:00:00.000Z',
        zone: 'Europe/Brussels',
      }),
    ]);
  });

  it('counts known driving after a Mountain View meeting as busy and leaves an unknown pair visible with a note', async () => {
    await home();
    const mv = await addPlace({
      label: 'Mountain View office',
      locality: 'Mountain View',
      zone: 'America/Los_Angeles',
    });
    const sf = await addPlace({ label: 'Remy’s office', locality: 'San Francisco', zone: 'America/Los_Angeles' });
    await setRhythm({ weekdays: ['thu'], placeId: mv.id, start: '09:00', end: '17:00' });
    await setPlacePair({ fromPlaceId: mv.id, toPlaceId: sf.id, mode: 'drive', minutes: 60, source: 'learned' });
    calendar.put({
      calendarId: PRINCIPAL,
      id: 'private-meeting',
      summary: 'Secret project',
      location: mv.label,
      start: { dateTime: '2026-11-12T18:00:00Z' },
      end: { dateTime: '2026-11-12T19:00:00Z' },
    });
    const range = { from: '2026-11-12T18:00:00Z', to: '2026-11-12T22:00:00Z', minutes: 30 };
    const known = await reads.freeTime({ ...range, place: sf.id }, emailSession, 'drive');
    expect(known.windows).toEqual([
      expect.objectContaining({ start: '2026-11-12T20:00:00.000Z', end: '2026-11-12T22:00:00.000Z' }),
    ]);
    const unknown = await reads.freeTime({ ...range, place: 'An unfamiliar cafe' }, emailSession, 'unknown-drive');
    expect(unknown.windows).toEqual([
      expect.objectContaining({
        start: '2026-11-12T19:00:00.000Z',
        fit_notes: ['travel from the previous place unknown'],
      }),
    ]);
    expect(JSON.stringify(known)).not.toMatch(/Secret project|private-meeting|Mountain View office/u);
  });

  it('shares deciding facts only for authenticated senders, main-named people and current chat members', async () => {
    const juno = 'juno.hale@outside.example';
    const remy = 'remy.vance@outside.example';
    await addPerson({
      name: 'Private record name',
      level: 'close',
      source: 'principal',
      basis: 'Private relationship basis',
      identity: `email:${juno}`,
    });
    await recordThreadAddresses(thread, [juno, remy, 'copied@outside.example'], 'message', new Date().toISOString());
    await recordAuthenticatedThreadSender(thread, juno, new Date().toISOString());
    await recordThreadAddresses(thread, [remy], 'main', new Date().toISOString());
    await recordThreadAddresses(thread, ['body@outside.example'], 'written', new Date().toISOString());
    await setSchedulingPreference({
      kind: 'meeting-length',
      meetingKind: 'intro',
      minutes: 20,
      source: 'principal',
      basis: 'Principal’s recorded introduction length',
    });
    calendar.put({
      calendarId: PRINCIPAL,
      id: 'old-private-meeting',
      summary: 'Private invitation',
      organizer: { email: PRINCIPAL },
      attendees: [{ email: juno }],
      start: { dateTime: '2026-09-01T12:00:00Z' },
      end: { dateTime: '2026-09-01T12:20:00Z' },
    });
    const answer = await reads.freeTime({ ...RANGE, minutes: 20 }, emailSession, 'facts');
    expect(answer.people).toEqual([
      {
        email: juno,
        relationship: 'close to the principal',
        has_people_record: true,
        meetings: 1,
        met_in_six_months: true,
      },
      { email: remy, relationship: null, has_people_record: false, meetings: 0, met_in_six_months: false },
    ]);
    expect(answer.meeting_lengths).toEqual([{ kind: 'intro', minutes: 20 }]);
    expect(JSON.stringify(answer)).not.toMatch(
      /Private record name|Private relationship basis|Private invitation|2026-09-01|old-private-meeting|copied@|body@/u,
    );
    const booked = answerData(await reads.book({ ...BOOK, title: 'Morgan and Juno' }, emailSession, 'facts-book'));
    expect(booked.people).toEqual(answer.people);
    expect(booked.meeting_lengths).toEqual(answer.meeting_lengths);
    const moved = answerData(
      await reads.changeBooking({ booking: booked.booking, start: LATER }, emailSession, 'facts-move'),
    );
    expect(moved.people).toEqual(answer.people);
    expect(moved).toMatchObject({ organizer: 'the principal', move: 'change' });
    expect(JSON.stringify(moved)).not.toMatch(/Private record name|Private invitation|2026-09-01|copied@|body@/u);
    const chatAnswer = await reads.freeTime(RANGE, chatSession, 'chat-facts');
    expect(chatAnswer.people).toEqual([expect.objectContaining({ email: MIRA })]);
  });

  it('uses the chosen kind on both surfaces while booking keeps its clash-only check', async () => {
    for (const [meetingKind, minutes] of [
      ['default', 15],
      ['intro', 60],
    ] as const)
      await setSchedulingPreference({
        kind: 'buffer',
        meetingKind,
        minutes,
        source: 'principal',
        basis: 'Morgan’s preference',
      });
    await setSchedulingPreference({
      kind: 'preferred-time',
      meetingKind: 'intro',
      start: '12:00',
      end: '13:00',
      source: 'principal',
      basis: 'Morgan’s preference',
    });
    calendar.put({
      calendarId: PRINCIPAL,
      id: 'busy',
      start: { dateTime: '2026-10-20T10:00:00Z' },
      end: { dateTime: '2026-10-20T11:00:00Z' },
    });
    const range = { from: '2026-10-20T09:00:00Z', to: '2026-10-20T13:00:00Z', minutes: 30 };
    for (const session of [emailSession, chatSession]) {
      const chosen = await reads.freeTime({ ...range, kind: 'intro' }, session, 'intro');
      expect(chosen.windows).toEqual([
        expect.objectContaining({
          start: '2026-10-20T12:00:00.000Z',
          end: '2026-10-20T13:00:00.000Z',
          fit: 'preferred',
        }),
      ]);
      const fallback = await reads.freeTime({ ...range, kind: 'unrecorded' }, session, 'fallback');
      expect(fallback.windows).toEqual((await reads.freeTime(range, session, 'default')).windows);
      expect(fallback.windows).toEqual(
        expect.arrayContaining([expect.objectContaining({ start: '2026-10-20T11:15:00.000Z' })]),
      );
    }
    const booked = answerData(
      await reads.book(
        { ...BOOK, start: '2026-10-20T11:00:00Z', title: 'Morgan and Remy' },
        emailSession,
        'clash-only',
      ),
    );
    expect(booked.start).toBe('2026-10-20T11:00:00.000Z');
  });

  it('retains valid windows when the history read is unavailable, with unknown counts rather than invented zeros', async () => {
    await recordAuthenticatedThreadSender(thread, 'juno.hale@outside.example', new Date().toISOString());
    vi.spyOn(calendar, 'listEventDetails').mockRejectedValue(new Error('History cannot be read'));
    const answer = await reads.freeTime(RANGE, emailSession, 'history-unavailable');
    expect(answer.windows).not.toEqual([]);
    expect(answer.people).toEqual([
      {
        email: 'juno.hale@outside.example',
        relationship: null,
        has_people_record: false,
        meetings: null,
        met_in_six_months: null,
      },
    ]);
    expect(answer.message).toContain('meeting history unavailable');
    expect(answer.message).not.toContain('0 meetings');
  });

  it('keeps a remote meeting across a commute-rhythm boundary when its clock and availability do not change', async () => {
    await home();
    const mv = await addPlace({
      label: 'Mountain View office',
      locality: 'Mountain View',
      zone: 'America/Los_Angeles',
    });
    await setRhythm({ weekdays: ['thu'], placeId: mv.id, start: '09:00', end: '17:00' });
    const answer = await reads.freeTime(
      { from: '2026-11-12T16:45:00Z', to: '2026-11-12T17:15:00Z', minutes: 30 },
      emailSession,
      'remote-rhythm',
    );
    expect(answer.windows).toEqual([
      expect.objectContaining({ start: '2026-11-12T16:45:00.000Z', end: '2026-11-12T17:15:00.000Z' }),
    ]);
  });

  it.each(['tool retry', 'resume sweep'] as const)(
    'rechecks current chat identities before returning a recovered booking’s people facts (%s)',
    async (mode) => {
      await mainSession();
      vi.spyOn(mainNotesModule, 'writeNoteForMain').mockRejectedValueOnce(new Error('Main note interrupted'));
      expect(await reads.book(BOOK, chatSession, 'recover-people')).toBe(ANSWER_LATER);
      expect(await getBookingRequest(chatSession.id, 'recover-people')).toMatchObject({
        applied: true,
        reported: false,
      });
      platformMembers([{ key: 'whatsapp:11', name: 'Morgan', isPrincipal: true }]);
      let answer: unknown;
      if (mode === 'tool retry') answer = answerData(await reads.book(BOOK, chatSession, 'recover-people'));
      else {
        await reads.resumePending();
        const frame = responseIn(chatSession, 'recover-people');
        expect(frame?.ok).toBe(true);
        answer = frame?.ok ? frame.data : undefined;
      }
      expect(answer).toMatchObject({ people: [] });
      expect(JSON.stringify(answer)).not.toContain(MIRA);
      expect(calendar.writes.map((write) => write.op)).toEqual(['insert']);
    },
  );
});

it('offers the same windows in text with both-zone labels from either real surface, including the booking calendar', async () => {
  await recordAuthenticatedThreadSender(thread, MIRA, new Date().toISOString());
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
      zone: 'UTC',
      their_time: 'Tuesday, Oct 20, 11:00 AM–2:00 PM CEST',
      fit: 'acceptable',
    },
    {
      start: '2026-10-20T13:00:00.000Z',
      end: '2026-10-20T14:00:00.000Z',
      principal_time: 'Tuesday, Oct 20, 1:00–2:00 PM UTC',
      zone: 'UTC',
      their_time: 'Tuesday, Oct 20, 3:00–4:00 PM CEST',
      fit: 'acceptable',
    },
    {
      start: '2026-10-20T15:00:00.000Z',
      end: '2026-10-20T17:00:00.000Z',
      principal_time: 'Tuesday, Oct 20, 3:00–5:00 PM UTC',
      zone: 'UTC',
      their_time: 'Tuesday, Oct 20, 5:00–7:00 PM CEST',
      fit: 'acceptable',
    },
  ]);
  expect(email.message).toContain("Free for 30 minutes: any start that ends by a window's end.");
  expect(email.message).toContain('for them, Tuesday, Oct 20, 11:00 AM–2:00 PM CEST');
  expect(JSON.stringify(email)).not.toMatch(
    /Private therapy|Private review|private-principal|private-booking-calendar/,
  );
  expect(details).toHaveBeenCalled();
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
  const listing = vi.spyOn(calendar, 'listLocatedEvents');
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
  const listing = vi.spyOn(calendar, 'listLocatedEvents');
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
  const email = await bookingSurfaceFor({ kind: 'thread', key: thread }, undefined);
  const spoken = await bookingSurfaceFor({ kind: 'chat', key: chat }, undefined);
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
  const surface = await resolveBookingSurface(session);
  expect(surface.writer).toBe('job');
  expect(await surface.privacyFor([MIRA])).toEqual({ chatId: chat });
  expect(await surface.privacyFor([MIRA, 'guest@outside.example'])).toEqual({});
  platformMembers([{ key: 'whatsapp:11', name: 'Juno', isPrincipal: true }]);
  await surface.beforeWrite();
  expect(await surface.privacyFor([MIRA])).toEqual({});
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

async function booked(session = chatSession): Promise<string> {
  return String(answerData(await reads.book(BOOK, session, 'initial')).booking);
}

it.each([undefined, { dateTime: 'not an instant' }, { date: 'not a date' }])(
  'refuses an owned event with an unreadable start through the booking contract (%j)',
  async (start) => {
    const id = await booked(emailSession);
    const stored = calendar.event(TEAM, id);
    if (!stored) throw new Error('The booked event is absent');
    calendar.put({ ...stored, start });
    await expect(
      reads.changeBooking({ booking: id, title: 'Morgan and Remy' }, emailSession, 'unreadable-start'),
    ).rejects.toThrow('The booking has no readable time. Ask main with tell_main.');
    expect(calendar.writes.map((write) => write.op)).toEqual(['insert']);
  },
);

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
      'Booked a meeting with mira@example.com for Tuesday, Oct 20, 12:00–12:30 PM UTC (30 minutes), by video call',
    );
    expect(notesIn(main)[0]).toContain('untrusted');
    expect(notesIn(main)[0]).toContain('Venue visit');
    expect(notesIn(main)[0]).toContain('Findings for 2026-10-20:');
    expect(
      await getDb().get(
        "SELECT matter_id FROM gws_ea_matter_links WHERE kind='event' AND reference=?",
        `${TEAM}/${event.id}`,
      ),
    ).toEqual({ matter_id: matterId });
  },
);

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
  expect(notesIn(main)[1]).toContain('Thursday, Oct 22, 1:00–1:30 PM UTC');
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
  await expect(action(content, chatSession, 'race')).rejects.toThrow('changed the meeting since it was checked');
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
      state === 'taken' ? 'no longer free' : 'changed the meeting since it was checked',
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
    'Its answer will reach you',
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

describe.each(['thread', 'chat'] as const)('a %s booking', (kind) => {
  it.each(['missing-label', 'foreign-label', 'removed'] as const)(
    'is neither changed nor cancelled when the stored event is %s',
    async (state) => {
      const session = kind === 'thread' ? emailSession : chatSession;
      const id = await booked(session);
      const event = calendar.event(TEAM, id);
      if (!event) throw new Error('No event');
      const label = kind === 'thread' ? 'gwsEaThread' : 'gwsEaChat';
      calendar.put({
        ...event,
        ...(state === 'removed'
          ? { status: 'cancelled' }
          : { tags: { gwsEaRole: 'booking', ...(state === 'foreign-label' ? { [label]: 'another-owner' } : {}) } }),
      });
      await expect(reads.changeBooking({ booking: id, start: LATER }, session, 'not-owned')).rejects.toThrow(
        state === 'removed' ? 'no longer on the calendar' : `That event no longer belongs to this ${kind}.`,
      );
      if (state !== 'removed')
        await expect(reads.cancelBooking({ booking: id }, session, 'not-owned-cancel')).rejects.toThrow(
          `That event no longer belongs to this ${kind}.`,
        );
      expect(calendar.writes.map((entry) => entry.op)).toEqual(['insert']);
    },
  );
});

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
    'Its answer will reach you',
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
    'UPDATE gws_ea_booking_requests SET carried_over=1,event_etag=NULL,request_json=? WHERE session_id=? AND request_id=?',
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
  await expect(reads.book(BOOK, chatSession, 'carry-book')).rejects.toThrow('This booking was not made');
  await expect(reads.book(BOOK, chatSession, 'carry-book')).rejects.toThrow('This booking was not made');
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

it.each(['book', 'change'] as const)('checks a live %s once, then writes what it checked', async (action) => {
  const id = action === 'change' ? await booked(emailSession) : undefined;
  const listing = vi.spyOn(calendar, 'listLocatedEvents');
  const calendars = vi.spyOn(calendar, 'getCalendar');
  answerData(
    id === undefined
      ? await reads.book(BOOK, emailSession, 'checked-once')
      : await reads.changeBooking({ booking: id, start: LATER }, emailSession, 'checked-once'),
  );
  expect(listing.mock.calls.map(([calendarId]) => calendarId).sort()).toEqual([PRINCIPAL, TEAM].sort());
  expect(calendars).toHaveBeenCalledTimes(1);
});

it.each(['overlaps another event', 'has started'] as const)(
  'replays an unconfirmed title-only change whose own slot now %s',
  async (state) => {
    const id = await booked(emailSession);
    calendar.failNext({ op: 'patch', error: new Error('Network timed out'), afterApplying: false });
    const content = { booking: id, title: 'New venue title' };
    expect(await reads.changeBooking(content, emailSession, 'title-replay')).toBe(ANSWER_LATER);
    if (state === 'has started') vi.setSystemTime(Date.parse(BOOK.start) + 60_000);
    else
      calendar.put({
        calendarId: TEAM,
        id: 'new-overlap',
        start: { dateTime: BOOK.start },
        end: { dateTime: '2026-10-20T13:00:00Z' },
      });
    expect(answerData(await reads.changeBooking(content, emailSession, 'title-replay')).message).toContain(
      'The booking stands at',
    );
    expect(calendar.event(TEAM, id)).toMatchObject({ summary: 'New venue title' });
    expect(calendar.writes.map((entry) => entry.op)).toEqual(['insert', 'patch']);
  },
);

it.each([
  ['a booking in its one open matter', 'booked', true],
  ['a booking whose chat is in two open matters', 'two matters', false],
  ['a booking removed before it was confirmed', 'removed', false],
] as const)('places and names the matter’s other conversations to brief only for %s', async (_name, state, named) => {
  const main = await mainSession();
  await placeInMatter(matterId, [{ kind: 'thread', reference: thread }]);
  if (state === 'two matters')
    await openMatter({ title: 'Cabin', openLoop: 'Choose dates', links: [{ kind: 'chat', reference: chat }] });
  if (state === 'removed') {
    calendar.failNext({ op: 'insert', error: new Error('Network timed out'), afterApplying: true });
    expect(await reads.book(BOOK, chatSession, 'brief')).toBe(ANSWER_LATER);
    calendar.put({ ...calendar.live()[0], status: 'cancelled' });
    await expect(reads.book(BOOK, chatSession, 'brief')).rejects.toThrow('no longer on the calendar');
  } else answerData(await reads.book(BOOK, chatSession, 'brief'));
  expect(notesIn(main)).toHaveLength(1);
  if (named) expect(notesIn(main)[0]).toContain(`Its matter's other conversations, to brief: thread ${thread}.`);
  else expect(notesIn(main)[0]).not.toContain('other conversations');
  expect(
    await getDb().all(
      "SELECT matter_id FROM gws_ea_matter_links WHERE kind='event' AND reference=?",
      `${TEAM}/${calendar.events[0].id}`,
    ),
  ).toEqual(named ? [{ matter_id: matterId }] : []);
});
