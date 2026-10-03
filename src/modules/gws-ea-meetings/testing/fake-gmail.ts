/**
 * An in-memory Gmail, as the assistant's host token sees it, for the
 * meetings module's tests: enough to copy the assistant in, hold mail,
 * receive replies in a thread, and send the assistant's own replies.
 * Mail from the principal carries Gmail's verified-principal results; mail
 * from anyone else is authenticated for its own domain only.
 */
import type { GmailApi, GmailHistoryRecord, GmailMessage, GmailMessageRef } from '../../gws-ea-inbox/index.js';

export interface Header {
  readonly name: string;
  readonly value: string;
}

export interface IncomingMail {
  readonly from: string;
  readonly to?: readonly string[];
  readonly cc?: readonly string[];
  readonly subject?: string;
  readonly body?: string;
  readonly threadId?: string;
  readonly principal?: boolean;
}

export interface SentMail {
  readonly id: string;
  readonly threadId: string;
  readonly headers: Header[];
  readonly text: string;
}

export function header(headers: readonly Header[], name: string): string | undefined {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}

function parseRaw(raw: string): { headers: Header[]; text: string } {
  const source = Buffer.from(raw, 'base64url').toString('utf8');
  const split = source.indexOf('\r\n\r\n');
  const head = source.slice(0, split).replace(/\r\n[ \t]+/g, ' ');
  const headers = head.split('\r\n').map((line) => {
    const colon = line.indexOf(':');
    return { name: line.slice(0, colon), value: line.slice(colon + 1).trim() };
  });
  const body = source.slice(split + 4).replace(/\r\n/g, '');
  return { headers, text: Buffer.from(body, 'base64').toString('utf8') };
}

export class FakeGmail implements GmailApi {
  historyId = 1000;
  readonly messages = new Map<string, GmailMessage>();
  readonly history: GmailHistoryRecord[] = [];
  readonly sent: SentMail[] = [];
  private nextId = 1;

  /** `assistant` is the address the inbox belongs to. */
  constructor(private readonly assistant: string) {}

  receive(mail: IncomingMail): string {
    const id = `m${this.nextId++}`;
    const threadId = mail.threadId ?? `t${this.nextId++}`;
    const domain = mail.from.slice(mail.from.lastIndexOf('@') + 1).replace('>', '');
    const auth = mail.principal
      ? `mx.google.com;\r\n dkim=pass header.i=@${domain} header.s=google header.b=a;\r\n dmarc=pass (p=REJECT) header.from=${domain}`
      : `mx.google.com;\r\n dkim=pass header.i=@${domain} header.s=s1 header.b=a;\r\n dmarc=pass (p=NONE) header.from=${domain}`;
    const headers: Header[] = [
      { name: 'Delivered-To', value: this.assistant },
      { name: 'Received', value: 'from mail.example by mx.google.com with ESMTPS id y' },
      { name: 'Authentication-Results', value: auth },
      { name: 'From', value: mail.from },
      { name: 'To', value: (mail.to ?? [this.assistant]).join(', ') },
      ...(mail.cc ? [{ name: 'Cc', value: mail.cc.join(', ') }] : []),
      { name: 'Subject', value: mail.subject ?? 'Hello' },
      { name: 'Message-ID', value: `<${id}@mail.example>` },
    ];
    this.messages.set(id, {
      id,
      threadId,
      labelIds: ['INBOX', 'UNREAD'],
      internalDate: String(Date.now()),
      payload: {
        mimeType: 'text/plain',
        headers,
        body: { data: Buffer.from(mail.body ?? 'Hi', 'utf8').toString('base64url') },
      },
    });
    this.historyId += 1;
    this.history.push({
      id: String(this.historyId),
      messagesAdded: [{ message: { id, threadId, labelIds: ['INBOX', 'UNREAD'] } }],
    });
    return id;
  }

  async getProfile() {
    return { emailAddress: this.assistant, historyId: String(this.historyId) };
  }

  async listHistory(input: { startHistoryId: string }) {
    const start = Number(input.startHistoryId);
    return { history: this.history.filter((r) => Number(r.id) > start), historyId: String(this.historyId) };
  }

  async getMessage(id: string) {
    return this.messages.get(id);
  }

  async listMessages(input: { maxResults: number }): Promise<GmailMessageRef[]> {
    return [...this.messages.values()]
      .reverse()
      .slice(0, input.maxResults)
      .map((m) => ({ id: m.id, threadId: m.threadId }));
  }

  async getThread(id: string) {
    const messages = [...this.messages.values()].filter((m) => m.threadId === id);
    return messages.length > 0 ? messages : undefined;
  }

  async send(input: { raw: string; threadId?: string }) {
    const id = `s${this.nextId++}`;
    const threadId = input.threadId ?? `t${this.nextId++}`;
    const { headers, text } = parseRaw(input.raw);
    this.messages.set(id, { id, threadId, labelIds: ['SENT'], payload: { mimeType: 'text/plain', headers } });
    this.sent.push({ id, threadId, headers, text });
    return { id, threadId };
  }
}
