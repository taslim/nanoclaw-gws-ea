/**
 * Native GChat inbound: Pub/Sub stream → fetch body → classify → onInbound.
 *
 * Replaces the chat-sdk's per-space subscription + webhook dispatch path.
 * The wildcard Workspace Events subscription delivers metadata-only events
 * (`{ message: { name } }`); we fetch the full message via
 * `chat.spaces.messages.get` (with the impersonated client so we read what
 * the user can read), classify the resulting message, and call
 * `setupConfig.onInbound` directly.
 *
 * The bridge's `onInbound` shape is preserved bit-for-bit with the chat-sdk
 * path's output (kind: 'chat-sdk', flat senderId/sender/senderName, etc.) so
 * the router and downstream consumers don't need to change.
 */
import { PubSub, type Message as PubSubMessage } from '@google-cloud/pubsub';
import { type chat_v1 } from 'googleapis';

import type { ChannelSetup, InboundMessage } from '../../channels/adapter.js';
import { ASSISTANT_NAME } from '../../config.js';
import { isDmSpace } from '../../gws-paths.js';
import { log } from '../../log.js';
import { getUser, upsertUser } from '../permissions/db/users.js';

const CHAT_MESSAGE_CREATED = 'google.workspace.chat.message.v1.created';

interface StartArgs {
  projectId: string;
  saCredentials: { client_email: string; private_key: string };
  topicShort: string;
  selfUserId: () => Promise<string | null>;
  chat: chat_v1.Chat;
  spaceCache: SpaceCache;
  memberCache: MemberCache;
  onInbound: ChannelSetup['onInbound'];
}

export interface InboundHandle {
  stop(): Promise<void>;
}

export async function startInboundStream(args: StartArgs): Promise<InboundHandle> {
  const pubsub = new PubSub({ projectId: args.projectId, credentials: args.saCredentials });
  const subscriptionName = `${args.topicShort}-sub`;
  const subscription = pubsub.subscription(subscriptionName, { flowControl: { maxMessages: 10 } });
  const subscriptionPath = `projects/${args.projectId}/subscriptions/${subscriptionName}`;

  subscription.on('message', (msg: PubSubMessage) => {
    handleMessage(msg, args)
      .then(() => msg.ack())
      .catch((err) => {
        log.error('GChat: inbound handler error', { messageId: msg.id, err });
        msg.nack();
      });
  });

  subscription.on('error', (err) => {
    log.error('GChat: subscription error', { err });
  });

  subscription.on('close', () => {
    log.warn('GChat: Pub/Sub subscription closed (StreamingPull will reconnect)');
  });

  log.info('GChat: native inbound stream started', { subscription: subscriptionPath });

  return {
    async stop() {
      subscription.removeAllListeners();
      await subscription.close();
      await pubsub.close();
      log.info('GChat: native inbound stream stopped');
    },
  };
}

async function handleMessage(msg: PubSubMessage, args: StartArgs): Promise<void> {
  const eventType = msg.attributes['ce-type'] || '';
  if (eventType !== CHAT_MESSAGE_CREATED) return;

  let resourceName: string | undefined;
  try {
    const data = JSON.parse(msg.data.toString('utf-8')) as { message?: { name?: string } };
    resourceName = data.message?.name;
  } catch {
    log.warn('GChat: failed to parse Pub/Sub data', { messageId: msg.id });
    return;
  }
  if (!resourceName) {
    log.warn('GChat: event missing message resource name', { messageId: msg.id });
    return;
  }

  const spaceName = resourceName.split('/').slice(0, 2).join('/');
  const channelId = `gchat:${spaceName}`;

  const [fetched, spaceMeta] = await Promise.all([
    args.chat.spaces.messages.get({ name: resourceName }),
    args.spaceCache.get(spaceName, args.chat),
  ]);
  const message = fetched.data;
  if (!message?.name) return;

  const senderUserId = message.sender?.name ?? '';
  const selfId = await args.selfUserId();
  if (selfId && senderUserId === selfId) {
    log.debug('GChat: dropping self-authored inbound', { messageId: message.name, senderUserId });
    return;
  }

  const isMention = detectMention(message, selfId);
  const inbound = await buildInbound(
    message,
    args.chat,
    args.memberCache,
    spaceName,
    selfId,
    isMention,
    !spaceMeta.isDM,
  );
  await args.onInbound(channelId, message.thread?.name ?? null, inbound);
}

/**
 * Quote-reply to the assistant counts as engagement. The QuotedMessageSnapshot
 * carries only a display name (no userId), so we match `ASSISTANT_NAME`
 * first-word — "Andy Smith" matches "Andy".
 */
function detectMention(message: chat_v1.Schema$Message, selfId: string | null): boolean {
  const annotations = message.annotations ?? [];
  if (selfId) {
    for (const ann of annotations) {
      if (ann.type !== 'USER_MENTION') continue;
      if (ann.userMention?.user?.name === selfId) return true;
    }
  }
  const quotedSender = message.quotedMessageMetadata?.quotedMessageSnapshot?.sender;
  if (quotedSender) {
    const first = quotedSender.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
    if (first === ASSISTANT_NAME.toLowerCase()) return true;
  }
  return false;
}

async function fetchQuotedMessage(
  chat: chat_v1.Chat,
  name: string,
): Promise<{ senderId: string; apiDisplayName: string; text?: string } | null> {
  try {
    const fetched = await chat.spaces.messages.get({ name });
    return {
      senderId: fetched.data.sender?.name ?? '',
      apiDisplayName: fetched.data.sender?.displayName ?? '',
      text: fetched.data.text ?? undefined,
    };
  } catch (err) {
    log.debug('GChat: failed to fetch quoted message for snapshot fallback', {
      quotedName: name,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * The GChat API often returns empty `displayName` even for known senders, so
 * we waterfall through cached state. Empty string is the final fallback —
 * the formatter renders it as "Unknown".
 */
async function resolveSenderName(
  senderId: string,
  apiDisplayName: string,
  spaceName: string,
  chat: chat_v1.Chat,
  memberCache: MemberCache,
): Promise<string> {
  if (apiDisplayName) return apiDisplayName;
  if (!senderId) return '';
  const cached = getUser(`gchat:${senderId}`)?.display_name;
  if (cached) return cached;
  const fromMembers = await memberCache.resolve(spaceName, senderId, chat);
  if (!fromMembers) return '';
  upsertUser({
    id: `gchat:${senderId}`,
    kind: 'gchat',
    display_name: fromMembers,
    created_at: new Date().toISOString(),
  });
  return fromMembers;
}

// GChat returns `<url|display>` for links and `<mailto:addr|display>` for
// emails when reading back its own rendered text (e.g. quotedMessageSnapshot).
// Unwrap to the display text so the agent doesn't see the raw token.
const GCHAT_LINK_TOKEN = /<(?:mailto:|tel:|https?:\/\/)[^|>]+\|([^>]+)>/g;
function unwrapGchatTokens(text: string): string {
  return text.replace(GCHAT_LINK_TOKEN, '$1');
}

/**
 * Rewrite the assistant's @mention to `@<ASSISTANT_NAME>` so engage-pattern
 * rules see a stable trigger regardless of the bot's display name. Replaces
 * right-to-left so earlier annotation indices stay valid.
 */
function normalizeAssistantMentions(message: chat_v1.Schema$Message, selfId: string | null): string {
  let text = message.text ?? '';
  if (!selfId) return text;
  const replacements: Array<{ start: number; length: number }> = [];
  for (const ann of message.annotations ?? []) {
    if (ann.type !== 'USER_MENTION') continue;
    if (ann.userMention?.user?.name !== selfId) continue;
    if (ann.startIndex == null || ann.length == null) continue;
    replacements.push({ start: ann.startIndex, length: ann.length });
  }
  if (replacements.length === 0) return text;
  replacements.sort((a, b) => b.start - a.start);
  const target = `@${ASSISTANT_NAME}`;
  for (const r of replacements) {
    text = text.slice(0, r.start) + target + text.slice(r.start + r.length);
  }
  return text;
}

async function buildInbound(
  message: chat_v1.Schema$Message,
  chat: chat_v1.Chat,
  memberCache: MemberCache,
  spaceName: string,
  selfId: string | null,
  isMention: boolean,
  isGroup: boolean,
): Promise<InboundMessage> {
  const senderId = message.sender?.name ?? '';
  const meta = message.quotedMessageMetadata;
  const snapshot = meta?.quotedMessageSnapshot;
  const needsQuoteFallback = meta?.name != null && (!snapshot?.text || !snapshot?.sender);

  const [senderName, attachments, quotedFallback] = await Promise.all([
    resolveSenderName(senderId, message.sender?.displayName ?? '', spaceName, chat, memberCache),
    collectAttachments(message, chat),
    needsQuoteFallback ? fetchQuotedMessage(chat, meta!.name!) : Promise.resolve(null),
  ]);

  const content: Record<string, unknown> = {
    senderId,
    sender: senderName,
    senderName,
    text: unwrapGchatTokens(normalizeAssistantMentions(message, selfId)),
  };
  if (attachments.length > 0) content.attachments = attachments;

  if (meta?.name) {
    const replyTo: Record<string, string> = { id: meta.name };
    let sender = snapshot?.sender;
    if (!sender && quotedFallback) {
      sender = await resolveSenderName(
        quotedFallback.senderId,
        quotedFallback.apiDisplayName,
        spaceName,
        chat,
        memberCache,
      );
    }
    const text = snapshot?.text ?? quotedFallback?.text;
    if (sender) replyTo.sender = sender;
    if (text) replyTo.text = unwrapGchatTokens(text);
    content.replyTo = replyTo;
  }

  return {
    id: message.name ?? '',
    kind: 'chat-sdk',
    content,
    timestamp: message.createTime ?? new Date().toISOString(),
    isMention,
    isGroup,
  };
}

async function collectAttachments(
  message: chat_v1.Schema$Message,
  chat: chat_v1.Chat,
): Promise<Array<{ type: string; name: string; mimeType: string; size: number; data?: string }>> {
  const raw = (message.attachment ?? []) as Array<chat_v1.Schema$Attachment>;
  return Promise.all(
    raw.map(async (att) => {
      const filename = att.contentName ?? att.name ?? 'attachment';
      const mimeType = att.contentType ?? 'application/octet-stream';
      const dataRef = (att.attachmentDataRef as { resourceName?: string } | undefined)?.resourceName;
      if (!dataRef) {
        return { type: 'file', name: filename, mimeType, size: 0 };
      }
      try {
        const downloaded = await chat.media.download(
          { resourceName: dataRef, alt: 'media' },
          { responseType: 'arraybuffer' },
        );
        const buf = Buffer.from(downloaded.data as ArrayBuffer);
        return { type: 'file', name: filename, mimeType, size: buf.byteLength, data: buf.toString('base64') };
      } catch (err) {
        log.warn('GChat: failed to download attachment', {
          name: filename,
          err: err instanceof Error ? err.message : String(err),
        });
        return { type: 'file', name: filename, mimeType, size: 0 };
      }
    }),
  );
}

interface SpaceMeta {
  isDM: boolean;
  displayName: string;
}

export interface SpaceCache {
  get(spaceName: string, chat: chat_v1.Chat): Promise<SpaceMeta>;
  invalidate(spaceName: string): void;
}

export interface MemberCache {
  /** Returns the displayName for a given userId in a space, or null if not a member. */
  resolve(spaceName: string, userId: string, chat: chat_v1.Chat): Promise<string | null>;
  invalidate(spaceName: string): void;
}

// Lazy member-list cache. We only fetch on miss (someone messaged us whose
// displayName we don't know), and we cache the entire space's roster. TTL is
// generous — membership changes don't invalidate sender resolution since the
// userId+name pair is stable.
export function createMemberCache(ttlMs: number = 60 * 60 * 1000): MemberCache {
  const cache = new Map<string, { members: Map<string, string>; expiresAt: number }>();
  return {
    async resolve(spaceName, userId, chat) {
      let entry = cache.get(spaceName);
      if (!entry || entry.expiresAt <= Date.now()) {
        const members = new Map<string, string>();
        try {
          let pageToken: string | undefined;
          do {
            const res = await chat.spaces.members.list({ parent: spaceName, pageSize: 100, pageToken });
            for (const m of res.data.memberships ?? []) {
              const id = m.member?.name;
              const name = m.member?.displayName;
              if (id && name) members.set(id, name);
            }
            pageToken = res.data.nextPageToken ?? undefined;
          } while (pageToken);
        } catch (err) {
          log.warn('GChat: members.list failed', {
            spaceName,
            err: err instanceof Error ? err.message : String(err),
          });
        }
        entry = { members, expiresAt: Date.now() + ttlMs };
        cache.set(spaceName, entry);
      }
      return entry.members.get(userId) ?? null;
    },
    invalidate(spaceName) {
      cache.delete(spaceName);
    },
  };
}

// spaceType / displayName don't change for a space's lifetime, but cap the
// TTL so a renamed space picks up its new display within an hour.
export function createSpaceCache(ttlMs: number = 60 * 60 * 1000): SpaceCache {
  const cache = new Map<string, { meta: SpaceMeta; expiresAt: number }>();
  return {
    async get(spaceName, chat) {
      const cached = cache.get(spaceName);
      if (cached && cached.expiresAt > Date.now()) return cached.meta;
      const res = await chat.spaces.get({ name: spaceName });
      const meta: SpaceMeta = {
        isDM: isDmSpace(res.data),
        displayName: res.data.displayName ?? '',
      };
      cache.set(spaceName, { meta, expiresAt: Date.now() + ttlMs });
      return meta;
    },
    invalidate(spaceName) {
      cache.delete(spaceName);
    },
  };
}
