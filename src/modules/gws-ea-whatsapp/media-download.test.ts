import { createCipheriv } from 'node:crypto';

import { getMediaKeys, type WAMessage } from '@whiskeysockets/baileys';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { incoming } from './testing/fake-socket.js';
import { transportHarness, type TransportHarness } from './testing/harness.js';

let h: TransportHarness;
beforeEach(async () => {
  h = await transportHarness();
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await h.close();
});
async function encryptedImage(
  url: string,
  plaintext = Buffer.from('image bytes'),
): Promise<{
  readonly message: WAMessage;
  readonly encrypted: Buffer;
}> {
  const mediaKey = Buffer.alloc(32, 7);
  const keys = await getMediaKeys(mediaKey, 'image');
  const cipher = createCipheriv('aes-256-cbc', keys.cipherKey, keys.iv);
  return {
    message: incoming('media', '', {
      message: { imageMessage: { url, mediaKey, fileLength: 1, mimetype: 'image/jpeg' } },
    }),
    encrypted: Buffer.concat([cipher.update(plaintext), cipher.final(), Buffer.alloc(10)]),
  };
}

describe('default WhatsApp media downloader', () => {
  it('refuses a sender-selected loopback URL before requesting it', async () => {
    const image = await encryptedImage('http://127.0.0.1:8765/private');
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(image.encrypted));
    await h.start({ downloadMedia: undefined });
    await h.socket().emit('messages.upsert', { type: 'notify', messages: [image.message] });
    expect(fetch).not.toHaveBeenCalled();
    expect(h.content()[0].attachments?.[0]).toMatchObject({ downloadError: 'media-download-failed' });
  });

  it('releases the inbound queue after a media download exceeds its total deadline', async () => {
    const image = await encryptedImage('https://mmg.whatsapp.net/image');
    let finish!: () => void;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(image.encrypted);
        finish = () => controller.close();
      },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await h.start({ downloadMedia: undefined });
    let routed = false;
    const received = h
      .socket()
      .emit('messages.upsert', { type: 'notify', messages: [image.message, incoming('after-media', 'Still here')] })
      .then(() => {
        routed = true;
      });
    try {
      await vi.advanceTimersByTimeAsync(31_000);
      expect(routed).toBe(true);
      expect(h.content().map((content) => content.text)).toEqual(['', 'Still here']);
      expect(h.content()[0].attachments?.[0]).toMatchObject({ downloadError: 'media-download-failed' });
    } finally {
      finish();
      await received;
    }
  });
});
