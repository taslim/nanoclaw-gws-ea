/**
 * The assistant's calendar list, kept by the inbox's poll (KTD4, KTD9; R7,
 * R8, R10, R36), and calendar news as Google Calendar's own notification
 * emails.
 *
 * A calendar is the principal's when its ID is one of their addresses (their
 * primary calendar) or its `dataOwner` is, in any spelling the one rule
 * recognizes (R1). The poll owns every write to the list, and each one
 * checks the whole list:
 *
 * - each listed address's main calendar is in the list: the poll adds it the
 *   first time it sees the address, and while Google answers that it is not
 *   shared (404), or after it left the list, asks again every
 *   `UNSHARED_RETRY_MS`. Removing the address or unsharing the calendar is
 *   how anyone stops that, so nothing records a calendar not to add;
 * - what the assistant can do with it is recorded per address (db.ts), and
 *   `main` is told once when that drops, since nobody else would look; a
 *   first reading or a rise tells no one, as both agents read it live;
 * - a calendar the host added for an address no longer the principal's is
 *   taken out; one anyone else added never is;
 * - each principal calendar the assistant can read gets email notifications
 *   for new, changed, and cancelled events and for attendees' responses,
 *   through `calendarList.patch`, so a calendar added later is turned on
 *   within a minute, and a setting someone turned off is turned back on. A
 *   free/busy-only calendar shows no events to be told of, so none is asked.
 *
 * Every principal calendar in the list, free/busy only or not, is recorded
 * for busy time to read; the assistant's own calendar never is.
 *
 * Each authenticated notification is read for one thing: the event link's
 * `eid`, which carries the event ID and its calendar. `main` hears only the
 * calendar, the event ID, and the kind of change, and reads the event from
 * the calendar itself; nothing else of the email reaches it.
 */
import { createHash } from 'node:crypto';

import { isRecord } from '../../gws-ea/validation.js';
import { log } from '../../log.js';
import type { PrincipalRecognizer } from '../gws-ea-profile/db.js';
import { writeNoteForMain, type NoteForMainResult } from '../gws-ea-profile/main-note.js';
import { googleJson, GoogleApiError, type GoogleClientOptions } from './gmail-api.js';
import {
  deleteCalendarAccess,
  listCalendarAccess,
  recordCalendarAccess,
  recordToldCalendarAccess,
  replacePrincipalCalendars,
  type CalendarAccess,
  type CalendarAccessRecord,
} from './db.js';
import { recordCalendarSync } from './health.js';
import type { ParsedMail } from './mime.js';

export type CalendarNotificationType =
  | 'eventCreation'
  | 'eventChange'
  | 'eventCancellation'
  | 'eventResponse'
  | 'agenda';

export interface CalendarNotification {
  readonly type: CalendarNotificationType;
  readonly method: 'email';
}

export interface CalendarListEntry {
  readonly id: string;
  readonly accessRole?: string;
  readonly primary?: boolean;
  readonly dataOwner?: string;
  readonly deleted?: boolean;
  readonly notificationSettings?: { readonly notifications?: readonly CalendarNotification[] };
  /** The conference types its events may carry, such as `hangoutsMeet`, when Google reports them. */
  readonly conferenceTypes?: readonly string[];
}

export interface CalendarListApi {
  /** Every entry of the assistant's calendar list, across pages. */
  list(): Promise<CalendarListEntry[]>;
  /** Replace one entry's notification settings. */
  patchNotifications(calendarId: string, notifications: readonly CalendarNotification[]): Promise<void>;
  /**
   * Add a calendar shared with the assistant to its list, by its ID: its
   * entry, or undefined when Google answers that no such calendar is shared
   * with the assistant (404).
   */
  subscribe(calendarId: string): Promise<CalendarListEntry | undefined>;
  /** Take a calendar out of the assistant's list; one already gone is no error. */
  unsubscribe(calendarId: string): Promise<void>;
}

/** The notifications the host keeps on for each principal calendar. */
export const WANTED_NOTIFICATIONS: readonly CalendarNotification[] = [
  { type: 'eventCreation', method: 'email' },
  { type: 'eventChange', method: 'email' },
  { type: 'eventCancellation', method: 'email' },
  { type: 'eventResponse', method: 'email' },
];

const NOTIFICATION_TYPES: ReadonlySet<string> = new Set([
  'eventCreation',
  'eventChange',
  'eventCancellation',
  'eventResponse',
  'agenda',
]);

const CALENDAR_LIST = 'https://www.googleapis.com/calendar/v3/users/me/calendarList';
const MAX_PAGES = 20;

function toNotification(value: unknown): CalendarNotification | undefined {
  return isRecord(value) &&
    typeof value.type === 'string' &&
    NOTIFICATION_TYPES.has(value.type) &&
    value.method === 'email'
    ? { type: value.type as CalendarNotificationType, method: 'email' }
    : undefined;
}

function toEntry(value: unknown): CalendarListEntry {
  if (!isRecord(value) || typeof value.id !== 'string') {
    throw new GoogleApiError(502, 'Google Calendar returned an unreadable calendar list entry');
  }
  const settings = isRecord(value.notificationSettings) ? value.notificationSettings : undefined;
  const notifications = Array.isArray(settings?.notifications)
    ? settings.notifications.flatMap((item) => toNotification(item) ?? [])
    : undefined;
  return {
    id: value.id,
    ...(typeof value.accessRole === 'string' ? { accessRole: value.accessRole } : {}),
    ...(typeof value.primary === 'boolean' ? { primary: value.primary } : {}),
    ...(typeof value.dataOwner === 'string' ? { dataOwner: value.dataOwner } : {}),
    ...(typeof value.deleted === 'boolean' ? { deleted: value.deleted } : {}),
    ...(notifications ? { notificationSettings: { notifications } } : {}),
  };
}

/** The real client, over the Calendar API's calendar list. */
export function createCalendarListApi(options: GoogleClientOptions): CalendarListApi {
  return {
    async list() {
      const entries: CalendarListEntry[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const params = new URLSearchParams({ maxResults: '250' });
        if (pageToken !== undefined) params.set('pageToken', pageToken);
        const payload = await googleJson(options, `${CALENDAR_LIST}?${params.toString()}`);
        if (!isRecord(payload)) throw new GoogleApiError(502, 'Google Calendar returned an unreadable calendar list');
        if (Array.isArray(payload.items)) entries.push(...payload.items.map(toEntry));
        pageToken = typeof payload.nextPageToken === 'string' ? payload.nextPageToken : undefined;
        if (pageToken === undefined) return entries;
      }
      throw new GoogleApiError(502, 'Google Calendar returned a calendar list too long to read');
    },

    async patchNotifications(calendarId, notifications) {
      await googleJson(options, `${CALENDAR_LIST}/${encodeURIComponent(calendarId)}`, {
        method: 'PATCH',
        body: { notificationSettings: { notifications } },
      });
    },

    async subscribe(calendarId) {
      const payload = await googleJson(options, CALENDAR_LIST, {
        method: 'POST',
        body: { id: calendarId },
        allowNotFound: true,
      });
      return payload === undefined ? undefined : toEntry(payload);
    },

    async unsubscribe(calendarId) {
      await googleJson(options, `${CALENDAR_LIST}/${encodeURIComponent(calendarId)}`, {
        method: 'DELETE',
        allowNotFound: true,
      });
    },
  };
}

/** Whether a calendar is the principal's, by the two facts that decide it. */
export function isPrincipalCalendar(entry: CalendarListEntry, principal: PrincipalRecognizer): boolean {
  if (entry.deleted === true) return false;
  return principal.has(entry.id) || principal.has(entry.dataOwner);
}

/**
 * The access roles that let the assistant change a calendar's events.
 * `writerWithoutPrivateAccess` shows the owner's private events only as busy
 * time, and lets it write only events that are not private.
 */
const CHANGING_ROLES: ReadonlySet<string> = new Set(['owner', 'writer', 'writerWithoutPrivateAccess']);

/** Every access role the host knows. */
const KNOWN_ROLES: ReadonlySet<string> = new Set([...CHANGING_ROLES, 'reader', 'freeBusyReader']);

/** Whether Google lets the assistant change events on a calendar. */
export function canChangeEvents(entry: Pick<CalendarListEntry, 'accessRole'>): boolean {
  return entry.accessRole !== undefined && CHANGING_ROLES.has(entry.accessRole);
}

/** Whether a calendar is shared with the assistant without its private events, so it writes none there. */
export function hidesPrivateEvents(entry: Pick<CalendarListEntry, 'accessRole'>): boolean {
  return entry.accessRole === 'writerWithoutPrivateAccess';
}

/**
 * Whether the assistant can book on a calendar: one of the principal's that
 * Google lets it change events on.
 */
export function isBookableCalendar(entry: CalendarListEntry, principal: PrincipalRecognizer): boolean {
  return isPrincipalCalendar(entry, principal) && canChangeEvents(entry);
}

/** Whether Google shows the assistant a calendar's events, not only when it is busy. */
export function isReadable(entry: CalendarListEntry): boolean {
  return entry.accessRole === 'reader' || canChangeEvents(entry);
}

/** Roles the poll has warned of since the host started, so a role is logged once rather than every minute. */
const warnedRoles = new Set<string>();

/**
 * Warn, once per role, of a principal calendar whose access role the host
 * does not know: the assistant neither reads nor books on it until the host
 * learns the role.
 */
function warnOfUnknownRole(entry: CalendarListEntry): void {
  const role = entry.accessRole;
  if (role === undefined || KNOWN_ROLES.has(role) || warnedRoles.has(role)) return;
  warnedRoles.add(role);
  log.warn('Google gave an access role the host does not know: no reading or booking on that calendar', {
    calendarId: entry.id,
    role,
  });
}

function hasWanted(entry: CalendarListEntry): boolean {
  const held = entry.notificationSettings?.notifications ?? [];
  return WANTED_NOTIFICATIONS.every((wanted) =>
    held.some((notification) => notification.type === wanted.type && notification.method === wanted.method),
  );
}

// ---------------------------------------------------------------------------
// Each principal address's calendar
// ---------------------------------------------------------------------------

/**
 * How long the poll waits before asking Google again for an address whose
 * calendar it could not add. A calendar is shared by a person, often while
 * main walks the principal through it, so the wait is minutes, not an hour;
 * against a poll each minute, it asks a fifteenth as often for a calendar
 * that is never shared.
 */
export const UNSHARED_RETRY_MS = 15 * 60_000;

/** Each access above the next: a drop is a move down this order. */
const ACCESS_ORDER: Readonly<Record<CalendarAccess, number>> = { none: 0, 'free-busy': 1, readable: 2, bookable: 3 };

function dropsBelow(access: CalendarAccess, than: CalendarAccess): boolean {
  return ACCESS_ORDER[access] < ACCESS_ORDER[than];
}

/** What the assistant can do with a principal address's main calendar, by Google's access role for it. */
function accessOf(entry: CalendarListEntry, principal: PrincipalRecognizer): CalendarAccess {
  if (isBookableCalendar(entry, principal)) return 'bookable';
  if (entry.accessRole === 'reader') return 'readable';
  if (entry.accessRole === 'freeBusyReader') return 'free-busy';
  return 'none';
}

const ACCESS_WORDS: Readonly<Record<CalendarAccess, string>> = {
  bookable: 'bookable',
  readable: 'readable',
  'free-busy': 'free/busy only',
  none: 'no access',
};

const LOSSES = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });

/** Main's note of a drop: the address, the access before and after, and what no longer works. */
function dropText(address: string, before: CalendarAccess, after: CalendarAccess): string {
  const lost = (level: CalendarAccess) => !dropsBelow(before, level) && dropsBelow(after, level);
  const losses = [
    ...(lost('bookable') ? ['bookings can no longer land on it'] : []),
    ...(lost('readable') ? ['its events can no longer be read'] : []),
    ...(lost('free-busy') ? ['its busy time no longer counts when times are offered'] : []),
  ];
  return (
    `The calendar of ${address}, one of the principal's addresses, dropped from ${ACCESS_WORDS[before]} to ${ACCESS_WORDS[after]}: ` +
    `${LOSSES.format(losses)}.` +
    (after === 'none' ? " The host adds it back to the assistant's calendar list once it is shared again." : '')
  );
}

/**
 * Keep each listed address's main calendar in the list and its access
 * recorded, and take out what the host added for an address no longer
 * listed. Returns the list as it now stands; each Google refusal is added
 * to `failures`.
 */
async function keepAddressCalendars(
  api: CalendarListApi,
  principal: PrincipalRecognizer,
  list: readonly CalendarListEntry[],
  at: string,
  failures: string[],
): Promise<CalendarListEntry[]> {
  let entries = list.filter((entry) => entry.deleted !== true);
  const records = await listCalendarAccess();
  const recorded = new Map(records.map((record) => [record.address, record]));
  // Whether the host added a calendar follows the calendar, by Google's id, whichever address it was recorded under.
  const addedByHost = (calendarId: string): boolean =>
    records.some((record) => record.hostAdded && record.calendarId === calendarId);
  const retryBefore = Date.parse(at) - UNSHARED_RETRY_MS;

  for (const address of principal.listed) {
    const previous = recorded.get(address);
    const entry =
      entries.find((candidate) => previous !== undefined && candidate.id === previous.calendarId) ??
      entries.find((candidate) => principal.resolve(candidate.id) === address);
    let reading: Pick<CalendarAccessRecord, 'calendarId' | 'access' | 'hostAdded'>;
    if (entry !== undefined) {
      reading = { calendarId: entry.id, access: accessOf(entry, principal), hostAdded: addedByHost(entry.id) };
    } else if (previous !== undefined && previous.calendarId !== null) {
      // It left the list: unshared, or taken out by hand. It is asked for again once the wait is over.
      reading = { calendarId: null, access: 'none', hostAdded: false };
    } else if (previous === undefined || Date.parse(previous.checkedAt) <= retryBefore) {
      let added: CalendarListEntry | undefined;
      try {
        added = await api.subscribe(address);
      } catch (error) {
        if (!(error instanceof GoogleApiError)) throw error;
        const reason = error.message;
        log.warn("Could not add a principal address's calendar to the assistant's calendar list", { address, reason });
        failures.push(reason);
        continue;
      }
      if (added !== undefined) {
        entries = [...entries, added];
        log.info("Added a principal address's calendar to the assistant's calendar list", { address });
      }
      reading =
        added === undefined
          ? { calendarId: null, access: 'none', hostAdded: false }
          : { calendarId: added.id, access: accessOf(added, principal), hostAdded: true };
    } else {
      continue;
    }
    if (previous !== undefined && previous.access !== reading.access) {
      log.info("A principal address's calendar access changed", { address, from: previous.access, to: reading.access });
    }
    await recordCalendarAccess({
      address,
      ...reading,
      checkedAt: at,
      changedAt: previous === undefined || previous.access !== reading.access ? at : previous.changedAt,
      toldAccess:
        previous === undefined || !dropsBelow(reading.access, previous.toldAccess)
          ? reading.access
          : previous.toldAccess,
    });
  }

  const listed = new Set(principal.listed);
  for (const record of records) {
    if (listed.has(record.address)) continue;
    const { calendarId } = record;
    if (
      record.hostAdded &&
      calendarId !== null &&
      !principal.has(calendarId) &&
      entries.some((entry) => entry.id === calendarId)
    ) {
      try {
        await api.unsubscribe(calendarId);
      } catch (error) {
        if (!(error instanceof GoogleApiError)) throw error;
        const reason = error.message;
        log.warn("Could not take the calendar of an address no longer the principal's out of the calendar list", {
          address: record.address,
          reason,
        });
        failures.push(reason);
        continue;
      }
      entries = entries.filter((entry) => entry.id !== calendarId);
      log.info("Took the calendar of an address no longer the principal's out of the assistant's calendar list", {
        address: record.address,
      });
    }
    await deleteCalendarAccess(record.address);
  }
  return entries;
}

/**
 * Tell main of each drop it has not been told of, without waking it: it
 * reads the note on its next turn, and reads access live whenever it books.
 * Recorded only once the note is written or there is nobody to tell, so a
 * note that failed is written again next poll. Its id is the drop's, so one
 * that did reach main is never written twice.
 */
async function tellMainOfDrops(principal: PrincipalRecognizer, at: string): Promise<void> {
  const listed = new Set(principal.listed);
  for (const record of await listCalendarAccess()) {
    if (!listed.has(record.address) || !dropsBelow(record.access, record.toldAccess)) continue;
    const drop = createHash('sha256')
      .update(record.address)
      .update('\u0000')
      .update(record.access)
      .update('\u0000')
      .update(record.changedAt)
      .digest('hex')
      .slice(0, 24);
    let told: NoteForMainResult;
    /* eslint-disable no-catch-all/no-catch-all -- a note that fails is written again next poll, and never stops it */
    try {
      told = await writeNoteForMain({
        id: `inbox-calendar-access-${drop}`,
        timestamp: at,
        text: dropText(record.address, record.toldAccess, record.access),
        wake: false,
      });
    } catch (error) {
      log.warn("Could not tell main that a calendar's access dropped; the next poll tries again", {
        address: record.address,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    /* eslint-enable no-catch-all/no-catch-all */
    if (told === 'no-main' || told === 'no-principal') {
      log.info("Nobody to tell that a calendar's access dropped; main reads it when it next lists the addresses", {
        address: record.address,
        result: told,
      });
    }
    await recordToldCalendarAccess(record.address, record.access);
  }
}

/**
 * One pass over the assistant's calendar list: each principal address's
 * calendar in it and its access recorded, main told of any drop,
 * notifications on for each principal calendar the assistant can read, and
 * which calendars are the principal's recorded. One calendar that refuses
 * does not stop the others; the sync is reported failing until every one
 * succeeds. A calendar that is simply not shared is no failure.
 */
export async function syncCalendarList(
  api: CalendarListApi,
  principal: PrincipalRecognizer,
  at: string,
): Promise<void> {
  let list: CalendarListEntry[];
  try {
    list = await api.list();
  } catch (error) {
    if (!(error instanceof GoogleApiError)) throw error;
    const reason = error.message;
    log.warn('Could not read the calendar list to keep it', { reason });
    await recordCalendarSync('failing', reason);
    return;
  }
  const failures: string[] = [];
  const entries = await keepAddressCalendars(api, principal, list, at, failures);
  await tellMainOfDrops(principal, at);
  const calendars = entries.filter((entry) => isPrincipalCalendar(entry, principal));
  for (const entry of calendars) {
    warnOfUnknownRole(entry);
    if (!isReadable(entry) || hasWanted(entry)) continue;
    const kept = (entry.notificationSettings?.notifications ?? []).filter(
      (notification) => !WANTED_NOTIFICATIONS.some((wanted) => wanted.type === notification.type),
    );
    try {
      await api.patchNotifications(entry.id, [...kept, ...WANTED_NOTIFICATIONS]);
      log.info('Turned on calendar notifications', { calendarId: entry.id });
    } catch (error) {
      if (!(error instanceof GoogleApiError)) throw error;
      const reason = error.message;
      log.warn('Could not turn on calendar notifications', { calendarId: entry.id, reason });
      failures.push(reason);
    }
  }
  await replacePrincipalCalendars(
    calendars.map((entry) => entry.id.toLowerCase()),
    at,
  );
  await recordCalendarSync(failures.length === 0 ? 'ok' : 'failing', failures[0] ?? null);
}

// ---------------------------------------------------------------------------
// Reading a notification
// ---------------------------------------------------------------------------

export type CalendarChange = 'created' | 'changed' | 'cancelled' | 'response' | 'unknown';

export interface CalendarNotice {
  /** The calendar the event is on, as its calendar-list ID. */
  readonly calendarId: string;
  readonly eventId: string;
  readonly change: CalendarChange;
}

/** Google's subject prefixes for each kind of notification (English). */
const SUBJECT_KINDS: readonly (readonly [RegExp, CalendarChange])[] = [
  [/^(new event|invitation):/iu, 'created'],
  [/^(updated event|updated invitation|event updated|updated event with note):/iu, 'changed'],
  [
    /^(canceled event|cancelled event|event canceled|event cancelled|canceled event with note|cancelled event with note):/iu,
    'cancelled',
  ],
  [/^(accepted|declined|tentatively accepted|maybe|proposed new time|new time proposed):/iu, 'response'],
];

/** The shortened calendar domains in an event link's `eid`. */
const CALENDAR_DOMAIN_SHORTHAND: Readonly<Record<string, string>> = {
  m: 'gmail.com',
  g: 'group.calendar.google.com',
  v: 'group.v.calendar.google.com',
};

/** A calendar reference as an `eid` writes it, expanded to its calendar ID. */
export function expandCalendarRef(reference: string): string {
  const at = reference.lastIndexOf('@');
  if (at <= 0) return reference.toLowerCase();
  const domain = reference.slice(at + 1);
  return `${reference.slice(0, at)}@${CALENDAR_DOMAIN_SHORTHAND[domain] ?? domain}`.toLowerCase();
}

/** Google's event ids: base32hex, with an occurrence's suffix after an underscore. */
export const EVENT_ID = /^[A-Za-z0-9_-]{1,1024}$/u;

function decodeEid(eid: string): { readonly eventId: string; readonly calendarId: string } | undefined {
  const decoded = Buffer.from(eid, 'base64url').toString('utf8');
  const [eventId, reference, ...rest] = decoded.split(' ');
  if (eventId === undefined || reference === undefined || rest.length > 0 || !EVENT_ID.test(eventId)) return undefined;
  if (!/^[^\s@]+@[^\s@]+$/u.test(reference)) return undefined;
  return { eventId, calendarId: expandCalendarRef(reference) };
}

/** The event a notification is about, or undefined when its links name none. */
export function parseCalendarNotification(mail: ParsedMail): CalendarNotice | undefined {
  const sources = [mail.text, mail.html ?? ''];
  for (const source of sources) {
    for (const match of source.matchAll(/[?&](?:amp;)?eid=([A-Za-z0-9_-]+)/gu)) {
      const target = decodeEid(match[1] ?? '');
      if (!target) continue;
      const change = SUBJECT_KINDS.find(([pattern]) => pattern.test(mail.subject))?.[1] ?? 'unknown';
      return { ...target, change };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The assistant's own changes
// ---------------------------------------------------------------------------

/** How long after the assistant changes an event a notification about it is taken as its own. */
const OWN_CHANGE_WINDOW_MS = 30 * 60_000;

const ownChanges = new Map<string, number[]>();

function ownKey(calendarId: string, eventId: string): string {
  return `${expandCalendarRef(calendarId)}\u0000${eventId}`;
}

/**
 * The host's calendar actions record each event the assistant creates,
 * moves, or deletes, so the notification Google sends about that change
 * produces no note: the assistant already knows. Each record answers for one
 * notification within half an hour.
 */
export function recordOwnCalendarChange(calendarId: string, eventId: string, at: Date = new Date()): void {
  for (const [key, times] of ownChanges) {
    const live = times.filter((time) => at.getTime() - time <= OWN_CHANGE_WINDOW_MS);
    if (live.length === 0) ownChanges.delete(key);
    else ownChanges.set(key, live);
  }
  const key = ownKey(calendarId, eventId);
  ownChanges.set(key, [...(ownChanges.get(key) ?? []), at.getTime()]);
}

/** Whether this notification is about the assistant's own recent change; consumes the record if so. */
export function consumeOwnCalendarChange(calendarId: string, eventId: string, at: Date): boolean {
  const key = ownKey(calendarId, eventId);
  const live = (ownChanges.get(key) ?? []).filter((time) => at.getTime() - time <= OWN_CHANGE_WINDOW_MS);
  const [, ...rest] = live;
  if (rest.length > 0) ownChanges.set(key, rest);
  else ownChanges.delete(key);
  return live.length > 0;
}
