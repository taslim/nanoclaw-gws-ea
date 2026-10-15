import { getDb } from '../../db/index.js';
import {
  deletePendingApproval,
  getPendingApproval,
  getPendingApprovalsByAction,
  getSession,
} from '../../db/sessions.js';
import { getDeliveryAdapter } from '../../delivery.js';
import type { PendingApproval } from '../../types.js';
import { getRegisteredApprovalActions, notifyApprovalResolved } from './primitive.js';
import { editApprovalCard } from './terminal-card.js';

/**
 * Remove a request without any channel or mailbox work. A caller can include
 * this in its own transaction and finish the withdrawal after committing.
 */
export async function detachApproval(approvalId: string): Promise<PendingApproval | null> {
  return getDb().transaction(async () => {
    const approval = await getPendingApproval(approvalId);
    if (!approval) return null;
    await deletePendingApproval(approvalId);
    return approval;
  });
}

/** Complete the post-commit half of a detached request exactly once at its caller. */
export async function finishApprovalWithdrawal(
  approval: PendingApproval,
  resolution: string,
  outcome: 'withdrawn' | 'expired' = 'withdrawn',
): Promise<void> {
  const session = approval.session_id ? await getSession(approval.session_id) : undefined;
  await editApprovalCard(getDeliveryAdapter(), approval, resolution, { recordOutcome: !session });
  if (session) await notifyApprovalResolved({ approval, session, outcome, userId: '', reason: resolution });
}

/** Withdraw an open request when no surrounding transaction is needed. */
export async function withdrawApproval(approvalId: string, resolution: string): Promise<boolean> {
  const approval = await detachApproval(approvalId);
  if (!approval) return false;
  await finishApprovalWithdrawal(approval, resolution);
  return true;
}

/** Claim expiry with a DB-only transition, before performing channel work. */
export async function expireApproval(approvalId: string, now = new Date().toISOString()): Promise<boolean> {
  const approval = await getDb().transaction(async () => {
    const row = await getPendingApproval(approvalId);
    if (!row || row.status !== 'pending' || !row.expires_at || row.expires_at > now) return null;
    await deletePendingApproval(approvalId);
    return row;
  });
  if (!approval) return false;
  await finishApprovalWithdrawal(approval, '⏱️ Timed out — no response', 'expired');
  return true;
}

/** Module handlers own these rows; other approval systems keep their own sweeps. */
export async function sweepExpiredApprovals(): Promise<void> {
  const now = new Date().toISOString();
  for (const action of getRegisteredApprovalActions()) {
    for (const row of await getPendingApprovalsByAction(action)) {
      if (row.status === 'pending' && row.expires_at && row.expires_at <= now) {
        await expireApproval(row.approval_id, now);
      }
    }
  }
}
