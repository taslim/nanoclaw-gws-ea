/**
 * Interactive module — generic ask_user_question flow.
 *
 * Container-side `ask_user_question` writes a chat-sdk card to outbound.db +
 * polls inbound.db for a `question_response` system message. On the host side
 * this module handles the answer (a button click, or an answer in words on a
 * channel whose requests are text): look up the pending_questions row, write
 * the response into the session's inbound.db, show the choice on the question
 * when the channel left it as posted, wake the container.
 *
 * The `createPendingQuestion` call in `deliverMessage` (delivery.ts) stays
 * inline in core — it's 15 lines guarded by `hasTable('pending_questions')`,
 * modularizing it adds more registry surface than it saves.
 */
import { getDb, hasTable } from '../../db/connection.js';
import { deletePendingQuestion, getPendingQuestion, getSession } from '../../db/sessions.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { requestWake } from '../../request-wake.js';
import { registerResponseHandler, showRequestOutcome, type ResponsePayload } from '../../response-registry.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';

async function handleInteractiveResponse(payload: ResponsePayload): Promise<boolean> {
  if (!(await hasTable(getDb(), 'pending_questions'))) return false;

  const pq = await getPendingQuestion(payload.questionId);
  if (!pq) return false;

  const session = await getSession(pq.session_id);
  if (!session) {
    log.warn('Session not found for pending question', { questionId: payload.questionId, sessionId: pq.session_id });
    await deletePendingQuestion(payload.questionId);
    return true; // claimed — we owned this questionId even though the session is gone
  }

  await writeSessionMessage(session.agent_group_id, session.id, {
    id: `qr-${payload.questionId}-${Date.now()}`,
    kind: 'system',
    timestamp: new Date().toISOString(),
    platformId: pq.platform_id,
    channelType: pq.channel_type,
    threadId: pq.thread_id,
    content: JSON.stringify({
      type: 'question_response',
      questionId: payload.questionId,
      selectedOption: payload.value,
      userId: payload.userId ?? '',
    }),
  });

  await deletePendingQuestion(payload.questionId);
  await showRequestOutcome(getDeliveryAdapter(), payload, pq);
  log.info('Question response routed', {
    questionId: payload.questionId,
    selectedOption: payload.value,
    sessionId: session.id,
  });

  await requestWake(session, 'interactive');
  return true;
}

registerResponseHandler(handleInteractiveResponse);
