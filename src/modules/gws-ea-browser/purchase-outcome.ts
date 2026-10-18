/**
 * Purchase outcomes the page could not prove (KTD8, KTD9; R10, R11). An attempt with no page proof either way is
 * unconfirmed: its delegating group hears so once, and another purchase on its site waits on it while browsing
 * there goes on. The merchant's order email reaches main like any mail, and otherwise main asks the principal
 * once; main records what it learned through `record_purchase_outcome`, by the attempt id the job's state shows,
 * never one a browser report gives.
 *
 * Every recording goes through the authority store's one resolve function: the first source to record an
 * outcome wins, and a later recording gets the recorded outcome back. A "placed" for an attempt recorded not
 * placed is the merchant's late confirmation of a possible duplicate: an incident, told at once. Main records the
 * attempts of a group whose browser access was removed.
 */
import { answeredGuard, answeringAction, forbidden, invalidArgs } from '../../cli/delivery-action.js';
import { getDb } from '../../db/connection.js';
import type { DbDriver } from '../../db/driver.js';
import { registerDeliveryAction } from '../../delivery.js';
import { ALLOW, DENY, defineGuardedAction } from '../../guard/index.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { errandSource, hasBrowserAccess, isMainAgentGroup } from './access.js';
import { PurchaseAuthorityStore, type PurchaseAttemptRow, type ResolutionSource } from './authority.js';
import { finishBrowserJobCancellation } from './cancel.js';
import { cardTime } from './cards.js';
import { BrowserStore, type BrowserJob } from './db.js';
import { formatMoney, type FreeCommitFacts, type PurchaseFacts } from './fingerprint.js';
import { freeCommitBooks } from './generic-signature.js';
import { notifyIncident, recordIncidentWithStop } from './incidents.js';
import { tellOfPurchaseOnce } from './notices.js';
import type { BrowserQueue } from './queue.js';
import { principalClock } from './watch-policy.js';

/** What an attempt was, as main reads it: a booking or an order, free or paid with its total, on its merchant. */
export function attemptSummary(attempt: PurchaseAttemptRow): { booking: boolean; what: string; total?: string } {
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

/** What the delegating group reads of an unconfirmed attempt: what, when, its attempt id, and what settles it. */
async function unconfirmedText(job: BrowserJob, attempt: PurchaseAttemptRow): Promise<string> {
  const { what, total } = attemptSummary(attempt);
  return (
    `Browser job ${job.thread_id}: the ${what}${total ? ` for ${total}` : ''}, pressed ` +
    `${cardTime(attempt.attempted_at, await principalClock())}, has no page proving whether it went through, so it is ` +
    `unconfirmed (attempt ${attempt.id}). When the merchant's order email reaches you, or once you have asked the ` +
    `principal whether it went through, record it with record_purchase_outcome. Until then another purchase on ` +
    `${attempt.site} waits on it; browsing there goes on.`
  );
}

/** Tells an unconfirmed attempt's delegating group of it, once; a notice that cannot go out yet waits for the sweep. */
export async function notifyUnconfirmedPurchase(attemptId: string, db: DbDriver = getDb()): Promise<void> {
  const attempt = await new PurchaseAuthorityStore(db).attempt(attemptId);
  if (!attempt || attempt.resolution || !attempt.unconfirmed_at || attempt.notified_at) return;
  await tellOfPurchaseOnce(db, attempt, {
    table: attempt.kind === 'paid' ? 'gws_ea_browser_purchase_attempts' : 'gws_ea_browser_free_attempts',
    noteId: `browser-unconfirmed-${attempt.id}`,
    text: (job) => unconfirmedText(job, attempt),
    unsent: { message: 'Nobody to tell of an unconfirmed purchase yet', kind: 'attempt' },
  });
}

/** The host's sweep: every unconfirmed attempt whose delegating group has not heard of it yet. */
export async function notifyPendingUnconfirmed(db: DbDriver = getDb()): Promise<void> {
  for (const { id } of await db.all<{ id: string }>(
    `SELECT id FROM gws_ea_browser_purchase_attempts WHERE resolution IS NULL AND unconfirmed_at IS NOT NULL AND notified_at IS NULL
     UNION ALL SELECT id FROM gws_ea_browser_free_attempts WHERE resolution IS NULL AND unconfirmed_at IS NOT NULL AND notified_at IS NULL`,
  ))
    await notifyUnconfirmedPurchase(id, db);
}

/** Who may record an attempt's outcome: an agent with browser access, and main whatever the setting lists. */
export const purchaseOutcomeGuard = defineGuardedAction({
  action: 'gws_ea_browser.purchase_outcome',
  async decide({ actor }) {
    if (actor.kind !== 'agent') return DENY('Only an agent records a purchase outcome.');
    if ((await isMainAgentGroup(actor.agentGroupId)) || (await hasBrowserAccess(actor.agentGroupId)))
      return ALLOW('A delegating agent records what it learned of its own errand’s purchase.');
    return DENY('Only an agent with browser access records a purchase outcome.');
  },
});

/** An errand's own group records its attempts; main records those of a group whose browser access was removed. */
async function mayRecord(caller: string, owner: string): Promise<boolean> {
  if (caller === owner) return true;
  return (await isMainAgentGroup(caller)) && !(await hasBrowserAccess(owner));
}

const OUTCOME_FIELDS: ReadonlySet<string> = new Set([
  'action',
  'requestId',
  'thread',
  'attempt_id',
  'outcome',
  'source',
]);

/** An answer as main recorded it, and its source. */
function recordedAs(attempt: PurchaseAttemptRow): {
  outcome: 'placed' | 'not_placed';
  source: ResolutionSource | null;
} {
  return { outcome: attempt.resolution === 'committed' ? 'placed' : 'not_placed', source: attempt.resolution_source };
}

/**
 * Main records the outcome of an attempt its errand left unconfirmed, from the merchant's order email or the
 * principal's answer. The attempt is one of that errand's, named by the id its state shows. The first recording
 * stands; a later one returns it, and a "placed" against a recorded "not placed" is a possible duplicate.
 */
export async function recordPurchaseOutcome(
  content: Record<string, unknown>,
  session: Session,
  queue?: () => BrowserQueue,
): Promise<Record<string, unknown>> {
  if (Object.keys(content).some((key) => !OUTCOME_FIELDS.has(key)))
    throw invalidArgs('Unknown record_purchase_outcome field.');
  const { thread, attempt_id: attemptId, outcome, source } = content;
  if (
    typeof thread !== 'string' ||
    typeof attemptId !== 'string' ||
    (outcome !== 'placed' && outcome !== 'not_placed') ||
    (source !== 'email' && source !== 'principal')
  )
    throw invalidArgs(
      'record_purchase_outcome needs the job thread, the attempt id its state shows, placed or not_placed, and the source: email or principal.',
    );
  const browser = new BrowserStore();
  const job = await browser.getJob(thread);
  if (
    !job ||
    errandSource(job.thread_id) !== job.source_agent_group_id ||
    !(await mayRecord(session.agent_group_id, job.source_agent_group_id))
  )
    throw forbidden('No browser job of yours exists for that thread.');
  const store = new PurchaseAuthorityStore(browser.db);
  const attempt = await store.attempt(attemptId);
  if (!attempt || attempt.job_id !== job.id)
    throw forbidden("That job made no purchase with that attempt id: use the id the job's state shows.");
  // A press still in progress settles from its own page first.
  if (!attempt.resolution && !attempt.unconfirmed_at) return { status: 'in_progress', thread: job.thread_id };
  const placed = outcome === 'placed';
  const { booking } = attemptSummary(attempt);
  const result = await store.resolve(attempt.id, {
    placed,
    source,
    evidence: { recorded_by: session.agent_group_id, source },
    outcome: {
      status: placed ? (booking ? 'booked' : 'placed') : 'not_placed',
      source,
      attempt_id: attempt.id,
      repeat_safe: false,
    },
  });
  switch (result.status) {
    case 'resolved':
      return { status: 'recorded', thread: job.thread_id, outcome, source };
    case 'already_resolved': {
      const recorded = recordedAs(result.attempt);
      if (placed && recorded.outcome === 'not_placed') {
        await lateConfirmation(job, result.attempt, source, queue?.());
        return { status: 'possible_duplicate', thread: job.thread_id, recorded };
      }
      return { status: 'already_recorded', thread: job.thread_id, ...recorded };
    }
    case 'record_used':
    case 'no_attempt':
      throw forbidden("That job made no purchase with that attempt id: use the id the job's state shows.");
    default: {
      const unknown: never = result;
      throw new Error(`Unknown resolution ${JSON.stringify(unknown)}`);
    }
  }
}

/**
 * A purchase recorded not placed, reported placed after all (KTD10): the incident and its job's stop in one
 * transaction, then the urgent notice and the cancellation's own work.
 */
async function lateConfirmation(
  job: BrowserJob,
  attempt: PurchaseAttemptRow,
  source: 'email' | 'principal',
  queue: BrowserQueue | undefined,
): Promise<void> {
  const { incident, stop } = await recordIncidentWithStop(new BrowserStore(), job.thread_id, {
    kind: 'late_confirmation',
    site: attempt.site,
    attemptId: attempt.id,
    evidenceKey: attempt.id,
    evidence: { reported: 'placed', source, recorded: recordedAs(attempt) },
  });
  /* eslint-disable no-catch-all/no-catch-all -- the incident is recorded: the sweep retries a notice that fails here */
  try {
    await notifyIncident(incident.id);
  } catch (error) {
    log.warn('A browser incident notice will be retried', {
      incident: incident.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  /* eslint-enable no-catch-all/no-catch-all */
  await finishBrowserJobCancellation(stop, queue);
}

export function registerPurchaseOutcomeDelivery(queue: () => BrowserQueue): void {
  registerDeliveryAction(
    'record_purchase_outcome',
    answeringAction('record_purchase_outcome', (content, session) => recordPurchaseOutcome(content, session, queue)),
    answeredGuard(purchaseOutcomeGuard),
  );
}
