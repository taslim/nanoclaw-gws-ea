import {
  ActionRefusal,
  answeredGuard,
  answeringAction,
  invalidArgs,
  type ActionAnswer,
} from '../../cli/delivery-action.js';
import { getDb } from '../../db/connection.js';
import { getSession } from '../../db/sessions.js';
import { ALLOW, DENY, defineGuardedAction } from '../../guard/index.js';
import { inChatConversation, requireServingChat } from './bridge.js';
import { getChat } from './db.js';
import { instantOf } from '../gws-ea-meetings/fields.js';
import { listChatMembers } from './roster.js';

const MAX_WAIT_MS = 48 * 60 * 60 * 1_000;
export const chatToolsAction = defineGuardedAction({
  action: 'gws_ea_chats.tools',
  decide: async ({ actor }) => {
    if (actor.kind !== 'agent' || actor.sessionId === undefined)
      return DENY('Only a serving chat session uses chat tools.');
    const session = await getSession(actor.sessionId);
    if (!session || session.agent_group_id !== actor.agentGroupId)
      return DENY('Only a serving chat session uses chat tools.');
    try {
      await requireServingChat(session);
      return ALLOW('current serving chat session');
    } catch (error) {
      if (error instanceof ActionRefusal) return DENY(error.message);
      throw error;
    }
  },
});
export function assertChatToolFields(content: Record<string, unknown>, fields: readonly string[]): void {
  const unknown = Object.keys(content).find((key) => !['action', 'requestId', 'delivers', ...fields].includes(key));
  if (unknown) throw invalidArgs(`Unknown field ${unknown}; this tool acts only in its session’s chat.`);
}
function memberKeys(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0)
    throw invalidArgs('people must list current chat member keys; omit it to wait for anyone.');
  return [
    ...new Set(
      value.map((entry: unknown) => {
        if (typeof entry !== 'string') throw invalidArgs('people must list current chat member keys.');
        return entry;
      }),
    ),
  ];
}
const expectReply: ActionAnswer = async (content, session, requestId) => {
  assertChatToolFields(content, ['people', 'until']);
  const chat = await requireServingChat(session);
  return inChatConversation(chat.messaging_group_id, async () => {
    const current = await requireServingChat(session);
    const until = content.until === undefined ? Date.now() + MAX_WAIT_MS : instantOf(content.until, 'until');
    if (until <= Date.now() || until > Date.now() + MAX_WAIT_MS)
      throw invalidArgs('until must be a future instant within 48 hours.');
    const people = content.people;
    const keys = people === undefined ? ['*'] : memberKeys(people);
    const members = await listChatMembers(chat.messaging_group_id);
    if (people !== undefined && keys.some((key) => !members.some((member) => member.member_key === key)))
      throw invalidArgs('people must name current members of this chat.');
    const expires = new Date(until).toISOString();
    await getDb().transaction(async () => {
      for (const key of keys)
        await getDb().run(
          'INSERT INTO gws_ea_chat_expected_replies(messaging_group_id,chat_created_at,request_id,member_key,expires_at) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING',
          chat.messaging_group_id,
          current.created_at,
          requestId,
          key,
          expires,
        );
    });
    return { until: expires, message: 'Their next answer will reach you in this chat.' };
  });
};
/** Close waits on the next human message; retain its identity until expiry so an interrupted mailbox write can replay. */
export async function consumeExpectedChatReply(chatId: string, userId: string, messageId: string): Promise<boolean> {
  const chat = await getChat(chatId);
  if (!chat) return false;
  return getDb().transaction(async () => {
    const row = await getDb().get<{ waiting: number }>(
      "SELECT 1 AS waiting FROM gws_ea_chat_expected_replies WHERE messaging_group_id=? AND chat_created_at=? AND member_key IN (?,'*') AND expires_at>? AND (consumed_message_id IS NULL OR consumed_message_id=?) LIMIT 1",
      chatId,
      chat.created_at,
      userId,
      new Date().toISOString(),
      messageId,
    );
    await getDb().run(
      "UPDATE gws_ea_chat_expected_replies SET consumed_message_id=? WHERE messaging_group_id=? AND chat_created_at=? AND member_key IN (?,'*') AND consumed_message_id IS NULL AND expires_at>?",
      messageId,
      chatId,
      chat.created_at,
      userId,
      new Date().toISOString(),
    );
    return row !== undefined;
  });
}
export async function expireExpectedChatReplies(): Promise<void> {
  await getDb().run(
    `DELETE FROM gws_ea_chat_expected_replies WHERE expires_at<=? OR NOT EXISTS (
    SELECT 1 FROM gws_ea_chats c WHERE c.messaging_group_id=gws_ea_chat_expected_replies.messaging_group_id
    AND c.created_at=gws_ea_chat_expected_replies.chat_created_at AND c.state IN ('connected','job','moving'))`,
    new Date().toISOString(),
  );
}
export const EXPECT_REPLY_ACTION = [
  'expect_reply',
  answeringAction('expect_reply', expectReply),
  answeredGuard(chatToolsAction),
] as const;
