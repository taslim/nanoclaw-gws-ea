import recurrenceRules from 'rrule';
import type { Options } from 'rrule';
import { isDeepStrictEqual } from 'node:util';
/**
 * The event writes `gog` cannot make: it sets no answer for the principal on
 * the guest list, refuses to answer an event they organize, and runs no
 * private-details check on its invitations.
 *
 * - On a principal calendar the principal is on every event these tools
 *   write, accepted unless they answered otherwise themselves, and never
 *   taken off. On the assistant's own calendar the principal is a guest only
 *   when invited: the event takes their time only through the copy Google's
 *   invitation puts on their calendar.
 * - An answer is never recorded as the assistant's own change: Google may
 *   not notify it, and a record would swallow the next real notice.
 * - A request's `matter` is checked before anything is written.
 */
import { loadTimeline, zoneAt, zoneForDay, type Timeline } from '../gws-ea-whereabouts/timeline.js';
import { boundary, wallClock, zonedInstant, type LocalDate } from '../gws-ea-whereabouts/clock.js';
import {
  affectedPeople,
  boundedCalendarMessage,
  calendarFindings,
  loadCalendarWeek,
  meetingLengthFacts,
  renderDays,
} from './days.js';
import {
  beginCalendarWrite,
  getCalendarWrite,
  markCalendarWriteApplied,
  completeCalendarWriteFindings,
  getCalendarSplitRecovery,
  pendingCalendarSplitRecoveries,
  markCalendarSplitMasterChanged,
  deferCalendarSplitRecovery,
  deferCalendarSplitReport,
  failCalendarSplitRecovery,
  markCalendarSplitReported,
  type CalendarWrite,
  type CalendarSplitPlan,
  type CalendarSplitRecovery,
} from './week/write-log.js';
import { WEEK_TAGS, calendarText, type EventCopy } from './week/model.js';
import { TIMEZONE } from '../../config.js';
import type { Session } from '../../types.js';
import {
  ANSWER_LATER,
  ActionRefusal,
  forbidden,
  invalidArgs,
  writeActionResponse,
  type ActionAnswer,
  type DeferredActionAnswer,
} from '../../cli/delivery-action.js';
import { getSession } from '../../db/sessions.js';
import { getGroupCapabilities } from '../../capabilities.js';
import { clearOutbox, withExistingMailboxSession } from '../../session-manager.js';
import type { ResponseFrame } from '../../cli/frame.js';
import { AGENT_GOOGLE_SERVICES } from '../gws-ea-google/grant.js';
import { writeNoteForMain } from '../gws-ea-profile/main-note.js';
import { EMAIL_PATTERN, hasControlCharacters } from '../../gws-ea/validation.js';
import { log } from '../../log.js';
import {
  canChangeEvents,
  EVENT_ID,
  hidesPrivateEvents,
  isPrincipalCalendar,
  recordOwnCalendarChange,
} from '../gws-ea-inbox/calendar-notifications.js';
import { GoogleApiError } from '../gws-ea-inbox/gmail-api.js';
import { assistantAddresses } from '../gws-ea-inbox/runtime.js';
import { joinRequestedMatter, requestedMatter } from '../gws-ea-matters/tool-matter.js';
import { getMainAgentGroupId, loadPrincipalRecognizer, type PrincipalRecognizer } from '../gws-ea-profile/db.js';
import {
  allowsMeet,
  type CalendarEntry,
  type EventGuests,
  type GuestRecord,
  type GuestWriteResult,
  type MeetingsCalendarApi,
  type NewEvent,
  type SendUpdates,
  type DetailedEvent,
  type EventWrite,
} from './calendar-api.js';
import {
  assertInvitationShareable,
  conferenceWords,
  dayLabel,
  eventIdFor,
  guestsOn,
  isOwnerAddress,
  readConference,
  spanLabel,
} from './calendar-actions.js';
import { addressesOf, flagOf, instantOf, lineOf, notesOf, timezoneOf } from './fields.js';
import { calendarName, calendarNames } from './calendar-names.js';

const TITLE_MAX = 200;
const NOTES_MAX = 8_000;
const LOCATION_MAX = 500;
const MAX_GUESTS = 50;
const MAX_RECURRENCE = 10;
const RECURRENCE_LINE_MAX = 500;
const MAX_EVENT_DAYS = 366;
/** Google's longest calendar id is an address. */
const CALENDAR_ID_MAX = 254;
const GUEST_WRITE_ATTEMPTS = 3;
const DAY = 24 * 60 * 60 * 1000;
const MAX_SPLIT_ATTEMPTS = 8;
const TOOL_WAIT_MS = 120_000;
const activeCalendarChanges = new Set<string>();
const splitOwnChanges = new Map<string, Set<string>>();
let calendarChangeTurn: Promise<unknown> = Promise.resolve();
function inCalendarChangeTurn<T>(work: () => Promise<T>): Promise<T> {
  const done = calendarChangeTurn.then(work);
  calendarChangeTurn = done.then(
    () => undefined,
    () => undefined,
  );
  return done;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const RECURRENCE_LINE = /^(?:RRULE|EXRULE|RDATE|EXDATE)[:;]\S+$/u;

const INCOMPLETE_LIST =
  "Google didn't return this event's whole guest list, so changing it could drop guests: ask the principal to change it in Google Calendar.";

const LIST = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });

// ---------------------------------------------------------------------------
// The request's fields
// ---------------------------------------------------------------------------

function calendarIdOf(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : '';
  if (id === '' || id.length > CALENDAR_ID_MAX || !id.includes('@') || /\s/u.test(id) || hasControlCharacters(id)) {
    throw invalidArgs("calendar must be a calendar ID, such as the principal's address for their primary calendar");
  }
  return id;
}

function eventIdOf(value: unknown): string {
  if (typeof value !== 'string' || !EVENT_ID.test(value)) {
    throw invalidArgs("event must be the event's id, as days gives it");
  }
  return value;
}

/** A calendar date, `YYYY-MM-DD`, as epoch milliseconds at its UTC midnight. */
function dateOf(value: unknown, label: string): number {
  const at = typeof value === 'string' && DATE.test(value) ? Date.parse(`${value}T00:00:00Z`) : NaN;
  if (!Number.isFinite(at) || new Date(at).toISOString().slice(0, 10) !== value) {
    throw invalidArgs(`${label} must be a date such as 2026-10-12`);
  }
  return at;
}

function recurrenceOf(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const lines = Array.isArray(value) ? value : [];
  if (
    lines.length === 0 ||
    lines.length > MAX_RECURRENCE ||
    !lines.every(
      (line): line is string =>
        typeof line === 'string' && line.length <= RECURRENCE_LINE_MAX && RECURRENCE_LINE.test(line),
    )
  ) {
    throw invalidArgs(
      `recurrence must list RRULE, EXRULE, RDATE or EXDATE lines, such as RRULE:FREQ=WEEKLY;BYDAY=MO (up to ${MAX_RECURRENCE})`,
    );
  }
  return lines;
}

function emailOf(guest: GuestRecord): string | undefined {
  return typeof guest.email === 'string' ? guest.email.toLowerCase() : undefined;
}

/** A guest's own address tells them nothing, so an address counts as seen only when another outside guest sees it. */
function addressesSeen(addresses: readonly string[], outside: readonly string[]): string[] {
  return addresses.filter((address) => outside.some((guest) => guest !== address));
}

function are(addresses: readonly string[]): string {
  return `${LIST.format(addresses)} ${addresses.length === 1 ? 'is' : 'are'}`;
}

/** `first` and `last` are days at UTC midnight (`dateOf`), `last` included. */
function daysLabel(first: number, last: number): string {
  return first === last ? dayLabel(first, 'UTC') : `${dayLabel(first, 'UTC')} to ${dayLabel(last, 'UTC')}`;
}

/** An answer a guest gave an event; `needsAction`, or none, is no answer yet. */
type Answer = 'accepted' | 'declined' | 'tentative';

function isAnswer(value: unknown): value is Answer {
  return value === 'accepted' || value === 'declined' || value === 'tentative';
}

function answerOf(guest: GuestRecord | undefined): Answer | undefined {
  const status = guest?.responseStatus;
  return isAnswer(status) ? status : undefined;
}

function responseOf(value: unknown): Answer {
  if (isAnswer(value)) return value;
  throw invalidArgs('response must be accepted, tentative or declined');
}

const ANSWER_WORDS: Readonly<Record<Answer, string>> = {
  accepted: 'going',
  tentative: 'maybe going',
  declined: 'not going',
};

function answerWords(status: unknown): string {
  return isAnswer(status) ? `${ANSWER_WORDS[status]} (${status})` : 'not yet answered (needsAction)';
}

function scopeWords(guests: EventGuests): string {
  if (guests.recurringEventId !== undefined) return ' on this occurrence only';
  return guests.recurrence === undefined ? '' : ' on every occurrence';
}

/** A new series has no old values for Google to retain on our behalf. */
function preservedSeriesProperties(before: DetailedEvent, patch: EventWrite): EventWrite {
  if (before.eventType !== undefined && before.eventType !== 'default')
    throw forbidden(
      'This event has a specialized calendar type that cannot be preserved in a series split. Nothing was written.',
    );
  if (before.attachments?.length || before.privateCopy || before.endTimeUnspecified || before.anyoneCanAddSelf)
    throw forbidden(
      'This event has calendar metadata that cannot be preserved in a series split. Nothing was written.',
    );
  if (before.attendeesOmitted) throw forbidden(`${INCOMPLETE_LIST} Nothing was written.`);
  const visibility = before.visibility;
  if (
    visibility !== undefined &&
    visibility !== 'default' &&
    visibility !== 'private' &&
    visibility !== 'public' &&
    visibility !== 'confidential'
  )
    throw forbidden('The event’s visibility could not be preserved in a series split. Nothing was written.');
  const transparency = before.transparency;
  if (transparency !== undefined && transparency !== 'opaque' && transparency !== 'transparent')
    throw forbidden('The event’s availability could not be preserved in a series split. Nothing was written.');
  if (patch.reminders === undefined && before.reminders === 'custom' && before.reminderOverrides === undefined)
    throw forbidden(
      'The event’s complete reminder overrides could not be read for the series split. Nothing was written.',
    );
  if (
    patch.conference === undefined &&
    before.conference !== undefined &&
    (before.conference.status !== 'success' || before.conferenceData === undefined)
  )
    throw forbidden('The existing conference could not be preserved in the series split. Nothing was written.');
  return {
    ...(visibility === undefined ? {} : { visibility }),
    ...(transparency === undefined ? {} : { transparency }),
    ...(before.reminders === undefined ? {} : { reminders: before.reminders }),
    ...(patch.reminders !== undefined || before.reminders !== 'custom' || before.reminderOverrides === undefined
      ? {}
      : { reminderOverrides: before.reminderOverrides }),
    ...(before.guestsCanModify === undefined ? {} : { guestsCanModify: before.guestsCanModify }),
    ...(before.guestsCanInviteOthers === undefined ? {} : { guestsCanInviteOthers: before.guestsCanInviteOthers }),
    ...(before.guestsCanSeeOtherGuests === undefined
      ? {}
      : { guestsCanSeeOtherGuests: before.guestsCanSeeOtherGuests }),
    ...(before.colorId === undefined ? {} : { colorId: before.colorId }),
    ...(before.source === undefined ? {} : { source: before.source }),
    ...(before.sharedTags === undefined ? {} : { sharedTags: before.sharedTags }),
    ...(patch.conference === undefined && before.conferenceData !== undefined
      ? { conferenceData: before.conferenceData }
      : {}),
  };
}

function sameTrimmedMaster(current: DetailedEvent | undefined, split: CalendarSplitPlan): boolean {
  if (split.deleteMaster) return current === undefined || current.status === 'cancelled';
  if (!current || !isDeepStrictEqual(current.recurrence, split.trim)) return false;
  const retainedFields = (event: DetailedEvent) =>
    Object.fromEntries(
      Object.entries(event).filter(([key, value]) => key !== 'etag' && key !== 'recurrence' && value !== undefined),
    );
  return isDeepStrictEqual(retainedFields(current), retainedFields(split.master));
}

const PRINCIPAL_WORDS: Readonly<Record<Answer, string>> = {
  accepted: 'and the principal, accepted',
  declined: 'and the principal, who declined it',
  tentative: 'and the principal, who answered maybe',
};

async function withMatter(message: string, matterId: string | undefined, calendarId: string, eventId: string) {
  return matterId === undefined
    ? message
    : `${message} ${await joinRequestedMatter(matterId, { kind: 'event', reference: `${calendarId}/${eventId}` })}`;
}

type CalendarOwner = 'principal' | 'assistant';

interface OwnerWords {
  readonly added: string;
  readonly stays: string;
  /** Ending "Nothing changed: …". */
  readonly alreadyOn: string;
  /** Who an event invites after `change_guests`, ending "Its guests now: …". */
  guestsNow(invited: readonly string[], answer: Answer): string;
}

const OWNER_WORDS: Readonly<Record<CalendarOwner, OwnerWords>> = {
  principal: {
    added: 'As on an event they made themselves, the principal is on its guest list, accepted.',
    stays: 'The principal stays on their own events: they organize them.',
    alreadyOn: 'the principal is already on it',
    guestsNow: (invited, answer) =>
      `${invited.length === 0 ? 'nobody else' : LIST.format(invited)}, ${PRINCIPAL_WORDS[answer]}`,
  },
  // The host reads none of the calendar's sharing (its token cannot), so these words cover every case.
  assistant: {
    added:
      'It is on your own calendar: anyone your calendar is shared with sees its details unless it is private, and in a company Workspace that can include colleagues.',
    stays: 'You stay on the events on your own calendar: you organize them.',
    alreadyOn: 'you are already on it',
    guestsNow: (invited) => (invited.length === 0 ? 'nobody but you' : LIST.format(invited)),
  },
};

/** On a principal calendar the principal is the organizer, so a change that touches only them emails no one. */
function googleTells(owner: CalendarOwner, principal: PrincipalRecognizer, addresses: readonly string[]): boolean {
  return owner === 'assistant' ? addresses.length > 0 : addresses.some((address) => !principal.has(address));
}

interface GuestChange {
  /** The list to write back, or undefined when it already says what was asked. */
  readonly next: readonly GuestRecord[] | undefined;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  /** Who the event invites afterwards: neither the calendar's owner nor a room. */
  readonly invited: readonly string[];
  /** The calendar owner's answer afterwards. */
  readonly answer: Answer;
  /** Addresses to take off that the list does not have. */
  readonly absent: readonly string[];
  /** Addresses to invite that it already has. */
  readonly already: readonly string[];
}

/**
 * Worked out afresh from each read of the list, everyone kept exactly as
 * Google holds them. `remove` never names the calendar's owner (refused
 * before this). Whatever the owner answered stays theirs; only with no
 * answer yet do they count as accepted, as the organizer of an event they
 * made themselves.
 */
function guestChange(
  calendarId: string,
  guests: readonly GuestRecord[],
  add: readonly string[],
  remove: readonly string[],
): GuestChange {
  const isOwner = (address: string | undefined): boolean => isOwnerAddress(calendarId, address);
  const listed = new Set(guests.flatMap((guest) => emailOf(guest) ?? []));
  const adding = add.filter((address) => !isOwner(address) && !listed.has(address));
  const ownerEntry = guests.find((guest) => isOwner(emailOf(guest)));
  const answered = answerOf(ownerEntry);

  const kept = guests
    .filter((guest) => !remove.includes(emailOf(guest) ?? ''))
    .map((guest) =>
      isOwner(emailOf(guest)) && answered === undefined ? { ...guest, responseStatus: 'accepted' } : guest,
    );
  const next: GuestRecord[] = [
    ...(ownerEntry === undefined ? [{ email: calendarId, responseStatus: 'accepted' }] : []),
    ...kept,
    ...adding.map((email) => ({ email })),
  ];
  const unchanged = adding.length === 0 && kept.length === guests.length && answered !== undefined;
  return {
    next: unchanged ? undefined : next,
    added: adding,
    removed: remove.filter((address) => listed.has(address)),
    // A room booked on the event stays on it as it is, but is no one invited.
    invited: next.flatMap((guest) => {
      const email = emailOf(guest);
      return email === undefined || isOwner(email) || guest.resource === true ? [] : [email];
    }),
    answer: answered ?? 'accepted',
    absent: remove.filter((address) => !listed.has(address)),
    already: add.filter((address) => !isOwner(address) && listed.has(address)),
  };
}

/** The assistant's when one of its own addresses names it, which can never be one of the principal's. */
function ownerOf(
  entry: CalendarEntry,
  principal: PrincipalRecognizer,
  assistant: ReadonlySet<string>,
): CalendarOwner | undefined {
  if (assistant.has(entry.id.toLowerCase())) return 'assistant';
  return isPrincipalCalendar(entry, principal) ? 'principal' : undefined;
}

/**
 * A write on a principal calendar is recorded so Google's notification of it
 * produces no note. One on the assistant's own calendar is not: the host
 * turns notifications on only for the principal's, so Google tells the
 * assistant nothing of its own edits there, and a record would swallow a
 * guest's first answer.
 */
function recordOwnChange(owner: CalendarOwner, calendarId: string, eventId: string): void {
  if (owner === 'principal') recordOwnCalendarChange(calendarId, eventId);
}

function recordSplitOwnChange(requestId: string, owner: CalendarOwner, calendarId: string, eventId: string): void {
  if (owner !== 'principal') return;
  const changes = splitOwnChanges.get(requestId) ?? new Set<string>();
  if (changes.has(eventId)) return;
  recordOwnChange(owner, calendarId, eventId);
  changes.add(eventId);
  splitOwnChanges.set(requestId, changes);
}

const { RRule } = recurrenceRules;
function floating(at: number, zone: string): Date {
  const t = wallClock(at, zone);
  return new Date(Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second));
}
function fromFloating(date: Date, zone: string): number {
  const day: LocalDate = { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
  return zonedInstant(day, date.getUTCHours() * 60 + date.getUTCMinutes(), zone) + date.getUTCSeconds() * 1000;
}
const compactUtc = (at: number): string =>
  new Date(at)
    .toISOString()
    .replace(/[-:]/gu, '')
    .replace(/\.\d{3}Z$/u, 'Z');
function dateInRule(value: string, zone: string, allDay: boolean, sourceZone = zone): Date {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/u.exec(value);
  if (!m) throw invalidArgs('Google returned a recurrence date that could not be read.');
  const date = new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)),
  );
  return allDay
    ? date
    : m[7]
      ? floating(date.getTime(), zone)
      : sourceZone === zone
        ? date
        : floating(fromFloating(date, sourceZone), zone);
}
function ruleLine(options: Partial<Options>, kind: 'RRULE' | 'EXRULE', zone: string, allDay: boolean): string {
  const rule = RRule.optionsToString(options)
    .split('\n')
    .find((line) => line.startsWith('RRULE:'));
  if (!rule) throw new Error('Recurrence rule did not serialize');
  return rule.replace(/^RRULE:/u, `${kind}:`).replace(/UNTIL=([0-9TZ]+)/u, () => {
    const until = options.until;
    if (!until) throw new Error('Recurrence end was not retained');
    return `UNTIL=${allDay ? compactUtc(until.getTime()).slice(0, 8) : compactUtc(fromFloating(until, zone))}`;
  });
}
/** Rule arithmetic uses floating wall dates, so the host process TZ cannot change a series across DST. */
function splitRecurrence(
  master: DetailedEvent,
  occurrence: DetailedEvent,
  patch: EventWrite,
  zone: string,
  nextZone: string,
  retainFollowing: boolean,
): { prior: string[]; following: string[]; hasPrior: boolean } {
  const allDay = master.start?.date !== undefined;
  const masterAt = master.start?.date
    ? dateOf(master.start.date, 'series start')
    : instantOf(master.start?.dateTime, 'series start');
  const original = occurrence.originalStartTime ?? occurrence.start;
  const cutoffAt = original?.date
    ? dateOf(original.date, 'original start')
    : instantOf(original?.dateTime, 'original start');
  const first = allDay ? new Date(masterAt) : floating(masterAt, zone);
  const cutoff = allDay ? new Date(cutoffAt) : floating(cutoffAt, zone);
  const nextAt = patch.start
    ? patch.allDay
      ? dateOf(patch.start, 'start')
      : instantOf(patch.start, 'start')
    : occurrence.start?.date
      ? dateOf(occurrence.start.date, 'start')
      : instantOf(occurrence.start?.dateTime, 'start');
  const next = (patch.allDay ?? allDay) ? new Date(nextAt) : floating(nextAt, nextZone);
  const delta = next.getTime() - cutoff.getTime();
  const prior: string[] = [];
  const following: string[] = [];
  let hasPrior = false;
  for (const line of master.recurrence ?? []) {
    if (/^(?:RRULE|EXRULE):/u.test(line)) {
      const kind = line.startsWith('EXRULE:') ? 'EXRULE' : 'RRULE';
      const parsed = RRule.parseString(line.replace(/^EXRULE:/u, 'RRULE:'));
      const until = parsed.until ? (allDay ? parsed.until : floating(parsed.until.getTime(), zone)) : undefined;
      const originalOptions = { ...parsed, dtstart: first, tzid: null, ...(until ? { until } : {}) };
      const rule = new RRule(originalOptions);
      const before = rule.between(new Date(first.getTime() - 1), cutoff, false).length;
      if (kind === 'RRULE' && before > 0) hasPrior = true;
      if (kind === 'EXRULE') prior.push(line);
      else if (before > 0) {
        const countFinished = parsed.count !== undefined && parsed.count !== null && before >= parsed.count;
        prior.push(
          countFinished
            ? line
            : ruleLine(
                {
                  ...originalOptions,
                  count: null,
                  until: new Date(Math.min(until?.getTime() ?? Infinity, cutoff.getTime() - 1000)),
                },
                kind,
                zone,
                allDay,
              ),
        );
      }
      const remaining = parsed.count == null ? undefined : parsed.count - before;
      if (remaining !== undefined && remaining <= 0) continue;
      if (until && until < cutoff) continue;
      if (retainFollowing && patch.recurrence === undefined) {
        const preservedFirst = rule.after(cutoff, true);
        const anchoredFirst = new RRule({
          ...originalOptions,
          dtstart: cutoff,
          ...(remaining === undefined ? {} : { count: remaining }),
        }).after(cutoff, true);
        // Google gives the new event one DTSTART and forbids independent DTSTART lines in recurrence[].
        // An off-cadence RDATE or exclusion rule can therefore shift unrequested future dates.
        if (preservedFirst?.getTime() !== anchoredFirst?.getTime())
          throw invalidArgs(
            'This split cannot preserve the existing recurrence with Google’s one start for the following series: re-anchoring a rule would change later dates. Supply an explicit replacement recurrence for the following series, or change this occurrence alone. Nothing was written.',
          );
      }
      following.push(
        ruleLine(
          {
            ...parsed,
            dtstart: next,
            tzid: null,
            ...(remaining === undefined ? {} : { count: remaining }),
            ...(until ? { until: new Date(until.getTime() + delta) } : {}),
          },
          kind,
          nextZone,
          patch.allDay ?? allDay,
        ),
      );
    } else {
      const [prefix, values] = line.split(':');
      if (!values || !/^(?:RDATE|EXDATE)(?:;|$)/u.test(prefix))
        throw invalidArgs('Google returned an unreadable recurrence set.');
      const sourceZone = /(?:^|;)TZID=([^;]+)/u.exec(prefix)?.[1] ?? zone;
      const dates = values.split(',').map((v) => dateInRule(v, zone, allDay, sourceZone));
      const earlier = dates.filter((d) => d < cutoff);
      const later = dates.filter((d) => d >= cutoff).map((d) => new Date(d.getTime() + delta));
      if (prefix.startsWith('RDATE') && earlier.length) hasPrior = true;
      const writeDates = (dates: readonly Date[], targetZone: string, dateOnly: boolean): string =>
        dates
          .map((d) => (dateOnly ? compactUtc(d.getTime()).slice(0, 8) : compactUtc(fromFloating(d, targetZone))))
          .join(',');
      if (earlier.length)
        prior.push(
          `${prefix.startsWith('EXDATE') ? 'EXDATE' : 'RDATE'}${allDay ? ';VALUE=DATE' : ''}:${writeDates(earlier, zone, allDay)}`,
        );
      if (later.length)
        following.push(
          `${prefix.startsWith('EXDATE') ? 'EXDATE' : 'RDATE'}${(patch.allDay ?? allDay) ? ';VALUE=DATE' : ''}:${writeDates(later, nextZone, patch.allDay ?? allDay)}`,
        );
    }
  }
  return { prior, following: patch.recurrence ? [...patch.recurrence] : following, hasPrior };
}
function linkedTags(content: Record<string, unknown>): Record<string, string> {
  const parent = content.parent_event === undefined ? undefined : eventIdOf(content.parent_event);
  const parentCalendar = content.parent_calendar === undefined ? undefined : calendarIdOf(content.parent_calendar);
  const parentStart = lineOf(content.parent_start, 'parent_start', 64);
  const kind = lineOf(content.block_kind, 'block_kind', 64);
  return {
    ...(parent ? { [WEEK_TAGS.parentEvent]: parent } : {}),
    ...(parentCalendar ? { [WEEK_TAGS.parentCalendar]: parentCalendar } : {}),
    ...(parentStart ? { [WEEK_TAGS.parentStart]: parentStart } : {}),
    ...(kind ? { [WEEK_TAGS.blockKind]: kind } : {}),
  };
}

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

export interface PrincipalEventToolsDeps {
  readonly calendar: () => MeetingsCalendarApi;
}

interface WritableCalendar {
  readonly entry: CalendarEntry;
  readonly owner: CalendarOwner;
  readonly principal: PrincipalRecognizer;
}

export function createPrincipalEventTools(deps: PrincipalEventToolsDeps) {
  const calendar = () => deps.calendar();

  async function writableCalendarOf(calendarId: string): Promise<WritableCalendar> {
    const [entry, principal, assistant] = await Promise.all([
      calendar().getCalendar(calendarId),
      loadPrincipalRecognizer(),
      assistantAddresses(),
    ]);
    const owner = entry === undefined ? undefined : ownerOf(entry, principal, assistant);
    if (entry === undefined || owner === undefined) {
      throw forbidden(
        `${calendarId} is not one of the principal's calendars in your list, nor your own: you write only on those.`,
      );
    }
    if (!canChangeEvents(entry)) {
      throw forbidden('Google lets you see that calendar but not change it.');
    }
    return { entry, owner, principal };
  }

  const createEventRaw = async (
    content: Record<string, unknown>,
    session: Session,
    requestId: string,
    timeline: Timeline,
  ): Promise<Record<string, unknown>> => {
    const calendarId = calendarIdOf(content.calendar);
    const title = lineOf(content.title, 'title', TITLE_MAX);
    if (title === undefined) throw invalidArgs(`title must be text of 1 to ${TITLE_MAX} characters`);
    const allDay = flagOf(content.all_day, 'all_day');
    const notes = notesOf(content.notes, NOTES_MAX);
    const location = lineOf(content.location, 'location', LOCATION_MAX);
    const guests = addressesOf(content.guests, 'guests', MAX_GUESTS) ?? [];
    const free = flagOf(content.free, 'free');
    const hidden = flagOf(content.private, 'private');
    const recurrence = recurrenceOf(content.recurrence);
    const videoCall = flagOf(content.video_call, 'video_call');
    let timezone = timezoneOf(content.timezone);

    let start: string;
    let end: string;
    let when: string;
    if (allDay) {
      const first = dateOf(content.start, 'start');
      const last = dateOf(content.end, 'end');
      if (last < first) throw invalidArgs('end, the last day, must not come before start');
      if (last - first >= MAX_EVENT_DAYS * DAY) throw invalidArgs(`An event may last at most ${MAX_EVENT_DAYS} days`);
      start = String(content.start);
      timezone ??= zoneForDay(timeline, start) ?? TIMEZONE;
      // Google's end date is the day after the last.
      end = new Date(last + DAY).toISOString().slice(0, 10);
      when = `${daysLabel(first, last)}, all day`;
    } else {
      const from = instantOf(content.start, 'start');
      const to = instantOf(content.end, 'end');
      if (to <= from) throw invalidArgs('end must come after start');
      if (to - from > MAX_EVENT_DAYS * DAY) throw invalidArgs(`An event may last at most ${MAX_EVENT_DAYS} days`);
      start = new Date(from).toISOString();
      timezone ??= zoneAt(timeline, from) ?? TIMEZONE;
      end = new Date(to).toISOString();
      // An event that ends on a later day names both days, not only the one it starts on.
      when = spanLabel({ start: from, end: to }, timezone);
    }
    const matterId = await requestedMatter(content.matter, session);

    const { entry, owner, principal } = await writableCalendarOf(calendarId);
    if (hidden && hidesPrivateEvents(entry)) {
      throw forbidden(
        'That calendar is shared with you without its private events, so Google lets you add only events that are not private there.',
      );
    }
    // The calendar's owner is its organizer; on the assistant's own, the principal is on it only when named.
    const attendees = guestsOn(entry.id, guests);
    const invited = guests.filter((address) => !isOwnerAddress(entry.id, address));
    const outside = invited.filter((address) => !principal.has(address));
    const tellsGuests = googleTells(owner, principal, invited);
    await assertInvitationShareable(
      {
        texts: [title, notes, location],
        shown: [
          entry.summary,
          ...addressesSeen(
            attendees.map((guest) => guest.email.toLowerCase()),
            outside,
          ),
        ],
        recipients: outside,
        writer: 'main',
      },
      'The event was not added',
      "Write it without that detail, and do not hint at, spell out, or encode it. If it is the calendar's name or a guest's address, ask the principal how they want it done.",
    );
    if (videoCall && !allowsMeet(entry)) {
      throw forbidden('That calendar does not allow Google Meet links: give the place in location instead.');
    }
    const eventId = eventIdFor('event', requestId);
    const preparedEvent: NewEvent = {
      summary: title,
      ...(notes === undefined ? {} : { description: notes }),
      ...(location === undefined ? {} : { location }),
      ...(videoCall ? { conference: { requestId: eventIdFor('meet', eventId) } } : {}),
      start,
      end,
      ...(allDay ? { allDay: true } : { timeZone: timezone }),
      ...(recurrence === undefined ? {} : { recurrence }),
      attendees,
      transparency: free ? 'transparent' : 'opaque',
      ...(hidden ? { visibility: 'private' as const } : {}),
      reminders: 'default',
      tags: {
        ...linkedTags(content),
        ...(matterId ? { [WEEK_TAGS.matter]: matterId } : {}),
        [WEEK_TAGS.assistantWritten]: 'true',
        ...(typeof content.kind === 'string' ? { [WEEK_TAGS.meetingKind]: content.kind } : {}),
      },
    };
    await beginCalendarWrite({
      requestId,
      calendarId: entry.id,
      eventId,
      action: 'create_event',
      request: content,
      before: null,
      plan: { patch: preparedEvent },
      refreshScope: recurrence?.length ? 'series' : 'event',
      affectedStart: allDay ? `${start}T00:00:00Z` : start,
      affectedEnd: allDay ? `${end}T00:00:00Z` : end,
    });
    let inserted: 'created' | 'exists';
    try {
      inserted = await calendar().insertEvent(entry.id, eventId, preparedEvent, tellsGuests ? 'all' : 'none');
    } catch (error) {
      if (error instanceof GoogleApiError && error.status > 0 && error.status < 500) throw error;
      log.warn('Calendar insert returned no result; checking its live event', { requestId, error });
      const made = await calendar().getEventDetail(entry.id, eventId);
      if (!made || made.status === 'cancelled' || !appliedPatch(made, preparedEvent)) throw error;
      inserted = 'created';
    }
    if (inserted === 'exists') {
      // A replay: this request made the event before, and its guests heard of it then. It stands
      // as it is now, unless someone has deleted it since, and an event deleted is not put back.
      const made = await calendar().getEvent(entry.id, eventId);
      if (made === undefined || made.status === 'cancelled') {
        throw forbidden(
          'The event this request made earlier has since been deleted from that calendar, so nothing was added.',
        );
      }
    }
    recordOwnChange(owner, entry.id, eventId);
    await markCalendarWriteApplied(
      requestId,
      `Added "${title}" to ${owner === 'assistant' ? 'your own calendar' : "the principal's calendar"}: ${when}.`,
    );
    const conference = videoCall ? await readConference(calendar(), entry.id, eventId) : undefined;
    const joined =
      matterId === undefined
        ? []
        : [await joinRequestedMatter(matterId, { kind: 'event', reference: `${entry.id}/${eventId}` })];
    let spokenCalendar = owner === 'assistant' ? 'your own calendar' : "the principal's calendar";
    if (owner === 'principal') {
      try {
        const listed = (await calendar().listCalendars()).filter((item) => isPrincipalCalendar(item, principal));
        const name = calendarNames(listed, principal).get(entry.id);
        if (name !== undefined && !EMAIL_PATTERN.test(name.text)) spokenCalendar = calendarName(name);
        // eslint-disable-next-line no-catch-all/no-catch-all -- a calendar label cannot fail an event already added
      } catch (error) {
        log.warn('Calendar event was added, but its calendar name could not be read', { error });
      }
    }
    return {
      calendar: entry.id,
      event: eventId,
      start: String(content.start),
      end: String(content.end),
      message: [
        `Added "${title}" to ${spokenCalendar}: ${when}${conferenceWords(conference)}.`,
        OWNER_WORDS[owner].added,
        ...(invited.length === 0
          ? []
          : [
              `Its guests: ${invited.join(', ')}; ${tellsGuests ? 'Google sent them the invitation' : 'Google emailed no one'}.`,
            ]),
        ...(recurrence === undefined ? [] : ['It repeats.']),
        `Change who it invites with change_guests, event ${eventId}; anything else with change_event.`,
        ...joined,
      ].join(' '),
    };
  };

  const changeGuestsRaw: ActionAnswer = async (content, session) => {
    const calendarId = calendarIdOf(content.calendar);
    const eventId = eventIdOf(content.event);
    const add = addressesOf(content.add, 'add', MAX_GUESTS) ?? [];
    const remove = addressesOf(content.remove, 'remove', MAX_GUESTS) ?? [];
    if (add.length === 0 && remove.length === 0) {
      throw invalidArgs('Give add, remove, or both: the people to invite or to take off.');
    }
    const matterId = await requestedMatter(content.matter, session);
    const { entry, owner, principal } = await writableCalendarOf(calendarId);
    const words = OWNER_WORDS[owner];
    const organizer = entry.id.toLowerCase();
    if (remove.some((address) => isOwnerAddress(entry.id, address))) throw forbidden(words.stays);
    const answered = async (guests: readonly string[], message: string) => ({
      calendar: entry.id,
      event: eventId,
      guests,
      message: await withMatter(message, matterId, entry.id, eventId),
    });

    // The list is written back only over the version of the event it was
    // read from, so a guest's answer, or anyone's change, that lands in
    // between is read again and kept rather than undone.
    for (let attempt = 0; attempt < GUEST_WRITE_ATTEMPTS; attempt += 1) {
      const current = await calendar().getGuests(entry.id, eventId);
      if (current === undefined || current.status === 'cancelled') {
        throw forbidden(`No event ${eventId} on that calendar.`);
      }
      if (current.organizer !== organizer) {
        throw forbidden(
          `${current.organizer ? calendarText(current.organizer) : 'Someone else'} organizes that event: only they change who it invites. Ask them, through external-email when they are outside.`,
        );
      }
      if (current.attendeesOmitted === true) throw forbidden(INCOMPLETE_LIST);

      const { next, added, removed, invited, answer, absent, already } = guestChange(
        entry.id,
        current.guests,
        add,
        remove,
      );
      if (next === undefined) {
        return answered(
          invited,
          `Nothing changed: ${[
            ...(absent.length === 0 ? [] : [`${are(absent)} not invited`]),
            ...(already.length === 0 ? [] : [`${are(already)} already invited`]),
            words.alreadyOn,
          ].join('; ')}.`,
        );
      }
      if (added.length > 0) {
        // Whoever it invites reads what the event already says, and everyone else on it sees who joins.
        const outside = invited.filter((address) => !principal.has(address));
        await assertInvitationShareable(
          {
            texts: [],
            shown: [
              current.summary,
              current.description,
              current.location,
              entry.summary,
              ...addressesSeen(
                next.flatMap((guest) => emailOf(guest) ?? []),
                outside,
              ),
            ],
            recipients: outside,
            writer: 'main',
          },
          'The guests were not changed',
          "It is in what the event already says, its calendar's name, or an address on its guest list: ask the principal how they want it done.",
        );
      }
      const tellsGuests = googleTells(owner, principal, [...added, ...removed]);
      const sendUpdates = tellsGuests ? 'all' : 'none';
      let written: GuestWriteResult;
      try {
        written = await calendar().setGuests(entry.id, eventId, next, sendUpdates, current.etag);
      } catch (error) {
        if (error instanceof GoogleApiError && error.status > 0 && error.status < 500) throw error;
        log.warn('Calendar guest write returned no result; checking its live guests', {
          calendarId: entry.id,
          eventId,
          error,
        });
        const after = await calendar().getGuests(entry.id, eventId);
        if (
          !after ||
          after.status === 'cancelled' ||
          after.organizer !== organizer ||
          after.attendeesOmitted ||
          guestChange(entry.id, after.guests, add, remove).next !== undefined
        )
          throw error;
        written = 'set';
      }
      if (written === 'gone') throw forbidden(`No event ${eventId} on that calendar.`);
      if (written === 'set') {
        recordOwnChange(owner, entry.id, eventId);
        return answered(
          invited,
          `Its guests now: ${words.guestsNow(invited, answer)}. ${tellsGuests ? 'Google sent the guests the update.' : 'Google emailed no one.'}`,
        );
      }
    }
    throw forbidden("The event's guests kept changing while this ran: try again in a moment.");
  };

  const respondToEventRaw: ActionAnswer = async (content, session) => {
    const calendarId = calendarIdOf(content.calendar);
    const eventId = eventIdOf(content.event);
    const response = responseOf(content.response);
    const matterId = await requestedMatter(content.matter, session);
    const { entry, owner, principal } = await writableCalendarOf(calendarId);
    if (owner === 'assistant') {
      throw forbidden("That is your own calendar: the principal's answer lives on their calendar, so answer there.");
    }
    const noEvent = `No event ${eventId} on that calendar.`;
    const answered = async (held: Answer, message: string) => ({
      calendar: entry.id,
      event: eventId,
      response: held,
      message: await withMatter(message, matterId, entry.id, eventId),
    });

    // Each write goes over the version of the event it read, so an answer the
    // principal gives themselves meanwhile is never overwritten.
    let first: unknown;
    for (let attempt = 0; attempt < GUEST_WRITE_ATTEMPTS; attempt += 1) {
      const current = await calendar().getGuests(entry.id, eventId);
      if (current === undefined || current.status === 'cancelled') throw forbidden(noEvent);
      const own = current.guests.find((guest) => guest.self === true);
      if (own === undefined) {
        if (hidesPrivateEvents(entry)) {
          throw forbidden(
            "You can't see the principal on that event. That calendar is shared with you without their private events, so if it is private, only they can answer it; otherwise bring it to them.",
          );
        }
        throw forbidden(
          current.organizer === entry.id.toLowerCase()
            ? "The principal organizes that event and isn't on its guest list, so they have no answer to set."
            : "The principal isn't on that event's guest list on that calendar, as when they're invited through a group: bring it to them.",
        );
      }
      const status = own.responseStatus;
      if (status === response) {
        return answered(
          response,
          `Nothing changed: Google already shows the principal as ${answerWords(response)}${scopeWords(current)}.`,
        );
      }
      if (attempt === 0) first = status;
      else if (status !== first) {
        throw forbidden(
          `The principal answered ${answerWords(status)} themselves while this ran, so nothing was written: their answer stands unless they ask you to change it.`,
        );
      }

      // Their entry as Google holds it, with the new answer and no earlier note: a word to the organizer goes
      // through external-email.
      const { comment: _comment, ...kept } = own;
      const next: GuestRecord = { ...kept, responseStatus: response };
      const organizes = own.organizer === true;
      if (organizes && current.attendeesOmitted === true) throw forbidden(INCOMPLETE_LIST);
      const sendUpdates: SendUpdates = organizes || principal.has(current.organizer) ? 'none' : 'all';
      let written: GuestWriteResult;
      let after: EventGuests | undefined;
      try {
        written = organizes
          ? await calendar().setGuests(
              entry.id,
              eventId,
              current.guests.map((guest) => (guest === own ? next : guest)),
              sendUpdates,
              current.etag,
            )
          : await calendar().setOwnEntry(entry.id, eventId, next, sendUpdates, current.etag);
      } catch (error) {
        if (error instanceof GoogleApiError && error.status > 0 && error.status < 500) throw error;
        log.warn('Calendar response write returned no result; checking its live response', {
          calendarId: entry.id,
          eventId,
          error,
        });
        after = await calendar().getGuests(entry.id, eventId);
        if (
          !after ||
          after.status === 'cancelled' ||
          after.guests.find((guest) => guest.self === true)?.responseStatus !== response
        )
          throw error;
        written = 'set';
      }
      if (written === 'gone') throw forbidden(noEvent);
      if (written === 'changed') continue;

      const notice = sendUpdates === 'all' ? 'Google was asked to tell the organizer.' : 'Google emailed no one.';
      try {
        after ??= await calendar().getGuests(entry.id, eventId);
      } catch (error) {
        // Google took the write; only reading it back failed, so the answer is unconfirmed, not refused.
        if (!(error instanceof GoogleApiError)) throw error;
        return answered(
          response,
          `Google took the answer but could not show it back just now, so check it with days before you tell the principal. ${notice}`,
        );
      }
      if (after === undefined || after.status === 'cancelled') throw forbidden(noEvent);
      const held = after.guests.find((guest) => guest.self === true)?.responseStatus;
      if (held !== response) {
        throw forbidden(
          `Google took the answer but still shows the principal as ${answerWords(held)}, so it didn't take: ask them to answer it in Google Calendar.`,
        );
      }
      return answered(
        response,
        `Google now shows the principal as ${answerWords(response)}${scopeWords(current)}. ${notice}`,
      );
    }
    throw forbidden('The event kept changing while this ran: try again in a moment.');
  };

  async function finishWrite(
    receipt: CalendarWrite,
    outcome: string,
    snapshot?: Timeline,
  ): Promise<Record<string, unknown>> {
    const base = {
      calendar: receipt.calendarId,
      event: receipt.eventId,
      ...(receipt.action === 'create_event'
        ? { start: String(receipt.request.start), end: String(receipt.request.end) }
        : {}),
    };
    /* eslint-disable no-catch-all/no-catch-all -- a committed calendar write survives every post-write read */
    try {
      const timeline = snapshot ?? (await loadTimeline());
      const start = Date.parse(receipt.affectedStart);
      const end = Date.parse(receipt.affectedEnd);
      const read = await calendar().getEventDetail(receipt.calendarId, receipt.eventId);
      const detail =
        receipt.action === 'cancel_event' && !read
          ? { ...receipt.before, id: receipt.eventId, status: 'cancelled' }
          : read;
      const own = (await assistantAddresses()).has(receipt.calendarId);
      const copies: EventCopy[] = detail
        ? [{ calendarId: receipt.calendarId, owner: own ? 'assistant' : 'principal', event: detail }]
        : [];
      const week = await loadCalendarWeek(calendar(), {
        start,
        end: Math.max(start + 1, end),
        timeline,
        shaping: receipt.action === 'create_event' || receipt.action === 'change_event',
        additionalEvents: copies,
        replaceEvent: { calendarId: receipt.calendarId, eventId: receipt.eventId },
      });
      const event = week.events.find((e) => e.calendarId === receipt.calendarId && e.id === receipt.eventId);
      const involvement = event && receipt.action === 'create_event' ? [affectedPeople(event, week)] : [];
      const findings = await calendarFindings(week);
      await completeCalendarWriteFindings(receipt.requestId);
      return {
        ...base,
        message: boundedCalendarMessage(outcome, [
          ...involvement,
          ...(event && receipt.action === 'change_event' ? [renderDays({ ...week, events: [event] })] : []),
          ...(receipt.action === 'create_event' || receipt.action === 'change_event'
            ? [meetingLengthFacts(week, typeof receipt.request.kind === 'string' ? receipt.request.kind : undefined)]
            : []),
          findings,
        ]),
      };
    } catch (error) {
      log.warn('Calendar write stands without findings', { requestId: receipt.requestId, error });
      return { ...base, message: `${outcome}\nfindings unavailable` };
    }
    /* eslint-enable no-catch-all/no-catch-all */
  }
  const createEvent: ActionAnswer = async (content, session, requestId) => {
    const timeline = await loadTimeline();
    let receipt = await getCalendarWrite(requestId);
    if (receipt?.state === 'applied') {
      await beginCalendarWrite({ ...receipt, request: content });
      const made = await calendar().getEvent(receipt.calendarId, receipt.eventId);
      if (!made || made.status === 'cancelled')
        throw forbidden(
          'The event this request made earlier has since been deleted from that calendar, so nothing was added.',
        );
      return finishWrite(receipt, receipt.outcome ?? 'Created.', timeline);
    }
    try {
      const result = await createEventRaw(content, session, requestId, timeline);
      receipt = await getCalendarWrite(requestId);
      if (!receipt) throw new Error('The calendar write has no durable receipt');
      const outcome = String(result.message);
      await markCalendarWriteApplied(requestId, outcome);
      return finishWrite(receipt, outcome, timeline);
    } catch (error) {
      receipt = await getCalendarWrite(requestId);
      if (receipt?.state !== 'applied') throw error;
      log.warn('Created event stands without post-write detail', { requestId, error });
      return finishWrite(receipt, receipt.outcome ?? 'Created.', timeline);
    }
  };

  function loggedExistingWrite(action: 'change_guests' | 'respond_to_event', raw: ActionAnswer): ActionAnswer {
    return async (content, session, requestId) => {
      const timeline = await loadTimeline();
      const calendarId = calendarIdOf(content.calendar);
      const eventId = eventIdOf(content.event);
      const existing = await getCalendarWrite(requestId);
      if (existing?.state === 'applied') {
        await beginCalendarWrite({ ...existing, request: content });
        return finishWrite(existing, existing.outcome ?? 'The change was applied.', timeline);
      }
      const before = await calendar().getEventDetail(calendarId, eventId);
      const start =
        before?.start?.dateTime ?? (before?.start?.date ? `${before.start.date}T00:00:00Z` : new Date().toISOString());
      const end =
        before?.end?.dateTime ??
        (before?.end?.date ? `${before.end.date}T00:00:00Z` : new Date(Date.parse(start) + DAY).toISOString());
      const receipt = await beginCalendarWrite({
        requestId,
        calendarId,
        eventId,
        action,
        request: content,
        before: before ?? null,
        refreshScope: before?.recurrence?.length ? 'series' : 'event',
        affectedStart: start,
        affectedEnd: end,
      });
      const result = await raw(content, session, requestId);
      const outcome = String(result.message);
      await markCalendarWriteApplied(requestId, outcome);
      return { ...result, ...(await finishWrite(receipt, outcome, timeline)) };
    };
  }
  const changeGuests = loggedExistingWrite('change_guests', changeGuestsRaw);
  const respondToEvent = loggedExistingWrite('respond_to_event', respondToEventRaw);

  function sendUpdatesOf(value: unknown): SendUpdates {
    if (value !== 'all' && value !== 'none')
      throw invalidArgs('send_updates must be all or none: choose whether Google notifies guests.');
    return value;
  }
  function patchOf(content: Record<string, unknown>, before: DetailedEvent): EventWrite {
    const start =
      content.start === undefined
        ? content.timezone === undefined
          ? undefined
          : (before.start?.dateTime ?? before.start?.date)
        : before.start?.date || content.all_day === true
          ? String(content.start)
          : new Date(instantOf(content.start, 'start')).toISOString();
    let end =
      content.end === undefined
        ? content.timezone === undefined
          ? undefined
          : (before.end?.dateTime ?? before.end?.date)
        : before.end?.date || content.all_day === true
          ? String(content.end)
          : new Date(instantOf(content.end, 'end')).toISOString();
    const allDay =
      content.all_day === undefined ? before.start?.date !== undefined : flagOf(content.all_day, 'all_day');
    if (
      content.all_day !== undefined &&
      allDay !== (before.start?.date !== undefined) &&
      (content.start === undefined || content.end === undefined)
    )
      throw invalidArgs('Changing all_day needs both start and end in their new form.');
    if (allDay) {
      if (start !== undefined) dateOf(start, 'start');
      if (end !== undefined && content.end !== undefined)
        end = new Date(dateOf(end, 'end') + DAY).toISOString().slice(0, 10);
    }
    const from = start ?? before.start?.dateTime ?? before.start?.date;
    const to = end ?? before.end?.dateTime ?? before.end?.date;
    if (!from || !to || Date.parse(to) <= Date.parse(from)) throw invalidArgs('end must come after start');
    const title = content.title === undefined ? undefined : lineOf(content.title, 'title', TITLE_MAX);
    const notes = content.notes === '' ? '' : notesOf(content.notes, NOTES_MAX);
    const location = content.location === '' ? '' : lineOf(content.location, 'location', LOCATION_MAX);
    if (content.reminders !== undefined && content.reminders !== 'default' && content.reminders !== 'none')
      throw invalidArgs('reminders must be default or none');
    const recurrence =
      Array.isArray(content.recurrence) && content.recurrence.length === 0 ? [] : recurrenceOf(content.recurrence);
    return {
      ...(title === undefined ? {} : { summary: title }),
      ...(notes === undefined ? {} : { description: notes }),
      ...(location === undefined ? {} : { location }),
      ...(start === undefined ? {} : { start }),
      ...(end === undefined ? {} : { end }),
      ...(start === undefined && end === undefined ? {} : { allDay }),
      ...(content.timezone === undefined ? {} : { timeZone: timezoneOf(content.timezone) }),
      ...(content.free === undefined ? {} : { transparency: flagOf(content.free, 'free') ? 'transparent' : 'opaque' }),
      ...(content.private === undefined
        ? {}
        : { visibility: flagOf(content.private, 'private') ? 'private' : 'default' }),
      ...(recurrence === undefined ? {} : { recurrence }),
      ...(content.reminders === undefined ? {} : { reminders: content.reminders as 'default' | 'none' }),
      ...(content.video_call === true ? { conference: { requestId: eventIdFor('meet', String(content.event)) } } : {}),
      tags: {
        ...before.tags,
        ...linkedTags(content),
        [WEEK_TAGS.assistantWritten]: 'true',
        ...(typeof content.kind === 'string' ? { [WEEK_TAGS.meetingKind]: content.kind } : {}),
      },
    };
  }
  function appliedPatch(detail: DetailedEvent, patch: EventWrite): boolean {
    return Object.entries(patch).every(([key, value]) => {
      if (key === 'start' || key === 'end')
        return (
          detail[key]?.date === value ||
          (detail[key]?.dateTime !== undefined && Date.parse(detail[key].dateTime) === Date.parse(String(value)))
        );
      if (key === 'allDay') return (detail.start?.date !== undefined) === value;
      if (key === 'timeZone') return detail.start?.timeZone === value && detail.end?.timeZone === value;
      if (key === 'tags') return Object.entries(patch.tags ?? {}).every(([tag, field]) => detail.tags?.[tag] === field);
      if (key === 'attendees')
        return (
          detail.attendees?.length === patch.attendees?.length &&
          (patch.attendees ?? []).every((guest) =>
            detail.attendees?.some(
              (a) =>
                a.email === guest.email &&
                (guest.responseStatus === undefined || a.responseStatus === guest.responseStatus),
            ),
          )
        );
      if (key === 'conference') return detail.conference !== undefined;
      return isDeepStrictEqual(detail[key as keyof DetailedEvent], value);
    });
  }
  async function affect(
    before: DetailedEvent,
    calendarId: string,
    owner: CalendarOwner,
    timeline: Timeline,
  ): Promise<string> {
    const start = before.start?.date
      ? boundary(before.start.date, zoneForDay(timeline, before.start.date) ?? 'UTC', 'start')
      : instantOf(before.start?.dateTime, 'event start');
    const end = before.end?.date
      ? boundary(before.end.date, zoneForDay(timeline, before.end.date) ?? 'UTC', 'start')
      : instantOf(before.end?.dateTime, 'event end');
    const week = await loadCalendarWeek(calendar(), {
      start,
      end,
      timeline,
      shaping: true,
      eventSnapshot: [],
      additionalEvents: [{ calendarId, event: before, owner }],
      replaceEvent: { calendarId, eventId: before.id ?? '' },
    });
    const event = week.events.find((e) => e.id === before.id && e.calendarId === calendarId);
    if (!event) throw new Error('The event being changed has no week facts');
    return affectedPeople(event, week);
  }
  const writeChange =
    (cancel: boolean): ActionAnswer =>
    async (content, session, requestId) => {
      const calendarId = calendarIdOf(content.calendar);
      const eventId = eventIdOf(content.event);
      const sendUpdates = sendUpdatesOf(content.send_updates);
      const timeline = await loadTimeline();
      const { owner, principal, entry } = await writableCalendarOf(calendarId);
      let receipt = await getCalendarWrite(requestId);
      if (receipt?.state === 'applied') {
        await beginCalendarWrite({ ...receipt, request: content });
        return finishWrite(receipt, receipt.outcome ?? (cancel ? 'Cancelled.' : 'Changed.'));
      }
      const fresh = receipt?.plan?.split ? undefined : await calendar().getEventDetail(calendarId, eventId);
      const before = receipt?.before ?? fresh;
      if (!before || before.status === 'cancelled') throw forbidden('That event is no longer on this calendar.');
      const affected = await affect(before, calendarId, owner, timeline);
      const matterId = await requestedMatter(content.matter, session);
      let patch = receipt?.plan?.patch ?? (cancel ? {} : patchOf(content, before));
      if (matterId && !cancel) patch = { ...patch, tags: { ...patch.tags, [WEEK_TAGS.matter]: matterId } };
      const askedGuests = addressesOf(content.guests, 'guests', MAX_GUESTS);
      if (askedGuests && receipt?.plan === undefined) {
        const whole = await calendar().getGuests(calendarId, eventId);
        if (!whole || whole.attendeesOmitted) throw forbidden(INCOMPLETE_LIST);
        const guests = guestsOn(calendarId, askedGuests).map((g) => {
          const held = whole.guests.find(
            (held) => typeof held.email === 'string' && held.email.toLowerCase() === g.email.toLowerCase(),
          );
          return held
            ? {
                ...held,
                email: g.email,
                ...(typeof held.responseStatus === 'string' ? { responseStatus: held.responseStatus } : {}),
              }
            : g;
        });
        patch = { ...patch, attendees: guests };
      }
      const guests = patch.attendees?.map((a) => a.email) ?? (before.attendees ?? []).flatMap((a) => a.email ?? []);
      const outside = guests.filter((email) => !principal.has(email) && email !== calendarId);
      if (!cancel)
        await assertInvitationShareable(
          {
            texts: [
              patch.summary ?? before.summary,
              patch.description ?? before.description,
              patch.location ?? before.location,
            ],
            shown: [entry.summary, ...addressesSeen(guests, outside)],
            recipients: outside,
            writer: 'main',
          },
          'The event was not changed',
          'Leave out private details or ask the principal how to proceed.',
        );
      const start = before.start?.dateTime ?? `${before.start?.date}T00:00:00Z`;
      const end = before.end?.dateTime ?? `${before.end?.date}T00:00:00Z`;
      const nextStart = patch.start ? (patch.allDay ? `${patch.start}T00:00:00Z` : patch.start) : start;
      const nextEnd = patch.end ? (patch.allDay ? `${patch.end}T00:00:00Z` : patch.end) : end;
      let split: CalendarSplitPlan | undefined = receipt?.plan?.split;
      if (content.scope !== undefined && content.scope !== 'event' && content.scope !== 'following')
        throw invalidArgs('scope must be event or following');
      if (content.scope === 'following' && !split) {
        if (!before.recurringEventId) throw invalidArgs('following needs an occurrence id, rather than a series id.');
        const master = await calendar().getEventDetail(calendarId, before.recurringEventId);
        if (!master || !master.etag || !master.recurrence?.length)
          throw forbidden('The recurring series could not be read at a version that can be changed.');
        const zone = master.start?.timeZone ?? zoneAt(timeline, Date.parse(start)) ?? 'UTC';
        const nextZone = patch.timeZone ?? zone;
        const recurrence = splitRecurrence(master, before, patch, zone, nextZone, !cancel);
        const followingId = eventIdFor('following', requestId);
        const whole = cancel ? undefined : await calendar().getGuests(calendarId, eventId);
        if (!cancel && (!whole || whole.attendeesOmitted || whole.etag !== before.etag))
          throw forbidden(
            'The event’s complete guest list at this version could not be read for the series split. Nothing was written.',
          );
        const baseGuests = (whole?.guests ?? []).map((guest) => {
          if (typeof guest.email !== 'string')
            throw forbidden('A guest could not be preserved in the series split. Nothing was written.');
          return { ...guest, email: guest.email };
        });
        split = {
          masterId: before.recurringEventId,
          master,
          trim: recurrence.prior,
          deleteMaster: !recurrence.hasPrior,
          followingId,
          following: cancel
            ? null
            : {
                ...preservedSeriesProperties(before, patch),
                summary: before.summary,
                description: before.description,
                location: before.location,
                attendees: baseGuests,
                ...patch,
                start: patch.start ?? before.start?.dateTime ?? before.start?.date ?? '',
                end: patch.end ?? before.end?.dateTime ?? before.end?.date ?? '',
                allDay: patch.allDay ?? before.start?.date !== undefined,
                timeZone: nextZone,
                recurrence: recurrence.following,
              },
        };
      }
      const plan = receipt?.plan ?? { patch, ...(split ? { split } : {}) };
      patch = plan.patch;
      const splitStartedAt = split
        ? await withExistingMailboxSession(
            session.agent_group_id,
            session.id,
            (mailbox) => mailbox.getOutboundMessage(requestId)?.timestamp,
          )
        : undefined;
      receipt = await beginCalendarWrite(
        {
          requestId,
          calendarId,
          eventId,
          action: cancel ? 'cancel_event' : 'change_event',
          request: content,
          before,
          plan,
          refreshScope: split || before.recurrence?.length || patch.recurrence?.length ? 'series' : 'event',
          affectedStart: new Date(Math.min(Date.parse(start), Date.parse(nextStart))).toISOString(),
          affectedEnd: new Date(Math.max(Date.parse(end), Date.parse(nextEnd))).toISOString(),
        },
        split ? session.id : undefined,
        splitStartedAt,
      );
      if (!before.etag)
        throw forbidden('Google did not supply this event’s version; read it again before changing it.');
      const splitOutcome = split
        ? cancel
          ? 'Cancelled this occurrence and all following occurrences.'
          : `Changed this occurrence and all following occurrences; the following series is event ${split.followingId}. Google resets separate future occurrence exceptions when a series is split.`
        : undefined;
      let outcome: string;
      let wrote = false;
      const principalIsGuest = Boolean(
        before.organizer?.email && !principal.has(before.organizer.email) && owner === 'principal',
      );
      const permissionRefusal = principalIsGuest
        ? 'Google refused the change. The principal is a guest; the organizer controls this event.'
        : 'Google refused permission to change this event.';
      try {
        if (split) {
          const currentMaster = await calendar().getEventDetail(calendarId, split.masterId);
          const alreadyTrimmed = split.deleteMaster
            ? currentMaster === undefined || currentMaster.status === 'cancelled'
            : isDeepStrictEqual(currentMaster?.recurrence, split.trim);
          if (alreadyTrimmed && !sameTrimmedMaster(currentMaster, split))
            throw forbidden(
              'The original series changed while the split was interrupted; its following series was not written over that edit.',
            );
          if (split.deleteMaster) {
            if (currentMaster && currentMaster.status !== 'cancelled')
              await calendar().deleteEvent(calendarId, split.masterId, sendUpdates, split.master.etag);
          } else if (JSON.stringify(currentMaster?.recurrence) !== JSON.stringify(split.trim)) {
            await calendar().patchEvent(
              calendarId,
              split.masterId,
              { recurrence: split.trim },
              sendUpdates,
              split.master.etag,
            );
          }
          await markCalendarSplitMasterChanged(requestId);
          recordSplitOwnChange(requestId, owner, calendarId, split.masterId);
          if (split.following) {
            const existingFollowing = await calendar().getEventDetail(calendarId, split.followingId);
            if (
              existingFollowing &&
              (existingFollowing.status === 'cancelled' || !appliedPatch(existingFollowing, split.following))
            )
              throw forbidden(
                'The following series changed while this split was interrupted; it was not overwritten or restored.',
              );
            if (!existingFollowing)
              await calendar().insertEvent(calendarId, split.followingId, split.following, sendUpdates);
            recordSplitOwnChange(requestId, owner, calendarId, split.followingId);
          }
          wrote = true;
        } else if (cancel) {
          wrote = (await calendar().deleteEvent(calendarId, eventId, sendUpdates, before.etag)) === 'deleted';
        } else if (!fresh || !appliedPatch(fresh, patch)) {
          await calendar().patchEvent(calendarId, eventId, patch, sendUpdates, before.etag);
          wrote = true;
        }
        if (splitOutcome !== undefined) outcome = splitOutcome;
        else if (cancel && principalIsGuest)
          outcome =
            'Removed the event from the principal’s copy. respond_to_event declines it and tells the organizer.';
        else if (cancel) outcome = 'Cancelled the event.';
        else if (wrote) outcome = 'Changed the event.';
        else outcome = 'Nothing changed: the event already has those values.';
      } catch (error) {
        if (split) {
          const [masterNow, followingNow] = await Promise.all([
            calendar().getEventDetail(calendarId, split.masterId),
            split.following ? calendar().getEventDetail(calendarId, split.followingId) : undefined,
          ]);
          const trimmed = split.deleteMaster
            ? !masterNow || masterNow.status === 'cancelled'
            : JSON.stringify(masterNow?.recurrence) === JSON.stringify(split.trim);
          if (trimmed) {
            await markCalendarSplitMasterChanged(requestId);
            recordSplitOwnChange(requestId, owner, calendarId, split.masterId);
          }
          if (
            trimmed &&
            (!split.following ||
              (followingNow && followingNow.status !== 'cancelled' && appliedPatch(followingNow, split.following)))
          ) {
            outcome = splitOutcome ?? 'The recurring event changed.';
            wrote = true;
            if (split.following) recordSplitOwnChange(requestId, owner, calendarId, split.followingId);
          } else if (error instanceof GoogleApiError && error.status === 403 && masterNow?.etag === split.master.etag) {
            const message = boundedCalendarMessage(affected, [permissionRefusal]);
            await markCalendarWriteApplied(requestId, message);
            return {
              message,
            };
          } else throw error;
        } else {
          const now = await calendar().getEventDetail(calendarId, eventId);
          if (
            cancel ? now === undefined || now.status === 'cancelled' : now !== undefined && appliedPatch(now, patch)
          ) {
            outcome = cancel ? 'Cancelled the event.' : 'Changed the event.';
            wrote = true;
          } else if (error instanceof GoogleApiError && (error.status === 403 || error.status === 412))
            return {
              message: boundedCalendarMessage(affected, [
                error.status === 403
                  ? permissionRefusal
                  : 'The event changed after it was read. Nothing was overwritten; read it again before deciding.',
              ]),
            };
          else throw error;
        }
      }
      if (wrote) {
        if (split) recordSplitOwnChange(requestId, owner, calendarId, eventId);
        else recordOwnChange(owner, calendarId, eventId);
      }
      const told =
        wrote && sendUpdates === 'all' && outside.length
          ? `Google notified these guests: ${outside.map((email) => calendarText(email)).join(' ')}.`
          : 'Google notified no guests.';
      const joined = matterId
        ? await joinRequestedMatter(matterId, {
            kind: 'event',
            reference: `${calendarId}/${split?.following ? split.followingId : eventId}`,
          })
        : undefined;
      const message = boundedCalendarMessage(affected, [outcome, told, ...(joined ? [joined] : [])]);
      await markCalendarWriteApplied(requestId, message);
      return finishWrite(receipt, message, timeline);
    };
  function interruptedSplitMessage(recovery: CalendarSplitRecovery, receipt: CalendarWrite, reason: string): string {
    const split = receipt.plan?.split;
    return [
      recovery.masterChanged
        ? 'The recurring series was only partly changed: its original series was shortened, but the following part could not be confirmed.'
        : 'The recurring-series change could not be confirmed.',
      reason,
      'It will not be retried automatically. Do not repeat the request; read the original and following series and reconcile future occurrences before making another change.',
      ...(split
        ? [
            `Original event ${calendarText(split.masterId)}; following event ${calendarText(split.followingId)} on ${calendarText(receipt.calendarId)}.`,
          ]
        : []),
    ].join(' ');
  }

  function boundChange(raw: ActionAnswer): DeferredActionAnswer {
    return async (content, session, requestId) => {
      if (activeCalendarChanges.has(requestId)) return ANSWER_LATER;
      activeCalendarChanges.add(requestId);
      try {
        return await inCalendarChangeTurn(async () => {
          const existing = await getCalendarSplitRecovery(requestId);
          if (existing?.sessionId !== undefined && existing.sessionId !== session.id)
            throw invalidArgs('This recurring-series request belongs to a different session.');
          if (existing) {
            const receipt = await getCalendarWrite(requestId);
            if (!receipt) throw new Error('The deferred calendar split has no write receipt');
            try {
              await beginCalendarWrite({ ...receipt, request: content });
            } catch (error) {
              if (!(error instanceof ActionRefusal) || error.code !== 'invalid-args') throw error;
              log.warn('Rejected a recurring-series retry with a different request under the same id', {
                requestId,
                sessionId: session.id,
              });
              return ANSWER_LATER;
            }
          }
          if (existing?.terminalError) throw forbidden(existing.terminalError);
          if (existing && Date.parse(existing.nextAttemptAt) > Date.now()) return ANSWER_LATER;
          try {
            const serving = await servingCalendarSession(session.id, session.agent_group_id);
            if (!serving)
              throw forbidden(
                'The calling session no longer has calendar authority, so no further calendar write was made.',
              );
            return await raw(content, serving, requestId);
          } catch (error) {
            const recovery = await getCalendarSplitRecovery(requestId);
            const receipt = recovery ? await getCalendarWrite(requestId) : undefined;
            if (!recovery || !receipt?.plan?.split || receipt.state === 'applied') throw error;
            const attempts = recovery.attempts + 1;
            const permanent =
              error instanceof GoogleApiError &&
              !error.retryable &&
              !(
                error.status === 403 &&
                ['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded', 'dailyLimitExceeded'].includes(
                  error.reason ?? '',
                )
              );
            if (error instanceof ActionRefusal || permanent || attempts >= MAX_SPLIT_ATTEMPTS) {
              const reason =
                error instanceof ActionRefusal
                  ? error.message
                  : permanent
                    ? 'Google refused the remaining write.'
                    : 'The calendar stayed unavailable through the bounded recovery attempts.';
              const message = interruptedSplitMessage(recovery, receipt, reason);
              await failCalendarSplitRecovery(requestId, message, attempts);
              throw forbidden(message);
            }
            await deferCalendarSplitRecovery(requestId, attempts);
            log.warn('Recurring-series split awaits recovery', { requestId, sessionId: session.id, attempts, error });
            return ANSWER_LATER;
          }
        });
      } finally {
        activeCalendarChanges.delete(requestId);
      }
    };
  }
  const changeEvent = boundChange(writeChange(false));
  const cancelEvent = boundChange(writeChange(true));

  async function servingCalendarSession(sessionId: string, expectedGroupId?: string): Promise<Session | undefined> {
    const current = await getSession(sessionId);
    if (
      !current ||
      current.status !== 'active' ||
      (expectedGroupId !== undefined && current.agent_group_id !== expectedGroupId)
    )
      return undefined;
    if (current.agent_group_id !== (await getMainAgentGroupId())) return undefined;
    return (await getGroupCapabilities(current.agent_group_id)).has(AGENT_GOOGLE_SERVICES.calendar.capability)
      ? current
      : undefined;
  }

  async function reportRecoveredSplit(recovery: CalendarSplitRecovery, receipt: CalendarWrite, session?: Session) {
    const answered = session
      ? await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
          mailbox
            .getInboundRecords({ since: recovery.createdAt })
            .find((message) => message.id === `action-resp-${recovery.requestId}`),
        )
      : undefined;
    if (!answered && session?.status === 'active') {
      const frame: ResponseFrame = recovery.terminalError
        ? { id: recovery.requestId, ok: false, error: { code: 'forbidden', message: recovery.terminalError } }
        : {
            id: recovery.requestId,
            ok: true,
            data: await finishWrite(receipt, receipt.outcome ?? 'The recurring series changed.'),
          };
      await writeActionResponse(session, recovery.requestId, frame);
      clearOutbox(session.agent_group_id, session.id, recovery.requestId);
    }
    const late =
      Date.parse(answered?.timestamp ?? new Date().toISOString()) - Date.parse(recovery.createdAt) >= TOOL_WAIT_MS;
    if (!session || session.status !== 'active' || late) {
      const result = await writeNoteForMain({
        id: `calendar-split-${eventIdFor('report', recovery.requestId)}`,
        timestamp: new Date().toISOString(),
        text: `Calendar request ${calendarText(recovery.requestId)}: ${receipt.outcome ?? 'The interrupted recurring-series change needs a calendar read to establish its outcome.'}`,
        wake: true,
        noteKind: 'host-receipt',
        pieces: [
          { kind: 'event', reference: `${receipt.calendarId}/${receipt.plan?.split?.masterId ?? receipt.eventId}` },
        ],
      });
      if (result === 'no-main' || result === 'no-principal') {
        await deferCalendarSplitReport(recovery.requestId);
        return;
      }
    }
    await markCalendarSplitReported(recovery.requestId);
    splitOwnChanges.delete(recovery.requestId);
  }

  /* eslint-disable no-catch-all/no-catch-all -- each durable split is retried independently; one read failure never stops the other recoveries */
  async function resumePending(): Promise<void> {
    for (const recovery of await pendingCalendarSplitRecoveries()) {
      if (activeCalendarChanges.has(recovery.requestId)) continue;
      try {
        let receipt = await getCalendarWrite(recovery.requestId);
        if (!receipt) throw new Error('The deferred calendar split has no write receipt');
        const candidate = await servingCalendarSession(recovery.sessionId);
        if (receipt.state === 'pending') {
          if (!candidate) {
            await failCalendarSplitRecovery(
              recovery.requestId,
              interruptedSplitMessage(
                recovery,
                receipt,
                'The calling session no longer has calendar authority, so no further calendar write was made.',
              ),
            );
          } else {
            const answer = receipt.action === 'cancel_event' ? cancelEvent : changeEvent;
            try {
              if ((await answer({ ...receipt.request }, candidate, recovery.requestId)) === ANSWER_LATER) continue;
            } catch (error) {
              const stopped = await getCalendarSplitRecovery(recovery.requestId);
              if (!stopped?.terminalError) throw error;
            }
          }
          receipt = await getCalendarWrite(recovery.requestId);
          if (!receipt || receipt.state !== 'applied') continue;
        }
        const current = await getCalendarSplitRecovery(recovery.requestId);
        if (!current) throw new Error('The deferred calendar split lost its recovery record');
        await reportRecoveredSplit(current, receipt, await servingCalendarSession(recovery.sessionId));
      } catch (error) {
        log.warn('Recurring-series recovery could not finish this sweep', { requestId: recovery.requestId, error });
      }
    }
  }
  /* eslint-enable no-catch-all/no-catch-all */

  return { createEvent, changeGuests, respondToEvent, changeEvent, cancelEvent, resumePending };
}
