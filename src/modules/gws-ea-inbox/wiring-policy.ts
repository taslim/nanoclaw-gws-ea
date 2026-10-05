/**
 * The email channel's two messaging groups and their wirings (KTD1).
 *
 * - The inbox (`email:inbox`): every thread anyone but the principal can
 *   read, mentions off and unknown senders admitted, each thread its own
 *   `external-email` session.
 * - The principal's own email conversation (`email:principal`): what only
 *   the principal and the assistant can read, in `main`'s one shared
 *   session, admitting only known senders: the principal's verified email
 *   identities, which `main`'s members follow (gws-ea-profile).
 *
 * The host creates each group and its wiring when absent, recording the
 * group's id before the wiring so the policies govern it. A wiring admission
 * policy pins both shapes, by the stored ids, on every path that writes a
 * wiring, so drift is refused where it would happen: the inbox is wired only
 * to `external-email` and `external-email` only to the inbox; the principal's
 * conversation only to `main`.
 */
import { randomUUID } from 'node:crypto';

import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroup,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
} from '../../db/messaging-groups.js';
import { registerWiringAdmissionPolicy } from '../../db/wiring-admission.js';
import type { MessagingGroup, MessagingGroupAgent } from '../../types.js';
import { getExternalEmailAgentGroupId } from '../gws-ea-external-email/index.js';
import { getMainAgentGroupId } from '../gws-ea-profile/db.js';
import { emailMessagingGroupIds, getInboxState, updateInboxState, type InboxState } from './db.js';
import { EMAIL_CHANNEL_TYPE, INBOX_PLATFORM_ID, PRINCIPAL_PLATFORM_ID } from './runtime.js';

/** The inbox's pinned wiring, as every check and the host's own creation read it. */
const INBOX_WIRING = {
  engage_mode: 'pattern',
  engage_pattern: '.',
  sender_scope: 'all',
  ignored_message_policy: 'drop',
  session_mode: 'per-thread',
  threads: 1,
} as const satisfies Partial<MessagingGroupAgent>;

/** The principal's conversation's pinned wiring: `main`'s shared session, known senders only, each row keeping its thread. */
const PRINCIPAL_WIRING = {
  engage_mode: 'pattern',
  engage_pattern: '.',
  sender_scope: 'known',
  ignored_message_policy: 'drop',
  session_mode: 'agent-shared',
  threads: 1,
} as const satisfies Partial<MessagingGroupAgent>;

/** The inbox's messaging group, or null until the host creates it. */
export async function getInboxMessagingGroupId(): Promise<string | null> {
  return (await emailMessagingGroupIds()).inbox;
}

/** One of the channel's groups as the host creates it, and the state column that stores its id. */
interface EmailGroup {
  /** Names its rows' ids. */
  readonly name: string;
  readonly column: keyof Pick<InboxState, 'messaging_group_id' | 'principal_messaging_group_id'>;
  readonly group: Omit<MessagingGroup, 'id' | 'created_at'>;
}

/**
 * Create the group when absent and record its id, then its wiring to
 * `agentGroupId`. Returns the group's id.
 */
async function ensureEmailGroup(
  email: EmailGroup,
  agentGroupId: string,
  wiring: Omit<MessagingGroupAgent, 'id' | 'messaging_group_id' | 'agent_group_id' | 'priority' | 'created_at'>,
): Promise<string> {
  const now = new Date().toISOString();
  let id = (await getInboxState())[email.column];
  if (id === null || (await getMessagingGroup(id)) === undefined) {
    const existing = await getMessagingGroupByPlatform(EMAIL_CHANNEL_TYPE, email.group.platform_id, EMAIL_CHANNEL_TYPE);
    id = existing?.id ?? `mg-${email.name}-${randomUUID()}`;
    if (!existing) await createMessagingGroup({ id, ...email.group, created_at: now });
    // Recorded before the wiring, so the admission policy below governs it.
    await updateInboxState({ [email.column]: id });
  }
  if ((await getMessagingGroupAgentByPair(id, agentGroupId)) === undefined) {
    await createMessagingGroupAgent({
      id: `mga-${email.name}-${randomUUID()}`,
      messaging_group_id: id,
      agent_group_id: agentGroupId,
      ...wiring,
      priority: 0,
      created_at: now,
    });
  }
  return id;
}

/**
 * Create the inbox's messaging group and its wiring to `external-email` when
 * either is absent. Run at host start, after `external-email` exists.
 */
export async function ensureInbox(externalEmailAgentGroupId: string): Promise<string> {
  return ensureEmailGroup(
    {
      name: 'inbox',
      column: 'messaging_group_id',
      group: {
        channel_type: EMAIL_CHANNEL_TYPE,
        platform_id: INBOX_PLATFORM_ID,
        instance: EMAIL_CHANNEL_TYPE,
        name: 'inbox',
        is_group: 1,
        unknown_sender_policy: 'public',
      },
    },
    externalEmailAgentGroupId,
    INBOX_WIRING,
  );
}

/**
 * Create the principal's own email conversation and its wiring to `main`
 * when either is absent. Run at host start, once `main` exists.
 */
export async function ensurePrincipalConversation(mainAgentGroupId: string): Promise<string> {
  return ensureEmailGroup(
    {
      name: 'principal-email',
      column: 'principal_messaging_group_id',
      group: {
        channel_type: EMAIL_CHANNEL_TYPE,
        platform_id: PRINCIPAL_PLATFORM_ID,
        instance: EMAIL_CHANNEL_TYPE,
        name: 'principal email',
        is_group: 0,
        unknown_sender_policy: 'strict',
      },
    },
    mainAgentGroupId,
    PRINCIPAL_WIRING,
  );
}

function pinned(proposed: MessagingGroupAgent, wiring: Partial<MessagingGroupAgent>): string | undefined {
  for (const [column, value] of Object.entries(wiring) as [keyof MessagingGroupAgent, unknown][]) {
    if (proposed[column] !== value) return `${column} must be ${JSON.stringify(value)}`;
  }
  return undefined;
}

registerWiringAdmissionPolicy('gws-ea-inbox:inbox-wiring', async ({ proposed }) => {
  const { inbox, principal } = await emailMessagingGroupIds();
  const externalEmail = await getExternalEmailAgentGroupId();
  const toInbox = inbox !== null && proposed.messaging_group_id === inbox;
  const toPrincipal = principal !== null && proposed.messaging_group_id === principal;
  const fromExternalEmail = externalEmail !== null && proposed.agent_group_id === externalEmail;

  const reject = (reason: string): never => {
    throw new Error(`Inbox wiring rejected: ${reason}`);
  };
  if (toPrincipal) {
    if (proposed.agent_group_id !== (await getMainAgentGroupId())) {
      reject("the principal's email conversation is wired only to main");
    }
    const drift = pinned(proposed, PRINCIPAL_WIRING);
    if (drift !== undefined) reject(drift);
    return;
  }
  if (!toInbox && !fromExternalEmail) return;
  if (!toInbox) reject('external-email is wired only to the inbox');
  if (!fromExternalEmail) reject('the inbox is wired only to external-email');
  const drift = pinned(proposed, INBOX_WIRING);
  if (drift !== undefined) reject(drift);
});
