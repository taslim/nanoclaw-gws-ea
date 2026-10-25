import fs from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const { ROOT } = vi.hoisted(() => ({ ROOT: `/tmp/gws-ea-chat-forget-${process.pid}` }));
vi.mock('../../config.js', async (original) => ({
  ...(await original<typeof import('../../config.js')>()),
  DATA_DIR: ROOT,
}));
vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn(async () => true) }));
// The barrel's order: the chat module's forget step runs before the inbox's and the matters'.
import './index.js';
import '../gws-ea-inbox/index.js';
import { closeDb, getDb } from '../../db/connection.js';
import { GOOGLE_GRANT_FILE_ENV } from '../gws-ea-google/grant.js';
import { closeMatter, openMatter, setChatLinkAccount } from '../gws-ea-matters/db.js';
import { mattersToRewrite } from '../gws-ea-matters/forget.js';
import { addPerson, forgetPerson } from '../gws-ea-people/db.js';
import { decideJoin } from './join.js';
import { forgetFromChatRosters, setChatMemberEmail, type ChatMemberFact } from './roster.js';
import { seedContext } from './testing/context-fixture.js';

beforeEach(() => {
  fs.mkdirSync(`${ROOT}/secrets`, { recursive: true, mode: 0o700 });
  vi.stubEnv(GOOGLE_GRANT_FILE_ENV, `${ROOT}/secrets/google.json`);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await closeDb();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

async function join(platformId: string, members: readonly ChatMemberFact[]): Promise<string> {
  const chat = await decideJoin({
    channelType: 'whatsapp',
    platformId,
    name: platformId,
    isGroup: true,
    members: [{ key: 'whatsapp:11', name: 'Juno', isPrincipal: true }, ...members],
  });
  if (!chat) throw new Error('No chat');
  return chat.messaging_group_id;
}

async function linkedAccount(chat: string, text: string): Promise<string> {
  const { matter } = await openMatter({
    title: `Plans in ${chat}`,
    openLoop: 'Settle the plan',
    links: [{ kind: 'chat', reference: chat }],
  });
  await setChatLinkAccount(matter.id, chat, 'external', text);
  return matter.id;
}

async function accountsOf(chat: string) {
  return getDb().all<{ readonly account: string | null; readonly account_at: string | null }>(
    "SELECT account, account_at FROM gws_ea_matter_links WHERE kind = 'chat' AND reference = ? ORDER BY matter_id",
    chat,
  );
}

it('clears the account of every chat whose roster holds the forgotten person, in open and closed matters', async () => {
  const { chat, person, matter } = await seedContext();
  const other = await join('other@g.us', [{ key: 'whatsapp:55', name: 'Noel', isPrincipal: false }]);
  await setChatLinkAccount(matter.id, chat.messaging_group_id, 'external', 'Mira confirmed Friday.');
  const closed = await linkedAccount(chat.messaging_group_id, 'Mira booked the table.');
  await closeMatter({ id: closed, outcome: 'Dinner happened' });
  await linkedAccount(other, 'Noel picked the book.');

  await forgetPerson({ id: person.id });

  const cleared = [
    { account: null, account_at: null },
    { account: null, account_at: null },
  ];
  expect(await accountsOf(chat.messaging_group_id)).toEqual(cleared);
  expect(await accountsOf(other)).toMatchObject([{ account: 'Noel picked the book.' }]);

  // A forget re-applied after a snapshot restore runs the step again.
  await forgetFromChatRosters({ id: person.id, handles: ['whatsapp:22'] });
  expect(await accountsOf(chat.messaging_group_id)).toEqual(cleared);
});

it('finds the person on a roster row that holds them only by handle, for the review and the forget', async () => {
  const { person } = await seedContext();
  const chat = await join('handle@g.us', [{ key: 'whatsapp:22', name: 'Mira', isPrincipal: false }]);
  await getDb().run(
    "UPDATE gws_ea_chat_members SET person_id = NULL WHERE messaging_group_id = ? AND member_key = 'whatsapp:22'",
    chat,
  );
  const matter = await linkedAccount(chat, 'Mira is bringing dessert.');
  expect(await mattersToRewrite({ id: person.id, name: person.name, handles: ['whatsapp:22'] })).toContain(
    `matter ${matter}`,
  );

  await forgetPerson({ id: person.id });

  expect(await accountsOf(chat)).toEqual([{ account: null, account_at: null }]);
  expect(await getDb().all("SELECT * FROM gws_ea_chat_members WHERE member_key = 'whatsapp:22'")).toEqual([]);
});

it('finds the person on a roster row that holds them only by email, for the review and the forget', async () => {
  await seedContext();
  const remy = await addPerson({
    name: 'Remy Vance',
    level: 'known',
    source: 'principal',
    basis: 'Juno’s colleague',
    identity: 'email:remy@example.test',
  });
  const chat = await join('email@g.us', [{ key: 'whatsapp:44', name: 'Remy', isPrincipal: false }]);
  await setChatMemberEmail(chat, 'whatsapp:44', 'Remy@Example.test', 'main');
  const matter = await linkedAccount(chat, 'Remy sent the agenda.');
  expect(await mattersToRewrite({ id: remy.id, name: remy.name, handles: ['email:remy@example.test'] })).toContain(
    `matter ${matter}`,
  );

  await forgetPerson({ id: remy.id });

  expect(await accountsOf(chat)).toEqual([{ account: null, account_at: null }]);
  expect(await getDb().all("SELECT * FROM gws_ea_chat_members WHERE member_key = 'whatsapp:44'")).toEqual([]);
});
