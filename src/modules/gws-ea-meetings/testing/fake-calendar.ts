/**
 * An in-memory Google Calendar, as the assistant's host token sees it, for
 * the scheduling tools' tests. It keeps what Google keeps: a deleted event
 * stays under its id as `cancelled`, an id is never issued twice, and a
 * Meet link is created once per request id, as `meetCreation` says it goes.
 * A guest a write gives no answer awaits one, and the calendar's own owner is
 * the organizer, as the live Calendar showed (2026-10-07). Every change to
 * an event gives it a new etag, and a guest-list write over an older one
 * is refused, as Google refuses it with 412.
 */
import { GoogleApiError } from '../../gws-ea-inbox/gmail-api.js';
import type {
  CalendarEntry,
  CalendarEvent,
  DetailedAttendee,
  DetailedEvent,
  EventAttendee,
  EventTime,
  EventConference,
  EventGuests,
  EventWrite,
  GuestRecord,
  MeetingsCalendarApi,
  NewEvent,
  SendUpdates,
} from '../calendar-api.js';

/** An event as Google stores it, text included, on one calendar. */
export interface StoredEvent extends Omit<CalendarEvent, 'organizer' | 'attendees'> {
  readonly calendarId: string;
  readonly organizer?: { readonly email?: string; readonly self?: boolean };
  readonly attendees?: readonly DetailedAttendee[];
  readonly attendeesOmitted?: boolean;
  readonly recurringEventId?: string;
  readonly originalStartTime?: EventTime;
  readonly summary?: string;
  readonly description?: string;
  readonly location?: string;
  readonly visibility?: string;
  readonly reminders?: 'default' | 'none';
  readonly recurrence?: readonly string[];
  /** Each guest whole, as Google holds them, once a test or a guest-list write sets more than `attendees` keeps. */
  readonly guests?: readonly GuestRecord[];
  /** Its version: every change to it, a test's own `put` included, gives it a new one. */
  readonly etag?: string;
}

export interface CalendarWriteRecord {
  readonly op: 'insert' | 'patch' | 'guests' | 'delete';
  readonly calendarId: string;
  readonly eventId: string;
  readonly sendUpdates: SendUpdates;
  readonly fields?: EventWrite;
  /** A guest-list write's guests, as the host sent them. */
  readonly guests?: readonly GuestRecord[];
}

type WriteOp = CalendarWriteRecord['op'];

/** A write that fails once: before Google applies it, or after (the answer lost on the way back). */
export interface InjectedFailure {
  readonly op: WriteOp;
  readonly error: Error;
  readonly afterApplying?: boolean;
}

function overlapsInterval(event: CalendarEvent, min: number, max: number): boolean {
  const start = event.start?.dateTime ?? (event.start?.date ? `${event.start.date}T00:00:00Z` : undefined);
  const end = event.end?.dateTime ?? (event.end?.date ? `${event.end.date}T00:00:00Z` : undefined);
  if (start === undefined || end === undefined) return false;
  // All-day dates are read loosely, a day either side: the host works out their local span itself.
  const slack = event.start?.dateTime === undefined ? 86_400_000 : 0;
  return Date.parse(start) - slack < max && Date.parse(end) + slack > min;
}

/** A guest as Google stores one a write lists: awaiting an answer unless given one, the calendar's owner its organizer. */
function stored(calendarId: string, guest: GuestRecord): GuestRecord {
  const email = typeof guest.email === 'string' ? guest.email.toLowerCase() : undefined;
  return {
    ...guest,
    ...(email === undefined ? {} : { email }),
    ...(typeof guest.responseStatus === 'string' ? {} : { responseStatus: 'needsAction' }),
    ...(email === calendarId.toLowerCase() ? { organizer: true } : {}),
  };
}

/** A stored guest as an event read shows them. */
function attendee(guest: GuestRecord): EventAttendee {
  return {
    ...(typeof guest.email === 'string' ? { email: guest.email } : {}),
    ...(typeof guest.responseStatus === 'string' ? { responseStatus: guest.responseStatus } : {}),
    ...(guest.resource === true ? { resource: true } : {}),
    ...(guest.organizer === true ? { organizer: true } : {}),
  };
}

/** An event with these guests, stored as Google stores them. */
function withGuests(event: StoredEvent, guests: readonly GuestRecord[]): StoredEvent {
  const kept = guests.map((guest) => stored(event.calendarId, guest));
  return { ...event, guests: kept, attendees: kept.map(attendee) };
}

function apply(written: StoredEvent, fields: EventWrite, meet: EventConference['status']): StoredEvent {
  const event =
    fields.attendees === undefined
      ? written
      : withGuests(
          written,
          fields.attendees.map((guest) => ({ ...guest })),
        );
  const conference: EventConference | undefined =
    event.conference ??
    (fields.conference === undefined
      ? undefined
      : meet === 'success'
        ? { status: 'success', uri: `https://meet.google.com/${fields.conference.requestId.slice(0, 10)}` }
        : { status: meet });
  return {
    ...event,
    ...(fields.status === undefined ? {} : { status: fields.status }),
    ...(fields.summary === undefined ? {} : { summary: fields.summary }),
    ...(fields.description === undefined ? {} : { description: fields.description }),
    ...(fields.location === undefined ? {} : { location: fields.location }),
    ...(conference === undefined ? {} : { conference }),
    ...(fields.start === undefined
      ? {}
      : { start: fields.allDay === true ? { date: fields.start } : { dateTime: fields.start } }),
    ...(fields.end === undefined
      ? {}
      : { end: fields.allDay === true ? { date: fields.end } : { dateTime: fields.end } }),
    ...(fields.recurrence === undefined ? {} : { recurrence: [...fields.recurrence] }),
    ...(fields.visibility === undefined ? {} : { visibility: fields.visibility }),
    ...(fields.transparency === undefined ? {} : { transparency: fields.transparency }),
    ...(fields.reminders === undefined ? {} : { reminders: fields.reminders }),
    ...(fields.tags === undefined ? {} : { tags: { ...fields.tags } }),
  };
}

export class FakeCalendar implements MeetingsCalendarApi {
  readonly calendars = new Map<string, CalendarEntry>();
  readonly events: StoredEvent[] = [];
  readonly writes: CalendarWriteRecord[] = [];
  calls = 0;
  failure: Error | undefined;
  /** How Google's creation of a Meet link a write asks for goes. */
  meetCreation: EventConference['status'] = 'success';
  private injected: InjectedFailure[] = [];
  private afterGuestReads: (() => void)[] = [];
  private revision = 0;

  private call(): void {
    this.calls += 1;
    if (this.failure) throw this.failure;
  }

  /** Fail the next write of `op` once. */
  failNext(failure: InjectedFailure): void {
    this.injected.push(failure);
  }

  private injectedFor(op: WriteOp): InjectedFailure | undefined {
    const index = this.injected.findIndex((failure) => failure.op === op);
    return index < 0 ? undefined : this.injected.splice(index, 1)[0];
  }

  /**
   * Run `change` once, right after the next guest-list read takes its copy:
   * someone else changing the event between that read and the write that
   * follows it.
   */
  changeAfterNextGuestRead(change: () => void): void {
    this.afterGuestReads.push(change);
  }

  /** The event at a new version. */
  private revised(event: StoredEvent): StoredEvent {
    this.revision += 1;
    return { ...event, etag: `"${this.revision}"` };
  }

  private find(calendarId: string, eventId: string): number {
    return this.events.findIndex((e) => e.calendarId === calendarId && e.id === eventId);
  }

  /** The stored event, text included. */
  event(calendarId: string, eventId: string): StoredEvent | undefined {
    return this.events.find((e) => e.calendarId === calendarId && e.id === eventId);
  }

  /** Every event on a calendar that is not deleted. */
  live(calendarId?: string): StoredEvent[] {
    return this.events.filter(
      (e) => e.status !== 'cancelled' && (calendarId === undefined || e.calendarId === calendarId),
    );
  }

  put(event: StoredEvent): void {
    const index = this.find(event.calendarId, event.id);
    if (index >= 0) this.events.splice(index, 1, this.revised(event));
    else this.events.push(this.revised(event));
  }

  remove(calendarId: string, eventId: string): void {
    const index = this.find(calendarId, eventId);
    if (index >= 0) this.events.splice(index, 1);
  }

  async getCalendar(calendarId: string) {
    this.call();
    return this.calendars.get(calendarId.toLowerCase());
  }

  async listCalendars() {
    this.call();
    return [...this.calendars.values()];
  }

  async getEvent(calendarId: string, eventId: string) {
    this.call();
    return this.event(calendarId, eventId);
  }

  async listEvents(calendarId: string, timeMin: string, timeMax: string) {
    this.call();
    const min = Date.parse(timeMin);
    const max = Date.parse(timeMax);
    return this.live(calendarId).filter((e) => overlapsInterval(e, min, max));
  }

  /** As Google lists them with titles and names: everything stored but the assistant's tags and the calendar. */
  async listEventDetails(calendarId: string, timeMin: string, timeMax: string): Promise<DetailedEvent[]> {
    const listed = await this.listEvents(calendarId, timeMin, timeMax);
    return listed.map(
      ({ calendarId: _calendar, tags: _tags, conference: _conference, guests: _guests, etag: _etag, ...event }) =>
        event,
    );
  }

  async insertEvent(calendarId: string, eventId: string, event: NewEvent, sendUpdates: SendUpdates) {
    this.call();
    const failure = this.injectedFor('insert');
    if (failure && !failure.afterApplying) throw failure.error;
    if (this.find(calendarId, eventId) >= 0) {
      if (failure) throw failure.error;
      return 'exists' as const;
    }
    this.events.push(
      this.revised(
        apply(
          {
            calendarId,
            id: eventId,
            iCalUID: `${eventId}@google.com`,
            status: 'confirmed',
            organizer: { email: calendarId },
          },
          event,
          this.meetCreation,
        ),
      ),
    );
    this.writes.push({ op: 'insert', calendarId, eventId, sendUpdates, fields: event });
    if (failure) throw failure.error;
    return 'created' as const;
  }

  async patchEvent(calendarId: string, eventId: string, event: EventWrite, sendUpdates: SendUpdates) {
    this.call();
    const failure = this.injectedFor('patch');
    if (failure && !failure.afterApplying) throw failure.error;
    const index = this.find(calendarId, eventId);
    if (index < 0)
      throw new GoogleApiError(404, `Google refused /calendars/${calendarId}/events/${eventId}: Not Found`);
    this.events.splice(index, 1, this.revised(apply(this.events[index], event, this.meetCreation)));
    this.writes.push({ op: 'patch', calendarId, eventId, sendUpdates, fields: event });
    if (failure) throw failure.error;
  }

  async getGuests(calendarId: string, eventId: string): Promise<EventGuests | undefined> {
    this.call();
    const event = this.event(calendarId, eventId);
    if (!event) return undefined;
    const read: EventGuests = {
      ...(event.etag === undefined ? {} : { etag: event.etag }),
      ...(event.status === undefined ? {} : { status: event.status }),
      ...(event.organizer?.email === undefined ? {} : { organizer: event.organizer.email.toLowerCase() }),
      guests: event.guests ?? (event.attendees ?? []).map((guest) => ({ ...guest })),
      ...(event.summary === undefined ? {} : { summary: event.summary }),
      ...(event.description === undefined ? {} : { description: event.description }),
      ...(event.location === undefined ? {} : { location: event.location }),
    };
    this.afterGuestReads.shift()?.();
    return read;
  }

  async setGuests(
    calendarId: string,
    eventId: string,
    guests: readonly GuestRecord[],
    sendUpdates: SendUpdates,
    etag?: string,
  ) {
    this.call();
    const failure = this.injectedFor('guests');
    if (failure && !failure.afterApplying) throw failure.error;
    const index = this.find(calendarId, eventId);
    if (index < 0)
      throw new GoogleApiError(404, `Google refused /calendars/${calendarId}/events/${eventId}: Not Found`);
    if (etag !== undefined && etag !== this.events[index].etag) {
      if (failure) throw failure.error;
      return 'changed' as const;
    }
    this.events.splice(index, 1, this.revised(withGuests(this.events[index], guests)));
    this.writes.push({ op: 'guests', calendarId, eventId, sendUpdates, guests });
    if (failure) throw failure.error;
    return 'set' as const;
  }

  async deleteEvent(calendarId: string, eventId: string, sendUpdates: SendUpdates) {
    this.call();
    const failure = this.injectedFor('delete');
    if (failure && !failure.afterApplying) throw failure.error;
    const index = this.find(calendarId, eventId);
    if (index < 0 || this.events[index].status === 'cancelled') {
      if (failure) throw failure.error;
      return 'gone' as const;
    }
    this.events.splice(index, 1, this.revised({ ...this.events[index], status: 'cancelled' }));
    this.writes.push({ op: 'delete', calendarId, eventId, sendUpdates });
    if (failure) throw failure.error;
    return 'deleted' as const;
  }
}

/** A client that forwards every call to whichever calendar `current` returns now. */
export function delegatingCalendarApi(current: () => MeetingsCalendarApi): MeetingsCalendarApi {
  return {
    getCalendar: (calendarId) => current().getCalendar(calendarId),
    listCalendars: () => current().listCalendars(),
    getEvent: (calendarId, eventId) => current().getEvent(calendarId, eventId),
    listEvents: (calendarId, timeMin, timeMax) => current().listEvents(calendarId, timeMin, timeMax),
    listEventDetails: (calendarId, timeMin, timeMax) => current().listEventDetails(calendarId, timeMin, timeMax),
    insertEvent: (calendarId, eventId, event, sendUpdates) =>
      current().insertEvent(calendarId, eventId, event, sendUpdates),
    patchEvent: (calendarId, eventId, event, sendUpdates) =>
      current().patchEvent(calendarId, eventId, event, sendUpdates),
    getGuests: (calendarId, eventId) => current().getGuests(calendarId, eventId),
    setGuests: (calendarId, eventId, guests, sendUpdates, etag) =>
      current().setGuests(calendarId, eventId, guests, sendUpdates, etag),
    deleteEvent: (calendarId, eventId, sendUpdates) => current().deleteEvent(calendarId, eventId, sendUpdates),
  };
}
