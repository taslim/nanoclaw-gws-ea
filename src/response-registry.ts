/**
 * Response handler registry.
 *
 * Extracted from index.ts so that modules calling `registerResponseHandler()`
 * at import time don't hit a TDZ error on the const-array declaration.
 * index.ts imports src/modules/index.js for its side effects, which triggers
 * module registrations that would otherwise happen before index.ts's own
 * const initializers have run.
 *
 * Keep this file's imports minimal: log.js, and request-text.js for how an
 * approver's reason is quoted (its imports reach the DB layer, but nothing
 * that imports this file or registers a response handler). Nothing else
 * from modules/* or index.ts itself. Any file imported here must not in
 * turn import from src/index.ts, or the cycle returns.
 */
import type { NormalizedOption } from './channels/ask-question.js';
import type { ChannelDeliveryAdapter } from './delivery.js';
import { log } from './log.js';
import { quoted, REASON_LIMIT } from './modules/approvals/request-text.js';

export interface ResponsePayload {
  questionId: string;
  instance?: string;
  messageId?: string;
  value: string;
  /** The reason given with a rejection (ActionAnswer.reason). */
  reason?: string;
  userId: string | null;
  channelType: string;
  platformId: string;
  threadId: string | null;
  /**
   * The channel left the request as posted (ActionAnswer.deferResolution):
   * the handler that resolves this answer shows its outcome
   * (showRequestOutcome) once it has authorized it.
   */
  deferResolution?: boolean;
}

export type ResponseHandler = (payload: ResponsePayload) => Promise<boolean>;

const responseHandlers: ResponseHandler[] = [];

export function registerResponseHandler(handler: ResponseHandler, options: { prepend?: boolean } = {}): void {
  if (options.prepend) responseHandlers.unshift(handler);
  else responseHandlers.push(handler);
}

export function getResponseHandlers(): readonly ResponseHandler[] {
  return responseHandlers;
}

export interface AnsweredRequest {
  readonly title: string;
  readonly question: string;
  readonly options: readonly NormalizedOption[];
}

/**
 * When the channel left the request as posted (ResponsePayload.deferResolution),
 * edit it in place to what was asked and the option chosen, with a rejection's
 * reason quoted as someone else's text. Call only once the answer is
 * authorized and the request resolved; a refused answer leaves the request as
 * posted. A failed edit is logged, and the resolution stands.
 */
export async function showRequestOutcome(
  adapter: ChannelDeliveryAdapter | null,
  payload: ResponsePayload,
  request: AnsweredRequest,
  reason?: string,
): Promise<void> {
  if (payload.deferResolution !== true) return;
  if (!adapter || !payload.platformId) {
    log.warn('An answered request has no address to show its outcome at', { questionId: payload.questionId });
    return;
  }
  const chosen = request.options.find((option) => option.value === payload.value)?.selectedLabel ?? payload.value;
  const resolution = reason ? `${chosen}: ${quoted(reason, REASON_LIMIT)}` : chosen;
  try {
    await adapter.deliver(
      payload.channelType,
      payload.platformId,
      payload.threadId,
      'chat-sdk',
      JSON.stringify({
        operation: 'edit',
        questionId: payload.questionId,
        messageId: payload.messageId,
        text: [request.title, request.question, resolution].filter(Boolean).join('\n\n'),
        terminalCard: { title: request.title, question: request.question, resolution },
      }),
      undefined,
      payload.instance,
    );
    // eslint-disable-next-line no-catch-all/no-catch-all -- the resolution stands whether or not its edit lands
  } catch (err) {
    log.error("Failed to show an answered request's outcome", { questionId: payload.questionId, err });
  }
}
