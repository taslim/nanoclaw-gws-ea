import { createHash } from 'node:crypto';
import type { ElementHandle, Page } from 'playwright-core';
import { forbidden, invalidArgs } from '../../cli/delivery-action.js';
import { getDb } from '../../db/connection.js';
import type { DbDriver } from '../../db/driver.js';
import { getPendingApproval, getSession } from '../../db/sessions.js';
import { DENY, HOLD, defineGuardedAction, guard } from '../../guard/index.js';
import { isRecord } from '../../gws-ea/validation.js';
import { registerApprovalHandler, requestApproval } from '../approvals/index.js';
import { registerApprovalResolvedHandler } from '../approvals/primitive.js';
import { isVerifiedPrincipalUser, principalApproverUserId } from '../gws-ea-profile/db.js';
import {
  PurchaseAuthorityError,
  PurchaseAuthorityStore,
  notifyPurchaseOutcome,
  type SpendingAuthority,
} from './authority.js';
import {
  detachPurchaseCards,
  finishPurchaseCardWithdrawals,
  notifyPurchaseCard,
  renderPurchaseCard,
  type PurchaseCard,
} from './cards.js';
import { activateControl, BrowserSiteBusyError, withBrowserJobNavigation } from './commit-classifier.js';
import { SiteLeaseStore } from './leases.js';
import { BrowserStore } from './db.js';
import { materialPurchaseChange, type PurchaseBounds, type PurchaseFacts } from './fingerprint.js';
import { readMerchantPurchase, readMerchantPurchaseEvidence } from './merchant-signatures.js';
import { disposeBrowserRefs, pinBrowserRefs, readBrowserRef } from './observe.js';
import { readBrowserPolicy } from './policy.js';
import {
  BrowserQueue,
  registerBrowserActionDelivery,
  registerBrowserQueuedAction,
  type BrowserExecutionContext,
} from './queue.js';
import { evidenceMatchesAttempt, reconcilePurchaseAttempt, type PurchaseAttempt } from './reconciliation.js';
import { deriveReservationGuaranteeAuthority } from './reservation-guarantee.js';

export const PURCHASE_APPROVAL = 'browser_purchase';
export const PURCHASE_CARD_LIFE_MS = 24 * 60 * 60 * 1000;
let getPurchaseQueue: (() => BrowserQueue) | undefined;
let commitsReady = false;

export const browserPurchaseGuard = defineGuardedAction({
  action: 'gws_ea_browser.purchase',
  grantActionName: PURCHASE_APPROVAL,
  grantCoversRequest: (grant, input) => grant.payload === JSON.stringify(input.payload),
  async decide({ actor, payload }) {
    if (actor.kind !== 'agent' || !actor.sessionId) return DENY('Only a live browser job can request a purchase.');
    const session = await getSession(actor.sessionId);
    const db = getDb();
    const job =
      typeof payload.jobId === 'string'
        ? await db.get<{ browser_session_id: string; cancelled: number; cancel_requested: number }>(
            'SELECT browser_session_id,cancelled,cancel_requested FROM gws_ea_browser_jobs WHERE id = ?',
            payload.jobId,
          )
        : undefined;
    if (
      !session ||
      !(await new BrowserStore(db).jobForSession(session, false)) ||
      session.agent_group_id !== actor.agentGroupId ||
      job?.browser_session_id !== session.id ||
      job.cancelled ||
      job.cancel_requested ||
      session.status !== 'active'
    )
      return DENY('The browser job is no longer live.');
    if (!(await readBrowserPolicy()).enabled) return DENY('Browser is disabled.');
    const principal = await principalApproverUserId();
    return principal
      ? HOLD('A purchase requires the principal to confirm the complete merchant facts.', principal)
      : DENY('No verified principal can confirm this purchase.');
  },
});
function cardPayload(card: PurchaseCard): Record<string, unknown> {
  return { cardId: card.id, jobId: card.job_id };
}
function stableId(prefix: string, value: string): string {
  return `${prefix}-${createHash('sha256').update(value).digest('hex')}`;
}

function iso(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)?$/u.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw invalidArgs('Use an ISO date or UTC timestamp.');
  return value;
}
export function validatePurchaseRequest(content: Record<string, unknown>): Record<string, unknown> {
  if (
    Object.keys(content).some(
      (key) =>
        ![
          'action',
          'requestId',
          'operation',
          'target',
          'attempt_id',
          'delivery_window',
          'needed_by',
          'budget_ms',
        ].includes(key),
    )
  )
    throw invalidArgs('Unknown purchase field.');
  const operation = content.operation ?? 'commit';
  if (operation !== 'commit' && operation !== 'reconcile') throw invalidArgs('Unknown purchase operation.');
  const ref = readBrowserRef(content.target, 'target needs a current ref and generation.');
  if (operation === 'reconcile') {
    if (
      typeof content.attempt_id !== 'string' ||
      !content.attempt_id ||
      content.delivery_window !== undefined ||
      content.needed_by !== undefined
    )
      throw invalidArgs('Reconciliation needs only attempt_id and target; no model verdict is accepted.');
    return { operation, target: ref, attempt_id: content.attempt_id };
  }
  if (content.attempt_id !== undefined) throw invalidArgs('attempt_id is for reconciliation.');
  let deliveryWindow: PurchaseBounds['deliveryWindow'];
  if (content.delivery_window !== undefined) {
    if (
      !isRecord(content.delivery_window) ||
      Object.keys(content.delivery_window).some((key) => !['start', 'end'].includes(key))
    )
      throw invalidArgs('delivery_window needs start and end.');
    deliveryWindow = { start: iso(content.delivery_window.start), end: iso(content.delivery_window.end) };
    if (deliveryWindow.start > deliveryWindow.end) throw invalidArgs('The delivery window must be ordered.');
  }
  const neededBy = content.needed_by === undefined ? undefined : iso(content.needed_by);
  return {
    operation,
    target: ref,
    ...(deliveryWindow ? { delivery_window: deliveryWindow } : {}),
    ...(neededBy ? { needed_by: neededBy } : {}),
  };
}
function boundsOf(payload: Record<string, unknown>): PurchaseBounds {
  return {
    ...(isRecord(payload.delivery_window)
      ? { deliveryWindow: payload.delivery_window as { start: string; end: string } }
      : {}),
    ...(typeof payload.needed_by === 'string'
      ? {
          neededBy:
            payload.needed_by.length === 10
              ? `${payload.needed_by}T23:59:59.999Z`
              : new Date(payload.needed_by).toISOString(),
        }
      : {}),
  };
}

async function requestPurchaseCard(
  context: BrowserExecutionContext,
  facts: PurchaseFacts,
  bounds: PurchaseBounds,
  change?: string,
): Promise<Record<string, unknown>> {
  const db = context.store.db;
  const authorities = new PurchaseAuthorityStore(db);
  const exceptions = await authorities.unresolved(facts.site);
  const id = stableId('card', context.request.id);
  const prior = await db.get<PurchaseCard>(
    'SELECT * FROM gws_ea_browser_purchase_cards WHERE request_id = ?',
    context.request.id,
  );
  if (prior)
    return {
      status:
        prior.status === 'open'
          ? 'awaiting_principal'
          : prior.status === 'superseded' || prior.status === 'approved'
            ? 'withdrawn'
            : prior.status,
      card_id: prior.id,
      repeat_safe: false,
    };
  const payload = { cardId: id, jobId: context.job.id };
  const decision = await guard(browserPurchaseGuard, {
    actor: { kind: 'agent', agentGroupId: context.session.agent_group_id, sessionId: context.session.id },
    payload,
  });
  if (decision.effect === 'deny') throw forbidden(decision.reason);
  if (decision.effect !== 'hold') throw forbidden('Purchase confirmation was not held for the principal.');
  const expires = new Date(Date.now() + PURCHASE_CARD_LIFE_MS).toISOString();
  const detached = await db.transaction(async () => {
    const job = await db.get<{ cancelled: number; cancel_requested: number }>(
      'SELECT cancelled,cancel_requested FROM gws_ea_browser_jobs WHERE id = ?',
      context.job.id,
    );
    if (!job || job.cancelled || job.cancel_requested) throw forbidden('The browser job was cancelled.');
    const old = await detachPurchaseCards(context.job.id, 'superseded');
    await db.run(
      `INSERT INTO gws_ea_browser_purchase_cards(id,job_id,request_id,status,facts_json,bounds_json,exception_ids_json,expires_at,created_at)
      VALUES(?,?,?,'open',?,?,?,?,?)`,
      id,
      context.job.id,
      context.request.id,
      JSON.stringify(facts),
      JSON.stringify(bounds),
      JSON.stringify(exceptions),
      expires,
      new Date().toISOString(),
    );
    await db.run(
      "UPDATE gws_ea_browser_site_leases SET state = 'purchase',updated_at = ? WHERE site = ? AND job_id = ?",
      new Date().toISOString(),
      facts.site,
      context.job.id,
    );
    return old;
  });
  await finishPurchaseCardWithdrawals(
    detached,
    'Withdrawn: the checkout changed. A fresh card contains the current facts.',
  );
  const approvalId = await requestApproval({
    session: context.session,
    agentName: 'browser',
    action: PURCHASE_APPROVAL,
    payload,
    title: 'Approve this purchase?',
    question: renderPurchaseCard(facts, bounds, exceptions, change),
    approverUserId: decision.approverUserId,
    expiresAt: expires,
    originLine: `From your browser errand ${context.job.thread_id}.`,
    details: { facts: { site: facts.site, total_minor: String(facts.totalMinor), currency: facts.currency } },
  });
  // A synchronous card click may already have created the authority; never reopen its logical card.
  if (approvalId) {
    const posted = await getPendingApproval(approvalId);
    if (posted)
      await db.run(
        'UPDATE gws_ea_browser_purchase_cards SET approval_json = ? WHERE id = ?',
        JSON.stringify(posted),
        id,
      );
    await db.run(
      'UPDATE gws_ea_browser_purchase_cards SET approval_id = ? WHERE id = ? AND approval_id IS NULL',
      approvalId,
      id,
    );
  } else {
    await db.run("UPDATE gws_ea_browser_purchase_cards SET status = 'withdrawn' WHERE id = ? AND status = 'open'", id);
    await context.wakeWaiters(
      await new SiteLeaseStore(db).release(context.job.id, facts.site),
      `card-delivery-failed-${id}`,
    );
  }
  return { status: approvalId ? 'awaiting_principal' : 'withdrawn', card_id: id, repeat_safe: false };
}

registerApprovalHandler(
  PURCHASE_APPROVAL,
  async ({ session, payload, approval, userId }) => {
    if (!(await isVerifiedPrincipalUser(userId)) || userId !== approval.approver_user_id) return;
    const card =
      typeof payload.cardId === 'string'
        ? await getDb().get<PurchaseCard>('SELECT * FROM gws_ea_browser_purchase_cards WHERE id = ?', payload.cardId)
        : undefined;
    if (
      !card ||
      card.job_id !== payload.jobId ||
      (card.approval_id !== null && card.approval_id !== approval.approval_id)
    )
      return;
    const decision = await guard(browserPurchaseGuard, {
      actor: { kind: 'agent', agentGroupId: session.agent_group_id, sessionId: session.id },
      payload: cardPayload(card),
      grant: approval,
    });
    if (decision.effect !== 'allow') return;
    let authorityId: string | undefined;
    await getDb().transaction(async () => {
      const current = await getDb().get<PurchaseCard>(
        'SELECT * FROM gws_ea_browser_purchase_cards WHERE id = ?',
        card.id,
      );
      const job = await getDb().get<{ cancelled: number; cancel_requested: number }>(
        'SELECT cancelled,cancel_requested FROM gws_ea_browser_jobs WHERE id = ?',
        card.job_id,
      );
      if (
        !(await isVerifiedPrincipalUser(userId)) ||
        !current ||
        !job ||
        job.cancelled ||
        job.cancel_requested ||
        current.expires_at <= new Date().toISOString()
      )
        return;
      const authority = new PurchaseAuthorityStore();
      const id = stableId('authority', card.id);
      if (current.status !== 'open' && !(current.status === 'approved' && (await authority.get(id)))) return;
      const durableAuthority = await authority.create({
        id,
        jobId: card.job_id,
        approvalId: approval.approval_id,
        cardId: card.id,
        kind: 'checkout',
        facts: JSON.parse(card.facts_json) as PurchaseFacts,
        bounds: JSON.parse(card.bounds_json) as PurchaseBounds,
        exceptionIds: JSON.parse(card.exception_ids_json) as string[],
        attemptId: stableId('attempt', card.id),
        expiresAt: card.expires_at,
      });
      await getDb().run(
        "UPDATE gws_ea_browser_purchase_cards SET status = 'approved',approval_id = ?,approval_json = ? WHERE id = ?",
        approval.approval_id,
        JSON.stringify(approval),
        card.id,
      );
      if (durableAuthority.state !== 'live') return;
      await getDb().run(
        'INSERT INTO gws_ea_browser_pending_commits(authority_id) VALUES(?) ON CONFLICT(authority_id) DO NOTHING',
        id,
      );
      authorityId = id;
    });
    // Acceptance is quick and never awaits a browser operation. Early host replay persists only.
    if (authorityId && commitsReady && getPurchaseQueue) await enqueuePurchaseCommit(getPurchaseQueue(), authorityId);
  },
  { restartSafe: true },
);

registerApprovalResolvedHandler(async ({ approval, outcome }) => {
  if (approval.action !== PURCHASE_APPROVAL || outcome === 'approve') return;
  const payload = JSON.parse(approval.payload) as { cardId?: string };
  if (!payload.cardId) return;
  const status = outcome === 'reject' ? 'rejected' : outcome;
  await getDb().run(
    "UPDATE gws_ea_browser_purchase_cards SET status = ? WHERE id = ? AND status = 'open'",
    status,
    payload.cardId,
  );
  await notifyPurchaseCard(payload.cardId, status);
  const card = await getDb().get<PurchaseCard>(
    'SELECT * FROM gws_ea_browser_purchase_cards WHERE id = ?',
    payload.cardId,
  );
  if (card && getPurchaseQueue) {
    const facts = JSON.parse(card.facts_json) as PurchaseFacts;
    const queue = getPurchaseQueue();
    const outstanding =
      (await getDb().get(
        "SELECT 1 FROM gws_ea_browser_purchase_cards WHERE job_id = ? AND status = 'open' LIMIT 1",
        card.job_id,
      )) ||
      (await getDb().get(
        "SELECT 1 FROM gws_ea_browser_authorities WHERE job_id = ? AND state IN ('live','committing') LIMIT 1",
        card.job_id,
      ));
    if (outstanding) return;
    await queue.wakeWaiters(await queue.leases.release(card.job_id, facts.site), `card-${card.id}-${status}`);
  }
});

async function verifyPlaced(
  page: Page,
  authority: SpendingAuthority,
  store: PurchaseAuthorityStore,
): Promise<Record<string, unknown> | undefined> {
  const evidence = await readMerchantPurchaseEvidence(page);
  const attempt = await store.db.get<PurchaseAttempt>(
    'SELECT * FROM gws_ea_browser_purchase_attempts WHERE authority_id = ?',
    authority.id,
  );
  return evidence?.resolution === 'committed' && attempt && evidenceMatchesAttempt(evidence, attempt)
    ? {
        status: evidence.reservation ? 'booked' : 'placed',
        order_number: evidence.recordId,
        evidence,
        repeat_safe: false,
      }
    : undefined;
}

/** Shared by purchase, recipes and native watches. The optional claim joins the same DB-only commit transaction. */
export async function executeAuthorizedPurchase(
  context: BrowserExecutionContext,
  authorityId: string,
  claim?: (db: DbDriver, authority: SpendingAuthority, facts: PurchaseFacts) => Promise<void>,
): Promise<Record<string, unknown>> {
  const store = new PurchaseAuthorityStore(context.store.db);
  const authority = await store.get(authorityId);
  if (!authority || authority.job_id !== context.job.id || authority.state !== 'live')
    return { status: 'withdrawn', reason: 'authority_unavailable', repeat_safe: false };
  const page = await context.page();
  return withBrowserJobNavigation(context, page, async () => {
    await context.assertActive();
    const read = await readMerchantPurchase(page);
    if (read.status !== 'ready') {
      await store.db.run('DELETE FROM gws_ea_browser_pending_commits WHERE authority_id = ?', authority.id);
      return {
        status: read.status === 'unsupported_merchant' ? 'unsupported_merchant' : read.status,
        repeat_safe: read.status === 'checkout_lapsed',
      };
    }
    let marked = false;
    let watchRefusal: import('./watches.js').WatchPurchaseRefusal | undefined;
    try {
      const approved = JSON.parse(authority.facts_json) as PurchaseFacts;
      const bounds = JSON.parse(authority.bounds_json) as PurchaseBounds;
      const change = materialPurchaseChange(approved, read.facts, bounds);
      if (authority.kind === 'watch' && (change || authority.expires_at <= new Date().toISOString()))
        return { status: 'outside_bounds', watchId: authority.watch_id, repeat_safe: false };
      if (change || authority.expires_at <= new Date().toISOString())
        return requestPurchaseCard(context, read.facts, bounds, change ?? 'The previous approval expired.');
      // Re-read once more inside the classifier's authority callback, immediately before its only native press.
      const arrived = read.signature.waitForResult(page, Math.min(10_000, context.remaining())).catch(() => undefined);
      await activateControl(
        page,
        read.element,
        async () => {
          await read.element.click({ timeout: Math.min(10_000, context.remaining()) });
          await arrived;
        },
        {
          async commitStarted() {
            await context.assertActive();
            const latest = await readMerchantPurchase(page, read.element);
            if (latest.status !== 'ready')
              throw new PurchaseAuthorityError('changed', 'The checkout is no longer readable.');
            let commitClaim = claim;
            if (authority.kind === 'watch') {
              const { prepareWatchCommit } = await import('./watches.js');
              const checked = await prepareWatchCommit(context, authority, latest.facts);
              if (typeof checked !== 'function') {
                watchRefusal = checked;
                throw new PurchaseAuthorityError('changed', checked.status);
              }
              commitClaim = checked;
            }
            await context.assertActive();
            const immediate = await readMerchantPurchase(page, read.element);
            if (immediate.status !== 'ready') throw new PurchaseAuthorityError('changed');
            await store.begin(context, authority.id, immediate.facts, commitClaim);
            marked = true;
          },
        },
      );
      const placed = await verifyPlaced(page, authority, store);
      const outcome = placed ?? {
        status: 'outcome_unknown',
        attempt_id: authority.attempt_id,
        purchase_blocked: true,
        repeat_safe: false,
      };
      await store.conclude(authority.id, outcome, Boolean(placed));
      await notifyPurchaseOutcome(authority.id, store);
      await context.wakeWaiters(
        await new SiteLeaseStore(context.store.db).release(context.job.id, read.facts.site),
        `purchase-${authority.id}`,
      );
      const currentJob = await context.store.getJob(context.job.id);
      if (currentJob?.cancelled) await context.runtime.closeJob(context.job.id);
      return outcome;
    } catch (error) {
      if (marked) {
        const outcome = {
          status: 'outcome_unknown',
          attempt_id: authority.attempt_id,
          purchase_blocked: true,
          repeat_safe: false,
        };
        await store.conclude(authority.id, outcome, false);
        await notifyPurchaseOutcome(authority.id, store);
        await context.wakeWaiters(
          await new SiteLeaseStore(context.store.db).release(context.job.id, read.facts.site),
          `purchase-${authority.id}`,
        );
        if ((await context.store.getJob(context.job.id))?.cancelled) await context.runtime.closeJob(context.job.id);
        return outcome;
      }
      if (error instanceof PurchaseAuthorityError) {
        if (authority.kind === 'watch' && watchRefusal) return { ...watchRefusal, repeat_safe: false };
        if (authority.kind === 'watch')
          return {
            status: error.reason === 'purchase_blocked' ? 'site_purchase_blocked' : 'outside_bounds',
            reason: error.message,
            watchId: authority.watch_id,
            repeat_safe: false,
          };
        if (error.reason === 'changed' || error.reason === 'expired')
          return requestPurchaseCard(
            context,
            read.facts,
            JSON.parse(authority.bounds_json) as PurchaseBounds,
            error.message,
          );
        return {
          status: error.reason === 'purchase_blocked' ? 'site_purchase_blocked' : 'withdrawn',
          reason: error.reason,
          repeat_safe: false,
        };
      }
      throw error;
    } finally {
      await read.element.dispose();
    }
  });
}

export async function executeBrowserPurchase(
  context: BrowserExecutionContext,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const page = await context.page();
  try {
    return await withBrowserJobNavigation(context, page, async () => {
      const refs = await pinBrowserRefs(page, [
        readBrowserRef(payload.target, 'target needs a current ref and generation.'),
      ]);
      try {
        if (payload.operation === 'reconcile')
          return reconcilePurchaseAttempt(
            String(payload.attempt_id),
            page,
            new PurchaseAuthorityStore(context.store.db),
          );
        const ref = refs.values().next().value as { element: ElementHandle } | undefined;
        const read = await readMerchantPurchase(page, ref?.element);
        if (read.status !== 'ready')
          return { status: read.status === 'checkout_lapsed' ? 'not_a_purchase' : read.status, repeat_safe: true };
        const store = new PurchaseAuthorityStore(context.store.db);
        const { prepareWatchPurchase } = await import('./watches.js');
        const watch = await prepareWatchPurchase(context, read.facts);
        if (watch)
          return watch.status === 'ready'
            ? executeAuthorizedPurchase(context, watch.authorityId)
            : { ...watch, repeat_safe: false };
        const live = await store.liveForJob(context.job.id);
        if (live) return executeAuthorizedPurchase(context, live.id);
        const child = await deriveReservationGuaranteeAuthority(
          context.job.id,
          context.request.id,
          read.facts,
          boundsOf(payload),
          store,
        );
        if (child) return executeAuthorizedPurchase(context, child.id);
        return requestPurchaseCard(context, read.facts, boundsOf(payload));
      } finally {
        await disposeBrowserRefs(refs);
      }
    });
  } catch (error) {
    if (error instanceof BrowserSiteBusyError)
      return { status: 'site_purchase_blocked', reason: 'site_busy', repeat_safe: true };
    throw error;
  }
}

registerBrowserQueuedAction('purchase', { validate: validatePurchaseRequest, execute: executeBrowserPurchase });
registerBrowserQueuedAction('browser_purchase_commit', {
  validate(content) {
    if (typeof content.authority_id !== 'string') throw invalidArgs('authority_id required');
    return { authority_id: content.authority_id };
  },
  execute: (context, payload) => executeAuthorizedPurchase(context, String(payload.authority_id)),
});
export function registerBrowserPurchaseDelivery(queue: () => BrowserQueue): void {
  getPurchaseQueue = queue;
  registerBrowserActionDelivery('purchase', queue);
}
async function enqueuePurchaseCommit(queue: BrowserQueue, id: string): Promise<void> {
  const pending = await queue.store.db.get<{ generation: number; queued_request_id: string | null }>(
    'SELECT generation,queued_request_id FROM gws_ea_browser_pending_commits WHERE authority_id = ?',
    id,
  );
  const authority = await new PurchaseAuthorityStore(queue.store.db).get(id);
  if (!pending || !authority || authority.state !== 'live') return;
  if (pending.queued_request_id) return;
  const requestId = stableId('purchase-commit', `${id}:${pending.generation}`);
  await queue.enqueueInternal(authority.job_id, 'browser_purchase_commit', { authority_id: id }, requestId);
  await queue.store.db.run(
    'UPDATE gws_ea_browser_pending_commits SET queued_request_id = ? WHERE authority_id = ? AND generation = ?',
    requestId,
    id,
    pending.generation,
  );
}
/** Must run before generic queue.start() interrupts the old request rows. */
export async function recoverBrowserPurchases(queue: BrowserQueue): Promise<void> {
  commitsReady = false;
  if (!(await queue.store.db.hasTable('gws_ea_browser_authorities'))) return;
  const store = new PurchaseAuthorityStore(queue.store.db);
  for (const authority of await store.db.all<SpendingAuthority>(
    "SELECT * FROM gws_ea_browser_authorities WHERE state = 'committing'",
  )) {
    await store.conclude(
      authority.id,
      { status: 'outcome_unknown', attempt_id: authority.attempt_id, purchase_blocked: true, repeat_safe: false },
      false,
    );
  }
  for (const attempt of await store.db.all<{ site: string }>(
    'SELECT DISTINCT site FROM gws_ea_browser_purchase_attempts WHERE resolution IS NULL',
  ))
    await store.db.run(
      'INSERT INTO gws_ea_browser_purchase_blocks(site,created_at) VALUES(?,?) ON CONFLICT(site) DO NOTHING',
      attempt.site,
      new Date().toISOString(),
    );
  // Only a current card/live authority keeps its cart. Unknown attempts are protected by site blocks instead.
  for (const lease of await store.db.all<{ site: string; job_id: string }>(
    "SELECT site,job_id FROM gws_ea_browser_site_leases WHERE state = 'purchase'",
  )) {
    const at = new Date().toISOString();
    const cards = await store.db.all<PurchaseCard>(
      "SELECT * FROM gws_ea_browser_purchase_cards WHERE job_id = ? AND status = 'open' AND expires_at > ?",
      lease.job_id,
      at,
    );
    const authorities = await store.db.all<SpendingAuthority>(
      "SELECT * FROM gws_ea_browser_authorities WHERE job_id = ? AND state = 'live' AND expires_at > ?",
      lease.job_id,
      at,
    );
    const held = [...cards, ...authorities].some(
      (row) => (JSON.parse(row.facts_json) as PurchaseFacts).site === lease.site,
    );
    if (!held)
      await queue.wakeWaiters(
        await queue.leases.release(lease.job_id, lease.site),
        `purchase-recovery-${lease.job_id}-${lease.site}`,
      );
  }
  // Old accepted requests will be answered interrupted. Recovery always creates a fresh request id afterward.
  await store.db.run('UPDATE gws_ea_browser_pending_commits SET generation = generation + 1,queued_request_id = NULL');
  for (const authority of await store.db.all<SpendingAuthority>(
    'SELECT * FROM gws_ea_browser_authorities WHERE outcome_json IS NOT NULL AND notified_at IS NULL',
  ))
    await notifyPurchaseOutcome(authority.id, store);
}
/** Call only after queue.start(): early approval replay persisted durable work without starting it. */
export async function resumeBrowserPurchaseCommits(queue: BrowserQueue): Promise<void> {
  commitsReady = true;
  if (!getPurchaseQueue) getPurchaseQueue = () => queue;
  for (const row of await queue.store.db.all<{ authority_id: string }>(
    'SELECT authority_id FROM gws_ea_browser_pending_commits',
  ))
    await enqueuePurchaseCommit(queue, row.authority_id);
}

/** The host sweep calls this with its running queue; only DB work runs under each transaction. */
export async function sweepBrowserPurchaseState(queue: BrowserQueue): Promise<void> {
  if (!(await queue.store.db.hasTable('gws_ea_browser_authorities'))) return;
  const store = new PurchaseAuthorityStore(queue.store.db);
  const at = new Date().toISOString();
  for (const authority of await store.db.all<SpendingAuthority>(
    "SELECT * FROM gws_ea_browser_authorities WHERE state = 'live' AND expires_at <= ?",
    at,
  )) {
    const changed = await store.db.transaction(async () => {
      const revoked = await store.db.run(
        "UPDATE gws_ea_browser_authorities SET state = 'revoked',outcome_json = ?,notified_at = NULL WHERE id = ? AND state = 'live' AND expires_at <= ?",
        JSON.stringify({ status: 'expired', repeat_safe: false }),
        authority.id,
        at,
      );
      if (!revoked.changes) return false;
      await store.db.run('DELETE FROM gws_ea_browser_pending_commits WHERE authority_id = ?', authority.id);
      if (authority.card_id)
        await store.db.run(
          "UPDATE gws_ea_browser_purchase_cards SET status = 'expired' WHERE id = ? AND status = 'approved'",
          authority.card_id,
        );
      return true;
    });
    if (changed) {
      await notifyPurchaseOutcome(authority.id, store);
      const facts = JSON.parse(authority.facts_json) as PurchaseFacts;
      await queue.wakeWaiters(await queue.leases.release(authority.job_id, facts.site), `expiry-${authority.id}`);
    }
  }
  for (const authority of await store.db.all<SpendingAuthority>(
    'SELECT * FROM gws_ea_browser_authorities WHERE outcome_json IS NOT NULL AND notified_at IS NULL',
  ))
    await notifyPurchaseOutcome(authority.id, store);
}
/** Queue interruption calls this before publishing an uncertain marked request's answer. */
export async function recordUnknownBrowserPurchaseRequest(requestId: string): Promise<void> {
  if (!(await getDb().hasTable('gws_ea_browser_authorities'))) return;
  const store = new PurchaseAuthorityStore();
  for (const authority of await store.db.all<SpendingAuthority>(
    "SELECT * FROM gws_ea_browser_authorities WHERE commit_request_id = ? AND state = 'committing'",
    requestId,
  )) {
    await store.conclude(
      authority.id,
      { status: 'outcome_unknown', attempt_id: authority.attempt_id, purchase_blocked: true, repeat_safe: false },
      false,
    );
    await notifyPurchaseOutcome(authority.id, store);
  }
}
