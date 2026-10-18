/**
 * The assistant's Google Chat channel (KTD1, KTD4): upstream's Chat SDK
 * adapter, signed in as the assistant's own Workspace account, with only how
 * its events arrive replaced. Everything the assistant sends, edits, or reacts with still goes
 * through upstream's adapter and its message model, but for a message with
 * files on it, which the SDK drops (below).
 *
 * Chat's events are pulled from Pub/Sub (delivery.ts), never pushed, so the
 * adapter declares itself polling, the bridge registers no webhook route for
 * it, and it refuses any webhook request. Each pulled event is read as the
 * assistant (hydrate.ts) and dispatched through the SDK as its webhook path
 * dispatches a message, with the DM and thread taken from the space's type.
 * The event's handler resolves only once every part is routed or found
 * gone, so the consumer acknowledges nothing before it is handled.
 *
 * While a turn works on a message past a few seconds, the assistant shows 👀
 * on it (R6, KTD7), placed and removed by the name Chat gives it, never by
 * emoji: the SDK's own removal takes the first matching emoji, whoever placed
 * it. Each 👀 placed is recorded in the bridge's state store until it is
 * removed, so one left by a crash is removed when the channel next starts.
 *
 * Protected SDK methods this overrides, pinned by the SDK version and named
 * in the divergence guard: `handlePubSubMessageEvent` and
 * `normalizeBotMentions`. It also overrides `editMessage`: the SDK's text edit
 * names `cards_v2` in its update mask, which Google lets only a Chat app
 * update, so an edit made as the assistant updates the text alone.
 *
 * The SDK's post drops files, so the channel posts a message with files on
 * it itself, such as an approval request with its pictures (KTD6): each file
 * uploaded to the conversation, then one message with the text and every
 * upload.
 */
import { randomUUID } from 'node:crypto';

import { GoogleChatAdapter, type GoogleChatMessage, type WorkspaceEventNotification } from '@chat-adapter/gchat';
import {
  convertEmojiPlaceholders,
  defaultEmojiResolver,
  type AdapterPostableMessage,
  type ChatInstance,
  type Message,
  type RawMessage,
  type ReactionEvent,
} from 'chat';
import { OAuth2Client } from 'google-auth-library';

import type { ChannelAdapter, ChannelDefaults, OutboundFile } from '../../channels/adapter.js';
import type { AudioSource } from '../../channels/inbound-content.js';
import {
  createChatSdkBridge,
  FilesNotAttachedError,
  type FileAttacher,
  type ReactionSource,
  type ReplyContext,
  type WorkingIndicator,
} from '../../channels/chat-sdk-bridge.js';
import { isRecord } from '../../gws-ea/validation.js';
import { log } from '../../log.js';
import { GoogleApiError, googleJson, type GoogleClientOptions } from '../gws-ea-inbox/gmail-api.js';
import { RENEW_BEFORE_EXPIRY_MS } from '../gws-ea-google/tokens.js';
import type { ChatDelivery } from './delivery.js';
import {
  chatEventParts,
  DIRECT_MESSAGE,
  messageOfReaction,
  spaceOfMessage,
  type ChatHydrator,
  type ChatMessage,
  type ChatReaction,
  type ChatSpace,
} from './hydrate.js';
import type { WorkspaceEvent } from './pubsub-pull.js';
import { CHAT_MESSAGE_CREATED } from './subscription.js';

/**
 * A reaction someone placed on a message in one of the assistant's
 * conversations, read from Chat. The SDK's own reaction dispatch is
 * fire-and-forget and swallows errors, so reactions reach the channel through
 * an awaited handler instead.
 */
export interface ChatReactionEvent extends Omit<ReactionEvent, 'thread' | 'message' | 'raw'> {
  /** The reaction's resource name, the same on every delivery. */
  readonly reactionName: string;
  /** The message reacted to, read as an inbound message is: its author's `isMe` marks the assistant's own. */
  readonly message: Message;
  /** When it was placed: its event's time, as Google records it. */
  readonly reactedAt: Date;
  readonly raw: ChatReaction;
}

/** Resolves once the reaction is handled; rejects when Pub/Sub must deliver it again. */
export type ChatReactionHandler = (reaction: ChatReactionEvent) => Promise<void>;

export interface AssistantChatAdapterOptions {
  /** `users/{sub}`: how Chat names the assistant. */
  readonly botUserId: string;
  /** How a mention of the assistant reads in the text agents see: `@{userName}`. */
  readonly userName: string;
  /** The assistant's OAuth client for Chat (hostChatAuth). */
  readonly auth: OAuth2Client;
  readonly hydrator: ChatHydrator;
  /** The assistant's Chat token, for the calls the channel makes itself: its working 👀, and messages with files. */
  readonly chatToken: () => Promise<string>;
  readonly fetch?: typeof globalThis.fetch;
  /** Starts pulling Chat's events into `onChatEvent`; started when the adapter initializes, stopped when it disconnects. */
  readonly startDelivery: (onChatEvent: (event: WorkspaceEvent) => Promise<void>) => ChatDelivery;
}

/** A message notification, as the SDK's Pub/Sub path reads one, with the space the channel read. */
interface ChatNotification extends WorkspaceEventNotification {
  readonly message: ChatMessage;
  readonly space: { name: string; type: string };
}

/** One part of an event, read and ready to dispatch in its place. */
interface ReadPart {
  /** Where it falls in the event: when it was written, as Google records it. */
  readonly at: number;
  dispatch(): Promise<void>;
}

const CHAT = 'https://chat.googleapis.com/v1';
/** Where Chat takes a file's bytes (`media.upload`). */
const CHAT_UPLOAD = 'https://chat.googleapis.com/upload/v1';
/** How long a turn works on a message before the assistant shows 👀 on it (R6). */
const WORKING_AFTER_MS = 3_000;
const WORKING_EMOJI = '👀';
/** The state-store record of each 👀 placed and not yet removed: its reaction name, by message name. */
const WORKING_RECORD = 'gws-ea-chat:working';
/** How many messages whose work ended are remembered, so a late pulse never shows 👀 on one again. */
const ENDED_KEPT = 1_000;
/** chat@4.40.0's default dedupe lifetime, retained for a completed audio dispatch. */
const SDK_DEDUPE_TTL_MS = 10 * 60_000;
const AUDIO_DISPATCH_COMPLETE = { gwsEaAudioCompleted: true } as const;

/** The assistant's 👀 on one message a turn works on. */
interface Working {
  /** Shows the 👀 once the turn has run WORKING_AFTER_MS; unset once it fired or the work ended. */
  timer?: NodeJS.Timeout;
  /** Chat placing the 👀; settles once Chat answered. */
  placing?: Promise<void>;
  /** The 👀 placed and not yet removed, by the name Chat gave it. */
  name?: string;
}

/**
 * The key the Chat SDK holds for ten minutes once it starts routing a
 * message, skipping any copy that arrives meanwhile (chat's
 * `routeIncomingMessage`).
 */
function sdkDedupeKey(adapterName: string, messageId: string): string {
  return `dedupe:${adapterName}:${messageId}`;
}

/**
 * The assistant's Google OAuth client for Chat: its token is the host's own
 * (KTD5), taken again before Google would expire it. The host's token
 * source hands out a token only while it has longer than
 * `RENEW_BEFORE_EXPIRY_MS` to live, so the client holds each one no longer.
 */
export function hostChatAuth(token: () => Promise<string>, fetch?: typeof globalThis.fetch): OAuth2Client {
  const client = new OAuth2Client(fetch === undefined ? {} : { transporterOptions: { fetchImplementation: fetch } });
  client.refreshHandler = async () => ({
    access_token: await token(),
    expiry_date: Date.now() + RENEW_BEFORE_EXPIRY_MS,
  });
  return client;
}

export class AssistantChatAdapter extends GoogleChatAdapter implements ReactionSource, WorkingIndicator, FileAttacher {
  /** Chat's events are pulled: the bridge registers no webhook route for this adapter. */
  readonly runtimeMode = 'polling';
  private readonly hydrator: ChatHydrator;
  private readonly startDelivery: AssistantChatAdapterOptions['startDelivery'];
  private readonly chatClient: GoogleClientOptions;
  private delivery: ChatDelivery | undefined;
  private reactionHandler: ChatReactionHandler | undefined;
  /** The 👀 of each message a turn works on, until it is off. */
  private readonly working = new Map<string, Working>();
  /** Messages whose work ended, oldest first. */
  private readonly ended = new Set<string>();
  /** The record's writes, in the order they were asked for. */
  private recording: Promise<void> = Promise.resolve();

  constructor(options: AssistantChatAdapterOptions) {
    super({
      auth: options.auth,
      botUserId: options.botUserId,
      userName: options.userName,
      // The constructor demands a webhook verifier. handleWebhook refuses every request, so none ever runs.
      disableSignatureVerification: true,
    });
    this.hydrator = options.hydrator;
    this.startDelivery = options.startDelivery;
    this.chatClient = { token: options.chatToken, ...(options.fetch === undefined ? {} : { fetch: options.fetch }) };
  }

  override async initialize(chat: ChatInstance): Promise<void> {
    await super.initialize(chat);
    await this.removeLeftWorking();
    await this.delivery?.stop();
    this.delivery = this.startDelivery((event) => this.handleChatEvent(event));
  }

  async disconnect(): Promise<void> {
    const delivery = this.delivery;
    this.delivery = undefined;
    // A 👀 not yet shown never will be; one shown stays recorded for the next start.
    for (const [messageId, entry] of this.working) {
      if (entry.timer === undefined) continue;
      clearTimeout(entry.timer);
      this.working.delete(messageId);
    }
    await delivery?.stop();
  }

  /**
   * A turn is working on the message (each typing pulse that names it). Its
   * 👀 shows once the turn has run WORKING_AFTER_MS, unless the work ended
   * first, and never again once it has. Only a Chat message can carry it:
   * one the host made itself, such as main's welcome to the principal, has
   * nothing in Chat to react to.
   */
  workingOn(_threadId: string, messageId: string): Promise<void> {
    if (spaceOfMessage(messageId) === undefined) return Promise.resolve();
    if (this.working.has(messageId) || this.ended.has(messageId)) return Promise.resolve();
    const entry: Working = {};
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      entry.placing = this.placeWorking(messageId, entry);
    }, WORKING_AFTER_MS);
    entry.timer.unref();
    this.working.set(messageId, entry);
    return Promise.resolve();
  }

  /** The work on the message ended: its 👀 comes off, by the name Chat gave it, once Chat has placed it. */
  async endWorking(_threadId: string, messageId: string): Promise<void> {
    if (this.ended.has(messageId)) return;
    this.ended.add(messageId);
    if (this.ended.size > ENDED_KEPT) {
      const oldest = this.ended.values().next().value;
      if (oldest !== undefined) this.ended.delete(oldest);
    }
    const entry = this.working.get(messageId);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    entry.timer = undefined;
    await entry.placing;
    if (entry.name === undefined) this.working.delete(messageId);
    else await this.removeWorking(messageId, entry.name);
  }

  /**
   * Edit one of the assistant's messages, such as a request showing its
   * outcome. A user may update only a message's text, never a card, so the
   * update names the text alone; the assistant never posts a card.
   */
  override async editMessage(
    threadId: string,
    messageId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<unknown>> {
    const text = convertEmojiPlaceholders(this.formatConverter.renderPostable(message), 'gchat');
    try {
      const response = await this.chatApi.spaces.messages.update({
        name: messageId,
        updateMask: 'text',
        requestBody: { text },
      });
      return { id: response.data.name ?? messageId, threadId, raw: response.data };
      // eslint-disable-next-line no-catch-all/no-catch-all -- handleGoogleChatError rethrows every error as the SDK's typed error
    } catch (error) {
      this.handleGoogleChatError(error, 'editMessage');
    }
  }

  /**
   * Post a message with files on it as one message, the one a reaction or
   * quote then answers (KTD6). Each file is uploaded to the conversation
   * first, then the message is posted with its text and every upload, as the
   * assistant. A file Chat does not take rejects with FilesNotAttachedError
   * before any message is posted. A file's bytes go only to Google.
   */
  async postWithFiles(
    threadId: string,
    message: AdapterPostableMessage,
    files: readonly OutboundFile[],
  ): Promise<RawMessage<unknown>> {
    const { spaceName, threadName } = this.decodeThreadId(threadId);
    const attachment: Array<{ attachmentDataRef: Record<string, unknown> }> = [];
    for (const file of files) attachment.push({ attachmentDataRef: await this.upload(spaceName, file) });
    const reply = threadName === undefined ? '' : '?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD';
    const posted = await googleJson(this.chatClient, `${CHAT}/${spaceName}/messages${reply}`, {
      method: 'POST',
      body: {
        text: convertEmojiPlaceholders(this.formatConverter.renderPostable(message), 'gchat'),
        attachment,
        ...(threadName === undefined ? {} : { thread: { name: threadName } }),
      },
    });
    if (!isRecord(posted) || typeof posted.name !== 'string') {
      throw new GoogleApiError(502, 'Chat posted a message without naming it');
    }
    return { id: posted.name, threadId, raw: posted };
  }

  /** Upload one file to the space (`media.upload`): its name, then its bytes. Resolves to what a message attaches. */
  private async upload(spaceName: string, file: OutboundFile): Promise<Record<string, unknown>> {
    const boundary = `gws-ea-${randomUUID()}`;
    const data = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
          `${JSON.stringify({ filename: file.filename })}\r\n` +
          `--${boundary}\r\nContent-Type: ${file.mimeType ?? 'application/octet-stream'}\r\n\r\n`,
      ),
      file.data,
      Buffer.from(`\r\n--${boundary}--`),
    ]);
    let uploaded: unknown;
    try {
      uploaded = await googleJson(
        this.chatClient,
        `${CHAT_UPLOAD}/${spaceName}/attachments:upload?uploadType=multipart`,
        {
          method: 'POST',
          content: { type: `multipart/related; boundary=${boundary}`, data },
        },
      );
    } catch (error) {
      // Its message carries Google's answer: a log shows an error's message, never its cause.
      const why = error instanceof Error ? error.message : 'unknown failure';
      throw new FilesNotAttachedError(`Chat did not take the file ${file.filename}: ${why}`, { cause: error });
    }
    const ref = isRecord(uploaded) && isRecord(uploaded.attachmentDataRef) ? uploaded.attachmentDataRef : undefined;
    if (typeof ref?.attachmentUploadToken !== 'string') {
      throw new FilesNotAttachedError(`Chat named no upload for the file ${file.filename}`);
    }
    return ref;
  }

  /** No request reaches this host from Google: Chat's events are pulled. */
  override handleWebhook(_request: Request): Promise<Response> {
    return Promise.resolve(new Response('Google Chat events reach this host by Pub/Sub pull', { status: 404 }));
  }

  /** Where reactions are handed once read; without a handler, a reaction is read and acknowledged. */
  setReactionHandler(handler: ChatReactionHandler | undefined): void {
    this.reactionHandler = handler;
  }

  /**
   * Handle one pulled event (KTD4): read each message or reaction it names,
   * then dispatch them in the order they were written. Nothing is dispatched
   * until every part is read, and dispatch stops at the first part not
   * routed, so on redelivery the parts arrive in order again and the router
   * drops the ones already routed. A part that is gone is acknowledged with
   * the rest.
   */
  async handleChatEvent(event: WorkspaceEvent): Promise<void> {
    const parts = chatEventParts(event);
    if (parts.length === 0) {
      log.warn('Acknowledged a Chat event with nothing to handle', { type: event.type, messageId: event.messageId });
      return;
    }
    const eventTime = Date.parse(event.time) || 0;
    const read = await Promise.all(
      parts.map((part) =>
        part.kind === 'message' ? this.readMessage(part.name) : this.readReaction(part.name, eventTime),
      ),
    );
    const ready = read.filter((part): part is ReadPart => part !== undefined).sort((a, b) => a.at - b.at);
    for (const part of ready) await part.dispatch();
  }

  /**
   * Dispatch one message as the SDK's webhook path does, and wait until it
   * is routed. A DM is addressed with no thread and the `:dm` mark; any other
   * space by the message's thread.
   *
   * The SDK declares this method void, and its push handler drops what it
   * returns; that handler is reached only through handleWebhook, which
   * refuses. handleChatEvent awaits it.
   */
  // eslint-disable-next-line @typescript-eslint/no-misused-promises -- the SDK's own caller is unreachable (above)
  protected override async handlePubSubMessageEvent(notification: WorkspaceEventNotification): Promise<void> {
    const { message, space } = notification;
    if (!message || !space) throw new Error('A Chat message notification lacks its message or space');
    const chat = this.requireChat();
    const threadId = this.threadIdOf(message, space);
    const key = sdkDedupeKey(this.name, message.name);
    const hasAudio = message.attachment?.some((attachment) => attachment.contentType?.startsWith('audio/')) === true;
    const claim = hasAudio ? await this.state?.get<unknown>(key) : undefined;
    const audioCompleted = isRecord(claim) && claim.gwsEaAudioCompleted === true;
    // The SDK claims a source before media preparation. Its opaque KV value
    // can also record completion, so only unfinished audio dispatch is retried
    // after a host death. Completed captions (including consumed replies and
    // command denials) keep native SDK dedupe; ordinary text is unchanged.
    // The pull owner serializes each space until this awaited dispatch ends.
    if (hasAudio && !audioCompleted) await this.state?.delete(key);
    try {
      await chat.processMessage(this, threadId, () => this.parsePubSubMessage(notification, threadId));
      if (hasAudio && !audioCompleted) await this.state?.set(key, AUDIO_DISPATCH_COMPLETE, SDK_DEDUPE_TTL_MS);
      // Mailbox source IDs cover a death before this completion write. A death
      // after a non-mailbox interceptor effect can repeat that effect, as the
      // SDK claim and module effects do not share an atomic transaction.
    } catch (error) {
      // A failed dispatch must retry, including a failed completion write after
      // mailbox insertion; durable source IDs protect an already inserted copy.
      await this.state?.delete(key).catch((cause: unknown) => {
        log.error('Could not clear a failed Chat message from the SDK dedupe', { name: message.name, err: cause });
      });
      throw error;
    }
  }

  /**
   * Mark a mention of the assistant as `@{userName}`, the form the SDK
   * detects. The assistant is a person, not a Chat app, so its mention is
   * matched by its user name whatever the user type. Rewritten from the
   * last mention back, so earlier offsets still hold.
   */
  protected override normalizeBotMentions(message: GoogleChatMessage): string {
    let text = message.text || '';
    const spans = (message.annotations ?? [])
      .filter(
        (annotation) => annotation.type === 'USER_MENTION' && annotation.userMention?.user.name === this.botUserId,
      )
      .flatMap(({ startIndex, length }) =>
        startIndex === undefined || length === undefined ? [] : [{ startIndex, length }],
      )
      .sort((a, b) => b.startIndex - a.startIndex);
    for (const { startIndex, length } of spans) {
      text = `${text.slice(0, startIndex)}@${this.userName}${text.slice(startIndex + length)}`;
    }
    return text;
  }

  /** Place the 👀 and record its name; a 👀 Chat refuses is not tried again. */
  private async placeWorking(messageId: string, entry: Working): Promise<void> {
    let placed: unknown;
    try {
      placed = await googleJson(this.chatClient, `${CHAT}/${messageId}/reactions`, {
        method: 'POST',
        body: { emoji: { unicode: WORKING_EMOJI } },
      });
      /* eslint-disable-next-line no-catch-all/no-catch-all -- 👀 is a courtesy: a turn never fails for it */
    } catch (error) {
      log.warn('Could not show 👀 on a Chat message', { messageId, err: error });
      return;
    }
    const name = isRecord(placed) && typeof placed.name === 'string' ? placed.name : undefined;
    if (name === undefined) {
      log.warn('Chat placed 👀 without naming it', { messageId });
      return;
    }
    entry.name = name;
    await this.recordWorking();
  }

  /**
   * Remove the 👀 by its name. One Chat no longer has, or no longer lets the
   * assistant reach (404, 403), is gone. One that cannot be removed now stays
   * recorded, and is removed when the channel next starts.
   */
  private async removeWorking(messageId: string, name: string): Promise<void> {
    try {
      await googleJson(this.chatClient, `${CHAT}/${name}`, { method: 'DELETE' });
      /* eslint-disable-next-line no-catch-all/no-catch-all -- one not removed now stays recorded for the next start */
    } catch (error) {
      if (!(error instanceof GoogleApiError && (error.status === 403 || error.status === 404))) {
        log.warn('Could not remove 👀 from a Chat message; it is removed when the channel next starts', {
          messageId,
          name,
          err: error,
        });
        return;
      }
    }
    this.working.delete(messageId);
    await this.recordWorking();
  }

  /**
   * Record every 👀 placed and not yet removed. Writes run one at a time,
   * each recording what is placed when it runs.
   */
  private recordWorking(): Promise<void> {
    this.recording = this.recording
      .then(async () => {
        const placed = Object.fromEntries(
          [...this.working].flatMap(([messageId, entry]) =>
            entry.name === undefined ? [] : [[messageId, entry.name] as const],
          ),
        );
        if (Object.keys(placed).length === 0) await this.state?.delete(WORKING_RECORD);
        else await this.state?.set(WORKING_RECORD, placed);
      })
      .catch((error: unknown) => {
        log.warn('Could not record the 👀 placed on Chat messages', { err: error });
      });
    return this.recording;
  }

  /** Remove each 👀 a previous run placed and left (a crash), and clear its record. */
  private async removeLeftWorking(): Promise<void> {
    let recorded: unknown;
    try {
      recorded = await this.state?.get(WORKING_RECORD);
      /* eslint-disable-next-line no-catch-all/no-catch-all -- Chat starts without the sweep; the record stays for the next start */
    } catch (error) {
      log.warn('Could not read the 👀 a previous run left on Chat messages', { err: error });
      return;
    }
    if (!isRecord(recorded)) return;
    const left = Object.entries(recorded).flatMap(([messageId, name]) =>
      typeof name === 'string' && !this.working.has(messageId) ? [{ messageId, name }] : [],
    );
    for (const { messageId, name } of left) {
      this.ended.add(messageId);
      this.working.set(messageId, { name });
    }
    await Promise.all(left.map(({ messageId, name }) => this.removeWorking(messageId, name)));
  }

  private requireChat(): ChatInstance {
    if (!this.chat) throw new Error('The Google Chat adapter received an event before it initialized');
    return this.chat;
  }

  private threadIdOf(message: GoogleChatMessage, space: { name: string; type: string }): string {
    const isDM = space.type === DIRECT_MESSAGE;
    return this.encodeThreadId({
      spaceName: space.name,
      isDM,
      threadName: isDM ? undefined : message.thread?.name || message.name,
    });
  }

  private notification(message: ChatMessage, space: ChatSpace): ChatNotification {
    return {
      eventType: CHAT_MESSAGE_CREATED,
      eventTime: message.createTime,
      message,
      space: { name: space.name, type: space.type },
      subscription: '',
      targetResource: `//chat.googleapis.com/${space.name}`,
    };
  }

  /**
   * The message with its sender named. The SDK caches the name it is given,
   * so a later message from the same person reads it there too.
   */
  private async withSenderName(message: ChatMessage): Promise<ChatMessage> {
    if (message.sender.name === this.botUserId) return message;
    const displayName = await this.hydrator.displayName(message.sender.name);
    return { ...message, sender: { ...message.sender, displayName } };
  }

  /** The message and its space, or undefined when either is gone. */
  private async readMessageIn(name: string): Promise<{ message: ChatMessage; space: ChatSpace } | undefined> {
    const spaceName = spaceOfMessage(name);
    if (spaceName === undefined) return undefined;
    const [message, space] = await Promise.all([this.hydrator.message(name), this.hydrator.space(spaceName)]);
    return message && space ? { message: await this.withSenderName(message), space } : undefined;
  }

  private async readMessage(name: string): Promise<ReadPart | undefined> {
    const read = await this.readMessageIn(name);
    if (read === undefined) {
      log.info('Acknowledged a Chat message the assistant can no longer read', { name });
      return undefined;
    }
    const notification = this.notification(read.message, read.space);
    return {
      at: Date.parse(read.message.createTime) || 0,
      dispatch: () => this.handlePubSubMessageEvent(notification),
    };
  }

  private async readReaction(name: string, at: number): Promise<ReadPart | undefined> {
    const messageName = messageOfReaction(name);
    const reaction = messageName === undefined ? undefined : await this.hydrator.reaction(name);
    if (messageName === undefined || reaction === undefined) {
      log.info('Acknowledged a Chat reaction that is gone', { name });
      return undefined;
    }
    // Its own: the working 👀 and the reactions agents send.
    if (reaction.user.name === this.botUserId) return undefined;
    const [read, reactor] = await Promise.all([
      this.readMessageIn(messageName),
      this.hydrator.displayName(reaction.user.name),
    ]);
    if (read === undefined) {
      log.info('Acknowledged a Chat reaction on a message the assistant can no longer read', { name });
      return undefined;
    }
    return {
      at,
      dispatch: async () => {
        const handler = this.reactionHandler;
        if (!handler) return;
        const threadId = this.threadIdOf(read.message, read.space);
        await handler({
          adapter: this,
          added: true,
          emoji: defaultEmojiResolver.fromGChat(reaction.emoji),
          rawEmoji: reaction.emoji,
          user: {
            userId: reaction.user.name,
            userName: reactor,
            fullName: reactor,
            isBot: reaction.user.type === 'BOT',
            isMe: false,
          },
          messageId: messageName,
          threadId,
          message: await this.parsePubSubMessage(this.notification(read.message, read.space), threadId),
          reactedAt: new Date(at),
          reactionName: reaction.name,
          raw: reaction,
        });
      },
    };
  }
}

/**
 * The message a Chat message quotes, so the agent sees what is being answered:
 * its text and sender from the snapshot Google keeps, and, for a reply, the
 * name of the message replied to. A forward quotes a message without
 * replying to it, so it names none.
 */
export function extractGchatReplyContext(raw: Record<string, unknown>): ReplyContext | null {
  const message = isRecord(raw.message) ? raw.message : undefined;
  const quote = isRecord(message?.quotedMessageMetadata) ? message.quotedMessageMetadata : undefined;
  if (quote === undefined) return null;
  const snapshot = isRecord(quote.quotedMessageSnapshot) ? quote.quotedMessageSnapshot : undefined;
  const text = typeof snapshot?.text === 'string' ? snapshot.text : '';
  const sender = typeof snapshot?.sender === 'string' && snapshot.sender.trim() ? snapshot.sender : 'unknown';
  const id = quote.quoteType !== 'FORWARD' && typeof quote.name === 'string' ? quote.name : undefined;
  if (!text.trim() && id === undefined) return null;
  return { sender, text, ...(id === undefined ? {} : { id }) };
}

/** A native forward contains source audio; replying to a message does not forward a new recording. */
function gchatAudioSource(raw: Record<string, unknown>): AudioSource {
  const message = isRecord(raw.message) ? raw.message : undefined;
  const quote = isRecord(message?.quotedMessageMetadata) ? message.quotedMessageMetadata : undefined;
  return { kind: 'audio', ...(quote?.quoteType === 'FORWARD' ? { forwarded: true } : {}) };
}

/**
 * Google Chat's wiring defaults. Every DM engages; a group conversation
 * engages on a mention, which an operator can widen per wiring. Unknown
 * senders ask for approval in both.
 */
export const GCHAT_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'request_approval' },
  group: { engageMode: 'mention', threads: true, unknownSenderPolicy: 'request_approval' },
  mentions: 'platform',
};

/** When Google recorded a message the assistant posted: the `createTime` of the message it returned. */
function chatCreateTime(raw: unknown): Date | undefined {
  if (!isRecord(raw) || typeof raw.createTime !== 'string') return undefined;
  const at = new Date(raw.createTime);
  return Number.isNaN(at.getTime()) ? undefined : at;
}

/**
 * The channel: the adapter behind the Chat SDK bridge. Pub/Sub may hand an
 * event out again after it was routed, so the router drops a copy already
 * queued. Google lets a user write only text, so questions and approval
 * requests post in words (R7), with any pictures they name attached (KTD6),
 * each remembered with the time Google recorded it.
 */
export function createAssistantChatChannel(adapter: AssistantChatAdapter): ChannelAdapter {
  return createChatSdkBridge({
    adapter,
    concurrency: 'concurrent',
    supportsThreads: true,
    defaults: GCHAT_DEFAULTS,
    extractReplyContext: extractGchatReplyContext,
    extractAudioSource: gchatAudioSource,
    redelivers: true,
    textRequests: { postedAt: chatCreateTime },
  });
}
