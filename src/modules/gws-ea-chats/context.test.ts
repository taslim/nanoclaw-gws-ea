import fs from 'node:fs';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
const { ROOT } = vi.hoisted(() => ({ ROOT: `/tmp/gws-ea-chat-context-${process.pid}` }));
vi.mock('../../config.js', async (original) => ({
  ...(await original<typeof import('../../config.js')>()),
  DATA_DIR: ROOT,
}));
vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn(async () => true) }));
import { closeDb } from '../../db/connection.js';
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
it('writes no other chat’s context into a peer session', async () => {
  const { session } = await seedContext();
  await writeChatContext({ ...session, agent_group_id: 'peer' });
  expect(fs.existsSync(inboundDbPath('peer', session.id))).toBe(false);
});
