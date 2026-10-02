/**
 * Time MCP tools: time_now, time_resolve, time_convert, time_diff, time_range.
 *
 * Models get dates, weekdays, and offsets wrong when they work them out
 * themselves; these tools make that work deterministic. The interface is
 * Soji's — the same five tools, the same inputs, and the same
 * `{ iso, formatted, day, zone }` shape — and everything is computed in the
 * container's timezone, which is the principal's, unless time_convert names
 * others.
 *
 * A local wall-clock time becomes an instant explicitly. One that does not
 * exist (the clocks go forward over it) is an error, and one that happens twice
 * (the clocks go back over it) comes back as both candidates; nothing guesses.
 * That is why nothing here uses `parseZonedToUtc`, which can be an hour off
 * near a change.
 *
 * Natural language goes through chrono-node against an explicit reference
 * time. chrono works with JavaScript's local-time Date methods, so it is given
 * the reference as the zone's wall-clock fields and its answer is read back as
 * fields, never as a Date: the process timezone does not decide the result.
 * time_resolve reports what it read, what it assumed, and the other readings
 * the words could have had.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as chrono from 'chrono-node';
import { DateTime, type DateTimeMaybeValid, type Duration } from 'luxon';

import { TIMEZONE, isValidTimezone } from '../timezone.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

type ValidDateTime = DateTime<true>;

const MAX_RANGE_DAYS = 60;
const MAX_SLOTS = 1000;
const DEFAULT_INTERVAL_MINUTES = 60;
const MINUTES_PER_DAY = 24 * 60;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?<offset>Z|[+-]\d{2}(?::?\d{2})?)?$/i;

/** chrono's tag for "in 3 hours"-style results: elapsed time from the reference. */
const RELATIVE_TIME_TAG = 'result/relativeDateAndTime';
/** chrono's tag for "now", which it stamps with the process timezone's offset as if the text had named one. */
const NOW_TAG = 'casualReference/now';
/** Words that point back in time; chrono's forward-date option would otherwise move "last Friday" ahead. */
const LOOKS_BACK = /\b(?:last|past|previous|prior|ago|yesterday|earlier|before)\b/i;
const NEXT_WEEKDAY = /\bnext\s+(?:mon|tue|wed|thu|fri|sat|sun)/i;
/** "03:00" is a 24-hour time: an hour written with a leading zero is not missing its AM or PM. */
const ZERO_PADDED_HOUR = /(?:^|\D)0\d:\d{2}/;

const DATE_FORMAT = 'EEE, MMM d yyyy';
const TIME_FORMAT = 'h:mm a';

/** A problem with the tool input, returned to the agent as an error result. */
class TimeInputError extends Error {}

function fail(message: string): never {
  throw new TimeInputError(message);
}

export interface FormattedDt {
  iso: string;
  formatted: string;
  day: string;
  zone: string;
}

export interface TimeNowResult extends FormattedDt {
  unix: number;
}

/** A local time that happens twice has no `resolved`; `candidates` holds both instants, earlier first. */
export interface TimeResolveResult {
  expression: string;
  reference: FormattedDt;
  resolved?: FormattedDt;
  candidates?: FormattedDt[];
  end?: FormattedDt;
  end_candidates?: FormattedDt[];
  time_stated: boolean;
  interpretation: { read: string; notes: string[] };
}

export interface TimeConversion {
  source: FormattedDt;
  conversions: Record<string, FormattedDt>;
}

/** An exact input carries one conversion inline; a local time that happens twice carries both as `candidates`. */
export interface TimeConvertResult extends Partial<TimeConversion> {
  input: string;
  ambiguous?: true;
  candidates?: TimeConversion[];
  notes?: string[];
}

export interface TimeDiffResult {
  from: FormattedDt;
  to: FormattedDt;
  direction: 'past' | 'future';
  calendar_days: number;
  business_days: number;
  human: string;
  breakdown: { years: number; months: number; weeks: number; days: number; hours: number; minutes: number };
  notes?: string[];
}

export interface TimeSlot {
  date: string;
  day: string;
  time?: string;
  iso: string;
  second_occurrence_iso?: string;
}

export interface TimeRangeResult {
  from: FormattedDt;
  to: FormattedDt;
  days: number;
  weekdays_only: boolean;
  time_window: string | null;
  interval_minutes: number | null;
  count: number;
  slots: TimeSlot[];
  skipped?: string[];
  notes?: string[];
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

/** An instant, or both instants when the local time it was read from happens twice. */
type Moment =
  | { kind: 'exact'; at: ValidDateTime }
  | { kind: 'ambiguous'; earlier: ValidDateTime; later: ValidDateTime };

interface Reading {
  moment: Moment;
  /** The local wall clock that was read, in the zone it was read in. */
  wall: WallClock;
  /** False when a day was given without a time of day. */
  timeStated: boolean;
  /** The part of the input that was read as the date. */
  read: string;
  notes: string[];
  end?: Moment;
}

function valid(dt: DateTimeMaybeValid): ValidDateTime {
  if (!dt.isValid) fail('That date is out of range.');
  return dt;
}

function isoOf(dt: ValidDateTime): string {
  return dt.toISO({ suppressMilliseconds: true });
}

function formatDt(dt: ValidDateTime): FormattedDt {
  const local = dt.setLocale('en-US');
  return {
    iso: isoOf(dt),
    formatted: local.toFormat(`${DATE_FORMAT} ${TIME_FORMAT} ZZZZ`),
    day: local.toFormat('EEEE'),
    zone: dt.zoneName,
  };
}

function wallClockOf(dt: ValidDateTime): WallClock {
  const { year, month, day, hour, minute, second, millisecond } = dt;
  return { year, month, day, hour, minute, second, millisecond };
}

function dateOnly(wall: WallClock): WallClock {
  return { ...wall, hour: 0, minute: 0, second: 0, millisecond: 0 };
}

/** The wall clock as if it were UTC, where arithmetic is plain field arithmetic with no clock changes. */
function floating(wall: WallClock): ValidDateTime {
  const dt = DateTime.fromObject(wall, { zone: 'utc' });
  if (!dt.isValid) {
    const pad = (value: number) => String(value).padStart(2, '0');
    fail(`${String(wall.year).padStart(4, '0')}-${pad(wall.month)}-${pad(wall.day)} is not a valid date.`);
  }
  return dt;
}

/** A calendar day as a whole number, for counting days between local dates. */
function dayNumber(wall: WallClock): number {
  return Math.round(floating(dateOnly(wall)).toMillis() / DAY_MS);
}

function describeDate(wall: WallClock): string {
  return floating(wall).setLocale('en-US').toFormat(DATE_FORMAT);
}

function describeTime(wall: WallClock): string {
  return floating(wall).setLocale('en-US').toFormat(TIME_FORMAT);
}

/** "Tue, Oct 13 2026 3:00 PM", or just the date when no time was stated. */
function describe(wall: WallClock, withTime: boolean): string {
  return withTime ? `${describeDate(wall)} ${describeTime(wall)}` : describeDate(wall);
}

/** "2:30 AM on Sun, Mar 8 2026". */
function describeLocalTime(wall: WallClock): string {
  return `${describeTime(wall)} on ${describeDate(wall)}`;
}

function utcOffsetLabel(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function offsetMinutesAt(zone: string, ms: number): number {
  return valid(DateTime.fromMillis(ms, { zone })).offset;
}

function showsWallClock(dt: ValidDateTime, wall: WallClock): boolean {
  return (
    dt.year === wall.year &&
    dt.month === wall.month &&
    dt.day === wall.day &&
    dt.hour === wall.hour &&
    dt.minute === wall.minute &&
    dt.second === wall.second &&
    dt.millisecond === wall.millisecond
  );
}

/**
 * Every instant at which the zone's clocks show `wall`, earliest first: none
 * when the clocks go forward over it, two when they go back over it. The
 * candidate offsets are the zone's offsets a day either side, which bracket
 * any single clock change.
 */
function instantsAt(wall: WallClock, zone: string): ValidDateTime[] {
  const localMs = floating(wall).toMillis();
  const instants = new Map<number, ValidDateTime>();
  for (const probe of [localMs - DAY_MS, localMs, localMs + DAY_MS]) {
    const ms = localMs - offsetMinutesAt(zone, probe) * MINUTE_MS;
    const dt = valid(DateTime.fromMillis(ms, { zone }));
    if (showsWallClock(dt, wall)) instants.set(ms, dt);
  }
  return [...instants.values()].sort((a, b) => a.toMillis() - b.toMillis());
}

function nonexistentMessage(wall: WallClock, zone: string): string {
  const localMs = floating(wall).toMillis();
  const before = utcOffsetLabel(offsetMinutesAt(zone, localMs - DAY_MS));
  const after = utcOffsetLabel(offsetMinutesAt(zone, localMs + DAY_MS));
  return `${describeLocalTime(wall)} does not exist in ${zone}: the clocks go forward then, from ${before} to ${after}. Use a time before or after the change.`;
}

function twiceMessage(wall: WallClock, zone: string, earlier: ValidDateTime, later: ValidDateTime): string {
  return `${describeLocalTime(wall)} happens twice in ${zone} because the clocks go back then: first at ${utcOffsetLabel(earlier.offset)}, then at ${utcOffsetLabel(later.offset)}.`;
}

/** A stated local time as an instant: an error when it does not exist, both candidates when it happens twice. */
function momentAt(wall: WallClock, zone: string): Moment {
  const [first, second] = instantsAt(wall, zone);
  if (first === undefined) fail(nonexistentMessage(wall, zone));
  return second === undefined ? { kind: 'exact', at: first } : { kind: 'ambiguous', earlier: first, later: second };
}

/**
 * A local time nobody stated (a placeholder, or the start of a day) as an
 * instant: the earlier one when it happens twice, and the moment the clocks
 * change when it falls in a gap.
 */
function placeholderInstant(wall: WallClock, zone: string): ValidDateTime {
  const [first] = instantsAt(wall, zone);
  if (first !== undefined) return first;
  const localMs = floating(wall).toMillis();
  return valid(DateTime.fromMillis(localMs - offsetMinutesAt(zone, localMs - DAY_MS) * MINUTE_MS, { zone }));
}

function startOfDay(wall: WallClock, zone: string): ValidDateTime {
  return placeholderInstant(dateOnly(wall), zone);
}

/** The single instant a reading names, or an error naming both candidates when it names two. */
function exactly(reading: Reading, label: string, zone: string): ValidDateTime {
  const { moment } = reading;
  if (moment.kind === 'exact') return moment.at;
  return fail(
    `${label}: ${twiceMessage(reading.wall, zone, moment.earlier, moment.later)} Pass one of ${isoOf(moment.earlier)} or ${isoOf(moment.later)}.`,
  );
}

function notUnderstood(text: string): string {
  return `Could not read "${text}" as a date or time. Try a clearer expression like "next Tuesday 3pm" or "March 15 2027", or an ISO time like "2027-03-15T14:00".`;
}

/** ISO 8601 input: a date, a local date-time, or a date-time with its UTC offset. */
function readIso(text: string, zone: string): Reading | null {
  const date = ISO_DATE.exec(text);
  if (date) {
    const wall = dateOnly({
      year: Number(date[1]),
      month: Number(date[2]),
      day: Number(date[3]),
      hour: 0,
      minute: 0,
      second: 0,
      millisecond: 0,
    });
    return { moment: { kind: 'exact', at: startOfDay(wall, zone) }, wall, timeStated: false, read: text, notes: [] };
  }

  const dateTime = ISO_DATE_TIME.exec(text);
  if (!dateTime) return null;
  const normalized = text.replace(' ', 'T').toUpperCase();
  if (dateTime.groups?.offset) {
    const parsed = DateTime.fromISO(normalized, { setZone: true });
    if (!parsed.isValid) fail(notUnderstood(text));
    const at = valid(parsed.setZone(zone));
    return { moment: { kind: 'exact', at }, wall: wallClockOf(at), timeStated: true, read: text, notes: [] };
  }
  const parsed = DateTime.fromISO(normalized, { zone: 'utc' });
  if (!parsed.isValid) fail(notUnderstood(text));
  const wall = wallClockOf(parsed);
  return { moment: momentAt(wall, zone), wall, timeStated: true, read: text, notes: [] };
}

/**
 * chrono reads its reference through local-time Date getters, so it gets a
 * Date whose local fields are the zone's wall clock. The fields are checked
 * because a wall clock inside a clock change of the process timezone cannot be
 * represented; that happens only when the zone is not the process's own.
 */
function localDate(wall: WallClock): Date | null {
  const date = new Date(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second, wall.millisecond);
  const faithful =
    date.getFullYear() === wall.year &&
    date.getMonth() === wall.month - 1 &&
    date.getDate() === wall.day &&
    date.getHours() === wall.hour &&
    date.getMinutes() === wall.minute &&
    date.getSeconds() === wall.second;
  return faithful ? date : null;
}

function wallOf(components: chrono.ParsedComponents, text: string): WallClock {
  const read = (component: chrono.Component): number => {
    const value = components.get(component);
    if (value === null) fail(notUnderstood(text));
    return value;
  };
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
    millisecond: read('millisecond'),
  };
}

/**
 * "in 3 hours" is elapsed time from the reference. chrono adds it to local
 * Date fields, so its answer is `reference + duration` in wall-clock fields,
 * unless that sum lands in a gap of the process timezone, where Date moves it
 * forward. The same words read a day earlier cannot land in the same gap, and a
 * gap only ever lengthens the sum, so the shorter of the two is the duration.
 */
function relativeInstant(
  result: chrono.ParsedResult,
  refWall: WallClock,
  reference: ValidDateTime,
  text: string,
): ValidDateTime {
  const durationFrom = (wall: WallClock, components: chrono.ParsedComponents): number =>
    floating(wallOf(components, text)).toMillis() - floating(wall).toMillis();

  const current = durationFrom(refWall, result.start);
  const dayBefore = wallClockOf(floating(refWall).minus({ days: 1 }));
  const dayBeforeDate = localDate(dayBefore);
  const [earlier] = dayBeforeDate ? chrono.parse(result.text, dayBeforeDate) : [];
  const duration =
    earlier !== undefined && earlier.start.tags().has(RELATIVE_TIME_TAG)
      ? Math.min(current, durationFrom(dayBefore, earlier.start))
      : current;
  return valid(reference.plus({ milliseconds: duration }));
}

function momentOf(
  components: chrono.ParsedComponents,
  wall: WallClock,
  zone: string,
  stated: boolean,
  notes: string[],
  reference: ValidDateTime,
): Moment {
  if (components.tags().has(NOW_TAG)) return { kind: 'exact', at: valid(reference.setZone(zone)) };
  const offset = components.isCertain('timezoneOffset') ? components.get('timezoneOffset') : null;
  if (offset !== null) {
    notes.push(`Used the timezone in the text: ${utcOffsetLabel(offset)}.`);
    const at = valid(DateTime.fromMillis(floating(wall).toMillis() - offset * MINUTE_MS, { zone }));
    return { kind: 'exact', at };
  }
  return stated ? momentAt(wall, zone) : { kind: 'exact', at: placeholderInstant(wall, zone) };
}

/** chrono numbers weekdays from Sunday = 0; luxon from Monday = 1. */
function luxonWeekday(chronoWeekday: number): number {
  return chronoWeekday === 0 ? 7 : chronoWeekday;
}

function readNatural(text: string, zone: string, reference: ValidDateTime): Reading {
  const refWall = wallClockOf(valid(reference.setZone(zone)));
  const refDate = localDate(refWall);
  if (!refDate) {
    fail(
      `Could not read "${text}" against ${describe(refWall, true)} in ${zone}. Give it as an ISO date and time, such as 2027-03-15T14:00.`,
    );
  }

  const forward = chrono.parse(text, refDate, { forwardDate: true });
  const [first, ...others] = forward;
  if (first === undefined) fail(notUnderstood(text));
  if (others.length > 0) {
    fail(
      `Found more than one date or time in "${text}": ${forward.map((result) => `"${result.text}"`).join(', ')}. Resolve one at a time. To count from a date, resolve the date first and pass it to time_resolve as reference_date: for "two weeks from Friday", resolve "Friday", then "in two weeks" from it.`,
    );
  }
  const plain = chrono
    .parse(text, refDate)
    .find((result) => result.index === first.index && result.text === first.text);
  const chosen = plain !== undefined && LOOKS_BACK.test(first.text) ? plain : first;
  const other = chosen === first ? plain : first;

  const start = chosen.start;
  const wall = wallOf(start, text);
  const timeStated = start.isCertain('hour');
  const notes: string[] = [];

  if (chosen.text.length < text.length) notes.push(`Read only "${chosen.text}"; the rest was ignored.`);

  const otherWall = other === undefined ? null : wallOf(other.start, text);
  if (otherWall !== null && floating(otherWall).toMillis() !== floating(wall).toMillis()) {
    notes.push(
      chosen === first
        ? `"${chosen.text}" could also mean ${describe(otherWall, timeStated)}, which is in the past; read as ${describe(wall, timeStated)}.`
        : `"${chosen.text}" was read as ${describe(wall, timeStated)}, in the past; the next one would be ${describe(otherWall, timeStated)}.`,
    );
  }

  const weekday = start.isCertain('weekday') ? start.get('weekday') : null;
  if (weekday !== null && NEXT_WEEKDAY.test(chosen.text)) {
    const today = floating(dateOnly(refWall));
    const target = luxonWeekday(weekday);
    const coming = today.plus({ days: (target - today.weekday + 7) % 7 || 7 });
    if (!coming.hasSame(floating(wall), 'day')) {
      notes.push(
        `"${chosen.text}" was read as ${describeDate(wall)}, in the week after this one. If the coming ${coming.setLocale('en-US').toFormat('EEEE')} was meant, that is ${describeDate(wallClockOf(coming))}.`,
      );
    }
  }

  if (
    timeStated &&
    !start.isCertain('meridiem') &&
    wall.hour >= 1 &&
    wall.hour <= 11 &&
    !ZERO_PADDED_HOUR.test(chosen.text)
  ) {
    notes.push(
      `No AM or PM was given: read as ${describeTime(wall)}. If the afternoon or evening was meant, that is ${describeTime({ ...wall, hour: wall.hour + 12 })}.`,
    );
  }

  if (!timeStated) notes.push('No time of day was given; the time shown is a placeholder.');

  const moment: Moment = start.tags().has(RELATIVE_TIME_TAG)
    ? { kind: 'exact', at: relativeInstant(chosen, refWall, reference, text) }
    : momentOf(start, wall, zone, timeStated, notes, reference);
  // chrono leaves `end` null, not undefined, on results it has copied.
  const end = chosen.end
    ? momentOf(chosen.end, wallOf(chosen.end, text), zone, chosen.end.isCertain('hour'), notes, reference)
    : undefined;

  return {
    moment,
    wall: moment.kind === 'exact' ? wallClockOf(moment.at) : wall,
    timeStated,
    read: chosen.text,
    notes: [...new Set(notes)],
    ...(end === undefined ? {} : { end }),
  };
}

/** Any accepted input: ISO first (exact and cheap), natural language otherwise. */
function readInput(input: string, zone: string, reference: ValidDateTime): Reading {
  const text = input.trim();
  const reading = readIso(text, zone) ?? readNatural(text, zone, reference);
  const { moment } = reading;
  if (moment.kind === 'ambiguous') {
    reading.notes.push(`${twiceMessage(reading.wall, zone, moment.earlier, moment.later)} Ask which one is meant.`);
  }
  return reading;
}

function nowIn(zone: string, now: () => number): ValidDateTime {
  return valid(DateTime.fromMillis(now(), { zone }));
}

function readReference(input: string | undefined, zone: string, now: () => number): ValidDateTime {
  if (input === undefined) return nowIn(zone, now);
  const reading = readIso(input.trim(), zone);
  if (reading === null) {
    fail(`reference_date must be an ISO date or date-time, such as 2026-10-05 or 2026-10-05T10:00; got "${input}".`);
  }
  return exactly(reading, 'reference_date', zone);
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') fail(`${key} must be a string.`);
  return value.trim() === '' ? undefined : value;
}

function requiredString(args: Record<string, unknown>, key: string): string {
  return optionalString(args, key) ?? fail(`${key} is required.`);
}

function optionalZones(args: Record<string, unknown>, key: string): string[] | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === 'string')) {
    fail(`${key} must be a list of IANA timezones.`);
  }
  return value.length === 0 ? undefined : value;
}

function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') fail(`${key} must be true or false.`);
  return value;
}

function optionalInterval(args: Record<string, unknown>): number | undefined {
  const value = args.interval_minutes;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MINUTES_PER_DAY) {
    fail(`interval_minutes must be a whole number from 1 to ${MINUTES_PER_DAY}.`);
  }
  return value;
}

function minutesOfDay(hhmm: string, key: string): number {
  const match = HH_MM.exec(hhmm);
  if (!match) fail(`Invalid ${key} "${hhmm}". Use HH:mm, such as "09:00".`);
  return Number(match[1]) * 60 + Number(match[2]);
}

function json(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

async function run<T>(compute: () => T): Promise<CallToolResult> {
  try {
    return json(compute());
  } catch (error) {
    if (error instanceof TimeInputError) {
      return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
    }
    throw error;
  }
}

/** Weekdays after the start day, up to and including the end day (the inverse of "add N business days"). */
function businessDaysBetween(earlier: WallClock, later: WallClock): number {
  const total = dayNumber(later) - dayNumber(earlier);
  const weeks = Math.floor(total / 7);
  const startWeekday = floating(dateOnly(earlier)).weekday;
  let count = weeks * 5;
  for (let offset = 1; offset <= total - weeks * 7; offset++) {
    if (((startWeekday - 1 + offset) % 7) + 1 <= 5) count++;
  }
  return count;
}

function humanDuration(duration: Duration): string {
  const parts: string[] = [];
  const add = (value: number, unit: string) => {
    const whole = Math.floor(value);
    if (whole > 0) parts.push(`${whole} ${unit}${whole === 1 ? '' : 's'}`);
  };
  add(duration.years, 'year');
  add(duration.months, 'month');
  add(duration.weeks, 'week');
  add(duration.days, 'day');
  add(duration.hours, 'hour');
  add(duration.minutes, 'minute');
  if (parts.length === 0) return 'less than a minute';
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function prefixed(label: string, notes: string[]): string[] {
  return notes.map((note) => `${label}: ${note}`);
}

/**
 * The five time tools, computing in `zone`. The container registers them for
 * its own timezone; tests build them for any zone and a fixed clock.
 */
export function createTimeTools(zone: string, now: () => number = Date.now): McpToolDefinition[] {
  if (!isValidTimezone(zone)) throw new Error(`Time tools need an IANA timezone, got "${zone}"`);

  const timeNow: McpToolDefinition = {
    tool: {
      name: 'time_now',
      description: `Get the current date, time, and day of the week in the principal's timezone (${zone}).`,
      inputSchema: { type: 'object' as const, properties: {} },
    },
    async handler() {
      return run((): TimeNowResult => {
        const dt = nowIn(zone, now);
        return { ...formatDt(dt), unix: Math.floor(dt.toSeconds()) };
      });
    },
  };

  const timeResolve: McpToolDefinition = {
    tool: {
      name: 'time_resolve',
      description: `Turn a date/time expression into an exact date in the principal's timezone (${zone}). Examples: "next Thursday 2pm", "March 15", "in 3 weeks", "2026-03-15T14:00". The result says what was read and assumed, and any other reading the words could have; a local time that does not exist on a clock-change day is an error, and one that happens twice returns both candidates instead of one.`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          expression: { type: 'string', description: 'Natural-language or ISO date/time expression' },
          reference_date: {
            type: 'string',
            description: `ISO date or date-time to resolve relative to, such as "2026-10-05T10:00" (read in ${zone} unless it carries an offset). Defaults to now.`,
          },
        },
        required: ['expression'],
      },
    },
    async handler(args) {
      return run((): TimeResolveResult => {
        const expression = requiredString(args, 'expression');
        const reference = readReference(optionalString(args, 'reference_date'), zone, now);
        const reading = readInput(expression, zone, reference);
        const both = (moment: Extract<Moment, { kind: 'ambiguous' }>) => [
          formatDt(moment.earlier),
          formatDt(moment.later),
        ];
        const { moment, end } = reading;
        return {
          expression,
          reference: formatDt(valid(reference.setZone(zone))),
          ...(moment.kind === 'exact' ? { resolved: formatDt(moment.at) } : { candidates: both(moment) }),
          ...(end === undefined
            ? {}
            : end.kind === 'exact'
              ? { end: formatDt(end.at) }
              : { end_candidates: both(end) }),
          time_stated: reading.timeStated,
          interpretation: { read: reading.read, notes: reading.notes },
        };
      });
    },
  };

  const timeConvert: McpToolDefinition = {
    tool: {
      name: 'time_convert',
      description: `Convert a time between timezones. \`from\` and \`to\` default to the principal's timezone (${zone}).`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          time: {
            type: 'string',
            description:
              'Time to convert: ISO (e.g. "2026-03-15T14:00") or natural language (e.g. "2pm", "tomorrow 9am")',
          },
          from: {
            type: 'string',
            description: 'Source IANA timezone (e.g. "America/Los_Angeles"). Defaults to the principal\'s timezone.',
          },
          to: {
            type: 'array',
            items: { type: 'string' },
            description: "Target IANA timezones. Defaults to [the principal's timezone].",
          },
        },
        required: ['time'],
      },
    },
    async handler(args) {
      return run((): TimeConvertResult => {
        const time = requiredString(args, 'time');
        const fromZone = optionalString(args, 'from') ?? zone;
        const targets = optionalZones(args, 'to') ?? [zone];
        if (!isValidTimezone(fromZone)) {
          fail(`Invalid source timezone "${fromZone}". Use an IANA name like "America/New_York".`);
        }
        const invalid = targets.find((target) => !isValidTimezone(target));
        if (invalid !== undefined) {
          fail(`Invalid target timezone "${invalid}". Use an IANA name like "America/New_York".`);
        }

        const reading = readInput(time, fromZone, nowIn(fromZone, now));
        const convert = (at: ValidDateTime): TimeConversion => ({
          source: formatDt(at),
          conversions: Object.fromEntries(targets.map((target) => [target, formatDt(valid(at.setZone(target)))])),
        });
        const notes = reading.notes.length > 0 ? { notes: reading.notes } : {};
        const { moment } = reading;
        if (moment.kind === 'exact') return { input: time, ...convert(moment.at), ...notes };
        return { input: time, ambiguous: true, candidates: [convert(moment.earlier), convert(moment.later)], ...notes };
      });
    },
  };

  const timeDiff: McpToolDefinition = {
    tool: {
      name: 'time_diff',
      description: `Calculate the gap between two dates in the principal's timezone (${zone}): calendar days between the local dates, business days (weekdays after the start day up to and including the end day; public holidays are not known), and the elapsed time. \`from\` defaults to now.`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          from: { type: 'string', description: 'Start: ISO or natural language (defaults to now)' },
          to: { type: 'string', description: 'End: ISO or natural language' },
        },
        required: ['to'],
      },
    },
    async handler(args) {
      return run((): TimeDiffResult => {
        const toInput = requiredString(args, 'to');
        const fromInput = optionalString(args, 'from');
        const current = nowIn(zone, now);
        const fromReading = fromInput === undefined ? null : readInput(fromInput, zone, current);
        const toReading = readInput(toInput, zone, current);
        const fromAt = fromReading === null ? current : exactly(fromReading, 'from', zone);
        const toAt = exactly(toReading, 'to', zone);

        const [earlier, later] = fromAt <= toAt ? [fromAt, toAt] : [toAt, fromAt];
        const earlierWall = wallClockOf(valid(earlier.setZone(zone)));
        const laterWall = wallClockOf(valid(later.setZone(zone)));
        const duration = valid(later.setZone(zone)).diff(valid(earlier.setZone(zone)), [
          'years',
          'months',
          'weeks',
          'days',
          'hours',
          'minutes',
        ]);
        const notes = [...prefixed('from', fromReading?.notes ?? []), ...prefixed('to', toReading.notes)];

        return {
          from: formatDt(valid(fromAt.setZone(zone))),
          to: formatDt(valid(toAt.setZone(zone))),
          direction: toAt < fromAt ? 'past' : 'future',
          calendar_days: dayNumber(laterWall) - dayNumber(earlierWall),
          business_days: businessDaysBetween(earlierWall, laterWall),
          human: humanDuration(duration),
          breakdown: {
            years: Math.floor(duration.years),
            months: Math.floor(duration.months),
            weeks: Math.floor(duration.weeks),
            days: Math.floor(duration.days),
            hours: Math.floor(duration.hours),
            minutes: Math.floor(duration.minutes),
          },
          ...(notes.length > 0 ? { notes } : {}),
        };
      });
    },
  };

  const timeRange: McpToolDefinition = {
    tool: {
      name: 'time_range',
      description: `List dates, or time slots within a daily window, in the principal's timezone (${zone}); e.g. "weekdays next week 9-5 hourly". A date given without a time covers that whole day. At most ${MAX_RANGE_DAYS} days and ${MAX_SLOTS} slots. A slot time the clocks skip is left out and listed under skipped; one that happens twice carries second_occurrence_iso.`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          from: { type: 'string', description: 'Start: ISO or natural language' },
          to: { type: 'string', description: 'End: ISO or natural language (a date alone includes that day)' },
          time_start: {
            type: 'string',
            description: 'Daily start time in HH:mm (e.g. "09:00"). If omitted, returns whole days.',
          },
          time_end: {
            type: 'string',
            description: 'Daily end time in HH:mm (e.g. "17:00"), after time_start. Required with time_start.',
          },
          interval_minutes: {
            type: 'integer',
            minimum: 1,
            maximum: MINUTES_PER_DAY,
            description: `Minutes between slot starts (default ${DEFAULT_INTERVAL_MINUTES}). Only used with time_start/time_end.`,
          },
          weekdays_only: { type: 'boolean', description: 'If true, exclude Saturdays and Sundays (default false)' },
        },
        required: ['from', 'to'],
      },
    },
    async handler(args) {
      return run((): TimeRangeResult => {
        const fromInput = requiredString(args, 'from');
        const toInput = requiredString(args, 'to');
        const timeStart = optionalString(args, 'time_start');
        const timeEnd = optionalString(args, 'time_end');
        const interval = optionalInterval(args) ?? DEFAULT_INTERVAL_MINUTES;
        const weekdaysOnly = optionalBoolean(args, 'weekdays_only') ?? false;

        if ((timeStart === undefined) !== (timeEnd === undefined)) {
          fail('time_start and time_end go together; give both or neither.');
        }
        const window =
          timeStart !== undefined && timeEnd !== undefined
            ? { start: minutesOfDay(timeStart, 'time_start'), end: minutesOfDay(timeEnd, 'time_end') }
            : null;
        if (window !== null && window.end <= window.start) {
          fail('time_end must be after time_start; a daily window cannot cross midnight.');
        }

        const current = nowIn(zone, now);
        const fromReading = readInput(fromInput, zone, current);
        const toReading = readInput(toInput, zone, current);
        const start = fromReading.timeStated ? exactly(fromReading, 'from', zone) : startOfDay(fromReading.wall, zone);
        const end = toReading.timeStated
          ? exactly(toReading, 'to', zone)
          : startOfDay(wallClockOf(floating(dateOnly(toReading.wall)).plus({ days: 1 })), zone);
        if (end <= start) fail('"to" must be after "from".');

        const firstDay = floating(dateOnly(wallClockOf(valid(start.setZone(zone)))));
        const lastDay = floating(dateOnly(wallClockOf(valid(end.minus({ milliseconds: 1 }).setZone(zone)))));
        const days = dayNumber(wallClockOf(lastDay)) - dayNumber(wallClockOf(firstDay)) + 1;
        if (days > MAX_RANGE_DAYS) {
          fail(`Range too large: it covers ${days} days. The maximum is ${MAX_RANGE_DAYS} days.`);
        }

        const slots: TimeSlot[] = [];
        const skipped: string[] = [];
        for (let index = 0; index < days; index++) {
          const day = firstDay.plus({ days: index }).setLocale('en-US');
          if (weekdaysOnly && day.weekday > 5) continue;
          if (window === null) {
            slots.push({
              date: day.toFormat(DATE_FORMAT),
              day: day.toFormat('EEEE'),
              iso: isoOf(startOfDay(wallClockOf(day), zone)),
            });
          } else {
            for (let minute = window.start; minute < window.end; minute += interval) {
              const wall = wallClockOf(day.plus({ minutes: minute }));
              const everyInstant = instantsAt(wall, zone);
              const [first, second] = everyInstant.filter((at) => at >= start && at < end);
              if (first === undefined) {
                if (everyInstant.length === 0) skipped.push(`${describeLocalTime(wall)} does not exist in ${zone}.`);
                continue;
              }
              const local = first.setLocale('en-US');
              slots.push({
                date: local.toFormat('EEE, MMM d'),
                day: local.toFormat('EEEE'),
                time: local.toFormat(TIME_FORMAT),
                iso: isoOf(first),
                ...(second === undefined ? {} : { second_occurrence_iso: isoOf(second) }),
              });
            }
          }
          if (slots.length > MAX_SLOTS) {
            fail(
              `Too many slots (more than ${MAX_SLOTS}). Narrow the range, lengthen the interval, or use weekdays_only.`,
            );
          }
        }

        const notes = [...prefixed('from', fromReading.notes), ...prefixed('to', toReading.notes)];
        return {
          from: formatDt(valid(start.setZone(zone))),
          to: formatDt(valid(end.setZone(zone))),
          days,
          weekdays_only: weekdaysOnly,
          time_window: window === null ? null : `${timeStart}–${timeEnd}`,
          interval_minutes: window === null ? null : interval,
          count: slots.length,
          slots,
          ...(skipped.length > 0 ? { skipped } : {}),
          ...(notes.length > 0 ? { notes } : {}),
        };
      });
    },
  };

  return [timeNow, timeResolve, timeConvert, timeDiff, timeRange];
}

registerTools(createTimeTools(TIMEZONE));
