import { afterEach, beforeEach, expect, it } from 'vitest';
import { dispatch } from '../../cli/dispatch.js';
import type { CallerContext } from '../../cli/frame.js';
import { ensureContainerConfig, updateContainerConfigScalars } from '../../db/container-configs.js';
import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import '../gws-ea-profile/index.js';
import '../gws-ea-people/index.js';
import '../gws-ea-privacy/index.js';
import '../gws-ea-whereabouts/index.js';
import { addPerson } from '../gws-ea-people/db.js';
import { addPrivateValue } from '../gws-ea-privacy/db.js';
import { addPlace } from '../gws-ea-whereabouts/db.js';
import './index.js';

const caller = (id: string): CallerContext => ({
  caller: 'agent',
  sessionId: 'session',
  agentGroupId: id,
  messagingGroupId: 'dm',
});
const run = (command: string, args: Record<string, unknown> = {}, id = 'main') =>
  dispatch({ id: command, command, args }, caller(id));
beforeEach(async () => {
  await runMigrations(await initTestDb());
  for (const id of ['main', 'other']) {
    await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: '2026-10-28T12:00:00Z' });
    await ensureContainerConfig(id);
    await updateContainerConfigScalars(id, { cli_scope: 'global' });
  }
  await getDb().run(
    "UPDATE gws_ea_profile SET assistant_first_name='Remy', main_agent_group_id='main', principal_first_name='Morgan', principal_last_name='Ellery' WHERE singleton=1",
  );
  await addPrivateValue({ label: 'Home', kind: 'address', value: '18 Linden Road, Brookhaven' });
  await addPerson({
    name: 'Juno Hale',
    level: 'inner-circle',
    source: 'principal',
    basis: 'Sibling.',
    identity: 'email:juno@example.test',
  });
  for (const [id, label] of [
    ['home', 'Home'],
    ['office', 'Office'],
  ])
    await addPlace({ id, label, locality: 'Brookhaven', zone: 'America/New_York' });
});
afterEach(closeDb);
it.each([
  ['Leave enough time from 18 Linden Rd.', 'private address', '18 Linden'],
  ['Morgan prefers a pause.', 'principal’s name', 'Morgan'],
  ['Ellery needs a pause.', 'principal’s name', 'Ellery'],
  ['M&#111;rgan prefers a pause.', 'principal’s name', 'M&#111;'],
  ['Ask remy%40example.test first.', 'email address', 'remy%40'],
  ['Brookhaven needs more travel time.', 'whereabouts place', 'Brookhaven'],
  ['Juno Hale prefers a pause.', 'person’s name', 'Juno'],
  ['Ask remy@example.test first.', 'email address', 'remy@'],
  ['Call +1 (415) 555-0123 first.', 'phone number', '555'],
])('refuses private craft without repeating its value: %s', async (text, kind, secret) => {
  const response = await run('lessons-add', { text });
  expect(response).toMatchObject({ ok: false, error: { message: expect.stringContaining(kind) } });
  expect(JSON.stringify(response)).not.toContain(secret);
  expect(await getDb().all('SELECT * FROM gws_ea_lessons')).toEqual([]);
});
it('accepts craft that uses a place label or a word of a person’s name as an ordinary word', async () => {
  await addPerson({
    name: 'Will Vance',
    level: 'inner-circle',
    source: 'principal',
    basis: 'Neighbor.',
    identity: 'email:will@example.test',
  });
  for (const text of [
    'A one-way flight leaves the return home unknown.',
    'Check the office commute before an early start.',
    'Ask who will join before booking a table.',
  ])
    expect(await run('lessons-add', { text })).toMatchObject({ ok: true, data: { added: true } });
});
it('stores exact repeats once and lists their review status', async () => {
  expect(await run('lessons-add', { text: 'Read the whole day before changing a meeting.' })).toMatchObject({
    ok: true,
    data: { added: true, status: 'queued' },
  });
  expect(await run('lessons-add', { text: 'Read the whole day before changing a meeting.' })).toMatchObject({
    ok: true,
    data: { added: false, status: 'queued' },
  });
  expect(await run('lessons-list')).toMatchObject({
    ok: true,
    data: [{ text: 'Read the whole day before changing a meeting.', status: 'queued' }],
  });
});
it('requires canonical main even for an agent with global CLI access', async () => {
  for (const command of ['lessons-add', 'lessons-list'])
    expect(
      await run(command, command.endsWith('add') ? { text: 'Keep the day coherent.' } : {}, 'other'),
    ).toMatchObject({ ok: false, error: { message: expect.stringMatching(/only.*main/iu) } });
});
it('does not return a private database failure to the model', async () => {
  await getDb().exec('DROP TABLE gws_ea_lessons');
  expect(await run('lessons-list')).toMatchObject({
    ok: false,
    error: { message: 'Lessons are unavailable just now.' },
  });
});
