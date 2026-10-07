/**
 * The assistant's own events on the principal's calendar (KTD7): how the
 * scheduling tools write them so a retry never writes one twice, and how a
 * time reads in an email.
 *
 * - Every event lists the owner of its calendar, the principal, as its first
 *   guest, accepted (`guestsOn`): Google then shows them on the guest list
 *   as its organizer, as it does for an event they made themselves.
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
import type {
  CalendarEvent,
  EventConference,
  GuestWrite,
  MeetingsCalendarApi,
  NewEvent,
  SendUpdates,
} from './calendar-api.js';
import type { Span } from './slots.js';

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

/**
 * The guests of an event the assistant writes on `calendarId`: the
 * calendar's owner first, accepted, then everyone `invitees` names. Google
 * gives the owner no answer of their own (`needsAction`) unless the write
 * does, and lists them as the event's organizer.
 */
export function guestsOn(calendarId: string, invitees: readonly string[]): GuestWrite[] {
  const owner = calendarId.toLowerCase();
  return [
    { email: calendarId, responseStatus: 'accepted' },
    ...invitees.filter((address) => address.toLowerCase() !== owner).map((email) => ({ email })),
  ];
}

/** Whether the event Google holds already says what the write would: its time, and each guest with any answer it gives them. */
function alreadyWritten(current: CalendarEvent, event: NewEvent): boolean {
  const startsTogether =
    current.start?.dateTime !== undefined && Date.parse(current.start.dateTime) === Date.parse(event.start);
  const endsTogether =
    current.end?.dateTime !== undefined && Date.parse(current.end.dateTime) === Date.parse(event.end);
  const answers = new Map(
    (current.attendees ?? []).flatMap((attendee) =>
      attendee.email === undefined ? [] : [[attendee.email, attendee.responseStatus] as const],
    ),
  );
  return (
    startsTogether &&
    endsTogether &&
    (event.attendees ?? []).every((guest) => {
      const email = guest.email.toLowerCase();
      return answers.has(email) && (guest.responseStatus === undefined || answers.get(email) === guest.responseStatus);
    })
  );
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

/** What a Meet link on an event means for the agent that asked for it, as words that follow its time. */
export function conferenceWords(conference: EventConference | undefined): string {
  if (conference === undefined) return '';
  switch (conference.status) {
    case 'success':
      return conference.uri === undefined
        ? ', with a Google Meet link'
        : `, with a Google Meet link (${conference.uri})`;
    case 'pending':
      return '; Google is still creating its Meet link, which appears on the invitation shortly';
    case 'failure':
      return '; Google could not create a Meet link, so tell them the place another way';
    default: {
      const unreachable: never = conference.status;
      throw new Error(`Unknown conference status ${String(unreachable)}`);
    }
  }
}

/**
 * A slot as people write it, in `timezone`: "Tuesday 6 Oct, 10:00–10:30
 * BST", its zone by the short name people know rather than its IANA name.
 */
export function slotLabel(span: Span, timezone: string): string {
  return `${dayLabel(span.start, timezone)}, ${clockLabel(span.start, timezone)}–${clockLabel(span.end, timezone)} ${zoneName(span.start, timezone)}`;
}

/** One instant as people write it, in `timezone`: "Thursday 8 Oct, 09:00 PDT". */
export function momentLabel(instant: number, timezone: string): string {
  return `${dayLabel(instant, timezone)}, ${clockLabel(instant, timezone)} ${zoneName(instant, timezone)}`;
}

function clockLabel(instant: number, timezone: string): string {
  return new Date(instant).toLocaleTimeString('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit' });
}

/** The day an instant falls on in `timezone`, as people write it: "Tuesday 6 Oct". */
export function dayLabel(instant: number, timezone: string): string {
  return new Date(instant)
    .toLocaleDateString('en-GB', { timeZone: timezone, weekday: 'long', day: 'numeric', month: 'short' })
    .replace(',', '');
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
