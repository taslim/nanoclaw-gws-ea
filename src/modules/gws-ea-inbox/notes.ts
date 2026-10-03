/**
 * Typed notes for `main` (KTD4, KTD9). Mail meant for `main` never enters the
 * email channel: the host writes a note into `main`'s shared session, routed
 * to the principal's direct message, so `main`'s answer reaches the
 * principal. Each note carries its typed fields in `content.note` and one
 * plain explanation in `content.text`; anything another person wrote is
 * wrapped as untrusted.
 *
 * A note's ID derives from the Gmail message it reports, so routing the same
 * message again finds the note already written.
 */
import { getSession } from '../../db/sessions.js';
import { isUniqueViolation } from '../../db/errors.js';
import { log } from '../../log.js';
import { requestWake } from '../../request-wake.js';
import { resolveSession, writeSessionMessage } from '../../session-manager.js';
import { principalContact } from '../gws-ea-privacy/audience.js';
import { getMainAgentGroupId } from '../gws-ea-profile/db.js';
import type { CalendarChange } from './calendar-notifications.js';

export type InboxNote =
  | {
      readonly type: 'gws-ea-inbox.principal-mail';
      readonly gmail_message_id: string;
      readonly gmail_thread_id: string;
      readonly from: string;
    }
  | {
      readonly type: 'gws-ea-inbox.copy-in';
      readonly thread_key: string;
      readonly gmail_message_id: string;
      readonly gmail_thread_id: string;
      readonly from: string;
      /** The thread's other people: everyone on the principal's message but the principal and the assistant. */
      readonly participants: readonly string[];
    }
  | { readonly type: 'gws-ea-inbox.cold-mail'; readonly gmail_message_id: string }
  | { readonly type: 'gws-ea-inbox.closed-thread-mail'; readonly thread_key: string; readonly gmail_message_id: string }
  | {
      readonly type: 'gws-ea-inbox.calendar-changes';
      readonly changes: readonly {
        readonly calendar_id: string;
        readonly event_id: string;
        readonly change: CalendarChange;
      }[];
    };

export interface MainNote {
  /** Stable for the mail it reports, so a repeat is a no-op. */
  readonly id: string;
  readonly text: string;
  readonly note: InboxNote;
  /** Whether `main` should take a turn now; cold mail waits for its next one. */
  readonly wake: boolean;
}

function isDuplicateNote(error: unknown): boolean {
  return isUniqueViolation(error) && error instanceof Error && /messages_in\.id\b/iu.test(error.message);
}

/** Write a note into `main`'s shared session; throws when there is no `main` or no principal to route it to. */
export async function writeMainNote(note: MainNote, at: string): Promise<void> {
  const mainAgentGroupId = await getMainAgentGroupId();
  const principal = await principalContact();
  if (mainAgentGroupId === null || principal === undefined) {
    throw new Error('The inbox has no main agent or no principal direct message to report to');
  }
  const { directMessage } = principal;
  const { session } = await resolveSession(mainAgentGroupId, directMessage.id, null, 'agent-shared');
  try {
    await writeSessionMessage(mainAgentGroupId, session.id, {
      id: note.id,
      kind: 'chat',
      timestamp: at,
      platformId: directMessage.platform_id,
      channelType: directMessage.channel_type,
      threadId: null,
      content: JSON.stringify({ text: note.text, sender: 'system', senderId: 'system', note: note.note }),
      trigger: note.wake,
    });
  } catch (error) {
    if (!isDuplicateNote(error)) throw error;
    log.info('Inbox note already written', { noteId: note.id });
    return;
  }
  if (note.wake) {
    const fresh = await getSession(session.id);
    if (fresh) await requestWake(fresh, 'inbound-message');
  }
}
