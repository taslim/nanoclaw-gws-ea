import { afterEach, beforeEach, expect, it } from 'vitest';

import { registerWhatsAppObserver } from './observers.js';
import { transportHarness, type TransportHarness } from './testing/harness.js';

let h: TransportHarness;
let unregister: (() => void) | undefined;
beforeEach(async () => {
  h = await transportHarness();
});
afterEach(async () => {
  unregister?.();
  await h.close();
});
it('reports a silent group join with resolved people and author through the production event listener', async () => {
  const events: unknown[] = [];
  unregister = registerWhatsAppObserver({
    onMembership: async (event) => {
      events.push(event);
    },
  });
  await h.start();
  h.socket().mappings.set('12000@lid', '15551112222@s.whatsapp.net');
  await h.socket().emit('groups.upsert', [
    {
      id: 'team@g.us',
      subject: 'Dinner',
      owner: undefined,
      author: '15551112222@s.whatsapp.net',
      participants: [{ id: '12000@lid', name: 'Pat' }, { id: '999000@lid' }],
    },
  ]);
  expect(events).toEqual([
    {
      kind: 'join',
      group: {
        platformId: 'team@g.us',
        name: 'Dinner',
        members: [
          {
            key: 'whatsapp:12000',
            person: { lid: '12000', phoneJid: '15551112222@s.whatsapp.net' },
            name: 'Pat',
            isPrincipal: false,
          },
          {
            key: 'whatsapp:999000',
            person: { lid: '999000', phoneJid: '15550000000@s.whatsapp.net' },
            isPrincipal: false,
          },
        ],
      },
      author: { lid: '12000', phoneJid: '15551112222@s.whatsapp.net' },
    },
  ]);
});

it('updates later participants and group names, then detaches on own removal or native deletion', async () => {
  const events: unknown[] = [];
  unregister = registerWhatsAppObserver({
    onMembership: async (event) => {
      events.push(event);
    },
  });
  await h.writeLink({ schema_version: 1, state: 'connected', principal: { lid: '12000' } });
  const adapter = await h.start();
  h.socket().groups.set('team@g.us', {
    id: 'team@g.us',
    owner: undefined,
    subject: 'Dinner',
    participants: [{ id: '12000@lid' }, { id: '999000@lid' }],
  });
  expect(await adapter.fetchGroupMembers('team@g.us')).toMatchObject({
    members: [
      { key: 'whatsapp:12000', isPrincipal: true },
      { key: 'whatsapp:999000', isPrincipal: false },
    ],
  });
  await h.socket().emit('group-participants.update', {
    id: 'team@g.us',
    author: '12000@lid',
    participants: [{ id: '13000@lid', notify: 'Remy' }],
    action: 'add',
  });
  expect(events.at(-1)).toMatchObject({
    kind: 'roster',
    group: {
      members: [{ key: 'whatsapp:12000' }, { key: 'whatsapp:999000' }, { key: 'whatsapp:13000', name: 'Remy' }],
    },
    author: { lid: '12000' },
  });
  await h.socket().emit('groups.update', [{ id: 'team@g.us', subject: 'Thursday dinner', author: '12000@lid' }]);
  expect(events.at(-1)).toMatchObject({ kind: 'roster', group: { name: 'Thursday dinner' } });
  await h.socket().emit('group-participants.update', {
    id: 'team@g.us',
    author: '12000@lid',
    participants: [{ id: '13000@lid' }],
    action: 'remove',
  });
  expect(events.at(-1)).toMatchObject({
    kind: 'roster',
    group: { members: [{ key: 'whatsapp:12000' }, { key: 'whatsapp:999000' }] },
  });
  await h.socket().emit('group-participants.update', {
    id: 'team@g.us',
    author: '12000@lid',
    participants: [{ id: '999000@lid' }],
    action: 'remove',
  });
  expect(events.at(-1)).toEqual({
    kind: 'detach',
    platformId: 'team@g.us',
    reason: 'removed',
    author: { lid: '12000' },
  });
  await h.socket().emit('chats.delete', ['another@g.us', '12000@lid']);
  expect(events.at(-1)).toEqual({ kind: 'detach', platformId: 'another@g.us', reason: 'deleted' });
});
