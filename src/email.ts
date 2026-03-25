/**
 * Email event source for NanoClaw GWS-EA
 *
 * Email is an event source, not a channel. The agent decides whether/how
 * to reply via MCP tools; its text output is a status update forwarded
 * to the main channel, not the email reply.
 *
 * Polls Gmail for new emails and invokes a callback per email.
 * Queueing: Gmail is:unread → insert as 'queued' → markAsRead. Intake complete.
 * Processing: agent run → updateEmailStatus. DB is source of truth.
 * Retry: DB-driven — poll for 'failed' → re-fetch → re-process with backoff.
 *
 * Principal-only threads (only principal + assistant) -> email:principal
 * Threads with any other participant -> email:external (restricted tools)
 * One-way ratchet: threads downgrade to external, never back.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { google } from 'googleapis';

import {
  ASSISTANT_EMAIL,
  ASSISTANT_NAME,
  EMAIL_POLL_INTERVAL,
  PRINCIPAL_EMAILS,
  PRINCIPAL_NAME,
  isPrincipalEmail,
} from './config.js';
import {
  getFailedEmailIds,
  insertEmailMessage,
  isEmailSeen,
  updateEmailStatus,
} from './db.js';
import { logger } from './logger.js';

// --- Synthetic group configs (exported for index.ts) ---

export const EMAIL_PRINCIPAL_GROUP = {
  jid: 'email:principal',
  name: 'Email (Principal)',
  folder: 'email-principal',
  trigger: `@${ASSISTANT_NAME}`,
  requiresTrigger: false,
  allowedTools: [
    // Standard tools
    'Bash',
    'Read',
    'Write',
    'Edit',
    'Glob',
    'Grep',
    'WebSearch',
    'WebFetch',
    'Task',
    'TaskOutput',
    'TaskStop',
    'TeamCreate',
    'TeamDelete',
    'SendMessage',
    'TodoWrite',
    'ToolSearch',
    'Skill',
    'NotebookEdit',
    // Gmail (via Workspace MCP)
    'mcp__workspace__send_gmail_message',
    'mcp__workspace__draft_gmail_message',
    'mcp__workspace__search_gmail_messages',
    'mcp__workspace__get_gmail_message_content',
    'mcp__workspace__get_gmail_messages_content_batch',
    'mcp__workspace__get_gmail_thread_content',
    'mcp__workspace__get_gmail_attachment_content',
    'mcp__workspace__modify_gmail_message_labels',
    'mcp__workspace__list_gmail_labels',
    // NanoClaw IPC — messaging, task management, matter context (read-only)
    'mcp__nanoclaw__send_message',
    'mcp__nanoclaw__schedule_task',
    'mcp__nanoclaw__list_tasks',
    'mcp__nanoclaw__list_matters',
    'mcp__nanoclaw__get_matter',
    'mcp__nanoclaw__find_matter',
    // Calendar: availability, event listing, RSVP (gcal MCP) + CRUD (workspace MCP)
    'mcp__gcal__*',
    'mcp__workspace__manage_event',
    'mcp__workspace__list_calendars',
    // Time MCP — date math, timezone conversions
    'mcp__time__*',
    // Google Workspace — contacts (read + write), docs, sheets, drive (no Chat admin)
    'mcp__workspace__contacts_search',
    'mcp__workspace__contacts_get',
    'mcp__workspace__manage_contact',
    'mcp__workspace__drive_search_files',
    'mcp__workspace__drive_read_file',
    'mcp__workspace__drive_create_file',
    'mcp__workspace__drive_update_file',
    'mcp__workspace__drive_share_file',
    'mcp__workspace__docs_create_document',
    'mcp__workspace__docs_read_document',
    'mcp__workspace__docs_update_document',
    'mcp__workspace__sheets_create_spreadsheet',
    'mcp__workspace__sheets_read_spreadsheet',
    'mcp__workspace__sheets_update_spreadsheet',
  ],
};

export const EMAIL_EXTERNAL_GROUP = {
  jid: 'email:external',
  name: 'Email (External)',
  folder: 'email-external',
  trigger: `@${ASSISTANT_NAME}`,
  requiresTrigger: false,
  allowedTools: [
    // Standard tools
    'Bash',
    'Read',
    'Write',
    'Edit',
    'Glob',
    'Grep',
    'WebSearch',
    'WebFetch',
    'Task',
    'TaskOutput',
    'TaskStop',
    'TeamCreate',
    'TeamDelete',
    'SendMessage',
    'TodoWrite',
    'ToolSearch',
    'Skill',
    'NotebookEdit',
    // Gmail (via Workspace MCP)
    'mcp__workspace__send_gmail_message',
    'mcp__workspace__draft_gmail_message',
    'mcp__workspace__search_gmail_messages',
    'mcp__workspace__get_gmail_message_content',
    'mcp__workspace__get_gmail_messages_content_batch',
    'mcp__workspace__get_gmail_thread_content',
    'mcp__workspace__get_gmail_attachment_content',
    'mcp__workspace__modify_gmail_message_labels',
    'mcp__workspace__list_gmail_labels',
    // Contacts (for tier-based gatekeeping)
    'mcp__workspace__contacts_search',
    'mcp__workspace__contacts_get',
    // NanoClaw IPC — no send_message (escalation handled by output forwarding), matter context (read-only)
    'mcp__nanoclaw__schedule_task',
    'mcp__nanoclaw__list_tasks',
    'mcp__nanoclaw__list_matters',
    'mcp__nanoclaw__get_matter',
    'mcp__nanoclaw__find_matter',
    // Calendar: availability + RSVP (gcal MCP), CRUD + discovery (workspace MCP)
    // Intentionally no list_events/get_events (prevents reading event details)
    'mcp__gcal__get_availability',
    'mcp__gcal__respond_to_event',
    'mcp__workspace__manage_event',
    'mcp__workspace__list_calendars',
    // Time MCP — date math, timezone conversions
    'mcp__time__*',
  ],
};

// --- Email types ---

export interface IncomingEmail {
  id: string;
  threadId: string;
  messageId: string; // RFC 2822 Message-ID header
  from: string;
  to: string;
  cc: string;
  subject: string;
  body: string;
  date: string;
}

export interface ThreadMessage {
  from: string;
  to: string;
  cc: string;
  date: string;
  messageId: string;
  body: string;
}

export interface EmailContext {
  email: IncomingEmail;
  fetchThread: () => Promise<ThreadMessage[]>;
}

// --- Public API ---

/**
 * Start polling Gmail for new emails.
 * Queueing: intake from Gmail (is:unread → insert 'queued' → markAsRead).
 * Processing: onEmail callback runs agent → updates status via updateEmailStatus.
 * Retry: polls DB for 'failed' emails → re-fetches → re-processes with backoff.
 */
export function startEmailLoop(
  onEmail: (ctx: EmailContext) => Promise<void>,
): void {
  const homeDir = os.homedir();
  const keysPath = path.join(homeDir, '.workspace-mcp', 'gcp-oauth.keys.json');
  const credsPath = path.join(homeDir, '.workspace-mcp', 'credentials.json');

  if (!fs.existsSync(keysPath) || !fs.existsSync(credsPath)) {
    logger.info('Email: Gmail credentials not found, skipping');
    return;
  }

  const keys = JSON.parse(fs.readFileSync(keysPath, 'utf-8'));
  const creds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));

  const clientConfig = keys.installed || keys.web;
  const oauth2Client = new google.auth.OAuth2(
    clientConfig.client_id,
    clientConfig.client_secret,
    clientConfig.redirect_uris?.[0],
  );

  oauth2Client.setCredentials({
    access_token: creds.access_token,
    refresh_token: creds.refresh_token,
    expiry_date: creds.expiry_date,
  });

  // Persist refreshed tokens back to disk
  oauth2Client.on('tokens', (tokens) => {
    const existing = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
    if (tokens.access_token) existing.access_token = tokens.access_token;
    if (tokens.refresh_token) existing.refresh_token = tokens.refresh_token;
    if (tokens.expiry_date) existing.expiry_date = tokens.expiry_date;
    fs.writeFileSync(credsPath, JSON.stringify(existing, null, 2));
    logger.debug('Gmail OAuth tokens refreshed and saved');
  });

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  /** Fetch all messages in a thread, excluding the current email. */
  async function fetchThreadMessages(
    threadId: string,
    excludeMessageId: string,
  ): Promise<ThreadMessage[]> {
    const thread = await gmail.users.threads.get({
      userId: 'me',
      id: threadId,
      format: 'full',
    });
    const messages: ThreadMessage[] = [];
    for (const msg of thread.data.messages || []) {
      if (msg.id === excludeMessageId) continue;
      const headers = (msg.payload?.headers || []) as Array<{
        name: string;
        value: string;
      }>;
      messages.push({
        from: extractEmailAddress(getHeader(headers, 'From')),
        to: getHeader(headers, 'To'),
        cc: getHeader(headers, 'Cc') || getHeader(headers, 'CC'),
        date: getHeader(headers, 'Date'),
        messageId:
          getHeader(headers, 'Message-ID') || getHeader(headers, 'Message-Id'),
        body: getTextBody(
          msg.payload as Parameters<typeof getTextBody>[0],
        ).slice(0, 2000),
      });
    }
    return messages;
  }

  logger.info(
    `Email channel active (polling every ${EMAIL_POLL_INTERVAL / 1000}s)`,
  );

  // In-memory retry tracking (mirrors group-queue.ts pattern)
  const MAX_RETRIES = 5;
  const BASE_RETRY_MS = 5000;
  const retryState = new Map<string, number>(); // messageId → retryCount
  const pendingRetries = new Set<string>(); // messageIds with scheduled setTimeout

  let polling = false;

  const poll = async () => {
    if (polling) return;
    polling = true;
    try {
      // Phase 1: Retry failed emails (DB-driven, in-memory backoff)
      const failedIds = getFailedEmailIds();
      for (const id of failedIds) {
        if (pendingRetries.has(id)) continue;

        const retryCount = (retryState.get(id) || 0) + 1;
        if (retryCount > MAX_RETRIES) {
          logger.error(
            { messageId: id, retryCount },
            'Max retries exceeded, giving up',
          );
          // Keep retryState entry so future polls skip this email (resets on restart)
          continue;
        }

        retryState.set(id, retryCount);
        pendingRetries.add(id);
        const delayMs = BASE_RETRY_MS * Math.pow(2, retryCount - 1);
        logger.info(
          { messageId: id, retryCount, delayMs },
          'Scheduling email retry',
        );

        setTimeout(() => {
          pendingRetries.delete(id);
          fetchEmailById(gmail, id)
            .then(async (email) => {
              if (!email) {
                updateEmailStatus(id, 'skipped');
                retryState.delete(id);
                return;
              }
              updateEmailStatus(id, 'queued');
              await onEmail({
                email,
                fetchThread: () =>
                  fetchThreadMessages(email.threadId, email.id),
              });
              retryState.delete(id);
            })
            .catch((err) => {
              updateEmailStatus(id, 'failed');
              logger.error({ messageId: id, err }, 'Email retry failed');
            });
        }, delayMs);
      }

      // Phase 2: Intake new emails (Gmail-driven)
      const emails = await fetchNewEmails(gmail);

      for (const email of emails) {
        logger.info(
          { from: email.from, subject: email.subject },
          'New email received',
        );

        // Queue + mark read (intake complete)
        insertEmailMessage(email.id, email.threadId, email.from, email.subject);
        await markAsRead(gmail, email.id);

        try {
          await onEmail({
            email,
            fetchThread: () => fetchThreadMessages(email.threadId, email.id),
          });
        } catch (err) {
          logger.error(
            { from: email.from, subject: email.subject, err },
            'Email processing failed, will retry',
          );
        }
      }
    } catch (err) {
      logger.error({ err }, 'Email poll error');
    } finally {
      polling = false;
    }
  };

  // Initial poll
  poll().catch((err) => logger.error({ err }, 'Email initial poll error'));

  // Recurring poll
  setInterval(() => {
    poll().catch((err) => logger.error({ err }, 'Email poll error'));
  }, EMAIL_POLL_INTERVAL);
}

/**
 * Classify which group an email should route to based on ALL participants.
 * Principal-only when thread is exclusively principal <-> assistant.
 * Any other participant -> external.
 */
export function classifyEmailRoute(email: IncomingEmail): string {
  const participants = extractAllParticipants(email);
  for (const addr of participants) {
    if (
      !isPrincipalEmail(addr) &&
      addr.toLowerCase() !== ASSISTANT_EMAIL.toLowerCase()
    ) {
      return 'email-external';
    }
  }
  return 'email-principal';
}

/**
 * Extract all email addresses from From, To, and CC fields.
 * Returns deduplicated lowercase addresses.
 */
function extractAllParticipants(email: IncomingEmail): string[] {
  const addresses = new Set<string>();
  if (email.from) addresses.add(email.from.toLowerCase());
  for (const raw of [email.to, email.cc]) {
    if (!raw) continue;
    for (const part of raw.split(',')) {
      const addr = extractEmailAddress(part.trim());
      if (addr) addresses.add(addr.toLowerCase());
    }
  }
  return [...addresses];
}

/** Comma-separated participant addresses for thread metadata. */
export function getEmailParticipants(email: IncomingEmail): string {
  return extractAllParticipants(email).join(', ');
}

/**
 * Build the agent prompt for an incoming email.
 * When threadMessages are provided, injects thread history and computes
 * the references chain. Otherwise falls back to agent-fetched references.
 */
export function buildEmailPrompt(
  email: IncomingEmail,
  isExternal?: boolean,
  threadMessages?: ThreadMessage[],
): string {
  const replySubject = email.subject.startsWith('Re:')
    ? email.subject
    : `Re: ${email.subject}`;
  const ownAddress = ASSISTANT_EMAIL.toLowerCase();
  const allRecipients = `${email.to}, ${email.cc}`
    .split(',')
    .map((r) => extractEmailAddress(r.trim()))
    .filter(
      (r) =>
        r &&
        r.toLowerCase() !== ownAddress &&
        r.toLowerCase() !== email.from.toLowerCase(),
    );
  const ccParam =
    allRecipients.length > 0 ? `\n- cc: "${allRecipients.join(', ')}"` : '';

  const externalNote = isExternal
    ? `\n\n[EXTERNAL SENDER — this person is not ${PRINCIPAL_NAME}. Handle per email-external procedures.]`
    : '';

  // Thread history (prior messages, oldest first)
  let threadSection = '';
  if (threadMessages && threadMessages.length > 0) {
    const lines = threadMessages.map(
      (m, i) => `[${i + 1}] From: ${m.from} | Date: ${m.date}\n${m.body}`,
    );
    threadSection = `\n--- Thread History (${threadMessages.length} prior message${threadMessages.length > 1 ? 's' : ''}, oldest first) ---\n${lines.join('\n\n')}\n--- End Thread History ---\n`;
  }

  // References chain: computed from thread messages or fallback to agent-fetched
  const allMessageIds = [
    ...(threadMessages || []).map((m) => m.messageId).filter(Boolean),
    email.messageId,
  ].filter(Boolean);
  const referencesParam =
    allMessageIds.length > 1
      ? `- references: "${allMessageIds.join(' ')}"`
      : '- references: <use get_gmail_thread_content to build the Message-ID chain>';

  return `[EMAIL RECEIVED]
${threadSection}
From: ${email.from}
To: ${email.to}${email.cc ? `\nCc: ${email.cc}` : ''}
Subject: ${email.subject}
Date: ${email.date}

--- Email Body ---
${email.body}
--- End Email Body ---

Reply params:
- to: "${email.from}"
${ccParam}
- subject: "${replySubject}"
- thread_id: "${email.threadId}"
- in_reply_to: "${email.messageId}"
${referencesParam}
- user_google_email: "${ASSISTANT_EMAIL}"
- from_name: "${ASSISTANT_NAME}"
- from_email: "${ASSISTANT_EMAIL}"
- body_format: "html"${externalNote}`;
}

// --- Private helpers ---

function extractEmailAddress(header: string): string {
  const match = header.match(/<([^>]+)>/);
  return match ? match[1] : header;
}

function decodeBody(body: string): string {
  return Buffer.from(body, 'base64url').toString('utf-8');
}

function getTextBody(payload: {
  mimeType?: string;
  body?: { data?: string };
  parts?: Array<{
    mimeType?: string;
    body?: { data?: string };
    parts?: unknown[];
  }>;
}): string {
  if (payload.body?.data && payload.mimeType === 'text/plain') {
    return decodeBody(payload.body.data);
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return decodeBody(part.body.data);
      }
    }
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body?.data) {
        const html = decodeBody(part.body.data);
        return html
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
    for (const part of payload.parts) {
      if (part.mimeType?.startsWith('multipart/') && part.parts) {
        const result = getTextBody(part as typeof payload);
        if (result) return result;
      }
    }
  }

  if (payload.body?.data) {
    return decodeBody(payload.body.data);
  }

  return '';
}

function getHeader(
  headers: Array<{ name: string; value: string }>,
  name: string,
): string {
  return (
    headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ||
    ''
  );
}

/**
 * Check if an email is relevant to the principal.
 * Only pass through emails that a real EA would act on.
 */
function isRelevantEmail(email: IncomingEmail): boolean {
  const fromLower = email.from.toLowerCase();
  const subjectLower = email.subject.toLowerCase();
  const bodyLower = email.body.toLowerCase().slice(0, 3000);

  if (isPrincipalEmail(fromLower)) return true;

  // Derive name variants dynamically from PRINCIPAL_NAME
  const nameVariants = [
    PRINCIPAL_NAME.toLowerCase(),
    ...PRINCIPAL_NAME.toLowerCase().split(/\s+/),
    ...PRINCIPAL_EMAILS,
  ];
  for (const name of nameVariants) {
    if (subjectLower.includes(name) || bodyLower.includes(name)) return true;
  }

  const recipientsLower = `${email.to}, ${email.cc}`.toLowerCase();
  for (const addr of PRINCIPAL_EMAILS) {
    if (recipientsLower.includes(addr)) return true;
  }

  const noisePatterns = [
    'unsubscribe',
    'no-reply@',
    'noreply@',
    'notifications@',
    'newsletter',
    'marketing@',
    'promo',
    'donotreply',
    'account verification',
    'verify your email',
    'welcome to',
    'your receipt',
    'order confirmation',
    'shipping notification',
  ];
  for (const pattern of noisePatterns) {
    if (
      fromLower.includes(pattern) ||
      subjectLower.includes(pattern) ||
      bodyLower.includes(pattern.toLowerCase())
    ) {
      return false;
    }
  }

  return true;
}

/** Parse a Gmail API message response into an IncomingEmail. */
function parseGmailMessage(
  id: string,
  threadId: string,
  payload: Parameters<typeof getTextBody>[0] & {
    headers?: Array<{ name: string; value: string }>;
  },
): IncomingEmail {
  const headers = (payload?.headers || []) as Array<{
    name: string;
    value: string;
  }>;
  const from = getHeader(headers, 'From');
  const rfcMessageId =
    getHeader(headers, 'Message-ID') || getHeader(headers, 'Message-Id');

  return {
    id,
    threadId,
    messageId: rfcMessageId,
    from: extractEmailAddress(from),
    to: getHeader(headers, 'To'),
    cc: getHeader(headers, 'Cc') || getHeader(headers, 'CC'),
    subject: getHeader(headers, 'Subject'),
    body: getTextBody(payload).slice(0, 10000),
    date: getHeader(headers, 'Date'),
  };
}

/** Re-fetch a single email by message ID (for retry). Returns null if deleted. */
async function fetchEmailById(
  gmail: ReturnType<typeof google.gmail>,
  messageId: string,
): Promise<IncomingEmail | null> {
  try {
    const msg = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full',
    });
    if (!msg.data.id || !msg.data.threadId) return null;
    return parseGmailMessage(
      msg.data.id,
      msg.data.threadId,
      msg.data.payload as Parameters<typeof parseGmailMessage>[2],
    );
  } catch (err: unknown) {
    const status = (err as { code?: number }).code;
    if (status === 404) {
      logger.warn({ messageId }, 'Email deleted, skipping retry');
      return null;
    }
    throw err;
  }
}

async function fetchNewEmails(
  gmail: ReturnType<typeof google.gmail>,
): Promise<IncomingEmail[]> {
  const emails: IncomingEmail[] = [];

  try {
    const response = await gmail.users.messages.list({
      userId: 'me',
      q: 'is:unread in:inbox -category:promotions -category:social -category:updates',
      maxResults: 10,
    });

    const messageRefs = response.data.messages || [];
    logger.debug(
      { count: messageRefs.length },
      'Gmail poll: unread messages found',
    );
    if (messageRefs.length === 0) return emails;

    for (const ref of messageRefs) {
      if (!ref.id || !ref.threadId) continue;

      // Skip already-seen messages (any status)
      if (isEmailSeen(ref.id)) continue;

      try {
        const msg = await gmail.users.messages.get({
          userId: 'me',
          id: ref.id,
          format: 'full',
        });

        const email = parseGmailMessage(
          ref.id,
          ref.threadId,
          msg.data.payload as Parameters<typeof parseGmailMessage>[2],
        );

        if (isRelevantEmail(email)) {
          emails.push(email);
        } else {
          // Not relevant — mark skipped so we don't check again, and mark read
          insertEmailMessage(ref.id, ref.threadId, email.from, email.subject);
          updateEmailStatus(ref.id, 'skipped');
          await markAsRead(gmail, ref.id);
          logger.debug(
            { from: email.from, subject: email.subject },
            'Email filtered out (not relevant to principal)',
          );
        }
      } catch (err) {
        logger.warn(
          { messageId: ref.id, err },
          'Failed to fetch email details',
        );
      }
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const errStack = err instanceof Error ? err.stack : undefined;
    logger.error(
      { err: errMsg, stack: errStack },
      'Failed to list Gmail messages',
    );
  }

  return emails;
}

async function markAsRead(
  gmail: ReturnType<typeof google.gmail>,
  messageId: string,
): Promise<void> {
  try {
    await gmail.users.messages.modify({
      userId: 'me',
      id: messageId,
      requestBody: { removeLabelIds: ['UNREAD'] },
    });
  } catch (err) {
    logger.warn({ messageId, err }, 'Failed to mark email as read');
  }
}
