/**
 * The assistant's Gmail in memory, for the tests of its web alias probe
 * (KTD13): what it sent, and what came back as a test arranges it. Search
 * matches `rfc822msgid:` on Message-ID, and a quoted term anywhere in a
 * message. A test makes Gmail deliver the probe, deliver it through a
 * Google Group, or bounce it, at once (`onSend`) or later.
 */
import { ensureContainerConfig } from '../../../db/container-configs.js';
import { createAgentGroup } from '../../../db/index.js';
import { reconcileGwsEaProfile } from '../../gws-ea-profile/db.js';
import type { GmailApi, GmailHeader, GmailMessage, GmailMessageRef } from '../gmail-api.js';
import type { InboxRuntime } from '../runtime.js';

/** The assistant every alias test serves, and the alias its name gives. */
export const ASSISTANT_NAME = 'Juno';
export const ASSISTANT_EMAIL = 'juno@example.test';
export const PRINCIPAL_EMAIL = 'morgan@example.test';
export const ALIAS = 'onuj@example.test';

/** The top-level headers of an RFC 822 message, unfolded. */
export function headersOf(mime: string): GmailHeader[] {
  const head = mime.slice(0, mime.indexOf('\r\n\r\n')).replace(/\r\n[ \t]+/gu, ' ');
  return head.split('\r\n').map((line) => {
    const colon = line.indexOf(':');
    return { name: line.slice(0, colon), value: line.slice(colon + 1).trim() };
  });
}

interface Held {
  message: GmailMessage;
  /** What Gmail search matches: every header and the body as sent. */
  readonly text: string;
}

export class FakeAliasGmail implements GmailApi {
  readonly held = new Map<string, Held>();
  /** Every message sent, as RFC 822 text. */
  readonly sent: string[] = [];
  /** What Gmail does the moment it takes a send. */
  onSend: ((id: string) => void) | undefined;
  #next = 1;

  #id(): string {
    return `m${this.#next++}`;
  }

  async getProfile() {
    return { emailAddress: ASSISTANT_EMAIL, historyId: '1' };
  }

  async listHistory(): Promise<never> {
    throw new Error('The alias probe never reads history');
  }

  async getThread(): Promise<never> {
    throw new Error('The alias probe never reads a thread');
  }

  async getAttachment(): Promise<never> {
    throw new Error('The alias probe never reads a file');
  }

  async getMessage(id: string): Promise<GmailMessage | undefined> {
    return this.held.get(id)?.message;
  }

  async listMessages(input: { readonly q?: string }): Promise<GmailMessageRef[]> {
    const query = input.q ?? '';
    const matches = [...this.held.values()].filter(({ message, text }) => {
      if (query.startsWith('rfc822msgid:')) {
        const wanted = `<${query.slice('rfc822msgid:'.length)}>`;
        return message.payload?.headers?.some((header) => header.name === 'Message-ID' && header.value === wanted);
      }
      const term = /^"(.+)"$/u.exec(query)?.[1];
      return term !== undefined && text.includes(term);
    });
    return matches.map(({ message }) => ({ id: message.id, threadId: message.threadId }));
  }

  async send(input: { readonly raw: string }): Promise<{ id: string; threadId: string }> {
    const mime = Buffer.from(input.raw, 'base64url').toString('utf8');
    this.sent.push(mime);
    const id = this.#id();
    this.held.set(id, {
      message: { id, threadId: id, labelIds: ['SENT'], payload: { headers: headersOf(mime) } },
      text: mime,
    });
    this.onSend?.(id);
    return { id, threadId: id };
  }

  /** The last probe as sent. */
  get probe(): Held {
    const last = [...this.held.values()].filter(({ message }) => message.labelIds?.includes('SENT')).at(-1);
    if (!last) throw new Error('Nothing was sent');
    return last;
  }

  /** Gmail delivers the probe to the assistant's own mailbox: the sent message is also in the inbox. */
  deliver(id = this.probe.message.id): void {
    const held = this.held.get(id);
    if (!held) throw new Error(`No message ${id}`);
    held.message = { ...held.message, labelIds: ['SENT', 'INBOX', 'UNREAD'] };
  }

  /** A copy of the probe reaches the inbox through a Google Group the assistant belongs to. */
  deliverThroughGroup(header: 'List-Id' | 'X-Google-Group-Id'): void {
    const { message, text } = this.probe;
    const id = this.#id();
    const headers = [...(message.payload?.headers ?? []), { name: header, value: '<onuj.example.test>' }];
    this.held.set(id, { message: { id, threadId: id, labelIds: ['INBOX'], payload: { headers } }, text });
  }

  /** Gmail's notice that the probe could not be delivered, quoting it. */
  bounce(): void {
    const { text } = this.probe;
    const to = this.probe.message.payload?.headers?.find((header) => header.name === 'To')?.value ?? ALIAS;
    const id = this.#id();
    const headers: GmailHeader[] = [
      { name: 'From', value: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>' },
      { name: 'To', value: ASSISTANT_EMAIL },
      { name: 'Subject', value: 'Delivery Status Notification (Failure)' },
      { name: 'Content-Type', value: 'multipart/report; boundary="b"; report-type=delivery-status' },
      { name: 'X-Failed-Recipients', value: to },
      { name: 'Message-ID', value: `<dsn.${id}@mx.google.com>` },
    ];
    this.held.set(id, {
      message: { id, threadId: id, labelIds: ['INBOX', 'UNREAD'], payload: { headers } },
      text: `Address not found\n----- Original message -----\n${text}`,
    });
  }
}

/** The running inbox the probe command finds, over `gmail`. */
export function aliasInbox(gmail: GmailApi): InboxRuntime {
  return {
    gmail,
    setup: () => undefined,
    gmailAddress: async () => ASSISTANT_EMAIL,
    knownGmailAddress: () => ASSISTANT_EMAIL,
    now: () => new Date('2026-10-17T15:00:00.000Z'),
    sleep: async () => undefined,
    wakeSignIn: () => undefined,
  };
}

/** The published profile of the assistant every alias test serves, in a migrated test database. */
export async function publishAliasTestProfile(): Promise<void> {
  await createAgentGroup({
    id: 'ag-main',
    name: 'main',
    folder: 'main',
    agent_provider: null,
    created_at: '2026-10-17T00:00:00.000Z',
  });
  await ensureContainerConfig('ag-main');
  await reconcileGwsEaProfile({
    assistantName: { firstName: ASSISTANT_NAME, lastName: null },
    assistantWorkspaceEmail: ASSISTANT_EMAIL,
    principalName: { firstName: 'Morgan', lastName: 'Ellery' },
    principalTimezone: 'America/New_York',
    mainAgentGroupId: 'ag-main',
    principalEmails: [PRINCIPAL_EMAIL],
  });
}
