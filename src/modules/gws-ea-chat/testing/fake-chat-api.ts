/**
 * The Google HTTP the assistant reads Chat with, faked at the `fetch`
 * boundary: Chat's REST API (a message, a space, a message's reactions, an
 * attachment's bytes) and the People API (a person's names). It answers as
 * Google does under user authentication:
 *
 * - A message names its sender by resource name and type only, with no
 *   display name, as do the users its mentions annotate.
 * - Reactions list in pages of `reactionPageSize`.
 * - What the assistant writes is its own: a message it posts, and a reaction
 *   it places, which Chat names in its answer and deletes only by that name.
 * - A file is uploaded to a space (`media.upload`, multipart) before a
 *   message carries it: a message may attach only what was uploaded to its
 *   own space, each upload once.
 * - An edit may update a message's text only: a user cannot update a card,
 *   so a mask naming one is refused as Google refuses it.
 * - Chat answers only the assistant's Chat token and People only its
 *   directory token; anything else is 401.
 *
 * Every request is recorded. A test makes a resource fail (`failures`, keyed
 * by its path, such as `spaces/AAAAjuno/messages/remy.1`, or
 * `spaces/AAAAjuno/attachments:upload` for an upload) until it clears it.
 */
import { ASSISTANT_TOKEN } from './fake-google-events.js';

export const CHAT_TOKEN = ASSISTANT_TOKEN;
export const DIRECTORY_TOKEN = 'assistant-directory-token';
/** The assistant's Google ID: Chat knows it as `users/{ASSISTANT_SUB}`. */
export const ASSISTANT_SUB = '100000000000000000001';
export const ASSISTANT = `users/${ASSISTANT_SUB}`;

export interface ChatFailure {
  readonly status: number;
  readonly message: string;
}

export interface ChatRequest {
  readonly method: string;
  readonly url: URL;
  readonly authorization: string | null;
}

export interface FakeChatMessage {
  readonly name: string;
  readonly createTime: string;
  readonly sender: { readonly name: string; readonly type: string };
  readonly text?: string;
  readonly thread?: { readonly name: string };
  readonly annotations?: readonly Readonly<Record<string, unknown>>[];
  readonly attachment?: readonly Readonly<Record<string, unknown>>[];
  readonly quotedMessageMetadata?: Readonly<Record<string, unknown>>;
}

export interface FakeChatReaction {
  readonly name: string;
  readonly user: { readonly name: string; readonly type: string };
  readonly emoji: { readonly unicode: string };
}

/** A file the assistant uploaded to a space, as Google received it. */
export interface FakeChatUpload {
  readonly space: string;
  readonly filename: string;
  readonly contentType: string;
  readonly data: Buffer;
  /** The token Google answered with, which a message names to carry the file. */
  readonly token: string;
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export function refusal(failure: ChatFailure): Response {
  return json(failure.status, { error: { code: failure.status, message: failure.message } });
}

export const NOT_FOUND: ChatFailure = { status: 404, message: 'Requested entity was not found.' };
export const UNAUTHENTICATED: ChatFailure = { status: 401, message: 'Request had invalid authentication credentials.' };
const CARDS_NEED_APP: ChatFailure = {
  status: 403,
  message: 'This field mask requires app authentication: cards_v2 can only be updated by a Chat app.',
};
const INVALID_UPLOAD: ChatFailure = { status: 400, message: 'Invalid multipart upload request.' };
const INVALID_ATTACHMENT: ChatFailure = { status: 400, message: 'Invalid attachment upload token.' };

/** The URL Google's clients ask for: they call `fetch(url, init)`, never with a `Request`. */
export function requestUrl(input: string | URL | Request): URL {
  if (input instanceof Request) throw new TypeError('The fake answers fetch(url, init), not a Request');
  return new URL(input);
}

/** A write's JSON body. */
function requestBody(init: RequestInit | undefined): Record<string, unknown> {
  const body: unknown = typeof init?.body === 'string' && init.body !== '' ? JSON.parse(init.body) : {};
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
}

/** A write's bytes, as a client sends binary. */
async function requestBytes(init: RequestInit | undefined): Promise<Buffer | undefined> {
  const body = init?.body;
  if (body instanceof Blob) return Buffer.from(await body.arrayBuffer());
  if (body instanceof Uint8Array) return Buffer.from(body);
  return undefined;
}

/** The parts of a `multipart/related` body, each with its type, in order; undefined when it is not one. */
function multipartParts(
  contentType: string | null,
  body: Buffer | undefined,
): Array<{ type: string; data: Buffer }> | undefined {
  const boundary = /^multipart\/related;\s*boundary=([^;]+)$/iu.exec(contentType ?? '')?.[1];
  if (boundary === undefined || body === undefined) return undefined;
  const delimiter = Buffer.from(`--${boundary}`);
  const parts: Array<{ type: string; data: Buffer }> = [];
  let start = body.indexOf(delimiter);
  while (start !== -1) {
    const next = body.indexOf(delimiter, start + delimiter.length);
    if (next === -1) break;
    // A part runs from the line after its delimiter to the line break before the next one.
    const part = body.subarray(start + delimiter.length + 2, next - 2);
    const split = part.indexOf('\r\n\r\n');
    if (split === -1) return undefined;
    const type = /^content-type:\s*(.+)$/imu.exec(part.subarray(0, split).toString('latin1'))?.[1]?.trim() ?? '';
    parts.push({ type, data: Buffer.from(part.subarray(split + 4)) });
    start = next;
  }
  return start !== -1 && body.subarray(start).toString('latin1').startsWith(`--${boundary}--`) ? parts : undefined;
}

export class FakeChatApi {
  readonly requests: ChatRequest[] = [];
  readonly messages = new Map<string, FakeChatMessage>();
  readonly spaces = new Map<string, { readonly name: string; readonly spaceType: string }>();
  /** Each message's reactions, by the message's name. */
  readonly reactions = new Map<string, FakeChatReaction[]>();
  /** Each person's display name, by their numeric Google ID; a person absent here has no profile the assistant can see. */
  readonly people = new Map<string, string>();
  /** Each attachment's bytes, by its data reference's resource name. */
  readonly media = new Map<string, Buffer>();
  /** Every file the assistant uploaded, in order. */
  readonly uploads: FakeChatUpload[] = [];
  /** A resource, by its path, answers with this failure while it is set. */
  readonly failures = new Map<string, ChatFailure>();
  reactionPageSize = 200;
  /** Numbers what the assistant writes. */
  private written = 0;
  /** Uploads no message has attached yet, by their token. */
  private readonly unattached = new Map<string, FakeChatUpload>();

  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const url = requestUrl(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    const authorization = headers.get('authorization');
    this.requests.push({ method, url, authorization });
    const upload = url.pathname.startsWith('/upload/v1/');
    const path = decodeURIComponent(url.pathname.replace(/^\/(?:upload\/)?v1\//u, ''));
    const failure = this.failures.get(path);
    if (failure) return refusal(failure);
    switch (url.host) {
      case 'chat.googleapis.com':
        if (authorization !== `Bearer ${CHAT_TOKEN}`) return refusal(UNAUTHENTICATED);
        if (upload && method === 'POST') {
          return this.upload(path, url, multipartParts(headers.get('content-type'), await requestBytes(init)));
        }
        if (method === 'POST') return this.write(path, requestBody(init));
        if (method === 'DELETE') return this.remove(path);
        if (method === 'PUT' || method === 'PATCH') return this.update(path, url, requestBody(init));
        return this.chat(path, url);
      case 'people.googleapis.com':
        if (authorization !== `Bearer ${DIRECTORY_TOKEN}`) return refusal(UNAUTHENTICATED);
        return this.person(path, url);
      default:
        throw new TypeError(`fetch failed: no fake for ${url.host}`);
    }
  };

  /** A space the assistant belongs to. */
  addSpace(name: string, spaceType: 'DIRECT_MESSAGE' | 'GROUP_CHAT' | 'SPACE'): void {
    this.spaces.set(name, { name, spaceType });
  }

  /** A message Google holds, as messages.get returns it to the assistant. */
  addMessage(message: FakeChatMessage): FakeChatMessage {
    this.messages.set(message.name, message);
    return message;
  }

  /** A reaction Google holds on a message. */
  addReaction(reaction: FakeChatReaction): FakeChatReaction {
    const message = reaction.name.split('/reactions/')[0]!;
    this.reactions.set(message, [...(this.reactions.get(message) ?? []), reaction]);
    return reaction;
  }

  /** The requests to one API path, such as `spaces/AAAAjuno` or `people/2001`. */
  calls(path: string): ChatRequest[] {
    return this.requests.filter((request) => decodeURIComponent(request.url.pathname) === `/v1/${path}`);
  }

  /** The messages the assistant posted, in order. */
  posted(): FakeChatMessage[] {
    return [...this.messages.values()].filter((message) => message.sender.name === ASSISTANT);
  }

  /** A file uploaded to a space (media.upload): its metadata names it, its media part holds it. */
  private upload(path: string, url: URL, parts: Array<{ type: string; data: Buffer }> | undefined): Response {
    const space = /^(spaces\/[^/]+)\/attachments:upload$/u.exec(path)?.[1];
    if (space === undefined || !this.spaces.has(space)) return refusal(NOT_FOUND);
    if (url.searchParams.get('uploadType') !== 'multipart' || parts?.length !== 2) return refusal(INVALID_UPLOAD);
    const [metadata, media] = parts;
    const filename: unknown = metadata!.type.startsWith('application/json')
      ? (JSON.parse(metadata!.data.toString('utf8')) as Record<string, unknown>).filename
      : undefined;
    if (typeof filename !== 'string' || filename === '' || media!.type === '') return refusal(INVALID_UPLOAD);
    this.written += 1;
    const uploaded: FakeChatUpload = {
      space,
      filename,
      contentType: media!.type,
      data: media!.data,
      token: `upload-token-${this.written}`,
    };
    this.uploads.push(uploaded);
    this.unattached.set(uploaded.token, uploaded);
    return json(200, {
      attachmentDataRef: { resourceName: `uploaded-${this.written}`, attachmentUploadToken: uploaded.token },
    });
  }

  /** A message the assistant posts, or a reaction it places on a message. */
  private write(path: string, body: Record<string, unknown>): Response {
    this.written += 1;
    const reactionsOf = /^(spaces\/[^/]+\/messages\/[^/]+)\/reactions$/u.exec(path)?.[1];
    if (reactionsOf !== undefined) {
      if (!this.messages.has(reactionsOf)) return refusal(NOT_FOUND);
      const emoji = body.emoji as { unicode: string };
      return json(
        200,
        this.addReaction({
          name: `${reactionsOf}/reactions/assistant-${this.written}`,
          user: { name: ASSISTANT, type: 'HUMAN' },
          emoji,
        }),
      );
    }
    const space = /^(spaces\/[^/]+)\/messages$/u.exec(path)?.[1];
    if (space !== undefined && this.spaces.has(space)) {
      const thread = body.thread as { name?: string } | undefined;
      const name = `${space}/messages/morgan.${this.written}`;
      const attachment = this.attach(space, name, body.attachment);
      if (attachment === undefined) return refusal(INVALID_ATTACHMENT);
      return json(
        200,
        this.addMessage({
          name,
          createTime: '2026-10-10T17:00:05.000000Z',
          sender: { name: ASSISTANT, type: 'HUMAN' },
          text: typeof body.text === 'string' ? body.text : '',
          thread: { name: thread?.name ?? `${space}/threads/morgan` },
          ...(attachment.length === 0 ? {} : { attachment }),
        }),
      );
    }
    return refusal(NOT_FOUND);
  }

  /** The attachments a new message carries, as Google returns them; undefined when one names no upload to its space. */
  private attach(space: string, message: string, requested: unknown): Array<Record<string, unknown>> | undefined {
    if (requested === undefined) return [];
    if (!Array.isArray(requested)) return undefined;
    const uploads = requested.map((entry: unknown) => {
      const ref =
        typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>).attachmentDataRef : undefined;
      const token =
        typeof ref === 'object' && ref !== null ? (ref as Record<string, unknown>).attachmentUploadToken : undefined;
      const uploaded = typeof token === 'string' ? this.unattached.get(token) : undefined;
      return uploaded?.space === space ? uploaded : undefined;
    });
    if (uploads.some((uploaded) => uploaded === undefined)) return undefined;
    return uploads.map((uploaded, index) => {
      this.unattached.delete(uploaded!.token);
      return {
        name: `${message}/attachments/${index + 1}`,
        contentName: uploaded!.filename,
        contentType: uploaded!.contentType,
        attachmentDataRef: { resourceName: `uploaded-${uploaded!.token}` },
        source: 'UPLOADED_CONTENT',
      };
    });
  }

  /** Edit a message the assistant posted; only its text can change. */
  private update(path: string, url: URL, body: Record<string, unknown>): Response {
    const message = this.messages.get(path);
    if (!message) return refusal(NOT_FOUND);
    const mask = (url.searchParams.get('updateMask') ?? '').split(',').map((field) => field.trim());
    if (mask.some((field) => field.toLowerCase().startsWith('cards'))) return refusal(CARDS_NEED_APP);
    if (!mask.includes('text') || typeof body.text !== 'string') return refusal(NOT_FOUND);
    return json(200, this.addMessage({ ...message, text: body.text }));
  }

  /** Delete a reaction, by its name. */
  private remove(path: string): Response {
    const message = /^(spaces\/[^/]+\/messages\/[^/]+)\/reactions\/[^/]+$/u.exec(path)?.[1];
    const held = message === undefined ? [] : (this.reactions.get(message) ?? []);
    if (message === undefined || !held.some((reaction) => reaction.name === path)) return refusal(NOT_FOUND);
    this.reactions.set(
      message,
      held.filter((reaction) => reaction.name !== path),
    );
    return json(200, {});
  }

  private chat(path: string, url: URL): Response {
    if (path.startsWith('media/')) {
      const bytes = this.media.get(path.slice('media/'.length));
      if (!bytes || url.searchParams.get('alt') !== 'media') return refusal(NOT_FOUND);
      return new Response(bytes, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
    }
    if (path.endsWith('/reactions')) {
      const message = path.slice(0, -'/reactions'.length);
      if (!this.messages.has(message)) return refusal(NOT_FOUND);
      const all = this.reactions.get(message) ?? [];
      const start = Number(url.searchParams.get('pageToken') ?? '0');
      const page = all.slice(start, start + this.reactionPageSize);
      const next = start + page.length;
      return json(200, {
        ...(page.length === 0 ? {} : { reactions: page }),
        ...(next < all.length ? { nextPageToken: String(next) } : {}),
      });
    }
    if (/^spaces\/[^/]+\/messages\/[^/]+$/u.test(path)) {
      const message = this.messages.get(path);
      return message ? json(200, message) : refusal(NOT_FOUND);
    }
    if (/^spaces\/[^/]+$/u.test(path)) {
      const space = this.spaces.get(path);
      return space ? json(200, space) : refusal(NOT_FOUND);
    }
    return refusal(NOT_FOUND);
  }

  private person(path: string, url: URL): Response {
    const id = /^people\/(\d+)$/u.exec(path)?.[1];
    if (id === undefined || url.searchParams.get('personFields') !== 'names') return refusal(NOT_FOUND);
    const displayName = this.people.get(id);
    if (displayName === undefined) return refusal(NOT_FOUND);
    return json(200, {
      resourceName: `people/${id}`,
      names: [
        { displayName: `${displayName} (old)`, metadata: { primary: false, source: { type: 'CONTACT' } } },
        { displayName, metadata: { primary: true, source: { type: 'DOMAIN_PROFILE' } } },
      ],
    });
  }
}

/** A message from a person, as the assistant reads it. */
export function chatMessage(
  space: string,
  id: string,
  fields: Partial<Omit<FakeChatMessage, 'name'>> & { readonly from?: string } = {},
): FakeChatMessage {
  const { from, ...rest } = fields;
  return {
    createTime: '2026-10-10T17:00:00.000000Z',
    sender: { name: from ?? 'users/2001', type: 'HUMAN' },
    text: 'Can you move Thursday?',
    thread: { name: `${space}/threads/${id.split('.')[0]}` },
    ...rest,
    name: `${space}/messages/${id}`,
  };
}

/** The annotation Chat places on a mention of `user` at `startIndex`, spanning `length` characters. */
export function mentionOf(user: string, startIndex: number, length: number, type = 'HUMAN') {
  return { type: 'USER_MENTION', startIndex, length, userMention: { user: { name: user, type }, type: 'MENTION' } };
}
