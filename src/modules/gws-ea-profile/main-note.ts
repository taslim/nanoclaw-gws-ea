/**
 * Notes the host writes for `main`, into its shared session, routed to the
 * principal's direct message so main's answer reaches the principal. The
 * inbox, the meetings, and the privacy check each write theirs through here.
 *
 * Side-effect free: importing it loads no module entry point, so it never
 * reorders the registrations a module's `index.ts` makes.
 */
import { isUniqueViolation } from '../../db/errors.js';
import { getSession } from '../../db/sessions.js';
import { requestWake } from '../../request-wake.js';
import { resolveSession, writeSessionMessage } from '../../session-manager.js';
import { getMainAgentGroupId, principalContact } from './db.js';

export interface NoteForMain {
  /** The message id; one derived from what the note reports makes writing it again a no-op. */
  readonly id: string;
  readonly timestamp: string;
  /** The one plain explanation main reads. */
  readonly text: string;
  /** The typed fields written beside the text: a `note`, or the privacy check's `signal`. */
  readonly fields: { readonly note: unknown } | { readonly signal: unknown };
  /** Whether main takes a turn now; otherwise the note waits for its next one. */
  readonly wake: boolean;
}

/** `already-written`: a note with this id is in main's session. The other two: nobody to write it to. */
export type NoteForMainResult = 'written' | 'already-written' | 'no-main' | 'no-principal';

/** A write refused because a message with that id is already in the session. */
export function isDuplicateNote(error: unknown): boolean {
  return isUniqueViolation(error) && error instanceof Error && /messages_in\.id\b/iu.test(error.message);
}

export async function writeNoteForMain(note: NoteForMain): Promise<NoteForMainResult> {
  const mainAgentGroupId = await getMainAgentGroupId();
  if (mainAgentGroupId === null) return 'no-main';
  const principal = await principalContact();
  if (principal === undefined) return 'no-principal';
  const { directMessage } = principal;
  const { session } = await resolveSession(mainAgentGroupId, directMessage.id, null, 'agent-shared');
  try {
    await writeSessionMessage(mainAgentGroupId, session.id, {
      id: note.id,
      kind: 'chat',
      timestamp: note.timestamp,
      platformId: directMessage.platform_id,
      channelType: directMessage.channel_type,
      threadId: null,
      content: JSON.stringify({ text: note.text, sender: 'system', senderId: 'system', ...note.fields }),
      trigger: note.wake,
    });
  } catch (error) {
    if (!isDuplicateNote(error)) throw error;
    return 'already-written';
  }
  if (note.wake) {
    const fresh = await getSession(session.id);
    if (fresh) await requestWake(fresh, 'inbound-message');
  }
  return 'written';
}
