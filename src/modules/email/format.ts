/**
 * Render an email + thread history into the `text` field of an InboundMessage.
 *
 * The agent reads this and types a reply. The channel adapter handles reply
 * addressing on `deliver()` for inbound-session replies; the `Thread:` line
 * gives the agent the Gmail thread_id so it can also reply from a non-email
 * session via `send_email({ intent: 'reply', thread_id })`.
 */
export interface ThreadMessage {
  from: string;
  to: string;
  cc: string;
  date: string;
  body: string;
}

export interface FormatInput {
  from: string;
  to: string;
  cc: string;
  subject: string;
  date: string;
  body: string;
  threadId: string;
  threadHistory?: ThreadMessage[];
}

export function formatEmailForAgent(email: FormatInput): string {
  const lines: string[] = [];
  lines.push('[EMAIL RECEIVED]', '');

  if (email.threadHistory && email.threadHistory.length > 0) {
    const count = email.threadHistory.length;
    lines.push(`--- Thread History (${count} prior message${count > 1 ? 's' : ''}, oldest first) ---`);
    email.threadHistory.forEach((m, i) => {
      lines.push(`[${i + 1}] From: ${m.from} | Date: ${m.date}`, m.body, '');
    });
    lines.push('--- End Thread History ---', '');
  }

  lines.push(`From: ${email.from}`);
  lines.push(`To: ${email.to}`);
  if (email.cc) lines.push(`Cc: ${email.cc}`);
  lines.push(`Subject: ${email.subject}`);
  lines.push(`Date: ${email.date}`);
  lines.push(`Thread: ${email.threadId}`, '');

  lines.push('--- Email Body ---', email.body, '--- End Email Body ---');

  return lines.join('\n');
}
