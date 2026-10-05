/**
 * The host's free-time arithmetic (KTD7; R69). Pure functions: no store, no
 * Google, no clock of their own.
 *
 * - Wall-clock times become instants through the principal's timezone, so a
 *   day with a clock change is 23 or 25 hours long and every time is its real
 *   length. A wall time the clocks skip lands just after the change.
 * - An event blocks time unless it is cancelled, free (transparent), or an
 *   invitation the principal declined; an all-day event covers the
 *   principal's whole local days (the rules `find_conflicts` uses).
 * - Free time is offered from the principal's waking day, widened by working
 *   hours that reach past it, on a half-hour grid of their clock, clear of
 *   protected time and of busy time by the buffer (`freeTimes`), and inside
 *   the counterpart's waking day when their zone is known. Each time carries
 *   a fit note from a fixed vocabulary on how it sits against the principal's
 *   preferences (`fitOf`). The times are spread across days and hours of the
 *   day as a person offers them, and listed in date order. Only protected
 *   time is hard (`inProtectedTime`), so a time someone proposes is checked
 *   against it too.
 */
import {
  type PreferenceValue,
  type PreferredTimePreference,
  type SchedulingPreferenceValues,
  type Weekday,
} from '../gws-ea-preferences/db.js';
import type { ListedEvent } from './calendar-api.js';

/** An interval of instants, in milliseconds since the epoch; `end` is exclusive. */
export interface Span {
  readonly start: number;
  readonly end: number;
}

/** A calendar date on the principal's clock; `month` runs 1 to 12. */
export interface LocalDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/** Minutes since local midnight; `end` may be 1440, the next midnight. */
export interface ClockRange {
  readonly start: number;
  readonly end: number;
}

export interface WeeklyRange extends ClockRange {
  readonly weekdays: ReadonlySet<Weekday>;
}

/** The principal's preferences, as free-time arithmetic needs them. */
export interface SchedulingRules {
  /** Hours per weekday; a weekday without hours is not a working day. */
  readonly workingHours: ReadonlyMap<Weekday, ClockRange>;
  readonly protectedWindows: readonly WeeklyRange[];
  readonly preferredTimes: readonly WeeklyRange[];
  readonly bufferMinutes: number;
}

/** Candidates start on this grid of the principal's clock. */
const SLOT_GRID_MINUTES = 30;
/** The waking day, 07:00 to 22:00, which free time offers from on either side's clock: never the night. */
const WAKING_HOURS: ClockRange = { start: 7 * 60, end: 22 * 60 };
/** Working hours until the principal has any: Monday to Friday, 09:00 to 17:00. */
const DEFAULT_WORKING_HOURS: ReadonlyMap<Weekday, ClockRange> = new Map(
  (['mon', 'tue', 'wed', 'thu', 'fri'] as const).map((day) => [day, { start: 9 * 60, end: 17 * 60 }]),
);
/** The kind of meeting whose preferred times and buffer free time keeps to. */
const DEFAULT_MEETING_KIND = 'default';

const MINUTE = 60_000;
const DAY_MS = 24 * 60 * MINUTE;
const SUNDAY_FIRST: readonly Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// ---------------------------------------------------------------------------
// Time zones
// ---------------------------------------------------------------------------

/** An instant as ISO-8601 UTC, the way the store and Google take it. */
export function iso(instant: number): string {
  return new Date(instant).toISOString();
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string): Intl.DateTimeFormat {
  let format = formatters.get(timezone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timezone, format);
  }
  return format;
}

interface WallClock extends LocalDate {
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

function wallClock(instant: number, timezone: string): WallClock {
  const parts: Record<string, number> = {};
  for (const part of formatter(timezone).formatToParts(new Date(instant))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

/** How far the zone's clock runs ahead of UTC at an instant. */
function zoneOffset(instant: number, timezone: string): number {
  const wall = wallClock(instant, timezone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/**
 * The instant a wall-clock time names in `timezone`. A time the clocks repeat
 * takes its later occurrence; a time they skip lands just after the change.
 */
export function zonedInstant(date: LocalDate, minuteOfDay: number, timezone: string): number {
  const wall = Date.UTC(date.year, date.month - 1, date.day, 0, minuteOfDay);
  const first = zoneOffset(wall, timezone);
  const guess = wall - first;
  const second = zoneOffset(guess, timezone);
  if (first === second) return guess;
  const adjusted = wall - second;
  const third = zoneOffset(adjusted, timezone);
  if (second === third) return adjusted;
  return wall - Math.min(second, third);
}

/** The local date an instant falls on, with its weekday and minute of the day. */
function localTime(
  instant: number,
  timezone: string,
): LocalDate & { readonly weekday: Weekday; readonly minuteOfDay: number } {
  const wall = wallClock(instant, timezone);
  return {
    year: wall.year,
    month: wall.month,
    day: wall.day,
    weekday: weekdayOf(wall),
    minuteOfDay: wall.hour * 60 + wall.minute,
  };
}

function weekdayOf(date: LocalDate): Weekday {
  return SUNDAY_FIRST[new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()];
}

function nextDate(date: LocalDate): LocalDate {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + 1));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

function dateKey(date: LocalDate): string {
  return `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
}

function compareDates(a: LocalDate, b: LocalDate): number {
  return a.year - b.year || a.month - b.month || a.day - b.day;
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;
const CLOCK_PATTERN = /^(\d{2}):(\d{2})$/u;

/** A `YYYY-MM-DD` date that exists, or undefined. */
function parseLocalDate(value: string): LocalDate | undefined {
  const match = DATE_PATTERN.exec(value);
  if (!match) return undefined;
  const date = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  const check = new Date(Date.UTC(date.year, date.month - 1, date.day));
  return check.getUTCFullYear() === date.year &&
    check.getUTCMonth() + 1 === date.month &&
    check.getUTCDate() === date.day
    ? date
    : undefined;
}

/** A 24-hour `HH:MM` as minutes of the day (`24:00` is 1440), or undefined. */
function parseClock(value: string): number | undefined {
  const match = CLOCK_PATTERN.exec(value);
  if (!match) return undefined;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  if (Number(match[2]) > 59 || minutes > 24 * 60) return undefined;
  return minutes;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** An event's span: a timed event's instants, an all-day event's whole local days. */
export function eventSpan(event: ListedEvent, timezone: string): Span | undefined {
  const { start, end } = event;
  if (start?.dateTime !== undefined && end?.dateTime !== undefined) {
    const span = { start: Date.parse(start.dateTime), end: Date.parse(end.dateTime) };
    return Number.isNaN(span.start) || Number.isNaN(span.end) ? undefined : span;
  }
  const startDate = start?.date === undefined ? undefined : parseLocalDate(start.date);
  const endDate = end?.date === undefined ? undefined : parseLocalDate(end.date);
  if (startDate === undefined || endDate === undefined) return undefined;
  return { start: zonedInstant(startDate, 0, timezone), end: zonedInstant(endDate, 0, timezone) };
}

/** Whether an event takes the principal's time: not cancelled, not free, not declined by them. */
export function blocksTime(event: ListedEvent, principal: ReadonlySet<string>): boolean {
  if (event.status === 'cancelled' || event.transparency === 'transparent') return false;
  return !(event.attendees ?? []).some(
    (attendee) =>
      attendee.email !== undefined && principal.has(attendee.email) && attendee.responseStatus === 'declined',
  );
}

// ---------------------------------------------------------------------------
// The principal's preferences
// ---------------------------------------------------------------------------

function clockRange(start: string, end: string): ClockRange | undefined {
  const from = parseClock(start);
  const to = parseClock(end);
  return from === undefined || to === undefined || to <= from ? undefined : { start: from, end: to };
}

function weekly(value: {
  readonly weekdays: readonly Weekday[];
  readonly start: string;
  readonly end: string;
}): WeeklyRange | undefined {
  const range = clockRange(value.start, value.end);
  return range && { ...range, weekdays: new Set(value.weekdays) };
}

/** The rules free time keeps to, from the values the store holds: the default kind's preferred times and buffer. */
export function schedulingRules(values: SchedulingPreferenceValues): SchedulingRules {
  const workingHours = new Map<Weekday, ClockRange>();
  for (const day of values.working_hours) {
    if (day.off) continue;
    const range = clockRange(day.start, day.end);
    if (range) workingHours.set(day.weekday, range);
  }
  const preferred: readonly PreferenceValue<PreferredTimePreference>[] = values.preferred_times.filter(
    (value) => value.meeting_kind === DEFAULT_MEETING_KIND,
  );
  return {
    workingHours: values.working_hours.length === 0 ? DEFAULT_WORKING_HOURS : workingHours,
    protectedWindows: values.protected_windows.flatMap((value) => weekly(value) ?? []),
    preferredTimes: preferred.flatMap((value) => weekly(value) ?? []),
    bufferMinutes: values.buffers.find((value) => value.meeting_kind === DEFAULT_MEETING_KIND)?.minutes ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Protected and busy time
// ---------------------------------------------------------------------------

function overlaps(a: Span, b: Span): boolean {
  return a.start < b.end && a.end > b.start;
}

function onDay(date: LocalDate, range: ClockRange, timezone: string): Span {
  return { start: zonedInstant(date, range.start, timezone), end: zonedInstant(date, range.end, timezone) };
}

/** Whether any part of a span falls inside one of the principal's protected windows, on every local day it touches. */
export function inProtectedTime(span: Span, rules: SchedulingRules, timezone: string): boolean {
  const last = localTime(span.end - 1, timezone);
  for (let date: LocalDate = localTime(span.start, timezone); compareDates(date, last) <= 0; date = nextDate(date)) {
    const weekday = weekdayOf(date);
    for (const window of rules.protectedWindows) {
      if (window.weekdays.has(weekday) && overlaps(span, onDay(date, window, timezone))) return true;
    }
  }
  return false;
}

/** Whether a span is clear of every busy time, by `bufferMinutes` either side. */
export function isClear(span: Span, busy: readonly Span[], bufferMinutes = 0): boolean {
  const buffer = bufferMinutes * MINUTE;
  const padded = { start: span.start - buffer, end: span.end + buffer };
  return !busy.some((taken) => overlaps(padded, taken));
}

// ---------------------------------------------------------------------------
// How a time fits
// ---------------------------------------------------------------------------

function insidePreferred(slot: Span, rules: SchedulingRules, timezone: string): boolean {
  const local = localTime(slot.start, timezone);
  return rules.preferredTimes.some((window) => {
    if (!window.weekdays.has(local.weekday)) return false;
    const preferred = onDay(local, window, timezone);
    return slot.start >= preferred.start && slot.end <= preferred.end;
  });
}

/** Whether a slot lies inside the principal's working hours that day. */
function insideWorkingHours(slot: Span, rules: SchedulingRules, timezone: string): boolean {
  const local = localTime(slot.start, timezone);
  const hours = rules.workingHours.get(local.weekday);
  if (!hours) return false;
  const day = onDay(local, hours, timezone);
  return slot.start >= day.start && slot.end <= day.end;
}

// ---------------------------------------------------------------------------
// Free time, as external-email asks for it (KTD7)
// ---------------------------------------------------------------------------

/** How a time sits against the principal's preferences, best first: the only words free time says of them. */
export const FITS = ['preferred', 'acceptable', 'outside usual hours'] as const;
export type Fit = (typeof FITS)[number];

/** Preferred when inside a preferred time, acceptable inside working hours, and otherwise outside usual hours. */
export function fitOf(span: Span, rules: SchedulingRules, timezone: string): Fit {
  if (insidePreferred(span, rules, timezone)) return 'preferred';
  return insideWorkingHours(span, rules, timezone) ? 'acceptable' : 'outside usual hours';
}

export interface FreeTimeQuery {
  readonly timezone: string;
  /** The counterpart's zone, when known: every time offered falls inside their waking day too. */
  readonly counterpartTimezone?: string;
  readonly lengthMinutes: number;
  /** Every time offered lies wholly inside it. */
  readonly window: Span;
  /** Time already taken on the principal's calendars. */
  readonly busy: readonly Span[];
  readonly rules: SchedulingRules;
}

export interface FreeTime extends Span {
  readonly fit: Fit;
}

/** An open time, with the principal's local day and hour of the day it starts in. */
interface OpenTime extends FreeTime {
  readonly day: string;
  readonly hour: number;
}

/** The hours free time offers from on a weekday: the waking day, widened by working hours that reach past it. */
function offerHours(rules: SchedulingRules, weekday: Weekday): ClockRange {
  const working = rules.workingHours.get(weekday);
  return working
    ? { start: Math.min(working.start, WAKING_HOURS.start), end: Math.max(working.end, WAKING_HOURS.end) }
    : WAKING_HOURS;
}

/** Whether a span lies wholly inside the waking day on `timezone`'s clock. */
function insideWakingDay(span: Span, timezone: string): boolean {
  const day = onDay(localTime(span.start, timezone), WAKING_HOURS, timezone);
  return span.start >= day.start && span.end <= day.end;
}

/**
 * Up to `limit` open times, chosen from the earliest as a person offers
 * them: first the earliest time each day at an hour of the day not offered
 * yet, then the earliest left that overlaps none already chosen.
 */
function spread(open: readonly OpenTime[], limit: number): OpenTime[] {
  const chosen: OpenTime[] = [];
  for (const time of open) {
    if (chosen.length >= limit) return chosen;
    if (!chosen.some((taken) => taken.day === time.day || taken.hour === time.hour)) chosen.push(time);
  }
  for (const time of open) {
    if (chosen.length >= limit) return chosen;
    if (!chosen.some((taken) => overlaps(taken, time))) chosen.push(time);
  }
  return chosen;
}

/**
 * Up to `limit` open times in the window, spread as a person offers them and
 * listed in date order: on the half-hour grid of the principal's clock,
 * within the hours free time offers from and the counterpart's waking day,
 * starting no earlier than the window, and clear of protected time and of
 * busy time by the buffer.
 */
export function freeTimes(query: FreeTimeQuery, limit: number): FreeTime[] {
  const { timezone, counterpartTimezone, rules, window } = query;
  const length = query.lengthMinutes * MINUTE;
  const grid = SLOT_GRID_MINUTES * MINUTE;
  const open: OpenTime[] = [];
  const last = localTime(window.end, timezone);
  for (let date: LocalDate = localTime(window.start, timezone); compareDates(date, last) <= 0; date = nextDate(date)) {
    const hours = offerHours(rules, weekdayOf(date));
    const firstStart = Math.ceil(hours.start / SLOT_GRID_MINUTES) * SLOT_GRID_MINUTES;
    const day = onDay(date, { start: firstStart, end: hours.end }, timezone);
    // Real minutes from the day's first grid start: a clock change keeps the grid on the hour.
    for (let start = day.start; start + length <= day.end; start += grid) {
      const span = { start, end: start + length };
      if (span.start < window.start || span.end > window.end) continue;
      if (counterpartTimezone !== undefined && !insideWakingDay(span, counterpartTimezone)) continue;
      if (inProtectedTime(span, rules, timezone) || !isClear(span, query.busy, rules.bufferMinutes)) continue;
      const hour = Math.floor(localTime(span.start, timezone).minuteOfDay / 60);
      open.push({ ...span, fit: fitOf(span, rules, timezone), day: dateKey(date), hour });
    }
  }
  return spread(open, limit)
    .sort((a, b) => a.start - b.start)
    .map(({ start, end, fit }) => ({ start, end, fit }));
}

/** One day, in milliseconds: how far calendar reads widen so all-day events are seen whole. */
export const READ_MARGIN_MS = DAY_MS;
