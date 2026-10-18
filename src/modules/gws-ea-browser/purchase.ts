import { createHash } from 'node:crypto';
import type { ElementHandle, Page } from 'playwright-core';
import { forbidden, invalidArgs } from '../../cli/delivery-action.js';
import { getDb } from '../../db/connection.js';
import { isUniqueViolation } from '../../db/errors.js';
import type { DbDriver } from '../../db/driver.js';
import { getPendingApproval, getSession } from '../../db/sessions.js';
import { DENY, HOLD, defineGuardedAction, guard } from '../../guard/index.js';
import { isRecord } from '../../gws-ea/validation.js';
import type { ResponseFrame } from '../../cli/frame.js';
import { requestWake } from '../../request-wake.js';
import { registerApprovalHandler, requestApproval } from '../approvals/index.js';
import { registerApprovalResolvedHandler } from '../approvals/primitive.js';
import { isVerifiedPrincipalUser, principalApproverUserId } from '../gws-ea-profile/db.js';
import {
  PurchaseAuthorityError,
  PurchaseAuthorityStore,
  notifyPurchaseOutcome,
  notifyPurchaseWaiters,
  type SpendingAuthority,
} from './authority.js';
import {
  detachPurchaseCards,
  ERRAND_ORIGIN_LINE,
  finishPurchaseCardWithdrawals,
  notifyPurchaseCard,
  renderPurchaseCard,
  type PurchaseCard,
} from './cards.js';
import { cancelBrowserJobInTransaction, finishBrowserJobCancellation } from './cancel.js';
import { checkoutPicture } from './checkout-picture.js';
import {
  activateControl,
  BrowserActivationError,
  BrowserSiteBusyError,
  classifyActivation,
  framesUnreadyStop,
  withBrowserJobNavigation,
} from './commit-classifier.js';
import { ControlFactsUnavailableError, readCheckoutRegion } from './control-facts.js';
import { readConfirmation, readPageLines, showsCharge } from './confirmation.js';
import { recordConsentGrant, runConsentPass, type ConsentAgreement } from './consent.js';
import { SiteLeaseStore } from './leases.js';
import { BrowserStore, markBrowserRequestCommitStarted, type BrowserRequest } from './db.js';
import {
  isFreeReservation,
  materialPurchaseChange,
  type FreeCommitFacts,
  type PurchaseBounds,
  type PurchaseFacts,
} from './fingerprint.js';
import {
  confirmsOnSite,
  freeCommitBooks,
  genericCheckoutSignature,
  offersPayment,
  pressRefusal,
} from './generic-signature.js';
import { stopForUnapprovedCommit, type UnapprovedCommit } from './incidents.js';
import { readIsoTime, zonedInstant } from './iso-time.js';
import type { MerchantCheckoutRead, MerchantPurchaseEvidence, MerchantSignature } from './merchant-contract.js';
import {
  merchantSignatureFor,
  readMerchantPurchase,
  readMerchantPurchaseEvidence,
  type MerchantPurchaseRead,
} from './merchant-signatures.js';
import { disposeBrowserRefs, pinBrowserRefs, readBrowserRef } from './observe.js';
import { readBrowserPolicy } from './policy.js';
import { writeBrowserNotice } from './notices.js';
import { notifyPendingUnconfirmed } from './purchase-outcome.js';
import {
  BrowserQueue,
  registerBrowserActionDelivery,
  registerBrowserQueuedAction,
  type BrowserExecutionContext,
} from './queue.js';
import { evidenceMatchesAttempt, reconcilePurchaseAttempt } from './reconciliation.js';
import { deriveReservationGuaranteeAuthority } from './reservation-guarantee.js';
import { principalClock } from './watch-policy.js';
import { assistantWebAddress } from './web-address.js';

export const PURCHASE_APPROVAL = 'browser_purchase';
export const PURCHASE_CARD_LIFE_MS = 24 * 60 * 60 * 1000;
/** How many presses one approval covers on a checkout whose steps each ask to commit (KTD3). */
const MAX_APPROVED_PRESSES = 3;
/** How many changed cards one checkout gets before its job stops (R9). */
const MAX_CHANGED_CARDS = 3;
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

/** What the consent engine leaves a checkout's press carrying: its agreements and the extras the site keeps. */
interface CheckoutConsent {
  readonly agreements: readonly ConsentAgreement[];
  readonly addOns: readonly string[];
}

/**
 * The consent engine's pass on the checkout's form (KTD11): every choice the engine owns made, the agreements
 * the principal approved ticked, and what only the card can approve read for it. Inside a purchase the engine
 * never stops: its exceptions are the card's.
 */
async function checkoutConsent(
  context: BrowserExecutionContext,
  page: Page,
  element: ElementHandle,
): Promise<CheckoutConsent> {
  const consent = await runConsentPass(page, element, {
    purchase: true,
    scope: { jobId: context.job.id, db: context.store.db },
    assertActive: context.assertActive,
  });
  if (consent.status !== 'ready') throw new Error('A purchase consent pass answers only with its facts');
  return consent;
}

/** The merchant's facts with the checkout's consent facts, which the card shows and the commit compares. */
function withConsent(facts: PurchaseFacts, consent: CheckoutConsent): PurchaseFacts {
  return {
    ...facts,
    ...(consent.agreements.length ? { agreements: [...consent.agreements] } : {}),
    ...(consent.addOns.length ? { addOns: [...consent.addOns] } : {}),
  };
}

/** A real calendar date, or a date and time with an explicit UTC offset normalized to UTC. */
function iso(value: unknown): string {
  const parsed = readIsoTime(value, 'optional');
  if (!parsed) throw invalidArgs('Use a real ISO date, or a date and time with a UTC offset.');
  return parsed;
}
/** Merchants quote delivery as calendar dates, so a window bound is the date it names in its own offset. */
function calendarDate(value: unknown): string {
  iso(value);
  return (value as string).slice(0, 10);
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
    deliveryWindow = {
      start: calendarDate(content.delivery_window.start),
      end: calendarDate(content.delivery_window.end),
    };
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
/** A date-only needed-by is the end of that day on the principal's clock. */
export function purchaseBounds(payload: Record<string, unknown>, principalTimeZone: string): PurchaseBounds {
  return {
    ...(isRecord(payload.delivery_window)
      ? { deliveryWindow: payload.delivery_window as { start: string; end: string } }
      : {}),
    ...(typeof payload.needed_by === 'string'
      ? {
          neededBy: new Date(
            payload.needed_by.length === 10
              ? zonedInstant(`${payload.needed_by}T23:59:59.999`, principalTimeZone)
              : Date.parse(payload.needed_by),
          ).toISOString(),
          principalTimeZone,
        }
      : {}),
  };
}

/** The cards a job's checkout on `site` was sent again for, each naming what changed (R9). */
async function changedCards(db: DbDriver, jobId: string, site: string): Promise<number> {
  const cards = await db.all<{ facts_json: string }>(
    'SELECT facts_json FROM gws_ea_browser_purchase_cards WHERE job_id = ? AND change_text IS NOT NULL',
    jobId,
  );
  return cards.filter((card) => (JSON.parse(card.facts_json) as PurchaseFacts).site === site).length;
}

/** The answer of a checkout that changed after its third changed card: no fourth card; its job stops (R9). */
function checkoutChanging(change: string): Record<string, unknown> {
  return {
    status: 'checkout_changing',
    reason: change,
    message:
      'The checkout changed again after three changed cards, so the host stopped this errand. Report what changed; nothing more was sent for approval.',
    repeat_safe: false,
  };
}

/**
 * A purchase that waits on an earlier one on its merchant (KTD9, AE4): browsing the site goes on, and the host
 * wakes the job once main records the earlier one's outcome. An earlier one settled between the refusal and this
 * wait leaves the checkout to be read afresh.
 */
async function waitOnEarlierPurchase(
  context: BrowserExecutionContext,
  site: string,
  exceptions: readonly string[] = [],
): Promise<Record<string, unknown>> {
  return (await new PurchaseAuthorityStore(context.store.db).waitOnEarlier(context.job.id, site, exceptions))
    ? { status: 'waiting_on_earlier', site, repeat_safe: true }
    : { status: 'checkout_lapsed', repeat_safe: true };
}

/** Stops a job whose checkout kept changing (R9): its cards are withdrawn and its page closed. The agent reports. */
async function stopChangingCheckout(context: BrowserExecutionContext): Promise<void> {
  const stop = await context.store.db.transaction(() =>
    cancelBrowserJobInTransaction(context.job.thread_id, context.store),
  );
  await finishBrowserJobCancellation(stop, undefined, context.request.id);
}

/**
 * Sends the principal a card for `facts`. `change` is the line it opens with; a material change counts toward
 * the checkout's cap, while an expired approval's fresh card does not.
 */
async function requestPurchaseCard(
  context: BrowserExecutionContext,
  facts: PurchaseFacts,
  bounds: PurchaseBounds,
  change?: string,
  material = change !== undefined,
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
  if (change && material && (await changedCards(db, context.job.id, facts.site)) >= MAX_CHANGED_CARDS)
    return checkoutChanging(change);
  const payload = { cardId: id, jobId: context.job.id };
  const decision = await guard(browserPurchaseGuard, {
    actor: { kind: 'agent', agentGroupId: context.session.agent_group_id, sessionId: context.session.id },
    payload,
  });
  if (decision.effect === 'deny') throw forbidden(decision.reason);
  if (decision.effect !== 'hold') throw forbidden('Purchase confirmation was not held for the principal.');
  // The card's picture (KTD6), taken before anything durable changes; null leaves the card saying it is unavailable.
  const picture = await checkoutPicture(context, facts);
  const expires = new Date(Date.now() + PURCHASE_CARD_LIFE_MS).toISOString();
  const detached = await db.transaction(async () => {
    const job = await db.get<{ cancelled: number; cancel_requested: number }>(
      'SELECT cancelled,cancel_requested FROM gws_ea_browser_jobs WHERE id = ?',
      context.job.id,
    );
    if (!job || job.cancelled || job.cancel_requested) throw forbidden('The browser job was cancelled.');
    const old = await detachPurchaseCards(context.job.id, 'superseded');
    const recorded = await authorities.recordedNotPlaced(facts.site);
    await db.run(
      `INSERT INTO gws_ea_browser_purchase_cards(id,job_id,request_id,status,facts_json,bounds_json,exception_ids_json,expires_at,created_at,change_text)
      VALUES(?,?,?,'open',?,?,?,?,?,?)`,
      id,
      context.job.id,
      context.request.id,
      JSON.stringify(facts),
      JSON.stringify(bounds),
      JSON.stringify(exceptions),
      expires,
      new Date().toISOString(),
      material ? (change ?? null) : null,
    );
    await db.run(
      "UPDATE gws_ea_browser_site_leases SET state = 'purchase',updated_at = ? WHERE site = ? AND job_id = ?",
      new Date().toISOString(),
      facts.site,
      context.job.id,
    );
    return {
      cards: old,
      recorded,
      waitingJobs: await new SiteLeaseStore(db).releaseUnheldPurchases(context.job.id),
    };
  });
  await context.wakeWaiters(detached.waitingJobs, `superseded-${id}`);
  await finishPurchaseCardWithdrawals(
    detached.cards,
    'Withdrawn: the checkout changed. A fresh card contains the current facts.',
  );
  const earlier = { unresolved: exceptions.length, recordedNotPlaced: detached.recorded };
  const question = renderPurchaseCard(facts, bounds, earlier, await principalClock(), change, {
    alias: await assistantWebAddress(),
  });
  const approvalId = await requestApproval({
    session: context.session,
    agentName: 'browser',
    action: PURCHASE_APPROVAL,
    payload,
    title: 'Approve this purchase?',
    question,
    approverUserId: decision.approverUserId,
    expiresAt: expires,
    originLine: ERRAND_ORIGIN_LINE,
    details: { facts: { site: facts.site, total_minor: String(facts.totalMinor), currency: facts.currency } },
    pictures: [picture],
  });
  // A synchronous card click may already have created the authority; never reopen its logical card.
  if (approvalId) {
    // The principal has now seen main's recorded answers on this site: no later card repeats them.
    await authorities.markRecordedShown(detached.recorded, id);
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
      const facts = JSON.parse(card.facts_json) as PurchaseFacts;
      const durableAuthority = await authority.create({
        id,
        jobId: card.job_id,
        approvalId: approval.approval_id,
        cardId: card.id,
        kind: 'checkout',
        facts,
        bounds: JSON.parse(card.bounds_json) as PurchaseBounds,
        exceptionIds: JSON.parse(card.exception_ids_json) as string[],
        attemptId: stableId('attempt', card.id),
        expiresAt: card.expires_at,
      });
      // The card's agreements stand approved on the site, as a consent card's would: no second card asks again.
      for (const agreement of facts.agreements ?? [])
        await recordConsentGrant(getDb(), {
          site: facts.site,
          origin: agreement.origin,
          wording: agreement.wording,
          approvalId: approval.approval_id,
          principalUserId: userId,
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
    const queue = getPurchaseQueue();
    await queue.wakeWaiters(await queue.leases.releaseUnheldPurchases(card.job_id), `card-${card.id}-${status}`);
  }
});

/**
 * What proves a press placed its purchase, and the merchant's record of it: a reviewed signature's record, or a
 * generic checkout's confirmation page (KTD4, KTD8), whose contact email keys the order number.
 */
async function verifyPlaced(
  page: Page,
  authority: SpendingAuthority,
  store: PurchaseAuthorityStore,
  facts: PurchaseFacts,
): Promise<{ outcome: Record<string, unknown>; evidence: MerchantPurchaseEvidence } | undefined> {
  const evidence = await readMerchantPurchaseEvidence(page, facts);
  const attempt = await store.attempt(authority.attempt_id);
  if (evidence?.resolution !== 'committed' || !attempt || !evidenceMatchesAttempt(evidence, attempt)) return undefined;
  return {
    evidence,
    outcome: {
      status: evidence.reservation || facts.generic?.booking ? 'booked' : 'placed',
      order_number: evidence.recordId,
      evidence,
      repeat_safe: false,
    },
  };
}

/** A checkout's next step after an approved press that placed nothing (KTD3). */
type CheckoutStep =
  /** Another step to press under the same approval. */
  | { kind: 'next'; element: ElementHandle; facts: PurchaseFacts }
  /** Another step whose facts changed: a new card. */
  | { kind: 'changed'; facts: PurchaseFacts; change: string }
  /** The same step came back with a decline: not placed. */
  | { kind: 'declined'; wording: string }
  /** The same step came back, or anything else: no page proof either way. */
  | { kind: 'unconfirmed' };

/**
 * Reads a generic checkout after an approved press that placed nothing (KTD3). It presses on only when the page
 * moved to a different step (the pressed control gone, or the commit label changed), shows no error or decline
 * wording, and nothing material changed.
 */
async function nextCheckoutStep(
  context: BrowserExecutionContext,
  page: Page,
  pressed: string,
  approved: PurchaseFacts,
  bounds: PurchaseBounds,
): Promise<CheckoutStep> {
  const lines = await readPageLines(page);
  const refusal = pressRefusal(lines);
  const next = await readMerchantPurchase(page);
  if (next.status === 'free') await next.element.dispose();
  const same = next.status !== 'ready' || next.facts.control.label === pressed;
  if (next.status !== 'ready' || same || refusal) {
    if (next.status === 'ready') await next.element.dispose();
    const decline = same && refusal === 'declined' ? pressRefusalWording(lines) : undefined;
    return decline ? { kind: 'declined', wording: decline } : { kind: 'unconfirmed' };
  }
  const facts = withConsent(next.facts, await checkoutConsent(context, page, next.element));
  const change = materialPurchaseChange(approved, facts, bounds);
  if (change) {
    await next.element.dispose();
    return { kind: 'changed', facts, change };
  }
  return { kind: 'next', element: next.element, facts };
}

/** The decline the page shows, bounded, for the attempt's evidence. */
function pressRefusalWording(lines: readonly string[]): string | undefined {
  const line = lines.find((candidate) => pressRefusal([candidate]) === 'declined');
  return line?.slice(0, 300);
}

/** What a commit's non-ready read answers: the checkout to rebuild, or what keeps it from a card. */
function unreadyCommit(read: Exclude<MerchantCheckoutRead, { status: 'ready' }>): Record<string, unknown> {
  switch (read.status) {
    case 'free':
    case 'checkout_lapsed':
      return { status: 'checkout_lapsed', repeat_safe: true };
    case 'facts_incomplete':
      return { status: read.status, missing: [...read.missing], repeat_safe: false };
    case 'card_needed':
    case 'terms_unavailable':
      return { status: read.status, repeat_safe: false };
    default: {
      const unknown: never = read;
      throw new Error(`Unknown checkout read ${JSON.stringify(unknown)}`);
    }
  }
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
  const approved = JSON.parse(authority.facts_json) as PurchaseFacts;
  const bounds = JSON.parse(authority.bounds_json) as PurchaseBounds;
  const answer = await withBrowserJobNavigation(context, page, async () => {
    await context.assertActive();
    const read = await readMerchantPurchase(page, undefined, approved);
    if (read.status !== 'ready') {
      await store.db.run('DELETE FROM gws_ea_browser_pending_commits WHERE authority_id = ?', authority.id);
      return unreadyCommit(read);
    }
    let marked = false;
    let watchRefusal: import('./watches.js').WatchPurchaseRefusal | undefined;
    let facts = read.facts;
    let element = read.element;
    /** The approved press, re-checked by `commitStarted` immediately before it. */
    const press = async (
      signature: MerchantSignature,
      target: ElementHandle,
      commitStarted: () => Promise<void>,
    ): Promise<void> => {
      await activateControl(
        page,
        target,
        async () => {
          // Listening starts before the sole authorized press.
          const arrived = signature.waitForResult(page, Math.min(10_000, context.remaining())).catch(() => undefined);
          await target.click({ timeout: Math.min(10_000, context.remaining()) });
          await arrived;
        },
        { commitStarted, ...(facts.generic ? { checkout: { origin: facts.origin } } : {}) },
      );
    };
    /** The outcome is told to the job, and the merchant's site goes to its waiters. */
    const settle = async (outcome: Record<string, unknown>): Promise<Record<string, unknown>> => {
      await notifyPurchaseOutcome(authority.id, store);
      await context.wakeWaiters(
        await new SiteLeaseStore(context.store.db).release(context.job.id, read.facts.site),
        `purchase-${authority.id}`,
      );
      if ((await context.store.getJob(context.job.id))?.cancelled) await context.runtime.closeJob(context.job.id);
      return outcome;
    };
    try {
      facts = withConsent(read.facts, await checkoutConsent(context, page, read.element));
      const change = materialPurchaseChange(approved, facts, bounds);
      const expired = authority.expires_at <= new Date().toISOString();
      if (authority.kind === 'watch' && (change || expired))
        return { status: 'outside_bounds', watchId: authority.watch_id, repeat_safe: false };
      if (change) return requestPurchaseCard(context, facts, bounds, change);
      if (expired) return requestPurchaseCard(context, facts, bounds, 'The previous approval expired.', false);
      // Re-read once more inside the classifier's authority callback, immediately before its only native press.
      await press(read.signature, element, async () => {
        await context.assertActive();
        const latest = await readMerchantPurchase(page, element);
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
        // The consent check immediately before the press, inside the facts `begin()` checks.
        const consent = await checkoutConsent(context, page, element);
        const immediate = await readMerchantPurchase(page, element);
        if (immediate.status !== 'ready') throw new PurchaseAuthorityError('changed');
        await store.begin(context, authority.id, withConsent(immediate.facts, consent), commitClaim);
        marked = true;
      });
      // An approval covers the checkout, not one control (KTD3): a middle step is pressed on, up to three presses.
      for (let presses = 1; ; presses++) {
        const placed = await verifyPlaced(page, authority, store, facts);
        if (placed) {
          const resolved = await store.resolve(authority.attempt_id, {
            placed: true,
            source: 'page',
            evidence: { ...placed.evidence },
            record: { id: placed.evidence.recordId, account: placed.evidence.account },
            outcome: placed.outcome,
          });
          if (resolved.status === 'resolved') return settle(placed.outcome);
          // An order number that already proves another attempt proves nothing of this one.
          break;
        }
        if (!facts.generic || presses >= MAX_APPROVED_PRESSES) break;
        const step = await nextCheckoutStep(context, page, facts.control.label, approved, bounds);
        if (step.kind === 'unconfirmed') break;
        if (step.kind === 'declined') {
          const outcome = {
            status: 'not_placed',
            reason: 'declined',
            attempt_id: authority.attempt_id,
            repeat_safe: false,
          };
          await store.resolve(authority.attempt_id, {
            placed: false,
            source: 'step',
            evidence: { source: page.url(), declined: step.wording },
            outcome,
          });
          return settle(outcome);
        }
        if (step.kind === 'changed') {
          // The press moved the checkout on to a step asking again with changed facts: nothing was placed.
          const stop = (await changedCards(context.store.db, context.job.id, step.facts.site)) >= MAX_CHANGED_CARDS;
          await store.resolve(authority.attempt_id, {
            placed: false,
            source: 'step',
            evidence: { source: page.url(), step: step.facts.control.label },
            outcome: {
              status: stop ? 'checkout_changing' : 'changed',
              reason: step.change,
              attempt_id: authority.attempt_id,
              repeat_safe: false,
            },
          });
          return stop ? checkoutChanging(step.change) : requestPurchaseCard(context, step.facts, bounds, step.change);
        }
        await element.dispose();
        element = step.element;
        facts = step.facts;
        const next = step.element;
        await press(genericCheckoutSignature, next, async () => {
          await context.assertActive();
          // The same checks as the first press: consent, then the facts the press carries, under the same approval.
          const consent = await checkoutConsent(context, page, next);
          const immediate = await readMerchantPurchase(page, next);
          if (immediate.status !== 'ready') throw new PurchaseAuthorityError('changed');
          await store.continueCommit(context, authority.id, withConsent(immediate.facts, consent));
        });
      }
      // No page proof either way: main settles it from the merchant's email or the principal (KTD8).
      return settle(await store.unconfirm(authority.attempt_id));
    } catch (error) {
      if (marked) return settle(await store.unconfirm(authority.attempt_id));
      // The approved control no longer reads as the commit it was: the checkout is rebuilt from a fresh read.
      if (error instanceof BrowserActivationError) return { status: 'checkout_lapsed', repeat_safe: true };
      if (error instanceof PurchaseAuthorityError) {
        if (authority.kind === 'watch' && watchRefusal) return { ...watchRefusal, repeat_safe: false };
        if (error.reason === 'purchase_blocked') {
          const waiting = await waitOnEarlierPurchase(
            context,
            approved.site,
            JSON.parse(authority.exception_ids_json) as string[],
          );
          return authority.kind === 'watch' ? { ...waiting, watchId: authority.watch_id, repeat_safe: false } : waiting;
        }
        if (authority.kind === 'watch')
          return { status: 'outside_bounds', reason: error.message, watchId: authority.watch_id, repeat_safe: false };
        if (error.reason === 'changed') return requestPurchaseCard(context, facts, bounds, error.message);
        if (error.reason === 'expired') return requestPurchaseCard(context, facts, bounds, error.message, false);
        return { status: 'withdrawn', reason: error.reason, repeat_safe: false };
      }
      throw error;
    } finally {
      await element.dispose();
    }
  });
  if (answer.status === 'checkout_changing') await stopChangingCheckout(context);
  return answer;
}

/**
 * A commit the host presses itself (KTD3, R3): an unreviewed checkout read as free, or a reviewed reservation
 * free by the same test, with the reviewed signature that reads it and proves its outcome.
 */
type FreeCommit =
  | { readonly kind: 'generic'; readonly facts: FreeCommitFacts; readonly element: ElementHandle }
  | {
      readonly kind: 'reviewed';
      readonly facts: PurchaseFacts;
      readonly element: ElementHandle;
      readonly signature: MerchantSignature;
    };

/**
 * Whether a reviewed reservation is free by the test any site's booking takes (KTD3, R3): its reviewed facts
 * state no money and no terms, and nothing on the page offers or holds a way to pay. An unreadable page is not.
 */
async function freeReservation(page: Page, facts: PurchaseFacts, element: ElementHandle): Promise<boolean> {
  if (!isFreeReservation(facts)) return false;
  try {
    return !offersPayment(await readCheckoutRegion(page, element));
  } catch (error) {
    if (error instanceof ControlFactsUnavailableError) return false;
    throw error;
  }
}

/** Whether a re-read shows the same free commit: still free, and nothing about it changed. */
async function stillFree(page: Page, free: FreeCommit, latest: MerchantPurchaseRead): Promise<boolean> {
  switch (free.kind) {
    case 'generic':
      return latest.status === 'free' && JSON.stringify(latest.facts) === JSON.stringify(free.facts);
    case 'reviewed':
      return (
        latest.status === 'ready' &&
        JSON.stringify(latest.facts) === JSON.stringify(free.facts) &&
        (await freeReservation(page, latest.facts, free.element))
      );
    default: {
      const unknown: never = free;
      throw new Error(`Unknown free commit ${JSON.stringify(unknown)}`);
    }
  }
}

/**
 * A free commit (KTD3): the host presses it itself, with no card. Like any purchase it waits on an earlier one
 * on its merchant (KTD9). It runs the consent check, writes a money-less attempt, presses, and reads the
 * booking's outcome: a reviewed signature's merchant record, or the page's confirmation, where one that shows a
 * charge after it is spending nobody approved (KTD10). With no proof either way it is unconfirmed, for main to
 * settle (KTD8).
 */
async function commitFree(
  context: BrowserExecutionContext,
  page: Page,
  free: FreeCommit,
): Promise<{ answer: Record<string, unknown>; unapproved?: UnapprovedCommit }> {
  const db = context.store.db;
  const store = new PurchaseAuthorityStore(db);
  const attemptId = stableId('free-attempt', context.request.id);
  const scope = { jobId: context.job.id, db };
  if (await store.waitOnEarlier(context.job.id, free.facts.site))
    return { answer: { status: 'waiting_on_earlier', site: free.facts.site, repeat_safe: true } };
  // The consent engine's check, as before any submission (KTD11): every choice it owns made, or a stop.
  const consent = await runConsentPass(page, free.element, { scope, assertActive: context.assertActive });
  if (consent.status === 'consent_required')
    return { answer: { status: 'stopped', reason: 'consent_required', consent: consent.stops, repeat_safe: true } };
  if (consent.status === 'add_on')
    return {
      answer: {
        status: 'facts_incomplete',
        missing: consent.addOns.map((addOn) => `the charge for ${addOn}`),
        repeat_safe: true,
      },
    };
  let attempted = false;
  try {
    await activateControl(
      page,
      free.element,
      async () => {
        // Listening starts before the press.
        const arrived = (free.kind === 'reviewed' ? free.signature : genericCheckoutSignature)
          .waitForResult(page, Math.min(10_000, context.remaining()))
          .catch(() => undefined);
        await free.element.click({ timeout: Math.min(10_000, context.remaining()) });
        await arrived;
      },
      {
        // A reviewed flow admits its own exact control; a generic press its checkout origin (KTD4).
        ...(free.kind === 'generic' ? { checkout: { origin: free.facts.origin } } : {}),
        async commitStarted() {
          await context.assertActive();
          // The check immediately before the press: still free, still this booking, every choice still made.
          const again = await runConsentPass(page, free.element, { scope, assertActive: context.assertActive });
          const latest = await readMerchantPurchase(page, free.element);
          if (again.status !== 'ready' || !(await stillFree(page, free, latest)))
            throw new PurchaseAuthorityError('changed', 'The booking changed before the host pressed it.');
          await db.transaction(async () => {
            const job = await db.get<{ cancelled: number; cancel_requested: number }>(
              'SELECT cancelled,cancel_requested FROM gws_ea_browser_jobs WHERE id = ?',
              context.job.id,
            );
            if (!job || job.cancelled || job.cancel_requested) throw new PurchaseAuthorityError('cancelled');
            if (await store.waitsOnEarlier(free.facts.site)) throw new PurchaseAuthorityError('purchase_blocked');
            const at = new Date().toISOString();
            await markBrowserRequestCommitStarted(db, context.request.id, at);
            // Its account key: a generic checkout's contact email, or a reviewed merchant's account, as a paid
            // attempt's is, under which an order number proves one attempt only (KTD8).
            await db.run(
              `INSERT INTO gws_ea_browser_free_attempts(id,job_id,request_id,site,platform,account_key,facts_json,attempted_at)
              VALUES(?,?,?,?,?,?,?,?)`,
              attemptId,
              context.job.id,
              context.request.id,
              free.facts.site,
              free.kind === 'generic' ? (free.facts.platform ?? null) : null,
              free.kind === 'generic' ? (free.facts.contactEmail ?? null) : free.facts.account,
              JSON.stringify(free.facts),
              at,
            );
            // A free table on a region watch's site spends the one booking of a watch it is within (KTD20);
            // region watches live only on sites without a reviewed reader.
            if (free.kind === 'generic' && freeCommitBooks(free.facts)) {
              const { claimRegionWatchCommit } = await import('./watches.js');
              await claimRegionWatchCommit(db, {
                jobId: context.job.id,
                site: free.facts.site,
                attemptId,
                requestId: context.request.id,
                at,
                booking: free.facts.booking,
              });
            }
          });
          attempted = true;
        },
      },
    );
  } catch (error) {
    if (!attempted && error instanceof PurchaseAuthorityError)
      return {
        answer:
          error.reason === 'purchase_blocked'
            ? await waitOnEarlierPurchase(context, free.facts.site)
            : { status: error.reason === 'cancelled' ? 'withdrawn' : 'checkout_lapsed', repeat_safe: true },
      };
    if (!attempted && error instanceof BrowserActivationError)
      return { answer: { status: 'checkout_lapsed', repeat_safe: true } };
    if (!attempted) throw error;
    // The press may or may not have reached the site: no page proof either way.
    return { answer: await store.unconfirm(attemptId) };
  }
  if (free.kind === 'reviewed') {
    // The reviewed signature's merchant record, bound to the checkout it read just before the press, proves it.
    const record = page.isClosed() ? undefined : await free.signature.readEvidence(page, free.facts);
    const proved =
      record?.resolution === 'committed' &&
      (
        await store.resolve(attemptId, {
          placed: true,
          source: 'page',
          evidence: { ...record },
          record: { id: record.recordId, account: record.account },
        })
      ).status === 'resolved';
    return {
      answer: proved
        ? {
            status: record.reservation ? 'booked' : 'placed',
            order_number: record.recordId,
            attempt_id: attemptId,
            repeat_safe: false,
          }
        : await store.unconfirm(attemptId),
    };
  }
  const evidence = page.isClosed() ? undefined : await readConfirmation(page);
  // The merchant's own confirmation proves the booking, unless its number already proves another under the same
  // contact email (KTD8).
  const confirmed =
    evidence !== undefined &&
    confirmsOnSite(evidence, free.facts.site, free.facts.platform) &&
    (
      await store.resolve(attemptId, {
        placed: true,
        source: 'page',
        evidence: { ...evidence },
        record: { id: evidence.reference, account: free.facts.contactEmail ?? null },
      })
    ).status === 'resolved';
  const answer = confirmed
    ? {
        status: freeCommitBooks(free.facts) ? 'booked' : 'placed',
        order_number: evidence.reference,
        attempt_id: attemptId,
        repeat_safe: false,
      }
    : await store.unconfirm(attemptId);
  if (evidence && showsCharge(evidence))
    return {
      answer: { status: 'stopped', reason: 'unapproved_commit', attempt_id: attemptId, repeat_safe: false },
      unapproved: { site: free.facts.site, evidence },
    };
  return { answer };
}

/**
 * The purchase door (KTD3): the host reads the checkout the target commits and decides, in order, a free commit
 * it presses itself, a checkout that needs a card, one whose facts are incomplete, one that waits on an earlier
 * purchase on its merchant (KTD9), or a card for the principal.
 */
export async function executeBrowserPurchase(
  context: BrowserExecutionContext,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const page = await context.page();
  // Spending nobody approved stops the job once its operation has ended (KTD10), as an ordinary press's does.
  const found: { unapproved?: UnapprovedCommit } = {};
  try {
    const answer = await withBrowserJobNavigation(context, page, async () => {
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
        // On an unreviewed site only a commit-class control is a purchase: the agent presses anything else itself.
        if (
          merchantSignatureFor(page) === genericCheckoutSignature &&
          (!ref || (await classifyActivation(page, ref.element)) !== 'purchase_control')
        )
          return { status: 'not_a_purchase', repeat_safe: true };
        const read = await readMerchantPurchase(page, ref?.element);
        switch (read.status) {
          case 'ready':
            break;
          case 'free': {
            // Its outcome, resolved or unconfirmed, ends a region watch the press claimed in the same transaction.
            const free = await commitFree(context, page, { kind: 'generic', facts: read.facts, element: read.element });
            found.unapproved = free.unapproved;
            return free.answer;
          }
          case 'card_needed':
            return { status: 'card_needed', ...read.needed, repeat_safe: true };
          case 'facts_incomplete':
            return { status: 'facts_incomplete', missing: [...read.missing], repeat_safe: true };
          case 'checkout_lapsed':
            return { status: 'not_a_purchase', repeat_safe: true };
          case 'terms_unavailable':
            return { status: read.status, repeat_safe: true };
          default: {
            const unknown: never = read;
            throw new Error(`Unknown checkout read ${JSON.stringify(unknown)}`);
          }
        }
        // The merchant keeps its lease through a payment platform's own page (KTD7).
        if (read.facts.generic) {
          const lease = await new SiteLeaseStore(context.store.db).acquire(
            context.job.id,
            `https://${read.facts.site}/`,
          );
          await context.wakeWaiters(lease.waitingJobs, `${context.request.id}:merchant-lease`);
          if (!lease.acquired) return { status: 'site_purchase_blocked', reason: 'site_busy', repeat_safe: true };
        }
        const facts = withConsent(read.facts, await checkoutConsent(context, page, read.element));
        const store = new PurchaseAuthorityStore(context.store.db);
        const { prepareWatchPurchase } = await import('./watches.js');
        const watch = await prepareWatchPurchase(context, facts);
        if (watch)
          return watch.status === 'ready'
            ? executeAuthorizedPurchase(context, watch.authorityId)
            : { ...watch, repeat_safe: false };
        const live = await store.liveForJob(context.job.id);
        if (live) return executeAuthorizedPurchase(context, live.id);
        // A reviewed reservation free by the test any site's booking takes is the host's to press, with no card (R3).
        if (await freeReservation(page, facts, read.element)) {
          const free = await commitFree(context, page, {
            kind: 'reviewed',
            facts: read.facts,
            element: read.element,
            signature: read.signature,
          });
          found.unapproved = free.unapproved;
          return free.answer;
        }
        // Another purchase on the merchant waits until main records the earlier one's outcome (KTD9, AE4).
        if (await store.waitOnEarlier(context.job.id, facts.site))
          return { status: 'waiting_on_earlier', site: facts.site, repeat_safe: true };
        const bounds = purchaseBounds(payload, await principalClock());
        const child = await deriveReservationGuaranteeAuthority(
          context.job.id,
          context.request.id,
          facts,
          bounds,
          store,
        );
        if (child) return executeAuthorizedPurchase(context, child.id);
        return requestPurchaseCard(context, facts, bounds);
      } finally {
        await disposeBrowserRefs(refs);
      }
    });
    if (found.unapproved) return { ...answer, incident: await stopForUnapprovedCommit(context, found.unapproved) };
    return answer;
  } catch (error) {
    if (error instanceof BrowserSiteBusyError)
      return { status: 'site_purchase_blocked', reason: 'site_busy', repeat_safe: true };
    const refused = framesUnreadyStop(error);
    if (refused) return refused;
    throw error;
  }
}

registerBrowserQueuedAction('purchase', { validate: validatePurchaseRequest, execute: executeBrowserPurchase });

/** Internal approval work has no polling MCP caller; every pre-commit answer resumes its job. */
async function deliverPurchaseCommitAnswer(request: BrowserRequest, frame: ResponseFrame): Promise<void> {
  if (request.commit_started_at) return; // Marked outcomes already use the durable authority notification.
  const payload = JSON.parse(request.payload_json) as Record<string, unknown>;
  const authority =
    typeof payload.authority_id === 'string' ? await new PurchaseAuthorityStore().get(payload.authority_id) : undefined;
  if (!authority || authority.job_id !== request.job_id || authority.outcome_json) return;
  const job = await new BrowserStore().getJob(request.job_id);
  const session = job ? await getSession(job.browser_session_id) : undefined;
  if (!job || !session || session.id !== request.session_id) return;
  const data =
    frame.ok && isRecord(frame.data)
      ? frame.data
      : {
          status: 'stopped',
          reason: frame.ok ? 'browser_unavailable' : frame.error.code,
        };
  const unspent = authority.state === 'live' && !authority.commit_started_at;
  const cancellation = await getDb().get<{ cancel_requested: number }>(
    'SELECT cancel_requested FROM gws_ea_browser_jobs WHERE id=?',
    job.id,
  );
  const rebuild =
    unspent &&
    authority.expires_at > new Date().toISOString() &&
    !job.cancelled &&
    cancellation?.cancel_requested === 0;
  try {
    await writeBrowserNotice(
      session,
      `browser-commit-${request.id}`,
      JSON.stringify({
        ...data,
        type: 'browser_purchase_outcome',
        job: job.id,
        authority_id: authority.id,
        authority_unspent: unspent,
        safe_to_rebuild: rebuild,
        repeat_safe: false,
        message: rebuild
          ? 'No purchase was attempted. Rebuild the checkout from a fresh observation and call purchase; the host will revalidate the original approved facts, bounds and expiry. Do not repeat the internal commit request.'
          : data.status === 'awaiting_principal'
            ? "No purchase was attempted: the principal has a new card with the checkout's current facts. Stay on the checkout and wait for its outcome."
            : 'No purchase was attempted. The existing approval cannot currently be used; report this outcome and continue only through the normal purchase flow.',
      }),
    );
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }
  void requestWake(session, 'browser-purchase-outcome').catch(() => undefined);
}
registerBrowserQueuedAction('browser_purchase_commit', {
  validate(content) {
    if (typeof content.authority_id !== 'string') throw invalidArgs('authority_id required');
    return { authority_id: content.authority_id };
  },
  async execute(context, payload) {
    try {
      return await executeAuthorizedPurchase(context, String(payload.authority_id));
    } catch (error) {
      const refused = framesUnreadyStop(error);
      if (refused) return refused;
      throw error;
    }
  },
  deliverAnswer: deliverPurchaseCommitAnswer,
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
  // A press the stop cut off, paid or free, has no page proof either way: it is unconfirmed (KTD8).
  for (const id of await store.unsettled()) await store.unconfirm(id);
  // Site blocks follow the attempts' own resolutions, so a resolved attempt never blocks its site again.
  await store.db.transaction(async () => {
    const unresolved = `SELECT site FROM gws_ea_browser_purchase_attempts WHERE resolution IS NULL
      UNION SELECT site FROM gws_ea_browser_free_attempts WHERE resolution IS NULL`;
    await store.db.run(`DELETE FROM gws_ea_browser_purchase_blocks WHERE site NOT IN (${unresolved})`);
    for (const { site } of await store.db.all<{ site: string }>(unresolved))
      await store.db.run(
        'INSERT INTO gws_ea_browser_purchase_blocks(site,created_at) VALUES(?,?) ON CONFLICT(site) DO NOTHING',
        site,
        new Date().toISOString(),
      );
    // A job that waited on a site nothing blocks any more is woken.
    await store.db.run(
      `UPDATE gws_ea_browser_purchase_waiters SET released_at = ? WHERE released_at IS NULL AND site NOT IN (${unresolved})`,
      new Date().toISOString(),
    );
  });
  // Unknown attempts are protected by site blocks, never stale cart leases.
  for (const job of await store.db.all<{ job_id: string }>(
    "SELECT DISTINCT job_id FROM gws_ea_browser_site_leases WHERE state = 'purchase'",
  ))
    await queue.wakeWaiters(await queue.leases.releaseUnheldPurchases(job.job_id), `purchase-recovery-${job.job_id}`);
  // Old accepted requests will be answered interrupted. Recovery always creates a fresh request id afterward.
  await store.db.run('UPDATE gws_ea_browser_pending_commits SET generation = generation + 1,queued_request_id = NULL');
  for (const authority of await store.db.all<SpendingAuthority>(
    'SELECT * FROM gws_ea_browser_authorities WHERE outcome_json IS NOT NULL AND notified_at IS NULL',
  ))
    await notifyPurchaseOutcome(authority.id, store);
  await notifyPendingUnconfirmed(store.db);
  await notifyPurchaseWaiters(store.db);
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
  await notifyPendingUnconfirmed(store.db);
  await notifyPurchaseWaiters(store.db);
}
/** Queue interruption calls this before publishing an uncertain marked request's answer: its press is unconfirmed. */
export async function recordUnknownBrowserPurchaseRequest(requestId: string): Promise<void> {
  if (!(await getDb().hasTable('gws_ea_browser_authorities'))) return;
  const store = new PurchaseAuthorityStore();
  for (const authority of await store.db.all<SpendingAuthority>(
    "SELECT * FROM gws_ea_browser_authorities WHERE commit_request_id = ? AND state = 'committing'",
    requestId,
  )) {
    await store.unconfirm(authority.attempt_id);
    await notifyPurchaseOutcome(authority.id, store);
  }
  for (const { id } of await store.db.all<{ id: string }>(
    'SELECT id FROM gws_ea_browser_free_attempts WHERE request_id = ? AND resolution IS NULL',
    requestId,
  ))
    await store.unconfirm(id);
}
