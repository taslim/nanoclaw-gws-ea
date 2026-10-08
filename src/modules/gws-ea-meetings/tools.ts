/**
 * external-email's scheduling tools (KTD7; R69, R70, R71): four host
 * actions, each bound to the email thread whose session calls it
 * (`threadCalendarAction` in `guard.ts`). No argument names a thread, so a
 * call never reaches another thread's bookings.
 *
 *   free_time       { from, to, minutes, timezone? } → { windows, windows_not_listed, message }
 *   book            { start, minutes, title, notes?, location?, video_call?, invitees?, timezone? }
 *                                                     → { booking, start, end, message }
 *   change_booking  { booking, start?, minutes?, title?, location?, notes?, video_call?, timezone? }
 *                                                     → { booking, start, end, message }
 *   cancel_booking  { booking, timezone? }           → { booking, message }
 *
 * Every time an answer gives is ready to write, in the principal's zone and,
 * when a call gives `timezone`, the other side's.
 *
 * - `free_time` lists the free windows in the range from now on, from the
 *   principal's free/busy alone, never inside protected time, in date order
 *   (`freeWindows` in `slots.ts`). The agent picks the times; each window is
 *   labeled, ready to write, in the principal's time zone and, when given,
 *   the counterpart's, inside whose waking day it falls, with a fit note from
 *   a fixed vocabulary that never echoes a preference.
 * - Nothing reserves a time before someone agrees to it: a time offered in
 *   one thread is any thread's until booked, and a booking blocks time as
 *   any other event of the principal's does (`blocksTime` in `slots.ts`).
 * - `book` always creates a new event at a time still free, inviting only
 *   people on the thread, with an invitation that passes the private-values
 *   check as its invitees would see it.
 * - `change_booking` and `cancel_booking` act only on an event this thread
 *   booked. A change keeps the event's id and is checked as `book` checks
 *   what it writes.
 * - `book` and `change_booking` refuse a time inside protected time, so a
 *   counterpart's proposal never gets round it, and refuse a time that has
 *   gone with word to offer others.
 * - Every booking lists the principal as an accepted guest, its organizer
 *   (`guestsOn`); who a booking invites never counts them.
 * - `main` hears in one fact when a booking is made, changed or cancelled.
 *
 * Bookings go on the calendar `main` named for the thread, else on the
 * principal's primary calendar: the calendar of the first address they
 * gave. Either way it must be a principal calendar the assistant can write
 * to; no other calendar stands in for it.
 * A booking is the thread's when its record names it and its event still
 * carries the booking tag the host gave it.
 *
 * Each request is answered once, a refusal or failure included. A replayed
 * request writes nothing twice: a booking's event id derives from the
 * request that made it.
 */
import { TIMEZONE } from '../../config.js';
import { forbidden, invalidArgs, type ActionAnswer } from '../../cli/delivery-action.js';
import { resolveGroupTimezone } from '../../container-config.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { isPrincipalCalendar, recordOwnCalendarChange } from '../gws-ea-inbox/calendar-notifications.js';
import { listPrincipalCalendars } from '../gws-ea-inbox/db.js';
import { assistantAddresses } from '../gws-ea-inbox/runtime.js';
import { threadAddresses } from '../gws-ea-inbox/thread-map.js';
import { untrustedLine } from '../gws-ea-inbox/untrusted.js';
import { getSchedulingPreferenceValues } from '../gws-ea-preferences/db.js';
import { getGwsEaProfile, getMainAgentGroupId, listPrincipalAddresses } from '../gws-ea-profile/db.js';
import { writeNoteForMain } from '../gws-ea-profile/main-note.js';
import { allowsMeet, type CalendarEntry, type EventWrite, type MeetingsCalendarApi } from './calendar-api.js';
import {
  assertInvitationShareable,
  conferenceWords,
  ensureEvent,
  eventIdFor,
  guestsOn,
  readConference,
  slotLabel,
  TAG_ROLE,
} from './calendar-actions.js';
import { addressesOf, flagOf, instantOf, lineOf, notesOf, timezoneOf } from './fields.js';
import {
  blocksTime,
  eventSpan,
  freeWindows,
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
  getThreadBooking,
  getThreadBookingCalendar,
  recordThreadBooking,
  type ThreadBooking,
} from './thread-calendar.js';

/** The private tag naming the thread an event was placed for. */
export const TAG_THREAD = 'gwsEaThread';

/** How many windows one `free_time` answer lists: about a week of days. */
const MAX_WINDOWS = 24;
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

/** A booking's id, as `book` answered with it: its event's id, lowercase hex. */
const BOOKING_ID = /^[0-9a-f]{64}$/u;

/**
 * What to do when an invitation would show its invitees a private detail.
 * Their guest list is never the detail: they are all people of the thread,
 * who see each other's addresses there.
 */
const PRIVATE_DETAIL_ADVICE =
  "Write it without that detail, and do not hint at, spell out, or encode it. If it is the calendar's name, tell main with tell_main.";

// ---------------------------------------------------------------------------
// The request's fields
// ---------------------------------------------------------------------------

function minutesOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < MIN_MINUTES || value > MAX_MINUTES) {
    throw invalidArgs(`minutes must be a whole number from ${MIN_MINUTES} to ${MAX_MINUTES}`);
  }
  return value;
}

function bookingIdOf(value: unknown): string {
  if (typeof value !== 'string' || !BOOKING_ID.test(value)) {
    throw invalidArgs('booking must be the booking id book answered with');
  }
  return value;
}

function spanAt(start: number, minutes: number): Span {
  return { start, end: start + minutes * MINUTE };
}

/** A time ready to write: in the principal's zone and, when known, the other side's. */
function bothZones(span: Span, timezone: string, theirs: string | undefined): string {
  return `${slotLabel(span, timezone)}${theirs === undefined ? '' : `; for them, ${slotLabel(span, theirs)}`}`;
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
   * The calendar the thread books on: the one main named for it, else the
   * principal's primary calendar. Either way it must be a principal calendar
   * the assistant can write to; refused, saying so, when it is not, rather
   * than placing the meeting on some other calendar of theirs.
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
        ? "The assistant cannot write to the principal's primary calendar, so it can book nothing: tell main with tell_main."
        : 'The assistant cannot write to the calendar main named for this thread, so it can book nothing: tell main with tell_main.',
    );
  }

  /**
   * Time taken in `span`, read now from the principal's calendars and the
   * one the thread books on: every event that blocks their time, the
   * assistant's own included, apart from those in `ignore`: the event a
   * write is itself moving or retrying.
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
   * or is no longer free: what `book` and `change_booking` never place. A
   * time no longer free is refused with word to offer others.
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
   * The calendar writes take turns across every thread: each looks at what
   * is free and writes before the next looks, so two threads never take one
   * time, and the second is told it has gone.
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
    const busy = window.start < window.end ? await busyIn(view, bookingCalendar.id, window, new Set()) : [];
    const found = freeWindows({ timezone, counterpartTimezone: theirs, lengthMinutes: minutes, window, busy, rules });
    const windows = found.slice(0, MAX_WINDOWS).map((free) => ({
      start: iso(free.start),
      end: iso(free.end),
      principal_time: slotLabel(free, timezone),
      ...(theirs === undefined ? {} : { their_time: slotLabel(free, theirs) }),
      fit: free.fit,
    }));
    const unlisted = found.length - windows.length;
    // Each line leads with the window on the principal's clock, with its offset, as the tools take a start back.
    const lines = found
      .slice(0, MAX_WINDOWS)
      .map(
        (free, index) =>
          `- ${zonedIso(free.start, timezone)} to ${zonedIso(free.end, timezone)}: ${windows[index].principal_time}` +
          (theirs === undefined ? '' : `; for them, ${windows[index].their_time}`) +
          ` (${free.fit})`,
      );
    return {
      windows,
      windows_not_listed: unlisted,
      message:
        windows.length === 0
          ? `Nothing in that range is free for ${minutes} minutes outside protected time${theirs === undefined ? '' : ' and inside their waking day'}: ask for another range, or tell main with tell_main.`
          : [
              `Free for ${minutes} minutes: any start that ends by a window's end.`,
              ...lines,
              ...(unlisted > 0 ? [`${unlisted} later windows are not listed: ask from the last one on for more.`] : []),
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
    const named = addressesOf(value, 'invitees', MAX_INVITEES);
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
    // Its own event, which an earlier attempt at this request may have left, never blocks it.
    await assertAvailable(view, bookingCalendar.id, [wanted.span], new Set([wanted.eventId]));
    await assertInvitationShareable(
      {
        texts: [wanted.title, wanted.notes, wanted.location],
        shown: [bookingCalendar.summary],
        recipients: wanted.invitees,
      },
      'The booking was not made',
      PRIVATE_DETAIL_ADVICE,
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
   * derived from this request, at a time still free and outside protected
   * time. It invites only people on the thread, with the invitation as they
   * would see it passing the private-values check, and main hears. A replay
   * of a request already booked only finishes what follows.
   */
  const book: ActionAnswer = async (content, session, requestId) => {
    const start = instantOf(content.start, 'start');
    const minutes = minutesOf(content.minutes);
    const title = lineOf(content.title, 'title', TITLE_MAX);
    if (title === undefined) throw invalidArgs('title is required: it is what the invitees see on their calendars');
    const notes = notesOf(content.notes, NOTES_MAX);
    const location = lineOf(content.location, 'location', LOCATION_MAX);
    const videoCall = flagOf(content.video_call, 'video_call');
    const theirs = timezoneOf(content.timezone);
    const view = await viewOf(session);
    const { timezone } = view.principal;
    const span = spanAt(start, minutes);
    const invitees = await inviteesOf(content.invitees, view);
    const eventId = eventIdFor('booking', view.threadKey, requestId);
    const booking =
      (await getThreadBooking(view.threadKey, eventId)) ??
      (await placeBooking(view, { eventId, span, invitees, title, notes, location, videoCall }));
    const conference = videoCall ? await readConference(calendar(), booking.calendarId, eventId) : undefined;
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
        `Booked: ${bothZones(span, timezone, theirs)}. Google sends ${invitees.join(', ')} the invitation from the principal's calendar` +
        `${conferenceWords(conference)}. main hears of it. To change or cancel it, give booking ${eventId}.`,
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
   * hears.
   */
  const changeBooking: ActionAnswer = async (content, session, requestId) => {
    const start = content.start === undefined || content.start === null ? undefined : instantOf(content.start, 'start');
    const minutes = content.minutes === undefined || content.minutes === null ? undefined : minutesOf(content.minutes);
    const title = lineOf(content.title, 'title', TITLE_MAX);
    const notes = notesOf(content.notes, NOTES_MAX);
    const location = lineOf(content.location, 'location', LOCATION_MAX);
    const videoCall = flagOf(content.video_call, 'video_call');
    const theirs = timezoneOf(content.timezone);
    if ([start, minutes, title, notes, location].every((value) => value === undefined) && !videoCall) {
      throw invalidArgs('Give at least one change: start, minutes, title, location, notes, or video_call: true.');
    }
    const view = await viewOf(session);
    const { timezone } = view.principal;
    const { booking, event, span: was, invitees } = await ownBooking(content, view);
    const span = spanAt(start ?? was.start, minutes ?? (was.end - was.start) / MINUTE);
    const retimed = span.start !== was.start || span.end !== was.end;
    // The booking never blocks its own move.
    if (retimed) await assertAvailable(view, booking.calendarId, [span], new Set([booking.eventId]));
    const texted = title !== undefined || notes !== undefined || location !== undefined;
    // A link is asked for only when the event has none that works: never a second one.
    const linking = videoCall && (event.conference === undefined || event.conference.status === 'failure');
    const entry = texted || linking ? await calendar().getCalendar(booking.calendarId) : undefined;
    if (texted) {
      await assertInvitationShareable(
        { texts: [title, notes, location], shown: [entry?.summary], recipients: invitees },
        'The booking was not changed',
        PRIVATE_DETAIL_ADVICE,
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
        message: `The booking already stands at ${bothZones(span, timezone, theirs)}${videoCall ? conferenceWords(event.conference) : ''}: nothing changed.`,
      };
    }
    await calendar().patchEvent(booking.calendarId, booking.eventId, fields, 'all');
    recordOwnCalendarChange(booking.calendarId, booking.eventId);
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
        `Changed: ${bothZones(span, timezone, theirs)}${conferenceWords(conference)}. ` +
        'Google sends the invitees the update, and main hears of it.',
    };
  };

  /** Cancel a booking this thread made: its event is deleted with Google's notice to the invitees. */
  const cancelBooking: ActionAnswer = async (content, session) => {
    const theirs = timezoneOf(content.timezone);
    const view = await viewOf(session);
    const { timezone } = view.principal;
    const { booking, span, invitees } = await ownBooking(content, view);
    await calendar().deleteEvent(booking.calendarId, booking.eventId, 'all');
    recordOwnCalendarChange(booking.calendarId, booking.eventId);
    await tellMain({ threadKey: view.threadKey, booking, span, invitees, change: { kind: 'cancelled' } });
    await deleteThreadBooking(booking.calendarId, booking.eventId);
    return {
      booking: booking.eventId,
      message: `Cancelled: ${bothZones(span, timezone, theirs)}. Google sends the invitees the cancellation, and main hears of it.`,
    };
  };

  return {
    freeTime,
    book: inTurn(book),
    changeBooking: inTurn(changeBooking),
    cancelBooking: inTurn(cancelBooking),
  };
}
