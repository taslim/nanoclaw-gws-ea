import dns from 'node:dns/promises';
import type { LookupFunction } from 'node:net';
import type { Transform } from 'node:stream';

import { assertMediaContent, downloadMediaMessage, type WAMessage } from '@whiskeysockets/baileys';
import ipaddr from 'ipaddr.js';
import { Agent, type Dispatcher } from 'undici';

import { isRecord } from '../../gws-ea/validation.js';
import {
  MAX_WHATSAPP_MEDIA_BYTES,
  WHATSAPP_MEDIA_DOWNLOAD_TIMEOUT_MS,
  WhatsAppMediaTooLargeError,
} from './media-limits.js';

// Baileys' default media host and WhatsApp's alternate media CDN; no arbitrary Meta or user-selected hosts.
const MEDIA_HOSTS = new Set(['mmg.whatsapp.net', 'mmg-fna.whatsapp.net']);
const MAX_ENCRYPTED_BYTES = MAX_WHATSAPP_MEDIA_BYTES + 16 + 10;

function mediaUrl(value: string | URL): URL {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port !== '' && url.port !== '443') ||
    !MEDIA_HOSTS.has(url.hostname)
  ) {
    throw new Error('WhatsApp media destination refused');
  }
  return url;
}

function validateMessage(message: WAMessage): void {
  const media = assertMediaContent(message.message ?? {});
  if (media.url) mediaUrl(media.url);
  if (
    media.directPath &&
    (!media.directPath.startsWith('/') ||
      /[\\#]/u.test(media.directPath) ||
      Array.from(media.directPath).some((character) => character.charCodeAt(0) <= 0x20))
  ) {
    throw new Error('WhatsApp media path refused');
  }
}

function publicAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  const parsed = ipaddr.parse(address);
  return parsed.range() === 'unicast' && (parsed.kind() === 'ipv4' || parsed.match(ipaddr.parse('2000::'), 3));
}

function retryableStatus(error: unknown): boolean {
  return (
    isRecord(error) && isRecord(error.output) && (error.output.statusCode === 404 || error.output.statusCode === 410)
  );
}

/** Native HTTP bodies finish under a byte cap before Baileys pipes them: rc14 does not forward source-stream errors. */
function boundedBody(dispatch: Dispatcher.Dispatch): Dispatcher.Dispatch {
  return (options, handler) => {
    if (!options.origin || options.method !== 'GET') throw new Error('WhatsApp media request refused');
    mediaUrl(new URL(options.path, options.origin));
    let response:
      | {
          status: number;
          headers: Parameters<NonNullable<Dispatcher.DispatchHandler['onResponseStart']>>[2];
          statusMessage?: string;
        }
      | undefined;
    let size = 0;
    const chunks: Buffer[] = [];
    return dispatch(options, {
      onRequestStart(controller, context: unknown) {
        handler.onRequestStart?.(controller, context);
      },
      onResponseStart(controller, status, headers, statusMessage) {
        const encoding = headers['content-encoding'];
        if (encoding && encoding !== 'identity') {
          controller.abort(new Error('Encoded WhatsApp media response refused'));
          return;
        }
        response = { status, headers, statusMessage };
      },
      onResponseData(controller, chunk) {
        size += chunk.length;
        if (size > MAX_ENCRYPTED_BYTES) {
          controller.abort(new WhatsAppMediaTooLargeError());
          return;
        }
        chunks.push(chunk);
      },
      onResponseEnd(controller, trailers) {
        if (!response || controller.aborted) return;
        const body = Buffer.concat(chunks, size);
        chunks.length = 0;
        handler.onResponseStart?.(controller, response.status, response.headers, response.statusMessage);
        if (body.length) handler.onResponseData?.(controller, body);
        handler.onResponseEnd?.(controller, trailers);
      },
      onResponseError(controller, error) {
        chunks.length = 0;
        handler.onResponseError?.(controller, error);
      },
    });
  };
}

export async function downloadWhatsAppMedia(
  message: WAMessage,
  reupload: (message: WAMessage) => Promise<WAMessage>,
  signal: AbortSignal,
): Promise<Buffer> {
  validateMessage(message);
  const control = new AbortController();
  let failure: Error = new Error('WhatsApp media download cancelled');
  const cancel = (): void => control.abort(failure);
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  const lookup: LookupFunction = (hostname, options, callback) => {
    let completed = false;
    const finish: typeof callback = (error, address, family) => {
      if (completed) return;
      completed = true;
      control.signal.removeEventListener('abort', aborted);
      callback(error, address, family);
    };
    const aborted = (): void => finish(failure, '');
    control.signal.addEventListener('abort', aborted, { once: true });
    if (control.signal.aborted) {
      aborted();
      return;
    }
    void dns.lookup(hostname, { all: true, verbatim: true }).then(
      (answers) => {
        if (answers.length === 0 || answers.some(({ address }) => !publicAddress(address))) {
          finish(new Error('WhatsApp media DNS destination refused'), '');
          return;
        }
        const selected = answers[0];
        finish(null, options.all ? answers : selected.address, selected.family);
      },
      (error: unknown) => finish(error instanceof Error ? error : new Error('WhatsApp media DNS lookup failed'), ''),
    );
  };
  const agent = new Agent({
    connect: { lookup, timeout: WHATSAPP_MEDIA_DOWNLOAD_TIMEOUT_MS },
    headersTimeout: WHATSAPP_MEDIA_DOWNLOAD_TIMEOUT_MS,
    bodyTimeout: WHATSAPP_MEDIA_DOWNLOAD_TIMEOUT_MS,
    connections: 1,
  });
  const dispatcher = agent.compose(boundedBody);
  let rejectAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(failure);
    control.signal.addEventListener('abort', rejectAbort, { once: true });
    if (control.signal.aborted) rejectAbort();
  });
  const timer = setTimeout(() => {
    failure = new Error('WhatsApp media download timed out');
    cancel();
  }, WHATSAPP_MEDIA_DOWNLOAD_TIMEOUT_MS);
  timer.unref();
  let stream: Transform | undefined;
  async function read(current: WAMessage): Promise<Buffer> {
    if (control.signal.aborted) throw failure;
    validateMessage(current);
    // Node 22's RequestInit names its bundled Undici 6 type; the native dispatch contract also accepts this pinned Agent.
    const options: RequestInit = {};
    Object.assign(options, { dispatcher });
    stream = await downloadMediaMessage(current, 'stream', { options });
    if (control.signal.aborted) throw failure;
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const value of stream) {
      const chunk: unknown = value;
      if (!Buffer.isBuffer(chunk)) throw new Error('WhatsApp media stream yielded non-binary data');
      size += chunk.length;
      if (size > MAX_WHATSAPP_MEDIA_BYTES) throw new WhatsAppMediaTooLargeError();
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, size);
  }
  async function download(): Promise<Buffer> {
    try {
      return await read(message);
    } catch (error) {
      if (!retryableStatus(error) || control.signal.aborted) throw error;
      return read(await reupload(message));
    }
  }
  try {
    return await Promise.race([download(), aborted]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
    control.signal.removeEventListener('abort', rejectAbort);
    stream?.destroy();
    await agent.destroy();
  }
}
