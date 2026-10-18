const ISO_TIME = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2})))?$/u;

/**
 * An agent-supplied ISO date, or date and time with an explicit UTC offset, that
 * names a real calendar moment: dates come back as written, times in UTC.
 * `Date.parse` alone moves impossible values instead of refusing them
 * (February 30 becomes March 2), which would silently shift a delegated bound.
 */
export function readIsoTime(value: unknown, time: 'optional' | 'required'): string | undefined {
  const match = typeof value === 'string' ? ISO_TIME.exec(value) : null;
  if (!match || (time === 'required' && match[4] === undefined)) return undefined;
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] = match
    .slice(1)
    .map((part) => Number(part ?? 0));
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  )
    return undefined;
  return match[4] === undefined ? match[0] : new Date(match[0]).toISOString();
}

const wallFormats = new Map<string, Intl.DateTimeFormat>();
/** The wall time `at` shows on the clock of IANA `timeZone`, written as if it were UTC. */
function wallClock(at: number, timeZone: string): number {
  let format = wallFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    wallFormats.set(timeZone, format);
  }
  const parts = format.formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((entry) => entry.type === type)?.value);
  return (
    Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second')) +
    (((at % 1000) + 1000) % 1000)
  );
}
/** The calendar date `at` falls on, on the clock of IANA `timeZone`, as YYYY-MM-DD. */
export function zonedDate(at: number, timeZone: string): string {
  return new Date(wallClock(at, timeZone)).toISOString().slice(0, 10);
}
/**
 * The instant a wall time (`YYYY-MM-DDTHH:MM:SS[.mmm]`, no offset) names on the clock of
 * IANA `timeZone`, or NaN for no such time. A wall time a daylight-saving change skips
 * moves forward with the clock (02:30 on a spring-forward night reads 03:30); one the
 * change repeats is its first occurrence.
 */
export function zonedInstant(wall: string, timeZone: string): number {
  const local = Date.parse(`${wall}Z`);
  if (!Number.isFinite(local)) return NaN;
  // The offsets either side of any change near this wall time.
  const offset = (at: number): number => wallClock(at, timeZone) - at;
  const before = local - offset(local - 86_400_000);
  const after = local - offset(local + 86_400_000);
  const exact = [before, after].filter((at) => wallClock(at, timeZone) === local);
  return exact.length ? Math.min(...exact) : before;
}
