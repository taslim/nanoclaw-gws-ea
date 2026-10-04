/**
 * The assistant's own events on the principal's calendar (KTD7): how the
 * scheduling tools write them so a retry never writes one twice, and how a
 * time reads in an email.
 *
 * - An event's id derives from what it is for (`eventIdFor`), so a retry
 *   after a partial failure finds the event it made (`ensureEvent`), and an
 *   event under that id that is not the assistant's is never touched.
 * - Every event the assistant places carries private tags no one else can
 *   set: its role (`TAG_ROLE`), a hold or a booking, and the thread it was
 *   placed for.
 * - Every write is recorded as the assistant's own change, so its
 *   notification produces no note.
 */
import { createHash } from 'node:crypto';

import { log } from '../../log.js';
import { recordOwnCalendarChange } from '../gws-ea-inbox/calendar-notifications.js';
import type { CalendarEvent, EventConference, MeetingsCalendarApi, NewEvent, SendUpdates } from './calendar-api.js';
import { eventSpan, type Span } from './slots.js';

/** The private tag naming an event's role, `hold` or `booking`, on the events the assistant places. */
export const TAG_ROLE = 'gwsEaRole';

/** A Google event id from its parts: lowercase hex, which Google's id alphabet allows. */
export function eventIdFor(...parts: readonly string[]): string {
  return createHash('sha256')
    .update(['gws-ea', ...parts].join('|'))
    .digest('hex');
}

/** The private tag that marks an event as one the assistant placed for its owner: the thread it was placed for. */
export interface OwnerTag {
  readonly key: string;
  readonly value: string;
}

/** Whether the event Google holds already says what the write would. */
function alreadyWritten(current: CalendarEvent, event: NewEvent): boolean {
  const startsTogether =
    current.start?.dateTime !== undefined && Date.parse(current.start.dateTime) === Date.parse(event.start);
  const endsTogether =
    current.end?.dateTime !== undefined && Date.parse(current.end.dateTime) === Date.parse(event.end);
  const invited = new Set((current.attendees ?? []).flatMap((attendee) => attendee.email ?? []));
  return startsTogether && endsTogether && (event.attendees ?? []).every((address) => invited.has(address));
}

/**
 * Create the event under its own id, or find the one an earlier attempt
 * made: restored if it was deleted, corrected if its time or people differ,
 * left alone (and nobody emailed again) if it already says the same. An
 * event under that id that does not carry `owner`'s tag is never touched.
 */
export async function ensureEvent(
  api: MeetingsCalendarApi,
  calendarId: string,
  eventId: string,
  event: NewEvent,
  sendUpdates: SendUpdates,
  owner: OwnerTag,
): Promise<void> {
  if ((await api.insertEvent(calendarId, eventId, event, sendUpdates)) === 'exists') {
    const current = await api.getEvent(calendarId, eventId);
    if (!current) throw new Error(`Google holds event ${eventId} on ${calendarId} but returns nothing for it`);
    const deleted = current.status === 'cancelled';
    if (!deleted && current.tags?.[owner.key] !== owner.value) {
      throw new Error(`Event ${eventId} on ${calendarId} is not ${owner.value}'s`);
    }
    if (deleted || !alreadyWritten(current, event)) {
      // A conference is created only when the event has none: never a second link.
      const { conference, ...fields } = event;
      await api.patchEvent(
        calendarId,
        eventId,
        {
          ...fields,
          ...(conference === undefined || current.conference !== undefined ? {} : { conference }),
          status: 'confirmed',
        },
        sendUpdates,
      );
    }
  }
  recordOwnCalendarChange(calendarId, eventId);
}

/**
 * Move a live event to `to`, in place, unless it is there already. Only the
 * time changes: its title, place and notes stay as they are, and Google
 * sends the attendees the update.
 */
export async function moveEventTo(
  api: MeetingsCalendarApi,
  calendarId: string,
  current: CalendarEvent,
  to: { readonly start_at: string; readonly end_at: string },
  timezone: string,
): Promise<void> {
  const span = eventSpan(current, timezone);
  if (!span || span.start !== Date.parse(to.start_at) || span.end !== Date.parse(to.end_at)) {
    await api.patchEvent(calendarId, current.id, { start: to.start_at, end: to.end_at }, 'all');
    recordOwnCalendarChange(calendarId, current.id);
  }
}

/**
 * A booked event's Meet link as Google reports it now. The booking already
 * stands, so a read that fails counts the link as still being created:
 * Google makes it after the request.
 */
export async function readConference(
  api: MeetingsCalendarApi,
  calendarId: string,
  eventId: string,
): Promise<EventConference> {
  /* eslint-disable no-catch-all/no-catch-all -- the booking stands regardless; only this read-back is forgiven */
  try {
    return (await api.getEvent(calendarId, eventId))?.conference ?? { status: 'pending' };
  } catch (err) {
    log.warn('Could not read back a booked event’s Meet status; reading it as still being created', {
      calendarId,
      eventId,
      err,
    });
    return { status: 'pending' };
  }
  /* eslint-enable no-catch-all/no-catch-all */
}

/**
 * A slot as people write it, in `timezone`: "Tuesday 6 Oct, 10:00–10:30
 * BST", its zone by the short name people know rather than its IANA name.
 */
export function slotLabel(span: Span, timezone: string): string {
  const day = new Date(span.start).toLocaleDateString('en-GB', {
    timeZone: timezone,
    weekday: 'long',
    day: 'numeric',
    month: 'short',
  });
  const clock = (instant: number): string =>
    new Date(instant).toLocaleTimeString('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit' });
  return `${day.replace(',', '')}, ${clock(span.start)}–${clock(span.end)} ${zoneName(span.start, timezone)}`;
}

/**
 * A zone's short name at an instant, as people know it: each locale names
 * only its own region's zones (BST in British English, EDT in American), so
 * the first that names it wins, and an offset such as GMT+1 stands in when none does.
 */
function zoneName(instant: number, timezone: string): string {
  const names = ['en-GB', 'en-US'].map(
    (locale) =>
      new Intl.DateTimeFormat(locale, { timeZone: timezone, timeZoneName: 'short' })
        .formatToParts(new Date(instant))
        .find((part) => part.type === 'timeZoneName')?.value ?? timezone,
  );
  return names.find((name) => !/^(GMT|UTC)[+-]/u.test(name)) ?? names[0];
}
