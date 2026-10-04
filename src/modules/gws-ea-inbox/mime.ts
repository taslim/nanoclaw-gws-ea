/**
 * Mail on the wire: reading the messages Gmail returns, and writing email in
 * their thread.
 *
 * Inbound, only headers and readable text are taken; attachments are counted,
 * never fetched. Outbound, an email is its rendered HTML and the plain text it
 * was written in (KTD6), quoted-printable, with any files after them. It is
 * addressed to exactly the To, Cc, and Bcc it is given, and no value can add a
 * header, because every header value is reduced to one line.
 *
 * Bcc goes in a header because that is the only way `users.messages.send`
 * takes recipients: Gmail sends to the To, Cc, and Bcc headers of the raw
 * message, and removes Bcc from the copies it delivers. Gmail reads those
 * headers only above the MIME headers, so they come first.
 */
import { randomBytes, randomUUID } from 'node:crypto';

import type { OutboundFile } from '../../channels/adapter.js';
import { EMAIL_PATTERN } from '../../gws-ea/validation.js';
import type { GmailMessage, GmailMessagePart } from './gmail-api.js';

export interface MailHeader {
  readonly name: string;
  readonly value: string;
}

/** One mailbox: its address, lowercased, and the display name it was written with, if any. */
export interface Mailbox {
  readonly address: string;
  readonly displayName?: string;
}

/** A Gmail message reduced to what routing reads. */
export interface ParsedMail {
  readonly id: string;
  readonly threadId: string;
  readonly labelIds: readonly string[];
  /** Every header, topmost first, as Gmail returned them. */
  readonly headers: readonly MailHeader[];
  /** The one From mailbox, or undefined when From is missing or names more than one. */
  readonly from: Mailbox | undefined;
  readonly to: readonly Mailbox[];
  readonly cc: readonly Mailbox[];
  readonly subject: string;
  readonly rfcMessageId: string | undefined;
  readonly inReplyTo: readonly string[];
  readonly references: readonly string[];
  /** The readable text: the plain-text part, or the HTML part's text when there is none. */
  readonly text: string;
  /** The HTML part as sent, for reading links; never shown to an agent. */
  readonly html: string | undefined;
  readonly attachmentCount: number;
  /** When Gmail received it, from `internalDate`; undefined when Gmail gave none. */
  readonly receivedAt: Date | undefined;
}

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

export function headerValues(headers: readonly MailHeader[], name: string): string[] {
  const wanted = name.toLowerCase();
  return headers.filter((header) => header.name.toLowerCase() === wanted).map((header) => header.value);
}

export function headerValue(headers: readonly MailHeader[], name: string): string | undefined {
  return headerValues(headers, name)[0];
}

function decodeBytes(bytes: Buffer, charset: string): string {
  /* eslint-disable no-catch-all/no-catch-all -- an unknown charset label reads as UTF-8 rather than failing the message */
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return bytes.toString('utf8');
  }
  /* eslint-enable no-catch-all/no-catch-all */
}

function decodeQ(text: string): Buffer {
  const bytes: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '_') bytes.push(0x20);
    else if (character === '=' && /^[0-9A-Fa-f]{2}$/u.test(text.slice(index + 1, index + 3))) {
      bytes.push(parseInt(text.slice(index + 1, index + 3), 16));
      index += 2;
    } else bytes.push(character.charCodeAt(0) & 0xff);
  }
  return Buffer.from(bytes);
}

const ENCODED_WORD = /=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/gu;

/** RFC 2047 encoded words, decoded; whitespace between two adjacent encoded words is dropped. */
export function decodeEncodedWords(value: string): string {
  const joined = value.replace(/(=\?[^?\s]+\?[BbQq]\?[^?\s]*\?=)\s+(?==\?[^?\s]+\?[BbQq]\?[^?\s]*\?=)/gu, '$1');
  return joined.replace(ENCODED_WORD, (_word, charset: string, encoding: string, text: string) => {
    const bytes = encoding.toUpperCase() === 'B' ? Buffer.from(text, 'base64') : decodeQ(text);
    return decodeBytes(bytes, charset.split('*')[0] ?? 'utf-8');
  });
}

/** Comments in parentheses removed, honoring quoted strings and escapes. */
function stripComments(value: string): string {
  let out = '';
  let depth = 0;
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '\\' && (quoted || depth > 0)) {
      if (depth === 0) out += character + (value[index + 1] ?? '');
      index += 1;
      continue;
    }
    if (depth === 0 && character === '"') quoted = !quoted;
    if (!quoted) {
      if (character === '(') {
        depth += 1;
        continue;
      }
      if (character === ')' && depth > 0) {
        depth -= 1;
        continue;
      }
    }
    if (depth === 0) out += character;
  }
  return out;
}

/** Split on `separator` where it is outside quotes, comments, and angle brackets. */
function splitTopLevel(value: string, separator: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  let angle = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '\\' && quoted) {
      current += character + (value[index + 1] ?? '');
      index += 1;
      continue;
    }
    if (character === '"') quoted = !quoted;
    else if (!quoted && character === '<') angle += 1;
    else if (!quoted && character === '>' && angle > 0) angle -= 1;
    if (!quoted && angle === 0 && character === separator) {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\(.)/gu, '$1');
  }
  return trimmed;
}

/** An address as compared everywhere: trimmed and lowercased; undefined when it is no address. */
export function normalizeAddress(value: string): string | undefined {
  const address = value.trim().toLowerCase();
  if (address.length > 254 || !EMAIL_PATTERN.test(address) || /[<>"(),;:\\[\]]/u.test(address)) return undefined;
  return address;
}

export function domainOf(address: string): string {
  return address.slice(address.lastIndexOf('@') + 1);
}

/**
 * An address list (From, To, Cc, Sender). Undefined when any entry is not a
 * mailbox, including group syntax, so a malformed list never yields a partial
 * one.
 */
export function parseAddressList(value: string): Mailbox[] | undefined {
  const mailboxes: Mailbox[] = [];
  for (const raw of splitTopLevel(value.replace(/\r?\n[ \t]+/gu, ' '), ',')) {
    const entry = stripComments(raw).trim();
    if (entry === '') continue;
    if (splitTopLevel(entry, ':').length > 1) return undefined;
    const open = entry.lastIndexOf('<');
    let address: string | undefined;
    let displayName: string | undefined;
    if (open >= 0) {
      const close = entry.indexOf('>', open);
      if (close < 0 || entry.slice(close + 1).trim() !== '') return undefined;
      address = normalizeAddress(entry.slice(open + 1, close));
      const name = decodeEncodedWords(unquote(entry.slice(0, open))).trim();
      if (name !== '') displayName = name;
    } else {
      address = normalizeAddress(entry);
    }
    if (address === undefined) return undefined;
    mailboxes.push(displayName === undefined ? { address } : { address, displayName });
  }
  return mailboxes.length > 0 ? mailboxes : undefined;
}

/** The `<id>` tokens of a Message-ID, In-Reply-To, or References header. */
export function messageIdsOf(value: string | undefined): string[] {
  if (value === undefined) return [];
  return [...value.matchAll(/<[^<>\s]+>/gu)].map((match) => match[0]);
}

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

function charsetOf(part: GmailMessagePart): string {
  const contentType = headerValue(part.headers ?? [], 'Content-Type') ?? '';
  return /charset\s*=\s*"?([^";\s]+)"?/iu.exec(contentType)?.[1]?.toLowerCase() ?? 'utf-8';
}

function partText(part: GmailMessagePart): string | undefined {
  const data = part.body?.data;
  if (data === undefined) return undefined;
  return decodeBytes(Buffer.from(data, 'base64url'), charsetOf(part)).replace(/\r\n?/gu, '\n');
}

function isAttachment(part: GmailMessagePart): boolean {
  return (part.filename ?? '') !== '' || part.body?.attachmentId !== undefined;
}

function walk(part: GmailMessagePart, visit: (part: GmailMessagePart) => void): void {
  visit(part);
  for (const child of part.parts ?? []) walk(child, visit);
}

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** The readable text of an HTML part: tags and scripts dropped, breaks kept, entities decoded. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, '')
    .replace(/<br\s*\/?>/giu, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)\s*>/giu, '\n')
    .replace(/<[^>]*>/gu, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (entity, code: string) => {
      if (code.startsWith('#x') || code.startsWith('#X')) return String.fromCodePoint(parseInt(code.slice(2), 16));
      if (code.startsWith('#')) return String.fromCodePoint(parseInt(code.slice(1), 10));
      return ENTITIES[code.toLowerCase()] ?? entity;
    })
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function receivedAt(internalDate: string | undefined): Date | undefined {
  if (internalDate === undefined || !/^\d{1,15}$/u.test(internalDate)) return undefined;
  const date = new Date(Number(internalDate));
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** A Gmail message (format `full` or `metadata`) reduced to what routing reads. */
export function parseGmailMessage(message: GmailMessage): ParsedMail {
  const payload = message.payload ?? {};
  const headers = payload.headers ?? [];
  let plain: string | undefined;
  let html: string | undefined;
  let attachmentCount = 0;
  walk(payload, (part) => {
    if (isAttachment(part)) {
      attachmentCount += 1;
      return;
    }
    const type = (part.mimeType ?? '').toLowerCase();
    if (type === 'text/plain' && plain === undefined) plain = partText(part);
    else if (type === 'text/html' && html === undefined) html = partText(part);
  });
  const fromList = parseAddressList(headerValues(headers, 'From').join(', '));
  const from = headerValues(headers, 'From').length === 1 && fromList?.length === 1 ? fromList[0] : undefined;
  const list = (name: string) => parseAddressList(headerValues(headers, name).join(', ')) ?? [];
  return {
    id: message.id,
    threadId: message.threadId,
    labelIds: message.labelIds ?? [],
    headers,
    from,
    to: list('To'),
    cc: list('Cc'),
    subject: decodeEncodedWords(headerValue(headers, 'Subject') ?? '')
      .replace(/\s+/gu, ' ')
      .trim(),
    rfcMessageId: messageIdsOf(headerValue(headers, 'Message-ID'))[0],
    inReplyTo: messageIdsOf(headerValue(headers, 'In-Reply-To')),
    references: messageIdsOf(headerValue(headers, 'References')),
    text: (plain ?? (html === undefined ? '' : htmlToText(html))).trim(),
    html,
    attachmentCount,
    receivedAt: receivedAt(message.internalDate),
  };
}

const QUOTE_START = [
  /^>/u,
  /^On\b.*\bwrote:\s*$/u,
  /^-{2,}\s*Forwarded message\s*-{2,}/iu,
  /^-{3,}\s*Original Message\s*-{3,}/iu,
  /^_{10,}\s*$/u,
];

/**
 * The writer's own words, and everything quoted or forwarded below them.
 * Quoted text is someone else's, so it is never read as the writer's.
 */
export function splitQuoted(text: string): { readonly own: string; readonly quoted: string } {
  const lines = text.replace(/\r\n?/gu, '\n').split('\n');
  const start = lines.findIndex((line, index) => {
    if (QUOTE_START.some((pattern) => pattern.test(line))) return true;
    // "On <date>, <name>" wrapped onto a second line ending in "wrote:".
    return /^On\b/u.test(line) && /\bwrote:\s*$/u.test(lines[index + 1] ?? '');
  });
  if (start < 0) return { own: text.trim(), quoted: '' };
  return { own: lines.slice(0, start).join('\n').trim(), quoted: lines.slice(start).join('\n').trim() };
}

// ---------------------------------------------------------------------------
// Outbound
// ---------------------------------------------------------------------------

/** An email as `buildMime` writes it. */
export interface OutgoingMail {
  readonly from: Mailbox;
  /** The recipients, exactly as placed; together they are what the audience check saw. */
  readonly to: readonly string[];
  readonly cc: readonly string[];
  /** Delivered to, never shown to anyone else. */
  readonly bcc: readonly string[];
  /** The thread's subject; a reply's gains "Re:" once. */
  readonly subject: string;
  readonly messageId: string;
  /** The message this answers, which makes it a reply. */
  readonly inReplyTo?: string;
  readonly references: readonly string[];
  /** The body as `renderEmail` made it: the plain text it was written in, and its HTML. */
  readonly text: string;
  readonly html: string;
  /** Files sent after the body. */
  readonly attachments?: readonly OutboundFile[];
  readonly date: Date;
}

/** What every email's headers say about who it is from and to, and where it sits in its thread. */
type Addressing = Omit<OutgoingMail, 'text' | 'html' | 'attachments'>;

/** Slice 2's plain-text reply, which outbound sends until it sends rendered email through `buildMime`. */
export interface OutboundMime extends Addressing {
  readonly text: string;
}

/** The longest line written: RFC 2045 holds encoded lines to 76 characters, and headers fold to the same. */
const MAX_LINE = 76;
/** UTF-8 bytes per RFC 2047 encoded word, so a header's name and its first word fit on one line. */
const ENCODED_WORD_BYTES = 39;

function isControl(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return code <= 0x1f || code === 0x7f;
}

/** One line, with no control character that could end a header early. */
export function oneLine(value: string): string {
  return Array.from(value, (character) => (isControl(character) ? ' ' : character))
    .join('')
    .replace(/\s+/gu, ' ')
    .trim();
}

function isPlainAscii(value: string): boolean {
  return /^[\x20-\x7e]*$/u.test(value);
}

/** RFC 2047 encoded words, each of whole characters, separated by spaces a header folds at. */
function encodeWords(value: string): string {
  const word = (chunk: string) => `=?UTF-8?B?${Buffer.from(chunk, 'utf8').toString('base64')}?=`;
  const words: string[] = [];
  let chunk = '';
  for (const character of value) {
    if (chunk !== '' && Buffer.byteLength(chunk + character, 'utf8') > ENCODED_WORD_BYTES) {
      words.push(word(chunk));
      chunk = '';
    }
    chunk += character;
  }
  if (chunk !== '') words.push(word(chunk));
  return words.join(' ');
}

function headerText(value: string): string {
  const line = oneLine(value);
  return isPlainAscii(line) ? line : encodeWords(line);
}

function mailboxText(mailbox: Mailbox): string {
  const name = mailbox.displayName === undefined ? '' : oneLine(mailbox.displayName);
  if (name === '') return mailbox.address;
  if (!isPlainAscii(name)) return `${encodeWords(name)} <${mailbox.address}>`;
  return /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~ ]+$/u.test(name)
    ? `${name} <${mailbox.address}>`
    : `"${name.replace(/(["\\])/gu, '\\$1')}" <${mailbox.address}>`;
}

/** `Name: value`, folded at spaces so each line stays within 76 characters wherever a space allows. */
function headerLine(name: string, value: string): string {
  const [first, ...rest] = value.split(' ');
  const lines: string[] = [];
  let line = `${name}: ${first}`;
  for (const word of rest) {
    if (line.length + 1 + word.length > MAX_LINE) {
      lines.push(line);
      line = ` ${word}`;
    } else line += ` ${word}`;
  }
  return [...lines, line].join('\r\n');
}

function replySubject(subject: string): string {
  return subject === '' || /^re:/iu.test(subject) ? subject : `Re: ${subject}`;
}

function messageIdToken(value: string): string {
  if (!/^<[^<>\s]+>$/u.test(value)) throw new Error(`Not a message ID: ${JSON.stringify(value)}`);
  return value;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** An RFC 5322 date in UTC. */
function mailDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${DAYS[date.getUTCDay()]}, ${pad(date.getUTCDate())} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`
  );
}

function addressLine(name: 'To' | 'Cc' | 'Bcc', addresses: readonly string[]): string[] {
  if (addresses.length === 0) return [];
  const checked = addresses.map((address) => {
    const normalized = normalizeAddress(address);
    if (normalized === undefined) throw new Error(`Not an email address: ${JSON.stringify(address)}`);
    return normalized;
  });
  return [headerLine(name, checked.join(', '))];
}

/** The headers above the MIME ones, Bcc among them, in the order Gmail reads them. */
function addressingHeaders(mail: Addressing): string[] {
  if (mail.to.length + mail.cc.length + mail.bcc.length === 0) {
    throw new Error('A message needs at least one recipient');
  }
  const subject = oneLine(mail.subject);
  const references = mail.references.map(messageIdToken);
  return [
    headerLine('From', mailboxText(mail.from)),
    ...addressLine('To', mail.to),
    ...addressLine('Cc', mail.cc),
    ...addressLine('Bcc', mail.bcc),
    headerLine('Subject', headerText(mail.inReplyTo === undefined ? subject : replySubject(subject))),
    `Date: ${mailDate(mail.date)}`,
    `Message-ID: ${messageIdToken(mail.messageId)}`,
    ...(mail.inReplyTo === undefined ? [] : [`In-Reply-To: ${messageIdToken(mail.inReplyTo)}`]),
    ...(references.length === 0 ? [] : [headerLine('References', references.join(' '))]),
    'MIME-Version: 1.0',
  ];
}

/** A MIME entity: its own headers, and its body as it goes on the wire. */
interface Entity {
  readonly headers: readonly string[];
  readonly body: string;
}

function serialize(entity: Entity): string {
  return `${entity.headers.join('\r\n')}\r\n\r\n${entity.body}`;
}

/** One line of text, quoted-printable (RFC 2045 §6.7), soft-broken so no encoded line passes 76 characters. */
function quotedPrintableLine(line: string): string {
  const bytes = Buffer.from(line, 'utf8');
  const lines: string[] = [];
  let current = '';
  bytes.forEach((byte, index) => {
    const blank = byte === 0x20 || byte === 0x09;
    const literal = (byte >= 0x21 && byte <= 0x7e && byte !== 0x3d) || (blank && index < bytes.length - 1);
    const token = literal ? String.fromCharCode(byte) : `=${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    if (current.length + token.length > MAX_LINE - 1) {
      lines.push(`${current}=`);
      current = '';
    }
    current += token;
  });
  return [...lines, current].join('\r\n');
}

function textEntity(subtype: 'plain' | 'html', content: string): Entity {
  return {
    headers: [`Content-Type: text/${subtype}; charset=UTF-8`, 'Content-Transfer-Encoding: quoted-printable'],
    body: content
      .split(/\r\n|\r|\n/u)
      .map(quotedPrintableLine)
      .join('\r\n'),
  };
}

/** The types of the files people send most; any other goes as bytes, which mail clients name by extension. */
const ATTACHMENT_TYPES: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  ics: 'text/calendar',
  txt: 'text/plain',
  csv: 'text/csv',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
};

/** A file's name as a parameter: quoted when it is plain ASCII, RFC 2231 encoded when it is not. */
function fileParameter(name: 'name' | 'filename', filename: string): string {
  const value = oneLine(filename);
  if (isPlainAscii(value)) return `${name}="${value.replace(/(["\\])/gu, '\\$1')}"`;
  const encoded = encodeURIComponent(value).replace(
    /['()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${name}*=UTF-8''${encoded}`;
}

function attachmentEntity(file: OutboundFile): Entity {
  const extension = /\.([A-Za-z0-9]+)$/u.exec(file.filename)?.[1]?.toLowerCase() ?? '';
  const type = ATTACHMENT_TYPES[extension] ?? 'application/octet-stream';
  return {
    headers: [
      headerLine('Content-Type', `${type}; ${fileParameter('name', file.filename)}`),
      headerLine('Content-Disposition', `attachment; ${fileParameter('filename', file.filename)}`),
      'Content-Transfer-Encoding: base64',
    ],
    body: (file.data.toString('base64').match(/.{1,76}/gu) ?? []).join('\r\n'),
  };
}

/** Parts under a fresh random boundary, which no part can contain by chance. */
function multipart(subtype: 'alternative' | 'mixed', parts: readonly Entity[]): Entity {
  const boundary = `=_${randomBytes(12).toString('hex')}`;
  return {
    headers: [headerLine('Content-Type', `multipart/${subtype}; boundary="${boundary}"`)],
    body: `${parts.map((part) => `--${boundary}\r\n${serialize(part)}\r\n`).join('')}--${boundary}--`,
  };
}

/**
 * An email, as the RFC 822 text `users.messages.send` takes (before
 * base64url): `multipart/alternative` with the plain text first, inside
 * `multipart/mixed` when files go with it.
 */
export function buildMime(mail: OutgoingMail): string {
  const headers = addressingHeaders(mail);
  const body = multipart('alternative', [textEntity('plain', mail.text), textEntity('html', mail.html)]);
  const files = mail.attachments ?? [];
  const root = files.length === 0 ? body : multipart('mixed', [body, ...files.map(attachmentEntity)]);
  return serialize({ headers: [...headers, ...root.headers], body: root.body });
}

/** A plain-text message, as the RFC 822 text `users.messages.send` takes (before base64url). */
export function buildOutboundMime(input: OutboundMime): string {
  const body = Buffer.from(input.text.replace(/\r\n?/gu, '\n').replace(/\n/gu, '\r\n'), 'utf8')
    .toString('base64')
    .replace(/.{1,76}/gu, (line) => `${line}\r\n`);
  return serialize({
    headers: [
      ...addressingHeaders(input),
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
    ],
    body,
  });
}

/** The `raw` field `users.messages.send` takes. */
export function encodeRaw(mime: string): string {
  return Buffer.from(mime, 'utf8').toString('base64url');
}

/** A Message-ID allocated before the send, so a retry can find the message it may already have sent. */
export function newMessageId(domain: string): string {
  return `<gws-ea.${randomUUID()}@${domain}>`;
}
