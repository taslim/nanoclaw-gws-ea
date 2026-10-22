import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChannelNotConnectedError } from '../../channels/adapter.js';
import { registerQuestionRenderResolver } from '../../channels/question-render-registry.js';
import { OutboundRefusedError } from '../../delivery.js';
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
const message = { kind: 'chat', content: { text: '👍' } };
describe('durable WhatsApp outbound rows', () => {
  it('leaves a prepared record before any send and sends the row once after restart', async () => {
    const adapter = await h.start({}, false);
    await expect(adapter.deliver('team@g.us', null, message, 'row-before-send')).rejects.toBeInstanceOf(
      ChannelNotConnectedError,
    );
    const disk = new WhatsAppIndex(h.directory, () => '15550000000@s.whatsapp.net');
    expect(disk.pending('row-before-send')).toMatchObject({ accepted: false, chat: 'team@g.us' });
    disk.close();
    expect(h.socket().sends).toEqual([]);
    await adapter.teardown();
    const fresh = await h.start();
    await fresh.deliver('team@g.us', null, message, 'row-before-send');
    expect(h.socket().sends).toHaveLength(1);
  });
  it('resends an ambiguous send with the same caller message id after restart', async () => {
    const adapter = await h.start();
    h.socket().sendError = new Error('process died after socket handoff');
    await expect(adapter.deliver('team@g.us', null, message, 'ambiguous')).rejects.toThrow('process died');
    const handedId = h.socket().sends[0].options.messageId;
    expect(handedId).toMatch(/^3EB0[0-9A-F]{28}$/u);
    await adapter.teardown();
    const fresh = await h.start();
    await fresh.deliver('team@g.us', null, message, 'ambiguous');
    expect(h.socket().sends[0].options.messageId).toBe(handedId);
  });
  it('does not resend a completed socket handoff after a crash before markDelivered', async () => {
    const first = await h.start();
    const handedId = await first.deliver('team@g.us', null, message, 'accepted');
    if (!handedId) throw new Error('WhatsApp did not name the accepted message');
    await first.teardown();
    const fresh = await h.start();
    expect(await fresh.deliver('team@g.us', null, message, 'accepted')).toBe(handedId);
    expect(h.socket().sends).toEqual([]);
    const disk = new WhatsAppIndex(h.directory, () => '15550000000@s.whatsapp.net');
    expect(disk.pending('accepted')?.accepted).toBe(true);
    disk.close();
    fresh.completeDelivery('accepted');
    const completed = new WhatsAppIndex(h.directory, () => '15550000000@s.whatsapp.net');
    expect(completed.pending('accepted')).toBeUndefined();
    expect(completed.message('team@g.us', handedId)?.fromMe).toBe(true);
    completed.close();
  });
  it('gives identical replies in different rows separate message ids and coalesces concurrent same-row calls', async () => {
    const adapter = await h.start();
    await Promise.all([
      adapter.deliver('team@g.us', null, message, 'thumb-1'),
      adapter.deliver('team@g.us', null, message, 'thumb-1'),
    ]);
    await adapter.deliver('team@g.us', null, message, 'thumb-2');
    expect(h.socket().sends).toHaveLength(2);
    expect(h.socket().sends[0].options.messageId).not.toBe(h.socket().sends[1].options.messageId);
  });
  it('returns a row held over four hours through the native refusal outcome', async () => {
    const adapter = await h.start({}, false);
    await expect(adapter.deliver('team@g.us', null, message, 'stale')).rejects.toBeInstanceOf(ChannelNotConnectedError);
    h.now.value += 4 * 60 * 60 * 1000 + 1;
    await h.socket().emit('connection.update', { connection: 'open' });
    await expect(adapter.deliver('team@g.us', null, message, 'stale')).rejects.toMatchObject({
      guardId: 'gws-ea-whatsapp:stale',
      reason: expect.stringContaining('four hours'),
    });
    expect(h.socket().sends).toEqual([]);
  });
  it('expires an old original row on its first observation after host downtime', async () => {
    const adapter = await h.start();
    const timestamp = new Date(h.now.value - 5 * 60 * 60 * 1000).toISOString();
    await expect(
      adapter.deliver('team@g.us', null, { ...message, timestamp }, 'first-seen-stale'),
    ).rejects.toMatchObject({ guardId: 'gws-ea-whatsapp:stale' });
    expect(h.socket().sends).toEqual([]);
  });

  it('does not treat an invalid original row timestamp as a fresh host send', async () => {
    const adapter = await h.start();
    await expect(
      adapter.deliver('team@g.us', null, { ...message, timestamp: 'not-a-time' }, 'invalid-original'),
    ).rejects.toThrow('invalid original timestamp');
    expect(h.socket().sends).toEqual([]);
  });

  it('serves the original sent media to a Baileys retry after restart', async () => {
    const adapter = await h.start();
    const wire = {
      imageMessage: {
        caption: 'A picture',
        mimetype: 'image/png',
        url: 'https://media.example/opaque',
        mediaKey: Buffer.from([3, 4, 5]),
      },
    };
    const original = h.socket().sendMessage.bind(h.socket());
    h.socket().sendMessage = async (...args) => ({ ...(await original(...args)), message: wire });
    const id = await adapter.deliver(
      'team@g.us',
      null,
      {
        kind: 'chat',
        content: { text: 'A picture' },
        files: [{ filename: 'photo.png', mimeType: 'image/png', data: Buffer.from('photo') }],
      },
      'media-retry',
    );
    await adapter.teardown();
    await h.start();
    const stored = await h.socketConfigs[1].getMessage?.({ remoteJid: 'team@g.us', id });
    expect(stored?.imageMessage).toMatchObject(wire.imageMessage);
    expect(stored?.conversation).toBeNull();
  });

  it('clears only a definitely refused send and throws the native refusal to its agent', async () => {
    const adapter = await h.start();
    h.socket().sendError = Object.assign(new Error('forbidden'), { output: { statusCode: 403 } });
    await expect(adapter.deliver('team@g.us', null, message, 'refused')).rejects.toBeInstanceOf(OutboundRefusedError);
    const disk = new WhatsAppIndex(h.directory, () => '15550000000@s.whatsapp.net');
    expect(disk.pending('refused')).toBeUndefined();
    disk.close();
  });
  it('resumes a partly sent file batch without resending its first attachment', async () => {
    const adapter = await h.start();
    const original = h.socket().sendMessage.bind(h.socket());
    let calls = 0;
    h.socket().sendMessage = async (...args) => {
      calls++;
      if (calls === 2) throw new Error('interrupted second attachment');
      return original(...args);
    };
    const files = {
      kind: 'chat',
      content: { text: 'Two pictures' },
      files: [
        { filename: 'one.png', mimeType: 'image/png', data: Buffer.from('one') },
        { filename: 'two.png', mimeType: 'image/png', data: Buffer.from('two') },
      ],
    };
    await expect(adapter.deliver('team@g.us', null, files, 'pictures')).rejects.toThrow('interrupted');
    await adapter.teardown();
    const fresh = await h.start();
    await fresh.deliver('team@g.us', null, files, 'pictures');
    expect(h.socket().sends).toHaveLength(1);
    expect(h.socket().sends[0].content).toMatchObject({ image: Buffer.from('two') });
  });
  it('names the group member who sent a message when it reacts, and its own message without one', async () => {
    const adapter = await h.start();
    await h.socket().emit('messages.upsert', { type: 'notify', messages: [incoming('from-pat', 'Lunch at noon?')] });
    const own = await adapter.deliver('team@g.us', null, message, 'own-message');
    const react = (messageId: string | undefined) => ({
      kind: 'chat',
      content: { operation: 'reaction', messageId, emoji: '👍' },
    });
    await adapter.deliver('team@g.us', null, react('from-pat'), 'react-member');
    await adapter.deliver('team@g.us', null, react(own), 'react-own');
    expect(
      h
        .socket()
        .sends.slice(1)
        .map((send) => send.content),
    ).toEqual([
      {
        react: { text: '👍', key: { remoteJid: 'team@g.us', id: 'from-pat', fromMe: false, participant: '12000@lid' } },
      },
      { react: { text: '👍', key: { remoteJid: 'team@g.us', id: own, fromMe: true } } },
    ]);
    await expect(adapter.deliver('team@g.us', null, react('unknown'), 'react-unknown')).rejects.toThrow(
      'does not have',
    );
    expect(h.socket().sends).toHaveLength(3);
  });
  it('uses composing while a turn works and paused when it ends', async () => {
    const adapter = await h.start();
    await adapter.setTyping?.('team@g.us', null);
    await adapter.endTyping?.('team@g.us', null, 'anchor');
    expect(h.socket().presence).toEqual([
      { status: 'composing', jid: 'team@g.us' },
      { status: 'paused', jid: 'team@g.us' },
    ]);
  });
});

describe('WhatsApp questions use native text answers', () => {
  const questionId = 'wa-u1-approval';
  const approval = {
    kind: 'chat',
    content: {
      type: 'ask_question',
      questionId,
      title: 'Allow this action?',
      question: 'Approve the action.',
      options: [
        { label: 'Allow', value: 'approve' },
        { label: 'Deny', value: 'reject' },
      ],
    },
  };
  registerQuestionRenderResolver((id) =>
    id === questionId
      ? {
          title: 'Allow this action?',
          kind: 'approval',
          options: [
            { label: 'Allow', selectedLabel: 'Allowed', value: 'approve' },
            { label: 'Deny', selectedLabel: 'Denied', value: 'reject' },
          ],
        }
      : undefined,
  );
  it('takes a thumb on the posted approval through answers.ts and ignores slash commands', async () => {
    const adapter = await h.start();
    const id = await adapter.deliver('team@g.us', null, approval, 'approval-row');
    expect(h.socket().sends[0].content).toMatchObject({
      text: expect.stringContaining('Quote this message with yes or no'),
    });
    await h.socket().emit('messages.upsert', {
      type: 'notify',
      messages: [
        incoming('slash', '/approve'),
        incoming('thumb', '', {
          message: { reactionMessage: { key: { id, remoteJid: 'team@g.us', fromMe: true }, text: '👍' } },
        }),
      ],
    });
    expect(h.setup.onAction).toHaveBeenCalledExactlyOnceWith(
      questionId,
      'approve',
      'whatsapp:12000',
      { platformId: 'team@g.us', threadId: null, messageId: id, instance: 'whatsapp' },
      { deferResolution: true },
    );
    expect(h.messages().map((message) => message.id)).toEqual(['slash']);
  });
  it('takes a quoted yes, but a forwarded quoted yes carries no approval authority', async () => {
    const adapter = await h.start();
    const id = await adapter.deliver('team@g.us', null, approval, 'quoted-approval');
    await h.socket().emit('messages.upsert', {
      type: 'notify',
      messages: [
        incoming('forwarded-yes', '', {
          message: { extendedTextMessage: { text: 'yes', contextInfo: { stanzaId: id, isForwarded: true } } },
        }),
        incoming('own-yes', '', { message: { extendedTextMessage: { text: 'yes', contextInfo: { stanzaId: id } } } }),
      ],
    });
    expect(vi.mocked(h.setup.onAction).mock.calls.map((call) => call[0])).toEqual([questionId]);
    expect(h.messages().map((message) => message.id)).toEqual(['forwarded-yes']);
  });
});
