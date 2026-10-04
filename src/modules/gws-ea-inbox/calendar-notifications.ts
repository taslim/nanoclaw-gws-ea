/**
 * Calendar news as Google Calendar's own notification emails (KTD9, R36).
 *
 * For each of the principal's calendars in the assistant's calendar list,
 * the host turns on email notifications for new, changed, and cancelled
 * events and for attendees' responses, through `calendarList.patch`. It
 * checks the whole list on every poll, so a calendar added later is turned on
 * within a minute, and a setting someone turned off is turned back on.
 *
 * A calendar is the principal's when its ID is one of their addresses (their
 * primary calendar) or its `dataOwner` is.
 *
 * Each authenticated notification is read for one thing: the event link's
 * `eid`, which carries the event ID and its calendar. `main` hears only the
 * calendar, the event ID, and the kind of change, and reads the event from
 * the calendar itself; nothing else of the email reaches it.
 */
import { isRecord } from '../../gws-ea/validation.js';
import { log } from '../../log.js';
import { googleJson, GoogleApiError, type GoogleClientOptions } from './gmail-api.js';
import { replacePrincipalCalendars } from './db.js';
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
  };
}

/** Whether a calendar is the principal's, by the two facts that decide it. */
export function isPrincipalCalendar(entry: CalendarListEntry, principalAddresses: ReadonlySet<string>): boolean {
  if (entry.deleted === true) return false;
  return (
    principalAddresses.has(entry.id.toLowerCase()) || principalAddresses.has((entry.dataOwner ?? '').toLowerCase())
  );
}

function hasWanted(entry: CalendarListEntry): boolean {
  const held = entry.notificationSettings?.notifications ?? [];
  return WANTED_NOTIFICATIONS.every((wanted) =>
    held.some((notification) => notification.type === wanted.type && notification.method === wanted.method),
  );
}

/**
 * Turn notifications on for every principal calendar in the list that lacks
 * them, keeping any other notification it already has, and record which
 * calendars are the principal's. One calendar that refuses does not stop the
 * others; the sync is reported failing until every one succeeds.
 */
export async function syncCalendarNotifications(
  api: CalendarListApi,
  principalAddresses: ReadonlySet<string>,
  at: string,
): Promise<void> {
  let entries: CalendarListEntry[];
  try {
    entries = await api.list();
  } catch (error) {
    if (!(error instanceof GoogleApiError)) throw error;
    const reason = error.message;
    log.warn('Could not read the calendar list to turn on calendar notifications', { reason });
    await recordCalendarSync('failing', reason);
    return;
  }
  const principal = entries.filter((entry) => isPrincipalCalendar(entry, principalAddresses));
  const failures: string[] = [];
  for (const entry of principal) {
    if (hasWanted(entry)) continue;
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
    principal.map((entry) => entry.id.toLowerCase()),
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

const EVENT_ID = /^[A-Za-z0-9_-]{1,1024}$/u;

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
