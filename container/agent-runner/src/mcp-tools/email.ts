/** `send_email` MCP tool — explicit two-mode email send (reply / compose). */
import { getCurrentInReplyTo } from '../current-batch.js';
import { writeMessageOut } from '../db/messages-out.js';
import { recordTurnSentPayload } from '../db/session-state.js';
import {
  asStringArray,
  err,
  generateId,
  ok,
  resolveRouting,
  stageOutboxFile,
} from './core.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

type Intent = 'reply' | 'compose';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

const REPLY_WITHOUT_THREAD_ID_ERROR =
  "intent 'reply' requires thread_id. Read the thread now with `mcp__gworkspace__get_gmail_thread_content` (even if you already have the id from a matter artifact — stored ids are stale), then pass the id you just read. See email-triage SKILL.md for the full procedure.";

export const sendEmail: McpToolDefinition = {
  tool: {
    name: 'send_email',
    description:
      "Send an email. Two modes by `intent`: 'reply' (requires `thread_id`, overrides allowed) or 'compose' (requires `recipients` + `subject`). DO NOT use this tool for a plain in-thread reply on the current email session — use a `<message to=\"email-…\">` block instead. See email-triage SKILL.md for the procedure that must run before every send.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        to: {
          type: 'string',
          description: 'Email destination name (e.g., "email-external"). Optional if you have only one destination.',
        },
        text: { type: 'string', description: 'Message body. Markdown is supported and renders to HTML.' },
        intent: {
          type: 'string',
          enum: ['reply', 'compose'],
          description: "'reply' to continue an existing thread (requires `thread_id`); 'compose' to start a new thread (requires `recipients` + `subject`).",
        },
        thread_id: {
          type: 'string',
          description: "Gmail thread id. Required when `intent: 'reply'`, forbidden when `intent: 'compose'`. Always pass the id you just read with `mcp__gworkspace__get_gmail_thread_content` — see email-triage SKILL.md for sourcing.",
        },
        subject: {
          type: 'string',
          description: "Email subject. Required for `intent: 'compose'`; optional override for `intent: 'reply'` (defaults to Re: of the prior subject).",
        },
        recipients: {
          type: 'array',
          items: { type: 'string' },
          description: "Email To: list. Required for `intent: 'compose'`; optional override for `intent: 'reply'` (full replacement, not a merge).",
        },
        cc: { type: 'array', items: { type: 'string' }, description: 'Email Cc: list (override).' },
        bcc: { type: 'array', items: { type: 'string' }, description: 'Email Bcc: list.' },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'File paths (relative to /workspace/agent/ or absolute) to attach.',
        },
      },
      required: ['intent', 'text'],
    },
  },
  async handler(args) {
    const text = typeof args.text === 'string' ? args.text : undefined;
    if (!text) return err('text is required');

    const intent = args.intent;
    if (intent !== 'reply' && intent !== 'compose') {
      return err("intent must be 'reply' or 'compose'");
    }

    const routing = resolveRouting(args.to as string | undefined);
    if ('error' in routing) return err(routing.error);

    if (routing.channel_type !== 'email') {
      return err(`send_email only sends to email destinations; "${routing.resolvedName}" is ${routing.channel_type}. Use send_message instead.`);
    }

    const threadId =
      typeof args.thread_id === 'string' && args.thread_id.trim().length > 0 ? args.thread_id : undefined;
    const recipients = asStringArray(args.recipients);
    const cc = asStringArray(args.cc);
    const bcc = asStringArray(args.bcc);
    const subject = typeof args.subject === 'string' ? args.subject : undefined;
    const filePaths = asStringArray(args.files);

    const writeThreadId = validateIntentShape(intent, threadId, recipients, subject);
    if ('error' in writeThreadId) return err(writeThreadId.error);

    const id = generateId();

    let stagedFilenames: string[] | undefined;
    if (filePaths) {
      stagedFilenames = [];
      for (const p of filePaths) {
        const staged = stageOutboxFile(id, p);
        if ('error' in staged) return err(staged.error);
        stagedFilenames.push(staged.filename);
      }
    }

    const content: Record<string, unknown> = { text };
    if (subject !== undefined) content.subject = subject;
    if (recipients) content.to = recipients;
    if (cc) content.cc = cc;
    if (bcc) content.bcc = bcc;
    if (stagedFilenames) content.files = stagedFilenames;

    const seq = writeMessageOut({
      id,
      in_reply_to: getCurrentInReplyTo(),
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: writeThreadId.value,
      content: JSON.stringify(content),
    });

    recordTurnSentPayload(text);
    log(`send_email: #${seq} → ${routing.resolvedName} (${intent})`);
    return ok(`Email sent to ${routing.resolvedName} (id: ${seq})`);
  },
};

function validateIntentShape(
  intent: Intent,
  threadId: string | undefined,
  recipients: string[] | undefined,
  subject: string | undefined,
): { value: string | null } | { error: string } {
  if (intent === 'reply') {
    if (!threadId) return { error: REPLY_WITHOUT_THREAD_ID_ERROR };
    return { value: threadId };
  }
  if (threadId) {
    return { error: "intent 'compose' does not accept thread_id — use intent: 'reply' to reply on a thread" };
  }
  if (!recipients || recipients.length === 0 || !subject) {
    return { error: "intent 'compose' requires recipients + subject" };
  }
  return { value: null };
}

registerTools([sendEmail]);
