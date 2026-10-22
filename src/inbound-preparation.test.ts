import { describe, expect, it, vi } from 'vitest';

import { parseInboundContent } from './channels/inbound-content.js';
import type { InboundPreparationRequest } from './inbound-preparation.js';

function request(): InboundPreparationRequest {
  return {
    content: '{"text":"Keep this exactly."}',
    channelType: 'gchat',
    instance: 'gchat',
    platformId: 'spaces/one',
    messageId: 'message-one',
    timestamp: '2026-10-12T18:30:00.000Z',
    session: {
      id: 'session-one',
      agent_group_id: 'ag-one',
      messaging_group_id: 'mg-one',
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: '2026-10-12T18:30:00.000Z',
    },
    messagingGroup: {
      id: 'mg-one',
      channel_type: 'gchat',
      instance: 'gchat',
      platform_id: 'spaces/one',
      name: null,
      is_group: 0,
      unknown_sender_policy: 'public',
      denied_at: null,
      created_at: '2026-10-12T18:30:00.000Z',
    },
  };
}

describe('content-only preparation', () => {
  it('is an exact pass-through without an installed preparer', async () => {
    vi.resetModules();
    const { prepareInboundContent } = await import('./inbound-preparation.js');
    const original = request();
    expect(await prepareInboundContent(original)).toBe(original.content);
  });

  it('chains installed content transformations in registration order', async () => {
    vi.resetModules();
    const { prepareInboundContent, registerInboundPreparer } = await import('./inbound-preparation.js');
    registerInboundPreparer(({ content }) => `${content}\nfirst`);
    registerInboundPreparer(async ({ content }) => `${content}\nsecond`);
    const original = request();
    expect(await prepareInboundContent(original)).toBe(`${original.content}\nfirst\nsecond`);
    expect(original.content).toBe('{"text":"Keep this exactly."}');
  });
});

describe('transcriptions in conversation context', () => {
  it('preserves ordinary wording, self-corrections and quoting facts', () => {
    const raw = JSON.stringify({
      text: 'Read these notes.',
      sender: 'Alex',
      senderId: 'gchat:one',
      attachments: [
        {
          type: 'audio',
          audioSource: { kind: 'voice-note' },
          speech: {
            status: 'recognized',
            text: 'Thursday — actually Friday, if Sarah confirms. Merci.',
            language: 'en',
          },
        },
        {
          type: 'audio',
          audioSource: { kind: 'audio', quoted: true },
          speech: {
            status: 'recognized',
            text: 'Do not send 25; send 15.',
            language: 'en',
          },
        },
        { type: 'audio', speech: { status: 'failed', reason: 'decode', text: 'must not appear' } },
      ],
    });
    expect(parseInboundContent(raw)).toEqual({
      sender: 'Alex',
      senderId: 'gchat:one',
      text: 'Read these notes.\nThursday — actually Friday, if Sarah confirms. Merci.\n[Quoted]\nDo not send 25; send 15.',
    });
  });

  it('does not invent speech for invalid attachment content', () => {
    expect(
      parseInboundContent('{"text":"caption","attachments":[null,{}, {"speech":{"status":"recognized","text":7}}]}')
        .text,
    ).toBe('caption');
    expect(parseInboundContent('plain legacy text').text).toBe('plain legacy text');
    expect(parseInboundContent('null').text).toBe('');
  });
});
