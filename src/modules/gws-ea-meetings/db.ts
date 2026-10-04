/**
 * The meeting store's reads and writes (see `migration.ts` for what each
 * table holds). Nothing here talks to Google, a session, or the inbox.
 */
import { getDb } from '../../db/connection.js';
import { identityMatchKey } from '../../gws-ea/validation.js';
import { PERSON_LEVELS, type PersonLevel } from '../gws-ea-people/db.js';

/**
 * What `main` handed over: a meeting to arrange, move, or ask an organizer
 * to move, or a conversation in a thread waiting for it (`respond`), which
 * has no length or window.
 */
export const MEETING_KINDS = ['arrange', 'reschedule', 'ask_organizer', 'respond'] as const;
export type MeetingKind = (typeof MEETING_KINDS)[number];
/** The kinds that find a time. */
export type SchedulingKind = Exclude<MeetingKind, 'respond'>;

/**
 * A live meeting holds its thread; every other state has ended it. A
 * `closing` meeting was called off and still owes the other side one line.
 */
export const LIVE_STATES = ['opening', 'active', 'booked', 'closing'] as const;
export type MeetingState =
  | (typeof LIVE_STATES)[number]
  | 'settled'
  | 'not-scheduling'
  | 'done'
  | 'gave-up'
  | 'cancelled'
  | 'stopped'
  | 'superseded'
  | 'failed';

/** A person's level, or `unknown` for an address nobody with a record holds. */
export type MeetingLevel = PersonLevel | 'unknown';

/** Closest first: the meeting's level is the last of its counterparts' in this order. */
export const LEVEL_ORDER: readonly MeetingLevel[] = [...PERSON_LEVELS, 'unknown'];

export function lowestLevel(levels: readonly MeetingLevel[]): MeetingLevel {
  return levels.reduce<MeetingLevel>(
    (lowest, level) => (LEVEL_ORDER.indexOf(level) > LEVEL_ORDER.indexOf(lowest) ? level : lowest),
    'inner-circle',
  );
}

/** The endings `external-email` reports; a booking is reported by `meeting_book` itself (KTD8). */
export const OUTCOMES = ['settled', 'not-scheduling', 'gave-up', 'done'] as const;
export type Outcome = (typeof OUTCOMES)[number];

/**
 * What an invitation the assistant creates carries beyond its time and
 * people, each set by judgment (KTD7): a title, notes that help the
 * attendees, a place, and whether it has a Google Meet link.
 */
export interface Invitation {
  readonly title?: string;
  readonly notes?: string;
  readonly location?: string;
  readonly video_call?: boolean;
}

/** An invitation as the store keeps it, read back; anything else reads as none. */
function parseInvitation(raw: string | null): Invitation | null {
  if (raw === null) return null;
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const text = (key: string) => (typeof record[key] === 'string' ? { [key]: record[key] as string } : {});
  return {
    ...text('title'),
    ...text('notes'),
    ...text('location'),
    ...(typeof record.video_call === 'boolean' ? { video_call: record.video_call } : {}),
  };
}

/** What `external-email` can ask main about, never in its own words (KTD5). */
export const ASK_TOPICS = ['time', 'length', 'people', 'place', 'other'] as const;
export type AskTopic = (typeof ASK_TOPICS)[number];

export interface MeetingCounterpart {
  /** The address the host took from a record, from Google, from mail, or from `main`. */
  readonly address: string;
  readonly person_id: string | null;
  /** The record's name when the brief was written; null for someone without a record. */
  readonly name: string | null;
  readonly level: MeetingLevel;
}

interface MeetingFields {
  readonly id: string;
  readonly requested_by_session: string;
  readonly request_id: string;
  readonly state: MeetingState;
  readonly level: MeetingLevel;
  /** Where `book` creates or moves the event; null for an ask_organizer meeting or a reply. */
  readonly booking_calendar_id: string | null;
  /** The event a reschedule moves, or the invitation an ask_organizer is about. */
  readonly event_calendar_id: string | null;
  readonly event_id: string | null;
  readonly purpose: string;
  readonly constraints: string | null;
  /** What main wishes the invitation to carry; null when main said nothing about it. */
  readonly invitation: Invitation | null;
  /** The kind of meeting whose buffer and preferred times apply; null for the principal's defaults. */
  readonly meeting_kind: string | null;
  readonly thread_key: string;
  readonly session_id: string | null;
  readonly brief_version: number;
  /** The booked meeting a reschedule took over its thread from. */
  readonly replaces_meeting_id: string | null;
  /** Follow-through deadlines (KTD12): the nudge, then the release and gave-up. */
  readonly nudge_at: string | null;
  readonly give_up_at: string | null;
  /** When delivery recorded the first email the job's conversation wrote in its thread; null until then. */
  readonly replied_at: string | null;
  /** The question `external-email` put to main and is waiting on, and when; both null while none is open. */
  readonly ask_about: AskTopic | null;
  readonly asked_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly ended_at: string | null;
}

/** A meeting's terms: a length and a window to find a time in, or none for a reply. */
export type MeetingTerms =
  | {
      readonly kind: SchedulingKind;
      readonly length_minutes: number;
      readonly window_start: string;
      readonly window_end: string;
    }
  | {
      readonly kind: 'respond';
      readonly length_minutes: null;
      readonly window_start: null;
      readonly window_end: null;
    };

type MeetingRow = MeetingFields & MeetingTerms;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** A meeting row as SQL returns it: its invitation still JSON. */
type StoredMeeting = DistributiveOmit<MeetingRow, 'invitation'> & { readonly invitation: string | null };

export type Meeting = MeetingRow & { readonly counterparts: readonly MeetingCounterpart[] };
/** A meeting that finds a time: every kind but `respond`. */
export type SchedulingMeeting = Extract<Meeting, { readonly kind: SchedulingKind }>;

export function isScheduling(meeting: Meeting): meeting is SchedulingMeeting {
  return meeting.kind !== 'respond';
}

export type NewMeeting = DistributiveOmit<
  MeetingRow,
  | 'state'
  | 'session_id'
  | 'brief_version'
  | 'nudge_at'
  | 'give_up_at'
  | 'replied_at'
  | 'ask_about'
  | 'asked_at'
  | 'created_at'
  | 'updated_at'
  | 'ended_at'
>;

export interface MeetingPatch {
  readonly state?: MeetingState;
  readonly session_id?: string;
  /** A scheduling meeting's terms, as `amend` changes them. */
  readonly length_minutes?: number;
  readonly window_start?: string;
  readonly window_end?: string;
  readonly constraints?: string;
  readonly brief_version?: number;
  readonly nudge_at?: string | null;
  readonly give_up_at?: string | null;
  readonly replied_at?: string;
  readonly ended_at?: string;
}

const PATCHABLE: readonly (keyof MeetingPatch)[] = [
  'state',
  'session_id',
  'length_minutes',
  'window_start',
  'window_end',
  'constraints',
  'brief_version',
  'nudge_at',
  'give_up_at',
  'replied_at',
  'ended_at',
];

const LIVE = LIVE_STATES.map((state) => `'${state}'`).join(', ');

async function attachCounterparts(row: StoredMeeting): Promise<Meeting> {
  const counterparts = await getDb().all<MeetingCounterpart>(
    `SELECT address, person_id, name, level FROM gws_ea_meeting_counterparts
      WHERE meeting_id = ? ORDER BY position`,
    row.id,
  );
  return { ...row, invitation: parseInvitation(row.invitation), counterparts };
}

async function withCounterparts(row: StoredMeeting | undefined): Promise<Meeting | undefined> {
  return row ? attachCounterparts(row) : undefined;
}

export async function getMeeting(id: string): Promise<Meeting | undefined> {
  return withCounterparts(await getDb().get<StoredMeeting>('SELECT * FROM gws_ea_meetings WHERE id = ?', id));
}

/** The meeting a request created, found again when the same request is replayed. */
export async function findMeetingByRequest(sessionId: string, requestId: string): Promise<Meeting | undefined> {
  return withCounterparts(
    await getDb().get<StoredMeeting>(
      'SELECT * FROM gws_ea_meetings WHERE requested_by_session = ? AND request_id = ?',
      sessionId,
      requestId,
    ),
  );
}

/** The live meeting that holds a thread, if any: a booked one only until its event has passed. */
export async function findLiveMeetingOnThread(threadKey: string): Promise<Meeting | undefined> {
  return withCounterparts(
    await getDb().get<StoredMeeting>(
      `SELECT * FROM gws_ea_meetings WHERE thread_key = ? AND state IN (${LIVE}) AND ended_at IS NULL`,
      threadKey,
    ),
  );
}

/** The live meeting about an existing event (a reschedule or an ask_organizer), if any. */
export async function findLiveMeetingForEvent(calendarId: string, eventId: string): Promise<Meeting | undefined> {
  return withCounterparts(
    await getDb().get<StoredMeeting>(
      `SELECT * FROM gws_ea_meetings
        WHERE event_calendar_id = ? AND event_id = ? AND state IN ('opening', 'active')
        ORDER BY created_at DESC LIMIT 1`,
      calendarId,
      eventId,
    ),
  );
}

/** The booked meeting whose own booking is this event, if any, until the event has passed. */
export async function findBookedMeetingForEvent(calendarId: string, eventId: string): Promise<Meeting | undefined> {
  return withCounterparts(
    await getDb().get<StoredMeeting>(
      `SELECT m.* FROM gws_ea_meetings m
         JOIN gws_ea_meeting_bookings b ON b.meeting_id = m.id
        WHERE b.calendar_id = ? AND b.event_id = ? AND m.state = 'booked' AND m.ended_at IS NULL
        ORDER BY m.created_at DESC LIMIT 1`,
      calendarId,
      eventId,
    ),
  );
}

export async function insertMeeting(
  meeting: NewMeeting,
  counterparts: readonly MeetingCounterpart[],
  at: string,
): Promise<void> {
  const db = getDb();
  await db.transaction(async () => {
    await db.run(
      `INSERT INTO gws_ea_meetings
         (id, kind, requested_by_session, request_id, state, level, booking_calendar_id, event_calendar_id,
          event_id, length_minutes, window_start, window_end, purpose, constraints, invitation, meeting_kind, thread_key,
          session_id, brief_version, replaces_meeting_id, nudge_at, give_up_at, created_at, updated_at, ended_at)
       VALUES (?, ?, ?, ?, 'opening', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, NULL, NULL, ?, ?, NULL)`,
      meeting.id,
      meeting.kind,
      meeting.requested_by_session,
      meeting.request_id,
      meeting.level,
      meeting.booking_calendar_id,
      meeting.event_calendar_id,
      meeting.event_id,
      meeting.length_minutes,
      meeting.window_start,
      meeting.window_end,
      meeting.purpose,
      meeting.constraints,
      meeting.invitation === null ? null : JSON.stringify(meeting.invitation),
      meeting.meeting_kind,
      meeting.thread_key,
      meeting.replaces_meeting_id,
      at,
      at,
    );
    for (const [position, counterpart] of counterparts.entries()) {
      await db.run(
        `INSERT INTO gws_ea_meeting_counterparts (meeting_id, position, address, person_id, name, level)
         VALUES (?, ?, ?, ?, ?, ?)`,
        meeting.id,
        position,
        counterpart.address,
        counterpart.person_id,
        counterpart.name,
        counterpart.level,
      );
    }
  });
}

export async function updateMeeting(id: string, patch: MeetingPatch, at: string): Promise<void> {
  const keys = PATCHABLE.filter((key) => patch[key] !== undefined);
  if (keys.length === 0) return;
  await getDb().run(
    `UPDATE gws_ea_meetings SET ${keys.map((key) => `${key} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
    ...keys.map((key) => patch[key]),
    at,
    id,
  );
}

/**
 * Add counterparts `main` named to a meeting, after those it has, and lower
 * its level to the lowest among them all. Someone already in it stays as
 * they are, so adding the same people again changes nothing.
 */
export async function addCounterparts(
  meetingId: string,
  counterparts: readonly MeetingCounterpart[],
  at: string,
): Promise<void> {
  const db = getDb();
  await db.transaction(async () => {
    const row = await db.get<{ readonly next: number }>(
      'SELECT COALESCE(MAX(position) + 1, 0) AS next FROM gws_ea_meeting_counterparts WHERE meeting_id = ?',
      meetingId,
    );
    let position = row?.next ?? 0;
    for (const counterpart of counterparts) {
      const added = await db.run(
        `INSERT INTO gws_ea_meeting_counterparts (meeting_id, position, address, person_id, name, level)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (meeting_id, address) DO NOTHING`,
        meetingId,
        position,
        counterpart.address,
        counterpart.person_id,
        counterpart.name,
        counterpart.level,
      );
      if (added.changes > 0) position += 1;
    }
    const levels = await db.all<{ readonly level: MeetingLevel }>(
      'SELECT level FROM gws_ea_meeting_counterparts WHERE meeting_id = ?',
      meetingId,
    );
    await db.run(
      'UPDATE gws_ea_meetings SET level = ?, updated_at = ? WHERE id = ?',
      lowestLevel(levels.map((counterpart) => counterpart.level)),
      at,
      meetingId,
    );
  });
}

/** Whether another meeting on the thread got past opening: an earlier conversation had the thread and its mail. */
export async function hadEarlierMeetingOnThread(threadKey: string, meetingId: string): Promise<boolean> {
  const row = await getDb().get<{ readonly found: number }>(
    `SELECT 1 AS found FROM gws_ea_meetings
      WHERE thread_key = ? AND id <> ? AND state NOT IN ('opening', 'failed') LIMIT 1`,
    threadKey,
    meetingId,
  );
  return row !== undefined;
}

/**
 * Record the question `external-email` put to main, once: false when one is
 * already open, or the meeting is no longer being arranged or booked. While
 * it is open, the follow-through count waits on main, from `deadlines`.
 */
export async function openAsk(id: string, about: AskTopic, deadlines: Deadlines, at: string): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE gws_ea_meetings SET ask_about = ?, asked_at = ?, nudge_at = ?, give_up_at = ?, updated_at = ?
      WHERE id = ? AND asked_at IS NULL AND state IN ('active', 'booked') AND ended_at IS NULL`,
    about,
    at,
    deadlines.nudge_at,
    deadlines.give_up_at,
    at,
    id,
  );
  return result.changes > 0;
}

/**
 * Close a meeting's open question, with the count that waited on main: the
 * conversation's next email starts its own. Changes nothing when none is open.
 */
export async function closeAsk(id: string, at: string): Promise<void> {
  await getDb().run(
    `UPDATE gws_ea_meetings SET ask_about = NULL, asked_at = NULL, nudge_at = NULL, give_up_at = NULL, updated_at = ?
      WHERE id = ? AND asked_at IS NOT NULL`,
    at,
    id,
  );
}

/** Record what main now wishes the meeting's invitation to carry. */
export async function setMeetingInvitation(id: string, invitation: Invitation, at: string): Promise<void> {
  await getDb().run(
    'UPDATE gws_ea_meetings SET invitation = ?, updated_at = ? WHERE id = ?',
    JSON.stringify(invitation),
    at,
    id,
  );
}

/** Clear a meeting's deadlines: no nudge and no give-up follows. */
export async function clearDeadlines(id: string, at: string): Promise<void> {
  await getDb().run(
    'UPDATE gws_ea_meetings SET nudge_at = NULL, give_up_at = NULL, updated_at = ? WHERE id = ?',
    at,
    id,
  );
}

// ---------------------------------------------------------------------------
// Follow-through (KTD12)
// ---------------------------------------------------------------------------

/** When the one nudge is due, if the job has one (a conversation has none), and when it is given up. */
export interface Deadlines {
  readonly nudge_at: string | null;
  readonly give_up_at: string;
}

/**
 * Start an active meeting's deadlines, unless some are already running: a
 * later email or hold never pushes them out, and a nudge's own email never
 * restarts the count it belongs to.
 */
export async function startDeadlines(id: string, deadlines: Deadlines, at: string): Promise<void> {
  await getDb().run(
    `UPDATE gws_ea_meetings SET nudge_at = ?, give_up_at = ?, updated_at = ?
      WHERE id = ? AND state = 'active' AND nudge_at IS NULL AND give_up_at IS NULL`,
    deadlines.nudge_at,
    deadlines.give_up_at,
    at,
    id,
  );
}

/** Start an active meeting's deadlines again, from the other side's email, unless main has a question open. */
export async function restartDeadlines(id: string, deadlines: Deadlines, at: string): Promise<void> {
  await getDb().run(
    `UPDATE gws_ea_meetings SET nudge_at = ?, give_up_at = ?, updated_at = ?
      WHERE id = ? AND state = 'active' AND asked_at IS NULL`,
    deadlines.nudge_at,
    deadlines.give_up_at,
    at,
    id,
  );
}

/**
 * Record the nudge sent for the deadline `nudgeAt`, and when giving up
 * follows it. Changes nothing when the deadline is no longer that one: a
 * reply started the count again meanwhile, and its deadlines stand.
 */
export async function recordNudged(id: string, nudgeAt: string, giveUpAt: string, at: string): Promise<void> {
  await getDb().run(
    'UPDATE gws_ea_meetings SET nudge_at = NULL, give_up_at = ?, updated_at = ? WHERE id = ? AND nudge_at = ?',
    giveUpAt,
    at,
    id,
    nudgeAt,
  );
}

/**
 * Claim the give-up due at `giveUpAt`: the meeting stops being arranged at
 * once, so a reply read after this restarts nothing, and keeps the deadline
 * until it has ended, so a pass after a failure or a restart finishes it.
 * False when that deadline no longer stands: a reply started the count again,
 * or a booking or an outcome ended it first.
 */
export async function claimGiveUp(id: string, giveUpAt: string, at: string): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE gws_ea_meetings SET state = 'gave-up', ended_at = COALESCE(ended_at, ?), updated_at = ?
      WHERE id = ? AND state IN ('active', 'gave-up') AND nudge_at IS NULL AND give_up_at = ?`,
    at,
    at,
    id,
    giveUpAt,
  );
  return result.changes > 0;
}

/** Release a claimed give-up main could not be told of: the meeting is arranged again until a later pass reports it. */
export async function releaseGiveUp(id: string, giveUpAt: string, at: string): Promise<void> {
  await getDb().run(
    `UPDATE gws_ea_meetings SET state = 'active', ended_at = NULL, updated_at = ?
      WHERE id = ? AND state = 'gave-up' AND give_up_at = ?`,
    at,
    id,
    giveUpAt,
  );
}

/**
 * Every live meeting with a deadline running (one being arranged, a booked
 * one waiting on main, or one owing its closing line), and every give-up
 * claimed but not yet finished.
 */
export async function listMeetingsWithDeadlines(): Promise<Meeting[]> {
  const rows = await getDb().all<StoredMeeting>(
    `SELECT * FROM gws_ea_meetings
      WHERE (state IN ('active', 'booked', 'closing') AND ended_at IS NULL
             AND (nudge_at IS NOT NULL OR give_up_at IS NOT NULL))
         OR (state = 'gave-up' AND give_up_at IS NOT NULL)
      ORDER BY created_at`,
  );
  return Promise.all(rows.map((row) => attachCounterparts(row)));
}

interface BookingColumns {
  readonly b_calendar_id: string;
  readonly b_event_id: string;
  readonly b_start_at: string;
  readonly b_end_at: string;
  readonly b_booked_at: string;
}

/** Every booked meeting whose conversation is still open, with its booking, earliest first. */
export async function listOpenBookings(): Promise<Array<{ readonly meeting: Meeting; readonly booking: Booking }>> {
  const rows = await getDb().all<StoredMeeting & BookingColumns>(
    `SELECT m.*, b.calendar_id AS b_calendar_id, b.event_id AS b_event_id, b.start_at AS b_start_at,
            b.end_at AS b_end_at, b.booked_at AS b_booked_at
       FROM gws_ea_meetings m JOIN gws_ea_meeting_bookings b ON b.meeting_id = m.id
      WHERE m.state = 'booked' AND m.ended_at IS NULL
      ORDER BY b.start_at`,
  );
  return Promise.all(
    rows.map(async ({ b_calendar_id, b_event_id, b_start_at, b_end_at, b_booked_at, ...row }) => ({
      meeting: await attachCounterparts(row),
      booking: {
        meeting_id: row.id,
        calendar_id: b_calendar_id,
        event_id: b_event_id,
        start_at: b_start_at,
        end_at: b_end_at,
        booked_at: b_booked_at,
      },
    })),
  );
}

/** Every conversation still at work, oldest first. */
export async function listLiveReplyJobs(): Promise<Meeting[]> {
  const rows = await getDb().all<StoredMeeting>(
    "SELECT * FROM gws_ea_meetings WHERE kind = 'respond' AND state = 'active' ORDER BY created_at",
  );
  return Promise.all(rows.map((row) => attachCounterparts(row)));
}

/** Every meeting that is no longer being arranged but still has holds recorded: a release that failed. */
export async function listSettledMeetingsWithHolds(): Promise<Meeting[]> {
  const rows = await getDb().all<StoredMeeting>(
    `SELECT * FROM gws_ea_meetings m
      WHERE m.state NOT IN ('opening', 'active')
        AND EXISTS (SELECT 1 FROM gws_ea_meeting_holds h WHERE h.meeting_id = m.id)`,
  );
  return Promise.all(rows.map((row) => attachCounterparts(row)));
}

// ---------------------------------------------------------------------------
// Requests and outcomes, recorded once
// ---------------------------------------------------------------------------

/** The answer already given to a request (its JSON), when it was answered before. */
export async function getRecordedResponse(sessionId: string, requestId: string): Promise<string | undefined> {
  const row = await getDb().get<{ readonly response: string }>(
    'SELECT response FROM gws_ea_meeting_requests WHERE session_id = ? AND request_id = ?',
    sessionId,
    requestId,
  );
  return row?.response;
}

/** Record a request's answer. The first answer stands. */
export async function recordResponse(
  sessionId: string,
  requestId: string,
  action: string,
  meetingId: string | null,
  response: string,
  at: string,
): Promise<void> {
  await getDb().run(
    `INSERT INTO gws_ea_meeting_requests (session_id, request_id, action, meeting_id, response, answered_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (session_id, request_id) DO NOTHING`,
    sessionId,
    requestId,
    action,
    meetingId,
    response,
    at,
  );
}

/** The data an outcome already returned (its JSON), when the meeting reported it before. */
export async function getRecordedOutcome(meetingId: string, outcome: Outcome): Promise<string | undefined> {
  const row = await getDb().get<{ readonly response: string }>(
    'SELECT response FROM gws_ea_meeting_outcomes WHERE meeting_id = ? AND outcome = ?',
    meetingId,
    outcome,
  );
  return row?.response;
}

export async function recordOutcome(meetingId: string, outcome: Outcome, response: string, at: string): Promise<void> {
  await getDb().run(
    `INSERT INTO gws_ea_meeting_outcomes (meeting_id, outcome, response, recorded_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (meeting_id, outcome) DO NOTHING`,
    meetingId,
    outcome,
    response,
    at,
  );
}

// ---------------------------------------------------------------------------
// What the calendar actions record
// ---------------------------------------------------------------------------

export interface Booking {
  readonly meeting_id: string;
  readonly calendar_id: string;
  readonly event_id: string;
  readonly start_at: string;
  readonly end_at: string;
  readonly booked_at: string;
}

/** The event the host's own `book` created or moved for the meeting, if it has booked one. */
export async function getBooking(meetingId: string): Promise<Booking | undefined> {
  return getDb().get<Booking>(
    'SELECT meeting_id, calendar_id, event_id, start_at, end_at, booked_at FROM gws_ea_meeting_bookings WHERE meeting_id = ?',
    meetingId,
  );
}

export interface OfferedSlot {
  readonly slot_id: string;
  readonly start_at: string;
  readonly end_at: string;
}

/** Every candidate time the host offered for the meeting. */
export async function listOfferedSlots(meetingId: string): Promise<OfferedSlot[]> {
  return getDb().all<OfferedSlot>(
    'SELECT slot_id, start_at, end_at FROM gws_ea_meeting_slots WHERE meeting_id = ? ORDER BY start_at',
    meetingId,
  );
}

/** One time the host offered for the meeting, when it did. */
export async function getOfferedSlot(meetingId: string, slotId: string): Promise<OfferedSlot | undefined> {
  return getDb().get<OfferedSlot>(
    'SELECT slot_id, start_at, end_at FROM gws_ea_meeting_slots WHERE meeting_id = ? AND slot_id = ?',
    meetingId,
    slotId,
  );
}

/** Record the times offered; a time offered before keeps its first record. */
export async function recordOfferedSlots(meetingId: string, slots: readonly OfferedSlot[], at: string): Promise<void> {
  const db = getDb();
  await db.transaction(async () => {
    for (const slot of slots) {
      await db.run(
        `INSERT INTO gws_ea_meeting_slots (meeting_id, slot_id, start_at, end_at, offered_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (meeting_id, slot_id) DO NOTHING`,
        meetingId,
        slot.slot_id,
        slot.start_at,
        slot.end_at,
        at,
      );
    }
  });
}

/** Where the booked event is now, after a move. */
export async function updateBookingTime(meetingId: string, startAt: string, endAt: string): Promise<void> {
  await getDb().run(
    'UPDATE gws_ea_meeting_bookings SET start_at = ?, end_at = ? WHERE meeting_id = ?',
    startAt,
    endAt,
    meetingId,
  );
}

/**
 * Record the event `book` created or moved, with what its invitation carries
 * when the assistant wrote it; none for a move. The first booking stands.
 */
export async function recordBooking(booking: Booking, invitation?: Invitation): Promise<void> {
  await getDb().run(
    `INSERT INTO gws_ea_meeting_bookings (meeting_id, calendar_id, event_id, start_at, end_at, booked_at, invitation)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (meeting_id) DO NOTHING`,
    booking.meeting_id,
    booking.calendar_id,
    booking.event_id,
    booking.start_at,
    booking.end_at,
    booking.booked_at,
    invitation === undefined ? null : JSON.stringify(invitation),
  );
}

/** What the booked event's invitation carries, as the assistant last wrote it; none for a move or a meeting not booked. */
export async function getBookedInvitation(meetingId: string): Promise<Invitation | undefined> {
  const row = await getDb().get<{ readonly invitation: string | null }>(
    'SELECT invitation FROM gws_ea_meeting_bookings WHERE meeting_id = ?',
    meetingId,
  );
  return parseInvitation(row?.invitation ?? null) ?? undefined;
}

/** Record what the booked event's invitation carries after main changed it. */
export async function setBookedInvitation(meetingId: string, invitation: Invitation): Promise<void> {
  await getDb().run(
    'UPDATE gws_ea_meeting_bookings SET invitation = ? WHERE meeting_id = ?',
    JSON.stringify(invitation),
    meetingId,
  );
}

/** How many times a meeting's requests of one action were answered, refusals and failures aside. */
export async function countAnswers(meetingId: string, action: string): Promise<number> {
  const row = await getDb().get<{ readonly n: number }>(
    'SELECT COUNT(*) AS n FROM gws_ea_meeting_requests WHERE meeting_id = ? AND action = ?',
    meetingId,
    action,
  );
  return row?.n ?? 0;
}

export interface Hold {
  readonly meeting_id: string;
  readonly slot_id: string;
  readonly calendar_id: string;
  readonly event_id: string;
  readonly start_at: string;
  readonly end_at: string;
  readonly held_at: string;
}

/** Every hold the assistant may have placed for the meeting, earliest first. */
export async function listHolds(meetingId: string): Promise<Hold[]> {
  return getDb().all<Hold>('SELECT * FROM gws_ea_meeting_holds WHERE meeting_id = ? ORDER BY start_at', meetingId);
}

/** Record a hold before its event is created; recording it again changes nothing. */
export async function recordHold(hold: Hold): Promise<void> {
  await getDb().run(
    `INSERT INTO gws_ea_meeting_holds (meeting_id, slot_id, calendar_id, event_id, start_at, end_at, held_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (meeting_id, slot_id) DO NOTHING`,
    hold.meeting_id,
    hold.slot_id,
    hold.calendar_id,
    hold.event_id,
    hold.start_at,
    hold.end_at,
    hold.held_at,
  );
}

/** Forget a hold once its event is gone. */
export async function deleteHold(meetingId: string, slotId: string): Promise<void> {
  await getDb().run('DELETE FROM gws_ea_meeting_holds WHERE meeting_id = ? AND slot_id = ?', meetingId, slotId);
}

// ---------------------------------------------------------------------------
// Making room (R14, R23)
// ---------------------------------------------------------------------------

export type RoomState = 'reserved' | 'given' | 'lost';

export interface Room {
  /** The reschedule moving a booked meeting to make the room. */
  readonly by_meeting_id: string;
  /** The meeting that needs the room. */
  readonly for_meeting_id: string;
  /** The booked meeting that moves. */
  readonly moved_meeting_id: string;
  /** The time reserved for the meeting that needs it. */
  readonly start_at: string;
  readonly end_at: string;
  readonly state: RoomState;
  readonly chosen_at: string;
  readonly settled_at: string | null;
}

export async function insertRoom(room: Omit<Room, 'state' | 'settled_at'>): Promise<void> {
  await getDb().run(
    `INSERT INTO gws_ea_meeting_rooms
       (by_meeting_id, for_meeting_id, moved_meeting_id, start_at, end_at, state, chosen_at, settled_at)
     VALUES (?, ?, ?, ?, ?, 'reserved', ?, NULL)
     ON CONFLICT (by_meeting_id) DO NOTHING`,
    room.by_meeting_id,
    room.for_meeting_id,
    room.moved_meeting_id,
    room.start_at,
    room.end_at,
    room.chosen_at,
  );
}

/** The room a reschedule is making, if it is making one. */
export async function getRoomMadeBy(byMeetingId: string): Promise<Room | undefined> {
  return getDb().get<Room>('SELECT * FROM gws_ea_meeting_rooms WHERE by_meeting_id = ?', byMeetingId);
}

/** The room given to a meeting, if one was. */
export async function getRoomGivenTo(forMeetingId: string): Promise<Room | undefined> {
  return getDb().get<Room>(
    `SELECT * FROM gws_ea_meeting_rooms WHERE for_meeting_id = ? AND state = 'given'
      ORDER BY settled_at DESC LIMIT 1`,
    forMeetingId,
  );
}

/** Rooms whose move is booked but whose time has not gone to the meeting it is for yet. */
export async function listRoomsAwaitingHandover(): Promise<Room[]> {
  return getDb().all<Room>(
    `SELECT r.* FROM gws_ea_meeting_rooms r
      WHERE r.state = 'reserved'
        AND EXISTS (SELECT 1 FROM gws_ea_meeting_bookings b WHERE b.meeting_id = r.by_meeting_id)`,
  );
}

/** Settle a reserved room once; returns false when it was settled already. */
export async function settleRoom(
  byMeetingId: string,
  state: Exclude<RoomState, 'reserved'>,
  at: string,
): Promise<boolean> {
  const result = await getDb().run(
    "UPDATE gws_ea_meeting_rooms SET state = ?, settled_at = ? WHERE by_meeting_id = ? AND state = 'reserved'",
    state,
    at,
    byMeetingId,
  );
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// Forgetting
// ---------------------------------------------------------------------------

/** Every meeting a forgotten person is a counterpart in, by record or by any spelling of their addresses. */
export async function meetingsWithPerson(personId: string, handles: readonly string[]): Promise<Meeting[]> {
  const keys = new Set(
    handles.filter((handle) => handle.toLowerCase().startsWith('email:')).map((handle) => identityMatchKey(handle)),
  );
  const rows = await getDb().all<{
    readonly meeting_id: string;
    readonly address: string;
    readonly person_id: string | null;
  }>('SELECT meeting_id, address, person_id FROM gws_ea_meeting_counterparts');
  const ids = new Set(
    rows
      .filter((row) => row.person_id === personId || keys.has(identityMatchKey(`email:${row.address}`)))
      .map((row) => row.meeting_id),
  );
  const meetings: Meeting[] = [];
  for (const id of ids) {
    const meeting = await getMeeting(id);
    if (meeting) meetings.push(meeting);
  }
  return meetings;
}

/** Delete a meeting and everything recorded for it. */
export async function deleteMeeting(id: string): Promise<void> {
  const db = getDb();
  await db.transaction(async () => {
    await db.run('DELETE FROM gws_ea_meeting_requests WHERE meeting_id = ?', id);
    await db.run('UPDATE gws_ea_meetings SET replaces_meeting_id = NULL WHERE replaces_meeting_id = ?', id);
    await db.run('DELETE FROM gws_ea_meetings WHERE id = ?', id);
  });
}
