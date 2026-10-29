import { createHash } from 'node:crypto';
import type { GmailHeader, GmailMessage, GmailMessagePart } from '../../../src/modules/gws-ea-inbox/gmail-api.js';
import { parseGmailMessage } from '../../../src/modules/gws-ea-inbox/mime.js';
import { googleError, googleJson } from './google-calendar.js';
import { SYNTHETIC_IDENTITY } from './state.js';

const header = (headers: readonly GmailHeader[], name: string): string | undefined =>
  headers.find((entry) => entry.name.toLowerCase() === name.toLowerCase())?.value;

function mimePart(raw: string): GmailMessagePart {
  const separator = raw.indexOf('\r\n\r\n');
  if (separator < 0) throw new Error('Synthetic Gmail received MIME without a header/body separator');
  const headers = raw
    .slice(0, separator)
    .replace(/\r\n[ \t]+/g, ' ')
    .split('\r\n')
    .map((line) => {
      const colon = line.indexOf(':');
      if (colon <= 0) throw new Error('Synthetic Gmail received an unreadable MIME header');
      return { name: line.slice(0, colon), value: line.slice(colon + 1).trim() };
    });
  const contentType = header(headers, 'Content-Type') ?? 'text/plain';
  const mimeType = contentType.split(';')[0]?.trim() ?? 'text/plain';
  const body = raw.slice(separator + 4);
  const boundary = /boundary="([^"]+)"|boundary=([^;\s]+)/i.exec(contentType);
  if (mimeType.startsWith('multipart/')) {
    const delimiter = boundary?.[1] ?? boundary?.[2];
    if (!delimiter) throw new Error('Synthetic Gmail received multipart MIME without a boundary');
    return {
      mimeType,
      headers,
      parts: body
        .split(`--${delimiter}`)
        .slice(1, -1)
        .map((piece) => mimePart(piece.replace(/^\r\n/, '').replace(/\r\n$/, ''))),
    };
  }
  const encoding = header(headers, 'Content-Transfer-Encoding')?.toLowerCase();
  let bytes: Buffer;
  if (encoding === 'base64') bytes = Buffer.from(body.replace(/\s/g, ''), 'base64');
  else if (encoding === 'quoted-printable') {
    const joined = body.replace(/=\r\n/g, '');
    const decoded: number[] = [];
    for (let index = 0; index < joined.length; index++) {
      if (joined[index] === '=' && /^[a-f0-9]{2}$/i.test(joined.slice(index + 1, index + 3))) {
        decoded.push(parseInt(joined.slice(index + 1, index + 3), 16));
        index += 2;
      } else decoded.push(joined.charCodeAt(index));
    }
    bytes = Buffer.from(decoded);
  } else bytes = Buffer.from(body, 'utf8');
  const filename = /filename="([^"]+)"/i.exec(header(headers, 'Content-Disposition') ?? '')?.[1];
  // Gmail supplies decoded bytes; the original MIME transfer encoding no longer applies.
  return {
    mimeType,
    headers: headers.filter((entry) => entry.name.toLowerCase() !== 'content-transfer-encoding'),
    ...(filename ? { filename } : {}),
    body: { size: bytes.length, data: bytes.toString('base64url') },
  };
}

function metadata(message: GmailMessage, url: URL): GmailMessage {
  if (url.searchParams.get('format') !== 'metadata') return message;
  const names = new Set(url.searchParams.getAll('metadataHeaders').map((name) => name.toLowerCase()));
  return {
    ...message,
    payload: {
      headers: message.payload?.headers?.filter((entry) => !names.size || names.has(entry.name.toLowerCase())),
    },
  };
}

/** One canonical Gmail store. Gmail itself does not deduplicate sends; native send recovery must do that. */
export class SyntheticGmailTransport {
  failAfterNextSend = false;
  constructor(readonly mail: GmailMessage[]) {}

  async request(url: URL, init?: RequestInit): Promise<Response> {
    const method = init?.method ?? 'GET';
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (url.pathname === '/gmail/v1/users/me/profile' && method === 'GET')
      return googleJson({
        emailAddress: SYNTHETIC_IDENTITY.assistantEmail,
        historyId: String(1000 + this.mail.length),
      });
    if (url.pathname === '/gmail/v1/users/me/messages/send' && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { readonly raw: string; readonly threadId?: string };
      const payload = mimePart(Buffer.from(body.raw, 'base64url').toString('utf8'));
      if (body.threadId && !this.mail.some((message) => message.threadId === body.threadId))
        return googleError(404, 'Thread not found');
      const number = this.mail.length + 1;
      const id = createHash('sha256').update(body.raw).update(String(number)).digest('hex').slice(0, 16);
      const message: GmailMessage = {
        id,
        threadId: body.threadId ?? id,
        labelIds: ['SENT'],
        internalDate: String(Date.parse('2026-11-01T12:00:00Z') + number),
        payload,
      };
      const parsed = parseGmailMessage(message);
      this.mail.push({ ...message, snippet: parsed.text.slice(0, 200) });
      if (this.failAfterNextSend) {
        this.failAfterNextSend = false;
        throw new Error('Synthetic transport lost Gmail send response after storing the message');
      }
      return googleJson({ id, threadId: message.threadId, labelIds: ['SENT'] });
    }
    if (method !== 'GET') throw new Error(`Unsupported synthetic Gmail operation: ${method} ${url.pathname}`);
    const messages = parts.indexOf('messages');
    if (messages >= 0) {
      const id = parts[messages + 1];
      if (parts[messages + 2] !== undefined) throw new Error(`Unsupported synthetic Gmail read: ${url.pathname}`);
      if (id) {
        const message = this.mail.find((entry) => entry.id === id);
        return message ? googleJson(metadata(message, url)) : googleError(404, 'Message not found');
      }
      const q = url.searchParams.get('q') ?? '';
      const messageId = /rfc822msgid:([^\s]+)/i.exec(q)?.[1]?.replace(/^<|>$/g, '');
      const labels = url.searchParams.getAll('labelIds');
      const selected = this.mail.filter(
        (message) =>
          labels.every((label) => message.labelIds?.includes(label)) &&
          (!messageId ||
            (message.payload?.headers ?? []).some(
              (entry) =>
                ['message-id', 'x-google-original-message-id'].includes(entry.name.toLowerCase()) &&
                entry.value.includes(`<${messageId}>`),
            )),
      );
      if (q && !messageId) throw new Error(`Unsupported synthetic Gmail query: ${q}`);
      return googleJson({
        messages: selected
          .slice()
          .reverse()
          .slice(0, Number(url.searchParams.get('maxResults') ?? 100))
          .map(({ id, threadId, labelIds }) => ({ id, threadId, labelIds })),
        resultSizeEstimate: selected.length,
      });
    }
    const threads = parts.indexOf('threads');
    if (threads >= 0 && parts[threads + 1] && parts[threads + 2] === undefined) {
      const id = parts[threads + 1];
      const messages = this.mail.filter((entry) => entry.threadId === id);
      return messages.length
        ? googleJson({ id, messages: messages.map((message) => metadata(message, url)) })
        : googleError(404, 'Thread not found');
    }
    throw new Error(`Unsupported synthetic Gmail read: ${url.pathname}`);
  }
}
