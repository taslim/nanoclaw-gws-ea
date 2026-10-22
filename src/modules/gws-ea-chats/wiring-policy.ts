import { randomUUID } from 'node:crypto';
import { getDb } from '../../db/connection.js';
import { createMessagingGroupAgent, getMessagingGroupAgentByPair } from '../../db/messaging-groups.js';
import { registerWiringAdmissionPolicy } from '../../db/wiring-admission.js';
import type { MessagingGroupAgent } from '../../types.js';
import { getJobAgent } from '../gws-ea-chat-agents/jobs.js';
import { getExternalChatAgentGroupId } from '../gws-ea-profile/db.js';
import { getChat, type Chat } from './db.js';

export const CHAT_WIRING = {
  engage_mode: 'module',
  engage_pattern: null,
  sender_scope: 'all',
  ignored_message_policy: 'accumulate',
  session_mode: 'shared',
  threads: 0,
} as const satisfies Partial<MessagingGroupAgent>;

export async function ensureChatWiring(chat: Chat): Promise<void> {
  if (await getMessagingGroupAgentByPair(chat.messaging_group_id, chat.serving_agent_group_id)) return;
  await createMessagingGroupAgent(
    {
      id: `mga-chat-${randomUUID()}`,
      messaging_group_id: chat.messaging_group_id,
      agent_group_id: chat.serving_agent_group_id,
      ...CHAT_WIRING,
      priority: 0,
      created_at: new Date().toISOString(),
    },
    { companionDestination: false },
  );
}

registerWiringAdmissionPolicy('gws-ea-chats:chat-shape', async ({ proposed }) => {
  if (!(await getDb().hasTable('gws_ea_chats'))) return;
  const chat = await getChat(proposed.messaging_group_id);
  const external = await getExternalChatAgentGroupId();
  const job = await getJobAgent(proposed.agent_group_id);
  if (!chat && proposed.agent_group_id !== external && !job) return;
  if (!chat || chat.state === 'declined' || chat.state === 'detached')
    throw new Error('Chat wiring requires an admitted chat record.');
  const allowed =
    proposed.agent_group_id === external ||
    (job?.messaging_group_id === chat.messaging_group_id && job.state === 'active');
  if (!allowed || proposed.agent_group_id !== chat.serving_agent_group_id)
    throw new Error('The chat is wired only to its serving agent.');
  for (const [key, value] of Object.entries(CHAT_WIRING) as [keyof MessagingGroupAgent, unknown][]) {
    if (proposed[key] !== value) throw new Error(`Chat wiring requires ${key} = ${JSON.stringify(value)}.`);
  }
});
