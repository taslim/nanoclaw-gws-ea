/**
 * Reading Chat's events (KTD1, KTD2). The subscription is name-only, so each
 * event carries only resource names; the host reads what they name as the
 * assistant, over Chat's REST API: the message, or the reaction among its
 * message's reactions, and the space the message is in. A batch event is
 * read as its parts.
 *
 * Under user authentication Chat names a person only by resource name and
 * type, so people's display names come from the People API with the host's
 * directory token. Spaces and names are kept an hour: a space's type does
 * not change, and a renamed person reaches the agent within the hour.
 *
 * A message, space, or reaction Google no longer has, or no longer lets the
 * assistant read (404, 403), is gone: it reads as undefined, and its event is
 * acknowledged. Any other failure is thrown, so Pub/Sub delivers the event
 * again.
 */
import type { GoogleChatMessage } from '@chat-adapter/gchat';

import { log } from '../../log.js';
import { isRecord } from '../../gws-ea/validation.js';
import { GoogleApiError, googleJson, type GoogleClientOptions } from '../gws-ea-inbox/gmail-api.js';
import type { WorkspaceEvent } from './pubsub-pull.js';
import { CHAT_MESSAGE_CREATED, CHAT_REACTION_CREATED } from './subscription.js';

/** Several messages Google publishes as one event; the subscription receives them without asking. */
export const CHAT_MESSAGE_BATCH_CREATED = 'google.workspace.chat.message.v1.batchCreated';
/** Several reactions Google publishes as one event. */
export const CHAT_REACTION_BATCH_CREATED = 'google.workspace.chat.reaction.v1.batchCreated';
/** A one-to-one conversation's space type. */
export const DIRECT_MESSAGE = 'DIRECT_MESSAGE';

const CHAT = 'https://chat.googleapis.com/v1';
const PEOPLE = 'https://people.googleapis.com/v1';
/** How long a space's type and a person's name are kept. */
const KEEP_MS = 60 * 60_000;
/** The most reactions Chat lists in one page. */
const REACTION_PAGE_SIZE = 200;

/** One message or reaction an event names. */
export interface ChatEventPart {
  readonly kind: 'message' | 'reaction';
  readonly name: string;
}

/** A space's name and its type: `DIRECT_MESSAGE`, `GROUP_CHAT`, or `SPACE`. */
export interface ChatSpace {
  readonly name: string;
  readonly type: string;
}

/** The message a Chat message quotes, as Google describes it. */
export interface QuotedMessageMetadata {
  readonly name: string;
  readonly quoteType?: string;
  readonly quotedMessageSnapshot?: { readonly sender?: string; readonly text?: string };
}

/** A message as the assistant reads it: the SDK's shape, with the message it quotes. */
export interface ChatMessage extends GoogleChatMessage {
  quotedMessageMetadata?: QuotedMessageMetadata;
}

/** A reaction as the assistant reads it, its emoji as Chat shows it. */
export interface ChatReaction {
  readonly name: string;
  readonly user: { readonly name: string; readonly type: string };
  readonly emoji: string;
}

export interface ChatHydrator {
  /** The message; undefined when it is gone. */
  message(name: string): Promise<ChatMessage | undefined>;
  /** The space; undefined when it is gone. */
  space(name: string): Promise<ChatSpace | undefined>;
  /** The reaction, found among its message's; undefined when it or its message is gone. */
  reaction(name: string): Promise<ChatReaction | undefined>;
  /** The person's display name; their user id when the assistant can see no profile for them. */
  displayName(userId: string): Promise<string>;
}

export interface ChatHydratorOptions {
  /** The assistant's Chat token. */
  readonly chatToken: () => Promise<string>;
  /** The host's directory token, for people's names. */
  readonly directoryToken: () => Promise<string>;
  readonly fetch?: typeof globalThis.fetch;
}

/** The space a message is in: `spaces/{space}` of `spaces/{space}/messages/{message}`. */
export function spaceOfMessage(name: string): string | undefined {
  return /^(spaces\/[^/]+)\/messages\/[^/]+$/u.exec(name)?.[1];
}

/** The message a reaction is on: `spaces/{space}/messages/{message}` of its reaction's name. */
export function messageOfReaction(name: string): string | undefined {
  return /^(spaces\/[^/]+\/messages\/[^/]+)\/reactions\/[^/]+$/u.exec(name)?.[1];
}

function named(kind: ChatEventPart['kind'], value: unknown): ChatEventPart[] {
  return isRecord(value) && typeof value.name === 'string' ? [{ kind, name: value.name }] : [];
}

function batch(kind: ChatEventPart['kind'], entries: unknown): ChatEventPart[] {
  return Array.isArray(entries)
    ? entries.flatMap((entry) => named(kind, isRecord(entry) ? entry[kind] : undefined))
    : [];
}

/** The messages and reactions an event names, in Google's order; none for an event the channel does not handle. */
export function chatEventParts(event: WorkspaceEvent): ChatEventPart[] {
  switch (event.type) {
    case CHAT_MESSAGE_CREATED:
      return named('message', event.data.message);
    case CHAT_MESSAGE_BATCH_CREATED:
      return batch('message', event.data.messages);
    case CHAT_REACTION_CREATED:
      return named('reaction', event.data.reaction);
    case CHAT_REACTION_BATCH_CREATED:
      return batch('reaction', event.data.reactions);
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Response shapes: the fields the SDK and the channel read are checked;
// anything else is left out.
// ---------------------------------------------------------------------------

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function toAnnotation(value: Record<string, unknown>): NonNullable<GoogleChatMessage['annotations']>[number] {
  const startIndex = count(value.startIndex);
  const length = count(value.length);
  const mention = isRecord(value.userMention) ? value.userMention : undefined;
  const user = isRecord(mention?.user) ? mention.user : undefined;
  const userName = text(user?.name);
  return {
    type: text(value.type) ?? '',
    ...(startIndex === undefined ? {} : { startIndex }),
    ...(length === undefined ? {} : { length }),
    ...(userName === undefined
      ? {}
      : { userMention: { user: { name: userName, type: text(user?.type) ?? '' }, type: text(mention?.type) ?? '' } }),
  };
}

function toAttachment(value: Record<string, unknown>): NonNullable<GoogleChatMessage['attachment']>[number] {
  const downloadUri = text(value.downloadUri);
  const resourceName = isRecord(value.attachmentDataRef) ? text(value.attachmentDataRef.resourceName) : undefined;
  return {
    name: text(value.name) ?? '',
    contentName: text(value.contentName) ?? '',
    contentType: text(value.contentType) ?? '',
    ...(downloadUri === undefined ? {} : { downloadUri }),
    ...(resourceName === undefined ? {} : { attachmentDataRef: { resourceName } }),
  };
}

function toQuote(value: unknown): QuotedMessageMetadata | undefined {
  if (!isRecord(value) || typeof value.name !== 'string') return undefined;
  const quoteType = text(value.quoteType);
  const snapshot = isRecord(value.quotedMessageSnapshot) ? value.quotedMessageSnapshot : undefined;
  const sender = text(snapshot?.sender);
  const quoted = text(snapshot?.text);
  return {
    name: value.name,
    ...(quoteType === undefined ? {} : { quoteType }),
    ...(snapshot === undefined
      ? {}
      : {
          quotedMessageSnapshot: {
            ...(sender === undefined ? {} : { sender }),
            ...(quoted === undefined ? {} : { text: quoted }),
          },
        }),
  };
}

/** A message, or undefined when Google returned one without what every message has. */
function toMessage(value: unknown): ChatMessage | undefined {
  if (!isRecord(value) || typeof value.name !== 'string' || typeof value.createTime !== 'string') return undefined;
  const sender = isRecord(value.sender) ? value.sender : undefined;
  if (typeof sender?.name !== 'string') return undefined;
  const thread = isRecord(value.thread) ? text(value.thread.name) : undefined;
  const annotations = records(value.annotations).map(toAnnotation);
  const attachments = records(value.attachment).map(toAttachment);
  const quote = toQuote(value.quotedMessageMetadata);
  return {
    name: value.name,
    createTime: value.createTime,
    // Under user authentication Chat gives no display name; the channel names the sender.
    sender: { name: sender.name, type: text(sender.type) ?? '', displayName: '' },
    text: text(value.text) ?? '',
    ...(thread === undefined ? {} : { thread: { name: thread } }),
    ...(annotations.length === 0 ? {} : { annotations }),
    ...(attachments.length === 0 ? {} : { attachment: attachments }),
    ...(quote === undefined ? {} : { quotedMessageMetadata: quote }),
  };
}

/** Older answers name a DM's type `DM` and a named space's `ROOM`, without a space type. */
const LEGACY_SPACE_TYPES: Readonly<Record<string, string>> = { DM: DIRECT_MESSAGE, ROOM: 'SPACE' };

function toSpace(value: unknown): ChatSpace | undefined {
  if (!isRecord(value) || typeof value.name !== 'string') return undefined;
  const type = text(value.spaceType) ?? LEGACY_SPACE_TYPES[text(value.type) ?? ''];
  return type === undefined ? undefined : { name: value.name, type };
}

function toReaction(value: Record<string, unknown>): ChatReaction | undefined {
  const user = isRecord(value.user) ? value.user : undefined;
  if (typeof value.name !== 'string' || typeof user?.name !== 'string') return undefined;
  const emoji = isRecord(value.emoji) ? value.emoji : undefined;
  const custom = isRecord(emoji?.customEmoji) ? emoji.customEmoji : undefined;
  return {
    name: value.name,
    user: { name: user.name, type: text(user.type) ?? '' },
    emoji: text(emoji?.unicode) ?? text(custom?.emojiName) ?? '',
  };
}

/** A person's primary name, else their first. */
function personName(value: unknown): string | undefined {
  const names = isRecord(value) ? records(value.names) : [];
  const primary = names.find((entry) => isRecord(entry.metadata) && entry.metadata.primary === true);
  return [primary, ...names].map((entry) => text(entry?.displayName)?.trim()).find((name) => !!name);
}

/** Undefined for a resource that is gone: Google has no such thing, or no longer lets the assistant read it. */
async function unlessGone(read: () => Promise<unknown>): Promise<unknown> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof GoogleApiError && (error.status === 403 || error.status === 404)) return undefined;
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface Kept<T> {
  readonly value: T;
  readonly until: number;
}

function kept<T>(store: Map<string, Kept<T>>, key: string): T | undefined {
  const entry = store.get(key);
  return entry !== undefined && entry.until > Date.now() ? entry.value : undefined;
}

export function createChatHydrator(options: ChatHydratorOptions): ChatHydrator {
  const fetch = options.fetch === undefined ? {} : { fetch: options.fetch };
  const chat: GoogleClientOptions = { token: options.chatToken, ...fetch };
  const directory: GoogleClientOptions = { token: options.directoryToken, ...fetch };
  const spaces = new Map<string, Kept<ChatSpace>>();
  const names = new Map<string, Kept<string>>();

  return {
    async message(name) {
      const payload = await unlessGone(() => googleJson(chat, `${CHAT}/${name}`));
      if (payload === undefined) return undefined;
      const message = toMessage(payload);
      if (message === undefined) log.warn('Chat returned a message the assistant cannot read', { name });
      return message;
    },

    async space(name) {
      const known = kept(spaces, name);
      if (known !== undefined) return known;
      const payload = await unlessGone(() => googleJson(chat, `${CHAT}/${name}`));
      if (payload === undefined) return undefined;
      const space = toSpace(payload);
      if (space === undefined) {
        log.warn('Chat returned a space the assistant cannot read', { name });
        return undefined;
      }
      spaces.set(name, { value: space, until: Date.now() + KEEP_MS });
      return space;
    },

    async reaction(name) {
      const message = messageOfReaction(name);
      if (message === undefined) return undefined;
      let pageToken: string | undefined;
      do {
        const query = new URLSearchParams({ pageSize: String(REACTION_PAGE_SIZE) });
        if (pageToken !== undefined) query.set('pageToken', pageToken);
        const page = await unlessGone(() => googleJson(chat, `${CHAT}/${message}/reactions?${query.toString()}`));
        if (!isRecord(page)) return undefined;
        const found = records(page.reactions).find((reaction) => reaction.name === name);
        if (found !== undefined) return toReaction(found);
        pageToken = text(page.nextPageToken) || undefined;
      } while (pageToken !== undefined);
      // Removed before the host read it.
      return undefined;
    },

    async displayName(userId) {
      const known = kept(names, userId);
      if (known !== undefined) return known;
      const id = /^users\/(\d+)$/u.exec(userId)?.[1];
      if (id === undefined) return userId;
      let payload: unknown;
      try {
        payload = await unlessGone(() => googleJson(directory, `${PEOPLE}/people/${id}?personFields=names`));
        /* eslint-disable-next-line no-catch-all/no-catch-all -- a name is never worth losing the message: the agent gets the user id, and the next message asks again */
      } catch (error) {
        log.warn("Could not read a Chat user's name from the People API", { userId, err: errorMessage(error) });
        return userId;
      }
      const name = personName(payload) ?? userId;
      names.set(userId, { value: name, until: Date.now() + KEEP_MS });
      return name;
    },
  };
}
