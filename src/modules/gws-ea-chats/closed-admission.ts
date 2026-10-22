import { getDb } from '../../db/connection.js';
import { getJobAgentForChat } from '../gws-ea-chat-agents/jobs.js';
import { retireJobAgent } from '../gws-ea-chat-agents/retire.js';
import { getChat, type Chat } from './db.js';
import { settleChatMessages } from './hold.js';
import type { ChatJoinFacts } from './join.js';
import { refreshChatRoster } from './roster.js';
import { ensureChatWiring } from './wiring-policy.js';

/** A native rejoin or a new principal request starts a new lifetime only after the previous one is closed. Caller owns the conversation tail. */
export async function reopenClosedChat(
  chat: Chat,
  facts: ChatJoinFacts,
  external: string,
  state: 'asking' | 'connected',
): Promise<Chat> {
  if (chat.state !== 'detached' && chat.state !== 'declined')
    throw new Error('Only a closed chat can start a new admission lifetime.');
  await settleChatMessages(chat.messaging_group_id);
  const job = await getJobAgentForChat(chat.messaging_group_id);
  if (job) await retireJobAgent(job.agent_group_id);
  const admittedAt = new Date(Math.max(Date.now(), Date.parse(chat.created_at) + 1)).toISOString();
  return getDb().transaction(async () => {
    await getDb().run(
      `UPDATE gws_ea_chats SET state = ?, serving_agent_group_id = ?,
      asking_notified_at = NULL, connected_at = ?, created_at = ?, updated_at = ?, settled_at = NULL,
      calendar_id = NULL, placed_nowhere = 0, move_source_session_id = NULL, move_request_id = NULL,
      move_pending_reminder_ids_json = '[]', move_failed = 0 WHERE messaging_group_id = ?`,
      state,
      external,
      state === 'connected' ? admittedAt : null,
      admittedAt,
      admittedAt,
      chat.messaging_group_id,
    );
    await getDb().run(
      "UPDATE messaging_groups SET denied_at = NULL, detached_at = NULL, unknown_sender_policy = 'public', name = COALESCE(?, name) WHERE id = ?",
      facts.name,
      chat.messaging_group_id,
    );
    await refreshChatRoster(chat.messaging_group_id, facts.members);
    const reopened = await getChat(chat.messaging_group_id);
    if (!reopened) throw new Error('The reopened chat disappeared.');
    await ensureChatWiring(reopened);
    return reopened;
  });
}
