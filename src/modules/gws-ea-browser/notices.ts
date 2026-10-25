import { formatLocalTimeWithZone } from '../../timezone.js';
import { formatMoney, freeCommitBooks, type FreeCommitFacts, type PurchaseFacts } from './fingerprint.js';
import { principalClock } from './watch-policy.js';
import type { PurchaseAttemptRow } from './authority.js';
import type { DbDriver } from '../../db/driver.js';
import { getSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import { requestWake } from '../../request-wake.js';
import { withExistingMailboxSession, writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { hasBrowserAccess, isMainAgentGroup } from './access.js';
import { BrowserStore, type BrowserJob } from './db.js';

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

export type DelegatorNotice = 'written' | 'already-written' | 'no-main' | 'no-principal' | 'no-delegating-session';

/**
 * Tell the agent that delegated a browser errand `text` now, once per `id`, and wake it: main in its shared
 * conversation, naming the job so its open matter comes with it; any other delegator in the session it delegated
 * from. No other agent hears of it.
 */
export async function tellDelegator(
  errand: BrowserErrand,
  note: { readonly id: string; readonly timestamp: string; readonly text: string },
): Promise<DelegatorNotice> {
  // Loaded on use: main's notes bring the matters graph, which the browser's own modules never need.
  const { isDuplicateNote, writeNoteForMain } = await import('../gws-ea-profile/main-note.js');
  if (await isMainAgentGroup(errand.source))
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
 * Once the delegating group's browser access was removed, main hears instead, since main is the one left to
 * record the purchase's outcome. The note names no job: main never holds another group's errand.
 */
async function tellOfPurchase(
  errand: BrowserErrand,
  note: { readonly id: string; readonly timestamp: string; readonly text: string },
): Promise<DelegatorNotice> {
  if (await hasBrowserAccess(errand.source)) return tellDelegator(errand, note);
  const { writeNoteForMain } = await import('../gws-ea-profile/main-note.js');
  return writeNoteForMain({ ...note, wake: true });
}

export interface OncePurchaseNotice {
  /** The table whose `notified_at` marks the record told. */
  readonly table: string;
  readonly noteId: string;
  readonly text: (job: BrowserJob) => string | Promise<string>;
  /** What the host logs, under the record's kind, while nobody can be told yet. */
  readonly unsent: { readonly message: string; readonly kind: 'attempt' | 'incident' };
}

/**
 * Marks `record` told, with a compare-and-set, only once its note is written; a notice that cannot go out yet
 * stays owed for the host's sweep.
 */
export async function tellOfPurchaseOnce(
  db: DbDriver,
  record: { readonly id: string; readonly job_id: string },
  notice: OncePurchaseNotice,
): Promise<void> {
  const job = await new BrowserStore(db).getJob(record.job_id);
  const session = job ? await getSession(job.browser_session_id) : undefined;
  if (!job || !session) return;
  const told = await tellOfPurchase(
    { job: job.thread_id, session, source: job.source_agent_group_id },
    { id: notice.noteId, timestamp: new Date().toISOString(), text: await notice.text(job) },
  );
  if (told !== 'written' && told !== 'already-written') {
    log.warn(notice.unsent.message, { [notice.unsent.kind]: record.id, result: told });
    return;
  }
  await db.run(
    `UPDATE ${notice.table} SET notified_at = ? WHERE id = ? AND notified_at IS NULL`,
    new Date().toISOString(),
    record.id,
  );
}

export function attemptSummary(attempt: Pick<PurchaseAttemptRow, 'kind' | 'facts_json' | 'site'>): {
  booking: boolean;
  what: string;
  total?: string;
} {
  if (attempt.kind === 'free') {
    const booking = freeCommitBooks(JSON.parse(attempt.facts_json) as FreeCommitFacts);
    return { booking, what: `free ${booking ? 'booking' : 'order'} on ${attempt.site}` };
  }
  const facts = JSON.parse(attempt.facts_json) as PurchaseFacts;
  const booking = Boolean(facts.reservation || facts.generic?.booking);
  return {
    booking,
    what: `${booking ? 'booking' : 'purchase'} on ${attempt.site}`,
    total: formatMoney(facts.totalMinor, facts.currency),
  };
}

/** to: main, delegator */
async function unconfirmedText(job: BrowserJob, attempt: PurchaseAttemptRow): Promise<string> {
  const { what, total } = attemptSummary(attempt);
  return (
    `Browser job ${job.thread_id}: the ${what}${total ? ` for ${total}` : ''}, pressed ` +
    `${formatLocalTimeWithZone(attempt.attempted_at, await principalClock())}, has no page proving whether it went through, so it is ` +
    `unconfirmed (attempt ${attempt.id}). When the merchant's order email reaches you, or once you have asked the ` +
    `principal whether it went through, record it with record_purchase_outcome. Until then another purchase on ` +
    `${attempt.site} waits on it; browsing there goes on.`
  );
}

/** At most once; a notice that cannot go out yet waits for the host's sweep. */
export async function notifyUnconfirmedPurchase(attempt: PurchaseAttemptRow, db: DbDriver): Promise<void> {
  if (attempt.resolution || !attempt.unconfirmed_at || attempt.notified_at) return;
  await tellOfPurchaseOnce(db, attempt, {
    table: attempt.kind === 'paid' ? 'gws_ea_browser_purchase_attempts' : 'gws_ea_browser_free_attempts',
    noteId: `browser-unconfirmed-${attempt.id}`,
    text: (job) => unconfirmedText(job, attempt),
    unsent: { message: 'Nobody to tell of an unconfirmed purchase yet', kind: 'attempt' },
  });
}
