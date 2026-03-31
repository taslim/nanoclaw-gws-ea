import fs from 'fs';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import {
  ASSISTANT_NAME,
  ATTACHMENT_MAX_PER_MESSAGE,
  ATTACHMENT_PRUNE_DAYS,
  DEFAULT_TRIGGER,
  SESSION_PRUNE_DAYS,
  EMAIL_EXTERNAL_DELAY,
  getTriggerPattern,
  GROUPS_DIR,
  HEARTBEAT_SPACE_ID,
  IDLE_TIMEOUT,
  MAX_MESSAGES_PER_PROMPT,
  ONECLI_URL,
  POLL_INTERVAL,
  PRINCIPAL_NAME,
  TIMEZONE,
  isPrincipalEmail,
  validateEaConfig,
} from './config.js';
import { HEARTBEAT_GROUP } from './heartbeat.js';
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
  classifyEmailRoute,
} from './email.js';
import type { ThreadMessage } from './email.js';
import {
  ContainerOutput,
  pruneOldSessions,
  runContainerAgent,
  writeMattersSnapshot,
  writeRecentEmailsSnapshot,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
} from './container-runtime.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllMatters,
  getAllSessions,
  deleteSession,
  getAllTasks,
  getEmailRoute,
  getRecentEmailThreads,
  getMessageFromMe,
  getLastBotMessageTimestamp,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  upsertEmailRoute,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
  updateEmailStatus,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startSchedulerLoop } from './task-scheduler.js';
import {
  Attachment,
  Channel,
  ContainerConfig,
  NewMessage,
  RegisteredGroup,
} from './types.js';
import {
  DownloadResult,
  downloadAndSave,
  isFailedAttachment,
  pruneAttachments,
  SavedAttachment,
} from './attachments.js';
import { logger } from './logger.js';
import { transcribe } from './transcription.js';

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

const onecli = new OneCLI({ url: ONECLI_URL });

function ensureOneCLIAgent(jid: string, group: RegisteredGroup): void {
  if (group.isMain) return;
  const identifier = group.folder.toLowerCase().replace(/_/g, '-');
  onecli.ensureAgent({ name: group.name, identifier }).then(
    (res) => {
      logger.info(
        { jid, identifier, created: res.created },
        'OneCLI agent ensured',
      );
    },
    (err) => {
      logger.debug(
        { jid, identifier, err: String(err) },
        'OneCLI agent ensure skipped',
      );
    },
  );
}

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

/**
 * Return the message cursor for a group, recovering from the last bot reply
 * if lastAgentTimestamp is missing (new group, corrupted state, restart).
 */
function getOrRecoverCursor(chatJid: string): string {
  const existing = lastAgentTimestamp[chatJid];
  if (existing) return existing;

  const botTs = getLastBotMessageTimestamp(chatJid, ASSISTANT_NAME);
  if (botTs) {
    logger.info(
      { chatJid, recoveredFrom: botTs },
      'Recovered message cursor from last bot reply',
    );
    lastAgentTimestamp[chatJid] = botTs;
    saveState();
    return botTs;
  }
  return '';
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

  // Copy CLAUDE.md template into the new group folder so agents have
  // identity and instructions from the first run.  (Fixes #1391)
  const groupMdFile = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(groupMdFile)) {
    const templateFile = path.join(
      GROUPS_DIR,
      group.isMain ? 'main' : 'global',
      'CLAUDE.md',
    );
    if (fs.existsSync(templateFile)) {
      let content = fs.readFileSync(templateFile, 'utf-8');
      if (ASSISTANT_NAME !== 'Andy') {
        content = content.replace(/^# Andy$/m, `# ${ASSISTANT_NAME}`);
        content = content.replace(/You are Andy/g, `You are ${ASSISTANT_NAME}`);
      }
      fs.writeFileSync(groupMdFile, content);
      logger.info({ folder: group.folder }, 'Created CLAUDE.md from template');
    }
  }

  // Ensure a corresponding OneCLI agent exists (best-effort, non-blocking)
  ensureOneCLIAgent(jid, group);

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

  const missedMessages = getMessagesSince(
    chatJid,
    getOrRecoverCursor(chatJid),
    ASSISTANT_NAME,
    MAX_MESSAGES_PER_PROMPT,
  );

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const triggerPattern = getTriggerPattern(group.trigger);
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        triggerPattern.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  // --- Status indicators: 👀 on each message, clear on response, ❌ on error ---
  for (const msg of missedMessages) {
    setIndicator(channel, msg, chatJid);
  }

  // --- Process attachments ---
  const savedAttachments: SavedAttachment[] = [];

  if (group.allowAttachments) {
    const authHeaders = (await channel.getAuthHeaders?.()) ?? {};

    // Download all attachments in parallel (across all messages)
    const downloadJobs: Array<{
      msg: NewMessage;
      att: Attachment;
      resultPromise: Promise<DownloadResult>;
    }> = [];

    for (const msg of missedMessages) {
      if (!msg.attachments?.length) continue;
      for (const att of msg.attachments.slice(0, ATTACHMENT_MAX_PER_MESSAGE)) {
        downloadJobs.push({
          msg,
          att,
          resultPromise: downloadAndSave(att, group.folder, authHeaders),
        });
      }
    }

    const results = await Promise.all(downloadJobs.map((j) => j.resultPromise));

    for (let i = 0; i < downloadJobs.length; i++) {
      const { msg, att } = downloadJobs[i];
      const result = results[i];

      if (isFailedAttachment(result)) {
        msg.content += `\n[Attachment failed: ${att.filename} — ${result.error}]`;
      } else if (result.mimeType.startsWith('audio/')) {
        const diskPath = path.join(
          resolveGroupFolderPath(group.folder),
          result.path,
        );
        const transcript = await transcribe(diskPath);
        if (transcript) {
          msg.content += `\n[Audio transcript: ${transcript}]`;
        } else {
          msg.content += `\n[Audio transcription unavailable: ${att.filename}]`;
        }
      } else {
        savedAttachments.push(result);
        if (result.mode === 'inline') {
          msg.content += `\n[Attached: ${att.filename}]`;
        } else {
          msg.content += `\n[File: ${att.filename} at /workspace/group/${result.path}]`;
        }
      }

      // Strip image URL from text if it was extracted from text
      if (att.extractedFromText) {
        msg.content = msg.content.replace(att.extractedFromText, '').trim();
      }
    }
  } else {
    // If attachments disabled but message is attachment-only, note it
    for (const msg of missedMessages) {
      if (msg.attachments?.length && !msg.content.trim()) {
        msg.content = '[Attachment(s) sent but not enabled for this group]';
      }
    }
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
    const output = await runAgent(
      group,
      prompt,
      chatJid,
      async (result) => {
        if (result.result) {
          const raw =
            typeof result.result === 'string'
              ? result.result
              : JSON.stringify(result.result);
          logger.info(
            { group: group.name },
            `Agent output: ${raw.slice(0, 200)}`,
          );
          const text = formatOutbound(raw);
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
      },
      { attachments: savedAttachments },
    );

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
  options?: { freshSession?: boolean; attachments?: SavedAttachment[] },
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const sessionId = options?.freshSession ? undefined : sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script || undefined,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update matters snapshot for container to read
  writeMattersSnapshot(group.folder, isMain, getAllMatters());

  // Update recent emails snapshot for heartbeat to triage into matters
  if (group.folder === HEARTBEAT_GROUP.folder) {
    const since = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // last 2 hours
    writeRecentEmailsSnapshot(group.folder, getRecentEmailThreads(since));
  }

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results (skip for fresh sessions)
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId && !options?.freshSession) {
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
        builtinTools: group.containerConfig?.builtins,
        mcpConfig: group.containerConfig?.mcpConfig,
        assistantName: ASSISTANT_NAME,
        ...(options?.attachments?.length && {
          attachments: options.attachments,
        }),
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId && !options?.freshSession) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      // Detect stale/corrupt session — clear it so the next retry starts fresh.
      // The session .jsonl can go missing after a crash mid-write, manual
      // deletion, or disk-full. The existing backoff in group-queue.ts
      // handles the retry; we just need to remove the broken session ID.
      const isStaleSession =
        sessionId &&
        output.error &&
        /no conversation found|ENOENT.*\.jsonl|session.*not found/i.test(
          output.error,
        );

      if (isStaleSession) {
        logger.warn(
          { group: group.name, staleSessionId: sessionId, error: output.error },
          'Stale session detected — clearing for next retry',
        );
        delete sessions[group.folder];
        deleteSession(group.folder);
      }

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

  logger.info(`NanoClaw running (default trigger: ${DEFAULT_TRIGGER})`);

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
            const triggerPattern = getTriggerPattern(group.trigger);
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                triggerPattern.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            getOrRecoverCursor(chatJid),
            ASSISTANT_NAME,
            MAX_MESSAGES_PER_PROMPT,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;

          // Process attachments for piped messages (saves to disk + annotates content)
          if (group.allowAttachments) {
            const authHeaders = (await channel.getAuthHeaders?.()) ?? {};
            for (const msg of messagesToSend) {
              if (!msg.attachments?.length) continue;
              for (const att of msg.attachments.slice(
                0,
                ATTACHMENT_MAX_PER_MESSAGE,
              )) {
                const result = await downloadAndSave(
                  att,
                  group.folder,
                  authHeaders,
                );
                if (isFailedAttachment(result)) {
                  msg.content += `\n[Attachment failed: ${att.filename} — ${result.error}]`;
                } else if (result.mimeType.startsWith('audio/')) {
                  const diskPath = path.join(
                    resolveGroupFolderPath(group.folder),
                    result.path,
                  );
                  const transcript = await transcribe(diskPath);
                  if (transcript) {
                    msg.content += `\n[Audio transcript: ${transcript}]`;
                  } else {
                    msg.content += `\n[Audio transcription unavailable: ${att.filename}]`;
                  }
                } else if (result.mode === 'inline') {
                  msg.content += `\n[Attached: ${att.filename} at /workspace/group/${result.path}]`;
                } else {
                  msg.content += `\n[File: ${att.filename} at /workspace/group/${result.path}]`;
                }
                if (att.extractedFromText) {
                  msg.content = msg.content
                    .replace(att.extractedFromText, '')
                    .trim();
                }
              }
            }
          }

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
    const pending = getMessagesSince(
      chatJid,
      getOrRecoverCursor(chatJid),
      ASSISTANT_NAME,
      MAX_MESSAGES_PER_PROMPT,
    );
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

/**
 * Resolve a JID to a channel. System groups with synthetic JIDs (email:*, heartbeat:*)
 * have no owning channel — their output routes to main for visibility.
 */
function resolveChannel(jid: string): {
  channel: Channel | undefined;
  targetJid: string;
} {
  const channel = findChannel(channels, jid);
  if (channel) return { channel, targetJid: jid };

  // No channel owns this JID — route to main (system groups, synthetic events)
  const mainEntry = Object.entries(registeredGroups).find(
    ([, g]) => g.folder === MAIN_GROUP_FOLDER,
  );
  if (!mainEntry) return { channel: undefined, targetJid: jid };
  return {
    channel: findChannel(channels, mainEntry[0]),
    targetJid: mainEntry[0],
  };
}

/**
 * Register or sync a system group — one that must exist on every startup
 * with its container config kept in sync with code. Works for any channel type.
 */
function ensureSystemGroup(cfg: {
  jid: string;
  name: string;
  folder: string;
  trigger: string;
  requiresTrigger: boolean;
  containerConfig?: ContainerConfig;
}): void {
  const existing = registeredGroups[cfg.jid];
  if (existing) {
    existing.containerConfig = cfg.containerConfig;
    setRegisteredGroup(cfg.jid, existing);
  } else {
    registerGroup(cfg.jid, {
      name: cfg.name,
      folder: cfg.folder,
      trigger: cfg.trigger,
      added_at: new Date().toISOString(),
      containerConfig: cfg.containerConfig,
      requiresTrigger: cfg.requiresTrigger,
    });
    logger.info(
      { jid: cfg.jid, folder: cfg.folder },
      'Auto-registered system group',
    );
  }
  // Derive channel label from JID prefix
  const source = cfg.jid.startsWith('email:')
    ? 'email'
    : cfg.jid.startsWith('gchat:')
      ? 'gchat'
      : 'synthetic';
  storeChatMetadata(cfg.jid, new Date().toISOString(), cfg.name, source);
}

/**
 * Register system groups (email routing, heartbeat sweep).
 * Container configs are synced from code on every restart.
 */
function ensureSystemGroups(): void {
  ensureSystemGroup(EMAIL_PRINCIPAL_GROUP);
  ensureSystemGroup(EMAIL_EXTERNAL_GROUP);

  if (HEARTBEAT_SPACE_ID) {
    ensureSystemGroup(HEARTBEAT_GROUP);
  }
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Validate EA config (fail fast if required env vars are missing)
  validateEaConfig();

  ensureSystemGroups();

  // Prune orphaned session files from fresh-session groups (email, heartbeat)
  pruneOldSessions(
    [
      EMAIL_PRINCIPAL_GROUP.folder,
      EMAIL_EXTERNAL_GROUP.folder,
      HEARTBEAT_GROUP.folder,
    ],
    SESSION_PRUNE_DAYS,
  );

  // Prune old attachments (14-day retention) on startup and daily
  const allGroupFolders = () =>
    Object.values(registeredGroups).map((g) => g.folder);
  pruneAttachments(allGroupFolders(), ATTACHMENT_PRUNE_DAYS);
  setInterval(
    () => pruneAttachments(allGroupFolders(), ATTACHMENT_PRUNE_DAYS),
    24 * 60 * 60 * 1000,
  );

  // Ensure OneCLI agents exist for all registered groups.
  // Recovers from missed creates (e.g. OneCLI was down at registration time).
  for (const [jid, group] of Object.entries(registeredGroups)) {
    ensureOneCLIAgent(jid, group);
  }

  restoreRemoteControl();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // Track GChat group spaces so onMessage can skip auto-registration for them
  const gchatGroupSpaces = new Set<string>();

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

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
      const { channel, targetJid } = resolveChannel(jid);
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
      const { channel, targetJid } = resolveChannel(jid);
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
    onTasksChanged: () => {
      const tasks = getAllTasks();
      const taskRows = tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        script: t.script || undefined,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      }));
      for (const group of Object.values(registeredGroups)) {
        writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
      }
    },
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();

  // Email event source — direct agent invocation, output forwarded to main channel
  startEmailLoop(async (ctx) => {
    const { email } = ctx;

    // Thread routing: one-way ratchet (external stays external, otherwise evaluate participants)
    const existingRoute = getEmailRoute(email.threadId);
    let targetFolder: string;
    if (existingRoute === 'email-external') {
      targetFolder = 'email-external';
    } else {
      targetFolder = classifyEmailRoute(email);
    }

    // Upsert routing record (ratchet handled in SQL)
    upsertEmailRoute(email.threadId, targetFolder);

    // Map folder → JID
    const targetJid =
      targetFolder === 'email-external'
        ? EMAIL_EXTERNAL_GROUP.jid
        : EMAIL_PRINCIPAL_GROUP.jid;

    const group = registeredGroups[targetJid];
    if (!group) {
      logger.warn(
        { targetFolder, targetJid },
        'Target group not registered, skipping email',
      );
      updateEmailStatus(email.id, 'failed');
      return;
    }

    // Fetch thread content (graceful degradation on failure)
    let threadMessages: ThreadMessage[] = [];
    try {
      threadMessages = await ctx.fetchThread();
    } catch (err) {
      logger.warn(
        { threadId: email.threadId, err },
        'Failed to fetch thread content, proceeding without',
      );
    }

    const isExternal = targetFolder === 'email-external';
    const prompt = buildEmailPrompt(email, isExternal, threadMessages);

    const emailTask = async (): Promise<void> => {
      const { channel: outputChannel, targetJid: outputJid } =
        resolveChannel(targetJid);

      logger.info(
        { emailId: email.id, threadId: email.threadId, route: targetFolder },
        `Processing email via ${targetFolder} group agent`,
      );

      // Fresh session per email — no cross-thread context leakage
      const output = await runAgent(
        group,
        prompt,
        targetJid,
        async (result) => {
          if (result.result) {
            const raw =
              typeof result.result === 'string'
                ? result.result
                : JSON.stringify(result.result);
            const text = formatOutbound(raw);
            if (text && outputChannel) {
              await outputChannel.sendMessage(outputJid, text);
            }
          }
        },
        { freshSession: true },
      );

      if (output === 'error') {
        logger.error(
          { emailId: email.id, threadId: email.threadId, route: targetFolder },
          'Email agent processing failed',
        );
        updateEmailStatus(email.id, 'failed');
        return;
      }
      updateEmailStatus(email.id, 'processed');
    };

    // Delay external emails to avoid instant AI-giveaway replies.
    if (isExternal && EMAIL_EXTERNAL_DELAY > 0) {
      logger.info(
        {
          emailId: email.id,
          threadId: email.threadId,
          delayMs: EMAIL_EXTERNAL_DELAY,
        },
        'Delaying external email processing',
      );
      setTimeout(() => {
        queue.enqueueTask(targetJid, email.id, emailTask);
      }, EMAIL_EXTERNAL_DELAY);
      return;
    }

    queue.enqueueTask(targetJid, email.id, emailTask);
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
