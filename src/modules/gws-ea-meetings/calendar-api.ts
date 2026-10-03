/**
 * The Google Calendar reads the meeting handoff makes with the host's own
 * Calendar token (KTD6, KTD11): whether a calendar is one the principal owns
 * and the assistant can write to, an event's organizer, attendees and time,
 * and the events in an interval. No client library: each call is one `fetch`
 * with the token in its header, so it never reaches a container or an
 * argument list.
 *
 * Every event read asks Google for its timing, status and people only, so no
 * title, description or location is ever fetched (R20). Tests use a fake with
 * the same interface; U12's calendar actions extend it with writes.
 */
import { isRecord } from '../../gws-ea/validation.js';
import type { CalendarListEntry } from '../gws-ea-inbox/calendar-notifications.js';
import { GoogleApiError, googleJson, type GoogleClientOptions } from '../gws-ea-inbox/gmail-api.js';

export interface EventTime {
  /** A timed event's instant, with its offset. */
  readonly dateTime?: string;
  /** An all-day event's date, `YYYY-MM-DD`. */
  readonly date?: string;
}

export interface EventAttendee {
  readonly email?: string;
  readonly responseStatus?: string;
  /** A room or other resource, never a person. */
  readonly resource?: boolean;
  readonly organizer?: boolean;
}

/** An event as the handoff reads it: no title, description or location. */
export interface CalendarEvent {
  readonly id: string;
  readonly iCalUID?: string;
  readonly status?: string;
  readonly transparency?: string;
  readonly organizer?: { readonly email?: string };
  readonly attendees?: readonly EventAttendee[];
  readonly start?: EventTime;
  readonly end?: EventTime;
}

export interface MeetingsCalendarApi {
  /** The assistant's calendar-list entry for a calendar, or undefined when it has none. */
  getCalendar(calendarId: string): Promise<CalendarListEntry | undefined>;
  /** One event, or undefined when it does not exist. */
  getEvent(calendarId: string, eventId: string): Promise<CalendarEvent | undefined>;
  /** Every event that overlaps the interval, recurring events expanded. */
  listEvents(calendarId: string, timeMin: string, timeMax: string): Promise<CalendarEvent[]>;
}

const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
const EVENT_FIELDS =
  'id,iCalUID,status,transparency,organizer(email),attendees(email,responseStatus,resource,organizer),start(dateTime,date),end(dateTime,date)';
const MAX_PAGES = 10;

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function toTime(value: unknown): EventTime | undefined {
  if (!isRecord(value)) return undefined;
  const dateTime = optionalString(value.dateTime);
  const date = optionalString(value.date);
  return {
    ...(dateTime === undefined ? {} : { dateTime }),
    ...(date === undefined ? {} : { date }),
  };
}

function toAttendee(value: unknown): EventAttendee | undefined {
  if (!isRecord(value)) return undefined;
  const email = optionalString(value.email);
  const responseStatus = optionalString(value.responseStatus);
  return {
    ...(email === undefined ? {} : { email: email.toLowerCase() }),
    ...(responseStatus === undefined ? {} : { responseStatus }),
    ...(value.resource === true ? { resource: true } : {}),
    ...(value.organizer === true ? { organizer: true } : {}),
  };
}

function toEvent(value: unknown): CalendarEvent {
  if (!isRecord(value) || typeof value.id !== 'string') {
    throw new GoogleApiError(502, 'Google Calendar returned an unreadable event');
  }
  const organizerEmail = isRecord(value.organizer) ? optionalString(value.organizer.email) : undefined;
  const start = toTime(value.start);
  const end = toTime(value.end);
  const iCalUID = optionalString(value.iCalUID);
  const status = optionalString(value.status);
  const transparency = optionalString(value.transparency);
  return {
    id: value.id,
    ...(iCalUID === undefined ? {} : { iCalUID }),
    ...(status === undefined ? {} : { status }),
    ...(transparency === undefined ? {} : { transparency }),
    ...(organizerEmail === undefined ? {} : { organizer: { email: organizerEmail.toLowerCase() } }),
    ...(Array.isArray(value.attendees)
      ? { attendees: value.attendees.flatMap((attendee) => toAttendee(attendee) ?? []) }
      : {}),
    ...(start === undefined ? {} : { start }),
    ...(end === undefined ? {} : { end }),
  };
}

function toCalendarEntry(value: unknown): CalendarListEntry {
  if (!isRecord(value) || typeof value.id !== 'string') {
    throw new GoogleApiError(502, 'Google Calendar returned an unreadable calendar list entry');
  }
  const accessRole = optionalString(value.accessRole);
  const dataOwner = optionalString(value.dataOwner);
  return {
    id: value.id,
    ...(accessRole === undefined ? {} : { accessRole }),
    ...(typeof value.primary === 'boolean' ? { primary: value.primary } : {}),
    ...(dataOwner === undefined ? {} : { dataOwner }),
    ...(typeof value.deleted === 'boolean' ? { deleted: value.deleted } : {}),
  };
}

/** The real client, over the Calendar API. */
export function createMeetingsCalendarApi(options: GoogleClientOptions): MeetingsCalendarApi {
  return {
    async getCalendar(calendarId) {
      const payload = await googleJson(
        options,
        `${CALENDAR_API}/users/me/calendarList/${encodeURIComponent(calendarId)}`,
        { allowNotFound: true },
      );
      return payload === undefined ? undefined : toCalendarEntry(payload);
    },

    async getEvent(calendarId, eventId) {
      const params = new URLSearchParams({ fields: EVENT_FIELDS });
      const payload = await googleJson(
        options,
        `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?${params.toString()}`,
        { allowNotFound: true },
      );
      return payload === undefined ? undefined : toEvent(payload);
    },

    async listEvents(calendarId, timeMin, timeMax) {
      const events: CalendarEvent[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const params = new URLSearchParams({
          timeMin,
          timeMax,
          singleEvents: 'true',
          maxResults: '250',
          fields: `items(${EVENT_FIELDS}),nextPageToken`,
        });
        if (pageToken !== undefined) params.set('pageToken', pageToken);
        const payload = await googleJson(
          options,
          `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`,
        );
        if (!isRecord(payload)) throw new GoogleApiError(502, 'Google Calendar returned an unreadable event list');
        if (Array.isArray(payload.items)) events.push(...payload.items.map(toEvent));
        pageToken = optionalString(payload.nextPageToken);
        if (pageToken === undefined) return events;
      }
      throw new GoogleApiError(502, 'Google Calendar returned an event list too long to read');
    },
  };
}
