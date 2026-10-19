import { createHash } from 'node:crypto';
import { withExistingMailboxSession } from '../../session-manager.js';
import { answeredGuard, answeringAction, invalidArgs, type ActionAnswer } from '../../cli/delivery-action.js';
import { resolveGroupTimezone } from '../../container-config.js';
import { instantOf } from '../gws-ea-meetings/fields.js';
import { createScheduledTask, prepareScheduledTask } from '../scheduling/create.js';
import { inChatConversation, requireServingChat } from './bridge.js';
import { assertChatToolFields, chatToolsAction } from './expect.js';

/** Stable native task identity across an interrupted chat cutover. */
export function movedReminderId(sourceSession: string, sourceId: string): string {
  return `chat-move-reminder-${createHash('sha256').update(`${sourceSession}\0${sourceId}`).digest('hex')}`;
}

const remind: ActionAnswer = async (content, session, requestId) => {
  assertChatToolFields(content, ['at', 'note']);
  const chat = await requireServingChat(session);
  return inChatConversation(chat.messaging_group_id, async () => {
    await requireServingChat(session);
    const id = `chat-reminder-${createHash('sha256').update(`${session.id}\0${requestId}`).digest('hex')}`;
    const existing = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
      mailbox.getTask(id),
    );
    if (existing)
      return { reminder: existing.id, at: existing.processAfter, message: 'The reminder is set for this chat.' };
    const note = typeof content.note === 'string' ? content.note.trim() : '';
    if (!note) throw invalidArgs('note must contain the reminder text.');
    const at = instantOf(content.at, 'at');
    if (at <= Date.now()) throw invalidArgs('at must be in the future.');
    const prepared = prepareScheduledTask({
      name: 'chat reminder',
      prompt: `Remind this chat: ${note}`,
      processAfter: new Date(at).toISOString(),
      timezone: await resolveGroupTimezone(session.agent_group_id),
    });
    const { row } = await createScheduledTask(session.agent_group_id, prepared, { id, session });
    return { reminder: row.id, at: row.processAfter, message: 'The reminder is set for this chat.' };
  });
};
export const REMIND_ACTION = ['remind', answeringAction('remind', remind), answeredGuard(chatToolsAction)] as const;
