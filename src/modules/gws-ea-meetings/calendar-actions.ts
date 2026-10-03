/**
 * external-email's calendar actions (KTD11; R4, R5, R6, R11, R20, R24):
 * host tools that take slot ids, never free text, and reveal nothing of the
 * principal's calendar but candidate start times.
 *
 * - `free_time` offers a capped list of start times of the meeting's length,
 *   each with an opaque slot id, inside the meeting's window, from the
 *   principal's calendars and visible colleagues' free/busy, the principal's
 *   preferences, and R13's rule for the meeting's level (`slots.ts`). It
 *   can narrow to one day and check one proposed time, in the counterpart's
 *   timezone, so no date arithmetic is left to the agent. Its answers per
 *   meeting are capped.
 * - `hold` places a private, busy, silent event on the meeting's booking
 *   calendar for each offered slot that is still open, at most three per
 *   meeting, under an id derived from the meeting and the slot.
 * - `book` creates the one meeting event from the meeting record: its
 *   people as attendees, its purpose as the title, and a fixed line, with
 *   Google's invitations sent; for a reschedule it moves the original event
 *   instead, keeping its id. The id is derived from the meeting, so a retry
 *   after a partial failure finds the event it made. It then releases every
 *   hold.
 * - `release_holds` deletes only the meeting's holds the assistant recorded
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
import { getDb } from '../../db/connection.js';
import { log } from '../../log.js';
import { formatLocalTime, isValidTimezone } from '../../timezone.js';
import type { Session } from '../../types.js';
import { recordOwnCalendarChange } from '../gws-ea-inbox/calendar-notifications.js';
import { listPrincipalCalendars } from '../gws-ea-inbox/db.js';
import { getSchedulingPreferenceValues, type SchedulingPreferenceValues } from '../gws-ea-preferences/db.js';
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
  LIVE_STATES,
  listHolds,
  recordBooking,
  recordHold,
  recordOfferedSlots,
  type Booking,
  type Hold,
  type Meeting,
  type OfferedSlot,
} from './db.js';
import {
  addressBook,
  invalid,
  meetingIdOf,
  principalTimezone,
  refused,
  type AddressBook,
  type Handle,
} from './handoff.js';
import {
  bestSlots,
  blocksTime,
  eventSpan,
  isOpen,
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

/** The private tags on the assistant's own events. */
const TAG_MEETING = 'gwsEaMeeting';
const TAG_ROLE = 'gwsEaRole';
const TAG_SLOT = 'gwsEaSlot';

const MINUTE = 60_000;
const SLOT_ID = /^slot-[0-9a-f]{12}$/u;

export interface CalendarActionsDeps {
  /** The host's own Calendar client. */
  readonly calendar: () => MeetingsCalendarApi;
}

const NO_PREFERENCES: SchedulingPreferenceValues = {
  working_hours: [],
  protected_windows: [],
  meeting_lengths: [],
  buffers: [],
  preferred_times: [],
};

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

function iso(instant: number): string {
  return new Date(instant).toISOString();
}

function slotSpan(slot: { readonly start_at: string; readonly end_at: string }): Span {
  return { start: Date.parse(slot.start_at), end: Date.parse(slot.end_at) };
}

function meetingWindow(meeting: Meeting): Span {
  return { start: Date.parse(meeting.window_start), end: Date.parse(meeting.window_end) };
}

/** Whether a slot still has the meeting's length and lies inside its window. */
function fitsMeeting(slot: OfferedSlot | Hold, meeting: Meeting): boolean {
  const span = slotSpan(slot);
  const window = meetingWindow(meeting);
  return (
    span.end - span.start === meeting.length_minutes * MINUTE && span.start >= window.start && span.end <= window.end
  );
}

/** A slot as the agent reads it: its weekday, date and local start and end, in `timezone`. */
function slotLabel(span: Span, timezone: string): string {
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
  if (!Array.isArray(value) || value.length === 0 || value.length > max) {
    throw invalid(`slot_ids must list 1 to ${max} slot ids from free_time`);
  }
  const ids = value.map((id: unknown) => {
    if (typeof id !== 'string' || !SLOT_ID.test(id)) {
      throw invalid('Each slot id must be one free_time gave, such as slot-3fa9c2e1b7d0');
    }
    return id;
  });
  return [...new Set(ids)];
}

function slotIdOf(value: unknown): string {
  if (typeof value !== 'string' || !SLOT_ID.test(value)) {
    throw invalid('slot_id must be one free_time gave, such as slot-3fa9c2e1b7d0');
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

/** The principal's preferences, or none while the store does not exist yet. */
async function preferenceValues(): Promise<SchedulingPreferenceValues> {
  if (!(await getDb().hasTable('gws_ea_pref_working_hours'))) return NO_PREFERENCES;
  return getSchedulingPreferenceValues();
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

async function viewOf(meeting: Meeting): Promise<View> {
  const profile = await getGwsEaProfile();
  const assistantDomain = profile.assistant_workspace_email ? domainOf(profile.assistant_workspace_email) : undefined;
  return {
    timezone: await principalTimezone(),
    book: await addressBook(),
    rules: schedulingRules(await preferenceValues(), meeting.meeting_kind),
    colleagues:
      assistantDomain === undefined
        ? []
        : meeting.counterparts.map((c) => c.address).filter((address) => domainOf(address) === assistantDomain),
    assistantName: profile.assistant_display_name,
  };
}

function holdFields(meeting: Meeting, view: View): Pick<EventWrite, 'summary' | 'description'> {
  const holder = view.assistantName ?? 'The assistant';
  return {
    summary: `Hold: ${meeting.purpose}`,
    description: `${holder} is holding this time while a meeting is agreed. It is released on its own.`,
  };
}

function bookingFields(meeting: Meeting, view: View): Pick<EventWrite, 'summary' | 'description'> {
  return {
    summary: meeting.purpose,
    description: view.assistantName
      ? `Arranged by ${view.assistantName}, the assistant.`
      : 'Arranged by the assistant.',
  };
}

/** What a free_time answer opens with: what was found, and what to do when nothing was. */
function freeTimeHeading(meeting: Meeting, proposedOpen: boolean | undefined, found: boolean, oneDay: boolean): string {
  if (proposedOpen === true) return 'That time is open:';
  if (proposedOpen === false) {
    return found
      ? 'That time is not open. Open times that day, best first:'
      : 'That time is not open, and nothing else is open that day.';
  }
  if (found) return `Open times for meeting ${meeting.id}, best first:`;
  if (oneDay) return 'Nothing is open that day: call free_time without a date for other days.';
  return meeting.level === 'inner-circle' || meeting.level === 'close'
    ? "Nothing in the meeting's window is open. Report needs-room with outcome."
    : "Nothing in the meeting's window is open: report gave-up with outcome, so main can tell the principal.";
}

export function createCalendarActions(deps: CalendarActionsDeps) {
  const calendar = () => deps.calendar();

  // -------------------------------------------------------------------------
  // The calendar, read now
  // -------------------------------------------------------------------------

  /** The principal's calendars, and the meeting's own, each once. */
  async function calendarsOf(meeting: Meeting): Promise<string[]> {
    const ids = new Map<string, string>();
    for (const id of [...(await listPrincipalCalendars()), meeting.booking_calendar_id, meeting.event_calendar_id]) {
      if (id !== null && !ids.has(id.toLowerCase())) ids.set(id.toLowerCase(), id);
    }
    return [...ids.values()];
  }

  /** The event a reschedule moves, or the invitation an organizer is asked to move: it never blocks itself. */
  async function movingEventOf(meeting: Meeting): Promise<{ id: string; iCalUID?: string } | undefined> {
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
   * this meeting's own holds and booking and the event it moves, and every
   * visible colleague's busy time.
   */
  async function busyIn(meeting: Meeting, view: View, span: Span): Promise<Busy> {
    const margin = view.rules.bufferMinutes * MINUTE + READ_MARGIN_MS;
    const from = iso(span.start - margin);
    const to = iso(span.end + margin);
    const moving = await movingEventOf(meeting);
    const isOwn = (event: ListedEvent): boolean =>
      event.tags?.[TAG_MEETING] === meeting.id ||
      (moving !== undefined &&
        (event.id === moving.id || (moving.iCalUID !== undefined && event.iCalUID === moving.iCalUID)));
    const busy: Span[] = [];
    for (const calendarId of await calendarsOf(meeting)) {
      for (const event of await calendar().listEvents(calendarId, from, to)) {
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

  function queryFor(meeting: Meeting, view: View, busy: readonly Span[], earliest: number): SlotQuery {
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

  async function releaseHolds(meeting: Meeting, which: 'all' | 'stale' = 'all'): Promise<void> {
    const holds = await listHolds(meeting.id);
    await removeHolds(meeting.id, which === 'all' ? holds : holds.filter((hold) => !fitsMeeting(hold, meeting)));
  }

  /** Create the meeting's event, or move the event a reschedule is about; returns the booking to record. */
  async function placeBooking(meeting: Meeting, view: View, slot: OfferedSlot): Promise<Booking> {
    const bookedAt = new Date().toISOString();
    if (meeting.kind === 'reschedule') {
      if (meeting.event_calendar_id === null || meeting.event_id === null) {
        throw new Error(`Reschedule ${meeting.id} names no event`);
      }
      const current = await calendar().getEvent(meeting.event_calendar_id, meeting.event_id);
      if (!current || current.status === 'cancelled') {
        throw refused('The event this meeting moves is no longer on the calendar: report gave-up with outcome.');
      }
      const span = eventSpan(current, view.timezone);
      if (!span || span.start !== Date.parse(slot.start_at) || span.end !== Date.parse(slot.end_at)) {
        // Only the time changes: the principal's own title, place and notes stay as they are.
        await calendar().patchEvent(
          meeting.event_calendar_id,
          meeting.event_id,
          { start: slot.start_at, end: slot.end_at },
          'all',
        );
        recordOwnCalendarChange(meeting.event_calendar_id, meeting.event_id);
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

  /** The booking's text may reach its attendees, so nothing private passes (R24). A move writes no text. */
  async function assertBookable(meeting: Meeting, view: View): Promise<void> {
    if (meeting.kind === 'reschedule') return;
    const fields = bookingFields(meeting, view);
    const check = await checkOutbound(
      [fields.summary ?? '', fields.description ?? ''],
      await audienceForAddresses(meeting.counterparts.map((counterpart) => counterpart.address)),
    );
    if (!check.allowed) {
      throw refused(
        `The booking was not made: the meeting's title carries one of the principal's private details (${check.kind}). ` +
          'Report gave-up with outcome, so main can arrange it again under another purpose.',
      );
    }
  }

  // -------------------------------------------------------------------------
  // The requests
  // -------------------------------------------------------------------------

  /** The meeting this conversation runs, still live. */
  async function ownLiveMeeting(content: Record<string, unknown>, session: Session): Promise<Meeting> {
    const meeting = await ownMeeting(content, session);
    if (!LIVE_STATES.some((state) => state === meeting.state)) {
      throw refused(`Meeting ${meeting.id} has ended (${meeting.state}): send nothing more in this conversation.`);
    }
    return meeting;
  }

  async function ownMeeting(content: Record<string, unknown>, session: Session): Promise<Meeting> {
    const meeting = await getMeeting(meetingIdOf(content));
    if (!meeting || meeting.session_id !== session.id) throw refused("That meeting is not this conversation's");
    return meeting;
  }

  /** Only a meeting the assistant books has holds and a booking. */
  function assertBooks(meeting: Meeting): void {
    if (meeting.kind === 'ask_organizer') {
      throw refused(
        'This meeting asks the organizer of an invitation to move it: offer times from free_time, hold and book nothing, and report settled once they have moved it.',
      );
    }
  }

  /** The offered slots named, each still the meeting's length and inside its window. */
  async function offeredSlots(meeting: Meeting, slotIds: readonly string[]): Promise<OfferedSlot[]> {
    const slots: OfferedSlot[] = [];
    for (const slotId of slotIds) {
      const slot = await getOfferedSlot(meeting.id, slotId);
      if (!slot) throw refused(`${slotId} was not offered for this meeting: use a slot id free_time gave you`);
      if (!fitsMeeting(slot, meeting)) {
        throw refused(
          `${slotId} was offered under an earlier brief and no longer fits the meeting's length or window: call free_time again`,
        );
      }
      slots.push(slot);
    }
    return slots;
  }

  /** Whether every slot is open now, by the same rules that offered it. */
  async function closedSlots(meeting: Meeting, view: View, slots: readonly OfferedSlot[]): Promise<string[]> {
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
        `free_time has answered ${MAX_FREE_TIME_ANSWERS} times for this meeting already: offer from the times you have, or report gave-up with outcome.`,
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
          `${footer}free_time has answered ${answered + 1} of ${MAX_FREE_TIME_ANSWERS} times for this meeting.`,
        ].join('\n'),
      },
    };
  };

  const hold: Handle = async (content, session) => {
    const meeting = await ownLiveMeeting(content, session);
    assertBooks(meeting);
    if (meeting.state === 'booked' || (await getBooking(meeting.id)) !== undefined) {
      throw refused(`Meeting ${meeting.id} is booked: there is nothing more to hold.`);
    }
    const calendarId = meeting.booking_calendar_id;
    if (calendarId === null) throw new Error(`Meeting ${meeting.id} has no booking calendar`);
    const slotIds = slotIdsOf(content.slot_ids, MAX_HOLDS);
    const existing = await listHolds(meeting.id);
    const heldIds = new Set(existing.map((held) => held.slot_id));
    const fresh = slotIds.filter((slotId) => !heldIds.has(slotId));
    if (existing.length + fresh.length > MAX_HOLDS) {
      throw refused(
        `A meeting holds at most three times, and this one holds ${existing.length}: release_holds the times they turned down first.`,
      );
    }
    const slots = await offeredSlots(meeting, slotIds);
    const view = await viewOf(meeting);
    const closed = await closedSlots(meeting, view, slots);
    if (closed.length > 0) {
      throw refused(`${closed.join(', ')} is no longer open: call free_time again for times to offer instead.`);
    }
    const fields = holdFields(meeting, view);
    const check = await checkOutbound([fields.summary ?? '', fields.description ?? ''], await audienceForAddresses([]));
    if (!check.allowed) {
      throw refused(
        `The hold was not placed: the meeting's title carries one of the principal's private details (${check.kind}). Report gave-up with outcome.`,
      );
    }
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
    const display = await resolveGroupTimezone(session.agent_group_id);
    return {
      meetingId: meeting.id,
      data: {
        meeting_id: meeting.id,
        held: slots.map((slot) => ({ slot_id: slot.slot_id, start: slot.start_at, end: slot.end_at })),
        message: [
          `Held for meeting ${meeting.id}:`,
          ...slots.map((slot) => `- ${slot.slot_id}: ${slotLabel(slotSpan(slot), display)}`),
          'When they pick one, book it. If they turn these down, release_holds them before you offer others.',
        ].join('\n'),
      },
    };
  };

  const releaseHoldsRequest: Handle = async (content, session) => {
    const meeting = await ownMeeting(content, session);
    const holds = await listHolds(meeting.id);
    const named = content.slot_ids === undefined ? undefined : slotIdsOf(content.slot_ids, MAX_HOLDS);
    const targets = named === undefined ? holds : holds.filter((held) => named.includes(held.slot_id));
    const notHeld = named === undefined ? [] : named.filter((slotId) => !holds.some((held) => held.slot_id === slotId));
    await removeHolds(meeting.id, targets);
    return {
      meetingId: meeting.id,
      data: {
        meeting_id: meeting.id,
        released: targets.map((held) => held.slot_id),
        message:
          (targets.length === 0
            ? `Meeting ${meeting.id} had no holds to release.`
            : `Released ${targets.length} hold${targets.length === 1 ? '' : 's'} for meeting ${meeting.id}.`) +
          (notHeld.length > 0 ? ` Not held: ${notHeld.join(', ')}.` : ''),
      },
    };
  };

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
        throw refused(
          `Meeting ${meeting.id} is already booked for ${slotLabel(slotSpan(existing), display)}. Report booked with outcome if you have not.`,
        );
      }
      // A repeat: the event already says this, so nobody is emailed again; it finishes what an earlier attempt left.
      await placeBooking(meeting, view, slot);
      booking = existing;
    } else {
      const closed = await closedSlots(meeting, view, [slot]);
      if (closed.length > 0)
        throw refused(`${slotId} is no longer open: call free_time again for times to offer instead.`);
      await assertBookable(meeting, view);
      booking = await placeBooking(meeting, view, slot);
      await recordBooking(booking);
    }
    await clearDeadlines(meeting.id, new Date().toISOString());
    let holdsLeft = '';
    /* eslint-disable no-catch-all/no-catch-all -- the booking stands; holds left over go on a repeat of book or when the meeting ends */
    try {
      await releaseHolds(meeting, 'all');
    } catch (err) {
      log.warn('A booked meeting’s holds were not all released', { meetingId: meeting.id, err });
      holdsLeft = ' Some holds could not be released yet: call book again with the same slot to finish.';
    }
    /* eslint-enable no-catch-all/no-catch-all */
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
          `and the other holds are released.${holdsLeft} Now report booked with outcome.`,
      },
    };
  };

  /**
   * Book an arranged meeting at once when everyone in it is a colleague
   * whose free/busy Google shows (R11): the best time free for all, with
   * Google's invitation and no email. Undefined when the meeting is not
   * such a meeting, or nothing in its window is free.
   */
  async function bookDirectly(meeting: Meeting): Promise<Booking | undefined> {
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
    await assertBookable(meeting, view);
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

  return {
    freeTime,
    hold,
    releaseHoldsRequest,
    book,
    releaseHolds,
    bookDirectly,
  };
}

export type CalendarActions = ReturnType<typeof createCalendarActions>;
