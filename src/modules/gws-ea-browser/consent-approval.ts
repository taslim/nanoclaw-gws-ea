/**
 * The principal's side of the consent engine. A `consent_required` stop records one wording the engine would not
 * agree to on its own; the browser agent asks the principal with `request_consent` and that stop's id, and the
 * principal approves or rejects it on a card showing the site and the exact wording. An approval stands for that
 * wording on that site and frame origin until the wording changes, which stops again, or the principal withdraws
 * it through an agent with browser access. A rejection leaves the box unticked, and the job is told; a credential
 * form held for that stop is left unknown, never filled again.
 */
import { noVerifiedPrincipalMessage } from '../gws-ea-profile/approval-wording.js';
import { getDomain } from 'tldts';

import { answeredGuard, answeringAction, forbidden, invalidArgs } from '../../cli/delivery-action.js';
import { getDb } from '../../db/connection.js';
import { isUniqueViolation } from '../../db/errors.js';
import { getSession } from '../../db/sessions.js';
import { registerDeliveryAction } from '../../delivery.js';
import { DENY, HOLD, defineGuardedAction, guard } from '../../guard/index.js';
import { requestWake } from '../../request-wake.js';
import type { Session } from '../../types.js';
import { registerApprovalHandler, requestApproval } from '../approvals/index.js';
import { registerApprovalResolvedHandler, type ApprovalResolvedEvent } from '../approvals/primitive.js';
import { isVerifiedPrincipalUser, principalApproverUserId } from '../gws-ea-profile/db.js';
import { browserAvailability } from './availability.js';
import { hasBrowserAccess } from './access.js';
import { browserDelegateGuard } from './cancel.js';
import { ERRAND_ORIGIN_LINE, SELLER_TEXT_LIMIT } from './cards.js';
import {
  getConsentStop,
  liveConsentGrants,
  recordConsentGrant,
  siteWording,
  type ConsentGrant,
  type ConsentStop,
} from './consent.js';
import { BrowserStore } from './db.js';
import { writeBrowserNotice } from './notices.js';

import type { BrowserExecutionContext, BrowserQueuedAction } from './actions.js';
import { quoted } from '../approvals/request-text.js';

/** The `pending_approvals.action` a consent card resolves through. */
export const CONSENT_APPROVAL = 'browser_consent';
export const CONSENT_CARD_LIFE_MS = 24 * 60 * 60 * 1000;
const STOP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

// A periodic sweep must not mistake card creation's awaits for an interrupted, cardless request.
const creatingConsentCards = new Set<string>();

/** Only a live browser job may ask for its own stop, and only the principal may agree. */
export const browserConsentGuard = defineGuardedAction({
  action: 'gws_ea_browser.consent',
  grantActionName: CONSENT_APPROVAL,
  grantCoversRequest: (grant, input) => grant.payload === JSON.stringify(input.payload),
  async decide({ actor, payload }) {
    if (actor.kind !== 'agent' || !actor.sessionId) return DENY('Only a live browser job can ask for consent.');
    const session = await getSession(actor.sessionId);
    const store = new BrowserStore(getDb());
    const stop = typeof payload.stopId === 'string' ? await getConsentStop(getDb(), payload.stopId) : undefined;
    const job = stop ? await store.getJob(stop.job_id) : undefined;
    if (
      !session ||
      !stop ||
      stop.job_id !== payload.jobId ||
      session.agent_group_id !== actor.agentGroupId ||
      session.status !== 'active' ||
      !(await store.jobForSession(session, false)) ||
      job?.browser_session_id !== session.id ||
      job.cancelled
    )
      return DENY('The browser job is no longer live.');
    if (!(await browserAvailability()).available)
      return DENY('Browser is unavailable; ask your operator to check Chrome.');
    const principal = await principalApproverUserId();
    return principal
      ? HOLD('Agreeing to anything beyond a site’s own terms is the principal’s decision.', principal)
      : DENY(noVerifiedPrincipalMessage());
  },
});

/** An address or a bare domain, keyed as grants are: by its registrable domain. */
function siteKey(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  try {
    return getDomain(new URL(trimmed).hostname, { allowPrivateDomains: true }) ?? trimmed;
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return getDomain(trimmed, { allowPrivateDomains: true }) ?? trimmed;
  }
}

function consentQuestion(stop: ConsentStop): string {
  return [
    `To continue your errand, ${stop.site} asks me to agree to this:`,
    quoted(stop.wording, 2000),
    // A form another site serves inside this one, such as a booking widget, is named by its own address.
    ...(siteKey(stop.origin) !== stop.site ? [`It is in a form from ${quoted(stop.origin, SELLER_TEXT_LIMIT)}.`] : []),
    `If you approve, I'll tick it there now and whenever this exact wording appears on ${stop.site} again, until you ask me to stop. If the wording changes, I'll ask you again.`,
  ].join('\n');
}

/** to: browser */
export function validateConsentRequest(content: Record<string, unknown>): Record<string, unknown> {
  if (Object.keys(content).some((key) => !['action', 'requestId', 'budget_ms', 'stop_id'].includes(key)))
    throw invalidArgs('Unknown request_consent field.');
  if (typeof content.stop_id !== 'string' || !STOP_ID.test(content.stop_id))
    throw invalidArgs('request_consent needs the stop_id a consent_required stop returned.');
  return { stop_id: content.stop_id };
}

/**
 * Posts the principal's card for one stop of this job. An unknown stop, another job's or one already used is
 * refused; a wording the principal already agreed to on the site is approved without a card.
 */
export async function executeConsentRequest(
  context: BrowserExecutionContext,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { db } = context.store;
  const stop = typeof payload.stop_id === 'string' ? await getConsentStop(db, payload.stop_id) : undefined;
  if (!stop || stop.job_id !== context.job.id) return { status: 'refused', reason: 'unknown_stop' };
  if (stop.status !== 'open') return { status: 'refused', reason: 'stop_used' };
  if ((await liveConsentGrants(db, stop.site, stop.origin)).has(stop.wording)) {
    await db.run(
      "UPDATE gws_ea_browser_consent_stops SET status = 'approved',decided_at = ?,outcome_notified_at = ? WHERE id = ? AND status = 'open'",
      new Date().toISOString(),
      new Date().toISOString(),
      stop.id,
    );
    return { status: 'approved', stop_id: stop.id };
  }
  const approval = { stopId: stop.id, jobId: stop.job_id };
  const decision = await guard(browserConsentGuard, {
    actor: { kind: 'agent', agentGroupId: context.session.agent_group_id, sessionId: context.session.id },
    payload: approval,
  });
  if (decision.effect !== 'hold') throw forbidden(decision.reason);
  if (creatingConsentCards.has(stop.id)) return { status: 'refused', reason: 'stop_used' };
  creatingConsentCards.add(stop.id);
  try {
    const claimed = await db.run(
      "UPDATE gws_ea_browser_consent_stops SET status = 'requested',requested_at = ? WHERE id = ? AND status = 'open'",
      new Date().toISOString(),
      stop.id,
    );
    if (!claimed.changes) return { status: 'refused', reason: 'stop_used' };
    const approvalId = await requestApproval({
      session: context.session,
      agentName: 'browser',
      action: CONSENT_APPROVAL,
      payload: approval,
      title: `Agree to this on ${stop.site}?`,
      question: consentQuestion(stop),
      approverUserId: decision.approverUserId,
      expiresAt: new Date(Date.now() + CONSENT_CARD_LIFE_MS).toISOString(),
      originLine: ERRAND_ORIGIN_LINE,
      details: { facts: { site: stop.site, wording: stop.wording } },
    });
    if (!approvalId) {
      await db.transaction(async () => {
        const at = new Date().toISOString();
        await db.run(
          "UPDATE gws_ea_browser_consent_stops SET status = 'withdrawn',decided_at = ?,outcome_notified_at = ? WHERE id = ? AND status = 'requested'",
          at,
          at,
          stop.id,
        );
      });
      return { status: 'withdrawn', stop_id: stop.id };
    }
    // A click delivered before the id returned has already set it.
    await db.run(
      'UPDATE gws_ea_browser_consent_stops SET approval_id = ? WHERE id = ? AND approval_id IS NULL',
      approvalId,
      stop.id,
    );
    return { status: 'awaiting_principal', stop_id: stop.id };
  } finally {
    creatingConsentCards.delete(stop.id);
  }
}

const OUTCOME_MESSAGES = {
  approved:
    'The principal agreed. The host may tick this box when this exact wording appears on the site. If credentials already reached the page, reconcile that attempt before trying again: consent does not prove the first attempt was unsubmitted.',
  rejected:
    'The principal declined. The host leaves this box unticked; do not submit a form that needs it, and report this to the agent that sent the errand.',
  expired:
    'The principal did not answer in time. The box stays unticked; report this to the agent that sent the errand.',
  withdrawn:
    'The consent card is no longer open. The box stays unticked; report this to the agent that sent the errand.',
} as const;

/** The job hears the principal's decision on its stop, once. */
async function notifyConsentOutcome(stop: ConsentStop, status: keyof typeof OUTCOME_MESSAGES): Promise<void> {
  const db = getDb();
  const current = await getConsentStop(db, stop.id);
  if (!current || current.status !== status || current.outcome_notified_at !== null) return;
  const job = await new BrowserStore(db).getJob(stop.job_id);
  const session = job ? await getSession(job.browser_session_id) : undefined;
  if (!session) return;
  let written = false;
  try {
    await writeBrowserNotice(
      session,
      `browser-consent-${stop.id}-${status}`,
      JSON.stringify({
        type: 'browser_consent_outcome',
        job: stop.job_id,
        stop_id: stop.id,
        status,
        site: stop.site,
        wording: siteWording(stop.wording, stop.site),
        message: OUTCOME_MESSAGES[status],
      }),
    );
    written = true;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }
  await db.run(
    'UPDATE gws_ea_browser_consent_stops SET outcome_notified_at = ? WHERE id = ? AND status = ? AND outcome_notified_at IS NULL',
    new Date().toISOString(),
    stop.id,
    status,
  );
  if (written) void requestWake(session, 'approval-response').catch(() => undefined);
}

/**
 * The principal's approval, re-checked live with the card as its grant: the wording stands agreed on the site
 * and frame origin. Idempotent, so an approved row resumes safely after a restart.
 */
registerApprovalHandler(
  CONSENT_APPROVAL,
  async ({ session, payload, approval, userId }) => {
    if (!(await isVerifiedPrincipalUser(userId)) || userId !== approval.approver_user_id) return;
    const stop = typeof payload.stopId === 'string' ? await getConsentStop(getDb(), payload.stopId) : undefined;
    if (
      !stop ||
      stop.job_id !== payload.jobId ||
      (stop.approval_id !== null && stop.approval_id !== approval.approval_id)
    )
      return;
    const decision = await guard(browserConsentGuard, {
      actor: { kind: 'agent', agentGroupId: session.agent_group_id, sessionId: session.id },
      payload: { stopId: stop.id, jobId: stop.job_id },
      grant: approval,
    });
    if (decision.effect !== 'allow') return;
    const db = getDb();
    const approved = await db.transaction(async () => {
      const current = await getConsentStop(db, stop.id);
      if (!current || (current.status !== 'requested' && current.status !== 'approved')) return false;
      await recordConsentGrant(db, {
        site: current.site,
        origin: current.origin,
        wording: current.wording,
        approvalId: approval.approval_id,
        principalUserId: userId,
      });
      await db.run(
        "UPDATE gws_ea_browser_consent_stops SET status = 'approved',approval_id = ?,decided_at = COALESCE(decided_at, ?) WHERE id = ?",
        approval.approval_id,
        new Date().toISOString(),
        current.id,
      );
      return true;
    });
    if (approved) await notifyConsentOutcome(stop, 'approved');
  },
  {
    restartSafe: true,
    rejectionNote: () => null,
    finalizeRejection: settleConsentOutcome,
  },
);

async function settleConsentOutcome({ approval, outcome }: ApprovalResolvedEvent): Promise<void> {
  if (approval.action !== CONSENT_APPROVAL || outcome === 'approve') return;
  const payload = JSON.parse(approval.payload) as { stopId?: unknown; jobId?: unknown };
  if (typeof payload.stopId !== 'string') return;
  const stopId = payload.stopId;
  const status = outcome === 'reject' ? 'rejected' : outcome;
  const db = getDb();
  const stop = await db.transaction(async () => {
    const current = await getConsentStop(db, stopId);
    if (
      !current ||
      current.job_id !== payload.jobId ||
      (current.approval_id !== null && current.approval_id !== approval.approval_id) ||
      (current.status !== 'requested' && current.status !== status)
    )
      return undefined;
    await db.run(
      'UPDATE gws_ea_browser_consent_stops SET status = ?,decided_at = COALESCE(decided_at, ?) WHERE id = ?',
      status,
      new Date().toISOString(),
      current.id,
    );
    return current;
  });
  if (stop) await notifyConsentOutcome(stop, status);
}

registerApprovalResolvedHandler(async (event) => {
  if (event.outcome !== 'reject') await settleConsentOutcome(event);
});

/** Repairs interrupted card requests, then retries outcomes whose deterministic mailbox notice is still owed. */
export async function recoverConsentOutcomes(): Promise<void> {
  const db = getDb();
  if (!(await db.hasTable('gws_ea_browser_consent_stops'))) return;
  const requested = await db.all<{ id: string }>(
    "SELECT id FROM gws_ea_browser_consent_stops WHERE status = 'requested' ORDER BY requested_at,id",
  );
  for (const { id } of requested) {
    await db.transaction(async () => {
      if (creatingConsentCards.has(id)) return;
      const stop = await getConsentStop(db, id);
      if (!stop || stop.status !== 'requested') return;
      const cards = await db.all<{ approval_id: string; payload: string }>(
        'SELECT approval_id,payload FROM pending_approvals WHERE action = ?',
        CONSENT_APPROVAL,
      );
      const card = cards.find((candidate) => {
        const payload = JSON.parse(candidate.payload) as { stopId?: unknown; jobId?: unknown };
        return payload.stopId === stop.id && payload.jobId === stop.job_id;
      });
      if (card) {
        // Card delivery and its answer may precede the request's final approval-id write.
        await db.run(
          "UPDATE gws_ea_browser_consent_stops SET approval_id = ? WHERE id = ? AND status = 'requested'",
          card.approval_id,
          stop.id,
        );
        return;
      }
      // The original reason may have disappeared with the card. Its absence proves only that consent
      // cannot complete now, never that the principal agreed: retain a truthful terminal outcome to notify.
      await db.run(
        "UPDATE gws_ea_browser_consent_stops SET status = 'withdrawn',decided_at = COALESCE(decided_at, ?) WHERE id = ? AND status = 'requested'",
        new Date().toISOString(),
        stop.id,
      );
    });
  }
  const pending = await db.all<ConsentStop>(
    "SELECT * FROM gws_ea_browser_consent_stops WHERE outcome_notified_at IS NULL AND status IN ('approved','rejected','expired','withdrawn') ORDER BY decided_at,id",
  );
  for (const stop of pending) {
    if (stop.status === 'open' || stop.status === 'requested') continue;
    await notifyConsentOutcome(stop, stop.status);
  }
}

export const requestConsentAction: BrowserQueuedAction = {
  validate: validateConsentRequest,
  execute: executeConsentRequest,
};

// ---------------------------------------------------------------- the principal's grants, for browser delegators

const GRANT_FIELDS: ReadonlySet<string> = new Set(['action', 'requestId', 'operation', 'grant_id', 'site']);

/**
 * Lists the principal's standing agreements, or withdraws one the principal asked to withdraw: from then on that
 * wording stops again on its site, and a purchase approved with it asks again before it commits.
 * to: main, delegator
 */
async function consentGrantsRequest(
  content: Record<string, unknown>,
  session: Session,
): Promise<Record<string, unknown>> {
  if (!(await hasBrowserAccess(session.agent_group_id)))
    throw forbidden('Only an agent with browser access may manage the principal’s consent grants.');
  if (Object.keys(content).some((key) => !GRANT_FIELDS.has(key))) throw invalidArgs('Unknown consent_grants field.');
  const { operation, grant_id: grantId, site } = content;
  const db = getDb();
  if (operation === 'list') {
    if (grantId !== undefined || (site !== undefined && (typeof site !== 'string' || !site.trim())))
      throw invalidArgs('list takes only an optional site.');
    const grants = await db.all<ConsentGrant>(
      typeof site === 'string'
        ? 'SELECT * FROM gws_ea_browser_consent_grants WHERE withdrawn_at IS NULL AND site = ? ORDER BY created_at'
        : 'SELECT * FROM gws_ea_browser_consent_grants WHERE withdrawn_at IS NULL ORDER BY created_at',
      ...(typeof site === 'string' ? [siteKey(site)] : []),
    );
    return {
      status: 'listed',
      grants: grants.map((grant) => ({
        grant_id: grant.id,
        site: grant.site,
        origin: grant.origin,
        wording: siteWording(grant.wording, grant.site),
        approved_at: grant.created_at,
      })),
    };
  }
  if (operation !== 'withdraw') throw invalidArgs('operation must be list or withdraw.');
  if (typeof grantId !== 'string' || !grantId || site !== undefined)
    throw invalidArgs('withdraw takes only the grant_id the list returned.');
  const withdrawn = await db.run(
    'UPDATE gws_ea_browser_consent_grants SET withdrawn_at = ? WHERE id = ? AND withdrawn_at IS NULL',
    new Date().toISOString(),
    grantId,
  );
  return withdrawn.changes ? { status: 'withdrawn', grant_id: grantId } : { status: 'not_found' };
}

export function registerConsentGrantsDelivery(): void {
  registerDeliveryAction(
    'consent_grants',
    answeringAction('consent_grants', consentGrantsRequest),
    answeredGuard(browserDelegateGuard),
  );
}
