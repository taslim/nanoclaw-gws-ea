/**
 * Chat SDK bridge — wraps a Chat SDK adapter + Chat instance
 * to conform to the NanoClaw ChannelAdapter interface.
 *
 * Used by Discord, Slack, and other Chat SDK-supported platforms.
 */
import { createHash, timingSafeEqual } from 'crypto';
import http from 'http';

import {
  Chat,
  Card,
  CardText,
  Actions,
  Button,
  LinkButton,
  type CardChild,
  type Adapter,
  type AdapterPostableMessage,
  type AssistantContextChangedEvent,
  type AssistantThreadStartedEvent,
  type Author,
  type ConcurrencyStrategy,
  type EmojiValue,
  type Message as ChatMessage,
  type StateAdapter,
} from 'chat';
import { log } from '../log.js';
import { SqliteStateAdapter } from '../state-sqlite.js';
import { registerWebhookAdapter } from '../webhook-server.js';
import { approveRejectRequest, normalizeOptions, type NormalizedOption } from './ask-question.js';
import type { AuthenticatedSender, ChannelAdapter, ChannelDefaults, ChannelSetup, InboundMessage } from './adapter.js';
import { createAnswers, indexPostedRequest, POSTED_REQUEST_KEPT_MS, type Answers } from './answers.js';
import { INSTANCE_KEY_RE } from './channel-registry.js';
import { resolveQuestionRender, dispatchQuestionAction } from './question-render-registry.js';

/** Adapter with optional gateway support (e.g., Discord). */
interface GatewayAdapter extends Adapter {
  startGatewayListener?(
    options: { waitUntil?: (task: Promise<unknown>) => void },
    durationMs?: number,
    abortSignal?: AbortSignal,
    webhookUrl?: string,
  ): Promise<Response>;
}

/** Adapter that can expose authenticated transport liveness to host status. */
interface ConnectionAwareAdapter extends Adapter {
  isConnected?(): boolean;
}

/** Reply context extracted from a platform's raw message. */
export interface ReplyContext {
  text: string;
  sender: string;
  /** The platform's id for the message replied to, when the platform names it. */
  id?: string;
}

// ---------------------------------------------------------------------------
// Reactions an adapter reads itself
// ---------------------------------------------------------------------------

/** A reaction someone placed on a message, as an adapter read it from its platform. */
export interface InboundReaction {
  /** The reaction's own id, the same each time the platform delivers it. */
  readonly reactionName: string;
  readonly emoji: EmojiValue;
  /** Who reacted. */
  readonly user: Author;
  /** The message reacted to, read as an inbound message is: `author.isMe` marks the assistant's own. */
  readonly message: ChatMessage;
  /** The SDK thread of the message reacted to. */
  readonly threadId: string;
  readonly reactedAt: Date;
}

/**
 * An adapter that reads its platform's reactions itself and hands each one to
 * the bridge, awaiting the promise: it resolves once the reaction is routed
 * and rejects when routing fails, so a platform that redelivers hands the
 * reaction over again. The SDK's own reaction dispatch is fire-and-forget,
 * which such a platform cannot use. The adapter drops its own reactions.
 */
export interface ReactionSource {
  readonly setReactionHandler: (handler: (reaction: InboundReaction) => Promise<void>) => void;
}

function isReactionSource(adapter: Adapter): adapter is Adapter & ReactionSource {
  return typeof (adapter as Partial<ReactionSource>).setReactionHandler === 'function';
}

// ---------------------------------------------------------------------------
// A working mark on the message a turn works on
// ---------------------------------------------------------------------------

/**
 * An adapter that marks the message a turn works on while the turn runs, as
 * the Google Chat assistant's 👀 does. The bridge hands it each typing pulse
 * that carries an anchor (ChannelAdapter.setTyping) and each anchor's end
 * (ChannelAdapter.endTyping); the adapter decides when to show its mark.
 */
export interface WorkingIndicator {
  /** A turn is working on the message: called on every typing pulse that names it. */
  readonly workingOn: (threadId: string, messageId: string) => Promise<void>;
  /** The work on the message ended; the mark comes off. */
  readonly endWorking: (threadId: string, messageId: string) => Promise<void>;
}

function isWorkingIndicator(adapter: Adapter): adapter is Adapter & WorkingIndicator {
  const candidate = adapter as Partial<WorkingIndicator>;
  return typeof candidate.workingOn === 'function' && typeof candidate.endWorking === 'function';
}

/** How much of the message reacted to the agent sees with the reaction. */
const REACTION_EXCERPT_CHARS = 200;

function excerpt(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= REACTION_EXCERPT_CHARS ? trimmed : `${trimmed.slice(0, REACTION_EXCERPT_CHARS - 1)}…`;
}

/** The sender identity the platform transport asserts for an SDK author, never parsed from content. */
function authenticatedSenderOf(author: Author): AuthenticatedSender | undefined {
  if (typeof author.userId !== 'string' || author.userId.length === 0) return undefined;
  return {
    userId: author.userId,
    displayName: author.fullName || author.userName || undefined,
    kind: author.isBot === false ? 'human' : author.isBot === true ? 'bot' : 'unknown',
  };
}

// ---------------------------------------------------------------------------
// Agent-DM opened hook (assistant_thread_started)
// ---------------------------------------------------------------------------

/** The user opened an agent DM (assistant thread started). Registered by the
 *  host to (re)assert onboarding prompts at a moment the user is provably
 *  looking — prompt sets made before the DM was ever opened may not render. */
export interface AgentDmOpenedEvent {
  instance: string;
  channelId: string;
}

let agentDmOpenedHandler: ((event: AgentDmOpenedEvent) => void | Promise<void>) | null = null;

export function setAgentDmOpenedHandler(fn: (event: AgentDmOpenedEvent) => void | Promise<void>): void {
  agentDmOpenedHandler = fn;
}

function dispatchAgentDmOpened(event: AgentDmOpenedEvent): void {
  if (!agentDmOpenedHandler) return;
  try {
    Promise.resolve(agentDmOpenedHandler(event)).catch((err) =>
      log.warn('Agent-DM opened handler failed', { channelId: event.channelId, err }),
    );
  } catch (err) {
    log.warn('Agent-DM opened handler threw', { channelId: event.channelId, err });
  }
}

// ---------------------------------------------------------------------------
// Agent-mode app context
// ---------------------------------------------------------------------------

/** One "what the user is viewing" entity, rendered by the container formatter. */
export interface AppContextEntity {
  type: string;
  id: string;
}

/**
 * Latest assistant context per (instance, DM channel, user), attached to the
 * NEXT inbound DM message as content.app_context and consumed. Platforms
 * whose DM surface materializes threads and reports client context send
 * app_context as its own event (assistant_thread_started legacy /
 * app_context_changed in agent view), not on the message payload, so the
 * bridge has to hold it across the event → message gap. Short TTL: a stale
 * "viewing X" is worse than none.
 */
const APP_CONTEXT_TTL_MS = 5 * 60 * 1000;
const appContextCache = new Map<string, { entities: AppContextEntity[]; at: number }>();

/** Channel ids arrive both raw ("D0123") and platform-encoded ("slack:D0123")
 *  depending on the emitting path — key on the final segment so both match. */
function appContextKey(instance: string, channelId: string, userId: string): string {
  const channel = channelId.includes(':') ? channelId.slice(channelId.lastIndexOf(':') + 1) : channelId;
  return `${instance}|${channel}|${userId}`;
}

/**
 * Derive ordered entities from an SDK assistant event. The installed chat
 * core (4.40.0) parses assistant_thread_started / legacy app_context_changed into a
 * `context` object (channelId/teamId/threadEntryPoint — the legacy assistant
 * context shape) with no entities array; prefer a real `entities` array
 * whenever a future SDK forwards the platform's ordered agent-context
 * entities.
 */
export function appContextEntities(
  event: AssistantThreadStartedEvent | AssistantContextChangedEvent,
): AppContextEntity[] {
  const raw = event as unknown as Record<string, unknown>;
  const direct = raw.entities ?? (raw.context as Record<string, unknown> | undefined)?.entities;
  if (Array.isArray(direct)) {
    return direct
      .map((e) => {
        const entity = e as Record<string, unknown> | null;
        const type = typeof entity?.type === 'string' ? entity.type : '';
        const idValue = entity?.id ?? entity?.channel_id ?? entity?.entity_id;
        const id = typeof idValue === 'string' ? idValue : '';
        return { type, id };
      })
      .filter((e) => e.type !== '' && e.id !== '');
  }
  const channelId = event.context?.channelId;
  return typeof channelId === 'string' && channelId ? [{ type: 'channel', id: channelId }] : [];
}

export function cacheAppContext(
  instance: string,
  channelId: string,
  userId: string,
  entities: AppContextEntity[],
  now = Date.now(),
): void {
  const key = appContextKey(instance, channelId, userId);
  if (entities.length === 0) {
    appContextCache.delete(key);
    return;
  }
  appContextCache.set(key, { entities, at: now });
}

/** Consume the cached context (single-shot: it describes what the user was
 *  viewing when they sent the NEXT message, not every message after). */
export function takeAppContext(
  instance: string,
  channelId: string,
  userId: string,
  now = Date.now(),
): AppContextEntity[] | undefined {
  const key = appContextKey(instance, channelId, userId);
  const hit = appContextCache.get(key);
  if (!hit) return undefined;
  appContextCache.delete(key);
  if (now - hit.at > APP_CONTEXT_TTL_MS) return undefined;
  return hit.entities;
}

/**
 * Attach the cached app context to an inbound DM message's content JSON
 * (content.app_context = { entities: [...] }). A context the SDK attached
 * directly on the message payload wins — the cache only fills the
 * event → message gap.
 */
export function attachAppContext(
  content: Record<string, unknown>,
  instance: string,
  channelId: string,
  userId: string | undefined,
): void {
  if (content.app_context) return;
  if (!userId) return;
  const entities = takeAppContext(instance, channelId, userId);
  if (entities && entities.length > 0) {
    content.app_context = { entities };
  }
}

/**
 * Root-thread a top-level DM message: on platforms whose DM surface
 * materializes conversation threads (agent-view semantics), every top-level
 * DM message is the root of a conversation thread — replying in-thread and
 * setting per-thread status on that ts is what OPENS the thread in the
 * client. Such adapters map top-level DM messages to an EMPTY threadTs
 * (`…:<channel>:`), so without this the thread never materializes: no
 * in-thread reply, no status target, no per-thread session.
 *
 * The message id is the platform ts for chat-sdk adapters, so appending it to
 * the dangling `:` yields the canonical thread id. Plain (non-agent) DM
 * wirings are unaffected downstream: the router strips thread ids when the
 * wiring's thread policy is off, restoring today's top-level behavior.
 */
export function normalizeDmThreadId(threadId: string, messageId: string): string {
  if (threadId.endsWith(':') && messageId && !messageId.includes(':')) {
    return threadId + messageId;
  }
  return threadId;
}

/** Extract reply context from a platform-specific raw message. Return null if no reply. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ReplyContextExtractor = (raw: Record<string, any>) => ReplyContext | null;

/**
 * Recover readable content a platform adapter left only in `message.raw`.
 *
 * The bridge drops `raw` before persisting (it can be very large), so anything
 * the adapter did not project into `Message.toJSON()` is lost at that point.
 * A platform that carries readable content outside the normal text — Slack
 * puts pasted tables in `attachments[].blocks[]` — returns it here as text.
 * Return null when there is nothing to recover.
 */
export type RawTextExtractor = (raw: Record<string, unknown>) => string | null;

// ---------------------------------------------------------------------------
// Membership hook
// ---------------------------------------------------------------------------

/**
 * A member joined (or left) a channel/group conversation one of our bridge
 * instances is in. Forwarded from the Chat SDK's member_joined_channel
 * dispatch; `left` is reserved for member_left_channel, which the installed
 * chat core (4.40.0) does NOT dispatch — see the TODO at the
 * onMemberJoinedChannel registration in setup().
 */
export interface MembershipEvent {
  /** Adapter-instance key of the bridge that saw the event (defaults to the
   *  platform name for default instances). */
  instance: string;
  /** Semantic platform key (`adapter.name`) — the key membership handlers
   *  are registered under. */
  channelType: string;
  channelId: string;
  userId: string;
  inviterId?: string;
  left?: boolean;
}

export type MembershipHandler = (event: MembershipEvent) => void | Promise<void>;

const membershipHandlers = new Map<string, MembershipHandler>();

/**
 * Register THE membership handler for a channel type (single registration —
 * one channel-side module owns it; a second registration for the same
 * channel type overwrites with a warning, mirroring the router's hook
 * discipline). The bridge invokes it fire-and-forget for every membership
 * event on every bridge instance of that channel type; errors are logged,
 * never thrown into SDK dispatch. With no handler registered the bridge
 * behaves exactly as before.
 */
export function setMembershipHandler(channelType: string, fn: MembershipHandler): void {
  if (membershipHandlers.has(channelType)) {
    log.warn('Membership handler overwritten', { channelType });
  }
  membershipHandlers.set(channelType, fn);
}

function dispatchMembership(event: MembershipEvent): void {
  const handler = membershipHandlers.get(event.channelType);
  if (!handler) return;
  try {
    Promise.resolve(handler(event)).catch((err) =>
      log.error('Membership handler failed', {
        channelType: event.channelType,
        channelId: event.channelId,
        userId: event.userId,
        err,
      }),
    );
  } catch (err) {
    log.error('Membership handler threw', {
      channelType: event.channelType,
      channelId: event.channelId,
      userId: event.userId,
      err,
    });
  }
}

// ---------------------------------------------------------------------------
// Inbound policy registration
// ---------------------------------------------------------------------------

/**
 * Wrap of the host's `ChannelSetup`, applied at bridge setup time. Every
 * inbound dispatch path (onSubscribedMessage / onNewMention / onDirectMessage
 * / onNewMessage) funnels through the stored setup's `onInbound`, so a policy
 * that wraps `onInbound` intercepts them all at a single point — e.g. to
 * drop, re-attribute, or rate-limit bot-authored messages before routing.
 *
 * `instanceKey` is the bridge's registry key (`config.instance ??
 * adapter.name`): the wrap runs once per bridge instance, so policy state
 * captured in the returned closure is naturally per-instance (= per bot
 * identity when several bridges share one platform).
 */
export type BridgeInboundPolicy = (setup: ChannelSetup, instanceKey: string) => ChannelSetup | Promise<ChannelSetup>;

const bridgeInboundPolicies = new Map<string, BridgeInboundPolicy>();

/**
 * Register THE inbound policy for a channel type (single registration — the
 * owning module registers on barrel import; a second registration overwrites
 * with a warning, mirroring the router's hook discipline). Bridges whose
 * channel type has no registered policy are unaffected.
 */
export function registerBridgeInboundPolicy(channelType: string, wrap: BridgeInboundPolicy): void {
  if (bridgeInboundPolicies.has(channelType)) {
    log.warn('Bridge inbound policy overwritten', { channelType });
  }
  bridgeInboundPolicies.set(channelType, wrap);
}

export interface ChatSdkBridgeConfig {
  adapter: Adapter;
  /**
   * Adapter-instance name for running multiple bridges of one platform
   * (e.g. several Slack apps in one workspace). Defaults to the platform
   * name. Drives the registry key, the webhook route (/webhook/<instance>),
   * and the Chat SDK state namespace. channelType is NOT affected — user
   * identity, formatting, and container config stay keyed on the platform.
   * Must be URL-safe: non-empty, only letters, digits, '.', '_' or '-'.
   */
  instance?: string;
  concurrency?: ConcurrencyStrategy;
  /** Bot token for authenticating forwarded Gateway events (required for interaction handling). */
  botToken?: string;
  /** Platform-specific reply context extraction. */
  extractReplyContext?: ReplyContextExtractor;
  /**
   * Recover readable content the platform adapter left only in `message.raw`.
   * The returned text is appended to the message body and persisted; the raw
   * provider payload is still dropped.
   */
  extractRawText?: RawTextExtractor;
  /**
   * The platform may deliver a message again after the adapter handed it on,
   * under the same message id: each inbound is marked `deduplicate`, so the
   * router drops a copy already queued (InboundMessage.deduplicate).
   */
  redelivers?: boolean;
  /**
   * Whether this platform uses threads as the primary conversation unit.
   * See `ChannelAdapter.supportsThreads`. Declared by the calling channel
   * skill, not inferred, because some platforms (Discord) can be used either
   * way and the default depends on installation style.
   */
  supportsThreads: boolean;
  /**
   * Declared wiring-time defaults for this channel. Copied verbatim onto the
   * returned ChannelAdapter, exactly like supportsThreads. See
   * `ChannelAdapter.defaults`.
   */
  defaults?: ChannelDefaults;
  /**
   * Optional transform applied to outbound text/markdown before it reaches the
   * adapter. Used by channels that need to sanitize for a platform-specific
   * quirk (e.g. Telegram's legacy Markdown parse mode).
   */
  transformOutboundText?: (text: string) => string;
  /**
   * Maximum text length the underlying adapter accepts in a single message.
   * When set, the bridge splits outbound text longer than this on paragraph
   * → line → hard-char boundaries and posts multiple messages. Without this,
   * adapters like Discord (2000) and Telegram (4096) silently truncate
   * mid-response. The returned id is the first chunk's id so subsequent edits
   * and reactions still target the head of the reply.
   */
  maxTextLength?: number;
  /**
   * The platform shows this account no cards (Google Chat under user
   * authentication), so requests are text. A question or approval request
   * posts as its title, the question, and how to answer it in words, with no
   * codes; a display card posts as text with its links. Every request is
   * left as posted until the handler that resolves an answer edits it to its
   * outcome: the bridge never edits one itself. Each request it posts is
   * recorded by its message, by its question (readPostedRequest), and in its
   * conversation, so an answer and the handler's edit both find it. A reply
   * or reaction that answers a request (src/channels/answers.ts) goes to its
   * handler through onAction instead of to the agent. Unset, requests post
   * as cards.
   */
  textRequests?: {
    /** When the platform recorded a message the adapter posted, read from postMessage's raw response. */
    readonly postedAt: (raw: unknown) => Date | undefined;
  };
}

/** A request the bridge posted as text (ChatSdkBridgeConfig.textRequests). */
export interface PostedRequest {
  /** The question id of its pending row. */
  readonly questionId: string;
  /** The conversation it was posted in, as the bridge's platform id. */
  readonly platformId: string;
  /** When the platform recorded it, as ISO-8601; absent when the platform reported no time. */
  readonly postedAt?: string;
}

function postedRequestKey(adapterName: string, messageId: string): string {
  return `text-request:${adapterName}:message:${messageId}`;
}

function requestMessageKey(adapterName: string, questionId: string): string {
  return `text-request:${adapterName}:question:${questionId}`;
}

/** The request the bridge posted as this message, while it takes answers. */
export async function readPostedRequest(
  state: StateAdapter,
  adapterName: string,
  messageId: string,
): Promise<PostedRequest | undefined> {
  return (await state.get<PostedRequest>(postedRequestKey(adapterName, messageId))) ?? undefined;
}

/**
 * How a request asks for its answer in words. An approve/reject request is
 * answered yes or no, by a quote or 👍/👎, with the reason after the no when
 * its rejection takes one; any other request lists its options by number.
 */
function howToAnswer(options: readonly NormalizedOption[]): string {
  const approval = approveRejectRequest(options);
  if (approval) {
    const yesOrNo = 'Quote this message with yes or no, or react 👍 or 👎.';
    return approval.takesReason ? `${yesOrNo} To say why, quote it with no and your reason.` : yesOrNo;
  }
  if (options.length === 0) return '';
  const list = options.map((option, index) => `${index + 1}. ${option.label}`).join('\n');
  return `${list}\n\nQuote this message with the number or name of your choice.`;
}

/** A question or approval request as text: its title, the question, and how to answer it. */
function textRequest(title: string, question: string, options: readonly NormalizedOption[]): string {
  return [`**${title}**`, question, howToAnswer(options)].filter(Boolean).join('\n\n');
}

/** An answered request as text: what was asked, and its outcome where the answer was asked for. */
function textOutcome({ title, question, resolution }: TerminalApprovalCard): string {
  return [`**${title}**`, question, resolution].filter(Boolean).join('\n\n');
}

/** A display card's content (send_card), as both of its renderings read it. */
interface DisplayCard {
  readonly title: string;
  /** Its description, then each text child. */
  readonly texts: readonly string[];
  readonly links: ReadonlyArray<{ label: string; url: string; style?: 'primary' | 'danger' | 'default' }>;
}

/**
 * Read a display card. Non-URL actions are dropped: send_card's contract is
 * fire-and-forget, so a callback button would have nowhere to land. The
 * runner filters actions against LINK_ACTION_SCHEMA before writing the row;
 * the checks here still stand because any producer can write this payload.
 */
function readDisplayCard(spec: Record<string, unknown>): DisplayCard {
  const texts: string[] = [];
  if (typeof spec.description === 'string' && spec.description) texts.push(spec.description);
  if (Array.isArray(spec.children)) {
    for (const child of spec.children) {
      if (typeof child === 'string' && child) {
        texts.push(child);
      } else if (child && typeof child === 'object' && typeof (child as Record<string, unknown>).text === 'string') {
        texts.push((child as Record<string, string>).text);
      }
    }
  }
  const links = Array.isArray(spec.actions)
    ? (spec.actions as Array<Record<string, unknown> | null | undefined>)
        .filter(
          (a): a is Record<string, unknown> =>
            !!a &&
            typeof a === 'object' &&
            typeof a.url === 'string' &&
            !!a.url &&
            typeof a.label === 'string' &&
            !!a.label,
        )
        .map((a) => {
          const style = a.style;
          const safeStyle: 'primary' | 'danger' | 'default' | undefined =
            style === 'primary' || style === 'danger' || style === 'default' ? style : undefined;
          return { label: a.label as string, url: a.url as string, style: safeStyle };
        })
    : [];
  return { title: (spec.title as string) || '', texts, links };
}

/** A display card as text: its title, its texts, and each link by its label. */
function textDisplayCard({ title, texts, links }: DisplayCard): string {
  const linkLines = links.map((link) => `[${link.label}](${link.url})`).join('\n');
  return [title ? `**${title}**` : '', ...texts, linkLines].filter(Boolean).join('\n\n');
}

/**
 * Split `text` into chunks no larger than `limit`, preferring paragraph
 * breaks, then line breaks, then a hard character cut as a last resort.
 * Preserves code fences only structurally — a fenced block that straddles a
 * chunk boundary will render as two independent blocks on the receiving
 * platform, which is the same behavior as manually re-opening a fence.
 */
/**
 * Decode the actual option value from a button callback. Buttons are encoded
 * with an integer index (to keep under Telegram's 64-byte callback_data cap),
 * and the real value is looked up via `resolveQuestionRender(questionId)`.
 * Falls back to treating the tail as a literal value so old in-flight cards
 * (encoded before this shortening landed) still resolve.
 */
function resolveSelectedOption(
  render: { options: NormalizedOption[] } | undefined,
  eventValue: string | undefined,
  tail: string | undefined,
): string {
  const candidate = eventValue ?? tail ?? '';
  if (render && /^\d+$/.test(candidate)) {
    const idx = Number(candidate);
    if (render.options[idx]) return render.options[idx].value;
  }
  return candidate;
}

interface TerminalApprovalCard {
  title: string;
  question: string;
  resolution: string;
}

/**
 * Keep an approval's full context after it resolves. The muted resolution
 * replaces the actions row, making the card visibly inactive without
 * discarding the request an admin decided on.
 */
export function buildTerminalApprovalCard({ title, question, resolution }: TerminalApprovalCard) {
  const children: CardChild[] = [];
  if (question) children.push(CardText(question));
  children.push(CardText(resolution, { style: 'muted' }));
  return Card({ title, children });
}

function terminalApprovalMessage(spec: TerminalApprovalCard) {
  return {
    card: buildTerminalApprovalCard(spec),
    fallbackText: [spec.title, spec.question, spec.resolution].filter(Boolean).join('\n\n'),
  };
}

function isTerminalCard(card: Partial<TerminalApprovalCard> | undefined): card is TerminalApprovalCard {
  return (
    card !== undefined &&
    typeof card.title === 'string' &&
    typeof card.question === 'string' &&
    typeof card.resolution === 'string'
  );
}

/**
 * Hand a click to the host without holding the platform's interaction on the
 * answer's handler. The host logs a handler that fails, and a click is never
 * delivered again, so nothing here waits on it.
 */
function handOnClick(setup: ChannelSetup, ...click: Parameters<ChannelSetup['onAction']>): void {
  void Promise.resolve(setup.onAction(...click)).catch(() => {});
}

export function splitForLimit(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf('\n\n', limit);
    if (cut <= 0) cut = remaining.lastIndexOf('\n', limit);
    if (cut <= 0) cut = remaining.lastIndexOf(' ', limit);
    if (cut <= 0) cut = limit;
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

/**
 * Append platform-rescued text to the serialized body, before `raw` is dropped.
 * No extractor, or nothing recovered, leaves the body byte-identical.
 */
export function appendRawText(
  serialized: Record<string, unknown>,
  raw: Record<string, unknown>,
  extract?: RawTextExtractor,
): void {
  if (!extract) return;
  const extra = extract(raw);
  if (!extra) return;
  const text = typeof serialized.text === 'string' ? serialized.text : '';
  serialized.text = text ? `${text}\n\n${extra}` : extra;
}

export function createChatSdkBridge(config: ChatSdkBridgeConfig): ChannelAdapter {
  const { adapter } = config;
  // The instance name becomes a webhook route segment (the route regex is
  // [^/?]+) and ':' is the state-namespace delimiter — reject anything that
  // would break either, at construction time rather than at first webhook.
  // Positive allow-list (not a deny-list): also rejects '' and
  // whitespace-only names, which are config bugs — '' is falsy, so it
  // would skip a truthiness guard, dead-end the webhook route, and
  // collapse the state namespace into the default instance's keyspace.
  if (config.instance !== undefined && !INSTANCE_KEY_RE.test(config.instance)) {
    throw new Error(
      `chat-sdk bridge instance ${JSON.stringify(config.instance)} must be URL-safe: ` +
        `non-empty, only letters, digits, '.', '_' or '-'`,
    );
  }
  const transformText = (t: string): string => (config.transformOutboundText ? config.transformOutboundText(t) : t);
  /** Registry/routing key for this bridge — also the app-context cache
   *  namespace. Default instances key by the platform name. */
  const instanceKey = config.instance ?? adapter.name;
  /** The adapter's working mark, when it shows one. */
  const working = isWorkingIndicator(adapter) ? adapter : undefined;
  /** Set when requests are text on this platform (ChatSdkBridgeConfig.textRequests). */
  const textRequests = config.textRequests;
  let chat: Chat;
  let state: SqliteStateAdapter;
  let setupConfig: ChannelSetup;
  /** Takes answers in words, when requests are text. */
  let answers: Answers | undefined;
  let gatewayAbort: AbortController | null = null;

  /** Post a request; when requests are text, remember it, so an answer and its outcome find it. */
  async function postRequest(
    tid: string,
    platformId: string,
    questionId: string,
    message: AdapterPostableMessage,
  ): Promise<string | undefined> {
    const result = await adapter.postMessage(tid, message);
    if (textRequests && result?.id) {
      const at = textRequests.postedAt(result.raw);
      const request: PostedRequest = {
        questionId,
        platformId,
        ...(at !== undefined && !Number.isNaN(at.getTime()) ? { postedAt: at.toISOString() } : {}),
      };
      await state.set(postedRequestKey(adapter.name, result.id), request, POSTED_REQUEST_KEPT_MS);
      await state.set(requestMessageKey(adapter.name, questionId), result.id, POSTED_REQUEST_KEPT_MS);
      await indexPostedRequest(state, adapter.name, platformId, result.id, request.postedAt);
    }
    return result?.id;
  }

  /**
   * Whether a message answered a request, which then goes to the request's
   * handler and is not routed. Only when requests are text; a handler that
   * fails rejects, so the platform delivers the message again.
   */
  async function answeredBy(message: ChatMessage, threadId: string, isDM: boolean): Promise<boolean> {
    if (!answers) return false;
    const quote = config.extractReplyContext && message.raw ? config.extractReplyContext(message.raw) : null;
    return answers.takeMessage({
      id: message.id,
      platformId: adapter.channelIdFromThreadId(threadId),
      userId: message.author.userId,
      isMe: message.author.isMe === true,
      isDM,
      at: message.metadata.dateSent,
      text: message.text,
      ...(quote === null ? {} : { quote: quote.id === undefined ? {} : { messageId: quote.id } }),
    });
  }

  /**
   * The message an outcome for this question goes on: the one the handler
   * named, when this question was posted as it, or else the question's
   * newest posting.
   */
  async function requestMessage(questionId: string, named: string | undefined): Promise<string | undefined> {
    if (named !== undefined && (await readPostedRequest(state, adapter.name, named))?.questionId === questionId) {
      return named;
    }
    return (await state.get<string>(requestMessageKey(adapter.name, questionId))) ?? named;
  }

  /**
   * Edit a request posted as text to the outcome its handler sent, addressed
   * by its question id. Showing its outcome, the message takes no answer
   * after this.
   */
  async function editRequestOutcome(tid: string, questionId: string, content: Record<string, unknown>): Promise<void> {
    const messageId = await requestMessage(
      questionId,
      typeof content.messageId === 'string' ? content.messageId : undefined,
    );
    if (messageId === undefined) {
      log.warn('No posted request to show its outcome on', { questionId });
      return;
    }
    const terminal = content.terminalCard as Partial<TerminalApprovalCard> | undefined;
    const render = await resolveQuestionRender(questionId);
    const outcome: AdapterPostableMessage =
      render?.renderTerminal && typeof terminal?.resolution === 'string'
        ? render.renderTerminal(terminal.resolution)
        : isTerminalCard(terminal)
          ? { markdown: transformText(textOutcome(terminal)) }
          : { markdown: transformText((content.text as string) || (content.markdown as string) || '') };
    await adapter.editMessage(tid, messageId, outcome);
    await state.delete(postedRequestKey(adapter.name, messageId));
    if ((await state.get<string>(requestMessageKey(adapter.name, questionId))) === messageId) {
      await state.delete(requestMessageKey(adapter.name, questionId));
    }
  }

  async function messageToInbound(
    message: ChatMessage,
    isMention: boolean,
    isGroup?: boolean,
  ): Promise<InboundMessage> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const serialized = message.toJSON() as Record<string, any>;

    // Download attachment data before serialization loses fetchData()
    if (message.attachments && message.attachments.length > 0) {
      const enriched = [];
      for (const att of message.attachments) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const entry: Record<string, any> = {
          type: att.type,
          name: att.name,
          mimeType: att.mimeType,
          size: att.size,
          width: (att as unknown as Record<string, unknown>).width,
          height: (att as unknown as Record<string, unknown>).height,
        };
        if (att.fetchData) {
          try {
            const buffer = await att.fetchData();
            entry.data = buffer.toString('base64');
          } catch (err) {
            log.warn('Failed to download attachment', { type: att.type, err });
          }
        }
        enriched.push(entry);
      }
      serialized.attachments = enriched;
    }

    // Recover platform content the Chat SDK omitted, while raw is still here.
    if (message.raw) {
      appendRawText(serialized, message.raw as Record<string, unknown>, config.extractRawText);
    }

    // Extract reply context via platform-specific hook
    if (config.extractReplyContext && message.raw) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const replyTo = config.extractReplyContext(message.raw as Record<string, any>);
      if (replyTo) serialized.replyTo = replyTo;
    }

    // Project chat-sdk's nested author into the flat sender fields the router
    // expects (see src/router.ts extractAndUpsertUser). Native adapters already
    // populate these directly; this brings chat-sdk adapters in line.
    const author = serialized.author as { userId?: string; fullName?: string; userName?: string } | undefined;
    if (author) {
      const name = author.fullName ?? author.userName;
      serialized.senderId = author.userId;
      serialized.sender = name;
      serialized.senderName = name;
    }

    // Drop raw to save DB space (can be very large)
    serialized.raw = undefined;

    return {
      id: message.id,
      kind: 'chat-sdk',
      content: serialized,
      timestamp: message.metadata.dateSent.toISOString(),
      isMention,
      isGroup,
      authenticatedSender: authenticatedSenderOf(message.author),
      ...(config.redelivers === true ? { deduplicate: true } : {}),
    };
  }

  /**
   * A reaction as the router takes it (InboundMessage.reaction): its own id,
   * so a redelivery is dropped, and quiet unless it is on the assistant's own
   * message. Its content names who reacted, the emoji by the name
   * add_reaction takes, and the message reacted to as an excerpt; it carries
   * no text, so nothing reads it as something written.
   */
  function reactionToInbound(reaction: InboundReaction, isGroup: boolean | undefined): InboundMessage {
    const reactor = reaction.user.fullName || reaction.user.userName || reaction.user.userId;
    const target = reaction.message.author;
    const self = target.isMe === true;
    return {
      id: reaction.reactionName,
      kind: 'chat-sdk',
      content: {
        sender: reactor,
        senderId: reaction.user.userId,
        senderName: reactor,
        reaction: {
          emoji: reaction.emoji.name,
          target: {
            self,
            sender: target.fullName || target.userName || target.userId,
            excerpt: excerpt(reaction.message.text),
          },
        },
      },
      timestamp: reaction.reactedAt.toISOString(),
      isMention: false,
      isGroup,
      authenticatedSender: authenticatedSenderOf(reaction.user),
      reaction: true,
      ...(self ? {} : { quiet: true }),
      ...(config.redelivers === true ? { deduplicate: true } : {}),
    };
  }

  const bridge: ChannelAdapter = {
    name: config.instance ?? adapter.name,
    channelType: adapter.name, // unchanged — semantic platform key
    instance: config.instance, // undefined ⇒ default instance

    supportsThreads: config.supportsThreads,
    defaults: config.defaults,

    async setup(hostConfig: ChannelSetup) {
      // Apply the registered inbound policy (if any) for this channel type.
      // Wrapping here — the single point every dispatch path reads back
      // through — means one policy covers onSubscribedMessage, onNewMention,
      // onDirectMessage and onNewMessage alike.
      const inboundPolicy = bridgeInboundPolicies.get(adapter.name);
      setupConfig = inboundPolicy ? await inboundPolicy(hostConfig, instanceKey) : hostConfig;

      // State namespace: ONLY for a named non-default instance. A skill
      // that explicitly names the primary instance after the platform
      // (instance === adapter.name) still lands on the legacy UNPREFIXED
      // keyspace — prefixing the default would orphan every live install's
      // chat_sdk_subscriptions/kv/locks/lists rows.
      state = new SqliteStateAdapter(config.instance && config.instance !== adapter.name ? config.instance : undefined);
      if (textRequests) {
        answers = createAnswers({
          state,
          adapterName: adapter.name,
          postedRequest: (messageId) => readPostedRequest(state, adapter.name, messageId),
          render: resolveQuestionRender,
          // The answering conversation and the request's message, so a durable gateway hold checks its own address.
          dispatch: async (answer) => {
            await setupConfig.onAction(
              answer.questionId,
              answer.value,
              answer.userId,
              { instance: instanceKey, messageId: answer.messageId, platformId: answer.platformId },
              { deferResolution: true, ...(answer.reason === undefined ? {} : { reason: answer.reason }) },
            );
          },
          ...(adapter.userName ? { selfMention: `@${adapter.userName}` } : {}),
        });
      }

      chat = new Chat({
        adapters: { [adapter.name]: adapter },
        userName: adapter.userName || 'NanoClaw',
        concurrency: config.concurrency ?? 'concurrent',
        state,
        logger: 'silent',
      });

      // Four SDK dispatch paths — bridge just forwards. All per-wiring
      // engage / accumulate / drop / subscribe decisions live in the host
      // router (src/router.ts routeInbound / evaluateEngage). The bridge
      // only resolves channel ids and sets the platform-confirmed isMention
      // flag that routeInbound evaluates; the router calls back into
      // bridge.subscribe(...) when a mention-sticky wiring engages.

      // Subscribed threads — every message in a thread we've previously
      // engaged. Carry the SDK's `message.isMention` through so mention-mode
      // wirings still fire on in-thread mentions.
      chat.onSubscribedMessage(async (thread, message) => {
        if (await answeredBy(message, thread.id, false)) return;
        const channelId = adapter.channelIdFromThreadId(thread.id);
        await setupConfig.onInbound(
          channelId,
          thread.id,
          await messageToInbound(message, message.isMention === true, true),
        );
      });

      // @mention in an unsubscribed thread — SDK-confirmed bot mention.
      chat.onNewMention(async (thread, message) => {
        if (await answeredBy(message, thread.id, false)) return;
        const channelId = adapter.channelIdFromThreadId(thread.id);
        await setupConfig.onInbound(channelId, thread.id, await messageToInbound(message, true, true));
      });

      // DMs — by definition addressed to the bot. Thread id flows through
      // unmodified (Slack users can open sub-threads inside a DM); whether it
      // is honored is policy, not transport: the channel's declared
      // dm.threads default (ChannelDefaults) or a per-wiring threads override
      // decides at router fanout whether replies land in-thread or all DM
      // sub-threads collapse into the one DM session.
      chat.onDirectMessage(async (thread, message) => {
        const channelId = adapter.channelIdFromThreadId(thread.id);
        log.info('Inbound DM received', {
          adapter: adapter.name,
          channelId,
          sender: (message.author as any)?.fullName ?? (message.author as any)?.userId ?? 'unknown',
          threadId: thread.id,
        });
        if (await answeredBy(message, thread.id, true)) return;
        const inbound = await messageToInbound(message, true, false);
        // Agent-mode app context: DM-only by platform design.
        attachAppContext(
          inbound.content as Record<string, unknown>,
          instanceKey,
          channelId,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (message.author as any)?.userId,
        );
        const dmThreadId = normalizeDmThreadId(thread.id, message.id);
        await setupConfig.onInbound(channelId, dmThreadId, inbound);
      });

      // Plain messages in unsubscribed threads.
      //
      // Chat SDK dispatch (handling-events.mdx §"Handler dispatch order") is
      // exclusive: subscribed → onSubscribedMessage; unsubscribed+mention →
      // onNewMention; unsubscribed+pattern-match → onNewMessage. Registering
      // with `/[\s\S]*/` lets the router see every plain message (including
      // media-only messages with empty text) on every unsubscribed thread the
      // getMessagingGroupWithAgentCount (~1 DB read) for unwired channels,
      // so forwarding every one is cheap enough to not need a bridge-side
      // flood gate.
      chat.onNewMessage(/[\s\S]*/, async (thread, message) => {
        if (await answeredBy(message, thread.id, false)) return;
        const channelId = adapter.channelIdFromThreadId(thread.id);
        await setupConfig.onInbound(channelId, thread.id, await messageToInbound(message, false, true));
      });

      // Agent-mode assistant context: cache the latest "what the user is
      // viewing" per (channel, user). The installed chat core (4.40.0)
      // dispatches both the legacy assistant_thread_started and the
      // agent_view app_context_changed events into these handlers.
      const rememberAppContext = (event: AssistantThreadStartedEvent | AssistantContextChangedEvent): void => {
        cacheAppContext(instanceKey, event.channelId, event.userId, appContextEntities(event));
      };
      chat.onAssistantThreadStarted((event) => {
        rememberAppContext(event);
        dispatchAgentDmOpened({ instance: instanceKey, channelId: event.channelId });
      });
      chat.onAssistantContextChanged(rememberAppContext);

      // Membership events: forwarded to the handler registered for this
      // channel type (setMembershipHandler); no-op when none is registered.
      // The chat core dispatches only member_joined_channel;
      // member_left_channel arrives at the adapter but has no SDK handler
      // in 4.40.0.
      // TODO(member-left): when the chat core grows an onMemberLeftChannel
      // dispatch, register it here and forward with { left: true } — the
      // MembershipEvent type and dispatchMembership already carry it.
      chat.onMemberJoinedChannel((event) => {
        dispatchMembership({
          instance: instanceKey,
          channelType: adapter.name,
          channelId: event.channelId,
          userId: event.userId,
          inviterId: event.inviterId,
        });
      });

      // Handle button clicks (ask_user_question)
      chat.onAction(async (event) => {
        if (await dispatchQuestionAction(event, adapter, instanceKey)) return;
        if (!event.actionId.startsWith('ncq:')) return;
        const parts = event.actionId.split(':');
        if (parts.length < 3) return;
        const questionId = parts[1];
        const tail = parts.slice(2).join(':');
        const userId = event.user?.userId || '';

        // Resolve render metadata BEFORE dispatching onAction (which deletes the row).
        const render = await resolveQuestionRender(questionId);
        // New format: button id/value is an integer index into options (kept
        // short to fit Telegram's 64-byte callback_data cap). Old format:
        // the full value is embedded in actionId/value directly.
        const selectedOption = resolveSelectedOption(render, event.value, tail);
        const address = {
          instance: instanceKey,
          messageId: event.messageId,
          platformId: adapter.channelIdFromThreadId(event.threadId),
        };
        // The handler that authorizes the answer shows its outcome: a
        // presentation that defers resolution asks for that, and text
        // requests always do.
        if (render?.deferResolution || textRequests) {
          await setupConfig.onAction(questionId, selectedOption, userId, address, { deferResolution: true });
          return;
        }
        const title = render?.title ?? '❓ Question';
        const matched = render?.options.find((o) => o.value === selectedOption);
        const selectedLabel = matched?.selectedLabel ?? selectedOption ?? '(clicked)';

        // Update the card to show the selected answer, who acted, and remove buttons
        const actorName = event.user?.userName || event.user?.fullName || '';
        const resolution = actorName ? `${selectedLabel} by ${actorName}` : selectedLabel;
        try {
          const tid = event.threadId;
          await adapter.editMessage(
            tid,
            event.messageId,
            render?.question
              ? terminalApprovalMessage({ title, question: render.question, resolution })
              : { markdown: `${title}\n\n${resolution}` },
          );
        } catch (err) {
          log.warn('Failed to update card after action', { err });
        }

        await setupConfig.onAction(questionId, selectedOption, userId, address);
      });

      // Reactions the adapter reads itself (ReactionSource), registered
      // before initialize starts its reading. Awaited: a reaction the router
      // or an answer's handler could not take rejects back to the adapter.
      // One that answers a request goes to its handler, not the router. In a
      // DM, the thread is the reacted message's own, as a direct message's is.
      if (isReactionSource(adapter)) {
        adapter.setReactionHandler(async (reaction) => {
          const platformId = adapter.channelIdFromThreadId(reaction.threadId);
          const answered = await answers?.takeReaction({
            id: reaction.reactionName,
            platformId,
            userId: reaction.user.userId,
            isMe: reaction.user.isMe === true,
            emoji: reaction.emoji.name,
            messageId: reaction.message.id,
          });
          if (answered === true) return;
          const isDM = adapter.isDM?.(reaction.threadId);
          await setupConfig.onInbound(
            platformId,
            isDM === true ? normalizeDmThreadId(reaction.threadId, reaction.message.id) : reaction.threadId,
            reactionToInbound(reaction, isDM === undefined ? undefined : !isDM),
          );
        });
      }

      await chat.initialize();

      // Test seam: unit tests drive the SDK's public process* dispatchers
      // (processAssistantContextChanged, …) against the handlers registered
      // above without a live platform. Not part of the ChannelAdapter
      // contract.
      (bridge as unknown as { _chat?: Chat })._chat = chat;

      // Start Gateway listener for adapters that support it (e.g., Discord)
      const gatewayAdapter = adapter as GatewayAdapter;
      if (gatewayAdapter.startGatewayListener) {
        gatewayAbort = new AbortController();

        // Start local HTTP server to receive forwarded Gateway events (including interactions)
        const webhookUrl = await startLocalWebhookServer(gatewayAdapter, setupConfig, config.botToken);

        // Exponential backoff capped at 1h. Without this, an unrecoverable
        // failure (e.g., TokenInvalid) restarts ~10×/sec and Discord's
        // Cloudflare layer issues a multi-hour IP block. A run that lasts
        // longer than 5 minutes counts as healthy and resets the counter.
        let consecutiveFailures = 0;
        const startGateway = () => {
          if (gatewayAbort?.signal.aborted) return;
          const startedAt = Date.now();
          // Capture the long-running listener promise via waitUntil
          let listenerPromise: Promise<unknown> | undefined;
          void gatewayAdapter.startGatewayListener!(
            {
              waitUntil: (p: Promise<unknown>) => {
                listenerPromise = p;
              },
            },
            24 * 60 * 60 * 1000,
            gatewayAbort!.signal,
            webhookUrl,
          ).then(() => {
            // startGatewayListener resolves immediately with a Response;
            // the actual work is in the listenerPromise passed to waitUntil
            if (!listenerPromise) return;
            const reschedule = (err?: unknown) => {
              if (gatewayAbort?.signal.aborted) return;
              const ranForMs = Date.now() - startedAt;
              if (ranForMs > 5 * 60 * 1000) consecutiveFailures = 0;
              else consecutiveFailures++;
              const delayMs = Math.min(60 * 60 * 1000, 2 ** consecutiveFailures * 1000);
              if (err) {
                log.error('Gateway listener error, retrying', {
                  adapter: adapter.name,
                  err,
                  consecutiveFailures,
                  delayMs,
                });
              } else {
                log.info('Gateway listener expired, restarting', {
                  adapter: adapter.name,
                  consecutiveFailures,
                  delayMs,
                });
              }
              setTimeout(startGateway, delayMs);
            };
            void listenerPromise.then(() => reschedule()).catch(reschedule);
          });
        };
        startGateway();
        log.info('Gateway listener started', { adapter: adapter.name });
      } else if ('runtimeMode' in adapter && adapter.runtimeMode === 'polling') {
        // Polling adapters (Telegram) pull updates themselves; a route here
        // would only bind the shared webhook port for nothing. Read after
        // initialize(): the adapter resolves mode 'auto' there.
        log.info('Polling adapter: no webhook route registered', { adapter: adapter.name });
      } else {
        // Non-gateway adapters (Slack, Teams, GitHub, etc.) — register on the
        // shared webhook server. The handler key stays adapter.name (the
        // Chat instance's webhooks map is keyed by it); the route segment is
        // the instance, so each same-platform bridge gets its own URL (and
        // its own signing secret — platforms sign per-app).
        registerWebhookAdapter(chat, adapter.name, config.instance ?? adapter.name);
      }

      log.info('Chat SDK bridge initialized', { adapter: adapter.name });
    },

    async deliver(platformId: string, threadId: string | null, message): Promise<string | undefined> {
      // platformId is already in the adapter's encoded format (e.g. "telegram:6037840640",
      // "discord:guildId:channelId") — use it directly as the thread ID
      const tid = threadId ?? platformId;
      const content = message.content as Record<string, unknown>;

      // A request's outcome, from the handler that resolved an answer to it.
      if (textRequests && content.operation === 'edit' && typeof content.questionId === 'string') {
        await editRequestOutcome(tid, content.questionId, content);
        return;
      }

      if (content.operation === 'edit' && content.messageId) {
        // An open text request still takes answers as posted, so rewording it
        // would have its approver decide something other than what they read.
        // Only its handler's outcome, addressed by question id, edits it.
        if (textRequests && (await readPostedRequest(state, adapter.name, content.messageId as string))) {
          throw new Error(`refused an edit to the open request posted as ${String(content.messageId)}`);
        }
        const render =
          typeof content.questionId === 'string' ? await resolveQuestionRender(content.questionId) : undefined;
        if (render?.renderTerminal && content.terminalCard) {
          const terminal = content.terminalCard as { resolution: string };
          await adapter.editMessage(tid, content.messageId as string, render.renderTerminal(terminal.resolution));
          return;
        }
        const terminalCard = content.terminalCard as Partial<TerminalApprovalCard> | undefined;
        if (isTerminalCard(terminalCard)) {
          await adapter.editMessage(tid, content.messageId as string, terminalApprovalMessage(terminalCard));
        } else {
          await adapter.editMessage(tid, content.messageId as string, {
            markdown: transformText((content.text as string) || (content.markdown as string) || ''),
          });
        }
        return;
      }

      if (content.operation === 'reaction' && content.messageId && content.emoji) {
        await adapter.addReaction(tid, content.messageId as string, content.emoji as string);
        return;
      }

      // Ask question — a Card with buttons, or words when requests are text
      if (content.type === 'ask_question' && content.questionId && content.options) {
        const questionId = content.questionId as string;
        const title = content.title as string;
        const question = content.question as string;
        if (!title) {
          log.error('ask_question missing required title — skipping delivery', { questionId });
          return;
        }
        const render = content.requirePresentation ? await resolveQuestionRender(questionId) : undefined;
        if (render?.renderMessage) {
          return postRequest(tid, platformId, questionId, render.renderMessage(questionId));
        }
        if (content.requirePresentation) throw new Error('Approval presentation adapter is unavailable');
        const options: NormalizedOption[] = normalizeOptions(content.options as never);
        if (textRequests) {
          const words = textRequest(title, typeof question === 'string' ? question : '', options);
          return postRequest(tid, platformId, questionId, { markdown: transformText(words) });
        }
        const card = Card({
          title,
          children: [
            CardText(question),
            Actions(
              // Encode button id/value with the option index rather than the
              // full value. Telegram caps callback_data at 64 bytes, and
              // long values (e.g. ISO datetimes, URLs) push the JSON payload
              // well past that. The onAction handlers resolve the index back
              // to the real value via resolveQuestionRender(questionId).
              options.map((opt, idx) =>
                Button({ id: `ncq:${questionId}:${idx}`, label: opt.label, value: String(idx), style: opt.style }),
              ),
            ),
          ],
        });
        const result = await adapter.postMessage(tid, {
          card,
          fallbackText: `${title}\n\n${question}\nOptions: ${options.map((o) => o.label).join(', ')}`,
        });
        return result?.id;
      }

      // Display card (send_card MCP tool) — returns immediately, no callback flow.
      // URL actions render as link buttons, or as links when requests are text.
      if (content.type === 'card' && content.card && typeof content.card === 'object') {
        const cardSpec = content.card as Record<string, unknown>;
        const display = readDisplayCard(cardSpec);
        if (display.texts.length === 0 && display.links.length === 0 && !display.title) {
          log.warn('send_card payload empty, skipping delivery');
          return;
        }
        if (textRequests) {
          const result = await adapter.postMessage(tid, { markdown: transformText(textDisplayCard(display)) });
          return result?.id;
        }

        const fallbackText =
          (content.fallbackText as string) || (cardSpec.description as string) || display.title || '';
        const cardChildren: CardChild[] = display.texts.map((child) => CardText(child));
        if (display.links.length > 0) cardChildren.push(Actions(display.links.map((link) => LinkButton(link))));
        const card = Card({ title: display.title, children: cardChildren });
        const result = await adapter.postMessage(tid, { card, fallbackText });
        return result?.id;
      }

      // Normal message
      const rawText = (content.markdown as string) || (content.text as string);
      const text = rawText ? transformText(rawText) : rawText;
      if (text) {
        // Attach files if present (FileUpload format: { data, filename })
        const fileUploads = message.files?.map((f: { data: Buffer; filename: string }) => ({
          data: f.data,
          filename: f.filename,
        }));
        // Split if over the adapter's max length. Files ride on the first
        // chunk so the head of the reply still carries them.
        const chunks =
          config.maxTextLength && text.length > config.maxTextLength
            ? splitForLimit(text, config.maxTextLength)
            : [text];
        let firstId: string | undefined;
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          const attachFiles = i === 0 && fileUploads && fileUploads.length > 0;
          const result = await adapter.postMessage(
            tid,
            attachFiles ? { markdown: chunk, files: fileUploads } : { markdown: chunk },
          );
          if (i === 0) firstId = result?.id;
        }
        return firstId;
      } else if (message.files && message.files.length > 0) {
        // Files only, no text
        const fileUploads = message.files.map((f: { data: Buffer; filename: string }) => ({
          data: f.data,
          filename: f.filename,
        }));
        const result = await adapter.postMessage(tid, { markdown: '', files: fileUploads });
        return result?.id;
      }
    },

    async setTyping(
      platformId: string,
      threadId: string | null,
      _status?: string,
      _statusKind?: 'auto' | 'agent',
      anchor?: string,
    ) {
      const tid = threadId ?? platformId;
      await adapter.startTyping(tid);
      if (anchor !== undefined && working) await working.workingOn(tid, anchor);
    },

    async teardown() {
      gatewayAbort?.abort();
      await chat.shutdown();
      log.info('Chat SDK bridge shut down', { adapter: adapter.name });
    },

    isConnected() {
      const probe = (adapter as ConnectionAwareAdapter).isConnected;
      return probe ? probe.call(adapter) : true;
    },

    async subscribe(_platformId: string, threadId: string) {
      // Chat SDK's subscription state lives on the StateAdapter (not on the
      // Chat instance itself). SqliteStateAdapter.subscribe is idempotent —
      // a second call on an already-subscribed thread is a no-op. threadId
      // is the SDK's thread id, which is what the router already has from
      // the original inbound event.
      await state.subscribe(threadId);
    },
  };

  // Only an adapter that marks the message a turn works on has an end to take.
  if (working) {
    bridge.endTyping = async (platformId: string, threadId: string | null, anchor: string): Promise<void> => {
      await working.endWorking(threadId ?? platformId, anchor);
    };
  }

  // Only expose openDM when the underlying Chat SDK adapter implements it.
  // Delegate straight to adapter.openDM rather than going through chat.openDM:
  // the latter dispatches via inferAdapterFromUserId, which only recognizes
  // Discord snowflakes, Slack U-ids, Teams 29:-ids, and gChat users/-ids, and
  // throws for everything else (Telegram numeric ids, iMessage, Matrix, …).
  // Calling adapter.openDM directly also preserves the adapter's native
  // platform_id encoding via channelIdFromThreadId (e.g. "telegram:<chatId>"),
  // which matches what onInbound stores in messaging_groups — avoiding a
  // duplicate-row / decode-error cascade at delivery time. See user-dm.ts for
  // the direct-addressable fallback when the adapter has no openDM at all.
  if (adapter.openDM) {
    bridge.openDM = async (userHandle: string): Promise<string> => {
      const threadId = await adapter.openDM!(userHandle);
      return adapter.channelIdFromThreadId(threadId);
    };
  }

  return bridge;
}

/**
 * Start a local HTTP server to receive forwarded Gateway events.
 * This is needed because the Gateway listener in webhook-forwarding mode
 * sends ALL raw events (including INTERACTION_CREATE for button clicks)
 * to the webhookUrl, which we handle here.
 *
 * Loopback is not a trust boundary, so only our own Gateway listener may post
 * here: it sends the bot token in x-discord-gateway-token on every forward.
 */
function startLocalWebhookServer(
  adapter: GatewayAdapter,
  setupConfig: ChannelSetup,
  botToken?: string,
): Promise<string> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (!gatewayTokenMatches(req.headers['x-discord-gateway-token'], botToken)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end('{"error":"unauthorized"}');
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        handleForwardedEvent(body, adapter, setupConfig, botToken)
          .then(() => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"ok":true}');
          })
          .catch((err) => {
            log.error('Webhook server error', { err });
            res.writeHead(500);
            res.end('{"error":"internal"}');
          });
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      const url = `http://127.0.0.1:${addr.port}/webhook`;
      log.info('Local webhook server started', { port: addr.port });
      resolve(url);
    });
  });
}

/** Constant-time check; hashing first keeps the lengths equal. No token configured means no match. */
function gatewayTokenMatches(header: string | string[] | undefined, botToken: string | undefined): boolean {
  if (!botToken || typeof header !== 'string') return false;
  const digest = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(digest(header), digest(botToken));
}

async function handleForwardedEvent(
  body: string,
  adapter: GatewayAdapter,
  setupConfig: ChannelSetup,
  botToken?: string,
): Promise<void> {
  let event: { type: string; data: Record<string, unknown> };
  try {
    event = JSON.parse(body);
  } catch {
    return;
  }

  // Handle interaction events (button clicks) — not handled by adapter's handleForwardedGatewayEvent
  if (event.type === 'GATEWAY_INTERACTION_CREATE' && event.data) {
    const interaction = event.data;
    // type 3 = MessageComponent (button/select)
    if (interaction.type === 3) {
      const customId = (interaction.data as Record<string, unknown>)?.custom_id as string;
      // In guilds the clicker is at interaction.member.user; in DMs it's interaction.user directly.
      const user =
        ((interaction.member as Record<string, unknown>)?.user as Record<string, string> | undefined) ??
        (interaction.user as Record<string, string> | undefined);
      const interactionId = interaction.id as string;
      const interactionToken = interaction.token as string;

      // Parse the selected option from custom_id
      let questionId: string | undefined;
      let tail: string | undefined;
      if (customId?.startsWith('ncq:')) {
        const colonIdx = customId.indexOf(':', 4); // after "ncq:"
        if (colonIdx !== -1) {
          questionId = customId.slice(4, colonIdx);
          tail = customId.slice(colonIdx + 1);
        }
      }

      // Update the card to show the selected answer and remove buttons
      const originalEmbeds =
        ((interaction.message as Record<string, unknown>)?.embeds as Array<Record<string, unknown>>) || [];
      const originalDescription = (originalEmbeds[0]?.description as string) || '';
      const render = questionId ? await resolveQuestionRender(questionId) : undefined;
      // Discord custom_id mirrors the new index-based encoding (see Button
      // construction). Decode back to the real option value for downstream.
      const selectedOption = resolveSelectedOption(render, tail, tail);
      if (render?.deferResolution && questionId) {
        await fetch(`https://discord.com/api/v10/interactions/${interactionId}/${interactionToken}/callback`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 6 }),
        });
        handOnClick(
          setupConfig,
          questionId,
          selectedOption,
          user?.id || '',
          {
            messageId: (interaction.message as Record<string, unknown> | undefined)?.id as string | undefined,
            platformId: interaction.channel_id as string | undefined,
          },
          { deferResolution: true },
        );
        return;
      }
      const cardTitle = render?.title ?? ((originalEmbeds[0]?.title as string) || '❓ Question');
      const matchedOpt = render?.options.find((o) => o.value === selectedOption);
      const selectedLabel = matchedOpt?.selectedLabel ?? selectedOption ?? customId;
      const actorName = user?.global_name || user?.username || '';
      const resolution = actorName ? `${selectedLabel} by ${actorName}` : selectedLabel;
      try {
        await fetch(`https://discord.com/api/v10/interactions/${interactionId}/${interactionToken}/callback`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 7, // UPDATE_MESSAGE — acknowledge + update in one call
            data: {
              embeds: [
                {
                  title: cardTitle,
                  description: originalDescription || render?.question || '',
                  footer: { text: resolution },
                },
              ],
              components: [], // remove buttons
            },
          }),
        });
      } catch (err) {
        log.error('Failed to update interaction', { err });
      }

      // Dispatch to host
      if (questionId && selectedOption) {
        handOnClick(setupConfig, questionId, selectedOption, user?.id || '', {
          messageId: (interaction.message as Record<string, unknown> | undefined)?.id as string | undefined,
          platformId: interaction.channel_id as string | undefined,
        });
      }
      return;
    }
  }

  // Forward other events to the adapter's webhook handler for normal processing
  const fakeRequest = new Request('http://localhost/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-discord-gateway-token': botToken || '',
    },
    body,
  });
  await adapter.handleWebhook(fakeRequest, {});
}
