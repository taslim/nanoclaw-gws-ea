/**
 * The shared reader for saved gog calendar output, and the event model it
 * reads into. find_conflicts, people_stats, and schedule_stats all read the
 * JSON that `gog calendar events ... --all-pages` saved to a file through
 * this one reader, so every event is one Google returned, parsed the same
 * way, and never copied or miscounted by a model.
 *
 * Reads files only inside the agent's workspace or the container's temp
 * directory (`FILE_ROOTS`), refuses a file that is not complete gog events
 * output — every page, valid JSON, every event parseable — and names the
 * file it refuses. `readEvents` can also refuse a file saved too long ago,
 * for a caller (find_conflicts) that needs the read to be fresh.
 *
 * Carries the identity model the three tools share alongside it: `Mailboxes`
 * recognises every spelling that reaches the same mailbox, `isPrincipalParty`
 * and `principalResponse` read the principal's own say on a copy, and
 * `isRoom` leaves a resource calendar out of a head count. `fail`/`answer`
 * are the pair every calendar tool's handler uses to turn an input problem
 * into a refusal instead of a thrown error.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { DateTime } from 'luxon';

type ValidDateTime = DateTime<true>;

export const WORKSPACE_DIR = '/workspace/agent';
/** Where the calendar tools read saved gog output: the agent's workspace and the container's temp directory. */
export const FILE_ROOTS: readonly string[] = [WORKSPACE_DIR, os.tmpdir()];
export const MAX_FILES = 10;
export const MAX_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_EVENTS = 20_000;
const MAX_LISTED_PROBLEMS = 5;
const MINUTE_MS = 60_000;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const DATE_TIME_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/i;
const EMAIL = /^[^\s@]+@[^\s@]+$/;
const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);
const GOG_EVENTS_COMMAND =
  'gog calendar events --calendars <calendarId>,<calendarId> --from <start> --to <end> --all-pages';

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

/** A problem with the tool input, returned to the agent as an error result. */
class CalendarEventsError extends Error {}

export function fail(message: string): never {
  throw new CalendarEventsError(message);
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

export function normalizeEmail(value: string): string | null {
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

function json(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

/** The computed value as the tool's answer, or the input problem `fail` raised as an error result. */
export async function answer(compute: () => unknown): Promise<CallToolResult> {
  try {
    return json(compute());
  } catch (error) {
    if (error instanceof CalendarEventsError) {
      return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
    }
    throw error;
  }
}

export function strongestResponse(responses: ReadonlyArray<string | null>): string | null {
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

// ---- Tool input schema (shared) ----------------------------------------------

export const FILES_SCHEMA = {
  type: 'array',
  minItems: 1,
  maxItems: MAX_FILES,
  items: { type: 'string' },
  description: `Paths to JSON files saved from \`${GOG_EVENTS_COMMAND}\`, inside /workspace/agent (relative paths start there) or the temp directory. Every file must be complete: pass --all-pages.`,
};
