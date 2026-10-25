/** Principal binding shared by the channels that verify a principal. It imports no module entry point. */
import { randomUUID } from 'node:crypto';

import { getDb } from '../../db/connection.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroup,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
  deleteMessagingGroupAgent,
  setMessagingGroupDetachedAt,
} from '../../db/messaging-groups.js';
import { getSessionsByAgentGroup } from '../../db/sessions.js';
import { deleteDestination, getDestinationByTarget } from '../agent-to-agent/db/agent-destinations.js';
import { writeDestinations } from '../agent-to-agent/write-destinations.js';
import { addMember, removeMember } from '../permissions/db/agent-group-members.js';
import { grantRole, isOwner, revokeRole } from '../permissions/db/user-roles.js';
import { upsertUser } from '../permissions/db/users.js';
import { rememberAuthenticatedUserDm } from '../permissions/user-dm.js';
import type { WhatsAppPerson } from '../gws-ea-whatsapp/paths.js';
import { bindVerifiedPrincipalUser, getGwsEaProfile, getMainAgentGroupId } from './db.js';

async function refreshMainDestinations(main: string): Promise<void> {
  if (!(await getDb().hasTable('agent_destinations'))) return;
  for (const session of await getSessionsByAgentGroup(main))
    if (session.status === 'active') await writeDestinations(main, session.id);
}

export async function bindPrincipalIdentity(input: {
  readonly userId: string;
  readonly messagingGroupId: string;
  readonly verifiedAt: string;
}): Promise<void> {
  const dm = await getMessagingGroup(input.messagingGroupId);
  if (!dm) throw new Error(`Principal direct message not found: ${input.messagingGroupId}`);
  await getDb().transaction(async () => {
    await bindVerifiedPrincipalUser(input.userId, input.verifiedAt);
    await rememberAuthenticatedUserDm(input.userId, dm, input.verifiedAt);
  });
}

/** Call only after the principal's authenticated phone-and-code proof. Never opens or sends a DM. */
export async function bindWhatsAppPrincipal(
  person: WhatsAppPerson,
  verifiedAt: string,
): Promise<{ readonly userId: string; readonly messagingGroupId: string }> {
  if (!/^\d+$/u.test(person.lid) || !/^\d{7,15}@s\.whatsapp\.net$/u.test(person.phoneJid ?? ''))
    throw new Error('WhatsApp binding needs the authenticated LID and phone number');
  const profile = await getGwsEaProfile();
  const main = profile.main_agent_group_id;
  if (!main) throw new Error('Canonical main is not ready');
  const userId = `whatsapp:${person.lid}`;
  const platformId = `${person.lid}@lid`;
  const result = await getDb().transaction(async () => {
    let dm = await getMessagingGroupByPlatform('whatsapp', platformId, 'whatsapp');
    if (!dm) {
      const id = randomUUID();
      await createMessagingGroup({
        id,
        channel_type: 'whatsapp',
        instance: 'whatsapp',
        platform_id: platformId,
        name: null,
        is_group: 0,
        unknown_sender_policy: 'strict',
        created_at: verifiedAt,
      });
      dm = await getMessagingGroup(id);
    }
    if (!dm) throw new Error('Principal WhatsApp direct conversation is unavailable');
    await setMessagingGroupDetachedAt(dm.id, null);
    await upsertUser({
      id: userId,
      kind: 'whatsapp',
      display_name: profile.principal_display_name,
      created_at: verifiedAt,
    });
    await bindPrincipalIdentity({ userId, messagingGroupId: dm.id, verifiedAt });
    if (!(await isOwner(userId)))
      await grantRole({
        user_id: userId,
        role: 'owner',
        agent_group_id: null,
        granted_by: null,
        granted_at: verifiedAt,
      });
    await addMember({ user_id: userId, agent_group_id: main, added_by: null, added_at: verifiedAt });
    if (!(await getMessagingGroupAgentByPair(dm.id, main)))
      await createMessagingGroupAgent({
        id: randomUUID(),
        messaging_group_id: dm.id,
        agent_group_id: main,
        engage_mode: 'pattern',
        engage_pattern: '.',
        sender_scope: 'known',
        ignored_message_policy: 'drop',
        session_mode: 'agent-shared',
        priority: 0,
        created_at: verifiedAt,
      });
    return { userId, messagingGroupId: dm.id };
  });
  await refreshMainDestinations(main);
  return result;
}

/** Unlink withdraws this identity's privilege and canonical wiring, keeping ordinary conversation history. */
export async function removeWhatsAppPrincipalBinding(lid: string): Promise<void> {
  if (!/^\d+$/u.test(lid)) throw new Error('Invalid WhatsApp LID');
  const db = getDb();
  const userId = `whatsapp:${lid}`;
  const main = await getMainAgentGroupId();
  await db.transaction(async () => {
    const dm = await getMessagingGroupByPlatform('whatsapp', `${lid}@lid`, 'whatsapp');
    if (dm) await setMessagingGroupDetachedAt(dm.id, new Date().toISOString());
    if (main) {
      if (dm) {
        const wiring = await getMessagingGroupAgentByPair(dm.id, main);
        if (wiring) await deleteMessagingGroupAgent(wiring.id);
        if (await db.hasTable('agent_destinations')) {
          const destination = await getDestinationByTarget(main, 'channel', dm.id);
          if (destination) await deleteDestination(main, destination.local_name);
        }
      }
      await removeMember(userId, main);
    }
    await revokeRole(userId, 'owner', null);
    await db.run('DELETE FROM gws_ea_principal_users WHERE user_id = ?', userId);
    await db.run('DELETE FROM user_dms WHERE user_id = ? AND channel_type = ?', userId, 'whatsapp');
    await db.run('DELETE FROM gws_ea_principal_messages WHERE user_id = ?', userId);
  });
  if (main) await refreshMainDestinations(main);
}
