import fs from 'node:fs';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
const { ROOT } = vi.hoisted(() => ({ ROOT: `/tmp/gws-ea-chat-context-${process.pid}` }));
vi.mock('../../config.js', async (original) => ({
  ...(await original<typeof import('../../config.js')>()),
  DATA_DIR: ROOT,
}));
vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn(async () => true) }));
import { closeDb, getDb } from '../../db/connection.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import { renderChatContext, writeChatContext } from './context.js';
import { seedContext } from './testing/context-fixture.js';
afterEach(async () => {
  await closeDb();
  fs.rmSync(ROOT, { recursive: true, force: true });
});
it('gives the chat only verified levels, framed source names, principal presence, calendar and main’s handoff', async () => {
  const { chat, session, matter } = await seedContext();
  const text = await renderChatContext(chat.messaging_group_id);
  expect(text).toContain('Member whatsapp:22; verified principal: false; level: close.');
  expect(text).toContain("A message's sender_id and mentions name these member keys; `you` is you.");
  for (const privateField of ['Private person name', 'Private reason', 'Private matter title', 'whatsapp:22 is'])
    expect(text).not.toContain(privateField);
  expect(text).toContain('Principal present: true.');
  expect(text).toContain('Booking calendar: set.');
  expect(text).not.toContain('team@group.calendar.google.com');
  expect(text).toContain(matter.id);
  expect(text).toContain('Find a venue for Friday.');
  expect(text).toMatch(/<<<EXTERNAL_UNTRUSTED_CONTENT[\s\S]*Trip/);
  await writeChatContext(session);
  await writeChatContext(session);
  const db = new Database(inboundDbPath('external', session.id), { readonly: true });
  try {
    expect(db.prepare("SELECT trigger FROM messages_in WHERE id LIKE 'chat-context-%'").all()).toEqual([
      { trigger: 0 },
    ]);
  } finally {
    db.close();
  }
});
it('tells the session again when the chat’s facts change back', async () => {
  const { chat, session } = await seedContext();
  const setPresent = (present: number) =>
    getDb().run(
      'UPDATE gws_ea_chats SET principal_present = ? WHERE messaging_group_id = ?',
      present,
      chat.messaging_group_id,
    );
  await writeChatContext(session);
  await setPresent(0);
  await writeChatContext(session);
  await setPresent(1);
  await writeChatContext(session);
  await writeChatContext(session);
  const db = new Database(inboundDbPath('external', session.id), { readonly: true });
  try {
    const rows = db.prepare("SELECT content FROM messages_in WHERE id LIKE 'chat-context-%' ORDER BY seq").all() as {
      content: string;
    }[];
    expect(rows.map((row) => /Principal present: (true|false)\./u.exec(row.content)?.[1])).toEqual([
      'true',
      'false',
      'true',
    ]);
  } finally {
    db.close();
  }
});
it('writes no other chat’s context into a peer session', async () => {
  const { session } = await seedContext();
  await writeChatContext({ ...session, agent_group_id: 'peer' });
  expect(fs.existsSync(inboundDbPath('peer', session.id))).toBe(false);
});

it('notes when a non-principal chat member has previously exchanged email with the assistant', async () => {
  const { chat } = await seedContext();
  await import('../gws-ea-inbox/index.js');
  const { runMigrations } = await import('../../db/migrations/index.js');
  await runMigrations(getDb());
  const { createThread, placeThread, recordThreadAddresses, recordThreadMessage, releaseThread } =
    await import('../gws-ea-inbox/thread-map.js');
  const now = new Date().toISOString();
  await getDb().run(
    "UPDATE gws_ea_chat_members SET email='mira@example.test', email_source='main' WHERE messaging_group_id=? AND member_key='whatsapp:22'",
    chat.messaging_group_id,
  );
  const prior = await createThread('g-mira', now, 'mail-mira-prior');
  await placeThread(prior.threadKey, 'nowhere');
  await releaseThread(prior.threadKey);
  await recordThreadAddresses(prior.threadKey, ['mira@example.test'], 'message', now);
  await recordThreadMessage(
    { threadKey: prior.threadKey, side: 'outside', gmailMessageId: 'gm-mira-1', origin: 'sent' },
    now,
  );
  // Another address added by main after that earlier exchange has not been emailed yet.
  const later = new Date(Date.parse(now) + 60_000).toISOString();
  await recordThreadAddresses(prior.threadKey, ['later@example.test'], 'main', later);
  const text = await renderChatContext(chat.messaging_group_id);
  expect(text).toContain('Member whatsapp:22; verified principal: false; level: close; met before by email: true.');

  await getDb().run(
    "UPDATE gws_ea_chat_members SET email='later@example.test', email_source='main' WHERE messaging_group_id=? AND member_key='whatsapp:22'",
    chat.messaging_group_id,
  );
  expect(await renderChatContext(chat.messaging_group_id)).not.toContain('met before by email: true');
});
