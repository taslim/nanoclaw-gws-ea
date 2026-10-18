import { afterEach, beforeEach, expect, it } from 'vitest';
import { WhatsAppIndex } from './index-store.js';
import { incoming } from './testing/fake-socket.js';
import { transportHarness, type TransportHarness } from './testing/harness.js';

let h: TransportHarness;
beforeEach(async () => {
  h = await transportHarness();
});
afterEach(async () => {
  await h.close();
});
const oldAccount = '15550000000@s.whatsapp.net';
const newAccount = '15550000099@s.whatsapp.net';
async function changedAccount() {
  await h.writeLink({ schema_version: 1, state: 'connected', number: '+15550000099' });
  const adapter = await h.start({}, false);
  h.socket().user.id = '15550000099:1@s.whatsapp.net';
  h.socket().user.lid = '777000:1@lid';
  await h.socket().emit('connection.update', { connection: 'open' });
  return adapter;
}

it('retains the completed send receipt after host delivery cleanup and a later account change', async () => {
  const first = await h.start();
  const message = { kind: 'chat', content: { text: 'Already delivered before the snapshot restore' } };
  const id = await first.deliver('team@g.us', null, message, 'completed-before-account-change');
  first.completeDelivery('completed-before-account-change');
  await first.teardown();
  const fresh = await changedAccount();
  expect(await fresh.deliver('team@g.us', null, message, 'completed-before-account-change')).toBe(id);
  expect(h.socket().sends).toHaveLength(0);
});

it('keeps an accepted logical row globally handed off after an account change but refuses an old unaccepted row', async () => {
  const first = await h.start();
  const content = { kind: 'chat', content: { text: 'One delivery' } };
  const accepted = await first.deliver('team@g.us', null, content, 'accepted-old-account');
  await h.socket().emit('connection.update', { connection: 'close' });
  await expect(first.deliver('team@g.us', null, content, 'unaccepted-old-account')).rejects.toThrow();
  await first.teardown();
  const fresh = await changedAccount();
  expect(await fresh.deliver('team@g.us', null, content, 'accepted-old-account')).toBe(accepted);
  await expect(fresh.deliver('team@g.us', null, content, 'unaccepted-old-account')).rejects.toMatchObject({
    guardId: 'gws-ea-whatsapp:account-changed',
  });
  expect(h.socket().sends).toHaveLength(0);
});

it('isolates old inbound, held, aliases, names, own-message quotes, questions and native resend bodies from a different phone account', async () => {
  const first = await h.start();
  await h
    .socket()
    .emit('messages.upsert', { type: 'notify', messages: [incoming('old-inbound', 'Private prior account text')] });
  const ownId = await first.deliver(
    'team@g.us',
    null,
    { kind: 'chat', content: { text: 'Old account’s own text' } },
    'old-owned',
  );
  const old = new WhatsAppIndex(h.directory, () => oldAccount);
  old.intake(incoming('pending-old-account'));
  old.intake(incoming('held-old-account'));
  old.hold('team@g.us', 'held-old-account', '12000');
  old.rememberRequest('old-question', 'team@g.us', 'principal-question');
  expect(old.phone('12000@lid')).toBe('15551112222@s.whatsapp.net');
  expect(old.name('12000@lid')).toBe('Pat');
  old.close();
  await first.teardown();
  const before = h.messages().length;
  const fresh = await changedAccount();
  expect(h.messages()).toHaveLength(before);
  expect(fresh.isOwnMessage('team@g.us', ownId!)).toBe(false);
  expect(await h.socketConfigs.at(-1)?.getMessage?.({ remoteJid: 'team@g.us', id: ownId })).toBeUndefined();
  const current = new WhatsAppIndex(h.directory, () => newAccount);
  expect(current.message('team@g.us', 'old-inbound')).toBeUndefined();
  expect(current.unrouted()).toEqual([]);
  current.releaseHeld('12000');
  expect(current.unrouted()).toEqual([]);
  expect(current.phone('12000@lid')).toBeUndefined();
  expect(current.lid('15551112222@s.whatsapp.net')).toBeUndefined();
  expect(current.name('12000@lid')).toBeUndefined();
  expect(current.request('old-question')).toBeUndefined();
  current.close();
  await h.socket().emit('messages.upsert', {
    type: 'notify',
    messages: [
      {
        ...incoming('new-quote', 'A new question', { pushName: undefined }),
        message: {
          extendedTextMessage: {
            text: 'A new question',
            contextInfo: { stanzaId: ownId, quotedMessage: { conversation: 'Forged old content' } },
          },
        },
      },
    ],
  });
  expect(h.content().at(-1)?.replyTo).toEqual({ id: ownId });
  expect(h.messages().at(-1)?.isMention).toBe(false);
  const retained = new WhatsAppIndex(h.directory, () => oldAccount);
  expect(retained.message('team@g.us', 'old-inbound')?.text).toBe('Private prior account text');
  expect(retained.unrouted().map(({ key }) => key.id)).toContain('pending-old-account');
  retained.releaseHeld('12000');
  expect(retained.unrouted().map(({ key }) => key.id)).toContain('held-old-account');
  retained.close();
});
