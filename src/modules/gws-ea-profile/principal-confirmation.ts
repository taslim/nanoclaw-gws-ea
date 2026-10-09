/**
 * A card asking the principal to confirm a change an agent asked for. It asks
 * as the assistant, by the name the principal knows it by, never as the agent
 * group that asked. The address card (index.ts) and the private-value card
 * (gws-ea-privacy) both go through here.
 */
import type { CallerContext } from '../../cli/frame.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getSession } from '../../db/sessions.js';
import type { GuardActor } from '../../guard/index.js';
import { requestApproval } from '../approvals/index.js';
import { getGwsEaProfile } from './db.js';

export interface PrincipalConfirmation {
  /** The `pending_approvals.action` the card resolves through. */
  readonly action: string;
  /** Stored exactly as given, so a grant binds to this one change. */
  readonly payload: Record<string, unknown>;
  readonly title: string;
  /** What the assistant asks, worded to follow "<assistant> asks". */
  readonly asks: string;
}

/** The caller as the guard judges it. */
export function guardActor(ctx: CallerContext): GuardActor {
  return ctx.caller === 'host'
    ? { kind: 'host' }
    : { kind: 'agent', agentGroupId: ctx.agentGroupId, sessionId: ctx.sessionId };
}

/** Send the principal the card for an agent's change that the guard held for `approverUserId`. */
export async function requestPrincipalConfirmation(
  ctx: CallerContext,
  approverUserId: string | undefined,
  card: PrincipalConfirmation,
): Promise<void> {
  if (ctx.caller !== 'agent' || approverUserId === undefined) {
    throw new Error("Only an agent's change is held for the principal's card");
  }
  const session = await getSession(ctx.sessionId);
  if (!session) throw new Error('Session not found');
  const assistant = (await getGwsEaProfile()).assistant_display_name ?? 'Your assistant';
  await requestApproval({
    session,
    agentName: (await getAgentGroup(ctx.agentGroupId))?.name ?? ctx.agentGroupId,
    action: card.action,
    payload: card.payload,
    title: card.title,
    question: `${assistant} asks ${card.asks}`,
    approverUserId,
  });
}
