/**
 * The Google Calendar calls the scheduling tools and the handoff make with
 * the host's own Calendar token (KTD7): whether a calendar is one the
 * principal owns and the assistant can write to, and its name; an event's
 * organizer, attendees, time and the assistant's own tags, the events in an
 * interval, and the writes behind holds, bookings, changes and cancellations.
 * No client library: each call is one `fetch` with the token in its header,
 * so it never reaches a container or an argument list.
 *
 * Every event read asks Google for its timing, status, people, the
 * assistant's own private tags, and the Meet link the host asked Google to
 * create, and every write asks for nothing back but the id, so no title,
 * description or location is ever fetched (R20). Tests use a fake with the
 * same interface.
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

/**
 * A Google Meet link on an event. Google creates one the host asks for
 * asynchronously: pending, then success or failure.
 */
export interface EventConference {
  readonly status: 'pending' | 'success' | 'failure';
  /** The link people join by, once there is one. */
  readonly uri?: string;
}

/** An event as the host reads it: no title, description or location. */
export interface CalendarEvent {
  readonly id: string;
  readonly iCalUID?: string;
  readonly status?: string;
  readonly transparency?: string;
  readonly organizer?: { readonly email?: string };
  readonly attendees?: readonly EventAttendee[];
  readonly start?: EventTime;
  readonly end?: EventTime;
  /** The private extended properties the assistant tagged its own events with. */
  readonly tags?: Readonly<Record<string, string>>;
  /** Its Meet link, when it has one or Google is creating one. */
  readonly conference?: EventConference;
}

/**
 * An event as a listing returns it: a calendar shared with the assistant as
 * free/busy only may list a busy block without an id, and it still counts.
 */
export type ListedEvent = Omit<CalendarEvent, 'id'> & { readonly id?: string };

/** Whether Google emails the attendees about a write. */
export type SendUpdates = 'all' | 'none';

/** A calendar-list entry with the calendar's own name, which the invitations of events on it show. */
export interface CalendarEntry extends CalendarListEntry {
  readonly summary?: string;
}

/**
 * A guest a write lists, with the answer it starts with. Google starts a
 * guest it is given no answer for at `needsAction`, the calendar's own owner
 * included.
 */
export interface GuestWrite {
  readonly email: string;
  readonly responseStatus?: 'accepted';
}

/** The fields a write sets; times are instants. */
export interface EventWrite {
  readonly summary?: string;
  readonly description?: string;
  /** Where people meet: an address, a phone number, or a link of the other side's own. */
  readonly location?: string;
  /** Ask Google to create a Meet link, under a request id it ignores when repeated. */
  readonly conference?: { readonly requestId: string };
  readonly start?: string;
  readonly end?: string;
  /** The zone the event's times display in. */
  readonly timeZone?: string;
  /** Every guest, the event's own calendar owner among them; a write with them replaces the list. */
  readonly attendees?: readonly GuestWrite[];
  readonly visibility?: 'default' | 'private';
  readonly transparency?: 'opaque' | 'transparent';
  /** `none` turns every reminder off; `default` keeps the calendar's own. */
  readonly reminders?: 'default' | 'none';
  /** Private extended properties: the assistant's own marks on its events. */
  readonly tags?: Readonly<Record<string, string>>;
  /** Restores an event deleted earlier under the same id. */
  readonly status?: 'confirmed';
}

/** A new event: a write with its times. */
export type NewEvent = EventWrite & { readonly start: string; readonly end: string };

export interface MeetingsCalendarApi {
  /** The assistant's calendar-list entry for a calendar, or undefined when it has none. */
  getCalendar(calendarId: string): Promise<CalendarEntry | undefined>;
  /** One event, or undefined when it does not exist. A deleted event reads as `cancelled`. */
  getEvent(calendarId: string, eventId: string): Promise<CalendarEvent | undefined>;
  /** Every live event that overlaps the interval, recurring events expanded. */
  listEvents(calendarId: string, timeMin: string, timeMax: string): Promise<ListedEvent[]>;
  /** Create an event under the id given; `exists` when Google already holds that id, deleted or not. */
  insertEvent(
    calendarId: string,
    eventId: string,
    event: NewEvent,
    sendUpdates: SendUpdates,
  ): Promise<'created' | 'exists'>;
  /** Change the fields given. */
  patchEvent(calendarId: string, eventId: string, event: EventWrite, sendUpdates: SendUpdates): Promise<void>;
  /** Delete an event; `gone` when it was already deleted or never existed. */
  deleteEvent(calendarId: string, eventId: string, sendUpdates: SendUpdates): Promise<'deleted' | 'gone'>;
}

const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
const EVENT_FIELDS =
  'id,iCalUID,status,transparency,organizer(email),attendees(email,responseStatus,resource,organizer),start(dateTime,date),end(dateTime,date),extendedProperties(private),conferenceData(createRequest(status(statusCode)),entryPoints(entryPointType,uri))';
/** The conference type Google Meet is in a calendar's allowed conference types and a create request. */
const GOOGLE_MEET = 'hangoutsMeet';
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

function toTags(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value) || !isRecord(value.private)) return undefined;
  const tags = Object.fromEntries(
    Object.entries(value.private).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
  return Object.keys(tags).length === 0 ? undefined : tags;
}

/** An event's Meet link as Google reports it: what it is creating, or what it has. */
function toConference(value: unknown): EventConference | undefined {
  if (!isRecord(value)) return undefined;
  const status =
    isRecord(value.createRequest) && isRecord(value.createRequest.status)
      ? optionalString(value.createRequest.status.statusCode)
      : undefined;
  const uri = Array.isArray(value.entryPoints)
    ? value.entryPoints
        .filter((entry): entry is Record<string, unknown> => isRecord(entry) && entry.entryPointType === 'video')
        .map((entry) => optionalString(entry.uri))
        .find((entry) => entry !== undefined)
    : undefined;
  if (status === 'pending' || status === 'failure') return { status };
  if (status === 'success' || uri !== undefined) return { status: 'success', ...(uri === undefined ? {} : { uri }) };
  return undefined;
}

function toListedEvent(value: unknown): ListedEvent {
  if (!isRecord(value)) throw new GoogleApiError(502, 'Google Calendar returned an unreadable event');
  const id = optionalString(value.id);
  const organizerEmail = isRecord(value.organizer) ? optionalString(value.organizer.email) : undefined;
  const start = toTime(value.start);
  const end = toTime(value.end);
  const iCalUID = optionalString(value.iCalUID);
  const status = optionalString(value.status);
  const transparency = optionalString(value.transparency);
  const tags = toTags(value.extendedProperties);
  const conference = toConference(value.conferenceData);
  return {
    ...(id === undefined ? {} : { id }),
    ...(iCalUID === undefined ? {} : { iCalUID }),
    ...(status === undefined ? {} : { status }),
    ...(transparency === undefined ? {} : { transparency }),
    ...(organizerEmail === undefined ? {} : { organizer: { email: organizerEmail.toLowerCase() } }),
    ...(Array.isArray(value.attendees)
      ? { attendees: value.attendees.flatMap((attendee) => toAttendee(attendee) ?? []) }
      : {}),
    ...(start === undefined ? {} : { start }),
    ...(end === undefined ? {} : { end }),
    ...(tags === undefined ? {} : { tags }),
    ...(conference === undefined ? {} : { conference }),
  };
}

/** One event read by its id: it always has one. */
function toEvent(value: unknown): CalendarEvent {
  const event = toListedEvent(value);
  if (event.id === undefined) throw new GoogleApiError(502, 'Google Calendar returned an event without an id');
  return { ...event, id: event.id };
}

function eventTime(instant: string, timeZone: string | undefined): Record<string, string> {
  return { dateTime: instant, ...(timeZone === undefined ? {} : { timeZone }) };
}

/** The request body for a write: only the fields it sets. */
function eventBody(event: EventWrite, id?: string): Record<string, unknown> {
  return {
    ...(id === undefined ? {} : { id }),
    ...(event.status === undefined ? {} : { status: event.status }),
    ...(event.summary === undefined ? {} : { summary: event.summary }),
    ...(event.description === undefined ? {} : { description: event.description }),
    ...(event.location === undefined ? {} : { location: event.location }),
    ...(event.conference === undefined
      ? {}
      : {
          conferenceData: {
            createRequest: { requestId: event.conference.requestId, conferenceSolutionKey: { type: GOOGLE_MEET } },
          },
        }),
    ...(event.start === undefined ? {} : { start: eventTime(event.start, event.timeZone) }),
    ...(event.end === undefined ? {} : { end: eventTime(event.end, event.timeZone) }),
    ...(event.attendees === undefined
      ? {}
      : {
          attendees: event.attendees.map((guest) => ({
            email: guest.email,
            ...(guest.responseStatus === undefined ? {} : { responseStatus: guest.responseStatus }),
          })),
        }),
    ...(event.visibility === undefined ? {} : { visibility: event.visibility }),
    ...(event.transparency === undefined ? {} : { transparency: event.transparency }),
    ...(event.reminders === undefined
      ? {}
      : { reminders: event.reminders === 'none' ? { useDefault: false, overrides: [] } : { useDefault: true } }),
    ...(event.tags === undefined ? {} : { extendedProperties: { private: { ...event.tags } } }),
  };
}

function eventUrl(calendarId: string, eventId?: string): string {
  const events = `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`;
  return eventId === undefined ? events : `${events}/${encodeURIComponent(eventId)}`;
}

function toCalendarEntry(value: unknown): CalendarEntry {
  if (!isRecord(value) || typeof value.id !== 'string') {
    throw new GoogleApiError(502, 'Google Calendar returned an unreadable calendar list entry');
  }
  const accessRole = optionalString(value.accessRole);
  const dataOwner = optionalString(value.dataOwner);
  const summary = optionalString(value.summary);
  const allowed =
    isRecord(value.conferenceProperties) && Array.isArray(value.conferenceProperties.allowedConferenceSolutionTypes)
      ? value.conferenceProperties.allowedConferenceSolutionTypes.filter(
          (type): type is string => typeof type === 'string',
        )
      : undefined;
  return {
    id: value.id,
    ...(accessRole === undefined ? {} : { accessRole }),
    ...(typeof value.primary === 'boolean' ? { primary: value.primary } : {}),
    ...(dataOwner === undefined ? {} : { dataOwner }),
    ...(typeof value.deleted === 'boolean' ? { deleted: value.deleted } : {}),
    ...(allowed === undefined ? {} : { conferenceTypes: allowed }),
    ...(summary === undefined ? {} : { summary }),
  };
}

/** Whether a calendar lets its events carry a Google Meet link. */
export function allowsMeet(entry: CalendarListEntry): boolean {
  return entry.conferenceTypes?.includes(GOOGLE_MEET) === true;
}

/** The query a write sends: its notification choice, an id-only answer, and conference support when it asks for a link. */
function writeParams(event: EventWrite, sendUpdates: SendUpdates): URLSearchParams {
  return new URLSearchParams({
    sendUpdates,
    fields: 'id',
    ...(event.conference === undefined ? {} : { conferenceDataVersion: '1' }),
  });
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
      const events: ListedEvent[] = [];
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
        if (Array.isArray(payload.items)) events.push(...payload.items.map(toListedEvent));
        pageToken = optionalString(payload.nextPageToken);
        if (pageToken === undefined) return events;
      }
      throw new GoogleApiError(502, 'Google Calendar returned an event list too long to read');
    },

    async insertEvent(calendarId, eventId, event, sendUpdates) {
      const params = writeParams(event, sendUpdates);
      try {
        await googleJson(options, `${eventUrl(calendarId)}?${params.toString()}`, {
          method: 'POST',
          body: eventBody(event, eventId),
        });
        return 'created';
      } catch (error) {
        if (error instanceof GoogleApiError && error.status === 409) return 'exists';
        throw error;
      }
    },

    async patchEvent(calendarId, eventId, event, sendUpdates) {
      const params = writeParams(event, sendUpdates);
      await googleJson(options, `${eventUrl(calendarId, eventId)}?${params.toString()}`, {
        method: 'PATCH',
        body: eventBody(event),
      });
    },

    async deleteEvent(calendarId, eventId, sendUpdates) {
      const params = new URLSearchParams({ sendUpdates });
      try {
        await googleJson(options, `${eventUrl(calendarId, eventId)}?${params.toString()}`, { method: 'DELETE' });
        return 'deleted';
      } catch (error) {
        if (error instanceof GoogleApiError && (error.status === 404 || error.status === 410)) return 'gone';
        throw error;
      }
    },
  };
}
