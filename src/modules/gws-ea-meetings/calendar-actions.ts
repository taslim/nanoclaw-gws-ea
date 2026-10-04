/**
 * external-email's calendar actions (KTD11; R4, R5, R6, R11, R20, R24):
 * host tools that take slot ids, never free text, and reveal nothing of the
 * principal's calendar but candidate start times.
 *
 * - `meeting_free_time` offers a capped list of start times of the
 *   meeting's length, each with an opaque slot id, inside the meeting's
 *   window, from the principal's calendars and visible colleagues'
 *   free/busy, the principal's preferences, and R13's rule for the meeting's
 *   level (`slots.ts`). It can narrow to one day and check one proposed
 *   time, in the counterpart's timezone, so no date arithmetic is left to
 *   the agent. Its answers per meeting are capped.
 * - `meeting_hold` holds exactly the offered slots it names, at most three:
 *   a private, busy, silent event on the meeting's booking calendar for
 *   each, under an id derived from the meeting and the slot, and any other
 *   hold of the meeting released. An empty list releases them all.
 * - `meeting_book` creates the one meeting event from the meeting record: its
 *   people as attendees, its purpose as the title, and a fixed line, with
 *   Google's invitations sent; for a reschedule it moves the original event
 *   instead, keeping its id. The id is derived from the meeting, so a retry
 *   after a partial failure finds the event it made. It then releases every
 *   hold. Once the meeting is booked, `book` with a newly offered slot moves
 *   the booked event there in place, when the counterpart asks, and main
 *   hears of it in a note.
 * - The first hold starts the meeting's follow-through deadlines (KTD12);
 *   a booking clears them. A reschedule making room for another meeting
 *   treats the time it frees as taken, and once it is booked that time goes
 *   to the meeting it was for (`room.ts`).
 * - A release deletes only the meeting's holds the assistant recorded
 *   placing, and only while the event still carries that meeting's tag.
 *
 * The calendar is re-read at every offer, hold and booking: the store keeps
 * intent and links only. Every write passes the audience check (KTD7) and
 * is recorded as the assistant's own change, so its notification produces
 * no note. A meeting with colleagues alone whose free/busy is visible is
 * booked directly from `arrange` (R11, `bookDirectly`).
 */
import { createHash } from 'node:crypto';

import { resolveGroupTimezone } from '../../container-config.js';
import { log } from '../../log.js';
import { formatLocalTime, isValidTimezone } from '../../timezone.js';
import type { Session } from '../../types.js';
import { recordOwnCalendarChange } from '../gws-ea-inbox/calendar-notifications.js';
import { listPrincipalCalendars } from '../gws-ea-inbox/db.js';
import { audienceForAddresses, checkOutbound } from '../gws-ea-privacy/index.js';
import { getGwsEaProfile } from '../gws-ea-profile/db.js';
import type {
  CalendarEvent,
  EventWrite,
  ListedEvent,
  MeetingsCalendarApi,
  NewEvent,
  SendUpdates,
} from './calendar-api.js';
import {
  clearDeadlines,
  countAnswers,
  deleteHold,
  getBooking,
  getMeeting,
  getOfferedSlot,
  getRoomMadeBy,
  listHolds,
  recordBooking,
  recordHold,
  recordOfferedSlots,
  startDeadlines,
  updateBookingTime,
  type Booking,
  type Hold,
  isScheduling,
  type Meeting,
  type SchedulingMeeting,
  type OfferedSlot,
} from './db.js';
import { deadlinesFrom } from './follow-through.js';
import {
  addressBook,
  invalid,
  meetingIdOf,
  principalPreferences,
  principalTimezone,
  refused,
  type AddressBook,
  type Answer,
  type Handle,
} from './handoff.js';
import { MOVED_NOTE_TYPE, mainTimezone, noteCounterparts, who, writeMainNote } from './notes.js';
import {
  bestSlots,
  blocksTime,
  eventSpan,
  isOpen,
  iso,
  localDaySpan,
  openSlots,
  parseClock,
  parseLocalDate,
  READ_MARGIN_MS,
  schedulingRules,
  slotIdFor,
  zonedInstant,
  type LocalDate,
  type SchedulingRules,
  type SlotQuery,
  type Span,
} from './slots.js';

/** The delivery action whose answers the cap on `free_time` counts. */
export const FREE_TIME_ACTION = 'meeting_free_time';
/** How many times `free_time` answers for one meeting. */
const MAX_FREE_TIME_ANSWERS = 10;
/** How many times one `free_time` answer offers. */
const MAX_OFFERED = 5;
/** How many times one meeting holds at once. */
const MAX_HOLDS = 3;
/** No time is offered that starts sooner than this. */
const MIN_NOTICE_MINUTES = 60;

/** The private tags on the assistant's own events: no one but the assistant can set them. */
export const TAG_MEETING = 'gwsEaMeeting';
export const TAG_ROLE = 'gwsEaRole';
const TAG_SLOT = 'gwsEaSlot';

const MINUTE = 60_000;
const SLOT_ID = /^slot-[0-9a-f]{12}$/u;

export interface CalendarActionsDeps {
  /** The host's own Calendar client. */
  readonly calendar: () => MeetingsCalendarApi;
  /**
   * Called once a meeting's booking is in place: a reschedule making room
   * hands the time it freed to the meeting it was for. Its failure leaves
   * the booking standing, and follow-through finishes it.
   */
  readonly afterBooking: (meeting: SchedulingMeeting) => Promise<void>;
}

/** An event to leave out of a meeting's busy time, by its id or its iCalendar id. */
export interface EventRef {
  readonly id: string;
  readonly iCalUID?: string;
}

/** A Google event id from its parts: lowercase hex, which Google's id alphabet allows. */
function eventIdFor(...parts: readonly string[]): string {
  return createHash('sha256')
    .update(['gws-ea', ...parts].join('|'))
    .digest('hex');
}

/** The hold's event id: the same for the same meeting and slot on every attempt. */
function holdEventId(meetingId: string, slotId: string): string {
  return eventIdFor('hold', meetingId, slotId);
}

/** The id of the event `book` creates for an arranged meeting: one per meeting. */
function bookingEventId(meetingId: string): string {
  return eventIdFor('booking', meetingId);
}

function domainOf(address: string): string {
  return address.slice(address.lastIndexOf('@') + 1).toLowerCase();
}

function slotSpan(slot: { readonly start_at: string; readonly end_at: string }): Span {
  return { start: Date.parse(slot.start_at), end: Date.parse(slot.end_at) };
}

function meetingWindow(meeting: SchedulingMeeting): Span {
  return { start: Date.parse(meeting.window_start), end: Date.parse(meeting.window_end) };
}

/** Whether a slot still has the meeting's length and lies inside its window. */
function fitsMeeting(slot: OfferedSlot | Hold, meeting: SchedulingMeeting): boolean {
  const span = slotSpan(slot);
  const window = meetingWindow(meeting);
  return (
    span.end - span.start === meeting.length_minutes * MINUTE && span.start >= window.start && span.end <= window.end
  );
}

/** A slot as the agent reads it: its weekday, date and local start and end, in `timezone`. */
export function slotLabel(span: Span, timezone: string): string {
  const weekday = new Date(span.start).toLocaleDateString('en-US', { timeZone: timezone, weekday: 'long' });
  const end = new Date(span.end).toLocaleTimeString('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  return `${weekday}, ${formatLocalTime(iso(span.start), timezone)} to ${end} (${timezone})`;
}

function slotIdsOf(value: unknown, max: number): string[] {
  if (!Array.isArray(value) || value.length > max) {
    throw invalid(`slot_ids must list up to ${max} slot ids from meeting_free_time`);
  }
  const ids = value.map((id: unknown) => {
    if (typeof id !== 'string' || !SLOT_ID.test(id)) {
      throw invalid('Each slot id must be one meeting_free_time gave, such as slot-3fa9c2e1b7d0');
    }
    return id;
  });
  return [...new Set(ids)];
}

function slotIdOf(value: unknown): string {
  if (typeof value !== 'string' || !SLOT_ID.test(value)) {
    throw invalid('slot_id must be one meeting_free_time gave, such as slot-3fa9c2e1b7d0');
  }
  return value;
}

interface Narrowing {
  readonly date?: LocalDate;
  /** Minutes of the day, with `date`. */
  readonly time?: number;
  /** The zone `date` and `time` are in, and the extra zone each time is shown in; undefined for the principal's. */
  readonly timezone?: string;
}

function narrowingOf(content: Record<string, unknown>): Narrowing {
  const { date, time, timezone } = content;
  if (timezone !== undefined && (typeof timezone !== 'string' || !isValidTimezone(timezone))) {
    throw invalid('timezone must be an IANA timezone, such as America/New_York');
  }
  if (date === undefined) {
    if (time !== undefined) throw invalid('Give the date a proposed time is on');
    return timezone === undefined ? {} : { timezone };
  }
  const day = typeof date === 'string' ? parseLocalDate(date) : undefined;
  if (day === undefined) throw invalid('date must be a day as YYYY-MM-DD');
  const minutes = typeof time === 'string' ? parseClock(time) : undefined;
  if (time !== undefined && (minutes === undefined || minutes >= 24 * 60)) {
    throw invalid('time must be a 24-hour time as HH:MM, such as 15:30');
  }
  return {
    date: day,
    ...(minutes === undefined ? {} : { time: minutes }),
    ...(timezone === undefined ? {} : { timezone }),
  };
}

/** What every action needs to know about a meeting's calendar. */
interface View {
  readonly timezone: string;
  readonly book: AddressBook;
  readonly rules: SchedulingRules;
  /** Counterparts in the assistant's own Workspace domain, whose free/busy may be visible (R11). */
  readonly colleagues: readonly string[];
  readonly assistantName: string | null;
}

async function viewOf(meeting: SchedulingMeeting): Promise<View> {
  const profile = await getGwsEaProfile();
  const assistantDomain = profile.assistant_workspace_email ? domainOf(profile.assistant_workspace_email) : undefined;
  return {
    timezone: await principalTimezone(),
    book: await addressBook(),
    rules: schedulingRules(await principalPreferences(), meeting.meeting_kind),
    colleagues:
      assistantDomain === undefined
        ? []
        : meeting.counterparts.map((c) => c.address).filter((address) => domainOf(address) === assistantDomain),
    assistantName: profile.assistant_display_name,
  };
}

function holdFields(meeting: SchedulingMeeting, view: View): Pick<EventWrite, 'summary' | 'description'> {
  const holder = view.assistantName ?? 'The assistant';
  return {
    summary: `Hold: ${meeting.purpose}`,
    description: `${holder} is holding this time while a meeting is agreed. It is released on its own.`,
  };
}

function bookingFields(meeting: SchedulingMeeting, view: View): Pick<EventWrite, 'summary' | 'description'> {
  return {
    summary: meeting.purpose,
    description: view.assistantName
      ? `Arranged by ${view.assistantName}, the assistant.`
      : 'Arranged by the assistant.',
  };
}

/** What a free_time answer opens with: what was found, and what to do when nothing was. */
function freeTimeHeading(
  meeting: SchedulingMeeting,
  proposedOpen: boolean | undefined,
  found: boolean,
  oneDay: boolean,
): string {
  if (proposedOpen === true) return 'That time is open:';
  if (proposedOpen === false) {
    return found
      ? 'That time is not open. Open times that day, best first:'
      : 'That time is not open, and nothing else is open that day.';
  }
  if (found) return `Open times for meeting ${meeting.id}, best first:`;
  if (oneDay) return 'Nothing is open that day: call meeting_free_time without a date for other days.';
  return "Nothing in the meeting's window is open: ask main about time with meeting_ask_main, and offer nothing meanwhile.";
}

export function createCalendarActions(deps: CalendarActionsDeps) {
  const calendar = () => deps.calendar();

  // -------------------------------------------------------------------------
  // The calendar, read now
  // -------------------------------------------------------------------------

  /** The principal's calendars, and the meeting's own, each once. */
  async function calendarsOf(meeting: SchedulingMeeting): Promise<string[]> {
    const ids = new Map<string, string>();
    for (const id of [...(await listPrincipalCalendars()), meeting.booking_calendar_id, meeting.event_calendar_id]) {
      if (id !== null && !ids.has(id.toLowerCase())) ids.set(id.toLowerCase(), id);
    }
    return [...ids.values()];
  }

  /** The event a reschedule moves, or the invitation an organizer is asked to move: it never blocks itself. */
  async function movingEventOf(meeting: SchedulingMeeting): Promise<{ id: string; iCalUID?: string } | undefined> {
    if (meeting.event_calendar_id === null || meeting.event_id === null) return undefined;
    const event = await calendar().getEvent(meeting.event_calendar_id, meeting.event_id);
    return { id: meeting.event_id, ...(event?.iCalUID === undefined ? {} : { iCalUID: event.iCalUID }) };
  }

  interface Busy {
    readonly busy: Span[];
    /** Colleagues whose free/busy Google does not show. */
    readonly hidden: string[];
  }

  /**
   * Time taken in `span`: the principal's events that block time, apart from
   * this meeting's own holds and booking, the event it moves, and any event
   * in `ignore`; every visible colleague's busy time; and, for a reschedule
   * making room, the time it frees for the meeting it is making room for.
   */
  async function busyIn(
    meeting: SchedulingMeeting,
    view: View,
    span: Span,
    ignore: readonly EventRef[] = [],
  ): Promise<Busy> {
    const margin = view.rules.bufferMinutes * MINUTE + READ_MARGIN_MS;
    const from = iso(span.start - margin);
    const to = iso(span.end + margin);
    const moving = await movingEventOf(meeting);
    const left = moving ? [moving, ...ignore] : ignore;
    const isOwn = (event: ListedEvent): boolean =>
      event.tags?.[TAG_MEETING] === meeting.id ||
      left.some((ref) => event.id === ref.id || (ref.iCalUID !== undefined && event.iCalUID === ref.iCalUID));
    const busy: Span[] = [];
    const room = await getRoomMadeBy(meeting.id);
    if (room?.state === 'reserved') busy.push({ start: Date.parse(room.start_at), end: Date.parse(room.end_at) });
    const listings = await Promise.all(
      (await calendarsOf(meeting)).map((calendarId) => calendar().listEvents(calendarId, from, to)),
    );
    for (const events of listings) {
      for (const event of events) {
        if (isOwn(event) || !blocksTime(event, view.book.principal)) continue;
        const taken = eventSpan(event, view.timezone);
        if (taken) busy.push(taken);
      }
    }
    const hidden: string[] = [];
    if (view.colleagues.length > 0) {
      const shared = await calendar().freeBusy(view.colleagues, from, to);
      for (const colleague of view.colleagues) {
        const freeBusy = shared.get(colleague.toLowerCase());
        if (!freeBusy?.visible) {
          hidden.push(colleague);
          continue;
        }
        for (const interval of freeBusy.busy) {
          const taken = { start: Date.parse(interval.start), end: Date.parse(interval.end) };
          if (!Number.isNaN(taken.start) && !Number.isNaN(taken.end)) busy.push(taken);
        }
      }
    }
    return { busy, hidden };
  }

  function queryFor(meeting: SchedulingMeeting, view: View, busy: readonly Span[], earliest: number): SlotQuery {
    return {
      timezone: view.timezone,
      level: meeting.level,
      lengthMinutes: meeting.length_minutes,
      window: meetingWindow(meeting),
      earliest,
      busy,
      rules: view.rules,
    };
  }

  // -------------------------------------------------------------------------
  // The assistant's own events
  // -------------------------------------------------------------------------

  /** Whether the event Google holds already says what the write would. */
  function alreadyWritten(current: CalendarEvent, event: NewEvent): boolean {
    const startsTogether =
      current.start?.dateTime !== undefined && Date.parse(current.start.dateTime) === Date.parse(event.start);
    const endsTogether =
      current.end?.dateTime !== undefined && Date.parse(current.end.dateTime) === Date.parse(event.end);
    const invited = new Set((current.attendees ?? []).flatMap((attendee) => attendee.email ?? []));
    return startsTogether && endsTogether && (event.attendees ?? []).every((address) => invited.has(address));
  }

  /**
   * Create the event under its own id, or find the one an earlier attempt
   * made: restored if it was deleted, corrected if its time or people differ,
   * left alone (and nobody emailed again) if it already says the same.
   */
  async function ensureEvent(
    calendarId: string,
    eventId: string,
    event: NewEvent,
    sendUpdates: SendUpdates,
    meetingId: string,
  ): Promise<void> {
    if ((await calendar().insertEvent(calendarId, eventId, event, sendUpdates)) === 'exists') {
      const current = await calendar().getEvent(calendarId, eventId);
      if (!current) throw new Error(`Google holds event ${eventId} on ${calendarId} but returns nothing for it`);
      const deleted = current.status === 'cancelled';
      if (!deleted && current.tags?.[TAG_MEETING] !== meetingId) {
        throw new Error(`Event ${eventId} on ${calendarId} is not meeting ${meetingId}'s`);
      }
      if (deleted || !alreadyWritten(current, event)) {
        await calendar().patchEvent(calendarId, eventId, { ...event, status: 'confirmed' }, sendUpdates);
      }
    }
    recordOwnCalendarChange(calendarId, eventId);
  }

  /**
   * Move an existing event to the slot's time, in place, unless it is there
   * already. Only the time changes: the principal's own title, place and
   * notes stay as they are, and Google sends the attendees the update. False
   * when the event is no longer on the calendar.
   */
  async function moveEvent(calendarId: string, eventId: string, slot: OfferedSlot, timezone: string): Promise<boolean> {
    const current = await calendar().getEvent(calendarId, eventId);
    if (!current || current.status === 'cancelled') return false;
    const span = eventSpan(current, timezone);
    if (!span || span.start !== Date.parse(slot.start_at) || span.end !== Date.parse(slot.end_at)) {
      await calendar().patchEvent(calendarId, eventId, { start: slot.start_at, end: slot.end_at }, 'all');
      recordOwnCalendarChange(calendarId, eventId);
    }
    return true;
  }

  /** Delete one recorded hold, if its event still carries this meeting's tag; then forget the record. */
  async function removeHold(hold: Hold): Promise<void> {
    const event = await calendar().getEvent(hold.calendar_id, hold.event_id);
    if (event && event.status !== 'cancelled') {
      if (event.tags?.[TAG_MEETING] === hold.meeting_id && event.tags[TAG_ROLE] === 'hold') {
        await calendar().deleteEvent(hold.calendar_id, hold.event_id, 'none');
        recordOwnCalendarChange(hold.calendar_id, hold.event_id);
      } else {
        log.warn('A recorded hold no longer carries its meeting’s tag; it is left on the calendar', {
          meetingId: hold.meeting_id,
          calendarId: hold.calendar_id,
          eventId: hold.event_id,
        });
      }
    }
    await deleteHold(hold.meeting_id, hold.slot_id);
  }

  /** Remove each hold; throw after trying them all if any stays, still recorded for the next attempt. */
  async function removeHolds(meetingId: string, holds: readonly Hold[]): Promise<void> {
    let failed = 0;
    for (const hold of holds) {
      /* eslint-disable no-catch-all/no-catch-all -- one hold that cannot go yet must not keep the others; the count is rethrown */
      try {
        await removeHold(hold);
      } catch (err) {
        failed += 1;
        log.warn('A hold could not be released yet', { meetingId, slotId: hold.slot_id, err });
      }
      /* eslint-enable no-catch-all/no-catch-all */
    }
    if (failed > 0) {
      throw new Error(
        `${failed} of meeting ${meetingId}'s holds could not be released yet; they stay recorded and go on the next attempt`,
      );
    }
  }

  /** Release a meeting's holds: every one, or only those that no longer fit it. A reply never holds any. */
  async function releaseHolds(meeting: Meeting, which: 'all' | 'stale' = 'all'): Promise<void> {
    const holds = await listHolds(meeting.id);
    const stale = (hold: Hold) => !isScheduling(meeting) || !fitsMeeting(hold, meeting);
    await removeHolds(meeting.id, which === 'all' ? holds : holds.filter(stale));
  }

  /** Create the meeting's event, or move the event a reschedule is about; returns the booking to record. */
  async function placeBooking(meeting: SchedulingMeeting, view: View, slot: OfferedSlot): Promise<Booking> {
    const bookedAt = new Date().toISOString();
    if (meeting.kind === 'reschedule') {
      if (meeting.event_calendar_id === null || meeting.event_id === null) {
        throw new Error(`Reschedule ${meeting.id} names no event`);
      }
      if (!(await moveEvent(meeting.event_calendar_id, meeting.event_id, slot, view.timezone))) {
        throw refused(
          'The event this meeting moves is no longer on the calendar: report gave-up with meeting_outcome.',
        );
      }
      return {
        meeting_id: meeting.id,
        calendar_id: meeting.event_calendar_id,
        event_id: meeting.event_id,
        start_at: slot.start_at,
        end_at: slot.end_at,
        booked_at: bookedAt,
      };
    }
    if (meeting.booking_calendar_id === null) throw new Error(`Meeting ${meeting.id} has no booking calendar`);
    const eventId = bookingEventId(meeting.id);
    await ensureEvent(
      meeting.booking_calendar_id,
      eventId,
      {
        ...bookingFields(meeting, view),
        start: slot.start_at,
        end: slot.end_at,
        timeZone: view.timezone,
        attendees: meeting.counterparts.map((counterpart) => counterpart.address),
        reminders: 'default',
        tags: { [TAG_MEETING]: meeting.id, [TAG_ROLE]: 'booking' },
      },
      'all',
      meeting.id,
    );
    return {
      meeting_id: meeting.id,
      calendar_id: meeting.booking_calendar_id,
      event_id: eventId,
      start_at: slot.start_at,
      end_at: slot.end_at,
      booked_at: bookedAt,
    };
  }

  /**
   * The booking's text reaches everyone it invites, so nothing private
   * passes (R24); `refusal` says what was not done. A move writes no text.
   */
  async function assertBookable(meeting: SchedulingMeeting, view: View, refusal: string): Promise<void> {
    if (meeting.kind === 'reschedule') return;
    const fields = bookingFields(meeting, view);
    const check = await checkOutbound(
      [fields.summary ?? '', fields.description ?? ''],
      await audienceForAddresses(meeting.counterparts.map((counterpart) => counterpart.address)),
    );
    if (!check.allowed) {
      throw refused(`${refusal}: the meeting's title carries one of the principal's private details (${check.kind}).`);
    }
  }

  // -------------------------------------------------------------------------
  // The requests
  // -------------------------------------------------------------------------

  /**
   * The meeting this conversation runs, still being arranged or booked: a
   * booked one only until its event has passed. A called-off meeting owes
   * one line and offers nothing.
   */
  async function ownLiveMeeting(content: Record<string, unknown>, session: Session): Promise<SchedulingMeeting> {
    const meeting = await ownMeeting(content, session);
    if (meeting.state === 'closing') {
      throw refused(`Meeting ${meeting.id} is called off: send your one closing line, and nothing more.`);
    }
    if ((meeting.state !== 'active' && meeting.state !== 'booked') || meeting.ended_at !== null) {
      throw refused(`Meeting ${meeting.id} has ended (${meeting.state}): send nothing more in this conversation.`);
    }
    return meeting;
  }

  async function ownMeeting(content: Record<string, unknown>, session: Session): Promise<SchedulingMeeting> {
    const meeting = await getMeeting(meetingIdOf(content));
    if (!meeting || meeting.session_id !== session.id) throw refused("That meeting is not this conversation's");
    if (!isScheduling(meeting)) {
      throw refused('This conversation writes one reply: it has no times to offer, hold, or book.');
    }
    return meeting;
  }

  /** Only a meeting the assistant books has holds and a booking. */
  function assertBooks(meeting: SchedulingMeeting): void {
    if (meeting.kind === 'ask_organizer') {
      throw refused(
        'This meeting asks the organizer of an invitation to move it: offer times from meeting_free_time, hold and book nothing, and report settled once they have moved it.',
      );
    }
  }

  /** The offered slots named, each still the meeting's length and inside its window. */
  async function offeredSlots(meeting: SchedulingMeeting, slotIds: readonly string[]): Promise<OfferedSlot[]> {
    const slots: OfferedSlot[] = [];
    for (const slotId of slotIds) {
      const slot = await getOfferedSlot(meeting.id, slotId);
      if (!slot) throw refused(`${slotId} was not offered for this meeting: use a slot id meeting_free_time gave you`);
      if (!fitsMeeting(slot, meeting)) {
        throw refused(
          `${slotId} was offered under an earlier brief and no longer fits the meeting's length or window: call meeting_free_time again`,
        );
      }
      slots.push(slot);
    }
    return slots;
  }

  /** Whether every slot is open now, by the same rules that offered it. */
  async function closedSlots(meeting: SchedulingMeeting, view: View, slots: readonly OfferedSlot[]): Promise<string[]> {
    const spans = slots.map(slotSpan);
    const covering = {
      start: Math.min(...spans.map((span) => span.start)),
      end: Math.max(...spans.map((span) => span.end)),
    };
    const { busy } = await busyIn(meeting, view, covering);
    const query = queryFor(meeting, view, busy, Date.now());
    return slots.filter((slot) => !isOpen(Date.parse(slot.start_at), query)).map((slot) => slot.slot_id);
  }

  const freeTime: Handle = async (content, session) => {
    const meeting = await ownLiveMeeting(content, session);
    const answered = await countAnswers(meeting.id, FREE_TIME_ACTION);
    if (answered >= MAX_FREE_TIME_ANSWERS) {
      throw refused(
        `meeting_free_time has answered ${MAX_FREE_TIME_ANSWERS} times for this meeting already: offer from the times you have, or report gave-up with meeting_outcome.`,
      );
    }
    const narrowing = narrowingOf(content);
    const view = await viewOf(meeting);
    const now = Date.now();
    const earliest = now + MIN_NOTICE_MINUTES * MINUTE;
    const window = meetingWindow(meeting);
    const zone = narrowing.timezone ?? view.timezone;
    const day = narrowing.date === undefined ? undefined : localDaySpan(narrowing.date, zone);
    if (day && (day.end <= window.start || day.start >= window.end)) {
      throw refused('That day is outside the meeting’s window: offer a day inside it, or tell them the window.');
    }
    const range = {
      start: Math.max(window.start, earliest, day?.start ?? -Infinity),
      end: Math.min(window.end, day?.end ?? Infinity),
    };
    const { busy } = await busyIn(meeting, view, range.start < range.end ? range : window);
    const query = queryFor(meeting, view, busy, earliest);

    let proposedOpen: boolean | undefined;
    let chosen: Span[];
    if (narrowing.date !== undefined && narrowing.time !== undefined) {
      const start = zonedInstant(narrowing.date, narrowing.time, zone);
      proposedOpen = isOpen(start, query);
      chosen = proposedOpen
        ? [{ start, end: start + meeting.length_minutes * MINUTE }]
        : bestSlots(query, openSlots(query, day), MAX_OFFERED, now);
    } else {
      chosen = bestSlots(query, openSlots(query, day), MAX_OFFERED, now);
    }

    const offered: OfferedSlot[] = chosen.map((span) => ({
      slot_id: slotIdFor(meeting.id, span),
      start_at: iso(span.start),
      end_at: iso(span.end),
    }));
    await recordOfferedSlots(meeting.id, offered, new Date().toISOString());
    const held = new Set((await listHolds(meeting.id)).map((hold) => hold.slot_id));
    const slots = offered.map((slot) => ({
      slot_id: slot.slot_id,
      start: slot.start_at,
      end: slot.end_at,
      held: held.has(slot.slot_id),
    }));

    const display = await resolveGroupTimezone(session.agent_group_id);
    const lines = offered.map((slot) => {
      const span = slotSpan(slot);
      const theirs = narrowing.timezone !== undefined && narrowing.timezone !== display;
      return (
        `- ${slot.slot_id}: ${slotLabel(span, display)}` +
        (theirs ? `; for them, ${slotLabel(span, narrowing.timezone ?? display)}` : '') +
        (held.has(slot.slot_id) ? ' (held)' : '')
      );
    });
    const heading = freeTimeHeading(meeting, proposedOpen, offered.length > 0, day !== undefined);
    const footer =
      offered.length > 0
        ? 'Offer two or three of them, on different days where you can, and hold each one you offer. '
        : '';
    return {
      meetingId: meeting.id,
      data: {
        meeting_id: meeting.id,
        slots,
        message: [
          heading,
          ...lines,
          `${footer}meeting_free_time has answered ${answered + 1} of ${MAX_FREE_TIME_ANSWERS} times for this meeting.`,
        ].join('\n'),
      },
    };
  };

  /**
   * Hold offered slots on the meeting's booking calendar, each only while it
   * is still open, and start its follow-through deadlines. Holding a slot
   * held already changes nothing. With `exact`, the meeting then holds those
   * slots and no others: every other hold is released once the named ones
   * are known to be open, so a refusal changes nothing. The meeting's own
   * `meeting_hold` holds exactly; the host adds to them when it hands a
   * freed time to the meeting that needed room.
   */
  async function holdSlots(
    meeting: SchedulingMeeting,
    slotIds: readonly string[],
    exact = false,
  ): Promise<OfferedSlot[]> {
    assertBooks(meeting);
    if (meeting.state === 'booked' || (await getBooking(meeting.id)) !== undefined) {
      throw refused(`Meeting ${meeting.id} is booked: there is nothing more to hold.`);
    }
    const calendarId = meeting.booking_calendar_id;
    if (calendarId === null) throw new Error(`Meeting ${meeting.id} has no booking calendar`);
    const existing = await listHolds(meeting.id);
    const heldIds = new Set(existing.map((held) => held.slot_id));
    const fresh = slotIds.filter((slotId) => !heldIds.has(slotId));
    const kept = exact ? existing.filter((held) => slotIds.includes(held.slot_id)) : existing;
    if (kept.length + fresh.length > MAX_HOLDS) {
      throw refused(
        `A meeting holds at most three times, and this one holds ${existing.length}: hold only the times you offer now.`,
      );
    }
    const slots = await offeredSlots(meeting, slotIds);
    const view = await viewOf(meeting);
    const closed = slots.length === 0 ? [] : await closedSlots(meeting, view, slots);
    if (closed.length > 0) {
      throw refused(`${closed.join(', ')} is no longer open: call meeting_free_time again for times to offer instead.`);
    }
    const fields = holdFields(meeting, view);
    const check = await checkOutbound([fields.summary ?? '', fields.description ?? ''], await audienceForAddresses([]));
    if (!check.allowed) {
      throw refused(
        `The hold was not placed: the meeting's title carries one of the principal's private details (${check.kind}). Report gave-up with meeting_outcome.`,
      );
    }
    if (exact)
      await removeHolds(
        meeting.id,
        existing.filter((held) => !slotIds.includes(held.slot_id)),
      );
    for (const slot of slots) {
      const eventId = holdEventId(meeting.id, slot.slot_id);
      // Recorded first, so a release finds it whatever happens to the write.
      await recordHold({
        meeting_id: meeting.id,
        slot_id: slot.slot_id,
        calendar_id: calendarId,
        event_id: eventId,
        start_at: slot.start_at,
        end_at: slot.end_at,
        held_at: new Date().toISOString(),
      });
      await ensureEvent(
        calendarId,
        eventId,
        {
          ...fields,
          start: slot.start_at,
          end: slot.end_at,
          timeZone: view.timezone,
          attendees: [],
          visibility: 'private',
          transparency: 'opaque',
          reminders: 'none',
          tags: { [TAG_MEETING]: meeting.id, [TAG_ROLE]: 'hold', [TAG_SLOT]: slot.slot_id },
        },
        'none',
        meeting.id,
      );
    }
    if (slots.length > 0) {
      const at = new Date();
      await startDeadlines(meeting.id, await deadlinesFrom(at.getTime()), at.toISOString());
    }
    return slots;
  }

  const hold: Handle = async (content, session) => {
    const meeting = await ownLiveMeeting(content, session);
    assertBooks(meeting);
    const slots = await holdSlots(meeting, slotIdsOf(content.slot_ids, MAX_HOLDS), true);
    const display = await resolveGroupTimezone(session.agent_group_id);
    return {
      meetingId: meeting.id,
      data: {
        meeting_id: meeting.id,
        held: slots.map((slot) => ({ slot_id: slot.slot_id, start: slot.start_at, end: slot.end_at })),
        message:
          slots.length === 0
            ? `Meeting ${meeting.id} holds no times now.`
            : [
                `Meeting ${meeting.id} now holds:`,
                ...slots.map((slot) => `- ${slot.slot_id}: ${slotLabel(slotSpan(slot), display)}`),
                'Any other time it held is released.',
              ].join('\n'),
      },
    };
  };

  /**
   * Move a booked meeting's event to a newly offered slot, in place, when
   * the counterpart asks: only its time changes, Google sends the attendees
   * the update, and main hears of it in one note. The note is written before
   * the new time is recorded, under an id for this move, so a repeat after
   * any failure finishes the move and tells main once.
   */
  async function moveBooking(
    meeting: SchedulingMeeting,
    existing: Booking,
    slot: OfferedSlot,
    view: View,
    display: string,
  ): Promise<Answer> {
    const closed = await closedSlots(meeting, view, [slot]);
    if (closed.length > 0) {
      throw refused(`${slot.slot_id} is no longer open: call meeting_free_time again for times to offer instead.`);
    }
    if (!(await moveEvent(existing.calendar_id, existing.event_id, slot, view.timezone))) {
      throw refused(
        'The booked event is no longer on the principal’s calendar, so there is nothing to move. Tell them so, and offer nothing.',
      );
    }
    const timezone = await mainTimezone();
    const minutes = Math.round((Date.parse(slot.end_at) - Date.parse(slot.start_at)) / MINUTE);
    await writeMainNote(
      `meeting-moved-${meeting.id}-${Date.parse(existing.start_at)}-${slot.slot_id}`,
      {
        type: MOVED_NOTE_TYPE,
        meeting_id: meeting.id,
        purpose: meeting.purpose,
        counterparts: noteCounterparts(meeting),
        booking: {
          calendar_id: existing.calendar_id,
          event_id: existing.event_id,
          start: slot.start_at,
          end: slot.end_at,
        },
        previous: { start: existing.start_at, end: existing.end_at },
      },
      `At their request, meeting ${meeting.id}, "${meeting.purpose}" with ${who(meeting)}, moved from ` +
        `${formatLocalTime(existing.start_at, timezone)} to ${formatLocalTime(slot.start_at, timezone)} (${minutes} minutes), ` +
        `on calendar ${existing.calendar_id}. Google sent them the update. Tell the principal in one line.`,
      new Date().toISOString(),
    );
    await updateBookingTime(meeting.id, slot.start_at, slot.end_at);
    return {
      meetingId: meeting.id,
      data: {
        meeting_id: meeting.id,
        booking: {
          calendar_id: existing.calendar_id,
          event_id: existing.event_id,
          start: slot.start_at,
          end: slot.end_at,
        },
        message:
          `Moved: ${slotLabel(slotSpan(slot), display)}. Google sends ${meeting.counterparts.map((c) => c.address).join(', ')} ` +
          "the update from the principal's calendar, and main tells the principal. There is no outcome to report.",
      },
    };
  }

  const book: Handle = async (content, session) => {
    const meeting = await ownLiveMeeting(content, session);
    assertBooks(meeting);
    const slotId = slotIdOf(content.slot_id);
    const [slot] = await offeredSlots(meeting, [slotId]);
    const view = await viewOf(meeting);
    const display = await resolveGroupTimezone(session.agent_group_id);
    const existing = await getBooking(meeting.id);
    let booking: Booking;
    if (existing) {
      if (existing.start_at !== slot.start_at || existing.end_at !== slot.end_at) {
        if (meeting.state === 'booked') return moveBooking(meeting, existing, slot, view, display);
        throw refused(
          `Meeting ${meeting.id} is already booked for ${slotLabel(slotSpan(existing), display)}. Report booked with meeting_outcome if you have not.`,
        );
      }
      // A repeat: the event already says this, so nobody is emailed again; it finishes what an earlier attempt left.
      await placeBooking(meeting, view, slot);
      booking = existing;
    } else {
      const closed = await closedSlots(meeting, view, [slot]);
      if (closed.length > 0)
        throw refused(`${slotId} is no longer open: call meeting_free_time again for times to offer instead.`);
      await assertBookable(
        meeting,
        view,
        'The booking was not made; report gave-up with meeting_outcome, so main can arrange it again under another purpose',
      );
      booking = await placeBooking(meeting, view, slot);
      await recordBooking(booking);
    }
    // A question main has not answered keeps its own count; nothing else waits once the meeting is booked.
    if (meeting.asked_at === null) await clearDeadlines(meeting.id, new Date().toISOString());
    let holdsLeft = '';
    /* eslint-disable no-catch-all/no-catch-all -- the booking stands; holds left over go on a repeat of book, or follow-through releases them */
    try {
      await releaseHolds(meeting, 'all');
    } catch (err) {
      log.warn('A booked meeting’s holds were not all released', { meetingId: meeting.id, err });
      holdsLeft = ' Some holds could not be released yet: call meeting_book again with the same slot to finish.';
    }
    try {
      await deps.afterBooking(meeting);
    } catch (err) {
      log.warn('What follows a booking did not finish; follow-through finishes it', { meetingId: meeting.id, err });
    }
    /* eslint-enable no-catch-all/no-catch-all */
    if (meeting.state === 'booked') {
      return {
        meetingId: meeting.id,
        data: {
          meeting_id: meeting.id,
          booking: {
            calendar_id: booking.calendar_id,
            event_id: booking.event_id,
            start: booking.start_at,
            end: booking.end_at,
          },
          message: `Meeting ${meeting.id} is booked for ${slotLabel(slotSpan(booking), display)}: nothing changed.${holdsLeft}`,
        },
      };
    }
    const moved = meeting.kind === 'reschedule';
    return {
      meetingId: meeting.id,
      data: {
        meeting_id: meeting.id,
        booking: {
          calendar_id: booking.calendar_id,
          event_id: booking.event_id,
          start: booking.start_at,
          end: booking.end_at,
        },
        message:
          `${moved ? 'Moved' : 'Booked'}: ${slotLabel(slotSpan(slot), display)}. ` +
          `Google sends ${meeting.counterparts.map((c) => c.address).join(', ')} the ${moved ? 'update' : 'invitation'} from the principal's calendar, ` +
          `and the other holds are released.${holdsLeft} Now report booked with meeting_outcome.`,
      },
    };
  };

  /**
   * Book an arranged meeting at once when everyone in it is a colleague
   * whose free/busy Google shows (R11): the best time free for all, with
   * Google's invitation and no email. Undefined when the meeting is not
   * such a meeting, or nothing in its window is free.
   */
  async function bookDirectly(meeting: SchedulingMeeting): Promise<Booking | undefined> {
    if (meeting.kind !== 'arrange' || meeting.booking_calendar_id === null) return undefined;
    const view = await viewOf(meeting);
    if (view.colleagues.length === 0 || view.colleagues.length !== meeting.counterparts.length) return undefined;
    const now = Date.now();
    const earliest = now + MIN_NOTICE_MINUTES * MINUTE;
    const window = meetingWindow(meeting);
    const range = { start: Math.max(window.start, earliest), end: window.end };
    if (range.start >= range.end) return undefined;
    const { busy, hidden } = await busyIn(meeting, view, range);
    if (hidden.length > 0) return undefined;
    const query = queryFor(meeting, view, busy, earliest);
    const [best] = bestSlots(query, openSlots(query), 1, now);
    if (!best) return undefined;
    await assertBookable(meeting, view, 'The meeting was not booked');
    const slot: OfferedSlot = {
      slot_id: slotIdFor(meeting.id, best),
      start_at: iso(best.start),
      end_at: iso(best.end),
    };
    await recordOfferedSlots(meeting.id, [slot], new Date().toISOString());
    try {
      const booking = await placeBooking(meeting, view, slot);
      await recordBooking(booking);
      return booking;
    } catch (error) {
      // The meeting fails and main may ask again: no invitation is left behind for a meeting that does not exist.
      /* eslint-disable no-catch-all/no-catch-all -- the booking already failed; withdrawing it is best effort and logged */
      try {
        await calendar().deleteEvent(meeting.booking_calendar_id, bookingEventId(meeting.id), 'all');
      } catch (err) {
        log.error('A direct booking that failed could not be withdrawn', { meetingId: meeting.id, err });
      }
      /* eslint-enable no-catch-all/no-catch-all */
      throw error;
    }
  }

  /**
   * Bring a booked meeting's event in line with the meeting after main added
   * people (KTD3): every one of them invited, with Google's update. Its text
   * is checked against them all first, so a refusal writes nothing.
   */
  async function updateBooking(meeting: SchedulingMeeting): Promise<void> {
    const booking = await getBooking(meeting.id);
    if (!booking) throw refused(`Meeting ${meeting.id} has no booking to update`);
    await assertBookable(meeting, await viewOf(meeting), 'Nobody was added');
    await calendar().patchEvent(
      booking.calendar_id,
      booking.event_id,
      { attendees: meeting.counterparts.map((counterpart) => counterpart.address) },
      'all',
    );
    recordOwnCalendarChange(booking.calendar_id, booking.event_id);
  }

  /** Whether anything in the meeting's window is open now, as meeting_free_time would offer it. */
  async function hasOpenTime(meeting: SchedulingMeeting): Promise<boolean> {
    return (await openTimes(meeting, meetingWindow(meeting), [])).length > 0;
  }

  /**
   * Open times for a meeting inside `range`, best first, as if the events in
   * `ignore` were not on the calendar: what moving them would free (R14).
   */
  async function openTimes(meeting: SchedulingMeeting, range: Span, ignore: readonly EventRef[]): Promise<Span[]> {
    const view = await viewOf(meeting);
    const now = Date.now();
    const earliest = now + MIN_NOTICE_MINUTES * MINUTE;
    const { busy } = await busyIn(meeting, view, range, ignore);
    const query = queryFor(meeting, view, busy, earliest);
    return bestSlots(query, openSlots(query, range), MAX_OFFERED, now);
  }

  return {
    freeTime,
    hold,
    book,
    releaseHolds,
    bookDirectly,
    holdSlots,
    openTimes,
    hasOpenTime,
    updateBooking,
  };
}

export type CalendarActions = ReturnType<typeof createCalendarActions>;
