import { getDb } from '../../db/connection.js';
import { registerDestinationAdmissionPolicy } from '../../db/wiring-admission.js';
import type { AgentDestination } from '../../types.js';
import { getJobAgent } from '../gws-ea-chat-agents/jobs.js';
import { getExternalChatAgentGroupId } from '../gws-ea-profile/db.js';
import { getChat } from './db.js';

/** A group-wide channel grant would let every shared session send outside its origin. */
export async function chatDestinationViolation(row: AgentDestination): Promise<string | undefined> {
  if (!(await getDb().hasTable('gws_ea_chats'))) return undefined;
  if (row.target_type === 'agent') return undefined;
  if (row.agent_group_id === (await getExternalChatAgentGroupId()))
    return 'Shared chat sessions may reply only to their originating chat.';
  const job = await getJobAgent(row.agent_group_id);
  if (job) {
    const chat = await getChat(job.messaging_group_id);
    return row.target_id === job.messaging_group_id &&
      job.state === 'active' &&
      chat?.serving_agent_group_id === job.agent_group_id
      ? undefined
      : 'A job agent serves only its own chat.';
  }
  if (await getChat(row.target_id)) return 'A chat receives channel replies only from its serving session.';
  return undefined;
}
registerDestinationAdmissionPolicy('gws-ea-chats:origin-only', ({ proposed }) => chatDestinationViolation(proposed));
