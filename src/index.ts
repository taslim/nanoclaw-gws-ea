import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  CREDENTIAL_PROXY_PORT,
  IDLE_TIMEOUT,
  POLL_INTERVAL,
  PRINCIPAL_NAME,
  TIMEZONE,
  TRIGGER_PATTERN,
  isPrincipalEmail,
  validateEaConfig,
} from './config.js';
import { startCredentialProxy } from './credential-proxy.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  EMAIL_PRINCIPAL_GROUP,
  EMAIL_EXTERNAL_GROUP,
  startEmailLoop,
  buildEmailPrompt,
  getEmailRouteGroup,
} from './email.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeEmailThreadsSnapshot,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
  PROXY_BIND_HOST,
} from './container-runtime.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllEmailThreads,
  getAllSessions,
  getAllTasks,
  getEmailThreadRoute,
  getMessageFromMe,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  upsertEmailThread,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

const MAIN_GROUP_FOLDER = 'main';

// --- Status indicators ---
// Lightweight per-message feedback: 👀 when acknowledged, clear on response, ❌ on unrecoverable error.
// Keyed by message ID. Both the new-container and piping paths use this same Map.
interface ActiveIndicator {
  chatJid: string;
  key: { id: string; remoteJid: string; fromMe: boolean };
  channel: Channel;
}
const activeIndicators = new Map<string, ActiveIndicator>();

/** Mark a message as acknowledged. */
function setIndicator(
  channel: Channel,
  msg: NewMessage,
  chatJid: string,
): void {
  if (!channel.sendReaction) return;
  const key = {
    id: msg.id,
    remoteJid: chatJid,
    fromMe: msg.is_from_me ?? false,
  };
  activeIndicators.set(msg.id, { chatJid, key, channel });
  channel
    .sendReaction(chatJid, key, '👀', { skipStore: true })
    .catch((err) => logger.debug({ chatJid, err }, 'Indicator set failed'));
}

/** Clear all pending indicators for a group (response arrived). */
function clearIndicators(chatJid: string): void {
  for (const [msgId, ind] of activeIndicators) {
    if (ind.chatJid !== chatJid) continue;
    activeIndicators.delete(msgId);
    ind.channel.sendReaction!(chatJid, ind.key, '', { skipStore: true }).catch(
      (err) => logger.debug({ chatJid, err }, 'Indicator clear failed'),
    );
  }
}

/** Mark error on the most recent pending indicator, clear the rest. */
function errorIndicators(chatJid: string): void {
  let lastMsgId: string | null = null;
  for (const [msgId, ind] of activeIndicators) {
    if (ind.chatJid === chatJid) lastMsgId = msgId;
  }

  for (const [msgId, ind] of activeIndicators) {
    if (ind.chatJid !== chatJid) continue;
    activeIndicators.delete(msgId);
    if (msgId === lastMsgId) {
      ind.channel.sendReaction!(chatJid, ind.key, '', { skipStore: true })
        .catch(() => {})
        .then(() =>
          ind.channel.sendReaction!(chatJid, ind.key, '❌', {
            skipStore: true,
          }),
        )
        .catch((err) =>
          logger.debug({ chatJid, err }, 'Error indicator failed'),
        );
    } else {
      ind.channel.sendReaction!(chatJid, ind.key, '', {
        skipStore: true,
      }).catch((err) =>
        logger.debug({ chatJid, err }, 'Indicator clear failed'),
      );
    }
  }
}

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        TRIGGER_PATTERN.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  // --- Status indicators: 👀 on each message, clear on response, ❌ on error ---
  for (const msg of missedMessages) {
    setIndicator(channel, msg, chatJid);
  }

  const prompt = formatMessages(missedMessages, TIMEZONE);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  let hadError = false;
  let outputSentToUser = false;

  try {
    const output = await runAgent(group, prompt, chatJid, async (result) => {
      if (result.result) {
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
        const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
        logger.info(
          { group: group.name },
          `Agent output: ${raw.slice(0, 200)}`,
        );
        if (text) {
          await channel.sendMessage(chatJid, text);
          clearIndicators(chatJid);
          outputSentToUser = true;
        }
        // Only reset idle timer on actual results, not session-update markers (result: null)
        resetIdleTimer();
      }

      if (result.status === 'success') {
        queue.notifyIdle(chatJid);
      }

      if (result.status === 'error') {
        hadError = true;
      }
    });

    if (idleTimer) clearTimeout(idleTimer);

    if (output === 'error' || hadError) {
      if (outputSentToUser) {
        errorIndicators(chatJid);
        logger.warn(
          { group: group.name },
          'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
        );
        return true;
      }
      // Will retry — clear indicators (new 👀s will appear on retry)
      clearIndicators(chatJid);
      lastAgentTimestamp[chatJid] = previousCursor;
      saveState();
      logger.warn(
        { group: group.name },
        'Agent error, rolled back message cursor for retry',
      );
      return false;
    }

    return true;
  } finally {
    // Catch-all for unexpected throws (OOM, crash, etc.)
    clearIndicators(chatJid);
  }
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update pending email threads snapshot for container to read
  writeEmailThreadsSnapshot(group.folder, isMain, getAllEmailThreads());

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        allowedTools: group.containerConfig?.allowedTools,
        assistantName: ASSISTANT_NAME,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                TRIGGER_PATTERN.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend, TIMEZONE);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // 👀 each piped message (cleared when IPC response arrives)
            for (const msg of messagesToSend) {
              setIndicator(channel, msg, chatJid);
            }
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

// --- Heartbeat/sweep synthetic group ---

const HEARTBEAT_GROUP = {
  jid: 'heartbeat:sweep',
  name: 'Proactive Sweep',
  folder: 'heartbeat',
  trigger: `@${ASSISTANT_NAME}`,
  requiresTrigger: false,
  allowedTools: [
    // Standard tools
    'Bash',
    'Read',
    'Write',
    'Edit',
    'Glob',
    'Grep',
    'WebSearch',
    'WebFetch',
    'Task',
    'TaskOutput',
    'TaskStop',
    'ToolSearch',
    // NanoClaw IPC — send_message routes to main
    'mcp__nanoclaw__send_message',
    'mcp__nanoclaw__schedule_task',
    'mcp__nanoclaw__list_tasks',
    'mcp__nanoclaw__update_email_thread',
    'mcp__nanoclaw__list_email_threads',
    // Full calendar access
    'mcp__calendar__*',
    // Time MCP
    'mcp__time__*',
    // Gmail (search + read, send for follow-ups)
    'mcp__workspace__send_gmail_message',
    'mcp__workspace__draft_gmail_message',
    'mcp__workspace__search_gmail_messages',
    'mcp__workspace__get_gmail_message_content',
    'mcp__workspace__get_gmail_messages_content_batch',
    'mcp__workspace__get_gmail_thread_content',
    'mcp__workspace__get_gmail_attachment_content',
    'mcp__workspace__list_gmail_labels',
    // Contacts (for tier lookups)
    'mcp__workspace__contacts_search',
    'mcp__workspace__contacts_get',
    // Workspace Chat (heartbeat logging)
    'mcp__workspace__chat_send_message',
    'mcp__workspace__chat_get_messages',
  ],
};

/**
 * Ensure synthetic groups exist for email-principal/email-external/heartbeat routing.
 * Tool lists are synced from code on every restart so changes propagate.
 * Idempotent.
 */
function ensureSyntheticGroups(): void {
  for (const cfg of [
    EMAIL_PRINCIPAL_GROUP,
    EMAIL_EXTERNAL_GROUP,
    HEARTBEAT_GROUP,
  ]) {
    const existing = registeredGroups[cfg.jid];
    if (existing) {
      // Sync allowedTools from code so tool list changes propagate on restart
      existing.containerConfig = { allowedTools: cfg.allowedTools };
      setRegisteredGroup(cfg.jid, existing);
    } else {
      registerGroup(cfg.jid, {
        name: cfg.name,
        folder: cfg.folder,
        trigger: cfg.trigger,
        added_at: new Date().toISOString(),
        containerConfig: { allowedTools: cfg.allowedTools },
        requiresTrigger: cfg.requiresTrigger,
      });
      logger.info(
        { jid: cfg.jid, folder: cfg.folder },
        'Auto-registered synthetic group',
      );
    }
    // Ensure chats row exists (storeMessage has FK on chat_jid → chats.jid)
    const source = cfg.jid.startsWith('email:') ? 'email' : 'synthetic';
    storeChatMetadata(cfg.jid, new Date().toISOString(), cfg.name, source);
  }
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();
  ensureSyntheticGroups();

  // Validate EA config (fail fast if required env vars are missing)
  validateEaConfig();

  ensureSyntheticGroups();

  // Start credential proxy (containers route API calls through this)
  const proxyServer = await startCredentialProxy(
    CREDENTIAL_PROXY_PORT,
    PROXY_BIND_HOST,
  );

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    proxyServer.close();
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // Track GChat group spaces so onMessage can skip auto-registration for them
  const gchatGroupSpaces = new Set<string>();

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);

      // Auto-register unregistered GChat DM spaces based on sender identity
      // Groups require manual registration (like WhatsApp)
      if (
        chatJid.startsWith('gchat:') &&
        !registeredGroups[chatJid] &&
        !gchatGroupSpaces.has(chatJid)
      ) {
        const isPrincipal = isPrincipalEmail(msg.sender);
        if (isPrincipal) {
          registerGroup(chatJid, {
            name:
              msg.sender_name?.replace(` [${PRINCIPAL_NAME}]`, '') ||
              'Google Chat DM',
            folder: MAIN_GROUP_FOLDER,
            trigger: `@${ASSISTANT_NAME}`,
            added_at: new Date().toISOString(),
            requiresTrigger: false,
            isMain: true,
          });
        }
        // Non-principal GChat DMs are not auto-registered.
        // Register them manually if needed.
      }
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => {
      storeChatMetadata(chatJid, timestamp, name, channel, isGroup);
      if (isGroup && chatJid.startsWith('gchat:'))
        gchatGroupSpaces.add(chatJid);
    },
    registeredGroups: () => registeredGroups,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const isSynthetic =
        jid.startsWith('email:') || jid.startsWith('heartbeat:');
      let targetJid = jid;
      if (isSynthetic) {
        const mainEntry = Object.entries(registeredGroups).find(
          ([, g]) => g.folder === MAIN_GROUP_FOLDER,
        );
        if (mainEntry) targetJid = mainEntry[0];
      }
      const channel = findChannel(channels, targetJid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(targetJid, text);
    },
  });
  startIpcWatcher({
    sendMessage: async (jid, text) => {
      // Synthetic JIDs (email:*, heartbeat:*) have no channel —
      // route to main channel instead.
      const isSynthetic =
        jid.startsWith('email:') || jid.startsWith('heartbeat:');

      let channel: Channel | undefined;
      let targetJid = jid;

      if (isSynthetic) {
        const mainEntry = Object.entries(registeredGroups).find(
          ([, g]) => g.folder === MAIN_GROUP_FOLDER,
        );
        if (mainEntry) {
          targetJid = mainEntry[0];
          channel = findChannel(channels, targetJid);
        }
      } else {
        channel = findChannel(channels, jid);
      }

      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      await channel.sendMessage(targetJid, text);
      clearIndicators(targetJid);
    },
    sendReaction: async (jid, emoji, messageId) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      if (messageId) {
        if (!channel.sendReaction)
          throw new Error('Channel does not support sendReaction');
        const messageKey = {
          id: messageId,
          remoteJid: jid,
          fromMe: getMessageFromMe(messageId, jid),
        };
        await channel.sendReaction(jid, messageKey, emoji);
      } else {
        if (!channel.reactToLatestMessage)
          throw new Error('Channel does not support reactions');
        await channel.reactToLatestMessage(jid, emoji);
      }
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();

  // Email event source — direct agent invocation, output forwarded to main channel
  startEmailLoop(async (email) => {
    const mainJid = Object.entries(registeredGroups).find(
      ([, g]) => g.folder === MAIN_GROUP_FOLDER,
    )?.[0];
    if (!mainJid) {
      logger.warn('No main group registered, cannot process email');
      return;
    }

    // Thread routing: check table first, then classify by sender
    let targetFolder = getEmailThreadRoute(email.threadId);
    if (!targetFolder) {
      targetFolder = getEmailRouteGroup(email);
    }
    // Hijacking detection: third-party sender on principal-initiated thread.
    const senderIsPrincipal = isPrincipalEmail(email.from);
    if (targetFolder === 'email-principal' && !senderIsPrincipal) {
      logger.warn(
        { from: email.from, subject: email.subject },
        'Third-party sender on principal-initiated thread — downgrading to email-external',
      );
      targetFolder = 'email-external';
      // Alert principal on main channel
      const mainChannel = findChannel(channels, mainJid);
      if (mainChannel) {
        await mainChannel.sendMessage(
          mainJid,
          `Heads up: ${email.from} replied to "${email.subject}" and you're no longer on the thread.`,
        );
      }
    }

    // Upsert thread after hijacking detection so group_folder is correct
    upsertEmailThread(email.threadId, targetFolder);

    // Map folder → JID
    const targetJid =
      targetFolder === 'email-external'
        ? EMAIL_EXTERNAL_GROUP.jid
        : EMAIL_PRINCIPAL_GROUP.jid;

    const group = registeredGroups[targetJid];
    if (!group) {
      logger.warn(
        { targetFolder, targetJid },
        'Target group not registered, falling back to main',
      );
      const mainGroup = registeredGroups[mainJid];
      const prompt = buildEmailPrompt(email);
      await runAgent(mainGroup, prompt, mainJid);
      return;
    }

    const isExternal = targetFolder === 'email-external';
    const prompt = buildEmailPrompt(email, isExternal);
    const mainChannel = findChannel(channels, mainJid);

    logger.info(
      { from: email.from, subject: email.subject, route: targetFolder },
      `Processing email via ${targetFolder} group agent`,
    );

    // Direct agent invocation with output forwarding to main
    const output = await runAgent(group, prompt, targetJid, async (result) => {
      if (result.result) {
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
        if (text && mainChannel) {
          await mainChannel.sendMessage(mainJid, text);
        }
      }
    });

    if (output === 'error') {
      logger.error(
        { from: email.from, subject: email.subject, route: targetFolder },
        'Email agent processing failed',
      );
    }
  });

  void startMessageLoop();
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
