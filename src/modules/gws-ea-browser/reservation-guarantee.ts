import { createHash } from 'node:crypto';
import { answeredGuard, answeringAction, forbidden, invalidArgs } from '../../cli/delivery-action.js';
import { getDb } from '../../db/connection.js';
import { registerDeliveryAction } from '../../delivery.js';
import { DENY, HOLD, defineGuardedAction, guard } from '../../guard/index.js';
import type { PendingApproval, Session } from '../../types.js';
import {
  detachApproval,
  finishApprovalWithdrawal,
  registerApprovalHandler,
  requestApproval,
} from '../approvals/index.js';
import { registerApprovalResolvedHandler } from '../approvals/primitive.js';
import { getMainAgentGroupId, isVerifiedPrincipalUser, principalApproverUserId } from '../gws-ea-profile/db.js';
import { PurchaseAuthorityStore, type SpendingAuthority } from './authority.js';
import { browserDelegateGuard } from './cancel.js';
import {
  completePurchaseFacts,
  formatMoney,
  moneyMinor,
  type PurchaseBounds,
  type PurchaseFacts,
} from './fingerprint.js';
import { readBrowserPolicy } from './policy.js';

const GUARANTEE_APPROVAL = 'browser_reservation_guarantee';
interface StandingGuarantee {
  id: string;
  approval_id: string;
  principal_user_id: string;
  currency: string;
  max_total_minor: number;
  created_at: string;
  revoked_at: string | null;
}
interface GuaranteeProposal {
  id: string;
  session_id: string;
  request_id: string;
  approval_id: string | null;
  currency: string;
  max_total_minor: number;
  expires_at: string;
  status: 'open' | 'approved' | 'withdrawn' | 'expired' | 'rejected';
  created_at: string;
}
export function guaranteeCoversReservation(
  grant: Pick<StandingGuarantee, 'currency' | 'max_total_minor' | 'revoked_at'> | undefined,
  facts: PurchaseFacts,
  bounds: PurchaseBounds,
): boolean {
  const reservation = facts.reservation;
  const delegated =
    bounds.reservation ??
    (reservation
      ? {
          venueId: reservation.venueId,
          partySize: reservation.partySize,
          windowStart: reservation.at,
          windowEnd: reservation.at,
        }
      : undefined);
  if (
    !grant ||
    grant.revoked_at ||
    !reservation ||
    !delegated ||
    facts.dueNowMinor !== 0 ||
    facts.currency !== grant.currency ||
    !completePurchaseFacts(facts)
  )
    return false;
  if (
    reservation.venueId !== delegated.venueId ||
    reservation.partySize !== delegated.partySize ||
    reservation.at < delegated.windowStart ||
    reservation.at > delegated.windowEnd
  )
    return false;
  if (
    !facts.commitments.every(
      (term) =>
        term.kind === 'conditional_fee' &&
        (term.conditionalTrigger === 'cancellation' || term.conditionalTrigger === 'no_show'),
    )
  )
    return false;
  // Distinct conditional fees can both apply; the ceiling covers total exposure, never one person's amount.
  const exposure = facts.commitments.reduce(
    (sum, term) => sum + (term.amountMinor ?? Infinity) * (term.perPerson ? reservation.partySize : 1),
    0,
  );
  return Number.isSafeInteger(exposure) && exposure <= grant.max_total_minor;
}
export async function deriveReservationGuaranteeAuthority(
  jobId: string,
  attemptKey: string,
  facts: PurchaseFacts,
  bounds: PurchaseBounds,
  store = new PurchaseAuthorityStore(),
): Promise<SpendingAuthority | undefined> {
  const grant = await store.db.get<StandingGuarantee>(
    'SELECT * FROM gws_ea_browser_reservation_guarantees WHERE revoked_at IS NULL ORDER BY created_at DESC LIMIT 1',
  );
  if (!guaranteeCoversReservation(grant, facts, bounds) || (await store.unresolved(facts.site)).length || !grant)
    return undefined;
  const attemptId = `attempt-${createHash('sha256').update(`${grant.id}\0${attemptKey}`).digest('hex')}`;
  const id = `guarantee-${createHash('sha256').update(`${grant.id}\0${attemptId}`).digest('hex')}`;
  const existing = await store.get(id);
  if (existing) return existing.state === 'live' ? existing : undefined;
  const exactBounds: PurchaseBounds = bounds.reservation
    ? bounds
    : {
        ...bounds,
        reservation: {
          venueId: facts.reservation!.venueId,
          partySize: facts.reservation!.partySize,
          windowStart: facts.reservation!.at,
          windowEnd: facts.reservation!.at,
        },
      };
  return store.create({
    id,
    jobId,
    kind: 'reservation_guarantee',
    facts,
    bounds: exactBounds,
    attemptId,
    guaranteeId: grant.id,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  });
}
const guaranteeGuard = defineGuardedAction({
  action: 'gws_ea_browser.reservation_guarantee',
  grantActionName: GUARANTEE_APPROVAL,
  grantCoversRequest: (grant, input) => grant.payload === JSON.stringify(input.payload),
  async decide({ actor }) {
    if (actor.kind !== 'agent' || actor.agentGroupId !== (await getMainAgentGroupId()))
      return DENY('Only main may propose a reservation guarantee.');
    if (!(await readBrowserPolicy()).enabled) return DENY('Browser is disabled.');
    const principal = await principalApproverUserId();
    return principal
      ? HOLD('Only the principal can authorize a standing reservation guarantee.', principal)
      : DENY('No verified principal can confirm a standing guarantee.');
  },
});

registerApprovalHandler(
  GUARANTEE_APPROVAL,
  async ({ session, payload, approval, userId }) => {
    if (!(await isVerifiedPrincipalUser(userId)) || approval.approver_user_id !== userId) return;
    const decision = await guard(guaranteeGuard, {
      actor: { kind: 'agent', agentGroupId: session.agent_group_id, sessionId: session.id },
      payload,
      grant: approval,
    });
    if (decision.effect !== 'allow' || typeof payload.proposalId !== 'string') return;
    await getDb().transaction(async () => {
      const proposal = await getDb().get<GuaranteeProposal>(
        'SELECT * FROM gws_ea_browser_guarantee_proposals WHERE id = ?',
        payload.proposalId,
      );
      if (
        !proposal ||
        proposal.session_id !== session.id ||
        proposal.expires_at <= new Date().toISOString() ||
        (proposal.approval_id !== null && proposal.approval_id !== approval.approval_id)
      )
        return;
      const existing = await getDb().get(
        'SELECT id FROM gws_ea_browser_reservation_guarantees WHERE approval_id = ?',
        approval.approval_id,
      );
      if (existing) return;
      if (proposal.status !== 'open') return;
      const at = new Date().toISOString();
      await getDb().run('UPDATE gws_ea_browser_reservation_guarantees SET revoked_at = ? WHERE revoked_at IS NULL', at);
      await getDb().run(
        "UPDATE gws_ea_browser_authorities SET state = 'revoked' WHERE kind = 'reservation_guarantee' AND state = 'live'",
      );
      await getDb().run(
        'INSERT INTO gws_ea_browser_reservation_guarantees(id,approval_id,principal_user_id,currency,max_total_minor,created_at) VALUES(?,?,?,?,?,?)',
        proposal.id,
        approval.approval_id,
        userId,
        proposal.currency,
        proposal.max_total_minor,
        at,
      );
      await getDb().run(
        "UPDATE gws_ea_browser_guarantee_proposals SET status = 'approved',approval_id = ? WHERE id = ?",
        approval.approval_id,
        proposal.id,
      );
    });
  },
  { restartSafe: true },
);
registerApprovalResolvedHandler(async ({ approval, outcome }) => {
  if (approval.action !== GUARANTEE_APPROVAL || outcome === 'approve') return;
  const payload = JSON.parse(approval.payload) as { proposalId?: string };
  if (payload.proposalId)
    await getDb().run(
      "UPDATE gws_ea_browser_guarantee_proposals SET status = ? WHERE id = ? AND status = 'open'",
      outcome === 'reject' ? 'rejected' : outcome,
      payload.proposalId,
    );
});

export async function reservationGuaranteeRequest(
  content: Record<string, unknown>,
  session: Session,
  requestId: string,
): Promise<Record<string, unknown>> {
  if (session.agent_group_id !== (await getMainAgentGroupId()))
    throw forbidden('Only main may manage reservation guarantees.');
  if (!(await readBrowserPolicy()).enabled) throw forbidden('Browser is disabled.');
  if (Object.keys(content).some((key) => !['action', 'requestId', 'operation', 'currency', 'max_total'].includes(key)))
    throw invalidArgs('Unknown reservation_guarantee field.');
  const operation = content.operation;
  if (operation !== 'read' && operation !== 'propose' && operation !== 'revoke')
    throw invalidArgs('operation must be read, propose or revoke.');
  if (operation !== 'propose' && (content.currency !== undefined || content.max_total !== undefined))
    throw invalidArgs('Only propose takes currency and max_total.');
  if (operation === 'read') {
    const grant = await getDb().get<StandingGuarantee>(
      'SELECT * FROM gws_ea_browser_reservation_guarantees WHERE revoked_at IS NULL ORDER BY created_at DESC LIMIT 1',
    );
    return {
      status: grant ? 'active' : 'not_configured',
      ...(grant
        ? { grant_id: grant.id, currency: grant.currency, max_total: (grant.max_total_minor / 100).toFixed(2) }
        : {}),
    };
  }
  if (operation === 'revoke') {
    const detached: PendingApproval[] = [];
    await getDb().transaction(async () => {
      const at = new Date().toISOString();
      await getDb().run('UPDATE gws_ea_browser_reservation_guarantees SET revoked_at = ? WHERE revoked_at IS NULL', at);
      await getDb().run(
        "UPDATE gws_ea_browser_authorities SET state = 'revoked' WHERE kind = 'reservation_guarantee' AND state = 'live'",
      );
      for (const approval of await getDb().all<PendingApproval>(
        'SELECT * FROM pending_approvals WHERE action = ?',
        GUARANTEE_APPROVAL,
      )) {
        const row = await detachApproval(approval.approval_id);
        if (row) detached.push(row);
      }
      await getDb().run("UPDATE gws_ea_browser_guarantee_proposals SET status = 'withdrawn' WHERE status = 'open'");
    });
    for (const row of detached)
      await finishApprovalWithdrawal(row, 'Withdrawn: the standing reservation guarantee was revoked.');
    return { status: 'revoked' };
  }
  if (
    typeof content.currency !== 'string' ||
    !/^[A-Z]{3}$/u.test(content.currency) ||
    typeof content.max_total !== 'string' ||
    !/^\d+(?:\.\d{2})?$/u.test(content.max_total)
  )
    throw invalidArgs('Propose requires an explicit currency and max_total decimal string; no default applies.');
  const maximum = moneyMinor(content.max_total);
  if (maximum === undefined) throw invalidArgs('max_total must be a nonnegative exact decimal amount.');
  // Currency validity also protects the card's exact formatted amount.
  try {
    formatMoney(maximum, content.currency);
  } catch {
    throw invalidArgs('Unknown currency.');
  }
  const id = `guarantee-${createHash('sha256').update(`${session.id}\0${requestId}`).digest('hex')}`;
  const payload = { proposalId: id };
  const decision = await guard(guaranteeGuard, {
    actor: { kind: 'agent', agentGroupId: session.agent_group_id, sessionId: session.id },
    payload,
  });
  if (decision.effect !== 'hold') return { status: 'refused', reason: decision.reason };
  const existing = await getDb().get<GuaranteeProposal>(
    'SELECT * FROM gws_ea_browser_guarantee_proposals WHERE id = ?',
    id,
  );
  if (existing)
    return {
      status: existing.status === 'open' ? 'awaiting_principal' : existing.status === 'approved' ? 'active' : 'refused',
    };
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const detached: PendingApproval[] = [];
  await getDb().transaction(async () => {
    for (const approval of await getDb().all<PendingApproval>(
      'SELECT * FROM pending_approvals WHERE action = ?',
      GUARANTEE_APPROVAL,
    )) {
      const row = await detachApproval(approval.approval_id);
      if (row) detached.push(row);
    }
    await getDb().run("UPDATE gws_ea_browser_guarantee_proposals SET status = 'withdrawn' WHERE status = 'open'");
    await getDb().run(
      "INSERT INTO gws_ea_browser_guarantee_proposals(id,session_id,request_id,currency,max_total_minor,expires_at,status,created_at) VALUES(?,?,?,?,?,?,'open',?)",
      id,
      session.id,
      `${session.id}:${requestId}`,
      content.currency,
      maximum,
      expires,
      new Date().toISOString(),
    );
  });
  for (const row of detached)
    await finishApprovalWithdrawal(row, 'Withdrawn: a newer standing-guarantee proposal replaced this card.');
  const approvalId = await requestApproval({
    session,
    agentName: 'main',
    action: GUARANTEE_APPROVAL,
    payload,
    title: 'Allow conditional reservation guarantees?',
    question: `I'd like permission to confirm reservations with nothing due at booking and a total conditional cancellation or no-show fee of at most ${formatMoney(maximum, content.currency)} (${content.currency}) per reservation, within the venue, party size and time bounds you delegate. Per-person fees count for the whole party. This never covers holds, deposits, prepayments, trials or subscriptions. You can revoke this permission at any time.`,
    approverUserId: decision.approverUserId,
    expiresAt: expires,
    originLine: 'From your reservation-guarantee request.',
    details: { facts: { currency: content.currency, max_total: content.max_total } },
  });
  if (approvalId)
    await getDb().run(
      'UPDATE gws_ea_browser_guarantee_proposals SET approval_id = ? WHERE id = ? AND approval_id IS NULL',
      approvalId,
      id,
    );
  else
    await getDb().run(
      "UPDATE gws_ea_browser_guarantee_proposals SET status = 'withdrawn' WHERE id = ? AND status = 'open'",
      id,
    );
  return { status: approvalId ? 'awaiting_principal' : 'refused' };
}
export function registerReservationGuaranteeDelivery(): void {
  registerDeliveryAction(
    'reservation_guarantee',
    answeringAction('reservation_guarantee', reservationGuaranteeRequest),
    answeredGuard(browserDelegateGuard),
  );
}
