/**
 * external-email's scheduling tools (KTD7; R69, R70, R71): five host
 * actions, each bound to the email thread whose session calls it
 * (`threadCalendarAction` in `guard.ts`). No argument names a thread, so a
 * call never reaches another thread's holds or bookings.
 *
 *   free_time       { from, to, minutes, timezone? } → { times, message }
 *   hold            { starts, minutes }              → { held, message }
 *   book            { start, minutes, title, notes?, location?, video_call?, invitees? }
 *                                                     → { booking, start, end, message }
 *   move_booking    { booking, start }               → { booking, start, end, message }
 *   cancel_booking  { booking }                      → { booking, message }
 *
 * - `free_time` offers up to eight start times from the principal's
 *   free/busy alone, never inside protected time, best fit first and spread
 *   across the range (`freeTimes` in `slots.ts`). Each is labeled in the
 *   principal's time zone and, when given, the counterpart's, with a fit
 *   note from a fixed vocabulary that never echoes a preference.
 * - `hold` replaces the thread's holds with at most three private, busy
 *   events, each lapsing three days after it was last held. A timer releases
 *   what lapsed (`releaseExpiredHolds`).
 * - `book` always creates a new event at a time still free or held by this
 *   thread, inviting only people on the thread, with an invitation that
 *   passes the private-values check as its invitees would see it. Then the
 *   thread's holds go.
 * - `move_booking` and `cancel_booking` act only on an event this thread
 *   booked.
 * - `hold`, `book` and `move_booking` refuse a time inside protected time, so
 *   a counterpart's proposal never gets round it.
 * - `main` hears in one fact when a booking is made, moved or cancelled.
 *
 * Holds and bookings go on the calendar `main` named for the thread, else on
 * the principal's primary calendar: the calendar of the first address they
 * gave. Either way it is a principal calendar the assistant can write to.
 * An event is the thread's when its record names it and it carries the role
 * tag the host gave it, so a hold converted from an earlier release, tagged
 * by its meeting, releases too.
 *
 * Each request is answered once, a refusal or failure included. A replayed
 * request writes nothing twice: a hold's event id derives from the thread
 * and its time, and a booking's from the request that made it.
 */
import { TIMEZONE } from '../../config.js';
import { writeActionResponse } from '../../cli/delivery-action.js';
import type { ResponseFrame } from '../../cli/frame.js';
import { resolveGroupTimezone } from '../../container-config.js';
import type { DeliveryGuardSpec, GuardedDeliveryHandler } from '../../delivery-guard.js';
import { hasControlCharacters } from '../../gws-ea/validation.js';
import { log } from '../../log.js';
import { formatLocalTime, isValidTimezone } from '../../timezone.js';
import type { Session } from '../../types.js';
import { isPrincipalCalendar, recordOwnCalendarChange } from '../gws-ea-inbox/calendar-notifications.js';
import { listPrincipalCalendars } from '../gws-ea-inbox/db.js';
import { normalizeAddress } from '../gws-ea-inbox/mime.js';
import { assistantAddresses } from '../gws-ea-inbox/runtime.js';
import { threadAddresses } from '../gws-ea-inbox/thread-map.js';
import { untrustedLine } from '../gws-ea-inbox/untrusted.js';
import { getSchedulingPreferenceValues } from '../gws-ea-preferences/db.js';
import { audienceForAddresses, checkOutbound } from '../gws-ea-privacy/index.js';
import { getGwsEaProfile, getMainAgentGroupId, listPrincipalAddresses } from '../gws-ea-profile/db.js';
import { writeNoteForMain } from '../gws-ea-profile/main-note.js';
import { allowsMeet, type CalendarEntry, type EventConference, type MeetingsCalendarApi } from './calendar-api.js';
import { ensureEvent, eventIdFor, moveEventTo, readConference, slotLabel, TAG_ROLE } from './calendar-actions.js';
import { threadCalendarAction } from './guard.js';
import {
  blocksTime,
  eventSpan,
  freeTimes,
  inProtectedTime,
  isClear,
  iso,
  READ_MARGIN_MS,
  schedulingRules,
  type SchedulingRules,
  type Span,
} from './slots.js';
import {
  deleteThreadBooking,
  deleteThreadHold,
  getThreadBooking,
  getThreadBookingCalendar,
  listExpiredHolds,
  listThreadHolds,
  recordThreadBooking,
  recordThreadHold,
  type ThreadBooking,
  type ThreadHold,
} from './thread-calendar.js';

/** The private tag naming the thread an event was placed for. */
export const TAG_THREAD = 'gwsEaThread';
/** The `note.type` of the fact main hears when a thread books, moves or cancels a meeting. */
export const BOOKING_FACT_TYPE = 'gws-ea-meetings.booking';

/** How many times one `free_time` answer offers. */
const MAX_OFFERED = 8;
/** How many times one thread holds at once. */
const MAX_HOLDS = 3;
/** A hold lapses this long after it was last held. */
const HOLD_LIFETIME_DAYS = 3;
/** `free_time` offers nothing that starts sooner than this. */
const MIN_NOTICE_MINUTES = 60;
/** The longest range one `free_time` reads. */
const MAX_RANGE_DAYS = 60;
const MIN_MINUTES = 5;
const MAX_MINUTES = 480;
/** An invitation's title, as attendees see it on their calendars. */
const TITLE_MAX = 120;
/** Notes that help the attendees: a few paragraphs at most. */
const NOTES_MAX = 2_000;
/** A place: an address, a phone number, or a link. */
const LOCATION_MAX = 500;
const MAX_INVITEES = 20;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/iu;
/** A booking's id, as `book` answered with it: its event's id, lowercase hex. */
const BOOKING_ID = /^[0-9a-f]{64}$/u;

// ---------------------------------------------------------------------------
// Refusals, and answering each request once
// ---------------------------------------------------------------------------

/** A request the host refuses as asked: the agent reads why and can ask differently. */
class SchedulingRefusal extends Error {
  constructor(
    readonly code: 'invalid-args' | 'forbidden',
    message: string,
  ) {
    super(message);
    this.name = 'SchedulingRefusal';
  }
}

function invalid(message: string): SchedulingRefusal {
  return new SchedulingRefusal('invalid-args', message);
}

function refused(message: string): SchedulingRefusal {
  return new SchedulingRefusal('forbidden', message);
}

/** The request id the runner set: the id of the outbound message that carried the request. */
function requestIdOf(content: Record<string, unknown>): string | undefined {
  const id = content.requestId;
  return typeof id === 'string' && REQUEST_ID.test(id) ? id : undefined;
}

export type SchedulingHandle = (
  content: Record<string, unknown>,
  session: Session,
  requestId: string,
) => Promise<Record<string, unknown>>;

function errorFrame(requestId: string, error: unknown): ResponseFrame {
  if (error instanceof SchedulingRefusal) {
    return { id: requestId, ok: false, error: { code: error.code, message: error.message } };
  }
  const reason = error instanceof Error ? error.message : String(error);
  return { id: requestId, ok: false, error: { code: 'handler-error', message: `The host could not do it: ${reason}` } };
}

/** A delivery action that answers its request once, a refusal or failure included. */
export function answerOnce(action: string, handle: SchedulingHandle): GuardedDeliveryHandler {
  return async (content, session) => {
    const requestId = requestIdOf(content);
    if (requestId === undefined) return;
    let frame: ResponseFrame;
    /* eslint-disable no-catch-all/no-catch-all -- every request is answered, a failure included; nothing is rethrown into a retry */
    try {
      frame = { id: requestId, ok: true, data: await handle(content, session, requestId) };
    } catch (error) {
      if (error instanceof SchedulingRefusal) {
        log.info('Scheduling request refused', { action, requestId, sessionId: session.id, reason: error.message });
      } else {
        log.error('Scheduling request failed', { action, requestId, sessionId: session.id, err: error });
      }
      frame = errorFrame(requestId, error);
    }
    /* eslint-enable no-catch-all/no-catch-all */
    await writeActionResponse(session, requestId, frame);
  };
}

/** The guard every scheduling tool passes; a refusal is answered, so the calling tool never waits it out. */
export const SCHEDULING_GUARD: DeliveryGuardSpec = {
  guardAction: threadCalendarAction,
  precheck: (content, session) => {
    if (requestIdOf(content) !== undefined) return true;
    log.warn('Scheduling request without a request id: nothing to answer', { sessionId: session.id });
    return false;
  },
  // This guard never holds; a hold would be a decision these actions cannot honor.
  requestHold: async (content, session) => {
    const requestId = requestIdOf(content) ?? '';
    await writeActionResponse(session, requestId, {
      id: requestId,
      ok: false,
      error: { code: 'forbidden', message: 'This request cannot wait for an approval.' },
    });
  },
  onDeny: async (content, session, reason) => {
    const requestId = requestIdOf(content) ?? '';
    await writeActionResponse(session, requestId, {
      id: requestId,
      ok: false,
      error: { code: 'forbidden', message: reason },
    });
  },
};

// ---------------------------------------------------------------------------
// The request's fields
// ---------------------------------------------------------------------------

function instantOf(value: unknown, label: string): number {
  if (typeof value !== 'string' || !DATE_TIME.test(value)) {
    throw invalid(`${label} must be a date and time with its UTC offset, such as 2026-10-07T09:00:00-04:00`);
  }
  const at = Date.parse(value);
  if (!Number.isFinite(at)) throw invalid(`${label} is not a real date and time: ${value}`);
  return at;
}

function minutesOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < MIN_MINUTES || value > MAX_MINUTES) {
    throw invalid(`minutes must be a whole number from ${MIN_MINUTES} to ${MAX_MINUTES}`);
  }
  return value;
}

function timezoneOf(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !isValidTimezone(value)) {
    throw invalid('timezone must be an IANA time zone, such as America/New_York');
  }
  return value;
}

/** One line of text, its whitespace collapsed; undefined when absent and not required. */
function lineOf(value: unknown, label: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  const line = typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
  if (line === '' || line.length > max || hasControlCharacters(line)) {
    throw invalid(`${label} must be text of 1 to ${max} characters`);
  }
  return line;
}

/** Notes as written: line breaks kept, nothing else unprintable. */
function notesOf(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const notes = typeof value === 'string' ? value.replace(/\r\n?/gu, '\n').trim() : '';
  if (notes === '' || notes.length > NOTES_MAX || hasControlCharacters(notes.replace(/[\n\t]/gu, ' '))) {
    throw invalid(`notes must be text of 1 to ${NOTES_MAX} characters`);
  }
  return notes;
}

function videoCallOf(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') throw invalid('video_call must be true or false');
  return value;
}

function bookingIdOf(value: unknown): string {
  if (typeof value !== 'string' || !BOOKING_ID.test(value)) {
    throw invalid('booking must be the booking id book answered with');
  }
  return value;
}

/** The addresses given, each normalized; undefined when absent. */
function addressesOf(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_INVITEES) {
    throw invalid(`invitees must list 1 to ${MAX_INVITEES} email addresses`);
  }
  return [
    ...new Set(
      value.map((entry: unknown) => {
        const address = typeof entry === 'string' ? normalizeAddress(entry) : undefined;
        if (address === undefined)
          throw invalid(`invitees must list email addresses; ${JSON.stringify(entry)} is not one`);
        return address;
      }),
    ),
  ];
}

function spanAt(start: number, minutes: number): Span {
  return { start, end: start + minutes * MINUTE };
}

// ---------------------------------------------------------------------------
// The principal, and the thread's calendar
// ---------------------------------------------------------------------------

interface Principal {
  readonly timezone: string;
  readonly rules: SchedulingRules;
  /** Their addresses, which also name their primary calendars. */
  readonly addresses: ReadonlySet<string>;
  /** Their addresses, the first they gave first: whose calendar is their primary one. */
  readonly addressesByAge: readonly string[];
  readonly assistantName: string | null;
}

async function principalView(): Promise<Principal> {
  const profile = await getGwsEaProfile();
  const addresses = await listPrincipalAddresses();
  return {
    timezone: profile.principal_timezone ?? TIMEZONE,
    rules: schedulingRules(await getSchedulingPreferenceValues()),
    addresses: new Set(addresses.map((address) => address.email)),
    addressesByAge: [...addresses]
      .sort((a, b) => a.added_at.localeCompare(b.added_at) || a.email.localeCompare(b.email))
      .map((address) => address.email),
    assistantName: profile.assistant_display_name,
  };
}

/** The calling session's thread: the guard admitted only a thread's own session. */
function threadKeyOf(session: Session): string {
  if (session.thread_id === null) throw new Error(`Session ${session.id} has no thread`);
  return session.thread_id;
}

/** What one thread's request reads and writes against. */
interface ThreadView {
  readonly threadKey: string;
  readonly principal: Principal;
}

export interface SchedulingToolsDeps {
  /** The host's own Calendar client. */
  readonly calendar: () => MeetingsCalendarApi;
}

export function createSchedulingTools(deps: SchedulingToolsDeps) {
  const calendar = () => deps.calendar();

  async function viewOf(session: Session): Promise<ThreadView> {
    return { threadKey: threadKeyOf(session), principal: await principalView() };
  }

  /**
   * The calendar the thread holds and books on: the one main named for it,
   * else the principal's primary calendar. Either way a principal calendar
   * the assistant can write to; refused, saying so, when there is none.
   */
  async function bookingCalendarOf(view: ThreadView): Promise<CalendarEntry> {
    const named = await getThreadBookingCalendar(view.threadKey);
    for (const calendarId of named === null ? view.principal.addressesByAge : [named]) {
      const entry = await calendar().getCalendar(calendarId);
      if (
        entry !== undefined &&
        isPrincipalCalendar(entry, view.principal.addresses) &&
        (entry.accessRole === 'writer' || entry.accessRole === 'owner')
      ) {
        return entry;
      }
    }
    throw refused(
      named === null
        ? "The assistant cannot write to the principal's primary calendar, so it can hold and book nothing: tell main with tell_main."
        : 'The assistant cannot write to the calendar main named for this thread, so it can hold and book nothing: tell main with tell_main.',
    );
  }

  /**
   * Time taken in `span`, read now from the principal's calendars and the
   * one the thread books on: every event that blocks their time, apart from
   * those in `ignore`, the thread's own.
   */
  async function busyIn(
    view: ThreadView,
    calendarId: string,
    span: Span,
    ignore: ReadonlySet<string>,
  ): Promise<Span[]> {
    const { principal } = view;
    const margin = principal.rules.bufferMinutes * MINUTE + READ_MARGIN_MS;
    const ids = new Map<string, string>();
    for (const id of [...(await listPrincipalCalendars()), calendarId]) {
      if (!ids.has(id.toLowerCase())) ids.set(id.toLowerCase(), id);
    }
    const listings = await Promise.all(
      [...ids.values()].map((id) => calendar().listEvents(id, iso(span.start - margin), iso(span.end + margin))),
    );
    return listings
      .flat()
      .flatMap((event) =>
        (event.id !== undefined && ignore.has(event.id)) || !blocksTime(event, principal.addresses)
          ? []
          : (eventSpan(event, principal.timezone) ?? []),
      );
  }

  /**
   * Refuse, naming each, any time that has passed, falls in protected time,
   * or is no longer free: what `hold`, `book` and `move_booking` never place.
   */
  async function assertAvailable(
    view: ThreadView,
    calendarId: string,
    spans: readonly Span[],
    ignore: ReadonlySet<string>,
  ): Promise<void> {
    const { timezone, rules } = view.principal;
    const now = Date.now();
    const label = (span: Span): string => slotLabel(span, timezone);
    const passed = spans.filter((span) => span.start <= now);
    if (passed.length > 0) throw refused(`${passed.map(label).join('; ')}: that time has passed.`);
    const protectedTime = spans.filter((span) => inProtectedTime(span, rules, timezone));
    if (protectedTime.length > 0) {
      throw refused(
        `${protectedTime.map(label).join('; ')}: the principal keeps that time protected, whoever asks for it. Offer times from free_time instead.`,
      );
    }
    const covering = {
      start: Math.min(...spans.map((span) => span.start)),
      end: Math.max(...spans.map((span) => span.end)),
    };
    const busy = await busyIn(view, calendarId, covering, ignore);
    const taken = spans.filter((span) => !isClear(span, busy));
    if (taken.length > 0) {
      throw refused(`${taken.map(label).join('; ')}: no longer free. Call free_time for times to offer instead.`);
    }
  }

  // -------------------------------------------------------------------------
  // Releasing holds
  // -------------------------------------------------------------------------

  /** Delete a recorded hold's event while it still carries the hold tag; then forget the record. */
  async function releaseHold(hold: ThreadHold): Promise<void> {
    const event = await calendar().getEvent(hold.calendarId, hold.eventId);
    if (event && event.status !== 'cancelled') {
      if (event.tags?.[TAG_ROLE] === 'hold') {
        await calendar().deleteEvent(hold.calendarId, hold.eventId, 'none');
        recordOwnCalendarChange(hold.calendarId, hold.eventId);
      } else {
        log.warn('A recorded hold no longer carries the hold tag; it is left on the calendar', {
          threadKey: hold.threadKey,
          calendarId: hold.calendarId,
          eventId: hold.eventId,
        });
      }
    }
    await deleteThreadHold(hold.calendarId, hold.eventId);
  }

  /** Release each hold; throw after trying them all if any stays, still recorded for the next attempt. */
  async function releaseHolds(holds: readonly ThreadHold[]): Promise<void> {
    let failed = 0;
    for (const hold of holds) {
      /* eslint-disable no-catch-all/no-catch-all -- one hold that cannot go yet must not keep the others; the count is rethrown */
      try {
        await releaseHold(hold);
      } catch (err) {
        failed += 1;
        log.warn('A hold could not be released yet', { threadKey: hold.threadKey, eventId: hold.eventId, err });
      }
      /* eslint-enable no-catch-all/no-catch-all */
    }
    if (failed > 0) {
      throw new Error(`${failed} hold(s) could not be released yet; they stay recorded and go on the next attempt`);
    }
  }

  /** Release every hold the thread placed. */
  async function releaseThreadHolds(threadKey: string): Promise<void> {
    await releaseHolds(await listThreadHolds(threadKey));
  }

  /** Release every hold whose time to lapse has come. Never throws: what stays goes on the next pass. */
  async function releaseExpiredHolds(): Promise<void> {
    /* eslint-disable no-catch-all/no-catch-all -- the timer runs on; a hold left recorded is released on the next pass */
    try {
      await releaseHolds(await listExpiredHolds(new Date().toISOString()));
    } catch (err) {
      log.warn('Lapsed holds were not all released; the next pass tries again', { err });
    }
    /* eslint-enable no-catch-all/no-catch-all */
  }

  // -------------------------------------------------------------------------
  // What main hears
  // -------------------------------------------------------------------------

  interface BookingFact {
    readonly type: typeof BOOKING_FACT_TYPE;
    readonly thread_key: string;
    readonly change: 'booked' | 'moved' | 'cancelled';
    readonly calendar_id: string;
    readonly event_id: string;
    readonly start: string;
    readonly end: string;
    readonly invitees: readonly string[];
    /** Where a moved booking was before. */
    readonly previous?: { readonly start: string; readonly end: string };
  }

  /**
   * Tell main of a booking the thread made, moved or cancelled, once: the
   * note's id derives from the change. The booking stands whatever happens
   * here, so a failure is logged, never thrown into a retry that would book
   * again. The event's title, which external-email wrote from the thread, is
   * framed as untrusted.
   */
  async function tellMain(fact: BookingFact, title?: string): Promise<void> {
    /* eslint-disable no-catch-all/no-catch-all -- the calendar change already stands; main's note is reported, never retried into a second change */
    try {
      const mainAgentGroupId = await getMainAgentGroupId();
      if (mainAgentGroupId === null) {
        log.warn('No main to tell of a booking change', { threadKey: fact.thread_key, change: fact.change });
        return;
      }
      const timezone = await resolveGroupTimezone(mainAgentGroupId);
      const when = formatLocalTime(fact.start, timezone);
      const minutes = Math.round((Date.parse(fact.end) - Date.parse(fact.start)) / MINUTE);
      const event = `event ${fact.event_id} on calendar ${fact.calendar_id}`;
      const people = fact.invitees.join(', ') || 'nobody';
      let id: string;
      let text: string;
      switch (fact.change) {
        case 'booked':
          id = `gws-ea-booking-booked-${fact.event_id}`;
          text =
            `Thread ${fact.thread_key} booked ${when} (${minutes} minutes) with ${people}: ${event}.` +
            (title === undefined ? '' : ` Its title, as written in the thread:\n${untrustedLine(title, TITLE_MAX)}`);
          break;
        case 'moved':
          id = `gws-ea-booking-moved-${fact.event_id}-${Date.parse(fact.start)}`;
          text =
            `Thread ${fact.thread_key} moved its booking, ${event}, ` +
            `${fact.previous === undefined ? '' : `from ${formatLocalTime(fact.previous.start, timezone)} `}` +
            `to ${when} (${minutes} minutes). Google sent ${people} the update.`;
          break;
        case 'cancelled':
          id = `gws-ea-booking-cancelled-${fact.event_id}`;
          text = `Thread ${fact.thread_key} cancelled its booking for ${when}, ${event}. Google sent ${people} the cancellation.`;
          break;
        default: {
          const unreachable: never = fact.change;
          throw new Error(`Unknown booking change: ${String(unreachable)}`);
        }
      }
      const result = await writeNoteForMain({
        id,
        timestamp: new Date().toISOString(),
        text,
        fields: { note: fact },
        wake: true,
      });
      if (result === 'no-main' || result === 'no-principal') {
        log.warn('Nobody to tell of a booking change', { threadKey: fact.thread_key, change: fact.change, result });
      }
    } catch (err) {
      log.error('Main was not told of a booking change', { threadKey: fact.thread_key, change: fact.change, err });
    }
    /* eslint-enable no-catch-all/no-catch-all */
  }

  /** What a Meet link on a booking means for the one who booked it. */
  function conferenceWords(conference: EventConference | undefined): string {
    if (conference === undefined) return '';
    switch (conference.status) {
      case 'success':
        return conference.uri === undefined
          ? ', with a Google Meet link'
          : `, with a Google Meet link (${conference.uri})`;
      case 'pending':
        return '; Google is still creating its Meet link, which appears on the invitation shortly';
      case 'failure':
        return '; Google could not create a Meet link, so tell them the place another way';
      default: {
        const unreachable: never = conference.status;
        throw new Error(`Unknown conference status ${String(unreachable)}`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // The tools
  // -------------------------------------------------------------------------

  const freeTime: SchedulingHandle = async (content, session) => {
    const from = instantOf(content.from, 'from');
    const to = instantOf(content.to, 'to');
    const minutes = minutesOf(content.minutes);
    const theirs = timezoneOf(content.timezone);
    if (to <= from) throw invalid('to must come after from');
    if (to - from > MAX_RANGE_DAYS * DAY) throw invalid(`The range may span at most ${MAX_RANGE_DAYS} days`);
    if (to <= Date.now()) throw invalid('That range has already passed: ask for one in the future.');
    const view = await viewOf(session);
    const { timezone, rules } = view.principal;
    const bookingCalendar = await bookingCalendarOf(view);
    const window = { start: Math.max(from, Date.now() + MIN_NOTICE_MINUTES * MINUTE), end: to };
    const holds = await listThreadHolds(view.threadKey);
    const busy =
      window.start < window.end
        ? await busyIn(view, bookingCalendar.id, window, new Set(holds.map((hold) => hold.eventId)))
        : [];
    const found = freeTimes({ timezone, lengthMinutes: minutes, window, busy, rules }, MAX_OFFERED);
    const times = found.map((time) => ({
      start: iso(time.start),
      end: iso(time.end),
      principal_time: slotLabel(time, timezone),
      ...(theirs === undefined ? {} : { their_time: slotLabel(time, theirs) }),
      fit: time.fit,
      held: holds.some((hold) => Date.parse(hold.startAt) === time.start && Date.parse(hold.endAt) === time.end),
    }));
    const lines = times.map(
      (time) =>
        `- ${time.start}: ${time.principal_time}` +
        (time.their_time === undefined ? '' : `; for them, ${time.their_time}`) +
        ` (${time.fit}${time.held ? ', held' : ''})`,
    );
    return {
      times,
      message:
        times.length === 0
          ? 'Nothing in that range is free outside protected time: ask for another range, or tell main with tell_main.'
          : ['Free times, best fit first. Hold the ones you offer:', ...lines].join('\n'),
    };
  };

  /**
   * Replace the thread's holds with these times, each lapsing three days
   * from now; an empty list releases them all. Every time is checked first,
   * so a refusal changes nothing. Holding a time held already only resets
   * when it lapses.
   */
  const hold: SchedulingHandle = async (content, session) => {
    if (!Array.isArray(content.starts) || content.starts.length > MAX_HOLDS) {
      throw invalid(`starts must list up to ${MAX_HOLDS} start times, or none to release every hold`);
    }
    const starts = [...new Set(content.starts.map((start: unknown) => instantOf(start, 'Each start')))].sort(
      (a, b) => a - b,
    );
    const view = await viewOf(session);
    const existing = await listThreadHolds(view.threadKey);
    if (starts.length === 0) {
      await releaseHolds(existing);
      return { held: [], message: 'This thread holds no times now.' };
    }
    const minutes = minutesOf(content.minutes);
    const spans = starts.map((start) => spanAt(start, minutes));
    if (spans.some((span, index) => index > 0 && span.start < spans[index - 1].end)) {
      throw invalid('The times overlap: hold times that do not.');
    }
    const { timezone } = view.principal;
    const bookingCalendar = await bookingCalendarOf(view);
    await assertAvailable(view, bookingCalendar.id, spans, new Set(existing.map((held) => held.eventId)));

    const eventIdOf = (span: Span): string => eventIdFor('hold', view.threadKey, iso(span.start), iso(span.end));
    const wanted = new Set(spans.map(eventIdOf));
    await releaseHolds(existing.filter((held) => held.calendarId !== bookingCalendar.id || !wanted.has(held.eventId)));
    const expiresAt = iso(Date.now() + HOLD_LIFETIME_DAYS * DAY);
    const holder = view.principal.assistantName ?? 'The assistant';
    for (const span of spans) {
      const eventId = eventIdOf(span);
      // Recorded first, so a release finds it whatever happens to the write.
      await recordThreadHold({
        threadKey: view.threadKey,
        calendarId: bookingCalendar.id,
        eventId,
        startAt: iso(span.start),
        endAt: iso(span.end),
        expiresAt,
      });
      await ensureEvent(
        calendar(),
        bookingCalendar.id,
        eventId,
        {
          summary: 'Hold',
          description: `${holder} is holding this time while a meeting is agreed by email. It is released on its own.`,
          start: iso(span.start),
          end: iso(span.end),
          timeZone: timezone,
          attendees: [],
          visibility: 'private',
          transparency: 'opaque',
          reminders: 'none',
          tags: { [TAG_ROLE]: 'hold', [TAG_THREAD]: view.threadKey },
        },
        'none',
        { key: TAG_THREAD, value: view.threadKey },
      );
    }
    return {
      held: spans.map((span) => ({
        start: iso(span.start),
        end: iso(span.end),
        principal_time: slotLabel(span, timezone),
      })),
      message: [
        'This thread now holds:',
        ...spans.map((span) => `- ${iso(span.start)}: ${slotLabel(span, timezone)}`),
        `They lapse on ${formatLocalTime(expiresAt, timezone)} unless you hold them again. Any other time it held is released.`,
      ].join('\n'),
    };
  };

  /**
   * The people a booking invites: those named, each one on the thread, or
   * everyone on it when none are named; never the principal or the
   * assistant, whose calendar the event is on.
   */
  async function inviteesOf(value: unknown, view: ThreadView): Promise<string[]> {
    const onThread = new Set((await threadAddresses(view.threadKey)).map((entry) => entry.address));
    const assistant = await assistantAddresses();
    const named = addressesOf(value);
    const stranger = named?.find((address) => !onThread.has(address));
    if (stranger !== undefined) {
      throw refused(
        `${stranger} is not on this thread: invite only people who wrote or were written to in it, or whom main named.`,
      );
    }
    const invitees = (named ?? [...onThread]).filter(
      (address) => !view.principal.addresses.has(address) && !assistant.has(address),
    );
    if (invitees.length === 0) throw invalid('Name someone on the thread to invite: the booking invites nobody else.');
    return invitees;
  }

  /** Take back an event a failed booking may have left, if it is this thread's. Best effort, and logged. */
  async function withdraw(calendarId: string, eventId: string, threadKey: string): Promise<void> {
    /* eslint-disable no-catch-all/no-catch-all -- the booking already failed; withdrawing it is best effort and logged */
    try {
      const event = await calendar().getEvent(calendarId, eventId);
      if (event && event.status !== 'cancelled' && event.tags?.[TAG_THREAD] === threadKey) {
        await calendar().deleteEvent(calendarId, eventId, 'all');
        recordOwnCalendarChange(calendarId, eventId);
      }
    } catch (err) {
      log.error('A booking that failed could not be withdrawn', { threadKey, calendarId, eventId, err });
    }
    /* eslint-enable no-catch-all/no-catch-all */
  }

  /** What a booking writes: its time, the people it invites, and the invitation they see. */
  interface NewBooking {
    readonly eventId: string;
    readonly span: Span;
    readonly invitees: readonly string[];
    readonly title: string;
    readonly notes: string | undefined;
    readonly location: string | undefined;
    readonly videoCall: boolean;
  }

  /**
   * Create the booking's event and record it. Every check runs first, so a
   * refusal writes nothing; a Calendar failure takes back whatever the
   * write left, and the agent sees the failure.
   */
  async function placeBooking(view: ThreadView, wanted: NewBooking): Promise<ThreadBooking> {
    const { threadKey } = view;
    const bookingCalendar = await bookingCalendarOf(view);
    const holds = await listThreadHolds(threadKey);
    await assertAvailable(
      view,
      bookingCalendar.id,
      [wanted.span],
      new Set([...holds.map((held) => held.eventId), wanted.eventId]),
    );
    const check = await checkOutbound(
      [wanted.title, wanted.notes ?? '', wanted.location ?? '', bookingCalendar.summary ?? ''],
      await audienceForAddresses(wanted.invitees),
    );
    if (!check.allowed) {
      throw refused(
        `The booking was not made: as the invitees would see it, its title, notes, place or calendar name carries one of the principal's private details (${check.kind}). ` +
          "Write it without that detail, and do not hint at, spell out, or encode it. If it is the calendar's name, tell main with tell_main.",
      );
    }
    if (wanted.videoCall && !allowsMeet(bookingCalendar)) {
      throw refused(
        'The calendar this thread books on does not allow Google Meet links: give the place another way, such as their own link in location.',
      );
    }
    try {
      await ensureEvent(
        calendar(),
        bookingCalendar.id,
        wanted.eventId,
        {
          summary: wanted.title,
          ...(wanted.notes === undefined ? {} : { description: wanted.notes }),
          ...(wanted.location === undefined ? {} : { location: wanted.location }),
          ...(wanted.videoCall ? { conference: { requestId: eventIdFor('meet', wanted.eventId) } } : {}),
          start: iso(wanted.span.start),
          end: iso(wanted.span.end),
          timeZone: view.principal.timezone,
          attendees: wanted.invitees,
          reminders: 'default',
          tags: { [TAG_ROLE]: 'booking', [TAG_THREAD]: threadKey },
        },
        'all',
        { key: TAG_THREAD, value: threadKey },
      );
    } catch (error) {
      await withdraw(bookingCalendar.id, wanted.eventId, threadKey);
      throw error;
    }
    const booking: ThreadBooking = {
      threadKey,
      calendarId: bookingCalendar.id,
      eventId: wanted.eventId,
      bookedAt: new Date().toISOString(),
    };
    await recordThreadBooking(booking);
    return booking;
  }

  /**
   * Book a time someone agreed to (R71): always a new event, under an id
   * derived from this request, at a time still free or held by this thread
   * and outside protected time. It invites only people on the thread, with
   * the invitation as they would see it passing the private-values check.
   * The thread's holds then go, and main hears. A replay of a request
   * already booked only finishes what follows.
   */
  const book: SchedulingHandle = async (content, session, requestId) => {
    const start = instantOf(content.start, 'start');
    const minutes = minutesOf(content.minutes);
    const title = lineOf(content.title, 'title', TITLE_MAX);
    if (title === undefined) throw invalid('title is required: it is what the invitees see on their calendars');
    const notes = notesOf(content.notes);
    const location = lineOf(content.location, 'location', LOCATION_MAX);
    const videoCall = videoCallOf(content.video_call);
    const view = await viewOf(session);
    const { timezone } = view.principal;
    const span = spanAt(start, minutes);
    const invitees = await inviteesOf(content.invitees, view);
    const eventId = eventIdFor('booking', view.threadKey, requestId);
    const booking =
      (await getThreadBooking(view.threadKey, eventId)) ??
      (await placeBooking(view, { eventId, span, invitees, title, notes, location, videoCall }));
    const conference = videoCall ? await readConference(calendar(), booking.calendarId, eventId) : undefined;
    let holdsLeft = '';
    /* eslint-disable no-catch-all/no-catch-all -- the booking stands; a hold left over lapses on its own */
    try {
      await releaseThreadHolds(view.threadKey);
    } catch (err) {
      log.warn('A booked thread’s holds were not all released', { threadKey: view.threadKey, err });
      holdsLeft = ' Some of its holds could not be released yet; they lapse on their own.';
    }
    /* eslint-enable no-catch-all/no-catch-all */
    await tellMain(
      {
        type: BOOKING_FACT_TYPE,
        thread_key: view.threadKey,
        change: 'booked',
        calendar_id: booking.calendarId,
        event_id: eventId,
        start: iso(span.start),
        end: iso(span.end),
        invitees,
      },
      title,
    );
    return {
      booking: eventId,
      start: iso(span.start),
      end: iso(span.end),
      message:
        `Booked: ${slotLabel(span, timezone)}. Google sends ${invitees.join(', ')} the invitation from the principal's calendar` +
        `${conferenceWords(conference)}. This thread's holds are released.${holdsLeft} main hears of it from the host. ` +
        `To move or cancel it, give booking ${eventId}.`,
    };
  };

  /**
   * The thread's booking named, with its event as Google holds it now:
   * refused unless this thread booked it, the event is still on the
   * calendar, and it still carries the booking tag. A booking whose event is
   * gone is forgotten.
   */
  async function ownBooking(content: Record<string, unknown>, view: ThreadView) {
    const eventId = bookingIdOf(content.booking);
    const booking = await getThreadBooking(view.threadKey, eventId);
    if (!booking) throw refused(`This thread has no booking ${eventId}: use a booking id book gave you here.`);
    const event = await calendar().getEvent(booking.calendarId, eventId);
    if (!event || event.status === 'cancelled') {
      await deleteThreadBooking(booking.calendarId, eventId);
      throw refused('That booking is no longer on the principal’s calendar, so there is nothing to change.');
    }
    if (event.tags?.[TAG_ROLE] !== 'booking') {
      throw refused('That event is no longer a booking this thread may change: tell main with tell_main.');
    }
    const span = eventSpan(event, view.principal.timezone);
    if (!span) throw refused('Google reports no readable time for that booking: tell main with tell_main.');
    const invitees = (event.attendees ?? []).flatMap((attendee) =>
      attendee.resource === true || attendee.email === undefined ? [] : [attendee.email],
    );
    return { booking, event, span, invitees };
  }

  /** Move a booking this thread made to a new start, keeping its length, when the time is free and not protected. */
  const moveBooking: SchedulingHandle = async (content, session) => {
    const start = instantOf(content.start, 'start');
    const view = await viewOf(session);
    const { timezone } = view.principal;
    const { booking, event, span: was, invitees } = await ownBooking(content, view);
    const span = spanAt(start, (was.end - was.start) / MINUTE);
    if (span.start === was.start) {
      return {
        booking: booking.eventId,
        start: iso(span.start),
        end: iso(span.end),
        message: `The booking is already at ${slotLabel(span, timezone)}: nothing changed.`,
      };
    }
    const holds = await listThreadHolds(view.threadKey);
    await assertAvailable(
      view,
      booking.calendarId,
      [span],
      new Set([...holds.map((held) => held.eventId), booking.eventId]),
    );
    await moveEventTo(
      calendar(),
      booking.calendarId,
      event,
      { start_at: iso(span.start), end_at: iso(span.end) },
      timezone,
    );
    await tellMain({
      type: BOOKING_FACT_TYPE,
      thread_key: view.threadKey,
      change: 'moved',
      calendar_id: booking.calendarId,
      event_id: booking.eventId,
      start: iso(span.start),
      end: iso(span.end),
      invitees,
      previous: { start: iso(was.start), end: iso(was.end) },
    });
    return {
      booking: booking.eventId,
      start: iso(span.start),
      end: iso(span.end),
      message: `Moved: ${slotLabel(span, timezone)}. Google sends the invitees the update, and main hears of it from the host.`,
    };
  };

  /** Cancel a booking this thread made: its event is deleted with Google's notice to the invitees. */
  const cancelBooking: SchedulingHandle = async (content, session) => {
    const view = await viewOf(session);
    const { timezone } = view.principal;
    const { booking, span, invitees } = await ownBooking(content, view);
    await calendar().deleteEvent(booking.calendarId, booking.eventId, 'all');
    recordOwnCalendarChange(booking.calendarId, booking.eventId);
    await tellMain({
      type: BOOKING_FACT_TYPE,
      thread_key: view.threadKey,
      change: 'cancelled',
      calendar_id: booking.calendarId,
      event_id: booking.eventId,
      start: iso(span.start),
      end: iso(span.end),
      invitees,
    });
    await deleteThreadBooking(booking.calendarId, booking.eventId);
    return {
      booking: booking.eventId,
      message: `Cancelled: ${slotLabel(span, timezone)}. Google sends the invitees the cancellation, and main hears of it from the host.`,
    };
  };

  return {
    freeTime,
    hold,
    book,
    moveBooking,
    cancelBooking,
    releaseThreadHolds,
    releaseExpiredHolds,
  };
}
