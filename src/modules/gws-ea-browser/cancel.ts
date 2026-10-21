/** Native job reads and cancellation, shared by delegation, matters and policy reconciliation. */
import { answeredGuard, answeringAction, forbidden, invalidArgs } from '../../cli/delivery-action.js';
import { getSession, updateSession } from '../../db/sessions.js';
import { getDb } from '../../db/connection.js';
import { registerDeliveryAction } from '../../delivery.js';
import { ALLOW, DENY, defineGuardedAction } from '../../guard/index.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import type { PendingApproval, Session } from '../../types.js';
import { getBrowserAgentGroupId } from '../gws-ea-profile/db.js';
import type { DbDriver } from '../../db/driver.js';
import { errandSource, hasBrowserAccess } from './access.js';
import { BrowserStore, type BrowserJob } from './db.js';
import { credentialAttempts, type CredentialAttempt } from './credential-attempts.js';
import { heldCredentialSites, SiteLeaseStore } from './leases.js';
import { PurchaseAuthorityStore } from './authority.js';
import { cardTime, detachPurchaseCards, finishPurchaseCardWithdrawals } from './cards.js';
import { formatMoney, type PurchaseFacts } from './fingerprint.js';
import { principalClock } from './watch-policy.js';
import { readBrowserPolicy } from './policy.js';
import type { BrowserQueue } from './queue.js';

export type BrowserJobState = 'idle' | 'working' | 'awaiting_principal' | 'watching' | 'cancelled';
/** The purchase card the principal is asked: its merchant and money, and when it lapses on their clock. */
export interface BrowserJobCard {
  readonly site: string;
  readonly total: string;
  readonly due_now: string;
  readonly expires: string;
}
/**
 * A purchase of the job's with no page proof (KTD8), and the attempt id main records its outcome against: never
 * one a browser report gives (KTD9). Its press is on the principal's clock.
 */
export interface BrowserJobUnconfirmed {
  readonly attempt_id: string;
  readonly what: string;
  readonly total?: string;
  readonly pressed: string;
}
export interface BrowserJobView {
  readonly job: BrowserJob;
  readonly state: BrowserJobState;
  readonly held_sites: readonly string[];
  readonly waiting_sign_in?: { readonly site: string; readonly origin: string; readonly expires_at: string };
  readonly open_card?: BrowserJobCard;
  readonly unconfirmed?: readonly BrowserJobUnconfirmed[];
  /** The delivered report's raw text; the rendering boundary frames it as untrusted. */
  readonly last_report?: { readonly at: string; readonly text: string };
}

/** The job's open card and unconfirmed purchases, as main reads them in the principal's time (KTD18). */
async function purchaseState(
  store: BrowserStore,
  jobId: string,
): Promise<{ open_card?: BrowserJobCard; unconfirmed?: BrowserJobUnconfirmed[] }> {
  if (!(await store.db.hasTable('gws_ea_browser_purchase_cards'))) return {};
  const card = await store.db.get<{ facts_json: string; expires_at: string }>(
    "SELECT facts_json,expires_at FROM gws_ea_browser_purchase_cards WHERE job_id = ? AND status = 'open' ORDER BY created_at DESC LIMIT 1",
    jobId,
  );
  const attempts = await new PurchaseAuthorityStore(store.db).unconfirmedOf(jobId);
  if (!card && !attempts.length) return {};
  const [{ attemptSummary }, zone] = await Promise.all([import('./purchase-outcome.js'), principalClock()]);
  const facts = card ? (JSON.parse(card.facts_json) as PurchaseFacts) : undefined;
  return {
    ...(card && facts
      ? {
          open_card: {
            site: facts.site,
            total: formatMoney(facts.totalMinor, facts.currency),
            due_now: formatMoney(facts.dueNowMinor, facts.currency),
            expires: cardTime(card.expires_at, zone),
          },
        }
      : {}),
    ...(attempts.length
      ? {
          unconfirmed: attempts.map((attempt) => {
            const { what, total } = attemptSummary(attempt);
            return {
              attempt_id: attempt.id,
              what,
              ...(total ? { total } : {}),
              pressed: cardTime(attempt.attempted_at, zone),
            };
          }),
        }
      : {}),
  };
}

/**
 * An existing native errand thread only; job rows are lazy, session ownership
 * is not. With `owner`, only an errand that group opened, created only while
 * it has browser access; without, the host's own reach to any errand, as
 * cancellation needs once a group's access ended.
 */
export async function resolveBrowserJob(
  thread: string,
  store = new BrowserStore(),
  owner?: string,
): Promise<BrowserJob | undefined> {
  const source = errandSource(thread);
  const browser = await getBrowserAgentGroupId();
  if (source === undefined || browser === null || (owner !== undefined && source !== owner)) return undefined;
  const existing = await store.getJob(thread);
  if (existing) return existing.source_agent_group_id === source ? existing : undefined;
  const session = await store.db.get<Session>(
    'SELECT * FROM sessions WHERE agent_group_id = ? AND messaging_group_id IS NULL AND thread_id = ?',
    browser,
    thread,
  );
  if (!session) return undefined;
  return owner === undefined ? store.errandJob(session) : store.jobForSession(session);
}

export async function readBrowserJob(thread: string, store = new BrowserStore()): Promise<BrowserJobView | undefined> {
  const job = await resolveBrowserJob(thread, store);
  if (!job) return undefined;
  const browser = await getBrowserAgentGroupId();
  if (browser === null) return undefined;
  const leases = await store.db.all<{ site: string }>(
    'SELECT site FROM gws_ea_browser_site_leases WHERE job_id = ? ORDER BY site',
    job.id,
  );
  const purchases = await store.db.hasTable('gws_ea_browser_purchase_cards');
  const card = purchases
    ? await store.db.get(
        "SELECT 1 FROM gws_ea_browser_purchase_cards WHERE job_id = ? AND status = 'open' LIMIT 1",
        job.id,
      )
    : undefined;
  const authority = purchases
    ? await store.db.get(
        "SELECT 1 FROM gws_ea_browser_authorities WHERE job_id = ? AND state IN ('live','committing') LIMIT 1",
        job.id,
      )
    : undefined;
  const running = await store.db.get(
    'SELECT 1 FROM gws_ea_browser_requests WHERE job_id = ? AND started_at IS NOT NULL AND answered_at IS NULL LIMIT 1',
    job.id,
  );
  const hasWatches = await store.db.hasTable('gws_ea_browser_watches');
  const watchCard = hasWatches
    ? await store.db.get(
        "SELECT 1 FROM gws_ea_browser_watches WHERE job_id = ? AND status = 'awaiting_principal' LIMIT 1",
        job.id,
      )
    : undefined;
  const watch = hasWatches
    ? await store.db.get(
        "SELECT 1 FROM gws_ea_browser_watches WHERE job_id = ? AND status IN ('armed','checking','preparing','booking') LIMIT 1",
        job.id,
      )
    : undefined;
  const waitingSignIn = job.cancelled
    ? undefined
    : await (await import('./sign-in-mail.js')).readPendingSignInSite(job.id);
  const report = await withExistingMailboxSession(browser, job.browser_session_id, (mailbox) =>
    mailbox.getLatestDeliveredAgentReport(job.source_agent_group_id),
  );
  let text: string | undefined;
  if (report) {
    try {
      const value: unknown = JSON.parse(report.content);
      if (typeof value === 'object' && value !== null && 'text' in value && typeof value.text === 'string')
        text = value.text;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  return {
    job,
    state: job.cancelled
      ? 'cancelled'
      : card || watchCard
        ? 'awaiting_principal'
        : running || leases.length > 0
          ? 'working'
          : watch
            ? 'watching'
            : authority
              ? 'working'
              : 'idle',
    held_sites: leases.map((lease) => lease.site),
    ...(waitingSignIn ? { waiting_sign_in: waitingSignIn } : {}),
    ...(await purchaseState(store, job.id)),
    ...(text === undefined || !report ? {} : { last_report: { at: report.timestamp, text } }),
  };
}

export interface BrowserJobCancellation {
  readonly status: 'cancelled' | 'already_cancelled' | 'in_progress';
  readonly thread: string;
  readonly job: BrowserJob;
  readonly waitingJobs: readonly string[];
  readonly withdrawnCards?: readonly PendingApproval[];
  /** Credential attempts that disclosed nothing: their unused candidates are archived after commit. */
  readonly abandonedAttempts?: readonly CredentialAttempt[];
}

/** A purchase commit or watch booking in progress, which finishes and reports before cancellation completes. */
async function committing(db: DbDriver, jobId: string): Promise<boolean> {
  const purchase =
    (await db.hasTable('gws_ea_browser_authorities')) &&
    (await db.get("SELECT 1 FROM gws_ea_browser_authorities WHERE job_id = ? AND state = 'committing' LIMIT 1", jobId));
  const booking =
    (await db.hasTable('gws_ea_browser_watches')) &&
    (await db.get("SELECT 1 FROM gws_ea_browser_watches WHERE job_id = ? AND status = 'booking' LIMIT 1", jobId));
  return Boolean(purchase) || Boolean(booking);
}

/**
 * Work a cancellation waits for: a commit or booking in progress, or a
 * credential attempt the website may have taken that is not yet settled.
 * Each finishes or is reconciled through this still-live job.
 */
async function unresolvedWork(db: DbDriver, jobId: string): Promise<boolean> {
  return (await committing(db, jobId)) || (await heldCredentialSites(db, jobId)).size > 0;
}

/**
 * DB-only half: callers may join authority/watch/card changes in this same
 * transaction. With `owner`, only an errand that group opened.
 */
export async function cancelBrowserJobInTransaction(
  thread: string,
  store = new BrowserStore(),
  owner?: string,
): Promise<BrowserJobCancellation> {
  const job = await resolveBrowserJob(thread, store, owner);
  if (!job) throw invalidArgs('No delegated browser job exists for that thread.');
  if (job.cancelled) return { status: 'already_cancelled', thread, job, waitingJobs: [] };
  const purchases = await store.db.hasTable('gws_ea_browser_authorities');
  const inProgress = await committing(store.db, job.id);
  const withdrawnCards = purchases ? await detachPurchaseCards(job.id, 'withdrawn') : [];
  if (await store.db.hasTable('gws_ea_browser_watches'))
    withdrawnCards.push(...(await (await import('./watches.js')).detachBrowserWatchCards(job.id, 'cancelled')));
  // No authority the job has not used survives it: nothing was disclosed for these.
  const abandonedAttempts = (await store.db.hasTable('gws_ea_browser_credential_attempts'))
    ? await credentialAttempts.abandonForJob(job.id)
    : [];
  // Read after abandoning, so an attempt whose disclosure won the race keeps the job live.
  if (inProgress || (await heldCredentialSites(store.db, job.id)).size > 0) {
    await store.db.run(
      'UPDATE gws_ea_browser_jobs SET cancel_requested = 1,updated_at = ? WHERE id = ?',
      new Date().toISOString(),
      job.id,
    );
    return { status: 'in_progress', thread, job, waitingJobs: [], withdrawnCards, abandonedAttempts };
  }
  await store.db.run(
    'UPDATE gws_ea_browser_jobs SET cancelled = 1, updated_at = ? WHERE id = ?',
    new Date().toISOString(),
    job.id,
  );
  const waitingJobs = await new SiteLeaseStore(store.db).release(job.id);
  return { status: 'cancelled', thread, job, waitingJobs, withdrawnCards, abandonedAttempts };
}

let cancellationQueue: BrowserQueue | undefined;
/** Composition supplies the running native queue; matters and disable use the same cancellation path. */
export function configureBrowserCancellation(queue: BrowserQueue): void {
  cancellationQueue = queue;
}

/**
 * Side effects run only after the cancellation transaction commits. `running` names a request that stopped its
 * own job: it answers for itself, so it is never interrupted.
 */
export async function finishBrowserJobCancellation(
  result: BrowserJobCancellation,
  queue = cancellationQueue,
  running?: string,
): Promise<void> {
  const cleanup = await Promise.allSettled([
    (async () => {
      if (result.abandonedAttempts?.length) await credentialAttempts.retireCandidates(result.abandonedAttempts);
    })(),
    (async () => {
      if (!result.withdrawnCards) return;
      await finishPurchaseCardWithdrawals(result.withdrawnCards, 'Withdrawn: this browser errand was cancelled.');
      if (await getDb().hasTable('gws_ea_browser_watches'))
        for (const card of result.withdrawnCards)
          await getDb().run(
            'UPDATE gws_ea_browser_watches SET approval_finished_at = ? WHERE approval_id = ?',
            new Date().toISOString(),
            card.approval_id,
          );
    })(),
    (async () => {
      if (!queue || result.status === 'already_cancelled' || result.status === 'in_progress') return;
      try {
        await queue.interruptJob(result.job.id, running);
      } finally {
        await queue.runtime.closeJob(result.job.id).catch(() => undefined);
        await queue.wakeWaiters(result.waitingJobs, `cancel:${result.job.id}`);
      }
    })(),
  ]);
  const failed = cleanup.find((result) => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
}

export async function cancelBrowserJob(
  thread: string,
  store = new BrowserStore(),
  owner?: string,
): Promise<BrowserJobCancellation> {
  const result = await store.db.transaction(() => cancelBrowserJobInTransaction(thread, store, owner));
  await finishBrowserJobCancellation(result);
  return result;
}

/**
 * Completes a cancellation that answered in_progress once the work it waited
 * for has settled; until then the job stays live so it can settle it.
 */
export async function finishRequestedCancellation(jobId: string, queue: BrowserQueue): Promise<void> {
  const { db } = queue.store;
  const result = await db.transaction(async (): Promise<BrowserJobCancellation | undefined> => {
    const job = await db.get<BrowserJob & { cancel_requested: number }>(
      'SELECT * FROM gws_ea_browser_jobs WHERE id = ?',
      jobId,
    );
    if (!job || job.cancelled || !job.cancel_requested || (await unresolvedWork(db, jobId))) return undefined;
    await db.run(
      'UPDATE gws_ea_browser_jobs SET cancelled = 1, updated_at = ? WHERE id = ?',
      new Date().toISOString(),
      jobId,
    );
    return {
      status: 'cancelled',
      thread: job.thread_id,
      job: { ...job, cancelled: 1 },
      waitingJobs: await new SiteLeaseStore(db).release(jobId),
    };
  });
  if (result) await finishBrowserJobCancellation(result, queue);
}

const JOB_IDLE_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

/** Terminal sessions close conditionally; durable jobs and purchase uncertainty remain. */
export async function sweepBrowserJobSessions(
  at = new Date().toISOString(),
  store = new BrowserStore(),
): Promise<void> {
  const cutoff = Date.parse(at) - JOB_IDLE_RETENTION_MS;
  const jobs = await store.db.all<BrowserJob>('SELECT * FROM gws_ea_browser_jobs ORDER BY id');
  for (const job of jobs) {
    const session = await getSession(job.browser_session_id);
    if (!session || session.status !== 'active' || session.container_status === 'running') continue;
    if (
      !(
        Math.max(
          Date.parse(job.updated_at),
          Date.parse(session.created_at),
          Date.parse(session.last_active ?? session.created_at),
        ) <= cutoff
      )
    )
      continue;
    const view = await readBrowserJob(job.thread_id, store);
    if (!view || (view.state !== 'idle' && view.state !== 'cancelled')) continue;
    if ((await store.pending(job.id)).length > 0) continue;
    const mailbox = await withExistingMailboxSession(session.agent_group_id, session.id, (messages) => ({
      latest: Math.max(
        ...messages.getInboundHistory(1).map((message) => Date.parse(message.timestamp)),
        ...messages.getOutboundHistory(1).map((message) => Date.parse(message.timestamp)),
      ),
      pending:
        messages.countDueMessages() > 0 ||
        messages.getProcessingClaims().length > 0 ||
        messages.getDueMessages(messages.getDeliveredIds()).length > 0,
    }));
    if (mailbox?.pending) continue;
    const lastActivity = Math.max(
      Date.parse(job.updated_at),
      Date.parse(session.created_at),
      Date.parse(session.last_active ?? session.created_at),
      mailbox?.latest ?? -Infinity,
    );
    if (!(lastActivity <= cutoff)) continue;
    await store.db.transaction(async () => {
      const currentSession = await getSession(session.id);
      const currentJob = await store.getJob(job.id);
      if (
        !currentSession ||
        !currentJob ||
        currentSession.status !== 'active' ||
        currentSession.container_status === 'running' ||
        currentSession.last_active !== session.last_active ||
        currentJob.updated_at !== job.updated_at ||
        currentJob.cancelled !== job.cancelled
      )
        return;
      // Re-read host-owned work under the closing transaction; workers cannot race it.
      const pending = await store.pending(job.id);
      const lease = await store.db.get('SELECT 1 FROM gws_ea_browser_site_leases WHERE job_id = ? LIMIT 1', job.id);
      const purchase =
        (await store.db.hasTable('gws_ea_browser_authorities')) &&
        ((await store.db.get(
          "SELECT 1 FROM gws_ea_browser_authorities WHERE job_id = ? AND state IN ('live','committing') LIMIT 1",
          job.id,
        )) ||
          (await store.db.get(
            "SELECT 1 FROM gws_ea_browser_purchase_cards WHERE job_id = ? AND status = 'open' LIMIT 1",
            job.id,
          )));
      const watch =
        (await store.db.hasTable('gws_ea_browser_watches')) &&
        (await store.db.get(
          "SELECT 1 FROM gws_ea_browser_watches WHERE job_id = ? AND status IN ('awaiting_principal','armed','checking','preparing','booking') LIMIT 1",
          job.id,
        ));
      // An unresolved credential attempt can be settled only through this job.
      const credential = (await heldCredentialSites(store.db, job.id)).size > 0;
      if (pending.length > 0 || lease || purchase || watch || credential) return;
      await updateSession(session.id, { status: 'closed' });
    });
  }
}

export const browserDelegateGuard = defineGuardedAction({
  action: 'gws_ea_browser.delegate',
  async decide({ actor }) {
    const policy = await readBrowserPolicy();
    if (actor.kind !== 'agent' || !(await hasBrowserAccess(actor.agentGroupId, policy)))
      return DENY('Only an agent with browser access may manage browser jobs.');
    if (!policy.enabled) return DENY('The operator needs to enable the browser for this assistant.');
    return ALLOW('An agent with browser access manages its own browser errands.');
  },
});

/** Relay and guarantee register their real handlers separately against this same guard. */
export function registerBrowserCancellationDelivery(queue: () => BrowserQueue): void {
  registerDeliveryAction(
    'cancel_job',
    answeringAction('cancel_job', async (content, session) => {
      if (typeof content.thread !== 'string' || !content.thread) throw invalidArgs('thread is required');
      if (!(await readBrowserPolicy()).enabled)
        throw forbidden('The operator needs to enable the browser for this assistant.');
      configureBrowserCancellation(queue());
      // Each agent cancels only the errands it opened.
      const result = await cancelBrowserJob(content.thread, undefined, session.agent_group_id);
      return { status: result.status, thread: result.thread };
    }),
    answeredGuard(browserDelegateGuard),
  );
}
