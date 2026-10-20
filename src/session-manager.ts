/**
 * Session lifecycle: folders, mailboxes, messages, and container status.
 * Storage layout and consistency belong to the registered mailbox.
 */
import { AsyncLocalStorage } from 'async_hooks';
import fs from 'fs';
import path from 'path';

import { AnchoredDir } from './anchored-dir.js';
import { deriveAttachmentName } from './attachment-naming.js';
import { inboxFolderName, isSafeAttachmentName } from './attachment-safety.js';
import type { OutboundFile } from './channels/adapter.js';
import { DATA_DIR } from './config.js';
import { getMessagingGroup } from './db/messaging-groups.js';
import { isUniqueViolation } from './db/errors.js';
import {
  createSession,
  findSystemSession,
  findSessionByAgentGroup,
  findSessionForAgent,
  getSession,
  taskThreadId,
  updateSession,
} from './db/sessions.js';
import { log } from './log.js';
import { getAgentMailbox, type InboundMessage, type MailboxSession } from './mailbox/index.js';
import { enqueueSessionReconcile } from './reconcile-feeds.js';
import type { MessagingGroup, MessagingGroupAgent, Session } from './types.js';

/** Root directory for all session data. */
export function sessionsBaseDir(): string {
  return path.join(DATA_DIR, 'v2-sessions');
}

/** Directory for a specific session: sessions/{agent_group_id}/{session_id}/ */
export function sessionDir(agentGroupId: string, sessionId: string): string {
  return path.join(sessionsBaseDir(), agentGroupId, sessionId);
}

/** Host-owned runner context, kept outside the agent-writable session directory. */
export function sessionContextPath(agentGroupId: string, sessionId: string): string {
  return path.join(DATA_DIR, 'v2-sessions', agentGroupId, '.context', `${sessionId}.json`);
}

/** Materialize the immutable context the runner receives at startup. */
export function writeSessionContext(agentGroupId: string, sessionId: string, mailbox: unknown): void {
  const contextPath = sessionContextPath(agentGroupId, sessionId);
  fs.mkdirSync(path.dirname(contextPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(contextPath, JSON.stringify({ agentGroupId, sessionId, mailbox }), { mode: 0o600 });
  fs.chmodSync(contextPath, 0o600);
}

/** Path to the container heartbeat file (touched instead of DB writes). */
export function heartbeatPath(agentGroupId: string, sessionId: string): string {
  return path.join(sessionDir(agentGroupId, sessionId), '.heartbeat');
}

function mailboxKey(agentGroupId: string, sessionId: string) {
  return { agentGroupId, sessionId };
}

function generateId(): string {
  return `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const sessionCreationLocks = new Map<string, Promise<void>>();

async function withSessionCreationLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = sessionCreationLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  sessionCreationLocks.set(key, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (sessionCreationLocks.get(key) === tail) sessionCreationLocks.delete(key);
  }
}

function sessionCreationKey(
  agentGroupId: string,
  messagingGroupId: string | null,
  threadId: string | null,
  sessionMode: 'shared' | 'per-thread' | 'agent-shared',
): string {
  if (sessionMode === 'agent-shared') return `agent\0${agentGroupId}`;
  return `route\0${agentGroupId}\0${messagingGroupId ?? ''}\0${sessionMode === 'shared' ? '' : (threadId ?? '')}`;
}

/**
 * The session mode a wiring's messages in a conversation resolve under, given
 * its resolved thread policy (resolveThreadPolicy): a thread-enabled wiring in
 * a group chat gets a per-thread session regardless of its session_mode.
 * agent-shared is preserved (it's a cross-channel directive the adapter doesn't
 * know about), and DMs collapse sub-threads to one session (is_group=0).
 */
export function effectiveSessionMode(
  wiring: Pick<MessagingGroupAgent, 'session_mode'>,
  mg: Pick<MessagingGroup, 'is_group'>,
  threadsEnabled: boolean,
): MessagingGroupAgent['session_mode'] {
  return threadsEnabled && wiring.session_mode !== 'agent-shared' && mg.is_group !== 0
    ? 'per-thread'
    : wiring.session_mode;
}

/**
 * The active session a messaging group + thread already has, which
 * resolveSession would resolve to; never creates one.
 *
 * Session modes:
 * - 'shared': one session per messaging group (ignores threadId)
 * - 'per-thread': one session per (messaging group, thread)
 * - 'agent-shared': one session per agent group — all messaging groups
 *   wired with this mode share a single session (e.g. GitHub + Slack), so it
 *   is found whichever conversation started it
 */
export async function findSession(
  agentGroupId: string,
  messagingGroupId: string | null,
  threadId: string | null,
  sessionMode: 'shared' | 'per-thread' | 'agent-shared',
): Promise<Session | undefined> {
  if (sessionMode === 'agent-shared') return findSessionByAgentGroup(agentGroupId);
  if (!messagingGroupId) return undefined;
  // Scope lookup by agent_group_id so fan-out to multiple agents in the
  // same chat doesn't accidentally deliver to the wrong agent's session.
  return findSessionForAgent(agentGroupId, messagingGroupId, sessionMode === 'shared' ? null : threadId);
}

/** Find or create a session for a messaging group + thread (session modes: findSession). */
export async function resolveSession(
  agentGroupId: string,
  messagingGroupId: string | null,
  threadId: string | null,
  sessionMode: 'shared' | 'per-thread' | 'agent-shared',
): Promise<{ session: Session; created: boolean }> {
  const key = sessionCreationKey(agentGroupId, messagingGroupId, threadId, sessionMode);
  return withSessionCreationLock(key, async () => {
    const existing = await findSession(agentGroupId, messagingGroupId, threadId, sessionMode);
    if (existing) {
      return { session: existing, created: false };
    }

    const id = generateId();
    const lookupThreadId = sessionMode === 'per-thread' ? threadId : null;
    const session: Session = {
      id,
      agent_group_id: agentGroupId,
      messaging_group_id: messagingGroupId,
      thread_id: lookupThreadId,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: new Date().toISOString(),
    };

    try {
      await createSession(session);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const raced = await findSession(agentGroupId, messagingGroupId, threadId, sessionMode);
      if (!raced) throw error;
      return { session: raced, created: false };
    }
    initSessionFolder(agentGroupId, id);
    log.info('Session created', { id, agentGroupId, messagingGroupId, threadId: lookupThreadId, sessionMode });

    return { session, created: true };
  });
}

/** Find or create the per-agent-group session used for scheduled tasks. */
/** Find or create the isolated session for one task series (thread `system:tasks:<seriesId>`). */
export async function resolveTaskSession(
  agentGroupId: string,
  seriesId: string,
): Promise<{ session: Session; created: boolean }> {
  return resolveSystemSession(agentGroupId, taskThreadId(seriesId));
}

/**
 * Find or create a host-owned system thread without a messaging group.
 * With includeClosed, return closed sessions instead of creating replacements.
 */
export async function resolveSystemSession(
  agentGroupId: string,
  threadId: string,
  options: { includeClosed?: boolean } = {},
): Promise<{ session: Session; created: boolean }> {
  if (!threadId.startsWith('system:')) throw new Error('System session requires a system: thread');
  return withSessionCreationLock(`system\0${agentGroupId}\0${threadId}`, async () => {
    const existing = await findSystemSession(agentGroupId, threadId, options.includeClosed);
    if (existing) return { session: existing, created: false };

    const id = generateId();
    const session: Session = {
      id,
      agent_group_id: agentGroupId,
      messaging_group_id: null,
      thread_id: threadId,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: new Date().toISOString(),
    };

    try {
      await createSession(session);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const raced = await findSystemSession(agentGroupId, threadId, options.includeClosed);
      if (!raced) throw error;
      return { session: raced, created: false };
    }
    initSessionFolder(agentGroupId, id);
    log.info('System session created', { id, agentGroupId, threadId });

    return { session, created: true };
  });
}

/** Create the workspace folders and synchronously prepare the registered mailbox. */
export function initSessionFolder(agentGroupId: string, sessionId: string): void {
  const dir = sessionDir(agentGroupId, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'outbox'), { recursive: true });
  getAgentMailbox().prepare(mailboxKey(agentGroupId, sessionId));
}

/** Destroy one session's implementation-owned mailbox after its container stops. */
export async function destroySessionMailbox(agentGroupId: string, sessionId: string): Promise<void> {
  await getAgentMailbox().destroy(mailboxKey(agentGroupId, sessionId));
  fs.rmSync(sessionContextPath(agentGroupId, sessionId), { force: true });
}

/**
 * Write the current chat/thread routing for a session into its inbound mailbox.
 *
 * The container reads this for tools that take no destination (`ask_user_question`,
 * `send_card`) and to detect a task session (`system:tasks:<id>` thread). Reply
 * threads are not resolved from here — thread_id is null for every session that
 * isn't per-thread — but from the latest messages_in row for the channel.
 * Derived from session.messaging_group_id → messaging_groups row + session.thread_id.
 *
 * Called on every container wake alongside the agent-to-agent module's
 * writeDestinations() (when installed) so the latest routing is always in
 * place, including after admin rewiring.
 */
export async function writeSessionRouting(agentGroupId: string, sessionId: string): Promise<void> {
  const session = await getSession(sessionId);
  if (!session) return;

  let channelType: string | null = null;
  let platformId: string | null = null;
  if (session.messaging_group_id) {
    const mg = await getMessagingGroup(session.messaging_group_id);
    if (mg) {
      channelType = mg.channel_type;
      platformId = mg.platform_id;
    }
  }

  await withMailboxSession(agentGroupId, sessionId, (mailbox) => {
    mailbox.setRouting({
      channelType,
      platformId,
      threadId: session.thread_id,
    });
  });
  log.debug('Session routing written', { sessionId, channelType, platformId, threadId: session.thread_id });
}

/**
 * Write a message to a session's inbound mailbox. Host-only.
 */
export async function writeSessionMessage(
  agentGroupId: string,
  sessionId: string,
  message: {
    id: string;
    kind: InboundMessage['kind'];
    timestamp: string;
    platformId?: string | null;
    channelType?: string | null;
    threadId?: string | null;
    content: string;
    processAfter?: string | null;
    recurrence?: string | null;
    /**
     * true = this message should wake the agent (the default); false = accumulate
     * as context only, don't wake. Host's countDueMessages gates on this
     * column; the container still reads all prior messages as context when
     * a triggering message does arrive.
     */
    trigger?: boolean;
    /**
     * For agent-to-agent inbound: the source session id that emitted the
     * outbound message which became this inbound row. Used as the return
     * path so the target's reply routes back to that exact session.
     */
    sourceSessionId?: string | null;
    /**
     * true = only deliver on the container's first poll (fresh start).
     * Dying containers (past first poll) skip these rows.
     */
    onWake?: boolean;
    /**
     * 'held' = no turn reads the message and nothing wakes for it until a
     * module releases the session's held messages; 'pending' (the default)
     * otherwise.
     */
    status?: 'pending' | 'held';
  },
): Promise<void> {
  // Documented reset: operators `rm -rf` a session folder to clear a stuck
  // session. The sessions row survives, so the next message takes the
  // existing-session path and lands here with a missing mailbox — the open
  // below would throw and the message would be logged-and-dropped forever.
  // Re-provision the folder + mailbox (initSessionFolder is idempotent) so the
  // documented reset actually re-provisions instead of killing the chat.
  initSessionFolder(agentGroupId, sessionId);

  // Extract base64 attachment data, save to inbox, replace with file paths
  const content = extractAttachmentFiles(agentGroupId, sessionId, message.id, message.content);

  await withMailboxSession(agentGroupId, sessionId, async (mailbox) => {
    await mailbox.insertMessage({
      id: message.id,
      kind: message.kind,
      timestamp: message.timestamp,
      platformId: message.platformId ?? null,
      channelType: message.channelType ?? null,
      threadId: message.threadId ?? null,
      content,
      processAfter: message.processAfter ?? null,
      recurrence: message.recurrence ?? null,
      trigger: message.trigger ?? true,
      sourceSessionId: message.sourceSessionId ?? null,
      onWake: message.onWake ?? false,
      status: message.status ?? 'pending',
    });
  });
  await updateSession(sessionId, { last_active: new Date().toISOString() });
  // Ask for a prompt reconcile now that the message is durable: a wake that
  // fails transiently is retried within the queue's cadence instead of
  // waiting for the next resync tick. No-op when the sweep isn't running.
  enqueueSessionReconcile(sessionId);
}

/**
 * Whether `name` in `dir` is this host user's own single-link regular file
 * holding exactly `bytes`: the attachment a source retry staged before. Read
 * through the anchored descriptor, so a symlink or FIFO planted there is
 * refused, never followed.
 */
function holdsStagedOriginal(dir: AnchoredDir, name: string, bytes: Buffer): boolean {
  let fd: number;
  try {
    fd = dir.openReadFd(name);
  } catch (error) {
    // openReadFd refuses a non-regular file with an Error carrying no code.
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    if (code === undefined || code === 'ELOOP' || code === 'ENOENT') return false;
    throw error;
  }
  try {
    const info = fs.fstatSync(fd);
    return (
      info.nlink === 1 &&
      info.size === bytes.length &&
      (typeof process.getuid !== 'function' || info.uid === process.getuid()) &&
      fs.readFileSync(fd).equals(bytes)
    );
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * If message content has attachments with base64 `data`, save them to
 * the session's inbox directory and replace with `localPath`.
 *
 * Both `messageId` and `att.name` originate in untrusted input. WhatsApp
 * passes `msg.key.id` through raw (and that field is client generated, so a
 * peer can craft it), and other adapters may follow. The session dir is
 * mounted writable into the container, so the agent owns the `inbox` and
 * `inbox/<msgId>` names and can turn either into a symlink at any time.
 *
 * Defenses:
 *   1. basename check on `filename`; a `messageId` that is not a safe file
 *      name (every Google Chat ID holds `/`) names its folder by a hash.
 *   2. `inbox/<folder>` is opened as an AnchoredDir, refusing symlinks, and
 *      every attachment is written through that descriptor, so a later swap
 *      of either name cannot redirect a write.
 *   3. exclusive create: never follows or overwrites an existing entry. A
 *      source retry may reuse only the identical file it staged before.
 */
function extractAttachmentFiles(
  agentGroupId: string,
  sessionId: string,
  messageId: string,
  contentStr: string,
): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(contentStr);
  } catch {
    return contentStr;
  }

  const attachments = parsed.attachments as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(attachments)) return contentStr;

  const inboxFolder = inboxFolderName(messageId);
  // Opened lazily on the first attachment that actually carries bytes, so a
  // message whose attachments have no inline `data` never creates an inbox dir.
  let inbox: AnchoredDir | null | undefined;

  let changed = false;
  try {
    for (const att of attachments) {
      if (typeof att.data !== 'string') continue;

      const rawName = deriveAttachmentName(att);
      const filename = isSafeAttachmentName(rawName) ? rawName : `attachment-${Date.now()}`;
      if (filename !== rawName) {
        log.warn('Refused unsafe attachment filename, would escape inbox', {
          messageId,
          rawName,
          replacement: filename,
        });
      }

      if (inbox === undefined) {
        try {
          inbox = AnchoredDir.open(sessionDir(agentGroupId, sessionId), ['inbox', inboxFolder], true);
        } catch (err) {
          log.warn('Rejecting unsafe inbox directory', { messageId, err });
          inbox = null;
        }
      }
      // Unsafe inbox — no attachment can be written safely.
      if (!inbox) break;

      const bytes = Buffer.from(att.data as string, 'base64');
      try {
        inbox.writeNewFile(filename, bytes);
      } catch (err: unknown) {
        const e = err as NodeJS.ErrnoException;
        if (e.code !== 'EEXIST') throw err;
        // A source retry may find the original bytes already staged.
        if (!holdsStagedOriginal(inbox, filename, bytes)) {
          log.warn('Inbox attachment target is not the original staged file; refusing reuse', {
            messageId,
            filename,
          });
          continue;
        }
      }

      att.name = filename;
      att.localPath = `inbox/${inboxFolder}/${filename}`;
      delete att.data;
      changed = true;
      log.debug('Saved attachment to inbox', { messageId, filename, size: att.size });
    }
  } finally {
    inbox?.close();
  }

  return changed ? JSON.stringify(parsed) : contentStr;
}

/**
 * Detects same-key session() nesting, which is forbidden: implementations may
 * serialize session() per key, so a nested call may deadlock. Tracked per async context so
 * legitimately concurrent top-level sessions on the same key don't trip it.
 */
const activeMailboxKeys = new AsyncLocalStorage<ReadonlySet<string>>();

/** Run one host operation against a session mailbox. The implementation owns persistence.
 *
 * Never call this (directly or via helpers like writeSessionMessage) from
 * inside another withMailboxSession action on the same session — finish the
 * open session first. See AgentMailbox.session in src/mailbox/types.ts.
 */
export function withMailboxSession<T>(
  agentGroupId: string,
  sessionId: string,
  action: (mailbox: MailboxSession) => T | Promise<T>,
): Promise<T> {
  return runMailboxSession(agentGroupId, sessionId, action, true) as Promise<T>;
}

/** Run against an already-provisioned mailbox without creating storage. */
export function withExistingMailboxSession<T>(
  agentGroupId: string,
  sessionId: string,
  action: (mailbox: MailboxSession) => T | Promise<T>,
): Promise<T | undefined> {
  return runMailboxSession(agentGroupId, sessionId, action, false);
}

async function runMailboxSession<T>(
  agentGroupId: string,
  sessionId: string,
  action: (mailbox: MailboxSession) => T | Promise<T>,
  provision: boolean,
): Promise<T | undefined> {
  const store = getAgentMailbox();
  const key = mailboxKey(agentGroupId, sessionId);
  const keyId = `${agentGroupId}/${sessionId}`;
  const held = activeMailboxKeys.getStore();
  if (held?.has(keyId)) {
    throw new Error(`Nested mailbox session for ${keyId} — serialized implementations would deadlock here`);
  }
  if (provision) store.prepare(key);
  else if (!(await store.exists(key))) return undefined;
  return activeMailboxKeys.run(new Set(held).add(keyId), () => store.session(key, action));
}

/**
 * Write a message directly to a session's outbound mailbox so the host delivery
 * loop picks it up.
 *
 * The selected mailbox owns persistence and sequencing. With the SQLite mailbox,
 * outbound.db belongs to the container: call this only while none is running,
 * because across a VM file share (Docker Desktop) the two writers can't see each
 * other's locks and writes get lost.
 */
export function writeOutboundDirect(
  agentGroupId: string,
  sessionId: string,
  message: {
    id: string;
    kind: string;
    platformId: string | null;
    channelType: string | null;
    threadId: string | null;
    content: string;
  },
): Promise<void> {
  return withMailboxSession(agentGroupId, sessionId, (mailbox) => mailbox.writeDirect(message));
}

/**
 * Load outbox attachments for a delivered message.
 *
 * Symmetric with `extractAttachmentFiles` on the inbound side: the container
 * writes files into the session's `outbox/<messageId>/` directory alongside
 * its outbound message, and the host reads them back at delivery time.
 *
 * Returns undefined when the outbox dir is missing or no declared file was
 * actually on disk — delivery continues without attachments rather than
 * failing the whole message.
 */
export function readOutboxFiles(
  agentGroupId: string,
  sessionId: string,
  messageId: string,
  filenames: string[],
): OutboundFile[] | undefined {
  if (!isSafeAttachmentName(messageId)) {
    log.warn('Rejecting unsafe outbox message id', { messageId });
    return undefined;
  }

  // The container owns `outbox` and everything below it: read only through
  // descriptors, refusing symlinks at every level.
  let outbox: AnchoredDir | null;
  try {
    outbox = AnchoredDir.open(sessionDir(agentGroupId, sessionId), ['outbox', messageId]);
  } catch (err) {
    log.warn('Rejecting unsafe outbox directory', { messageId, err });
    return undefined;
  }
  if (!outbox) return undefined;

  const files: OutboundFile[] = [];
  try {
    for (const filename of filenames) {
      if (!isSafeAttachmentName(filename)) {
        log.warn('Refused unsafe outbox filename, would escape outbox', { messageId, filename });
        continue;
      }
      try {
        files.push({ filename, data: outbox.readFile(filename) });
      } catch (err) {
        log.warn('Outbox file missing or not a regular file', { messageId, filename, err });
      }
    }
  } finally {
    outbox.close();
  }
  return files.length > 0 ? files : undefined;
}

/**
 * Remove a message's outbox directory after successful delivery. Best-effort:
 * failures log and swallow. A cleanup failure must NOT propagate to the
 * delivery caller — the message is already on the user's screen, and a
 * thrown error would trigger the delivery retry path and deliver twice.
 */
export function clearOutbox(agentGroupId: string, sessionId: string, messageId: string): void {
  if (!isSafeAttachmentName(messageId)) {
    log.warn('Rejecting unsafe outbox cleanup message id', { messageId });
    return;
  }

  let outbox: AnchoredDir | null = null;
  try {
    outbox = AnchoredDir.open(sessionDir(agentGroupId, sessionId), ['outbox']);
    const dir = outbox?.openDir(messageId);
    if (!outbox || !dir) return;
    // One level, no recursion: a message outbox holds the files it delivered.
    // Anything else surfaces as an error below instead of being walked.
    try {
      for (const entry of dir.entries()) dir.unlink(entry);
    } finally {
      dir.close();
    }
    outbox.rmdir(messageId);
  } catch (err) {
    log.warn('Outbox cleanup failed (message already delivered)', { messageId, err });
  } finally {
    outbox?.close();
  }
}

/** Mark a container as running for a session. */
export async function markContainerRunning(sessionId: string): Promise<void> {
  await updateSession(sessionId, { container_status: 'running', last_active: new Date().toISOString() });
}

/** Mark a container as idle for a session. */
export async function markContainerIdle(sessionId: string): Promise<void> {
  await updateSession(sessionId, { container_status: 'idle' });
}

/** Mark a container as stopped for a session. */
export async function markContainerStopped(sessionId: string): Promise<void> {
  await updateSession(sessionId, { container_status: 'stopped' });
}
