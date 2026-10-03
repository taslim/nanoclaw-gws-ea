/**
 * Mail as text (KTD4): reading the messages Gmail returns, and writing
 * plain-text replies in their thread.
 *
 * Inbound, only headers and readable text are taken; attachments are counted,
 * never fetched. Outbound, a reply is one `text/plain` part with no quote and
 * no signature, addressed with To only: there is never a Cc or a Bcc, and no
 * value can add a header, because every header value is reduced to one line.
 */
import { randomUUID } from 'node:crypto';

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

export interface OutboundMime {
  readonly from: Mailbox;
  /** The send list, exactly; it is also what the audience check saw. */
  readonly to: readonly string[];
  readonly subject: string;
  readonly messageId: string;
  readonly inReplyTo?: string;
  readonly references: readonly string[];
  readonly text: string;
  readonly date: Date;
}

function isControl(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return code <= 0x1f || code === 0x7f;
}

/** One line, with no control character that could end a header early. */
function oneLine(value: string): string {
  return Array.from(value, (character) => (isControl(character) ? ' ' : character))
    .join('')
    .replace(/\s+/gu, ' ')
    .trim();
}

function isPlainAscii(value: string): boolean {
  return /^[\x20-\x7e]*$/u.test(value);
}

function encodeWord(value: string): string {
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function headerText(value: string): string {
  const line = oneLine(value);
  return isPlainAscii(line) ? line : encodeWord(line);
}

function mailboxText(mailbox: Mailbox): string {
  const name = mailbox.displayName === undefined ? '' : oneLine(mailbox.displayName);
  if (name === '') return mailbox.address;
  if (!isPlainAscii(name)) return `${encodeWord(name)} <${mailbox.address}>`;
  return /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~ ]+$/u.test(name)
    ? `${name} <${mailbox.address}>`
    : `"${name.replace(/(["\\])/gu, '\\$1')}" <${mailbox.address}>`;
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

/** Long lists of message IDs folded onto continuation lines. */
function foldIds(ids: readonly string[]): string {
  const lines: string[] = [];
  let current = '';
  for (const id of ids) {
    if (current !== '' && current.length + id.length + 1 > 900) {
      lines.push(current);
      current = id;
    } else current = current === '' ? id : `${current} ${id}`;
  }
  if (current !== '') lines.push(current);
  return lines.join('\r\n ');
}

/** A plain-text message, as the RFC 822 text `users.messages.send` takes (before base64url). */
export function buildOutboundMime(input: OutboundMime): string {
  if (input.to.length === 0) throw new Error('A message needs at least one recipient');
  const to = input.to.map((address) => {
    const normalized = normalizeAddress(address);
    if (normalized === undefined) throw new Error(`Not an email address: ${JSON.stringify(address)}`);
    return normalized;
  });
  const references = input.references.map(messageIdToken);
  const headers = [
    `From: ${mailboxText(input.from)}`,
    `To: ${to.join(', ')}`,
    `Subject: ${headerText(input.subject)}`,
    `Date: ${mailDate(input.date)}`,
    `Message-ID: ${messageIdToken(input.messageId)}`,
    ...(input.inReplyTo === undefined ? [] : [`In-Reply-To: ${messageIdToken(input.inReplyTo)}`]),
    ...(references.length === 0 ? [] : [`References: ${foldIds(references)}`]),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ];
  const body = Buffer.from(input.text.replace(/\r\n?/gu, '\n').replace(/\n/gu, '\r\n'), 'utf8')
    .toString('base64')
    .replace(/.{1,76}/gu, (line) => `${line}\r\n`);
  return `${headers.join('\r\n')}\r\n\r\n${body}`;
}

/** The `raw` field `users.messages.send` takes. */
export function encodeRaw(mime: string): string {
  return Buffer.from(mime, 'utf8').toString('base64url');
}

export function decodeRaw(raw: string): string {
  return Buffer.from(raw, 'base64url').toString('utf8');
}

/** A Message-ID allocated before the send, so a retry can find the message it may already have sent. */
export function newMessageId(domain: string): string {
  return `<gws-ea.${randomUUID()}@${domain}>`;
}
