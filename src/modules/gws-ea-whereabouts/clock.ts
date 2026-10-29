/** Dependency-free wall-clock arithmetic shared by whereabouts and scheduling. */
export interface LocalDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}
const MINUTE = 60_000;

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

export interface WallClock extends LocalDate {
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

export function wallClock(instant: number, timezone: string): WallClock {
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

/** Milliseconds the zone's clock runs ahead of UTC at `instant`. */
function zoneOffset(instant: number, timezone: string): number {
  const wall = wallClock(instant, timezone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

const pad = (value: number, width = 2): string => String(value).padStart(width, '0');

/**
 * Such as 2026-10-06T07:00-04:00: how an agent reads a time and gives it back
 * to a tool. Seconds appear only when the instant has them.
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

/** A time the clocks repeat takes its later occurrence; a time they skip lands just after the change. */
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

export function dateString(date: LocalDate): string {
  return `${String(date.year).padStart(4, '0')}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
}

export function parseDate(value: string): LocalDate {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) throw new Error('Use a date YYYY-MM-DD or an instant with an explicit UTC offset');
  const date = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  const check = new Date(Date.UTC(date.year, date.month - 1, date.day));
  if (check.getUTCFullYear() !== date.year || check.getUTCMonth() + 1 !== date.month || check.getUTCDate() !== date.day)
    throw new Error(`Invalid date ${value}`);
  return date;
}

export function nextDate(date: LocalDate): LocalDate {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + 1));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

export function isDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/u.test(value);
}

/** Dates include their last day; instants use an exclusive end. */
export function boundary(value: string, zone: string, edge: 'start' | 'end'): number {
  if (isDate(value)) {
    const date = parseDate(value);
    return zonedInstant(edge === 'end' ? nextDate(date) : date, 0, zone);
  }
  if (!/T.*(?:Z|[+-]\d{2}:\d{2})$/u.test(value) || !Number.isFinite(Date.parse(value)))
    throw new Error(`Invalid instant ${value}: include a UTC offset`);
  return Date.parse(value);
}
