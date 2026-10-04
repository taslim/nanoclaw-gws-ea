/**
 * external-email asks main (KTD2, KTD3; R42, R43): a curveball goes to main
 * as a typed question, and nothing goes to the other side meanwhile; main
 * answers with `meeting_amend`, or takes a conversation over with
 * `meeting_arrange`; a question main leaves open is followed up with main.
 *
 * Drives the real delivery actions, guards, inbox, router, follow-through
 * timer and session DBs against an in-memory Gmail and Google Calendar. Only
 * the container runtime and its wake are mocked, and the clock is moved by hand.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_DIR = '/tmp/nanoclaw-test-gws-ea-ask';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-gws-ea-ask',
    GROUPS_DIR: '/tmp/nanoclaw-test-gws-ea-ask/groups',
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

import type { Session } from '../../types.js';
import { addPrivateValue } from '../gws-ea-privacy/db.js';
import { getBooking, runFollowThrough, type Meeting } from './index.js';
import {
  ADDRESSES,
  ask,
  contents,
  data,
  meeting,
  meetingSession,
  notes,
  PRINCIPAL,
  refusal,
  reply,
  setUpScheduling,
  slotsOf,
  tearDownScheduling,
  type Scheduling,
} from './testing/scheduling.js';

/** Monday 5 October 2026, 08:00 in London (BST, UTC+1). */
const NOW = '2026-10-05T07:00:00.000Z';
/** Tuesday 6 October to the end of Friday 9 October, London. */
const WEEK = { window_start: '2026-10-06T00:00:00+01:00', window_end: '2026-10-10T00:00:00+01:00' };
/** The week after: Monday 12 to the end of Friday 16 October. */
const WEEK_AFTER = { window_start: '2026-10-12T00:00:00+01:00', window_end: '2026-10-17T00:00:00+01:00' };

const ASK = 'gws-ea-meetings.ask';
const JANE = 'jane@partner.example';

let scheduling: Scheduling;

beforeEach(async () => {
  vi.useFakeTimers({ now: new Date(NOW), toFake: ['Date'] });
  scheduling = await setUpScheduling(TEST_DIR, google);
});

afterEach(async () => {
  vi.useRealTimers();
  await tearDownScheduling(TEST_DIR);
});

/** The clock reaches `iso`; the inbox polls, then follow-through runs, as the host's timers do each minute. */
async function reach(iso: string): Promise<void> {
  vi.setSystemTime(new Date(iso));
  await scheduling.inbox.tick();
  await runFollowThrough();
}

interface Offered {
  readonly stored: Meeting;
  readonly session: Session;
}

/** main hands Acme over, for this week by default; external-email offers and holds two times by email. */
async function offeredToAcme(window: typeof WEEK = WEEK): Promise<Offered> {
  const answer = data(
    await ask(scheduling.main, 'meeting_arrange', {
      people: [{ person_id: scheduling.people.acme.id }],
      calendar_id: PRINCIPAL,
      length_minutes: 30,
      ...window,
      purpose: 'Partnership intro',
    }),
  );
  const session = await meetingSession(answer.meeting_id);
  const slots = slotsOf(await ask(session, 'meeting_free_time', { meeting_id: answer.meeting_id }));
  data(
    await ask(session, 'meeting_hold', {
      meeting_id: answer.meeting_id,
      slot_ids: slots.slice(0, 2).map((slot) => slot.slot_id),
    }),
  );
  const stored = await meeting(answer.meeting_id);
  await reply(session, stored.thread_key, 'Hello, I am Juno, Alex Doe’s assistant. Would Tuesday or Wednesday suit?');
  return { stored, session };
}

function asks(meetingId: string) {
  return notes(scheduling.main, ASK).filter((c) => c.note?.meeting_id === meetingId);
}

describe('a curveball goes to main, and nothing goes to the other side', () => {
  it('refuses a question about a meeting that has ended', async () => {
    const answer = data(
      await ask(scheduling.main, 'meeting_arrange', {
        people: [{ person_id: scheduling.people.acme.id }],
        calendar_id: PRINCIPAL,
        length_minutes: 30,
        ...WEEK,
        purpose: 'Partnership intro',
      }),
    );
    const session = await meetingSession(answer.meeting_id);
    // Nobody was written to yet, so calling it off ends it at once.
    data(await ask(scheduling.main, 'meeting_cancel', { meeting_id: answer.meeting_id }));
    expect((await meeting(answer.meeting_id)).state).toBe('cancelled');
    expect(refusal(await ask(session, 'meeting_ask_main', { meeting_id: answer.meeting_id, about: 'time' }))).toMatch(
      /has ended \(cancelled\): send nothing more/,
    );
  });

  it('is asked only by external-email, from the meeting’s own conversation', async () => {
    const { stored } = await offeredToAcme();
    expect(refusal(await ask(scheduling.main, 'meeting_ask_main', { meeting_id: stored.id, about: 'time' }))).toMatch(
      /Only external-email asks main about a meeting/,
    );
    // external-email's conversation for another meeting is refused by the guard itself, before the request runs.
    const other = data(
      await ask(scheduling.main, 'meeting_arrange', {
        people: [{ person_id: scheduling.people.pat.id }],
        calendar_id: PRINCIPAL,
        length_minutes: 30,
        ...WEEK,
        purpose: 'Coffee',
      }),
    );
    const otherSession = await meetingSession(other.meeting_id);
    expect(refusal(await ask(otherSession, 'meeting_ask_main', { meeting_id: stored.id, about: 'time' }))).toMatch(
      /That meeting is not this conversation's\. Use only the meeting your brief names\./,
    );
    expect(asks(stored.id)).toEqual([]);
    expect((await meeting(stored.id)).ask_about).toBeNull();
  });

  it('refuses main’s answer when it carries one of the principal’s private details', async () => {
    const { stored, session } = await offeredToAcme();
    data(await ask(session, 'meeting_ask_main', { meeting_id: stored.id, about: 'place' }));
    await addPrivateValue({ label: 'Home', kind: 'address', value: '12 Elm Road, Springfield' });
    expect(
      refusal(
        await ask(scheduling.main, 'meeting_amend', {
          meeting_id: stored.id,
          answer: 'Come to 12 Elm Road, Springfield at ten.',
        }),
      ),
    ).toMatch(/not passed on/);
    expect((await meeting(stored.id)).ask_about).toBe('place');
  });
});

describe('main answers a booked meeting', () => {
  /** Booked for the week after, so it has not passed while a question waits. */
  async function bookedWithAcme(): Promise<Offered> {
    const { stored, session } = await offeredToAcme(WEEK_AFTER);
    const [slot] = slotsOf(await ask(session, 'meeting_free_time', { meeting_id: stored.id }));
    data(
      await ask(session, 'meeting_book', {
        meeting_id: stored.id,
        slot_id: slot.slot_id,
        invitation: { title: 'Partnership intro' },
      }),
    );
    return { stored: await meeting(stored.id), session };
  }

  it('adds Jane to its event with everyone invited and Google’s update, and refuses a new length', async () => {
    const { stored, session } = await bookedWithAcme();
    data(await ask(session, 'meeting_ask_main', { meeting_id: stored.id, about: 'people' }));
    data(
      await ask(scheduling.main, 'meeting_amend', {
        meeting_id: stored.id,
        people: [{ email: JANE }],
        answer: 'Yes, Jane is welcome.',
      }),
    );
    const booking = await getBooking(stored.id);
    if (!booking) throw new Error('not booked');
    const event = scheduling.calendar.event(booking.calendar_id, booking.event_id);
    expect(event?.attendees?.map((attendee) => attendee.email).sort()).toEqual([ADDRESSES.acme, JANE].sort());
    expect(scheduling.calendar.writes.at(-1)).toMatchObject({ op: 'patch', sendUpdates: 'all' });
    expect(await meeting(stored.id)).toMatchObject({ state: 'booked', ask_about: null });
    const brief = contents(session)
      .filter((c) => c.brief !== undefined)
      .at(-1);
    expect(brief?.text).toMatch(/It is booked for/);
    expect(brief?.text).toContain(JANE);

    expect(refusal(await ask(scheduling.main, 'meeting_amend', { meeting_id: stored.id, length_minutes: 60 }))).toMatch(
      /meeting_reschedule/,
    );
  });

  it('changes its invitation at main’s word, checked against everyone it reaches before anything is written', async () => {
    const { stored, session } = await bookedWithAcme();
    data(await ask(session, 'meeting_ask_main', { meeting_id: stored.id, about: 'place' }));
    data(
      await ask(scheduling.main, 'meeting_amend', {
        meeting_id: stored.id,
        invitation: { location: 'Acme HQ, 1 Main Street' },
        answer: 'Alex will come to Acme.',
      }),
    );
    const booking = await getBooking(stored.id);
    if (!booking) throw new Error('not booked');
    expect(scheduling.calendar.event(booking.calendar_id, booking.event_id)).toMatchObject({
      summary: 'Partnership intro',
      location: 'Acme HQ, 1 Main Street',
    });
    expect(scheduling.calendar.writes.at(-1)).toMatchObject({ op: 'patch', sendUpdates: 'all' });

    // The invitation already says something the principal has since made private: nobody new may read it.
    await addPrivateValue({ label: 'Office', kind: 'address', value: 'Acme HQ, 1 Main Street' });
    const writes = scheduling.calendar.writes.length;
    expect(
      refusal(await ask(scheduling.main, 'meeting_amend', { meeting_id: stored.id, people: [{ email: JANE }] })),
    ).toMatch(/Nothing was changed: the invitation carries one of the principal.s private details/);
    expect(scheduling.calendar.writes).toHaveLength(writes);
    expect((await meeting(stored.id)).counterparts.map((c) => c.address)).toEqual([ADDRESSES.acme]);
  });

  it('adds a Meet link to its event at main’s word, and never takes one away', async () => {
    scheduling.calendar.calendars.set(PRINCIPAL, {
      id: PRINCIPAL,
      accessRole: 'writer',
      primary: false,
      conferenceTypes: ['hangoutsMeet'],
    });
    const { stored, session } = await bookedWithAcme();
    data(await ask(session, 'meeting_ask_main', { meeting_id: stored.id, about: 'place' }));
    data(
      await ask(scheduling.main, 'meeting_amend', {
        meeting_id: stored.id,
        invitation: { video_call: true },
        answer: 'A video call suits Alex best.',
      }),
    );
    const booking = await getBooking(stored.id);
    if (!booking) throw new Error('not booked');
    expect(scheduling.calendar.event(booking.calendar_id, booking.event_id)?.conference?.status).toBe('success');
    expect(scheduling.calendar.writes.at(-1)).toMatchObject({ op: 'patch', sendUpdates: 'all' });

    const writes = scheduling.calendar.writes.length;
    expect(
      refusal(
        await ask(scheduling.main, 'meeting_amend', { meeting_id: stored.id, invitation: { video_call: false } }),
      ),
    ).toMatch(/keeps its Google Meet link/);
    expect(scheduling.calendar.writes).toHaveLength(writes);
  });

  it('lets a question main leaves open lapse, and the booked meeting stands', async () => {
    const { stored, session } = await bookedWithAcme();
    data(await ask(session, 'meeting_ask_main', { meeting_id: stored.id, about: 'place' }));
    await reach('2026-10-07T08:01:00.000Z');
    const [, reminder] = asks(stored.id);
    expect(reminder.note).toMatchObject({ reminder: true });
    expect(reminder.text).toMatch(/the booked meeting stands/);
    await reach('2026-10-09T08:02:00.000Z');
    expect(await meeting(stored.id)).toMatchObject({ state: 'booked', ask_about: null, give_up_at: null });
  });
});
