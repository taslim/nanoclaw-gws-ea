import { getDb } from '../../db/index.js';
import { deletePendingApproval, getSession } from '../../db/sessions.js';
import { requestWake } from '../../request-wake.js';
import { log } from '../../log.js';
import { withMailboxSession, writeSessionMessage } from '../../session-manager.js';
import type { PendingApproval } from '../../types.js';
import {
  getApprovalRejectionFinalizer,
  getApprovalRejectionNote,
  getRegisteredApprovalActions,
  notifyApprovalResolved,
  type ApprovalRejectedEvent,
} from './primitive.js';

interface RejectedApproval extends PendingApproval {
  rejection_user_id: string | null;
  rejection_reason: string | null;
  rejected_at: string | null;
}

const finalizing = new Set<string>();

/**
 * Claim the rejection together with its reason. A required module finalizer
 * must settle its state and persist its notification before this row is
 * removed. Failures leave a rejected row for startup and host-sweep replay.
 */
export async function finalizeReject(
  approval: PendingApproval,
  userId: string,
  reason?: string,
  expectedStatus: 'pending' | 'awaiting_reason' = approval.status === 'awaiting_reason' ? 'awaiting_reason' : 'pending',
): Promise<boolean> {
  const claimed = await getDb().run(
    `UPDATE pending_approvals SET status = 'rejected', rejection_user_id = ?, rejection_reason = ?, rejected_at = ?
     WHERE approval_id = ? AND status = ?`,
    userId,
    reason ?? null,
    new Date().toISOString(),
    approval.approval_id,
    expectedStatus,
  );
  if (claimed.changes === 0) return false;

  log.info('Approval rejected', {
    approvalId: approval.approval_id,
    action: approval.action,
    userId,
    withReason: reason !== undefined,
  });
  await finishRejection(approval.approval_id);
  return true;
}

/** Replay registered actions only: an absent module must retain its work. */
export async function resumeRejectedApprovals(): Promise<void> {
  for (const action of getRegisteredApprovalActions()) {
    const rows = await getDb().all<{ approval_id: string }>(
      "SELECT approval_id FROM pending_approvals WHERE action = ? AND status = 'rejected'",
      action,
    );
    for (const row of rows) await finishRejection(row.approval_id);
  }
}

async function finishRejection(approvalId: string): Promise<void> {
  if (finalizing.has(approvalId)) return;
  finalizing.add(approvalId);
  try {
    const approval = await getDb().get<RejectedApproval>(
      "SELECT * FROM pending_approvals WHERE approval_id = ? AND status = 'rejected'",
      approvalId,
    );
    if (!approval) return;
    const session = approval.session_id ? await getSession(approval.session_id) : undefined;
    if (!session) {
      await deletePendingApproval(approvalId);
      return;
    }
    const reason = approval.rejection_reason ?? undefined;
    const event: ApprovalRejectedEvent = {
      approval,
      session,
      outcome: 'reject',
      userId: approval.rejection_user_id ?? '',
      reason,
    };
    await getApprovalRejectionFinalizer(approval.action)?.(event);

    const rejectionNote = getApprovalRejectionNote(approval.action);
    const text = rejectionNote
      ? await rejectionNote(approval, reason)
      : reason
        ? `Your ${approval.action} request was rejected by admin: "${reason}"`
        : `Your ${approval.action} request was rejected by admin.`;
    if (text !== null) {
      const noteId = `appr-reject-${approval.approval_id}`;
      const written = await withMailboxSession(session.agent_group_id, session.id, (mailbox) =>
        mailbox.hasMessage(noteId),
      );
      if (!written)
        await writeSessionMessage(session.agent_group_id, session.id, {
          id: noteId,
          kind: 'chat',
          timestamp: approval.rejected_at ?? new Date().toISOString(),
          platformId: session.agent_group_id,
          channelType: 'agent',
          threadId: null,
          content: JSON.stringify({ text, sender: 'system', senderId: 'system' }),
        });
    }

    await notifyApprovalResolved(event);
    await requestWake(session, 'approval-response');
    await deletePendingApproval(approvalId);
    // eslint-disable-next-line no-catch-all/no-catch-all -- a failed settlement remains durable and the next sweep retries it
  } catch (err) {
    log.error('Approval rejection settlement deferred', { approvalId, err });
  } finally {
    finalizing.delete(approvalId);
  }
}
