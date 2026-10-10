/**
 * main's two writes on events, which `gog` cannot make with the principal
 * on the guest list (it sets no answer, and refuses to answer an event they
 * organize), nor with the private-details check on its invitations:
 *
 *   create_event   { calendar, title, start, end, all_day?, timezone?, notes?, location?,
 *                    guests?, free?, private?, recurrence?, video_call? }
 *                                        → { calendar, event, start, end, message }
 *   change_guests  { calendar, event, add?, remove? }
 *                                        → { calendar, event, guests, message }
 *
 * - Each writes only to a calendar Google lets the assistant change that is
 *   the principal's or the assistant's own (KTD10), and `change_guests` only
 *   to an event that calendar organizes: what someone else organizes
 *   changes through them.
 * - On every event either writes on a principal calendar, the principal is
 *   a guest, accepted, as Google lists the organizer of an event they made
 *   themselves, unless they have answered it otherwise themselves; they
 *   never come off it. On the assistant's own calendar the assistant is that
 *   organizer, and the principal is a guest like any other, only when main
 *   invites them: the event takes their time only through the copy Google's
 *   invitation puts on their calendar. Its answer says who else sees it.
 * - `change_guests` writes each guest it keeps back exactly as Google holds
 *   them, so nobody else's answer or note changes, and only over the version
 *   of the event it read: a change that lands in between is read again and
 *   kept. A room booked on the event stays on it, and is never named a guest.
 * - `create_event` sends Google's invitation when it invites anyone but the
 *   principal, as a human assistant's invitation reaches its guests, and
 *   emails no one otherwise. `change_guests` sends Google's update when it
 *   invites or takes off anyone but the principal, and emails no one when
 *   the change is the principal's alone. On the assistant's own calendar,
 *   the principal hears of either as any guest does.
 * - Before either puts anyone on an event, it passes the private-details
 *   check as its guests outside the principal would see it: its title,
 *   notes and place, the calendar's name, and every address on its guest
 *   list but their own.
 * - A write on a principal calendar is recorded as the assistant's own
 *   change, so Google's notification of it makes no note; one on the
 *   assistant's own calendar is not, so a guest's answer to it reaches main
 *   (KTD12).
 *
 * Each request is answered once. A replayed `create_event` finds the event
 * it made, whose id derives from the request, and writes nothing more: its
 * guests heard of it from the first write, and a change made since stands.
 * It adds nothing when that event has since been deleted.
 */
import { TIMEZONE } from '../../config.js';
import { forbidden, invalidArgs, type ActionAnswer } from '../../cli/delivery-action.js';
import { hasControlCharacters } from '../../gws-ea/validation.js';
import { EVENT_ID, isPrincipalCalendar, recordOwnCalendarChange } from '../gws-ea-inbox/calendar-notifications.js';
import { assistantAddresses } from '../gws-ea-inbox/runtime.js';
import { getGwsEaProfile, loadPrincipalRecognizer, type PrincipalRecognizer } from '../gws-ea-profile/db.js';
import { allowsMeet, type CalendarEntry, type GuestRecord, type MeetingsCalendarApi } from './calendar-api.js';
import {
  assertInvitationShareable,
  conferenceWords,
  dayLabel,
  eventIdFor,
  guestsOn,
  isOwnerAddress,
  readConference,
  spanLabel,
} from './calendar-actions.js';
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

/**
 * The addresses on a guest list that someone outside the principal sees
 * beside their own: a guest's own address tells them nothing.
 */
function addressesSeen(addresses: readonly string[], outside: readonly string[]): string[] {
  return addresses.filter((address) => outside.some((guest) => guest !== address));
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

/** Whose calendar the tools write on (KTD10): one of the principal's, or the assistant's own. */
type CalendarOwner = 'principal' | 'assistant';

/**
 * What the answers say of a calendar's owner, the organizer of every event
 * the tools change on it.
 */
interface OwnerWords {
  /** Said of every event `create_event` adds there. */
  readonly added: string;
  /** Refusing to take the owner off an event of theirs. */
  readonly stays: string;
  /** Ending "Nothing changed: …". */
  readonly alreadyOn: string;
  /** Who an event invites after `change_guests`, ending "Its guests now: …". */
  guestsNow(invited: readonly string[], answer: Answer): string;
}

const OWNER_WORDS: Readonly<Record<CalendarOwner, OwnerWords>> = {
  principal: {
    added: 'As on an event they made themselves, the principal is on its guest list, accepted.',
    stays: 'The principal stays on their own events: they organize them.',
    alreadyOn: 'the principal is already on it',
    guestsNow: (invited, answer) =>
      `${invited.length === 0 ? 'nobody else' : LIST.format(invited)}, ${PRINCIPAL_WORDS[answer]}`,
  },
  // The host reads none of the calendar's sharing (its token cannot), so these words cover every case.
  assistant: {
    added:
      'It is on your own calendar: anyone your calendar is shared with sees its details unless it is private, and in a company Workspace that can include colleagues.',
    stays: 'You stay on the events on your own calendar: you organize them.',
    alreadyOn: 'you are already on it',
    guestsNow: (invited) => (invited.length === 0 ? 'nobody but you' : LIST.format(invited)),
  },
};

/**
 * Whether Google tells an event's guests of a write that invites, adds or
 * takes off `addresses`: on a principal calendar, only when one of them is
 * someone other than the principal, its organizer; on the assistant's own,
 * whenever there is anyone, the principal included.
 */
function googleTells(owner: CalendarOwner, principal: PrincipalRecognizer, addresses: readonly string[]): boolean {
  return owner === 'assistant' ? addresses.length > 0 : addresses.some((address) => !principal.has(address));
}

/** What `change_guests` makes of an event's guest list as Google holds it. */
interface GuestChange {
  /** The list to write back, or undefined when it already says what was asked. */
  readonly next: readonly GuestRecord[] | undefined;
  /** Addresses the list gains, and those it loses. */
  readonly added: readonly string[];
  readonly removed: readonly string[];
  /** Who the event invites afterwards: neither the calendar's owner nor a room. */
  readonly invited: readonly string[];
  /** The calendar owner's answer afterwards. */
  readonly answer: Answer;
  /** Addresses to take off that the list does not have. */
  readonly absent: readonly string[];
  /** Addresses to invite that it already has. */
  readonly already: readonly string[];
}

/**
 * The guest list `change_guests` writes on an event of the calendar
 * `calendarId`, the principal's or the assistant's own, worked out afresh
 * from each read of it: everyone kept exactly as Google holds them, those
 * named in `remove` taken off (never the calendar's owner, refused before
 * this), those in `add` appended, and the owner on it. Whatever the owner
 * answered stays theirs; only when they have no answer yet do they count as
 * accepted, as the organizer of an event they made themselves.
 */
function guestChange(
  calendarId: string,
  guests: readonly GuestRecord[],
  add: readonly string[],
  remove: readonly string[],
): GuestChange {
  const isOwner = (address: string | undefined): boolean => isOwnerAddress(calendarId, address);
  const listed = new Set(guests.flatMap((guest) => emailOf(guest) ?? []));
  const adding = add.filter((address) => !isOwner(address) && !listed.has(address));
  const ownerEntry = guests.find((guest) => isOwner(emailOf(guest)));
  const answered = answerOf(ownerEntry);

  const kept = guests
    .filter((guest) => !remove.includes(emailOf(guest) ?? ''))
    .map((guest) =>
      isOwner(emailOf(guest)) && answered === undefined ? { ...guest, responseStatus: 'accepted' } : guest,
    );
  const next: GuestRecord[] = [
    ...(ownerEntry === undefined ? [{ email: calendarId, responseStatus: 'accepted' }] : []),
    ...kept,
    ...adding.map((email) => ({ email })),
  ];
  const unchanged = adding.length === 0 && kept.length === guests.length && answered !== undefined;
  return {
    next: unchanged ? undefined : next,
    added: adding,
    removed: remove.filter((address) => listed.has(address)),
    // A room booked on the event stays on it as it is, but is no one invited.
    invited: next.flatMap((guest) => {
      const email = emailOf(guest);
      return email === undefined || isOwner(email) || guest.resource === true ? [] : [email];
    }),
    answer: answered ?? 'accepted',
    absent: remove.filter((address) => !listed.has(address)),
    already: add.filter((address) => !isOwner(address) && listed.has(address)),
  };
}

/**
 * Whose a calendar in the list is: the assistant's when one of its own
 * addresses names it, which can never be the principal's (R3); the
 * principal's by the rule every principal calendar is told by; or neither.
 */
function ownerOf(
  entry: CalendarEntry,
  principal: PrincipalRecognizer,
  assistant: ReadonlySet<string>,
): CalendarOwner | undefined {
  if (assistant.has(entry.id.toLowerCase())) return 'assistant';
  return isPrincipalCalendar(entry, principal) ? 'principal' : undefined;
}

/**
 * Record a write on a principal calendar as the assistant's own change, so
 * Google's notification of it produces no note. A write on the assistant's
 * own calendar is not recorded: the host turns notifications on only for
 * the principal's, so Google tells the assistant nothing of its own edits
 * there, and a record would swallow a guest's first answer (KTD12).
 */
function recordOwnChange(owner: CalendarOwner, calendarId: string, eventId: string): void {
  if (owner === 'principal') recordOwnCalendarChange(calendarId, eventId);
}

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

export interface PrincipalEventToolsDeps {
  /** The host's own Calendar client. */
  readonly calendar: () => MeetingsCalendarApi;
}

/** A calendar the tools write on, with whose it is and the principal's addresses. */
interface WritableCalendar {
  readonly entry: CalendarEntry;
  readonly owner: CalendarOwner;
  readonly principal: PrincipalRecognizer;
}

export function createPrincipalEventTools(deps: PrincipalEventToolsDeps) {
  const calendar = () => deps.calendar();

  /**
   * The calendar named, for both tools (KTD10): the assistant's own, its
   * primary calendar, named by one of its addresses; or one of the
   * principal's. Refused when it is neither, or when Google lets the
   * assistant see it but not change it.
   */
  async function writableCalendarOf(calendarId: string): Promise<WritableCalendar> {
    const [entry, principal, assistant] = await Promise.all([
      calendar().getCalendar(calendarId),
      loadPrincipalRecognizer(),
      assistantAddresses(),
    ]);
    const owner = entry === undefined ? undefined : ownerOf(entry, principal, assistant);
    if (entry === undefined || owner === undefined) {
      throw forbidden(
        `${calendarId} is not one of the principal's calendars in your list, nor your own: you write only on those.`,
      );
    }
    if (entry.accessRole !== 'writer' && entry.accessRole !== 'owner') {
      throw forbidden('Google lets you see that calendar but not change it.');
    }
    return { entry, owner, principal };
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

    const { entry, owner, principal } = await writableCalendarOf(calendarId);
    // The calendar's owner is its organizer; on the assistant's own, the principal is on it only when named.
    const attendees = guestsOn(entry.id, guests);
    const invited = guests.filter((address) => !isOwnerAddress(entry.id, address));
    const outside = invited.filter((address) => !principal.has(address));
    const tellsGuests = googleTells(owner, principal, invited);
    await assertInvitationShareable(
      {
        texts: [title, notes, location],
        shown: [
          entry.summary,
          ...addressesSeen(
            attendees.map((guest) => guest.email.toLowerCase()),
            outside,
          ),
        ],
        recipients: outside,
        writer: 'main',
      },
      'The event was not added',
      "Write it without that detail, and do not hint at, spell out, or encode it. If it is the calendar's name or a guest's address, ask the principal how they want it done.",
    );
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
        attendees,
        transparency: free ? 'transparent' : 'opaque',
        ...(hidden ? { visibility: 'private' as const } : {}),
        reminders: 'default',
      },
      tellsGuests ? 'all' : 'none',
    );
    if (inserted === 'exists') {
      // A replay: this request made the event before, and its guests heard of it then. It stands
      // as it is now, unless someone has deleted it since, and an event deleted is not put back.
      const made = await calendar().getEvent(entry.id, eventId);
      if (made === undefined || made.status === 'cancelled') {
        throw forbidden(
          'The event this request made earlier has since been deleted from that calendar, so nothing was added.',
        );
      }
    }
    recordOwnChange(owner, entry.id, eventId);
    const conference = videoCall ? await readConference(calendar(), entry.id, eventId) : undefined;
    return {
      calendar: entry.id,
      event: eventId,
      start: String(content.start),
      end: String(content.end),
      message: [
        `Added "${title}" to ${entry.summary ?? entry.id}: ${when}${conferenceWords(conference)}.`,
        OWNER_WORDS[owner].added,
        ...(invited.length === 0
          ? []
          : [
              `Its guests: ${invited.join(', ')}; ${tellsGuests ? 'Google sent them the invitation' : 'Google emailed no one'}.`,
            ]),
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
    const { entry, owner, principal } = await writableCalendarOf(calendarId);
    const words = OWNER_WORDS[owner];
    const organizer = entry.id.toLowerCase();
    if (remove.some((address) => isOwnerAddress(entry.id, address))) throw forbidden(words.stays);

    // The list is written back only over the version of the event it was
    // read from, so a guest's answer, or anyone's change, that lands in
    // between is read again and kept rather than undone.
    for (let attempt = 0; attempt < GUEST_WRITE_ATTEMPTS; attempt += 1) {
      const current = await calendar().getGuests(entry.id, eventId);
      if (current === undefined || current.status === 'cancelled') {
        throw forbidden(`No event ${eventId} on that calendar.`);
      }
      if (current.organizer !== organizer) {
        throw forbidden(
          `${current.organizer ?? 'Someone else'} organizes that event: only they change who it invites. Ask them, through external-email when they are outside.`,
        );
      }

      const { next, added, removed, invited, answer, absent, already } = guestChange(
        entry.id,
        current.guests,
        add,
        remove,
      );
      if (next === undefined) {
        return {
          calendar: entry.id,
          event: eventId,
          guests: invited,
          message: `Nothing changed: ${[
            ...(absent.length === 0 ? [] : [`${are(absent)} not invited`]),
            ...(already.length === 0 ? [] : [`${are(already)} already invited`]),
            words.alreadyOn,
          ].join('; ')}.`,
        };
      }
      if (added.length > 0) {
        // Whoever it invites reads what the event already says, and everyone else on it sees who joins.
        const outside = invited.filter((address) => !principal.has(address));
        await assertInvitationShareable(
          {
            texts: [],
            shown: [
              current.summary,
              current.description,
              current.location,
              entry.summary,
              ...addressesSeen(
                next.flatMap((guest) => emailOf(guest) ?? []),
                outside,
              ),
            ],
            recipients: outside,
            writer: 'main',
          },
          'The guests were not changed',
          "It is in what the event already says, its calendar's name, or an address on its guest list: ask the principal how they want it done.",
        );
      }
      const tellsGuests = googleTells(owner, principal, [...added, ...removed]);
      const sendUpdates = tellsGuests ? 'all' : 'none';
      if ((await calendar().setGuests(entry.id, eventId, next, sendUpdates, current.etag)) === 'set') {
        recordOwnChange(owner, entry.id, eventId);
        return {
          calendar: entry.id,
          event: eventId,
          guests: invited,
          message: `Its guests now: ${words.guestsNow(invited, answer)}. ${tellsGuests ? 'Google sent the guests the update.' : 'Google emailed no one.'}`,
        };
      }
    }
    throw forbidden("The event's guests kept changing while this ran: try again in a moment.");
  };

  return { createEvent, changeGuests };
}
