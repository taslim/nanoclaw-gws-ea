import { createCipheriv } from 'node:crypto';
import type { LookupAddress } from 'node:dns';
import type { Socket } from 'node:net';

import { getMediaKeys, type WAMessage } from '@whiskeysockets/baileys';
import type { Agent } from 'undici';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_WHATSAPP_MEDIA_BYTES, WHATSAPP_MEDIA_DOWNLOAD_TIMEOUT_MS } from './media-limits.js';
import { incoming } from './testing/fake-socket.js';
import { transportHarness, type TransportHarness } from './testing/harness.js';

interface Reply {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Buffer;
  readonly stall?: boolean;
  readonly error?: Error;
}
const network = vi.hoisted(() => ({
  lookup: vi.fn<(hostname: string) => Promise<LookupAddress[]>>(),
  respond: vi.fn<(host: string, path: string) => Reply>(),
  connections: [] as { host: string; addresses: string | LookupAddress[] }[],
  requests: [] as { host: string; path: string }[],
  sockets: [] as Socket[],
}));
vi.mock('node:dns/promises', () => ({ default: { lookup: network.lookup } }));
vi.mock('undici', async () => {
  const actual = await vi.importActual<typeof import('undici')>('undici');
  const { Socket: NativeSocket } = await import('node:net');
  class HttpSocket extends NativeSocket {
    private request = '';
    constructor(private readonly host: string) {
      super();
      network.sockets.push(this);
    }
    override _read(): void {
      // The in-memory HTTP peer pushes its response after receiving the request headers.
    }
    override _write(value: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
      this.request += value.toString();
      callback();
      if (!this.request.includes('\r\n\r\n')) return;
      const path = this.request.split(' ')[1];
      network.requests.push({ host: this.host, path });
      const reply = network.respond(this.host, path);
      queueMicrotask(() => {
        if (this.destroyed) return;
        const body = reply.body ?? Buffer.alloc(0);
        const headers = {
          'content-length': String(reply.stall ? 1_000_000 : body.length),
          connection: 'close',
          ...reply.headers,
        };
        this.push(
          Buffer.from(
            `HTTP/1.1 ${reply.status ?? 200} Response\r\n${Object.entries(headers)
              .map(([key, value]) => `${key}: ${value}`)
              .join('\r\n')}\r\n\r\n`,
          ),
        );
        if (body.length) this.push(body);
        if (reply.error) this.destroy(reply.error);
        else if (!reply.stall) this.push(null);
      });
    }
  }
  class MemoryAgent extends actual.Agent {
    constructor(options: Agent.Options = {}) {
      const connect = options.connect;
      if (!connect || typeof connect !== 'object' || !('lookup' in connect) || typeof connect.lookup !== 'function')
        throw new Error('Expected guarded native lookup');
      const lookup = connect.lookup;
      super({
        ...options,
        connect(target, callback) {
          lookup(target.hostname, { all: true }, (error, addresses) => {
            if (error) {
              callback(error, null);
              return;
            }
            network.connections.push({ host: target.hostname, addresses });
            callback(null, new HttpSocket(target.hostname));
          });
        },
      });
    }
  }
  return { ...actual, Agent: MemoryAgent };
});

let h: TransportHarness;
beforeEach(async () => {
  h = await transportHarness();
  network.lookup.mockReset();
  network.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
  network.respond.mockReset();
  network.respond.mockReturnValue({});
  network.connections.length = 0;
  network.requests.length = 0;
  network.sockets.length = 0;
});
afterEach(async () => {
  await h.close();
  vi.useRealTimers();
  expect(network.sockets.every((socket) => socket.destroyed)).toBe(true);
});
async function image(
  plaintext: Buffer,
  change: Partial<NonNullable<NonNullable<WAMessage['message']>['imageMessage']>> = {},
) {
  const mediaKey = Buffer.alloc(32, 11);
  const keys = await getMediaKeys(mediaKey, 'image');
  const cipher = createCipheriv('aes-256-cbc', keys.cipherKey, keys.iv);
  return {
    encrypted: Buffer.concat([cipher.update(plaintext), cipher.final(), Buffer.alloc(10)]),
    message: incoming('network-media', '', {
      message: {
        imageMessage: {
          url: 'https://mmg.whatsapp.net/image',
          mediaKey,
          fileLength: 1,
          mimetype: 'image/jpeg',
          ...change,
        },
      },
    }),
  };
}
async function receive(message: WAMessage): Promise<void> {
  await h.socket().emit('messages.upsert', { type: 'notify', messages: [message, incoming('next', 'Following text')] });
}
function failed(reason: string): void {
  expect(h.content()[0].attachments?.[0]).toMatchObject({ downloadError: reason });
  expect(h.content()[0].attachments?.[0].data).toBeUndefined();
  expect(h.content()[1].text).toBe('Following text');
}

describe('WhatsApp media native HTTP boundary without network sockets', () => {
  it('decrypts an attachment over the real HTTP dispatcher using only the validated DNS answer', async () => {
    const content = Buffer.from('A real encrypted attachment');
    const attachment = await image(content);
    network.respond.mockReturnValue({ body: attachment.encrypted });
    await h.start({ downloadMedia: undefined });
    await receive(attachment.message);
    expect(h.content()[0].attachments?.[0].data).toBe(content.toString('base64'));
    expect(network.connections).toEqual([{ host: 'mmg.whatsapp.net', addresses: [{ address: '8.8.8.8', family: 4 }] }]);
    expect(network.lookup).toHaveBeenCalledTimes(1);
    expect(network.requests).toEqual([{ host: 'mmg.whatsapp.net', path: '/image' }]);
  });

  it.each([
    'http://mmg.whatsapp.net/image',
    'https://user:secret@mmg.whatsapp.net/image',
    'https://mmg.whatsapp.net:8443/image',
    'https://mmg.whatsapp.net.attacker.example/image',
    'https://127.0.0.1/image',
  ])('refuses an untrusted initial location %s before DNS or HTTP', async (url) => {
    const attachment = await image(Buffer.from('image'), { url });
    await h.start({ downloadMedia: undefined });
    await receive(attachment.message);
    failed('media-download-failed');
    expect(network.lookup).not.toHaveBeenCalled();
    expect(network.requests).toEqual([]);
  });

  it('downloads a native directPath against the validated media host', async () => {
    const content = Buffer.from('Direct-path image');
    const attachment = await image(content, { url: undefined, directPath: '/direct?token=opaque' });
    network.respond.mockReturnValue({ body: attachment.encrypted });
    await h.start({ downloadMedia: undefined });
    await receive(attachment.message);
    expect(h.content()[0].attachments?.[0].data).toBe(content.toString('base64'));
    expect(network.requests).toEqual([{ host: 'mmg.whatsapp.net', path: '/direct?token=opaque' }]);
  });

  it('never lets directPath replace validation of the sender-selected URL host', async () => {
    const attachment = await image(Buffer.from('image'), { url: 'https://127.0.0.1/private', directPath: '/image' });
    await h.start({ downloadMedia: undefined });
    await receive(attachment.message);
    failed('media-download-failed');
    expect(network.requests).toEqual([]);
  });

  it.each(['127.0.0.1', '10.0.0.4', '169.254.169.254', '::1', '::ffff:8.8.8.8'])(
    'refuses a supported CDN that resolves to %s before connecting',
    async (address) => {
      const attachment = await image(Buffer.from('image'));
      network.lookup.mockResolvedValue([{ address, family: address.includes(':') ? 6 : 4 }]);
      await h.start({ downloadMedia: undefined });
      await receive(attachment.message);
      failed('media-download-failed');
      expect(network.connections).toEqual([]);
      expect(network.requests).toEqual([]);
    },
  );

  it('refuses mixed public/private DNS answers rather than selecting the public one', async () => {
    const attachment = await image(Buffer.from('image'));
    network.lookup.mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ]);
    await h.start({ downloadMedia: undefined });
    await receive(attachment.message);
    failed('media-download-failed');
    expect(network.connections).toEqual([]);
  });

  it('refuses a CDN redirect to loopback before issuing the redirected request', async () => {
    const attachment = await image(Buffer.from('image'));
    network.respond.mockReturnValue({ status: 302, headers: { location: 'http://127.0.0.1:8765/private' } });
    await h.start({ downloadMedia: undefined });
    await receive(attachment.message);
    failed('media-download-failed');
    expect(network.requests).toEqual([{ host: 'mmg.whatsapp.net', path: '/image' }]);
    expect(network.lookup).toHaveBeenCalledTimes(1);
  });

  it('checks DNS again when an allowed redirect changes CDN origin', async () => {
    const attachment = await image(Buffer.from('image'));
    network.respond.mockReturnValue({ status: 302, headers: { location: 'https://mmg-fna.whatsapp.net/redirected' } });
    network.lookup.mockImplementation(async (hostname) => [
      { address: hostname === 'mmg.whatsapp.net' ? '8.8.8.8' : '10.0.0.1', family: 4 },
    ]);
    await h.start({ downloadMedia: undefined });
    await receive(attachment.message);
    failed('media-download-failed');
    expect(network.requests).toEqual([{ host: 'mmg.whatsapp.net', path: '/image' }]);
    expect(network.lookup).toHaveBeenCalledTimes(2);
  });

  it('does not request a private location returned by native media reupload', async () => {
    const attachment = await image(Buffer.from('image'));
    network.respond.mockReturnValue({ status: 404 });
    await h.start({ downloadMedia: undefined });
    const reupload = vi.spyOn(h.socket(), 'updateMediaMessage').mockImplementation(async (message) => ({
      ...message,
      message: { imageMessage: { ...message.message?.imageMessage, url: 'https://127.0.0.1/private' } },
    }));
    await receive(attachment.message);
    failed('media-download-failed');
    expect(reupload).toHaveBeenCalledTimes(1);
    expect(network.requests).toEqual([{ host: 'mmg.whatsapp.net', path: '/image' }]);
  });

  it('preserves a successful native reupload through the same checked downloader', async () => {
    const content = Buffer.from('Reuploaded image');
    const attachment = await image(content);
    network.respond.mockImplementation((_host, path) =>
      path === '/image' ? { status: 410 } : { body: attachment.encrypted },
    );
    await h.start({ downloadMedia: undefined });
    vi.spyOn(h.socket(), 'updateMediaMessage').mockImplementation(async (message) => ({
      ...message,
      message: { imageMessage: { ...message.message?.imageMessage, url: 'https://mmg-fna.whatsapp.net/fresh' } },
    }));
    await receive(attachment.message);
    expect(h.content()[0].attachments?.[0].data).toBe(content.toString('base64'));
    expect(network.requests).toEqual([
      { host: 'mmg.whatsapp.net', path: '/image' },
      { host: 'mmg-fna.whatsapp.net', path: '/fresh' },
    ]);
  });

  it('cancels an understated oversized stream before EOF and routes the next message', async () => {
    const attachment = await image(Buffer.alloc(MAX_WHATSAPP_MEDIA_BYTES + 1024 * 1024));
    network.respond.mockReturnValue({
      body: attachment.encrypted,
      stall: true,
      headers: { 'content-length': String(attachment.encrypted.length + 1) },
    });
    const adapter = await h.start({ downloadMedia: undefined });
    let routed = false;
    const received = receive(attachment.message).then(() => {
      routed = true;
    });
    try {
      await vi.waitFor(() => expect(routed).toBe(true));
      failed('too-large');
      expect(network.sockets.every((socket) => socket.destroyed)).toBe(true);
    } finally {
      await adapter.teardown();
      await received;
    }
  });

  it('also caps decrypted bytes when ciphertext padding fits inside the transport allowance', async () => {
    const attachment = await image(Buffer.alloc(MAX_WHATSAPP_MEDIA_BYTES + 1));
    network.respond.mockReturnValue({ body: attachment.encrypted });
    await h.start({ downloadMedia: undefined });
    await receive(attachment.message);
    failed('too-large');
  });

  it('accepts the full 25 MB plaintext allowance including native encryption padding', async () => {
    const content = Buffer.alloc(MAX_WHATSAPP_MEDIA_BYTES, 19);
    const attachment = await image(content);
    network.respond.mockReturnValue({ body: attachment.encrypted });
    await h.start({ downloadMedia: undefined });
    await receive(attachment.message);
    const data = h.content()[0].attachments?.[0].data;
    expect(data).toBeDefined();
    expect(Buffer.from(data ?? '', 'base64').equals(content)).toBe(true);
  });

  it('settles a partial HTTP failure before passing a body to the native decryption stream', async () => {
    const attachment = await image(Buffer.from('image'));
    network.respond.mockReturnValue({
      body: attachment.encrypted.subarray(0, 8),
      stall: true,
      error: new Error('Connection lost'),
    });
    await h.start({ downloadMedia: undefined });
    await receive(attachment.message);
    failed('media-download-failed');
  });

  it('does not decompress an encoded HTTP response outside the encrypted-byte bound', async () => {
    const attachment = await image(Buffer.from('image'));
    network.respond.mockReturnValue({
      headers: { 'content-encoding': 'gzip' },
      body: Buffer.from('Not a permitted encrypted representation'),
    });
    await h.start({ downloadMedia: undefined });
    await receive(attachment.message);
    failed('media-download-failed');
  });

  it('expires a pending DNS lookup and ignores a later answer without connecting', async () => {
    const attachment = await image(Buffer.from('image'));
    let answer!: (addresses: LookupAddress[]) => void;
    network.lookup.mockImplementation(
      () =>
        new Promise<LookupAddress[]>((resolve) => {
          answer = resolve;
        }),
    );
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await h.start({ downloadMedia: undefined });
    const received = receive(attachment.message);
    await vi.waitFor(() => expect(network.lookup).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(WHATSAPP_MEDIA_DOWNLOAD_TIMEOUT_MS + 1);
    await received;
    failed('media-download-failed');
    answer([{ address: '8.8.8.8', family: 4 }]);
    await Promise.resolve();
    expect(network.connections).toEqual([]);
  });

  it('aborts the actual HTTP response at the total deadline and releases later inbound work', async () => {
    const attachment = await image(Buffer.from('image'));
    network.respond.mockReturnValue({ stall: true });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await h.start({ downloadMedia: undefined });
    const received = receive(attachment.message);
    await vi.waitFor(() => expect(network.requests).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(WHATSAPP_MEDIA_DOWNLOAD_TIMEOUT_MS + 1);
    await received;
    failed('media-download-failed');
    expect(network.sockets.every((socket) => socket.destroyed)).toBe(true);
  });

  it('cancels a pending HTTP response during native adapter teardown', async () => {
    const attachment = await image(Buffer.from('image'));
    network.respond.mockReturnValue({ stall: true });
    const adapter = await h.start({ downloadMedia: undefined });
    const received = receive(attachment.message);
    await vi.waitFor(() => expect(network.requests).toHaveLength(1));
    await adapter.teardown();
    await received;
    expect(network.sockets.every((socket) => socket.destroyed)).toBe(true);
    failed('media-download-failed');
  });
});
