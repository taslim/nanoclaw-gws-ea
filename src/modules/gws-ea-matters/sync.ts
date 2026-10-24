/**
 * The daily sync (KTD6): one recurring task in `main`'s conversation, kept by
 * the host (`loop.ts`), that wakes main seven days a week to look ahead
 * and read whatever has waited for it. It is the host's bookkeeping, never
 * a message to the principal: whether they hear about their day, and when, is main's
 * judgment, and a standing morning rundown is a task they ask for.
 *
 * - Its time is an hour before the earliest working-hours start in the
 *   principal's preferences, or 07:00 while they have none, in main's time
 *   zone, and it follows their working hours when those change. Nothing else
 *   sets it.
 * - Its pre-task script, `ncl matters sync`, always wakes main (character
 *   and roles KTD12), carrying unread notes, threads still waiting to be
 *   placed, later looks and a morning rundown's time. Monday's month view
 *   follows the occurrence's scheduled day in the principal's zone.
 * - The prompt asks main to look closely at the next few days, and on
 *   Mondays at the month through a subagent briefed with current priorities.
 *   The principal hears only what needs them, in one morning message.
 * - A matter left without a look, and a repeating look whose run failed,
 *   come back at its time (`loop.ts`), each as a look of its own (R14).
 *
 * `ncl matters today` prints the day as matters hold it, as the script of a
 * morning rundown the principal asks for: today's looks, the matters handed
 * back, and the threads waiting to be placed. It reads nothing live.
 */
import { CronExpressionParser } from 'cron-parser';

import { resolveGroupTimezone } from '../../container-config.js';
import { isContainerRunning } from '../../container-runner.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import { formatLocalTime } from '../../timezone.js';
import type { Session } from '../../types.js';
import { ECHO_CHANNEL_TYPE } from '../cross-session-context/config.js';
import { listUnplacedThreads, type UnplacedThread } from '../gws-ea-inbox/thread-map.js';
import { getSchedulingPreferenceValues } from '../gws-ea-preferences/db.js';
import { createScheduledTask, makeTaskId, prepareScheduledTask, taskNameSlug } from '../scheduling/create.js';
import { parseTaskContent } from '../scheduling/task-content.js';
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
const DEFAULT_SYNC_MINUTE = 7 * 60;
const BEFORE_WORK_MINUTES = 60;
const SYNC_SCRIPT = 'ncl matters sync';
const SYNC_PROMPT = `Your daily sync. Read what has waited for you, then look closely at the next few days across work and personal life: preparation, timing, transitions and confirmations. Check open matters before raising anything, handle what you can, and set a matter look for anything that can wait.

When the script says this sync starts the week, also look at the month ahead through a subagent. Brief it with Core Memory's current priorities; a subagent does not receive your memory section. Ask for one line per candidate: what, when, and what may be owed. Decide what to act on yourself. Keep current priorities in Core Memory as short dated facts with their evidence. Distinguish calendar observations from inferred priorities. Update or retire a priority when evidence shows it changed; a quiet calendar alone never retires an explicit priority. Confirm consequential uncertainty with the principal, with a recommendation.

Stay silent unless something needs the principal. On days off, raise work only if it would otherwise be missed. Merge anything for them with a morning rundown or later look already due, so they receive one message timed for their morning. If the rundown is still to come, put what it needs in a matter for that time; if the morning's message already went, send another only for something that cannot wait. Keep your look-ahead and memory housekeeping to yourself.`;

function localDay(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}

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

/** The sync's cron: an hour before the earliest working-hours start the principal has, or 07:00 while they have none. */
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

async function createSync(
  conversation: Session,
  recurrence: string,
  timezone: string,
  processAfter?: string,
): Promise<string> {
  const prepared = prepareScheduledTask({
    name: SYNC_TASK_NAME,
    prompt: SYNC_PROMPT,
    script: SYNC_SCRIPT,
    recurrence,
    timezone,
    ...(processAfter === undefined ? {} : { processAfter }),
  });
  await createScheduledTask(conversation.agent_group_id, prepared, { session: conversation });
  return prepared.processAfter;
}

/**
 * Keep the release's sync prompt, script and time on each host pass (KTD12).
 * A pending occurrence due today keeps its time when the release changes;
 * one already running finishes once. Completed recurring rows still own a
 * clock until the sweep re-arms them: replace that clock atomically, rather
 * than cancel a spent row (which deliberately leaves its recurrence alone).
 * An identical task is left unchanged. The caller holds `oneAtATime`.
 */
export async function keepSync(conversation: Session): Promise<string> {
  const timezone = await resolveGroupTimezone(conversation.agent_group_id);
  const recurrence = await syncRecurrence();
  const held = await findSync();
  if (held === undefined) return createSync(conversation, recurrence, timezone);
  const { task } = held;
  const content = parseTaskContent(task.content);
  const sameContent = content.prompt === SYNC_PROMPT && content.script === SYNC_SCRIPT;
  const sameSchedule = task.recurrence === recurrence;
  if (task.recurrence !== null && (task.status === 'completed' || task.status === 'failed')) {
    if (sameContent && sameSchedule) return nextRun(recurrence, timezone);
    const at = nextRun(recurrence, timezone);
    const id = makeTaskId(SYNC_TASK_NAME);
    const armed = await withExistingMailboxSession(held.session.agent_group_id, held.session.id, (mailbox) =>
      mailbox.armNextTask(task.id, {
        id,
        seriesId: id,
        processAfter: at,
        recurrence,
        content: JSON.stringify({
          prompt: SYNC_PROMPT,
          script: SYNC_SCRIPT,
          originSessionId: null,
          inConversation: true,
        }),
      }),
    );
    // The sweep may have re-armed our snapshot first. Reconcile its successor
    // against this release rather than leave the old prompt on that clock.
    if (armed === false) return keepSync(conversation);
    return at;
  }
  if (task.status === 'pending' && task.processAfter !== null) {
    if (sameContent && sameSchedule) return task.processAfter;
    // The runner may have read the due row before posting its processing claim.
    if (Date.parse(task.processAfter) <= Date.now() && isContainerRunning(held.session.id)) return task.processAfter;
  }
  const keepToday =
    task.status === 'pending' &&
    !sameContent &&
    sameSchedule &&
    task.processAfter !== null &&
    localDay(task.processAfter, timezone) === localDay(new Date().toISOString(), timezone);
  await cancelTaskSeries(seriesKey(task));
  return createSync(conversation, recurrence, timezone, keepToday ? (task.processAfter ?? undefined) : undefined);
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

async function morningRundowns(timezone: string): Promise<string[]> {
  const today = localDay(new Date().toISOString(), timezone);
  const times: string[] = [];
  for (const session of await mainConversations()) {
    const tasks = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
      mailbox.listLiveTasks('pending'),
    );
    for (const task of tasks ?? []) {
      const at = task.processAfter;
      if (
        at === null ||
        localDay(at, timezone) !== today ||
        parseTaskContent(task.content).script?.trim() !== 'ncl matters today'
      )
        continue;
      const hour = Number(
        new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', hourCycle: 'h23' }).format(
          new Date(at),
        ),
      );
      if (hour < 12) times.push(at);
    }
  }
  return times.sort().map((at) => `Morning rundown: ${formatLocalTime(at, timezone)}.`);
}

export async function syncVerdict(): Promise<ScriptVerdict> {
  const timezone = await principalTimezone();
  const [notes, unplaced, sync, looks, rundowns] = await Promise.all([
    unreadNotes(),
    listUnplacedThreads(),
    findSync(),
    looksBefore(nextRun('0 0 * * *', timezone)),
    morningRundowns(timezone),
  ]);
  const at = sync?.task.processAfter;
  const startsWeek =
    at !== undefined &&
    at !== null &&
    new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'long' }).format(new Date(at)) === 'Monday';
  const later = looks.filter((look) => Date.parse(look.at) > Date.now());
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
    data: [
      ...unread,
      ...(unplaced.length === 0 ? [] : sectionLines(unplacedSection(unplaced, timezone))),
      ...(startsWeek ? [`This sync starts the week: Monday in ${timezone}.`] : []),
      ...(later.length === 0
        ? []
        : sectionLines({
            heading: 'Later looks today',
            lines: later.map((look) => `- ${look.matterId}, ${formatLocalTime(look.at, timezone)}: ${look.title}`),
          })),
      ...rundowns,
    ],
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
 * wakes main: it runs as the script of a rundown the principal asked for,
 * main's own list to fold into a rundown built from their calendar.
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
