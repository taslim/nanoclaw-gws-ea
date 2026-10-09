/**
 * main's calendar facts, counted by the host from Google's own answer
 * (R53), so no model copies, drops, or misreads an event:
 *
 *   find_conflicts { start, end, candidate_ical_uid? } → { conflicts, conflicts_not_listed, message }
 *   people_stats   { people? }                         → { since, people, people_not_listed, events, message }
 *
 * - Both read every calendar of the principal's, by the ownership rule
 *   (`isPrincipalCalendar`), whole: every page of each, and a calendar Google
 *   will not list fails the call rather than counting as empty. They fetch
 *   what they count themselves, so nothing an agent saved or says it fetched
 *   decides the answer.
 * - `find_conflicts` lists every meeting that takes the principal's time
 *   over the candidate, by the one rule free time and booking read
 *   (`blocksTime`): cancelled events, free (transparent) ones, and those the
 *   principal declined on that calendar do not count; all-day busy events,
 *   free/busy-only blocks, and the assistant's own bookings do. The
 *   candidate's own copies, by iCalUID, never count. An all-day event runs
 *   midnight to midnight on the principal's clocks, so a day with a clock
 *   change is 23 or 25 hours long. A meeting on several of the principal's
 *   calendars is listed once, with each.
 * - `people_stats` counts, over the last six months, the meetings the
 *   principal organized or accepted with each person: an invitation they
 *   left unanswered, declined, or marked maybe never builds a record. The
 *   principal (every spelling of their addresses), the assistant, rooms, and
 *   meetings of more than eight people are left out, and a meeting on several
 *   calendars counts once.
 *
 * Every time comes with a label ready to write on the principal's clock.
 * Titles and names other people wrote come back capped and wrapped as
 * untrusted text. A group holding Google Calendar calls them (`guard.ts`);
 * nothing here ever reaches external-email.
 */
import { TIMEZONE } from '../../config.js';
import { forbidden, invalidArgs, type ActionAnswer } from '../../cli/delivery-action.js';
import { identityMatchKey } from '../../gws-ea/validation.js';
import { isPrincipalCalendar } from '../gws-ea-inbox/calendar-notifications.js';
import { assistantAddresses } from '../gws-ea-inbox/runtime.js';
import { untrustedLine } from '../gws-ea-inbox/untrusted.js';
import { getGwsEaProfile, listPrincipalAddresses } from '../gws-ea-profile/db.js';
import type { DetailedAttendee, DetailedEvent, EventTime, MeetingsCalendarApi } from './calendar-api.js';
import { dayLabel, spanLabel } from './calendar-actions.js';
import { addressesOf, instantOf, lineOf } from './fields.js';
import {
  blocksTime,
  eventSpan,
  isPrincipalAddress,
  isPrincipalAttendee,
  iso,
  principalAnswer,
  READ_MARGIN_MS,
  strongestAnswer,
  type Span,
  zonedIso,
} from './slots.js';

/** The longest candidate `find_conflicts` checks: one meeting, or a trip. */
const MAX_WINDOW_DAYS = 14;
const MAX_LISTED_CONFLICTS = 50;
/** How far back `people_stats` counts. */
const HISTORY_DAYS = 183;
/** A meeting with more people than this says little about any one of them. */
const MAX_MEETING_SIZE = 8;
const MAX_LISTED_PEOPLE = 100;
const MAX_PEOPLE_ASKED = 100;
const MAX_NAME_CHARS = 64;
const MAX_TITLE_CHARS = 100;
const MAX_ICAL_UID = 1_024;
const DAY = 86_400_000;
const MINUTE = 60_000;
/** Where the text other people wrote came from, as its untrusted wrapping names it. */
const CALENDAR_SOURCE = 'google_calendar';

export interface Conflict {
  /** Every principal calendar the meeting sits on, as it counts there. */
  readonly calendars: readonly string[];
  readonly event_id: string | null;
  readonly ical_uid: string | null;
  /** Wrapped as untrusted; null for a free/busy-only block. */
  readonly title: string | null;
  /** On the principal's clock, with its offset. */
  readonly start: string;
  readonly end: string;
  /** Ready to write, on the principal's clock. */
  readonly when: string;
  readonly all_day: boolean;
  readonly overlap_minutes: number;
  readonly principal_response: string | null;
  readonly organizer: string | null;
}

export interface PersonStats {
  /** NanoClaw's handle for the person, as the people store takes it. */
  readonly identity: string;
  /** Wrapped as untrusted; null when no counted meeting carried one. */
  readonly display_name: string | null;
  readonly meetings: number;
  /** Meetings with the principal and this person alone; the assistant does not count. */
  readonly one_on_ones: number;
  readonly recurring_series: number;
  /** Ready to write, on the principal's clock: "Tuesday 1 Sept". */
  readonly first_meeting: string | null;
  readonly last_meeting: string | null;
}

/** Every event copy read is in exactly one of the other counts. */
export interface PeopleCounts {
  received: number;
  counted: number;
  duplicate_copies: number;
  cancelled: number;
  not_organized_or_accepted: number;
  more_than_eight: number;
  attendees_omitted: number;
}

export interface CalendarFactsDeps {
  /** The host's own Calendar client. */
  readonly calendar: () => MeetingsCalendarApi;
}

/** One copy of an event, on the calendar it was read from. */
interface Copy {
  readonly calendarId: string;
  readonly event: DetailedEvent;
  readonly span: Span;
  /** The same on every copy of one meeting, whichever calendar it sits on. */
  readonly meeting: string;
}

/** Whose calendars, on whose clock, and who the principal is in every spelling. */
interface FactsView {
  readonly timezone: string;
  readonly addresses: ReadonlySet<string>;
  readonly calendars: readonly string[];
}

function timeKey(time: EventTime | undefined): string {
  return time?.date ?? String(time?.dateTime === undefined ? '' : Date.parse(time.dateTime));
}

function overlap(a: Span, b: Span): number {
  return Math.min(a.end, b.end) - Math.max(a.start, b.start);
}

/** An address's key across the spellings that reach one mailbox. */
function mailbox(email: string): string {
  return identityMatchKey(`email:${email}`);
}

function isRoom(attendee: DetailedAttendee): boolean {
  return attendee.resource === true || (attendee.email?.endsWith('@resource.calendar.google.com') ?? false);
}

export function createCalendarFactTools(deps: CalendarFactsDeps) {
  const calendar = () => deps.calendar();

  async function viewOf(): Promise<FactsView> {
    const addresses = new Set((await listPrincipalAddresses()).map((address) => address.email.toLowerCase()));
    const calendars = (await calendar().listCalendars())
      .filter((entry) => isPrincipalCalendar(entry, addresses))
      .map((entry) => entry.id);
    if (calendars.length === 0) {
      throw forbidden(
        "None of the calendars you can see is the principal's yet, so there is nothing to count: find and add their calendars as the gcalendar skill shows.",
      );
    }
    return { timezone: (await getGwsEaProfile()).principal_timezone ?? TIMEZONE, addresses, calendars };
  }

  /**
   * Every copy on the principal's calendars that meets `span`, each with its
   * span on the principal's clocks. A copy Google gives no readable time
   * fails the call: a count that skipped it would be wrong without anyone
   * knowing.
   */
  async function copiesIn(view: FactsView, span: Span): Promise<Copy[]> {
    const listings = await Promise.all(
      view.calendars.map(async (calendarId) => ({
        calendarId,
        events: await calendar().listEventDetails(
          calendarId,
          iso(span.start - READ_MARGIN_MS),
          iso(span.end + READ_MARGIN_MS),
        ),
      })),
    );
    return listings.flatMap(({ calendarId, events }) =>
      events.map((event, index): Copy => {
        const copySpan = eventSpan(event, view.timezone);
        if (copySpan === undefined) {
          throw new Error(`Google returned an event on ${calendarId} without a readable time (${event.id ?? index})`);
        }
        const meeting = `${event.iCalUID ?? event.id ?? `${calendarId}#${index}`}|${timeKey(event.originalStartTime ?? event.start)}`;
        return { calendarId, event, span: copySpan, meeting };
      }),
    );
  }

  function whenOf(copy: Copy, timezone: string): string {
    if (copy.event.start?.date === undefined) return spanLabel(copy.span, timezone);
    const first = dayLabel(copy.span.start, timezone);
    const last = dayLabel(copy.span.end - 1, timezone);
    return `${first === last ? first : `${first} to ${last}`}, all day`;
  }

  /**
   * Every meeting that takes the principal's time over a candidate, by the
   * rule free time and booking read; the candidate's own copies never count.
   */
  const findConflicts: ActionAnswer = async (content) => {
    const start = instantOf(content.start, 'start');
    const end = instantOf(content.end, 'end');
    if (end <= start) throw invalidArgs('end must come after start');
    if (end - start > MAX_WINDOW_DAYS * DAY) {
      throw invalidArgs(`The window is longer than ${MAX_WINDOW_DAYS} days: check one candidate time at a time.`);
    }
    const candidate = lineOf(content.candidate_ical_uid, 'candidate_ical_uid', MAX_ICAL_UID);
    const view = await viewOf();
    const candidateSpan = { start, end };

    const meetings = new Map<string, Copy[]>();
    for (const copy of await copiesIn(view, candidateSpan)) {
      if (candidate !== undefined && copy.event.iCalUID === candidate) continue;
      // Touching ends are not an overlap, and a zero-length event takes no time.
      if (!blocksTime(copy.event, view.addresses) || overlap(copy.span, candidateSpan) <= 0) continue;
      meetings.set(copy.meeting, [...(meetings.get(copy.meeting) ?? []), copy]);
    }
    const conflicts = [...meetings.values()]
      .map((copies): Conflict => {
        const [first] = copies;
        const titled = copies.find((copy) => copy.event.summary !== undefined)?.event.summary;
        const answers = copies.map((copy) => principalAnswer(copy.event, view.addresses));
        return {
          calendars: [...new Set(copies.map((copy) => copy.calendarId))].sort(),
          event_id: first.event.id ?? null,
          ical_uid: first.event.iCalUID ?? null,
          title: titled === undefined ? null : untrustedLine(titled, MAX_TITLE_CHARS, CALENDAR_SOURCE),
          start: zonedIso(first.span.start, view.timezone),
          end: zonedIso(first.span.end, view.timezone),
          when: whenOf(first, view.timezone),
          all_day: first.event.start?.date !== undefined,
          overlap_minutes: Math.round(overlap(first.span, candidateSpan) / MINUTE),
          principal_response: strongestAnswer(answers) ?? null,
          organizer: copies.find((copy) => copy.event.organizer?.email !== undefined)?.event.organizer?.email ?? null,
        };
      })
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || Date.parse(a.end) - Date.parse(b.end));
    const listed = conflicts.slice(0, MAX_LISTED_CONFLICTS);
    const checked = spanLabel(candidateSpan, view.timezone);
    return {
      conflicts: listed,
      conflicts_not_listed: conflicts.length - listed.length,
      message:
        listed.length === 0
          ? `${checked} is free on the principal's calendars.`
          : [`${checked} overlaps:`, ...listed.map((conflict) => `- ${conflict.when}`)].join('\n'),
    };
  };

  /**
   * Who the principal has met over the last six months, counted only from
   * meetings they organized or accepted.
   */
  const peopleStats: ActionAnswer = async (content) => {
    const asked = addressesOf(content.people, 'people', MAX_PEOPLE_ASKED);
    const view = await viewOf();
    const assistant = new Set([...(await assistantAddresses())].map(mailbox));
    const now = Date.now();
    const history = { start: now - HISTORY_DAYS * DAY, end: now };
    const copies = (await copiesIn(view, history)).filter(
      (copy) => copy.span.start >= history.start && copy.span.start < history.end,
    );

    type Outcome = Exclude<keyof PeopleCounts, 'received' | 'duplicate_copies'>;
    const outcomeOf = ({ event }: Copy): Outcome => {
      if (event.status === 'cancelled') return 'cancelled';
      if (event.attendeesOmitted === true) return 'attendees_omitted';
      if ((event.attendees ?? []).filter((attendee) => !isRoom(attendee)).length > MAX_MEETING_SIZE) {
        return 'more_than_eight';
      }
      const organizer = event.organizer;
      const organized = organizer?.self === true || isPrincipalAddress(organizer?.email, view.addresses);
      return organized || principalAnswer(event, view.addresses) === 'accepted'
        ? 'counted'
        : 'not_organized_or_accepted';
    };

    const counts: PeopleCounts = {
      received: copies.length,
      counted: 0,
      duplicate_copies: 0,
      cancelled: 0,
      not_organized_or_accepted: 0,
      more_than_eight: 0,
      attendees_omitted: 0,
    };
    // One meeting per key: the first copy that counts stands for it, else the first copy.
    const meetings = new Map<string, { copy: Copy; outcome: Outcome }>();
    for (const copy of copies) {
      const outcome = outcomeOf(copy);
      const seen = meetings.get(copy.meeting);
      if (seen === undefined) {
        meetings.set(copy.meeting, { copy, outcome });
        continue;
      }
      counts.duplicate_copies++;
      if (seen.outcome !== 'counted' && outcome === 'counted') meetings.set(copy.meeting, { copy, outcome });
    }
    const counted: Copy[] = [];
    for (const { copy, outcome } of meetings.values()) {
      counts[outcome]++;
      if (outcome === 'counted') counted.push(copy);
    }
    counted.sort((a, b) => a.span.start - b.span.start || a.meeting.localeCompare(b.meeting));

    interface Tally {
      meetings: number;
      oneOnOnes: number;
      series: Set<string>;
      first: number;
      last: number;
      name: string | undefined;
    }
    const tallies = new Map<string, Tally>();
    for (const { event, span } of counted) {
      const others = new Map<string, DetailedAttendee>();
      for (const attendee of event.attendees ?? []) {
        const email = attendee.email;
        if (email === undefined || isRoom(attendee) || isPrincipalAttendee(attendee, view.addresses)) continue;
        if (assistant.has(mailbox(email)) || others.has(email)) continue;
        others.set(email, attendee);
      }
      for (const [email, attendee] of others) {
        const tally = tallies.get(email) ?? {
          meetings: 0,
          oneOnOnes: 0,
          series: new Set<string>(),
          first: span.start,
          last: span.start,
          name: undefined,
        };
        tally.meetings++;
        if (others.size === 1) tally.oneOnOnes++;
        if (event.recurringEventId !== undefined) tally.series.add(event.recurringEventId);
        tally.last = span.start;
        // Meetings run earliest first, so the latest name given wins.
        if (attendee.displayName !== undefined) tally.name = attendee.displayName;
        tallies.set(email, tally);
      }
    }

    const people = [...new Set(asked ?? tallies.keys())]
      .map((email): PersonStats => {
        const tally = tallies.get(email);
        return {
          identity: `email:${email}`,
          display_name: tally?.name === undefined ? null : untrustedLine(tally.name, MAX_NAME_CHARS, CALENDAR_SOURCE),
          meetings: tally?.meetings ?? 0,
          one_on_ones: tally?.oneOnOnes ?? 0,
          recurring_series: tally?.series.size ?? 0,
          first_meeting: tally === undefined ? null : dayLabel(tally.first, view.timezone),
          last_meeting: tally === undefined ? null : dayLabel(tally.last, view.timezone),
        };
      })
      .sort((a, b) => b.meetings - a.meetings || a.identity.localeCompare(b.identity));
    const listed = people.slice(0, MAX_LISTED_PEOPLE);
    const since = dayLabel(history.start, view.timezone);
    return {
      since,
      people: listed,
      people_not_listed: people.length - listed.length,
      events: counts,
      message: `Counted ${counts.counted} meetings the principal organized or accepted since ${since}, with ${tallies.size} people.`,
    };
  };

  return { findConflicts, peopleStats };
}
