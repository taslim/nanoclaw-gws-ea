/**
 * Time MCP Server for NanoClaw
 * Standalone stdio server for date math, timezone conversions, and NL date parsing.
 * LLMs are unreliable at date math — this makes "compute, don't guess" the default.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { DateTime, Duration, IANAZone } from 'luxon';
import * as chrono from 'chrono-node';

const PRIMARY_TZ = process.env.NANOCLAW_PRIMARY_TIMEZONE || 'America/Los_Angeles';

const TIMEZONE_LABELS: Record<string, string> = {
  'America/Los_Angeles': 'PT',
  'America/New_York': 'ET',
  'America/Chicago': 'CT',
  'America/Denver': 'MT',
  'UTC': 'UTC',
  'Europe/London': 'GMT',
  'Europe/Paris': 'CET',
  'Asia/Tokyo': 'JST',
  'Africa/Lagos': 'WAT',
};

const DEFAULT_CONVERT_ZONES = ['America/Los_Angeles', 'America/New_York', 'UTC'];

function tzLabel(zone: string): string {
  return TIMEZONE_LABELS[zone] || zone;
}

function formatDt(dt: DateTime): { iso: string; formatted: string; day: string; zone: string; label: string } {
  return {
    iso: dt.toISO()!,
    formatted: dt.toFormat('EEE, MMM d yyyy h:mm a ZZZZ'),
    day: dt.toFormat('EEEE'),
    zone: dt.zoneName!,
    label: tzLabel(dt.zoneName!),
  };
}

/**
 * Parse natural language date/time using chrono-node.
 * Anchors to `zone` (defaults to PRIMARY_TZ) so "2pm" means 2pm in that zone.
 */
function parseNatural(expression: string, referenceDate?: string, zone?: string): DateTime | null {
  const tz = zone || PRIMARY_TZ;
  const refDt = referenceDate
    ? DateTime.fromISO(referenceDate, { zone: tz })
    : DateTime.now().setZone(tz);

  if (!refDt.isValid) return null;

  const results = chrono.parse(expression, refDt.toJSDate(), { forwardDate: true });
  if (results.length === 0) return null;

  const parsed = results[0].start;
  const jsDate = parsed.date();

  // If chrono didn't detect a timezone, interpret in the anchor zone
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

function countBusinessDays(start: DateTime, end: DateTime): number {
  let count = 0;
  let cursor = start.startOf('day');
  const endDay = end.startOf('day');

  // Determine direction
  const forward = endDay >= cursor;
  while (forward ? cursor < endDay : cursor > endDay) {
    const dow = cursor.weekday; // 1=Mon, 7=Sun
    if (dow >= 1 && dow <= 5) count++;
    cursor = forward ? cursor.plus({ days: 1 }) : cursor.minus({ days: 1 });
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

const MAX_RANGE_DAYS = 60;

const server = new McpServer({
  name: 'time',
  version: '1.0.0',
});

// --- now ---
server.tool(
  'now',
  'Get the current date, time, and day of week. Call this before referencing "today", the current time, or day of week.',
  {},
  async () => {
    const dt = DateTime.now().setZone(PRIMARY_TZ);
    const primary = formatDt(dt);
    const conversions: Record<string, ReturnType<typeof formatDt>> = {};
    for (const zone of DEFAULT_CONVERT_ZONES) {
      if (zone !== PRIMARY_TZ) {
        conversions[tzLabel(zone)] = formatDt(dt.setZone(zone));
      }
    }

    const result = {
      ...primary,
      unix: Math.floor(dt.toSeconds()),
      conversions,
    };

    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

// --- resolve ---
server.tool(
  'resolve',
  'Parse a natural language date/time expression into a structured date. Examples: "next Thursday 2pm", "March 15", "in 3 weeks".',
  {
    expression: z.string().describe('Natural language date/time expression'),
    reference_date: z.string().optional().describe('ISO date to resolve relative to (defaults to now)'),
  },
  async (args) => {
    const dt = parseNatural(args.expression, args.reference_date);
    if (!dt || !dt.isValid) {
      return {
        content: [{ type: 'text' as const, text: `Could not parse "${args.expression}". Try a clearer expression like "next Tuesday 3pm" or "March 15 2026".` }],
        isError: true,
      };
    }

    const primary = formatDt(dt);
    const conversions: Record<string, ReturnType<typeof formatDt>> = {};
    for (const zone of DEFAULT_CONVERT_ZONES) {
      if (zone !== PRIMARY_TZ) {
        conversions[tzLabel(zone)] = formatDt(dt.setZone(zone));
      }
    }

    const result = {
      expression: args.expression,
      resolved: primary,
      conversions,
    };

    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

// --- convert ---
server.tool(
  'convert',
  'Convert a time between timezones. Defaults to showing PT, ET, and UTC.',
  {
    time: z.string().describe('Time to convert — ISO string or natural language (e.g. "2pm PT", "2026-03-15T14:00")'),
    from: z.string().optional().describe('Source IANA timezone (e.g. "America/Los_Angeles"). Defaults to primary timezone.'),
    to: z.array(z.string()).optional().describe('Target IANA timezones. Defaults to [PT, ET, UTC].'),
  },
  async (args) => {
    const fromZone = args.from || PRIMARY_TZ;

    if (!IANAZone.isValidZone(fromZone)) {
      return {
        content: [{ type: 'text' as const, text: `Invalid source timezone: "${fromZone}". Use IANA format like "America/New_York".` }],
        isError: true,
      };
    }

    // Try ISO parse first, then natural language anchored to fromZone
    let dt = DateTime.fromISO(args.time, { zone: fromZone });
    if (!dt.isValid) {
      const parsed = parseNatural(args.time, undefined, fromZone);
      if (parsed && parsed.isValid) {
        dt = parsed;
      }
    }

    if (!dt.isValid) {
      return {
        content: [{ type: 'text' as const, text: `Could not parse "${args.time}". Try ISO format "2026-03-15T14:00" or natural language "2pm".` }],
        isError: true,
      };
    }

    const targetZones = args.to || DEFAULT_CONVERT_ZONES;
    const invalidZone = targetZones.find(tz => !IANAZone.isValidZone(tz));
    if (invalidZone) {
      return {
        content: [{ type: 'text' as const, text: `Invalid target timezone: "${invalidZone}". Use IANA format like "America/New_York".` }],
        isError: true,
      };
    }

    const conversions: Record<string, ReturnType<typeof formatDt>> = {};
    for (const zone of targetZones) {
      conversions[tzLabel(zone)] = formatDt(dt.setZone(zone));
    }

    const result = {
      input: args.time,
      source: formatDt(dt),
      conversions,
    };

    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

// --- diff ---
server.tool(
  'diff',
  'Calculate the gap between two dates. Defaults "from" to now. Returns calendar duration, business days, and human-readable text.',
  {
    from: z.string().optional().describe('Start date — ISO or natural language (defaults to now)'),
    to: z.string().describe('End date — ISO or natural language'),
  },
  async (args) => {
    const fromDt = args.from ? (parseNatural(args.from) || DateTime.fromISO(args.from, { zone: PRIMARY_TZ })) : DateTime.now().setZone(PRIMARY_TZ);
    const toDt = parseNatural(args.to) || DateTime.fromISO(args.to, { zone: PRIMARY_TZ });

    if (!fromDt.isValid) {
      return { content: [{ type: 'text' as const, text: `Could not parse "from" date: "${args.from}".` }], isError: true };
    }
    if (!toDt.isValid) {
      return { content: [{ type: 'text' as const, text: `Could not parse "to" date: "${args.to}".` }], isError: true };
    }

    const dur = toDt.diff(fromDt, ['years', 'months', 'weeks', 'days', 'hours', 'minutes']);
    const totalDays = toDt.diff(fromDt, 'days').days;
    const businessDays = countBusinessDays(fromDt, toDt);
    const isPast = totalDays < 0;

    const result = {
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
    };

    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

// --- range ---
server.tool(
  'range',
  'List date/time slots in a window. Useful for "weekdays next week", "every hour from 9-5 on Monday", etc.',
  {
    from: z.string().describe('Start date — ISO or natural language'),
    to: z.string().describe('End date — ISO or natural language'),
    time_start: z.string().optional().describe('Daily start time in HH:mm (e.g. "09:00"). If omitted, returns full days.'),
    time_end: z.string().optional().describe('Daily end time in HH:mm (e.g. "17:00"). Required if time_start is set.'),
    interval_minutes: z.number().min(1).optional().describe('Interval between slots in minutes (default 60, minimum 1). Only used when time_start/time_end are set.'),
    weekdays_only: z.boolean().optional().describe('If true, exclude weekends (default false)'),
  },
  async (args) => {
    const fromDt = parseNatural(args.from) || DateTime.fromISO(args.from, { zone: PRIMARY_TZ });
    const toDt = parseNatural(args.to) || DateTime.fromISO(args.to, { zone: PRIMARY_TZ });

    if (!fromDt.isValid) {
      return { content: [{ type: 'text' as const, text: `Could not parse "from": "${args.from}".` }], isError: true };
    }
    if (!toDt.isValid) {
      return { content: [{ type: 'text' as const, text: `Could not parse "to": "${args.to}".` }], isError: true };
    }

    const daySpan = toDt.diff(fromDt, 'days').days;
    if (daySpan < 0) {
      return { content: [{ type: 'text' as const, text: '"to" must be after "from".' }], isError: true };
    }
    if (daySpan > MAX_RANGE_DAYS) {
      return { content: [{ type: 'text' as const, text: `Range too large (${Math.round(daySpan)} days). Maximum is ${MAX_RANGE_DAYS} days.` }], isError: true };
    }

    if (args.time_start && !args.time_end) {
      return { content: [{ type: 'text' as const, text: 'time_end is required when time_start is set.' }], isError: true };
    }

    const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (args.time_start && !HH_MM.test(args.time_start)) {
      return { content: [{ type: 'text' as const, text: `Invalid time_start "${args.time_start}". Use HH:mm format (e.g. "09:00").` }], isError: true };
    }
    if (args.time_end && !HH_MM.test(args.time_end)) {
      return { content: [{ type: 'text' as const, text: `Invalid time_end "${args.time_end}". Use HH:mm format (e.g. "17:00").` }], isError: true };
    }

    const hasTimeWindow = args.time_start !== undefined && args.time_end !== undefined;
    const interval = args.interval_minutes || 60;
    const weekdaysOnly = args.weekdays_only || false;
    const MAX_SLOTS = 1000;

    const slots: Array<{ date: string; day: string; time?: string; iso: string }> = [];
    let cursor = fromDt.startOf('day');
    const endDay = toDt.startOf('day');

    while (cursor <= endDay) {
      const dow = cursor.weekday;
      if (!weekdaysOnly || (dow >= 1 && dow <= 5)) {
        if (hasTimeWindow) {
          const [startH, startM] = args.time_start!.split(':').map(Number);
          const [endH, endM] = args.time_end!.split(':').map(Number);

          let slotTime = cursor.set({ hour: startH, minute: startM, second: 0 });
          const endTime = cursor.set({ hour: endH, minute: endM, second: 0 });

          while (slotTime < endTime) {
            slots.push({
              date: slotTime.toFormat('EEE, MMM d'),
              day: slotTime.toFormat('EEEE'),
              time: slotTime.toFormat('h:mm a'),
              iso: slotTime.toISO()!,
            });
            if (slots.length >= MAX_SLOTS) {
              return {
                content: [{ type: 'text' as const, text: `Too many slots (>${MAX_SLOTS}). Narrow the range, increase the interval, or use weekdays_only.` }],
                isError: true,
              };
            }
            slotTime = slotTime.plus({ minutes: interval });
          }
        } else {
          slots.push({
            date: cursor.toFormat('EEE, MMM d yyyy'),
            day: cursor.toFormat('EEEE'),
            iso: cursor.toISO()!,
          });
        }
      }
      cursor = cursor.plus({ days: 1 });
    }

    const result = {
      from: formatDt(fromDt),
      to: formatDt(toDt),
      weekdays_only: weekdaysOnly,
      time_window: hasTimeWindow ? `${args.time_start}–${args.time_end}` : null,
      interval_minutes: hasTimeWindow ? interval : null,
      count: slots.length,
      slots,
    };

    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
