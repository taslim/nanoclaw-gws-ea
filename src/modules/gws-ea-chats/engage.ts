import { getChannelAdapterExact } from '../../channels/channel-registry.js';
import { parseInboundContent } from '../../channels/inbound-content.js';
import { isRecord } from '../../gws-ea/validation.js';
import type { EngagementDecisionRequest } from '../../router.js';
import type { AssistantChatChannel } from '../gws-ea-chat/membership.js';
import { getGwsEaProfile } from '../gws-ea-profile/db.js';
import type { WhatsAppAdapter } from '../gws-ea-whatsapp/adapter.js';
import { getChat } from './db.js';
import { admitChatFromPrincipalMessage } from './hold.js';
import { channelUserId, listChatMembers, memberFact, recordChatSpeaker, setChatMemberEmail } from './roster.js';

export type ExpectedChatReplyReader = (chatId: string, userId: string) => Promise<boolean>;
const expectedReaders = new Map<string, ExpectedChatReplyReader>();
/** The expected-replies owner supplies its real durable lookup; registration conveys no authority. */
export function registerExpectedChatReplyReader(id: string, read: ExpectedChatReplyReader): void {
  if (expectedReaders.has(id)) throw new Error(`Expected reply reader already registered: ${id}`);
  expectedReaders.set(id, read);
}
function contentRecord(content: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(content);
    return isRecord(value) ? value : undefined;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return undefined;
  }
}
export async function decideChatEngagement({ event, messagingGroup }: EngagementDecisionRequest): Promise<boolean> {
  let chat = await getChat(messagingGroup.id);
  if (!chat) return false;
  const parsed = contentRecord(event.message.content);
  const mark = isRecord(parsed?.principalMessage) ? parsed.principalMessage : undefined;
  if (chat.state === 'asking' && mark?.id === event.message.id && mark.messagingGroupId === messagingGroup.id) {
    // The mark alone never grants admission: read the persisted, exact-chat principal words.
    chat = await admitChatFromPrincipalMessage(messagingGroup.id, event.message.id);
  }
  if (chat.state === 'declined' || chat.state === 'detached') return false;
  const userId =
    event.message.authenticatedSender?.kind === 'human'
      ? channelUserId(event.channelType, event.message.authenticatedSender.userId)
      : undefined;
  if (userId)
    await recordChatSpeaker(
      messagingGroup.id,
      await memberFact(event.channelType, userId, event.message.authenticatedSender?.displayName),
    );
  if (userId && parsed?.forwarded !== true && parsed?.quoted !== true && typeof parsed?.text === 'string') {
    const emails =
      parsed.text.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?\.[A-Z]{2,}/giu) ?? [];
    if (
      emails.length === 1 &&
      (parsed.text.trim() === emails[0] ||
        /(?:\bmy (?:email(?: address)?|address)\s*(?:is|:)|\b(?:email|reach|contact) me (?:at|on))\s*$/iu.test(
          parsed.text.slice(0, parsed.text.indexOf(emails[0])),
        )) &&
      (await listChatMembers(messagingGroup.id)).some((member) => member.member_key === userId)
    )
      await setChatMemberEmail(messagingGroup.id, userId, emails[0], 'member');
  }
  if (messagingGroup.is_group === 0 || event.message.isMention === true) return true;
  const name = (await getGwsEaProfile()).assistant_display_name;
  if (name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    if (
      new RegExp(`(?:^|[^\\p{L}\\p{N}_])@?${escaped}(?=$|[^\\p{L}\\p{N}_])`, 'iu').test(
        parseInboundContent(event.message.content).text,
      )
    )
      return true;
  }
  const quote = isRecord(parsed?.replyTo) ? parsed.replyTo : undefined;
  if (typeof quote?.id === 'string' && quote.forwarded !== true) {
    const adapter = getChannelAdapterExact(event.instance ?? event.channelType);
    if (
      event.channelType === 'whatsapp' &&
      adapter &&
      (adapter as WhatsAppAdapter).isOwnMessage(event.platformId, quote.id)
    )
      return true;
    if (
      event.channelType === 'gchat' &&
      adapter &&
      (await (adapter as AssistantChatChannel).isOwnMessage(event.platformId, quote.id))
    )
      return true;
  }
  if (userId) for (const reader of expectedReaders.values()) if (await reader(messagingGroup.id, userId)) return true;
  return false;
}
