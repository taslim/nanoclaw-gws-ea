/**
 * Principal provenance (KTD8): a write that claims the principal's word
 * (`--source principal`) counts only when the turn the agent is answering
 * holds a message from the principal.
 *
 * At every turn start the runner republishes its reply stamp, which names
 * every message in the batch the turn answers
 * (container/agent-runner/src/db/session-state.ts). The host reads that stamp
 * from the caller's session mailbox and looks each message up. A message is
 * the principal's when it is
 *   - a chat message on a conversation wired to main whose sender is a
 *     verified principal user. Host notes, `tell_main` and calendar
 *     notifications among them, are sent by `system` and never qualify; or
 *   - a message on the principal's own email conversation (`email:principal`),
 *     which only Gmail-verified mail from the principal reaches.
 * A reminder is a task, not a chat message, and another agent's message is
 * not on a conversation wired to main, so neither ever qualifies.
 *
 * Boundary (a named residual): this stops principal writes in turns the
 * principal did not start. Instructions inside or beside the principal's own
 * message (forwarded or quoted mail, other messages in the same batch, tool
 * output read during the turn) stay with main's guidance that only the
 * principal instructs it.
 */
import type { CallerContext } from '../../cli/frame.js';
import { getMessagingGroupsByAgentGroup } from '../../db/messaging-groups.js';
import type { InboundOrigin } from '../../mailbox/types.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import type { MessagingGroup } from '../../types.js';
// The inbox's store alone: its module entry points load external-email, whose
// registrations must follow this module's.
import { emailMessagingGroupIds } from '../gws-ea-inbox/db.js';
import { getMainAgentGroupId, isVerifiedPrincipalUser } from './db.js';

/** Why a principal-sourced write was refused: the reply to asking is itself a turn the principal started. */
const NOT_THE_PRINCIPALS_TURN =
  'This turn is not answering a message from the principal, so it cannot record their word. Ask the principal, and record it once they reply.';

const CHAT_KINDS: ReadonlySet<string> = new Set(['chat', 'chat-sdk']);

type AgentCaller = Extract<CallerContext, { caller: 'agent' }>;

/** The messages the caller's current turn answers, as its runner stamped them. */
async function turnMessages(caller: AgentCaller): Promise<readonly InboundOrigin[]> {
  const messages = await withExistingMailboxSession(caller.agentGroupId, caller.sessionId, (mailbox) =>
    (mailbox.getTurnStamp()?.messageIds ?? []).flatMap((id) => mailbox.getInboundOrigin(id) ?? []),
  );
  return messages ?? [];
}

/** The sender's user id, named as the router names users: a handle without a channel takes the message's own. */
function senderUserId(message: InboundOrigin): string | undefined {
  let content: unknown;
  try {
    content = JSON.parse(message.content);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  const senderId: unknown =
    typeof content === 'object' && content !== null ? (content as { senderId?: unknown }).senderId : undefined;
  if (typeof senderId !== 'string' || senderId === '') return undefined;
  return senderId.includes(':') ? senderId : `${message.channelType ?? ''}:${senderId}`;
}

async function isPrincipalMessage(
  message: InboundOrigin,
  mainConversations: readonly MessagingGroup[],
  principalEmail: string | null,
): Promise<boolean> {
  if (!CHAT_KINDS.has(message.kind)) return false;
  const conversations = mainConversations.filter(
    (group) => group.channel_type === message.channelType && group.platform_id === message.platformId,
  );
  if (conversations.some((group) => group.id === principalEmail)) return true;
  if (conversations.length === 0) return false;
  const sender = senderUserId(message);
  return sender !== undefined && (await isVerifiedPrincipalUser(sender));
}

/** Whether the turn `caller` is answering holds a message from the principal. */
async function turnHasPrincipalMessage(caller: AgentCaller): Promise<boolean> {
  const mainAgentGroupId = await getMainAgentGroupId();
  if (mainAgentGroupId === null) return false;
  const messages = await turnMessages(caller);
  if (messages.length === 0) return false;
  const mainConversations = await getMessagingGroupsByAgentGroup(mainAgentGroupId);
  const principalEmail = (await emailMessagingGroupIds()).principal;
  for (const message of messages) {
    if (await isPrincipalMessage(message, mainConversations, principalEmail)) return true;
  }
  return false;
}

/**
 * Refuse a write an agent makes as the principal's (`source` is `principal`)
 * unless its turn answers the principal. The operator, as the host caller,
 * and learned writes pass.
 */
export async function assertPrincipalProvenance(ctx: CallerContext, source: unknown): Promise<void> {
  if (ctx.caller === 'host' || source !== 'principal') return;
  if (!(await turnHasPrincipalMessage(ctx))) throw new Error(NOT_THE_PRINCIPALS_TURN);
}
