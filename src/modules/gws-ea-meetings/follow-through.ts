/**
 * Follow-through (KTD12; R9, R26): what the host does over time for the
 * meetings `external-email` is arranging, read from the meeting store and the
 * calendar, never from an agent's memory. A module timer runs `tick` each
 * minute. Everything it acts on is stored, so a restart loses nothing, and a
 * deadline that came due while the host was down fires once it is back.
 *
 * - A job's quiet count starts when its conversation's first email is
 *   delivered, or when it first holds times, whichever comes first: a nudge
 *   two working days on, and giving up two working days after the nudge, on
 *   the principal's working hours and clock (`workingDaysLater`). A
 *   conversation has no nudge: it ends quietly after the two spans together.
 * - The nudge follows up with whoever the job waits on. While main has a
 *   question open (`meeting_ask_main`), main gets one reminder; otherwise the
 *   meeting's own session gets a host-only note, and its agent sends the
 *   counterpart one nudge. Giving up is the host's alone: it reports gave-up
 *   to `main`, ends the meeting and its conversation, and releases its
 *   holds, with no agent turn. A conversation that goes quiet ends without
 *   a word to anyone, and a booked meeting's open question lapses.
 * - A deadline acts only while the inbox is healthy, and only once a poll
 *   that began after it has finished: a reply the host has not read yet never
 *   counts as silence, so deadlines pause while mail cannot be read.
 * - A counterpart's email in the thread starts the quiet count again, unless
 *   main has a question open: then it waits on main. A booking clears the
 *   count (`book`).
 * - A booked meeting's conversation closes once its event has passed, read
 *   again from the calendar; later mail in its thread reaches `main` as a
 *   note (`closeThread`).
 * - Holds a release could not remove at the time go on a later pass, and a
 *   room whose move is booked goes to the meeting it was made for.
 */
import { getSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import type { InboxHealth } from '../gws-ea-inbox/index.js';
import type { MeetingsCalendarApi } from './calendar-api.js';
import {
  findLiveMeetingOnThread,
  getMeeting,
  listLiveReplyJobs,
  listMeetingsWithDeadlines,
  listOpenBookings,
  listRoomsAwaitingHandover,
  listSettledMeetingsWithHolds,
  recordNudged,
  restartDeadlines,
  updateBookingTime,
  type Deadlines,
  type Meeting,
  type Room,
} from './db.js';
import { principalPreferences, principalTimezone } from './handoff.js';
import { NUDGE_NOTE_TYPE, writeMeetingNote } from './notes.js';
import { eventSpan, schedulingRules, workingDaysLater } from './slots.js';

/** Working days of silence after the times are offered before the one nudge. */
export const NUDGE_AFTER_WORKING_DAYS = 2;
/** Working days of silence after the nudge before the host gives up. */
export const GIVE_UP_AFTER_WORKING_DAYS = 2;

/** `count` working days after `from`, on the principal's working hours and clock. */
async function afterWorkingDays(from: number, count: number): Promise<number> {
  const rules = schedulingRules(await principalPreferences(), null);
  return workingDaysLater(from, count, rules, await principalTimezone());
}

/** A meeting's deadlines when its quiet count starts at `from`. */
export async function deadlinesFrom(from: number): Promise<Deadlines> {
  const nudge = await afterWorkingDays(from, NUDGE_AFTER_WORKING_DAYS);
  const giveUp = await afterWorkingDays(nudge, GIVE_UP_AFTER_WORKING_DAYS);
  return { nudge_at: new Date(nudge).toISOString(), give_up_at: new Date(giveUp).toISOString() };
}

/** A job's quiet count from `from`: a conversation has no nudge, and ends when a meeting would be given up. */
export async function quietDeadlines(meeting: Pick<Meeting, 'kind'>, from: number): Promise<Deadlines> {
  const deadlines = await deadlinesFrom(from);
  return meeting.kind === 'respond' ? { nudge_at: null, give_up_at: deadlines.give_up_at } : deadlines;
}

export interface FollowThroughDeps {
  /** The host's own Calendar client. */
  readonly calendar: () => MeetingsCalendarApi;
  readonly inboxHealth: () => Promise<InboxHealth>;
  /** Remind main, once, that a meeting has waited on its answer since `nudgeAt` came due. */
  readonly remindMain: (meeting: Meeting, nudgeAt: string) => Promise<void>;
  /**
   * Report gave-up for a meeting nobody answered, end it, and release its
   * holds (throws when a hold stays), unless the deadline `giveUpAt` no longer stands.
   */
  readonly giveUp: (meeting: Meeting, giveUpAt: string) => Promise<void>;
  /** End a booked meeting whose event has passed: its conversation and thread close. */
  readonly closeBooked: (meeting: Meeting) => Promise<void>;
  /** Release every hold the meeting still has recorded (throws when one stays). */
  readonly releaseHolds: (meeting: Meeting) => Promise<void>;
  /** Hold the time a booked move freed for the meeting it was made for. */
  readonly handOverRoom: (room: Room) => Promise<void>;
  /** Finish a reply job whose ending was cut short, or leave one still at work. */
  readonly finishCutShortReply: (meeting: Meeting) => Promise<void>;
}

/** Whether a poll that began at or after `deadline` has read the inbox, and it is healthy. */
function readPast(health: InboxHealth, deadline: number): boolean {
  return health.state === 'healthy' && health.lastSuccessAt !== null && Date.parse(health.lastSuccessAt) >= deadline;
}

function isDue(value: string | null, now: number): value is string {
  return value !== null && Date.parse(value) <= now;
}

/** Run one step for one meeting; a failure is logged, and the next pass tries again. */
async function step(what: string, meetingId: string, action: () => Promise<void>): Promise<void> {
  /* eslint-disable no-catch-all/no-catch-all -- one meeting's failure must not stop the others; the next pass retries */
  try {
    await action();
  } catch (err) {
    log.error(`Follow-through could not ${what}`, { meetingId, err });
  }
  /* eslint-enable no-catch-all/no-catch-all */
}

export function createFollowThrough(deps: FollowThroughDeps) {
  /**
   * Follow up once with whoever the meeting waits on: main, while a question
   * to it is open, or else the other side, through the meeting's own session.
   * Then count two working days on to giving up; nothing when the deadline
   * `nudgeAt` no longer stands.
   */
  async function nudge(meetingId: string, nudgeAt: string, now: number): Promise<void> {
    // Read again: a reply since the pass listed the meeting started its count again.
    const meeting = await getMeeting(meetingId);
    if ((meeting?.state !== 'active' && meeting?.state !== 'booked') || meeting.nudge_at !== nudgeAt) return;
    const at = new Date(now).toISOString();
    const session = meeting.session_id === null ? undefined : await getSession(meeting.session_id);
    if (meeting.asked_at !== null) {
      await deps.remindMain(meeting, nudgeAt);
    } else if (session?.status === 'active') {
      await writeMeetingNote(
        session,
        meeting,
        `meeting-nudge-${meeting.id}-${Date.parse(nudgeAt)}`,
        { type: NUDGE_NOTE_TYPE },
        `Note for meeting ${meeting.id}, from the host: no one has replied in this thread since you offered times. ` +
          'Send them one short, friendly nudge in this thread, and nothing more. If no one answers within two ' +
          'working days, the host releases the held times and tells the principal.',
        at,
      );
    } else {
      log.warn('A meeting due a nudge has no open conversation to nudge from', { meetingId: meeting.id });
    }
    const giveUpAt = new Date(await afterWorkingDays(now, GIVE_UP_AFTER_WORKING_DAYS)).toISOString();
    await recordNudged(meeting.id, nudgeAt, giveUpAt, at);
  }

  /**
   * Each meeting's due deadline, from one read of the store. Earlier
   * meetings' steps take time, so each step acts only while the deadline it
   * was read with still stands.
   */
  async function runDeadlines(now: number): Promise<void> {
    const meetings = await listMeetingsWithDeadlines();
    if (meetings.length === 0) return;
    const health = await deps.inboxHealth();
    for (const meeting of meetings) {
      // The nudge comes first: a give-up never fires before the nudge it follows.
      const { nudge_at: nudgeAt, give_up_at: giveUpAt } = meeting;
      if (nudgeAt !== null) {
        if (isDue(nudgeAt, now) && readPast(health, Date.parse(nudgeAt))) {
          await step('nudge', meeting.id, () => nudge(meeting.id, nudgeAt, now));
        }
        continue;
      }
      if (isDue(giveUpAt, now) && readPast(health, Date.parse(giveUpAt))) {
        await step('give up', meeting.id, () => deps.giveUp(meeting, giveUpAt));
      }
    }
  }

  /** Close each booked meeting whose event has passed, as the calendar shows it now. */
  async function closePassedBookings(now: number): Promise<void> {
    const passed = (await listOpenBookings()).filter(({ booking }) => Date.parse(booking.end_at) <= now);
    if (passed.length === 0) return;
    const timezone = await principalTimezone();
    for (const { meeting, booking } of passed) {
      await step('close a booked meeting', meeting.id, async () => {
        const event = await deps.calendar().getEvent(booking.calendar_id, booking.event_id);
        const span = event && event.status !== 'cancelled' ? eventSpan(event, timezone) : undefined;
        if (span && span.end > now) {
          // Moved later on the calendar: it has not happened yet.
          await updateBookingTime(meeting.id, new Date(span.start).toISOString(), new Date(span.end).toISOString());
          return;
        }
        await deps.closeBooked(meeting);
      });
    }
  }

  async function finishRooms(): Promise<void> {
    for (const room of await listRoomsAwaitingHandover()) {
      await step('hand over a room', room.for_meeting_id, () => deps.handOverRoom(room));
    }
  }

  async function releaseLeftoverHolds(): Promise<void> {
    for (const meeting of await listSettledMeetingsWithHolds()) {
      await step('release holds', meeting.id, () => deps.releaseHolds(meeting));
    }
  }

  async function finishCutShortReplies(): Promise<void> {
    for (const meeting of await listLiveReplyJobs()) {
      await step('finish a reply', meeting.id, () => deps.finishCutShortReply(meeting));
    }
  }

  /** One pass, as the host's timer runs it each minute. Never throws. */
  async function tick(): Promise<void> {
    const now = Date.now();
    for (const [what, run] of [
      ['run deadlines', () => runDeadlines(now)],
      ['close passed meetings', () => closePassedBookings(now)],
      ['hand over rooms', finishRooms],
      ['release leftover holds', releaseLeftoverHolds],
      ['finish cut-short replies', finishCutShortReplies],
    ] as const) {
      /* eslint-disable no-catch-all/no-catch-all -- the timer never stops: each pass logs what failed and the next retries */
      try {
        await run();
      } catch (err) {
        log.error(`Follow-through could not ${what}`, { err });
      }
      /* eslint-enable no-catch-all/no-catch-all */
    }
  }

  /**
   * The other side wrote in a job's thread: its quiet count starts again
   * from now. While main has a question open, the count waits on main,
   * whatever the other side writes.
   */
  async function replied(threadKey: string): Promise<void> {
    const meeting = await findLiveMeetingOnThread(threadKey);
    if (!meeting || meeting.state !== 'active' || meeting.asked_at !== null) return;
    const now = new Date();
    await restartDeadlines(meeting.id, await quietDeadlines(meeting, now.getTime()), now.toISOString());
  }

  return { tick, replied };
}

export type FollowThrough = ReturnType<typeof createFollowThrough>;
