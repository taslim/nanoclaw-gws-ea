/**
 * The inbox's one messaging group and its one wiring (KTD3, KTD4).
 *
 * The host creates both when absent: the messaging group is an `email`
 * group with mentions off and unknown senders admitted, and the wiring sends
 * every thread to its own `external-email` session. A wiring admission
 * policy pins that shape on every path that writes a wiring, so drift is
 * refused where it would happen: the inbox is wired only to `external-email`,
 * `external-email` only to the inbox, and only in the pinned shape.
 */
import { randomUUID } from 'node:crypto';

import { getDb } from '../../db/connection.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroup,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
} from '../../db/messaging-groups.js';
import { registerWiringAdmissionPolicy } from '../../db/wiring-admission.js';
import type { MessagingGroupAgent } from '../../types.js';
import { getExternalEmailAgentGroupId } from '../gws-ea-external-email/index.js';
import { getInboxState, updateInboxState } from './db.js';
import { EMAIL_CHANNEL_TYPE, INBOX_PLATFORM_ID } from './runtime.js';

/** The pinned wiring, as every check and the host's own creation read it. */
const INBOX_WIRING = {
  engage_mode: 'pattern',
  engage_pattern: '.',
  sender_scope: 'all',
  ignored_message_policy: 'drop',
  session_mode: 'per-thread',
  threads: 1,
} as const satisfies Partial<MessagingGroupAgent>;

/** The inbox's messaging group, or null until the host creates it. */
export async function getInboxMessagingGroupId(): Promise<string | null> {
  if (!(await getDb().hasTable('gws_ea_inbox_state'))) return null;
  return (await getInboxState()).messaging_group_id;
}

/**
 * Create the inbox's messaging group and its wiring to `external-email` when
 * either is absent. Run at host start, after `external-email` exists.
 */
export async function ensureInbox(externalEmailAgentGroupId: string): Promise<string> {
  const now = new Date().toISOString();
  let inboxId = await getInboxMessagingGroupId();
  if (inboxId === null || (await getMessagingGroup(inboxId)) === undefined) {
    const existing = await getMessagingGroupByPlatform(EMAIL_CHANNEL_TYPE, INBOX_PLATFORM_ID, EMAIL_CHANNEL_TYPE);
    if (existing) {
      inboxId = existing.id;
    } else {
      inboxId = `mg-inbox-${randomUUID()}`;
      await createMessagingGroup({
        id: inboxId,
        channel_type: EMAIL_CHANNEL_TYPE,
        platform_id: INBOX_PLATFORM_ID,
        instance: EMAIL_CHANNEL_TYPE,
        name: 'inbox',
        is_group: 1,
        unknown_sender_policy: 'public',
        created_at: now,
      });
    }
    // Recorded before the wiring, so the admission policy below governs it.
    await updateInboxState({ messaging_group_id: inboxId });
  }
  if ((await getMessagingGroupAgentByPair(inboxId, externalEmailAgentGroupId)) === undefined) {
    await createMessagingGroupAgent({
      id: `mga-inbox-${randomUUID()}`,
      messaging_group_id: inboxId,
      agent_group_id: externalEmailAgentGroupId,
      ...INBOX_WIRING,
      priority: 0,
      created_at: now,
    });
  }
  return inboxId;
}

registerWiringAdmissionPolicy('gws-ea-inbox:inbox-wiring', async ({ proposed }) => {
  const inboxId = await getInboxMessagingGroupId();
  const externalEmail = await getExternalEmailAgentGroupId();
  const toInbox = inboxId !== null && proposed.messaging_group_id === inboxId;
  const fromExternalEmail = externalEmail !== null && proposed.agent_group_id === externalEmail;
  if (!toInbox && !fromExternalEmail) return;

  const reject = (reason: string): never => {
    throw new Error(`Inbox wiring rejected: ${reason}`);
  };
  if (!toInbox) reject('external-email is wired only to the inbox');
  if (!fromExternalEmail) reject('the inbox is wired only to external-email');
  for (const [column, pinned] of Object.entries(INBOX_WIRING) as [keyof typeof INBOX_WIRING, string | number][]) {
    if (proposed[column] !== pinned) reject(`${column} must be ${JSON.stringify(pinned)}`);
  }
});
