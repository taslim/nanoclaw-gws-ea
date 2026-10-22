import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
const { ROOT } = vi.hoisted(() => ({ ROOT: `/tmp/chat-expect-u11-${process.pid}` }));
vi.mock('../../config.js', async (original) => ({
  ...(await original<typeof import('../../config.js')>()),
  DATA_DIR: ROOT,
}));
vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn(async () => true) }));
import { getDb } from '../../db/connection.js';
import { requestWake } from '../../request-wake.js';
import { routeInbound } from '../../router.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import { resolveSession } from '../../session-manager.js';
import { cleanU11, dataU11, refusalU11, seedU11, sendU11 } from './testing/u11-fixture.js';
import { expireExpectedChatReplies } from './expect.js';
afterEach(async () => {
  vi.useRealTimers();
  vi.mocked(requestWake).mockClear();
  await cleanU11(ROOT);
});
it('AE3: a real expected answer wakes its own chat once while another person and a later message stay silent', async () => {
  const { chat, session } = await seedU11();
  const send = (id: string, user: string, text: string) =>
    routeInbound({
      channelType: 'whatsapp',
      platformId: 'context@g.us',
      threadId: null,
      message: {
        id,
        kind: 'chat',
        timestamp: new Date().toISOString(),
        content: JSON.stringify({ text }),
        authenticatedSender: { kind: 'human', userId: user },
      },
    });
  expect(dataU11(await sendU11(session, 'expect_reply', { people: ['whatsapp:11'] }))).toHaveProperty('until');
  await send('remy', '22', 'Unrelated banter');
  expect(requestWake).not.toHaveBeenCalled();
  await send('answer', '11', 'Thursday');
  expect(requestWake).toHaveBeenCalledTimes(1);
  expect(requestWake).toHaveBeenCalledWith(expect.objectContaining({ id: session.id }), 'inbound-message');
  await send('later', '11', 'Other banter');
  expect(requestWake).toHaveBeenCalledTimes(1);
  const db = new Database(inboundDbPath(session.agent_group_id, session.id), { readonly: true });
  try {
    expect(
      db
        .prepare(
          "SELECT id,trigger FROM messages_in WHERE id IN ('remy:external','answer:external','later:external') ORDER BY seq",
        )
        .all(),
    ).toEqual([
      { id: 'remy:external', trigger: 0 },
      { id: 'answer:external', trigger: 1 },
      { id: 'later:external', trigger: 0 },
    ]);
  } finally {
    db.close();
  }
  expect(
    await getDb().all(
      'SELECT member_key,consumed_message_id FROM gws_ea_chat_expected_replies WHERE messaging_group_id=?',
      chat.messaging_group_id,
    ),
  ).toEqual([{ member_key: 'whatsapp:11', consumed_message_id: 'answer' }]);
});
it('expires durable expectations within 48 hours and never accepts a different session or caller-supplied chat', async () => {
  const { session, chat } = await seedU11();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-18T12:00:00Z'));
  dataU11(await sendU11(session, 'expect_reply', { until: '2026-10-18T13:00:00Z' }));
  expect(refusalU11(await sendU11(session, 'expect_reply', { until: '2026-10-21T12:00:00Z' }))).toContain('48 hours');
  expect(refusalU11(await sendU11(session, 'expect_reply', { chat: 'another' }))).toContain('Unknown field');
  const foreign = (await resolveSession('peer', chat.messaging_group_id, null, 'shared')).session;
  expect(refusalU11(await sendU11(foreign, 'expect_reply', {}))).toContain('serving');
  vi.setSystemTime(new Date('2026-10-18T13:00:00Z'));
  await routeInbound({
    channelType: 'whatsapp',
    platformId: 'context@g.us',
    threadId: null,
    message: {
      id: 'expired',
      kind: 'chat',
      timestamp: new Date().toISOString(),
      content: JSON.stringify({ text: 'Thursday' }),
      authenticatedSender: { kind: 'human', userId: '22' },
    },
  });
  expect(requestWake).not.toHaveBeenCalled();
  await expireExpectedChatReplies();
  expect(await getDb().all('SELECT * FROM gws_ea_chat_expected_replies')).toEqual([]);
});
it('waiting for anyone consumes the first authenticated answer and does not cross chats', async () => {
  const { session } = await seedU11();
  dataU11(await sendU11(session, 'expect_reply', {}));
  const { consumeExpectedChatReply } = await import('./expect.js');
  expect(await consumeExpectedChatReply('another', 'whatsapp:22', 'first')).toBe(false);
  expect(await consumeExpectedChatReply(session.messaging_group_id ?? '', 'whatsapp:22', 'first')).toBe(true);
  expect(await consumeExpectedChatReply(session.messaging_group_id ?? '', 'whatsapp:22', 'first')).toBe(true);
  expect(await consumeExpectedChatReply(session.messaging_group_id ?? '', 'whatsapp:22', 'later')).toBe(false);
  expect(await consumeExpectedChatReply(session.messaging_group_id ?? '', 'whatsapp:11', 'second')).toBe(false);
});
it('preserves an expected wake when the first native inbound mailbox write is interrupted and retried', async () => {
  const { session } = await seedU11();
  dataU11(await sendU11(session, 'expect_reply', { people: ['whatsapp:22'] }));
  const sessionManager = await import('../../session-manager.js');
  const write = sessionManager.writeSessionMessage;
  const stopped = vi.spyOn(sessionManager, 'writeSessionMessage').mockImplementation(async (...args) => {
    if (args[2].id === 'interrupt-answer:external') throw new Error('Interrupted native inbound write');
    return write(...args);
  });
  const inbound = {
    channelType: 'whatsapp',
    platformId: 'context@g.us',
    threadId: null,
    message: {
      id: 'interrupt-answer',
      kind: 'chat' as const,
      timestamp: new Date().toISOString(),
      content: JSON.stringify({ text: 'Thursday' }),
      deduplicate: true,
      authenticatedSender: { kind: 'human' as const, userId: '22' },
    },
  };
  await expect(routeInbound(inbound)).rejects.toThrow('Interrupted native inbound write');
  stopped.mockRestore();
  expect(requestWake).not.toHaveBeenCalled();
  await routeInbound(inbound);
  expect(requestWake).toHaveBeenCalledTimes(1);
  const db = new Database(inboundDbPath(session.agent_group_id, session.id), { readonly: true });
  try {
    expect(db.prepare('SELECT trigger FROM messages_in WHERE id=?').get('interrupt-answer:external')).toEqual({
      trigger: 1,
    });
  } finally {
    db.close();
  }
});
