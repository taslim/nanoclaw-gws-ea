import type { ChannelDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import type { PendingApproval } from '../../types.js';
import { recordRequestOutcome } from './request-context.js';

/** Show a terminal request in its original conversation and on its bound card. */
export async function editApprovalCard(
  adapter: ChannelDeliveryAdapter | null,
  row: PendingApproval,
  resolution: string,
  options: { threadId?: string | null; recordOutcome?: boolean } = {},
): Promise<void> {
  if (!adapter || !row.platform_message_id || !row.channel_type || !row.platform_id) return;
  const threadId = options.threadId ?? null;
  if (options.recordOutcome !== false) {
    await recordRequestOutcome(
      { channelType: row.channel_type, platformId: row.platform_id, instance: row.instance, threadId },
      { id: row.approval_id, about: row.action, title: row.title, outcome: resolution },
    );
  }
  try {
    await adapter.deliver(
      row.channel_type,
      row.platform_id,
      threadId,
      'chat-sdk',
      JSON.stringify({
        questionId: row.approval_id,
        operation: 'edit',
        messageId: row.platform_message_id,
        text: [row.title, row.question, resolution].filter(Boolean).join('\n\n'),
        terminalCard: { title: row.title, question: row.question, resolution },
      }),
      undefined,
      row.instance ?? row.channel_type,
    );
    // eslint-disable-next-line no-catch-all/no-catch-all -- the durable resolution stands even if its card cannot be edited
  } catch (err) {
    log.error('Failed to edit terminal approval card', { approvalId: row.approval_id, err });
  }
}
