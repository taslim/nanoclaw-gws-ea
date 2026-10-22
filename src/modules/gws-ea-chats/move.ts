import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { isContainerRunning, killContainer } from '../../container-runner.js';
import { getDb } from '../../db/connection.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getSession, updateSession } from '../../db/sessions.js';
import { GwsEaError } from '../../gws-ea/types.js';
import { isRecord } from '../../gws-ea/validation.js';
import { onHostShutdown, onHostStart } from '../../host-lifecycle.js';
import { log } from '../../log.js';
import type { InboundRecord } from '../../mailbox/types.js';
import { requestWake } from '../../request-wake.js';
import {
  resolveSession,
  sessionDir,
  withExistingMailboxSession,
  withMailboxSession,
  writeSessionMessage,
} from '../../session-manager.js';
import type { Session } from '../../types.js';
import { activateJobAgent, createJobAgent, getJobAgentForChat } from '../gws-ea-chat-agents/jobs.js';
import { retireJobAgent } from '../gws-ea-chat-agents/retire.js';
import { isDuplicateNote, writeNoteForMain } from '../gws-ea-profile/main-note.js';
import { getGwsEaProfile } from '../gws-ea-profile/db.js';
import { setLinkHandler } from '../gws-ea-matters/db.js';
import { flushChatHandoffs, inChatConversation } from './bridge.js';
import { getChat, listChats, type Chat } from './db.js';
import { releaseChatMessages } from './hold.js';
import { movedReminderId } from './remind.js';
import { ensureChatWiring } from './wiring-policy.js';

interface ReminderSource {
  readonly session: string;
  readonly id: string;
}
interface MoveState {
  readonly move_source_session_id: string | null;
  readonly move_request_id: string | null;
  readonly move_pending_reminder_ids_json: string;
  readonly move_failed: number;
}
async function moveState(chat: string): Promise<MoveState> {
  const row = await getDb().get<MoveState>(
    'SELECT move_source_session_id,move_request_id,move_pending_reminder_ids_json,move_failed FROM gws_ea_chats WHERE messaging_group_id=?',
    chat,
  );
  if (!row) throw new Error('The moving chat disappeared.');
  return row;
}
function pendingReminders(state: MoveState): ReminderSource[] {
  const value: unknown = JSON.parse(state.move_pending_reminder_ids_json);
  if (
    !Array.isArray(value) ||
    !value.every(
      (item): item is ReminderSource =>
        isRecord(item) && typeof item.session === 'string' && typeof item.id === 'string',
    )
  )
    throw new Error('The chat move reminder record is invalid.');
  return value;
}

export interface ChatMoveAdmission {
  readonly sourceSessionId: string;
  readonly pending: readonly ReminderSource[];
}
/** Read the native mailbox before entering the central handoff transaction. Caller owns the tail. */
export async function prepareChatMove(chat: Chat): Promise<ChatMoveAdmission> {
  const source = (await resolveSession(chat.serving_agent_group_id, chat.messaging_group_id, null, 'shared')).session;
  const pending =
    (await withExistingMailboxSession(source.agent_group_id, source.id, (mailbox) =>
      mailbox.listLiveTasks('pending').map((task) => ({ session: source.id, id: task.id })),
    )) ?? [];
  return { sourceSessionId: source.id, pending };
}
/** DB-only admission joins the checked handoff in one central transaction. */
export async function admitChatMove(
  chat: Chat,
  admission: ChatMoveAdmission | undefined,
  requestId: string,
): Promise<void> {
  if (chat.state === 'moving' || chat.state === 'job') return;
  if ((await moveState(chat.messaging_group_id)).move_source_session_id !== null) return;
  if (chat.state !== 'connected' || !admission) throw new Error('Only a prepared connected chat can move.');
  await getDb().run(
    "UPDATE gws_ea_chats SET state='moving',move_source_session_id=?,move_request_id=?,move_pending_reminder_ids_json=?,move_failed=0,updated_at=? WHERE messaging_group_id=?",
    admission.sourceSessionId,
    requestId,
    JSON.stringify(admission.pending),
    new Date().toISOString(),
    chat.messaging_group_id,
  );
}
async function sameMove(chat: Chat, state: MoveState): Promise<boolean> {
  const current = await getChat(chat.messaging_group_id);
  if (current?.created_at !== chat.created_at) return false;
  const stored = await moveState(chat.messaging_group_id);
  return (
    stored.move_source_session_id === state.move_source_session_id && stored.move_request_id === state.move_request_id
  );
}
/** Repeated after admission and on recovery. Save the original pending set before the first mailbox pause. */
export async function pauseMoveReminders(chatId: string): Promise<void> {
  const state = await moveState(chatId);
  if (!state.move_source_session_id) return;
  const source = await getSession(state.move_source_session_id);
  if (!source) throw new Error('The chat move source session disappeared.');
  await withExistingMailboxSession(source.agent_group_id, source.id, (mailbox) => {
    for (const task of mailbox.listLiveTasks()) mailbox.pauseTask(task.id);
  });
}
async function stopSource(source: Session): Promise<void> {
  if (!isContainerRunning(source.id)) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('The chat container has not stopped; its move will resume.')),
      30_000,
    );
    killContainer(source.id, 'chat-move', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}
async function drained(source: Session): Promise<boolean> {
  return (
    (await withExistingMailboxSession(source.agent_group_id, source.id, (mailbox) => {
      mailbox.applyProcessingAcks(mailbox.getTerminalProcessingAcks());
      const delivered = mailbox.getDeliveredIds();
      return (
        mailbox.getProcessingClaims().length === 0 &&
        mailbox.countDueMessages() === 0 &&
        mailbox.getDueMessages(delivered).length === 0
      );
    })) ?? true
  );
}
function seedId(source: Session, side: 'in' | 'out', id: string): string {
  return `chat-move-seed-${createHash('sha256').update(`${source.id}\0${side}\0${id}`).digest('hex')}`;
}
/** Rehydrate only attachments under this source session's inbox; the native writer owns the new paths. */
function carriedContent(source: Session, content: string): string {
  const parsed: unknown = JSON.parse(content);
  if (!isRecord(parsed) || !Array.isArray(parsed.attachments)) return content;
  const inbox = path.join(sessionDir(source.agent_group_id, source.id), 'inbox');
  const attachments = parsed.attachments.map((value: unknown) => {
    if (!isRecord(value) || typeof value.localPath !== 'string') return value;
    const file = fs.realpathSync(path.resolve(sessionDir(source.agent_group_id, source.id), value.localPath));
    const root = fs.realpathSync(inbox);
    if (!file.startsWith(`${root}${path.sep}`) || !fs.statSync(file).isFile())
      throw new Error('A chat attachment is outside its source inbox.');
    const bytes = fs.readFileSync(file);
    const { localPath: _localPath, ...attachment } = value;
    return { ...attachment, data: bytes.toString('base64') };
  });
  return JSON.stringify({ ...parsed, attachments });
}
async function insertOnce(target: Session, message: Parameters<typeof writeSessionMessage>[2]): Promise<void> {
  if (await withExistingMailboxSession(target.agent_group_id, target.id, (mailbox) => mailbox.hasMessage(message.id)))
    return;
  try {
    await writeSessionMessage(target.agent_group_id, target.id, message);
  } catch (error) {
    if (!isDuplicateNote(error)) throw error;
  }
}
async function seedConversation(chat: Chat, source: Session, target: Session): Promise<void> {
  const group = await getMessagingGroup(chat.messaging_group_id);
  if (!group) throw new Error('The moving chat disappeared.');
  const since = new Date(
    Math.max(Date.parse(chat.connected_at ?? chat.created_at), Date.now() - 14 * 24 * 60 * 60_000),
  ).toISOString();
  const sender = (await getGwsEaProfile()).assistant_display_name ?? 'Assistant';
  const history =
    (await withExistingMailboxSession(source.agent_group_id, source.id, (mailbox) => {
      const delivered = mailbox.getDeliveredIds('delivered');
      return [
        ...mailbox
          .getInboundRecords({ since })
          .filter(
            (row) =>
              row.status !== 'held' &&
              row.status !== 'pending' &&
              row.kind !== 'task' &&
              row.channelType === group.channel_type &&
              row.platformId === group.platform_id,
          )
          .map((row) => ({
            id: row.id.endsWith(`:${source.agent_group_id}`)
              ? movedInboundId(row, source, target)
              : seedId(source, 'in', row.id),
            timestamp: row.timestamp,
            content: carriedContent(source, row.content),
          })),
        ...mailbox
          .getOutboundRecords(since)
          .filter(
            (row) =>
              delivered.has(row.id) &&
              (row.kind === 'chat' || row.kind === 'chat-sdk') &&
              row.channelType === group.channel_type &&
              row.platformId === group.platform_id,
          )
          .map((row) => ({
            id: seedId(source, 'out', row.id),
            timestamp: row.timestamp,
            content: JSON.stringify({ ...(JSON.parse(row.content) as Record<string, unknown>), sender, self: true }),
          })),
      ].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    })) ?? [];
  for (const row of history)
    await insertOnce(target, {
      ...row,
      kind: 'chat',
      channelType: 'chat-seed',
      platformId: null,
      threadId: null,
      trigger: false,
    });
}
async function copyReminders(source: Session, target: Session): Promise<void> {
  const tasks =
    (await withExistingMailboxSession(source.agent_group_id, source.id, (mailbox) => mailbox.listLiveTasks())) ?? [];
  await withMailboxSession(target.agent_group_id, target.id, async (mailbox) => {
    for (const task of tasks) {
      const id = movedReminderId(source.id, task.id);
      if (!mailbox.getTask(id))
        await mailbox.insertTask({
          id,
          seriesId: movedReminderId(source.id, task.seriesId ?? task.id),
          content: task.content,
          processAfter: task.processAfter,
          recurrence: task.recurrence,
          status: 'paused',
        });
    }
  });
}
function movedInboundId(row: InboundRecord, source: Session, target: Session): string {
  const suffix = `:${source.agent_group_id}`;
  return row.id.endsWith(suffix) ? `${row.id.slice(0, -suffix.length)}:${target.agent_group_id}` : row.id;
}
async function copyHolds(source: Session, target: Session): Promise<void> {
  const rows =
    (await withExistingMailboxSession(source.agent_group_id, source.id, (mailbox) =>
      [...mailbox.getInboundRecords({ status: 'held' }), ...mailbox.getInboundRecords({ status: 'pending' })]
        .filter((row) => row.kind !== 'task')
        .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0)),
    )) ?? [];
  for (const row of rows) {
    await insertOnce(target, {
      ...row,
      id: movedInboundId(row, source, target),
      content: carriedContent(source, row.content),
      status: 'held',
    });
    await withExistingMailboxSession(source.agent_group_id, source.id, (mailbox) =>
      mailbox.settleUnreadMessages([row.id]),
    );
  }
}
async function undoMove(chat: Chat, source: Session, state: MoveState): Promise<void> {
  if (!(await sameMove(chat, state))) return;
  const job = await getJobAgentForChat(chat.messaging_group_id);
  if (job) {
    const sessions = await getDb().all<Session>('SELECT * FROM sessions WHERE agent_group_id=?', job.agent_group_id);
    for (const target of sessions)
      await withExistingMailboxSession(target.agent_group_id, target.id, (mailbox) => {
        for (const task of mailbox.listLiveTasks()) mailbox.deleteTask(task.id);
      });
    await retireJobAgent(job.agent_group_id);
  }
  const group = await getMessagingGroup(chat.messaging_group_id);
  const noted = await writeNoteForMain({
    id: `chat-move-failed-${state.move_request_id}`,
    timestamp: new Date().toISOString(),
    text: `The host could not move chat ${JSON.stringify(group?.name ?? chat.messaging_group_id)} to its own assistant. Its conversation and reminders remain with the assistant already helping there.`,
    wake: true,
  });
  if (noted === 'no-main' || noted === 'no-principal')
    throw new Error('There is no principal conversation to report the failed chat move.');
  await getDb().run(
    "UPDATE gws_ea_chats SET state='connected',updated_at=? WHERE messaging_group_id=? AND state='moving'",
    new Date().toISOString(),
    chat.messaging_group_id,
  );
  await flushChatHandoffs(chat.messaging_group_id, { wake: false });
  await releaseChatMessages(chat.messaging_group_id, { wake: false });
  await withExistingMailboxSession(source.agent_group_id, source.id, (mailbox) => {
    for (const task of pendingReminders(state)) if (task.session === source.id) mailbox.resumeTask(task.id);
  });
  await getDb().run(
    "UPDATE gws_ea_chats SET move_source_session_id=NULL,move_request_id=NULL,move_pending_reminder_ids_json='[]',move_failed=0 WHERE messaging_group_id=?",
    chat.messaging_group_id,
  );
  if (await withExistingMailboxSession(source.agent_group_id, source.id, (mailbox) => mailbox.countDueMessages() > 0))
    await requestWake(source, 'due-message');
}
async function finishMove(chat: Chat, source: Session, target: Session, state: MoveState): Promise<void> {
  await copyHolds(source, target);
  await updateSession(source.id, { status: 'closed' });
  await withExistingMailboxSession(source.agent_group_id, source.id, (mailbox) => mailbox.cancelTask());
  await withMailboxSession(target.agent_group_id, target.id, (mailbox) => {
    for (const task of pendingReminders(state)) mailbox.resumeTask(movedReminderId(task.session, task.id));
  });
  await getDb().run(
    "UPDATE gws_ea_chats SET state='job',updated_at=? WHERE messaging_group_id=? AND state='moving'",
    new Date().toISOString(),
    chat.messaging_group_id,
  );
  await flushChatHandoffs(chat.messaging_group_id, { wake: false });
  await releaseChatMessages(chat.messaging_group_id, { wake: false });
  await getDb().run(
    "UPDATE gws_ea_chats SET move_source_session_id=NULL,move_request_id=NULL,move_pending_reminder_ids_json='[]',move_failed=0 WHERE messaging_group_id=?",
    chat.messaging_group_id,
  );
  if (await withExistingMailboxSession(target.agent_group_id, target.id, (mailbox) => mailbox.countDueMessages() > 0))
    await requestWake(target, 'due-message');
}

/** One host-run move. Durable registry/chat/mailbox state makes each step safe to repeat after host restart. */
export async function moveChat(chatId: string): Promise<void> {
  let chat = await getChat(chatId);
  if (chat?.state !== 'moving' && chat?.state !== 'job' && chat?.state !== 'connected') return;
  const epoch = chat;
  const state = await moveState(chatId);
  if (!state.move_source_session_id) return;
  const source = state.move_source_session_id ? await getSession(state.move_source_session_id) : undefined;
  if (!source) throw new Error('The moving chat has no source session.');
  if (state.move_failed) {
    const failed = chat;
    return inChatConversation(chatId, () => undoMove(failed, source, state));
  }
  try {
    await pauseMoveReminders(chatId);
    let job = await getJobAgentForChat(chatId);
    if (job?.state === 'retiring') {
      await retireJobAgent(job.agent_group_id);
      job = undefined;
    }
    if (!job || job.state === 'creating') job = await createJobAgent(chatId);
    chat = await getChat(chatId);
    if (!(await sameMove(epoch, state)) || (chat?.state !== 'moving' && chat?.state !== 'job')) {
      await retireJobAgent(job.agent_group_id);
      return;
    }
    const target = (await resolveSession(job.agent_group_id, chatId, null, 'shared')).session;
    if (!(await sameMove(epoch, state))) {
      await updateSession(target.id, { status: 'closed' });
      await retireJobAgent(job.agent_group_id);
      return;
    }
    if (job.state === 'creating') {
      if (!(await drained(source))) {
        if (await sameMove(epoch, state)) await requestWake(source, 'due-message');
        return;
      }
      await stopSource(source);
      if (!(await sameMove(epoch, state))) {
        await retireJobAgent(job.agent_group_id);
        return;
      }
      if (!(await drained(source))) return;
      await seedConversation(chat, source, target);
      await copyReminders(source, target);
    }
    await inChatConversation(chatId, async () => {
      const current = await getChat(chatId);
      if (!(await sameMove(epoch, state)) || (current?.state !== 'moving' && current?.state !== 'job')) {
        await retireJobAgent(job.agent_group_id);
        return;
      }
      if (job.state === 'creating')
        await getDb().transaction(async () => {
          await getDb().run(
            'UPDATE gws_ea_chats SET serving_agent_group_id=? WHERE messaging_group_id=?',
            job.agent_group_id,
            chatId,
          );
          await activateJobAgent(job.agent_group_id);
          await setLinkHandler({ kind: 'chat', reference: chatId }, job.agent_group_id);
          const next = await getChat(chatId);
          if (!next) throw new Error('The moving chat disappeared.');
          await ensureChatWiring(next);
          await getDb().run(
            'DELETE FROM messaging_group_agents WHERE messaging_group_id=? AND agent_group_id<>?',
            chatId,
            job.agent_group_id,
          );
        });
      await finishMove(current, source, target, state);
    });
  } catch (error) {
    if (error instanceof GwsEaError && error.code === 'instance_busy') throw error;
    if (!(await sameMove(epoch, state))) return;
    const current = await getChat(chatId);
    const job = await getJobAgentForChat(chatId);
    if (current?.state !== 'moving' || job?.state === 'active') throw error;
    await getDb().run('UPDATE gws_ea_chats SET move_failed=1 WHERE messaging_group_id=?', chatId);
    await inChatConversation(chatId, () => undoMove(current, source, state));
    log.warn('Chat move returned to its original conversation', { chatId, error });
  }
}
const moveTails = new Map<string, Promise<void>>();
/** Move steps for one chat run one at a time, whether its driver or the sweep asks. */
async function serialMoveChat(chatId: string): Promise<void> {
  const previous = moveTails.get(chatId) ?? Promise.resolve();
  const result = previous.then(() => moveChat(chatId));
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  moveTails.set(chatId, tail);
  try {
    await result;
  } finally {
    if (moveTails.get(chatId) === tail) moveTails.delete(chatId);
  }
}
/** Whether moveChat still has work for this chat: the same test it starts with. */
async function moveOwed(chatId: string): Promise<boolean> {
  const chat = await getChat(chatId);
  if (chat?.state !== 'moving' && chat?.state !== 'job' && chat?.state !== 'connected') return false;
  return (await moveState(chatId)).move_source_session_id !== null;
}

const DRIVE_RETRY_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];
const drives = new Map<string, Promise<void>>();
let driving: AbortController | undefined;
async function drive(chatId: string, signal: AbortSignal): Promise<void> {
  /* eslint-disable no-catch-all/no-catch-all -- a failed step is retried on the next beat; it must not end the drive */
  for (let attempt = 0; !signal.aborted; attempt++) {
    try {
      await serialMoveChat(chatId);
      if (!(await moveOwed(chatId))) return;
    } catch (error) {
      if (!(error instanceof GwsEaError && error.code === 'instance_busy'))
        log.error('Chat move will resume', { chatId, error });
    }
    try {
      await sleep(DRIVE_RETRY_MS[Math.min(attempt, DRIVE_RETRY_MS.length - 1)], undefined, { signal, ref: false });
    } catch {
      return;
    }
  }
  /* eslint-enable no-catch-all/no-catch-all */
}
/**
 * Carry an admitted move through now instead of at the next sweep. Each step
 * that waits on the old conversation is retried soon, then less often, until
 * the move finishes or is undone. Inert until the host starts.
 */
export function driveChatMove(chatId: string): void {
  if (!driving || drives.has(chatId)) return;
  const run = drive(chatId, driving.signal).finally(() => drives.delete(chatId));
  drives.set(chatId, run);
}
onHostStart(() => {
  driving = new AbortController();
});
onHostShutdown(async () => {
  driving?.abort();
  driving = undefined;
  await Promise.all(drives.values());
});

/** The sweep's resume after a restart, and for any move its driver has left. */
export async function resumeChatMoves(): Promise<void> {
  /* eslint-disable no-catch-all/no-catch-all -- each durable chat retries independently; failure must not stop the host's other moves */
  for (const chat of await listChats())
    if (
      (chat.state === 'moving' || chat.state === 'job' || chat.state === 'connected') &&
      !drives.has(chat.messaging_group_id)
    ) {
      try {
        await serialMoveChat(chat.messaging_group_id);
      } catch (error) {
        if (error instanceof GwsEaError && error.code === 'instance_busy') continue;
        log.error('Chat move will resume', { chatId: chat.messaging_group_id, error });
      }
    }
  /* eslint-enable no-catch-all/no-catch-all */
}
