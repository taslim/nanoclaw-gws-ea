/**
 * An in-memory Google Calendar, as the assistant's host token sees it, for
 * the meetings module's tests. It keeps what Google keeps: a deleted event
 * stays under its id as `cancelled`, an id is never issued twice, and a
 * calendar whose free/busy is not shared reads as not visible.
 */
import type { CalendarListEntry } from '../../gws-ea-inbox/calendar-notifications.js';
import { GoogleApiError } from '../../gws-ea-inbox/gmail-api.js';
import type {
  CalendarEvent,
  EventWrite,
  FreeBusyCalendar,
  MeetingsCalendarApi,
  NewEvent,
  SendUpdates,
} from '../calendar-api.js';

/** An event as Google stores it, text included, on one calendar. */
export interface StoredEvent extends CalendarEvent {
  readonly calendarId: string;
  readonly summary?: string;
  readonly description?: string;
  readonly visibility?: string;
  readonly reminders?: 'default' | 'none';
}

export interface CalendarWriteRecord {
  readonly op: 'insert' | 'patch' | 'delete';
  readonly calendarId: string;
  readonly eventId: string;
  readonly sendUpdates: SendUpdates;
  readonly fields?: EventWrite;
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

function apply(event: StoredEvent, fields: EventWrite): StoredEvent {
  return {
    ...event,
    ...(fields.status === undefined ? {} : { status: fields.status }),
    ...(fields.summary === undefined ? {} : { summary: fields.summary }),
    ...(fields.description === undefined ? {} : { description: fields.description }),
    ...(fields.start === undefined ? {} : { start: { dateTime: fields.start } }),
    ...(fields.end === undefined ? {} : { end: { dateTime: fields.end } }),
    ...(fields.attendees === undefined
      ? {}
      : { attendees: fields.attendees.map((email) => ({ email, responseStatus: 'needsAction' })) }),
    ...(fields.visibility === undefined ? {} : { visibility: fields.visibility }),
    ...(fields.transparency === undefined ? {} : { transparency: fields.transparency }),
    ...(fields.reminders === undefined ? {} : { reminders: fields.reminders }),
    ...(fields.tags === undefined ? {} : { tags: { ...fields.tags } }),
  };
}

export class FakeCalendar implements MeetingsCalendarApi {
  readonly calendars = new Map<string, CalendarListEntry>();
  readonly events: StoredEvent[] = [];
  readonly writes: CalendarWriteRecord[] = [];
  /** Colleagues' shared free/busy, by address; an address absent here is hidden from the assistant. */
  readonly sharedFreeBusy = new Map<string, Array<{ start: string; end: string }>>();
  /** The address that organizes events the assistant creates on each calendar, when not the calendar's id. */
  readonly calendarOwners = new Map<string, string>();
  calls = 0;
  failure: Error | undefined;
  private injected: InjectedFailure[] = [];

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
    if (index >= 0) this.events.splice(index, 1, event);
    else this.events.push(event);
  }

  remove(calendarId: string, eventId: string): void {
    const index = this.find(calendarId, eventId);
    if (index >= 0) this.events.splice(index, 1);
  }

  async getCalendar(calendarId: string) {
    this.call();
    return this.calendars.get(calendarId.toLowerCase());
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

  async insertEvent(calendarId: string, eventId: string, event: NewEvent, sendUpdates: SendUpdates) {
    this.call();
    const failure = this.injectedFor('insert');
    if (failure && !failure.afterApplying) throw failure.error;
    if (this.find(calendarId, eventId) >= 0) {
      if (failure) throw failure.error;
      return 'exists' as const;
    }
    const organizer = this.calendarOwners.get(calendarId) ?? calendarId;
    this.events.push(
      apply(
        {
          calendarId,
          id: eventId,
          iCalUID: `${eventId}@google.com`,
          status: 'confirmed',
          organizer: { email: organizer },
        },
        event,
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
    this.events.splice(index, 1, apply(this.events[index], event));
    this.writes.push({ op: 'patch', calendarId, eventId, sendUpdates, fields: event });
    if (failure) throw failure.error;
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
    this.events.splice(index, 1, { ...this.events[index], status: 'cancelled' });
    this.writes.push({ op: 'delete', calendarId, eventId, sendUpdates });
    if (failure) throw failure.error;
    return 'deleted' as const;
  }

  async freeBusy(calendarIds: readonly string[], timeMin: string, timeMax: string) {
    this.call();
    const min = Date.parse(timeMin);
    const max = Date.parse(timeMax);
    return new Map<string, FreeBusyCalendar>(
      calendarIds.map((id) => {
        const shared = this.sharedFreeBusy.get(id.toLowerCase());
        return [
          id.toLowerCase(),
          shared === undefined
            ? { visible: false, busy: [] }
            : {
                visible: true,
                busy: shared.filter((busy) => Date.parse(busy.start) < max && Date.parse(busy.end) > min),
              },
        ];
      }),
    );
  }
}

/** A client that forwards every call to whichever calendar `current` returns now. */
export function delegatingCalendarApi(current: () => MeetingsCalendarApi): MeetingsCalendarApi {
  return {
    getCalendar: (calendarId) => current().getCalendar(calendarId),
    getEvent: (calendarId, eventId) => current().getEvent(calendarId, eventId),
    listEvents: (calendarId, timeMin, timeMax) => current().listEvents(calendarId, timeMin, timeMax),
    insertEvent: (calendarId, eventId, event, sendUpdates) =>
      current().insertEvent(calendarId, eventId, event, sendUpdates),
    patchEvent: (calendarId, eventId, event, sendUpdates) =>
      current().patchEvent(calendarId, eventId, event, sendUpdates),
    deleteEvent: (calendarId, eventId, sendUpdates) => current().deleteEvent(calendarId, eventId, sendUpdates),
    freeBusy: (calendarIds, timeMin, timeMax) => current().freeBusy(calendarIds, timeMin, timeMax),
  };
}
