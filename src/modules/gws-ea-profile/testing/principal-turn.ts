/**
 * main's turns as they reach its session mailbox, for tests of principal
 * provenance (../provenance.ts): the router writes the messages a turn answers
 * into inbound.db, and the runner names them in its reply stamp in outbound.db.
 * A test file using these points DATA_DIR at a scratch directory and loads the
 * profile module, whose policy admits the wiring to main.
 */
import Database from 'better-sqlite3';

import type { CallerContext } from '../../../cli/frame.js';
import { createMessagingGroup, createMessagingGroupAgent } from '../../../db/messaging-groups.js';
import { outboundDbPath } from '../../../mailbox/sqlite/paths.js';
import type { InboundMessage } from '../../../mailbox/types.js';
import { resolveSession, writeSessionMessage } from '../../../session-manager.js';
import type { Session } from '../../../types.js';
import { addMember } from '../../permissions/db/agent-group-members.js';
import { upsertUserDm } from '../../permissions/db/user-dms.js';
import { grantRole } from '../../permissions/db/user-roles.js';
import { upsertUser } from '../../permissions/db/users.js';
import { bindVerifiedPrincipalUser } from '../db.js';

/** The principal's verified chat identity, and the handle their chat messages carry. */
const PRINCIPAL_USER = 'gchat:users/principal';
const PRINCIPAL_HANDLE = 'users/principal';
/** The principal's direct message with the assistant. */
const PRINCIPAL_DM = {
  id: 'mg-principal-dm',
  channelType: 'gchat',
  platformId: 'gchat:spaces/principal',
} as const;

export interface TurnMessage {
  readonly id: string;
  readonly kind: InboundMessage['kind'];
  readonly channelType: string | null;
  readonly platformId: string | null;
  readonly content: Readonly<Record<string, unknown>>;
}

function now(): string {
  return new Date().toISOString();
}

/**
 * The principal's verified chat identity and their direct message, wired to
 * main as canonical-main admission requires, and main's one session there.
 */
export async function principalDmSession(mainAgentGroupId: string): Promise<Session> {
  await createMessagingGroup({
    id: PRINCIPAL_DM.id,
    channel_type: PRINCIPAL_DM.channelType,
    platform_id: PRINCIPAL_DM.platformId,
    name: 'Principal',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
  await upsertUser({ id: PRINCIPAL_USER, kind: 'gchat', display_name: 'Morgan', created_at: now() });
  await bindVerifiedPrincipalUser(PRINCIPAL_USER, now());
  await upsertUserDm({
    user_id: PRINCIPAL_USER,
    channel_type: PRINCIPAL_DM.channelType,
    messaging_group_id: PRINCIPAL_DM.id,
    resolved_at: now(),
  });
  await grantRole({
    user_id: PRINCIPAL_USER,
    role: 'owner',
    agent_group_id: null,
    granted_by: null,
    granted_at: now(),
  });
  await addMember({ user_id: PRINCIPAL_USER, agent_group_id: mainAgentGroupId, added_by: null, added_at: now() });
  await createMessagingGroupAgent({
    id: 'mga-principal-dm',
    messaging_group_id: PRINCIPAL_DM.id,
    agent_group_id: mainAgentGroupId,
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'known',
    ignored_message_policy: 'drop',
    session_mode: 'agent-shared',
    priority: 0,
    created_at: now(),
  });
  return (await resolveSession(mainAgentGroupId, PRINCIPAL_DM.id, null, 'agent-shared')).session;
}

/** A message the principal wrote in their direct message, as the Chat SDK bridge stores it. */
export function fromPrincipal(id: string, text = 'From the principal.'): TurnMessage {
  return {
    id,
    kind: 'chat-sdk',
    channelType: PRINCIPAL_DM.channelType,
    platformId: PRINCIPAL_DM.platformId,
    content: { text, senderId: PRINCIPAL_HANDLE, sender: 'Morgan', author: { userId: PRINCIPAL_HANDLE } },
  };
}

/** A reminder main set itself: a task, with no route and no sender. */
export function reminder(id: string): TurnMessage {
  return { id, kind: 'task', channelType: null, platformId: null, content: { prompt: 'Follow up.' } };
}

/** Write a message into the session's inbound mailbox, as the router does. */
export async function deliver(session: Session, message: TurnMessage): Promise<void> {
  await writeSessionMessage(session.agent_group_id, session.id, {
    id: message.id,
    kind: message.kind,
    timestamp: now(),
    platformId: message.platformId,
    channelType: message.channelType,
    threadId: null,
    content: JSON.stringify(message.content),
  });
}

/** Publish the reply stamp of the turn that answers `messageIds`, as the runner does at each turn start. */
export function stampTurn(session: Session, messageIds: readonly string[]): void {
  const db = new Database(outboundDbPath(session.agent_group_id, session.id));
  try {
    db.prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)').run(
      'current_reply_route',
      JSON.stringify({ inReplyTo: messageIds[0], channelType: null, platformId: null, threadId: null, messageIds }),
      now(),
    );
  } finally {
    db.close();
  }
}

/** The caller context of an `ncl` call from the session's container. */
export function callerIn(session: Session): CallerContext {
  return {
    caller: 'agent',
    sessionId: session.id,
    agentGroupId: session.agent_group_id,
    messagingGroupId: session.messaging_group_id ?? '',
  };
}

/** Deliver `messages` and start the turn that answers them; main's `ncl` calls then run in that turn. */
export async function answering(session: Session, ...messages: TurnMessage[]): Promise<CallerContext> {
  for (const message of messages) await deliver(session, message);
  stampTurn(
    session,
    messages.map((message) => message.id),
  );
  return callerIn(session);
}
