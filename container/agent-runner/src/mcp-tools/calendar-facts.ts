/**
 * find_conflicts and people_stats: exact calendar facts, counted from gog's
 * own output, read through the shared reader in calendar-events.ts.
 *
 * A model that copies events out of a calendar listing drops some, misreads
 * times, and cannot be checked. These tools do the counting over events the
 * reader already parsed and validated:
 *
 * - find_conflicts lists every event on the principal's calendars that
 *   overlaps a candidate time. Unlike `gog calendar conflicts`, which compares
 *   calendars with each other, it also finds an overlap on one calendar. The
 *   candidate's own copies (by `iCalUID`), cancelled events, events the
 *   principal declined, and free (transparent) events do not count; all-day
 *   busy events and free/busy-only blocks do. Times are compared as instants,
 *   and an all-day event runs from midnight to midnight on the principal's
 *   clocks, so a day with a clock change is 23 or 25 hours long. A hold the
 *   assistant placed while an email thread arranges a meeting is listed
 *   apart, as time that can give way. The answer is only as good as the files, so the call
 *   names the range they were fetched for, and a candidate outside it or a
 *   file saved more than fifteen minutes ago is refused.
 * - people_stats counts, for each person, the meetings the principal organized
 *   or accepted with them. A stranger's unanswered or declined invitations
 *   never build a record. The principal, the assistant, rooms, and meetings of
 *   more than eight people are left out, and a meeting that sits on several of
 *   the principal's calendars counts once.
 *
 * Names and titles come back capped and wrapped as untrusted text, the way
 * gog marks them, because other people wrote them.
 */
import { randomBytes } from 'crypto';
import path from 'path';
import { DateTime } from 'luxon';

import { TIMEZONE, isValidTimezone } from '../timezone.js';
import {
  DATE_TIME_WITH_OFFSET,
  FILES_SCHEMA,
  FILE_ROOTS,
  Mailboxes,
  answer,
  fail,
  isPrincipalParty,
  isRoom,
  normalizeEmail,
  principalResponse,
  readAddressList,
  readEvents,
  readFiles,
  strongestResponse,
  type CalendarEvent,
} from './calendar-events.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

type ValidDateTime = DateTime<true>;

/**
 * The key that grants find_conflicts and people_stats. Named here, not left
 * to the barrel's load, so a test that imports this module directly still
 * attributes the tools correctly.
 */
const CALENDAR_FACTS_CAPABILITY = 'calendar-facts';

export const MAX_WINDOW_DAYS = 14;
/** A conflict check reads only events fetched this recently: one turn of fetching and checking. */
export const MAX_FILE_AGE_MINUTES = 15;
/** A meeting with more people than this says little about any one of them. */
export const MAX_MEETING_SIZE = 8;
export const MAX_LISTED_CONFLICTS = 50;
export const MAX_LISTED_PEOPLE = 100;
export const MAX_NAME_CHARS = 64;
export const MAX_TITLE_CHARS = 100;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

const DATE_TIME_SHAPE = 'a date-time with its UTC offset, such as 2026-10-06T10:00:00+01:00';

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

/** Time the assistant holds while an email thread arranges a meeting: it can give way. */
export interface HeldTime {
  /** The email thread the time is held for, such as mail-…. */
  thread_key: string;
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

function iso(at: ValidDateTime): string {
  return at.toISO({ suppressMilliseconds: true });
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
  // The copies of each meeting, by meeting; a hold also keeps the thread it holds time for.
  const conflicting = new Map<string, CalendarEvent[]>();
  const held = new Map<string, { threadKey: string; copies: CalendarEvent[] }>();
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
      else held.set(event.meetingKey, { threadKey: event.heldFor, copies: [event] });
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
    .map(({ threadKey, copies }): HeldTime => {
      const [first] = copies;
      return {
        thread_key: threadKey,
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
    const others = new Map<string, CalendarEvent['attendees'][number]>();
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
      description: `List every event on the principal's calendars that overlaps a candidate time, counted from gog calendar events output saved for a range that covers it. It finds overlaps on one calendar as well as across calendars. Left out: the candidate's own copies on any calendar (matched by candidate_ical_uid), cancelled events, events the principal declined, and free (transparent) events. All-day busy events and free/busy-only blocks count. A time the assistant holds while an email thread arranges a meeting is listed under holds with its thread_key, as time that can give way, not as a conflict; a meeting the assistant booked is a conflict like any other. A meeting on several of the principal's calendars is listed once with each calendar. Times are compared as instants; an all-day event runs midnight to midnight on the principal's clocks, so clock changes are handled. The window is at most ${MAX_WINDOW_DAYS} days. Titles come back wrapped as untrusted text. Refused, so you fetch again: a candidate outside the from-to range the files were fetched for, and a file saved more than ${MAX_FILE_AGE_MINUTES} minutes ago. A file that is malformed, incomplete, or outside the workspace and temp directory is refused and named.`,
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
