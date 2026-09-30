/**
 * schedule_stats: candidate scheduling preferences, counted from calendar history.
 *
 * A preference learned from the principal's calendar has to come from
 * counting, not from a model reading a long list of events. This tool does the
 * counting. Given a bounded window of events and the principal's timezone, it
 * returns the usual start and end of the working day for each weekday, the
 * most common meeting lengths, and the usual gaps between meetings.
 *
 * Only meetings with at least one other attendee are counted. Every other
 * event lands in exactly one group that is counted and set aside: all-day
 * events, events outside the window, zero-length events, events that cross
 * midnight, and blocks with no other attendee. A timed event must carry its
 * UTC offset, so no local time is guessed at a clock change. A single invalid
 * event refuses the whole call and is named, because a preference learned from
 * mangled input would be wrong without anyone knowing.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { DateTime, type DateTimeMaybeValid } from 'luxon';

import { isValidTimezone } from '../timezone.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

type ValidDateTime = DateTime<true>;

export const MAX_WINDOW_DAYS = 60;
export const MAX_EVENTS = 2000;
/** A gap of more than this between two meetings is free time, not a buffer. */
export const BUFFER_GAP_LIMIT_MINUTES = 60;
const MOST_COMMON_LIMIT = 3;
const MAX_LISTED_PROBLEMS = 5;
const MINUTE_MS = 60_000;

/** The preference store's weekday keys, Monday first. */
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
type Weekday = (typeof WEEKDAYS)[number];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/i;
const TIMESTAMP_SHAPE =
  'a date-time with its UTC offset, such as 2026-10-05T09:00:00+01:00, or a date (2026-10-05) for an all-day event';
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
  /** Every received event is in exactly one of the other counts. */
  events: {
    received: number;
    meetings: number;
    solo_blocks: number;
    all_day: number;
    zero_length: number;
    crosses_midnight: number;
    outside_window: number;
  };
  working_hours: Record<Weekday, WeekdayHours>;
  meeting_lengths: {
    all: LengthStats;
    /** Exactly two attendees. */
    one_on_one: LengthStats;
    /** Three or more attendees. */
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

/** A problem with the tool input, returned to the agent as an error result. */
class StatsInputError extends Error {}

function fail(message: string): never {
  throw new StatsInputError(message);
}

function valid(dt: DateTimeMaybeValid): ValidDateTime {
  if (!dt.isValid) fail('A date is out of range.');
  return dt;
}

type ParsedEvent =
  | { kind: 'all_day' }
  | { kind: 'timed'; start: ValidDateTime; end: ValidDateTime; attendeeCount: number; organizer: string | null };

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
  attendeeCount: number;
  organizer: string | null;
}

type SetAside = 'all_day' | 'outside_window' | 'zero_length' | 'crosses_midnight' | 'solo_blocks';

interface StatsInput {
  zone: string;
  from: ValidDateTime;
  to: ValidDateTime;
  days: number;
  events: ParsedEvent[];
  principalAddresses: ReadonlySet<string> | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
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

function readAddresses(args: Record<string, unknown>): ReadonlySet<string> | null {
  const value: unknown = args.principal_addresses;
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) fail('principal_addresses must be a list of email addresses.');
  const items: unknown[] = value;
  if (!items.every((item): item is string => typeof item === 'string')) {
    fail('principal_addresses must be a list of email addresses.');
  }
  const addresses = items.map(normalizeAddress).filter((address) => address !== '');
  return addresses.length === 0 ? null : new Set(addresses);
}

type Timestamp = { kind: 'date' | 'date_time'; at: ValidDateTime };

function readTimestamp(value: unknown): Timestamp | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (ISO_DATE.test(text)) {
    const at = DateTime.fromISO(text, { zone: 'utc' });
    return at.isValid ? { kind: 'date', at } : null;
  }
  if (DATE_TIME_WITH_OFFSET.test(text)) {
    const at = DateTime.fromISO(text.toUpperCase(), { setZone: true });
    return at.isValid ? { kind: 'date_time', at } : null;
  }
  return null;
}

/** An event, or the sentence saying what is wrong with it. */
function parseEvent(value: unknown, index: number): ParsedEvent | string {
  const label = `events[${index}]`;
  if (!isRecord(value)) return `${label} must be an object with start, end, and attendee_count.`;
  const start = readTimestamp(value.start);
  if (start === null) return `${label}.start must be ${TIMESTAMP_SHAPE}.`;
  const end = readTimestamp(value.end);
  if (end === null) return `${label}.end must be ${TIMESTAMP_SHAPE}.`;
  const attendeeCount = value.attendee_count;
  if (typeof attendeeCount !== 'number' || !Number.isInteger(attendeeCount) || attendeeCount < 0) {
    return `${label}.attendee_count must be a whole number, 0 or more.`;
  }
  const organizer = value.organizer;
  if (organizer !== undefined && organizer !== null && typeof organizer !== 'string') {
    return `${label}.organizer must be an email address.`;
  }
  if (start.kind !== end.kind) return `${label} mixes a date and a date-time; an all-day event gives both as dates.`;
  if (end.at.toMillis() < start.at.toMillis()) return `${label} ends before it starts.`;
  if (start.kind === 'date') return { kind: 'all_day' };
  return {
    kind: 'timed',
    start: start.at,
    end: end.at,
    attendeeCount,
    organizer: typeof organizer === 'string' ? normalizeAddress(organizer) : null,
  };
}

function readEvents(args: Record<string, unknown>): ParsedEvent[] {
  const value: unknown = args.events;
  if (!Array.isArray(value)) fail('events must be a list of events.');
  const items: unknown[] = value;
  if (items.length > MAX_EVENTS) {
    fail(`Too many events: ${items.length}. The limit is ${MAX_EVENTS}; use a shorter window.`);
  }
  const events: ParsedEvent[] = [];
  const problems: string[] = [];
  items.forEach((item, index) => {
    const parsed = parseEvent(item, index);
    if (typeof parsed === 'string') problems.push(parsed);
    else events.push(parsed);
  });
  if (problems.length > 0) {
    const listed = problems.slice(0, MAX_LISTED_PROBLEMS);
    const unlisted = problems.length - listed.length;
    fail(
      [
        `Invalid events: ${problems.length} of ${items.length}, so nothing was counted.`,
        ...listed,
        ...(unlisted > 0 ? [`${unlisted} more invalid event${unlisted === 1 ? ' is' : 's are'} not listed.`] : []),
      ].join(' '),
    );
  }
  return events;
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
  const principalAddresses = readAddresses(args);
  return { zone, from, to, days, events: readEvents(args), principalAddresses };
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

function classify(event: ParsedEvent, input: StatsInput): Meeting | SetAside {
  if (event.kind === 'all_day') return 'all_day';
  const start = valid(event.start.setZone(input.zone));
  const end = valid(event.end.setZone(input.zone));
  const date = isoDate(start);
  if (date < isoDate(input.from) || date > isoDate(input.to)) return 'outside_window';
  if (end.toMillis() === start.toMillis()) return 'zero_length';
  const endMinute = endMinuteOnStartDay(start, end);
  if (endMinute === null) return 'crosses_midnight';
  if (event.attendeeCount < 2) return 'solo_blocks';
  return {
    date,
    weekday: weekdayOf(start),
    startMs: start.toMillis(),
    endMs: end.toMillis(),
    startMinute: minuteOfDay(start),
    endMinute,
    lengthMinutes: Math.round((end.toMillis() - start.toMillis()) / MINUTE_MS),
    attendeeCount: event.attendeeCount,
    organizer: event.organizer,
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
  const counts = {
    received: input.events.length,
    meetings: 0,
    solo_blocks: 0,
    all_day: 0,
    zero_length: 0,
    crosses_midnight: 0,
    outside_window: 0,
  };
  const meetings: Meeting[] = [];
  for (const event of input.events) {
    const classified = classify(event, input);
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

  const addresses = input.principalAddresses;
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
      organized_by_principal:
        addresses === null
          ? null
          : lengthStats(meetings.filter((meeting) => meeting.organizer !== null && addresses.has(meeting.organizer))),
    },
    gaps: gapStats(byDate.values()),
    notes:
      meetings.length === 0
        ? ['No meetings with other people in this window, so there is nothing to learn from it.']
        : [],
  };
}

function json(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

export const scheduleStats: McpToolDefinition = {
  tool: {
    name: 'schedule_stats',
    description: `Count the principal's calendar history into candidate scheduling preferences: the usual start and end of the working day for each weekday, the most common meeting lengths, and the usual gaps between meetings. Give every event from a window of at most ${MAX_WINDOW_DAYS} days (about eight weeks), leaving out cancelled events and ones the principal declined; times are read on the principal's clocks in \`timezone\`. Only meetings with at least one other attendee are counted. All-day events, blocks with no other attendee, zero-length events, events that cross midnight, and events outside the window are counted and set aside. Overlapping meetings are merged before gaps are measured, and a gap of more than ${BUFFER_GAP_LIMIT_MINUTES} minutes is free time, not a gap between meetings. A usual start is the middle of each day's first start (the earlier middle when the days split evenly); a usual end is the middle of each day's last end (the later middle). One invalid event refuses the whole call and is named.`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        timezone: { type: 'string', description: 'The principal\'s IANA timezone, such as "Africa/Lagos".' },
        from: { type: 'string', description: 'First day of the window, YYYY-MM-DD.' },
        to: {
          type: 'string',
          description: `Last day of the window, YYYY-MM-DD, included. The window is at most ${MAX_WINDOW_DAYS} days.`,
        },
        events: {
          type: 'array',
          maxItems: MAX_EVENTS,
          description: 'Every event in the window, each once.',
          items: {
            type: 'object',
            properties: {
              start: { type: 'string', description: `Start: ${TIMESTAMP_SHAPE}.` },
              end: { type: 'string', description: `End: ${TIMESTAMP_SHAPE}. All-day events end on the day after.` },
              attendee_count: {
                type: 'integer',
                minimum: 0,
                description:
                  'Everyone invited, including the principal and the organizer; 0 when the event has no guests.',
              },
              organizer: { type: 'string', description: "The organizer's email address." },
            },
            required: ['start', 'end', 'attendee_count'],
          },
        },
        principal_addresses: {
          type: 'array',
          items: { type: 'string' },
          description:
            "The principal's email addresses. When given, lengths of the meetings the principal organized are reported separately.",
        },
      },
      required: ['timezone', 'from', 'to', 'events'],
    },
  },
  async handler(args) {
    try {
      return json(computeScheduleStats(readInput(args)));
    } catch (error) {
      if (error instanceof StatsInputError) {
        return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
      }
      throw error;
    }
  },
};

registerTools([scheduleStats]);
