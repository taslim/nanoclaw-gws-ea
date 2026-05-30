/**
 * Time MCP tools: time_now, time_resolve, time_convert, time_diff, time_range.
 *
 * LLMs miscompute date math; these tools make it deterministic. Output is in
 * TIMEZONE unless time_convert is used.
 */
import * as chrono from 'chrono-node';
import { DateTime, Duration } from 'luxon';

import { TIMEZONE, isValidTimezone } from '../timezone.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const MAX_RANGE_DAYS = 60;
const MAX_SLOTS = 1000;
const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

interface FormattedDt {
  iso: string;
  formatted: string;
  day: string;
  zone: string;
}

function formatDt(dt: DateTime): FormattedDt {
  return {
    iso: dt.toISO()!,
    formatted: dt.toFormat('EEE, MMM d yyyy h:mm a ZZZZ'),
    day: dt.toFormat('EEEE'),
    zone: dt.zoneName!,
  };
}

function parseNatural(expression: string, referenceDate?: string, zone?: string): DateTime | null {
  const tz = zone || TIMEZONE;
  const refDt = referenceDate ? DateTime.fromISO(referenceDate, { zone: tz }) : DateTime.now().setZone(tz);
  if (!refDt.isValid) return null;

  const results = chrono.parse(expression, refDt.toJSDate(), { forwardDate: true });
  if (results.length === 0) return null;

  const parsed = results[0].start;
  const jsDate = parsed.date();

  // chrono-node returns a JS Date in system local time. If chrono didn't see
  // an explicit zone in the input, re-anchor the wall-clock fields to `tz`.
  if (!parsed.isCertain('timezoneOffset')) {
    return DateTime.fromObject(
      {
        year: jsDate.getFullYear(),
        month: jsDate.getMonth() + 1,
        day: jsDate.getDate(),
        hour: jsDate.getHours(),
        minute: jsDate.getMinutes(),
        second: jsDate.getSeconds(),
      },
      { zone: tz },
    );
  }
  return DateTime.fromJSDate(jsDate).setZone(tz);
}

/**
 * Parse `input` as ISO first (cheap), falling back to natural language only on
 * failure. Returns an invalid DateTime on total failure so callers can branch
 * on `.isValid` uniformly. Skipping chrono on clean ISO input avoids loading
 * its regex tables on the happy path.
 */
function parseFlexible(input: string, zone: string = TIMEZONE): DateTime {
  const iso = DateTime.fromISO(input, { zone });
  if (iso.isValid) return iso;
  const nat = parseNatural(input, undefined, zone);
  return nat ?? DateTime.invalid('unparseable');
}

/**
 * Closed-form weekday count between two days (in either order). Bounds the
 * remainder loop to at most 6 iterations regardless of range size.
 */
function countBusinessDays(start: DateTime, end: DateTime): number {
  const [s, e] = start <= end ? [start.startOf('day'), end.startOf('day')] : [end.startOf('day'), start.startOf('day')];
  const totalDays = Math.round(e.diff(s, 'days').days);
  const weeks = Math.floor(totalDays / 7);
  const remainder = totalDays - weeks * 7;
  let count = weeks * 5;
  for (let i = 0; i < remainder; i++) {
    const dow = ((s.weekday - 1 + i) % 7) + 1;
    if (dow >= 1 && dow <= 5) count++;
  }
  return count;
}

function humanDuration(dur: Duration): string {
  const shifted = dur.shiftTo('years', 'months', 'weeks', 'days', 'hours', 'minutes');
  const parts: string[] = [];
  const add = (val: number, unit: string) => {
    const rounded = Math.floor(Math.abs(val));
    if (rounded > 0) parts.push(`${rounded} ${unit}${rounded !== 1 ? 's' : ''}`);
  };
  add(shifted.years, 'year');
  add(shifted.months, 'month');
  add(shifted.weeks, 'week');
  add(shifted.days, 'day');
  add(shifted.hours, 'hour');
  add(shifted.minutes, 'minute');
  if (parts.length === 0) return 'less than a minute';
  if (parts.length === 1) return parts[0];
  return parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function jsonOk(value: unknown) {
  return ok(JSON.stringify(value, null, 2));
}

export const timeNow: McpToolDefinition = {
  tool: {
    name: 'time_now',
    description: 'Get the current date, time, and day of week in the primary timezone.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  async handler() {
    const dt = DateTime.now().setZone(TIMEZONE);
    return jsonOk({ ...formatDt(dt), unix: Math.floor(dt.toSeconds()) });
  },
};

export const timeResolve: McpToolDefinition = {
  tool: {
    name: 'time_resolve',
    description:
      'Parse a natural language date/time expression into a structured date in the primary timezone. Examples: "next Thursday 2pm", "March 15", "in 3 weeks".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        expression: { type: 'string', description: 'Natural language date/time expression' },
        reference_date: { type: 'string', description: 'ISO date to resolve relative to (defaults to now)' },
      },
      required: ['expression'],
    },
  },
  async handler(args) {
    const expression = args.expression as string;
    const referenceDate = args.reference_date as string | undefined;
    if (!expression) return err('expression is required');

    const dt = parseNatural(expression, referenceDate);
    if (!dt || !dt.isValid) {
      return err(
        `Could not parse "${expression}". Try a clearer expression like "next Tuesday 3pm" or "March 15 2026".`,
      );
    }
    return jsonOk({ expression, resolved: formatDt(dt) });
  },
};

export const timeConvert: McpToolDefinition = {
  tool: {
    name: 'time_convert',
    description: 'Convert a time between timezones. Defaults `to` to the primary timezone.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        time: {
          type: 'string',
          description: 'Time to convert — ISO string or natural language (e.g. "2pm PT", "2026-03-15T14:00")',
        },
        from: {
          type: 'string',
          description: 'Source IANA timezone (e.g. "America/Los_Angeles"). Defaults to primary timezone.',
        },
        to: {
          type: 'array',
          items: { type: 'string' },
          description: 'Target IANA timezones. Defaults to [primary timezone].',
        },
      },
      required: ['time'],
    },
  },
  async handler(args) {
    const time = args.time as string;
    const fromZone = (args.from as string | undefined) || TIMEZONE;
    const targetZones = (args.to as string[] | undefined) || [TIMEZONE];
    if (!time) return err('time is required');

    if (!isValidTimezone(fromZone)) {
      return err(`Invalid source timezone: "${fromZone}". Use IANA format like "America/New_York".`);
    }
    const invalid = targetZones.find((tz) => !isValidTimezone(tz));
    if (invalid) return err(`Invalid target timezone: "${invalid}". Use IANA format like "America/New_York".`);

    const dt = parseFlexible(time, fromZone);
    if (!dt.isValid) {
      return err(`Could not parse "${time}". Try ISO format "2026-03-15T14:00" or natural language "2pm".`);
    }

    const conversions: Record<string, FormattedDt> = {};
    for (const zone of targetZones) conversions[zone] = formatDt(dt.setZone(zone));
    return jsonOk({ input: time, source: formatDt(dt), conversions });
  },
};

export const timeDiff: McpToolDefinition = {
  tool: {
    name: 'time_diff',
    description: 'Calculate the gap between two dates. Defaults `from` to now.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        from: { type: 'string', description: 'Start date — ISO or natural language (defaults to now)' },
        to: { type: 'string', description: 'End date — ISO or natural language' },
      },
      required: ['to'],
    },
  },
  async handler(args) {
    const fromIn = args.from as string | undefined;
    const toIn = args.to as string;
    if (!toIn) return err('to is required');

    const fromDt = fromIn ? parseFlexible(fromIn) : DateTime.now().setZone(TIMEZONE);
    const toDt = parseFlexible(toIn);

    if (!fromDt.isValid) return err(`Could not parse "from" date: "${fromIn}".`);
    if (!toDt.isValid) return err(`Could not parse "to" date: "${toIn}".`);

    const dur = toDt.diff(fromDt, ['years', 'months', 'weeks', 'days', 'hours', 'minutes']);
    const totalDays = toDt.diff(fromDt, 'days').days;
    const businessDays = countBusinessDays(fromDt, toDt);
    const isPast = totalDays < 0;

    return jsonOk({
      from: formatDt(fromDt),
      to: formatDt(toDt),
      direction: isPast ? 'past' : 'future',
      calendar_days: Math.round(Math.abs(totalDays)),
      business_days: businessDays,
      human: humanDuration(dur),
      breakdown: {
        years: Math.abs(Math.floor(dur.years)),
        months: Math.abs(Math.floor(dur.months)),
        weeks: Math.abs(Math.floor(dur.weeks)),
        days: Math.abs(Math.floor(dur.days)),
        hours: Math.abs(Math.floor(dur.hours)),
        minutes: Math.abs(Math.floor(dur.minutes)),
      },
    });
  },
};

interface SlotEmitContext {
  startH: number;
  startM: number;
  endH: number;
  endM: number;
  interval: number;
  fromDt: DateTime;
  toDt: DateTime;
}

type Slot = { date: string; day: string; time?: string; iso: string };

function fullDaySlot(cursor: DateTime): Slot {
  return {
    date: cursor.toFormat('EEE, MMM d yyyy'),
    day: cursor.toFormat('EEEE'),
    iso: cursor.toISO()!,
  };
}

function windowedSlots(cursor: DateTime, ctx: SlotEmitContext): Slot[] {
  const { startH, startM, endH, endM, interval, fromDt, toDt } = ctx;
  let slotTime = cursor.set({ hour: startH, minute: startM, second: 0 });
  const endTime = cursor.set({ hour: endH, minute: endM, second: 0 });
  if (slotTime < fromDt) slotTime = fromDt;
  const clippedEnd = endTime > toDt ? toDt : endTime;
  const out: Slot[] = [];
  while (slotTime < clippedEnd) {
    out.push({
      date: slotTime.toFormat('EEE, MMM d'),
      day: slotTime.toFormat('EEEE'),
      time: slotTime.toFormat('h:mm a'),
      iso: slotTime.toISO()!,
    });
    slotTime = slotTime.plus({ minutes: interval });
  }
  return out;
}

export const timeRange: McpToolDefinition = {
  tool: {
    name: 'time_range',
    description: 'List date/time slots in a window (e.g. "weekdays next week 9-5 hourly").',
    inputSchema: {
      type: 'object' as const,
      properties: {
        from: { type: 'string', description: 'Start date — ISO or natural language' },
        to: { type: 'string', description: 'End date — ISO or natural language' },
        time_start: {
          type: 'string',
          description: 'Daily start time in HH:mm (e.g. "09:00"). If omitted, returns full days.',
        },
        time_end: {
          type: 'string',
          description: 'Daily end time in HH:mm (e.g. "17:00"). Required if time_start is set.',
        },
        interval_minutes: {
          type: 'number',
          minimum: 1,
          description: 'Interval between slots in minutes (default 60). Only used when time_start/time_end are set.',
        },
        weekdays_only: { type: 'boolean', description: 'If true, exclude weekends (default false)' },
      },
      required: ['from', 'to'],
    },
  },
  async handler(args) {
    const fromIn = args.from as string;
    const toIn = args.to as string;
    if (!fromIn || !toIn) return err('from and to are required');

    const timeStart = args.time_start as string | undefined;
    const timeEnd = args.time_end as string | undefined;
    const interval = (args.interval_minutes as number | undefined) || 60;
    const weekdaysOnly = (args.weekdays_only as boolean | undefined) || false;

    if (timeStart && !timeEnd) return err('time_end is required when time_start is set.');
    if (timeStart && !HH_MM.test(timeStart)) {
      return err(`Invalid time_start "${timeStart}". Use HH:mm format (e.g. "09:00").`);
    }
    if (timeEnd && !HH_MM.test(timeEnd)) {
      return err(`Invalid time_end "${timeEnd}". Use HH:mm format (e.g. "17:00").`);
    }

    const fromDt = parseFlexible(fromIn);
    const toDt = parseFlexible(toIn);
    if (!fromDt.isValid) return err(`Could not parse "from": "${fromIn}".`);
    if (!toDt.isValid) return err(`Could not parse "to": "${toIn}".`);

    const daySpan = toDt.diff(fromDt, 'days').days;
    if (daySpan < 0) return err('"to" must be after "from".');
    if (daySpan > MAX_RANGE_DAYS) {
      return err(`Range too large (${Math.round(daySpan)} days). Maximum is ${MAX_RANGE_DAYS} days.`);
    }

    const hasTimeWindow = timeStart !== undefined;
    const ctx: SlotEmitContext | null = hasTimeWindow
      ? (() => {
          const [startH, startM] = timeStart!.split(':').map(Number);
          const [endH, endM] = timeEnd!.split(':').map(Number);
          return { startH, startM, endH, endM, interval, fromDt, toDt };
        })()
      : null;

    const slots: Slot[] = [];
    let cursor = fromDt.startOf('day');
    const endDay = toDt.startOf('day');

    while (cursor <= endDay) {
      const dow = cursor.weekday;
      const skipWeekend = weekdaysOnly && (dow < 1 || dow > 5);
      if (!skipWeekend) {
        const next = ctx ? windowedSlots(cursor, ctx) : [fullDaySlot(cursor)];
        slots.push(...next);
        if (slots.length >= MAX_SLOTS) {
          return err(
            `Too many slots (>${MAX_SLOTS}). Narrow the range, increase the interval, or use weekdays_only.`,
          );
        }
      }
      cursor = cursor.plus({ days: 1 });
    }

    return jsonOk({
      from: formatDt(fromDt),
      to: formatDt(toDt),
      weekdays_only: weekdaysOnly,
      time_window: hasTimeWindow ? `${timeStart}–${timeEnd}` : null,
      interval_minutes: hasTimeWindow ? interval : null,
      count: slots.length,
      slots,
    });
  },
};

registerTools([timeNow, timeResolve, timeConvert, timeDiff, timeRange]);
