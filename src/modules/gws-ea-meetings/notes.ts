/**
 * What the host tells the agents about meetings, as typed notes.
 *
 * - To `main`: in its shared session, routed to the principal's direct
 *   message, so main's one line reaches the principal (R26). How a meeting
 *   ended or a reply went out, a question `external-email` is waiting on
 *   main to answer, an email in a meeting's thread that could not be sent, a
 *   step in its conversation that failed, a booked meeting the counterpart
 *   moved, and a room that could not be held.
 * - To a meeting's own `external-email` session: host-only messages from
 *   sender `system`, which no email can be, in the meeting's thread. The
 *   nudge for a quiet thread, the time room was made for (KTD12), and the
 *   one closing line a called-off meeting owes (KTD6).
 *
 * A note's id derives from what it reports, so writing it again is a no-op.
 */
import { resolveGroupTimezone } from '../../container-config.js';
import { log } from '../../log.js';
import { requestWake } from '../../request-wake.js';
import { writeSessionMessage } from '../../session-manager.js';
import { formatLocalTime } from '../../timezone.js';
import type { Session } from '../../types.js';
import { EMAIL_CHANNEL_TYPE, INBOX_PLATFORM_ID } from '../gws-ea-inbox/index.js';
import { getMainAgentGroupId } from '../gws-ea-profile/db.js';
import { isDuplicateNote, writeNoteForMain } from '../gws-ea-profile/main-note.js';
import type { EventConference } from './calendar-api.js';
import {
  getBooking,
  getMeeting,
  getRoomGivenTo,
  type Booking,
  type Meeting,
  type MeetingKind,
  type MeetingLevel,
  type Outcome,
  type SchedulingMeeting,
} from './db.js';

export const OUTCOME_NOTE_TYPE = 'gws-ea-meetings.outcome';
/** To main: `external-email` asks about a meeting, and waits for the answer (KTD2). */
export const ASK_NOTE_TYPE = 'gws-ea-meetings.ask';
/** A booked meeting moved at the counterpart's request. */
export const MOVED_NOTE_TYPE = 'gws-ea-meetings.moved';
/** The time freed to make room was taken before it could be held. */
export const ROOM_LOST_NOTE_TYPE = 'gws-ea-meetings.room-lost';
/** To main: an email in a meeting's thread that delivery gave up on, while the meeting goes on. */
export const UNSENT_NOTE_TYPE = 'gws-ea-meetings.unsent';
/** To main: a meeting's conversation could not process an email, or a turn of it failed, so nothing answered. */
export const STALLED_NOTE_TYPE = 'gws-ea-meetings.stalled';
/** To a meeting's session: nobody has replied, so nudge them once. */
export const NUDGE_NOTE_TYPE = 'gws-ea-meetings.nudge';
/** To a meeting's session: room was made, and its time is held for the meeting. */
export const ROOM_NOTE_TYPE = 'gws-ea-meetings.room';
/** To a meeting's session: main called it off; tell them in one line, then nothing more. */
export const CLOSING_NOTE_TYPE = 'gws-ea-meetings.closing';

export interface NoteCounterpart {
  readonly name: string | null;
  readonly address: string;
}

/** A booked meeting the assistant arranged that could move to make room (R14). */
export interface RoomCandidate {
  readonly meeting_id: string;
  readonly calendar_id: string;
  readonly event_id: string;
  readonly start: string;
  readonly end: string;
  readonly purpose: string;
  readonly people: readonly (NoteCounterpart & { readonly level: MeetingLevel })[];
  /** The time moving it frees for the meeting that needs room. */
  readonly frees: { readonly start: string; readonly end: string };
}

export interface OutcomeNote {
  readonly type: typeof OUTCOME_NOTE_TYPE;
  readonly meeting_id: string;
  /** How it ended, or `booked`, which `meeting_book` reports itself (KTD8). */
  readonly outcome: Outcome | 'booked';
  readonly kind: MeetingKind;
  readonly purpose: string;
  readonly level: MeetingLevel;
  readonly counterparts: readonly NoteCounterpart[];
  /** The event the host booked or moved: only on a booked outcome. */
  readonly booking?: {
    readonly calendar_id: string;
    readonly event_id: string;
    readonly start: string;
    readonly end: string;
  };
  /** Whether the booked event has a Google Meet link, or Google is creating one: only on a booked outcome. */
  readonly video_call?: boolean;
  /** The invitation the organizer moved: only on a settled outcome. */
  readonly invitation?: { readonly calendar_id: string; readonly event_id: string };
  /** On a booked outcome: the meeting that moved to make room for this one. */
  readonly made_room_by?: {
    readonly meeting_id: string;
    readonly purpose: string;
    readonly counterparts: readonly NoteCounterpart[];
    readonly moved_to: { readonly start: string; readonly end: string } | null;
  };
  /** On a gave-up outcome the host reported itself: nobody answered after a nudge. */
  readonly unanswered?: true;
  /** On a gave-up outcome for a conversation: delivery gave up on its email, so it was never sent. */
  readonly undelivered?: true;
  /** On a done or not-scheduling outcome: the thread, waiting for main again, to arrange, respond, or dismiss. */
  readonly thread_key?: string;
}

/** Who a meeting is with, for a note: each name and address. */
export function who(meeting: { readonly counterparts: readonly NoteCounterpart[] }): string {
  return meeting.counterparts
    .map((counterpart) => (counterpart.name ? `${counterpart.name} (${counterpart.address})` : counterpart.address))
    .join(', ');
}

export function noteCounterparts(meeting: Pick<Meeting, 'counterparts'>): NoteCounterpart[] {
  return meeting.counterparts.map(({ name, address }) => ({ name, address }));
}

/** The main agent group, or throw: an outcome nobody can hear is not accepted. */
export async function requireMainAgentGroupId(): Promise<string> {
  const id = await getMainAgentGroupId();
  if (id === null) throw new Error('There is no main agent to report the meeting to');
  return id;
}

/** The timezone main tells the principal times in. */
export async function mainTimezone(): Promise<string> {
  return resolveGroupTimezone(await requireMainAgentGroupId());
}

/**
 * Write a note into main's shared session, waking it unless `wake` is false:
 * a fact main need not act on waits for its next turn. Throws when there is
 * no main or no principal to reach.
 */
export async function writeMainNote<Note extends { readonly type: string; readonly meeting_id: string }>(
  id: string,
  note: Note,
  text: string,
  at: string,
  wake = true,
): Promise<void> {
  const result = await writeNoteForMain({ id, timestamp: at, text, fields: { note }, wake });
  switch (result) {
    case 'no-main':
      throw new Error('There is no main agent to report the meeting to');
    case 'no-principal':
      throw new Error('There is no principal direct message to report the meeting to');
    case 'already-written':
      log.info('Meeting note already written', { meetingId: note.meeting_id, type: note.type });
      return;
    case 'written':
      return;
    default: {
      const unreachable: never = result;
      throw new Error(`Unknown note result: ${String(unreachable)}`);
    }
  }
}

/**
 * Write how a meeting ended into main's shared session, once per meeting and
 * outcome, waking main unless `wake` is false.
 */
export async function writeOutcomeNote(note: OutcomeNote, text: string, at: string, wake = true): Promise<void> {
  await writeMainNote(`meeting-${note.outcome}-${note.meeting_id}`, note, text, at, wake);
}

/**
 * Write a host-only note into a meeting's own session, in its thread, and
 * wake it. Returns false when the note was written before.
 */
export async function writeMeetingNote(
  session: Session,
  meeting: Pick<Meeting, 'id' | 'thread_key'>,
  id: string,
  note: { readonly type: string; readonly [key: string]: unknown },
  text: string,
  at: string,
): Promise<boolean> {
  try {
    await writeSessionMessage(session.agent_group_id, session.id, {
      id,
      kind: 'chat',
      timestamp: at,
      platformId: INBOX_PLATFORM_ID,
      channelType: EMAIL_CHANNEL_TYPE,
      threadId: meeting.thread_key,
      content: JSON.stringify({
        text,
        sender: 'system',
        senderId: 'system',
        note: { ...note, meeting_id: meeting.id },
      }),
      trigger: true,
    });
  } catch (error) {
    if (!isDuplicateNote(error)) throw error;
    log.info('Meeting note already written', { meetingId: meeting.id, type: note.type });
    return false;
  }
  await requestWake(session, 'inbound-message');
  return true;
}

/**
 * Tell main a meeting is booked or moved, the moment it is (KTD8, R47):
 * written once per meeting, however often a booking is repeated. It names
 * the meeting by main's own purpose and carries nothing `external-email`
 * wrote; main reads the event when it needs its title or place.
 */
export async function writeBookedNote(
  meeting: SchedulingMeeting,
  booking: Booking,
  conference: EventConference | undefined,
  at: string,
): Promise<void> {
  const timezone = await mainTimezone();
  const given = await getRoomGivenTo(meeting.id);
  const moved = given ? await getMeeting(given.moved_meeting_id) : undefined;
  const movedTo = given ? await getBooking(given.by_meeting_id) : undefined;
  const madeRoomBy =
    moved === undefined
      ? undefined
      : {
          meeting_id: moved.id,
          purpose: moved.purpose,
          counterparts: noteCounterparts(moved),
          moved_to: movedTo ? { start: movedTo.start_at, end: movedTo.end_at } : null,
        };
  const videoCall = conference !== undefined && conference.status !== 'failure';
  const minutes = Math.round((Date.parse(booking.end_at) - Date.parse(booking.start_at)) / 60_000);
  const note: OutcomeNote = {
    type: OUTCOME_NOTE_TYPE,
    meeting_id: meeting.id,
    outcome: 'booked',
    kind: meeting.kind,
    purpose: meeting.purpose,
    level: meeting.level,
    counterparts: noteCounterparts(meeting),
    booking: {
      calendar_id: booking.calendar_id,
      event_id: booking.event_id,
      start: booking.start_at,
      end: booking.end_at,
    },
    ...(videoCall ? { video_call: true } : {}),
    ...(madeRoomBy ? { made_room_by: madeRoomBy } : {}),
  };
  const madeRoom = madeRoomBy
    ? ` To make room for it, "${madeRoomBy.purpose}" with ${who(madeRoomBy)} moved` +
      (madeRoomBy.moved_to ? ` to ${formatLocalTime(madeRoomBy.moved_to.start, timezone)}.` : '.')
    : '';
  await writeOutcomeNote(
    note,
    `Meeting ${meeting.id} is ${meeting.kind === 'reschedule' ? 'moved to' : 'booked for'} ` +
      `${formatLocalTime(booking.start_at, timezone)} (${minutes} minutes): "${meeting.purpose}" with ${who(meeting)}, ` +
      `on calendar ${booking.calendar_id}${videoCall ? ', with a Google Meet link' : ''}.${madeRoom}`,
    at,
  );
}
