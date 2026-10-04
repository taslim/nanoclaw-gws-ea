/**
 * find_conflicts and people_stats: exact calendar facts, counted from gog's
 * own output.
 *
 * A model that copies events out of a calendar listing drops some, misreads
 * times, and cannot be checked. These tools read the JSON that
 * `gog calendar events ... --all-pages` saved to a file and do the counting:
 *
 * - find_conflicts lists every event on the principal's calendars that
 *   overlaps a candidate time. Unlike `gog calendar conflicts`, which compares
 *   calendars with each other, it also finds an overlap on one calendar. The
 *   candidate's own copies (by `iCalUID`), cancelled events, events the
 *   principal declined, and free (transparent) events do not count; all-day
 *   busy events and free/busy-only blocks do. Times are compared as instants,
 *   and an all-day event runs from midnight to midnight on the principal's
 *   clocks, so a day with a clock change is 23 or 25 hours long. A hold the
 *   assistant placed for a meeting it is arranging is listed apart, as time
 *   that can give way. The answer is only as good as the files, so the call
 *   names the range they were fetched for, and a candidate outside it or a
 *   file saved more than fifteen minutes ago is refused.
 * - people_stats counts, for each person, the meetings the principal organized
 *   or accepted with them. A stranger's unanswered or declined invitations
 *   never build a record. The principal, the assistant, rooms, and meetings of
 *   more than eight people are left out, and a meeting that sits on several of
 *   the principal's calendars counts once.
 *
 * Both read files only inside the agent's workspace or the container's temp
 * directory, refuse a file that is not complete gog events output, and name
 * the file they refuse. schedule_stats reads its files through the same
 * reader. Names and titles come back capped and wrapped as untrusted text, the
 * way gog marks them, because other people wrote them.
 */
import { randomBytes } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { DateTime } from 'luxon';

import { TIMEZONE, isValidTimezone } from '../timezone.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

type ValidDateTime = DateTime<true>;

/**
 * The key that grants find_conflicts and people_stats. Named here, not left
 * to the barrel's load, because schedule-stats imports this module for its
 * reader and so may load it first.
 */
const CALENDAR_FACTS_CAPABILITY = 'calendar-facts';

export const WORKSPACE_DIR = '/workspace/agent';
/** Where the calendar tools read saved gog output: the agent's workspace and the container's temp directory. */
export const FILE_ROOTS: readonly string[] = [WORKSPACE_DIR, os.tmpdir()];
export const MAX_FILES = 10;
export const MAX_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_EVENTS = 20_000;
export const MAX_WINDOW_DAYS = 14;
/** A conflict check reads only events fetched this recently: one turn of fetching and checking. */
export const MAX_FILE_AGE_MINUTES = 15;
/** A meeting with more people than this says little about any one of them. */
export const MAX_MEETING_SIZE = 8;
export const MAX_LISTED_CONFLICTS = 50;
export const MAX_LISTED_PEOPLE = 100;
export const MAX_NAME_CHARS = 64;
export const MAX_TITLE_CHARS = 100;
const MAX_LISTED_PROBLEMS = 5;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/i;
const DATE_TIME_SHAPE = 'a date-time with its UTC offset, such as 2026-10-06T10:00:00+01:00';
const EMAIL = /^[^\s@]+@[^\s@]+$/;
const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);
const GOG_EVENTS_COMMAND =
  'gog calendar events --calendars <calendarId>,<calendarId> --from <start> --to <end> --all-pages';

/** How gog wraps text other people wrote (internal/outfmt/untrusted.go). */
const UNTRUSTED_SOURCE = 'google_api';
const GOG_WRAPPED =
  /^<<<EXTERNAL_UNTRUSTED_CONTENT id="([0-9a-f]+)">>>\nSource: [^\n]*\n---\n([\s\S]*)\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="\1">>>$/;
const UNTRUSTED_MARKER = /<<<\s*(?:END[\s_]+)?EXTERNAL[\s_]+UNTRUSTED[\s_]+CONTENT(?:\s+[^>]*)?\s*>>>/gi;
/** The host keeps its own list in `src/modules/gws-ea-inbox/untrusted.ts`; keep the two in step. */
const SPECIAL_TOKENS = [
  '<|im_start|>',
  '<|im_end|>',
  '<|endoftext|>',
  '<|begin_of_text|>',
  '<|end_of_text|>',
  '<|start_header_id|>',
  '<|end_header_id|>',
  '<|eot_id|>',
  '<|python_tag|>',
  '<|eom_id|>',
  '[INST]',
  '[/INST]',
  '<<SYS>>',
  '<</SYS>>',
  '<|channel|>',
  '<|message|>',
  '<|return|>',
  '<|call|>',
  '<start_of_turn>',
  '<end_of_turn>',
];
const RESERVED_SPECIAL_TOKEN = /<\|reserved_special_token_\d+\|>/g;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

/**
 * The private marks the assistant puts on the events it places. A private
 * property belongs to one calendar's copy of an event, so only someone who can
 * write that calendar sets it: an invitation's organizer cannot. The host
 * writes them in `src/modules/gws-ea-meetings/calendar-actions.ts`; keep the
 * two in step.
 */
const TAG_MEETING = 'gwsEaMeeting';
const TAG_ROLE = 'gwsEaRole';

/** The principal's own answer to an invitation; a stronger answer wins across copies. */
const RESPONSE_RANK: Record<string, number> = { accepted: 3, tentative: 2, needsAction: 1, declined: 0 };

export interface Conflict {
  /** Every principal calendar the counted copies sit on; empty when the file named none. */
  calendars: string[];
  event_id: string | null;
  ical_uid: string | null;
  /** Wrapped as untrusted; null for a free/busy-only block. */
  title: string | null;
  start: string;
  end: string;
  all_day: boolean;
  overlap_minutes: number;
  principal_response: string | null;
  organizer: string | null;
}

/** Time the assistant holds for a meeting it is arranging: it can give way. */
export interface HeldTime {
  /** The meeting the time is held for, such as mtg-…. */
  meeting_id: string;
  /** Every principal calendar the hold sits on; empty when the file named none. */
  calendars: string[];
  event_id: string | null;
  start: string;
  end: string;
  overlap_minutes: number;
}

export interface FindConflictsResult {
  timezone: string;
  window: { start: string; end: string };
  /** Earliest first. */
  conflicts: Conflict[];
  conflicts_not_listed: number;
  /** Earliest first. */
  holds: HeldTime[];
  holds_not_listed: number;
  /** Every event copy read is in exactly one of the other counts. */
  events: {
    received: number;
    candidate_copies: number;
    cancelled: number;
    declined: number;
    free: number;
    outside_window: number;
    conflicting: number;
    holds: number;
  };
}

export interface PersonStats {
  /** NanoClaw's handle for the person, as the people store takes it. */
  identity: string;
  /** Wrapped as untrusted; null when no counted meeting carried one. */
  display_name: string | null;
  meetings: number;
  /** Meetings with the principal and this person alone; the assistant does not count. */
  one_on_ones: number;
  recurring_series: number;
  /** Local dates, YYYY-MM-DD. */
  first_meeting: string | null;
  last_meeting: string | null;
}

export interface PeopleStatsResult {
  timezone: string;
  /** Most meetings first. */
  people: PersonStats[];
  people_not_listed: number;
  /** Every event copy read is in exactly one of the other counts. */
  events: {
    received: number;
    counted: number;
    duplicate_copies: number;
    cancelled: number;
    not_organized_or_accepted: number;
    more_than_eight: number;
    attendees_omitted: number;
  };
}

export interface CalendarFactsOptions {
  /** The only directories files are read from. Relative paths resolve against the first. */
  allowedRoots: readonly string[];
  /** The principal's timezone, used when a call names none. */
  defaultTimezone: string;
}

/** A problem with the tool input, returned to the agent as an error result. */
class CalendarFactsError extends Error {}

export function fail(message: string): never {
  throw new CalendarFactsError(message);
}

/** A problem with one event, collected so a refusal can name several. */
class EventProblem extends Error {}

function problem(message: string): never {
  throw new EventProblem(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

// ---- Identities -------------------------------------------------------------

function normalizeEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  return EMAIL.test(email) ? email : null;
}

/**
 * Every spelling that reaches the same mailbox: lowercased, without a `+tag`,
 * and without the dots Gmail ignores. The people store keys identities the
 * same way. Used only to recognise the principal and the assistant, so a
 * variant spelling can never give either of them a record.
 *
 * The host holds the same rule as `identityMatchKey` in
 * `src/gws-ea/validation.ts`; change both together.
 */
function mailboxKey(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return email;
  let local = email.slice(0, at);
  let domain = email.slice(at + 1);
  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);
  if (GMAIL_DOMAINS.has(domain)) {
    const undotted = local.replaceAll('.', '');
    if (undotted) local = undotted;
    domain = 'gmail.com';
  }
  return `${local}@${domain}`;
}

export class Mailboxes {
  private readonly keys: ReadonlySet<string>;

  constructor(emails: readonly string[]) {
    this.keys = new Set(emails.map(mailboxKey));
  }

  has(email: string | null): boolean {
    return email !== null && this.keys.has(mailboxKey(email));
  }
}

// ---- Untrusted text ---------------------------------------------------------

function sanitizeUntrusted(text: string): string {
  let clean = text.replace(UNTRUSTED_MARKER, (marker) =>
    /^<<<\s*END/i.test(marker) ? '[[END_MARKER_SANITIZED]]' : '[[MARKER_SANITIZED]]',
  );
  for (const token of SPECIAL_TOKENS) clean = clean.split(token).join('[REMOVED_SPECIAL_TOKEN]');
  return clean.replace(RESERVED_SPECIAL_TOKEN, '[REMOVED_SPECIAL_TOKEN]');
}

/**
 * Text another person wrote, as one capped line wrapped in gog's untrusted
 * markers under a fresh random id. gog's own wrapping is taken off first, so
 * the text is wrapped once; a file gog wrote without wrapping is sanitized the
 * same way gog would have.
 */
function untrustedText(raw: string | null, limit: number): string | null {
  if (raw === null) return null;
  const unwrapped = GOG_WRAPPED.exec(raw)?.[2] ?? raw;
  const line = sanitizeUntrusted(unwrapped.replace(CONTROL_CHARACTERS, ' ').replace(/\s+/g, ' ').trim());
  if (line === '') return null;
  const characters = Array.from(line);
  const kept = characters
    .slice(0, limit - 1)
    .join('')
    .trimEnd();
  const capped = characters.length <= limit ? line : `${kept}…`;
  const id = randomBytes(8).toString('hex');
  return `<<<EXTERNAL_UNTRUSTED_CONTENT id="${id}">>>\nSource: ${UNTRUSTED_SOURCE}\n---\n${capped}\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="${id}">>>`;
}

// ---- Reading gog's output ---------------------------------------------------

interface Party {
  email: string | null;
  displayName: string | null;
  /** The entry for the calendar this copy sits on. */
  self: boolean;
  resource: boolean;
  responseStatus: string | null;
}

export interface CalendarEvent {
  calendarId: string | null;
  id: string | null;
  iCalUID: string | null;
  status: string | null;
  summary: string | null;
  transparent: boolean;
  allDay: boolean;
  /** On the principal's clocks. */
  start: ValidDateTime;
  end: ValidDateTime;
  attendees: Party[];
  attendeesOmitted: boolean;
  organizer: { email: string | null; self: boolean } | null;
  recurringEventId: string | null;
  /** The meeting this copy holds time for, when it is a hold the assistant placed; null for any other event. */
  heldFor: string | null;
  /** The same on every copy of one meeting, whichever calendar it sits on. */
  meetingKey: string;
}

type EventTime = { kind: 'date'; date: string } | { kind: 'date_time'; at: ValidDateTime };

function optionalString(record: Record<string, unknown>, key: string, label: string): string | null {
  const value = record[key];
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') problem(`${label}.${key} must be text.`);
  return value;
}

function optionalBoolean(record: Record<string, unknown>, key: string, label: string): boolean {
  const value = record[key];
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') problem(`${label}.${key} must be true or false.`);
  return value;
}

function readEventTime(value: unknown, label: string): EventTime {
  const shape = `${label} must have a dateTime with its UTC offset, such as 2026-10-06T10:00:00+01:00, or a date`;
  if (!isRecord(value)) problem(`${shape}.`);
  const dateTime = optionalString(value, 'dateTime', label);
  if (dateTime !== null) {
    const text = dateTime.trim().toUpperCase();
    const at = DateTime.fromISO(text, { setZone: true });
    if (!DATE_TIME_WITH_OFFSET.test(text) || !at.isValid) problem(`${shape}.`);
    return { kind: 'date_time', at };
  }
  const date = optionalString(value, 'date', label);
  if (date !== null && ISO_DATE.test(date.trim()) && DateTime.fromISO(date.trim(), { zone: 'utc' }).isValid) {
    return { kind: 'date', date: date.trim() };
  }
  problem(`${shape}.`);
}

function onClocks(time: EventTime, zone: string, label: string): ValidDateTime {
  const local =
    time.kind === 'date_time' ? time.at.setZone(zone) : DateTime.fromISO(time.date, { zone }).startOf('day');
  if (!local.isValid) problem(`${label} is out of range.`);
  return local;
}

function timeKey(time: EventTime): string {
  return time.kind === 'date' ? time.date : String(time.at.toMillis());
}

function readParty(value: unknown, label: string): Party {
  if (!isRecord(value)) problem(`${label} must be an object.`);
  const email = optionalString(value, 'email', label);
  return {
    email: email === null ? null : normalizeEmail(email),
    displayName: optionalString(value, 'displayName', label),
    self: optionalBoolean(value, 'self', label),
    resource: optionalBoolean(value, 'resource', label),
    responseStatus: optionalString(value, 'responseStatus', label),
  };
}

/**
 * The meeting a copy holds time for, read from the assistant's private marks
 * on it. Both marks make a hold; anything else, a booking included, is a real
 * event.
 */
function readHeldFor(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) problem(`${label} must be an object.`);
  const marks = value.private;
  if (marks === undefined || marks === null) return null;
  if (!isRecord(marks)) problem(`${label}.private must be an object.`);
  const role = optionalString(marks, TAG_ROLE, `${label}.private`);
  const meeting = optionalString(marks, TAG_MEETING, `${label}.private`);
  return role === 'hold' ? meeting : null;
}

function parseEvent(value: unknown, label: string, fallbackKey: string, zone: string): CalendarEvent {
  if (!isRecord(value)) problem(`${label} must be an object.`);
  const start = readEventTime(value.start, `${label}.start`);
  const end = readEventTime(value.end, `${label}.end`);
  if (start.kind !== end.kind) problem(`${label} mixes a date and a date-time; an all-day event gives both as dates.`);
  const localStart = onClocks(start, zone, `${label}.start`);
  const localEnd = onClocks(end, zone, `${label}.end`);
  if (localEnd.toMillis() < localStart.toMillis()) problem(`${label} ends before it starts.`);

  const rawAttendees = value.attendees;
  if (rawAttendees !== undefined && rawAttendees !== null && !Array.isArray(rawAttendees)) {
    problem(`${label}.attendees must be a list.`);
  }
  const attendeeItems: unknown[] = Array.isArray(rawAttendees) ? rawAttendees : [];
  const attendees = attendeeItems.map((item, index) => readParty(item, `${label}.attendees[${index}]`));

  const rawOrganizer = value.organizer;
  let organizer: CalendarEvent['organizer'] = null;
  if (rawOrganizer !== undefined && rawOrganizer !== null) {
    const party = readParty(rawOrganizer, `${label}.organizer`);
    organizer = { email: party.email, self: party.self };
  }

  const original =
    value.originalStartTime === undefined || value.originalStartTime === null
      ? null
      : readEventTime(value.originalStartTime, `${label}.originalStartTime`);
  const id = optionalString(value, 'id', label);
  const iCalUID = optionalString(value, 'iCalUID', label);
  return {
    calendarId: optionalString(value, 'CalendarID', label),
    id,
    iCalUID,
    status: optionalString(value, 'status', label),
    summary: optionalString(value, 'summary', label),
    transparent: optionalString(value, 'transparency', label) === 'transparent',
    allDay: start.kind === 'date',
    start: localStart,
    end: localEnd,
    attendees,
    attendeesOmitted: optionalBoolean(value, 'attendeesOmitted', label),
    organizer,
    recurringEventId: optionalString(value, 'recurringEventId', label),
    heldFor: readHeldFor(value.extendedProperties, `${label}.extendedProperties`),
    // An occurrence of a series keeps its original start on every copy, even after it moves.
    meetingKey: `${iCalUID ?? id ?? fallbackKey}|${timeKey(original ?? start)}`,
  };
}

/** gog prints a page token only when the listing stopped early. */
function hasMorePages(output: Record<string, unknown>): boolean {
  const single = output.nextPageToken;
  const multiple = output.nextPageTokens;
  const singleMore = single !== undefined && single !== null && single !== '';
  const multipleMore =
    multiple !== undefined && multiple !== null && !(Array.isArray(multiple) && multiple.length === 0);
  return singleMore || multipleMore;
}

function isWithin(directory: string, target: string): boolean {
  const relative = path.relative(directory, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** A root as the filesystem resolves it; a root that does not exist yet stays as written. */
function realRoot(root: string): string {
  try {
    return fs.realpathSync(root);
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) return path.resolve(root);
    throw error;
  }
}

/** `freshWithinMinutes`, when given, refuses a file saved longer ago than that, by its modification time. */
function readJsonFile(input: string, roots: readonly string[], freshWithinMinutes?: number): unknown {
  const where = `the agent workspace or the temp directory (${roots.join(', ')})`;
  const absolute = path.resolve(roots[0], input);
  if (!roots.some((root) => isWithin(path.resolve(root), absolute))) {
    fail(`Refused ${input}: it is outside ${where}. Save gog's output there.`);
  }
  let real: string;
  try {
    real = fs.realpathSync(absolute);
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) fail(`Refused ${input}: there is no such file.`);
    throw error;
  }
  if (!roots.some((root) => isWithin(realRoot(root), real))) {
    fail(`Refused ${input}: it leads outside ${where}.`);
  }
  const stat = fs.statSync(real);
  if (!stat.isFile()) fail(`Refused ${input}: it is not a file.`);
  if (stat.size > MAX_FILE_BYTES) {
    fail(`Refused ${input}: it is over ${MAX_FILE_BYTES / (1024 * 1024)} MB. Use a shorter window.`);
  }
  if (freshWithinMinutes !== undefined && Date.now() - stat.mtimeMs > freshWithinMinutes * MINUTE_MS) {
    fail(
      `Refused ${input}: it was saved more than ${freshWithinMinutes} minutes ago, and this check reads only events fetched since. Fetch again with gog calendar events, then call again.`,
    );
  }
  try {
    return JSON.parse(fs.readFileSync(real, 'utf8')) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) fail(`Refused ${input}: it is not valid JSON. Save gog's output unchanged.`);
    throw error;
  }
}

function readEventsFile(
  input: string,
  roots: readonly string[],
  zone: string,
  freshWithinMinutes: number | undefined,
): CalendarEvent[] {
  const output = readJsonFile(input, roots, freshWithinMinutes);
  if (!isRecord(output) || !Array.isArray(output.events)) {
    fail(`Refused ${input}: it is not what gog calendar events prints, an object with an "events" list.`);
  }
  if (hasMorePages(output)) {
    fail(`Refused ${input}: it holds only the first page of events. Run gog calendar events again with --all-pages.`);
  }
  const items: unknown[] = output.events;
  const events: CalendarEvent[] = [];
  const problems: string[] = [];
  items.forEach((item, index) => {
    try {
      events.push(parseEvent(item, `events[${index}]`, `${input}#${index}`, zone));
    } catch (error) {
      if (!(error instanceof EventProblem)) throw error;
      problems.push(error.message);
    }
  });
  if (problems.length > 0) {
    const listed = problems.slice(0, MAX_LISTED_PROBLEMS);
    const unlisted = problems.length - listed.length;
    fail(
      [
        `Refused ${input}: ${problems.length} of ${items.length} events are invalid, so nothing was counted.`,
        ...listed,
        ...(unlisted > 0 ? [`${unlisted} more invalid event${unlisted === 1 ? ' is' : 's are'} not listed.`] : []),
      ].join(' '),
    );
  }
  return events;
}

/**
 * Every event in the saved gog output `files` name, on the principal's clocks
 * in `zone`. Refuses, naming the file, anything outside `roots`, anything that
 * is not complete gog events output, and, with `freshWithinMinutes`, a file
 * saved longer ago than that.
 */
export function readEvents(
  files: readonly string[],
  roots: readonly string[],
  zone: string,
  freshWithinMinutes?: number,
): CalendarEvent[] {
  const events: CalendarEvent[] = [];
  for (const file of files) {
    events.push(...readEventsFile(file, roots, zone, freshWithinMinutes));
    if (events.length > MAX_EVENTS) fail(`The files hold more than ${MAX_EVENTS} events. Use a shorter window.`);
  }
  return events;
}

// ---- Arguments --------------------------------------------------------------

export function readFiles(args: Record<string, unknown>): string[] {
  const value: unknown = args.files;
  const shape = `files must list from 1 to ${MAX_FILES} paths to saved gog calendar events output.`;
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_FILES) fail(shape);
  const items: unknown[] = value;
  if (!items.every((item): item is string => typeof item === 'string' && item.trim() !== '')) fail(shape);
  return items.map((item) => item.trim());
}

function readTimezone(args: Record<string, unknown>, fallback: string): string {
  const value = args.timezone;
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string' || !isValidTimezone(value) || !DateTime.fromMillis(0, { zone: value }).isValid) {
    fail(`Invalid timezone "${String(value)}". Use an IANA name like "Africa/Lagos".`);
  }
  return value;
}

function readInstant(args: Record<string, unknown>, key: 'start' | 'end' | 'from' | 'to', zone: string): ValidDateTime {
  const value = args[key];
  if (typeof value !== 'string' || !DATE_TIME_WITH_OFFSET.test(value.trim())) {
    fail(`${key} must be ${DATE_TIME_SHAPE}.`);
  }
  const at = DateTime.fromISO(value.trim().toUpperCase(), { setZone: true }).setZone(zone);
  if (!at.isValid) fail(`${key} must be ${DATE_TIME_SHAPE}.`);
  return at;
}

export function readAddressList(args: Record<string, unknown>, key: string, required: boolean): string[] {
  const value: unknown = args[key];
  if (value === undefined || value === null) {
    if (required) fail(`${key} must list at least one email address.`);
    return [];
  }
  if (!Array.isArray(value)) fail(`${key} must be a list of email addresses.`);
  const items: unknown[] = value;
  const addresses: string[] = [];
  for (const item of items) {
    const email = typeof item === 'string' ? normalizeEmail(item) : null;
    if (email === null) fail(`${key} must be a list of email addresses; "${String(item)}" is not one.`);
    addresses.push(email);
  }
  if (required && addresses.length === 0) fail(`${key} must list at least one email address.`);
  return addresses;
}

function iso(at: ValidDateTime): string {
  return at.toISO({ suppressMilliseconds: true });
}

function json(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

/** The computed value as the tool's answer, or the input problem `fail` raised as an error result. */
export async function answer(compute: () => unknown): Promise<CallToolResult> {
  try {
    return json(compute());
  } catch (error) {
    if (error instanceof CalendarFactsError) {
      return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
    }
    throw error;
  }
}

function strongestResponse(responses: ReadonlyArray<string | null>): string | null {
  let strongest: string | null = null;
  for (const response of responses) {
    if (response === null) continue;
    if (strongest === null || (RESPONSE_RANK[response] ?? -1) > (RESPONSE_RANK[strongest] ?? -1)) strongest = response;
  }
  return strongest;
}

/** The entry that speaks for the principal on this copy: the calendar's own, else the principal's addresses. */
export function isPrincipalParty(party: Party, principal: Mailboxes): boolean {
  return party.self || principal.has(party.email);
}

/**
 * The principal's answer on this copy. The calendar's own entry decides when
 * there is one; otherwise the principal's strongest answer from any address.
 */
export function principalResponse(event: CalendarEvent, principal: Mailboxes): string | null {
  const own = event.attendees.find((party) => party.self);
  if (own) return own.responseStatus;
  return strongestResponse(
    event.attendees.filter((party) => principal.has(party.email)).map((party) => party.responseStatus),
  );
}

export function isRoom(party: Party): boolean {
  return party.resource || (party.email?.endsWith('@resource.calendar.google.com') ?? false);
}

// ---- find_conflicts ---------------------------------------------------------

/** Where a copy lands before an overlap is split into a conflict or a hold. */
type ConflictOutcome = Exclude<keyof FindConflictsResult['events'], 'received' | 'conflicting' | 'holds'> | 'overlaps';

function overlapMs(event: CalendarEvent, start: ValidDateTime, end: ValidDateTime): number {
  return Math.min(event.end.toMillis(), end.toMillis()) - Math.max(event.start.toMillis(), start.toMillis());
}

/** Earliest first, comparing two meetings by one copy of each. */
function earliestFirst(a: CalendarEvent, b: CalendarEvent): number {
  return (
    a.start.toMillis() - b.start.toMillis() ||
    a.end.toMillis() - b.end.toMillis() ||
    a.meetingKey.localeCompare(b.meetingKey)
  );
}

function calendarsOf(copies: readonly CalendarEvent[]): string[] {
  return [...new Set(copies.map((copy) => copy.calendarId).filter((id) => id !== null))].sort();
}

function computeConflicts(input: {
  zone: string;
  start: ValidDateTime;
  end: ValidDateTime;
  candidate: string | null;
  principal: Mailboxes;
  events: readonly CalendarEvent[];
}): FindConflictsResult {
  const counts: FindConflictsResult['events'] = {
    received: input.events.length,
    candidate_copies: 0,
    cancelled: 0,
    declined: 0,
    free: 0,
    outside_window: 0,
    conflicting: 0,
    holds: 0,
  };
  // The copies of each meeting, by meeting; a hold also keeps the meeting it holds time for.
  const conflicting = new Map<string, CalendarEvent[]>();
  const held = new Map<string, { meetingId: string; copies: CalendarEvent[] }>();
  for (const event of input.events) {
    const outcome = classifyConflict(event, input);
    if (outcome !== 'overlaps') {
      counts[outcome]++;
    } else if (event.heldFor === null) {
      counts.conflicting++;
      const copies = conflicting.get(event.meetingKey);
      if (copies) copies.push(event);
      else conflicting.set(event.meetingKey, [event]);
    } else {
      counts.holds++;
      const hold = held.get(event.meetingKey);
      if (hold) hold.copies.push(event);
      else held.set(event.meetingKey, { meetingId: event.heldFor, copies: [event] });
    }
  }

  const overlapMinutes = (event: CalendarEvent): number =>
    Math.round(overlapMs(event, input.start, input.end) / MINUTE_MS);
  const conflicts = [...conflicting.values()]
    .sort(([a], [b]) => earliestFirst(a, b))
    .map((copies): Conflict => {
      const [first] = copies;
      return {
        calendars: calendarsOf(copies),
        event_id: first.id,
        ical_uid: first.iCalUID,
        title: untrustedText(copies.find((copy) => copy.summary !== null)?.summary ?? null, MAX_TITLE_CHARS),
        start: iso(first.start),
        end: iso(first.end),
        all_day: first.allDay,
        overlap_minutes: overlapMinutes(first),
        principal_response: strongestResponse(copies.map((copy) => principalResponse(copy, input.principal))),
        organizer: copies.find((copy) => copy.organizer?.email)?.organizer?.email ?? null,
      };
    });
  const holds = [...held.values()]
    .sort(({ copies: [a] }, { copies: [b] }) => earliestFirst(a, b))
    .map(({ meetingId, copies }): HeldTime => {
      const [first] = copies;
      return {
        meeting_id: meetingId,
        calendars: calendarsOf(copies),
        event_id: first.id,
        start: iso(first.start),
        end: iso(first.end),
        overlap_minutes: overlapMinutes(first),
      };
    });

  return {
    timezone: input.zone,
    window: { start: iso(input.start), end: iso(input.end) },
    conflicts: conflicts.slice(0, MAX_LISTED_CONFLICTS),
    conflicts_not_listed: Math.max(0, conflicts.length - MAX_LISTED_CONFLICTS),
    holds: holds.slice(0, MAX_LISTED_CONFLICTS),
    holds_not_listed: Math.max(0, holds.length - MAX_LISTED_CONFLICTS),
    events: counts,
  };
}

function classifyConflict(
  event: CalendarEvent,
  input: { start: ValidDateTime; end: ValidDateTime; candidate: string | null; principal: Mailboxes },
): ConflictOutcome {
  if (input.candidate !== null && event.iCalUID === input.candidate) return 'candidate_copies';
  if (event.status === 'cancelled') return 'cancelled';
  if (principalResponse(event, input.principal) === 'declined') return 'declined';
  if (event.transparent) return 'free';
  // Touching ends are not an overlap, and a zero-length event blocks no time.
  return overlapMs(event, input.start, input.end) > 0 ? 'overlaps' : 'outside_window';
}

// ---- people_stats -----------------------------------------------------------

type PeopleOutcome = Exclude<keyof PeopleStatsResult['events'], 'received' | 'duplicate_copies'>;

interface PeopleInput {
  zone: string;
  principal: Mailboxes;
  assistant: Mailboxes;
  /** Lowercased addresses to report on; null reports everyone. */
  only: readonly string[] | null;
  events: readonly CalendarEvent[];
}

function classifyForPeople(event: CalendarEvent, principal: Mailboxes): PeopleOutcome {
  if (event.status === 'cancelled') return 'cancelled';
  if (event.attendeesOmitted) return 'attendees_omitted';
  if (event.attendees.filter((party) => !isRoom(party)).length > MAX_MEETING_SIZE) return 'more_than_eight';
  const organized = event.organizer !== null && (event.organizer.self || principal.has(event.organizer.email));
  const accepted = event.attendees.some(
    (party) => isPrincipalParty(party, principal) && party.responseStatus === 'accepted',
  );
  return organized || accepted ? 'counted' : 'not_organized_or_accepted';
}

interface Tally {
  meetings: number;
  oneOnOnes: number;
  series: Set<string>;
  firstMs: number;
  lastMs: number;
  first: string;
  last: string;
  displayName: string | null;
}

function computePeopleStats(input: PeopleInput): PeopleStatsResult {
  const counts: PeopleStatsResult['events'] = {
    received: input.events.length,
    counted: 0,
    duplicate_copies: 0,
    cancelled: 0,
    not_organized_or_accepted: 0,
    more_than_eight: 0,
    attendees_omitted: 0,
  };

  // One meeting per key: the first copy that counts stands for it, else the first copy.
  const meetings = new Map<string, { event: CalendarEvent; outcome: PeopleOutcome }>();
  for (const event of input.events) {
    const outcome = classifyForPeople(event, input.principal);
    const seen = meetings.get(event.meetingKey);
    if (seen === undefined) {
      meetings.set(event.meetingKey, { event, outcome });
      continue;
    }
    counts.duplicate_copies++;
    if (seen.outcome !== 'counted' && outcome === 'counted') meetings.set(event.meetingKey, { event, outcome });
  }

  const counted: CalendarEvent[] = [];
  for (const { event, outcome } of meetings.values()) {
    counts[outcome]++;
    if (outcome === 'counted') counted.push(event);
  }
  counted.sort((a, b) => a.start.toMillis() - b.start.toMillis() || a.meetingKey.localeCompare(b.meetingKey));

  const tallies = new Map<string, Tally>();
  for (const event of counted) {
    const others = new Map<string, Party>();
    for (const party of event.attendees) {
      if (party.email === null || isRoom(party) || isPrincipalParty(party, input.principal)) continue;
      if (input.assistant.has(party.email) || others.has(party.email)) continue;
      others.set(party.email, party);
    }
    const startMs = event.start.toMillis();
    const date = event.start.toISODate();
    for (const [email, party] of others) {
      let tally = tallies.get(email);
      if (tally === undefined) {
        tally = {
          meetings: 0,
          oneOnOnes: 0,
          series: new Set(),
          firstMs: startMs,
          lastMs: startMs,
          first: date,
          last: date,
          displayName: null,
        };
        tallies.set(email, tally);
      }
      tally.meetings++;
      if (others.size === 1) tally.oneOnOnes++;
      if (event.recurringEventId !== null) tally.series.add(event.recurringEventId);
      if (startMs < tally.firstMs) [tally.firstMs, tally.first] = [startMs, date];
      if (startMs >= tally.lastMs) [tally.lastMs, tally.last] = [startMs, date];
      // Meetings run earliest first, so the latest name given wins.
      if (party.displayName !== null) tally.displayName = party.displayName;
    }
  }

  const emails = input.only ?? [...tallies.keys()];
  const people = [...new Set(emails)]
    .map((email): PersonStats => {
      const tally = tallies.get(email);
      return {
        identity: `email:${email}`,
        display_name: untrustedText(tally?.displayName ?? null, MAX_NAME_CHARS),
        meetings: tally?.meetings ?? 0,
        one_on_ones: tally?.oneOnOnes ?? 0,
        recurring_series: tally?.series.size ?? 0,
        first_meeting: tally?.first ?? null,
        last_meeting: tally?.last ?? null,
      };
    })
    .sort((a, b) => b.meetings - a.meetings || a.identity.localeCompare(b.identity));

  return {
    timezone: input.zone,
    people: people.slice(0, MAX_LISTED_PEOPLE),
    people_not_listed: Math.max(0, people.length - MAX_LISTED_PEOPLE),
    events: counts,
  };
}

// ---- Tools ------------------------------------------------------------------

export const FILES_SCHEMA = {
  type: 'array',
  minItems: 1,
  maxItems: MAX_FILES,
  items: { type: 'string' },
  description: `Paths to JSON files saved from \`${GOG_EVENTS_COMMAND}\`, inside /workspace/agent (relative paths start there) or the temp directory. Every file must be complete: pass --all-pages.`,
};
const TIMEZONE_SCHEMA = {
  type: 'string',
  description: 'The principal\'s IANA timezone, such as "Africa/Lagos". Defaults to the principal\'s timezone.',
};

export function createCalendarFactTools(options: CalendarFactsOptions): {
  findConflicts: McpToolDefinition;
  peopleStats: McpToolDefinition;
} {
  if (options.allowedRoots.length === 0) throw new Error('calendar facts need at least one allowed directory');
  const roots = options.allowedRoots.map((root) => path.resolve(root));

  const findConflicts: McpToolDefinition = {
    tool: {
      name: 'find_conflicts',
      description: `List every event on the principal's calendars that overlaps a candidate time, counted from gog calendar events output saved for a range that covers it. It finds overlaps on one calendar as well as across calendars. Left out: the candidate's own copies on any calendar (matched by candidate_ical_uid), cancelled events, events the principal declined, and free (transparent) events. All-day busy events and free/busy-only blocks count. A time the assistant holds for a meeting it is arranging is listed under holds with its meeting_id, as time that can give way, not as a conflict; a meeting the assistant booked is a conflict like any other. A meeting on several of the principal's calendars is listed once with each calendar. Times are compared as instants; an all-day event runs midnight to midnight on the principal's clocks, so clock changes are handled. The window is at most ${MAX_WINDOW_DAYS} days. Titles come back wrapped as untrusted text. Refused, so you fetch again: a candidate outside the from-to range the files were fetched for, and a file saved more than ${MAX_FILE_AGE_MINUTES} minutes ago. A file that is malformed, incomplete, or outside the workspace and temp directory is refused and named.`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          files: FILES_SCHEMA,
          from: {
            type: 'string',
            description: `The start of the range the files were fetched for, as given to gog's --from: ${DATE_TIME_SHAPE}.`,
          },
          to: {
            type: 'string',
            description: `The end of that range, as given to gog's --to: ${DATE_TIME_SHAPE}.`,
          },
          start: { type: 'string', description: `Candidate start: ${DATE_TIME_SHAPE}.` },
          end: { type: 'string', description: `Candidate end: ${DATE_TIME_SHAPE}. Must be after start.` },
          candidate_ical_uid: {
            type: 'string',
            description:
              "The candidate event's iCalUID, when it is already on a calendar (an invitation, or an event being moved).",
          },
          principal_addresses: {
            type: 'array',
            items: { type: 'string' },
            description:
              "The principal's email addresses, to read their answer on a copy that has no entry for its calendar.",
          },
          timezone: TIMEZONE_SCHEMA,
        },
        required: ['files', 'from', 'to', 'start', 'end'],
      },
    },
    async handler(args) {
      return answer(() => {
        const zone = readTimezone(args, options.defaultTimezone);
        const start = readInstant(args, 'start', zone);
        const end = readInstant(args, 'end', zone);
        if (end.toMillis() <= start.toMillis()) fail('end must be after start.');
        if (end.toMillis() - start.toMillis() > MAX_WINDOW_DAYS * DAY_MS) {
          fail(`The window is longer than ${MAX_WINDOW_DAYS} days. Check one candidate time at a time.`);
        }
        const from = readInstant(args, 'from', zone);
        const to = readInstant(args, 'to', zone);
        if (to.toMillis() <= from.toMillis()) fail('to must be after from.');
        if (start.toMillis() < from.toMillis() || end.toMillis() > to.toMillis()) {
          fail(
            `The candidate time is outside the range the files were fetched for, ${iso(from)} to ${iso(to)}, so events around it are missing. Fetch again with gog calendar events over a range that covers it, then call again.`,
          );
        }
        const candidate = args.candidate_ical_uid;
        if (candidate !== undefined && candidate !== null && typeof candidate !== 'string') {
          fail('candidate_ical_uid must be text.');
        }
        const principal = new Mailboxes(readAddressList(args, 'principal_addresses', false));
        const files = readFiles(args);
        return computeConflicts({
          zone,
          start,
          end,
          candidate: typeof candidate === 'string' && candidate.trim() !== '' ? candidate.trim() : null,
          principal,
          events: readEvents(files, roots, zone, MAX_FILE_AGE_MINUTES),
        });
      });
    },
  };

  const peopleStats: McpToolDefinition = {
    tool: {
      name: 'people_stats',
      description: `Count, for each person, the meetings the principal had with them, from saved gog calendar events output: meetings, one-on-ones, recurring series, and the first and last meeting date. Only events the principal organized or accepted count, so an invitation they left unanswered, declined, or marked maybe never builds a record. Left out: the principal (every spelling of their addresses), the assistant, rooms, cancelled events, and meetings of more than ${MAX_MEETING_SIZE} people. A meeting on several of the principal's calendars counts once. Lists the ${MAX_LISTED_PEOPLE} people met most, or exactly the people asked about. Names come back capped and wrapped as untrusted text. A file that is malformed, incomplete, or outside the workspace and temp directory is refused and named.`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          files: FILES_SCHEMA,
          principal_addresses: {
            type: 'array',
            minItems: 1,
            items: { type: 'string' },
            description: 'Every email address the principal uses.',
          },
          assistant_address: { type: 'string', description: 'Your own Google Workspace address.' },
          people: {
            type: 'array',
            items: { type: 'string' },
            description: 'Email addresses to report on, each listed even with no meetings. Omit to list everyone.',
          },
          timezone: TIMEZONE_SCHEMA,
        },
        required: ['files', 'principal_addresses', 'assistant_address'],
      },
    },
    async handler(args) {
      return answer(() => {
        const zone = readTimezone(args, options.defaultTimezone);
        const principal = new Mailboxes(readAddressList(args, 'principal_addresses', true));
        const assistantAddress =
          typeof args.assistant_address === 'string' ? normalizeEmail(args.assistant_address) : null;
        if (assistantAddress === null) fail('assistant_address is required: your own Google Workspace address.');
        const asked = readAddressList(args, 'people', false);
        const files = readFiles(args);
        return computePeopleStats({
          zone,
          principal,
          assistant: new Mailboxes([assistantAddress]),
          only: asked.length === 0 ? null : asked,
          events: readEvents(files, roots, zone),
        });
      });
    },
  };

  return { findConflicts, peopleStats };
}

export const { findConflicts, peopleStats } = createCalendarFactTools({
  allowedRoots: FILE_ROOTS,
  defaultTimezone: TIMEZONE,
});

registerTools([findConflicts, peopleStats], CALENDAR_FACTS_CAPABILITY);
