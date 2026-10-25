/**
 * How the scheduling tools write their events so a retry never writes one
 * twice, and how a time reads in text an agent or a person sees.
 *
 * An event's id derives from what it is for (`eventIdFor`), so a retry after
 * a partial failure finds the event it made (`ensureEvent`). Each booking
 * carries private tags: its role (`TAG_ROLE`) and the thread or chat it was
 * placed for (`OwnerTag`).
 */
import { createHash } from 'node:crypto';

import { forbidden, invalidArgs } from '../../cli/delivery-action.js';
import { principalMatchKey } from '../../gws-ea/validation.js';
import { log } from '../../log.js';
import { weekdayRefusal } from '../gws-ea-dates/refusal.js';
import { recordOwnCalendarChange } from '../gws-ea-inbox/calendar-notifications.js';
import { audienceForAddresses, checkOutbound, privateKindNoun } from '../gws-ea-privacy/index.js';
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

/** `booking` on every booking; a thread or chat changes only an event that still carries it. */
export const TAG_ROLE = 'gwsEaRole';

/** Lowercase hex, which Google's event id alphabet allows. */
export function eventIdFor(...parts: readonly string[]): string {
  return createHash('sha256')
    .update(['gws-ea', ...parts].join('|'))
    .digest('hex');
}

/** The thread or chat an event was placed for. */
export interface OwnerTag {
  readonly key: string;
  readonly value: string;
}

export function isOwnerAddress(calendarId: string, address: string | undefined): boolean {
  return address !== undefined && principalMatchKey(address) === principalMatchKey(calendarId);
}

/**
 * The calendar's owner goes first, accepted: Google lists them as the
 * organizer but leaves them `needsAction` unless the write answers for them.
 */
export function guestsOn(calendarId: string, invitees: readonly string[]): GuestWrite[] {
  return [
    { email: calendarId, responseStatus: 'accepted' },
    ...invitees.filter((address) => !isOwnerAddress(calendarId, address)).map((email) => ({ email })),
  ];
}

export interface Invitation {
  /** The write's own words, the only ones checked for a weekday that does not match its date. */
  readonly texts: readonly (string | undefined)[];
  /** Everything else the invitation shows them, such as the calendar's name. */
  readonly shown: readonly (string | undefined)[];
  /** Everyone but the principal that Google sends it to; empty skips every check but the weekday one. */
  readonly recipients: readonly string[];
  /** Who writes it, so a refused link is explained in words fitted to them. */
  readonly writer: LinkWriter;
  /** Canonical chat, supplied only by the host's serving-session check. */
  readonly chatId?: string;
}

/**
 * `refused` leads every refusal and `advice` ends one for a private detail,
 * which names the detail's kind, never the detail.
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
    invitation.chatId,
  );
  if (!check.allowed) {
    throw forbidden(
      `${refused}: as its guests would see it, the invitation carries the principal's private ${privateKindNoun(check.kind)}. ${advice}`,
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
 * Create the event under its own id, or settle the one an earlier attempt
 * made: restored if it was deleted, corrected if its time or guests differ,
 * else left alone. A correction emails nobody, since the guests heard of the
 * first write; a restore tells them as that write did, since the last they
 * heard was that it was cancelled. A live event under that id without
 * `owner`'s tag is refused. Recorded as the assistant's own change, so
 * Google's notification of it makes no note.
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
 * The booking already stands, so a read that fails counts the Meet link as
 * still being created: Google makes it after the request.
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

export function bothZones(span: Span, timezone: string, theirs: string | undefined): string {
  return `${slotLabel(span, timezone)}${theirs === undefined ? '' : `; for them, ${slotLabel(span, theirs)}`}`;
}

/** "Tuesday, Oct 6, 10:00–10:30 AM BST": the zone by the short name people know, not its IANA name. */
export function slotLabel(span: Span, timezone: string): string {
  const start = clockOf(span.start, timezone);
  const end = clockOf(span.end, timezone);
  const times =
    start.period === end.period
      ? `${start.time}–${end.time} ${end.period}`
      : `${start.time} ${start.period}–${end.time} ${end.period}`;
  return `${dayLabel(span.start, timezone)}, ${times} ${zoneName(span.start, timezone)}`;
}

/**
 * A slot when it starts and ends on one day, else both days: "Thursday,
 * Oct 8, 9:00 AM PDT to Saturday, Oct 10, 5:00 PM PDT". Ending at midnight
 * stays the same day.
 */
export function spanLabel(span: Span, timezone: string): string {
  return dayLabel(span.start, timezone) === dayLabel(span.end - 1, timezone)
    ? slotLabel(span, timezone)
    : `${momentLabel(span.start, timezone)} to ${momentLabel(span.end, timezone)}`;
}

/** "Thursday, Oct 8, 9:00 AM PDT". */
export function momentLabel(instant: number, timezone: string): string {
  const clock = clockOf(instant, timezone);
  return `${dayLabel(instant, timezone)}, ${clock.time} ${clock.period} ${zoneName(instant, timezone)}`;
}

/** Read from its parts so the space before AM or PM is a plain one, whatever the ICU version writes there. */
function clockOf(instant: number, timezone: string): { time: string; period: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(new Date(instant));
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((each) => each.type === type)?.value ?? '';
  return { time: `${part('hour')}:${part('minute')}`, period: part('dayPeriod') };
}

/**
 * A day is written without its year only inside the window the outgoing
 * weekday check (`gws-ea-dates`) reads a yearless date in, so a label copied
 * into a message never reads as another year's.
 */
const YEARLESS_PAST_MS = 120 * 24 * 60 * 60 * 1000;
const YEARLESS_AHEAD_MS = 300 * 24 * 60 * 60 * 1000;

/** "Tuesday, Oct 6", with its year when far from now. */
export function dayLabel(instant: number, timezone: string): string {
  const now = Date.now();
  const near = instant >= now - YEARLESS_PAST_MS && instant < now + YEARLESS_AHEAD_MS;
  return new Date(instant).toLocaleDateString('en-US', {
    timeZone: timezone,
    weekday: 'long',
    day: 'numeric',
    month: 'short',
    ...(near ? {} : { year: 'numeric' }),
  });
}

/**
 * Each locale names only its own region's zones (BST in British English, EDT
 * in American), so the first that names it wins, and an offset such as GMT+1
 * stands in when none does.
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
