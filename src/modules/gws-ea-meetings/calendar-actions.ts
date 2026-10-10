/**
 * The assistant's own events on the principal's calendar (KTD7): how the
 * scheduling tools write them so a retry never writes one twice, and how a
 * time reads in an email.
 *
 * - Every event lists the owner of its calendar, the principal, as its first
 *   guest, accepted (`guestsOn`): Google then shows them on the guest list
 *   as its organizer, as it does for an event they made themselves.
 * - An invitation shows no one Google sends it to a private detail of the
 *   principal's, names no weekday beside a date it does not fall on, and
 *   carries no Google link a guest other than the principal cannot open
 *   (`assertInvitationShareable`).
 * - An event's id derives from what it is for (`eventIdFor`), so a retry
 *   after a partial failure finds the event it made (`ensureEvent`), and an
 *   event under that id that is not the assistant's is never touched. Its
 *   guests hear of it from the first write alone.
 * - Every event the assistant places carries private tags no one else can
 *   set: its role (`TAG_ROLE`), which marks it a booking, and the thread it
 *   was placed for.
 * - Every write is recorded as the assistant's own change, so its
 *   notification produces no note.
 */
import { createHash } from 'node:crypto';

import { forbidden, invalidArgs } from '../../cli/delivery-action.js';
import { log } from '../../log.js';
import { weekdayRefusal } from '../gws-ea-dates/refusal.js';
import { recordOwnCalendarChange } from '../gws-ea-inbox/calendar-notifications.js';
import { audienceForAddresses, checkOutbound } from '../gws-ea-privacy/index.js';
import {
  checkLinksOpenable,
  LinkCheckUnavailableError,
  LINKS_UNCHECKED,
  type LinkWriter,
} from '../gws-ea-workspace/link-access.js';
import type {
  CalendarEvent,
  EventConference,
  GuestWrite,
  MeetingsCalendarApi,
  NewEvent,
  SendUpdates,
} from './calendar-api.js';
import type { Span } from './slots.js';

/** The private tag naming an event's role, `booking`, on the events the assistant places. */
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

/** What an invitation shows the people Google sends it to. */
export interface Invitation {
  /** What the write says: its title, notes and place. */
  readonly texts: readonly (string | undefined)[];
  /**
   * What else they see beside it: the name of the calendar it is on and,
   * unless they have seen them already, the other addresses on its guest
   * list.
   */
  readonly shown: readonly (string | undefined)[];
  /** Who Google sends it to. The principal may see anything; nobody at all sees nothing. */
  readonly recipients: readonly string[];
  /** Who writes it, so a refused link is explained in words fitted to them. */
  readonly writer: LinkWriter;
}

/**
 * Refuse, writing nothing, an invitation whose words name a weekday beside a
 * date it does not fall on, which would show anyone Google sends it to
 * one of the principal's private details, or which carries a Google link
 * one of them other than the principal cannot open. `refused` leads the
 * refusal and `advice` ends one for a private detail, saying what to do
 * about it; the refusal names the detail's kind, never the detail. A link is
 * read in everything the guests see, what the event already says included.
 */
export async function assertInvitationShareable(
  invitation: Invitation,
  refused: string,
  advice: string,
): Promise<void> {
  const misdated = await weekdayRefusal(invitation.texts.map((text) => text ?? ''));
  if (misdated !== undefined) throw invalidArgs(`${refused}: ${misdated}`);
  if (invitation.recipients.length === 0) return;
  const check = await checkOutbound(
    [...invitation.texts, ...invitation.shown].map((text) => text ?? ''),
    await audienceForAddresses(invitation.recipients),
  );
  if (!check.allowed) {
    throw forbidden(
      `${refused}: as its guests would see it, the invitation carries one of the principal's private details (${check.kind}). ${advice}`,
    );
  }
  const links = await checkLinksOpenable({
    texts: [...invitation.texts, ...invitation.shown].flatMap((text) => text ?? []),
    recipients: invitation.recipients,
    writer: invitation.writer,
  }).catch((error: unknown) => {
    throw error instanceof LinkCheckUnavailableError ? forbidden(`${refused}: ${LINKS_UNCHECKED}`) : error;
  });
  if (!links.allowed) throw forbidden(`${refused}: ${links.reason}`);
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
 * Create the event under its own id, telling its guests as `sendUpdates`
 * says, or find the one an earlier attempt made: restored if it was
 * deleted, corrected if its time or people differ, left alone if it already
 * says the same. Its guests heard of it from that first write, so a
 * correction emails nobody again; a restore tells them as the first write
 * did, since the last they heard was that it was cancelled. An event under
 * that id that does not carry `owner`'s tag is never touched.
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
        deleted ? sendUpdates : 'none',
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

/**
 * A span as people write it, in `timezone`: a slot when it starts and ends
 * on one day, and both days otherwise, "Thursday 8 Oct, 09:00 PDT to
 * Saturday 10 Oct, 17:00 PDT". Ending at midnight stays the same day.
 */
export function spanLabel(span: Span, timezone: string): string {
  return dayLabel(span.start, timezone) === dayLabel(span.end - 1, timezone)
    ? slotLabel(span, timezone)
    : `${momentLabel(span.start, timezone)} to ${momentLabel(span.end, timezone)}`;
}

/** One instant as people write it, in `timezone`: "Thursday 8 Oct, 09:00 PDT". */
export function momentLabel(instant: number, timezone: string): string {
  return `${dayLabel(instant, timezone)}, ${clockLabel(instant, timezone)} ${zoneName(instant, timezone)}`;
}

function clockLabel(instant: number, timezone: string): string {
  return new Date(instant).toLocaleTimeString('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit' });
}

/**
 * How far from now a day is written without its year: the reading the
 * outgoing weekday check takes of a date written without one
 * (`gws-ea-dates`), so a label copied into a message never reads as another
 * year's.
 */
const YEARLESS_PAST_MS = 120 * 24 * 60 * 60 * 1000;
const YEARLESS_AHEAD_MS = 300 * 24 * 60 * 60 * 1000;

/** The day an instant falls on in `timezone`, as people write it: "Tuesday 6 Oct", with its year when far from now. */
export function dayLabel(instant: number, timezone: string): string {
  const now = Date.now();
  const near = instant >= now - YEARLESS_PAST_MS && instant < now + YEARLESS_AHEAD_MS;
  return new Date(instant)
    .toLocaleDateString('en-GB', {
      timeZone: timezone,
      weekday: 'long',
      day: 'numeric',
      month: 'short',
      ...(near ? {} : { year: 'numeric' }),
    })
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
