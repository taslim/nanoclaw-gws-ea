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
