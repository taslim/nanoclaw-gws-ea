/**
 * Google Calendar MCP Server for NanoClaw
 *
 * Multi-calendar availability, event listing, and RSVP with config-driven filtering.
 * Queries events.list across calendars, applies configurable event filters
 * (static value matches or cross-event dedup), and returns clean results.
 *
 * Tools: get_availability (unified busy/free), list_events (full event details),
 *        respond_to_event (RSVP with notes, plus-ones, recurring instance support).
 *
 * Config (calendars.json): calendars[0] is primary (used for timezone).
 * eventFilters[] define exclude/includeOnly rules against any event property.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { OAuth2Client } from 'google-auth-library';
import { google, calendar_v3 } from 'googleapis';
import { DateTime } from 'luxon';
import * as fs from 'fs';

interface EventFilter {
  action: 'exclude' | 'includeOnly';
  where: string;
  equals?: string;
  inValuesOf?: string;
  calendarIds?: string[];
}

interface CalendarConfig {
  calendars: string[];
  eventFilters?: EventFilter[];
}

const FALLBACK_TZ = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

const config: CalendarConfig = (() => {
  const configPath = process.env.CALENDAR_CONFIG_PATH;
  if (!configPath || !fs.existsSync(configPath)) return { calendars: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Partial<CalendarConfig>;
    return {
      calendars: Array.isArray(raw.calendars) ? raw.calendars : [],
      eventFilters: Array.isArray(raw.eventFilters) ? raw.eventFilters : undefined,
    };
  } catch (err) {
    process.stderr.write(`gcal-mcp: failed to parse calendar config: ${err}\n`);
    return { calendars: [] };
  }
})();

const credsPath = process.env.GOOGLE_OAUTH_CREDENTIALS;
const tokenPath = process.env.GOOGLE_CALENDAR_MCP_TOKEN_PATH;
if (!credsPath || !tokenPath) {
  process.stderr.write('gcal-mcp: GOOGLE_OAUTH_CREDENTIALS or GOOGLE_CALENDAR_MCP_TOKEN_PATH not set\n');
  process.exit(1);
}

const credsFile = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
const { client_id, client_secret, redirect_uris } = credsFile.installed || credsFile.web;
const oauth2Client = new OAuth2Client(client_id, client_secret, redirect_uris?.[0]);

const tokenData = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));
const accountTokens = tokenData.normal || tokenData;
oauth2Client.setCredentials({
  access_token: accountTokens.access_token,
  refresh_token: accountTokens.refresh_token,
  expiry_date: accountTokens.expiry_date,
  token_type: accountTokens.token_type,
  scope: accountTokens.scope,
});

oauth2Client.on('tokens', (newTokens) => {
  try {
    const current = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));
    if (current.normal) {
      current.normal = { ...current.normal, ...newTokens };
    } else {
      Object.assign(current, newTokens);
    }
    fs.writeFileSync(tokenPath, JSON.stringify(current, null, 2), { mode: 0o600 });
  } catch {
    process.stderr.write('gcal-mcp: failed to persist refreshed tokens\n');
  }
});

const calendarApi = google.calendar({ version: 'v3', auth: oauth2Client });

const primaryCalendarId = config.calendars[0] ?? 'primary';

const timezonePromise: Promise<string> = (async () => {
  try {
    const res = await calendarApi.calendars.get({ calendarId: primaryCalendarId });
    if (res.data.timeZone) return res.data.timeZone;
  } catch {
    process.stderr.write('gcal-mcp: failed to detect timezone from primary calendar\n');
  }
  return FALLBACK_TZ;
})();

function resolveCalendarIds(paramIds?: string[]): string[] {
  if (paramIds && paramIds.length > 0) return paramIds;
  return config.calendars;
}

function jsonResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function errorResult(message: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true as const };
}

interface RawEvent {
  id: string;
  calendarId: string;
  start: string;
  end: string;
  isAllDay: boolean;
  extendedProperties?: {
    private?: Record<string, string>;
    shared?: Record<string, string>;
  } | null;
  transparent: boolean;
  declined: boolean;
}

interface BusyBlock {
  start: string;
  end: string;
  day: string;
  calendarId: string;
  isAllDay: boolean;
}

interface FreeBlock {
  start: string;
  end: string;
  day: string;
  label: string;
}

interface AvailabilityResponse {
  timezone: string;
  window: { start: string; end: string };
  busy: BusyBlock[];
  free: FreeBlock[];
  calendars_checked: string[];
  events_filtered: number;
  errors?: Array<{ calendarId: string; error: string }>;
}

interface StructuredEvent {
  id: string;
  summary?: string | null;
  description?: string | null;
  location?: string | null;
  start: calendar_v3.Schema$EventDateTime;
  end: calendar_v3.Schema$EventDateTime;
  startDayOfWeek: string;
  endDayOfWeek: string;
  sortEpoch: number;
  status?: string | null;
  htmlLink?: string | null;
  created?: string | null;
  updated?: string | null;
  colorId?: string | null;
  creator?: calendar_v3.Schema$Event['creator'];
  organizer?: calendar_v3.Schema$Event['organizer'];
  attendees?: calendar_v3.Schema$EventAttendee[];
  recurrence?: string[];
  recurringEventId?: string | null;
  originalStartTime?: calendar_v3.Schema$EventDateTime;
  transparency?: string | null;
  visibility?: string | null;
  iCalUID?: string | null;
  sequence?: number | null;
  reminders?: calendar_v3.Schema$Event['reminders'];
  conferenceData?: calendar_v3.Schema$ConferenceData;
  hangoutLink?: string | null;
  eventType?: string | null;
  extendedProperties?: calendar_v3.Schema$Event['extendedProperties'];
  calendarId: string;
}

interface ListEventsResponse {
  events: StructuredEvent[];
  totalCount: number;
  calendars?: string[];
  events_filtered?: number;
  errors?: Array<{ calendarId: string; error: string }>;
}

function toEpoch(isoOrDate: string): number {
  return new Date(isoOrDate).getTime();
}

function dayName(isoDate: string, tz: string): string {
  return DateTime.fromISO(isoDate, { zone: tz }).toFormat('EEEE');
}

function dayLabel(isoDate: string, tz: string): string {
  return DateTime.fromISO(isoDate, { zone: tz }).toFormat('EEEE, MMMM d');
}

function allDayToRange(startDate: string, endDate: string, tz: string): { start: string; end: string } {
  const s = DateTime.fromISO(startDate, { zone: tz }).startOf('day');
  const e = DateTime.fromISO(endDate, { zone: tz }).startOf('day');
  if (!s.isValid || !e.isValid) throw new Error(`Invalid all-day range: ${startDate} - ${endDate} (tz=${tz})`);
  return { start: s.toISO(), end: e.toISO() };
}

function isDeclined(event: calendar_v3.Schema$Event): boolean {
  if (!event.attendees) return false;
  const self = event.attendees.find((a) => a.self);
  return self?.responseStatus === 'declined';
}

async function paginateEvents<T>(
  calendarId: string, timeMin: string, timeMax: string, tz: string,
  opts: { fields?: string },
  mapEvent: (event: calendar_v3.Schema$Event) => T | null,
): Promise<T[]> {
  const results: T[] = [];
  let pageToken: string | undefined;

  do {
    const res = await calendarApi.events.list({
      calendarId, timeMin, timeMax,
      singleEvents: true, orderBy: 'startTime', timeZone: tz,
      maxResults: 2500, pageToken,
      ...(opts.fields && { fields: opts.fields }),
    });

    for (const event of res.data.items || []) {
      if (event.status === 'cancelled') continue;
      const mapped = mapEvent(event);
      if (mapped !== null) results.push(mapped);
    }

    pageToken = res.data.nextPageToken || undefined;
  } while (pageToken);

  return results;
}

const SLIM_FIELDS = 'items(id,status,start,end,transparency,attendees(self,responseStatus),extendedProperties),nextPageToken';

function fetchEventsSlim(calendarId: string, timeMin: string, timeMax: string, tz: string): Promise<RawEvent[]> {
  return paginateEvents(calendarId, timeMin, timeMax, tz, { fields: SLIM_FIELDS }, (event) => {
    if (!event.id || !event.start || !event.end) return null;
    const isAllDay = !!event.start.date;
    const start = isAllDay ? event.start.date : event.start.dateTime;
    const end = isAllDay ? event.end.date : event.end.dateTime;
    if (!start || !end) return null;
    return {
      id: event.id, calendarId, start, end, isAllDay,
      extendedProperties: event.extendedProperties,
      transparent: event.transparency === 'transparent',
      declined: isDeclined(event),
    };
  });
}

function fetchEventsFull(calendarId: string, timeMin: string, timeMax: string, tz: string): Promise<calendar_v3.Schema$Event[]> {
  return paginateEvents(calendarId, timeMin, timeMax, tz, {}, (event) => {
    if (!event.start || !event.end) return null;
    return event;
  });
}

async function fetchMultiCalendar<T>(
  calendarIds: string[],
  fetcher: (calendarId: string) => Promise<T[]>,
): Promise<{ events: T[]; eventsFiltered: number; errors: Array<{ calendarId: string; error: string }> }> {
  const results = await Promise.allSettled(calendarIds.map((id) => fetcher(id)));

  const allEvents: T[] = [];
  const errors: Array<{ calendarId: string; error: string }> = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'fulfilled') {
      allEvents.push(...result.value);
    } else {
      errors.push({
        calendarId: calendarIds[i],
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  }

  const { events, eventsFiltered } = applyEventFilters(allEvents, config.eventFilters);
  return { events, eventsFiltered, errors };
}

function getProp(obj: unknown, path: string): unknown {
  let current: unknown = obj;
  for (const key of path.split('.')) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

interface FilterResult<T> {
  events: T[];
  eventsFiltered: number;
}

function applyEventFilters<T>(events: T[], filters: EventFilter[] | undefined): FilterResult<T> {
  if (!filters || filters.length === 0) return { events, eventsFiltered: 0 };

  // Phase 1: pre-scan for cross-event filters — build match sets
  const matchSets = new Map<number, Set<string>>();
  for (let i = 0; i < filters.length; i++) {
    const filter = filters[i];
    if (!filter.equals && filter.inValuesOf) {
      const values = new Set<string>();
      for (const event of events) {
        const val = getProp(event, filter.inValuesOf);
        if (typeof val === 'string' && val.length > 0) values.add(val);
      }
      matchSets.set(i, values);
    }
  }

  // Phase 2: apply all filters as per-event predicates
  let eventsFiltered = 0;
  const result: T[] = [];

  for (const event of events) {
    let keep = true;

    for (let i = 0; i < filters.length; i++) {
      const filter = filters[i];
      let matches: boolean;

      // Skip this filter for events outside its calendar scope
      if (filter.calendarIds) {
        const eventCalId = getProp(event, 'calendarId');
        if (typeof eventCalId !== 'string' || !filter.calendarIds.includes(eventCalId)) continue;
      }

      if (filter.equals !== undefined) {
        matches = getProp(event, filter.where) === filter.equals;
      } else if (filter.inValuesOf) {
        const propValue = getProp(event, filter.where);
        matches = typeof propValue === 'string' && (matchSets.get(i)?.has(propValue) ?? false);
      } else {
        continue;
      }

      if (filter.action === 'exclude' && matches) { keep = false; break; }
      if (filter.action === 'includeOnly' && !matches) { keep = false; break; }
    }

    if (keep) result.push(event);
    else eventsFiltered++;
  }

  return { events: result, eventsFiltered };
}

function toStructuredEvent(event: calendar_v3.Schema$Event, calendarId: string, tz: string): StructuredEvent | null {
  if (!event.start || !event.end || !event.id) return null;
  const isAllDay = !!event.start.date;
  const startStr = isAllDay ? event.start.date : event.start.dateTime;
  const endStr = isAllDay ? event.end.date : event.end.dateTime;
  if (!startStr || !endStr) return null;

  return {
    id: event.id,
    summary: event.summary,
    description: event.description,
    location: event.location,
    start: event.start,
    end: event.end,
    startDayOfWeek: dayName(startStr, tz),
    endDayOfWeek: dayName(endStr, tz),
    sortEpoch: toEpoch(startStr),
    status: event.status,
    htmlLink: event.htmlLink,
    created: event.created,
    updated: event.updated,
    colorId: event.colorId,
    creator: event.creator,
    organizer: event.organizer,
    attendees: event.attendees || undefined,
    recurrence: event.recurrence || undefined,
    recurringEventId: event.recurringEventId,
    originalStartTime: event.originalStartTime || undefined,
    transparency: event.transparency,
    visibility: event.visibility,
    iCalUID: event.iCalUID,
    sequence: event.sequence,
    reminders: event.reminders,
    conferenceData: event.conferenceData || undefined,
    hangoutLink: event.hangoutLink,
    eventType: event.eventType,
    extendedProperties: event.extendedProperties,
    calendarId,
  };
}

function computeFreeSlots(busy: Array<{ start: string; end: string }>, windowStart: string, windowEnd: string, tz: string): FreeBlock[] {
  if (busy.length === 0) return [{ start: windowStart, end: windowEnd, day: dayName(windowStart, tz), label: dayLabel(windowStart, tz) }];

  const sorted = [...busy].sort((a, b) => toEpoch(a.start) - toEpoch(b.start));
  const merged: Array<{ start: string; end: string }> = [{ ...sorted[0] }];

  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    if (toEpoch(sorted[i].start) <= toEpoch(last.end)) {
      if (toEpoch(sorted[i].end) > toEpoch(last.end)) last.end = sorted[i].end;
    } else {
      merged.push({ ...sorted[i] });
    }
  }

  const free: FreeBlock[] = [];
  let cursor = windowStart;

  for (const block of merged) {
    if (toEpoch(block.start) > toEpoch(cursor)) {
      free.push({ start: cursor, end: block.start, day: dayName(cursor, tz), label: dayLabel(cursor, tz) });
    }
    if (toEpoch(block.end) > toEpoch(cursor)) cursor = block.end;
  }

  if (toEpoch(cursor) < toEpoch(windowEnd)) {
    free.push({ start: cursor, end: windowEnd, day: dayName(cursor, tz), label: dayLabel(cursor, tz) });
  }

  return free;
}

const server = new McpServer({
  name: 'gcal',
  version: '1.0.0',
});

server.tool(
  'get_availability',
  'Get unified availability across all calendars. Returns merged busy blocks and computed free slots. Calendar IDs default to config if not provided.',
  {
    time_min: z.string().describe('Start of window (ISO 8601 datetime, e.g. 2026-03-23T00:00:00-07:00)'),
    time_max: z.string().describe('End of window (ISO 8601 datetime, e.g. 2026-04-06T00:00:00-07:00)'),
    calendar_ids: z.array(z.string()).optional().describe('Calendar IDs to check. Defaults to config calendars if omitted.'),
    timezone: z.string().optional().describe('IANA timezone for output formatting (defaults to primary calendar timezone)'),
  },
  async (args) => {
    const tz = args.timezone || await timezonePromise;
    const calendarIds = resolveCalendarIds(args.calendar_ids);

    if (!DateTime.now().setZone(tz).isValid) return errorResult(`Invalid timezone: ${tz}`);
    if (calendarIds.length === 0) return errorResult('No calendar IDs provided and no config defaults found');

    const { events, eventsFiltered, errors } = await fetchMultiCalendar(
      calendarIds,
      (id) => fetchEventsSlim(id, args.time_min, args.time_max, tz),
    );

    const busy: BusyBlock[] = [];
    for (const event of events) {
      if (event.transparent || event.declined) continue;
      busy.push({
        start: event.start,
        end: event.end,
        day: dayName(event.start, tz),
        calendarId: event.calendarId,
        isAllDay: event.isAllDay,
      });
    }

    busy.sort((a, b) => toEpoch(a.start) - toEpoch(b.start));

    const busyForGaps = busy.map((b) => {
      if (b.isAllDay) return allDayToRange(b.start, b.end, tz);
      return { start: b.start, end: b.end };
    });
    const free = computeFreeSlots(busyForGaps, args.time_min, args.time_max, tz);

    return jsonResult({
      timezone: tz,
      window: { start: args.time_min, end: args.time_max },
      busy,
      free,
      calendars_checked: calendarIds,
      events_filtered: eventsFiltered,
      ...(errors.length > 0 && { errors }),
    } satisfies AvailabilityResponse);
  },
);

server.tool(
  'list_events',
  'List events across all calendars. Returns full event details (title, attendees, location, etc.). Calendar IDs default to config if not provided.',
  {
    calendar_ids: z.array(z.string()).optional().describe('Calendar IDs to query. Defaults to config calendars if omitted.'),
    timeMin: z.string().describe('Start of window (ISO 8601 datetime)'),
    timeMax: z.string().describe('End of window (ISO 8601 datetime)'),
    timeZone: z.string().optional().describe('IANA timezone (defaults to primary calendar timezone)'),
  },
  async (args) => {
    const tz = args.timeZone || await timezonePromise;
    const calendarIds = resolveCalendarIds(args.calendar_ids);

    if (!DateTime.now().setZone(tz).isValid) return errorResult(`Invalid timezone: ${tz}`);
    if (calendarIds.length === 0) return errorResult('No calendar IDs provided and no config defaults found');

    const { events, eventsFiltered, errors } = await fetchMultiCalendar(
      calendarIds,
      async (id) => (await fetchEventsFull(id, args.timeMin, args.timeMax, tz)).map((e) => ({ ...e, calendarId: id })),
    );

    const allEvents = events
      .map((event) => toStructuredEvent(event, event.calendarId, tz))
      .filter((e): e is StructuredEvent => e !== null)
      .sort((a, b) => a.sortEpoch - b.sortEpoch);

    return jsonResult({
      events: allEvents,
      totalCount: allEvents.length,
      ...(calendarIds.length > 1 && { calendars: calendarIds }),
      ...(eventsFiltered > 0 && { events_filtered: eventsFiltered }),
      ...(errors.length > 0 && { errors }),
    } satisfies ListEventsResponse);
  },
);

server.tool(
  'respond_to_event',
  'Respond to a calendar event invitation (accept, decline, tentative). Supports response notes, plus-ones, and recurring event instances.',
  {
    event_id: z.string().describe('Event ID (use instance ID from list_events for recurring events)'),
    response: z.enum(['accepted', 'declined', 'tentative', 'needsAction']).describe('RSVP response'),
    calendar_id: z.string().optional().describe('Calendar ID (defaults to primary calendar from config)'),
    comment: z.string().optional().describe('Note to include with the response'),
    additional_guests: z.number().int().min(0).optional().describe('Number of additional guests (plus-ones)'),
    send_updates: z.enum(['all', 'externalOnly', 'none']).optional().describe('Who to notify about the response (defaults to none)'),
    scope: z.enum(['single', 'all']).optional().describe('For recurring events: respond to this instance only or all instances (defaults to single)'),
    original_start_time: z.string().optional().describe('Original start time (ISO 8601) — required when passing a base event ID with scope single'),
  },
  async (args) => {
    const calendarId = args.calendar_id ?? primaryCalendarId;
    const scope = args.scope ?? 'single';
    const sendUpdates = args.send_updates ?? 'none';

    // Google Calendar instance IDs use the format baseEventId_YYYYMMDDTHHMMSSz
    let eventId = args.event_id;
    if (scope === 'all') {
      const idx = eventId.lastIndexOf('_');
      if (idx > 0 && /^\d{8}T\d{6}Z$/.test(eventId.substring(idx + 1))) {
        eventId = eventId.substring(0, idx);
      }
    } else if (args.original_start_time && !eventId.includes('_')) {
      const dt = DateTime.fromISO(args.original_start_time, { zone: 'utc' });
      if (!dt.isValid) {
        return errorResult(`Invalid original_start_time: ${args.original_start_time}`);
      }
      const ts = dt.toFormat("yyyyMMdd'T'HHmmss'Z'");
      eventId = `${eventId}_${ts}`;
    }

    let event: calendar_v3.Schema$Event;
    try {
      const res = await calendarApi.events.get({ calendarId, eventId, fields: 'attendees,summary' });
      event = res.data;
    } catch (err) {
      return errorResult(`Failed to fetch event: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!event.attendees?.length) {
      return errorResult('Event has no attendees');
    }

    const selfAttendee = event.attendees.find((a) => a.self);
    if (!selfAttendee) {
      return errorResult('You are not an attendee of this event');
    }

    const updatedAttendees = event.attendees.map((a) => {
      if (!a.self) return a;
      return {
        ...a,
        responseStatus: args.response,
        ...(args.comment !== undefined && { comment: args.comment }),
        ...(args.additional_guests !== undefined && { additionalGuests: args.additional_guests }),
      };
    });

    try {
      await calendarApi.events.patch({
        calendarId,
        eventId,
        sendUpdates,
        requestBody: { attendees: updatedAttendees },
      });
    } catch (err) {
      return errorResult(`Failed to update response: ${err instanceof Error ? err.message : String(err)}`);
    }

    return jsonResult({
      success: true,
      event_id: eventId,
      summary: event.summary,
      response: args.response,
      ...(args.comment !== undefined && { comment: args.comment }),
      ...(args.additional_guests !== undefined && { additional_guests: args.additional_guests }),
      send_updates: sendUpdates,
    });
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
