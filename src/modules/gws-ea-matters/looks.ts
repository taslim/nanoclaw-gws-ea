/**
 * A matter's next look (KTD4, R13): one slot on the matter, held by one
 * scheduled task that comes back as a turn of `main`'s conversation (KTD1).
 * The task is the matter's only clock: the matter records the task's id,
 * never a time.
 *
 * - The task's prompt names only the matter's id, so a rename or a forget
 *   leaves nothing stale in it.
 * - Its pre-task script, `ncl matters look <id>`, prints the verdict the
 *   runner reads from a script's last line
 *   (`container/agent-runner/src/scheduling/task-script.ts`): the matter read
 *   live (KTD5) while it is open, and no wake once it has closed. A look never
 *   presents a stale matter, and a leftover one stays silent.
 * - `open`, `update` and `close` keep one look per matter. A new look is
 *   recorded before the one it replaces is cancelled, so the matter always
 *   names a live task, and a failure between the two leaves at most a stray
 *   the host's loop cancels (`loop.ts`). A repeating look is never replaced
 *   by a one-off, which would silently end a yearly date (R24): a one-off
 *   follow-up is a matter of its own.
 * - A look the host sets for a matter left without one (R14) is named apart,
 *   so today's list can say which matters came back that way.
 *
 * Every change to a slot, and each pass of the host's loop, runs one at a
 * time, so a pass never reads a slot halfway through a change.
 */
import { resolveGroupTimezone } from '../../container-config.js';
import { findConversationSessions } from '../../db/sessions.js';
import type { TaskRecord } from '../../mailbox/index.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { getMainAgentGroupId } from '../gws-ea-profile/db.js';
import { resolveMainConversation } from '../gws-ea-profile/main-note.js';
import { createScheduledTask, prepareScheduledTask } from '../scheduling/create.js';
import {
  closeMatter,
  getMatter,
  listOpenLookSlots,
  openMatter,
  recordLookTask,
  requireMatter,
  updateMatter,
  type CloseMatterInput,
  type LookSlot,
  type Matter,
  type OpenMatterInput,
  type Placed,
  type UpdateMatterInput,
} from './db.js';
import type { NextLook } from './next-look.js';
import { renderMatter } from './render.js';

let slots: Promise<void> = Promise.resolve();

/** Run `work` once every slot change and loop pass begun before it has settled. */
export function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
  const run = slots.then(work);
  slots = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * `main`'s one shared conversation (`resolveMainConversation`), where every
 * note lands and every look and the daily sync come back: undefined until the
 * profile names main and the principal has a direct message.
 */
export async function mainConversation(): Promise<Session | undefined> {
  const conversation = await resolveMainConversation();
  return typeof conversation === 'string' ? undefined : conversation.session;
}

export async function requireMainConversation(): Promise<Session> {
  const conversation = await mainConversation();
  if (conversation === undefined) {
    throw new Error("A look comes back in main's conversation with the principal, and there is none yet");
  }
  return conversation;
}

/** Each of `main`'s live conversations, newest first: a task set in an earlier one still comes back there. */
export async function mainConversations(): Promise<Session[]> {
  const mainAgentGroupId = await getMainAgentGroupId();
  return mainAgentGroupId === null ? [] : findConversationSessions(mainAgentGroupId);
}

/** A task as one of `main`'s conversations holds it. */
export interface HeldTask {
  readonly session: Session;
  readonly task: TaskRecord;
}

/** The series a task row belongs to: the id the matter records and `ncl tasks` shows. */
export function seriesKey(task: TaskRecord): string {
  return task.seriesId ?? task.id;
}

/** The tasks `ids` name, each from whichever of `main`'s conversations holds it. */
export async function findTasks(ids: readonly string[]): Promise<Map<string, HeldTask>> {
  const found = new Map<string, HeldTask>();
  for (const session of await mainConversations()) {
    const wanted = ids.filter((id) => !found.has(id));
    if (wanted.length === 0) break;
    const tasks = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
      wanted.flatMap((id) => {
        const task = mailbox.getTask(id);
        return task === undefined ? [] : [{ id, task }];
      }),
    );
    for (const { id, task } of tasks ?? []) found.set(id, { session, task });
  }
  return found;
}

/** An open matter's look slot, with the task it records as one of main's conversations holds it. */
export interface HeldSlot {
  readonly slot: LookSlot;
  /** Undefined while it records none, or none of main's conversations holds the one it records. */
  readonly held: HeldTask | undefined;
}

/** Every open matter's look slot, oldest first, each with its task as main's conversations hold it. */
export async function listHeldLookSlots(): Promise<HeldSlot[]> {
  const slots = await listOpenLookSlots();
  const tasks = await findTasks(slots.flatMap((slot) => (slot.look_task_id === null ? [] : [slot.look_task_id])));
  return slots.map((slot) => ({ slot, held: slot.look_task_id === null ? undefined : tasks.get(slot.look_task_id) }));
}

/** Cancel a task series wherever in `main`'s conversations it is; a spent one stays as it is. */
export async function cancelTaskSeries(taskId: string): Promise<void> {
  for (const session of await mainConversations()) {
    await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) => mailbox.cancelTask(taskId));
  }
}

/**
 * Whether a task will still come back: an occurrence waits or is being run
 * (its row stays pending until the host reads the runner's answer), or a
 * repeating one has run and the sweep arms the next. A paused, cancelled or
 * spent one will not.
 */
export function stillToCome(task: TaskRecord | undefined): boolean {
  if (task === undefined) return false;
  switch (task.status) {
    case 'pending':
      return true;
    case 'completed':
    case 'failed':
      return task.recurrence !== null;
    case 'paused':
    case 'cancelled':
      return false;
    default: {
      const unreachable: never = task.status;
      throw new Error(`Unknown task status: ${String(unreachable)}`);
    }
  }
}

/** A look `main` set is named `look <matter id>`; one the host set for a matter left without one, `back <matter id>`. */
const LOOK_SERIES = /^(look|back)-(m-[0-9a-f]{12})-[0-9a-f]{4}$/u;

export interface LookSeries {
  readonly matterId: string;
  /** The host set it, at the daily sync, for a matter left without a look (R14). */
  readonly handedBack: boolean;
}

/** The matter a task series is a look for, or undefined for any other task. */
export function lookSeries(key: string): LookSeries | undefined {
  const match = LOOK_SERIES.exec(key);
  return match === null ? undefined : { matterId: match[2], handedBack: match[1] === 'back' };
}

function lookPrompt(matterId: string): string {
  return `Look at matter ${matterId}: the script output is the matter as it stands now. Act on it, then set its next look or close it.`;
}

async function createLook(
  conversation: Session,
  matterId: string,
  look: NextLook,
  handedBack: boolean,
): Promise<string> {
  const prepared = prepareScheduledTask({
    name: `${handedBack ? 'back' : 'look'} ${matterId}`,
    prompt: lookPrompt(matterId),
    script: `ncl matters look ${matterId}`,
    ...(look.kind === 'once' ? { processAfter: look.at } : { recurrence: look.cron }),
    timezone: await resolveGroupTimezone(conversation.agent_group_id),
  });
  const { row } = await createScheduledTask(conversation.agent_group_id, prepared, { session: conversation });
  return row.id;
}

/**
 * Give a matter its next look in `conversation`, replacing `previous`: the new
 * task is recorded before the old one is cancelled. The caller holds
 * `oneAtATime`.
 */
export async function setLook(
  conversation: Session,
  matterId: string,
  previous: string | null,
  look: NextLook,
  handedBack = false,
): Promise<void> {
  const taskId = await createLook(conversation, matterId, look, handedBack);
  await recordLookTask(matterId, taskId);
  if (previous !== null) await cancelTaskSeries(previous);
}

/** Open a matter with its first next look (R13). Nothing is written while there is no conversation for it. */
export function openMatterWithLook(input: OpenMatterInput, look: NextLook): Promise<Placed> {
  return oneAtATime(async () => {
    const conversation = await requireMainConversation();
    const placed = await openMatter(input);
    await setLook(conversation, placed.matter.id, null, look);
    return { ...placed, matter: await requireMatter(placed.matter.id) };
  });
}

/**
 * Change a matter, and with `look` move its next look, which reopens a
 * closed one (KTD3). A one-off look never replaces a repeating one.
 */
export function updateMatterAndLook(input: UpdateMatterInput, look: NextLook | undefined): Promise<Matter> {
  if (look === undefined) return updateMatter(input);
  return oneAtATime(async () => {
    const current = await requireMatter(input.id);
    if (look.kind === 'once' && current.open && current.look_task_id !== null) {
      const task = (await findTasks([current.look_task_id])).get(current.look_task_id)?.task;
      if (task !== undefined && stillToCome(task) && task.recurrence !== null) {
        throw new Error(
          `${current.id}'s next look repeats on "${task.recurrence}", and a one-off look would end it: open a separate matter for a one-off follow-up, or give --look-cron to change how it repeats`,
        );
      }
    }
    const conversation = await requireMainConversation();
    const matter = await updateMatter({ ...input, reopen: true });
    await setLook(conversation, matter.id, matter.look_task_id, look);
    return requireMatter(matter.id);
  });
}

/** Close a matter, ending its next look (R5, R13). */
export function closeMatterAndLook(input: CloseMatterInput): Promise<Matter> {
  return oneAtATime(async () => {
    const closed = await closeMatter(input);
    if (closed.look_task_id === null) return closed;
    await cancelTaskSeries(closed.look_task_id);
    await recordLookTask(closed.id, null);
    return { ...closed, look_task_id: null };
  });
}

/** What a pre-task script answers, as the runner reads its last line. */
export interface ScriptVerdict {
  readonly wakeAgent: boolean;
  /** What `main` reads with the task, a line each. */
  readonly data?: readonly string[];
}

/** A look's verdict: its matter read live while it is open; no wake once it has closed or is gone. */
export async function lookVerdict(id: string): Promise<ScriptVerdict> {
  const matter = await getMatter(id);
  if (matter === undefined || !matter.open) return { wakeAgent: false };
  return { wakeAgent: true, data: (await renderMatter(matter)).split('\n') };
}
