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
 *   change_booking  { booking, start?, minutes?, title?, location?, notes?, video_call? }
 *                                                     → { booking, start, end, message }
 *   cancel_booking  { booking }                      → { booking, message }
 *
 * - `free_time` offers up to eight start times from now on, from the
 *   principal's free/busy alone, never inside protected time, spread across
 *   the range and listed in date order (`freeTimes` in `slots.ts`). Each is
 *   labeled in the principal's time zone and, when given, the counterpart's,
 *   inside whose waking day it falls, with a fit note from a fixed
 *   vocabulary that never echoes a preference.
 * - `hold` replaces the thread's holds with at most three private, busy
 *   events, each lapsing three days after it was last held. A timer releases
 *   what lapsed (`releaseExpiredHolds`).
 * - `book` always creates a new event at a time still free or held by this
 *   thread, inviting only people on the thread, with an invitation that
 *   passes the private-values check as its invitees would see it. Then the
 *   thread's holds go.
 * - `change_booking` and `cancel_booking` act only on an event this thread
 *   booked. A change keeps the event's id and is checked as `book` checks
 *   what it writes.
 * - `hold`, `book` and `change_booking` refuse a time inside protected time,
 *   so a counterpart's proposal never gets round it.
 * - Every hold and booking lists the principal as an accepted guest, its
 *   organizer (`guestsOn`); who a booking invites never counts them.
 * - `main` hears in one fact when a booking is made, changed or cancelled.
 *
 * Holds and bookings go on the calendar `main` named for the thread, else on
 * the principal's primary calendar: the calendar of the first address they
 * gave. Either way it must be a principal calendar the assistant can write
 * to; no other calendar stands in for it.
 * An event is the thread's when its record names it and it carries the role
 * tag the host gave it, so a hold converted from an earlier release, tagged
 * by its meeting, releases too.
 *
 * Each request is answered once, a refusal or failure included. A replayed
 * request writes nothing twice: a hold's event id derives from the thread
 * and its time, and a booking's from the request that made it.
 */
import { TIMEZONE } from '../../config.js';
import { forbidden, invalidArgs, type ActionAnswer } from '../../cli/delivery-action.js';
import { resolveGroupTimezone } from '../../container-config.js';
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
import {
  allowsMeet,
  type CalendarEntry,
  type EventConference,
  type EventWrite,
  type MeetingsCalendarApi,
} from './calendar-api.js';
import { ensureEvent, eventIdFor, guestsOn, readConference, slotLabel, TAG_ROLE } from './calendar-actions.js';
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
  zonedIso,
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

/** How many times one `free_time` answer offers. */
const MAX_OFFERED = 8;
/** How many times one thread holds at once. */
const MAX_HOLDS = 3;
/** A hold lapses this long after it was last held. */
const HOLD_LIFETIME_DAYS = 3;
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

/** People named in prose: "a, b, and c". */
const LIST = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });

const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/iu;
/** A booking's id, as `book` answered with it: its event's id, lowercase hex. */
const BOOKING_ID = /^[0-9a-f]{64}$/u;

// ---------------------------------------------------------------------------
// The request's fields
// ---------------------------------------------------------------------------

function instantOf(value: unknown, label: string): number {
  if (typeof value !== 'string' || !DATE_TIME.test(value)) {
    throw invalidArgs(`${label} must be a date and time with its UTC offset, such as 2026-10-07T09:00:00-04:00`);
  }
  const at = Date.parse(value);
  if (!Number.isFinite(at)) throw invalidArgs(`${label} is not a real date and time: ${value}`);
  return at;
}

function minutesOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < MIN_MINUTES || value > MAX_MINUTES) {
    throw invalidArgs(`minutes must be a whole number from ${MIN_MINUTES} to ${MAX_MINUTES}`);
  }
  return value;
}

function timezoneOf(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !isValidTimezone(value)) {
    throw invalidArgs('timezone must be an IANA time zone, such as America/New_York');
  }
  return value;
}

/** One line of text, its whitespace collapsed; undefined when absent and not required. */
function lineOf(value: unknown, label: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  const line = typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
  if (line === '' || line.length > max || hasControlCharacters(line)) {
    throw invalidArgs(`${label} must be text of 1 to ${max} characters`);
  }
  return line;
}

/** Notes as written: line breaks kept, nothing else unprintable. */
function notesOf(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const notes = typeof value === 'string' ? value.replace(/\r\n?/gu, '\n').trim() : '';
  if (notes === '' || notes.length > NOTES_MAX || hasControlCharacters(notes.replace(/[\n\t]/gu, ' '))) {
    throw invalidArgs(`notes must be text of 1 to ${NOTES_MAX} characters`);
  }
  return notes;
}

function videoCallOf(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') throw invalidArgs('video_call must be true or false');
  return value;
}

function bookingIdOf(value: unknown): string {
  if (typeof value !== 'string' || !BOOKING_ID.test(value)) {
    throw invalidArgs('booking must be the booking id book answered with');
  }
  return value;
}

/** The addresses given, each normalized; undefined when absent. */
function addressesOf(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_INVITEES) {
    throw invalidArgs(`invitees must list 1 to ${MAX_INVITEES} email addresses`);
  }
  return [
    ...new Set(
      value.map((entry: unknown) => {
        const address = typeof entry === 'string' ? normalizeAddress(entry) : undefined;
        if (address === undefined)
          throw invalidArgs(`invitees must list email addresses; ${JSON.stringify(entry)} is not one`);
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
  /** Their addresses, which also name their own calendars. */
  readonly addresses: ReadonlySet<string>;
  /** Their primary calendar: that of the first address they gave, while they have one. */
  readonly primaryCalendar: string | undefined;
  readonly assistantName: string | null;
}

async function principalView(): Promise<Principal> {
  const profile = await getGwsEaProfile();
  const addresses = await listPrincipalAddresses();
  const [first] = [...addresses].sort((a, b) => a.added_at.localeCompare(b.added_at) || a.email.localeCompare(b.email));
  return {
    timezone: profile.principal_timezone ?? TIMEZONE,
    rules: schedulingRules(await getSchedulingPreferenceValues()),
    addresses: new Set(addresses.map((address) => address.email)),
    primaryCalendar: first?.email,
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
   * else the principal's primary calendar. Either way it must be a principal
   * calendar the assistant can write to; refused, saying so, when it is not,
   * rather than placing the meeting on some other calendar of theirs.
   */
  async function bookingCalendarOf(view: ThreadView): Promise<CalendarEntry> {
    const named = await getThreadBookingCalendar(view.threadKey);
    const calendarId = named ?? view.principal.primaryCalendar;
    const entry = calendarId === undefined ? undefined : await calendar().getCalendar(calendarId);
    if (
      entry !== undefined &&
      isPrincipalCalendar(entry, view.principal.addresses) &&
      (entry.accessRole === 'writer' || entry.accessRole === 'owner')
    ) {
      return entry;
    }
    throw forbidden(
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
   * or is no longer free: what `hold`, `book` and `change_booking` never place.
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
    if (passed.length > 0) throw forbidden(`${passed.map(label).join('; ')}: that time has passed.`);
    const protectedTime = spans.filter((span) => inProtectedTime(span, rules, timezone));
    if (protectedTime.length > 0) {
      throw forbidden(
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
      throw forbidden(`${taken.map(label).join('; ')}: no longer free. Call free_time for times to offer instead.`);
    }
  }

  /**
   * The calendar writes take turns across every thread and the timer that
   * releases lapsed holds: each looks at what is free or held and writes
   * before the next looks, so two threads never take one time and a hold
   * held again is never released from under its thread.
   */
  let turn: Promise<unknown> = Promise.resolve();
  function takeTurn<T>(work: () => Promise<T>): Promise<T> {
    const done = turn.then(work);
    turn = done.then(
      () => undefined,
      () => undefined,
    );
    return done;
  }
  function inTurn(answer: ActionAnswer): ActionAnswer {
    return (content, session, requestId) => takeTurn(() => answer(content, session, requestId));
  }

  // -------------------------------------------------------------------------
  // Releasing holds
  // -------------------------------------------------------------------------

  /**
   * Delete a recorded hold's event while it still carries the hold tag; then
   * forget the record, when given `expiredBy` only if it is still lapsed by
   * then.
   */
  async function releaseHold(hold: ThreadHold, expiredBy?: string): Promise<void> {
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
    await deleteThreadHold(hold.calendarId, hold.eventId, expiredBy);
  }

  /** Release each hold; throw after trying them all if any stays, still recorded for the next attempt. */
  async function releaseHolds(holds: readonly ThreadHold[], expiredBy?: string): Promise<void> {
    let failed = 0;
    for (const hold of holds) {
      /* eslint-disable no-catch-all/no-catch-all -- one hold that cannot go yet must not keep the others; the count is rethrown */
      try {
        await releaseHold(hold, expiredBy);
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

  /**
   * Release every hold whose time to lapse has come, in its turn with the
   * calendar writes. Never throws: what stays goes on the next pass.
   */
  function releaseExpiredHolds(): Promise<void> {
    return takeTurn(async () => {
      /* eslint-disable no-catch-all/no-catch-all -- the timer runs on; a hold left recorded is released on the next pass */
      try {
        const at = new Date().toISOString();
        await releaseHolds(await listExpiredHolds(at), at);
      } catch (err) {
        log.warn('Lapsed holds were not all released; the next pass tries again', { err });
      }
      /* eslint-enable no-catch-all/no-catch-all */
    });
  }

  // -------------------------------------------------------------------------
  // What main hears
  // -------------------------------------------------------------------------

  /** What happened to a booking, with what main needs to read of it. */
  type BookingChange =
    | {
        readonly kind: 'booked';
        readonly title: string;
        /** Whether it has, or is getting, a Google Meet link. */
        readonly videoCall: boolean;
      }
    | {
        readonly kind: 'changed';
        /** The request that changed it, so a replay tells main nothing twice. */
        readonly requestId: string;
        /** Its time before, when the change moved it or changed its length. */
        readonly was?: Span;
        /** What else on the invitation is new: its title, place, notes, or Meet link. */
        readonly fresh: readonly string[];
        /** Its new title, when it has one. */
        readonly title?: string;
      }
    | { readonly kind: 'cancelled' };

  interface BookingFact {
    readonly threadKey: string;
    readonly booking: ThreadBooking;
    /** Its time now; for a cancellation, the time it had. */
    readonly span: Span;
    readonly invitees: readonly string[];
    readonly change: BookingChange;
  }

  /**
   * Tell main of a booking the thread made, changed or cancelled, once: the
   * note's id derives from the change. The note leads with what happened and
   * to whom, in main's time zone, and ends with the ids main acts on. The
   * booking stands whatever happens here, so a failure is logged, never
   * thrown into a retry that would book again. A title, which external-email
   * wrote from the thread, is framed as untrusted.
   */
  async function tellMain(fact: BookingFact): Promise<void> {
    const { threadKey, booking, span, invitees, change } = fact;
    /* eslint-disable no-catch-all/no-catch-all -- the calendar change already stands; main's note is reported, never retried into a second change */
    try {
      const mainAgentGroupId = await getMainAgentGroupId();
      if (mainAgentGroupId === null) {
        log.warn('No main to tell of a booking change', { threadKey, change: change.kind });
        return;
      }
      const timezone = await resolveGroupTimezone(mainAgentGroupId);
      const when = (time: Span): string => slotLabel(time, timezone);
      const lasting = (time: Span): string => `${when(time)} (${Math.round((time.end - time.start) / MINUTE)} minutes)`;
      const withWhom = invitees.length === 0 ? '' : ` with ${LIST.format(invitees)}`;
      const googleSent = (what: string): string => (invitees.length === 0 ? '' : ` Google sent them the ${what}.`);
      const ids = `(thread ${threadKey}; event ${booking.eventId} on calendar ${booking.calendarId})`;
      const endingWith = (label: string, title: string | undefined): string =>
        title === undefined
          ? ` ${ids}`
          : ` ${label}, as written in the thread:\n${untrustedLine(title, TITLE_MAX)}\n${ids}`;
      let id: string;
      let text: string;
      switch (change.kind) {
        case 'booked':
          id = `gws-ea-booking-booked-${booking.eventId}`;
          text =
            `Booked a meeting${withWhom} for ${lasting(span)}${change.videoCall ? ', by video call' : ''}.` +
            `${googleSent('invitation')}${endingWith('Its title', change.title)}`;
          break;
        case 'changed': {
          id = `gws-ea-booking-changed-${booking.eventId}-${change.requestId}`;
          const fresh = change.fresh.length === 0 ? '' : `a new ${LIST.format(change.fresh)}`;
          const lead =
            change.was === undefined
              ? `Changed the meeting${withWhom} on ${when(span)}: ${fresh}`
              : `Rescheduled the meeting${withWhom} to ${lasting(span)}, from ${when(change.was)}${fresh === '' ? '' : `, with ${fresh}`}`;
          text = `${lead}.${googleSent('update')}${endingWith('Its new title', change.title)}`;
          break;
        }
        case 'cancelled':
          id = `gws-ea-booking-cancelled-${booking.eventId}`;
          text = `Cancelled the meeting${withWhom} on ${when(span)}.${googleSent('cancellation')} ${ids}`;
          break;
        default: {
          const unreachable: never = change;
          throw new Error(`Unknown booking change: ${JSON.stringify(unreachable)}`);
        }
      }
      const result = await writeNoteForMain({ id, timestamp: new Date().toISOString(), text, wake: true });
      if (result === 'no-main' || result === 'no-principal') {
        log.warn('Nobody to tell of a booking change', { threadKey, change: change.kind, result });
      }
    } catch (err) {
      log.error('Main was not told of a booking change', { threadKey, change: change.kind, err });
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

  const freeTime: ActionAnswer = async (content, session) => {
    const from = instantOf(content.from, 'from');
    const to = instantOf(content.to, 'to');
    const minutes = minutesOf(content.minutes);
    const theirs = timezoneOf(content.timezone);
    if (to <= from) throw invalidArgs('to must come after from');
    if (to - from > MAX_RANGE_DAYS * DAY) throw invalidArgs(`The range may span at most ${MAX_RANGE_DAYS} days`);
    if (to <= Date.now()) throw invalidArgs('That range has already passed: ask for one in the future.');
    const view = await viewOf(session);
    const { timezone, rules } = view.principal;
    const bookingCalendar = await bookingCalendarOf(view);
    const window = { start: Math.max(from, Date.now()), end: to };
    const holds = await listThreadHolds(view.threadKey);
    const busy =
      window.start < window.end
        ? await busyIn(view, bookingCalendar.id, window, new Set(holds.map((hold) => hold.eventId)))
        : [];
    const found = freeTimes(
      { timezone, counterpartTimezone: theirs, lengthMinutes: minutes, window, busy, rules },
      MAX_OFFERED,
    );
    const times = found.map((time) => ({
      start: iso(time.start),
      end: iso(time.end),
      principal_time: slotLabel(time, timezone),
      ...(theirs === undefined ? {} : { their_time: slotLabel(time, theirs) }),
      fit: time.fit,
      held: holds.some((hold) => Date.parse(hold.startAt) === time.start && Date.parse(hold.endAt) === time.end),
    }));
    // Each line leads with the start as the tools take it back: on the principal's clock, with its offset.
    const lines = times.map(
      (time) =>
        `- ${zonedIso(Date.parse(time.start), timezone)}: ${time.principal_time}` +
        (time.their_time === undefined ? '' : `; for them, ${time.their_time}`) +
        ` (${time.fit}${time.held ? ', held' : ''})`,
    );
    return {
      times,
      message:
        times.length === 0
          ? `Nothing in that range is free outside protected time${theirs === undefined ? '' : ' and inside their waking day'}: ask for another range, or tell main with tell_main.`
          : ['Free times:', ...lines].join('\n'),
    };
  };

  /**
   * Replace the thread's holds with these times, each lapsing three days
   * from now; an empty list releases them all. Every time is checked first,
   * so a refusal changes nothing. Holding a time held already only resets
   * when it lapses.
   */
  const hold: ActionAnswer = async (content, session) => {
    if (!Array.isArray(content.starts) || content.starts.length > MAX_HOLDS) {
      throw invalidArgs(`starts must list up to ${MAX_HOLDS} start times, or none to release every hold`);
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
      throw invalidArgs('The times overlap: hold times that do not.');
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
          attendees: guestsOn(bookingCalendar.id, []),
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
        ...spans.map((span) => `- ${zonedIso(span.start, timezone)}: ${slotLabel(span, timezone)}`),
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
    const addresses = await threadAddresses(view.threadKey);
    const onThread = new Set(addresses.map((entry) => entry.address));
    // Unnamed, the invitees are the people in the conversation: not someone only mentioned in it.
    const inConversation = new Set(addresses.flatMap((entry) => (entry.source === 'written' ? [] : [entry.address])));
    const assistant = await assistantAddresses();
    const named = addressesOf(value);
    const stranger = named?.find((address) => !onThread.has(address));
    if (stranger !== undefined) {
      throw forbidden(
        `${stranger} is not on this thread: invite only people who wrote or were written to in it, or whom main named.`,
      );
    }
    const invitees = (named ?? [...inConversation]).filter(
      (address) => !view.principal.addresses.has(address) && !assistant.has(address),
    );
    if (invitees.length === 0)
      throw invalidArgs('Name someone on the thread to invite: the booking invites nobody else.');
    return invitees;
  }

  /**
   * Refuse, writing nothing, an invitation whose text carries one of the
   * principal's private values as its invitees would see it: what it says,
   * and the name of the calendar it is on.
   */
  async function assertInvitationShareable(
    texts: readonly (string | undefined)[],
    calendarName: string | undefined,
    invitees: readonly string[],
    refused: string,
  ): Promise<void> {
    const check = await checkOutbound(
      [...texts.map((text) => text ?? ''), calendarName ?? ''],
      await audienceForAddresses(invitees),
    );
    if (!check.allowed) {
      throw forbidden(
        `${refused}: as the invitees would see it, its title, notes, place or calendar name carries one of the principal's private details (${check.kind}). ` +
          "Write it without that detail, and do not hint at, spell out, or encode it. If it is the calendar's name, tell main with tell_main.",
      );
    }
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
   * refusal writes nothing; a failure to create or record it takes back
   * whatever the write left, and the agent sees the failure.
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
    await assertInvitationShareable(
      [wanted.title, wanted.notes, wanted.location],
      bookingCalendar.summary,
      wanted.invitees,
      'The booking was not made',
    );
    if (wanted.videoCall && !allowsMeet(bookingCalendar)) {
      throw forbidden(
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
          attendees: guestsOn(bookingCalendar.id, wanted.invitees),
          reminders: 'default',
          tags: { [TAG_ROLE]: 'booking', [TAG_THREAD]: threadKey },
        },
        'all',
        { key: TAG_THREAD, value: threadKey },
      );
      const booking: ThreadBooking = {
        threadKey,
        calendarId: bookingCalendar.id,
        eventId: wanted.eventId,
        bookedAt: new Date().toISOString(),
      };
      await recordThreadBooking(booking);
      return booking;
    } catch (error) {
      await withdraw(bookingCalendar.id, wanted.eventId, threadKey);
      throw error;
    }
  }

  /**
   * Book a time someone agreed to (R71): always a new event, under an id
   * derived from this request, at a time still free or held by this thread
   * and outside protected time. It invites only people on the thread, with
   * the invitation as they would see it passing the private-values check.
   * The thread's holds then go, and main hears. A replay of a request
   * already booked only finishes what follows.
   */
  const book: ActionAnswer = async (content, session, requestId) => {
    const start = instantOf(content.start, 'start');
    const minutes = minutesOf(content.minutes);
    const title = lineOf(content.title, 'title', TITLE_MAX);
    if (title === undefined) throw invalidArgs('title is required: it is what the invitees see on their calendars');
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
    await tellMain({
      threadKey: view.threadKey,
      booking,
      span,
      invitees,
      change: { kind: 'booked', title, videoCall: conference !== undefined && conference.status !== 'failure' },
    });
    return {
      booking: eventId,
      start: iso(span.start),
      end: iso(span.end),
      message:
        `Booked: ${slotLabel(span, timezone)}. Google sends ${invitees.join(', ')} the invitation from the principal's calendar` +
        `${conferenceWords(conference)}. This thread's holds are released.${holdsLeft} main hears of it. ` +
        `To change or cancel it, give booking ${eventId}.`,
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
    if (!booking) throw forbidden(`This thread has no booking ${eventId}: use a booking id book gave you here.`);
    const event = await calendar().getEvent(booking.calendarId, eventId);
    if (!event || event.status === 'cancelled') {
      await deleteThreadBooking(booking.calendarId, eventId);
      throw forbidden('That booking is no longer on the principal’s calendar, so there is nothing to change.');
    }
    if (event.tags?.[TAG_ROLE] !== 'booking') {
      throw forbidden('That event is no longer a booking this thread may change: tell main with tell_main.');
    }
    const span = eventSpan(event, view.principal.timezone);
    if (!span) throw forbidden('Google reports no readable time for that booking: tell main with tell_main.');
    // Who it invites: neither a room nor the principal, whose calendar organizes it.
    const invitees = (event.attendees ?? []).flatMap((attendee) =>
      attendee.resource === true || attendee.organizer === true || attendee.email === undefined ? [] : [attendee.email],
    );
    return { booking, event, span, invitees };
  }

  /**
   * Change a booking this thread made, in place under its own id: its start,
   * its length, or what the invitation says. A new time is checked as `book`
   * checks one; new text passes the private-values check as the invitees
   * would see it, beside the calendar's name; and a Meet link needs a
   * calendar that allows one. Google sends the invitees the update and main
   * hears. The thread's holds stay, but for any the booking now sits on.
   */
  const changeBooking: ActionAnswer = async (content, session, requestId) => {
    const start = content.start === undefined || content.start === null ? undefined : instantOf(content.start, 'start');
    const minutes = content.minutes === undefined || content.minutes === null ? undefined : minutesOf(content.minutes);
    const title = lineOf(content.title, 'title', TITLE_MAX);
    const notes = notesOf(content.notes);
    const location = lineOf(content.location, 'location', LOCATION_MAX);
    const videoCall = videoCallOf(content.video_call);
    if ([start, minutes, title, notes, location].every((value) => value === undefined) && !videoCall) {
      throw invalidArgs('Give at least one change: start, minutes, title, location, notes, or video_call: true.');
    }
    const view = await viewOf(session);
    const { timezone } = view.principal;
    const { booking, event, span: was, invitees } = await ownBooking(content, view);
    const span = spanAt(start ?? was.start, minutes ?? (was.end - was.start) / MINUTE);
    const retimed = span.start !== was.start || span.end !== was.end;
    const holds = await listThreadHolds(view.threadKey);
    if (retimed) {
      await assertAvailable(
        view,
        booking.calendarId,
        [span],
        new Set([...holds.map((held) => held.eventId), booking.eventId]),
      );
    }
    const texted = title !== undefined || notes !== undefined || location !== undefined;
    // A link is asked for only when the event has none that works: never a second one.
    const linking = videoCall && (event.conference === undefined || event.conference.status === 'failure');
    const entry = texted || linking ? await calendar().getCalendar(booking.calendarId) : undefined;
    if (texted) {
      await assertInvitationShareable(
        [title, notes, location],
        entry?.summary,
        invitees,
        'The booking was not changed',
      );
    }
    if (linking && (entry === undefined || !allowsMeet(entry))) {
      throw forbidden(
        'The calendar this booking is on does not allow Google Meet links: give the place another way, such as their own link in location.',
      );
    }
    const fields: EventWrite = {
      ...(title === undefined ? {} : { summary: title }),
      ...(notes === undefined ? {} : { description: notes }),
      ...(location === undefined ? {} : { location }),
      ...(linking ? { conference: { requestId: eventIdFor('meet', booking.eventId, requestId) } } : {}),
      ...(retimed ? { start: iso(span.start), end: iso(span.end) } : {}),
    };
    if (Object.keys(fields).length === 0) {
      return {
        booking: booking.eventId,
        start: iso(span.start),
        end: iso(span.end),
        message: `The booking already stands at ${slotLabel(span, timezone)}${videoCall ? conferenceWords(event.conference) : ''}: nothing changed.`,
      };
    }
    await calendar().patchEvent(booking.calendarId, booking.eventId, fields, 'all');
    recordOwnCalendarChange(booking.calendarId, booking.eventId);
    let holdsLeft = '';
    /* eslint-disable no-catch-all/no-catch-all -- the change stands; a hold left under it lapses on its own */
    try {
      if (retimed) {
        await releaseHolds(
          holds.filter((held) => !isClear(span, [{ start: Date.parse(held.startAt), end: Date.parse(held.endAt) }])),
        );
      }
    } catch (err) {
      log.warn('A hold under a changed booking was not released', { threadKey: view.threadKey, err });
      holdsLeft = ' A hold it now sits on could not be released yet; it lapses on its own.';
    }
    /* eslint-enable no-catch-all/no-catch-all */
    const conference = linking ? await readConference(calendar(), booking.calendarId, booking.eventId) : undefined;
    const fresh = [
      ...(title === undefined ? [] : ['title']),
      ...(location === undefined ? [] : ['place']),
      ...(notes === undefined ? [] : ['notes']),
      ...(linking ? ['Google Meet link'] : []),
    ];
    await tellMain({
      threadKey: view.threadKey,
      booking,
      span,
      invitees,
      change: {
        kind: 'changed',
        requestId,
        ...(retimed ? { was } : {}),
        fresh,
        ...(title === undefined ? {} : { title }),
      },
    });
    return {
      booking: booking.eventId,
      start: iso(span.start),
      end: iso(span.end),
      message:
        `Changed: ${slotLabel(span, timezone)}${conferenceWords(conference)}. ` +
        `Google sends the invitees the update, and main hears of it.${holdsLeft}`,
    };
  };

  /** Cancel a booking this thread made: its event is deleted with Google's notice to the invitees. */
  const cancelBooking: ActionAnswer = async (content, session) => {
    const view = await viewOf(session);
    const { timezone } = view.principal;
    const { booking, span, invitees } = await ownBooking(content, view);
    await calendar().deleteEvent(booking.calendarId, booking.eventId, 'all');
    recordOwnCalendarChange(booking.calendarId, booking.eventId);
    await tellMain({ threadKey: view.threadKey, booking, span, invitees, change: { kind: 'cancelled' } });
    await deleteThreadBooking(booking.calendarId, booking.eventId);
    return {
      booking: booking.eventId,
      message: `Cancelled: ${slotLabel(span, timezone)}. Google sends the invitees the cancellation, and main hears of it.`,
    };
  };

  return {
    freeTime,
    hold: inTurn(hold),
    book: inTurn(book),
    changeBooking: inTurn(changeBooking),
    cancelBooking: inTurn(cancelBooking),
    releaseThreadHolds,
    releaseExpiredHolds,
  };
}
