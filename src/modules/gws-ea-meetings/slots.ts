/**
 * The host's free-time arithmetic (KTD7; R69). Pure functions: no store, no
 * Google, no clock of their own.
 *
 * - Wall-clock times become instants through the principal's timezone, so a
 *   day with a clock change is 23 or 25 hours long and every time is its real
 *   length. A wall time the clocks skip lands just after the change.
 * - An event blocks time unless it is cancelled, free (transparent), or an
 *   invitation the principal declined on that calendar; an all-day event
 *   covers the principal's whole local days. `free_time`, `book` and main's
 *   `find_conflicts` all read time through this one rule.
 * - Free time is every free window in the principal's waking day, widened
 *   by working hours that reach past it, clear of protected time and of busy
 *   time by the buffer, inside the counterpart's waking day when their zone
 *   is known, and long enough for the meeting (`freeWindows`). Its edges sit
 *   on the quarter hour. Each window carries a fit note from a fixed
 *   vocabulary that every meeting inside it meets (`fitOf`), so a window is
 *   split where the fit changes. The agent picks the times; the host only
 *   says which are free. Only protected time is hard (`inProtectedTime`), so
 *   a time someone proposes is checked against it too.
 */
import {
  type PreferenceValue,
  type PreferredTimePreference,
  type SchedulingPreferenceValues,
  type Weekday,
} from '../gws-ea-preferences/db.js';
import { identityMatchKey } from '../../gws-ea/validation.js';
import type { EventAttendee, ListedEvent } from './calendar-api.js';

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

/** Free windows start and end on the quarter hour. */
const EDGE_MINUTES = 15;
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

const pad = (value: number, width = 2): string => String(value).padStart(width, '0');

/**
 * An instant as ISO-8601 on `timezone`'s clock with its UTC offset, such as
 * 2026-10-06T07:00-04:00: how an agent reads a time and gives it back to a
 * tool. Seconds appear only when the instant has them.
 */
export function zonedIso(instant: number, timezone: string): string {
  const wall = wallClock(instant, timezone);
  const offset = Math.round(zoneOffset(instant, timezone) / MINUTE);
  const milliseconds = ((instant % 1000) + 1000) % 1000;
  const seconds =
    wall.second === 0 && milliseconds === 0
      ? ''
      : `:${pad(wall.second)}${milliseconds === 0 ? '' : `.${pad(milliseconds, 3)}`}`;
  const sign = offset < 0 ? '-' : '+';
  return (
    `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}T${pad(wall.hour)}:${pad(wall.minute)}${seconds}` +
    `${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`
  );
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
export function eventSpan(event: Pick<ListedEvent, 'start' | 'end'>, timezone: string): Span | undefined {
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

/** How strongly an answer commits the principal; the strongest across their addresses stands. */
const ANSWER_RANK: Readonly<Record<string, number>> = { accepted: 3, tentative: 2, needsAction: 1, declined: 0 };

/** Whether an address reaches one of the principal's mailboxes, in any spelling Gmail delivers to them. */
export function isPrincipalAddress(email: string | undefined, principal: ReadonlySet<string>): boolean {
  if (email === undefined) return false;
  const key = identityMatchKey(`email:${email}`);
  for (const address of principal) if (identityMatchKey(`email:${address}`) === key) return true;
  return false;
}

/** Whether a guest-list entry speaks for the principal on this copy: the calendar's own entry, or one of their addresses. */
export function isPrincipalAttendee(attendee: EventAttendee, principal: ReadonlySet<string>): boolean {
  return attendee.self === true || isPrincipalAddress(attendee.email, principal);
}

/**
 * The principal's answer on one copy of an event: the entry for the
 * calendar it sits on decides when there is one; otherwise their strongest
 * answer from any of their addresses.
 */
export function principalAnswer(
  event: { readonly attendees?: readonly EventAttendee[] },
  principal: ReadonlySet<string>,
): string | undefined {
  const attendees = event.attendees ?? [];
  const own = attendees.find((attendee) => attendee.self === true);
  if (own) return own.responseStatus;
  return strongestAnswer(
    attendees
      .filter((attendee) => isPrincipalAddress(attendee.email, principal))
      .map((attendee) => attendee.responseStatus),
  );
}

/** The answer that commits the principal most, of several. */
export function strongestAnswer(answers: readonly (string | undefined)[]): string | undefined {
  let strongest: string | undefined;
  for (const answer of answers) {
    if (answer === undefined) continue;
    if (strongest === undefined || (ANSWER_RANK[answer] ?? -1) > (ANSWER_RANK[strongest] ?? -1)) strongest = answer;
  }
  return strongest;
}

/** Whether an event takes the principal's time: not cancelled, not free, not declined by them on its calendar. */
export function blocksTime(
  event: Pick<ListedEvent, 'status' | 'transparency' | 'attendees'>,
  principal: ReadonlySet<string>,
): boolean {
  if (event.status === 'cancelled' || event.transparency === 'transparent') return false;
  return principalAnswer(event, principal) !== 'declined';
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
  /** The counterpart's zone, when known: every window falls inside their waking day too. */
  readonly counterpartTimezone?: string;
  readonly lengthMinutes: number;
  /** Every window lies wholly inside it. */
  readonly window: Span;
  /** Time already taken on the principal's calendars. */
  readonly busy: readonly Span[];
  readonly rules: SchedulingRules;
}

/** A free window: every meeting of the asked length inside it is free, and fits at least as `fit` says. */
export interface FreeWindow extends Span {
  readonly fit: Fit;
}

/** The hours free time offers from on a weekday: the waking day, widened by working hours that reach past it. */
function offerHours(rules: SchedulingRules, weekday: Weekday): ClockRange {
  const working = rules.workingHours.get(weekday);
  return working
    ? { start: Math.min(working.start, WAKING_HOURS.start), end: Math.max(working.end, WAKING_HOURS.end) }
    : WAKING_HOURS;
}

/** `spans` with every part inside one of `cuts` removed. */
function without(spans: readonly Span[], cuts: readonly Span[]): Span[] {
  let left = [...spans];
  for (const cut of cuts) {
    left = left.flatMap((span) =>
      overlaps(span, cut)
        ? [
            ...(span.start < cut.start ? [{ start: span.start, end: cut.start }] : []),
            ...(cut.end < span.end ? [{ start: cut.end, end: span.end }] : []),
          ]
        : [span],
    );
  }
  return left;
}

/** The parts of `spans` inside one of `keep`. */
function within(spans: readonly Span[], keep: readonly Span[]): Span[] {
  return spans.flatMap((span) =>
    keep.flatMap((kept) =>
      overlaps(span, kept) ? [{ start: Math.max(span.start, kept.start), end: Math.min(span.end, kept.end) }] : [],
    ),
  );
}

/** The waking days on `timezone`'s clock that meet `span`. */
function wakingDays(span: Span, timezone: string): Span[] {
  const days: Span[] = [];
  const last = localTime(span.end, timezone);
  for (let date: LocalDate = localTime(span.start, timezone); compareDates(date, last) <= 0; date = nextDate(date)) {
    days.push(onDay(date, WAKING_HOURS, timezone));
  }
  return days;
}

/** A free run with its edges moved inward to the quarter hour; every zone in use keeps quarter hours on its clock. */
function onQuarterHours(span: Span): Span {
  const quarter = EDGE_MINUTES * MINUTE;
  return { start: Math.ceil(span.start / quarter) * quarter, end: Math.floor(span.end / quarter) * quarter };
}

/**
 * A free run split where its fit changes, at the day's working hours and
 * preferred times. A piece too short for the meeting cannot hold one at its
 * own fit, so it joins a neighbour whose fit the joining leaves as it was,
 * the better fitting one first, and goes when no neighbour takes it; then
 * neighbours that fit alike as one become one. Every window is labeled with
 * the fit of the window as a whole, which every meeting inside it meets.
 */
function byFit(run: Span, date: LocalDate, rules: SchedulingRules, timezone: string, length: number): FreeWindow[] {
  const weekday = weekdayOf(date);
  const hours = rules.workingHours.get(weekday);
  const ranges: ClockRange[] = [
    ...(hours === undefined ? [] : [hours]),
    ...rules.preferredTimes.filter((window) => window.weekdays.has(weekday)),
  ];
  const cuts = new Set<number>();
  for (const range of ranges) {
    const { start, end } = onDay(date, range, timezone);
    for (const cut of [start, end]) if (cut > run.start && cut < run.end) cuts.add(cut);
  }
  const points = [run.start, ...[...cuts].sort((a, b) => a - b), run.end];
  const fitted = (span: Span): FreeWindow => ({ ...span, fit: fitOf(span, rules, timezone) });
  const rank = (fit: Fit): number => FITS.indexOf(fit);
  /** `pieces[first]` and the one after it as one window, when that leaves `keep`'s fit as it was. */
  const join = (pieces: readonly FreeWindow[], first: number, keep: FreeWindow): FreeWindow | undefined => {
    const joined = fitted({ start: pieces[first].start, end: pieces[first + 1].end });
    return joined.fit === keep.fit ? joined : undefined;
  };

  let pieces = points.slice(1).map((end, index) => fitted({ start: points[index], end }));
  for (;;) {
    const short = pieces.findIndex((piece) => piece.end - piece.start < length);
    if (short < 0) break;
    const [best] = [short - 1, short + 1]
      .filter((index) => index >= 0 && index < pieces.length)
      .flatMap((index) => {
        const first = Math.min(index, short);
        const window = join(pieces, first, pieces[index]);
        return window === undefined ? [] : [{ first, window }];
      })
      .sort((a, b) => rank(a.window.fit) - rank(b.window.fit));
    pieces =
      best === undefined
        ? pieces.filter((_, index) => index !== short)
        : [...pieces.slice(0, best.first), best.window, ...pieces.slice(best.first + 2)];
  }
  const merged: FreeWindow[] = [];
  for (const piece of pieces) {
    const last = merged.at(-1);
    const joined = last !== undefined && last.end === piece.start ? join([last, piece], 0, piece) : undefined;
    if (joined !== undefined && joined.fit === last?.fit) merged[merged.length - 1] = joined;
    else merged.push(piece);
  }
  return merged;
}

/**
 * Every free window in the range: in the hours free time offers from, inside
 * the counterpart's waking day when their zone is known, from the range's
 * start on, clear of protected time and of busy time by the buffer, on the
 * quarter hour, long enough for the meeting, and split where the fit
 * changes. Listed in date order.
 */
export function freeWindows(query: FreeTimeQuery): FreeWindow[] {
  const { timezone, counterpartTimezone, rules, window } = query;
  const length = query.lengthMinutes * MINUTE;
  const buffer = rules.bufferMinutes * MINUTE;
  const taken = query.busy.map((span) => ({ start: span.start - buffer, end: span.end + buffer }));
  const windows: FreeWindow[] = [];
  const last = localTime(window.end, timezone);
  for (let date: LocalDate = localTime(window.start, timezone); compareDates(date, last) <= 0; date = nextDate(date)) {
    const weekday = weekdayOf(date);
    let open = within([onDay(date, offerHours(rules, weekday), timezone)], [window]);
    if (counterpartTimezone !== undefined) {
      open = open.flatMap((span) => within([span], wakingDays(span, counterpartTimezone)));
    }
    const protectedTime = rules.protectedWindows
      .filter((protectedWindow) => protectedWindow.weekdays.has(weekday))
      .map((protectedWindow) => onDay(date, protectedWindow, timezone));
    for (const run of without(without(open, protectedTime), taken).map(onQuarterHours)) {
      if (run.end - run.start >= length) windows.push(...byFit(run, date, rules, timezone, length));
    }
  }
  return windows.sort((a, b) => a.start - b.start);
}

/** One day, in milliseconds: how far calendar reads widen so all-day events are seen whole. */
export const READ_MARGIN_MS = DAY_MS;
