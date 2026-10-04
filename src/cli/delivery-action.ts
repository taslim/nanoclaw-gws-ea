/**
 * Delivery action handler for CLI requests from container agents, and the
 * typed `action_response` every request-and-answer delivery action uses.
 *
 * When an agent writes a `cli_request` system message to its outbound mailbox,
 * the delivery poll picks it up and calls this handler. We dispatch
 * the command and write the response back to its inbound mailbox.
 *
 * Any other delivery action that answers its calling tool does the same
 * through `writeActionResponse`: one `action_response` per request, keyed on
 * the request id the runner set (the id of the outbound message that carried
 * it), which the runner's tool polls for.
 */
import { isUniqueViolation } from '../db/errors.js';
import { registerDeliveryAction } from '../delivery.js';
import { unguarded } from '../guard/index.js';
import { log } from '../log.js';
import { writeSessionMessage } from '../session-manager.js';
import type { Session } from '../types.js';
import { dispatch } from './dispatch.js';
import type { RequestFrame, ResponseFrame } from './frame.js';

/**
 * Answer a request in the calling session's inbound mailbox, without waking
 * it: the calling tool is polling for this row. A request answered before
 * (a delivery replayed after a host restart) keeps its first answer.
 *
 * Opens its own mailbox session, so it never runs inside one.
 */
export async function writeActionResponse(session: Session, requestId: string, frame: ResponseFrame): Promise<void> {
  try {
    await writeSessionMessage(session.agent_group_id, session.id, {
      id: `action-resp-${requestId}`,
      kind: 'system',
      timestamp: new Date().toISOString(),
      content: JSON.stringify({ type: 'action_response', requestId, frame }),
      trigger: false,
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    log.info('Action already answered; keeping the first answer', { requestId, sessionId: session.id });
  }
}

registerDeliveryAction(
  'cli_request',
  async (content, session) => {
    const requestId = content.requestId as string;
    const command = content.command as string;
    const args = (content.args as Record<string, unknown>) ?? {};

    if (!requestId || !command) {
      log.warn('cli_request missing requestId or command', { sessionId: session.id });
      return;
    }

    const req: RequestFrame = { id: requestId, command, args };
    const ctx = {
      caller: 'agent' as const,
      sessionId: session.id,
      agentGroupId: session.agent_group_id,
      messagingGroupId: session.messaging_group_id ?? '',
    };

    log.info('CLI request from agent', { requestId, command, sessionId: session.id });

    const response = await dispatch(req, ctx);

    // Dispatch above may already have opened (and closed) sessions on this
    // key; nothing here holds one across calls.
    await writeActionResponse(session, requestId, response);

    log.info('CLI response written', { requestId, ok: response.ok, sessionId: session.id });
  },
  unguarded('transport envelope — every inner command is guarded at dispatch'),
);
