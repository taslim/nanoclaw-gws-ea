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
 *   nudge for a quiet thread, and the time room was made for (KTD12).
 *
 * A note's id derives from what it reports, so writing it again is a no-op.
 */
import { resolveGroupTimezone } from '../../container-config.js';
import { log } from '../../log.js';
import { requestWake } from '../../request-wake.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { EMAIL_CHANNEL_TYPE, INBOX_PLATFORM_ID } from '../gws-ea-inbox/index.js';
import { getMainAgentGroupId } from '../gws-ea-profile/db.js';
import { isDuplicateNote, writeNoteForMain } from '../gws-ea-profile/main-note.js';
import type { Meeting, MeetingKind, MeetingLevel, Outcome } from './db.js';

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
  readonly outcome: Outcome;
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
  /** On a gave-up outcome for a reply: delivery gave up on its email, so it was never sent. */
  readonly undelivered?: true;
  /** On a responded or not-scheduling outcome: the thread, waiting for main again, to arrange, respond, or dismiss. */
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
 * outcome; with `report`, the request that carried it, once per report.
 */
export async function writeOutcomeNote(note: OutcomeNote, text: string, at: string, report?: string): Promise<void> {
  const id = `meeting-${note.outcome}-${note.meeting_id}`;
  await writeMainNote(report === undefined ? id : `${id}-${report}`, note, text, at);
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
