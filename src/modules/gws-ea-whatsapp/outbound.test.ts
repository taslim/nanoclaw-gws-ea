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
const msg = (deliveryId: string, extra: Record<string, unknown> = {}) => ({ ...message, ...extra, deliveryId });
describe('durable WhatsApp outbound rows', () => {
  it('leaves a prepared record before any send and sends the row once after restart', async () => {
    const adapter = await h.start({}, false);
    await expect(adapter.deliver('team@g.us', null, msg('row-before-send'))).rejects.toBeInstanceOf(
      ChannelNotConnectedError,
    );
    const disk = new WhatsAppIndex(h.directory, () => '15550000000@s.whatsapp.net');
    expect(disk.pending('row-before-send')).toMatchObject({ accepted: false, chat: 'team@g.us' });
    disk.close();
    expect(h.socket().sends).toEqual([]);
    await adapter.teardown();
    const fresh = await h.start();
    await fresh.deliver('team@g.us', null, msg('row-before-send'));
    expect(h.socket().sends).toHaveLength(1);
  });
  it('resends an ambiguous send with the same caller message id after restart', async () => {
    const adapter = await h.start();
    h.socket().sendError = new Error('process died after socket handoff');
    await expect(adapter.deliver('team@g.us', null, msg('ambiguous'))).rejects.toThrow('process died');
    const handedId = h.socket().sends[0].options.messageId;
    expect(handedId).toMatch(/^3EB0[0-9A-F]{28}$/u);
    await adapter.teardown();
    const fresh = await h.start();
    await fresh.deliver('team@g.us', null, msg('ambiguous'));
    expect(h.socket().sends[0].options.messageId).toBe(handedId);
  });
  it('does not resend a completed socket handoff after a crash before markDelivered', async () => {
    const first = await h.start();
    const handedId = await first.deliver('team@g.us', null, msg('accepted'));
    if (!handedId) throw new Error('WhatsApp did not name the accepted message');
    await first.teardown();
    const fresh = await h.start();
    expect(await fresh.deliver('team@g.us', null, msg('accepted'))).toBe(handedId);
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
      adapter.deliver('team@g.us', null, msg('thumb-1')),
      adapter.deliver('team@g.us', null, msg('thumb-1')),
    ]);
    await adapter.deliver('team@g.us', null, msg('thumb-2'));
    expect(h.socket().sends).toHaveLength(2);
    expect(h.socket().sends[0].options.messageId).not.toBe(h.socket().sends[1].options.messageId);
  });
  it('returns a row held over four hours through the native refusal outcome', async () => {
    const adapter = await h.start({}, false);
    await expect(adapter.deliver('team@g.us', null, msg('stale'))).rejects.toBeInstanceOf(ChannelNotConnectedError);
    h.now.value += 4 * 60 * 60 * 1000 + 1;
    await h.socket().emit('connection.update', { connection: 'open' });
    await expect(adapter.deliver('team@g.us', null, msg('stale'))).rejects.toMatchObject({
      guardId: 'gws-ea-whatsapp:stale',
      reason: expect.stringContaining('four hours'),
    });
    expect(h.socket().sends).toEqual([]);
  });
  it('expires an old original row on its first observation after host downtime', async () => {
    const adapter = await h.start();
    const timestamp = new Date(h.now.value - 5 * 60 * 60 * 1000).toISOString();
    await expect(adapter.deliver('team@g.us', null, msg('first-seen-stale', { timestamp }))).rejects.toMatchObject({
      guardId: 'gws-ea-whatsapp:stale',
    });
    expect(h.socket().sends).toEqual([]);
  });

  it('does not treat an invalid original row timestamp as a fresh host send', async () => {
    const adapter = await h.start();
    await expect(
      adapter.deliver('team@g.us', null, msg('invalid-original', { timestamp: 'not-a-time' })),
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
    const id = await adapter.deliver('team@g.us', null, {
      kind: 'chat',
      content: { text: 'A picture' },
      files: [{ filename: 'photo.png', mimeType: 'image/png', data: Buffer.from('photo') }],
      deliveryId: 'media-retry',
    });
    await adapter.teardown();
    await h.start();
    const stored = await h.socketConfigs[1].getMessage?.({ remoteJid: 'team@g.us', id });
    expect(stored?.imageMessage).toMatchObject(wire.imageMessage);
    expect(stored?.conversation).toBeNull();
  });

  it('clears only a definitely refused send and throws the native refusal to its agent', async () => {
    const adapter = await h.start();
    h.socket().sendError = Object.assign(new Error('forbidden'), { output: { statusCode: 403 } });
    await expect(adapter.deliver('team@g.us', null, msg('refused'))).rejects.toBeInstanceOf(OutboundRefusedError);
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
      deliveryId: 'pictures',
    };
    await expect(adapter.deliver('team@g.us', null, files)).rejects.toThrow('interrupted');
    await adapter.teardown();
    const fresh = await h.start();
    await fresh.deliver('team@g.us', null, files);
    expect(h.socket().sends).toHaveLength(1);
    expect(h.socket().sends[0].content).toMatchObject({ image: Buffer.from('two') });
  });
  it('names the group member who sent a message when it reacts, and its own message without one', async () => {
    const adapter = await h.start();
    await h.socket().emit('messages.upsert', { type: 'notify', messages: [incoming('from-pat', 'Lunch at noon?')] });
    const own = await adapter.deliver('team@g.us', null, msg('own-message'));
    const react = (messageId: string | undefined, deliveryId: string) => ({
      kind: 'chat',
      content: { operation: 'reaction', messageId, emoji: '👍' },
      deliveryId,
    });
    await adapter.deliver('team@g.us', null, react('from-pat', 'react-member'));
    await adapter.deliver('team@g.us', null, react(own, 'react-own'));
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
    await expect(adapter.deliver('team@g.us', null, react('unknown', 'react-unknown'))).rejects.toThrow(
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
          question: 'Approve the action.',
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
    const id = await adapter.deliver('team@g.us', null, { ...approval, deliveryId: 'approval-row' });
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
      { redeliverOnError: true },
    );
    expect(h.messages().map((message) => message.id)).toEqual(['slash']);
  });
  it('takes a quoted yes, but a forwarded quoted yes carries no approval authority', async () => {
    const adapter = await h.start();
    const id = await adapter.deliver('team@g.us', null, { ...approval, deliveryId: 'quoted-approval' });
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
  it('edits the posted approval in place when the host accepts an answer, and leaves refused answers unedited', async () => {
    const adapter = await h.start();
    const id = await adapter.deliver('team@g.us', null, { ...approval, deliveryId: 'edit-approval' });
    vi.mocked(h.setup.onAction).mockResolvedValueOnce('refused').mockResolvedValueOnce('accepted');
    await h.socket().emit('messages.upsert', {
      type: 'notify',
      messages: [
        incoming('refused-yes', '', {
          message: { extendedTextMessage: { text: 'yes', contextInfo: { stanzaId: id } } },
        }),
      ],
    });
    expect(h.socket().sends).toHaveLength(1);
    await h.socket().emit('messages.upsert', {
      type: 'notify',
      messages: [
        incoming('accepted-yes', '', {
          message: { extendedTextMessage: { text: 'yes', contextInfo: { stanzaId: id } } },
        }),
      ],
    });
    expect(h.socket().sends).toHaveLength(2);
    expect(h.socket().sends[1].content).toMatchObject({
      text: expect.stringContaining('Allowed'),
      edit: { id, remoteJid: 'team@g.us', fromMe: true },
    });

    // Once the outcome edit lands, the request row is forgotten so later replies/reactions cannot answer it again.
    const disk = new WhatsAppIndex(h.directory, () => '15550000000@s.whatsapp.net');
    expect(disk.request(id!)).toBeUndefined();
    expect(disk.requestMessage(questionId, 'team@g.us')).toBeUndefined();
    disk.close();

    vi.mocked(h.setup.onAction).mockClear();
    await h.socket().emit('messages.upsert', {
      type: 'notify',
      messages: [
        incoming('late-thumb', '', {
          message: { reactionMessage: { key: { id, remoteJid: 'team@g.us', fromMe: true }, text: '👍' } },
        }),
        incoming('late-yes', '', {
          message: { extendedTextMessage: { text: 'yes', contextInfo: { stanzaId: id } } },
        }),
      ],
    });
    expect(h.setup.onAction).not.toHaveBeenCalled();
  });

  it('refuses plain edits to an open request and keeps the request tracked if an outcome edit fails before sending', async () => {
    const adapter = await h.start();
    const id = await adapter.deliver('team@g.us', null, { ...approval, deliveryId: 'open-approval' });
    expect(id).toBeDefined();

    await expect(
      adapter.deliver('team@g.us', null, {
        kind: 'chat',
        content: { operation: 'edit', messageId: id, text: 'Reworded decoy' },
        deliveryId: 'plain-edit',
      }),
    ).rejects.toThrow('An open WhatsApp request may only be edited by its outcome handler');
    expect(h.socket().sends).toHaveLength(1);

    // If the socket fails during a host outcome edit, the request remains tracked for retry / answers.
    h.socket().sendError = new Error('transient socket error');
    await expect(
      adapter.deliver('team@g.us', null, {
        kind: 'chat-sdk',
        content: {
          operation: 'edit',
          questionId,
          messageId: id,
          text: 'Allowed',
          terminalCard: { title: 'Allow this action?', question: 'Approve the action.', resolution: 'Allowed' },
        },
        deliveryId: 'outcome-edit-1',
      }),
    ).rejects.toThrow('transient socket error');
    const stillOpen = new WhatsAppIndex(h.directory, () => '15550000000@s.whatsapp.net');
    expect(stillOpen.request(id!)).toMatchObject({ questionId, platformId: 'team@g.us' });
    stillOpen.close();

    // Once the retry lands, receipt + target update + request cleanup + acceptance commit atomically,
    // so a restart before completeDelivery still returns the accepted edit id without resending.
    h.socket().sendError = undefined;
    const outcomeMessage = {
      kind: 'chat-sdk',
      content: {
        operation: 'edit',
        questionId,
        messageId: id,
        text: 'Allowed',
        terminalCard: { title: 'Allow this action?', question: 'Approve the action.', resolution: 'Allowed' },
      },
      deliveryId: 'outcome-edit-1',
    };
    const editId = await adapter.deliver('team@g.us', null, outcomeMessage);
    await adapter.teardown();
    const restarted = await h.start();
    expect(await restarted.deliver('team@g.us', null, outcomeMessage)).toBe(editId);
    expect(h.socket().sends).toEqual([]);
    const forgotten = new WhatsAppIndex(h.directory, () => '15550000000@s.whatsapp.net');
    expect(forgotten.pending('outcome-edit-1')?.accepted).toBe(true);
    expect(forgotten.message('team@g.us', id!)?.text).toBe('Allowed');
    expect(forgotten.request(id!)).toBeUndefined();
    forgotten.close();
  });

  it('rolls back receipt, text update, and request cleanup together if acceptance fails inside recordEdit', async () => {
    const index = new WhatsAppIndex(h.directory, () => '15550000000@s.whatsapp.net');
    try {
      index.sent({
        chat: 'team@g.us',
        id: 'orig-1',
        sender: '15550000000@s.whatsapp.net',
        fromMe: true,
        forwarded: false,
        text: 'Allow?',
        at: h.now.value,
      });
      index.rememberRequest('orig-1', 'team@g.us', questionId, new Date(h.now.value).toISOString());
      index.prepare('edit-row', 'team@g.us', 'receipt-1', h.now.value);

      vi.spyOn(index, 'accepted').mockImplementationOnce(() => {
        throw new Error('simulated failure before commit');
      });
      expect(() =>
        index.recordEdit(
          'edit-row',
          {
            chat: 'team@g.us',
            id: 'receipt-1',
            sender: '15550000000@s.whatsapp.net',
            fromMe: true,
            forwarded: false,
            text: 'Allowed',
            at: h.now.value,
          },
          'orig-1',
          true,
        ),
      ).toThrow('simulated failure before commit');

      // None of the four mutations committed: request stays resolvable and row stays unaccepted.
      expect(index.message('team@g.us', 'receipt-1')).toBeUndefined();
      expect(index.message('team@g.us', 'orig-1')?.text).toBe('Allow?');
      expect(index.request('orig-1')).toMatchObject({ questionId, platformId: 'team@g.us' });
      expect(index.pending('edit-row')?.accepted).toBe(false);
    } finally {
      index.close();
    }
  });

  it('neutralizes bidi/hidden characters and @digits mentions on host approval prompts and outcome edits', async () => {
    const adapter = await h.start();
    const id = await adapter.deliver('team@g.us', null, {
      kind: 'chat-sdk',
      content: {
        type: 'ask_question',
        questionId,
        title: 'Allow \u202Eexe @15551234567?',
        question: 'Send to @+15559876543\u200B now',
        options: [
          { label: 'Allow', value: 'approve' },
          { label: 'Deny', value: 'reject' },
        ],
      },
      deliveryId: 'host-bidi-approval',
    });
    expect(id).toBeDefined();
    expect(h.socket().sends[0].content).toMatchObject({
      text: expect.stringContaining('\\u202eexe @15551234567?'),
      mentions: [],
    });
    expect(String((h.socket().sends[0].content as { text: string }).text)).toContain('\\u200b');
    expect(String((h.socket().sends[0].content as { text: string }).text)).not.toContain('\u202E');
    expect(String((h.socket().sends[0].content as { text: string }).text)).not.toContain('\u200B');

    await adapter.deliver('team@g.us', null, {
      kind: 'chat-sdk',
      content: {
        operation: 'edit',
        questionId,
        messageId: id,
        text: 'Denied: \u202Eping @15551234567',
        terminalCard: { title: 'Allow?', question: 'Send?', resolution: 'Denied' },
      },
      deliveryId: 'host-bidi-edit',
    });
    expect(h.socket().sends[1].content).toMatchObject({
      text: expect.stringContaining('\\u202eping @15551234567'),
      mentions: [],
    });
    expect(String((h.socket().sends[1].content as { text: string }).text)).not.toContain('\u202E');

    // Ordinary agent chat messages still parse @digits into WhatsApp mention JIDs.
    await adapter.deliver('team@g.us', null, {
      kind: 'chat',
      content: { text: 'Ping @15551234567 please' },
      deliveryId: 'normal-mention',
    });
    expect(h.socket().sends[2].content).toMatchObject({
      text: 'Ping @15551234567 please',
      mentions: ['15551234567@s.whatsapp.net'],
    });
  });
});

describe('WhatsApp send_card rendering', () => {
  it('renders title, description, card parts, and URL actions as formatted WhatsApp text while dropping non-URL actions', async () => {
    const adapter = await h.start();
    const id = await adapter.deliver('team@g.us', null, {
      kind: 'chat-sdk',
      deliveryId: 'wa-card-full',
      content: {
        type: 'card',
        card: {
          title: 'Weekly Summary',
          description: 'Key metrics for this week.',
          children: [
            { type: 'Text', props: { content: 'Highlights', style: 'bold' } },
            { type: 'Text', props: { content: 'All systems healthy.', style: 'muted' } },
            { type: 'Divider' },
            {
              type: 'Fields',
              children: [
                { type: 'Field', props: { label: 'Owner', value: 'Morgan' } },
                { type: 'Field', props: { label: 'Tasks', value: 7 } },
              ],
            },
            {
              type: 'Table',
              props: {
                caption: 'Open items',
                headers: ['Item', 'Count'],
                rows: [
                  ['Reviews', 3],
                  ['Follow-ups', 4],
                ],
              },
            },
            {
              type: 'Chart',
              props: {
                title: 'Time Split',
                chart: {
                  type: 'pie',
                  segments: [
                    { label: 'Deep work', value: 60 },
                    { label: 'Meetings', value: 40 },
                  ],
                },
              },
            },
            {
              type: 'Chart',
              props: {
                title: 'Daily Volume',
                chart: {
                  type: 'bar',
                  categories: ['Mon', 'Tue'],
                  series: [{ name: 'Emails', values: [12, 9] }],
                  xLabel: 'Day',
                  yLabel: 'Count',
                },
              },
            },
          ],
          actions: [
            { label: 'Open dashboard', url: 'https://example.test/dash' },
            { label: 'Ignored callback', actionId: 'approve' },
          ],
        },
      },
    });
    expect(id).toMatch(/^3EB0[0-9A-F]{28}$/u);
    expect(h.socket().sends).toHaveLength(1);
    const text = String((h.socket().sends[0].content as { text: string }).text);
    expect(text).toContain('*Weekly Summary*');
    expect(text).toContain('Key metrics for this week.');
    expect(text).toContain('*Highlights*');
    expect(text).toContain('_All systems healthy._');
    expect(text).toContain('*Owner:* Morgan');
    expect(text).toContain('*Tasks:* 7');
    expect(text).toContain('_Open items_');
    expect(text).toContain('*Item | Count*');
    expect(text).toContain('Reviews | 3');
    expect(text).toContain('*Time Split*');
    expect(text).toContain('- Deep work: 60');
    expect(text).toContain('*Daily Volume*');
    expect(text).toContain('- Emails: Mon: 12, Tue: 9');
    expect(text).toContain('Open dashboard (https://example.test/dash)');
    expect(text).not.toContain('Ignored callback');
  });

  it('refuses invalid cards through OutboundRefusedError without sending or leaving a pending row', async () => {
    const adapter = await h.start();
    await expect(
      adapter.deliver('team@g.us', null, {
        kind: 'chat-sdk',
        deliveryId: 'wa-card-invalid',
        content: {
          type: 'card',
          card: {
            title: 'Bad card',
            children: [{ type: 'Button', props: { label: 'Click' } }],
          },
        },
      }),
    ).rejects.toMatchObject({
      name: 'OutboundRefusedError',
      guardId: 'gws-ea-whatsapp:invalid-card',
      reason: expect.stringContaining('unknown part "Button"'),
    });
    expect(h.socket().sends).toEqual([]);
    const disk = new WhatsAppIndex(h.directory, () => '15550000000@s.whatsapp.net');
    expect(disk.pending('wa-card-invalid')).toBeUndefined();
    disk.close();
  });

  it('falls back to fallbackText for an empty card and skips completely empty cards cleanly', async () => {
    const adapter = await h.start();
    await adapter.deliver('team@g.us', null, {
      kind: 'chat-sdk',
      deliveryId: 'wa-card-fallback',
      content: { type: 'card', card: {}, fallbackText: 'Fallback notice' },
    });
    expect(h.socket().sends).toHaveLength(1);
    expect(h.socket().sends[0].content).toMatchObject({ text: 'Fallback notice' });

    const skippedId = await adapter.deliver('team@g.us', null, {
      kind: 'chat-sdk',
      deliveryId: 'wa-card-empty',
      content: { type: 'card', card: {} },
    });
    expect(skippedId).toBe('');
    expect(h.socket().sends).toHaveLength(1);
    const disk = new WhatsAppIndex(h.directory, () => '15550000000@s.whatsapp.net');
    expect(disk.pending('wa-card-empty')).toBeUndefined();
    disk.close();
  });
});
