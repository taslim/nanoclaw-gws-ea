/**
 * A host delivery action as an agent's tool reaches it: one request through native delivery, and the host's one
 * answer, read from the caller's inbound mailbox where the tool waits for it.
 */
import type { ResponseFrame } from '../../../cli/frame.js';
import { getDeliveryAction } from '../../../delivery.js';
import { withExistingMailboxSession } from '../../../session-manager.js';
import type { Session } from '../../../types.js';

let requests = 0;

/** Send `fields` to delivery action `action` from `from`, and read the host's answer. */
export async function deliverAction(
  from: Session,
  action: string,
  fields: Record<string, unknown>,
): Promise<ResponseFrame> {
  const handler = getDeliveryAction(action);
  if (!handler) throw new Error(`No delivery action ${action}`);
  const requestId = `${action}-${++requests}`;
  await handler({ ...fields, action, requestId }, from);
  const row = await withExistingMailboxSession(
    from.agent_group_id,
    from.id,
    (mailbox) => mailbox.getInboundMessages([`action-resp-${requestId}`])[0],
  );
  if (!row) throw new Error(`No host answer to ${action}`);
  return (JSON.parse(row.content) as { frame: ResponseFrame }).frame;
}

/** Why the host refused a request, or undefined when it answered. */
export function refusal(frame: ResponseFrame): string | undefined {
  return frame.ok ? undefined : frame.error.message;
}
