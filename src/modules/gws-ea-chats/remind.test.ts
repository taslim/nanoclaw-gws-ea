import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
const { ROOT } = vi.hoisted(() => ({ ROOT: `/tmp/chat-remind-${process.pid}` }));
vi.mock('../../config.js', async (original) => ({
  ...(await original<typeof import('../../config.js')>()),
  DATA_DIR: ROOT,
}));
vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn(async () => true) }));
import { requestWake } from '../../request-wake.js';
import { deliverSessionMessages } from '../../delivery.js';
import { outboundDbPath } from '../../mailbox/sqlite/paths.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import { reconcileSession } from '../../reconcile-session.js';
import {
  cleanChatDelivery,
  chatData,
  chatRefusal,
  seedChatDelivery,
  sendChatRequest,
  deliveredToChat,
} from './testing/chat-delivery-fixture.js';
afterEach(async () => {
  vi.useRealTimers();
  vi.mocked(requestWake).mockClear();
  await cleanChatDelivery(ROOT);
});
it('stores a real in-conversation reminder in the calling chat and wakes that session only when it becomes due', async () => {
  const { session } = await seedChatDelivery();
  const at = new Date(Date.now() + 3_600_000).toISOString();
  const reply = chatData(await sendChatRequest(session, 'remind', { at, note: 'Choose the venue.' }, 'same-reminder'));
  expect(reply.at).toBe(at);
  chatData(await sendChatRequest(session, 'remind', { at, note: 'Choose the venue.' }, 'same-reminder'));
  const db = new Database(inboundDbPath(session.agent_group_id, session.id));
  try {
    const tasks = db.prepare("SELECT id,content,process_after,status FROM messages_in WHERE kind='task'").all() as {
      id: string;
      content: string;
      process_after: string;
      status: string;
    }[];
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ id: reply.reminder, process_after: at, status: 'pending' });
    expect(JSON.parse(tasks[0].content)).toMatchObject({
      prompt: 'Remind this chat: Choose the venue.',
      inConversation: true,
      script: null,
    });
  } finally {
    db.close();
  }
  await reconcileSession(session.id);
  expect(requestWake).not.toHaveBeenCalled();
  // SQLite uses its real clock; move the stored deadline across that clock to exercise the due path.
  const dueDb = new Database(inboundDbPath(session.agent_group_id, session.id));
  dueDb.prepare("UPDATE messages_in SET process_after='2020-01-01T00:00:00Z' WHERE kind='task'").run();
  dueDb.close();
  await reconcileSession(session.id);
  expect(requestWake).toHaveBeenCalledTimes(1);
  expect(requestWake).toHaveBeenCalledWith(
    expect.objectContaining({ id: session.id, messaging_group_id: session.messaging_group_id }),
    'due-message',
  );
  // The runner's inConversation path emits a normal chat response; exercise its real host delivery.
  const out = new Database(outboundDbPath(session.agent_group_id, session.id));
  out
    .prepare('INSERT INTO messages_out(id,timestamp,kind,platform_id,channel_type,content) VALUES(?,?,?,?,?,?)')
    .run(
      'reminder-answer',
      new Date().toISOString(),
      'chat',
      'context@g.us',
      'whatsapp',
      JSON.stringify({ text: 'Choose the venue today.' }),
    );
  out.close();
  await deliverSessionMessages(session);
  expect(deliveredToChat).toHaveBeenCalledWith(
    'context@g.us',
    null,
    expect.objectContaining({ kind: 'chat', content: { text: 'Choose the venue today.' } }),
    'reminder-answer',
  );
});
it('refuses past times and cross-chat fields without creating a reminder', async () => {
  const { session } = await seedChatDelivery();
  expect(chatRefusal(await sendChatRequest(session, 'remind', { at: '2020-01-01T12:00:00Z', note: 'Old.' }))).toContain(
    'future',
  );
  expect(
    chatRefusal(
      await sendChatRequest(session, 'remind', { at: '2030-01-01T12:00:00Z', note: 'Other.', chat: 'another' }),
    ),
  ).toContain('Unknown field');
});
it('replays an interrupted action response into its existing native task instead of a second reminder', async () => {
  const { session } = await seedChatDelivery();
  const fields = { at: new Date(Date.now() + 3_600_000).toISOString(), note: 'Confirm the venue.' };
  const first = chatData(await sendChatRequest(session, 'remind', fields, 'interrupted-reminder'));
  const db = new Database(inboundDbPath(session.agent_group_id, session.id));
  try {
    // Model a host stop after committing the task but before its action response was durable.
    db.prepare('DELETE FROM messages_in WHERE id=?').run('action-resp-interrupted-reminder');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.now() + 7_200_000));
    expect(chatData(await sendChatRequest(session, 'remind', fields, 'interrupted-reminder'))).toEqual(first);
    expect(db.prepare("SELECT id FROM messages_in WHERE kind='task'").all()).toEqual([{ id: first.reminder }]);
  } finally {
    db.close();
  }
});
