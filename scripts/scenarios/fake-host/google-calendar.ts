import type { FakeCalendar, StoredEvent } from '../../../src/modules/gws-ea-meetings/testing/fake-calendar.js';
import type { EventWrite, GuestRecord, SendUpdates } from '../../../src/modules/gws-ea-meetings/calendar-api.js';
import { GoogleApiError } from '../../../src/modules/gws-ea-inbox/gmail-api.js';

export const googleJson = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
export const googleError = (status: number, message: string): Response =>
  googleJson({ error: { code: status, message } }, status);

interface WireEvent extends Omit<EventWrite, 'start' | 'end' | 'conference' | 'reminders' | 'tags'> {
  readonly id?: string;
  readonly start?: { readonly date?: string; readonly dateTime?: string; readonly timeZone?: string };
  readonly end?: { readonly date?: string; readonly dateTime?: string; readonly timeZone?: string };
  readonly conferenceData?: { readonly createRequest?: { readonly requestId?: string } };
  readonly reminders?: { readonly useDefault?: boolean };
  readonly extendedProperties?: { readonly private?: Readonly<Record<string, string>> };
  readonly attendeesOmitted?: boolean;
}

function eventWrite(body: WireEvent, url: URL): EventWrite {
  const {
    start,
    end,
    conferenceData,
    reminders,
    extendedProperties,
    id: _id,
    attendeesOmitted: _omitted,
    ...fields
  } = body;
  const requestId = conferenceData?.createRequest?.requestId;
  return {
    ...fields,
    ...(start ? { start: start.dateTime ?? start.date, allDay: start.date !== undefined } : {}),
    ...(end ? { end: end.dateTime ?? end.date } : {}),
    ...(start?.timeZone ? { timeZone: start.timeZone } : {}),
    ...(requestId && url.searchParams.get('conferenceDataVersion') === '1' ? { conference: { requestId } } : {}),
    ...(reminders ? { reminders: reminders.useDefault ? 'default' : 'none' } : {}),
    ...(extendedProperties?.private ? { tags: extendedProperties.private } : {}),
  };
}

export function googleEvent(event: StoredEvent): Readonly<Record<string, unknown>> {
  const { calendarId: _calendar, tags, conference, guests, reminders, ...fields } = event;
  return {
    kind: 'calendar#event',
    ...fields,
    ...(guests ? { attendees: guests } : {}),
    ...(reminders
      ? { reminders: { useDefault: reminders === 'default', ...(reminders === 'none' ? { overrides: [] } : {}) } }
      : {}),
    ...(tags ? { extendedProperties: { private: tags } } : {}),
    ...(conference
      ? {
          conferenceData: {
            createRequest: { status: { statusCode: conference.status } },
            ...(conference.uri
              ? {
                  conferenceId: conference.uri.split('/').at(-1),
                  conferenceSolution: { key: { type: 'hangoutsMeet' }, name: 'Google Meet' },
                  entryPoints: [{ entryPointType: 'video', uri: conference.uri }],
                }
              : {}),
          },
        }
      : {}),
  };
}

/** Wire-level Google fixture. Every mutation and read uses the existing canonical Calendar. */
export async function calendarTransport(calendar: FakeCalendar, url: URL, init?: RequestInit): Promise<Response> {
  const method = init?.method ?? 'GET';
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (url.pathname === '/calendar/v3/freeBusy' && method === 'POST') {
    const body = JSON.parse(String(init?.body)) as { timeMin: string; timeMax: string; items: { id: string }[] };
    const calendars = await calendar.freeBusy(
      body.items.map(({ id }) => id),
      body.timeMin,
      body.timeMax,
    );
    return googleJson({
      kind: 'calendar#freeBusy',
      timeMin: body.timeMin,
      timeMax: body.timeMax,
      calendars: Object.fromEntries(
        body.items.map(({ id }) => [
          id,
          calendar.calendars.has(id) ? { busy: calendars[id] } : { errors: [{ reason: 'notFound', domain: 'global' }] },
        ]),
      ),
    });
  }
  const list = parts.indexOf('calendarList');
  if (list >= 0 && method === 'GET') {
    if (list !== 4 || parts[2] !== 'users' || parts[3] !== 'me' || parts.length > list + 2)
      throw new Error(`Unsupported synthetic Calendar operation: ${method} ${url.pathname}`);
    const entries = [...calendar.calendars.values()].map((entry) => ({
      ...entry,
      conferenceProperties: { allowedConferenceSolutionTypes: entry.conferenceTypes },
    }));
    const id = parts[list + 1];
    const entry = entries.find((entry) => entry.id === id);
    return id ? (entry ? googleJson(entry) : googleError(404, 'Calendar not found')) : googleJson({ items: entries });
  }
  const index = parts.indexOf('calendars');
  const calendarId = parts[index + 1] ?? '';
  if (index !== 2) throw new Error(`Unsupported synthetic Calendar operation: ${method} ${url.pathname}`);
  if (!calendar.calendars.has(calendarId)) return googleError(404, 'Calendar not found');
  if (parts[index + 2] !== 'events') {
    if (method !== 'GET' || parts.length !== index + 2)
      throw new Error(`Unsupported synthetic Calendar operation: ${method} ${url.pathname}`);
    return googleJson(calendar.calendars.get(calendarId));
  }
  if (parts.length > index + 4) throw new Error(`Unsupported synthetic Calendar operation: ${method} ${url.pathname}`);
  const eventId = parts[index + 3];
  if (method === 'GET') {
    if (eventId) {
      const event = calendar.event(calendarId, eventId);
      return event ? googleJson(googleEvent(event)) : googleError(404, 'Event not found');
    }
    const min = url.searchParams.get('timeMin');
    const max = url.searchParams.get('timeMax');
    const events = min && max ? await calendar.listEvents(calendarId, min, max) : calendar.live(calendarId);
    return googleJson({ kind: 'calendar#events', items: events.map((event) => googleEvent(event as StoredEvent)) });
  }
  const sendUpdates: SendUpdates = url.searchParams.get('sendUpdates') === 'all' ? 'all' : 'none';
  const etag = new Headers(init?.headers).get('if-match') ?? undefined;
  try {
    if (method === 'DELETE' && eventId) {
      const result = await calendar.deleteEvent(calendarId, eventId, sendUpdates, etag);
      return result === 'gone' ? googleError(410, 'Resource has been deleted') : new Response(null, { status: 204 });
    }
    const body = JSON.parse(String(init?.body)) as WireEvent;
    const fields = eventWrite(body, url);
    if (method === 'POST' && eventId === undefined && body.id && fields.start && fields.end) {
      const result = await calendar.insertEvent(
        calendarId,
        body.id,
        { ...fields, start: fields.start, end: fields.end },
        sendUpdates,
      );
      if (result === 'exists') return googleError(409, 'The requested identifier already exists');
    } else if (method === 'PATCH' && eventId) {
      const current = calendar.event(calendarId, eventId) as
        | (StoredEvent & { readonly guestsCanModify?: boolean })
        | undefined;
      if (
        current?.organizer?.email &&
        current.organizer.email !== calendarId &&
        current.guestsCanModify !== true &&
        body.attendeesOmitted !== true
      )
        return googleError(403, 'Forbidden: guests cannot modify this event');
      if (body.attendeesOmitted === true) {
        const entry = body.attendees?.[0];
        if (!entry || body.attendees?.length !== 1) return googleError(400, 'An own-entry write needs one guest');
        const result = await calendar.setOwnEntry(calendarId, eventId, { ...entry }, sendUpdates, etag);
        if (result !== 'set')
          return googleError(
            result === 'gone' ? 404 : 412,
            result === 'gone' ? 'Event not found' : 'Precondition Failed',
          );
      } else if (Object.keys(body).length === 1 && body.attendees) {
        const guests: GuestRecord[] = body.attendees.map((entry) => ({ ...entry }));
        const result = await calendar.setGuests(calendarId, eventId, guests, sendUpdates, etag);
        if (result !== 'set')
          return googleError(
            result === 'gone' ? 404 : 412,
            result === 'gone' ? 'Event not found' : 'Precondition Failed',
          );
      } else await calendar.patchEvent(calendarId, eventId, fields, sendUpdates, etag);
    } else throw new Error(`Unsupported synthetic Calendar operation: ${method} ${url.pathname}`);
    const saved = calendar.event(calendarId, eventId ?? body.id ?? '');
    if (!saved) throw new Error('Synthetic Calendar write did not store its event');
    return googleJson(url.searchParams.get('fields') === 'id' ? { id: saved.id } : googleEvent(saved));
  } catch (error) {
    if (error instanceof GoogleApiError) return googleError(error.status, error.message);
    throw error;
  }
}
