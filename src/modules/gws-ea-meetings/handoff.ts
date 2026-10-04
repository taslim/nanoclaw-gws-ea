/**
 * The typed handoff between `main` and `external-email` (KTD5, KTD16).
 *
 * `main` sends requests; `external-email` reports one outcome and may place
 * the people on its thread. Each arrives as a guarded delivery action (see
 * `guard.ts`), and each gets exactly one answer, errors included, through
 * `writeActionResponse`. An answer is recorded against the request id the
 * runner set, the id of the outbound message that carried it, so a request
 * replayed after a host restart gets the first answer and causes nothing
 * twice.
 *
 * - `arrange` opens a new email thread to the people `main` names, copying
 *   the principal only when asked, or takes over a thread the host holds for
 *   `main` (one the principal copied the assistant into, or one anyone else
 *   started), taking its people from its mail, with anyone `main` adds.
 *   `reschedule` moves an event the principal organizes; `ask_organizer`
 *   asks an invitation's organizer, record or not (R16), to move it.
 * - `respond` takes over a held thread for one reply, from a brief; the
 *   moment delivery records the reply, the thread is held for `main` again.
 *   `dismiss` closes a held thread with nothing sent.
 * - Nothing in a meeting's conversation stalls silently. When delivery gives
 *   up on an email it wrote, when an email to it is given up after its
 *   retries, or when one of its turns fails, `main` hears of it: a reply's
 *   job ends and its thread is held again; any other meeting goes on, for
 *   `main` to amend, reschedule, or cancel.
 *   `reply_to_principal` answers the principal's own email, to them alone.
 * - Every meeting is bound to one `external-email` session. Its first message
 *   is the brief: a host-only message from sender `system`, which no email
 *   can be, carrying the counterparts' names and addresses, who its replies
 *   go to, the meeting's level, its length, window, purpose and constraints,
 *   and nothing else from the people store. Mail held for the thread follows
 *   it.
 * - The purpose and constraints are length-capped and pass the audience
 *   check before `external-email` sees them.
 * - Replies go to everyone on the thread (R40). `external-email` may place
 *   those people in To, Cc, and Bcc or leave someone off (`recipients`);
 *   only `main` adds someone, with `arrange` or `amend`.
 * - `arrange` with colleagues alone whose free/busy Google shows books the
 *   time directly, with no email and no session (R11).
 * - `cancel` ends a meeting, closes its session, and tells the people the
 *   assistant wrote to in one checked line; a reply not yet sent is simply
 *   called off. Given an event the principal organizes with others instead,
 *   it deletes the event with Google's own cancellation notice to them (R8).
 *   `amend` writes a new brief.
 * - An outcome becomes a typed note in `main`'s shared session. Booked comes
 *   only after the host's own booking; settled only after the invitation is
 *   re-read and found moved to an offered time or clear of conflicts;
 *   needs-room only for someone in the inner circle or close, and its note
 *   lists the meetings that could move to make room (R14, `room.ts`);
 *   not-scheduling hands the thread back to `main` to triage.
 * - `reschedule` with `making_room_for` moves one of those, and reserves the
 *   time it frees for the meeting that needs it (R23). That meeting's
 *   booking note names the meeting that moved.
 * - Follow-through ends a meeting nobody answered, and closes a booked one
 *   once its event has passed (`follow-through.ts`).
 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';

import { writeActionResponse } from '../../cli/delivery-action.js';
import type { ResponseFrame } from '../../cli/frame.js';
import { TIMEZONE } from '../../config.js';
import { resolveGroupTimezone } from '../../container-config.js';
import { isContainerRunning, killContainer } from '../../container-runner.js';
import { getDb } from '../../db/connection.js';
import { isUniqueViolation } from '../../db/errors.js';
import { deleteSession, getSession, updateSession } from '../../db/sessions.js';
import { getDeliveryAdapter } from '../../delivery.js';
import type { GuardedDeliveryHandler } from '../../delivery-guard.js';
import { hasControlCharacters } from '../../gws-ea/validation.js';
import { log } from '../../log.js';
import type { MessageRetry, OutboundMessage } from '../../mailbox/index.js';
import { requestWake } from '../../request-wake.js';
import { destroySessionMailbox, sessionDir, writeSessionMessage } from '../../session-manager.js';
import { formatLocalTime } from '../../timezone.js';
import type { Session } from '../../types.js';
import { isPrincipalCalendar, recordOwnCalendarChange } from '../gws-ea-inbox/calendar-notifications.js';
import { authenticateSender } from '../gws-ea-inbox/authentication.js';
import {
  getPrincipalMessage,
  hasSentInThreadSince,
  isSettled,
  listPrincipalCalendars,
  threadMessageIds,
} from '../gws-ea-inbox/db.js';
import {
  addThreadPeople,
  arrangeThreadPeople,
  authorizeThread,
  closeThread,
  EMAIL_CHANNEL_TYPE,
  getThreadParticipants,
  GoogleApiError,
  handBackHeldThread,
  INBOX_PLATFORM_ID,
  mintThreadKey,
  openThreadSession,
  releaseHeldMail,
  sendPrincipalReply,
  vouchThreadPeople,
  type ThreadOrigin,
  type ThreadPeople,
  type ThreadView,
} from '../gws-ea-inbox/index.js';
import { normalizeAddress } from '../gws-ea-inbox/mime.js';
import { loadRoutingContext } from '../gws-ea-inbox/routing.js';
import { activeInbox, assistantAddresses } from '../gws-ea-inbox/runtime.js';
import { untrustedLine } from '../gws-ea-inbox/untrusted.js';
import { findPeople, getPerson } from '../gws-ea-people/db.js';
import { checkOutbound, deleteThreadRecord, type ThreadKey } from '../gws-ea-privacy/index.js';
import { getSchedulingPreferenceValues, type SchedulingPreferenceValues } from '../gws-ea-preferences/db.js';
import { getGwsEaProfile, listPrincipalAddresses } from '../gws-ea-profile/db.js';
import type { CalendarEvent, MeetingsCalendarApi } from './calendar-api.js';
import { blocksTime, eventSpan } from './slots.js';
import {
  addCounterparts,
  claimGiveUp,
  clearDeadlines,
  deleteMeeting,
  findBookedMeetingForEvent,
  findLiveMeetingForEvent,
  findLiveMeetingOnThread,
  findMeetingByRequest,
  getBooking,
  getMeeting,
  getRecordedOutcome,
  getRecordedResponse,
  getRoomGivenTo,
  getRoomMadeBy,
  hadEarlierMeetingOnThread,
  insertMeeting,
  insertRoom,
  isScheduling,
  LIVE_STATES,
  listOfferedSlots,
  lowestLevel,
  meetingsWithPerson,
  OUTCOMES,
  recordOutcome,
  recordResponse,
  releaseGiveUp,
  updateMeeting,
  type Booking,
  type Meeting,
  type MeetingCounterpart,
  type MeetingState,
  type MeetingTerms,
  type Outcome,
  type SchedulingKind,
  type SchedulingMeeting,
} from './db.js';
import {
  mainTimezone,
  noteCounterparts,
  OUTCOME_NOTE_TYPE,
  STALLED_NOTE_TYPE,
  UNSENT_NOTE_TYPE,
  who,
  writeMainNote,
  writeOutcomeNote,
  type OutcomeNote,
  type RoomCandidate,
} from './notes.js';

export interface MeetingHandoffDeps {
  /** The host's own Calendar client. */
  readonly calendar: () => MeetingsCalendarApi;
  /**
   * Release the holds the host placed for a meeting: every one when the
   * meeting ends, or only those that no longer fit its length and window.
   * Throws when one could not be released; it stays recorded for the next
   * attempt.
   */
  readonly releaseHolds: (meeting: Meeting, which?: 'all' | 'stale') => Promise<void>;
  /**
   * Book a new meeting directly when everyone in it is a colleague whose
   * free/busy Google shows (R11), at the best time free for all; undefined
   * when it is not such a meeting or no time is free, so it goes by email.
   */
  readonly bookDirectly: (meeting: SchedulingMeeting) => Promise<Booking | undefined>;
  /** The booked meetings that could move to make room for one that needs it, earliest first (R14). */
  readonly roomCandidates: (meeting: SchedulingMeeting) => Promise<readonly RoomCandidate[]>;
  /** That event as a candidate to move for `meeting`; refused, saying why, when it may not move for it. */
  readonly roomCandidate: (meeting: SchedulingMeeting, calendarId: string, eventId: string) => Promise<RoomCandidate>;
}

/** A request the host refuses as asked: the caller reads why and can ask differently. */
export class MeetingRequestError extends Error {
  constructor(
    readonly code: 'invalid-args' | 'forbidden',
    message: string,
  ) {
    super(message);
    this.name = 'MeetingRequestError';
  }
}

export function invalid(message: string): MeetingRequestError {
  return new MeetingRequestError('invalid-args', message);
}

export function refused(message: string): MeetingRequestError {
  return new MeetingRequestError('forbidden', message);
}

// ---------------------------------------------------------------------------
// The request's fields, checked here before anything acts on them
// ---------------------------------------------------------------------------

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const THREAD_KEY = /^mail-[A-Za-z0-9-]{1,80}$/u;
const MEETING_ID = /^mtg-[0-9a-f-]{36}$/u;
const EVENT_ID = /^[A-Za-z0-9_-]{1,1024}$/u;
const PERSON_ID = /^p-[0-9a-f]{12}$/u;
/** The preferences store's shape for a kind of meeting, such as `one-on-one`. */
const MEETING_KIND = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const MEETING_KIND_MAX = 40;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/iu;
const GMAIL_MESSAGE_ID = /^[A-Za-z0-9_-]{1,128}$/u;
/** A meeting's purpose is a new thread's subject, so it stays short. */
const PURPOSE_MAX = 120;
/** A reply's purpose says what the one reply must do: decline, route, acknowledge, or hold. */
const REPLY_PURPOSE_MAX = 500;
const CONSTRAINTS_MAX = 500;
/** How much of a list of addresses only email gave is shown, wrapped as untrusted. */
const MAIL_ADDRESSES_MAX = 2_000;
/** The principal's own email is answered in full, so it may run to several paragraphs. */
const PRINCIPAL_REPLY_MAX = 20_000;
const MIN_LENGTH = 5;
const MAX_LENGTH = 480;
const MAX_WINDOW_DAYS = 60;
const MAX_PEOPLE = 8;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** The request id the runner set: the id of the outbound message that carried the request. */
export function requestIdOf(content: Record<string, unknown>): string | undefined {
  const id = content.requestId;
  return typeof id === 'string' && REQUEST_ID.test(id) ? id : undefined;
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string') throw invalid(`${label} is required`);
  const line = value.replace(/\s+/gu, ' ').trim();
  if (line === '' || line.length > max || hasControlCharacters(line)) {
    throw invalid(`${label} must be text of 1 to ${max} characters`);
  }
  return line;
}

function optionalText(value: unknown, label: string, max: number): string | undefined {
  return value === undefined || value === null ? undefined : text(value, label, max);
}

export function meetingIdOf(content: Record<string, unknown>, field = 'meeting_id'): string {
  const id = content[field];
  if (typeof id !== 'string' || !MEETING_ID.test(id)) throw invalid(`${field} must be a meeting id, such as mtg-…`);
  return id;
}

/** A held thread's key, as the note about its email gave it; absent for a new thread. */
function threadKeyOf(content: Record<string, unknown>): string | undefined {
  const key = content.thread_key;
  if (key === undefined || key === null) return undefined;
  if (typeof key !== 'string' || !THREAD_KEY.test(key)) {
    throw invalid('thread_key must be the thread_key the note about an email gave you, such as mail-…');
  }
  return key;
}

function requiredThreadKeyOf(content: Record<string, unknown>): string {
  const key = threadKeyOf(content);
  if (key === undefined) throw invalid('thread_key is required: give the thread_key the note about an email gave you');
  return key;
}

/** Whether `main` asked to copy the principal on a new thread; false unless it did. */
function copyPrincipalOf(content: Record<string, unknown>): boolean {
  const value = content.copy_principal;
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') throw invalid('copy_principal must be true or false');
  return value;
}

/** Text the principal reads as written: line breaks kept, nothing else unprintable. */
function bodyText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string') throw invalid(`${label} is required`);
  const body = value.replace(/\r\n?/gu, '\n').trim();
  if (body === '' || body.length > max || hasControlCharacters(body.replace(/[\n\t]/gu, ' '))) {
    throw invalid(`${label} must be text of 1 to ${max} characters`);
  }
  return body;
}

/** A list of addresses as given, each normalized; an empty list when it is absent and not required. */
function addressesOf(value: unknown, label: string, required: boolean): string[] {
  if (value === undefined || value === null) {
    if (required) throw invalid(`${label} is required: list the addresses to place there`);
    return [];
  }
  if (!Array.isArray(value) || value.length > MAX_PEOPLE * 4) {
    throw invalid(`${label} must list email addresses`);
  }
  return value.map((entry: unknown) => {
    const address = typeof entry === 'string' ? normalizeAddress(entry) : undefined;
    if (address === undefined) throw invalid(`${label} must list email addresses; ${JSON.stringify(entry)} is not one`);
    return address;
  });
}

function calendarIdOf(content: Record<string, unknown>): string {
  const id = content.calendar_id;
  if (typeof id !== 'string' || id.trim() === '' || id.length > 256 || /\s/u.test(id) || hasControlCharacters(id)) {
    throw invalid('calendar_id must be a calendar id, such as the principal’s address');
  }
  return id.trim();
}

function eventIdOf(content: Record<string, unknown>): string {
  const id = content.event_id;
  if (typeof id !== 'string' || !EVENT_ID.test(id)) throw invalid('event_id must be an event id from the calendar');
  return id;
}

/** The kind of meeting whose preferences apply, when main named one. */
function meetingKindOf(content: Record<string, unknown>): string | undefined {
  const kind = content.meeting_kind;
  if (kind === undefined || kind === null) return undefined;
  if (typeof kind !== 'string' || kind.length > MEETING_KIND_MAX || !MEETING_KIND.test(kind)) {
    throw invalid('meeting_kind must be a kind of meeting as the preferences name it, such as one-on-one');
  }
  return kind;
}

function lengthOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < MIN_LENGTH || value > MAX_LENGTH) {
    throw invalid(`length_minutes must be a whole number of minutes from ${MIN_LENGTH} to ${MAX_LENGTH}`);
  }
  return value;
}

function instantOf(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DATE_TIME.test(value) || Number.isNaN(Date.parse(value))) {
    throw invalid(`${label} must be a date-time with its UTC offset, such as 2026-10-12T09:00:00+01:00`);
  }
  return new Date(value).toISOString();
}

interface Window {
  readonly start: string;
  readonly end: string;
}

/** A window that ends after it starts, has not ended, spans at most `MAX_WINDOW_DAYS`, and holds the meeting. */
function checkedWindow(window: Window, lengthMinutes: number, at: Date): Window {
  const start = Date.parse(window.start);
  const end = Date.parse(window.end);
  if (end <= start) throw invalid('window_end must come after window_start');
  if (end <= at.getTime()) throw invalid('The window has already ended: give one in the future');
  if (end - start > MAX_WINDOW_DAYS * DAY) throw invalid(`The window may span at most ${MAX_WINDOW_DAYS} days`);
  if (end - Math.max(start, at.getTime()) < lengthMinutes * MINUTE) {
    throw invalid('The window left is shorter than the meeting');
  }
  return window;
}

function windowOf(content: Record<string, unknown>): Window {
  return { start: instantOf(content.window_start, 'window_start'), end: instantOf(content.window_end, 'window_end') };
}

/** Someone `main` names: by their record, with which of its addresses, or by an address alone. */
type PersonRef =
  | { readonly kind: 'record'; readonly personId: string; readonly email: string | undefined }
  | { readonly kind: 'address'; readonly address: string };

const PERSON_SHAPE =
  'Each person must be { person_id, email? }, with a record id such as p-1a2b3c4d5e6f, or { email } for someone without a record';

function peopleOf(value: unknown): PersonRef[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PEOPLE) {
    throw invalid(`people must list 1 to ${MAX_PEOPLE} people`);
  }
  return value.map((entry: unknown): PersonRef => {
    const record = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : {};
    const { person_id: personId, email } = record;
    if (email !== undefined && typeof email !== 'string') throw invalid('email must be an address');
    if (personId === undefined) {
      const address = email === undefined ? undefined : normalizeAddress(email);
      if (address === undefined) throw invalid(PERSON_SHAPE);
      return { kind: 'address', address };
    }
    if (typeof personId !== 'string' || !PERSON_ID.test(personId.trim())) throw invalid(PERSON_SHAPE);
    return { kind: 'record', personId: personId.trim(), email };
  });
}

/** The purpose and constraints may reach anyone the meeting's thread reaches, so nothing private passes. */
async function assertShareable(purpose: string | undefined, constraints: string | undefined): Promise<void> {
  const parts = [purpose, constraints].filter((part): part is string => part !== undefined);
  if (parts.length === 0) return;
  const check = await checkOutbound(parts, 'others');
  if (!check.allowed) throw refused(`The purpose or constraints were not passed on: ${check.reason}`);
}

// ---------------------------------------------------------------------------
// Who the meeting is with
// ---------------------------------------------------------------------------

export interface AddressBook {
  readonly principal: ReadonlySet<string>;
  readonly assistant: ReadonlySet<string>;
}

export async function addressBook(): Promise<AddressBook> {
  return {
    principal: new Set((await listPrincipalAddresses()).map((address) => address.email)),
    assistant: await assistantAddresses(),
  };
}

function assertSomeoneElse(address: string, book: AddressBook): void {
  if (book.principal.has(address)) throw invalid('The principal is never a counterpart in their own meeting');
  if (book.assistant.has(address)) throw invalid('The assistant is never its own counterpart');
}

/** A counterpart `main` named, never the principal or the assistant. */
async function counterpartFor(ref: PersonRef, book: AddressBook): Promise<MeetingCounterpart> {
  if (ref.kind === 'record') return counterpartForPerson(ref, book);
  assertSomeoneElse(ref.address, book);
  return counterpartForAddress(ref.address);
}

/** A counterpart from a record: its name, level, and the one address to write to. */
async function counterpartForPerson(
  ref: Extract<PersonRef, { readonly kind: 'record' }>,
  book: AddressBook,
): Promise<MeetingCounterpart> {
  const person = await getPerson(ref.personId);
  if (!person) {
    throw refused(`No person ${ref.personId} has a record. Find them with ncl people, or add them first.`);
  }
  const addresses = person.identities
    .filter((identity) => identity.handle.startsWith('email:'))
    .map((identity) => identity.handle.slice('email:'.length));
  let address: string;
  if (ref.email !== undefined) {
    const wanted = normalizeAddress(ref.email);
    if (wanted === undefined || !addresses.includes(wanted)) {
      throw invalid(`${person.name}'s record has no address ${ref.email}`);
    }
    address = wanted;
  } else if (addresses.length === 1) {
    address = addresses[0];
  } else if (addresses.length === 0) {
    throw refused(`${person.name}'s record has no email address to write to`);
  } else {
    throw invalid(`${person.name} has several addresses (${addresses.join(', ')}): name one as email`);
  }
  assertSomeoneElse(address, book);
  return { address, person_id: person.id, name: person.name, level: person.level };
}

/** A counterpart from an address Google or the principal's message gave: their record if they have one. */
export async function counterpartForAddress(address: string): Promise<MeetingCounterpart> {
  const found = await findPeople(`email:${address}`);
  const person = found.matched_by === 'identity' && found.people.length === 1 ? found.people[0] : undefined;
  return person
    ? { address, person_id: person.id, name: person.name, level: person.level }
    : { address, person_id: null, name: null, level: 'unknown' };
}

function distinct(counterparts: readonly MeetingCounterpart[]): MeetingCounterpart[] {
  const seen = new Set<string>();
  return counterparts.filter((counterpart) => {
    if (seen.has(counterpart.address)) return false;
    seen.add(counterpart.address);
    return true;
  });
}

/** Where a message or a turn belongs: the conversation and thread, as core reports them. */
interface ThreadRoute {
  readonly channelType: string | null;
  readonly platformId: string | null;
  readonly threadId: string | null;
}

/** A thread the host holds for `main`: copied in by the principal, or started by anyone else. */
function isHeldOrigin(origin: ThreadOrigin): boolean {
  return origin === 'copy-in' || origin === 'inbound';
}

/** Everyone a reply in the thread reaches, each once. */
function everyoneOn(people: ThreadPeople): string[] {
  return [...new Set([...people.to, ...people.cc, ...people.bcc])];
}

/**
 * The people on a thread besides the principal and the assistant, as
 * counterparts. A record's level and name apply only to someone the
 * principal, a sender Gmail verified, or main put on the thread: an
 * unverified email can name anyone, so anyone else is judged as unknown (R21).
 */
async function threadCounterparts(thread: ThreadView, book: AddressBook): Promise<MeetingCounterpart[]> {
  const vouched = new Set(thread.vouched);
  return Promise.all(
    everyoneOn(thread.people)
      .filter((address) => !book.principal.has(address) && !book.assistant.has(address))
      .map(
        async (address): Promise<MeetingCounterpart> =>
          vouched.has(address)
            ? counterpartForAddress(address)
            : { address, person_id: null, name: null, level: 'unknown' },
      ),
  );
}

/** A thread's counterparts with the people main named: main's naming of someone wins, then anyone new. */
function withNamed(thread: readonly MeetingCounterpart[], named: readonly MeetingCounterpart[]): MeetingCounterpart[] {
  return distinct([...thread.map((c) => named.find((n) => n.address === c.address) ?? c), ...named]);
}

/** A thread waiting for `main`, with no meeting in progress, that `arrange` or `respond` may take over. */
async function requireHeldThread(threadKey: string): Promise<ThreadView> {
  const thread = await getThreadParticipants(threadKey);
  if (!thread || !isHeldOrigin(thread.origin)) {
    throw refused(`${threadKey} is not a thread waiting for you: use the thread_key a note about an email gave you`);
  }
  if (thread.state === 'closed') throw refused(`Thread ${threadKey} is closed`);
  const live = await findLiveMeetingOnThread(threadKey);
  if (live) throw refused(`Thread ${threadKey} already has meeting ${live.id}`);
  return thread;
}

/** The principal's timezone, which their preferences and all-day events are on. */
export async function principalTimezone(): Promise<string> {
  return (await getGwsEaProfile()).principal_timezone ?? TIMEZONE;
}

const NO_PREFERENCES: SchedulingPreferenceValues = {
  working_hours: [],
  protected_windows: [],
  meeting_lengths: [],
  buffers: [],
  preferred_times: [],
};

/** The principal's scheduling preferences, or none while the store does not exist yet. */
export async function principalPreferences(): Promise<SchedulingPreferenceValues> {
  if (!(await getDb().hasTable('gws_ea_pref_working_hours'))) return NO_PREFERENCES;
  return getSchedulingPreferenceValues();
}

/** Whether the principal organizes an event: one of their addresses, or the calendar it is on, is its organizer. */
export function organizedByPrincipal(event: CalendarEvent, calendarId: string, book: AddressBook): boolean {
  const organizer = event.organizer?.email;
  return organizer !== undefined && (book.principal.has(organizer) || organizer === calendarId.toLowerCase());
}

/** The people besides the principal and the assistant on an event: its guests to tell. */
export function guestsOf(event: CalendarEvent, book: AddressBook): string[] {
  return [
    ...new Set(
      (event.attendees ?? [])
        .filter((attendee) => attendee.resource !== true)
        .flatMap((attendee) => normalizeAddress(attendee.email ?? '') ?? [])
        .filter((address) => !book.principal.has(address) && !book.assistant.has(address)),
    ),
  ];
}

// ---------------------------------------------------------------------------
// Answering every request exactly once
// ---------------------------------------------------------------------------

/** What a request's handler returns: the data its answer carries, and the meeting it concerns. */
export interface Answer {
  readonly meetingId: string | null;
  readonly data: Record<string, unknown>;
}

function errorFrame(requestId: string, error: unknown): ResponseFrame {
  if (error instanceof MeetingRequestError) {
    return { id: requestId, ok: false, error: { code: error.code, message: error.message } };
  }
  const reason = error instanceof Error ? error.message : String(error);
  return {
    id: requestId,
    ok: false,
    error: { code: 'handler-error', message: `The host could not do it: ${reason}` },
  };
}

export type Handle = (content: Record<string, unknown>, session: Session, requestId: string) => Promise<Answer>;

/**
 * A delivery action that answers its request once. The answer, an error
 * included, is recorded before it is written, so a replay writes the same
 * answer again and runs nothing.
 */
export function answering(action: string, handle: Handle): GuardedDeliveryHandler {
  return async (content, session) => {
    const requestId = requestIdOf(content);
    if (requestId === undefined) return;
    const recorded = await getRecordedResponse(session.id, requestId);
    if (recorded !== undefined) {
      await writeActionResponse(session, requestId, JSON.parse(recorded) as ResponseFrame);
      return;
    }
    let frame: ResponseFrame;
    let meetingId: string | null = null;
    /* eslint-disable no-catch-all/no-catch-all -- every request is answered, a failure included; nothing is rethrown into a retry */
    try {
      const answer = await handle(content, session, requestId);
      meetingId = answer.meetingId;
      frame = { id: requestId, ok: true, data: answer.data };
    } catch (error) {
      if (error instanceof MeetingRequestError) {
        log.info('Meeting request refused', { action, requestId, sessionId: session.id, reason: error.message });
      } else {
        log.error('Meeting request failed', { action, requestId, sessionId: session.id, err: error });
      }
      frame = errorFrame(requestId, error);
    }
    /* eslint-enable no-catch-all/no-catch-all */
    await recordResponse(session.id, requestId, action, meetingId, JSON.stringify(frame), new Date().toISOString());
    await writeActionResponse(session, requestId, frame);
  };
}

export function createMeetingHandoff(deps: MeetingHandoffDeps) {
  const calendar = () => deps.calendar();

  /** A calendar of the principal's in the assistant's list; with `write`, one it can change. */
  async function requirePrincipalCalendar(calendarId: string, write: boolean): Promise<string> {
    const entry = await calendar().getCalendar(calendarId);
    const { principal } = await addressBook();
    if (!entry || !isPrincipalCalendar(entry, principal)) {
      throw refused(`Calendar ${calendarId} is not one of the principal's calendars the assistant can see`);
    }
    if (write && entry.accessRole !== 'writer' && entry.accessRole !== 'owner') {
      throw refused(
        `The assistant cannot change calendar ${calendarId}: choose one of the principal's calendars it can write to`,
      );
    }
    return entry.id;
  }

  /** A timed, live event, with its span and length in minutes. */
  async function requireTimedEvent(
    calendarId: string,
    eventId: string,
  ): Promise<{ readonly event: CalendarEvent; readonly minutes: number }> {
    const event = await calendar().getEvent(calendarId, eventId);
    if (!event || event.status === 'cancelled') throw refused(`There is no event ${eventId} on calendar ${calendarId}`);
    if (event.start?.dateTime === undefined) throw refused('An all-day event cannot be moved this way');
    const span = eventSpan(event, await principalTimezone());
    if (!span || span.end <= span.start) throw refused('Google reports no readable time for that event');
    return { event, minutes: Math.round((span.end - span.start) / MINUTE) };
  }

  // -------------------------------------------------------------------------
  // Opening a meeting
  // -------------------------------------------------------------------------

  type Opening =
    | { readonly kind: 'new'; readonly opener: 'arrange' | 'ask_organizer'; readonly copyPrincipal: boolean }
    | { readonly kind: 'held' }
    | { readonly kind: 'takeover'; readonly session: Session };

  type BriefSetting = 'new-thread' | 'copied-in' | 'inbound' | 'held-again' | 'continuing';

  const TASKS: Readonly<Record<SchedulingKind, string>> = {
    arrange: 'Arrange a meeting between the principal and:',
    reschedule: "Move the principal's existing meeting with these people to a new time in the window:",
    ask_organizer:
      "Ask the organizer of an invitation to the principal to move it to a time in the window, because it conflicts with the principal's calendar:",
  };

  const SETTINGS: Readonly<Record<BriefSetting, string>> = {
    'new-thread': 'This is a new email thread: your first email starts it.',
    'copied-in': 'The principal copied you into this email thread. Its mail so far follows this brief.',
    inbound: "This email thread came to the assistant's inbox. Its mail so far follows this brief.",
    'held-again':
      'This email thread was handed to the assistant before, in an earlier conversation, so only the mail that arrived since then follows this brief.',
    continuing: 'Continue in this email thread, where you have written to them before.',
  };

  const PLACEMENTS = [
    ['to', 'To'],
    ['cc', 'Cc'],
    ['bcc', 'Bcc'],
  ] as const;

  function personText(counterpart: Pick<MeetingCounterpart, 'name' | 'address'>): string {
    return counterpart.name ? `${counterpart.name} <${counterpart.address}>` : counterpart.address;
  }

  /**
   * People, for text the host writes (KTD16). The principal and the meeting's
   * counterparts are named: the host or main put them there. Anyone else is
   * on the thread because an email named them, and an email can name anyone,
   * so their addresses stay inside the untrusted wrapper.
   */
  function peopleText(
    groups: readonly (readonly [label: string, addresses: readonly string[]])[],
    meeting: Pick<Meeting, 'counterparts'>,
    principal: ReadonlySet<string>,
  ): string {
    const named: string[] = [];
    const fromMail: string[] = [];
    for (const [label, addresses] of groups) {
      const names: string[] = [];
      const others: string[] = [];
      for (const address of addresses) {
        const counterpart = meeting.counterparts.find((c) => c.address === address);
        if (principal.has(address)) names.push(`the principal <${address}>`);
        else if (counterpart) names.push(personText(counterpart));
        else others.push(address);
      }
      const prefix = label === '' ? '' : `${label} `;
      if (names.length > 0) named.push(prefix + names.join(', '));
      if (others.length > 0) fromMail.push(prefix + others.join(', '));
    }
    if (fromMail.length === 0) return named.length === 0 ? 'no one' : named.join('; ');
    const wrapped = untrustedLine(fromMail.join('; '), MAIL_ADDRESSES_MAX);
    return named.length === 0
      ? `people only email put on the thread: ${wrapped}`
      : `${named.join('; ')}; and people only email put on the thread: ${wrapped}`;
  }

  /** A thread's people by placement, To first, leaving out an empty one. */
  function placed(people: ThreadPeople): (readonly [string, readonly string[]])[] {
    return PLACEMENTS.filter(([field]) => people[field].length > 0).map(
      ([field, name]) => [name, people[field]] as const,
    );
  }

  /** Who a reply in the thread reaches now, as the thread places them. */
  function repliesGoTo(people: ThreadPeople, meeting: Meeting, principal: ReadonlySet<string>): string {
    const groups = placed(people);
    return groups.length === 0
      ? 'Your replies go to no one yet.'
      : `Your replies go to: ${peopleText(groups, meeting, principal)}.`;
  }

  function termsText(meeting: Meeting, timezone: string): string[] {
    if (!isScheduling(meeting)) {
      return [`Write one reply in this thread: ${meeting.purpose}`, `Constraints: ${meeting.constraints ?? 'none.'}`];
    }
    return [
      TASKS[meeting.kind],
      ...meeting.counterparts.map((counterpart) => `- ${personText(counterpart)}`),
      `Level: ${meeting.level}.`,
      `Length: ${meeting.length_minutes} minutes.`,
      `Window: from ${formatLocalTime(meeting.window_start, timezone)} to ${formatLocalTime(meeting.window_end, timezone)} (${timezone}).`,
      `Purpose: ${meeting.purpose}`,
      `Constraints: ${meeting.constraints ?? 'none.'}`,
    ];
  }

  interface BriefContext {
    readonly version: number;
    readonly setting: BriefSetting;
    readonly timezone: string;
    readonly people: ThreadPeople;
    readonly principal: ReadonlySet<string>;
    /** The people `main` added with this brief. */
    readonly added: readonly MeetingCounterpart[];
  }

  function briefText(meeting: Meeting, context: BriefContext): string {
    return [
      context.version === 1
        ? `Brief for meeting ${meeting.id}, from the host.`
        : `Updated brief for meeting ${meeting.id} (version ${context.version}), from the host. It replaces the earlier brief.`,
      'Only the host writes briefs; no email ever arrives as one.',
      '',
      ...termsText(meeting, context.timezone),
      '',
      repliesGoTo(context.people, meeting, context.principal),
      ...(context.added.length === 0
        ? []
        : [`main added ${context.added.map(personText).join(', ')} to the thread: your next reply goes to them too.`]),
      SETTINGS[context.setting],
      isScheduling(meeting)
        ? `When it ends, report it once with outcome for meeting ${meeting.id}.`
        : `Send that one reply, then report responded with outcome for meeting ${meeting.id}.`,
    ].join('\n');
  }

  /** Write a brief into the meeting's session. Writing the same version again is a no-op. */
  async function writeBrief(
    meeting: Meeting,
    session: Session,
    version: number,
    setting: BriefSetting,
    added: readonly MeetingCounterpart[] = [],
  ): Promise<void> {
    const thread = await getThreadParticipants(meeting.thread_key);
    if (!thread) throw new Error(`Meeting ${meeting.id} has no thread to brief`);
    const context: BriefContext = {
      version,
      setting,
      timezone: await resolveGroupTimezone(session.agent_group_id),
      people: thread.people,
      principal: (await addressBook()).principal,
      added,
    };
    const brief = {
      type: 'gws-ea-meetings.brief',
      meeting_id: meeting.id,
      version,
      kind: meeting.kind,
      level: meeting.level,
      length_minutes: meeting.length_minutes,
      window_start: meeting.window_start,
      window_end: meeting.window_end,
      purpose: meeting.purpose,
      constraints: meeting.constraints,
      counterparts: meeting.counterparts.map(({ name, address }) => ({ name, address })),
      people: thread.people,
    };
    try {
      await writeSessionMessage(session.agent_group_id, session.id, {
        id: `meeting-brief-${meeting.id}-${version}`,
        kind: 'chat',
        timestamp: new Date().toISOString(),
        platformId: INBOX_PLATFORM_ID,
        channelType: EMAIL_CHANNEL_TYPE,
        threadId: meeting.thread_key,
        content: JSON.stringify({
          text: briefText(meeting, context),
          sender: 'system',
          senderId: 'system',
          brief,
        }),
        trigger: true,
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      log.info('Meeting brief already written', { meetingId: meeting.id, version });
    }
  }

  async function requireMeeting(id: string): Promise<Meeting> {
    const meeting = await getMeeting(id);
    if (!meeting) throw refused(`There is no meeting ${id}`);
    return meeting;
  }

  /**
   * Open the thread to its mail and hand over what it held; how many reached
   * the session now. Gmail failing for a moment fails nothing: the thread is
   * open by then, so the inbox's next poll hands over what is still held.
   */
  async function releaseHeld(threadKey: string): Promise<number> {
    try {
      return (await releaseHeldMail(threadKey)).released;
    } catch (error) {
      if (!(error instanceof GoogleApiError) || !error.retryable) throw error;
      log.warn('Held mail waits for the next inbox poll: Gmail could not be read', { threadKey, err: error });
      return 0;
    }
  }

  /** Which brief opens a held thread: as it came in, or taken up again after an earlier conversation had it. */
  async function heldSetting(meeting: Meeting, origin: ThreadOrigin): Promise<BriefSetting> {
    if (await hadEarlierMeetingOnThread(meeting.thread_key, meeting.id)) return 'held-again';
    return origin === 'copy-in' ? 'copied-in' : 'inbound';
  }

  /**
   * Bind the meeting to its thread and session, write the brief, and only
   * then let the thread's mail in. Every step is safe to repeat, so a replay
   * after a restart finishes what the first attempt began.
   */
  async function openMeeting(meeting: Meeting, opening: Opening): Promise<Meeting> {
    let session: Session;
    let setting: BriefSetting;
    if (opening.kind === 'takeover') {
      session = opening.session;
      setting = 'continuing';
    } else {
      if (opening.kind === 'new') {
        await authorizeThread({
          kind: 'new',
          threadKey: meeting.thread_key,
          opener: opening.opener,
          subject: meeting.purpose,
          counterparts: meeting.counterparts.map((counterpart) => counterpart.address),
          copyPrincipal: opening.copyPrincipal,
        });
        setting = 'new-thread';
      } else {
        const thread = await authorizeThread({ kind: 'held', threadKey: meeting.thread_key });
        // The people main added join the thread's own, on To.
        const onThread = new Set(everyoneOn(thread.people));
        const added = meeting.counterparts.map((c) => c.address).filter((address) => !onThread.has(address));
        if (added.length > 0) await addThreadPeople(meeting.thread_key, added, 'to');
        // Everyone the meeting carries a record for is vouched for: the thread keeps it for any later job.
        await vouchThreadPeople(
          meeting.thread_key,
          meeting.counterparts.filter((c) => c.person_id !== null).map((c) => c.address),
        );
        setting = await heldSetting(meeting, thread.origin);
      }
      ({ session } = await openThreadSession(meeting.thread_key));
    }
    await updateMeeting(meeting.id, { session_id: session.id }, new Date().toISOString());
    await writeBrief({ ...meeting, session_id: session.id }, session, 1, setting);
    await updateMeeting(meeting.id, { brief_version: 1 }, new Date().toISOString());
    const released = opening.kind === 'takeover' ? 0 : await releaseHeld(meeting.thread_key);
    // Held mail reaching the session woke it; otherwise the brief does.
    if (released === 0) await requestWake(session, 'inbound-message');
    await updateMeeting(meeting.id, { state: 'active' }, new Date().toISOString());
    return requireMeeting(meeting.id);
  }

  /** Undo what a meeting that failed to open began, so nothing is left half-open. */
  async function abandon(meeting: Meeting): Promise<void> {
    const at = new Date().toISOString();
    /* eslint-disable no-catch-all/no-catch-all -- the request already failed; undoing is best effort and logged */
    try {
      if (meeting.replaces_meeting_id !== null) {
        const replaced = meeting.replaces_meeting_id;
        await getDb().transaction(async () => {
          await updateMeeting(meeting.id, { state: 'failed', ended_at: at }, at);
          await getDb().run(
            "UPDATE gws_ea_meetings SET state = 'booked', ended_at = NULL, updated_at = ? WHERE id = ? AND state = 'superseded'",
            at,
            replaced,
          );
        });
        return;
      }
      await updateMeeting(meeting.id, { state: 'failed', ended_at: at }, at);
      const thread = await getThreadParticipants(meeting.thread_key);
      if (!thread || thread.state === 'closed' || thread.state === 'awaiting-arrange') return;
      // A thread held for main stays main's to take over again, its held mail kept.
      // Either way its mail stops first, so none reaches the session being closed.
      if (isHeldOrigin(thread.origin)) await handBackHeldThread(meeting.thread_key);
      else await closeThread(meeting.thread_key);
      if (thread.sessionId !== null) await closeSession(thread.sessionId, true);
    } catch (err) {
      log.error('A meeting that failed to open could not be undone', { meetingId: meeting.id, err });
    }
    /* eslint-enable no-catch-all/no-catch-all */
  }

  const KIND_WORDS: Readonly<Record<SchedulingKind, string>> = {
    arrange: 'to arrange',
    reschedule: 'to move',
    ask_organizer: 'to ask its organizer about',
  };

  function openedAnswer(meeting: Meeting): Answer {
    return {
      meetingId: meeting.id,
      data: {
        meeting_id: meeting.id,
        thread_key: meeting.thread_key,
        level: meeting.level,
        message: isScheduling(meeting)
          ? `external-email has meeting ${meeting.id} ${KIND_WORDS[meeting.kind]}, with ${who(meeting)}; its level is ${meeting.level}. ` +
            'You will get a note when it is booked or ends.'
          : `external-email is writing one reply in thread ${meeting.thread_key}, to ${who(meeting)} (meeting ${meeting.id}). ` +
            'You will get a note once it has gone.',
      },
    };
  }

  async function openOrAbandon(meeting: Meeting, opening: Opening): Promise<Answer> {
    try {
      return openedAnswer(await openMeeting(meeting, opening));
    } catch (error) {
      await abandon(meeting);
      throw error;
    }
  }

  function bookedDirectlyAnswer(meeting: Meeting, booking: Booking, timezone: string): Answer {
    const minutes = Math.round((Date.parse(booking.end_at) - Date.parse(booking.start_at)) / MINUTE);
    return {
      meetingId: meeting.id,
      data: {
        meeting_id: meeting.id,
        state: 'booked',
        booking: {
          calendar_id: booking.calendar_id,
          event_id: booking.event_id,
          start: booking.start_at,
          end: booking.end_at,
        },
        message:
          `Booked directly: "${meeting.purpose}" with ${who(meeting)}, ${formatLocalTime(booking.start_at, timezone)} ` +
          `(${minutes} minutes), on calendar ${booking.calendar_id}. Their calendars showed the time free, so Google's ` +
          'invitation went to them and nobody was emailed. Tell the principal in one line.',
      },
    };
  }

  /**
   * A new meeting with colleagues alone whose free/busy is visible is booked
   * at once (R11); any other goes to external-email by email.
   */
  async function openArranged(meeting: Meeting, opening: Opening): Promise<Answer> {
    if (opening.kind === 'new' && meeting.kind === 'arrange') {
      let booking: Booking | undefined;
      try {
        booking = await deps.bookDirectly(meeting);
      } catch (error) {
        await abandon(meeting);
        throw error;
      }
      if (booking) {
        const at = new Date().toISOString();
        await updateMeeting(meeting.id, { state: 'booked' }, at);
        await clearDeadlines(meeting.id, at);
        return bookedDirectlyAnswer(meeting, booking, await mainTimezone());
      }
    }
    return openOrAbandon(meeting, opening);
  }

  /**
   * Finish a meeting a replayed request had already created. `copyPrincipal`
   * is the replayed request's own, for a new thread not yet authorized.
   */
  async function resume(meeting: Meeting, copyPrincipal = false): Promise<Answer> {
    if (meeting.state === 'booked' && meeting.session_id === null) {
      const booking = await getBooking(meeting.id);
      if (booking) return bookedDirectlyAnswer(meeting, booking, await mainTimezone());
    }
    if (meeting.state === 'active' || meeting.state === 'booked' || meeting.state === 'responded') {
      return openedAnswer(meeting);
    }
    if (meeting.state !== 'opening') throw refused(`Meeting ${meeting.id} did not open (${meeting.state})`);
    if (meeting.replaces_meeting_id !== null) {
      const session = meeting.session_id === null ? undefined : await getSession(meeting.session_id);
      if (!session) throw refused(`Meeting ${meeting.id} lost the session it was taking over`);
      return openOrAbandon(meeting, { kind: 'takeover', session });
    }
    const thread = await getThreadParticipants(meeting.thread_key);
    if (thread !== undefined && isHeldOrigin(thread.origin)) return openOrAbandon(meeting, { kind: 'held' });
    const opening: Opening = {
      kind: 'new',
      opener: meeting.kind === 'ask_organizer' ? 'ask_organizer' : 'arrange',
      copyPrincipal,
    };
    // No thread yet: the first attempt stopped before choosing between booking directly and email.
    return thread === undefined ? openArranged(meeting, opening) : openOrAbandon(meeting, opening);
  }

  interface Creation {
    readonly terms: MeetingTerms;
    readonly session: Session;
    readonly requestId: string;
    readonly counterparts: readonly MeetingCounterpart[];
    readonly bookingCalendarId: string | null;
    readonly event: { readonly calendarId: string; readonly eventId: string } | null;
    readonly purpose: string;
    readonly constraints: string | undefined;
    readonly meetingKind: string | undefined;
    readonly threadKey: string;
    /** A booked meeting whose thread and session this one takes over. */
    readonly replaces?: Meeting;
    /** The room this reschedule makes: for which meeting, by moving which, and the time it frees. */
    readonly room?: { readonly forMeetingId: string; readonly candidate: RoomCandidate };
  }

  /** A scheduling meeting's terms: its kind, length, and window. */
  function scheduling(kind: SchedulingKind, lengthMinutes: number, window: Window): MeetingTerms {
    return { kind, length_minutes: lengthMinutes, window_start: window.start, window_end: window.end };
  }

  async function createMeeting(creation: Creation): Promise<Meeting> {
    const id = `mtg-${randomUUID()}`;
    const at = new Date().toISOString();
    try {
      await getDb().transaction(async () => {
        if (creation.replaces) {
          await updateMeeting(creation.replaces.id, { state: 'superseded', ended_at: at }, at);
        }
        await insertMeeting(
          {
            ...creation.terms,
            id,
            requested_by_session: creation.session.id,
            request_id: creation.requestId,
            level: lowestLevel(creation.counterparts.map((counterpart) => counterpart.level)),
            booking_calendar_id: creation.bookingCalendarId,
            event_calendar_id: creation.event?.calendarId ?? null,
            event_id: creation.event?.eventId ?? null,
            purpose: creation.purpose,
            constraints: creation.constraints ?? null,
            meeting_kind: creation.meetingKind ?? null,
            thread_key: creation.threadKey,
            replaces_meeting_id: creation.replaces?.id ?? null,
          },
          creation.counterparts,
          at,
        );
        if (creation.replaces?.session_id) {
          await updateMeeting(id, { session_id: creation.replaces.session_id }, at);
        }
        if (creation.room) {
          await insertRoom({
            by_meeting_id: id,
            for_meeting_id: creation.room.forMeetingId,
            moved_meeting_id: creation.room.candidate.meeting_id,
            start_at: creation.room.candidate.frees.start,
            end_at: creation.room.candidate.frees.end,
            chosen_at: at,
          });
        }
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const live = await findLiveMeetingOnThread(creation.threadKey);
      throw refused(`That thread already has meeting ${live?.id ?? 'in progress'}`);
    }
    return requireMeeting(id);
  }

  // -------------------------------------------------------------------------
  // main's requests
  // -------------------------------------------------------------------------

  async function arrange(content: Record<string, unknown>, session: Session, requestId: string): Promise<Answer> {
    const copyPrincipal = copyPrincipalOf(content);
    const existing = await findMeetingByRequest(session.id, requestId);
    if (existing) return resume(existing, copyPrincipal);
    const at = new Date();
    const people = peopleOf(content.people);
    const threadKey = threadKeyOf(content);
    const calendarId = calendarIdOf(content);
    const lengthMinutes = lengthOf(content.length_minutes);
    const window = checkedWindow(windowOf(content), lengthMinutes, at);
    const purpose = text(content.purpose, 'purpose', PURPOSE_MAX);
    const constraints = optionalText(content.constraints, 'constraints', CONSTRAINTS_MAX);
    const meetingKind = meetingKindOf(content);
    const book = await addressBook();
    const named = await Promise.all((people ?? []).map((ref) => counterpartFor(ref, book)));

    let counterparts: MeetingCounterpart[];
    let opening: Opening;
    if (threadKey !== undefined) {
      if (copyPrincipal) {
        throw invalid(
          'copy_principal is only for a new thread: on a thread that already exists, the principal is where its mail put them',
        );
      }
      // The thread's own people, from its mail, and anyone main adds.
      counterparts = withNamed(await threadCounterparts(await requireHeldThread(threadKey), book), named);
      if (counterparts.length === 0) throw refused('Nobody but the principal is on that thread');
      opening = { kind: 'held' };
    } else {
      if (people === undefined) {
        throw invalid('Name the people to meet, or the thread_key the note about an email gave you');
      }
      counterparts = distinct(named);
      opening = { kind: 'new', opener: 'arrange', copyPrincipal };
    }
    const bookingCalendarId = await requirePrincipalCalendar(calendarId, true);
    await assertShareable(purpose, constraints);
    const meeting = await createMeeting({
      terms: scheduling('arrange', lengthMinutes, window),
      session,
      requestId,
      counterparts,
      bookingCalendarId,
      event: null,
      purpose,
      constraints,
      meetingKind,
      threadKey: threadKey ?? mintThreadKey(),
    });
    return openArranged(meeting, opening);
  }

  async function reschedule(content: Record<string, unknown>, session: Session, requestId: string): Promise<Answer> {
    const existing = await findMeetingByRequest(session.id, requestId);
    if (existing) return resume(existing);
    const at = new Date();
    const calendarId = calendarIdOf(content);
    const eventId = eventIdOf(content);
    const askedLength = content.length_minutes === undefined ? undefined : lengthOf(content.length_minutes);
    const window = windowOf(content);
    const purpose = text(content.purpose, 'purpose', PURPOSE_MAX);
    const constraints = optionalText(content.constraints, 'constraints', CONSTRAINTS_MAX);
    const meetingKind = meetingKindOf(content);
    const roomForId =
      content.making_room_for === undefined || content.making_room_for === null
        ? undefined
        : meetingIdOf(content, 'making_room_for');

    const bookingCalendarId = await requirePrincipalCalendar(calendarId, true);
    const { event, minutes } = await requireTimedEvent(bookingCalendarId, eventId);
    const book = await addressBook();
    if (!organizedByPrincipal(event, bookingCalendarId, book)) {
      throw refused(
        'Someone else organizes that event, so it cannot be moved from here: use ask_organizer to ask its organizer instead.',
      );
    }
    const addresses = guestsOf(event, book);
    if (addresses.length === 0) throw refused('Nobody else is invited to that event: move it on the calendar yourself');
    const lengthMinutes = askedLength ?? minutes;
    if (lengthMinutes < MIN_LENGTH || lengthMinutes > MAX_LENGTH) {
      throw refused(
        `The event lasts ${lengthMinutes} minutes; give a length_minutes from ${MIN_LENGTH} to ${MAX_LENGTH}`,
      );
    }
    checkedWindow(window, lengthMinutes, at);
    await assertShareable(purpose, constraints);
    const live = await findLiveMeetingForEvent(bookingCalendarId, eventId);
    if (live) throw refused(`Meeting ${live.id} is already working on that event: amend or cancel it instead`);
    const room = roomForId === undefined ? undefined : await roomFor(roomForId, bookingCalendarId, eventId);
    const counterparts = await Promise.all(addresses.map((address) => counterpartForAddress(address)));
    const creation: Omit<Creation, 'threadKey' | 'replaces'> = {
      terms: scheduling('reschedule', lengthMinutes, window),
      session,
      requestId,
      counterparts,
      bookingCalendarId,
      event: { calendarId: bookingCalendarId, eventId },
      purpose,
      constraints,
      meetingKind,
      ...(room ? { room } : {}),
    };

    // A meeting the assistant booked keeps its thread: the new job continues there.
    const booked = await findBookedMeetingForEvent(bookingCalendarId, eventId);
    const bookedSession = booked?.session_id ? await getSession(booked.session_id) : undefined;
    const bookedThread = booked ? await getThreadParticipants(booked.thread_key) : undefined;
    if (booked && bookedSession?.status === 'active' && bookedThread?.state === 'open') {
      const meeting = await createMeeting({ ...creation, threadKey: booked.thread_key, replaces: booked });
      return openOrAbandon(meeting, { kind: 'takeover', session: bookedSession });
    }
    const meeting = await createMeeting({ ...creation, threadKey: mintThreadKey() });
    return openOrAbandon(meeting, { kind: 'new', opener: 'arrange', copyPrincipal: false });
  }

  /**
   * The room a reschedule makes (R14, R23): only for a meeting still waiting
   * for room after it reported needs-room, and only by moving a meeting the
   * host lists as a candidate for it now.
   */
  async function roomFor(
    forMeetingId: string,
    calendarId: string,
    eventId: string,
  ): Promise<{ readonly forMeetingId: string; readonly candidate: RoomCandidate }> {
    const forMeeting = await requireMeeting(forMeetingId);
    const waiting =
      forMeeting.state === 'active' &&
      forMeeting.ended_at === null &&
      (await getRecordedOutcome(forMeeting.id, 'needs-room')) !== undefined;
    if (!waiting || !isScheduling(forMeeting)) {
      throw refused(`Meeting ${forMeeting.id} is not waiting for room: make room only for a meeting that needs it`);
    }
    return { forMeetingId, candidate: await deps.roomCandidate(forMeeting, calendarId, eventId) };
  }

  async function askOrganizer(content: Record<string, unknown>, session: Session, requestId: string): Promise<Answer> {
    const existing = await findMeetingByRequest(session.id, requestId);
    if (existing) return resume(existing);
    const at = new Date();
    const calendarId = calendarIdOf(content);
    const eventId = eventIdOf(content);
    const window = windowOf(content);
    const purpose = text(content.purpose, 'purpose', PURPOSE_MAX);
    const constraints = optionalText(content.constraints, 'constraints', CONSTRAINTS_MAX);

    const principalCalendar = await requirePrincipalCalendar(calendarId, false);
    const { event, minutes } = await requireTimedEvent(principalCalendar, eventId);
    const book = await addressBook();
    const organizer = normalizeAddress(event.organizer?.email ?? '');
    if (organizer === undefined) throw refused('Google reports no organizer for that invitation');
    if (book.principal.has(organizer) || organizer === principalCalendar.toLowerCase()) {
      throw refused('The principal organizes that event: use reschedule to move it');
    }
    if (book.assistant.has(organizer)) throw refused('The assistant organizes that event');
    // An organizer without a record is judged like anyone else (R16): main decided to ask them.
    const counterpart = await counterpartForAddress(organizer);
    if (minutes < MIN_LENGTH || minutes > MAX_LENGTH) {
      throw refused(`That invitation lasts ${minutes} minutes, which is too long to move this way`);
    }
    checkedWindow(window, minutes, at);
    await assertShareable(purpose, constraints);
    const live = await findLiveMeetingForEvent(principalCalendar, eventId);
    if (live) throw refused(`Meeting ${live.id} is already asking about that invitation`);
    const meeting = await createMeeting({
      terms: scheduling('ask_organizer', minutes, window),
      session,
      requestId,
      counterparts: [counterpart],
      bookingCalendarId: null,
      event: { calendarId: principalCalendar, eventId },
      purpose,
      constraints,
      meetingKind: undefined,
      threadKey: mintThreadKey(),
    });
    return openOrAbandon(meeting, { kind: 'new', opener: 'ask_organizer', copyPrincipal: false });
  }

  /**
   * One reply in a thread waiting for main (KTD16): to decline with an
   * alternative, route, acknowledge, or send a holding line. The reply goes
   * to everyone on the thread, and once it has been delivered the thread is
   * held for main again.
   */
  async function respond(content: Record<string, unknown>, session: Session, requestId: string): Promise<Answer> {
    const existing = await findMeetingByRequest(session.id, requestId);
    if (existing) return resume(existing);
    const threadKey = requiredThreadKeyOf(content);
    const purpose = text(content.purpose, 'purpose', REPLY_PURPOSE_MAX);
    const constraints = optionalText(content.constraints, 'constraints', CONSTRAINTS_MAX);
    const counterparts = await threadCounterparts(await requireHeldThread(threadKey), await addressBook());
    if (counterparts.length === 0) throw refused('Nobody but the principal is on that thread');
    await assertShareable(purpose, constraints);
    const meeting = await createMeeting({
      terms: { kind: 'respond', length_minutes: null, window_start: null, window_end: null },
      session,
      requestId,
      counterparts,
      bookingCalendarId: null,
      event: null,
      purpose,
      constraints,
      meetingKind: undefined,
      threadKey,
    });
    return openOrAbandon(meeting, { kind: 'held' });
  }

  /** Close a thread waiting for main with nothing sent: later mail in it starts a new one. */
  async function dismiss(content: Record<string, unknown>): Promise<Answer> {
    const threadKey = requiredThreadKeyOf(content);
    const thread = await getThreadParticipants(threadKey);
    if (!thread || !isHeldOrigin(thread.origin)) {
      throw refused(`${threadKey} is not a thread waiting for you: use the thread_key a note about an email gave you`);
    }
    const live = await findLiveMeetingOnThread(threadKey);
    if (live) throw refused(`Thread ${threadKey} has meeting ${live.id} in progress: cancel it instead`);
    if (thread.state !== 'closed') await closeThread(threadKey);
    await deleteThreadRecord({ channelType: EMAIL_CHANNEL_TYPE, platformId: INBOX_PLATFORM_ID, threadId: threadKey });
    if (thread.sessionId !== null) await closeSession(thread.sessionId, false);
    return {
      meetingId: null,
      data: {
        thread_key: threadKey,
        state: 'closed',
        message: `Thread ${threadKey} is closed and nothing was sent. Mail in it from now on reaches you as a new email.`,
      },
    };
  }

  /** Answer the principal's own email by email, to them alone, in its Gmail thread (R41). */
  async function replyToPrincipal(
    content: Record<string, unknown>,
    session: Session,
    requestId: string,
  ): Promise<Answer> {
    const gmailMessageId = content.gmail_message_id;
    if (typeof gmailMessageId !== 'string' || !GMAIL_MESSAGE_ID.test(gmailMessageId)) {
      throw invalid('gmail_message_id must be the Gmail message id the note about the principal’s email gave you');
    }
    const body = bodyText(content.text, 'text', PRINCIPAL_REPLY_MAX);
    if (!(await getPrincipalMessage(gmailMessageId))) {
      throw refused(
        `Gmail message ${gmailMessageId} is not one Gmail verified the principal sent you: reply_to_principal answers only the principal's own email`,
      );
    }
    // Unique per request, so a replay sends nothing twice and two answers to one email both go.
    const replyId = await sendPrincipalReply({ gmailMessageId, text: body, requestId: `${session.id}:${requestId}` });
    return {
      meetingId: null,
      data: {
        gmail_message_id: gmailMessageId,
        reply_id: replyId,
        message: 'Your reply went to the principal by email, in their thread. Do not repeat it here.',
      },
    };
  }

  async function cancel(content: Record<string, unknown>): Promise<Answer> {
    const namesEvent = content.calendar_id !== undefined || content.event_id !== undefined;
    if (content.meeting_id !== undefined) {
      if (namesEvent) throw invalid('Give either meeting_id, or calendar_id with event_id, not both');
      return cancelMeeting(await requireMeeting(meetingIdOf(content)));
    }
    if (namesEvent) return cancelEvent(calendarIdOf(content), eventIdOf(content));
    throw invalid(
      'Give the meeting_id of a meeting you handed over, or the calendar_id and event_id of an event the principal organizes',
    );
  }

  /** End a meeting as cancelled and tell the people the assistant wrote to; true when they were told. */
  async function endCancelled(meeting: Meeting): Promise<boolean> {
    let told = false;
    await endMeeting(meeting, 'cancelled', true, async () => {
      told = await sendCancelLine(meeting);
    });
    return told;
  }

  async function cancelMeeting(meeting: Meeting): Promise<Answer> {
    if (!isLive(meeting.state) && meeting.state !== 'cancelled') {
      throw refused(`Meeting ${meeting.id} has already ended (${meeting.state})`);
    }
    if (meeting.state === 'booked' && meeting.ended_at !== null) {
      throw refused(`Meeting ${meeting.id} has already ended: its event has passed`);
    }
    if (!isScheduling(meeting)) {
      // A reply not yet reported: nothing more goes out, and the thread waits for main again.
      await handBack(meeting, 'cancelled', true);
      return {
        meetingId: meeting.id,
        data: {
          meeting_id: meeting.id,
          state: 'cancelled',
          thread_key: meeting.thread_key,
          message:
            `The reply in thread ${meeting.thread_key} is called off, and nothing more goes out in it` +
            (meeting.replied_at === null ? '. ' : ', though its reply had already gone. ') +
            'The thread waits for you again.',
        },
      };
    }
    const told = await endCancelled(meeting);
    return {
      meetingId: meeting.id,
      data: {
        meeting_id: meeting.id,
        state: 'cancelled',
        counterparts_told: told,
        message: told
          ? `Meeting ${meeting.id} is cancelled, its conversation closed, and ${who(meeting)} told in one line.`
          : `Meeting ${meeting.id} is cancelled and its conversation closed. The assistant had not written to ${who(meeting)}, so nobody was told.`,
      },
    };
  }

  /**
   * Cancel an event the principal organizes with others (R8): Google's own
   * cancellation notice goes to its guests, as a human assistant's delete
   * would send, and a meeting the assistant was working on for that event
   * ends as a cancelled meeting does.
   */
  async function cancelEvent(requestedCalendarId: string, eventId: string): Promise<Answer> {
    const calendarId = await requirePrincipalCalendar(requestedCalendarId, true);
    const event = await calendar().getEvent(calendarId, eventId);
    if (!event) throw refused(`There is no event ${eventId} on calendar ${calendarId}`);
    const book = await addressBook();
    const alreadyCancelled = event.status === 'cancelled';
    if (!alreadyCancelled && !organizedByPrincipal(event, calendarId, book)) {
      throw refused(
        'Someone else organizes that event, so it cannot be cancelled from here: use ask_organizer to ask its organizer, or decline it.',
      );
    }
    const guests = guestsOf(event, book);
    if (!alreadyCancelled && guests.length === 0) {
      throw refused('Nobody else is invited to that event: delete it on the calendar yourself');
    }
    const bound = [
      await findLiveMeetingForEvent(calendarId, eventId),
      await findBookedMeetingForEvent(calendarId, eventId),
    ].filter((meeting): meeting is Meeting => meeting !== undefined);
    if (!alreadyCancelled) {
      await calendar().deleteEvent(calendarId, eventId, 'all');
      recordOwnCalendarChange(calendarId, eventId);
    }
    for (const meeting of bound) await endCancelled(meeting);

    const span = eventSpan(event, await principalTimezone());
    const when = span ? ` at ${formatLocalTime(new Date(span.start).toISOString(), await mainTimezone())}` : '';
    const ended = bound.length > 0 ? `, and meeting ${bound.map((meeting) => meeting.id).join(', ')} is ended` : '';
    return {
      meetingId: bound[0]?.id ?? null,
      data: {
        calendar_id: calendarId,
        event_id: eventId,
        state: 'cancelled',
        ...(bound.length > 0 ? { meeting_id: bound[0].id } : {}),
        guests,
        message: alreadyCancelled
          ? `The event${when} on calendar ${calendarId} was already cancelled; nothing more was sent.`
          : `The event${when} on calendar ${calendarId} is cancelled. Google sent its guests (${guests.join(', ')}) ` +
            `its own cancellation notice${ended}. Tell the principal in one line.`,
      },
    };
  }

  async function amend(content: Record<string, unknown>): Promise<Answer> {
    const meeting = await requireMeeting(meetingIdOf(content));
    if (meeting.state !== 'active') {
      throw refused(`Meeting ${meeting.id} is ${meeting.state}: only a meeting still being arranged can be amended`);
    }
    if (!isScheduling(meeting)) {
      throw refused(`Meeting ${meeting.id} writes one reply and has nothing to amend: cancel it and respond again`);
    }
    const changes = ['length_minutes', 'window_start', 'window_end', 'constraints', 'people'].filter(
      (key) => content[key] !== undefined,
    );
    if (changes.length === 0) {
      throw invalid('Give a new length_minutes, window_start, window_end, or constraints, or people to add');
    }
    const people = peopleOf(content.people);
    if (people !== undefined && meeting.kind !== 'arrange') {
      throw refused(
        "Only a meeting handed over with arrange takes new people: moving an event, or asking its organizer, reaches the event's own guests.",
      );
    }
    const lengthMinutes =
      content.length_minutes === undefined ? meeting.length_minutes : lengthOf(content.length_minutes);
    const window = checkedWindow(
      {
        start:
          content.window_start === undefined ? meeting.window_start : instantOf(content.window_start, 'window_start'),
        end: content.window_end === undefined ? meeting.window_end : instantOf(content.window_end, 'window_end'),
      },
      lengthMinutes,
      new Date(),
    );
    const constraints =
      content.constraints === undefined
        ? (meeting.constraints ?? undefined)
        : text(content.constraints, 'constraints', CONSTRAINTS_MAX);
    const book = await addressBook();
    const named = distinct(await Promise.all((people ?? []).map((ref) => counterpartFor(ref, book))));
    const added = named.filter((person) => !meeting.counterparts.some((c) => c.address === person.address));
    await assertShareable(undefined, constraints);
    const session = meeting.session_id === null ? undefined : await getSession(meeting.session_id);
    if (!session) throw refused(`Meeting ${meeting.id} has no conversation to brief`);

    const version = meeting.brief_version + 1;
    const at = new Date().toISOString();
    if (added.length > 0) {
      // Only main adds someone (R40): on the thread, on To, and in the meeting, whose level becomes the lowest.
      await addThreadPeople(
        meeting.thread_key,
        added.map((person) => person.address),
        'to',
      );
      await addCounterparts(meeting.id, added, at);
    }
    await updateMeeting(
      meeting.id,
      {
        length_minutes: lengthMinutes,
        window_start: window.start,
        window_end: window.end,
        ...(constraints === undefined ? {} : { constraints }),
        brief_version: version,
      },
      at,
    );
    const amended = await requireMeeting(meeting.id);
    await writeBrief(amended, session, version, 'continuing', added);
    await requestWake(session, 'inbound-message');
    /* eslint-disable no-catch-all/no-catch-all -- the brief stands; a hold that no longer fits cannot be booked, and is released when the meeting ends */
    try {
      await deps.releaseHolds(amended, 'stale');
    } catch (err) {
      log.warn('Holds that no longer fit an amended meeting were not all released', { meetingId: meeting.id, err });
    }
    /* eslint-enable no-catch-all/no-catch-all */
    return {
      meetingId: meeting.id,
      data: {
        meeting_id: meeting.id,
        brief_version: version,
        level: amended.level,
        message:
          `Meeting ${meeting.id} has a new brief (version ${version}); external-email works from it now.` +
          (added.length === 0 ? '' : ` ${added.map(personText).join(', ')} joined the thread and the meeting.`),
      },
    };
  }

  // -------------------------------------------------------------------------
  // external-email's outcome
  // -------------------------------------------------------------------------

  /** The outcomes a meeting that finds a time reports; a reply reports only `responded`. */
  type SchedulingOutcome = Exclude<Outcome, 'responded'>;

  /** The state each outcome leaves its meeting in. */
  const OUTCOME_STATES: Readonly<Record<SchedulingOutcome, MeetingState>> = {
    booked: 'booked',
    settled: 'settled',
    'needs-room': 'active',
    'not-scheduling': 'not-scheduling',
    'gave-up': 'gave-up',
  };

  /** What a note adds about room: the meeting that moved for this one, or the one a failed move was for. */
  interface RoomContext {
    readonly candidates?: readonly RoomCandidate[];
    readonly madeRoomBy?: NonNullable<OutcomeNote['made_room_by']>;
    /** The meeting a reschedule was making room for, while that room is still unmade. */
    readonly roomFor?: Meeting;
  }

  function candidateLine(candidate: RoomCandidate, timezone: string): string {
    const people = candidate.people.map((person) => `${person.name ?? person.address} (${person.level})`).join(', ');
    return (
      `- meeting ${candidate.meeting_id}: "${candidate.purpose}" with ${people}, ${formatLocalTime(candidate.start, timezone)} ` +
      `(calendar_id ${candidate.calendar_id}, event_id ${candidate.event_id}); it frees ${formatLocalTime(candidate.frees.start, timezone)}`
    );
  }

  function needsRoomText(meeting: Meeting, candidates: readonly RoomCandidate[], timezone: string): string {
    const opening = `Meeting ${meeting.id} with ${who(meeting)} (${meeting.level}) needs room: nothing open in its window fits.`;
    if (candidates.length === 0) {
      return (
        `${opening} No meeting the assistant arranged with someone who matters less can move to make it, and the principal's own ` +
        'events and invitations from others never move for it. Move nothing: give the principal one recommendation in one line, ' +
        'such as which of their own plans could give way, or a later window.'
      );
    }
    return [
      `${opening} The assistant arranged these meetings with people who matter less, and moving one frees a time that fits:`,
      ...candidates.map((candidate) => candidateLine(candidate, timezone)),
      `To move one, reschedule it with making_room_for ${meeting.id}: the time it frees goes to this meeting. ` +
        'If none should move, move nothing and give the principal one recommendation in one line.',
    ].join('\n');
  }

  function outcomeText(
    meeting: Meeting,
    outcome: SchedulingOutcome,
    booking: Booking | undefined,
    timezone: string,
    room: RoomContext,
  ): string {
    switch (outcome) {
      case 'booked': {
        if (!booking) throw new Error('A booked note needs its booking');
        const moved = meeting.kind === 'reschedule' ? 'moved to' : 'booked for';
        const minutes = Math.round((Date.parse(booking.end_at) - Date.parse(booking.start_at)) / MINUTE);
        const madeRoom = room.madeRoomBy
          ? ` To make room for it, "${room.madeRoomBy.purpose}" with ${who(room.madeRoomBy)} moved` +
            (room.madeRoomBy.moved_to ? ` to ${formatLocalTime(room.madeRoomBy.moved_to.start, timezone)}.` : '.')
          : '';
        return (
          `Meeting ${meeting.id} is ${moved} ${formatLocalTime(booking.start_at, timezone)} (${minutes} minutes): ` +
          `"${meeting.purpose}" with ${who(meeting)}, on calendar ${booking.calendar_id}.${madeRoom} Tell the principal in one line.`
        );
      }
      case 'settled':
        return (
          `${who(meeting)} moved their invitation, so it no longer conflicts (meeting ${meeting.id}, "${meeting.purpose}"). ` +
          'Tell the principal in one line.'
        );
      case 'needs-room':
        return needsRoomText(meeting, room.candidates ?? [], timezone);
      case 'not-scheduling':
        return (
          `Thread ${meeting.thread_key} with ${who(meeting)} is not about scheduling, so external-email sent nothing in it (meeting ${meeting.id}). ` +
          `It waits for you again: triage it like any other email. Answer it with respond, with thread_key ${meeting.thread_key}, ` +
          'or close it with dismiss, and tell the principal only if it needs them.'
        );
      case 'gave-up':
        return (
          `external-email gave up on meeting ${meeting.id}, "${meeting.purpose}" with ${who(meeting)}: no time was agreed. ` +
          'Tell the principal in one line, with a suggestion.' +
          roomStillNeeded(room)
        );
      default: {
        const unreachable: never = outcome;
        throw new Error(`Unknown outcome ${String(unreachable)}`);
      }
    }
  }

  /** For a move that was making room and ended without it: that meeting still needs room. */
  function roomStillNeeded(room: RoomContext): string {
    return room.roomFor
      ? ` It was moving to make room for meeting ${room.roomFor.id} with ${who(room.roomFor)}, which still needs room: ` +
          'move another meeting the needs-room note listed, or tell the principal in one line with your recommendation.'
      : '';
  }

  /** What a note about this outcome says about room. */
  async function roomContext(meeting: SchedulingMeeting, outcome: SchedulingOutcome): Promise<RoomContext> {
    switch (outcome) {
      case 'needs-room':
        return { candidates: await deps.roomCandidates(meeting) };
      case 'booked': {
        const given = await getRoomGivenTo(meeting.id);
        const moved = given ? await getMeeting(given.moved_meeting_id) : undefined;
        if (!given || !moved) return {};
        const movedTo = await getBooking(given.by_meeting_id);
        return {
          madeRoomBy: {
            meeting_id: moved.id,
            purpose: moved.purpose,
            counterparts: noteCounterparts(moved),
            moved_to: movedTo ? { start: movedTo.start_at, end: movedTo.end_at } : null,
          },
        };
      }
      case 'gave-up': {
        const making = await getRoomMadeBy(meeting.id);
        const roomFor = making?.state === 'reserved' ? await getMeeting(making.for_meeting_id) : undefined;
        return roomFor ? { roomFor } : {};
      }
      case 'settled':
      case 'not-scheduling':
        return {};
      default: {
        const unreachable: never = outcome;
        throw new Error(`Unknown outcome ${String(unreachable)}`);
      }
    }
  }

  const OUTCOME_REPLIES: Readonly<Record<SchedulingOutcome, string>> = {
    booked:
      'Recorded: booked. The principal hears it from main. Stay ready in this thread for any change they ask for.',
    settled: 'Recorded: settled. This conversation is now closed: send nothing more in it.',
    'needs-room':
      'Recorded: needs-room. main decides whether to make room; wait for a message from the host before offering anything else.',
    'not-scheduling': 'Recorded: not-scheduling. This conversation is now closed: send nothing more in it.',
    'gave-up': 'Recorded: gave-up. This conversation is now closed: send nothing more in it.',
  };

  const RESPONDED_REPLY = 'Your reply has gone, and this conversation is closed: send nothing more in it.';
  const RESPONDED_PENDING_REPLY =
    'Noted: your reply has not gone yet. The host closes this conversation as soon as it has. ' +
    'If you have not written it, write it now, once; otherwise send nothing more.';

  /** Whether the invitation now sits at an offered time, or clear of everything else on the principal's calendars. */
  async function assertSettled(meeting: Meeting): Promise<void> {
    if (meeting.event_calendar_id === null || meeting.event_id === null) {
      throw refused('Report settled only for an invitation you asked its organizer to move');
    }
    const event = await calendar().getEvent(meeting.event_calendar_id, meeting.event_id);
    if (!event || event.status === 'cancelled') {
      throw refused(
        'The invitation is no longer on the principal’s calendar, so nothing was moved. Report gave-up if it is off.',
      );
    }
    const timezone = await principalTimezone();
    const span = eventSpan(event, timezone);
    if (!span) throw refused('Google reports no readable time for the invitation');
    const offered = await listOfferedSlots(meeting.id);
    if (offered.some((slot) => Date.parse(slot.start_at) === span.start && Date.parse(slot.end_at) === span.end)) {
      return;
    }
    const { principal } = await addressBook();
    const calendars = new Set([...(await listPrincipalCalendars()), meeting.event_calendar_id.toLowerCase()]);
    let conflicts = 0;
    for (const calendarId of calendars) {
      const events = await calendar().listEvents(
        calendarId,
        new Date(span.start).toISOString(),
        new Date(span.end).toISOString(),
      );
      conflicts += events.filter((other) => {
        if (other.id === event.id || (event.iCalUID !== undefined && other.iCalUID === event.iCalUID)) return false;
        if (!blocksTime(other, principal)) return false;
        const otherSpan = eventSpan(other, timezone);
        return otherSpan !== undefined && otherSpan.start < span.end && otherSpan.end > span.start;
      }).length;
    }
    if (conflicts > 0) {
      throw refused(
        `The invitation still conflicts with ${conflicts === 1 ? 'an event' : `${conflicts} events`} on the principal's calendars. ` +
          'Report settled once the organizer has moved it to a time you offered.',
      );
    }
  }

  async function outcome(content: Record<string, unknown>, session: Session, requestId: string): Promise<Answer> {
    const meeting = await requireMeeting(meetingIdOf(content));
    const kind = OUTCOMES.find((value) => value === content.outcome);
    if (kind === undefined) throw invalid(`outcome must be one of ${OUTCOMES.join(', ')}`);
    if (meeting.session_id !== session.id) throw refused("That meeting is not this conversation's");
    if (!isScheduling(meeting)) {
      if (kind !== 'responded') {
        throw refused('This conversation writes one reply: send it, then report responded with outcome.');
      }
      return responded(meeting);
    }
    if (kind === 'responded') {
      throw refused('Only a conversation briefed to write one reply reports responded.');
    }
    // needs-room leaves the meeting being arranged, and comes again when an amended window or a
    // turned-down room still leaves no time: each report is new. Every other outcome is reported once.
    const repeatable = kind === 'needs-room';
    const recorded = repeatable ? undefined : await getRecordedOutcome(meeting.id, kind);
    if (recorded !== undefined) return { meetingId: meeting.id, data: JSON.parse(recorded) as Record<string, unknown> };
    // A replay that stopped between the state change and the record finishes here.
    if (meeting.state !== 'active' && meeting.state !== OUTCOME_STATES[kind]) {
      throw refused(`Meeting ${meeting.id} takes no outcome now (${meeting.state})`);
    }

    let booking: Booking | undefined;
    switch (kind) {
      case 'booked':
        if (meeting.kind === 'ask_organizer')
          throw refused('An ask_organizer meeting ends settled or gave-up, never booked');
        booking = await getBooking(meeting.id);
        if (!booking) throw refused('Report booked only after book succeeded: this meeting has no booking yet');
        break;
      case 'settled':
        if (meeting.kind !== 'ask_organizer') throw refused('Only an ask_organizer meeting ends settled');
        await assertSettled(meeting);
        break;
      case 'needs-room':
        if (meeting.level !== 'inner-circle' && meeting.level !== 'close') {
          throw refused(
            `needs-room is only for someone in the inner circle or close; this meeting's level is ${meeting.level}. Offer the open times there are, or report gave-up.`,
          );
        }
        break;
      case 'not-scheduling': {
        const thread = await getThreadParticipants(meeting.thread_key);
        if (thread === undefined || !isHeldOrigin(thread.origin)) {
          throw refused(
            'not-scheduling is only for a thread that came to the assistant or that the principal copied you into; this one was opened to schedule',
          );
        }
        break;
      }
      case 'gave-up':
        break;
      default: {
        const unreachable: never = kind;
        throw new Error(`Unknown outcome ${String(unreachable)}`);
      }
    }

    const at = new Date().toISOString();
    const room = await roomContext(meeting, kind);
    const note: OutcomeNote = {
      type: OUTCOME_NOTE_TYPE,
      meeting_id: meeting.id,
      outcome: kind,
      kind: meeting.kind,
      purpose: meeting.purpose,
      level: meeting.level,
      counterparts: noteCounterparts(meeting),
      ...(room.candidates ? { candidates: room.candidates } : {}),
      ...(room.madeRoomBy ? { made_room_by: room.madeRoomBy } : {}),
      ...(booking
        ? {
            booking: {
              calendar_id: booking.calendar_id,
              event_id: booking.event_id,
              start: booking.start_at,
              end: booking.end_at,
            },
          }
        : {}),
      ...(kind === 'settled' && meeting.event_calendar_id !== null && meeting.event_id !== null
        ? { invitation: { calendar_id: meeting.event_calendar_id, event_id: meeting.event_id } }
        : {}),
      ...(kind === 'not-scheduling' ? { thread_key: meeting.thread_key } : {}),
    };
    // The note's id is fixed per meeting and outcome, or per needs-room report, so it is written
    // once however often this runs; the state changes after it are safe to repeat.
    await writeOutcomeNote(
      note,
      outcomeText(meeting, kind, booking, await mainTimezone(), room),
      at,
      repeatable ? requestId : undefined,
    );
    if (kind === 'booked') {
      await updateMeeting(meeting.id, { state: 'booked' }, at);
      await clearDeadlines(meeting.id, at);
    } else if (kind === 'not-scheduling') {
      // The thread is main's to triage again: respond in it, or dismiss it.
      await handBack(meeting, 'not-scheduling', false);
    } else if (kind !== 'needs-room') {
      await endMeeting(meeting, OUTCOME_STATES[kind], false);
    }
    const data = { meeting_id: meeting.id, outcome: kind, message: OUTCOME_REPLIES[kind] };
    await recordOutcome(meeting.id, kind, JSON.stringify(data), at);
    return { meetingId: meeting.id, data };
  }

  // -------------------------------------------------------------------------
  // A reply, once it has gone
  // -------------------------------------------------------------------------

  /**
   * external-email reports its one reply written. The reply's delivery ends
   * the job (`replyDelivered`), so the report changes nothing: it is answered
   * whether it comes before the reply has gone or after. A job whose ending a
   * stop cut short, after Gmail took its reply, is finished here.
   */
  async function responded(meeting: Meeting): Promise<Answer> {
    const answer = (message: string): Answer => ({
      meetingId: meeting.id,
      data: { meeting_id: meeting.id, outcome: 'responded', message },
    });
    if (meeting.state === 'responded') return answer(RESPONDED_REPLY);
    if (meeting.state !== 'active') throw refused(`Meeting ${meeting.id} takes no outcome now (${meeting.state})`);
    if (!(await replyWentOut(meeting))) return answer(RESPONDED_PENDING_REPLY);
    await endAfterReply(meeting);
    return answer(RESPONDED_REPLY);
  }

  /**
   * The live meeting a message or turn of `session` belongs to: the one bound
   * to that very conversation, in its own inbox thread.
   */
  async function meetingInThread(route: ThreadRoute, session: Session): Promise<Meeting | undefined> {
    if (route.channelType !== EMAIL_CHANNEL_TYPE || route.platformId !== INBOX_PLATFORM_ID || route.threadId === null) {
      return undefined;
    }
    if (!(await getDb().hasTable('gws_ea_meetings'))) return undefined;
    const meeting = await findLiveMeetingOnThread(route.threadId);
    return meeting?.session_id === session.id ? meeting : undefined;
  }

  /** A live reply job, from the very conversation `msg` came from, in its own thread. */
  async function replyJobFor(msg: OutboundMessage, session: Session): Promise<Meeting | undefined> {
    const meeting = await meetingInThread(msg, session);
    return meeting && !isScheduling(meeting) && meeting.state === 'active' ? meeting : undefined;
  }

  function replyNote(meeting: Meeting, outcome: 'responded' | 'gave-up'): OutcomeNote {
    return {
      type: OUTCOME_NOTE_TYPE,
      meeting_id: meeting.id,
      outcome,
      kind: meeting.kind,
      purpose: meeting.purpose,
      level: meeting.level,
      counterparts: noteCounterparts(meeting),
      thread_key: meeting.thread_key,
      ...(outcome === 'gave-up' ? { undelivered: true as const } : {}),
    };
  }

  /**
   * The reply went out: the thread is main's again at once, so later mail in
   * it is held for main and never reaches the conversation being closed;
   * main hears of the reply; the job ends. Safe to repeat.
   */
  async function finishReply(meeting: Meeting): Promise<void> {
    const at = new Date().toISOString();
    await handBack(meeting, 'responded', false, () =>
      writeOutcomeNote(
        replyNote(meeting, 'responded'),
        `external-email's reply went out in thread ${meeting.thread_key}, to ${who(meeting)} (meeting ${meeting.id}): ` +
          `"${meeting.purpose}". The thread waits for you again: if they write back, you will hear of it, and you can ` +
          `arrange, respond, or dismiss with thread_key ${meeting.thread_key}. Tell the principal only if it matters to them.`,
        at,
      ),
    );
    await recordOutcome(
      meeting.id,
      'responded',
      JSON.stringify({ meeting_id: meeting.id, outcome: 'responded', message: RESPONDED_REPLY }),
      at,
    );
  }

  /**
   * Whether a reply job's one reply has gone: delivery recorded it, or Gmail
   * took an email in its thread since the job began, which the inbox records
   * before delivery hears of it.
   */
  async function replyWentOut(meeting: Meeting): Promise<boolean> {
    return meeting.replied_at !== null || (await hasSentInThreadSince(meeting.thread_key, meeting.created_at));
  }

  /** The reply has gone: recorded first, so an ending cut short can be finished later; then the job ends. */
  async function endAfterReply(meeting: Meeting): Promise<void> {
    if (meeting.replied_at === null) {
      const at = new Date().toISOString();
      await updateMeeting(meeting.id, { replied_at: at }, at);
    }
    await finishReply(meeting);
  }

  /** Delivery recorded a message from a reply's conversation in its thread: the reply has gone, and the job ends. */
  async function replyDelivered(msg: OutboundMessage, session: Session): Promise<void> {
    const meeting = await replyJobFor(msg, session);
    if (meeting) await endAfterReply(meeting);
  }

  /**
   * Delivery gave up on emails a meeting's conversation wrote in its thread:
   * main hears of each, since the principal asked for nothing there.
   */
  async function sendsFailed(failed: readonly OutboundMessage[], session: Session): Promise<void> {
    for (const msg of failed) {
      const meeting = await meetingInThread(msg, session);
      if (!meeting) continue;
      if (isScheduling(meeting)) await sendFailed(meeting, msg);
      else if (meeting.state === 'active') await replyFailed(meeting);
    }
  }

  /** A reply's email could not be sent: the job ends unsent, and main hears why. */
  function replyFailed(meeting: Meeting): Promise<void> {
    return endUnsentReply(meeting, 'could not be sent: email delivery kept failing');
  }

  /**
   * A reply job whose ending was cut short. Delivery tells the host of a
   * reply's sending or failure once, so a stop or a failed note can leave
   * the job live part-way through ending. Each follow-through pass runs this:
   * a job whose reply Gmail took ends as responded; one whose thread already
   * went back to main, its reply never sent, ends unsent so main can respond
   * again. A job still at work is left alone. Safe to repeat.
   */
  async function finishCutShortReply(meeting: Meeting): Promise<void> {
    if (isScheduling(meeting) || meeting.state !== 'active') return;
    if (await replyWentOut(meeting)) {
      await endAfterReply(meeting);
      return;
    }
    if ((await getThreadParticipants(meeting.thread_key))?.state === 'awaiting-arrange') {
      await endUnsentReply(meeting, 'was not sent: its job stopped before the reply went out');
    }
  }

  /**
   * A reply job ends with its reply unsent: its thread goes back to main, and
   * main hears `why`, so it can respond again or tell the principal.
   */
  async function endUnsentReply(meeting: Meeting, why: string): Promise<void> {
    const at = new Date().toISOString();
    await handBack(meeting, 'gave-up', false, () =>
      writeOutcomeNote(
        replyNote(meeting, 'gave-up'),
        `external-email's reply in thread ${meeting.thread_key}, to ${who(meeting)} (meeting ${meeting.id}), ${why}. ` +
          `It was to "${meeting.purpose}". The thread waits for you again: try again with ` +
          `respond and thread_key ${meeting.thread_key}, or tell the principal in one line.`,
        at,
      ),
    );
    await recordOutcome(
      meeting.id,
      'gave-up',
      JSON.stringify({ meeting_id: meeting.id, outcome: 'gave-up', message: OUTCOME_REPLIES['gave-up'] }),
      at,
    );
  }

  /**
   * An email in a scheduling meeting's thread could not be sent. The meeting
   * and its conversation go on, but nothing may come of them: with no times
   * held, no follow-through deadline runs. So main hears of it, once per
   * email, to amend, cancel, or tell the principal.
   */
  async function sendFailed(meeting: SchedulingMeeting, msg: OutboundMessage): Promise<void> {
    const thread = await getThreadParticipants(meeting.thread_key);
    const to = thread
      ? peopleText([['', everyoneOn(thread.people)]], meeting, (await addressBook()).principal)
      : who(meeting);
    await writeMainNote(
      `meeting-unsent-${meeting.id}-${msg.id}`,
      {
        type: UNSENT_NOTE_TYPE,
        meeting_id: meeting.id,
        thread_key: meeting.thread_key,
        kind: meeting.kind,
        purpose: meeting.purpose,
        counterparts: noteCounterparts(meeting),
      },
      `An email external-email wrote in meeting ${meeting.id}'s thread could not be sent: email delivery kept failing ` +
        `("${meeting.purpose}", thread_key ${meeting.thread_key}). It was to ${to}. ` +
        (meeting.state === 'booked'
          ? 'The meeting stays booked as it is: cancel it, or tell the principal in one line if it matters.'
          : 'The meeting is still being arranged, but nothing will come of it on its own: amend it, cancel it, or tell the principal in one line.'),
      new Date().toISOString(),
    );
  }

  // -------------------------------------------------------------------------
  // A step in a meeting's conversation that failed
  // -------------------------------------------------------------------------

  /** Why a meeting's conversation stopped short: an email it could not process, or a turn that failed. */
  type StallCause = 'unprocessed' | 'turn-failed';

  /** What main can do about a meeting that stalled, as its state allows. */
  function stallNextStep(meeting: Meeting): string {
    if (!isScheduling(meeting)) {
      return (
        `Its reply was not sent, and the thread waits for you again: respond again with thread_key ${meeting.thread_key}, ` +
        'or tell the principal in one line.'
      );
    }
    return meeting.state === 'booked'
      ? 'The meeting stays booked: reschedule it if they asked to move it, cancel it, or tell the principal in one line.'
      : 'The meeting is still open, but nothing will come of it on its own: amend it to brief external-email again, ' +
          'cancel it, or tell the principal in one line.';
  }

  /**
   * Something in a meeting's conversation failed, so the email that started
   * it went unanswered, and nothing follows on its own: no hold, no deadline.
   * main hears of it once per `key`. A reply ends and its thread goes back to
   * main, so main can respond again; any other meeting goes on.
   */
  async function stalled(
    meeting: Meeting,
    cause: StallCause,
    key: string,
    happened: string,
    fields: Record<string, unknown> = {},
  ): Promise<void> {
    const at = new Date().toISOString();
    const id = `meeting-stalled-${meeting.id}-${createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
    const note = {
      type: STALLED_NOTE_TYPE,
      meeting_id: meeting.id,
      thread_key: meeting.thread_key,
      kind: meeting.kind,
      cause,
      counterparts: noteCounterparts(meeting),
      ...fields,
    };
    const gmailMessageId = typeof fields.gmail_message_id === 'string' ? fields.gmail_message_id : undefined;
    const read =
      cause === 'turn-failed'
        ? ''
        : gmailMessageId === undefined
          ? ' You can read the thread in the inbox with the gmail skill.'
          : ` You can read it in the inbox with the gmail skill, as Gmail message ${gmailMessageId}.`;
    const text = `${happened} (meeting ${meeting.id}, thread_key ${meeting.thread_key}).${read} ${stallNextStep(meeting)}`;
    if (isScheduling(meeting)) {
      await writeMainNote(id, note, text, at);
      return;
    }
    await handBack(meeting, 'gave-up', false, () => writeMainNote(id, note, text, at));
    await recordOutcome(
      meeting.id,
      'gave-up',
      JSON.stringify({ meeting_id: meeting.id, outcome: 'gave-up', message: OUTCOME_REPLIES['gave-up'] }),
      at,
    );
  }

  /**
   * Who sent an email the inbox routed, as Gmail's authentication shows it:
   * found from the inbound message's id, which is the Gmail message id with
   * the router's `:<agent group>` suffix. Undefined for anything else, such
   * as a brief, or when Gmail cannot say now.
   */
  async function emailSender(
    messageId: string,
    session: Session,
  ): Promise<{ readonly gmailMessageId: string; readonly address: string; readonly verified: boolean } | undefined> {
    const suffix = `:${session.agent_group_id}`;
    const gmailMessageId = messageId.endsWith(suffix) ? messageId.slice(0, -suffix.length) : messageId;
    const runtime = activeInbox();
    if (!runtime || !(await isSettled(gmailMessageId))) return undefined;
    /* eslint-disable no-catch-all/no-catch-all -- the sender only helps main find the email; the note goes without it */
    try {
      const message = await runtime.gmail.getMessage(gmailMessageId, 'metadata');
      if (!message) return undefined;
      const { auth } = await loadRoutingContext(await assistantAddresses(), runtime.now());
      const verdict = authenticateSender(message.payload?.headers ?? [], auth);
      if (verdict.kind === 'principal' || verdict.kind === 'authenticated') {
        return { gmailMessageId, address: verdict.address, verified: true };
      }
      if (verdict.kind === 'unauthenticated' && verdict.address !== undefined) {
        return { gmailMessageId, address: verdict.address, verified: false };
      }
      return undefined;
    } catch (err) {
      log.warn('Could not read who sent an email its conversation failed on', { gmailMessageId, err });
      return undefined;
    }
    /* eslint-enable no-catch-all/no-catch-all */
  }

  /** Messages a meeting's conversation was given up on after their retries: main hears of each, once. */
  async function inboundFailed(failed: readonly MessageRetry[], session: Session): Promise<void> {
    for (const retry of failed) {
      const meeting = await meetingInThread(retry, session);
      if (!meeting || (!isScheduling(meeting) && meeting.state !== 'active')) continue;
      const sender = await emailSender(retry.id, session);
      // An unverified From is whatever the sender typed, so only a verified one is named.
      const what = !sender
        ? 'A message'
        : sender.verified
          ? `An email from ${sender.address}`
          : 'An email whose sender Gmail could not verify';
      await stalled(
        meeting,
        'unprocessed',
        `message:${retry.id}`,
        `${what} in meeting ${meeting.id}'s thread could not be processed, even after retrying, so nothing answered it`,
        sender ? { sender: sender.address, verified: sender.verified, gmail_message_id: sender.gmailMessageId } : {},
      );
    }
  }

  /**
   * A turn of a meeting's conversation failed, so the email that started it
   * went unanswered. main hears of it once per state of the thread: the same
   * failed turn delivered again, or another failing on the same email, adds
   * nothing; a later email that also goes unanswered is noted again.
   */
  async function turnFailed(route: ThreadRoute, session: Session): Promise<void> {
    const meeting = await meetingInThread(route, session);
    if (!meeting || (!isScheduling(meeting) && meeting.state !== 'active')) return;
    const latest = (await threadMessageIds(meeting.thread_key)).at(-1) ?? `brief-${meeting.brief_version}`;
    await stalled(
      meeting,
      'turn-failed',
      `turn:${latest}`,
      `A step external-email took in meeting ${meeting.id}'s thread failed, so the latest email there was not answered`,
    );
  }

  // -------------------------------------------------------------------------
  // external-email's recipients
  // -------------------------------------------------------------------------

  /**
   * Place the people already on the meeting's thread for its next replies
   * (R40): in To, Cc, or Bcc, or left off. Nobody new: only main adds
   * someone. It holds until the next email in the thread changes who is on it.
   */
  async function recipients(content: Record<string, unknown>, session: Session): Promise<Answer> {
    const meeting = await requireMeeting(meetingIdOf(content));
    if (meeting.session_id !== session.id) throw refused("That meeting is not this conversation's");
    if (!isLive(meeting.state) || meeting.ended_at !== null) {
      throw refused(`Meeting ${meeting.id} has ended (${meeting.state}): send nothing more in this conversation.`);
    }
    const wanted: ThreadPeople = {
      to: addressesOf(content.to, 'to', true),
      cc: addressesOf(content.cc, 'cc', false),
      bcc: addressesOf(content.bcc, 'bcc', false),
    };
    const thread = await getThreadParticipants(meeting.thread_key);
    if (!thread || (thread.state !== 'open' && thread.state !== 'authorized')) {
      throw refused('This thread is not open for replies.');
    }
    const { principal } = await addressBook();
    const onThread = everyoneOn(thread.people);
    const chosen = [...wanted.to, ...wanted.cc, ...wanted.bcc];
    const newcomers = [...new Set(chosen.filter((address) => !onThread.includes(address)))];
    if (newcomers.length > 0) {
      throw refused(
        `${newcomers.length === 1 ? 'This address is' : 'These addresses are'} not on this thread, and you cannot add anyone: ` +
          `${untrustedLine(newcomers.join(', '), MAIL_ADDRESSES_MAX)}\n` +
          `To include someone new, invite the people on the thread to copy them in. On it now: ${peopleText(placed(thread.people), meeting, principal)}.`,
      );
    }
    const twice = chosen.find((address, index) => chosen.indexOf(address) !== index);
    if (twice !== undefined) throw invalid(`${twice} can be placed only once`);
    if (wanted.to.length === 0) throw invalid('Put at least one person on to');
    const people = (await arrangeThreadPeople(meeting.thread_key, wanted)).people;
    const left = onThread.filter((address) => !chosen.includes(address));
    return {
      meetingId: meeting.id,
      data: {
        meeting_id: meeting.id,
        ...people,
        message:
          `Your replies in this thread now go to: ${peopleText(placed(people), meeting, principal)}.` +
          (left.length === 0 ? '' : ` Left off: ${peopleText([['', left]], meeting, principal)}.`) +
          ' This holds until the next email in the thread changes who is on it.',
      },
    };
  }

  // -------------------------------------------------------------------------
  // Ending a meeting
  // -------------------------------------------------------------------------

  function isLive(state: MeetingState): boolean {
    return LIVE_STATES.some((live) => live === state);
  }

  async function closeSession(sessionId: string, kill: boolean): Promise<void> {
    const session = await getSession(sessionId);
    if (!session) return;
    if (session.status !== 'closed') await updateSession(sessionId, { status: 'closed' });
    if (kill) killContainer(sessionId, 'its meeting ended');
  }

  /** Stop the meeting: its state, its deadlines, and its session, which never wakes again. */
  async function stopMeeting(meeting: Meeting, state: MeetingState, kill: boolean): Promise<void> {
    const at = new Date().toISOString();
    // One write: an ended meeting never shows a deadline, which marks a give-up not yet finished.
    await updateMeeting(meeting.id, { state, ended_at: meeting.ended_at ?? at, nudge_at: null, give_up_at: null }, at);
    if (meeting.session_id !== null) await closeSession(meeting.session_id, kill);
  }

  /** Close the meeting's thread, so later mail reaches main as a note, and forget what it sent. */
  async function closeMeetingThread(meeting: Meeting): Promise<void> {
    const thread = await getThreadParticipants(meeting.thread_key);
    if (thread && thread.state !== 'closed') await closeThread(meeting.thread_key);
    await deleteThreadRecord({
      channelType: EMAIL_CHANNEL_TYPE,
      platformId: INBOX_PLATFORM_ID,
      threadId: meeting.thread_key,
    });
  }

  /** Whether another meeting has taken the meeting's thread over since: the thread is that meeting's now. */
  async function threadTakenOver(meeting: Meeting): Promise<boolean> {
    const live = await findLiveMeetingOnThread(meeting.thread_key);
    return live !== undefined && live.id !== meeting.id;
  }

  /**
   * End a meeting: stopped, then `afterStop` (a cancel's line to its people,
   * sent while the thread is still open), its thread closed, and then its
   * holds released. Releasing comes last, so a failure there leaves nothing
   * open; the holds stay recorded and a repeat releases them.
   */
  async function endMeeting(
    meeting: Meeting,
    state: MeetingState,
    kill: boolean,
    afterStop?: () => Promise<void>,
  ): Promise<void> {
    await stopMeeting(meeting, state, kill);
    if (!(await threadTakenOver(meeting))) {
      if (afterStop) await afterStop();
      await closeMeetingThread(meeting);
    }
    await deps.releaseHolds(meeting);
  }

  /**
   * End a job on a thread held for main and give the thread back, its later
   * mail held for main again: after a reply has gone or could not be sent,
   * when the thread is not about scheduling, or when main calls a reply off.
   * Its mail stops reaching the session first, then `tellMain` writes main's
   * note, then the job and its session end. The thread keeps its privacy
   * record, since the conversation goes on. Safe to repeat.
   */
  async function handBack(
    meeting: Meeting,
    state: MeetingState,
    kill: boolean,
    tellMain?: () => Promise<void>,
  ): Promise<void> {
    if (!(await threadTakenOver(meeting))) await handBackHeldThread(meeting.thread_key);
    if (tellMain) await tellMain();
    await stopMeeting(meeting, state, kill);
    await deps.releaseHolds(meeting);
  }

  /** The one checked line a cancel sends, in the thread, to the people the assistant already wrote to. */
  async function sendCancelLine(meeting: Meeting): Promise<boolean> {
    const thread = await getThreadParticipants(meeting.thread_key);
    if (!thread || thread.gmailThreadId === null || (thread.state !== 'open' && thread.state !== 'authorized')) {
      return false;
    }
    const adapter = getDeliveryAdapter();
    if (!adapter) return false;
    const profile = await getGwsEaProfile();
    const principal = profile.principal_display_name ?? 'The person I assist';
    const assistant = profile.assistant_display_name ?? 'The assistant';
    const line =
      `${principal} no longer needs this meeting, so there is nothing more to arrange. ` +
      `Thank you, and sorry for any trouble. ${assistant}, assistant to ${principal}`;
    /* eslint-disable no-catch-all/no-catch-all -- the meeting is cancelled either way; main hears whether the line went */
    try {
      // The guarded adapter: the line passes the audience check like every send.
      await adapter.deliver(
        EMAIL_CHANNEL_TYPE,
        INBOX_PLATFORM_ID,
        meeting.thread_key,
        'chat',
        JSON.stringify({ text: line }),
      );
      return true;
    } catch (err) {
      log.warn('A cancelled meeting’s line to its counterparts was not sent', { meetingId: meeting.id, err });
      return false;
    }
    /* eslint-enable no-catch-all/no-catch-all */
  }

  /**
   * Give up on a meeting nobody answered (KTD12, R9), once it claims the
   * deadline `giveUpAt` it came due on: a reply read first started the count
   * again, and wins. The host reports gave-up to main itself, ends the
   * meeting and its conversation, and releases its holds, with no agent turn.
   * Safe to repeat: a claimed give-up keeps its deadline until the meeting is
   * stopped, and one main could not be told of is released; the note is
   * written once, and a release of holds that fails leaves them for a later pass.
   */
  async function giveUpUnanswered(meeting: Meeting, giveUpAt: string): Promise<void> {
    const at = new Date().toISOString();
    if (!(await claimGiveUp(meeting.id, giveUpAt, at))) return;
    const current = await requireMeeting(meeting.id);
    try {
      await reportUnanswered(current, at);
    } catch (error) {
      await releaseGiveUp(current.id, giveUpAt, new Date().toISOString());
      throw error;
    }
    await endMeeting(current, 'gave-up', true);
  }

  /** Tell main nobody answered the meeting, and record the outcome. */
  async function reportUnanswered(meeting: Meeting, at: string): Promise<void> {
    const room = isScheduling(meeting) ? await roomContext(meeting, 'gave-up') : {};
    const note: OutcomeNote = {
      type: OUTCOME_NOTE_TYPE,
      meeting_id: meeting.id,
      outcome: 'gave-up',
      kind: meeting.kind,
      purpose: meeting.purpose,
      level: meeting.level,
      counterparts: noteCounterparts(meeting),
      unanswered: true,
    };
    const text =
      `Nobody answered meeting ${meeting.id}, "${meeting.purpose}" with ${who(meeting)}, in the two working days after a nudge, ` +
      'so its held times were released and its thread closed. Tell the principal in one line, with a suggestion, ' +
      'such as another way to reach them or a later window.' +
      roomStillNeeded(room);
    await writeOutcomeNote(note, text, at);
    const data = { meeting_id: meeting.id, outcome: 'gave-up', message: OUTCOME_REPLIES['gave-up'] };
    await recordOutcome(meeting.id, 'gave-up', JSON.stringify(data), at);
  }

  /** A thread the audience check stopped: its meeting ends at once, so the thread can wake nothing. */
  async function threadStopped(key: ThreadKey): Promise<void> {
    if (key.channelType !== EMAIL_CHANNEL_TYPE || key.platformId !== INBOX_PLATFORM_ID || key.threadId === null) return;
    const meeting = await findLiveMeetingOnThread(key.threadId);
    if (meeting) await endMeeting(meeting, 'stopped', true);
  }

  /** Remove a session and everything it holds, once its container is gone. */
  async function purgeSession(sessionId: string): Promise<void> {
    const session = await getSession(sessionId);
    if (!session) return;
    if (session.status !== 'closed') await updateSession(sessionId, { status: 'closed' });
    if (isContainerRunning(sessionId)) {
      await new Promise<void>((resolve) => {
        const bound = setTimeout(resolve, 30_000);
        killContainer(sessionId, 'a person in its meeting was forgotten', () => {
          clearTimeout(bound);
          resolve();
        });
      });
    }
    await destroySessionMailbox(session.agent_group_id, sessionId);
    fs.rmSync(sessionDir(session.agent_group_id, sessionId), { recursive: true, force: true });
    await deleteSession(sessionId);
  }

  /** A forgotten person leaves no meeting, thread, hold, deadline, or session behind (KTD8). */
  async function forgetPerson(person: { readonly id: string; readonly handles: readonly string[] }): Promise<void> {
    if (!(await getDb().hasTable('gws_ea_meetings'))) return;
    const meetings = await meetingsWithPerson(person.id, person.handles);
    // Every meeting, ended ones too: a hold a failed release left behind goes before its record does.
    for (const meeting of meetings) await deps.releaseHolds(meeting);
    for (const meeting of meetings) await deleteMeeting(meeting.id);
    for (const threadKey of new Set(meetings.map((meeting) => meeting.thread_key))) {
      if (await findLiveMeetingOnThread(threadKey)) continue;
      const thread = await getThreadParticipants(threadKey);
      if (thread && thread.state !== 'closed') await closeThread(threadKey);
      await deleteThreadRecord({ channelType: EMAIL_CHANNEL_TYPE, platformId: INBOX_PLATFORM_ID, threadId: threadKey });
    }
    const sessions = new Set(meetings.flatMap((meeting) => (meeting.session_id === null ? [] : [meeting.session_id])));
    for (const sessionId of sessions) {
      const stillBound = await getDb().get(
        'SELECT 1 AS bound FROM gws_ea_meetings WHERE session_id = ? LIMIT 1',
        sessionId,
      );
      if (!stillBound) await purgeSession(sessionId);
    }
  }

  return {
    // The requests, each registered under its action name and answered once (`index.ts`).
    arrange,
    reschedule,
    askOrganizer,
    cancel,
    amend,
    respond,
    dismiss,
    replyToPrincipal,
    outcome,
    recipients,
    /** A delivered message may be a reply's own email: it finishes the reply once reported. */
    replyDelivered,
    /** A reply job whose ending a stop or a failed note cut short: follow-through finishes it. */
    finishCutShortReply,
    /** Delivery gave up on messages: each email a meeting's conversation wrote among them reaches main. */
    sendsFailed,
    /** A meeting's conversation was given up on messages after their retries: main hears of each. */
    inboundFailed,
    /** A turn of a meeting's conversation failed: main hears the email that started it went unanswered. */
    turnFailed,
    /** End a meeting from the host (a booked event passes). */
    endMeeting,
    giveUpUnanswered,
    threadStopped,
    forgetPerson,
  };
}
