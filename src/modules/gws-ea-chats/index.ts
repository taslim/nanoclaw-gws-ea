import { setMembershipHandler } from '../../channels/chat-sdk-bridge.js';
import { register } from '../../cli/registry.js';
import { getDb } from '../../db/connection.js';
import { registerMigration } from '../../db/migrations/index.js';
import {
  registerEngagementDecider,
  registerInboundDelay,
  registerMessageInterceptor,
  runInConversationTail,
} from '../../router.js';
import { registerChatMembershipObserver, type AssistantChatChannel } from '../gws-ea-chat/membership.js';
import { getChannelAdapterExact } from '../../channels/channel-registry.js';
import { registerPersonForgetHook } from '../gws-ea-people/db.js';
import { assertMainCaller } from '../gws-ea-profile/db.js';
import { registerWhatsAppObserver } from '../gws-ea-whatsapp/observers.js';
import { registerChannelCardInterceptor } from '../permissions/channel-approval.js';
import { getChat, listChats } from './db.js';
import { decideChatEngagement } from './engage.js';
import { renderChat } from './framing.js';
import { chatInboundDelay, detachChat } from './hold.js';
import { chatByAddress, decideJoin, interceptChatMessage } from './join.js';
import { chatsMigration } from './migration.js';
import { forgetFromChatRosters, memberFact } from './roster.js';
import './destination-policy.js';

export * from './db.js';
export * from './hold.js';
export * from './roster.js';
export { decideJoin, refreshChatMembership } from './join.js';
export { renderChat } from './framing.js';
export { registerExpectedChatReplyReader } from './engage.js';
export { registerChatLifecycleTask, sweepChatLifecycle } from './lifecycle.js';

registerMigration(chatsMigration);
registerMessageInterceptor(interceptChatMessage);
registerInboundDelay((_event, session) => chatInboundDelay(session));
for (const channel of ['whatsapp', 'gchat']) {
  registerEngagementDecider(channel, decideChatEngagement);
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

for (const verb of ['list', 'get'] as const)
  register({
    name: `chats-${verb}`,
    resource: 'chats',
    description: 'Read chat state and framed member information.',
    access: 'open',
    parseArgs(raw) {
      if (Object.keys(raw).some((key) => key !== 'id')) throw new Error('Unknown chats field.');
      if (verb === 'get' && typeof raw.id !== 'string') throw new Error('A chat id is required.');
      return { id: typeof raw.id === 'string' ? raw.id : undefined };
    },
    async handler({ id }, ctx) {
      await assertMainCaller(ctx, 'chats');
      const chats = id ? [await getChat(id)] : await listChats();
      const rendered: string[] = [];
      for (const chat of chats) if (chat) rendered.push(await renderChat(chat));
      return rendered;
    },
  });
