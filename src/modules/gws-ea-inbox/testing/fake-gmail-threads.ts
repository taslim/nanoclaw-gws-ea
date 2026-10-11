/**
 * Gmail's threads in memory, as the host's Gmail token reads them, for the
 * tests of what reads a thread live: each message with its labels, Gmail's
 * time, the headers `getThread` asks for, and Gmail's excerpt. Every read is
 * recorded. A test makes the next read fail (`failNext`) or never answer
 * (`stallNext`).
 */
import type { GmailApi, GmailMessage } from '../gmail-api.js';

/** A message as a test writes it. */
export interface HeldMessage {
  readonly id: string;
  /** The From header as written. */
  readonly from: string;
  /** When Gmail received or sent it, ISO. */
  readonly at: string;
  readonly subject?: string;
  readonly snippet?: string;
  /** The assistant sent it. */
  readonly sent?: boolean;
  /** Still a draft. */
  readonly draft?: boolean;
}

function toGmail(threadId: string, message: HeldMessage): GmailMessage {
  return {
    id: message.id,
    threadId,
    labelIds: message.draft === true ? ['DRAFT'] : message.sent === true ? ['SENT'] : ['INBOX'],
    internalDate: String(Date.parse(message.at)),
    ...(message.snippet === undefined ? {} : { snippet: message.snippet }),
    payload: {
      headers: [
        { name: 'From', value: message.from },
        { name: 'Date', value: new Date(message.at).toUTCString() },
        ...(message.subject === undefined ? [] : [{ name: 'Subject', value: message.subject }]),
        { name: 'Message-ID', value: `<${message.id}@mail.example>` },
      ],
    },
  };
}

export class FakeGmailThreads implements Pick<GmailApi, 'getThread'> {
  /** The Gmail thread of every read, in order. */
  readonly reads: string[] = [];
  private readonly threads = new Map<string, GmailMessage[]>();
  private failure: Error | undefined;
  private stalled: (() => void) | undefined;

  /** The thread's messages become these, oldest first. */
  put(threadId: string, ...messages: readonly HeldMessage[]): void {
    this.threads.set(
      threadId,
      messages.map((message) => toGmail(threadId, message)),
    );
  }

  /** The next read fails with `error`. */
  failNext(error: Error): void {
    this.failure = error;
  }

  /** The next read never answers; the promise settles once it has begun. */
  stallNext(): Promise<void> {
    return new Promise((begun) => {
      this.stalled = begun;
    });
  }

  async getThread(id: string): Promise<GmailMessage[] | undefined> {
    this.reads.push(id);
    const failure = this.failure;
    this.failure = undefined;
    if (failure) throw failure;
    const begun = this.stalled;
    this.stalled = undefined;
    if (begun) {
      begun();
      return new Promise<never>(() => undefined);
    }
    return this.threads.get(id)?.slice();
  }
}
