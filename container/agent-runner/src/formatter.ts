import { showsWorkingIndicator } from './acknowledge.js';
import { findByRouting } from './destinations.js';
import type { MessageInRow } from './db/messages-in.js';
import { TIMEZONE, formatLocalTime, formatLocalStamp } from './timezone.js';
import './providers/index.js';
import './provider-contracts/index.js';
import { getProviderRuntimeContract } from './providers/provider-registry.js';
import { commandText, slashCommandName, withoutBotSuffix } from './slash-command.generated.js';

/**
 * channel_type marking cross-session context copies (accumulate fan-out from
 * the agent group's other sessions). Echo rows are ambient context only: they
 * never provide reply routing, never count as commands, and render as
 * <cross-session-context> blocks.
 */
export const SESSION_ECHO_CHANNEL = 'session-echo';

export function isSessionEcho(msg: MessageInRow): boolean {
  return msg.channel_type === SESSION_ECHO_CHANNEL;
}

/**
 * Content flag the runner sets on its own failure notices. The host passes
 * a2a content through unchanged, so the flag reaches the receiving agent and
 * a failure there sends no notice back (never answer an error with an error).
 */
export const FAILURE_NOTICE_FIELD = 'failureNotice';

/** Notice text when the provider gave no error of its own. */
export const GENERIC_FAILURE_NOTICE =
  "Sorry, something went wrong and I couldn't answer. Whoever runs this NanoClaw can look into it using the logs: https://docs.nanoclaw.dev/operate/troubleshooting#start-here";

export function isFailureNotice(msg: MessageInRow): boolean {
  try {
    return JSON.parse(msg.content)?.[FAILURE_NOTICE_FIELD] === true;
  } catch {
    return false;
  }
}

/**
 * Content flag the host sets on a task created to come back as a turn of its
 * conversation (`ncl tasks create --in-conversation`). Any other task is an
 * isolated run wherever its row sits, a v1-ported one in a conversation's
 * session included.
 */
const IN_CONVERSATION_FIELD = 'inConversation';

function isConversationTask(msg: MessageInRow): boolean {
  try {
    return JSON.parse(msg.content)?.[IN_CONVERSATION_FIELD] === true;
  } catch {
    return false;
  }
}

/**
 * Command categories for messages starting with '/'.
 * - admin: sender must be in NANOCLAW_ADMIN_USER_IDS
 * - filtered: silently drop (mark completed without processing)
 * - passthrough: pass raw to the agent (no XML wrapping)
 * - none: not a command — format normally
 */
export type CommandCategory = 'admin' | 'filtered' | 'passthrough' | 'none';

/** Commands the runner itself handles, whatever provider is active. */
const RUNNER_ADMIN_COMMANDS = ['/clear', '/upload-trace'];

interface CommandSets {
  admin: ReadonlySet<string>;
  filtered: ReadonlySet<string>;
}

const commandSetsByProvider = new Map<string, CommandSets>();

/**
 * The command lists for the ACTIVE provider: the runner's own commands plus
 * the native admin/filtered commands its contract declares. Another
 * registered contract's lists are never consulted — a session runs exactly
 * one provider. A provider without a contract contributes nothing.
 */
// What the formatter applied to every provider before runtime contracts
// existed. Only the contractless fallback reads these; a declared contract
// supplies its own lists.
const LEGACY_NATIVE_ADMIN_COMMANDS = ['/remote-control', '/compact', '/context', '/cost', '/files'];
const LEGACY_NATIVE_FILTERED_COMMANDS = ['/help', '/login', '/logout', '/doctor', '/config', '/start'];

function commandSets(providerName: string): CommandSets {
  const cached = commandSetsByProvider.get(providerName);
  if (cached) return cached;
  const contract = getProviderRuntimeContract(providerName);
  const sets: CommandSets = {
    // A provider with no contract keeps the lists the formatter hard-coded
    // before contracts existed, so a pre-contract payload sees no change.
    admin: new Set([...RUNNER_ADMIN_COMMANDS, ...(contract?.commands.nativeAdmin ?? LEGACY_NATIVE_ADMIN_COMMANDS)]),
    filtered: new Set(contract?.commands.nativeFiltered ?? LEGACY_NATIVE_FILTERED_COMMANDS),
  };
  commandSetsByProvider.set(providerName, sets);
  return sets;
}

export interface CommandInfo {
  category: CommandCategory;
  command: string; // the command name (e.g., '/clear')
  text: string; // full text; a command's `@botname` suffix is dropped
  senderId: string | null;
}

/**
 * Categorize a message as a command or not.
 * Only applies to chat/chat-sdk messages. `providerName` is the active
 * provider whose contract supplies the native command lists.
 *
 * The extracted `senderId` is compared against `NANOCLAW_ADMIN_USER_IDS`
 * which stores ids in the namespaced form `<channel_type>:<raw>` (see
 * src/db/users.ts). chat-sdk-bridge serializes `author.userId` as a raw
 * platform id with no prefix, so we prefix it here. If the id already
 * contains a `:` we assume it's pre-namespaced (non-chat-sdk adapters
 * that populate `senderId` directly) and leave it alone.
 */
export function categorizeMessage(msg: MessageInRow, providerName: string): CommandInfo {
  const text = commandText(msg.content);
  const senderId = extractSenderId(msg, parseContent(msg.content));

  // Cross-session echo rows are ambient copies of another conversation —
  // a copied "/clear" etc. must never execute here. Nor may a failure
  // notice whose error text happens to start with a slash.
  // The host gate names commands with the same parse (slash-command.generated.ts).
  const command = isSessionEcho(msg) || isFailureNotice(msg) ? null : slashCommandName(text);
  if (command === null) {
    return { category: 'none', command: '', text, senderId };
  }

  const dispatchText = withoutBotSuffix(text);
  const commands = commandSets(providerName);
  if (commands.admin.has(command)) {
    return { category: 'admin', command, text: dispatchText, senderId };
  }

  if (commands.filtered.has(command)) {
    return { category: 'filtered', command, text: dispatchText, senderId };
  }

  return { category: 'passthrough', command, text: dispatchText, senderId };
}

/**
 * Narrow check for /clear — the only command the runner handles directly.
 * All other command gating (filtered, admin) is done by the host router
 * before messages reach the container.
 */
export function isClearCommand(msg: MessageInRow): boolean {
  if (isSessionEcho(msg) || isFailureNotice(msg)) return false;
  // Exact name, never a prefix: the host gate only admin-checks '/clear'.
  return slashCommandName(commandText(msg.content)) === '/clear';
}

/**
 * True for any chat that needs the outer loop's command path: /clear plus
 * admin/passthrough slash commands the SDK can only dispatch when they are
 * a query's first input. Used by the follow-up poller to bail out and let
 * the outer loop reopen the query.
 */
export function isRunnerCommand(msg: MessageInRow, providerName: string): boolean {
  if (msg.kind !== 'chat' && msg.kind !== 'chat-sdk') return false;
  const cat = categorizeMessage(msg, providerName).category;
  return cat === 'admin' || cat === 'passthrough';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractSenderId(msg: MessageInRow, content: any): string | null {
  return namespacedUserId(msg, content?.senderId || content?.author?.userId);
}

function namespacedUserId(msg: MessageInRow, raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  // Already namespaced (e.g. "telegram:123") — use as-is.
  if (raw.includes(':')) return raw;
  // Raw platform id from chat-sdk serialization — prefix with channel type.
  if (!msg.channel_type) return raw;
  return `${msg.channel_type}:${raw}`;
}

/**
 * Routing context extracted from messages_in rows.
 * Copied to messages_out by default so responses go back to the sender.
 */
export interface RoutingContext {
  platformId: string | null;
  channelType: string | null;
  threadId: string | null;
  inReplyTo: string | null;
  /** Batch is a task run: every row is a scheduled task, unless each was
   *  created to come back in its conversation. One-door delivery: only an
   *  explicitly addressed tool delivers from a task run; final-text
   *  `<message to>` blocks are inert and the final text auto-appends to the
   *  series run log. */
  taskRun: boolean;
  /** Every row in the batch is a scheduled task (echo rows aside). When such
   *  a batch is not a task run, its prose outside a block is scratchpad, never
   *  nudged, so a task with nothing to say stays quiet; absent is no. */
  tasksOnly?: boolean;
  /** Every non-echo row that woke this turn is a failure notice. */
  failureNoticeWake?: boolean;
  /**
   * Someone who wrote in a live chat (a Chat SDK channel) waits for the answer
   * with no sign that the agent is working on it (acknowledge.ts); absent is no.
   */
  personWaiting?: boolean;
  /**
   * The ids of the messages the turn answers, trigger=0 context included but
   * no session-echo row. Its failure report and each message it writes to a
   * person name them, so the host can tell whose they were; absent is none.
   */
  batch?: readonly string[];
  /** The thread per A2A peer in this batch; null when the peer's rows name different threads or none. */
  agentThreads?: Readonly<Record<string, string | null>>;
}

/** Leaves out every session-echo row, this conversation's own dm/channel-timeline history included. */
export function batchOf(messages: readonly MessageInRow[]): string[] {
  return messages.filter((m) => !isSessionEcho(m)).map((m) => m.id);
}

/**
 * Extract routing context from a batch of messages.
 * Uses the first non-echo message's routing fields — a cross-session echo
 * row must never decide where the reply goes (its routing is NULL by
 * contract, but even a malformed row with routing set is skipped). Falls
 * back to the plain first row if the batch is somehow all echo (shouldn't
 * happen — echo rows never trigger). A batch that opens with a failure
 * notice routes by its first real waking message instead, so a failure
 * answers the requester, not the agent that failed.
 */
export function extractRouting(messages: MessageInRow[]): RoutingContext {
  const nonEcho = messages.filter((m) => !isSessionEcho(m));
  const waking = nonEcho.filter((m) => m.trigger !== 0);
  const preferred = nonEcho[0] && isFailureNotice(nonEcho[0]) ? waking.find((m) => !isFailureNotice(m)) : undefined;
  const first = preferred ?? nonEcho[0] ?? messages[0];
  // Echo rows riding along with a task must not disable one-door delivery.
  const tasksOnly =
    messages.some((m) => m.kind === 'task') && messages.every((m) => m.kind === 'task' || isSessionEcho(m));
  const agentThreads: Record<string, string | null> = {};
  for (const message of nonEcho) {
    if (message.channel_type !== 'agent' || !message.platform_id) continue;
    const peer = message.platform_id;
    const thread = message.thread_id;
    agentThreads[peer] = !(peer in agentThreads) ? thread : agentThreads[peer] === thread ? thread : null;
  }
  return {
    agentThreads,
    platformId: first?.platform_id ?? null,
    channelType: first?.channel_type ?? null,
    threadId: first?.thread_id ?? null,
    inReplyTo: first?.id ?? null,
    // A task comes back as a turn only when it was created to, wherever its
    // row sits; a batch mixing such tasks with others stays a run.
    taskRun: tasksOnly && !messages.filter((m) => m.kind === 'task').every(isConversationTask),
    tasksOnly,
    // Accumulated trigger=0 context rides along but did not wake the turn.
    failureNoticeWake: waking.length > 0 && waking.every(isFailureNotice),
    personWaiting: waking.some((m) => m.kind === 'chat-sdk' && !showsWorkingIndicator(m.channel_type)),
    batch: batchOf(messages),
  };
}

/**
 * Format a batch of messages_in rows into a prompt string.
 *
 * Prepends a `<context timezone="<IANA>" />` header so the agent always knows
 * what timezone it's in — every timestamp it sees in message bodies is the
 * user's local time, and every time it produces (schedules, suggests) should
 * be interpreted as local time in that same zone. This header is v1 behavior
 * (src/v1/router.ts:20-22); dropping it led to misinterpretations where the
 * agent scheduled tasks for the wrong hour.
 *
 * Strips routing fields — the agent never sees platform_id, channel_type, thread_id.
 */
export function formatMessages(messages: MessageInRow[]): string {
  const header = `<context timezone="${escapeXml(TIMEZONE)}" />\n`;
  if (messages.length === 0) return header;

  // Group by kind
  const chatMessages = messages.filter((m) => m.kind === 'chat' || m.kind === 'chat-sdk');
  const taskMessages = messages.filter((m) => m.kind === 'task');
  const webhookMessages = messages.filter((m) => m.kind === 'webhook');
  const systemMessages = messages.filter((m) => m.kind === 'system');

  const parts: string[] = [];

  if (chatMessages.length > 0) {
    parts.push(formatChatMessages(chatMessages));
  }
  if (taskMessages.length > 0) {
    parts.push(...taskMessages.map(formatTaskMessage));
  }
  if (webhookMessages.length > 0) {
    parts.push(...webhookMessages.map(formatWebhookMessage));
  }
  if (systemMessages.length > 0) {
    parts.push(...systemMessages.map(formatSystemMessage));
  }

  return header + parts.join('\n\n');
}

function formatChatMessages(messages: MessageInRow[]): string {
  // Each `<message id="..." from="...">...</message>` block is self-contained;
  // concatenating them reads to the agent as a sequence of distinct messages.
  // Earlier revisions wrapped multi-message batches in an outer `<messages>`
  // envelope, but the Claude Agent SDK responded to that shape with a
  // synthetic stub (`model: "<synthetic>"`, `content: "No response
  // requested."`) instead of calling the API — see #2555 for the full trace.
  // The fix is simply to drop the wrapper; the single-message path (which
  // already worked) is now just the N=1 case of the same code.
  return messages.map(formatSingleChat).join('\n');
}

function formatSingleChat(msg: MessageInRow): string {
  if (isSessionEcho(msg)) return formatEchoMessage(msg);
  const content = parseContent(msg.content);
  if (content.reaction !== undefined) return formatReaction(msg, content);
  const sender = content.sender || content.author?.fullName || content.author?.userName || 'Unknown';
  const time = formatLocalTime(msg.timestamp, TIMEZONE);
  const text = content.text || '';
  const idAttr = msg.seq != null ? ` id="${msg.seq}"` : '';
  const replyAttr = content.replyTo?.id ? ` reply_to="${escapeXml(String(content.replyTo.id))}"` : '';
  const replyPrefix = formatReplyContext(msg, content.replyTo);
  const linksSuffix = formatLinks(content.links, text);
  const attachmentsSuffix = formatAttachments(content.attachments);
  const appContextSuffix = formatAppContext(content.app_context);

  const fromAttr = originAttr(msg);
  const threadAttr = msg.channel_type === 'agent' && msg.thread_id ? ` thread="${escapeXml(msg.thread_id)}"` : '';
  const identityAttrs = msg.channel_type === 'agent' ? '' : formatIdentityAttrs(msg, content);

  const principalMark = msg.channel_type === 'agent' ? '' : formatPrincipalMark(content.principalMessage);
  return `${principalMark}<message${idAttr}${fromAttr}${threadAttr} sender="${escapeXml(sender)}"${identityAttrs} time="${escapeXml(time)}"${replyAttr}>${replyPrefix}${escapeXml(text)}${linksSuffix}${attachmentsSuffix}${appContextSuffix}</message>`;
}

/**
 * Names in the text are for reading; these platform keys, written by the adapter and never by a member, say
 * exactly who spoke and whom they mentioned (`you` is the agent).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatIdentityAttrs(msg: MessageInRow, content: any): string {
  const senderId = extractSenderId(msg, content);
  const mentions = Array.isArray(content.mentions)
    ? content.mentions.flatMap((key: unknown) => {
        const id = key === 'you' ? key : namespacedUserId(msg, key);
        return id ? [id] : [];
      })
    : [];
  return (
    (senderId ? ` sender_id="${escapeXml(senderId)}"` : '') +
    (mentions.length > 0 ? ` mentions="${escapeXml(mentions.join(','))}"` : '')
  );
}

function formatPrincipalMark(value: unknown): string {
  const mark = attachmentRecord(value);
  if (typeof mark?.id !== 'string' || !mark.id || typeof mark.messagingGroupId !== 'string' || !mark.messagingGroupId) {
    return '';
  }
  return `<principal_message id="${escapeXml(mark.id)}" chat="${escapeXml(mark.messagingGroupId)}"/>\n`;
}

/** content.reaction, as the host's chat-sdk bridge writes it on a reaction's row. */
interface ReactionContent {
  /** The emoji by the name add_reaction takes (thumbs_up). */
  emoji: string;
  /** `self` marks the agent's own message; `senderId` is its author's platform key. */
  target: { self: boolean; sender: string; senderId?: string; excerpt: string };
}

function readReaction(value: unknown): ReactionContent {
  const reaction = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const target =
    typeof reaction.target === 'object' && reaction.target !== null ? (reaction.target as Record<string, unknown>) : {};
  return {
    emoji: typeof reaction.emoji === 'string' ? reaction.emoji : 'unknown',
    target: {
      self: target.self === true,
      sender: typeof target.sender === 'string' ? target.sender : 'Unknown',
      ...(typeof target.senderId === 'string' && target.senderId ? { senderId: target.senderId } : {}),
      excerpt: typeof target.excerpt === 'string' ? target.excerpt : '',
    },
  };
}

/** Never a <message>: there is nothing written to reply to, and no id to react to. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatReaction(msg: MessageInRow, content: any): string {
  const { emoji, target } = readReaction(content.reaction);
  const sender = typeof content.sender === 'string' && content.sender ? content.sender : 'Unknown';
  const senderId = extractSenderId(msg, content);
  const time = formatLocalTime(msg.timestamp, TIMEZONE);
  const on = target.self ? 'you' : target.sender;
  const onId = target.self ? null : namespacedUserId(msg, target.senderId);
  return `<reaction${originAttr(msg)} sender="${escapeXml(sender)}"${senderId ? ` sender_id="${escapeXml(senderId)}"` : ''} emoji="${escapeXml(emoji)}" time="${escapeXml(time)}">\n  <reacted_to sender="${escapeXml(on)}"${onId ? ` sender_id="${escapeXml(onId)}"` : ''}>${escapeXml(target.excerpt)}</reacted_to>\n</reaction>`;
}

/**
 * Render a cross-session context copy. No id/reply_to attributes — echo rows
 * are ambient context, not addressable messages. `from` is the human label of
 * the source conversation (e.g. "#Pixel room", "DM with Gavriel") written by
 * the host at fan-out time; content.text is already truncated host-side.
 */
function formatEchoMessage(msg: MessageInRow): string {
  const content = parseContent(msg.content);
  const label = content.echo?.label || 'another conversation';
  // `self` marks the agent's own post; the host sets it in backfill and the outbound fan.
  const sender = content.self ? 'you' : content.sender || 'Unknown';
  const time = formatLocalStamp(new Date(msg.timestamp), TIMEZONE);
  // Timeline rows are the conversation's own preceding history — FIRST-CLASS
  // context this thread continues from, unlike cross-session-context ambient
  // echoes from other live surfaces which must never be acted on in-place.
  // dm-timeline = a DM's timeline; channel-timeline = a group conversation's
  // (per-thread groups).
  if (content.echo?.surface === 'dm-timeline' || content.echo?.surface === 'channel-timeline') {
    const tag = content.echo.surface === 'channel-timeline' ? 'channel-history' : 'dm-history';
    return `<${tag} sender="${escapeXml(sender)}" time="${escapeXml(time)}">${escapeXml(content.text || '')}</${tag}>`;
  }
  return `<cross-session-context from="${escapeXml(label)}" sender="${escapeXml(sender)}" time="${escapeXml(time)}">${escapeXml(content.text || '')}</cross-session-context>`;
}

/**
 * Build a ` from="destination_name"` attribute string from a message's routing
 * fields. Shared by all formatters so the agent always knows where a message
 * originated — critical for explicit addressing.
 */
function originAttr(msg: MessageInRow): string {
  const fromDest = findByRouting(msg.channel_type, msg.platform_id);
  if (fromDest) return ` from="${escapeXml(fromDest.name)}"`;
  if (msg.channel_type || msg.platform_id) {
    return ` from="unknown:${escapeXml(msg.channel_type || '')}:${escapeXml(msg.platform_id || '')}"`;
  }
  return '';
}

function formatTaskMessage(msg: MessageInRow): string {
  const content = parseContent(msg.content);
  const from = originAttr(msg);
  const time = formatLocalTime(msg.process_after ?? msg.timestamp, TIMEZONE);
  const currentTime = new Date().toLocaleString('en-US', {
    timeZone: TIMEZONE,
    dateStyle: 'full',
    timeStyle: 'short',
  });
  const parts: string[] = [];
  if (content.scriptOutput) {
    // A script's data can carry outside text, which must never close the
    // <task> block, so it is escaped like any other inbound text.
    parts.push('Script output:', escapeXml(JSON.stringify(content.scriptOutput, null, 2)), '');
  }
  parts.push('Instructions:', stripLegacyTaskContract(content.prompt || ''));
  return `<task${from} time="${escapeXml(time)}" current_time="${escapeXml(currentTime)}">${parts.join('\n')}</task>`;
}

const LEGACY_TASK_CONTRACT_MARKERS = [
  '\n\n[A task serves the user two separate ways —',
  '\n\n[Task delivery contract:',
];

/**
 * PR #2981 persisted its generated delivery contract inside each task prompt.
 * New sessions receive the contract from their runtime system prompt instead.
 * Strip only a known generated suffix, at read time, so existing task rows stay
 * compatible without a session-DB migration or contradictory model guidance.
 */
export function stripLegacyTaskContract(prompt: string): string {
  if (!prompt.trimEnd().endsWith(']')) return prompt;

  let contractStart = -1;
  for (const marker of LEGACY_TASK_CONTRACT_MARKERS) {
    contractStart = Math.max(contractStart, prompt.lastIndexOf(marker));
  }
  return contractStart >= 0 ? prompt.slice(0, contractStart).trimEnd() : prompt;
}

function formatWebhookMessage(msg: MessageInRow): string {
  const content = parseContent(msg.content);
  const source = content.source || 'unknown';
  const event = content.event || 'unknown';
  const from = originAttr(msg);
  return `<webhook${from} source="${escapeXml(source)}" event="${escapeXml(event)}">${JSON.stringify(content.payload || content, null, 2)}</webhook>`;
}

function formatSystemMessage(msg: MessageInRow): string {
  const content = parseContent(msg.content);
  const from = originAttr(msg);
  return `<system_response${from} action="${escapeXml(content.action || 'unknown')}" status="${escapeXml(content.status || 'unknown')}">${JSON.stringify(content.result || null)}</system_response>`;
}

/**
 * Render the quoted original inside the <message> body.
 *
 * Matches v1 format (src/v1/router.ts:10-18): `<quoted_message from="X">Y</quoted_message>`.
 * Requires BOTH sender and text — if only id is present the reply_to attribute
 * on the parent <message> carries the link without an inline preview. The
 * agent's own message reads `from="you"`; another's carries `from_id`, its
 * platform key, beside the name, as a message's `sender_id` does.
 *
 * No truncation here (v1 didn't truncate).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatReplyContext(msg: MessageInRow, replyTo: any): string {
  if (!replyTo) return '';
  const own = replyTo.self === true;
  const sender = own ? 'you' : replyTo.sender;
  const text = replyTo.text;
  if (!sender || !text) return '';
  const senderId = own ? null : namespacedUserId(msg, replyTo.senderId);
  const idAttr = senderId ? ` from_id="${escapeXml(senderId)}"` : '';
  return `\n  <quoted_message from="${escapeXml(sender)}"${idAttr}>${escapeXml(text)}</quoted_message>\n`;
}

/**
 * Render agent-mode app context — the entities the user was viewing when
 * they sent this message (content.app_context = { entities: [{ type, id },
 * …] }, attached by the chat-sdk bridge). One compact line inside the
 * message block; malformed/empty context renders nothing.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatAppContext(appContext: any): string {
  if (!appContext || !Array.isArray(appContext.entities)) return '';
  const items = appContext.entities
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((e: any) => typeof e?.type === 'string' && e.type && typeof e?.id === 'string' && e.id)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((e: any) => `${e.type} ${e.id}`);
  if (items.length === 0) return '';
  return `\n(viewing: ${escapeXml(items.join(', '))})`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatLinks(links: any[] | undefined, text: string): string {
  if (!Array.isArray(links) || links.length === 0) return '';
  const urls = [
    ...new Set(
      links.flatMap((link) =>
        typeof link?.url === 'string' && link.url && !text.includes(link.url) ? [link.url] : [],
      ),
    ),
  ];
  return urls.length === 0 ? '' : `\n${urls.map((url) => `[link: ${escapeXml(url)}]`).join('\n')}`;
}

function attachmentRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function attachmentText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Why voice notes could not hear a recording, as the principal may hear it:
 * each names their operator, the only one who can change it.
 */
const OPERATOR_LIMITS: ReadonlyMap<string, string> = new Map([
  ['operator-setup-required', "voice notes need a local installation only the principal's operator can set up"],
  ['operator-enablement-required', "voice notes need a local installation only the principal's operator can set up"],
  ['operator-update-required', "voice notes need an update only the principal's operator can make"],
  [
    'voice-installation-unhealthy',
    "voice notes aren't working right now, and only the principal's operator can fix that",
  ],
]);

/** Anyone but the principal hears no reason: it is about their operator's setup. */
const NOT_LISTENED_ELSEWHERE =
  "You can't listen to this recording here. Its sender expects you heard it, so if it bears on the thread, say you couldn't listen to it and ask them to put it in writing, without saying why; handle the rest of the message as usual.";

/**
 * Its sender believes the recording was heard, so each line says to tell them
 * and what to ask for, or silence would read as if it had been. Only the
 * principal's own private conversation, as the host marked it, hears that
 * their operator can change it; a missing mark reads as anywhere else.
 */
function speechStatusLine(speech: Record<string, unknown>): string {
  const principals = speech.inPrincipalPrivateConversation === true;
  const told = (fact: string, ask: string): string =>
    principals
      ? `${fact} They expect you heard it, so tell them so in a line of your reply, ask them to ${ask}, and handle the rest of their message as usual.`
      : `${fact} Its sender expects you heard it, so if it bears on the thread, tell them so and ask them to ${ask}; handle the rest of the message as usual.`;
  if (speech.status === 'no-speech')
    return told('No speech was heard in this recording.', 'type anything it was meant to say');
  const reason = typeof speech.reason === 'string' ? speech.reason : '';
  switch (reason) {
    case 'voice-busy':
    case 'aborted':
      return told("This recording wasn't listened to and won't be retried.", 'send it again or type it');
    case 'media-download-failed':
      return told("This recording couldn't be fetched.", 'send it again');
  }
  const limit = OPERATOR_LIMITS.get(reason);
  if (limit || speech.status === 'unavailable') {
    if (!principals) return NOT_LISTENED_ELSEWHERE;
    return told(
      limit ? `You didn't listen to this recording: ${limit}.` : "You can't listen to this recording here.",
      'type anything it held',
    );
  }
  return told("This recording couldn't be understood.", 'type anything it held');
}

function isRecognizedSpeech(speech: Record<string, unknown> | undefined): boolean {
  return speech?.status === 'recognized' && attachmentText(speech.text).trim() !== '';
}

function formatSpeech(attachment: Record<string, unknown>): string {
  const speech = attachmentRecord(attachment.speech);
  if (!speech) return '';
  const source = attachmentRecord(attachment.audioSource);
  const sourceAttrs =
    ` source="${source?.kind === 'voice-note' ? 'voice-note' : 'audio'}"` +
    (source?.forwarded === true ? ' forwarded="true"' : '') +
    (source?.quoted === true ? ' quoted="true"' : '');
  if (isRecognizedSpeech(speech)) {
    return (
      '\n' +
      [
        ...(source?.forwarded === true ? ['[Forwarded]'] : []),
        ...(source?.quoted === true ? ['[Quoted]'] : []),
        escapeXml(attachmentText(speech.text)),
      ].join('\n')
    );
  }
  const status = speech.status === 'unavailable' || speech.status === 'no-speech' ? speech.status : 'failed';
  return `\n<speech status="${status}"${sourceAttrs}>${speechStatusLine(speech)}</speech>`;
}

function formatAttachments(attachments: unknown): string {
  if (!Array.isArray(attachments) || attachments.length === 0) return '';
  const parts = attachments.map((value: unknown) => {
    const a = attachmentRecord(value) ?? {};
    const name = attachmentText(a.name) || attachmentText(a.filename) || 'attachment';
    const type = attachmentText(a.type) || 'file';
    const local = attachmentText(a.localPath);
    const localPath = local ? `/workspace/${local}` : '';
    const url = attachmentText(a.url);
    const speech = formatSpeech(a);
    if (localPath) {
      return `[${escapeXml(type)}: ${escapeXml(name)} — saved to ${escapeXml(localPath)}]${speech}`;
    }
    const description = url
      ? `[${escapeXml(type)}: ${escapeXml(name)} (${escapeXml(url)})]`
      : `[${escapeXml(type)}: ${escapeXml(name)}]`;
    return description + speech;
  });
  return '\n' + parts.join('\n');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseContent(json: string): any {
  try {
    return JSON.parse(json);
  } catch {
    return { text: json };
  }
}

function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Strip `<internal>...</internal>` blocks from agent output, then trim.
 * Ported from v1 (src/v1/router.ts:25-27). Used to remove the agent's
 * own scratchpad/reasoning before a reply goes out over a channel.
 */
export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}
