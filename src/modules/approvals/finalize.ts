/**
 * Shared "finalize a rejected approval" path.
 *
 * Three entry points land here so they relay one message and clean up
 * identically:
 *   1. The instant Reject button            (response-handler.ts)
 *   2. A captured Reject-with-reason reply   (reason-capture.ts)
 *   3. The host-sweep ghost finalizer        (reason-capture.ts, via host-sweep)
 *
 * Kept in its own leaf file so both response-handler.ts and reason-capture.ts
 * can import it without an import cycle (finalize → primitive only).
 */
import { requestWake } from '../../request-wake.js';
import { deletePendingApproval, transitionPendingApprovalStatus } from '../../db/sessions.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { PendingApproval, Session } from '../../types.js';
import { getApprovalRejectionNote, notifyApprovalResolved } from './primitive.js';

/**
 * Notify the requesting agent that its action was rejected, drop the pending
 * row, fire approval-resolved callbacks, and wake the container.
 *
 * The note is the action's registered `rejectionNote` when it has one, and
 * none when that returns null: the module's approval-resolved callback tells
 * the agent itself, before the wake below. Otherwise it is the generic note,
 * with `reason` appended under generic attribution — the why, not the who
 * (the rejecting admin may belong to a different owner than the requesting
 * agent). Callers are responsible for clamping the reason length before
 * passing it in.
 */
export async function finalizeReject(
  approval: PendingApproval,
  session: Session,
  userId: string,
  reason?: string,
  expectedStatus: 'pending' | 'awaiting_reason' = approval.status === 'awaiting_reason' ? 'awaiting_reason' : 'pending',
): Promise<boolean> {
  // Worded before the claim, so a note that fails leaves the row open to answer again.
  const rejectionNote = getApprovalRejectionNote(approval.action);
  const text = rejectionNote
    ? await rejectionNote(approval, reason)
    : reason
      ? `Your ${approval.action} request was rejected by admin: "${reason}"`
      : `Your ${approval.action} request was rejected by admin.`;

  if (!(await transitionPendingApprovalStatus(approval.approval_id, expectedStatus, 'rejected'))) return false;

  if (text !== null)
    await writeSessionMessage(session.agent_group_id, session.id, {
      id: `appr-note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: session.agent_group_id,
      channelType: 'agent',
      threadId: null,
      content: JSON.stringify({ text, sender: 'system', senderId: 'system' }),
    });

  log.info('Approval rejected', {
    approvalId: approval.approval_id,
    action: approval.action,
    userId,
    withReason: reason !== undefined,
  });

  await deletePendingApproval(approval.approval_id);
  await notifyApprovalResolved({ approval, session, outcome: 'reject', userId, reason });
  await requestWake(session, 'approval-response');
  return true;
}
