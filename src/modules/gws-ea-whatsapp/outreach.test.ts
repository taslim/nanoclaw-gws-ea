import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getDb, runMigrations, createMessagingGroup } from '../../db/index.js';
import { addPrivateValue } from '../gws-ea-privacy/db.js';
import { gwsEaPrivacyMigration } from '../gws-ea-privacy/migration.js';
import { bindVerifiedPrincipalUser } from '../gws-ea-profile/db.js';
import { gwsEaProfileMigration } from '../gws-ea-profile/migration.js';
import { upsertUserDm } from '../permissions/db/user-dms.js';
import { upsertUser } from '../permissions/db/users.js';
import { transportHarness, type TransportHarness } from './testing/harness.js';

let h: TransportHarness;
beforeEach(async () => {
  h = await transportHarness();
});
afterEach(async () => {
  await h.close();
});
const request = { requestId: 'native-request', principalMessageId: 'principal-own-request' };
const person = { lid: '12000', phoneJid: '15551112222@s.whatsapp.net' };

describe('native WhatsApp outreach', () => {
  it('checks registration before resolving a new number through the LID USync boundary', async () => {
    const adapter = await h.start();
    h.socket().usync.set(person.phoneJid, '12000@lid');
    expect(await adapter.resolveNumber('+15551112222')).toEqual(person);
    expect(h.socket().numberQueries).toEqual(['15551112222@s.whatsapp.net']);
    expect(h.socket().lookups).toEqual(['15551112222@s.whatsapp.net']);
  });
  it('uses the per-person add response invite, counts it once, and never sends a reusable group link', async () => {
    const adapter = await h.start();
    h.socket().groups.set('team@g.us', { id: 'team@g.us', owner: undefined, subject: 'Dinner', participants: [] });
    h.socket().addResults.set('12000@lid', {
      jid: '12000@lid',
      status: '403',
      content: {
        tag: 'participant',
        attrs: { jid: '12000@lid', error: '403' },
        content: [{ tag: 'add_request', attrs: { code: 'person-only-invite', expiration: '1792411200' } }],
      },
    });
    expect(await adapter.addParticipant('team@g.us', person, request)).toBe('invited');
    expect(h.socket().sends).toHaveLength(1);
    expect(h.socket().sends[0]).toMatchObject({
      jid: '12000@lid',
      content: { groupInvite: { inviteCode: 'person-only-invite', jid: 'team@g.us', subject: 'Dinner' } },
    });
    for (let number = 1; number <= 4; number++)
      await adapter.deliver(`${number}@lid`, null, { kind: 'chat', content: { text: 'Hi' } }, `contact-${number}`);
    await expect(
      adapter.deliver('5@lid', null, { kind: 'chat', content: { text: 'Hi' } }, 'sixth'),
    ).rejects.toMatchObject({ guardId: 'gws-ea-whatsapp:contact-cap' });
    expect(await adapter.addParticipant('team@g.us', person, request)).toBe('invited');
    expect(h.socket().participantUpdates).toHaveLength(1);
  });
});

it('does not look up a LID when WhatsApp says a number is unregistered', async () => {
  const adapter = await h.start();
  h.socket().registered.set(person.phoneJid, false);
  expect(await adapter.resolveNumber('+15551112222')).toBeUndefined();
  expect(h.socket().lookups).toEqual([]);
});

it('creates a group with the bound principal, adds requested people and returns the same group without duplicate native side effects', async () => {
  await h.writeLink({ schema_version: 1, state: 'connected', principal: { lid: '11000' } });
  const adapter = await h.start();
  expect(await adapter.createGroup('Dinner', [person], request)).toEqual({
    platformId: 'created-1@g.us',
    participants: [
      { person: { lid: '11000' }, outcome: 'added' },
      { person, outcome: 'added' },
    ],
  });
  await adapter.createGroup('Dinner', [person], request);
  expect(h.socket().createdGroups).toEqual([{ subject: 'Dinner', participants: ['11000@lid'] }]);
  expect(h.socket().participantUpdates).toEqual([
    { jid: 'created-1@g.us', participants: ['12000@lid'], action: 'add' },
  ]);
});

it('creates distinct groups for distinct tool requests citing the same principal message', async () => {
  await h.writeLink({ schema_version: 1, state: 'connected', principal: { lid: '11000' } });
  const adapter = await h.start();
  const first = await adapter.createGroup('Dinner', [person], { ...request, requestId: 'dinner-request' });
  const second = await adapter.createGroup('Venue', [person], { ...request, requestId: 'venue-request' });
  expect([first.platformId, second.platformId]).toEqual(['created-1@g.us', 'created-2@g.us']);
  expect(h.socket().createdGroups.map(({ subject }) => subject)).toEqual(['Dinner', 'Venue']);
});

it('defers an admitted DM to the real outbound row and never lends a fresh post-refusal citation to an old row', async () => {
  const adapter = await h.start();
  expect(
    await adapter.prepareReachOutDM(person, { requestId: 'first-request', principalMessageId: 'own-first' }),
  ).toEqual({ platformId: '12000@lid' });
  expect(h.socket().sends).toEqual([]);
  h.socket().sendError = Object.assign(new Error('refused'), { output: { statusCode: 463 } });
  await expect(
    adapter.deliver('12000@lid', null, { kind: 'chat', content: { text: 'Hello' } }, 'first-row'),
  ).rejects.toMatchObject({ guardId: 'gws-ea-whatsapp:contact-refused' });
  h.socket().sendError = undefined;
  h.now.value += 24 * 60 * 60 * 1000 + 1;
  await expect(
    adapter.deliver('12000@lid', null, { kind: 'chat', content: { text: 'Old reminder' } }, 'old-reminder'),
  ).rejects.toMatchObject({ guardId: 'gws-ea-whatsapp:contact-refused' });
  await adapter.teardown();
  const offline = await h.start({}, false);
  await expect(
    offline.deliver('12000@lid', null, { kind: 'chat', content: { text: 'Offline reminder' } }, 'offline-reminder'),
  ).rejects.toMatchObject({ name: 'ChannelNotConnectedError' });
  h.now.value += 1;
  await h.socket().emit('connection.update', { connection: 'open' });
  await offline.prepareReachOutDM(person, { requestId: 'fresh-request', principalMessageId: 'own-fresh' });
  await offline.teardown();
  const fresh = await h.start();
  await expect(
    fresh.deliver('12000@lid', null, { kind: 'chat', content: { text: 'Hello' } }, 'first-row'),
  ).rejects.toMatchObject({ guardId: 'gws-ea-whatsapp:contact-refused' });
  await expect(
    fresh.deliver('12000@lid', null, { kind: 'chat', content: { text: 'Offline reminder' } }, 'offline-reminder'),
  ).rejects.toMatchObject({ guardId: 'gws-ea-whatsapp:contact-refused' });
  await expect(
    fresh.deliver('12000@lid', null, { kind: 'chat', content: { text: 'Old reminder' } }, 'old-reminder'),
  ).rejects.toMatchObject({ guardId: 'gws-ea-whatsapp:contact-refused' });
  await expect(
    fresh.deliver(
      '12000@lid',
      null,
      {
        kind: 'chat',
        timestamp: new Date(h.now.value - 1).toISOString(),
        content: { text: 'Queued before the new request' },
      },
      'older-queued-row',
    ),
  ).rejects.toMatchObject({ guardId: 'gws-ea-whatsapp:contact-refused' });
  await fresh.deliver('12000@lid', null, { kind: 'chat', content: { text: 'A newly requested hello' } }, 'fresh-row');
  await expect(
    fresh.deliver('12000@lid', null, { kind: 'chat', content: { text: 'Unrelated reminder' } }, 'unrelated-row'),
  ).rejects.toMatchObject({ guardId: 'gws-ea-whatsapp:contact-refused' });
  expect(h.socket().sends).toHaveLength(1);
});

it('checks cap and time-lock before group creation, participant adds and per-person invitation handoff', async () => {
  await h.writeLink({ schema_version: 1, state: 'connected', principal: { lid: '11000' } });
  const adapter = await h.start();
  h.socket().groups.set('team@g.us', { id: 'team@g.us', owner: undefined, subject: 'Dinner', participants: [] });
  for (let number = 1; number <= 5; number++)
    await adapter.deliver(`${number}@lid`, null, { kind: 'chat', content: { text: 'Hi' } }, `new-${number}`);
  await expect(adapter.createGroup('Dinner', [person], request)).rejects.toMatchObject({
    guardId: 'gws-ea-whatsapp:contact-cap',
  });
  await expect(adapter.addParticipant('team@g.us', person, request)).rejects.toMatchObject({
    guardId: 'gws-ea-whatsapp:contact-cap',
  });
  expect(h.socket().createdGroups).toEqual([]);
  expect(h.socket().participantUpdates).toEqual([]);
  h.now.value += 24 * 60 * 60 * 1000;
  const lock = { reachoutTimeLock: { isActive: true, timeEnforcementEnds: new Date(h.now.value + 60_000) } };
  await h.socket().emit('connection.update', lock);
  await expect(adapter.createGroup('Dinner', [person], request)).rejects.toMatchObject({
    guardId: 'gws-ea-whatsapp:contact-time-lock',
  });
  await expect(adapter.addParticipant('team@g.us', person, request)).rejects.toMatchObject({
    guardId: 'gws-ea-whatsapp:contact-time-lock',
  });
  await h.socket().emit('connection.update', { reachoutTimeLock: { isActive: false } });
  h.socket().groups.set('team@g.us', { id: 'team@g.us', owner: undefined, subject: 'Dinner', participants: [] });
  const original = h.socket().groupParticipantsUpdate.bind(h.socket());
  h.socket().addResults.set('12000@lid', {
    jid: '12000@lid',
    status: '403',
    content: {
      tag: 'participant',
      attrs: { jid: '12000@lid' },
      content: [
        {
          tag: 'add_request',
          attrs: { code: 'per-person', expiration: String(Math.floor(h.now.value / 1000) + 3600) },
        },
      ],
    },
  });
  h.socket().groupParticipantsUpdate = async (...args) => {
    const result = await original(...args);
    await h.socket().emit('connection.update', lock);
    return result;
  };
  await expect(
    adapter.addParticipant('team@g.us', person, { requestId: 'after-lock-request', principalMessageId: 'after-lock' }),
  ).rejects.toMatchObject({ guardId: 'gws-ea-whatsapp:contact-time-lock' });
  expect(h.socket().sends).toHaveLength(5);
});

it('verifies the principal actually joined after create and sends their own privacy invitation when absent', async () => {
  await h.writeLink({ schema_version: 1, state: 'connected', principal: { lid: '11000' } });
  const adapter = await h.start();
  const original = h.socket().groupCreate.bind(h.socket());
  h.socket().groupCreate = async (...args) => {
    const group = await original(...args);
    const withoutPrincipal = { ...group, participants: group.participants.filter(({ id }) => id !== '11000@lid') };
    h.socket().groups.set(group.id, withoutPrincipal);
    return withoutPrincipal;
  };
  h.socket().addResults.set('11000@lid', {
    jid: '11000@lid',
    status: '403',
    content: {
      tag: 'participant',
      attrs: { jid: '11000@lid' },
      content: [
        {
          tag: 'add_request',
          attrs: { code: 'principal-only', expiration: String(Math.floor(h.now.value / 1000) + 3600) },
        },
      ],
    },
  });
  expect((await adapter.createGroup('Dinner', [person], request)).participants).toEqual([
    { person: { lid: '11000' }, outcome: 'invited' },
    { person, outcome: 'added' },
  ]);
  expect(h.socket().sends[0]).toMatchObject({
    jid: '11000@lid',
    content: { groupInvite: { inviteCode: 'principal-only' } },
  });
});

it('never repeats a group create whose socket handoff was ambiguous', async () => {
  await h.writeLink({ schema_version: 1, state: 'connected', principal: { lid: '11000' } });
  const adapter = await h.start();
  const original = h.socket().groupCreate.bind(h.socket());
  h.socket().groupCreate = async (...args) => {
    await original(...args);
    throw new Error('connection lost after create');
  };
  await expect(adapter.createGroup('Dinner', [person], request)).rejects.toThrow('connection lost');
  await expect(adapter.createGroup('Dinner', [person], request)).rejects.toMatchObject({
    guardId: 'gws-ea-whatsapp:outreach-unconfirmed',
  });
  expect(h.socket().createdGroups).toHaveLength(1);
});

it('refuses a private group subject before creating the group or reserving first contacts', async () => {
  await runMigrations(getDb(), [gwsEaPrivacyMigration]);
  await addPrivateValue({ label: 'Home', kind: 'address', value: '123 Hidden Street' });
  await h.writeLink({ schema_version: 1, state: 'connected', principal: { lid: '11000' } });
  const adapter = await h.start();
  await expect(adapter.createGroup('Dinner at 123 Hidden Street', [person], request)).rejects.toMatchObject({
    guardId: 'gws-ea-privacy:audience',
  });
  expect(h.socket().createdGroups).toEqual([]);
  for (let number = 1; number <= 5; number++)
    await adapter.deliver(
      `${number}@lid`,
      null,
      { kind: 'chat', content: { text: 'Hi' } },
      `privacy-not-counted-${number}`,
    );
});

it('checks the freshly read per-person invite subject before handing it to a nonmember', async () => {
  await runMigrations(getDb(), [gwsEaPrivacyMigration]);
  await addPrivateValue({ label: 'Home', kind: 'address', value: '123 Hidden Street' });
  const adapter = await h.start();
  h.socket().groups.set('team@g.us', { id: 'team@g.us', owner: undefined, subject: 'Dinner', participants: [] });
  h.socket().addResults.set('12000@lid', {
    jid: '12000@lid',
    status: '403',
    content: {
      tag: 'participant',
      attrs: { jid: '12000@lid' },
      content: [
        {
          tag: 'add_request',
          attrs: { code: 'person-only', expiration: String(Math.floor(h.now.value / 1000) + 3600) },
        },
      ],
    },
  });
  const original = h.socket().groupParticipantsUpdate.bind(h.socket());
  h.socket().groupParticipantsUpdate = async (...args) => {
    const result = await original(...args);
    h.socket().groups.set('team@g.us', {
      id: 'team@g.us',
      owner: undefined,
      subject: 'Dinner at 123 Hidden Street',
      participants: [],
    });
    return result;
  };
  await expect(adapter.addParticipant('team@g.us', person, request)).rejects.toMatchObject({
    guardId: 'gws-ea-privacy:audience',
  });
  expect(h.socket().sends).toEqual([]);
});

it('admits the full direct outreach message and text attachments through the normal private-value check', async () => {
  await runMigrations(getDb(), [gwsEaPrivacyMigration]);
  await addPrivateValue({ label: 'Home', kind: 'address', value: '123 Hidden Street' });
  const adapter = await h.start();
  const messages = [
    { kind: 'chat', content: { text: 'Meet at 123 Hidden Street' } },
    {
      kind: 'chat',
      content: { text: 'Notes' },
      files: [{ filename: '123 Hidden Street.txt', data: Buffer.from('Notes'), mimeType: 'text/plain' }],
    },
    {
      kind: 'chat',
      content: { text: 'Notes' },
      files: [{ filename: 'notes.txt', data: Buffer.from('123 Hidden Street'), mimeType: 'text/plain' }],
    },
  ];
  for (const [index, message] of messages.entries())
    await expect(
      adapter.reachOutDM(person, message, {
        requestId: `private-request-${index}`,
        principalMessageId: `private-${index}`,
      }),
    ).rejects.toMatchObject({ guardId: 'gws-ea-privacy:audience' });
  expect(h.socket().sends).toEqual([]);
});

it('checks a current private group subject before adding a new member who would see it', async () => {
  await runMigrations(getDb(), [gwsEaPrivacyMigration]);
  await addPrivateValue({ label: 'Home', kind: 'address', value: '123 Hidden Street' });
  const adapter = await h.start();
  h.socket().groups.set('team@g.us', {
    id: 'team@g.us',
    owner: undefined,
    subject: 'Dinner at 123 Hidden Street',
    participants: [],
  });
  await expect(adapter.addParticipant('team@g.us', person, request)).rejects.toMatchObject({
    guardId: 'gws-ea-privacy:audience',
  });
  expect(h.socket().participantUpdates).toEqual([]);
});

it('keeps normal privacy admission of a verified principal DM for direct outreach', async () => {
  await runMigrations(getDb(), [gwsEaPrivacyMigration, gwsEaProfileMigration]);
  await addPrivateValue({ label: 'Home', kind: 'address', value: '123 Hidden Street' });
  const at = new Date().toISOString();
  await createMessagingGroup({
    id: 'principal-wa-dm',
    channel_type: 'whatsapp',
    platform_id: '12000@lid',
    name: null,
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: at,
  });
  await upsertUser({ id: 'whatsapp:12000', kind: 'whatsapp', display_name: 'Principal', created_at: at });
  await bindVerifiedPrincipalUser('whatsapp:12000', at);
  await upsertUserDm({
    user_id: 'whatsapp:12000',
    channel_type: 'whatsapp',
    messaging_group_id: 'principal-wa-dm',
    resolved_at: at,
  });
  const adapter = await h.start();
  await adapter.reachOutDM(person, { kind: 'chat', content: { text: '123 Hidden Street' } }, request);
  expect(h.socket().sends[0]).toMatchObject({ jid: '12000@lid', content: { text: '123 Hidden Street' } });
});
