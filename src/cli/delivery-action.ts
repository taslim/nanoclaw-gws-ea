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
 * it), which the runner's tool polls for. `answeringAction` and
 * `answeredGuard` make such an action of a function that returns its answer
 * or throws: the host's twin of the runner's `requestTool`.
 */
import { isUniqueViolation } from '../db/errors.js';
import type { DeliveryGuardSpec, GuardedDeliveryHandler } from '../delivery-guard.js';
import { registerDeliveryAction } from '../delivery.js';
import { unguarded, type GuardedAction } from '../guard/index.js';
import { log } from '../log.js';
import { clearOutbox, withExistingMailboxSession, writeSessionMessage } from '../session-manager.js';
import type { Session } from '../types.js';
import { dispatch } from './dispatch.js';
import type { ErrorCode, RequestFrame, ResponseFrame } from './frame.js';

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
      id: answerId(requestId),
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

/** The id of a request's answer in the calling session's inbound mailbox. */
function answerId(requestId: string): string {
  return `action-resp-${requestId}`;
}

/** A request refused as asked: the agent reads why and can ask differently. */
export class ActionRefusal extends Error {
  constructor(
    readonly code: Extract<ErrorCode, 'invalid-args' | 'forbidden'>,
    message: string,
  ) {
    super(message);
    this.name = 'ActionRefusal';
  }
}

/** A refusal of a request whose fields are not as the action takes them. */
export function invalidArgs(message: string): ActionRefusal {
  return new ActionRefusal('invalid-args', message);
}

/** A refusal of a request the action will not do as asked. */
export function forbidden(message: string): ActionRefusal {
  return new ActionRefusal('forbidden', message);
}

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/u;

/** The request id the runner set: the id of the outbound message that carried the request. */
export function requestIdOf(content: Record<string, unknown>): string | undefined {
  const id = content.requestId;
  return typeof id === 'string' && REQUEST_ID.test(id) ? id : undefined;
}

/** What an answering action does with a request: the answer's data, or an `ActionRefusal` or failure thrown. */
export type ActionAnswer = (
  content: Record<string, unknown>,
  session: Session,
  requestId: string,
) => Promise<Record<string, unknown>>;

function errorFrame(requestId: string, error: unknown): ResponseFrame {
  if (error instanceof ActionRefusal) {
    return { id: requestId, ok: false, error: { code: error.code, message: error.message } };
  }
  const reason = error instanceof Error ? error.message : String(error);
  return { id: requestId, ok: false, error: { code: 'handler-error', message: `The host could not do it: ${reason}` } };
}

/**
 * Answer a request, then let go of the files it staged in its outbox: until
 * then a replay finds them where the first run did.
 */
async function writeAnswer(session: Session, requestId: string, frame: ResponseFrame): Promise<void> {
  await writeActionResponse(session, requestId, frame);
  clearOutbox(session.agent_group_id, session.id, requestId);
}

/**
 * A delivery action that answers each request once, a refusal or failure
 * included. A request already answered is a replay of work already done,
 * whatever its answer, so it is not done again. A request without a request
 * id has no tool waiting on it, so nothing answers it.
 */
export function answeringAction(action: string, answer: ActionAnswer): GuardedDeliveryHandler {
  return async (content, session) => {
    const requestId = requestIdOf(content);
    if (requestId === undefined) {
      log.warn('Action request without a request id: nothing to answer', { action, sessionId: session.id });
      return;
    }
    const answered = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
      mailbox.hasMessage(answerId(requestId)),
    );
    if (answered === true) {
      log.info('Action request already answered; not done again', { action, requestId, sessionId: session.id });
      clearOutbox(session.agent_group_id, session.id, requestId);
      return;
    }
    let frame: ResponseFrame;
    /* eslint-disable no-catch-all/no-catch-all -- every request is answered, a failure included; nothing is rethrown into a retry */
    try {
      frame = { id: requestId, ok: true, data: await answer(content, session, requestId) };
    } catch (error) {
      if (error instanceof ActionRefusal) {
        log.info('Action request refused', { action, requestId, sessionId: session.id, reason: error.message });
      } else {
        log.error('Action request failed', { action, requestId, sessionId: session.id, err: error });
      }
      frame = errorFrame(requestId, error);
    }
    /* eslint-enable no-catch-all/no-catch-all */
    await writeAnswer(session, requestId, frame);
  };
}

async function refuse(content: Record<string, unknown>, session: Session, message: string): Promise<void> {
  const requestId = requestIdOf(content) ?? '';
  await writeAnswer(session, requestId, { id: requestId, ok: false, error: { code: 'forbidden', message } });
}

/**
 * The guard of an answering action: a denial is answered as a refusal, so
 * the calling tool never waits it out. Such an action never waits for an
 * approval, so a hold is refused too.
 */
export function answeredGuard(guardAction: GuardedAction): DeliveryGuardSpec {
  return {
    guardAction,
    precheck: (content, session) => {
      if (requestIdOf(content) !== undefined) return true;
      log.warn('Action request without a request id: nothing to answer', {
        guard: guardAction.action,
        sessionId: session.id,
      });
      return false;
    },
    requestHold: (content, session) => refuse(content, session, 'This request cannot wait for an approval.'),
    onDeny: (content, session, reason) => refuse(content, session, reason),
  };
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
