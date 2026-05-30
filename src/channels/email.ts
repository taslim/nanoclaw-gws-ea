/**
 * Gmail channel adapter (v2). Self-registers on import.
 *
 * One Gmail inbox routed across two messaging groups
 * (`email:principal:<addr>` / `email:external:<addr>`) by per-message
 * participant classification — one wiring per mg avoids v2's router
 * fan-out. External replies are deferred by `EMAIL_EXTERNAL_DELAY` so
 * they don't feel AI-fast. The mgs, agent groups, wirings, and principal
 * members are seeded by `scripts/init-email.ts`; setup() looks them up
 * and refuses to start if either is missing.
 *
 * deliver() handles two paths:
 *  - Reply (threadId present): build an in-thread Gmail reply. To/Cc
 *    derive from the latest thread state unless the agent explicitly
 *    overrides them in the outbound content. In-Reply-To/References
 *    come from the chain.
 *  - Compose (threadId absent): build a fresh outbound email from the
 *    agent's `to` / `cc` / `bcc` / `subject` fields. No thread context.
 *
 * Both paths support plain text, HTML (multipart/alternative when both
 * are provided), and attachments (multipart/mixed via `OutboundMessage.files`).
 */
import fs from 'fs';

import { google, type gmail_v1 } from 'googleapis';
import { Marked } from 'marked';

import { ASSISTANT_FULL_NAME } from '../config.js';
import { getMessagingGroupByPlatform } from '../db/messaging-groups.js';
import { parseCsvSet, readEnvFile } from '../env.js';
import { getSaKeyPath } from '../gws-paths.js';
import { log } from '../log.js';
import {
  classifyEmailRoute,
  extractAllParticipants,
  extractEmailAddress,
  isRelevantEmail,
  type EmailRoute,
  type ParsedEmail,
} from '../modules/email/classify.js';
import {
  clearDeferredOnThread,
  deleteDeferred,
  getDueDeferred,
  getLastHistoryId,
  setLastHistoryId,
  upsertDeferredOnThread,
} from '../modules/email/db.js';
import { formatEmailForAgent, type ThreadMessage } from '../modules/email/format.js';
import type { ChannelAdapter, ChannelSetup, OutboundFile, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/gmail.send'];

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_EXTERNAL_DELAY_MS = 360_000;
const DRAIN_INTERVAL_MS = 30_000;
const BODY_TRUNCATE = 10_000;
const THREAD_BODY_TRUNCATE = 2_000;

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

interface InboundAttachment {
  name?: string;
  mimeType: string;
  data: string;
}

interface IncomingEmail extends ParsedEmail {
  id: string;
  threadId: string;
  messageId: string;
  date: string;
}

// Anthropic native-ingest caps; oversized parts get dropped here rather than
// shipped only to be skipped at the model boundary.
const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;
const MAX_ATTACHMENT_TOTAL_BYTES = 40 * 1024 * 1024;

registerChannelAdapter('email', { factory: createEmailAdapter });

function createEmailAdapter(): ChannelAdapter | null {
  const env = readEnvFile([
    'ASSISTANT_EMAIL',
    'PRINCIPAL_EMAILS',
    'PRINCIPAL_NAME',
    'EMAIL_POLL_INTERVAL',
    'EMAIL_EXTERNAL_DELAY',
    'SA_KEY_PATH',
  ]);
  if (!env.ASSISTANT_EMAIL || !env.PRINCIPAL_EMAILS || !env.PRINCIPAL_NAME) {
    log.warn('Email: ASSISTANT_EMAIL / PRINCIPAL_EMAILS / PRINCIPAL_NAME missing, channel disabled');
    return null;
  }

  const saKeyPath = env.SA_KEY_PATH || getSaKeyPath();
  let raw: string;
  try {
    raw = fs.readFileSync(saKeyPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      log.warn('Email: service-account key not found, channel disabled', { path: saKeyPath });
      return null;
    }
    throw err;
  }
  const sa = JSON.parse(raw) as ServiceAccountKey;

  const assistantEmail = env.ASSISTANT_EMAIL;
  const assistantFromHeader = formatFromHeader(ASSISTANT_FULL_NAME, assistantEmail);
  const principalEmails = parseCsvSet(env.PRINCIPAL_EMAILS);
  const principalName = env.PRINCIPAL_NAME;
  const pollIntervalMs = env.EMAIL_POLL_INTERVAL ? parseInt(env.EMAIL_POLL_INTERVAL, 10) : DEFAULT_POLL_INTERVAL_MS;
  const externalDelayMs = env.EMAIL_EXTERNAL_DELAY ? parseInt(env.EMAIL_EXTERNAL_DELAY, 10) : DEFAULT_EXTERNAL_DELAY_MS;

  const auth = new google.auth.JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: GMAIL_SCOPES,
    subject: assistantEmail,
  });
  const gmail = google.gmail({ version: 'v1', auth });

  const principalPlatformId = `email:principal:${assistantEmail.toLowerCase()}`;
  const externalPlatformId = `email:external:${assistantEmail.toLowerCase()}`;

  let setup: ChannelSetup | null = null;
  let routes: { principal: string; external: string } | null = null;
  let pollTimer: NodeJS.Timeout | null = null;
  let drainTimer: NodeJS.Timeout | null = null;
  let polling = false;
  let connected = false;

  async function poll(): Promise<void> {
    if (polling || !routes) return;
    polling = true;
    try {
      const stored = getLastHistoryId();
      if (!stored) {
        const profile = await gmail.users.getProfile({ userId: 'me' });
        if (profile.data.historyId) {
          setLastHistoryId(profile.data.historyId);
          log.info('Email: seeded historyId, no backfill', { historyId: profile.data.historyId });
        }
        connected = true;
        return;
      }

      let result: { refs: NewMessageRef[]; historyId: string | null };
      try {
        result = await listNewMessageIds(gmail, stored);
      } catch (err) {
        // Gmail expires startHistoryId after ~7 days. Re-seed and accept the
        // gap; emails since expiry stay unread in Gmail itself.
        const code = (err as { code?: number }).code;
        if (code === 404 || code === 410) {
          const profile = await gmail.users.getProfile({ userId: 'me' });
          if (profile.data.historyId) {
            setLastHistoryId(profile.data.historyId);
            log.warn('Email: history pointer expired, re-seeded', { historyId: profile.data.historyId });
          }
          connected = true;
          return;
        }
        throw err;
      }

      for (const ref of result.refs) {
        const fetched = await fetchEmailAndThread(gmail, ref);
        if (!fetched) continue;
        const { email, threadHistory, payload } = fetched;
        if (extractEmailAddress(email.from).toLowerCase() === assistantEmail.toLowerCase()) continue;
        if (!isRelevantEmail(email, principalEmails, principalName)) {
          log.debug('Email: filtered as non-relevant', { from: email.from, subject: email.subject });
          continue;
        }

        const participants = extractAllParticipants(email);
        const route = classifyEmailRoute(email, principalEmails, assistantEmail);

        if (route === 'external' && externalDelayMs > 0) {
          // First message on a thread anchors the clock; subsequent messages
          // advance the pointer but keep the original due_at — bounded
          // latency, drain refetches fresh thread state at fire time.
          const fallbackDueAt = new Date(Date.now() + externalDelayMs).toISOString();
          const { due_at, superseded } = upsertDeferredOnThread({
            message_id: email.id,
            thread_id: email.threadId,
            fallback_due_at: fallbackDueAt,
          });
          log.info('Email: deferring external for human-pace delay', {
            messageId: email.id,
            dueAt: due_at,
            from: email.from,
            superseded,
          });
          continue;
        }

        // Principal dispatch on a thread cancels any pending external defer:
        // the human responded directly, so the agent's queued reply would be
        // stale by the time the timer fires.
        const cancelled = clearDeferredOnThread(email.threadId);
        if (cancelled > 0) {
          log.info('Email: principal activity cancelled pending external defer', {
            threadId: email.threadId,
            cancelled,
          });
        }
        await dispatch(email, route, participants, threadHistory, payload);
      }

      if (result.historyId) setLastHistoryId(result.historyId);
      connected = true;
    } catch (err) {
      log.error('Email: poll failed', { err });
    } finally {
      polling = false;
    }
  }

  async function dispatch(
    email: IncomingEmail,
    route: EmailRoute,
    participants: string[],
    threadHistory: ThreadMessage[],
    payload?: gmail_v1.Schema$MessagePart,
  ): Promise<void> {
    if (!setup || !routes) return;
    const targetPlatformId = routes[route];
    const fromAddr = extractEmailAddress(email.from).toLowerCase();
    const senderId = `email:${fromAddr}`;

    const text = formatEmailForAgent({
      from: email.from,
      to: email.to,
      cc: email.cc,
      subject: email.subject,
      date: email.date,
      body: email.body,
      threadId: email.threadId,
      threadHistory,
    });

    const attachments = await fetchAttachments(gmail, email.id, payload);

    const content: Record<string, unknown> = {
      text,
      sender: email.from,
      senderId,
      participants,
      route,
      timestamp: email.date,
    };
    if (attachments.length > 0) {
      content.attachments = attachments;
    }

    await setup.onInbound(targetPlatformId, email.threadId, {
      id: email.id,
      kind: 'chat',
      content,
      timestamp: new Date().toISOString(),
      isMention: false,
      isGroup: false,
    });
  }

  async function drainDeferred(): Promise<void> {
    if (!routes) return;
    const due = getDueDeferred(new Date().toISOString());
    for (const row of due) {
      // Claim the row up front. If a new message lands on this thread while
      // we're dispatching, the upsert below sees no existing row and starts
      // a fresh clock — avoids a second fire on the row we're handling.
      deleteDeferred(row.message_id);
      try {
        const fetched = await fetchEmailAndThread(gmail, { messageId: row.message_id, threadId: row.thread_id });
        if (!fetched) {
          log.info('Email: deferred message no longer fetchable, dropping', { messageId: row.message_id });
          continue;
        }
        const { email, threadHistory, payload } = fetched;
        const participants = extractAllParticipants(email);
        await dispatch(email, 'external', participants, threadHistory, payload);
      } catch (err) {
        log.error('Email: deferred dispatch failed', { messageId: row.message_id, err });
      }
    }
  }

  return {
    name: 'email',
    channelType: 'email',
    supportsThreads: true,

    async setup(config) {
      const principalMg = getMessagingGroupByPlatform('email', principalPlatformId);
      const externalMg = getMessagingGroupByPlatform('email', externalPlatformId);
      if (!principalMg || !externalMg) {
        log.error('Email: messaging groups not seeded — run scripts/init-email.ts first', {
          principalSeeded: !!principalMg,
          externalSeeded: !!externalMg,
        });
        return;
      }
      setup = config;
      routes = { principal: principalPlatformId, external: externalPlatformId };
      pollTimer = setInterval(() => void poll(), pollIntervalMs);
      drainTimer = setInterval(() => void drainDeferred(), DRAIN_INTERVAL_MS);
      void poll();
      void drainDeferred();
      log.info('Email: adapter active', {
        assistantEmail,
        pollIntervalMs,
        externalDelayMs,
      });
    },

    async teardown() {
      if (pollTimer) clearInterval(pollTimer);
      if (drainTimer) clearInterval(drainTimer);
      pollTimer = null;
      drainTimer = null;
      connected = false;
    },

    isConnected() {
      return connected;
    },

    async deliver(_pid, threadId, message) {
      const content = parseEmailContent(message);
      if (!content) return undefined;
      if (!hasBody(content)) return undefined;

      if (threadId) {
        const sent = await sendReply(gmail, assistantEmail, assistantFromHeader, threadId, content, message.files);
        return sent ?? undefined;
      }

      if (!content.to || content.to.length === 0) {
        log.warn('Email: compose requires `to`, dropping outbound');
        return undefined;
      }
      if (!content.subject) {
        log.warn('Email: compose requires `subject`, dropping outbound');
        return undefined;
      }
      const sent = await sendCompose(gmail, assistantFromHeader, content, message.files);
      return sent ?? undefined;
    },
  };
}

interface EmailOutboundContent {
  text?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
}

function parseEmailContent(message: OutboundMessage): EmailOutboundContent | null {
  if (!message.content || typeof message.content !== 'object') return null;

  const obj = message.content as Record<string, unknown>;
  const text = typeof obj.text === 'string' ? obj.text : typeof obj.markdown === 'string' ? obj.markdown : undefined;
  const subject = typeof obj.subject === 'string' ? sanitizeHeaderValue(obj.subject) : undefined;
  return {
    text,
    to: normalizeAddressList(obj.to),
    cc: normalizeAddressList(obj.cc),
    bcc: normalizeAddressList(obj.bcc),
    subject,
  };
}

function hasBody(c: EmailOutboundContent): boolean {
  return !!(c.text && c.text.trim());
}

function parseAddressList(raw: string | string[]): string[] {
  const parts = Array.isArray(raw) ? raw.flatMap((v) => (typeof v === 'string' ? v.split(',') : [])) : raw.split(',');
  const out: string[] = [];
  for (const part of parts) {
    const addr = extractEmailAddress(part.trim());
    if (addr && !out.includes(addr)) out.push(addr);
  }
  return out;
}

function normalizeAddressList(input: unknown): string[] | undefined {
  if (typeof input !== 'string' && !Array.isArray(input)) return undefined;
  const out = parseAddressList(input);
  return out.length > 0 ? out : undefined;
}

/**
 * Strip CR/LF (and any control chars) from header values. Header injection
 * via newline-bearing subjects/addresses is an obvious footgun once the
 * agent is allowed to specify these fields; sanitize at the boundary.
 */
function sanitizeHeaderValue(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim();
}

interface NewMessageRef {
  messageId: string;
  threadId: string;
}

async function listNewMessageIds(
  gmail: gmail_v1.Gmail,
  startHistoryId: string,
): Promise<{ refs: NewMessageRef[]; historyId: string | null }> {
  const seen = new Set<string>();
  const refs: NewMessageRef[] = [];
  let pageToken: string | undefined;
  let historyId: string | null = null;
  do {
    const res = await gmail.users.history.list({
      userId: 'me',
      startHistoryId,
      historyTypes: ['messageAdded'],
      pageToken,
    });
    if (res.data.historyId) historyId = res.data.historyId;
    for (const h of res.data.history ?? []) {
      for (const m of h.messagesAdded ?? []) {
        const id = m.message?.id;
        const tid = m.message?.threadId;
        const labels = m.message?.labelIds ?? [];
        if (!id || !tid || seen.has(id)) continue;
        if (!labels.includes('INBOX') || labels.includes('SENT')) continue;
        seen.add(id);
        refs.push({ messageId: id, threadId: tid });
      }
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return { refs, historyId };
}

async function fetchEmailAndThread(
  gmail: gmail_v1.Gmail,
  ref: NewMessageRef,
): Promise<{
  email: IncomingEmail;
  threadHistory: ThreadMessage[];
  payload: gmail_v1.Schema$MessagePart | undefined;
} | null> {
  try {
    const thread = await gmail.users.threads.get({ userId: 'me', id: ref.threadId, format: 'full' });
    const messages = thread.data.messages ?? [];
    const target = messages.find((m) => m.id === ref.messageId);
    if (!target?.id) return null;

    const email = parseGmailMessage(target.id, ref.threadId, target.payload);
    const threadHistory: ThreadMessage[] = [];
    for (const msg of messages) {
      if (msg.id === ref.messageId) continue;
      const headers = (msg.payload?.headers ?? []) as Array<{ name: string; value: string }>;
      threadHistory.push({
        from: extractEmailAddress(getHeader(headers, 'From')),
        to: getHeader(headers, 'To'),
        cc: getHeader(headers, 'Cc') || getHeader(headers, 'CC'),
        date: getHeader(headers, 'Date'),
        body: getTextBody(msg.payload).slice(0, THREAD_BODY_TRUNCATE),
      });
    }
    return { email, threadHistory, payload: target.payload ?? undefined };
  } catch (err) {
    if ((err as { code?: number }).code === 404) return null;
    throw err;
  }
}

async function sendReply(
  gmail: gmail_v1.Gmail,
  fromAddress: string,
  fromHeader: string,
  threadId: string,
  content: EmailOutboundContent,
  files: OutboundFile[] | undefined,
): Promise<string | null> {
  const thread = await gmail.users.threads.get({ userId: 'me', id: threadId, format: 'metadata' });
  const messages = thread.data.messages ?? [];
  if (messages.length === 0) return null;
  const last = messages[messages.length - 1];
  const headers = (last.payload?.headers ?? []) as Array<{ name: string; value: string }>;

  const priorSubject = getHeader(headers, 'Subject');
  const lastFrom = extractEmailAddress(getHeader(headers, 'From'));
  const lastTo = getHeader(headers, 'To');
  const lastCc = getHeader(headers, 'Cc') || getHeader(headers, 'CC');
  const lastMessageId = getHeader(headers, 'Message-ID') || getHeader(headers, 'Message-Id');
  const references = getHeader(headers, 'References');

  // Subject: agent override wins; otherwise prefix Re: if not already there.
  const subject = content.subject
    ? content.subject
    : priorSubject.startsWith('Re:')
      ? priorSubject
      : `Re: ${priorSubject}`;

  // Recipients: agent override wins (full replacement, not merge); otherwise
  // derive from prior thread state.
  let to: string[];
  let cc: string[];
  if (content.to) {
    to = content.to;
    cc = content.cc ?? [];
  } else {
    const derived = collectRecipients(lastFrom, `${lastTo}, ${lastCc}`, fromAddress);
    to = derived.to;
    cc = content.cc ?? derived.cc;
  }
  if (to.length === 0) {
    log.warn('Email: no reply recipient found, dropping outbound', { threadId });
    return null;
  }

  const referenceChain = [references, lastMessageId].filter(Boolean).join(' ').trim();

  const raw = buildRawMime({
    from: fromHeader,
    to,
    cc,
    bcc: content.bcc ?? [],
    subject,
    inReplyTo: lastMessageId || undefined,
    references: referenceChain || undefined,
    text: content.text,
    html: content.text ? renderMarkdownToHtml(content.text) : undefined,
    files,
  });

  const sent = await gmail.users.messages.send({ userId: 'me', requestBody: { raw, threadId } });
  return sent.data.id ?? null;
}

async function sendCompose(
  gmail: gmail_v1.Gmail,
  fromHeader: string,
  content: EmailOutboundContent,
  files: OutboundFile[] | undefined,
): Promise<string | null> {
  const raw = buildRawMime({
    from: fromHeader,
    to: content.to ?? [],
    cc: content.cc ?? [],
    bcc: content.bcc ?? [],
    subject: content.subject!,
    text: content.text,
    html: content.text ? renderMarkdownToHtml(content.text) : undefined,
    files,
  });
  const sent = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
  return sent.data.id ?? null;
}

interface BuildMimeArgs {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  inReplyTo?: string;
  references?: string;
  text?: string;
  html?: string;
  files?: OutboundFile[];
}

/**
 * Marked instance configured for outbound email rendering. GFM on (tables,
 * autolinks, strikethrough); `breaks: true` so every newline becomes a `<br>`
 * — matches how people actually write email (signatures, address blocks,
 * stanza-style lists) rather than CommonMark's paragraph-collapse default.
 * Raw HTML passes through (agent is internal; email clients sandbox).
 */
const emailMarkdown = new Marked({ gfm: true, breaks: true, async: false });

/** Render the agent's markdown text body to an HTML email part. */
export function renderMarkdownToHtml(text: string): string {
  if (!text || !text.trim()) return '';
  return emailMarkdown.parse(text) as string;
}

function buildRawMime(args: BuildMimeArgs): string {
  const body = buildBody(args.text, args.html, args.files);

  const headers: string[] = [`From: ${args.from}`];
  if (args.to.length > 0) headers.push(`To: ${args.to.join(', ')}`);
  if (args.cc.length > 0) headers.push(`Cc: ${args.cc.join(', ')}`);
  if (args.bcc.length > 0) headers.push(`Bcc: ${args.bcc.join(', ')}`);
  headers.push(`Subject: ${encodeHeaderWord(args.subject)}`);
  headers.push('MIME-Version: 1.0');
  headers.push(`Content-Type: ${body.contentType}`);
  if (body.contentTransferEncoding) headers.push(`Content-Transfer-Encoding: ${body.contentTransferEncoding}`);
  if (args.inReplyTo) headers.push(`In-Reply-To: ${args.inReplyTo}`);
  if (args.references) headers.push(`References: ${args.references}`);

  const raw = `${headers.join('\r\n')}\r\n\r\n${body.payload}`;
  return Buffer.from(raw, 'utf-8').toString('base64url');
}

function buildBody(
  text: string | undefined,
  html: string | undefined,
  files: OutboundFile[] | undefined,
): { contentType: string; contentTransferEncoding?: string; payload: string } {
  const hasText = !!text && text.length > 0;
  const hasHtml = !!html && html.length > 0;
  const hasFiles = (files?.length ?? 0) > 0;

  let bodyContentType: string;
  let bodyCTE: string | undefined;
  let bodyPayload: string;

  if (hasText && hasHtml) {
    const altBoundary = randomBoundary('alt');
    bodyPayload = [
      `--${altBoundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      encodeUtf8Base64(text!),
      `--${altBoundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      encodeUtf8Base64(html!),
      `--${altBoundary}--`,
    ].join('\r\n');
    bodyContentType = `multipart/alternative; boundary="${altBoundary}"`;
  } else if (hasHtml) {
    bodyContentType = 'text/html; charset="UTF-8"';
    bodyCTE = 'base64';
    bodyPayload = encodeUtf8Base64(html!);
  } else {
    bodyContentType = 'text/plain; charset="UTF-8"';
    bodyCTE = 'base64';
    bodyPayload = encodeUtf8Base64(text ?? '');
  }

  if (!hasFiles) {
    return { contentType: bodyContentType, contentTransferEncoding: bodyCTE, payload: bodyPayload };
  }

  const mixedBoundary = randomBoundary('mix');
  const parts: string[] = [`--${mixedBoundary}`, `Content-Type: ${bodyContentType}`];
  if (bodyCTE) parts.push(`Content-Transfer-Encoding: ${bodyCTE}`);
  parts.push('', bodyPayload);
  for (const file of files!) {
    const filename = sanitizeHeaderValue(file.filename);
    const quotedFilename = escapeQuoted(filename);
    const mimeType = guessMimeType(filename);
    parts.push(
      `--${mixedBoundary}`,
      `Content-Type: ${mimeType}; name="${quotedFilename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${quotedFilename}"`,
      '',
      wrapBase64(file.data.toString('base64')),
    );
  }
  parts.push(`--${mixedBoundary}--`);
  return { contentType: `multipart/mixed; boundary="${mixedBoundary}"`, payload: parts.join('\r\n') };
}

function encodeUtf8Base64(s: string): string {
  return wrapBase64(Buffer.from(s, 'utf-8').toString('base64'));
}

/**
 * Build an RFC 5322 `From:` value as `Display Name <addr>`. Non-ASCII names
 * become an RFC 2047 encoded-word; ASCII names with specials get quoted.
 * Falls back to the bare address when no usable display name is provided.
 */
function formatFromHeader(displayName: string | undefined, address: string): string {
  const name = displayName?.trim();
  if (!name) return address;
  const sanitized = sanitizeHeaderValue(name);
  if (!sanitized) return address;
  if (/^[\x20-\x7e]*$/.test(sanitized)) {
    const needsQuoting = /[()<>@,;:\\".\[\]]/.test(sanitized);
    const phrase = needsQuoting ? `"${sanitized.replace(/(["\\])/g, '\\$1')}"` : sanitized;
    return `${phrase} <${address}>`;
  }
  return `${encodeHeaderWord(sanitized)} <${address}>`;
}

/**
 * RFC 2047 encoded-word for header values containing non-ASCII bytes.
 * Splits on UTF-8 character boundaries so each encoded-word stays under
 * the 75-char limit.
 */
function encodeHeaderWord(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;

  const MAX_INPUT_BYTES = 45;
  const words: string[] = [];
  let buf = Buffer.alloc(0);
  for (const char of value) {
    const charBytes = Buffer.from(char, 'utf-8');
    if (buf.length > 0 && buf.length + charBytes.length > MAX_INPUT_BYTES) {
      words.push(`=?UTF-8?B?${buf.toString('base64')}?=`);
      buf = charBytes;
    } else {
      buf = Buffer.concat([buf, charBytes]);
    }
  }
  if (buf.length > 0) words.push(`=?UTF-8?B?${buf.toString('base64')}?=`);
  return words.join(' ');
}

function randomBoundary(tag: string): string {
  return `=_${tag}_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

function escapeQuoted(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}

function wrapBase64(b64: string, lineLength = 76): string {
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += lineLength) {
    lines.push(b64.slice(i, i + lineLength));
  }
  return lines.join('\r\n');
}

const MIME_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.md': 'text/markdown',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.doc': 'application/msword',
  '.xls': 'application/vnd.ms-excel',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.ics': 'text/calendar',
};

function guessMimeType(filename: string): string {
  const ext = filename.toLowerCase().match(/\.[a-z0-9]+$/)?.[0];
  return (ext && MIME_TYPES[ext]) || 'application/octet-stream';
}

function collectRecipients(lastFrom: string, toAndCc: string, selfAddress: string): { to: string[]; cc: string[] } {
  const self = selfAddress.toLowerCase();
  // Skip lastFrom when it's us (self-reply chain) — primary recipient is
  // whoever else was on the previous To/Cc.
  const to: string[] = [];
  if (lastFrom && lastFrom.toLowerCase() !== self) to.push(lastFrom);

  const cc: string[] = [];
  for (const addr of parseAddressList(toAndCc)) {
    if (addr.toLowerCase() === self || to.includes(addr)) continue;
    if (to.length === 0) {
      to.push(addr);
      continue;
    }
    cc.push(addr);
  }
  return { to, cc };
}

function parseGmailMessage(
  id: string,
  threadId: string,
  payload: gmail_v1.Schema$MessagePart | undefined,
): IncomingEmail {
  const headers = (payload?.headers ?? []) as Array<{ name: string; value: string }>;
  return {
    id,
    threadId,
    messageId: getHeader(headers, 'Message-ID') || getHeader(headers, 'Message-Id'),
    from: getHeader(headers, 'From'),
    to: getHeader(headers, 'To'),
    cc: getHeader(headers, 'Cc') || getHeader(headers, 'CC'),
    subject: getHeader(headers, 'Subject'),
    body: getTextBody(payload).slice(0, BODY_TRUNCATE),
    date: getHeader(headers, 'Date'),
  };
}

// Cap concurrent Gmail attachment fetches; per-user QPS quotas exist and a
// 50-attachment email shouldn't fire 50 simultaneous calls.
const ATTACHMENT_FETCH_CONCURRENCY = 6;

type PartDescriptor =
  | { kind: 'inline'; filename: string; mime: string; sizeHint: number; data: string }
  | { kind: 'remote'; filename: string; mime: string; sizeHint: number; attachmentId: string };

/** Caller passes `payload` if it has one already; otherwise we refetch by id. */
async function fetchAttachments(
  gmail: gmail_v1.Gmail,
  messageId: string,
  payload?: gmail_v1.Schema$MessagePart,
): Promise<InboundAttachment[]> {
  if (!payload) {
    try {
      const res = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
      payload = res.data.payload ?? undefined;
    } catch (err) {
      log.warn('Email: failed to refetch message for attachments', { messageId, err });
      return [];
    }
  }
  if (!payload) return [];

  const descriptors: PartDescriptor[] = [];
  let preFetchTotal = 0;

  function walk(part: gmail_v1.Schema$MessagePart): void {
    const mime = part.mimeType ?? '';
    if (mime.startsWith('multipart/')) {
      for (const child of part.parts ?? []) walk(child);
      return;
    }
    const filename = part.filename ?? '';
    // text/plain and text/html without a filename are the body — getTextBody handles those.
    if (!filename && (mime === 'text/plain' || mime === 'text/html')) return;

    const sizeHint = part.body?.size ?? 0;
    if (sizeHint > MAX_ATTACHMENT_BYTES) {
      log.warn('Email: skipping oversized attachment', { messageId, filename, mime, size: sizeHint });
      return;
    }
    if (preFetchTotal + sizeHint > MAX_ATTACHMENT_TOTAL_BYTES) {
      log.warn('Email: per-message attachment budget exhausted, dropping rest', { messageId });
      return;
    }
    preFetchTotal += sizeHint;

    if (part.body?.data) {
      descriptors.push({ kind: 'inline', filename, mime, sizeHint, data: part.body.data });
    } else if (part.body?.attachmentId) {
      descriptors.push({ kind: 'remote', filename, mime, sizeHint, attachmentId: part.body.attachmentId });
    }
  }

  walk(payload);
  if (descriptors.length === 0) return [];

  async function fetchOne(d: PartDescriptor): Promise<string | null> {
    if (d.kind === 'inline') return d.data;
    try {
      const res = await gmail.users.messages.attachments.get({
        userId: 'me',
        messageId,
        id: d.attachmentId,
      });
      return res.data.data ?? null;
    } catch (err) {
      log.warn('Email: attachment fetch failed', { messageId, filename: d.filename, err });
      return null;
    }
  }

  const fetched: (string | null)[] = [];
  for (let i = 0; i < descriptors.length; i += ATTACHMENT_FETCH_CONCURRENCY) {
    const slice = descriptors.slice(i, i + ATTACHMENT_FETCH_CONCURRENCY);
    fetched.push(...(await Promise.all(slice.map(fetchOne))));
  }

  // Re-check against decoded sizes; Gmail's `body.size` is a hint, not a guarantee.
  const out: InboundAttachment[] = [];
  let total = 0;
  for (let i = 0; i < descriptors.length; i++) {
    const data = fetched[i];
    if (!data) continue;
    const d = descriptors[i];

    // Gmail returns base64url; downstream consumers want standard base64.
    const buf = Buffer.from(data, 'base64url');
    if (buf.length > MAX_ATTACHMENT_BYTES) {
      log.warn('Email: skipping oversized attachment after decode', {
        messageId,
        filename: d.filename,
        mime: d.mime,
        size: buf.length,
      });
      continue;
    }
    if (total + buf.length > MAX_ATTACHMENT_TOTAL_BYTES) {
      log.warn('Email: per-message attachment budget exhausted, dropping rest', { messageId });
      break;
    }
    total += buf.length;

    const att: InboundAttachment = {
      mimeType: d.mime || 'application/octet-stream',
      data: buf.toString('base64'),
    };
    if (d.filename) att.name = d.filename;
    out.push(att);
  }
  return out;
}

function getHeader(headers: Array<{ name: string; value: string }>, name: string): string {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}

function decodeBody(body: string): string {
  return Buffer.from(body, 'base64url').toString('utf-8');
}

function getTextBody(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (!payload) return '';
  if (payload.body?.data && payload.mimeType === 'text/plain') return decodeBody(payload.body.data);

  const parts = payload.parts ?? [];
  for (const part of parts) {
    if (part.mimeType === 'text/plain' && part.body?.data) return decodeBody(part.body.data);
  }
  for (const part of parts) {
    if (part.mimeType === 'text/html' && part.body?.data) {
      return decodeBody(part.body.data)
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }
  }
  for (const part of parts) {
    if (part.mimeType?.startsWith('multipart/') && part.parts) {
      const result = getTextBody(part);
      if (result) return result;
    }
  }
  return payload.body?.data ? decodeBody(payload.body.data) : '';
}
