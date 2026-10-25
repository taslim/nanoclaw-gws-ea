import { randomUUID } from 'node:crypto';
import type { InboundEvent } from '../../channels/adapter.js';
import { getChannelAdapterExact } from '../../channels/channel-registry.js';
import { getDb } from '../../db/connection.js';
import {
  createMessagingGroupIfAbsent,
  getMessagingGroupByPlatform,
  getMessagingGroupAgents,
  getMessagingGroup,
} from '../../db/messaging-groups.js';
import { log } from '../../log.js';
import { runInConversationTail } from '../../router.js';
import type { MessagingGroup } from '../../types.js';
import type { AssistantChatChannel } from '../gws-ea-chat/membership.js';
import { getExternalChatAgentGroupId, isVerifiedPrincipalUser } from '../gws-ea-profile/db.js';
import { writeNoteForMain } from '../gws-ea-profile/main-note.js';
import type { WhatsAppAdapter } from '../gws-ea-whatsapp/adapter.js';
import { getChat, type Chat } from './db.js';
import { renderChat } from './framing.js';
import {
  channelUserId,
  listChatMembers,
  memberFact,
  personForMember,
  refreshChatRoster,
  type ChatMemberFact,
  type ChatMember,
} from './roster.js';
import { ensureChatWiring } from './wiring-policy.js';
import { reopenClosedChat } from './closed-admission.js';

export interface ChatJoinFacts {
  readonly channelType: 'whatsapp' | 'gchat';
  readonly instance?: string;
  readonly platformId: string;
  readonly name: string | null;
  readonly isGroup: boolean;
  readonly members: readonly ChatMemberFact[];
  /** A native assistant-added event, never inferred from an ordinary message or roster refresh. */
  readonly joined?: boolean;
}
export async function notifyAskingChat(chat: Chat): Promise<void> {
  if (chat.state !== 'asking' || chat.asking_notified_at !== null) return;
  const outcome = await writeNoteForMain({
    id: `chat-asking-${chat.messaging_group_id}-${chat.created_at}`,
    timestamp: chat.created_at,
    wake: true,
    text: `Someone has asked for help in a chat where the principal is not yet participating, or in a new private conversation. Ask the principal once whether to help here. Nothing has been sent there.\n${await renderChat(chat)}`,
  });
  if (outcome === 'written' || outcome === 'already-written')
    await getDb().run(
      'UPDATE gws_ea_chats SET asking_notified_at = ? WHERE messaging_group_id = ?',
      new Date().toISOString(),
      chat.messaging_group_id,
    );
}
/** Both membership events and the first message use the same facts and decision. Caller owns the conversation tail. */
export async function decideJoin(facts: ChatJoinFacts): Promise<Chat | undefined> {
  const external = await getExternalChatAgentGroupId();
  if (external === null) return undefined;
  const now = new Date().toISOString();
  await createMessagingGroupIfAbsent({
    id: `mg-chat-${randomUUID()}`,
    channel_type: facts.channelType,
    instance: facts.instance ?? facts.channelType,
    platform_id: facts.platformId,
    name: facts.name,
    is_group: Number(facts.isGroup),
    unknown_sender_policy: 'public',
    created_at: now,
  });
  const group = await getMessagingGroupByPlatform(
    facts.channelType,
    facts.platformId,
    facts.instance ?? facts.channelType,
  );
  if (!group) throw new Error('The chat conversation was not stored.');
  let chat = await getChat(group.id);
  if (chat?.state === 'declined' || (chat?.state === 'detached' && !facts.joined)) return chat;
  if (chat?.state === 'detached') {
    chat = await reopenClosedChat(
      chat,
      facts,
      external,
      facts.members.some((member) => member.isPrincipal) ? 'connected' : 'asking',
    );
    await notifyAskingChat(chat);
    return chat;
  }
  if (!chat) {
    if ((await getMessagingGroupAgents(group.id)).length > 0) return undefined;
    const principal = facts.members.some((member) => member.isPrincipal);
    const knownPrivate =
      !facts.isGroup && facts.members.length === 1 && (await personForMember(facts.members[0].key)) !== null;
    const state = principal || knownPrivate ? 'connected' : 'asking';
    await getDb().transaction(async () => {
      await getDb().run(
        `INSERT INTO gws_ea_chats
        (messaging_group_id, state, serving_agent_group_id, principal_present, connected_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
        group.id,
        state,
        external,
        Number(principal),
        state === 'connected' ? now : null,
        now,
        now,
      );
      await getDb().run(
        "UPDATE messaging_groups SET unknown_sender_policy = 'public', name = COALESCE(?, name) WHERE id = ?",
        facts.name,
        group.id,
      );
      chat = await getChat(group.id);
      if (!chat) throw new Error('The chat record was not stored.');
      await refreshChatRoster(group.id, facts.members);
      await ensureChatWiring(chat);
    });
  } else {
    await refreshChatRoster(group.id, facts.members);
    if (facts.name !== null)
      await getDb().run('UPDATE messaging_groups SET name = ? WHERE id = ?', facts.name, group.id);
    await ensureChatWiring(chat);
  }
  chat = await getChat(group.id);
  if (chat) await notifyAskingChat(chat);
  return chat;
}

async function readMembership(address: {
  readonly channelType: string;
  readonly instance?: string;
  readonly platformId: string;
  readonly isGroup: boolean;
}): Promise<ChatJoinFacts> {
  const adapter = getChannelAdapterExact(address.instance ?? address.channelType);
  if (!adapter) throw new Error('The receiving chat adapter is unavailable.');
  if (address.channelType === 'whatsapp') {
    if (!address.isGroup) {
      const person = await (adapter as WhatsAppAdapter).resolvePerson(address.platformId);
      if (!person) throw new Error('The private chat member cannot be resolved.');
      return {
        channelType: 'whatsapp',
        instance: address.instance,
        platformId: address.platformId,
        name: null,
        isGroup: false,
        members: [await memberFact('whatsapp', person.lid)],
      };
    }
    const group = await (adapter as WhatsAppAdapter).fetchGroupMembers(address.platformId);
    return {
      channelType: 'whatsapp',
      instance: address.instance,
      platformId: group.platformId,
      name: group.name,
      isGroup: true,
      members: group.members,
    };
  }
  if (address.channelType !== 'gchat') throw new Error('This platform is not a supported chat.');
  const group = await (adapter as AssistantChatChannel).fetchChatMembers(address.platformId);
  return {
    channelType: 'gchat',
    instance: address.instance,
    platformId: group.platformId,
    name: group.name,
    isGroup: group.isGroup,
    members: await Promise.all(group.members.map((member) => memberFact('gchat', member.userId, member.name))),
  };
}
/**
 * Membership read fresh from the platform, for decisions on who is in the chat. Takes the conversation
 * tail; callers must not already hold it.
 */
export async function refreshChatMembership(chatId: string): Promise<ChatMember[]> {
  const group = await getMessagingGroup(chatId);
  if (!group || !(await getChat(chatId))) throw new Error('The chat does not exist.');
  const address = {
    channelType: group.channel_type,
    instance: group.instance ?? group.channel_type,
    platformId: group.platform_id,
    isGroup: group.is_group === 1,
  };
  return runInConversationTail(address, async () => {
    const facts = await readMembership(address);
    await refreshChatRoster(chatId, facts.members);
    return listChatMembers(chatId);
  });
}
export async function interceptChatMessage(event: InboundEvent): Promise<boolean> {
  if (event.channelType !== 'whatsapp' && event.channelType !== 'gchat') return false;
  if (!(await getDb().hasTable('gws_ea_chats'))) return false;
  const group = await getMessagingGroupByPlatform(
    event.channelType,
    event.platformId,
    event.instance ?? event.channelType,
  );
  const chat = group ? await getChat(group.id) : undefined;
  if (chat) {
    if (chat.state === 'declined' || chat.state === 'detached') return true;
    // Core's reaction path bypasses engagement. A held conversation must stay silent there too.
    if (event.message.reaction || event.message.quiet) return chat.state === 'asking' || chat.state === 'moving';
    return false;
  }
  if (event.message.reaction || event.message.quiet) return false;
  if (group && (await getMessagingGroupAgents(group.id)).length > 0) return false;
  const sender = event.message.authenticatedSender;
  if (sender?.kind !== 'human') {
    log.info('Ignored an unresolved sender in an unrecorded chat', {
      channelType: event.channelType,
      platformId: event.platformId,
    });
    return true;
  }
  const key = channelUserId(event.channelType, sender.userId);
  const isGroup = event.message.isGroup === true || group?.is_group === 1;
  if (!isGroup && (await isVerifiedPrincipalUser(key))) return false;
  await decideJoin(
    isGroup
      ? await readMembership({ ...event, isGroup: true })
      : {
          channelType: event.channelType,
          instance: event.instance,
          platformId: event.platformId,
          name: sender.displayName ?? null,
          isGroup: false,
          members: [await memberFact(event.channelType, sender.userId, sender.displayName)],
        },
  );
  return false;
}

export async function chatByAddress(channel: string, platform: string): Promise<MessagingGroup | undefined> {
  return getMessagingGroupByPlatform(channel, platform, channel);
}
