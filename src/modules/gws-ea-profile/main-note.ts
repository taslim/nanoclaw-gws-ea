/**
 * Notes the host writes for `main`, into its shared session, routed to the
 * principal's direct message so main's answer reaches the principal. The
 * inbox and the meetings each write theirs through here.
 *
 * Side-effect free: importing it loads no module entry point, so it never
 * reorders the registrations a module's `index.ts` makes.
 */
import { createHash } from 'node:crypto';

import type { OutboundFile } from '../../channels/adapter.js';
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
  /** Whether main takes a turn now; otherwise the note waits for its next one. */
  readonly wake: boolean;
  /** Files that come with it, saved in main's inbox beside it, each recorded there by its SHA-256. */
  readonly files?: readonly OutboundFile[];
}

/** `already-written`: a note with this id is in main's session. The other two: nobody to write it to. */
export type NoteForMainResult = 'written' | 'already-written' | 'no-main' | 'no-principal';

/** A write refused because a message with that id is already in the session. */
export function isDuplicateNote(error: unknown): boolean {
  return isUniqueViolation(error) && error instanceof Error && /messages_in\.id\b/iu.test(error.message);
}

/** A file as a note carries it; core saves its bytes into the session's inbox, and its SHA-256 stays beside them. */
interface NoteAttachment {
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
  readonly data: string;
}

function attachmentsOf(files: readonly OutboundFile[] = []): { readonly attachments?: readonly NoteAttachment[] } {
  if (files.length === 0) return {};
  return {
    attachments: files.map((file) => ({
      name: file.filename,
      size: file.data.length,
      sha256: createHash('sha256').update(file.data).digest('hex'),
      data: file.data.toString('base64'),
    })),
  };
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
      content: JSON.stringify({ text: note.text, sender: 'system', senderId: 'system', ...attachmentsOf(note.files) }),
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
