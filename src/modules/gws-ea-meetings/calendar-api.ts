/**
 * The host's own Google Calendar client. No client library: each call is one
 * `fetch` with the token in its header, so the token never reaches a
 * container or an argument list.
 *
 * `getEvent`, `listEvents` and every write fetch no title, description or
 * location, so what they return can serve external-email. The host-only
 * `listLocatedEvents` adds location for availability; detail reads also carry titles and names.
 */
import { isRecord } from '../../gws-ea/validation.js';
import type { CalendarListEntry } from '../gws-ea-inbox/calendar-notifications.js';
import { GoogleApiError, googleJson, type GoogleClientOptions } from '../gws-ea-inbox/gmail-api.js';

export interface EventTime {
  /** A timed event's instant, with its offset. */
  readonly dateTime?: string;
  /** An all-day event's date, `YYYY-MM-DD`. */
  readonly date?: string;
  readonly timeZone?: string;
}

export interface EventAttendee {
  readonly email?: string;
  readonly responseStatus?: string;
  /** A room or other resource, never a person. */
  readonly resource?: boolean;
  readonly organizer?: boolean;
  /** The entry for the calendar this copy sits on: on a principal calendar, the principal's own answer. */
  readonly self?: boolean;
}

/** Google creates a requested Meet link asynchronously: pending, then success or failure. */
export interface EventConference {
  readonly status: 'pending' | 'success' | 'failure';
  readonly uri?: string;
}

/** An event as the host reads it: no title, description or location. */
export interface CalendarEvent {
  readonly id: string;
  /** The version used to avoid overwriting an intervening edit. */
  readonly etag?: string;
  readonly iCalUID?: string;
  readonly status?: string;
  readonly transparency?: string;
  readonly organizer?: { readonly email?: string };
  readonly attendees?: readonly EventAttendee[];
  readonly start?: EventTime;
  readonly end?: EventTime;
  /** Google's private extended properties, where the assistant marks its own events. */
  readonly tags?: Readonly<Record<string, string>>;
  readonly conference?: EventConference;
}

/**
 * An event as a listing returns it: a calendar shared with the assistant as
 * free/busy only may list a busy block without an id, and it still counts.
 */
export type ListedEvent = Omit<CalendarEvent, 'id'> & { readonly id?: string };

/** Host-only availability input: location may be private and never reaches an outward result. */
export interface LocatedEvent extends ListedEvent {
  readonly location?: string;
}

export interface DetailedConference extends EventConference {
  readonly entryPoints: readonly { readonly entryPointType: string; readonly uri: string; readonly label?: string }[];
}

export interface DetailedAttendee extends EventAttendee {
  readonly displayName?: string;
}

export interface ReminderOverride {
  readonly method: 'email' | 'popup';
  readonly minutes: number;
}

export interface EventSource {
  readonly title?: string;
  readonly url?: string;
}

/** Host-only detail: titles and names never reach an outward reader. */
export interface DetailedEvent {
  readonly visibility?: string;
  readonly reminders?: 'default' | 'none' | 'custom';
  readonly reminderOverrides?: readonly ReminderOverride[];
  readonly guestsCanModify?: boolean;
  readonly guestsCanInviteOthers?: boolean;
  readonly guestsCanSeeOtherGuests?: boolean;
  readonly attachments?: readonly unknown[];
  readonly privateCopy?: boolean;
  readonly endTimeUnspecified?: boolean;
  readonly anyoneCanAddSelf?: boolean;
  readonly colorId?: string;
  readonly source?: EventSource;
  readonly sharedTags?: Readonly<Record<string, string>>;
  readonly etag?: string;
  readonly description?: string;
  readonly location?: string;
  readonly creator?: { readonly email?: string; readonly displayName?: string; readonly self?: boolean };
  readonly eventType?: string;
  readonly tags?: Readonly<Record<string, string>>;
  readonly conference?: DetailedConference;
  /** The writable conference payload for preserving an existing link on a series split. */
  readonly conferenceData?: Readonly<Record<string, unknown>>;
  readonly id?: string;
  readonly iCalUID?: string;
  readonly status?: string;
  readonly transparency?: string;
  readonly summary?: string;
  readonly organizer?: { readonly email?: string; readonly self?: boolean };
  readonly attendees?: readonly DetailedAttendee[];
  /** Google left some guests out of `attendees`. */
  readonly attendeesOmitted?: boolean;
  readonly recurringEventId?: string;
  readonly recurrence?: readonly string[];
  /** An occurrence's start before it moved, the same on every copy of it. */
  readonly originalStartTime?: EventTime;
  readonly start?: EventTime;
  readonly end?: EventTime;
}

export type SendUpdates = 'all' | 'none';

/** `summary` is the calendar's own name, which the invitations of events on it show. */
export interface CalendarEntry extends CalendarListEntry {
  readonly summary?: string;
}

/** Google starts a guest it is given no answer for at `needsAction`, the calendar's own owner included. */
export interface GuestWrite {
  readonly email: string;
  readonly responseStatus?: string;
}

/**
 * A guest exactly as Google holds it, every field kept, so a guest list
 * written back changes nobody else's answer, note, or flags.
 */
export type GuestRecord = Readonly<Record<string, unknown>>;

export interface EventGuests {
  /**
   * The version of the event this list was read from. Google gives the
   * event a new one on every change, a guest's answer included, so a list
   * written back over it cannot undo a change made since.
   */
  readonly etag?: string;
  readonly status?: string;
  /** The organizer's address, lowercased: the calendar the event belongs to. */
  readonly organizer?: string;
  readonly guests: readonly GuestRecord[];
  /** Google left guests out of `guests`: written back whole, the list would lose them. */
  readonly attendeesOmitted?: boolean;
  /** The series this occurrence belongs to: a write on it changes that occurrence alone. */
  readonly recurringEventId?: string;
  /** The event repeats: a write on it changes every occurrence. */
  readonly recurrence?: readonly string[];
  readonly summary?: string;
  readonly description?: string;
  readonly location?: string;
}

/** The fields a write sets; times are instants, or dates for an all-day event. */
export interface EventWrite {
  readonly summary?: string;
  readonly description?: string;
  readonly location?: string;
  /** Ask Google to create a Meet link, under a request id it ignores when repeated. */
  readonly conference?: { readonly requestId: string };
  /** An existing conference read by the host, without its createRequest. */
  readonly conferenceData?: Readonly<Record<string, unknown>>;
  readonly start?: string;
  readonly end?: string;
  /** The zone the event's times display in. */
  readonly timeZone?: string;
  /** Its times are dates, `YYYY-MM-DD`, the end the day after its last: an all-day event. */
  readonly allDay?: boolean;
  /** Its repetition, as RRULE, EXRULE, RDATE and EXDATE lines. */
  readonly recurrence?: readonly string[];
  /** A write with them replaces the whole guest list, the calendar's owner included. */
  readonly attendees?: readonly GuestWrite[];
  readonly visibility?: 'default' | 'private' | 'public' | 'confidential';
  readonly transparency?: 'opaque' | 'transparent';
  /** `none` turns every reminder off; `default` keeps the calendar's own. */
  readonly reminders?: 'default' | 'none' | 'custom';
  readonly reminderOverrides?: readonly ReminderOverride[];
  readonly guestsCanModify?: boolean;
  readonly guestsCanInviteOthers?: boolean;
  readonly guestsCanSeeOtherGuests?: boolean;
  readonly colorId?: string;
  readonly source?: EventSource;
  readonly sharedTags?: Readonly<Record<string, string>>;
  /** Private extended properties. */
  readonly tags?: Readonly<Record<string, string>>;
  /** Restores an event deleted earlier under the same id. */
  readonly status?: 'confirmed';
}

/**
 * `changed`: nothing written, since the event is no longer the version it
 * was read at; `gone`: the event no longer exists.
 */
export type GuestWriteResult = 'set' | 'changed' | 'gone';

export type NewEvent = EventWrite & { readonly start: string; readonly end: string };

export interface MeetingsCalendarApi {
  /** Undefined when the calendar is not on the assistant's calendar list. */
  getCalendar(calendarId: string): Promise<CalendarEntry | undefined>;
  listCalendars(): Promise<CalendarEntry[]>;
  /** Undefined when the event does not exist; a deleted event reads as `cancelled`. */
  getEvent(calendarId: string, eventId: string): Promise<CalendarEvent | undefined>;
  /** Main-only detail; the outward getter above remains title-free. */
  getEventDetail(calendarId: string, eventId: string): Promise<DetailedEvent | undefined>;
  freeBusy(
    calendarIds: readonly string[],
    timeMin: string,
    timeMax: string,
  ): Promise<Readonly<Record<string, readonly { readonly start: string; readonly end: string }[]>>>;
  /** Every live event that overlaps the interval, recurring events expanded. */
  listEvents(calendarId: string, timeMin: string, timeMax: string): Promise<ListedEvent[]>;
  listLocatedEvents(calendarId: string, timeMin: string, timeMax: string): Promise<LocatedEvent[]>;
  /** Host-only titles, names and series; outward answers project only permitted facts. */
  listEventDetails(calendarId: string, timeMin: string, timeMax: string): Promise<DetailedEvent[]>;
  /** `exists` when Google already holds that id, deleted or not. */
  insertEvent(
    calendarId: string,
    eventId: string,
    event: NewEvent,
    sendUpdates: SendUpdates,
  ): Promise<'created' | 'exists'>;
  patchEvent(
    calendarId: string,
    eventId: string,
    event: EventWrite,
    sendUpdates: SendUpdates,
    etag?: string,
  ): Promise<void>;
  /** With the event's version and its title, notes and place; undefined when the event does not exist. */
  getGuests(calendarId: string, eventId: string): Promise<EventGuests | undefined>;
  /** Replaces the guest list, each guest as given; with `etag`, only while the event is still that version. */
  setGuests(
    calendarId: string,
    eventId: string,
    guests: readonly GuestRecord[],
    sendUpdates: SendUpdates,
    etag?: string,
  ): Promise<GuestWriteResult>;
  /**
   * Write only the calendar's own entry on an event's guest list, the rest
   * of the list left as Google holds it (`attendeesOmitted`), over `etag`'s
   * version: how a guest's own answer is written.
   */
  setOwnEntry(
    calendarId: string,
    eventId: string,
    entry: GuestRecord,
    sendUpdates: SendUpdates,
    etag?: string,
  ): Promise<GuestWriteResult>;
  /** `gone` when the event was already deleted or never existed. */
  deleteEvent(
    calendarId: string,
    eventId: string,
    sendUpdates: SendUpdates,
    etag?: string,
  ): Promise<'deleted' | 'gone'>;
}

const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
const EVENT_FIELDS =
  'id,etag,iCalUID,status,transparency,organizer(email),attendees(email,responseStatus,resource,organizer,self),start(dateTime,date),end(dateTime,date),extendedProperties(private),conferenceData(createRequest(status(statusCode)),entryPoints(entryPointType,uri))';
const LOCATED_FIELDS = `${EVENT_FIELDS},location`;
/** Includes titles and names, so nothing read with it may reach external-email. */
const DETAIL_FIELDS =
  'id,etag,iCalUID,status,transparency,visibility,reminders(useDefault,overrides(method,minutes)),guestsCanModify,guestsCanInviteOthers,guestsCanSeeOtherGuests,attachments,privateCopy,endTimeUnspecified,anyoneCanAddSelf,colorId,source,summary,description,location,creator(email,displayName,self),organizer(email,self),attendees(email,displayName,responseStatus,resource,organizer,self),attendeesOmitted,recurringEventId,recurrence,originalStartTime(dateTime,date,timeZone),start(dateTime,date,timeZone),end(dateTime,date,timeZone),eventType,extendedProperties(private,shared),conferenceData';
/** Google Meet's conference type, in a calendar's allowed types and in a create request. */
const GOOGLE_MEET = 'hangoutsMeet';
const MAX_PAGES = 10;

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function toTime(value: unknown, detail = false): EventTime | undefined {
  if (!isRecord(value)) return undefined;
  const dateTime = optionalString(value.dateTime);
  const date = optionalString(value.date);
  return {
    ...(dateTime === undefined ? {} : { dateTime }),
    ...(date === undefined ? {} : { date }),
    ...(detail && typeof value.timeZone === 'string' ? { timeZone: value.timeZone } : {}),
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
    ...(value.self === true ? { self: true } : {}),
  };
}

function toDetailedEvent(value: unknown): DetailedEvent {
  if (!isRecord(value)) throw new GoogleApiError(502, 'Google Calendar returned an unreadable event');
  const fields: Record<string, unknown> = {};
  for (const key of [
    'id',
    'etag',
    'iCalUID',
    'status',
    'transparency',
    'visibility',
    'summary',
    'description',
    'location',
    'eventType',
    'recurringEventId',
    'colorId',
  ] as const) {
    const text = optionalString(value[key]);
    if (text !== undefined) fields[key] = text;
  }
  if (isRecord(value.organizer)) {
    const email = optionalString(value.organizer.email);
    fields.organizer = {
      ...(email === undefined ? {} : { email: email.toLowerCase() }),
      ...(value.organizer.self === true ? { self: true } : {}),
    };
  }
  if (Array.isArray(value.attendees)) {
    fields.attendees = value.attendees.flatMap((entry): DetailedAttendee[] => {
      const attendee = toAttendee(entry);
      if (attendee === undefined || !isRecord(entry)) return [];
      const displayName = optionalString(entry.displayName);
      return [{ ...attendee, ...(displayName === undefined ? {} : { displayName }) }];
    });
  }
  if (value.attendeesOmitted === true) fields.attendeesOmitted = true;
  for (const key of [
    'guestsCanModify',
    'guestsCanInviteOthers',
    'guestsCanSeeOtherGuests',
    'privateCopy',
    'endTimeUnspecified',
    'anyoneCanAddSelf',
  ] as const)
    if (typeof value[key] === 'boolean') fields[key] = value[key];
  if (Array.isArray(value.attachments)) fields.attachments = value.attachments;
  if (isRecord(value.source))
    fields.source = {
      ...(typeof value.source.title === 'string' ? { title: value.source.title } : {}),
      ...(typeof value.source.url === 'string' ? { url: value.source.url } : {}),
    };
  if (isRecord(value.reminders)) {
    fields.reminders =
      value.reminders.useDefault === true
        ? 'default'
        : Array.isArray(value.reminders.overrides) && value.reminders.overrides.length
          ? 'custom'
          : 'none';
    if (
      Array.isArray(value.reminders.overrides) &&
      value.reminders.overrides.every(
        (override: unknown) =>
          isRecord(override) &&
          (override.method === 'email' || override.method === 'popup') &&
          typeof override.minutes === 'number' &&
          Number.isInteger(override.minutes) &&
          override.minutes >= 0 &&
          override.minutes <= 40_320,
      )
    )
      fields.reminderOverrides = value.reminders.overrides;
  }
  if (Array.isArray(value.recurrence))
    fields.recurrence = value.recurrence.filter((line): line is string => typeof line === 'string');
  for (const key of ['start', 'end', 'originalStartTime'] as const) {
    const time = toTime(value[key], true);
    if (time !== undefined) fields[key] = time;
  }
  if (isRecord(value.creator)) {
    const email = optionalString(value.creator.email);
    const displayName = optionalString(value.creator.displayName);
    fields.creator = {
      ...(email === undefined ? {} : { email: email.toLowerCase() }),
      ...(displayName === undefined ? {} : { displayName }),
      ...(value.creator.self === true ? { self: true } : {}),
    };
  }
  const tags = toTags(value.extendedProperties);
  const conference = toDetailedConference(value.conferenceData);
  if (tags) fields.tags = tags;
  const sharedTags = isRecord(value.extendedProperties) ? stringProperties(value.extendedProperties.shared) : undefined;
  if (sharedTags) fields.sharedTags = sharedTags;
  if (conference) fields.conference = conference;
  if (isRecord(value.conferenceData)) {
    const copy = Object.fromEntries(Object.entries(value.conferenceData).filter(([key]) => key !== 'createRequest'));
    if (Object.keys(copy).length) fields.conferenceData = copy;
  }
  return fields as DetailedEvent;
}

function toTags(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value) || !isRecord(value.private)) return undefined;
  return stringProperties(value.private);
}
function stringProperties(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const tags = Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
  return Object.keys(tags).length === 0 ? undefined : tags;
}

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

function toDetailedConference(value: unknown): DetailedConference | undefined {
  if (!isRecord(value)) return undefined;
  const entryPoints = Array.isArray(value.entryPoints)
    ? value.entryPoints.flatMap((entry) => {
        if (!isRecord(entry) || typeof entry.entryPointType !== 'string' || typeof entry.uri !== 'string') return [];
        return [
          {
            entryPointType: entry.entryPointType,
            uri: entry.uri,
            ...(typeof entry.label === 'string' ? { label: entry.label } : {}),
          },
        ];
      })
    : [];
  const conference = toConference(value) ?? (entryPoints.length ? { status: 'success' as const } : undefined);
  if (!conference) return undefined;
  return { ...conference, entryPoints };
}

function toListedEvent(value: unknown): ListedEvent {
  if (!isRecord(value)) throw new GoogleApiError(502, 'Google Calendar returned an unreadable event');
  const id = optionalString(value.id);
  const organizerEmail = isRecord(value.organizer) ? optionalString(value.organizer.email) : undefined;
  const start = toTime(value.start);
  const end = toTime(value.end);
  const etag = optionalString(value.etag);
  const iCalUID = optionalString(value.iCalUID);
  const status = optionalString(value.status);
  const transparency = optionalString(value.transparency);
  const tags = toTags(value.extendedProperties);
  const conference = toConference(value.conferenceData);
  return {
    ...(id === undefined ? {} : { id }),
    ...(etag === undefined ? {} : { etag }),
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

function toEvent(value: unknown): CalendarEvent {
  const event = toListedEvent(value);
  if (event.id === undefined) throw new GoogleApiError(502, 'Google Calendar returned an event without an id');
  return { ...event, id: event.id };
}

function toLocatedEvent(value: unknown): LocatedEvent {
  const event = toListedEvent(value);
  const location = isRecord(value) ? optionalString(value.location) : undefined;
  return { ...event, ...(location === undefined ? {} : { location }) };
}

function eventTime(at: string, timeZone: string | undefined, allDay: boolean | undefined): Record<string, string> {
  return { ...(allDay === true ? { date: at } : { dateTime: at }), ...(timeZone === undefined ? {} : { timeZone }) };
}

function eventBody(event: EventWrite, id?: string): Record<string, unknown> {
  if (event.reminders === 'custom' && event.reminderOverrides === undefined)
    throw new Error('Custom reminders need their complete overrides before an event can be written');
  return {
    ...(id === undefined ? {} : { id }),
    ...(event.status === undefined ? {} : { status: event.status }),
    ...(event.summary === undefined ? {} : { summary: event.summary }),
    ...(event.description === undefined ? {} : { description: event.description }),
    ...(event.location === undefined ? {} : { location: event.location }),
    ...(event.conference === undefined
      ? event.conferenceData === undefined
        ? {}
        : { conferenceData: event.conferenceData }
      : {
          conferenceData: {
            createRequest: { requestId: event.conference.requestId, conferenceSolutionKey: { type: GOOGLE_MEET } },
          },
        }),
    ...(event.start === undefined ? {} : { start: eventTime(event.start, event.timeZone, event.allDay) }),
    ...(event.end === undefined ? {} : { end: eventTime(event.end, event.timeZone, event.allDay) }),
    ...(event.recurrence === undefined ? {} : { recurrence: [...event.recurrence] }),
    ...(event.attendees === undefined
      ? {}
      : {
          attendees: event.attendees.map((guest) => ({ ...guest })),
        }),
    ...(event.visibility === undefined ? {} : { visibility: event.visibility }),
    ...(event.transparency === undefined ? {} : { transparency: event.transparency }),
    ...(event.guestsCanModify === undefined ? {} : { guestsCanModify: event.guestsCanModify }),
    ...(event.guestsCanInviteOthers === undefined ? {} : { guestsCanInviteOthers: event.guestsCanInviteOthers }),
    ...(event.guestsCanSeeOtherGuests === undefined ? {} : { guestsCanSeeOtherGuests: event.guestsCanSeeOtherGuests }),
    ...(event.colorId === undefined ? {} : { colorId: event.colorId }),
    ...(event.source === undefined ? {} : { source: event.source }),
    ...(event.reminders === undefined
      ? {}
      : {
          reminders:
            event.reminders === 'custom'
              ? { useDefault: false, overrides: event.reminderOverrides }
              : event.reminders === 'none'
                ? { useDefault: false, overrides: [] }
                : { useDefault: true },
        }),
    ...(event.tags === undefined && event.sharedTags === undefined
      ? {}
      : {
          extendedProperties: {
            ...(event.tags === undefined ? {} : { private: { ...event.tags } }),
            ...(event.sharedTags === undefined ? {} : { shared: { ...event.sharedTags } }),
          },
        }),
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

export function allowsMeet(entry: CalendarListEntry): boolean {
  return entry.conferenceTypes?.includes(GOOGLE_MEET) === true;
}

/**
 * An id-only answer keeps the event's words out of every write's response;
 * Google acts on a Meet request only with `conferenceDataVersion` 1.
 */
function writeParams(event: EventWrite, sendUpdates: SendUpdates): URLSearchParams {
  return new URLSearchParams({
    sendUpdates,
    fields: 'id',
    ...(event.conference === undefined && event.conferenceData === undefined ? {} : { conferenceDataVersion: '1' }),
  });
}

function isGone(error: unknown): boolean {
  return error instanceof GoogleApiError && (error.status === 404 || error.status === 410);
}

async function guestWrite(write: Promise<unknown>): Promise<GuestWriteResult> {
  try {
    await write;
    return 'set';
  } catch (error) {
    // 412 Precondition Failed: the event is no longer the version the list was read from.
    if (error instanceof GoogleApiError && error.status === 412) return 'changed';
    if (isGone(error)) return 'gone';
    throw error;
  }
}

export function createMeetingsCalendarApi(options: GoogleClientOptions): MeetingsCalendarApi {
  /**
   * Every page of a Google list, read whole: a listing too long to read fails
   * rather than coming back short, because a missing calendar or event would
   * look exactly like an empty or free one.
   */
  async function readAllPages<T>(
    path: string,
    params: Record<string, string>,
    noun: 'event list' | 'calendar list',
    toItem: (value: unknown) => T,
  ): Promise<T[]> {
    const items: T[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const query = new URLSearchParams({ ...params, maxResults: '250' });
      if (pageToken !== undefined) query.set('pageToken', pageToken);
      const payload = await googleJson(options, `${CALENDAR_API}/${path}?${query.toString()}`);
      if (!isRecord(payload)) throw new GoogleApiError(502, `Google Calendar returned an unreadable ${noun}`);
      if (Array.isArray(payload.items)) items.push(...payload.items.map(toItem));
      pageToken = optionalString(payload.nextPageToken);
      if (pageToken === undefined) return items;
    }
    throw new GoogleApiError(
      502,
      `Google Calendar returned ${noun === 'event list' ? 'an' : 'a'} ${noun} too long to read`,
    );
  }

  function listPages<T>(
    calendarId: string,
    timeMin: string,
    timeMax: string,
    fields: string,
    toItem: (value: unknown) => T,
  ): Promise<T[]> {
    return readAllPages(
      `calendars/${encodeURIComponent(calendarId)}/events`,
      { timeMin, timeMax, singleEvents: 'true', fields: `items(${fields}),nextPageToken` },
      'event list',
      toItem,
    );
  }

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

    async getEventDetail(calendarId, eventId) {
      const params = new URLSearchParams({ fields: DETAIL_FIELDS });
      try {
        const payload = await googleJson(options, `${eventUrl(calendarId, eventId)}?${params.toString()}`, {
          allowNotFound: true,
        });
        return payload === undefined ? undefined : toDetailedEvent(payload);
      } catch (error) {
        if (isGone(error)) return undefined;
        throw error;
      }
    },

    async freeBusy(calendarIds, timeMin, timeMax) {
      const payload = await googleJson(options, `${CALENDAR_API}/freeBusy`, {
        method: 'POST',
        body: { timeMin, timeMax, items: calendarIds.map((id) => ({ id })) },
      });
      if (!isRecord(payload) || !isRecord(payload.calendars))
        throw new GoogleApiError(502, 'Google returned an unreadable busy-time answer');
      const result: Record<string, { start: string; end: string }[]> = {};
      for (const id of calendarIds) {
        const entry = payload.calendars[id];
        if (!isRecord(entry) || (Array.isArray(entry.errors) && entry.errors.length > 0) || !Array.isArray(entry.busy))
          throw new GoogleApiError(502, 'Google could not read every requested calendar’s busy time');
        result[id] = entry.busy.map((window: unknown) => {
          if (
            !isRecord(window) ||
            typeof window.start !== 'string' ||
            typeof window.end !== 'string' ||
            !Number.isFinite(Date.parse(window.start)) ||
            !Number.isFinite(Date.parse(window.end)) ||
            Date.parse(window.end) <= Date.parse(window.start)
          )
            throw new GoogleApiError(502, 'Google returned an unreadable busy-time window');
          return { start: window.start, end: window.end };
        });
      }
      return result;
    },

    listCalendars: () => readAllPages('users/me/calendarList', {}, 'calendar list', toCalendarEntry),

    listEvents: (calendarId, timeMin, timeMax) => listPages(calendarId, timeMin, timeMax, EVENT_FIELDS, toListedEvent),

    listLocatedEvents: (calendarId, timeMin, timeMax) =>
      listPages(calendarId, timeMin, timeMax, LOCATED_FIELDS, toLocatedEvent),

    listEventDetails: (calendarId, timeMin, timeMax) =>
      listPages(calendarId, timeMin, timeMax, DETAIL_FIELDS, toDetailedEvent),

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

    async patchEvent(calendarId, eventId, event, sendUpdates, etag) {
      const params = writeParams(event, sendUpdates);
      await googleJson(options, `${eventUrl(calendarId, eventId)}?${params.toString()}`, {
        method: 'PATCH',
        body: eventBody(event),
        ...(etag === undefined ? {} : { ifMatch: etag }),
      });
    },

    async getGuests(calendarId, eventId) {
      const params = new URLSearchParams({
        fields:
          'etag,status,organizer(email),attendees,attendeesOmitted,recurringEventId,recurrence,summary,description,location',
      });
      let payload: unknown;
      try {
        payload = await googleJson(options, `${eventUrl(calendarId, eventId)}?${params.toString()}`, {
          allowNotFound: true,
        });
      } catch (error) {
        if (isGone(error)) return undefined;
        throw error;
      }
      if (payload === undefined) return undefined;
      if (!isRecord(payload)) throw new GoogleApiError(502, 'Google Calendar returned an unreadable event');
      const etag = optionalString(payload.etag);
      const status = optionalString(payload.status);
      const organizer = isRecord(payload.organizer) ? optionalString(payload.organizer.email) : undefined;
      const recurringEventId = optionalString(payload.recurringEventId);
      const recurrence = Array.isArray(payload.recurrence)
        ? payload.recurrence.filter((line): line is string => typeof line === 'string')
        : undefined;
      const summary = optionalString(payload.summary);
      const description = optionalString(payload.description);
      const location = optionalString(payload.location);
      return {
        ...(etag === undefined ? {} : { etag }),
        ...(status === undefined ? {} : { status }),
        ...(organizer === undefined ? {} : { organizer: organizer.toLowerCase() }),
        guests: Array.isArray(payload.attendees) ? payload.attendees.filter(isRecord) : [],
        ...(payload.attendeesOmitted === true ? { attendeesOmitted: true } : {}),
        ...(recurringEventId === undefined ? {} : { recurringEventId }),
        ...(recurrence === undefined || recurrence.length === 0 ? {} : { recurrence }),
        ...(summary === undefined ? {} : { summary }),
        ...(description === undefined ? {} : { description }),
        ...(location === undefined ? {} : { location }),
      };
    },

    setGuests(calendarId, eventId, guests, sendUpdates, etag) {
      const params = new URLSearchParams({ sendUpdates, fields: 'id' });
      return guestWrite(
        googleJson(options, `${eventUrl(calendarId, eventId)}?${params.toString()}`, {
          method: 'PATCH',
          body: { attendees: guests },
          ...(etag === undefined ? {} : { ifMatch: etag }),
        }),
      );
    },

    setOwnEntry(calendarId, eventId, entry, sendUpdates, etag) {
      const params = new URLSearchParams({ sendUpdates, fields: 'id' });
      return guestWrite(
        googleJson(options, `${eventUrl(calendarId, eventId)}?${params.toString()}`, {
          method: 'PATCH',
          body: { attendeesOmitted: true, attendees: [entry] },
          ...(etag === undefined ? {} : { ifMatch: etag }),
        }),
      );
    },

    async deleteEvent(calendarId, eventId, sendUpdates, etag) {
      const params = new URLSearchParams({ sendUpdates });
      try {
        await googleJson(options, `${eventUrl(calendarId, eventId)}?${params.toString()}`, {
          method: 'DELETE',
          ...(etag === undefined ? {} : { ifMatch: etag }),
        });
        return 'deleted';
      } catch (error) {
        if (isGone(error)) return 'gone';
        throw error;
      }
    },
  };
}
