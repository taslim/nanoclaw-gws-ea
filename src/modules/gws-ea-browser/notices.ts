import { getSession } from '../../db/sessions.js';
import { requestWake } from '../../request-wake.js';
import { withExistingMailboxSession, writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { getMainAgentGroupId } from '../gws-ea-profile/db.js';
import { hasBrowserAccess } from './access.js';

/** Browser continuations are host chat turns; system rows are reserved for tool answers. */
export function writeBrowserNotice(session: Session, id: string, eventJson: string): Promise<void> {
  return writeSessionMessage(session.agent_group_id, session.id, {
    id,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    trigger: true,
    content: JSON.stringify({ text: eventJson, sender: 'system', senderId: 'system' }),
  });
}

/** A browser errand: its job thread, the browser session working it, and the agent group that delegated it. */
export interface BrowserErrand {
  readonly job: string;
  readonly session: Session;
  readonly source: string;
}

/** Whether the delegating agent was told, had been told already, or had nowhere to be told. */
export type DelegatorNotice = 'written' | 'already-written' | 'no-main' | 'no-principal' | 'no-delegating-session';

/**
 * Tell the agent that delegated a browser errand `text` now, once per `id`, and wake it: main in its shared
 * conversation, naming the job so its open matter comes with it; any other agent with browser access in the
 * session it delegated from (R28). No other agent hears of it.
 */
export async function tellDelegator(
  errand: BrowserErrand,
  note: { readonly id: string; readonly timestamp: string; readonly text: string },
): Promise<DelegatorNotice> {
  // Loaded on use: main's notes bring the matters graph, which the browser's own modules never need.
  const { isDuplicateNote, writeNoteForMain } = await import('../gws-ea-profile/main-note.js');
  if (errand.source === (await getMainAgentGroupId()))
    return writeNoteForMain({ ...note, wake: true, pieces: [{ kind: 'job', reference: errand.job }] });
  const delegatedFrom = await withExistingMailboxSession(errand.session.agent_group_id, errand.session.id, (mailbox) =>
    mailbox.getMostRecentPeerSourceSessionId(errand.source),
  );
  const session = delegatedFrom ? await getSession(delegatedFrom) : undefined;
  if (session?.agent_group_id !== errand.source || session.status !== 'active') return 'no-delegating-session';
  try {
    await writeSessionMessage(session.agent_group_id, session.id, {
      id: note.id,
      kind: 'chat',
      timestamp: note.timestamp,
      platformId: session.agent_group_id,
      channelType: 'agent',
      threadId: null,
      content: JSON.stringify({ text: note.text, sender: 'system', senderId: 'system' }),
    });
  } catch (error) {
    if (!isDuplicateNote(error)) throw error;
    return 'already-written';
  }
  const fresh = await getSession(session.id);
  if (fresh) await requestWake(fresh, 'inbound-message');
  return 'written';
}

/**
 * Tell the agent that delegated a browser errand of its purchase, as `tellDelegator` does; once its group's
 * browser access was removed, main hears instead, since main is the one left to record the purchase's outcome
 * (KTD9). The note names no job: main never holds another group's errand.
 */
export async function tellOfPurchase(
  errand: BrowserErrand,
  note: { readonly id: string; readonly timestamp: string; readonly text: string },
): Promise<DelegatorNotice> {
  if (await hasBrowserAccess(errand.source)) return tellDelegator(errand, note);
  const { writeNoteForMain } = await import('../gws-ea-profile/main-note.js');
  return writeNoteForMain({ ...note, wake: true });
}
