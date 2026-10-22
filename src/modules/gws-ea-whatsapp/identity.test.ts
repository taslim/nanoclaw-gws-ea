import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { incoming } from './testing/fake-socket.js';
import { transportHarness, type TransportHarness } from './testing/harness.js';

let h: TransportHarness;
beforeEach(async () => {
  h = await transportHarness();
});
afterEach(async () => {
  await h.close();
});
describe('authenticated WhatsApp identities', () => {
  it('maps a LID and its phone alias to the same person and DM', async () => {
    await h.start();
    await h.socket().emit('messages.upsert', {
      type: 'notify',
      messages: [
        incoming('lid', 'Hi', {
          key: { id: 'lid', remoteJid: '12000@lid', remoteJidAlt: '15551112222@s.whatsapp.net' },
        }),
        incoming('phone', 'Hi again', { key: { id: 'phone', remoteJid: '15551112222@s.whatsapp.net' } }),
      ],
    });
    expect(h.messages().map((message) => message.authenticatedSender?.userId)).toEqual([
      'whatsapp:12000',
      'whatsapp:12000',
    ]);
    expect(h.content().map((content) => content.chatJid)).toEqual(['12000@lid', '12000@lid']);
  });
  it('asks the Baileys mapping store (which uses USync) for an unknown phone', async () => {
    await h.start();
    h.socket().usync.set('15553334444@s.whatsapp.net', '13000@lid');
    await h.socket().emit('messages.upsert', {
      type: 'notify',
      messages: [incoming('usync', 'Hello', { key: { id: 'usync', remoteJid: '15553334444@s.whatsapp.net' } })],
    });
    expect(h.socket().lookups).toContain('15553334444@s.whatsapp.net');
    expect(h.messages()[0].authenticatedSender?.userId).toBe('whatsapp:13000');
  });
  it('routes an unresolved group sender without authority and drops its DM', async () => {
    await h.start();
    await h.socket().emit('messages.upsert', {
      type: 'notify',
      messages: [
        incoming('raw', 'I am the principal', {
          key: { id: 'raw', remoteJid: 'team@g.us', participant: '15559998888@s.whatsapp.net' },
          pushName: 'Principal',
        }),
        incoming('unresolved-dm', 'I am the principal', {
          key: { id: 'unresolved-dm', remoteJid: '15559998888@s.whatsapp.net' },
        }),
      ],
    });
    expect(h.messages()).toHaveLength(1);
    expect(h.messages()[0].authenticatedSender).toBeUndefined();
    expect(h.messages()[0].isMention).toBe(false);
    expect(h.content()[0].senderId).toBe('whatsapp:15559998888@s.whatsapp.net');
  });
  it('resolves the bare canonical user handle to its DM JID while offline', async () => {
    const adapter = await h.start({}, false);
    expect(await adapter.openDM?.('12000')).toBe('12000@lid');
    expect(h.socket().sends).toEqual([]);
  });
  it('persists aliases across a transport restart', async () => {
    const first = await h.start();
    await h.socket().emit('messages.upsert', { type: 'notify', messages: [incoming('group-lid')] });
    await first.teardown();
    await h.start();
    await h.socket().emit('messages.upsert', {
      type: 'append',
      messages: [
        incoming('pn-after-restart', 'Hello', {
          key: { id: 'pn-after-restart', remoteJid: '15551112222@s.whatsapp.net' },
        }),
      ],
    });
    expect(h.messages()[1].authenticatedSender?.userId).toBe('whatsapp:12000');
  });
});
