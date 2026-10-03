/**
 * Outcomes reach `main` as typed notes in its shared session, routed to the
 * principal's direct message, so main's one line reaches the principal (R26).
 * A note's id derives from the meeting and the outcome, so writing it again
 * is a no-op.
 */
import { isUniqueViolation } from '../../db/errors.js';
import { getSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import { requestWake } from '../../request-wake.js';
import { resolveSession, writeSessionMessage } from '../../session-manager.js';
import { principalContact } from '../gws-ea-privacy/audience.js';
import { getMainAgentGroupId } from '../gws-ea-profile/db.js';
import type { MeetingKind, MeetingLevel, Outcome } from './db.js';

export const OUTCOME_NOTE_TYPE = 'gws-ea-meetings.outcome';

export interface OutcomeNote {
  readonly type: typeof OUTCOME_NOTE_TYPE;
  readonly meeting_id: string;
  readonly outcome: Outcome;
  readonly kind: MeetingKind;
  readonly purpose: string;
  readonly level: MeetingLevel;
  readonly counterparts: readonly { readonly name: string | null; readonly address: string }[];
  /** The event the host booked or moved: only on a booked outcome. */
  readonly booking?: {
    readonly calendar_id: string;
    readonly event_id: string;
    readonly start: string;
    readonly end: string;
  };
  /** The invitation the organizer moved: only on a settled outcome. */
  readonly invitation?: { readonly calendar_id: string; readonly event_id: string };
}

function isDuplicateNote(error: unknown): boolean {
  return isUniqueViolation(error) && error instanceof Error && /messages_in\.id\b/iu.test(error.message);
}

/** The main agent group, or throw: an outcome nobody can hear is not accepted. */
export async function requireMainAgentGroupId(): Promise<string> {
  const id = await getMainAgentGroupId();
  if (id === null) throw new Error('There is no main agent to report the meeting to');
  return id;
}

/** Write an outcome into main's shared session and wake it. Throws when there is no main or no principal to reach. */
export async function writeOutcomeNote(note: OutcomeNote, text: string, at: string): Promise<void> {
  const mainAgentGroupId = await requireMainAgentGroupId();
  const principal = await principalContact();
  if (principal === undefined) throw new Error('There is no principal direct message to report the meeting to');
  const { directMessage } = principal;
  const { session } = await resolveSession(mainAgentGroupId, directMessage.id, null, 'agent-shared');
  try {
    await writeSessionMessage(mainAgentGroupId, session.id, {
      id: `meeting-${note.outcome}-${note.meeting_id}`,
      kind: 'chat',
      timestamp: at,
      platformId: directMessage.platform_id,
      channelType: directMessage.channel_type,
      threadId: null,
      content: JSON.stringify({ text, sender: 'system', senderId: 'system', note }),
      trigger: true,
    });
  } catch (error) {
    if (!isDuplicateNote(error)) throw error;
    log.info('Meeting outcome note already written', { meetingId: note.meeting_id, outcome: note.outcome });
    return;
  }
  const fresh = await getSession(session.id);
  if (fresh) await requestWake(fresh, 'inbound-message');
}
