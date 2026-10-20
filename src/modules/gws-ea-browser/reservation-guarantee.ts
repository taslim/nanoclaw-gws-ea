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
import { isVerifiedPrincipalUser, principalApproverUserId } from '../gws-ea-profile/db.js';
import { hasBrowserAccess, readHostBrowserPolicy } from './access.js';
import { PurchaseAuthorityStore, type SpendingAuthority } from './authority.js';
import { readIsoTime } from './iso-time.js';
import { browserDelegateGuard, resolveBrowserJob } from './cancel.js';
import { agreementsGranted } from './consent.js';
import {
  guaranteeCoversReservation,
  amountMinor,
  currencyExponent,
  formatMoney,
  type PurchaseBounds,
  type PurchaseFacts,
} from './fingerprint.js';

import { BrowserStore } from './db.js';

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
export async function deriveReservationGuaranteeAuthority(
  jobId: string,
  attemptKey: string,
  facts: PurchaseFacts,
  bounds: PurchaseBounds,
  store = new PurchaseAuthorityStore(),
): Promise<SpendingAuthority | undefined> {
  return store.db.transaction(async () => {
    // Once this errand asks for checkout approval, a standing grant cannot replace that decision.
    if (await store.db.get('SELECT 1 FROM gws_ea_browser_purchase_cards WHERE job_id = ? LIMIT 1', jobId))
      return undefined;
    const reservation = await new BrowserStore(store.db).reservationBounds(jobId);
    const delegatedBounds = { ...bounds, reservation };
    const grant = await store.db.get<StandingGuarantee>(
      'SELECT * FROM gws_ea_browser_reservation_guarantees WHERE revoked_at IS NULL ORDER BY created_at DESC LIMIT 1',
    );
    if (
      !guaranteeCoversReservation(grant, facts, delegatedBounds) ||
      (await store.unresolved(facts.site)).length ||
      !grant ||
      // An agreement the principal has not approved needs the card.
      (facts.agreements?.length && !(await agreementsGranted(store.db, facts.site, facts.agreements)))
    )
      return undefined;
    const prior = await store.db.all<SpendingAuthority>(
      "SELECT * FROM gws_ea_browser_authorities WHERE job_id = ? AND kind = 'reservation_guarantee' ORDER BY created_at",
      jobId,
    );
    if (
      prior.some(
        (authority) => authority.commit_started_at || ['committing', 'committed', 'unknown'].includes(authority.state),
      )
    )
      return undefined;
    const live = prior.find((authority) => authority.state === 'live' && authority.guarantee_id === grant.id);
    if (live) return live;
    const attemptId = `attempt-${createHash('sha256').update(`${grant.id}\0${jobId}\0${attemptKey}`).digest('hex')}`;
    const id = `guarantee-${createHash('sha256').update(`${grant.id}\0${attemptId}`).digest('hex')}`;
    if (await store.get(id)) return undefined;
    return store.create({
      id,
      jobId,
      kind: 'reservation_guarantee',
      facts,
      bounds: delegatedBounds,
      attemptId,
      guaranteeId: grant.id,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });
  });
}

/** A delegating agent records the principal's errand scope; this grants no financial authority by itself. */
async function reservationBoundsRequest(
  content: Record<string, unknown>,
  session: Session,
): Promise<Record<string, unknown>> {
  if (!(await hasBrowserAccess(session.agent_group_id)))
    throw forbidden('Only an agent with browser access may record reservation bounds.');
  if (
    Object.keys(content).some(
      (key) => !['action', 'requestId', 'thread', 'venue_id', 'party_size', 'window_start', 'window_end'].includes(key),
    )
  )
    throw invalidArgs('Unknown reservation_bounds field.');
  if (
    typeof content.thread !== 'string' ||
    typeof content.venue_id !== 'string' ||
    !content.venue_id.trim() ||
    content.venue_id.length > 256 ||
    !Number.isSafeInteger(content.party_size) ||
    Number(content.party_size) < 1
  )
    throw invalidArgs('Reservation bounds require a job thread, venue_id and positive party_size.');
  const stamp = (value: unknown): string => {
    const parsed = readIsoTime(value, 'required');
    if (!parsed) throw invalidArgs('Reservation bounds require real ISO timestamps with an explicit timezone.');
    return parsed;
  };
  const bounds = {
    venueId: content.venue_id.trim(),
    partySize: Number(content.party_size),
    windowStart: stamp(content.window_start),
    windowEnd: stamp(content.window_end),
  };
  if (bounds.windowEnd <= bounds.windowStart) throw invalidArgs('The reservation window must end after it starts.');
  return getDb().transaction(async () => {
    const job = await resolveBrowserJob(content.thread as string, undefined, session.agent_group_id);
    if (!job || job.cancelled) throw forbidden('No live browser job of yours exists for that thread.');
    const encoded = JSON.stringify(bounds);
    const existing = await new BrowserStore().reservationBounds(job.id);
    if (existing && JSON.stringify(existing) === encoded)
      return { status: 'recorded', thread: job.thread_id, bounds: existing };
    const authority = await getDb().get(
      "SELECT 1 FROM gws_ea_browser_authorities WHERE job_id = ? AND kind = 'reservation_guarantee' AND (state <> 'revoked' OR commit_started_at IS NOT NULL) LIMIT 1",
      job.id,
    );
    if (authority)
      throw forbidden('This errand already has reservation authority. Open a new errand for different bounds.');
    await getDb().run(
      'INSERT INTO gws_ea_browser_reservation_bounds(job_id,bounds_json,created_at) VALUES(?,?,?) ON CONFLICT(job_id) DO UPDATE SET bounds_json=excluded.bounds_json',
      job.id,
      encoded,
      new Date().toISOString(),
    );
    return { status: 'recorded', thread: job.thread_id, bounds };
  });
}
const guaranteeGuard = defineGuardedAction({
  action: 'gws_ea_browser.reservation_guarantee',
  grantActionName: GUARANTEE_APPROVAL,
  grantCoversRequest: (grant, input) => grant.payload === JSON.stringify(input.payload),
  async decide({ actor }) {
    const policy = await readHostBrowserPolicy();
    if (actor.kind !== 'agent' || !(await hasBrowserAccess(actor.agentGroupId, policy)))
      return DENY('Only an agent with browser access may propose a reservation guarantee.');
    if (!policy.enabled) return DENY('Browser is disabled.');
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
  { restartSafe: true, rejectionNote: guaranteeRejectionNote },
);
/**
 * What the agent that proposed a standing guarantee reads when the principal declines it: their decision, with
 * any reason they gave, and what still holds, since an earlier guarantee stays until a newer one is approved.
 */
async function guaranteeRejectionNote(approval: PendingApproval, reason: string | undefined): Promise<string> {
  const { proposalId } = JSON.parse(approval.payload) as { proposalId?: unknown };
  const proposal =
    typeof proposalId === 'string'
      ? await getDb().get<GuaranteeProposal>(
          'SELECT * FROM gws_ea_browser_guarantee_proposals WHERE id = ?',
          proposalId,
        )
      : undefined;
  const current = await getDb().get<StandingGuarantee>(
    'SELECT * FROM gws_ea_browser_reservation_guarantees WHERE revoked_at IS NULL ORDER BY created_at DESC LIMIT 1',
  );
  const limit = (grant: Pick<StandingGuarantee, 'currency' | 'max_total_minor'>) =>
    `${formatMoney(grant.max_total_minor, grant.currency)} (${grant.currency})`;
  const declined = `The principal declined to allow reservation guarantees${proposal ? ` of up to ${limit(proposal)}` : ''}${reason ? `: "${reason}"` : ''}.`;
  return current
    ? `${declined} The guarantee they already allow, up to ${limit(current)}, stays as it is.`
    : `${declined} A reservation with a cancellation or no-show fee still goes to them on its own card.`;
}
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
  const policy = await readHostBrowserPolicy();
  if (!(await hasBrowserAccess(session.agent_group_id, policy)))
    throw forbidden('Only an agent with browser access may manage reservation guarantees.');
  if (!policy.enabled) throw forbidden('Browser is disabled.');
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
    if (!grant) return { status: 'not_configured' };
    const precision = currencyExponent(grant.currency);
    if (precision === undefined) throw forbidden('The standing guarantee currency is not supported.');
    return {
      status: 'active',
      grant_id: grant.id,
      currency: grant.currency,
      max_total: (grant.max_total_minor / 10 ** precision).toFixed(precision),
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
    !/^\d+(?:\.\d{1,3})?$/u.test(content.max_total)
  )
    throw invalidArgs('Propose requires an explicit currency and max_total decimal string; no default applies.');
  const maximum = amountMinor(content.max_total, content.currency);
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
    'reservation_bounds',
    answeringAction('reservation_bounds', reservationBoundsRequest),
    answeredGuard(browserDelegateGuard),
  );
  registerDeliveryAction(
    'reservation_guarantee',
    answeringAction('reservation_guarantee', reservationGuaranteeRequest),
    answeredGuard(browserDelegateGuard),
  );
}
