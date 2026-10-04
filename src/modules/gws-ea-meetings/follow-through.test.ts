/**
 * Follow-through (KTD12; R9, R26): quiet threads get one nudge and then a
 * clean release, a booked meeting's conversation closes once its event has
 * passed, and a counterpart who asks to move a booked meeting has it moved
 * in place.
 *
 * Drives the real delivery actions, inbox, router, follow-through timer and
 * session DBs against an in-memory Gmail and Google Calendar. Only the
 * container runtime and its wake are mocked, and the clock is moved by hand.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_DIR = '/tmp/nanoclaw-test-gws-ea-follow-through';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-gws-ea-follow-through',
    GROUPS_DIR: '/tmp/nanoclaw-test-gws-ea-follow-through/groups',
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

import { killContainer } from '../../container-runner.js';
import { getDb } from '../../db/connection.js';
import { getSession } from '../../db/sessions.js';
import { requestWake } from '../../request-wake.js';
import type { Session } from '../../types.js';
import { getThreadParticipants, GoogleApiError } from '../gws-ea-inbox/index.js';
import { setSchedulingPreference } from '../gws-ea-preferences/db.js';
import type { Person } from '../gws-ea-people/db.js';
import { claimGiveUp } from './db.js';
import { getBooking, runFollowThrough, type Meeting } from './index.js';
import type { StoredEvent } from './testing/fake-calendar.js';
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
  ROBIN,
  setUpScheduling,
  slotsOf,
  tearDownScheduling,
  type Scheduling,
} from './testing/scheduling.js';

/** Monday 5 October 2026, 08:00 in London (BST, UTC+1). */
const NOW = '2026-10-05T07:00:00.000Z';
/** Tuesday 6 October to the end of Friday 16 October, London. */
const WINDOW = { window_start: '2026-10-06T00:00:00+01:00', window_end: '2026-10-17T00:00:00+01:00' };

const NUDGE = 'gws-ea-meetings.nudge';
const OUTCOME = 'gws-ea-meetings.outcome';

let scheduling: Scheduling;

beforeEach(async () => {
  vi.useFakeTimers({ now: new Date(NOW), toFake: ['Date'] });
  scheduling = await setUpScheduling(TEST_DIR, google);
  vi.mocked(requestWake).mockClear();
  vi.mocked(killContainer).mockClear();
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

function holds(): StoredEvent[] {
  return scheduling.calendar.live(PRINCIPAL).filter((event) => event.tags?.gwsEaRole === 'hold');
}

interface Offered {
  readonly stored: Meeting;
  readonly session: Session;
  readonly slots: ReturnType<typeof slotsOf>;
}

/** main hands over a meeting; external-email holds three times and emails them. */
async function offered(person: Person, extra: Record<string, unknown> = {}): Promise<Offered> {
  const answer = data(
    await ask(scheduling.main, 'meeting_arrange', {
      people: [{ person_id: person.id }],
      calendar_id: PRINCIPAL,
      length_minutes: 30,
      ...WINDOW,
      purpose: 'Partnership intro',
      ...extra,
    }),
  );
  const session = await meetingSession(answer.meeting_id);
  const slots = slotsOf(await ask(session, 'meeting_free_time', { meeting_id: answer.meeting_id }));
  data(
    await ask(session, 'meeting_hold', {
      meeting_id: answer.meeting_id,
      slot_ids: slots.slice(0, 3).map((slot) => slot.slot_id),
    }),
  );
  const stored = await meeting(answer.meeting_id);
  await reply(session, stored.thread_key, 'Hello, I am Robin, Alex Doe’s assistant. Would one of these times suit?');
  return { stored, session, slots };
}

/** An invitation Acme organizes on the principal's calendar, on Wednesday morning. */
function calendarInvitation(): void {
  scheduling.calendar.put({
    calendarId: PRINCIPAL,
    id: 'evt-invite',
    iCalUID: 'evt-invite@google.com',
    status: 'confirmed',
    organizer: { email: ADDRESSES.acme },
    attendees: [
      { email: ADDRESSES.acme, organizer: true, responseStatus: 'accepted' },
      { email: PRINCIPAL, responseStatus: 'needsAction' },
    ],
    start: { dateTime: '2026-10-07T09:00:00Z' },
    end: { dateTime: '2026-10-07T10:00:00Z' },
  });
}

/** A counterpart writes in the thread of an email the assistant sent, the first by default. */
async function theyWrite(from: string, body: string, inThreadOf = scheduling.gmail.sent[0]): Promise<void> {
  scheduling.gmail.receive({
    threadId: inThreadOf.threadId,
    from,
    to: [ROBIN],
    subject: 'Re: Partnership intro',
    body,
  });
  await scheduling.inbox.tick();
}

// ---------------------------------------------------------------------------
// Deadlines
// ---------------------------------------------------------------------------

describe('AE2: a quiet thread', () => {
  it('gets one nudge after two working days, and two working days later its holds go and main hears one line', async () => {
    const { stored, session } = await offered(scheduling.people.acme);
    // Held before Monday's working day began: it counts from 09:00, so two working days later is Wednesday 09:00.
    expect(await meeting(stored.id)).toMatchObject({
      nudge_at: '2026-10-07T08:00:00.000Z',
      give_up_at: '2026-10-09T08:00:00.000Z',
    });

    await reach('2026-10-07T07:59:00.000Z');
    expect(notes(session, NUDGE)).toHaveLength(0);

    vi.mocked(requestWake).mockClear();
    await reach('2026-10-07T08:01:00.000Z');
    const [nudge, ...more] = notes(session, NUDGE);
    expect(more).toEqual([]);
    expect(nudge.sender).toBe('system');
    expect(nudge.row.thread_id).toBe(stored.thread_key);
    expect(nudge.row.trigger).toBe(1);
    expect(nudge.text).toMatch(/nudge/i);
    expect(vi.mocked(requestWake)).toHaveBeenCalledWith(expect.objectContaining({ id: session.id }), 'inbound-message');
    expect(holds()).toHaveLength(3);

    // Nothing more until two working days after the nudge.
    await reach('2026-10-08T12:00:00.000Z');
    await reach('2026-10-09T07:59:00.000Z');
    expect(notes(session, NUDGE)).toHaveLength(1);
    expect(notes(scheduling.main, OUTCOME)).toHaveLength(0);

    const before = contents(session).length;
    vi.mocked(requestWake).mockClear();
    await reach('2026-10-09T08:02:00.000Z');
    expect(holds()).toEqual([]);
    expect(await meeting(stored.id)).toMatchObject({ state: 'gave-up', nudge_at: null, give_up_at: null });
    expect((await getSession(session.id))?.status).toBe('closed');
    expect(vi.mocked(killContainer)).toHaveBeenCalledWith(session.id, expect.any(String));
    expect(await getThreadParticipants(stored.thread_key)).toMatchObject({ state: 'closed' });

    // The host reported it: external-email took no turn, and main tells the principal in one line.
    expect(contents(session)).toHaveLength(before);
    expect(vi.mocked(requestWake)).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: session.id }),
      expect.anything(),
    );
    const [gaveUp, ...again] = notes(scheduling.main, OUTCOME);
    expect(again).toEqual([]);
    expect(gaveUp.note).toMatchObject({ meeting_id: stored.id, outcome: 'gave-up' });
    expect(gaveUp.text).toContain('Acme Sales');
    expect(gaveUp.text).toMatch(/one line/);
    expect(gaveUp.text).toMatch(/suggestion/);
    expect(vi.mocked(requestWake)).toHaveBeenCalledWith(
      expect.objectContaining({ id: scheduling.main.id }),
      'inbound-message',
    );

    await reach('2026-10-12T09:00:00.000Z');
    expect(notes(scheduling.main, OUTCOME)).toHaveLength(1);
  });
});

describe('deadlines', () => {
  it("count working days on the principal's own hours and clock, skipping days off and weekends", async () => {
    await getDb().run("UPDATE gws_ea_profile SET principal_timezone = 'America/New_York' WHERE singleton = 1");
    for (const weekday of ['mon', 'tue', 'wed', 'thu']) {
      await setSchedulingPreference({
        kind: 'working-hours',
        weekday,
        hours: { start: '10:00', end: '16:00' },
        source: 'principal',
        basis: 'said so',
      });
    }
    await setSchedulingPreference({
      kind: 'working-hours',
      weekday: 'fri',
      hours: 'off',
      source: 'principal',
      basis: 'said so',
    });
    // Thursday 8 October, 17:00 in New York: after the day's hours, and Friday is off.
    vi.setSystemTime(new Date('2026-10-08T21:00:00.000Z'));
    const { stored } = await offered(scheduling.people.acme, {
      window_start: '2026-10-12T00:00:00-04:00',
      window_end: '2026-10-24T00:00:00-04:00',
    });
    // The count starts Monday 10:00: two working days later is Wednesday 10:00 in New York, and two more,
    // past Friday off and the weekend, is Monday 19 October.
    expect(await meeting(stored.id)).toMatchObject({
      nudge_at: '2026-10-14T14:00:00.000Z',
      give_up_at: '2026-10-19T14:00:00.000Z',
    });
  });

  it('a reply starts the quiet count again from the reply, whether or not times are held', async () => {
    const { stored, session } = await offered(scheduling.people.acme);
    vi.setSystemTime(new Date('2026-10-06T11:00:00.000Z'));
    await theyWrite(`Acme Sales <${ADDRESSES.acme}>`, 'Thanks, let me check with the team and come back to you.');
    expect(contents(session).some((content) => content.text?.includes('check with the team'))).toBe(true);
    // Tuesday 12:00: two working days later is Thursday 12:00, and two more is Monday 12 October.
    expect(await meeting(stored.id)).toMatchObject({
      nudge_at: '2026-10-08T11:00:00.000Z',
      give_up_at: '2026-10-12T11:00:00.000Z',
    });

    await reach('2026-10-07T08:30:00.000Z');
    expect(notes(session, NUDGE)).toHaveLength(0);
    await reach('2026-10-08T11:01:00.000Z');
    expect(notes(session, NUDGE)).toHaveLength(1);

    // With nothing held, a reply still starts the count again: the conversation is what goes quiet.
    data(await ask(session, 'meeting_hold', { meeting_id: stored.id, slot_ids: [] }));
    await theyWrite(`Acme Sales <${ADDRESSES.acme}>`, 'None of those work, sorry.');
    expect(await meeting(stored.id)).toMatchObject({
      nudge_at: '2026-10-12T11:01:00.000Z',
      give_up_at: '2026-10-14T11:01:00.000Z',
    });
  });

  it('start at the first email delivered for a job that holds nothing, and its nudge never restarts them', async () => {
    calendarInvitation();
    const asked = data(
      await ask(scheduling.main, 'meeting_reschedule', {
        calendar_id: PRINCIPAL,
        event_id: 'evt-invite',
        ...WINDOW,
        purpose: 'Your Wednesday invitation',
      }),
    );
    const stored = await meeting(asked.meeting_id);
    const session = await meetingSession(asked.meeting_id);
    expect(stored).toMatchObject({ kind: 'ask_organizer', nudge_at: null, give_up_at: null });
    await reply(session, stored.thread_key, 'Hello, could your Wednesday invitation move to Thursday at 10?');
    expect(await meeting(stored.id)).toMatchObject({
      nudge_at: '2026-10-07T08:00:00.000Z',
      give_up_at: '2026-10-09T08:00:00.000Z',
    });

    await reach('2026-10-07T08:01:00.000Z');
    expect(notes(session, NUDGE)).toHaveLength(1);
    await reply(session, stored.thread_key, 'Just checking whether Thursday at 10 could work?');
    // The nudge's own email leaves the give-up where the nudge set it.
    expect(await meeting(stored.id)).toMatchObject({ nudge_at: null, give_up_at: '2026-10-09T08:01:00.000Z' });
  });

  it('end a called-off meeting without its closing line when the line never goes', async () => {
    const { stored, session } = await offered(scheduling.people.acme);
    expect(data(await ask(scheduling.main, 'meeting_cancel', { meeting_id: stored.id })).state).toBe('closing');
    await reach('2026-10-05T07:59:00.000Z');
    expect((await meeting(stored.id)).state).toBe('closing');
    await reach('2026-10-05T08:01:00.000Z');
    expect((await meeting(stored.id)).state).toBe('cancelled');
    expect((await getSession(session.id))?.status).toBe('closed');
    expect(await getThreadParticipants(stored.thread_key)).toMatchObject({ state: 'closed' });
    expect(scheduling.gmail.sent).toHaveLength(1);
  });

  it("are not touched by the principal's own message in the thread", async () => {
    const { stored } = await offered(scheduling.people.acme);
    const [first] = scheduling.gmail.sent;
    scheduling.gmail.receive({
      threadId: first.threadId,
      from: `Alex <${PRINCIPAL}>`,
      principal: true,
      to: [ADDRESSES.acme],
      cc: [ROBIN],
      subject: 'Re: Partnership intro',
      body: 'Any of these is fine for me.',
    });
    await scheduling.inbox.tick();
    expect(await meeting(stored.id)).toMatchObject({ nudge_at: '2026-10-07T08:00:00.000Z' });
  });

  it('a booking clears them', async () => {
    const { stored, session, slots } = await offered(scheduling.people.acme);
    data(await ask(session, 'meeting_book', { meeting_id: stored.id, slot_id: slots[0].slot_id }));
    expect(await meeting(stored.id)).toMatchObject({ nudge_at: null, give_up_at: null });
    await reach('2026-10-07T08:01:00.000Z');
    await reach('2026-10-09T08:02:00.000Z');
    expect(notes(session, NUDGE)).toHaveLength(0);
    expect(notes(scheduling.main, OUTCOME)).toHaveLength(0);
  });

  it('that came due while the host was down fire once it is back, exactly once', async () => {
    const { session } = await offered(scheduling.people.acme);
    // The host was down over Wednesday morning; it starts again at 10:00 and polls the inbox first.
    vi.setSystemTime(new Date('2026-10-07T09:00:00.000Z'));
    await scheduling.inbox.tick();
    await Promise.all([runFollowThrough(), runFollowThrough()]);
    await runFollowThrough();
    expect(notes(session, NUDGE)).toHaveLength(1);
  });

  it('pause while the inbox is unhealthy, and wait for a poll that read past them', async () => {
    const { stored, session } = await offered(scheduling.people.acme);
    await getDb().run(
      "UPDATE gws_ea_inbox_state SET health = 'unhealthy', health_reason = 'Gmail is down', health_since = ?, consecutive_failures = 3 WHERE singleton = 1",
      '2026-10-06T09:00:00.000Z',
    );
    vi.setSystemTime(new Date('2026-10-07T09:00:00.000Z'));
    await runFollowThrough();
    expect(notes(session, NUDGE)).toHaveLength(0);

    // Healthy again, but no poll has read the mail since the deadline: still nothing.
    await getDb().run(
      "UPDATE gws_ea_inbox_state SET health = 'healthy', health_reason = NULL, health_since = NULL, consecutive_failures = 0, last_success_at = ? WHERE singleton = 1",
      '2026-10-07T07:30:00.000Z',
    );
    await runFollowThrough();
    expect(notes(session, NUDGE)).toHaveLength(0);

    await reach('2026-10-07T09:01:00.000Z');
    expect(notes(session, NUDGE)).toHaveLength(1);
    expect((await meeting(stored.id)).state).toBe('active');
  });

  describe('act on each meeting as it is when the pass reaches it', () => {
    /** While the pass releases the first meeting's holds with Google, `meanwhile` runs. */
    function duringFirstRelease(meanwhile: () => Promise<void>): void {
      const deleteEvent = scheduling.calendar.deleteEvent.bind(scheduling.calendar);
      vi.spyOn(scheduling.calendar, 'deleteEvent').mockImplementationOnce(async (...args) => {
        await meanwhile();
        return deleteEvent(...args);
      });
    }

    /** Pat replies in their meeting's thread: the second the assistant wrote to. */
    const patReplies = () =>
      theyWrite(`Pat Lee <${ADDRESSES.pat}>`, 'Sorry for the wait: the second time works.', scheduling.gmail.sent[1]);

    it('so a reply read after the pass began stops its give-up', async () => {
      const acme = await offered(scheduling.people.acme);
      vi.setSystemTime(new Date('2026-10-05T07:30:00.000Z'));
      const pat = await offered(scheduling.people.pat);
      // Both held before Monday's working day began: both are nudged on Wednesday, and give up on Friday.
      await reach('2026-10-07T08:01:00.000Z');
      expect(await meeting(pat.stored.id)).toMatchObject({ nudge_at: null, give_up_at: '2026-10-09T08:01:00.000Z' });

      // Friday's pass reads both, and gives up on Acme's first; Pat replies meanwhile.
      duringFirstRelease(patReplies);
      await reach('2026-10-09T08:02:00.000Z');

      expect((await meeting(acme.stored.id)).state).toBe('gave-up');
      expect(contents(pat.session).some((content) => content.text?.includes('the second time works'))).toBe(true);
      // Pat's quiet count starts again from the reply, and the meeting carries on.
      expect(await meeting(pat.stored.id)).toMatchObject({
        state: 'active',
        nudge_at: '2026-10-13T08:02:00.000Z',
        give_up_at: '2026-10-15T08:02:00.000Z',
      });
      expect((await getSession(pat.session.id))?.status).toBe('active');
      expect(vi.mocked(killContainer)).not.toHaveBeenCalledWith(pat.session.id, expect.anything());
      expect(holds().filter((event) => event.tags?.gwsEaMeeting === pat.stored.id)).toHaveLength(3);
      expect(notes(scheduling.main, OUTCOME).map((note) => note.note?.meeting_id)).toEqual([acme.stored.id]);
    });

    it('so a reply read after the pass began stops its nudge', async () => {
      const acme = await offered(scheduling.people.acme);
      await reach('2026-10-07T08:01:00.000Z');
      // Pat's times are held on Wednesday at 09:05, so Pat's nudge comes due on Friday at 09:05.
      vi.setSystemTime(new Date('2026-10-07T08:05:00.000Z'));
      const pat = await offered(scheduling.people.pat);
      expect(await meeting(pat.stored.id)).toMatchObject({ nudge_at: '2026-10-09T08:05:00.000Z' });

      // Friday's pass reads both, and gives up on Acme's first; Pat replies meanwhile.
      duringFirstRelease(patReplies);
      await reach('2026-10-09T08:06:00.000Z');

      expect((await meeting(acme.stored.id)).state).toBe('gave-up');
      expect(notes(pat.session, NUDGE)).toEqual([]);
      expect(await meeting(pat.stored.id)).toMatchObject({ state: 'active', nudge_at: '2026-10-13T08:06:00.000Z' });
    });
  });

  it('stand as they were when main cannot be told of a give-up, and a later pass gives up', async () => {
    const { stored, session } = await offered(scheduling.people.acme);
    await reach('2026-10-07T08:01:00.000Z');
    await getDb().run('UPDATE gws_ea_profile SET main_agent_group_id = NULL WHERE singleton = 1');
    await reach('2026-10-09T08:02:00.000Z');
    // Nothing ended that main has not heard of: the times stay held, and a reply would still count.
    expect(await meeting(stored.id)).toMatchObject({
      state: 'active',
      ended_at: null,
      give_up_at: '2026-10-09T08:01:00.000Z',
    });
    expect(holds()).toHaveLength(3);
    expect((await getSession(session.id))?.status).toBe('active');

    await getDb().run("UPDATE gws_ea_profile SET main_agent_group_id = 'ag-main' WHERE singleton = 1");
    await reach('2026-10-09T08:03:00.000Z');
    expect(await meeting(stored.id)).toMatchObject({ state: 'gave-up', give_up_at: null });
    expect(holds()).toEqual([]);
    expect(notes(scheduling.main, OUTCOME)).toHaveLength(1);
  });

  it('finish a give-up the host claimed and then stopped before ending', async () => {
    const { stored, session } = await offered(scheduling.people.acme);
    await reach('2026-10-07T08:01:00.000Z');
    vi.setSystemTime(new Date('2026-10-09T08:02:00.000Z'));
    expect(await claimGiveUp(stored.id, '2026-10-09T08:01:00.000Z', new Date().toISOString())).toBe(true);

    // The host comes back.
    await reach('2026-10-09T08:03:00.000Z');
    expect(await meeting(stored.id)).toMatchObject({ state: 'gave-up', nudge_at: null, give_up_at: null });
    expect((await getSession(session.id))?.status).toBe('closed');
    expect(await getThreadParticipants(stored.thread_key)).toMatchObject({ state: 'closed' });
    expect(holds()).toEqual([]);
    const [gaveUp, ...again] = notes(scheduling.main, OUTCOME);
    expect(again).toEqual([]);
    expect(gaveUp.note).toMatchObject({ meeting_id: stored.id, outcome: 'gave-up', unanswered: true });
  });

  it('release on a later pass the holds a give-up could not release at once', async () => {
    const { stored } = await offered(scheduling.people.acme);
    await reach('2026-10-07T08:01:00.000Z');
    // Google cannot be reached when the host gives up.
    scheduling.calendar.failure = new GoogleApiError(503, 'Google refused: backend error');
    await reach('2026-10-09T08:02:00.000Z');
    expect((await meeting(stored.id)).state).toBe('gave-up');
    expect(holds()).toHaveLength(3);
    scheduling.calendar.failure = undefined;
    await reach('2026-10-09T08:03:00.000Z');
    expect(holds()).toEqual([]);
    expect(await getDb().all('SELECT slot_id FROM gws_ea_meeting_holds WHERE meeting_id = ?', stored.id)).toEqual([]);
    expect(notes(scheduling.main, OUTCOME)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// A booked meeting
// ---------------------------------------------------------------------------

async function booked(person: Person): Promise<Offered> {
  const held = await offered(person);
  data(await ask(held.session, 'meeting_book', { meeting_id: held.stored.id, slot_id: held.slots[0].slot_id }));
  data(await ask(held.session, 'meeting_outcome', { meeting_id: held.stored.id, outcome: 'booked' }));
  return { ...held, stored: await meeting(held.stored.id) };
}

describe('a booked meeting', () => {
  it('closes its conversation once its event has passed, and later thread mail reaches main for triage', async () => {
    const { stored, session } = await booked(scheduling.people.acme);
    const booking = await getBooking(stored.id);
    if (!booking) throw new Error('no booking');
    expect(booking.start_at).toBe('2026-10-06T08:00:00.000Z');

    await reach('2026-10-06T08:20:00.000Z');
    expect((await getSession(session.id))?.status).toBe('active');

    // The principal drags it to Wednesday on their calendar: it has not passed yet.
    const event = scheduling.calendar.event(PRINCIPAL, booking.event_id);
    if (!event) throw new Error('no event');
    scheduling.calendar.put({
      ...event,
      start: { dateTime: '2026-10-07T13:00:00.000Z' },
      end: { dateTime: '2026-10-07T13:30:00.000Z' },
    });
    await reach('2026-10-06T08:31:00.000Z');
    expect((await getSession(session.id))?.status).toBe('active');

    await reach('2026-10-07T13:31:00.000Z');
    expect((await getSession(session.id))?.status).toBe('closed');
    expect(await meeting(stored.id)).toMatchObject({ state: 'booked', ended_at: '2026-10-07T13:31:00.000Z' });
    expect(await getThreadParticipants(stored.thread_key)).toMatchObject({ state: 'closed' });

    const before = contents(session).length;
    await theyWrite(`Acme Sales <${ADDRESSES.acme}>`, 'Thanks for the meeting, great to meet you.');
    expect(contents(session)).toHaveLength(before);
    const [late] = notes(scheduling.main, 'gws-ea-inbox.inbound');
    expect(late.note).toMatchObject({ sender: ADDRESSES.acme, verified: true });
    expect(late.note?.thread_key).not.toBe(stored.thread_key);

    // A finished meeting is not cancelled again.
    expect(refusal(await ask(scheduling.main, 'meeting_cancel', { meeting_id: stored.id }))).toMatch(/ended/);
  });

  it('is moved in place when the counterpart asks, once, and main hears it in one line', async () => {
    const { stored, session } = await booked(scheduling.people.acme);
    const before = await getBooking(stored.id);
    if (!before) throw new Error('no booking');
    await theyWrite(`Acme Sales <${ADDRESSES.acme}>`, 'Something came up: could we do Wednesday at 10:00 instead?');

    const [wednesday] = slotsOf(
      await ask(session, 'meeting_free_time', { meeting_id: stored.id, date: '2026-10-07', time: '10:00' }),
    );
    expect(wednesday.start).toBe('2026-10-07T09:00:00.000Z');
    const writesBefore = scheduling.calendar.writes.length;
    const moved = data(await ask(session, 'meeting_book', { meeting_id: stored.id, slot_id: wednesday.slot_id }));
    expect(String(moved.message)).toMatch(/Moved/);

    expect(scheduling.calendar.writes.slice(writesBefore)).toEqual([
      {
        op: 'patch',
        calendarId: PRINCIPAL,
        eventId: before.event_id,
        sendUpdates: 'all',
        fields: { start: wednesday.start, end: wednesday.end },
      },
    ]);
    expect(scheduling.calendar.live(PRINCIPAL).filter((event) => event.tags?.gwsEaRole === 'booking')).toHaveLength(1);
    expect(await getBooking(stored.id)).toMatchObject({ event_id: before.event_id, start_at: wednesday.start });
    expect((await meeting(stored.id)).state).toBe('booked');

    const [note, ...more] = notes(scheduling.main, 'gws-ea-meetings.moved');
    expect(more).toEqual([]);
    expect(note.note).toMatchObject({ meeting_id: stored.id, booking: { start: wednesday.start } });
    expect(note.text).toContain('Acme Sales');
    expect(note.text).toMatch(/one line/);

    // A repeat moves nothing and tells no one again.
    data(await ask(session, 'meeting_book', { meeting_id: stored.id, slot_id: wednesday.slot_id }));
    expect(scheduling.calendar.writes).toHaveLength(writesBefore + 1);
    expect(notes(scheduling.main, 'gws-ea-meetings.moved')).toHaveLength(1);
  });
});
