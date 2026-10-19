import { getDb } from '../../db/connection.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { onHostShutdown, onHostStart } from '../../host-lifecycle.js';
import { log } from '../../log.js';
import { runInConversationTail } from '../../router.js';
import { getChat, listChats } from './db.js';
import { expireAskingChats, releaseChatMessages, settleChatMessages } from './hold.js';
import { notifyAskingChat } from './join.js';

const lifecycleTasks = new Map<string, () => Promise<void>>();
export function registerChatLifecycleTask(id: string, task: () => Promise<void>): void {
  if (lifecycleTasks.has(id)) throw new Error(`Chat lifecycle task already registered: ${id}`);
  lifecycleTasks.set(id, task);
}
/** One ordered loop for expiry and registered cutover/retirement resumes. */
export async function sweepChatLifecycle(): Promise<void> {
  if (!(await getDb().hasTable('gws_ea_chats'))) return;
  await expireAskingChats();
  for (const chat of await listChats()) {
    const group = await getMessagingGroup(chat.messaging_group_id);
    if (!group) continue;
    await runInConversationTail(
      {
        channelType: group.channel_type,
        instance: group.instance ?? group.channel_type,
        platformId: group.platform_id,
      },
      async () => {
        const current = await getChat(chat.messaging_group_id);
        if (!current) return;
        if (current.state === 'asking') await notifyAskingChat(current);
        const upkeep = await getDb().get<{ move_source_session_id: string | null; settled_at: string | null }>(
          'SELECT move_source_session_id,settled_at FROM gws_ea_chats WHERE messaging_group_id=?',
          current.messaging_group_id,
        );
        if ((current.state === 'connected' || current.state === 'job') && !upkeep?.move_source_session_id)
          await releaseChatMessages(current.messaging_group_id);
        if ((current.state === 'declined' || current.state === 'detached') && !upkeep?.settled_at)
          await settleChatMessages(current.messaging_group_id);
      },
    );
  }
  for (const task of lifecycleTasks.values()) await task();
}
let timer: NodeJS.Timeout | undefined;
let stopped = true;
let running: Promise<void> = Promise.resolve();
function schedule(): void {
  if (stopped) return;
  timer = setTimeout(() => {
    running = sweepChatLifecycle()
      .catch((error: unknown) => {
        log.error('Chat lifecycle sweep failed', { error });
      })
      .finally(schedule);
  }, 60_000);
  timer.unref();
}
onHostStart(async () => {
  stopped = false;
  await sweepChatLifecycle();
  schedule();
});
onHostShutdown(async () => {
  stopped = true;
  clearTimeout(timer);
  await running;
});
