/**
 * Asks the principal to confirm a change an agent asked for, as the
 * assistant, in the first person, never as the agent group that asked.
 */
import type { CallerContext } from '../../cli/frame.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getSession } from '../../db/sessions.js';
import type { GuardActor } from '../../guard/index.js';
import { requestApproval } from '../approvals/index.js';
import type { RequestDetails } from '../approvals/request-context.js';

export interface PrincipalConfirmation {
  /** The `pending_approvals.action` the request resolves through. */
  readonly action: string;
  /** Stored exactly as given, so a grant binds to this one change. */
  readonly payload: Record<string, unknown>;
  readonly title: string;
  /** What the assistant would like to do, worded to follow "I'd like": "to record …". */
  readonly asks: string;
  /** The change as main's note about the request holds it (request-context.ts). */
  readonly details: RequestDetails;
}

export function guardActor(ctx: CallerContext): GuardActor {
  return ctx.caller === 'host'
    ? { kind: 'host' }
    : { kind: 'agent', agentGroupId: ctx.agentGroupId, sessionId: ctx.sessionId };
}

/** Ask the principal to confirm an agent's change that the guard held for `approverUserId`. */
export async function requestPrincipalConfirmation(
  ctx: CallerContext,
  approverUserId: string | undefined,
  card: PrincipalConfirmation,
): Promise<void> {
  if (ctx.caller !== 'agent' || approverUserId === undefined) {
    throw new Error("Only an agent's change is held for the principal to confirm");
  }
  const session = await getSession(ctx.sessionId);
  if (!session) throw new Error('Session not found');
  await requestApproval({
    session,
    agentName: (await getAgentGroup(ctx.agentGroupId))?.name ?? ctx.agentGroupId,
    action: card.action,
    payload: card.payload,
    title: card.title,
    question: `I'd like ${card.asks}`,
    details: card.details,
    approverUserId,
  });
}
