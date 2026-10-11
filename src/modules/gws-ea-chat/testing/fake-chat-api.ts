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
 * - Chat answers only the assistant's Chat token and People only its
 *   directory token; anything else is 401.
 *
 * Every request is recorded. A test makes a resource fail (`failures`, keyed
 * by its path, such as `spaces/AAAAjuno/messages/remy.1`) until it clears it.
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

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function refusal(failure: ChatFailure): Response {
  return json(failure.status, { error: { code: failure.status, message: failure.message } });
}

const NOT_FOUND: ChatFailure = { status: 404, message: 'Requested entity was not found.' };
const UNAUTHENTICATED: ChatFailure = { status: 401, message: 'Request had invalid authentication credentials.' };

function requestUrl(input: string | URL | Request): URL {
  if (input instanceof URL) return input;
  return new URL(typeof input === 'string' ? input : input.url);
}

/** A write's JSON body, as `fetch` was handed it. */
async function requestBody(
  input: string | URL | Request,
  init: RequestInit | undefined,
): Promise<Record<string, unknown>> {
  const text = typeof init?.body === 'string' ? init.body : input instanceof Request ? await input.text() : '';
  const body: unknown = text === '' ? {} : JSON.parse(text);
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
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
  /** A resource, by its path, answers with this failure while it is set. */
  readonly failures = new Map<string, ChatFailure>();
  reactionPageSize = 200;
  /** Numbers what the assistant writes. */
  private written = 0;

  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const url = requestUrl(input);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const authorization = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get(
      'authorization',
    );
    this.requests.push({ method, url, authorization });
    const path = decodeURIComponent(url.pathname.replace(/^\/v1\//u, ''));
    const failure = this.failures.get(path);
    if (failure) return refusal(failure);
    switch (url.host) {
      case 'chat.googleapis.com':
        if (authorization !== `Bearer ${CHAT_TOKEN}`) return refusal(UNAUTHENTICATED);
        if (method === 'POST') return this.write(path, await requestBody(input, init));
        if (method === 'DELETE') return this.remove(path);
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
      return json(
        200,
        this.addMessage({
          name: `${space}/messages/morgan.${this.written}`,
          createTime: '2026-10-10T17:00:05.000000Z',
          sender: { name: ASSISTANT, type: 'HUMAN' },
          text: typeof body.text === 'string' ? body.text : '',
          thread: { name: thread?.name ?? `${space}/threads/morgan` },
        }),
      );
    }
    return refusal(NOT_FOUND);
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
