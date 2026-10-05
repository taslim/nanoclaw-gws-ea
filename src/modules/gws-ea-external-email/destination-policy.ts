/**
 * KTD5's destination admission. A destination is an ACL grant: the row lets
 * its owner send free text to its target. `main` and `external-email`
 * exchange work only as typed requests through the host, and each email
 * conversation has one writer (KTD1), pinned by the messaging-group ids the
 * inbox stored:
 *
 *   - no destination joins `main` and `external-email`;
 *   - `external-email` addresses nothing but the inbox it is wired to, and
 *     only it addresses the inbox (`email:inbox`);
 *   - only `main` addresses the principal's email conversation
 *     (`email:principal`), once it is wired to it, and of the email
 *     conversations `main` addresses only that one;
 *   - no agent group addresses `external-email`, or any other email
 *     conversation.
 *
 * The check runs on every destination write (`createDestination`), so it
 * covers `ncl destinations add`, a wiring's companion row, and `create_agent`.
 * Status scans the stored rows with the same check, for any row written
 * before the check existed or behind it.
 */
import { getDb } from '../../db/connection.js';
import { registerDestinationAdmissionPolicy } from '../../db/wiring-admission.js';
import type { AgentDestination } from '../../types.js';
// The inbox's store alone: its module entry points load this module.
import { emailMessagingGroupIds } from '../gws-ea-inbox/db.js';
import { EMAIL_CHANNEL_TYPE } from '../gws-ea-inbox/runtime.js';
import { getExternalEmailAgentGroupId, getMainAgentGroupId } from '../gws-ea-profile/db.js';

/** The channel type of the assistant's email conversations (KTD1). */

const JOINS_THE_AGENTS = 'it joins main and external-email, which exchange work only through the host';

async function isEmail(messagingGroupId: string): Promise<boolean> {
  const row = await getDb().get<{ channel_type: string }>(
    'SELECT channel_type FROM messaging_groups WHERE id = ?',
    messagingGroupId,
  );
  return row?.channel_type === EMAIL_CHANNEL_TYPE;
}

async function isWired(messagingGroupId: string, agentGroupId: string): Promise<boolean> {
  const row = await getDb().get<{ present: number }>(
    'SELECT 1 AS present FROM messaging_group_agents WHERE messaging_group_id = ? AND agent_group_id = ? LIMIT 1',
    messagingGroupId,
    agentGroupId,
  );
  return row !== undefined;
}

/** Why the destination breaks the separation, or undefined when it does not. */
export async function destinationViolation(row: AgentDestination): Promise<string | undefined> {
  if (!(await getDb().hasTable('gws_ea_profile'))) return undefined;
  const [main, externalEmail, email] = await Promise.all([
    getMainAgentGroupId(),
    getExternalEmailAgentGroupId(),
    emailMessagingGroupIds(),
  ]);
  const channel = row.target_type === 'channel' ? row.target_id : undefined;
  const toInbox = channel !== undefined && channel === email.inbox;
  const toPrincipal = channel !== undefined && channel === email.principal;
  if (externalEmail !== null && row.agent_group_id === externalEmail) {
    if (toInbox && (await isWired(channel, externalEmail))) return undefined;
    if (row.target_type === 'agent' && row.target_id === main) return JOINS_THE_AGENTS;
    return 'external-email may address only the inbox it is wired to';
  }
  if (externalEmail !== null && row.target_type === 'agent' && row.target_id === externalEmail) {
    return row.agent_group_id === main
      ? JOINS_THE_AGENTS
      : 'no agent group may address external-email, which takes work only through the host';
  }
  if (toInbox) return 'only external-email may address the inbox';
  if (toPrincipal) {
    if (main !== null && row.agent_group_id === main && (await isWired(channel, main))) return undefined;
    return "only main may address the principal's email conversation, once it is wired to it";
  }
  if (channel !== undefined && (await isEmail(channel))) {
    return "no agent group may address an email conversation but the inbox and the principal's";
  }
  return undefined;
}

registerDestinationAdmissionPolicy('gws-ea-external-email:separation', ({ proposed }) =>
  destinationViolation(proposed),
);

/** Each stored destination that breaks the separation, named by its owner and local name. */
export async function destinationViolations(): Promise<string[]> {
  const db = getDb();
  if (!(await db.hasTable('agent_destinations'))) return [];
  const rows = await db.all<AgentDestination>('SELECT * FROM agent_destinations ORDER BY agent_group_id, local_name');
  const found: string[] = [];
  for (const row of rows) {
    const reason = await destinationViolation(row);
    if (reason !== undefined) found.push(`${row.agent_group_id}'s destination ${row.local_name}: ${reason}`);
  }
  return found;
}
