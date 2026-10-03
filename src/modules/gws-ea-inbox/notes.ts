/**
 * Typed notes for `main` (KTD4, KTD9, KTD16). Mail meant for `main` never
 * enters the email channel: the host writes a note into `main`'s shared
 * session, routed to the principal's direct message, so `main`'s answer
 * reaches the principal. Each note carries its typed fields in `content.note` and one
 * plain explanation in `content.text`; anything another person wrote is
 * wrapped as untrusted.
 *
 * A note's ID derives from the Gmail message it reports, so routing the same
 * message again finds the note already written.
 */
import { log } from '../../log.js';
import type { PersonLevel } from '../gws-ea-people/db.js';
import { writeNoteForMain } from '../gws-ea-profile/main-note.js';
import type { CalendarChange } from './calendar-notifications.js';

/** An email from anyone but the principal, as the host read it, in a thread held for `main`. */
export interface HeldMailFields {
  readonly thread_key: string;
  readonly gmail_message_id: string;
  /** The From address as written, or null when From is not one mailbox; it is proven only when `verified`. */
  readonly sender: string | null;
  /** Whether Gmail's authentication proved the sender. */
  readonly verified: boolean;
  /** The sender's level, present only when Gmail verified a sender who has a record (R21). */
  readonly level?: PersonLevel;
  /** As the sender wrote it, so untrusted. */
  readonly subject: string;
  /** Everyone on the message but the assistant. */
  readonly people: readonly string[];
}

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
  /** A new thread held for `main` to triage: the email that started it. */
  | ({ readonly type: 'gws-ea-inbox.inbound'; readonly gmail_thread_id: string } & HeldMailFields)
  /** A later email in a thread still held for `main`. */
  | ({ readonly type: 'gws-ea-inbox.held-mail' } & HeldMailFields)
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
  /** Whether `main` should take a turn now; otherwise the note waits for its next one. */
  readonly wake: boolean;
}

/** Write a note into `main`'s shared session; throws when there is no `main` or no principal to route it to. */
export async function writeMainNote(note: MainNote, at: string): Promise<void> {
  const result = await writeNoteForMain({
    id: note.id,
    timestamp: at,
    text: note.text,
    fields: { note: note.note },
    wake: note.wake,
  });
  if (result === 'no-main' || result === 'no-principal') {
    throw new Error('The inbox has no main agent or no principal direct message to report to');
  }
  if (result === 'already-written') log.info('Inbox note already written', { noteId: note.id });
}
