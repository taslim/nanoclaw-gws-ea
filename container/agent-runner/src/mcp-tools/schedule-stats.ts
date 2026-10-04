/**
 * schedule_stats: candidate scheduling preferences, counted from calendar history.
 *
 * A preference learned from the principal's calendar has to come from
 * counting, not from a model reading a long list of events. This tool does the
 * counting over the JSON that `gog calendar events ... --all-pages` saved for
 * a bounded window, read through calendar-events.ts's shared reader, so every
 * event is one Google returned and none was copied by hand. It returns the
 * usual start and end of the working day for each weekday, the most common
 * meeting lengths, and the usual gaps between meetings, on the principal's
 * clocks.
 *
 * Only meetings with at least one other person are counted, and a meeting on
 * several of the principal's calendars counts once. Every other event lands in
 * exactly one group that is counted and set aside: cancelled events, events
 * the principal declined, all-day events, events outside the window,
 * zero-length events, events that cross midnight, events whose guest list
 * Google left out, and blocks with no other person. A file that is not
 * complete gog output, or holds one invalid event, refuses the whole call and
 * is named, because a preference learned from mangled input would be wrong
 * without anyone knowing.
 */
import { DateTime, type DateTimeMaybeValid } from 'luxon';

import { isValidTimezone } from '../timezone.js';
import {
  FILES_SCHEMA,
  FILE_ROOTS,
  Mailboxes,
  answer,
  fail,
  isPrincipalParty,
  isRoom,
  principalResponse,
  readAddressList,
  readEvents,
  readFiles,
  type CalendarEvent,
} from './calendar-events.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

type ValidDateTime = DateTime<true>;

/**
 * The key that grants schedule_stats. Named here, not left to the barrel's
 * load, so a test that imports this module directly still attributes the
 * tool correctly.
 */
const SCHEDULE_STATS_CAPABILITY = 'schedule-stats';

export const MAX_WINDOW_DAYS = 60;
/** A gap of more than this between two meetings is free time, not a buffer. */
export const BUFFER_GAP_LIMIT_MINUTES = 60;
const MOST_COMMON_LIMIT = 3;
const MINUTE_MS = 60_000;

/** The preference store's weekday keys, Monday first. */
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
type Weekday = (typeof WEEKDAYS)[number];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_SHAPE = 'a date written as YYYY-MM-DD, such as 2026-08-10';

export interface Frequency {
  minutes: number;
  count: number;
}

export interface LengthStats {
  count: number;
  /** Most frequent first; a tie goes to the shorter length. */
  most_common: Frequency[];
}

/** Times are local `HH:MM`; an end of `24:00` is midnight. */
export interface WeekdayHours {
  days_in_window: number;
  days_with_meetings: number;
  usual_start: string | null;
  usual_end: string | null;
  earliest_start: string | null;
  latest_end: string | null;
}

export interface ScheduleStatsResult {
  timezone: string;
  window: { from: string; to: string; days: number };
  /** Every received event copy is in exactly one of the other counts. */
  events: {
    received: number;
    meetings: number;
    /** Further copies of a meeting on several of the principal's calendars. */
    duplicate_copies: number;
    cancelled: number;
    declined: number;
    solo_blocks: number;
    all_day: number;
    zero_length: number;
    crosses_midnight: number;
    attendees_omitted: number;
    outside_window: number;
  };
  working_hours: Record<Weekday, WeekdayHours>;
  meeting_lengths: {
    all: LengthStats;
    /** The principal and one other person. */
    one_on_one: LengthStats;
    /** The principal and two or more others. */
    group: LengthStats;
    /** Null when no principal addresses were given. */
    organized_by_principal: LengthStats | null;
  };
  gaps: {
    count: number;
    back_to_back: number;
    median_minutes: number | null;
    most_common: Frequency[];
    longer_than_an_hour: number;
    overlapping_meetings: number;
  };
  notes: string[];
}

function valid(dt: DateTimeMaybeValid): ValidDateTime {
  if (!dt.isValid) fail('A date is out of range.');
  return dt;
}

interface Meeting {
  /** The local date the meeting starts on, YYYY-MM-DD. */
  date: string;
  weekday: Weekday;
  startMs: number;
  endMs: number;
  /** Minutes after local midnight. */
  startMinute: number;
  /** Minutes after local midnight; 1440 when the meeting ends at midnight. */
  endMinute: number;
  lengthMinutes: number;
  /** The people in it: the principal, and everyone else invited but rooms. */
  attendeeCount: number;
  organizedByPrincipal: boolean;
}

type SetAside = Exclude<keyof ScheduleStatsResult['events'], 'received' | 'meetings' | 'duplicate_copies'>;

interface StatsInput {
  zone: string;
  from: ValidDateTime;
  to: ValidDateTime;
  days: number;
  /** On the principal's clocks. */
  events: readonly CalendarEvent[];
  principal: Mailboxes;
  /** Whether principal addresses were given, so the meetings they organized are reported apart. */
  principalNamed: boolean;
}

function perWeekday<T>(make: (weekday: Weekday) => T): Record<Weekday, T> {
  return {
    mon: make('mon'),
    tue: make('tue'),
    wed: make('wed'),
    thu: make('thu'),
    fri: make('fri'),
    sat: make('sat'),
    sun: make('sun'),
  };
}

function weekdayOf(dt: ValidDateTime): Weekday {
  return WEEKDAYS[dt.weekday - 1];
}

function isoDate(dt: ValidDateTime): string {
  return dt.toISODate();
}

function minuteOfDay(dt: ValidDateTime): number {
  return dt.hour * 60 + dt.minute;
}

function clock(minutes: number): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

function isUsableTimezone(zone: string): boolean {
  return isValidTimezone(zone) && DateTime.fromMillis(0, { zone }).isValid;
}

function readTimezone(args: Record<string, unknown>): string {
  const value = args.timezone;
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    fail('timezone is required.');
  }
  if (typeof value !== 'string' || !isUsableTimezone(value)) {
    fail(`Invalid timezone "${String(value)}". Use an IANA name like "Africa/Lagos".`);
  }
  return value;
}

function readDate(args: Record<string, unknown>, key: 'from' | 'to'): ValidDateTime {
  const value = args[key];
  if (value === undefined || value === null || value === '') fail(`${key} is required.`);
  if (typeof value !== 'string' || !ISO_DATE.test(value.trim())) fail(`${key} must be ${DATE_SHAPE}.`);
  const date = DateTime.fromISO(value.trim(), { zone: 'utc' });
  if (!date.isValid) fail(`${key} must be ${DATE_SHAPE}.`);
  return date;
}

function readInput(args: Record<string, unknown>): StatsInput {
  const zone = readTimezone(args);
  const from = readDate(args, 'from');
  const to = readDate(args, 'to');
  if (to.toMillis() < from.toMillis()) fail('"to" must be on or after "from".');
  const days = Math.round(to.diff(from, 'days').days) + 1;
  if (days > MAX_WINDOW_DAYS) {
    fail(
      `The window covers ${days} days; the limit is ${MAX_WINDOW_DAYS} days (about eight weeks). Use a shorter window.`,
    );
  }
  const principalAddresses = readAddressList(args, 'principal_addresses', false);
  const files = readFiles(args);
  return {
    zone,
    from,
    to,
    days,
    events: readEvents(files, FILE_ROOTS, zone),
    principal: new Mailboxes(principalAddresses),
    principalNamed: principalAddresses.length > 0,
  };
}

/**
 * Where the meeting ends, in minutes after midnight of the day it starts: 1440
 * when it ends exactly at the next midnight, and null when it runs past it.
 */
function endMinuteOnStartDay(start: ValidDateTime, end: ValidDateTime): number | null {
  if (isoDate(end) === isoDate(start)) return minuteOfDay(end);
  const nextDate = isoDate(valid(DateTime.fromISO(isoDate(start), { zone: 'utc' }).plus({ days: 1 })));
  const atMidnight = end.hour === 0 && end.minute === 0 && end.second === 0 && end.millisecond === 0;
  return isoDate(end) === nextDate && atMidnight ? 24 * 60 : null;
}

function classify(event: CalendarEvent, input: StatsInput): Meeting | SetAside {
  if (event.status === 'cancelled') return 'cancelled';
  if (principalResponse(event, input.principal) === 'declined') return 'declined';
  if (event.allDay) return 'all_day';
  const { start, end } = event;
  const date = isoDate(start);
  if (date < isoDate(input.from) || date > isoDate(input.to)) return 'outside_window';
  if (end.toMillis() === start.toMillis()) return 'zero_length';
  const endMinute = endMinuteOnStartDay(start, end);
  if (endMinute === null) return 'crosses_midnight';
  // Its size is unknown, so it is neither a block nor a meeting of any size.
  if (event.attendeesOmitted) return 'attendees_omitted';
  // Its people: the principal once, however many of their addresses are invited, and everyone else but rooms.
  const others = new Set(
    event.attendees
      .filter((party) => !isRoom(party) && !isPrincipalParty(party, input.principal))
      .map((party) => party.email),
  );
  const attendeeCount = others.size + 1;
  if (attendeeCount < 2) return 'solo_blocks';
  return {
    date,
    weekday: weekdayOf(start),
    startMs: start.toMillis(),
    endMs: end.toMillis(),
    startMinute: minuteOfDay(start),
    endMinute,
    lengthMinutes: Math.round((end.toMillis() - start.toMillis()) / MINUTE_MS),
    attendeeCount,
    organizedByPrincipal:
      event.organizer !== null && (event.organizer.self || input.principal.has(event.organizer.email)),
  };
}

function ascending(values: readonly number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

/** The middle value; the lower of the two middle values when the count is even. */
function lowerMiddle(sorted: readonly number[]): number {
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

/** The middle value; the upper of the two middle values when the count is even. */
function upperMiddle(sorted: readonly number[]): number {
  return sorted[Math.floor(sorted.length / 2)];
}

function mostCommon(values: readonly number[]): Frequency[] {
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts]
    .map(([minutes, count]) => ({ minutes, count }))
    .sort((a, b) => b.count - a.count || a.minutes - b.minutes)
    .slice(0, MOST_COMMON_LIMIT);
}

function lengthStats(meetings: readonly Meeting[]): LengthStats {
  return { count: meetings.length, most_common: mostCommon(meetings.map((meeting) => meeting.lengthMinutes)) };
}

/**
 * The gaps between meetings on each day. Meetings that overlap are merged into
 * one busy stretch first, so a gap is never negative; each merged meeting is
 * counted as overlapping.
 */
function gapStats(days: Iterable<readonly Meeting[]>): ScheduleStatsResult['gaps'] {
  const gaps: number[] = [];
  let longer = 0;
  let overlapping = 0;
  for (const day of days) {
    const sorted = [...day].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
    let busyUntil = sorted[0].endMs;
    let stretch = 1;
    for (const meeting of sorted.slice(1)) {
      if (meeting.startMs < busyUntil) {
        stretch++;
        busyUntil = Math.max(busyUntil, meeting.endMs);
        continue;
      }
      if (stretch > 1) overlapping += stretch;
      const gap = Math.round((meeting.startMs - busyUntil) / MINUTE_MS);
      if (gap > BUFFER_GAP_LIMIT_MINUTES) longer++;
      else gaps.push(gap);
      busyUntil = meeting.endMs;
      stretch = 1;
    }
    if (stretch > 1) overlapping += stretch;
  }
  const sorted = ascending(gaps);
  return {
    count: gaps.length,
    back_to_back: gaps.filter((gap) => gap === 0).length,
    median_minutes: sorted.length === 0 ? null : lowerMiddle(sorted),
    most_common: mostCommon(gaps),
    longer_than_an_hour: longer,
    overlapping_meetings: overlapping,
  };
}

export function computeScheduleStats(input: StatsInput): ScheduleStatsResult {
  const counts: ScheduleStatsResult['events'] = {
    received: input.events.length,
    meetings: 0,
    duplicate_copies: 0,
    cancelled: 0,
    declined: 0,
    solo_blocks: 0,
    all_day: 0,
    zero_length: 0,
    crosses_midnight: 0,
    attendees_omitted: 0,
    outside_window: 0,
  };
  // One meeting per key: the first copy that is a meeting stands for it, else the first copy.
  const kept = new Map<string, Meeting | SetAside>();
  for (const event of input.events) {
    const classified = classify(event, input);
    const seen = kept.get(event.meetingKey);
    if (seen === undefined) {
      kept.set(event.meetingKey, classified);
      continue;
    }
    counts.duplicate_copies++;
    if (typeof seen === 'string' && typeof classified !== 'string') kept.set(event.meetingKey, classified);
  }
  const meetings: Meeting[] = [];
  for (const classified of kept.values()) {
    if (typeof classified === 'string') {
      counts[classified]++;
    } else {
      counts.meetings++;
      meetings.push(classified);
    }
  }

  const byDate = new Map<string, Meeting[]>();
  for (const meeting of meetings) {
    const day = byDate.get(meeting.date);
    if (day) day.push(meeting);
    else byDate.set(meeting.date, [meeting]);
  }

  const daysInWindow = perWeekday(() => 0);
  for (let offset = 0; offset < input.days; offset++) {
    daysInWindow[weekdayOf(valid(input.from.plus({ days: offset })))]++;
  }
  const firstStarts = perWeekday((): number[] => []);
  const lastEnds = perWeekday((): number[] => []);
  for (const day of byDate.values()) {
    const { weekday } = day[0];
    firstStarts[weekday].push(Math.min(...day.map((meeting) => meeting.startMinute)));
    lastEnds[weekday].push(Math.max(...day.map((meeting) => meeting.endMinute)));
  }

  return {
    timezone: input.zone,
    window: { from: isoDate(input.from), to: isoDate(input.to), days: input.days },
    events: counts,
    working_hours: perWeekday((weekday): WeekdayHours => {
      const starts = ascending(firstStarts[weekday]);
      const ends = ascending(lastEnds[weekday]);
      if (starts.length === 0) {
        return {
          days_in_window: daysInWindow[weekday],
          days_with_meetings: 0,
          usual_start: null,
          usual_end: null,
          earliest_start: null,
          latest_end: null,
        };
      }
      // The earlier middle start and the later middle end: a working day that
      // leaves out a typical day would be too narrow.
      return {
        days_in_window: daysInWindow[weekday],
        days_with_meetings: starts.length,
        usual_start: clock(lowerMiddle(starts)),
        usual_end: clock(upperMiddle(ends)),
        earliest_start: clock(starts[0]),
        latest_end: clock(ends[ends.length - 1]),
      };
    }),
    meeting_lengths: {
      all: lengthStats(meetings),
      one_on_one: lengthStats(meetings.filter((meeting) => meeting.attendeeCount === 2)),
      group: lengthStats(meetings.filter((meeting) => meeting.attendeeCount >= 3)),
      organized_by_principal: input.principalNamed
        ? lengthStats(meetings.filter((meeting) => meeting.organizedByPrincipal))
        : null,
    },
    gaps: gapStats(byDate.values()),
    notes:
      meetings.length === 0
        ? ['No meetings with other people in this window, so there is nothing to learn from it.']
        : [],
  };
}

export const scheduleStats: McpToolDefinition = {
  tool: {
    name: 'schedule_stats',
    description: `Count the principal's calendar history into candidate scheduling preferences: the usual start and end of the working day for each weekday, the most common meeting lengths, and the usual gaps between meetings. Reads saved gog calendar events output for a window of at most ${MAX_WINDOW_DAYS} days (about eight weeks); times are read on the principal's clocks in \`timezone\`. Only meetings with at least one other person are counted, and a meeting on several of the principal's calendars counts once. Cancelled events, events the principal declined, all-day events, blocks with no other person (rooms are not people), zero-length events, events that cross midnight, events whose guest list Google left out, and events outside the window are counted and set aside. Overlapping meetings are merged before gaps are measured, and a gap of more than ${BUFFER_GAP_LIMIT_MINUTES} minutes is free time, not a gap between meetings. A usual start is the middle of each day's first start (the earlier middle when the days split evenly); a usual end is the middle of each day's last end (the later middle). A file that is malformed, incomplete, or outside the workspace and temp directory, or that holds one invalid event, refuses the whole call and is named.`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        files: FILES_SCHEMA,
        timezone: { type: 'string', description: 'The principal\'s IANA timezone, such as "Africa/Lagos".' },
        from: { type: 'string', description: 'First day of the window, YYYY-MM-DD.' },
        to: {
          type: 'string',
          description: `Last day of the window, YYYY-MM-DD, included. The window is at most ${MAX_WINDOW_DAYS} days.`,
        },
        principal_addresses: {
          type: 'array',
          items: { type: 'string' },
          description:
            "The principal's email addresses. When given, lengths of the meetings the principal organized are reported separately, and the principal counts as one person in a meeting however many of these addresses it invites.",
        },
      },
      required: ['files', 'timezone', 'from', 'to'],
    },
  },
  async handler(args) {
    return answer(() => computeScheduleStats(readInput(args)));
  },
};

registerTools([scheduleStats], SCHEDULE_STATS_CAPABILITY);
