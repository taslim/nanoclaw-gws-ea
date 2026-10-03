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
import { log } from '../../log.js';
import { writeNoteForMain } from '../gws-ea-profile/main-note.js';
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
