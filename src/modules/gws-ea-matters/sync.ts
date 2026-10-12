/**
 * The daily sync (KTD6): one recurring task in `main`'s conversation, kept by
 * the host (`loop.ts`), that brings main back once a day to whatever has
 * waited for it. It is the host's bookkeeping, never a message to the
 * principal: whether they hear about their day, and when, is main's
 * judgment, and a standing morning rundown is a task they ask for.
 *
 * - Its time is 30 minutes before the earliest working-hours start in the
 *   principal's preferences, or 07:30 while they have none, in main's time
 *   zone, and it follows their working hours when those change. Nothing else
 *   sets it.
 * - Its pre-task script, `ncl matters sync`, wakes main only when something
 *   waits for it: a note it has not read, which rides along with the sync,
 *   or a thread still waiting to be placed (R27). On a quiet day it wakes
 *   nothing.
 * - A matter left without a look, and a repeating look whose run failed,
 *   come back at its time (`loop.ts`), each as a look of its own (R14).
 *
 * `ncl matters today` prints the day as matters hold it, as the script of a
 * morning rundown the principal asks for: today's looks, the matters handed
 * back, and the threads waiting to be placed. It reads nothing live.
 */
import { CronExpressionParser } from 'cron-parser';

import { resolveGroupTimezone } from '../../container-config.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import { formatLocalTime } from '../../timezone.js';
import type { Session } from '../../types.js';
import { ECHO_CHANNEL_TYPE } from '../cross-session-context/config.js';
import { listUnplacedThreads, type UnplacedThread } from '../gws-ea-inbox/thread-map.js';
import { getSchedulingPreferenceValues } from '../gws-ea-preferences/db.js';
import { createScheduledTask, prepareScheduledTask, taskNameSlug } from '../scheduling/create.js';
import {
  cancelTaskSeries,
  listHeldLookSlots,
  lookSeries,
  mainConversations,
  seriesKey,
  type HeldTask,
  type ScriptVerdict,
} from './looks.js';
import { principalTimezone } from './render.js';

const SYNC_TASK_NAME = 'gws-ea daily sync';
const SYNC_SLUG = taskNameSlug(SYNC_TASK_NAME);
const DEFAULT_SYNC_MINUTE = 7 * 60 + 30;
const BEFORE_WORK_MINUTES = 30;

function minuteOfDay(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

function daily(minute: number): string {
  return `${minute % 60} ${Math.floor(minute / 60)} * * *`;
}

function nextRun(recurrence: string, timezone: string): string {
  return CronExpressionParser.parse(recurrence, { tz: timezone }).next().toDate().toISOString();
}

/** The sync's cron: 30 minutes before the earliest working-hours start the principal has, or 07:30 while they have none. */
async function syncRecurrence(): Promise<string> {
  const starts = (await getSchedulingPreferenceValues()).working_hours.flatMap((day) =>
    day.off ? [] : [minuteOfDay(day.start)],
  );
  return daily(starts.length === 0 ? DEFAULT_SYNC_MINUTE : Math.max(0, Math.min(...starts) - BEFORE_WORK_MINUTES));
}

/** The sync series in main's conversations: a live one first, or else whichever holds its latest run. */
async function findSync(): Promise<HeldTask | undefined> {
  let latest: HeldTask | undefined;
  for (const session of await mainConversations()) {
    const task = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
      mailbox.findTaskBySeriesSlug(SYNC_SLUG),
    );
    if (task === undefined) continue;
    if (task.status === 'pending' || task.status === 'paused') return { session, task };
    latest ??= { session, task };
  }
  return latest;
}

async function createSync(conversation: Session, recurrence: string, timezone: string): Promise<string> {
  const prepared = prepareScheduledTask({
    name: SYNC_TASK_NAME,
    prompt:
      "Your daily sync: what has waited for you since your last turn comes with this. Act on it as you would on any note; the principal hears only what can't wait for them.",
    script: 'ncl matters sync',
    recurrence,
    timezone,
  });
  await createScheduledTask(conversation.agent_group_id, prepared, { session: conversation });
  return prepared.processAfter;
}

/**
 * Make sure the sync exists at its time (KTD7, step 1), and say when it next
 * comes, ISO. It is created on the first pass, and again once it was
 * cancelled, paused (by the sweep after eight failed runs, or by hand), ended,
 * or left at a time the principal's working hours no longer give. One that
 * has just run keeps its series, whose next run the sweep arms. The caller
 * holds `oneAtATime`.
 */
export async function keepSync(conversation: Session): Promise<string> {
  const timezone = await resolveGroupTimezone(conversation.agent_group_id);
  const recurrence = await syncRecurrence();
  const task = (await findSync())?.task;
  if (task !== undefined && task.recurrence !== null) {
    if (task.status === 'completed' || task.status === 'failed') return nextRun(task.recurrence, timezone);
    if (task.status === 'pending' && task.processAfter !== null && task.recurrence === recurrence) {
      return task.processAfter;
    }
  }
  if (task !== undefined) await cancelTaskSeries(seriesKey(task));
  return createSync(conversation, recurrence, timezone);
}

/** One part of what a script prints: its heading, and a line for each thing in it. */
interface ScriptSection {
  readonly heading: string;
  readonly lines: readonly string[];
}

function sectionLines(section: ScriptSection): string[] {
  return section.lines.length === 0 ? [`${section.heading}: none.`] : [`${section.heading}:`, ...section.lines];
}

/**
 * A thread waiting to be placed, as main reads it in the sync, in today's
 * list and in the host's reminder: its key, who its mail carried, when its
 * latest came, and the Gmail thread to read it by.
 */
export function unplacedThreadLine(thread: UnplacedThread, timezone: string): string {
  return [
    `- ${thread.threadKey}: ${thread.people.join(', ')}`,
    `latest mail ${formatLocalTime(thread.latestAt, timezone)}`,
    ...(thread.gmailThreadId === null ? [] : [`Gmail thread ${thread.gmailThreadId}`]),
  ].join('; ');
}

function unplacedSection(threads: readonly UnplacedThread[], timezone: string): ScriptSection {
  return {
    heading: 'Threads waiting to be placed',
    lines: threads.map((thread) => unplacedThreadLine(thread, timezone)),
  };
}

/** How many notes main has not read, across its conversations: each rides along with its next turn. */
async function unreadNotes(): Promise<number> {
  let count = 0;
  for (const session of await mainConversations()) {
    count +=
      (await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
        mailbox.countUnreadContext(ECHO_CHANNEL_TYPE),
      )) ?? 0;
  }
  return count;
}

/**
 * The sync's verdict: main wakes only for what waits for it, notes it has
 * not read and threads still to place, and on a quiet day not at all.
 */
export async function syncVerdict(): Promise<ScriptVerdict> {
  const [notes, unplaced] = await Promise.all([unreadNotes(), listUnplacedThreads()]);
  if (notes === 0 && unplaced.length === 0) return { wakeAgent: false };
  const timezone = await principalTimezone();
  const unread =
    notes === 0
      ? []
      : [
          notes === 1
            ? 'A note you have not read comes with this.'
            : `${notes} notes you have not read come with this.`,
        ];
  return {
    wakeAgent: true,
    data: [...unread, ...(unplaced.length === 0 ? [] : sectionLines(unplacedSection(unplaced, timezone)))],
  };
}

/** A look due before the day ends. */
interface DueLook {
  readonly matterId: string;
  readonly title: string;
  readonly at: string;
  readonly handedBack: boolean;
}

/** Every open matter's look that comes before `before`, ISO, soonest first: overdue ones included. */
async function looksBefore(before: string): Promise<DueLook[]> {
  const due = (await listHeldLookSlots()).flatMap(({ slot, held }): DueLook[] => {
    const task = held?.task;
    if (
      task?.status !== 'pending' ||
      task.processAfter === null ||
      Date.parse(task.processAfter) >= Date.parse(before)
    ) {
      return [];
    }
    const handedBack = lookSeries(seriesKey(task))?.handedBack === true;
    return [{ matterId: slot.id, title: slot.title, at: task.processAfter, handedBack }];
  });
  return due.sort((left, right) => Date.parse(left.at) - Date.parse(right.at) || left.title.localeCompare(right.title));
}

/**
 * Today as matters hold it, from the host's own records alone: today's
 * looks, by time and title, the matters the host handed back for lack of a
 * look (R14), and the threads still waiting to be placed (R27). It always
 * wakes main: it is the script of a rundown the principal asked for.
 */
export async function todayVerdict(): Promise<ScriptVerdict> {
  const timezone = await principalTimezone();
  const looks = await looksBefore(nextRun('0 0 * * *', timezone));
  const sections: ScriptSection[] = [
    {
      heading: 'Looks today',
      lines: looks
        .filter((look) => !look.handedBack)
        .map((look) => `- ${look.matterId}, ${formatLocalTime(look.at, timezone)}: ${look.title}`),
    },
    {
      heading: 'Handed back without a next look',
      lines: looks.filter((look) => look.handedBack).map((look) => `- ${look.matterId}: ${look.title}`),
    },
    unplacedSection(await listUnplacedThreads(), timezone),
  ];
  return { wakeAgent: true, data: sections.flatMap(sectionLines) };
}
