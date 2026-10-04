/**
 * The host's slot arithmetic (R4, R5, R13, KTD11). Pure functions: no store,
 * no Google, no clock of their own.
 *
 * - Wall-clock times become instants through the principal's timezone, so a
 *   day with a clock change is 23 or 25 hours long and every slot is its real
 *   length. A wall time the clocks skip lands just after the change.
 * - An event blocks time unless it is cancelled, free (transparent), or an
 *   invitation the principal declined; an all-day event covers the
 *   principal's whole local days (the rules `find_conflicts` uses).
 * - A start is open when the meeting fits inside its window, after the
 *   earliest allowed start, inside the day's hours for its level, clear of
 *   protected time, and clear of busy time by the buffer. The inner circle and
 *   close may meet outside working hours, within `PERSONAL_HOURS`; everyone
 *   else only within working hours (R13). Protected time applies to everyone.
 * - Candidates start on a half-hour grid of the principal's clock. The best
 *   ones are ranked as a person would pick them (KTD9): the principal's
 *   preferred times first for everyone, working hours before the evenings
 *   and weekends the inner circle and close may use, and for someone active
 *   the next two working days first (R13). They are spread across days and
 *   times of day, never overlap, and are capped; a narrow window gives the
 *   fewer times it holds.
 * - Offers start the next day, unless the window ends today: an email read
 *   later in the day should not find its times gone.
 */
import { createHash } from 'node:crypto';

import {
  type PreferenceValue,
  type PreferredTimePreference,
  type SchedulingPreferenceValues,
  type Weekday,
} from '../gws-ea-preferences/db.js';
import type { ListedEvent } from './calendar-api.js';
import type { MeetingLevel } from './db.js';

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

/** The principal's preferences, as slot arithmetic needs them for one kind of meeting. */
export interface SchedulingRules {
  /** Hours per weekday; a weekday without hours is not a working day. */
  readonly workingHours: ReadonlyMap<Weekday, ClockRange>;
  readonly protectedWindows: readonly WeeklyRange[];
  readonly preferredTimes: readonly WeeklyRange[];
  readonly bufferMinutes: number;
}

export interface SlotQuery {
  readonly timezone: string;
  readonly level: MeetingLevel;
  readonly lengthMinutes: number;
  /** The meeting's window: a slot lies wholly inside it. */
  readonly window: Span;
  /** No slot starts before this. */
  readonly earliest: number;
  /** Time already taken on the principal's calendars and visible colleagues'. */
  readonly busy: readonly Span[];
  readonly rules: SchedulingRules;
}

export interface Candidate extends Span {
  /** The local date it starts on, `YYYY-MM-DD`. */
  readonly day: string;
  /** Its rank group: lower is better. */
  readonly tier: number;
}

/** Candidates start on this grid of the principal's clock. */
export const SLOT_GRID_MINUTES = 30;
/** The day the inner circle and close may use outside working hours: never the night. */
export const PERSONAL_HOURS: ClockRange = { start: 7 * 60, end: 22 * 60 };
/** Working hours until the principal has any: Monday to Friday, 09:00 to 17:00. */
export const DEFAULT_WORKING_HOURS: ReadonlyMap<Weekday, ClockRange> = new Map(
  (['mon', 'tue', 'wed', 'thu', 'fri'] as const).map((day) => [day, { start: 9 * 60, end: 17 * 60 }]),
);
/** The kind of meeting whose preferences apply when a meeting's own kind has none. */
export const DEFAULT_MEETING_KIND = 'default';
/** Two times offered on one day start at least this far apart. */
const SAME_DAY_SPACING_MINUTES = 120;
/** Active counterparts' times come from this many working days first (R13). */
const ACTIVE_WORKING_DAYS = 2;
/** Noon on the principal's clock: offers alternate either side of it where they can. */
const NOON = 12 * 60;

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
export function localTime(
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
export function parseLocalDate(value: string): LocalDate | undefined {
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
export function parseClock(value: string): number | undefined {
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

/** A kind's own values, or the default kind's when it has none. */
function forKind<T extends { readonly meeting_kind: string }>(values: readonly T[], kind: string | null): T[] {
  const own = kind === null ? [] : values.filter((value) => value.meeting_kind === kind);
  return own.length > 0 ? own : values.filter((value) => value.meeting_kind === DEFAULT_MEETING_KIND);
}

/** The rules for one kind of meeting, from the values the store holds. */
export function schedulingRules(values: SchedulingPreferenceValues, meetingKind: string | null): SchedulingRules {
  const workingHours = new Map<Weekday, ClockRange>();
  for (const day of values.working_hours) {
    if (day.off) continue;
    const range = clockRange(day.start, day.end);
    if (range) workingHours.set(day.weekday, range);
  }
  const preferred: readonly PreferenceValue<PreferredTimePreference>[] = forKind(values.preferred_times, meetingKind);
  return {
    workingHours: values.working_hours.length === 0 ? DEFAULT_WORKING_HOURS : workingHours,
    protectedWindows: values.protected_windows.flatMap((value) => weekly(value) ?? []),
    preferredTimes: preferred.flatMap((value) => weekly(value) ?? []),
    bufferMinutes: forKind(values.buffers, meetingKind)[0]?.minutes ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Open times
// ---------------------------------------------------------------------------

/** The inner circle and close: they may meet outside working hours, and only they report needs-room. */
export function usesPersonalHours(level: MeetingLevel): boolean {
  return level === 'inner-circle' || level === 'close';
}

/** The hours a level may meet on a weekday, or undefined when it may not meet that day. */
function dayHours(query: SlotQuery, weekday: Weekday): ClockRange | undefined {
  return usesPersonalHours(query.level) ? PERSONAL_HOURS : query.rules.workingHours.get(weekday);
}

function overlaps(a: Span, b: Span): boolean {
  return a.start < b.end && a.end > b.start;
}

function onDay(date: LocalDate, range: ClockRange, timezone: string): Span {
  return { start: zonedInstant(date, range.start, timezone), end: zonedInstant(date, range.end, timezone) };
}

/** Whether a meeting may start at `start`: inside the window and the day's hours, clear of protected and busy time. */
export function isOpen(start: number, query: SlotQuery): boolean {
  const slot = { start, end: start + query.lengthMinutes * MINUTE };
  if (slot.start < query.window.start || slot.end > query.window.end || slot.start < query.earliest) return false;
  const local = localTime(start, query.timezone);
  const hours = dayHours(query, local.weekday);
  if (!hours) return false;
  const day = onDay(local, hours, query.timezone);
  if (slot.start < day.start || slot.end > day.end) return false;
  for (const window of query.rules.protectedWindows) {
    if (window.weekdays.has(local.weekday) && overlaps(slot, onDay(local, window, query.timezone))) return false;
  }
  const buffer = query.rules.bufferMinutes * MINUTE;
  const padded = { start: slot.start - buffer, end: slot.end + buffer };
  return !query.busy.some((busy) => overlaps(padded, busy));
}

/** Every open start on the half-hour grid, earliest first, optionally only inside `range`. */
export function openSlots(query: SlotQuery, range?: Span): Span[] {
  const from = Math.max(query.window.start, query.earliest, range?.start ?? -Infinity);
  const to = Math.min(query.window.end, range?.end ?? Infinity);
  if (from >= to) return [];
  const length = query.lengthMinutes * MINUTE;
  const grid = SLOT_GRID_MINUTES * MINUTE;
  const open: Span[] = [];
  const last = localTime(to, query.timezone);
  for (let date: LocalDate = localTime(from, query.timezone); compareDates(date, last) <= 0; date = nextDate(date)) {
    const hours = dayHours(query, weekdayOf(date));
    if (!hours) continue;
    const firstStart = Math.ceil(hours.start / SLOT_GRID_MINUTES) * SLOT_GRID_MINUTES;
    const day = onDay(date, { start: firstStart, end: hours.end }, query.timezone);
    // Real minutes from the day's first grid start: a clock change keeps the grid on the hour.
    for (let start = day.start; start + length <= day.end; start += grid) {
      if (start < from || start + length > to) continue;
      if (isOpen(start, query)) open.push({ start, end: start + length });
    }
  }
  return open;
}

// ---------------------------------------------------------------------------
// The best ones to offer
// ---------------------------------------------------------------------------

function insidePreferred(slot: Span, query: SlotQuery): boolean {
  const local = localTime(slot.start, query.timezone);
  return query.rules.preferredTimes.some((window) => {
    if (!window.weekdays.has(local.weekday)) return false;
    const preferred = onDay(local, window, query.timezone);
    return slot.start >= preferred.start && slot.end <= preferred.end;
  });
}

/** Whether a slot lies inside the principal's working hours that day. */
function insideWorkingHours(slot: Span, query: SlotQuery): boolean {
  const local = localTime(slot.start, query.timezone);
  const hours = query.rules.workingHours.get(local.weekday);
  if (!hours) return false;
  const day = onDay(local, hours, query.timezone);
  return slot.start >= day.start && slot.end <= day.end;
}

/**
 * Rank open times as a person would pick them (KTD9, R13) and choose up to
 * `limit` to offer. The rank: the principal's preferred times first, then
 * working hours before personal hours, and for someone active the next two
 * working days first. Within each rank, one per day at a new hour of the
 * day, alternating either side of noon where the open times allow; then one
 * per day at a new hour; then one per day; then a second per day at least
 * two hours apart; then any time left that overlaps none already chosen.
 */
export function bestSlots(query: SlotQuery, open: readonly Span[], limit: number, now: number): Candidate[] {
  const horizon =
    query.level === 'active' ? workingDayEnd(now, ACTIVE_WORKING_DAYS, query.rules, query.timezone) : undefined;
  const tierOf = (slot: Span): number =>
    (insidePreferred(slot, query) ? 0 : 4) +
    (insideWorkingHours(slot, query) ? 0 : 2) +
    (horizon !== undefined && slot.end > horizon ? 1 : 0);
  const ranked: Candidate[] = open
    .map((slot) => ({ ...slot, day: dateKey(localTime(slot.start, query.timezone)), tier: tierOf(slot) }))
    .sort((a, b) => a.tier - b.tier || a.start - b.start);

  const chosen: Candidate[] = [];
  const spacing = SAME_DAY_SPACING_MINUTES * MINUTE;
  const minuteOf = (slot: Span): number => localTime(slot.start, query.timezone).minuteOfDay;
  const hourOf = (slot: Span): number => Math.floor(minuteOf(slot) / 60);
  const fits = (candidate: Candidate, perDay: number | undefined): boolean => {
    if (chosen.some((taken) => overlaps(taken, candidate))) return false;
    if (perDay === undefined) return true;
    const sameDay = chosen.filter((taken) => taken.day === candidate.day);
    return sameDay.length < perDay && sameDay.every((taken) => Math.abs(taken.start - candidate.start) >= spacing);
  };
  /** Whether a time adds variety: a new hour of the day, and with `alternate` the other side of noon from the last one. */
  const varied = (candidate: Candidate, alternate: boolean): boolean => {
    if (chosen.some((taken) => hourOf(taken) === hourOf(candidate))) return false;
    const last = chosen.at(-1);
    return !alternate || last === undefined || minuteOf(last) < NOON !== minuteOf(candidate) < NOON;
  };
  const take = (
    candidates: readonly Candidate[],
    perDay: number | undefined,
    variety: 'alternate' | 'new-hour' | 'any',
  ): void => {
    for (const candidate of candidates) {
      if (chosen.length >= limit) return;
      if (chosen.includes(candidate) || !fits(candidate, perDay)) continue;
      if (variety !== 'any' && !varied(candidate, variety === 'alternate')) continue;
      chosen.push(candidate);
    }
  };
  for (const tier of [...new Set(ranked.map((candidate) => candidate.tier))]) {
    const inTier = ranked.filter((candidate) => candidate.tier === tier);
    take(inTier, 1, 'alternate');
    take(inTier, 1, 'new-hour');
    take(inTier, 1, 'any');
    take(inTier, 2, 'any');
  }
  take(ranked, undefined, 'any');
  return chosen;
}

/**
 * The earliest start to offer from `now`: the next day, unless the window
 * ends today, and never sooner than the notice. An email is read later, so
 * a time later today is offered only when the meeting must be today.
 */
export function earliestOffer(now: number, window: Span, timezone: string, noticeMinutes: number): number {
  const notice = now + noticeMinutes * MINUTE;
  const tomorrow = zonedInstant(nextDate(localTime(now, timezone)), 0, timezone);
  return window.end <= tomorrow ? notice : Math.max(notice, tomorrow);
}

/**
 * The end of the `count`th working day that ends after `from`, on the
 * principal's working hours and clock; undefined when the principal works no
 * days at all.
 */
function workingDayEnd(from: number, count: number, rules: SchedulingRules, timezone: string): number | undefined {
  if (rules.workingHours.size === 0) return undefined;
  let counted = 0;
  let date: LocalDate = localTime(from, timezone);
  for (let days = 0; days < 7 * (count + 1); days += 1, date = nextDate(date)) {
    const hours = rules.workingHours.get(weekdayOf(date));
    if (!hours) continue;
    const end = zonedInstant(date, hours.end, timezone);
    if (end <= from) continue;
    counted += 1;
    if (counted === count) return end;
  }
  return undefined;
}

/**
 * The instant `count` working days after `from`, on the principal's working
 * hours and clock: the same time of day on the `count`th working day after
 * the one `from` falls in, never past that day's close. A `from` outside
 * working hours counts from the start of the next working day, so the
 * weekend and days off never count. Without any working day it assumes
 * Monday to Friday, 09:00 to 17:00. Follow-through deadlines use it (KTD12).
 */
export function workingDaysLater(from: number, count: number, rules: SchedulingRules, timezone: string): number {
  const hours = rules.workingHours.size > 0 ? rules.workingHours : DEFAULT_WORKING_HOURS;
  /** The first working day after `date`, with its hours. */
  const nextWorkingDay = (date: LocalDate): { readonly date: LocalDate; readonly hours: ClockRange } => {
    for (let next = nextDate(date); ; next = nextDate(next)) {
      const range = hours.get(weekdayOf(next));
      if (range) return { date: next, hours: range };
    }
  };
  const local = localTime(from, timezone);
  const today = hours.get(local.weekday);
  const duringToday = today !== undefined && local.minuteOfDay < today.end;
  let day = duringToday ? { date: local, hours: today } : nextWorkingDay(local);
  const minute = duringToday ? Math.max(local.minuteOfDay, today.start) : day.hours.start;
  for (let counted = 0; counted < count; counted += 1) day = nextWorkingDay(day.date);
  return zonedInstant(day.date, Math.min(Math.max(minute, day.hours.start), day.hours.end), timezone);
}

/** A slot's id: opaque, and the same for the same meeting and time on every call. */
export function slotIdFor(meetingId: string, slot: Span): string {
  const digest = createHash('sha256')
    .update(`${meetingId}|${new Date(slot.start).toISOString()}|${new Date(slot.end).toISOString()}`)
    .digest('hex');
  return `slot-${digest.slice(0, 12)}`;
}

/** The local day containing `date` in `timezone`, as an interval. */
export function localDaySpan(date: LocalDate, timezone: string): Span {
  return { start: zonedInstant(date, 0, timezone), end: zonedInstant(nextDate(date), 0, timezone) };
}

/** One day, in milliseconds: how far calendar reads widen so all-day events are seen whole. */
export const READ_MARGIN_MS = DAY_MS;
