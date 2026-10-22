import { register } from '../../cli/registry.js';
import { assertMainCaller } from '../gws-ea-profile/db.js';
import { getChat, listChats } from './db.js';
import { renderChat } from './framing.js';
import { chatMatterIds, getChatCalendar } from './handoffs.js';

for (const verb of ['list', 'get'] as const)
  register({
    name: `chats-${verb}`,
    resource: 'chats',
    description: 'Read chat state, framed members, calendar and matter keys.',
    access: 'open',
    parseArgs(raw) {
      if (Object.keys(raw).some((key) => key !== 'id')) throw new Error('Unknown chats field.');
      if (verb === 'get' && (typeof raw.id !== 'string' || !raw.id.trim())) throw new Error('A chat id is required.');
      return { id: typeof raw.id === 'string' ? raw.id : undefined };
    },
    async handler({ id }, ctx) {
      await assertMainCaller(ctx, 'chats');
      const chats = id ? [await getChat(id)] : await listChats();
      if (id && !chats[0]) throw new Error('The chat does not exist.');
      const rendered: string[] = [];
      for (const chat of chats)
        if (chat)
          rendered.push(
            `${await renderChat(chat)}\nCalendar: ${(await getChatCalendar(chat.messaging_group_id)) ?? 'not set'}. Open matters: ${(await chatMatterIds(chat.messaging_group_id)).join(', ') || 'none'}.`,
          );
      return rendered;
    },
  });
