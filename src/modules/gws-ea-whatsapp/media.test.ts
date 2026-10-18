import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMessagingGroup, getDb } from '../../db/index.js';
import {
  VOICE_MODEL_CATALOG,
  VOICE_RECIPE_ID,
  VOICE_SOURCE_ARTIFACTS,
  type VerifiedVoiceInstallation,
} from '../../gws-ea/voice-assets.js';
import type { InboundPreparationRequest } from '../../inbound-preparation.js';
import { prepareVoiceContent } from '../gws-ea-voice/index.js';
import { incoming } from './testing/fake-socket.js';
import { transportHarness, type TransportHarness } from './testing/harness.js';

const boundary = vi.hoisted(() => ({
  data: '',
  readiness: vi.fn<typeof import('../gws-ea-voice/config.js').readVoiceReadiness>(),
  transcribe: vi.fn<typeof import('../gws-ea-voice/transcribe.js').transcribeAudio>(),
}));
vi.mock('../../config.js', async () => ({
  ...(await vi.importActual<typeof import('../../config.js')>('../../config.js')),
  get DATA_DIR() {
    return boundary.data;
  },
}));
vi.mock('../gws-ea-voice/config.js', () => ({ readVoiceReadiness: boundary.readiness }));
vi.mock('../gws-ea-voice/transcribe.js', async () => ({
  ...(await vi.importActual<typeof import('../gws-ea-voice/transcribe.js')>('../gws-ea-voice/transcribe.js')),
  transcribeAudio: boundary.transcribe,
}));
let h: TransportHarness;
beforeEach(async () => {
  h = await transportHarness();
  boundary.data = h.root;
  const installation: VerifiedVoiceInstallation = {
    installationDir: h.root,
    ffmpeg: 'unused-ffmpeg',
    whisperCli: 'unused-whisper',
    model: 'unused-model',
    vad: 'unused-vad',
    receipt: {
      schemaVersion: 1,
      recipe: VOICE_RECIPE_ID,
      platform: 'darwin',
      architecture: 'arm64',
      model: 'base',
      builtAt: '2026-10-18T00:00:00.000Z',
      artifacts: {
        ffmpeg: { file: 'bin/ffmpeg', size: 1, sha256: 'a'.repeat(64) },
        whisperCli: { file: 'bin/whisper-cli', size: 1, sha256: 'b'.repeat(64) },
        model: {
          file: VOICE_MODEL_CATALOG.base.filename,
          size: VOICE_MODEL_CATALOG.base.size,
          sha256: VOICE_MODEL_CATALOG.base.sha256,
        },
        vad: {
          file: VOICE_SOURCE_ARTIFACTS.vad.filename,
          size: VOICE_SOURCE_ARTIFACTS.vad.size,
          sha256: VOICE_SOURCE_ARTIFACTS.vad.sha256,
        },
      },
    },
  };
  boundary.readiness.mockResolvedValue({ status: 'ready', enabled: true, installation });
  boundary.transcribe.mockReset();
  boundary.transcribe.mockResolvedValue({
    status: 'recognized',
    text: 'Find a table for six on Friday.',
    language: 'en',
  });
});
afterEach(async () => {
  await h.close();
});
async function chatState(state: string): Promise<void> {
  await getDb().exec(
    'CREATE TABLE gws_ea_chats(messaging_group_id TEXT PRIMARY KEY,state TEXT NOT NULL,serving_agent_group_id TEXT)',
  );
  await createMessagingGroup({
    id: 'team',
    channel_type: 'whatsapp',
    platform_id: 'team@g.us',
    name: 'Team',
    is_group: 1,
    unknown_sender_policy: 'strict',
    created_at: new Date().toISOString(),
  });
  await getDb().run('INSERT INTO gws_ea_chats(messaging_group_id,state) VALUES(?,?)', 'team', state);
}
function preparation(platformId: string, content: unknown): InboundPreparationRequest {
  const timestamp = new Date().toISOString();
  return {
    channelType: 'whatsapp',
    instance: 'whatsapp',
    platformId,
    messageId: 'voice',
    timestamp,
    content: JSON.stringify(content),
    session: {
      id: 'session',
      agent_group_id: 'external-chat',
      messaging_group_id: 'team',
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: timestamp,
    },
    messagingGroup: {
      id: 'team',
      channel_type: 'whatsapp',
      platform_id: platformId,
      name: null,
      is_group: platformId.endsWith('@g.us') ? 1 : 0,
      unknown_sender_policy: 'strict',
      created_at: timestamp,
    },
  };
}
describe('WhatsApp media at the native voice boundary', () => {
  it.each(['team@g.us', '12000@lid'])('downloads and prepares the first voice note in %s', async (chat) => {
    await h.start();
    const key = chat.endsWith('@g.us')
      ? { id: 'voice', remoteJid: chat, participant: '12000@lid', participantAlt: '15551112222@s.whatsapp.net' }
      : { id: 'voice', remoteJid: chat, remoteJidAlt: '15551112222@s.whatsapp.net' };
    await h.socket().emit('messages.upsert', {
      type: 'notify',
      messages: [
        incoming('voice', '', {
          key,
          message: {
            audioMessage: {
              ptt: true,
              mimetype: 'audio/ogg; codecs=opus',
              fileLength: 1024,
              contextInfo: { isForwarded: true },
            },
          },
        }),
      ],
    });
    const content = h.content()[0];
    expect(content).toMatchObject({
      text: '',
      forwarded: true,
      attachments: [
        {
          type: 'audio',
          data: Buffer.from('real media boundary bytes').toString('base64'),
          mimeType: 'audio/ogg; codecs=opus',
          audioSource: { kind: 'voice-note', forwarded: true },
        },
      ],
    });
    const prepared = JSON.parse(await prepareVoiceContent(preparation(chat, content))) as {
      attachments: { speech: unknown }[];
    };
    expect(prepared.attachments[0].speech).toEqual({
      status: 'recognized',
      text: 'Find a table for six on Friday.',
      language: 'en',
    });
    expect(boundary.transcribe.mock.calls[0][0]).toEqual(Buffer.from('real media boundary bytes'));
  });
  it.each(['declined', 'detached'])('does not download media from a %s chat', async (state) => {
    await chatState(state);
    await h.start();
    await h.socket().emit('messages.upsert', {
      type: 'notify',
      messages: [
        incoming('declined-media', '', {
          message: { audioMessage: { ptt: true, mimetype: 'audio/ogg', fileLength: 100 } },
        }),
      ],
    });
    expect(h.download).not.toHaveBeenCalled();
    expect(h.content()[0].attachments?.[0]).toMatchObject({ name: 'audio.ogg', downloadError: 'chat-declined' });
  });
  it('downloads an unknown chat even when other chat policy rows already exist', async () => {
    await chatState('declined');
    await h.start();
    await h.socket().emit('messages.upsert', {
      type: 'notify',
      messages: [
        incoming('new-chat', '', {
          key: { id: 'new-chat', remoteJid: 'new@g.us', participant: '12000@lid' },
          message: { audioMessage: { ptt: true, mimetype: 'audio/ogg', fileLength: 100 } },
        }),
      ],
    });
    expect(h.download).toHaveBeenCalledTimes(1);
  });
  it('names oversized media without downloading it and recognizes forwardingScore on text', async () => {
    await h.start();
    await h.socket().emit('messages.upsert', {
      type: 'notify',
      messages: [
        incoming('large', '', {
          message: {
            documentMessage: {
              fileName: 'plans.pdf',
              mimetype: 'application/pdf',
              fileLength: 25 * 1024 * 1024 + 1,
              contextInfo: { forwardingScore: 2 },
            },
            extendedTextMessage: { text: 'An attached plan', contextInfo: { forwardingScore: 2 } },
          },
        }),
      ],
    });
    expect(h.download).not.toHaveBeenCalled();
    expect(h.content()[0]).toMatchObject({
      text: 'An attached plan',
      forwarded: true,
      attachments: [{ name: 'plans.pdf', mimeType: 'application/pdf', downloadError: 'too-large' }],
    });
    expect(h.content()[0].attachments?.[0].data).toBeUndefined();
  });
  it('retains a failed audio download as an attachment with a terminal speech outcome', async () => {
    h.download.mockRejectedValue(new Error('media unavailable'));
    await h.start();
    await h.socket().emit('messages.upsert', {
      type: 'notify',
      messages: [
        incoming('failed-media', '', {
          message: { audioMessage: { ptt: true, mimetype: 'audio/ogg', fileLength: 100 } },
        }),
      ],
    });
    expect(h.content()[0].attachments?.[0]).toMatchObject({
      type: 'audio',
      speech: { status: 'failed', reason: 'media-download-failed' },
    });
  });
});
