/** Native job reads and cancellation, shared by delegation, matters and policy reconciliation. */
import { answeredGuard, answeringAction, forbidden, invalidArgs } from '../../cli/delivery-action.js';
import { getSession, updateSession } from '../../db/sessions.js';
import { getDb } from '../../db/connection.js';
import { registerDeliveryAction } from '../../delivery.js';
import { ALLOW, DENY, defineGuardedAction } from '../../guard/index.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import type { PendingApproval, Session } from '../../types.js';
import { getBrowserAgentGroupId, getMainAgentGroupId } from '../gws-ea-profile/db.js';
import type { DbDriver } from '../../db/driver.js';
import { BrowserStore, type BrowserJob } from './db.js';
import { credentialAttempts, type CredentialAttempt } from './credential-attempts.js';
import { heldCredentialSites, SiteLeaseStore } from './leases.js';
import { detachPurchaseCards, finishPurchaseCardWithdrawals } from './cards.js';
import { readBrowserPolicy } from './policy.js';
import type { BrowserQueue } from './queue.js';

export type BrowserJobState = 'idle' | 'working' | 'awaiting_principal' | 'watching' | 'cancelled';
export interface BrowserJobView {
  readonly job: BrowserJob;
  readonly state: BrowserJobState;
  readonly held_sites: readonly string[];
  readonly waiting_sign_in?: { readonly site: string; readonly origin: string; readonly expires_at: string };
  /** The delivered report's raw text; the rendering boundary frames it as untrusted. */
  readonly last_report?: { readonly at: string; readonly text: string };
}

/** An existing native main-owned thread only; job rows are lazy, session ownership is not. */
export async function resolveBrowserJob(thread: string, store = new BrowserStore()): Promise<BrowserJob | undefined> {
  const main = await getMainAgentGroupId();
  const browser = await getBrowserAgentGroupId();
  if (main === null || browser === null || !thread.startsWith(`system:a2a:${main}:`)) return undefined;
  const existing = await store.getJob(thread);
  if (existing) return existing.source_agent_group_id === main ? existing : undefined;
  const session = await store.db.get<Session>(
    'SELECT * FROM sessions WHERE agent_group_id = ? AND messaging_group_id IS NULL AND thread_id = ?',
    browser,
    thread,
  );
  return session ? store.jobForSession(session) : undefined;
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

/** DB-only half: callers may join authority/watch/card changes in this same transaction. */
export async function cancelBrowserJobInTransaction(
  thread: string,
  store = new BrowserStore(),
): Promise<BrowserJobCancellation> {
  const job = await resolveBrowserJob(thread, store);
  if (!job) throw invalidArgs('No main-owned browser job exists for that thread.');
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

/** Side effects run only after the cancellation transaction commits. */
export async function finishBrowserJobCancellation(
  result: BrowserJobCancellation,
  queue = cancellationQueue,
): Promise<void> {
  if (result.abandonedAttempts?.length) await credentialAttempts.retireCandidates(result.abandonedAttempts);
  if (result.withdrawnCards)
    await finishPurchaseCardWithdrawals(result.withdrawnCards, 'Withdrawn: this browser errand was cancelled.');
  if (result.withdrawnCards && (await getDb().hasTable('gws_ea_browser_watches')))
    for (const card of result.withdrawnCards)
      await getDb().run(
        'UPDATE gws_ea_browser_watches SET approval_finished_at = ? WHERE approval_id = ?',
        new Date().toISOString(),
        card.approval_id,
      );
  if (!queue || result.status === 'already_cancelled' || result.status === 'in_progress') return;
  await queue.interruptJob(result.job.id);
  await queue.runtime.closeJob(result.job.id);
  await queue.wakeWaiters(result.waitingJobs, `cancel:${result.job.id}`);
}

export async function cancelBrowserJob(thread: string, store = new BrowserStore()): Promise<BrowserJobCancellation> {
  const result = await store.db.transaction(() => cancelBrowserJobInTransaction(thread, store));
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
    if (actor.kind !== 'agent' || actor.agentGroupId !== (await getMainAgentGroupId()))
      return DENY('Only main may manage browser jobs.');
    if (!(await readBrowserPolicy()).enabled)
      return DENY('The operator needs to enable the browser for this assistant.');
    return ALLOW('Canonical main manages its own browser errands.');
  },
});

/** Relay and guarantee register their real handlers separately against this same guard. */
export function registerBrowserCancellationDelivery(queue: () => BrowserQueue): void {
  registerDeliveryAction(
    'cancel_job',
    answeringAction('cancel_job', async (content) => {
      if (typeof content.thread !== 'string' || !content.thread) throw invalidArgs('thread is required');
      if (!(await readBrowserPolicy()).enabled)
        throw forbidden('The operator needs to enable the browser for this assistant.');
      configureBrowserCancellation(queue());
      const result = await cancelBrowserJob(content.thread);
      return { status: result.status, thread: result.thread };
    }),
    answeredGuard(browserDelegateGuard),
  );
}
