/**
 * The host's free-time arithmetic. Pure functions: no store, no Google, no
 * clock of their own. Wall-clock times become instants through the zone, so
 * a day with a clock change is 23 or 25 hours long.
 *
 * Protected time is a fit note, not a wall: the agent picks the times, and
 * judges who is worth bending a preference for; the host only says which
 * are free.
 */
import {
  type PreferenceValue,
  type PreferredTimePreference,
  type SchedulingPreferenceValues,
  type Weekday,
} from '../gws-ea-preferences/db.js';
import type { PrincipalRecognizer } from '../gws-ea-profile/db.js';
import type { EventAttendee, ListedEvent } from './calendar-api.js';
import { wallClock, zonedInstant, type LocalDate } from '../gws-ea-whereabouts/clock.js';
export { iso, zonedInstant, zonedIso, type LocalDate } from '../gws-ea-whereabouts/clock.js';

/** An interval of instants, in milliseconds since the epoch; `end` is exclusive. */
export interface Span {
  readonly start: number;
  readonly end: number;
}

/** Minutes since local midnight; `end` may be 1440, the next midnight. */
export interface ClockRange {
  readonly start: number;
  readonly end: number;
}

export interface WeeklyRange extends ClockRange {
  readonly weekdays: ReadonlySet<Weekday>;
}

export interface SchedulingRules {
  /** Hours per weekday; a weekday without hours is not a working day. */
  readonly workingHours: ReadonlyMap<Weekday, ClockRange>;
  readonly protectedWindows: readonly WeeklyRange[];
  readonly preferredTimes: readonly WeeklyRange[];
  readonly bufferMinutes: number;
}

const EDGE_MINUTES = 15;
/** Free time keeps to the waking day on either side's clock, widened on the principal's by their working hours. */
const WAKING_HOURS: ClockRange = { start: 7 * 60, end: 22 * 60 };
/** Used while the principal has set no working hours. */
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

/** `24:00` is allowed, as 1440: a range ending at the next midnight. */
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

/** An all-day event covers its whole local days in `timezone`; undefined when Google gives no readable time. */
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

export function isPrincipalAttendee(attendee: EventAttendee, principal: PrincipalRecognizer): boolean {
  return attendee.self === true || principal.has(attendee.email);
}

export function principalAnswer(
  event: { readonly attendees?: readonly EventAttendee[] },
  principal: PrincipalRecognizer,
): string | undefined {
  const attendees = event.attendees ?? [];
  const own = attendees.find((attendee) => attendee.self === true);
  if (own) return own.responseStatus;
  return strongestAnswer(
    attendees.filter((attendee) => principal.has(attendee.email)).map((attendee) => attendee.responseStatus),
  );
}

export function strongestAnswer(answers: readonly (string | undefined)[]): string | undefined {
  let strongest: string | undefined;
  for (const answer of answers) {
    if (answer === undefined) continue;
    if (strongest === undefined || (ANSWER_RANK[answer] ?? -1) > (ANSWER_RANK[strongest] ?? -1)) strongest = answer;
  }
  return strongest;
}

/** The one rule every read of the principal's busy time uses. */
export function blocksTime(
  event: Pick<ListedEvent, 'id' | 'status' | 'transparency' | 'attendees'>,
  principal: PrincipalRecognizer,
  ignoredPrefixes: readonly string[] = [],
): boolean {
  if (event.id !== undefined && ignoredPrefixes.some((prefix) => prefix.length > 0 && event.id?.startsWith(prefix)))
    return false;
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

export function schedulingRules(values: SchedulingPreferenceValues, kind = DEFAULT_MEETING_KIND): SchedulingRules {
  const workingHours = new Map<Weekday, ClockRange>();
  for (const day of values.working_hours) {
    if (day.off) continue;
    const range = clockRange(day.start, day.end);
    if (range) workingHours.set(day.weekday, range);
  }
  const chosen = values.preferred_times.filter((value) => value.meeting_kind === kind);
  const preferred: readonly PreferenceValue<PreferredTimePreference>[] =
    chosen.length > 0 ? chosen : values.preferred_times.filter((value) => value.meeting_kind === DEFAULT_MEETING_KIND);
  return {
    workingHours: values.working_hours.length === 0 ? DEFAULT_WORKING_HOURS : workingHours,
    protectedWindows: values.protected_windows.flatMap((value) => weekly(value) ?? []),
    preferredTimes: preferred.flatMap((value) => weekly(value) ?? []),
    bufferMinutes:
      (
        values.buffers.find((value) => value.meeting_kind === kind) ??
        values.buffers.find((value) => value.meeting_kind === DEFAULT_MEETING_KIND)
      )?.minutes ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Busy and protected time
// ---------------------------------------------------------------------------

function overlaps(a: Span, b: Span): boolean {
  return a.start < b.end && a.end > b.start;
}

function onDay(date: LocalDate, range: ClockRange, timezone: string): Span {
  return { start: zonedInstant(date, range.start, timezone), end: zonedInstant(date, range.end, timezone) };
}

function inProtectedTime(span: Span, rules: SchedulingRules, timezone: string): boolean {
  const last = localTime(span.end - 1, timezone);
  for (let date: LocalDate = localTime(span.start, timezone); compareDates(date, last) <= 0; date = nextDate(date)) {
    const weekday = weekdayOf(date);
    for (const window of rules.protectedWindows) {
      if (window.weekdays.has(weekday) && overlaps(span, onDay(date, window, timezone))) return true;
    }
  }
  return false;
}

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

function insideWorkingHours(slot: Span, rules: SchedulingRules, timezone: string): boolean {
  const local = localTime(slot.start, timezone);
  const hours = rules.workingHours.get(local.weekday);
  if (!hours) return false;
  const day = onDay(local, hours, timezone);
  return slot.start >= day.start && slot.end <= day.end;
}

// ---------------------------------------------------------------------------
// Free time
// ---------------------------------------------------------------------------

/** How a time sits against the principal's preferences, best first: the only words free time says of them. */
export const FITS = ['preferred', 'acceptable', 'outside usual hours', 'protected time'] as const;
export type Fit = (typeof FITS)[number];

export function fitOf(span: Span, rules: SchedulingRules, timezone: string): Fit {
  if (inProtectedTime(span, rules, timezone)) return 'protected time';
  if (insidePreferred(span, rules, timezone)) return 'preferred';
  return insideWorkingHours(span, rules, timezone) ? 'acceptable' : 'outside usual hours';
}

export interface FreeTimeQuery {
  readonly timezone: string;
  /** A stay kept on home hours still offers the waking day on its local clock. */
  readonly rulesTimezone?: string;
  /** The counterpart's zone, when known: every window falls inside their waking day too. */
  readonly counterpartTimezone?: string;
  readonly lengthMinutes: number;
  /** Every window lies wholly inside it. */
  readonly window: Span;
  readonly busy: readonly Span[];
  readonly rules: SchedulingRules;
}

/** A free window: every meeting of the asked length inside it is free, and fits at least as `fit` says. */
export interface FreeWindow extends Span {
  readonly fit: Fit;
}

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
 * A free run split where its fit changes, at the day's working hours,
 * preferred times and protected windows. A piece too short for the meeting
 * cannot hold one at its own fit, so it joins a neighbour when the joined
 * window keeps the fit of either, the better fitting join first, and goes
 * when none does; then neighbours that fit alike as one become one. Every
 * window is labeled with the fit of the window as a whole, which every
 * meeting inside it meets.
 */
function byFit(run: Span, rules: SchedulingRules, timezone: string, length: number): FreeWindow[] {
  const cuts = new Set<number>();
  const lastDate = localTime(run.end - 1, timezone);
  for (let date: LocalDate = localTime(run.start, timezone); compareDates(date, lastDate) <= 0; date = nextDate(date)) {
    const weekday = weekdayOf(date);
    const hours = rules.workingHours.get(weekday);
    const ranges: ClockRange[] = [
      ...(hours === undefined ? [] : [hours]),
      ...rules.preferredTimes.filter((window) => window.weekdays.has(weekday)),
      ...rules.protectedWindows.filter((window) => window.weekdays.has(weekday)),
    ];
    for (const range of ranges) {
      const { start, end } = onDay(date, range, timezone);
      for (const cut of [start, end]) if (cut > run.start && cut < run.end) cuts.add(cut);
    }
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
        const window = join(pieces, first, pieces[index]) ?? join(pieces, first, pieces[short]);
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
    for (const run of without(open, taken).map(onQuarterHours)) {
      if (run.end - run.start >= length) windows.push(...byFit(run, rules, query.rulesTimezone ?? timezone, length));
    }
  }
  return windows.sort((a, b) => a.start - b.start);
}

/** How far calendar reads widen so all-day events are seen whole. */
export const READ_MARGIN_MS = DAY_MS;
