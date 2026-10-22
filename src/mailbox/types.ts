import type {
  ContainerRecord,
  DestinationRecord,
  DirectOutboundWrite,
  InboundWrite,
  InboundRecord,
  InboundStatus,
  OutboundRecord,
  OutboundDelivery,
  ProcessingAckRecord,
  SessionRoutingRecord,
  TaskRecord as CanonicalTaskRecord,
  TaskWrite,
} from './model.js';

export type {
  ContainerRecord,
  DeliveryRecord,
  DestinationRecord,
  DirectOutboundWrite,
  InboundRecord,
  InboundStatus,
  InboundWrite,
  IsoTimestamp,
  OutboundDelivery,
  OutboundRecord,
  OutboundWrite,
  ProcessingAckRecord,
  ProcessingStatus,
  SessionRoutingRecord,
  StateRecord,
  TaskStatus,
  TaskWrite,
} from './model.js';

export interface MailboxSessionKey {
  agentGroupId: string;
  sessionId: string;
}

export interface HeldReleaseOptions {
  readonly preserveTriggers?: boolean;
  readonly preserveProcessAfter?: boolean;
}

export type ProcessingAck = ProcessingAckRecord;
export type Destination = DestinationRecord;
export type SessionRouting = SessionRoutingRecord;
export type InboundMessage = InboundWrite;
export type DirectOutboundMessage = DirectOutboundWrite;

export interface MessageRetry {
  id: string;
  tries: number;
  processAfter: string | null;
  /** Where the message came from, for the hooks told the host gave up on it (src/reconcile-session.ts). */
  kind: string;
  channelType: string | null;
  platformId: string | null;
  threadId: string | null;
}

/**
 * An inbound message as it arrived: its kind, the series a task belongs to,
 * its conversation, and its content, which names its sender.
 */
export interface InboundOrigin {
  id: string;
  kind: string;
  seriesId: string | null;
  channelType: string | null;
  platformId: string | null;
  threadId: string | null;
  content: string;
}

/** A pending inbound message that waits for its `process_after`. */
export interface WaitingMessage {
  id: string;
  /** Attempts so far: a retried message waits out its backoff. */
  tries: number;
  processAfter: string;
}

export interface ProcessingClaim {
  messageId: string;
  statusChanged: string;
}

export type ContainerState = Omit<ContainerRecord, 'updatedAt'>;
export type OutboundMessage = OutboundDelivery;
export type Task = TaskWrite;

export interface TaskUpdate {
  prompt?: string;
  script?: string | null;
  recurrence?: string | null;
  processAfter?: string;
}

export type TaskRecord = CanonicalTaskRecord;

export interface TaskStats {
  runs: number;
  lastRun: string | null;
  failedRuns: number;
}

export interface RecurringMessage {
  id: string;
  content: string;
  recurrence: string;
  seriesId: string;
}

export interface MailboxHistoryMessage {
  timestamp: string;
  kind: string;
  content: string;
}

export interface MailboxTimelineMessage {
  timestamp: string;
  content: string;
}

/** Host-visible inbound mailbox behavior. Storage layout and lifecycle are implementation-private. */
export interface InboundMailbox {
  setRouting(routing: SessionRouting): void;
  replaceDestinations(entries: Destination[]): void;
  insertMessage(message: InboundMessage): Promise<void>;
  countDueMessages(): number;
  /**
   * How many due messages wait, waking nothing, as context for the next
   * turn: pending non-trigger rows, other than those on `exceptChannelType`.
   */
  countUnreadContext(exceptChannelType: string): number;
  /**
   * Release every held message: each becomes a pending trigger, due at
   * `processAfter` (null: due now). With preserveTriggers, retain each row's
   * original engagement instead. With preserveProcessAfter, retain each row's
   * stored deadline. Returns how many it released.
   */
  releaseHeldMessages(processAfter: string | null, options?: HeldReleaseOptions): number;
  /**
   * Settle every held message: each is completed unread, so no turn ever
   * reads it and no later release brings it back. Returns how many it settled.
   */
  settleHeldMessages(): number;
  /** Complete unread transferred pending/held rows only, after their durable destination insert. */
  settleUnreadMessages(messageIds: readonly string[]): number;
  markMessageFailed(messageId: string): void;
  retryWithBackoff(messageId: string, backoffSec: number): void;
  getMessageForRetry(messageId: string, status: 'pending' | 'processing'): MessageRetry | undefined;
  /** Pending messages whose `process_after` is still ahead, soonest first. */
  getWaitingMessages(): WaitingMessage[];
  /** Whether the mailbox holds a message with this id, whatever its status. */
  hasMessage(messageId: string): boolean;
  /** The messages with these ids, whatever their status, in the order they arrived; an id it lacks is left out. */
  getInboundMessages(messageIds: readonly string[]): InboundOrigin[];
  /** Stable source identities and lifecycle facts, in arrival order, for resumable host cutovers. */
  getInboundRecords(options?: { readonly since?: string; readonly status?: InboundStatus }): InboundRecord[];
  applyProcessingAcks(acks: ProcessingAck[]): void;
  getDeliveredIds(status?: 'delivered'): Set<string>;
  markDelivered(messageOutId: string, platformMessageId: string | null): void;
  markDeliveryFailed(messageOutId: string): void;
  getInboundSourceSessionId(messageId: string): string | null;
  getMostRecentPeerSourceSessionId(peerAgentGroupId: string): string | null;
  insertTask(task: Task): Promise<void>;
  cancelTask(taskId?: string): number;
  pauseTask(taskId: string): number;
  resumeTask(taskId: string): number;
  deleteTask(taskId: string): number;
  updateTask(taskId: string, update: TaskUpdate): number;
  listLiveTasks(status?: 'pending' | 'paused'): TaskRecord[];
  getTask(taskId: string): TaskRecord | undefined;
  getTaskStats(seriesId: string): TaskStats;
  getCompletedRecurring(): RecurringMessage[];
  trailingFailedRuns(seriesId: string): number;
  clearRecurrence(messageId: string): void;
  /**
   * Atomically insert a series' next occurrence and clear the recurrence on
   * the completed original — one durable step. Split writes tear on a crash:
   * an inserted next occurrence with the original's recurrence intact
   * re-clones the series on the following tick (duplicate runs), while the
   * reverse order silently kills the series. Durable when the promise
   * resolves, like insertTask.
   */
  armNextTask(originalId: string, task: Task): Promise<void>;
  countLiveTasks(): number;
  prunePendingMessages(channelType: string, before: string, keep: number): number;
  getInboundHistory(limit: number): MailboxHistoryMessage[];
  getConversationRoot(): MailboxTimelineMessage | undefined;
  findTaskBySeriesSlug(slug: string): TaskRecord | undefined;
}

/** Host-visible outbound mailbox behavior. Storage layout and lifecycle are implementation-private. */
export interface OutboundMailbox {
  /** Stable outbound source rows since an inclusive timestamp, in arrival order. */
  getOutboundRecords(since: string): OutboundRecord[];
  /** Read one immutable container request by its exact outbound id. Host only. */
  getOutboundMessage(id: string): OutboundMessage | undefined;
  getTerminalProcessingAcks(): ProcessingAck[];
  getProcessingClaims(): ProcessingClaim[];
  deleteOrphanProcessingClaims(): number;
  getContainerState(): ContainerState | null;
  getDueMessages(excludeIds?: ReadonlySet<string>): OutboundMessage[];
  writeDirect(message: DirectOutboundMessage): Promise<void>;
  getOutboundHistory(limit: number): MailboxHistoryMessage[];
  getTopLevelOutbound(limit: number): MailboxTimelineMessage[];
}

export interface MailboxSession extends InboundMailbox, OutboundMailbox {
  /** Latest successful delivered chat to this agent; failed and pending rows do not count. */
  getLatestDeliveredAgentReport(targetAgentGroupId: string): MailboxHistoryMessage | undefined;
}

export interface AgentMailbox {
  /** True only when this implementation already owns storage for the key. Must not provision it. */
  exists(key: MailboxSessionKey): Promise<boolean>;
  /** Authorize/provision this implementation's storage for a later session(). */
  prepare(key: MailboxSessionKey): void;
  destroy(key: MailboxSessionKey): Promise<void>;
  runnerContext(key: MailboxSessionKey): Promise<unknown>;
  /** Non-secret runner configuration only; never credentials, authorization material, or identity. */
  runnerEnvironment(key: MailboxSessionKey): Promise<Record<string, string>>;
  /**
   * Run one logical operation against a session's mailbox.
   *
   * Contract, both directions:
   * - session() never provisions storage by itself. Callers that intend to
   *   create/write call prepare() first; read-only callers check exists().
   * - Implementations may serialize session() per key while loading and
   *   committing their session state. Callers must therefore NEVER open a
   *   nested session() for the same key from inside an action —
   *   withMailboxSession enforces this. Sessions for other keys, or
   *   sequential sessions, are fine.
   * - The sync MailboxSession methods operate on implementation-managed
   *   session state; their effects need only be durable once session()
   *   resolves. The async writes (insertMessage, insertTask, writeDirect)
   *   must be durable when their own promise resolves — callers wake
   *   containers on the strength of them.
   */
  session<T>(key: MailboxSessionKey, action: (mailbox: MailboxSession) => T | Promise<T>): Promise<T>;
}

export type AgentMailboxFactory = () => AgentMailbox;
