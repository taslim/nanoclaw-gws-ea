/**
 * Calendar facts counted by the host from Google's own answer, so no model
 * copies, drops, or misreads an event. They read every page of every
 * principal calendar themselves: a calendar Google will not list fails the
 * call rather than counting as empty, and nothing an agent saved or says it
 * fetched decides the answer.
 *
 * Only the message reaches the agent; `find_conflicts`'s other fields also
 * serve host callers. Titles and names other people wrote come back capped
 * and wrapped as untrusted text, and nothing here reaches external-email.
 */
import { forbidden, invalidArgs } from '../../cli/delivery-action.js';
import { EMAIL_PATTERN, identityMatchKey } from '../../gws-ea/validation.js';
import { isPrincipalCalendar } from '../gws-ea-inbox/calendar-notifications.js';
import { assistantAddresses } from '../gws-ea-inbox/runtime.js';
import { untrustedLine } from '../gws-ea-inbox/untrusted.js';
import { loadTimeline, zoneAt, zoneForDay, type Timeline } from '../gws-ea-whereabouts/timeline.js';
import { getGwsEaProfile, principalRecognizer, type PrincipalRecognizer } from '../gws-ea-profile/db.js';
import {
  createMeetingsCalendarApi,
  type DetailedAttendee,
  type DetailedEvent,
  type EventTime,
  type MeetingsCalendarApi,
} from './calendar-api.js';
import { hostGoogleAccessToken } from '../gws-ea-google/index.js';
import { dayLabel, spanLabel } from './calendar-actions.js';
import { addressesOf, instantOf, lineOf } from './fields.js';
import { calendarName, calendarNames, type CalendarName } from './calendar-names.js';
import {
  blocksTime,
  eventSpan,
  isPrincipalAttendee,
  iso,
  principalAnswer,
  READ_MARGIN_MS,
  strongestAnswer,
  type Span,
  zonedIso,
} from './slots.js';

/** One meeting, or a trip. */
const MAX_WINDOW_DAYS = 14;
const MAX_LISTED_CONFLICTS = 50;
const HISTORY_DAYS = 183;
/** A meeting with more people than this says little about any one of them. */
const MAX_MEETING_SIZE = 8;
const MAX_LISTED_PEOPLE = 100;
const MAX_PEOPLE_ASKED = 100;
const MAX_NAME_CHARS = 64;
const MAX_TITLE_CHARS = 100;
const MAX_ICAL_UID = 1_024;
/** So a long list never crowds the agent's context. */
const MAX_MESSAGE_CHARS = 12_000;
/** Room kept for the line saying how many more were not listed. */
const NOT_LISTED_ROOM = 40;
const DAY = 86_400_000;
const MINUTE = 60_000;
const LIST = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });
const ANSWER_WORDS: Readonly<Record<string, string>> = {
  accepted: 'accepted',
  tentative: 'maybe',
  needsAction: 'not answered yet',
  declined: 'declined',
};
const CALENDAR_SOURCE = 'google_calendar';

export interface Conflict {
  /** Each principal calendar whose copy of the meeting takes the principal's time. */
  readonly calendars: readonly string[];
  readonly event_id: string | null;
  readonly ical_uid: string | null;
  /** Wrapped as untrusted; null when no copy shows a title, as for a free/busy-only or hidden block. */
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
  /** Most first; a meeting on several calendars counts on each whose own copy counts. */
  readonly meetings_by_calendar: Readonly<Record<string, number>>;
  /** Meetings with the principal and this person alone; the assistant does not count. */
  readonly one_on_ones: number;
  readonly recurring_series: number;
  /** Ready to write, on the principal's clock: "Tuesday, Sep 1". */
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
  readonly timeline?: Timeline;
  readonly calendar: () => MeetingsCalendarApi;
}

export interface CalendarConflictResult extends Record<string, unknown> {
  conflicts: Conflict[];
  conflicts_not_listed: number;
  message: string;
}

/** The complete read `find_conflicts` makes, for host callers. */
export function findPrincipalCalendarConflicts(
  start: string,
  end: string,
  calendar: MeetingsCalendarApi = createMeetingsCalendarApi({ token: () => hostGoogleAccessToken('calendar-host') }),
): Promise<CalendarConflictResult> {
  return createCalendarFactTools({ calendar: () => calendar }).findConflicts({ start, end });
}

/** One calendar's copy of an event. */
interface Copy {
  readonly calendarId: string;
  readonly event: DetailedEvent;
  readonly span: Span;
  /** The same on every copy of one meeting, whichever calendar it sits on. */
  readonly meeting: string;
}

interface FactsView {
  readonly timeline: Timeline;
  readonly timezone: string;
  readonly addresses: PrincipalRecognizer;
  readonly calendars: readonly string[];
  readonly names: ReadonlyMap<string, CalendarName>;
}

function namedCalendar(id: string, view: FactsView): CalendarName {
  return view.names.get(id) ?? { text: id, external: true };
}

function timeKey(time: EventTime | undefined): string {
  return time?.date ?? String(time?.dateTime === undefined ? '' : Date.parse(time.dateTime));
}

function overlap(a: Span, b: Span): number {
  return Math.min(a.end, b.end) - Math.max(a.start, b.start);
}

/** An address's key across the spellings that reach one mailbox: who is the assistant, never who is the principal. */
function mailbox(email: string): string {
  return identityMatchKey(`email:${email}`);
}

function isRoom(attendee: DetailedAttendee): boolean {
  return attendee.resource === true || (attendee.email?.endsWith('@resource.calendar.google.com') ?? false);
}

function count(n: number, one: string, many = `${one}s`): string {
  return n === 0 ? `no ${many}` : `${n} ${n === 1 ? one : many}`;
}

/** Says how many of `total` were not listed, so the count stays honest whatever the size or a cap left out. */
function listMessage(head: string, entries: readonly string[], total: number): string {
  const lines = [head];
  let size = head.length;
  for (const entry of entries) {
    if (size + 1 + entry.length + NOT_LISTED_ROOM > MAX_MESSAGE_CHARS) break;
    lines.push(entry);
    size += 1 + entry.length;
  }
  const notListed = total - (lines.length - 1);
  if (notListed > 0) lines.push(`${notListed} more not listed.`);
  return lines.join('\n');
}

/**
 * A block with no title, free/busy-only or hidden, says in words that it
 * takes all of its own time: a bare "busy" line next to a titled meeting at
 * the same start reads as that meeting's shadow. It names its calendar, so it
 * reads as a block of its own, but never by an address: two calendars told
 * apart only by their addresses need no telling apart for a busy block.
 */
function conflictLine(conflict: Conflict, view: FactsView): string {
  const overlapping = conflict.overlap_minutes === 0 ? 'under a minute' : count(conflict.overlap_minutes, 'minute');
  const when = conflict.all_day ? conflict.when : `${conflict.when} (overlapping ${overlapping})`;
  const calendars = conflict.calendars.map((id) => namedCalendar(id, view));
  if (conflict.title === null) {
    const named = calendars.filter((name) => !EMAIL_PATTERN.test(name.text)).map(calendarName);
    return [
      `- ${when}`,
      ...(named.length === 0 ? [] : [`on ${LIST.format(named)}`]),
      'busy, with no details shown: the principal is taken for all of it',
    ].join('; ');
  }
  const answer = conflict.principal_response === null ? undefined : ANSWER_WORDS[conflict.principal_response];
  const organizer =
    conflict.organizer === null
      ? undefined
      : `organized by ${view.addresses.has(conflict.organizer) ? 'the principal' : conflict.organizer}`;
  return [
    `- ${when}`,
    `on ${LIST.format(calendars.map(calendarName))}`,
    ...(organizer === undefined ? [] : [organizer]),
    ...(answer === undefined ? [] : [`the principal's answer: ${answer}`]),
    `title:\n${conflict.title}`,
  ].join('; ');
}

function personLine(person: PersonStats, view: FactsView): string {
  const address = person.identity.replace(/^email:/u, '');
  if (person.meetings === 0) return `- ${address}: no meetings`;
  const byCalendar = Object.entries(person.meetings_by_calendar).map(
    ([id, meetings]) => [calendarName(namedCalendar(id, view)), meetings] as const,
  );
  const meetings =
    byCalendar.length === 1
      ? `${count(person.meetings, 'meeting')}, all on ${byCalendar[0][0]}`
      : `${count(person.meetings, 'meeting')}: ${LIST.format(byCalendar.map(([name, n]) => `${n} on ${name}`))}`;
  return [
    `- ${address}: ${meetings}`,
    count(person.one_on_ones, 'one-on-one'),
    count(person.recurring_series, 'recurring series', 'recurring series'),
    `first met ${person.first_meeting}`,
    `last met ${person.last_meeting}`,
    ...(person.display_name === null ? [] : [`their name on invitations:\n${person.display_name}`]),
  ].join('; ');
}

export function createCalendarFactTools(deps: CalendarFactsDeps) {
  const calendar = () => deps.calendar();

  async function viewOf(at = Date.now()): Promise<FactsView> {
    const [profile, listed, timeline] = await Promise.all([
      getGwsEaProfile(),
      calendar().listCalendars(),
      deps.timeline ?? loadTimeline(),
    ]);
    const addresses = principalRecognizer(profile.principal_emails);
    const principal = listed.filter((entry) => isPrincipalCalendar(entry, addresses));
    const calendars = principal.map((entry) => entry.id);
    if (calendars.length === 0) {
      throw forbidden(
        "None of the calendars you can see is the principal's yet, so there is nothing to count: the host adds each of their addresses' calendars to yours once they share it with you.",
      );
    }
    return {
      timeline,
      timezone: zoneAt(timeline, at) ?? 'UTC',
      addresses,
      calendars,
      names: calendarNames(principal, addresses),
    };
  }

  /**
   * A copy Google gives no readable time fails the call: a count that skipped
   * it would be wrong without anyone knowing.
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
        const timedSpan = eventSpan(event, view.timezone);
        if (timedSpan === undefined) {
          throw new Error(`Google returned an event on ${calendarId} without a readable time (${event.id ?? index})`);
        }
        const copySpan =
          event.start?.date === undefined
            ? timedSpan
            : (eventSpan(event, zoneForDay(view.timeline, event.start.date) ?? 'UTC') ?? timedSpan);
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

  const findConflicts = async (content: Record<string, unknown>): Promise<CalendarConflictResult> => {
    const start = instantOf(content.start, 'start');
    const end = instantOf(content.end, 'end');
    if (end <= start) throw invalidArgs('end must come after start');
    if (end - start > MAX_WINDOW_DAYS * DAY) {
      throw invalidArgs(`The window is longer than ${MAX_WINDOW_DAYS} days: check one candidate time at a time.`);
    }
    const candidate = lineOf(content.candidate_ical_uid, 'candidate_ical_uid', MAX_ICAL_UID);
    const view = await viewOf(start);
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
        const zone = zoneAt(view.timeline, first.span.start) ?? 'UTC';
        const titled = copies.find((copy) => copy.event.summary !== undefined)?.event.summary;
        const answers = copies.map((copy) => principalAnswer(copy.event, view.addresses));
        return {
          calendars: [...new Set(copies.map((copy) => copy.calendarId))].sort(),
          event_id: first.event.id ?? null,
          ical_uid: first.event.iCalUID ?? null,
          title: titled === undefined ? null : untrustedLine(titled, MAX_TITLE_CHARS, CALENDAR_SOURCE),
          start: zonedIso(first.span.start, zone),
          end: zonedIso(first.span.end, zoneAt(view.timeline, first.span.end - 1) ?? 'UTC'),
          when:
            whenOf(first, zone) +
            (zoneAt(view.timeline, first.span.start) === null ? ' (local zone unknown; UTC shown)' : ''),
          all_day: first.event.start?.date !== undefined,
          overlap_minutes: Math.round(overlap(first.span, candidateSpan) / MINUTE),
          principal_response: strongestAnswer(answers) ?? null,
          organizer: copies.find((copy) => copy.event.organizer?.email !== undefined)?.event.organizer?.email ?? null,
        };
      })
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || Date.parse(a.end) - Date.parse(b.end));
    const listed = conflicts.slice(0, MAX_LISTED_CONFLICTS);
    const checked =
      spanLabel(candidateSpan, view.timezone) +
      (zoneAt(view.timeline, start) === null ? ' (local zone unknown; UTC shown)' : '');
    return {
      conflicts: listed,
      conflicts_not_listed: conflicts.length - listed.length,
      message:
        conflicts.length === 0
          ? `${checked} is free on the principal's calendars.`
          : listMessage(
              `${checked} is not free. Each block below takes the principal's time, including any their calendar shows with no details:`,
              listed.map((conflict) => conflictLine(conflict, view)),
              conflicts.length,
            ),
    };
  };

  const peopleStats = async (content: Record<string, unknown>) => {
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
      const organized = organizer?.self === true || view.addresses.has(organizer?.email);
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
    // It sits on each calendar whose own copy counts.
    interface Meeting {
      readonly copy: Copy;
      readonly outcome: Outcome;
      readonly calendars: Set<string>;
    }
    const meetings = new Map<string, Meeting>();
    for (const copy of copies) {
      const outcome = outcomeOf(copy);
      const seen = meetings.get(copy.meeting);
      if (seen === undefined) {
        meetings.set(copy.meeting, {
          copy,
          outcome,
          calendars: new Set(outcome === 'counted' ? [copy.calendarId] : []),
        });
        continue;
      }
      counts.duplicate_copies++;
      if (outcome !== 'counted') continue;
      seen.calendars.add(copy.calendarId);
      if (seen.outcome !== 'counted') meetings.set(copy.meeting, { ...seen, copy, outcome });
    }
    const counted: Meeting[] = [];
    for (const meeting of meetings.values()) {
      counts[meeting.outcome]++;
      if (meeting.outcome === 'counted') counted.push(meeting);
    }
    counted.sort((a, b) => a.copy.span.start - b.copy.span.start || a.copy.meeting.localeCompare(b.copy.meeting));

    interface Tally {
      meetings: number;
      byCalendar: Map<string, number>;
      oneOnOnes: number;
      series: Set<string>;
      first: number;
      last: number;
      name: string | undefined;
    }
    const tallies = new Map<string, Tally>();
    for (const {
      copy: { event, span },
      calendars,
    } of counted) {
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
          byCalendar: new Map<string, number>(),
          oneOnOnes: 0,
          series: new Set<string>(),
          first: span.start,
          last: span.start,
          name: undefined,
        };
        tally.meetings++;
        for (const calendarId of calendars)
          tally.byCalendar.set(calendarId, (tally.byCalendar.get(calendarId) ?? 0) + 1);
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
          meetings_by_calendar: Object.fromEntries(
            [...(tally?.byCalendar ?? [])].sort(([a, inA], [b, inB]) => inB - inA || a.localeCompare(b)),
          ),
          one_on_ones: tally?.oneOnOnes ?? 0,
          recurring_series: tally?.series.size ?? 0,
          first_meeting:
            tally === undefined ? null : dayLabel(tally.first, zoneAt(view.timeline, tally.first) ?? 'UTC'),
          last_meeting: tally === undefined ? null : dayLabel(tally.last, zoneAt(view.timeline, tally.last) ?? 'UTC'),
        };
      })
      .sort((a, b) => b.meetings - a.meetings || a.identity.localeCompare(b.identity));
    const listed = people.slice(0, MAX_LISTED_PEOPLE);
    const since = dayLabel(history.start, zoneAt(view.timeline, history.start) ?? 'UTC');
    return {
      since,
      people: listed,
      people_not_listed: people.length - listed.length,
      events: counts,
      message: listMessage(
        `Counted ${counts.counted} meetings the principal organized or accepted since ${since}, with ${tallies.size} people.`,
        listed.map((person) => personLine(person, view)),
        people.length,
      ),
    };
  };

  return { findConflicts, peopleStats };
}
