/**
 * The Gmail REST calls the inbox makes, behind a small typed client (KTD4).
 * No client library: each call is one `fetch` with the host's own Gmail
 * token in its header, so the token never reaches a container or an argument
 * list. Tests use a fake with the same interface.
 */
import { isRecord } from '../../gws-ea/validation.js';

/** A Google API answered with an error status, or could not be reached (status 0). */
export class GoogleApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'GoogleApiError';
  }

  /** Worth retrying: unreachable, rate-limited, or a server error. */
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

export interface GmailHeader {
  readonly name: string;
  readonly value: string;
}

export interface GmailMessagePart {
  readonly mimeType?: string;
  readonly filename?: string;
  readonly headers?: readonly GmailHeader[];
  readonly body?: { readonly size?: number; readonly data?: string; readonly attachmentId?: string };
  readonly parts?: readonly GmailMessagePart[];
}

export interface GmailMessage {
  readonly id: string;
  readonly threadId: string;
  readonly labelIds?: readonly string[];
  /** Epoch milliseconds, as a string. */
  readonly internalDate?: string;
  readonly payload?: GmailMessagePart;
}

export interface GmailMessageRef {
  readonly id: string;
  readonly threadId: string;
  readonly labelIds?: readonly string[];
}

export interface GmailHistoryRecord {
  readonly id: string;
  readonly messagesAdded?: readonly { readonly message: GmailMessageRef }[];
  readonly labelsAdded?: readonly { readonly message: GmailMessageRef; readonly labelIds: readonly string[] }[];
}

export type GmailHistoryType = 'messageAdded' | 'labelAdded';

export interface GmailHistoryPage {
  readonly history: readonly GmailHistoryRecord[];
  readonly nextPageToken?: string;
  readonly historyId: string;
}

export interface GmailApi {
  getProfile(): Promise<{ readonly emailAddress: string; readonly historyId: string }>;
  /** Throws a `GoogleApiError` with status 404 when `startHistoryId` is too old. */
  listHistory(input: {
    readonly startHistoryId: string;
    readonly labelId: 'INBOX';
    readonly historyTypes: readonly GmailHistoryType[];
    readonly pageToken?: string;
  }): Promise<GmailHistoryPage>;
  /** Undefined when the message no longer exists. `metadata` returns the reconciliation headers only. */
  getMessage(id: string, format?: 'full' | 'metadata'): Promise<GmailMessage | undefined>;
  listMessages(input: {
    readonly q?: string;
    readonly labelIds?: readonly string[];
    readonly maxResults: number;
  }): Promise<GmailMessageRef[]>;
  /** The thread's messages with their reconciliation headers; undefined when it no longer exists. */
  getThread(id: string): Promise<GmailMessage[] | undefined>;
  /** One file a message carries, base64url, as Gmail stores it; undefined when it no longer exists. */
  getAttachment(messageId: string, attachmentId: string): Promise<string | undefined>;
  send(input: {
    readonly raw: string;
    readonly threadId?: string;
  }): Promise<{ readonly id: string; readonly threadId: string }>;
}

/** The headers a sent message is found by: Gmail may keep a client's Message-ID or move it. */
export const RECONCILIATION_HEADERS = ['Message-ID', 'X-Google-Original-Message-ID'] as const;

export interface GoogleClientOptions {
  /** A live access token for this call; minted in host memory. */
  readonly token: () => Promise<string>;
  readonly fetch?: typeof globalThis.fetch;
}

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * One JSON call to a Google API. With `allowNotFound`, a 404 returns
 * undefined; every other failure throws a `GoogleApiError`.
 */
export async function googleJson(
  options: GoogleClientOptions,
  url: string,
  init: { readonly method?: string; readonly body?: unknown; readonly allowNotFound?: boolean } = {},
): Promise<unknown> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const token = await options.token();
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new GoogleApiError(0, `Google could not be reached (${new URL(url).pathname})`, { cause: error });
  }
  if (response.status === 404 && init.allowNotFound === true) return undefined;
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const reason =
      isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === 'string'
        ? payload.error.message
        : `HTTP ${response.status}`;
    throw new GoogleApiError(response.status, `Google refused ${new URL(url).pathname}: ${reason}`);
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Response shapes: fields read are checked; anything else is ignored.
// ---------------------------------------------------------------------------

function unreadable(what: string): GoogleApiError {
  return new GoogleApiError(502, `Gmail returned an unreadable ${what}`);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function texts(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined;
}

function toRef(value: unknown): GmailMessageRef {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.threadId !== 'string') {
    throw unreadable('message reference');
  }
  const labelIds = texts(value.labelIds);
  return { id: value.id, threadId: value.threadId, ...(labelIds ? { labelIds } : {}) };
}

function toPart(value: unknown): GmailMessagePart {
  if (!isRecord(value)) throw unreadable('message part');
  const headers = Array.isArray(value.headers)
    ? value.headers.flatMap((header): GmailHeader[] =>
        isRecord(header) && typeof header.name === 'string' && typeof header.value === 'string'
          ? [{ name: header.name, value: header.value }]
          : [],
      )
    : undefined;
  const body = isRecord(value.body)
    ? {
        ...(typeof value.body.size === 'number' ? { size: value.body.size } : {}),
        ...(typeof value.body.data === 'string' ? { data: value.body.data } : {}),
        ...(typeof value.body.attachmentId === 'string' ? { attachmentId: value.body.attachmentId } : {}),
      }
    : undefined;
  const mimeType = text(value.mimeType);
  const filename = text(value.filename);
  return {
    ...(mimeType === undefined ? {} : { mimeType }),
    ...(filename === undefined ? {} : { filename }),
    ...(headers ? { headers } : {}),
    ...(body ? { body } : {}),
    ...(Array.isArray(value.parts) ? { parts: value.parts.map(toPart) } : {}),
  };
}

function toMessage(value: unknown): GmailMessage {
  const ref = toRef(value);
  const record = value as Record<string, unknown>;
  const internalDate = text(record.internalDate);
  return {
    ...ref,
    ...(internalDate === undefined ? {} : { internalDate }),
    ...(record.payload === undefined ? {} : { payload: toPart(record.payload) }),
  };
}

function toHistoryRecord(value: unknown): GmailHistoryRecord {
  if (!isRecord(value) || typeof value.id !== 'string') throw unreadable('history record');
  const messagesAdded = Array.isArray(value.messagesAdded)
    ? value.messagesAdded.map((entry) => {
        if (!isRecord(entry)) throw unreadable('history record');
        return { message: toRef(entry.message) };
      })
    : undefined;
  const labelsAdded = Array.isArray(value.labelsAdded)
    ? value.labelsAdded.map((entry) => {
        if (!isRecord(entry)) throw unreadable('history record');
        return { message: toRef(entry.message), labelIds: texts(entry.labelIds) ?? [] };
      })
    : undefined;
  return {
    id: value.id,
    ...(messagesAdded ? { messagesAdded } : {}),
    ...(labelsAdded ? { labelsAdded } : {}),
  };
}

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';

function query(params: Record<string, string | readonly string[] | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) search.append(key, String(item));
    else search.append(key, String(value));
  }
  const rendered = search.toString();
  return rendered === '' ? '' : `?${rendered}`;
}

const METADATA = { format: 'metadata', metadataHeaders: [...RECONCILIATION_HEADERS] } as const;

/** The real client, over Gmail's REST API. */
export function createGmailApi(options: GoogleClientOptions): GmailApi {
  return {
    async getProfile() {
      const payload = await googleJson(options, `${GMAIL}/profile`);
      if (!isRecord(payload) || typeof payload.emailAddress !== 'string' || typeof payload.historyId !== 'string') {
        throw unreadable('profile');
      }
      return { emailAddress: payload.emailAddress, historyId: payload.historyId };
    },

    async listHistory(input) {
      const payload = await googleJson(
        options,
        `${GMAIL}/history${query({
          startHistoryId: input.startHistoryId,
          labelId: input.labelId,
          historyTypes: input.historyTypes,
          maxResults: 500,
          pageToken: input.pageToken,
        })}`,
      );
      if (!isRecord(payload) || typeof payload.historyId !== 'string') throw unreadable('history page');
      const nextPageToken = text(payload.nextPageToken);
      return {
        history: Array.isArray(payload.history) ? payload.history.map(toHistoryRecord) : [],
        historyId: payload.historyId,
        ...(nextPageToken === undefined ? {} : { nextPageToken }),
      };
    },

    async getMessage(id, format = 'full') {
      const params = format === 'full' ? { format: 'full' } : METADATA;
      const payload = await googleJson(options, `${GMAIL}/messages/${encodeURIComponent(id)}${query(params)}`, {
        allowNotFound: true,
      });
      return payload === undefined ? undefined : toMessage(payload);
    },

    async listMessages(input) {
      const payload = await googleJson(
        options,
        `${GMAIL}/messages${query({ q: input.q, labelIds: input.labelIds, maxResults: input.maxResults })}`,
      );
      if (!isRecord(payload)) throw unreadable('message list');
      return Array.isArray(payload.messages) ? payload.messages.map(toRef) : [];
    },

    async getThread(id) {
      const payload = await googleJson(options, `${GMAIL}/threads/${encodeURIComponent(id)}${query(METADATA)}`, {
        allowNotFound: true,
      });
      if (payload === undefined) return undefined;
      if (!isRecord(payload)) throw unreadable('thread');
      return Array.isArray(payload.messages) ? payload.messages.map(toMessage) : [];
    },

    async getAttachment(messageId, attachmentId) {
      const payload = await googleJson(
        options,
        `${GMAIL}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
        { allowNotFound: true },
      );
      if (payload === undefined) return undefined;
      if (!isRecord(payload) || typeof payload.data !== 'string') throw unreadable('attachment');
      return payload.data;
    },

    async send(input) {
      const payload = await googleJson(options, `${GMAIL}/messages/send`, {
        method: 'POST',
        body: { raw: input.raw, ...(input.threadId === undefined ? {} : { threadId: input.threadId }) },
      });
      const ref = toRef(payload);
      return { id: ref.id, threadId: ref.threadId };
    },
  };
}
