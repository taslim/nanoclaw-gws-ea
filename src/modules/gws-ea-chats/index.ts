import { setMembershipHandler } from '../../channels/chat-sdk-bridge.js';
import { getDb } from '../../db/connection.js';
import { registerMigration } from '../../db/migrations/index.js';
import { registerSessionAdmissionPolicy } from '../../container-runner.js';
import { getSession } from '../../db/sessions.js';
import { registerDeliveryAction } from '../../delivery.js';
import {
  registerEngagementDecider,
  registerInboundDelay,
  registerMessageInterceptor,
  runInConversationTail,
} from '../../router.js';
import { registerChatMembershipObserver, type AssistantChatChannel } from '../gws-ea-chat/membership.js';
import { getChannelAdapterExact } from '../../channels/channel-registry.js';
import { registerPersonForgetHook } from '../gws-ea-people/db.js';
import { registerWhatsAppObserver } from '../gws-ea-whatsapp/observers.js';
import { registerChannelCardInterceptor } from '../permissions/channel-approval.js';
import { chatIsActive, getChat, listChats } from './db.js';
import { decideChatEngagement, registerExpectedChatReplyReader } from './engage.js';
import { chatInboundDelay, detachChat } from './hold.js';
import { chatByAddress, decideJoin, interceptChatMessage } from './join.js';
import { chatsMigration } from './migration.js';
import { forgetFromChatRosters, memberFact } from './roster.js';
import './destination-policy.js';
import './directory.js';
import { CHAT_BRIDGE_ACTIONS, flushChatHandoffs, inChatConversation } from './bridge.js';
import { writeChatContext } from './context.js';
import { chatHandoffMigration } from './handoff-migration.js';
import { registerChatLifecycleTask } from './lifecycle.js';
import { chatToolsMigration } from './tools-migration.js';
import { EXPECT_REPLY_ACTION, consumeExpectedChatReply, expireExpectedChatReplies } from './expect.js';
import { REMIND_ACTION } from './remind.js';

export * from './db.js';
export * from './hold.js';
export * from './roster.js';
export { decideJoin, refreshChatMembership } from './join.js';
export { renderChat } from './framing.js';
export { registerExpectedChatReplyReader } from './engage.js';
export { registerChatLifecycleTask, sweepChatLifecycle } from './lifecycle.js';

registerMigration(chatsMigration);
registerMigration(chatHandoffMigration);
registerMigration(chatToolsMigration);
registerDeliveryAction(...EXPECT_REPLY_ACTION);
registerDeliveryAction(...REMIND_ACTION);
registerExpectedChatReplyReader('gws-ea-chats:expected', consumeExpectedChatReply);
registerChatLifecycleTask('gws-ea-chats:expected', expireExpectedChatReplies);
for (const [action, handler, guard] of CHAT_BRIDGE_ACTIONS) registerDeliveryAction(action, handler, guard);
registerSessionAdmissionPolicy('gws-ea-chats:context', async ({ key }) => {
  const session = await getSession(key.sessionId);
  if (session) await writeChatContext(session);
});
registerChatLifecycleTask('gws-ea-chats:handoffs', async () => {
  for (const chat of await listChats())
    await inChatConversation(chat.messaging_group_id, () => flushChatHandoffs(chat.messaging_group_id));
});
registerMessageInterceptor(interceptChatMessage);
registerInboundDelay((_event, session) => chatInboundDelay(session));
for (const channel of ['whatsapp', 'gchat']) {
  registerEngagementDecider(channel, async (request) => {
    const engaged = await decideChatEngagement(request);
    if (engaged) {
      const chat = await getChat(request.messagingGroup.id);
      if (chat && chatIsActive(chat)) await writeChatContext(request.session);
    }
    return engaged;
  });
  registerChannelCardInterceptor(channel, async () => 'handled');
}
registerPersonForgetHook('gws-ea-chats:rosters', forgetFromChatRosters);

registerWhatsAppObserver({
  async onMembership(event) {
    if (!(await getDb().hasTable('gws_ea_chats'))) return;
    if (event.kind === 'detach') {
      const group = await chatByAddress('whatsapp', event.platformId);
      if (group && (await getChat(group.id))) await detachChat(group.id);
      return;
    }
    await runInConversationTail({ channelType: 'whatsapp', platformId: event.group.platformId }, () =>
      decideJoin({
        channelType: 'whatsapp',
        platformId: event.group.platformId,
        name: event.group.name,
        isGroup: true,
        members: event.group.members,
        joined: event.kind === 'join',
      }),
    );
  },
});
registerChatMembershipObserver(async (event) => {
  if (!(await getDb().hasTable('gws_ea_chats'))) return;
  if (event.kind === 'detach') {
    const group = await chatByAddress('gchat', event.platformId);
    if (group && (await getChat(group.id))) await detachChat(group.id);
    return;
  }
  const members = await Promise.all(
    event.group.members.map((member) => memberFact('gchat', member.userId, member.name)),
  );
  if (!event.group.isGroup && members.some((member) => member.isPrincipal)) return;
  await runInConversationTail({ channelType: 'gchat', platformId: event.group.platformId }, () =>
    decideJoin({
      channelType: 'gchat',
      platformId: event.group.platformId,
      name: event.group.name,
      isGroup: event.group.isGroup,
      members,
      joined: event.kind === 'join',
    }),
  );
});
// The bridge also forwards SDK joins; the name-only Workspace subscription covers departures itself.
setMembershipHandler('gchat', async (event) => {
  const adapter = getChannelAdapterExact(event.instance) as AssistantChatChannel | undefined;
  if (!adapter || !(await getDb().hasTable('gws_ea_chats'))) return;
  const group = await adapter.fetchChatMembers(event.channelId);
  const members = await Promise.all(group.members.map((member) => memberFact('gchat', member.userId, member.name)));
  if (!group.isGroup && members.some((member) => member.isPrincipal)) return;
  await runInConversationTail({ channelType: 'gchat', instance: event.instance, platformId: group.platformId }, () =>
    decideJoin({
      channelType: 'gchat',
      instance: event.instance,
      platformId: group.platformId,
      name: group.name,
      isGroup: group.isGroup,
      members,
    }),
  );
});
