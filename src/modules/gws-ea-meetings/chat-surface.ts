import { ActionRefusal } from '../../cli/delivery-action.js';
import { inChatConversation, requireServingChat } from '../gws-ea-chats/bridge.js';
import { getChatCalendar, chatMatterIds } from '../gws-ea-chats/handoffs.js';
import { refreshChatMembership } from '../gws-ea-chats/join.js';
import { listChatMembers } from '../gws-ea-chats/roster.js';
import { bookingMatters, type BookingSurface } from './booking-surface.js';

export function chatSurface(chatId: string, writer: 'external-chat' | 'job'): BookingSurface {
  const owner = { kind: 'chat', key: chatId } as const;
  const knownEmails = async (): Promise<string[]> =>
    (await listChatMembers(chatId)).flatMap((member) => (member.email === null ? [] : [member.email.toLowerCase()]));
  return {
    owner,
    writer,
    /** to: external-chat, job */
    words: {
      ownerLabel: 'this chat',
      connectionStep: "Wake main with tell_main, saying what you couldn't do in this chat, and wait for main.",
    },
    calendarId: () => getChatCalendar(chatId),
    async invitationPeople() {
      const known = await knownEmails();
      return {
        allowed: known,
        defaults: known,
        /** to: external-chat, job */
        outside: () => 'Invite only current members of this chat with known email addresses.',
        /** to: external-chat, job */
        empty: 'No current chat member has an email address to invite. Ask main or the members for their addresses.',
      };
    },
    async privacyFor(recipients) {
      const known = new Set(await knownEmails());
      return recipients.every((address) => known.has(address.toLowerCase())) ? { chatId } : {};
    },
    async beforeWrite() {
      await refreshChatMembership(chatId);
    },
    inWrite: (work) => inChatConversation(chatId, work),
    async stillServing(session) {
      try {
        return (await requireServingChat(session)).messaging_group_id === chatId;
      } catch (error) {
        if (error instanceof ActionRefusal) return false;
        throw error;
      }
    },
    openMatters: async () => bookingMatters(await chatMatterIds(chatId), owner),
  };
}
