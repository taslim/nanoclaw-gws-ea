import fs from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
const { ROOT } = vi.hoisted(() => ({ ROOT: `/tmp/gws-ea-chat-directory-${process.pid}` }));
vi.mock('../../config.js', async (original) => ({
  ...(await original<typeof import('../../config.js')>()),
  DATA_DIR: ROOT,
}));
import { closeDb } from '../../db/connection.js';
import { lookup } from '../../cli/registry.js';
import { seedContext } from './testing/context-fixture.js';
afterEach(async () => {
  await closeDb();
  fs.rmSync(ROOT, { recursive: true, force: true });
});
it('lists framed chat names and members with matter keys only to canonical main', async () => {
  const { chat, matter } = await seedContext();
  const command = lookup('chats-list');
  if (!command) throw new Error('Missing registered directory');
  for (const agentGroupId of ['external', 'peer'])
    await expect(
      command.handler(command.parseArgs({}), {
        caller: 'agent',
        agentGroupId,
        sessionId: 'caller',
        messagingGroupId: chat.messaging_group_id,
      }),
    ).rejects.toThrow(/only to main/);
  const rendered = await command.handler(command.parseArgs({}), {
    caller: 'agent',
    agentGroupId: 'main',
    sessionId: 'main-session',
    messagingGroupId: 'principal-dm',
  });
  expect(rendered).toEqual([expect.stringContaining(chat.messaging_group_id)]);
  expect(JSON.stringify(rendered)).toContain(matter.id);
  expect(JSON.stringify(rendered)).toContain('EXTERNAL_UNTRUSTED_CONTENT');
  const get = lookup('chats-get');
  if (!get) throw new Error('Missing registered chat get');
  expect(
    await get.handler(get.parseArgs({ id: chat.messaging_group_id }), {
      caller: 'agent',
      agentGroupId: 'main',
      sessionId: 'main-session',
      messagingGroupId: 'principal-dm',
    }),
  ).toEqual([expect.stringContaining(chat.messaging_group_id)]);
});
