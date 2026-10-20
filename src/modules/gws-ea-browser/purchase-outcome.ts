/**
 * Purchase outcomes the page could not prove (KTD8, KTD9; R10, R11). An attempt with no page proof either way is
 * unconfirmed: its delegating group hears so once, and another purchase on its site waits on it while browsing
 * there goes on. The merchant's order email reaches main like any mail, and otherwise main asks the principal
 * once; main records what it learned through `record_purchase_outcome`, by the attempt id the host's unconfirmed
 * notice gave, never one a browser report gives.
 *
 * Every recording goes through the authority store's one resolve function: the first source to record an
 * outcome wins, and a later recording gets the recorded outcome back. A "placed" for an attempt recorded not
 * placed is the merchant's late confirmation of a possible duplicate: an incident, whose alarm is the recorder's
 * own answer (KTD15). Main records the attempts of a group whose browser access was removed, and that group hears
 * only that its errand stopped.
 */
import { answeredGuard, answeringAction, forbidden, invalidArgs } from '../../cli/delivery-action.js';
import { getDb } from '../../db/connection.js';
import { getSession } from '../../db/sessions.js';
import type { DbDriver } from '../../db/driver.js';
import { registerDeliveryAction } from '../../delivery.js';
import { ALLOW, DENY, defineGuardedAction } from '../../guard/index.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { errandSource, hasBrowserAccess, isMainAgentGroup } from './access.js';
import { PurchaseAuthorityStore, type PurchaseAttemptRow, type ResolutionSource } from './authority.js';
import { finishBrowserJobCancellation } from './cancel.js';
import { BrowserStore, type BrowserJob } from './db.js';
import { recordIncidentWithStop } from './incidents.js';
import { attemptSummary, notifyUnconfirmedPurchase, tellDelegator } from './notices.js';
import type { BrowserQueue } from './queue.js';

/** Every delegator reads the attempt id in the host's unconfirmed notice; only main also reads job state. */
const NO_SUCH_ATTEMPT =
  "That job made no purchase with that attempt id: use the attempt id the host's unconfirmed notice gave.";

/** The host's sweep: every unconfirmed attempt whose delegating group has not heard of it yet. */
export async function notifyPendingUnconfirmed(db: DbDriver = getDb()): Promise<void> {
  for (const { id } of await db.all<{ id: string }>(
    `SELECT id FROM gws_ea_browser_purchase_attempts WHERE resolution IS NULL AND unconfirmed_at IS NOT NULL AND notified_at IS NULL
     UNION ALL SELECT id FROM gws_ea_browser_free_attempts WHERE resolution IS NULL AND unconfirmed_at IS NOT NULL AND notified_at IS NULL`,
  )) {
    const attempt = await new PurchaseAuthorityStore(db).attempt(id);
    if (attempt) await notifyUnconfirmedPurchase(attempt, db);
  }
}

/** Who may record an attempt's outcome: an agent with browser access, and main whatever the setting lists. */
const purchaseOutcomeGuard = defineGuardedAction({
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
 * principal's answer. The attempt is one of that errand's, named by the id the host's unconfirmed notice gave. The first recording
 * stands; a later one returns it, and a "placed" against a recorded "not placed" is a possible duplicate.
 */
export async function recordPurchaseOutcome(
  content: Record<string, unknown>,
  session: Session,
  queue: () => BrowserQueue,
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
      "record_purchase_outcome needs the job thread, the attempt id the host's unconfirmed notice gave, placed or not_placed, and the source: email or principal.",
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
  if (!attempt || attempt.job_id !== job.id) throw forbidden(NO_SUCH_ATTEMPT);
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
        const created = await lateConfirmation(job, result.attempt, source, session.agent_group_id, queue());
        const { what, total } = attemptSummary(result.attempt);
        const purchase = `The ${what}${total ? ` for ${total}` : ''}`;
        return {
          status: 'possible_duplicate',
          thread: job.thread_id,
          recorded,
          message: created
            ? `${purchase} was recorded as not placed and is now reported placed after all, so the principal may ` +
              'have bought it twice. The host stopped this errand. Tell the principal now.'
            : `${purchase} was already reported as a possible duplicate, and the host stopped this errand then.`,
        };
      }
      return { status: 'already_recorded', thread: job.thread_id, ...recorded };
    }
    case 'record_used':
    case 'no_attempt':
      throw forbidden(NO_SUCH_ATTEMPT);
    default: {
      const unknown: never = result;
      throw new Error(`Unknown resolution ${JSON.stringify(unknown)}`);
    }
  }
}

/**
 * A purchase recorded not placed, reported placed after all (KTD10): the incident and its job's stop in one
 * transaction, then the cancellation's own work. The recorder's answer is the alarm, so the incident is recorded
 * told (KTD15); a delegating group other than the recorder hears only that its errand stopped. Whether this
 * report raised the incident, rather than finding it raised.
 */
async function lateConfirmation(
  job: BrowserJob,
  attempt: PurchaseAttemptRow,
  source: 'email' | 'principal',
  recorder: string,
  queue: BrowserQueue,
): Promise<boolean> {
  const { incident, stop, created } = await recordIncidentWithStop(new BrowserStore(), job.thread_id, {
    kind: 'late_confirmation',
    site: attempt.site,
    attemptId: attempt.id,
    evidenceKey: attempt.id,
    evidence: { reported: 'placed', source, recorded: recordedAs(attempt) },
    told: true,
  });
  /* eslint-disable no-catch-all/no-catch-all -- the incident and the job's stop are recorded, and the recorder's
     answer carries the alarm: a notice or cleanup that fails never turns the possible duplicate into an error */
  if (created && job.source_agent_group_id !== recorder)
    try {
      const session = await getSession(job.browser_session_id);
      const told = session
        ? await tellDelegator(
            { job: job.thread_id, session, source: job.source_agent_group_id },
            {
              id: `browser-incident-${incident.id}-stopped`,
              timestamp: new Date().toISOString(),
              text:
                `Browser job ${job.thread_id} was stopped: the purchase on ${attempt.site} recorded as not placed was ` +
                'reported placed after all. Main is telling the principal, so nothing more is needed from you.',
            },
          )
        : 'no-delegating-session';
      if (told !== 'written' && told !== 'already-written')
        log.warn('A stopped errand’s delegating group could not be told', { incident: incident.id, result: told });
    } catch (error) {
      log.warn('A stopped errand’s delegating group could not be told', {
        incident: incident.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  try {
    await finishBrowserJobCancellation(stop, queue);
  } catch (error) {
    log.warn('A stopped browser job could not be cleaned up', {
      job: stop.job.id,
      incident: incident.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  /* eslint-enable no-catch-all/no-catch-all */
  return created;
}

export function registerPurchaseOutcomeDelivery(queue: () => BrowserQueue): void {
  registerDeliveryAction(
    'record_purchase_outcome',
    answeringAction('record_purchase_outcome', (content, session) => recordPurchaseOutcome(content, session, queue)),
    answeredGuard(purchaseOutcomeGuard),
  );
}
