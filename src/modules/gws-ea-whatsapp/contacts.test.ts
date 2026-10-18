import fs from 'node:fs';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  DATA_DIR: '/tmp/nanoclaw-wa-u2-contacts',
  GROUPS_DIR: '/tmp/nanoclaw-wa-u2-contacts/groups',
}));
vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn(async () => true) }));

import { getDb, runMigrations } from '../../db/index.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import { mainSession, seedMain } from '../gws-ea-matters/testing/main-conversation.js';
import { gwsEaProfileMigration } from '../gws-ea-profile/migration.js';

import { incoming } from './testing/fake-socket.js';
import { registerWhatsAppObserver } from './observers.js';
import { WhatsAppIndex } from './index-store.js';
import { transportHarness, type TransportHarness } from './testing/harness.js';

let h: TransportHarness;
beforeEach(async () => {
  fs.rmSync('/tmp/nanoclaw-wa-u2-contacts', { recursive: true, force: true });
  h = await transportHarness();
  await runMigrations(getDb(), [gwsEaProfileMigration]);
});
afterEach(async () => {
  await h.close();
  fs.rmSync('/tmp/nanoclaw-wa-u2-contacts', { recursive: true, force: true });
});
const message = { kind: 'chat', content: { text: 'Hello there' } };

describe('first-contact enforcement through the production WhatsApp adapter', () => {
  it('refuses the sixth new person before socket handoff while existing-group replies still send', async () => {
    const adapter = await h.start();
    for (let person = 1; person <= 5; person++)
      await adapter.deliver(`${person}@lid`, null, message, `person-${person}`);
    await expect(adapter.deliver('6@lid', null, message, 'sixth')).rejects.toMatchObject({
      guardId: 'gws-ea-whatsapp:contact-cap',
    });
    await adapter.deliver('team@g.us', null, message, 'group-reply');
    expect(h.socket().sends.map(({ jid }) => jid)).toEqual(['1@lid', '2@lid', '3@lid', '4@lid', '5@lid', 'team@g.us']);
  });
  it('persists an asynchronous 463 after row completion and blocks followups and reminders after restart', async () => {
    const adapter = await h.start();
    const id = await adapter.deliver('12000@lid', null, message, 'first');
    adapter.completeDelivery('first');
    await h.socket().emit('messages.update', [
      {
        key: { remoteJid: '12000@lid', fromMe: true, id: id ?? undefined },
        update: { status: 0, messageStubParameters: ['463'] },
      },
    ]);
    await adapter.teardown();
    const fresh = await h.start();
    for (const row of ['followup', 'fired-reminder'])
      await expect(fresh.deliver('12000@lid', null, message, row)).rejects.toMatchObject({
        guardId: 'gws-ea-whatsapp:contact-refused',
      });
    expect(h.socket().sends).toEqual([]);
  });
  it('keeps the time-lock through restart and permits an existing group while it holds', async () => {
    const adapter = await h.start();
    await h.socket().emit('connection.update', {
      reachoutTimeLock: { isActive: true, timeEnforcementEnds: new Date(h.now.value + 60_000) },
    });
    await adapter.teardown();
    const fresh = await h.start();
    await expect(fresh.deliver('1@lid', null, message, 'locked')).rejects.toMatchObject({
      guardId: 'gws-ea-whatsapp:contact-time-lock',
    });
    await fresh.deliver('team@g.us', null, message, 'group');
    h.now.value += 60_001;
    await fresh.deliver('1@lid', null, message, 'unlocked');
    expect(h.socket().sends.map(({ jid }) => jid)).toEqual(['team@g.us', '1@lid']);
  });
  it('does not mistake group participation for a 1:1 reply', async () => {
    const adapter = await h.start();
    await h.socket().emit('messages.upsert', { type: 'notify', messages: [incoming('group')] });
    for (let person = 1; person <= 5; person++) await adapter.deliver(`${person}@lid`, null, message, `new-${person}`);
    await expect(adapter.deliver('12000@lid', null, message, 'group-person')).rejects.toMatchObject({
      guardId: 'gws-ea-whatsapp:contact-cap',
    });
    await h.socket().emit('messages.upsert', {
      type: 'notify',
      messages: [incoming('direct', 'Yes', { key: { id: 'direct', remoteJid: '12000@lid' } })],
    });
    await adapter.deliver('12000@lid', null, message, 'direct-person');
    expect(h.socket().sends.at(-1)?.jid).toBe('12000@lid');
  });
});

it('serializes simultaneous first contacts at the rolling cap and opens the next window at exactly 24 hours', async () => {
  const adapter = await h.start();
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, (_, index) => adapter.deliver(`${index + 1}@lid`, null, message, `parallel-${index}`)),
  );
  expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(5);
  expect(h.socket().sends).toHaveLength(5);
  h.now.value += 24 * 60 * 60 * 1000;
  await adapter.deliver('20@lid', null, message, 'tomorrow');
  expect(h.socket().sends.at(-1)?.jid).toBe('20@lid');
});

it('keeps the same-number ledger but starts a different linked number with no contacts, lock or refusals', async () => {
  const adapter = await h.start();
  for (let person = 1; person <= 5; person++) await adapter.deliver(`${person}@lid`, null, message, `old-${person}`);
  await h.socket().emit('connection.update', {
    reachoutTimeLock: { isActive: true, timeEnforcementEnds: new Date(h.now.value + 60_000) },
  });
  await adapter.teardown();
  const same = await h.start();
  await expect(same.deliver('6@lid', null, message, 'same')).rejects.toMatchObject({
    guardId: 'gws-ea-whatsapp:contact-time-lock',
  });
  await same.teardown();
  const different = await h.start({}, false);
  h.socket().user.id = '15559999999:1@s.whatsapp.net';
  h.socket().user.lid = '777000:1@lid';
  await h.socket().emit('connection.update', { connection: 'open' });
  await different.deliver('6@lid', null, message, 'different');
  expect(h.socket().sends).toHaveLength(1);
});

it('allows only a fresh admitted principal request after a 463 expiry; ordinary reminders stay stopped', async () => {
  const adapter = await h.start();
  h.socket().sendError = Object.assign(new Error('refused'), { output: { statusCode: 463 } });
  await expect(
    adapter.reachOutDM({ lid: '12000' }, message, { requestId: 'first-request', principalMessageId: 'own-first' }),
  ).rejects.toMatchObject({ guardId: 'gws-ea-whatsapp:contact-refused' });
  h.socket().sendError = undefined;
  await expect(
    adapter.reachOutDM({ lid: '12000' }, message, { requestId: 'soon-request', principalMessageId: 'own-too-soon' }),
  ).rejects.toMatchObject({ guardId: 'gws-ea-whatsapp:contact-refused' });
  h.now.value += 24 * 60 * 60 * 1000 + 1;
  await expect(adapter.deliver('12000@lid', null, message, 'late-reminder')).rejects.toMatchObject({
    guardId: 'gws-ea-whatsapp:contact-refused',
  });
  await adapter.reachOutDM({ lid: '12000' }, message, { requestId: 'fresh-request', principalMessageId: 'own-fresh' });
  expect(h.socket().sends).toHaveLength(2);
});

it('ends first-contact restrictions on a real 1:1 reply but never reissues the refused original operation', async () => {
  const adapter = await h.start();
  h.socket().sendError = Object.assign(new Error('refused'), { output: { statusCode: 463 } });
  await expect(adapter.deliver('12000@lid', null, message, 'refused-original')).rejects.toMatchObject({
    guardId: 'gws-ea-whatsapp:contact-refused',
  });
  h.socket().sendError = undefined;
  await h.socket().emit('messages.upsert', {
    type: 'notify',
    messages: [incoming('reply', 'Hello', { key: { id: 'reply', remoteJid: '12000@lid' } })],
  });
  await h.socket().emit('connection.update', {
    reachoutTimeLock: { isActive: true, timeEnforcementEnds: new Date(h.now.value + 60_000) },
  });
  await adapter.deliver('12000@lid', null, message, 'legitimate-reply');
  await expect(adapter.deliver('12000@lid', null, message, 'refused-original')).rejects.toMatchObject({
    guardId: 'gws-ea-whatsapp:contact-refused',
  });
  expect(h.socket().sends).toHaveLength(2);
});

it('delivers each 463 outcome to main through its real note writer, including a notice deferred across restart', async () => {
  const adapter = await h.start();
  h.socket().sendError = Object.assign(new Error('refused'), { output: { statusCode: 463 } });
  await expect(adapter.deliver('12000@lid', null, message, 'note-refusal')).rejects.toMatchObject({
    guardId: 'gws-ea-whatsapp:contact-refused',
  });
  await adapter.teardown();
  await seedMain('America/Los_Angeles');
  const fresh = await h.start();
  await fresh.reconnect();
  await h.socket().emit('connection.update', { connection: 'open' });
  const session = await mainSession();
  const database = new Database(inboundDbPath(session.agent_group_id, session.id), { readonly: true });
  try {
    const notes = database.prepare("SELECT content FROM messages_in WHERE kind='chat'").all() as { content: string }[];
    expect(notes).toHaveLength(1);
    expect(notes[0].content).toContain('WhatsApp error 463');
    expect(notes[0].content).toContain('whatsapp:12000');
    expect(notes[0].content).toContain('Do not retry');
  } finally {
    database.close();
  }
});

it('withholds refused DM bodies from native Baileys retry requests while existing-group retries remain available', async () => {
  const adapter = await h.start();
  const id = await adapter.deliver('12000@lid', null, message, 'retry-refused');
  const groupId = await adapter.deliver('team@g.us', null, message, 'retry-group');
  if (!id || !groupId) throw new Error('Expected native message ids');
  await h
    .socket()
    .emit('messages.update', [
      { key: { remoteJid: '12000@lid', fromMe: true, id }, update: { status: 0, messageStubParameters: ['463'] } },
    ]);
  expect(await h.socketConfigs[0].getMessage?.({ remoteJid: '12000@lid', id })).toBeUndefined();
  expect(await h.socketConfigs[0].getMessage?.({ remoteJid: 'team@g.us', id: groupId })).toEqual({
    conversation: 'Hello there',
  });
  expect(h.socketConfigs[0].enableRecentMessageCache).toBe(false);
});

it('records a consumed binding DM and a durably replayed DM as real 1:1 replies', async () => {
  const adapter = await h.start();
  for (let person = 1; person <= 5; person++)
    await adapter.deliver(`${person}@lid`, null, message, `reply-cap-${person}`);
  const unregister = registerWhatsAppObserver({ onMessage: async () => 'consume' });
  try {
    await h.socket().emit('messages.upsert', {
      type: 'notify',
      messages: [incoming('binding', 'A claim', { key: { id: 'binding', remoteJid: '12000@lid' } })],
    });
    expect(h.messages()).toEqual([]);
  } finally {
    unregister();
  }
  await adapter.deliver('12000@lid', null, message, 'consumed-known');
  const index = new WhatsAppIndex(h.directory, () => '15550000000@s.whatsapp.net');
  index.intake(incoming('replayed-direct', 'Hello', { key: { id: 'replayed-direct', remoteJid: '13000@lid' } }));
  index.close();
  await adapter.teardown();
  const fresh = await h.start();
  expect(h.messages().map(({ id }) => id)).toContain('replayed-direct');
  await fresh.deliver('13000@lid', null, message, 'replayed-known');
  expect(h.socket().sends.map(({ jid }) => jid)).toEqual(['13000@lid']);
});

it('serves only this account own DM bodies to native retry requests and rechecks a newly imposed time-lock', async () => {
  const adapter = await h.start();
  const id = await adapter.deliver('12000@lid', null, message, 'retry-ordinary');
  if (!id) throw new Error('Expected native message id');
  const retry = h.socketConfigs[0].getMessage;
  expect(await retry?.({ remoteJid: '12000@lid', id })).toEqual({ conversation: 'Hello there' });
  await h.socket().emit('messages.upsert', { type: 'notify', messages: [incoming('foreign-body')] });
  expect(await retry?.({ remoteJid: 'team@g.us', id: 'foreign-body' })).toBeUndefined();
  expect(await retry?.({ remoteJid: 'team@g.us', id: 'unknown' })).toBeUndefined();
  await h.socket().emit('connection.update', {
    reachoutTimeLock: { isActive: true, timeEnforcementEnds: new Date(h.now.value + 60_000) },
  });
  expect(await retry?.({ remoteJid: '12000@lid', id })).toBeUndefined();
});

it('shares cap reservations across independent transport instances using the same linked account', async () => {
  const first = await h.start();
  const second = await h.start();
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, (_, index) =>
      (index % 2 ? first : second).deliver(`${index + 1}@lid`, null, message, `cross-instance-${index}`),
    ),
  );
  expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(5);
  expect(h.sockets.reduce((total, socket) => total + socket.sends.length, 0)).toBe(5);
});

it('does not carry an old number 1:1 reply into a different linked number', async () => {
  const first = await h.start();
  await h.socket().emit('messages.upsert', {
    type: 'notify',
    messages: [incoming('old-number-reply', 'Hi', { key: { id: 'old-number-reply', remoteJid: '12000@lid' } })],
  });
  await first.teardown();
  const fresh = await h.start({}, false);
  h.socket().user.id = '15559999999:1@s.whatsapp.net';
  h.socket().user.lid = '777000:1@lid';
  await h.socket().emit('connection.update', { connection: 'open' });
  for (let person = 1; person <= 5; person++)
    await fresh.deliver(`${person}@lid`, null, message, `new-number-${person}`);
  await expect(fresh.deliver('12000@lid', null, message, 'old-reply-new-contact')).rejects.toMatchObject({
    guardId: 'gws-ea-whatsapp:contact-cap',
  });
});
