/**
 * The typed handoff between `main` and `external-email` (KTD5).
 *
 * `main` sends one of five requests; `external-email` reports one outcome.
 * Each arrives as a guarded delivery action (see `guard.ts`), and each gets
 * exactly one answer, errors included, through `writeActionResponse`. An
 * answer is recorded against the request id the runner set, the id of the
 * outbound message that carried it, so a request replayed after a host
 * restart gets the first answer and causes nothing twice.
 *
 * - `arrange` opens a new email thread to people the principal has records
 *   for, or binds a thread the principal copied the assistant into, taking
 *   its people from the principal's message. `reschedule` moves an event the
 *   principal organizes; `ask_organizer` asks an invitation's organizer, who
 *   must have a record (R16), to move it.
 * - Every meeting is bound to one `external-email` session. Its first message
 *   is the brief: a host-only message from sender `system`, which no email
 *   can be, carrying the counterparts' names and addresses, the meeting's
 *   level, its length, window, purpose and constraints, and nothing else
 *   from the people store. Mail held for the thread follows it.
 * - The purpose and constraints are length-capped and pass the audience
 *   check before `external-email` sees them.
 * - `cancel` ends a meeting, closes its session, and tells the people the
 *   assistant wrote to in one checked line; `amend` writes a new brief.
 * - An outcome becomes a typed note in `main`'s shared session. Booked comes
 *   only after the host's own booking; settled only after the invitation is
 *   re-read and found moved to an offered time or clear of conflicts;
 *   needs-room only for someone in the inner circle or close.
 */
import { randomUUID } from 'node:crypto';
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
import { requestWake } from '../../request-wake.js';
import { destroySessionMailbox, sessionDir, writeSessionMessage } from '../../session-manager.js';
import { formatLocalTime, parseZonedToUtc } from '../../timezone.js';
import type { Session } from '../../types.js';
import { isPrincipalCalendar } from '../gws-ea-inbox/calendar-notifications.js';
import { listPrincipalCalendars } from '../gws-ea-inbox/db.js';
import {
  authorizeThread,
  closeThread,
  EMAIL_CHANNEL_TYPE,
  getThreadParticipants,
  INBOX_PLATFORM_ID,
  mintThreadKey,
  openThreadSession,
  releaseHeldMail,
} from '../gws-ea-inbox/index.js';
import { normalizeAddress } from '../gws-ea-inbox/mime.js';
import { assistantAddresses } from '../gws-ea-inbox/runtime.js';
import { findPeople, getPerson } from '../gws-ea-people/db.js';
import { checkOutbound, deleteThreadRecord, type ThreadKey } from '../gws-ea-privacy/index.js';
import { getGwsEaProfile, listPrincipalAddresses } from '../gws-ea-profile/db.js';
import type { CalendarEvent, MeetingsCalendarApi } from './calendar-api.js';
import {
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
  insertMeeting,
  LIVE_STATES,
  listOfferedSlots,
  lowestLevel,
  meetingsWithPerson,
  OUTCOMES,
  recordOutcome,
  recordResponse,
  updateMeeting,
  type Booking,
  type Meeting,
  type MeetingCounterpart,
  type MeetingKind,
  type MeetingState,
  type Outcome,
} from './db.js';
import { OUTCOME_NOTE_TYPE, requireMainAgentGroupId, writeOutcomeNote, type OutcomeNote } from './notes.js';

export interface MeetingHandoffDeps {
  /** The host's own Calendar reads. */
  readonly calendar: () => MeetingsCalendarApi;
  /**
   * Release every hold the host created for a meeting that is ending. The
   * calendar actions (U12) create holds and supply this; with none created
   * there is nothing to release.
   */
  readonly releaseHolds: (meeting: Meeting) => Promise<void>;
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

function invalid(message: string): MeetingRequestError {
  return new MeetingRequestError('invalid-args', message);
}

function refused(message: string): MeetingRequestError {
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
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/iu;
const PURPOSE_MAX = 120;
const CONSTRAINTS_MAX = 500;
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

function meetingIdOf(content: Record<string, unknown>): string {
  const id = content.meeting_id;
  if (typeof id !== 'string' || !MEETING_ID.test(id)) throw invalid('meeting_id must be a meeting id, such as mtg-…');
  return id;
}

/** A copied-in thread's key, as its note gave it; absent for a new thread. */
function threadKeyOf(content: Record<string, unknown>): string | undefined {
  const key = content.thread_key;
  if (key === undefined || key === null) return undefined;
  if (typeof key !== 'string' || !THREAD_KEY.test(key)) {
    throw invalid('thread_key must be the thread key from the note, such as mail-copy-…');
  }
  return key;
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

interface PersonRef {
  readonly personId: string;
  readonly email: string | undefined;
}

function peopleOf(value: unknown): PersonRef[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PEOPLE) {
    throw invalid(`people must list 1 to ${MAX_PEOPLE} people`);
  }
  return value.map((entry: unknown) => {
    const record = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : {};
    const personId = record.person_id;
    if (typeof personId !== 'string' || !PERSON_ID.test(personId.trim())) {
      throw invalid('Each person must be { person_id, email? }, with a record id such as p-1a2b3c4d5e6f');
    }
    if (record.email !== undefined && typeof record.email !== 'string') throw invalid('email must be an address');
    return { personId: personId.trim(), email: record.email };
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

interface AddressBook {
  readonly principal: ReadonlySet<string>;
  readonly assistant: ReadonlySet<string>;
}

async function addressBook(): Promise<AddressBook> {
  return {
    principal: new Set((await listPrincipalAddresses()).map((address) => address.email)),
    assistant: await assistantAddresses(),
  };
}

function assertSomeoneElse(address: string, book: AddressBook): void {
  if (book.principal.has(address)) throw invalid('The principal is never a counterpart in their own meeting');
  if (book.assistant.has(address)) throw invalid('The assistant is never its own counterpart');
}

/** A counterpart from a record: its name, level, and the one address to write to. */
async function counterpartForPerson(ref: PersonRef, book: AddressBook): Promise<MeetingCounterpart> {
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
async function counterpartForAddress(address: string): Promise<MeetingCounterpart> {
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

function who(meeting: Pick<Meeting, 'counterparts'>): string {
  return meeting.counterparts
    .map((counterpart) => (counterpart.name ? `${counterpart.name} (${counterpart.address})` : counterpart.address))
    .join(', ');
}

// ---------------------------------------------------------------------------
// The calendar, as Google reports it now
// ---------------------------------------------------------------------------

interface Span {
  readonly start: number;
  readonly end: number;
}

/** An event's span: a timed event's instants, an all-day event's days on the principal's clock. */
function spanOf(event: CalendarEvent, timezone: string): Span | undefined {
  const { start, end } = event;
  if (start?.dateTime !== undefined && end?.dateTime !== undefined) {
    const span = { start: Date.parse(start.dateTime), end: Date.parse(end.dateTime) };
    return Number.isNaN(span.start) || Number.isNaN(span.end) ? undefined : span;
  }
  if (start?.date !== undefined && end?.date !== undefined) {
    return {
      start: parseZonedToUtc(`${start.date}T00:00:00`, timezone).getTime(),
      end: parseZonedToUtc(`${end.date}T00:00:00`, timezone).getTime(),
    };
  }
  return undefined;
}

export function createMeetingHandoff(deps: MeetingHandoffDeps) {
  const calendar = () => deps.calendar();

  async function principalTimezone(): Promise<string> {
    return (await getGwsEaProfile()).principal_timezone ?? TIMEZONE;
  }

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
    const span = spanOf(event, await principalTimezone());
    if (!span || span.end <= span.start) throw refused('Google reports no readable time for that event');
    return { event, minutes: Math.round((span.end - span.start) / MINUTE) };
  }

  // -------------------------------------------------------------------------
  // Opening a meeting
  // -------------------------------------------------------------------------

  type Opening =
    | { readonly kind: 'new'; readonly opener: 'arrange' | 'ask_organizer' }
    | { readonly kind: 'copy-in' }
    | { readonly kind: 'takeover'; readonly session: Session };

  type BriefSetting = 'new-thread' | 'copied-in' | 'continuing';

  const TASKS: Readonly<Record<MeetingKind, string>> = {
    arrange: 'Arrange a meeting between the principal and:',
    reschedule: "Move the principal's existing meeting with these people to a new time in the window:",
    ask_organizer:
      "Ask the organizer of an invitation to the principal to move it to a time in the window, because it conflicts with the principal's calendar:",
  };

  const SETTINGS: Readonly<Record<BriefSetting, string>> = {
    'new-thread': 'This is a new email thread: your first email starts it, and goes only to the people above.',
    'copied-in': 'The principal copied you into this email thread. Its mail so far follows this brief.',
    continuing: 'Continue in this email thread, where you have written to them before.',
  };

  function briefText(meeting: Meeting, version: number, setting: BriefSetting, timezone: string): string {
    return [
      version === 1
        ? `Brief for meeting ${meeting.id}, from the host.`
        : `Updated brief for meeting ${meeting.id} (version ${version}), from the host. It replaces the earlier brief.`,
      'Only the host writes briefs; no email ever arrives as one.',
      '',
      TASKS[meeting.kind],
      ...meeting.counterparts.map((counterpart) =>
        counterpart.name ? `- ${counterpart.name} <${counterpart.address}>` : `- ${counterpart.address}`,
      ),
      `Level: ${meeting.level}.`,
      `Length: ${meeting.length_minutes} minutes.`,
      `Window: from ${formatLocalTime(meeting.window_start, timezone)} to ${formatLocalTime(meeting.window_end, timezone)} (${timezone}).`,
      `Purpose: ${meeting.purpose}`,
      `Constraints: ${meeting.constraints ?? 'none.'}`,
      '',
      SETTINGS[setting],
      `When it ends, report it once with outcome for meeting ${meeting.id}.`,
    ].join('\n');
  }

  /** Write a brief into the meeting's session. Writing the same version again is a no-op. */
  async function writeBrief(meeting: Meeting, session: Session, version: number, setting: BriefSetting): Promise<void> {
    const timezone = await resolveGroupTimezone(session.agent_group_id);
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
          text: briefText(meeting, version, setting, timezone),
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
   * Bind the meeting to its thread and session, write the brief, and only
   * then let the thread's mail in. Every step is safe to repeat, so a replay
   * after a restart finishes what the first attempt began.
   */
  async function openMeeting(meeting: Meeting, opening: Opening): Promise<Meeting> {
    let session: Session;
    if (opening.kind === 'takeover') {
      session = opening.session;
    } else {
      if (opening.kind === 'new') {
        await authorizeThread({
          kind: 'new',
          threadKey: meeting.thread_key,
          opener: opening.opener,
          subject: meeting.purpose,
          counterparts: meeting.counterparts.map((counterpart) => counterpart.address),
        });
      } else {
        await authorizeThread({ kind: 'copy-in', threadKey: meeting.thread_key });
      }
      ({ session } = await openThreadSession(meeting.thread_key));
    }
    await updateMeeting(meeting.id, { session_id: session.id }, new Date().toISOString());
    const setting: BriefSetting =
      opening.kind === 'new' ? 'new-thread' : opening.kind === 'copy-in' ? 'copied-in' : 'continuing';
    await writeBrief({ ...meeting, session_id: session.id }, session, 1, setting);
    await updateMeeting(meeting.id, { brief_version: 1 }, new Date().toISOString());
    const released = opening.kind === 'takeover' ? 0 : (await releaseHeldMail(meeting.thread_key)).released;
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
      // A copied-in thread still waiting for arrange stays the principal's to hand over again.
      if (!thread || thread.state === 'closed' || thread.state === 'awaiting-arrange') return;
      if (thread.sessionId !== null) await closeSession(thread.sessionId, true);
      await closeThread(meeting.thread_key);
    } catch (err) {
      log.error('A meeting that failed to open could not be undone', { meetingId: meeting.id, err });
    }
    /* eslint-enable no-catch-all/no-catch-all */
  }

  interface Answer {
    readonly meetingId: string | null;
    readonly data: Record<string, unknown>;
  }

  const KIND_WORDS: Readonly<Record<MeetingKind, string>> = {
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
        message:
          `external-email has meeting ${meeting.id} ${KIND_WORDS[meeting.kind]}, with ${who(meeting)}; its level is ${meeting.level}. ` +
          'You will get a note when it is booked or ends.',
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

  /** Finish a meeting a replayed request had already created. */
  async function resume(meeting: Meeting): Promise<Answer> {
    if (meeting.state === 'active' || meeting.state === 'booked') return openedAnswer(meeting);
    if (meeting.state !== 'opening') throw refused(`Meeting ${meeting.id} did not open (${meeting.state})`);
    if (meeting.replaces_meeting_id !== null) {
      const session = meeting.session_id === null ? undefined : await getSession(meeting.session_id);
      if (!session) throw refused(`Meeting ${meeting.id} lost the session it was taking over`);
      return openOrAbandon(meeting, { kind: 'takeover', session });
    }
    const thread = await getThreadParticipants(meeting.thread_key);
    return openOrAbandon(
      meeting,
      thread?.origin === 'copy-in'
        ? { kind: 'copy-in' }
        : { kind: 'new', opener: meeting.kind === 'ask_organizer' ? 'ask_organizer' : 'arrange' },
    );
  }

  interface Creation {
    readonly kind: MeetingKind;
    readonly session: Session;
    readonly requestId: string;
    readonly counterparts: readonly MeetingCounterpart[];
    readonly bookingCalendarId: string | null;
    readonly event: { readonly calendarId: string; readonly eventId: string } | null;
    readonly lengthMinutes: number;
    readonly window: Window;
    readonly purpose: string;
    readonly constraints: string | undefined;
    readonly threadKey: string;
    /** A booked meeting whose thread and session this one takes over. */
    readonly replaces?: Meeting;
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
            id,
            kind: creation.kind,
            requested_by_session: creation.session.id,
            request_id: creation.requestId,
            level: lowestLevel(creation.counterparts.map((counterpart) => counterpart.level)),
            booking_calendar_id: creation.bookingCalendarId,
            event_calendar_id: creation.event?.calendarId ?? null,
            event_id: creation.event?.eventId ?? null,
            length_minutes: creation.lengthMinutes,
            window_start: creation.window.start,
            window_end: creation.window.end,
            purpose: creation.purpose,
            constraints: creation.constraints ?? null,
            thread_key: creation.threadKey,
            replaces_meeting_id: creation.replaces?.id ?? null,
          },
          creation.counterparts,
          at,
        );
        if (creation.replaces?.session_id) {
          await updateMeeting(id, { session_id: creation.replaces.session_id }, at);
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
    const existing = await findMeetingByRequest(session.id, requestId);
    if (existing) return resume(existing);
    const at = new Date();
    const people = peopleOf(content.people);
    const threadKey = threadKeyOf(content);
    const calendarId = calendarIdOf(content);
    const lengthMinutes = lengthOf(content.length_minutes);
    const window = checkedWindow(windowOf(content), lengthMinutes, at);
    const purpose = text(content.purpose, 'purpose', PURPOSE_MAX);
    const constraints = optionalText(content.constraints, 'constraints', CONSTRAINTS_MAX);
    const book = await addressBook();

    let counterparts: MeetingCounterpart[];
    let opening: Opening;
    if (threadKey !== undefined) {
      if (people !== undefined) {
        throw invalid("A copied-in thread's people are the ones on the principal's message: leave people out");
      }
      const thread = await getThreadParticipants(threadKey);
      if (!thread || thread.origin !== 'copy-in') {
        throw refused(`${threadKey} is not a thread the principal copied you into`);
      }
      if (thread.state === 'closed') throw refused(`Thread ${threadKey} is closed`);
      const live = await findLiveMeetingOnThread(threadKey);
      if (live) throw refused(`Thread ${threadKey} already has meeting ${live.id}`);
      counterparts = await Promise.all(
        thread.counterparts
          .filter((address) => !book.principal.has(address) && !book.assistant.has(address))
          .map((address) => counterpartForAddress(address)),
      );
      if (counterparts.length === 0) throw refused('Nobody but the principal is on that thread');
      opening = { kind: 'copy-in' };
    } else {
      if (people === undefined) {
        throw invalid('Name the people to meet, or the thread_key of a thread the principal copied you into');
      }
      counterparts = distinct(await Promise.all(people.map((ref) => counterpartForPerson(ref, book))));
      opening = { kind: 'new', opener: 'arrange' };
    }
    const bookingCalendarId = await requirePrincipalCalendar(calendarId, true);
    await assertShareable(purpose, constraints);
    const meeting = await createMeeting({
      kind: 'arrange',
      session,
      requestId,
      counterparts,
      bookingCalendarId,
      event: null,
      lengthMinutes,
      window,
      purpose,
      constraints,
      threadKey: threadKey ?? mintThreadKey(),
    });
    return openOrAbandon(meeting, opening);
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

    const bookingCalendarId = await requirePrincipalCalendar(calendarId, true);
    const { event, minutes } = await requireTimedEvent(bookingCalendarId, eventId);
    const book = await addressBook();
    const organizer = event.organizer?.email;
    if (organizer === undefined || !(book.principal.has(organizer) || organizer === bookingCalendarId.toLowerCase())) {
      throw refused(
        'Someone else organizes that event, so it cannot be moved from here: use ask_organizer to ask its organizer instead.',
      );
    }
    const addresses = [
      ...new Set(
        (event.attendees ?? [])
          .filter((attendee) => attendee.resource !== true)
          .flatMap((attendee) => normalizeAddress(attendee.email ?? '') ?? [])
          .filter((address) => !book.principal.has(address) && !book.assistant.has(address)),
      ),
    ];
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
    const counterparts = await Promise.all(addresses.map((address) => counterpartForAddress(address)));

    // A meeting the assistant booked keeps its thread: the new job continues there.
    const booked = await findBookedMeetingForEvent(bookingCalendarId, eventId);
    const bookedSession = booked?.session_id ? await getSession(booked.session_id) : undefined;
    const bookedThread = booked ? await getThreadParticipants(booked.thread_key) : undefined;
    if (booked && bookedSession?.status === 'active' && bookedThread?.state === 'open') {
      const meeting = await createMeeting({
        kind: 'reschedule',
        session,
        requestId,
        counterparts,
        bookingCalendarId,
        event: { calendarId: bookingCalendarId, eventId },
        lengthMinutes,
        window,
        purpose,
        constraints,
        threadKey: booked.thread_key,
        replaces: booked,
      });
      return openOrAbandon(meeting, { kind: 'takeover', session: bookedSession });
    }
    const meeting = await createMeeting({
      kind: 'reschedule',
      session,
      requestId,
      counterparts,
      bookingCalendarId,
      event: { calendarId: bookingCalendarId, eventId },
      lengthMinutes,
      window,
      purpose,
      constraints,
      threadKey: mintThreadKey(),
    });
    return openOrAbandon(meeting, { kind: 'new', opener: 'arrange' });
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
    const counterpart = await counterpartForAddress(organizer);
    if (counterpart.person_id === null) {
      throw refused(
        `${organizer} has no people record, so the assistant does not write to them: bring the invitation to the principal in one message, with your recommendation.`,
      );
    }
    if (minutes < MIN_LENGTH || minutes > MAX_LENGTH) {
      throw refused(`That invitation lasts ${minutes} minutes, which is too long to move this way`);
    }
    checkedWindow(window, minutes, at);
    await assertShareable(purpose, constraints);
    const live = await findLiveMeetingForEvent(principalCalendar, eventId);
    if (live) throw refused(`Meeting ${live.id} is already asking about that invitation`);
    const meeting = await createMeeting({
      kind: 'ask_organizer',
      session,
      requestId,
      counterparts: [counterpart],
      bookingCalendarId: null,
      event: { calendarId: principalCalendar, eventId },
      lengthMinutes: minutes,
      window,
      purpose,
      constraints,
      threadKey: mintThreadKey(),
    });
    return openOrAbandon(meeting, { kind: 'new', opener: 'ask_organizer' });
  }

  async function cancel(content: Record<string, unknown>): Promise<Answer> {
    const meeting = await requireMeeting(meetingIdOf(content));
    if (!isLive(meeting.state) && meeting.state !== 'cancelled') {
      throw refused(`Meeting ${meeting.id} has already ended (${meeting.state})`);
    }
    await stopMeeting(meeting, 'cancelled', true);
    const told = await sendCancelLine(meeting);
    await closeMeetingThread(meeting);
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

  async function amend(content: Record<string, unknown>): Promise<Answer> {
    const meeting = await requireMeeting(meetingIdOf(content));
    if (meeting.state !== 'active') {
      throw refused(`Meeting ${meeting.id} is ${meeting.state}: only a meeting still being arranged can be amended`);
    }
    const changes = ['length_minutes', 'window_start', 'window_end', 'constraints'].filter(
      (key) => content[key] !== undefined,
    );
    if (changes.length === 0) throw invalid('Give a new length_minutes, window_start, window_end, or constraints');
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
    await assertShareable(undefined, constraints);
    const session = meeting.session_id === null ? undefined : await getSession(meeting.session_id);
    if (!session) throw refused(`Meeting ${meeting.id} has no conversation to brief`);

    const version = meeting.brief_version + 1;
    const at = new Date().toISOString();
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
    await writeBrief(amended, session, version, 'continuing');
    await requestWake(session, 'inbound-message');
    return {
      meetingId: meeting.id,
      data: {
        meeting_id: meeting.id,
        brief_version: version,
        message: `Meeting ${meeting.id} has a new brief (version ${version}); external-email works from it now.`,
      },
    };
  }

  // -------------------------------------------------------------------------
  // external-email's outcome
  // -------------------------------------------------------------------------

  /** The state each outcome leaves its meeting in. */
  const OUTCOME_STATES: Readonly<Record<Outcome, MeetingState>> = {
    booked: 'booked',
    settled: 'settled',
    'needs-room': 'active',
    'not-scheduling': 'not-scheduling',
    'gave-up': 'gave-up',
  };

  async function mainTimezone(): Promise<string> {
    return resolveGroupTimezone(await requireMainAgentGroupId());
  }

  function outcomeText(meeting: Meeting, outcome: Outcome, booking: Booking | undefined, timezone: string): string {
    switch (outcome) {
      case 'booked': {
        if (!booking) throw new Error('A booked note needs its booking');
        const moved = meeting.kind === 'reschedule' ? 'moved to' : 'booked for';
        const minutes = Math.round((Date.parse(booking.end_at) - Date.parse(booking.start_at)) / MINUTE);
        return (
          `Meeting ${meeting.id} is ${moved} ${formatLocalTime(booking.start_at, timezone)} (${minutes} minutes): ` +
          `"${meeting.purpose}" with ${who(meeting)}, on calendar ${booking.calendar_id}. Tell the principal in one line.`
        );
      }
      case 'settled':
        return (
          `${who(meeting)} moved their invitation, so it no longer conflicts (meeting ${meeting.id}, "${meeting.purpose}"). ` +
          'Tell the principal in one line.'
        );
      case 'needs-room':
        return (
          `Meeting ${meeting.id} with ${who(meeting)} (${meeting.level}) needs room: nothing open in its window fits. ` +
          "Decide whether to make room for them under the principal's rules; if you cannot, tell the principal in one line."
        );
      case 'not-scheduling':
        return (
          `The thread the principal copied you into with ${who(meeting)} is not about scheduling, so external-email will not handle it (meeting ${meeting.id}). ` +
          "Tell the principal in one line that you can't take it on yet."
        );
      case 'gave-up':
        return (
          `external-email gave up on meeting ${meeting.id}, "${meeting.purpose}" with ${who(meeting)}: no time was agreed. ` +
          'Tell the principal in one line, with a suggestion.'
        );
      default: {
        const unreachable: never = outcome;
        throw new Error(`Unknown outcome ${String(unreachable)}`);
      }
    }
  }

  const OUTCOME_REPLIES: Readonly<Record<Outcome, string>> = {
    booked:
      'Recorded: booked. The principal hears it from main. Stay ready in this thread for any change they ask for.',
    settled: 'Recorded: settled. This conversation is now closed: send nothing more in it.',
    'needs-room':
      'Recorded: needs-room. main decides whether to make room; wait for a new brief before offering anything else.',
    'not-scheduling': 'Recorded: not-scheduling. This conversation is now closed: send nothing more in it.',
    'gave-up': 'Recorded: gave-up. This conversation is now closed: send nothing more in it.',
  };

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
    const span = spanOf(event, timezone);
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
        if (other.status === 'cancelled' || other.transparency === 'transparent') return false;
        const declined = (other.attendees ?? []).some(
          (attendee) =>
            attendee.email !== undefined && principal.has(attendee.email) && attendee.responseStatus === 'declined',
        );
        if (declined) return false;
        const otherSpan = spanOf(other, timezone);
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

  async function outcome(content: Record<string, unknown>, session: Session): Promise<Answer> {
    const meeting = await requireMeeting(meetingIdOf(content));
    const kind = OUTCOMES.find((value) => value === content.outcome);
    if (kind === undefined) throw invalid(`outcome must be one of ${OUTCOMES.join(', ')}`);
    if (meeting.session_id !== session.id) throw refused("That meeting is not this conversation's");
    const recorded = await getRecordedOutcome(meeting.id, kind);
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
        if (thread?.origin !== 'copy-in') {
          throw refused(
            'not-scheduling is only for a thread the principal copied you into; this one was opened to schedule',
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
    const note: OutcomeNote = {
      type: OUTCOME_NOTE_TYPE,
      meeting_id: meeting.id,
      outcome: kind,
      kind: meeting.kind,
      purpose: meeting.purpose,
      level: meeting.level,
      counterparts: meeting.counterparts.map(({ name, address }) => ({ name, address })),
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
    };
    // The note's id is fixed per meeting and outcome, so it is written once
    // however often this runs; the state changes after it are safe to repeat.
    await writeOutcomeNote(note, outcomeText(meeting, kind, booking, await mainTimezone()), at);
    if (kind === 'booked') {
      await updateMeeting(meeting.id, { state: 'booked' }, at);
      await clearDeadlines(meeting.id, at);
    } else if (kind !== 'needs-room') {
      await endMeeting(meeting, OUTCOME_STATES[kind], false);
    }
    const data = { meeting_id: meeting.id, outcome: kind, message: OUTCOME_REPLIES[kind] };
    await recordOutcome(meeting.id, kind, JSON.stringify(data), at);
    return { meetingId: meeting.id, data };
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

  /** Stop the meeting: its state, its deadlines, its holds, and its session, which never wakes again. */
  async function stopMeeting(meeting: Meeting, state: MeetingState, kill: boolean): Promise<void> {
    const at = new Date().toISOString();
    await updateMeeting(meeting.id, { state, ended_at: meeting.ended_at ?? at }, at);
    await clearDeadlines(meeting.id, at);
    await deps.releaseHolds(meeting);
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

  async function endMeeting(meeting: Meeting, state: MeetingState, kill: boolean): Promise<void> {
    await stopMeeting(meeting, state, kill);
    await closeMeetingThread(meeting);
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
    for (const meeting of meetings) {
      if (isLive(meeting.state)) await deps.releaseHolds(meeting);
    }
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

  // -------------------------------------------------------------------------
  // Answering every request exactly once
  // -------------------------------------------------------------------------

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

  type Handle = (content: Record<string, unknown>, session: Session, requestId: string) => Promise<Answer>;

  /**
   * A delivery action that answers its request once. The answer, an error
   * included, is recorded before it is written, so a replay writes the same
   * answer again and runs nothing.
   */
  function answering(action: string, handle: Handle): GuardedDeliveryHandler {
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

  return {
    arrange: answering('meeting_arrange', arrange),
    reschedule: answering('meeting_reschedule', reschedule),
    askOrganizer: answering('meeting_ask_organizer', askOrganizer),
    cancel: answering('meeting_cancel', (content) => cancel(content)),
    amend: answering('meeting_amend', (content) => amend(content)),
    outcome: answering('meeting_outcome', (content, session) => outcome(content, session)),
    /** End a meeting from the host (follow-through gives up, a booked event passes). */
    endMeeting,
    threadStopped,
    forgetPerson,
  };
}

export type MeetingHandoff = ReturnType<typeof createMeetingHandoff>;
