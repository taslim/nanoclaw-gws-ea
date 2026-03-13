/**
 * Email event source for NanoClaw GWS-EA
 *
 * Email is an event source, not a channel. The agent decides whether/how
 * to reply via MCP tools; its text output is a status update forwarded
 * to the main channel, not the email reply.
 *
 * Polls Gmail for new emails and invokes a callback per email.
 * On success the email is marked processed, read, and responded.
 * On failure it stays unread for retry on the next poll cycle.
 *
 * Emails from the principal -> email:principal (full EA tools)
 * All other emails -> email:external (restricted tools)
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
  isEmailProcessed,
  markEmailProcessed,
  markEmailResponded,
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
    // NanoClaw IPC — messaging and task management, no admin operations
    'mcp__nanoclaw__send_message',
    'mcp__nanoclaw__schedule_task',
    'mcp__nanoclaw__list_tasks',
    'mcp__nanoclaw__update_email_thread',
    'mcp__nanoclaw__list_email_threads',
    // Full calendar access (principal's emails often involve scheduling decisions)
    'mcp__calendar__*',
    // Time MCP — date math, timezone conversions
    'mcp__time__*',
    // Google Workspace — contacts, docs, sheets, drive (no Chat admin)
    'mcp__workspace__contacts_search',
    'mcp__workspace__contacts_get',
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
    'mcp__workspace__tasks_list',
    'mcp__workspace__tasks_create',
    'mcp__workspace__tasks_update',
    'mcp__workspace__tasks_delete',
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
    // NanoClaw IPC — no send_message (escalation handled by output forwarding)
    'mcp__nanoclaw__schedule_task',
    'mcp__nanoclaw__list_tasks',
    'mcp__nanoclaw__update_email_thread',
    'mcp__nanoclaw__list_email_threads',
    // Calendar: free/busy, event management, and calendar discovery
    // Excludes: list-events, get-event, search-events (prevents reading event details)
    'mcp__calendar__list-calendars',
    'mcp__calendar__get-freebusy',
    'mcp__calendar__create-event',
    'mcp__calendar__update-event',
    'mcp__calendar__delete-event',
    'mcp__calendar__respond-to-event',
    'mcp__calendar__get-current-time',
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

// --- Public API ---

/**
 * Start polling Gmail for new emails.
 * Calls onEmail for each new, relevant email.
 * On callback success: marks processed, read, and responded.
 * On callback failure: leaves email unread for retry on next poll.
 */
export function startEmailLoop(
  onEmail: (email: IncomingEmail) => Promise<void>,
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

  logger.info(
    `Email channel active (polling every ${EMAIL_POLL_INTERVAL / 1000}s)`,
  );

  let polling = false;

  const poll = async () => {
    if (polling) return;
    polling = true;
    try {
      const emails = await fetchNewEmails(gmail);

      for (const email of emails) {
        logger.info(
          { from: email.from, subject: email.subject },
          'New email received',
        );

        try {
          await onEmail(email);

          // Success — mark processed, read, and responded
          markEmailProcessed(
            email.id,
            email.threadId,
            email.from,
            email.subject,
          );
          await markAsRead(gmail, email.id);
          markEmailResponded(email.id);
        } catch (err) {
          // Failure — leave unread for retry on next poll
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
 * Determine which group folder an email should route to based on sender.
 * Returns 'email-principal' for principal, 'email-external' for everyone else.
 */
export function getEmailRouteGroup(email: IncomingEmail): string {
  return isPrincipalEmail(email.from) ? 'email-principal' : 'email-external';
}

/**
 * Build the agent prompt for an incoming email.
 */
export function buildEmailPrompt(
  email: IncomingEmail,
  isExternal?: boolean,
): string {
  const replySubject = email.subject.startsWith('Re:')
    ? email.subject
    : `Re: ${email.subject}`;
  const ownAddress = ASSISTANT_EMAIL;
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

  return `[EMAIL RECEIVED]

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
- references: <use get_gmail_thread_content to build the Message-ID chain>
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

      // Skip already-processed messages
      if (isEmailProcessed(ref.id)) continue;

      try {
        const msg = await gmail.users.messages.get({
          userId: 'me',
          id: ref.id,
          format: 'full',
        });

        const headers = msg.data.payload?.headers || [];
        const typedHeaders = headers as Array<{
          name: string;
          value: string;
        }>;
        const from = getHeader(typedHeaders, 'From');
        const to = getHeader(typedHeaders, 'To');
        const cc =
          getHeader(typedHeaders, 'Cc') || getHeader(typedHeaders, 'CC');
        const subject = getHeader(typedHeaders, 'Subject');
        const date = getHeader(typedHeaders, 'Date');
        const rfcMessageId =
          getHeader(typedHeaders, 'Message-ID') ||
          getHeader(typedHeaders, 'Message-Id');
        const body = getTextBody(
          msg.data.payload as Parameters<typeof getTextBody>[0],
        );

        const email: IncomingEmail = {
          id: ref.id,
          threadId: ref.threadId,
          messageId: rfcMessageId,
          from: extractEmailAddress(from),
          to,
          cc,
          subject,
          body: body.slice(0, 10000),
          date,
        };

        if (isRelevantEmail(email)) {
          emails.push(email);
        } else {
          // Not relevant — mark processed so we don't check again, and mark read
          markEmailProcessed(ref.id, ref.threadId, email.from, subject);
          await markAsRead(gmail, ref.id);
          logger.debug(
            { from: email.from, subject },
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
