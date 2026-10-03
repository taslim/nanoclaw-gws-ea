/**
 * Making room (KTD12; R14, R23): when nothing is open for someone in the
 * inner circle or close, the host lists the meetings the assistant arranged
 * with people who matter less, `main` picks one to reschedule, and the time
 * it frees goes to the meeting that needed it. An event the principal
 * created, one someone else organizes, and a meeting with someone at the
 * same or a higher level never move.
 *
 * Drives the real delivery actions, guards, inbox, router and session DBs
 * against an in-memory Gmail and Google Calendar. Only the container runtime
 * and its wake are mocked, and the clock is fixed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_DIR = '/tmp/nanoclaw-test-gws-ea-room';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-gws-ea-room',
    GROUPS_DIR: '/tmp/nanoclaw-test-gws-ea-room/groups',
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

const google = vi.hoisted(() => ({ calendar: undefined as unknown }));
vi.mock('./calendar-api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./calendar-api.js')>();
  const { delegatingCalendarApi } = await import('./testing/fake-calendar.js');
  return {
    ...actual,
    createMeetingsCalendarApi: () =>
      delegatingCalendarApi(() => google.calendar as import('./calendar-api.js').MeetingsCalendarApi),
  };
});

import { getDb } from '../../db/connection.js';
import { getDeliveryAction } from '../../delivery.js';
import { requestWake } from '../../request-wake.js';
import type { Session } from '../../types.js';
import type { Person } from '../gws-ea-people/db.js';
import { getBooking, type Meeting } from './index.js';
import type { StoredEvent } from './testing/fake-calendar.js';
import {
  ADDRESSES,
  ask,
  data,
  meeting,
  meetingSession,
  notes,
  PRINCIPAL,
  refusal,
  setUpScheduling,
  slotsOf,
  tearDownScheduling,
  type Scheduling,
} from './testing/scheduling.js';

/** Monday 5 October 2026, 08:00 in London (BST, UTC+1). */
const NOW = '2026-10-05T07:00:00.000Z';
/** Tuesday 6 October to the end of Friday 9 October, London. */
const WEEK = { window_start: '2026-10-06T00:00:00+01:00', window_end: '2026-10-10T00:00:00+01:00' };

const OUTCOME = 'gws-ea-meetings.outcome';

let scheduling: Scheduling;

beforeEach(async () => {
  vi.useFakeTimers({ now: new Date(NOW), toFake: ['Date'] });
  scheduling = await setUpScheduling(TEST_DIR, google);
  vi.mocked(requestWake).mockClear();
});

afterEach(async () => {
  vi.useRealTimers();
  await tearDownScheduling(TEST_DIR);
});

interface Booked {
  readonly stored: Meeting;
  readonly session: Session;
  readonly eventId: string;
}

/** A meeting the assistant arranged and booked with `people`, at `time` on `date` in London. */
async function bookedAt(
  people: readonly Person[],
  date: string,
  time: string,
  lengthMinutes: number,
  purpose: string,
): Promise<Booked> {
  const answer = data(
    await ask(scheduling.main, 'meeting_arrange', {
      people: people.map((person) => ({ person_id: person.id })),
      calendar_id: PRINCIPAL,
      length_minutes: lengthMinutes,
      ...WEEK,
      purpose,
    }),
  );
  const session = await meetingSession(answer.meeting_id);
  const [slot] = slotsOf(await ask(session, 'meeting_free_time', { meeting_id: answer.meeting_id, date, time }));
  data(await ask(session, 'meeting_book', { meeting_id: answer.meeting_id, slot_id: slot.slot_id }));
  data(await ask(session, 'meeting_outcome', { meeting_id: answer.meeting_id, outcome: 'booked' }));
  const booking = await getBooking(String(answer.meeting_id));
  if (!booking) throw new Error('not booked');
  expect(booking.start_at.slice(0, 16)).toBe(new Date(`${date}T${time}:00+01:00`).toISOString().slice(0, 16));
  return { stored: await meeting(answer.meeting_id), session, eventId: booking.event_id };
}

/** One of the principal's own events, created by them, with the people given. */
function own(id: string, start: string, end: string, attendees: readonly string[] = []): StoredEvent {
  return {
    calendarId: PRINCIPAL,
    id,
    iCalUID: `${id}@google.com`,
    status: 'confirmed',
    summary: 'Their own plans',
    organizer: { email: PRINCIPAL },
    attendees: [
      { email: PRINCIPAL, organizer: true, responseStatus: 'accepted' },
      ...attendees.map((email) => ({ email, responseStatus: 'accepted' })),
    ],
    start: { dateTime: start },
    end: { dateTime: end },
  };
}

/** Dana, who is close, needs half an hour on Thursday morning, London. */
async function danaNeedsRoom(windowEnd = '2026-10-08T12:00:00+01:00', lengthMinutes = 30) {
  const answer = data(
    await ask(scheduling.main, 'meeting_arrange', {
      people: [{ person_id: scheduling.people.dana.id }],
      calendar_id: PRINCIPAL,
      length_minutes: lengthMinutes,
      window_start: '2026-10-08T09:00:00+01:00',
      window_end: windowEnd,
      purpose: 'Catch-up',
    }),
  );
  const session = await meetingSession(answer.meeting_id);
  const offered = data(await ask(session, 'meeting_free_time', { meeting_id: answer.meeting_id }));
  expect(offered.slots).toEqual([]);
  expect(String(offered.message)).toMatch(/needs-room/);
  data(await ask(session, 'meeting_outcome', { meeting_id: answer.meeting_id, outcome: 'needs-room' }));
  const [note, ...more] = notes(scheduling.main, OUTCOME).filter((c) => c.note?.outcome === 'needs-room');
  expect(more).toEqual([]);
  return { stored: await meeting(answer.meeting_id), session, note };
}

interface Candidate {
  readonly meeting_id: string;
  readonly calendar_id: string;
  readonly event_id: string;
  readonly start: string;
  readonly end: string;
}

describe('AE3: making room for someone close', () => {
  it('moves the coffee the assistant arranged with Pat, and gives its time to Dana', async () => {
    const { people } = scheduling;
    const coffee = await bookedAt([people.pat], '2026-10-08', '10:00', 30, 'Coffee');
    scheduling.calendar.put(own('evt-early', '2026-10-08T08:00:00Z', '2026-10-08T09:00:00Z'));
    scheduling.calendar.put(own('evt-late', '2026-10-08T09:30:00Z', '2026-10-08T11:00:00Z'));

    const dana = await danaNeedsRoom();
    const candidates = dana.note.note?.candidates as Candidate[];
    expect(candidates).toEqual([
      expect.objectContaining({
        meeting_id: coffee.stored.id,
        calendar_id: PRINCIPAL,
        event_id: coffee.eventId,
        start: '2026-10-08T09:00:00.000Z',
        end: '2026-10-08T09:30:00.000Z',
      }),
    ]);
    expect(dana.note.text).toContain('Pat Lee');
    expect(dana.note.text).toContain('making_room_for');

    // main moves the coffee; Pat's conversation carries the new job.
    const moving = data(
      await ask(scheduling.main, 'meeting_reschedule', {
        calendar_id: PRINCIPAL,
        event_id: coffee.eventId,
        window_start: '2026-10-08T00:00:00+01:00',
        window_end: '2026-10-10T00:00:00+01:00',
        purpose: 'Moving our coffee',
        making_room_for: dana.stored.id,
      }),
    );
    const patSession = await meetingSession(moving.meeting_id);
    expect(patSession.id).toBe(coffee.session.id);

    // The time freed for Dana is never offered to Pat.
    const forPat = slotsOf(await ask(patSession, 'meeting_free_time', { meeting_id: moving.meeting_id }));
    expect(forPat.length).toBeGreaterThan(0);
    for (const slot of forPat) {
      expect(slot.start < '2026-10-08T09:30:00.000Z' && slot.end > '2026-10-08T09:00:00.000Z').toBe(false);
    }
    const friday = forPat.find((slot) => slot.start.startsWith('2026-10-09'));
    if (!friday) throw new Error('no Friday time for the coffee');
    data(await ask(patSession, 'meeting_book', { meeting_id: moving.meeting_id, slot_id: friday.slot_id }));
    expect(scheduling.calendar.event(PRINCIPAL, coffee.eventId)?.start?.dateTime).toBe(friday.start);

    // Dana's meeting holds the freed time at once, and its conversation hears of it.
    const [room, ...moreRooms] = notes(dana.session, 'gws-ea-meetings.room');
    expect(moreRooms).toEqual([]);
    expect(room.sender).toBe('system');
    const slotId = String(room.note?.slot_id);
    expect(room.text).toContain(slotId);
    const held = scheduling.calendar
      .live(PRINCIPAL)
      .filter((event) => event.tags?.gwsEaRole === 'hold' && event.tags.gwsEaMeeting === dana.stored.id);
    expect(held.map((event) => event.start?.dateTime)).toEqual(['2026-10-08T09:00:00.000Z']);
    expect((await meeting(dana.stored.id)).nudge_at).not.toBeNull();
    expect(vi.mocked(requestWake)).toHaveBeenCalledWith(
      expect.objectContaining({ id: dana.session.id }),
      'inbound-message',
    );

    data(await ask(patSession, 'meeting_outcome', { meeting_id: moving.meeting_id, outcome: 'booked' }));

    // Dana agrees: the booking note names the meeting that moved for her.
    data(await ask(dana.session, 'meeting_book', { meeting_id: dana.stored.id, slot_id: slotId }));
    data(await ask(dana.session, 'meeting_outcome', { meeting_id: dana.stored.id, outcome: 'booked' }));
    const danaEvent = scheduling.calendar
      .live(PRINCIPAL)
      .find((event) => event.tags?.gwsEaRole === 'booking' && event.tags.gwsEaMeeting === dana.stored.id);
    expect(danaEvent?.attendees?.map((attendee) => attendee.email)).toEqual([ADDRESSES.dana]);
    expect(danaEvent?.start?.dateTime).toBe('2026-10-08T09:00:00.000Z');
    const booked = notes(scheduling.main, OUTCOME).find(
      (c) => c.note?.outcome === 'booked' && c.note.meeting_id === dana.stored.id,
    );
    expect(booked?.note).toMatchObject({
      made_room_by: { meeting_id: coffee.stored.id, purpose: 'Coffee', moved_to: { start: friday.start } },
    });
    expect(booked?.text).toContain('Pat Lee');
    expect(booked?.text).toMatch(/moved/);
  });
});

describe('making room', () => {
  it('moves nothing when the only thing in the way is an event the principal created, and main gets one recommendation to give', async () => {
    scheduling.calendar.put(own('evt-early', '2026-10-08T08:00:00Z', '2026-10-08T09:00:00Z'));
    scheduling.calendar.put(own('evt-theirs', '2026-10-08T09:00:00Z', '2026-10-08T09:30:00Z', [ADDRESSES.pat]));
    scheduling.calendar.put(own('evt-late', '2026-10-08T09:30:00Z', '2026-10-08T11:00:00Z'));

    const dana = await danaNeedsRoom();
    expect(dana.note.note?.candidates).toEqual([]);
    expect(dana.note.text).toMatch(/move nothing/i);
    expect(dana.note.text).toMatch(/one recommendation/);

    const message = refusal(
      await ask(scheduling.main, 'meeting_reschedule', {
        calendar_id: PRINCIPAL,
        event_id: 'evt-theirs',
        ...WEEK,
        purpose: 'Making room',
        making_room_for: dana.stored.id,
      }),
    );
    expect(message).toMatch(/principal/);
    expect(scheduling.calendar.writes).toEqual([]);
    const row = await getDb().get<{ n: number }>("SELECT COUNT(*) AS n FROM gws_ea_meetings WHERE kind = 'reschedule'");
    expect(row?.n).toBe(0);
    expect((await meeting(dana.stored.id)).state).toBe('active');
  });

  it('never offers a meeting someone else now organizes, or one with someone at the same or a higher level', async () => {
    const { people } = scheduling;
    const withPat = await bookedAt([people.pat], '2026-10-08', '09:00', 60, 'Coffee with Pat');
    const withLee = await bookedAt([people.lee], '2026-10-08', '10:00', 60, 'Lunch with Lee');
    await bookedAt([people.jo], '2026-10-08', '11:00', 60, 'Family call');
    await bookedAt([people.pat, people.lee], '2026-10-08', '12:00', 60, 'Three of us');
    scheduling.calendar.put(own('evt-focus', '2026-10-08T12:00:00Z', '2026-10-08T13:00:00Z'));
    // Pat took the coffee over: the assistant's booking, organized by Pat now.
    const coffee = scheduling.calendar.event(PRINCIPAL, withPat.eventId);
    if (!coffee) throw new Error('the coffee is not on the calendar');
    scheduling.calendar.put({ ...coffee, organizer: { email: ADDRESSES.pat } });

    const dana = await danaNeedsRoom('2026-10-08T14:00:00+01:00', 60);
    expect(dana.note.note?.candidates).toEqual([]);

    const sameLevel = refusal(
      await ask(scheduling.main, 'meeting_reschedule', {
        calendar_id: PRINCIPAL,
        event_id: withLee.eventId,
        ...WEEK,
        purpose: 'Making room',
        making_room_for: dana.stored.id,
      }),
    );
    expect(sameLevel).toMatch(/Lee Wu/);
    expect((await meeting(withLee.stored.id)).state).toBe('booked');
  });

  it('lists the meetings that could move again when an amended meeting still needs room, once per report', async () => {
    const { people } = scheduling;
    const coffee = await bookedAt([people.pat], '2026-10-08', '10:00', 30, 'Coffee');
    const tea = await bookedAt([people.pat], '2026-10-09', '10:00', 30, 'Tea');
    // Thursday and Friday mornings are full around them.
    for (const day of ['2026-10-08', '2026-10-09']) {
      scheduling.calendar.put(own(`evt-early-${day}`, `${day}T08:00:00Z`, `${day}T09:00:00Z`));
      scheduling.calendar.put(own(`evt-late-${day}`, `${day}T09:30:00Z`, `${day}T11:00:00Z`));
    }
    const dana = await danaNeedsRoom();
    expect((dana.note.note?.candidates as Candidate[]).map((c) => c.meeting_id)).toEqual([coffee.stored.id]);

    // main moves the meeting to Friday morning, where nothing is open either: it still needs room.
    data(
      await ask(scheduling.main, 'meeting_amend', {
        meeting_id: dana.stored.id,
        window_start: '2026-10-09T09:00:00+01:00',
        window_end: '2026-10-09T12:00:00+01:00',
      }),
    );
    expect(data(await ask(dana.session, 'meeting_free_time', { meeting_id: dana.stored.id })).slots).toEqual([]);
    const report = { meeting_id: dana.stored.id, outcome: 'needs-room' };
    data(await ask(dana.session, 'meeting_outcome', report, 'req-needs-room-again'));

    const needsRoom = () => notes(scheduling.main, OUTCOME).filter((c) => c.note?.outcome === 'needs-room');
    expect(needsRoom()).toHaveLength(2);
    // main hears of it again, with what could move in the new window.
    expect((needsRoom()[1].note?.candidates as Candidate[]).map((c) => c.meeting_id)).toEqual([tea.stored.id]);

    // The host stopped after the note but before it recorded the answer: the replay writes no third note.
    await getDb().run('DELETE FROM gws_ea_meeting_requests WHERE request_id = ?', 'req-needs-room-again');
    await getDeliveryAction('meeting_outcome')?.(
      { action: 'meeting_outcome', requestId: 'req-needs-room-again', ...report },
      dana.session,
    );
    expect(needsRoom()).toHaveLength(2);
    expect((await meeting(dana.stored.id)).state).toBe('active');
  });
});
