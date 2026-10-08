/**
 * main's two writes on the principal's own events, which `gog` cannot make
 * with the principal on the guest list (it sets no answer, and refuses to
 * answer an event they organize):
 *
 *   create_event   { calendar, title, start, end, all_day?, timezone?, notes?, location?,
 *                    guests?, free?, private?, recurrence?, video_call? }
 *                                        → { calendar, event, start, end, message }
 *   change_guests  { calendar, event, add?, remove? }
 *                                        → { calendar, event, guests, message }
 *
 * - Each writes only to a calendar of the principal's that Google lets the
 *   assistant change, and `change_guests` only to an event that calendar
 *   organizes: what someone else organizes changes through them.
 * - On every event either writes, the principal is a guest, accepted, as
 *   Google lists the organizer of an event they made themselves, unless
 *   they have answered it otherwise themselves; they never come off it.
 * - `change_guests` writes each guest it keeps back exactly as Google holds
 *   them, so nobody else's answer or note changes, and only over the version
 *   of the event it read: a change that lands in between is read again and
 *   kept. A room booked on the event stays on it, and is never named a guest.
 * - Neither emails anyone, as `gog` emails no one unless told to.
 *
 * Each request is answered once. A replayed `create_event` finds the event
 * it made, whose id derives from the request, and adds nothing when that
 * event has since been deleted.
 */
import { TIMEZONE } from '../../config.js';
import { forbidden, invalidArgs, type ActionAnswer } from '../../cli/delivery-action.js';
import { hasControlCharacters } from '../../gws-ea/validation.js';
import { weekdayRefusal } from '../gws-ea-dates/refusal.js';
import { EVENT_ID, isPrincipalCalendar, recordOwnCalendarChange } from '../gws-ea-inbox/calendar-notifications.js';
import { getGwsEaProfile, listPrincipalAddresses } from '../gws-ea-profile/db.js';
import { allowsMeet, type CalendarEntry, type GuestRecord, type MeetingsCalendarApi } from './calendar-api.js';
import { conferenceWords, dayLabel, eventIdFor, guestsOn, readConference, spanLabel } from './calendar-actions.js';
import { addressesOf, flagOf, instantOf, lineOf, notesOf, timezoneOf } from './fields.js';

const TITLE_MAX = 200;
const NOTES_MAX = 8_000;
const LOCATION_MAX = 500;
const MAX_GUESTS = 50;
const MAX_RECURRENCE = 10;
const RECURRENCE_LINE_MAX = 500;
/** The longest an event may last: a year. */
const MAX_EVENT_DAYS = 366;
/** Google's longest calendar id is an address. */
const CALENDAR_ID_MAX = 254;
/** How many times `change_guests` reads and writes a guest list that keeps changing under it before it gives up. */
const GUEST_WRITE_ATTEMPTS = 3;
const DAY = 24 * 60 * 60 * 1000;

const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const RECURRENCE_LINE = /^(?:RRULE|EXRULE|RDATE|EXDATE)[:;]\S+$/u;

/** People named in prose: "a, b, and c". */
const LIST = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });

// ---------------------------------------------------------------------------
// The request's fields
// ---------------------------------------------------------------------------

function calendarIdOf(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : '';
  if (id === '' || id.length > CALENDAR_ID_MAX || !id.includes('@') || /\s/u.test(id) || hasControlCharacters(id)) {
    throw invalidArgs("calendar must be a calendar ID, such as the principal's address for their primary calendar");
  }
  return id;
}

function eventIdOf(value: unknown): string {
  if (typeof value !== 'string' || !EVENT_ID.test(value)) {
    throw invalidArgs("event must be the event's id, as gog calendar events gives it");
  }
  return value;
}

/** A calendar date, `YYYY-MM-DD`, as epoch milliseconds at its UTC midnight. */
function dateOf(value: unknown, label: string): number {
  const at = typeof value === 'string' && DATE.test(value) ? Date.parse(`${value}T00:00:00Z`) : NaN;
  if (!Number.isFinite(at) || new Date(at).toISOString().slice(0, 10) !== value) {
    throw invalidArgs(`${label} must be a date such as 2026-10-12`);
  }
  return at;
}

function recurrenceOf(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const lines = Array.isArray(value) ? value : [];
  if (
    lines.length === 0 ||
    lines.length > MAX_RECURRENCE ||
    !lines.every(
      (line): line is string =>
        typeof line === 'string' && line.length <= RECURRENCE_LINE_MAX && RECURRENCE_LINE.test(line),
    )
  ) {
    throw invalidArgs(
      `recurrence must list RRULE, EXRULE, RDATE or EXDATE lines, such as RRULE:FREQ=WEEKLY;BYDAY=MO (up to ${MAX_RECURRENCE})`,
    );
  }
  return lines;
}

/** A guest's address as Google holds it, lowercased. */
function emailOf(guest: GuestRecord): string | undefined {
  return typeof guest.email === 'string' ? guest.email.toLowerCase() : undefined;
}

/** "a is", "a and b are". */
function are(addresses: readonly string[]): string {
  return `${LIST.format(addresses)} ${addresses.length === 1 ? 'is' : 'are'}`;
}

/** An all-day span, its days at UTC midnight, as people say it: "Monday 12 Oct", or "Monday 12 Oct to Tuesday 13 Oct". */
function daysLabel(first: number, last: number): string {
  return first === last ? dayLabel(first, 'UTC') : `${dayLabel(first, 'UTC')} to ${dayLabel(last, 'UTC')}`;
}

/** An answer a guest gave an event; `needsAction`, or none, is no answer yet. */
type Answer = 'accepted' | 'declined' | 'tentative';

function answerOf(guest: GuestRecord | undefined): Answer | undefined {
  const status = guest?.responseStatus;
  return status === 'accepted' || status === 'declined' || status === 'tentative' ? status : undefined;
}

/** The principal on an event's guest list, as the end of a sentence naming its other guests. */
const PRINCIPAL_WORDS: Readonly<Record<Answer, string>> = {
  accepted: 'and the principal, accepted',
  declined: 'and the principal, who declined it',
  tentative: 'and the principal, who answered maybe',
};

/** What `change_guests` makes of an event's guest list as Google holds it. */
interface GuestChange {
  /** The list to write back, or undefined when it already says what was asked. */
  readonly next: readonly GuestRecord[] | undefined;
  /** Who the event invites afterwards: neither the principal nor a room. */
  readonly invited: readonly string[];
  /** The principal's answer afterwards. */
  readonly answer: Answer;
  /** Addresses to take off that the list does not have. */
  readonly absent: readonly string[];
  /** Addresses to invite that it already has. */
  readonly already: readonly string[];
}

/**
 * The guest list `change_guests` writes on an event of the principal's
 * calendar `calendarId`, worked out afresh from each read of it: everyone
 * kept exactly as Google holds them, those named in `remove` taken off
 * (never the principal, refused before this), those in `add` appended, and
 * the principal on it. Whatever the principal answered stays theirs; only
 * when they have no answer yet do they count as accepted, as the organizer
 * of an event they made themselves.
 */
function guestChange(
  calendarId: string,
  guests: readonly GuestRecord[],
  add: readonly string[],
  remove: readonly string[],
): GuestChange {
  const owner = calendarId.toLowerCase();
  const isOwner = (guest: GuestRecord): boolean => emailOf(guest) === owner;
  const listed = new Set(guests.flatMap((guest) => emailOf(guest) ?? []));
  const adding = add.filter((address) => address !== owner && !listed.has(address));
  const ownerEntry = guests.find(isOwner);
  const answered = answerOf(ownerEntry);

  const kept = guests
    .filter((guest) => !remove.includes(emailOf(guest) ?? ''))
    .map((guest) => (isOwner(guest) && answered === undefined ? { ...guest, responseStatus: 'accepted' } : guest));
  const next: GuestRecord[] = [
    ...(ownerEntry === undefined ? [{ email: calendarId, responseStatus: 'accepted' }] : []),
    ...kept,
    ...adding.map((email) => ({ email })),
  ];
  const unchanged = adding.length === 0 && kept.length === guests.length && answered !== undefined;
  return {
    next: unchanged ? undefined : next,
    // A room booked on the event stays on it as it is, but is no one invited.
    invited: next.flatMap((guest) => {
      const email = emailOf(guest);
      return email === undefined || email === owner || guest.resource === true ? [] : [email];
    }),
    answer: answered ?? 'accepted',
    absent: remove.filter((address) => !listed.has(address)),
    already: add.filter((address) => address !== owner && listed.has(address)),
  };
}

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

export interface PrincipalEventToolsDeps {
  /** The host's own Calendar client. */
  readonly calendar: () => MeetingsCalendarApi;
}

export function createPrincipalEventTools(deps: PrincipalEventToolsDeps) {
  const calendar = () => deps.calendar();

  /** The calendar named, refused unless it is the principal's and Google lets the assistant change it. */
  async function principalCalendarOf(calendarId: string): Promise<CalendarEntry> {
    const [entry, addresses] = await Promise.all([calendar().getCalendar(calendarId), listPrincipalAddresses()]);
    const principal = new Set(addresses.map((address) => address.email.toLowerCase()));
    if (entry === undefined || !isPrincipalCalendar(entry, principal)) {
      throw forbidden(
        `${calendarId} is not one of the principal's calendars in your list: put their events on one of theirs.`,
      );
    }
    if (entry.accessRole !== 'writer' && entry.accessRole !== 'owner') {
      throw forbidden('Google lets you see that calendar but not change it.');
    }
    return entry;
  }

  const createEvent: ActionAnswer = async (content, _session, requestId) => {
    const calendarId = calendarIdOf(content.calendar);
    const title = lineOf(content.title, 'title', TITLE_MAX);
    if (title === undefined) throw invalidArgs(`title must be text of 1 to ${TITLE_MAX} characters`);
    const allDay = flagOf(content.all_day, 'all_day');
    const notes = notesOf(content.notes, NOTES_MAX);
    const location = lineOf(content.location, 'location', LOCATION_MAX);
    const guests = addressesOf(content.guests, 'guests', MAX_GUESTS) ?? [];
    const free = flagOf(content.free, 'free');
    const hidden = flagOf(content.private, 'private');
    const recurrence = recurrenceOf(content.recurrence);
    const videoCall = flagOf(content.video_call, 'video_call');
    const timezone = timezoneOf(content.timezone) ?? (await getGwsEaProfile()).principal_timezone ?? TIMEZONE;
    const misdated = await weekdayRefusal([title, notes ?? '', location ?? '']);
    if (misdated !== undefined) throw invalidArgs(`The event was not added: ${misdated}`);

    let start: string;
    let end: string;
    let when: string;
    if (allDay) {
      const first = dateOf(content.start, 'start');
      const last = dateOf(content.end, 'end');
      if (last < first) throw invalidArgs('end, the last day, must not come before start');
      if (last - first >= MAX_EVENT_DAYS * DAY) throw invalidArgs(`An event may last at most ${MAX_EVENT_DAYS} days`);
      start = String(content.start);
      // Google's end date is the day after the last.
      end = new Date(last + DAY).toISOString().slice(0, 10);
      when = `${daysLabel(first, last)}, all day`;
    } else {
      const from = instantOf(content.start, 'start');
      const to = instantOf(content.end, 'end');
      if (to <= from) throw invalidArgs('end must come after start');
      if (to - from > MAX_EVENT_DAYS * DAY) throw invalidArgs(`An event may last at most ${MAX_EVENT_DAYS} days`);
      start = new Date(from).toISOString();
      end = new Date(to).toISOString();
      // An event that ends on a later day names both days, not only the one it starts on.
      when = spanLabel({ start: from, end: to }, timezone);
    }

    const entry = await principalCalendarOf(calendarId);
    if (videoCall && !allowsMeet(entry)) {
      throw forbidden('That calendar does not allow Google Meet links: give the place in location instead.');
    }
    const eventId = eventIdFor('event', requestId);
    const inserted = await calendar().insertEvent(
      entry.id,
      eventId,
      {
        summary: title,
        ...(notes === undefined ? {} : { description: notes }),
        ...(location === undefined ? {} : { location }),
        ...(videoCall ? { conference: { requestId: eventIdFor('meet', eventId) } } : {}),
        start,
        end,
        ...(allDay ? { allDay: true } : { timeZone: timezone }),
        ...(recurrence === undefined ? {} : { recurrence }),
        attendees: guestsOn(entry.id, guests),
        transparency: free ? 'transparent' : 'opaque',
        ...(hidden ? { visibility: 'private' as const } : {}),
        reminders: 'default',
      },
      'none',
    );
    if (inserted === 'exists') {
      // A replay: this request made the event before. It stands unless someone has deleted it since,
      // and an event deleted is not put back.
      const made = await calendar().getEvent(entry.id, eventId);
      if (made === undefined || made.status === 'cancelled') {
        throw forbidden(
          'The event this request made earlier has since been deleted from that calendar, so nothing was added.',
        );
      }
    }
    recordOwnCalendarChange(entry.id, eventId);
    const conference = videoCall ? await readConference(calendar(), entry.id, eventId) : undefined;
    const invited = guests.filter((address) => address !== entry.id.toLowerCase());
    return {
      calendar: entry.id,
      event: eventId,
      start: String(content.start),
      end: String(content.end),
      message: [
        `Added "${title}" to ${entry.summary ?? entry.id}: ${when}${conferenceWords(conference)}.`,
        'As on an event they made themselves, the principal is on its guest list, accepted.',
        ...(invited.length === 0 ? [] : [`Its guests: ${invited.join(', ')}; Google emailed no one.`]),
        ...(recurrence === undefined ? [] : ['It repeats.']),
        `Change who it invites with change_guests, event ${eventId}; anything else with gog calendar update.`,
      ].join(' '),
    };
  };

  const changeGuests: ActionAnswer = async (content) => {
    const calendarId = calendarIdOf(content.calendar);
    const eventId = eventIdOf(content.event);
    const add = addressesOf(content.add, 'add', MAX_GUESTS) ?? [];
    const remove = addressesOf(content.remove, 'remove', MAX_GUESTS) ?? [];
    if (add.length === 0 && remove.length === 0) {
      throw invalidArgs('Give add, remove, or both: the people to invite or to take off.');
    }
    const entry = await principalCalendarOf(calendarId);
    const owner = entry.id.toLowerCase();
    if (remove.includes(owner)) throw forbidden('The principal stays on their own events: they organize them.');

    // The list is written back only over the version of the event it was
    // read from, so a guest's answer, or anyone's change, that lands in
    // between is read again and kept rather than undone.
    for (let attempt = 0; attempt < GUEST_WRITE_ATTEMPTS; attempt += 1) {
      const current = await calendar().getGuests(entry.id, eventId);
      if (current === undefined || current.status === 'cancelled') {
        throw forbidden(`No event ${eventId} on that calendar.`);
      }
      if (current.organizer !== owner) {
        throw forbidden(
          `${current.organizer ?? 'Someone else'} organizes that event: only they change who it invites. Ask them, through external-email when they are outside.`,
        );
      }

      const { next, invited, answer, absent, already } = guestChange(entry.id, current.guests, add, remove);
      if (next === undefined) {
        return {
          calendar: entry.id,
          event: eventId,
          guests: invited,
          message: `Nothing changed: ${[
            ...(absent.length === 0 ? [] : [`${are(absent)} not invited`]),
            ...(already.length === 0 ? [] : [`${are(already)} already invited`]),
            'the principal is already on it',
          ].join('; ')}.`,
        };
      }
      if ((await calendar().setGuests(entry.id, eventId, next, 'none', current.etag)) === 'set') {
        recordOwnCalendarChange(entry.id, eventId);
        return {
          calendar: entry.id,
          event: eventId,
          guests: invited,
          message: `Its guests now: ${invited.length === 0 ? 'nobody else' : LIST.format(invited)}, ${PRINCIPAL_WORDS[answer]}. Google emailed no one.`,
        };
      }
    }
    throw forbidden("The event's guests kept changing while this ran: try again in a moment.");
  };

  return { createEvent, changeGuests };
}
