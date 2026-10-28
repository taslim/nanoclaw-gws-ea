import { execFileSync } from 'node:child_process';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';

const ROOT = vi.hoisted(() => `/tmp/booking-runner-${process.pid}`);
vi.mock('../../config.js', async (original) => ({
  ...(await original<typeof import('../../config.js')>()),
  DATA_DIR: ROOT,
}));
vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn(async () => true) }));

import './index.js';
import '../gws-ea-preferences/index.js';
import { getDb } from '../../db/connection.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import { ANSWER_LATER } from '../../cli/delivery-action.js';
import { cleanChatDelivery, seedChatDelivery } from '../gws-ea-chats/testing/chat-delivery-fixture.js';
import { setChatMemberEmail } from '../gws-ea-chats/roster.js';
import { replacePrincipalCalendars } from '../gws-ea-inbox/db.js';
import { addPrincipalAddress } from '../gws-ea-profile/db.js';
import { createBookingTools } from './booking.js';
import { FakeCalendar } from './testing/fake-calendar.js';

const RUNNER_PROBE = String.raw`
const root = process.env.BOOKING_TEST_RUNNER_ROOT;
if (!root) throw new Error('Missing runner root');
await import(root + '/src/modules/index.ts');
const { initTestSessionDb, closeSessionDb } = await import(root + '/src/mailbox/sqlite/connection.ts');
const { runPollLoop } = await import(root + '/src/poll-loop.ts');
const { MockProvider } = await import(root + '/src/providers/mock.ts');
const rows = JSON.parse(await Bun.stdin.text());
const { inbound } = initTestSessionDb();
const insert = inbound.prepare(
  'INSERT INTO messages_in(id,seq,kind,timestamp,content,platform_id,channel_type,thread_id,trigger) VALUES(?,?,?,?,?,?,?,?,?)'
);
for (const row of rows)
  insert.run(row.id,row.seq,row.kind,row.timestamp,row.content,row.platform_id,row.channel_type,row.thread_id,row.trigger);
const prompts = [];
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 1500);
try {
  await runPollLoop({
    provider: new MockProvider({}, (prompt) => { prompts.push(prompt); controller.abort(); return ''; }),
    providerName: 'mock', cwd: root, signal: controller.signal,
  });
  process.stdout.write(JSON.stringify(prompts));
} finally {
  clearTimeout(timer);
  closeSessionDb();
}
`;

afterEach(async () => {
  vi.useRealTimers();
  await cleanChatDelivery(ROOT);
});

it('delivers an actual recovered booking outcome to the runner provider once after the tool timed out', async () => {
  vi.useFakeTimers({ now: new Date('2026-10-18T12:00:00Z'), toFake: ['Date'] });
  const { session, chat } = await seedChatDelivery();
  const principal = 'juno@example.com';
  const team = 'team@group.calendar.google.com';
  await addPrincipalAddress(principal);
  await getDb().run("UPDATE gws_ea_profile SET assistant_workspace_email='avery@example.com' WHERE singleton=1");
  await replacePrincipalCalendars([principal], new Date().toISOString());
  await setChatMemberEmail(chat.messaging_group_id, 'whatsapp:22', 'mira@example.com', 'main');
  await setChatMemberEmail(chat.messaging_group_id, 'whatsapp:11', principal, 'main');
  const calendar = new FakeCalendar();
  calendar.calendars.set(principal, { id: principal, accessRole: 'writer' });
  calendar.calendars.set(team, { id: team, dataOwner: principal, accessRole: 'writer' });
  calendar.failNext({ op: 'insert', error: new Error('Reply lost after insert'), afterApplying: true });
  const booking = createBookingTools({ calendar: () => calendar });
  expect(
    await booking.book({ start: '2026-10-20T12:00:00Z', minutes: 30, title: 'Venue visit' }, session, 'late-runner'),
  ).toBe(ANSWER_LATER);
  vi.setSystemTime(new Date('2026-10-18T12:02:01Z'));
  await booking.resumePending();
  await booking.resumePending();
  const db = new Database(inboundDbPath(session.agent_group_id, session.id), { readonly: true });
  let rows: unknown;
  try {
    rows = db
      .prepare(
        "SELECT id,seq,kind,timestamp,content,platform_id,channel_type,thread_id,trigger FROM messages_in WHERE id='action-resp-late-runner' OR id LIKE 'gws-ea-booking-answer-%' ORDER BY seq",
      )
      .all();
  } finally {
    db.close();
  }
  const output = execFileSync('bun', ['--eval', RUNNER_PROBE], {
    input: JSON.stringify(rows),
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      PATH: process.env.PATH,
      BOOKING_TEST_RUNNER_ROOT: path.resolve('container/agent-runner'),
    },
  });
  const prompts: unknown = JSON.parse(output);
  expect(prompts).toEqual([expect.stringContaining('Booking request late-runner: Booked:')]);
  expect(prompts).not.toEqual(expect.arrayContaining([expect.stringContaining('action-resp-late-runner')]));
  expect(calendar.live()).toHaveLength(1);
}, 15_000);
