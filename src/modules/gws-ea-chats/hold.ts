import { getDb } from '../../db/connection.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { requestWake } from '../../request-wake.js';
import { HOLD_UNTIL_RELEASED, runInConversationTail, type InboundDelay } from '../../router.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { deleteChatClearances } from '../gws-ea-privacy/clearance.js';
import { requirePrincipalDirectMessage, requirePrincipalMessage } from '../gws-ea-profile/marks.js';
import { chatIsActive, getChat, type Chat } from './db.js';
import { ensureChatWiring } from './wiring-policy.js';

async function sessions(chat: string): Promise<Session[]> {
  return getDb().all<Session>('SELECT * FROM sessions WHERE messaging_group_id = ?', chat);
}
export async function chatInboundDelay(session: Session): Promise<InboundDelay> {
  const chat = session.messaging_group_id === null ? undefined : await getChat(session.messaging_group_id);
  return chat && (chat.state === 'asking' || chat.state === 'moving') ? HOLD_UNTIL_RELEASED : null;
}
/** Called inside the conversation tail by the prepared engagement path. */
export async function admitChatFromPrincipalMessage(chatId: string, messageId: string): Promise<Chat> {
  const principal = await requirePrincipalMessage(messageId, chatId);
  return releaseChat(chatId, principal.userId);
}
async function releaseChat(chatId: string, principalUserId?: string): Promise<Chat> {
  await getDb().transaction(async () => {
    const chat = await getChat(chatId);
    if (!chat || (chat.state !== 'asking' && chat.state !== 'connected'))
      throw new Error('This chat is not awaiting admission.');
    await getDb().run(
      `UPDATE gws_ea_chats SET state = 'connected', connected_at = COALESCE(connected_at, ?), updated_at = ? WHERE messaging_group_id = ?`,
      new Date().toISOString(),
      new Date().toISOString(),
      chatId,
    );
    await getDb().run('UPDATE messaging_groups SET denied_at = NULL, detached_at = NULL WHERE id = ?', chatId);
    if (principalUserId !== undefined) {
      await getDb().run('UPDATE gws_ea_chats SET principal_present = 1 WHERE messaging_group_id = ?', chatId);
      await getDb().run(
        `INSERT INTO gws_ea_chat_members (messaging_group_id, member_key, is_principal, updated_at)
        VALUES (?, ?, 1, ?) ON CONFLICT (messaging_group_id, member_key) DO UPDATE SET is_principal = 1, updated_at = excluded.updated_at`,
        chatId,
        principalUserId,
        new Date().toISOString(),
      );
    }
  });
  const chat = await getChat(chatId);
  if (!chat) throw new Error('The admitted chat disappeared.');
  await ensureChatWiring(chat);
  await releaseChatMessages(chatId);
  return chat;
}
/** Active state is durable admission; retry interrupted mailbox release without waking an ambient-only batch. */
export async function releaseChatMessages(chatId: string, options: { readonly wake?: boolean } = {}): Promise<void> {
  const chat = await getChat(chatId);
  if (!chat || !chatIsActive(chat)) return;
  for (const session of await sessions(chatId)) {
    if (session.agent_group_id !== chat.serving_agent_group_id || session.status !== 'active') continue;
    const releasedDue = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) => {
      const released = mailbox.releaseHeldMessages(null, { preserveTriggers: true });
      return released > 0 && mailbox.countDueMessages() > 0;
    });
    if (releasedDue && options.wake !== false) await requestWake(session, 'due-message');
  }
}
async function inChatTail<T>(chatId: string, work: () => Promise<T>): Promise<T> {
  const group = await getMessagingGroup(chatId);
  if (!group) throw new Error('The chat does not exist.');
  return runInConversationTail(
    { channelType: group.channel_type, instance: group.instance ?? group.channel_type, platformId: group.platform_id },
    work,
  );
}
/** Main cites the host's copy of the principal's DM answer. */
export async function admitChat(chatId: string, principalMessageId: string): Promise<Chat> {
  return inChatTail(chatId, async () => {
    await requirePrincipalDirectMessage(principalMessageId);
    return releaseChat(chatId);
  });
}
async function closeChat(chatId: string, state: 'declined' | 'detached'): Promise<void> {
  const db = getDb();
  await db.transaction(async () => {
    if (!(await getChat(chatId))) return;
    const now = new Date().toISOString();
    await db.run('UPDATE gws_ea_chats SET state = ?, updated_at = ? WHERE messaging_group_id = ?', state, now, chatId);
    await db.run('DELETE FROM messaging_group_agents WHERE messaging_group_id = ?', chatId);
    if (await db.hasTable('agent_destinations'))
      await db.run("DELETE FROM agent_destinations WHERE target_type = 'channel' AND target_id = ?", chatId);
    await db.run(
      `UPDATE messaging_groups SET ${state === 'declined' ? 'denied_at' : 'detached_at'} = ? WHERE id = ?`,
      now,
      chatId,
    );
    await deleteChatClearances(chatId, db);
    if (await db.hasTable('gws_ea_chat_handoffs')) {
      await db.run('DELETE FROM gws_ea_chat_handoffs WHERE messaging_group_id = ?', chatId);
      await db.run(
        'UPDATE gws_ea_chats SET calendar_id = NULL, placed_nowhere = 0 WHERE messaging_group_id = ?',
        chatId,
      );
    }
  });
  await settleChatMessages(chatId);
}
/** After the central transition commits; safe to repeat after an interrupted detach. */
export async function settleChatMessages(chatId: string): Promise<void> {
  for (const session of await sessions(chatId))
    await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) => mailbox.settleHeldMessages());
}
/** Host-only primitive: the calling action authorizes main; declining grants no authority or private context. */
export async function declineChat(chatId: string): Promise<void> {
  await inChatTail(chatId, () => closeChat(chatId, 'declined'));
}
export async function detachChat(chatId: string): Promise<void> {
  await inChatTail(chatId, () => closeChat(chatId, 'detached'));
}
export const ASKING_LIFETIME_MS = 7 * 24 * 60 * 60_000;
export async function expireAskingChats(now = Date.now()): Promise<void> {
  const due = await getDb().all<{ messaging_group_id: string }>(
    "SELECT messaging_group_id FROM gws_ea_chats WHERE state = 'asking' AND created_at <= ?",
    new Date(now - ASKING_LIFETIME_MS).toISOString(),
  );
  for (const chat of due)
    await inChatTail(chat.messaging_group_id, async () => {
      if ((await getChat(chat.messaging_group_id))?.state === 'asking')
        await closeChat(chat.messaging_group_id, 'declined');
    });
}

/** A checked main handoff places a new private conversation. Caller owns the tail and transaction. */
export async function connectPrivateChatHandoff(chatId: string): Promise<void> {
  const group = await getMessagingGroup(chatId);
  const chat = await getChat(chatId);
  if (!group || group.is_group !== 0 || chat?.state !== 'asking')
    throw new Error('Only an asking private conversation is connected by a checked handoff.');
  const now = new Date().toISOString();
  await getDb().run(
    "UPDATE gws_ea_chats SET state = 'connected', connected_at = ?, updated_at = ? WHERE messaging_group_id = ?",
    now,
    now,
    chatId,
  );
}
