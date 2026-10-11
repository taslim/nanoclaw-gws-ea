/**
 * The morning (KTD6, R16, R17): one recurring task in `main`'s conversation
 * brings it back once a day, before the principal's day starts. The host
 * keeps it (`loop.ts`) and finds it by its name.
 *
 * - Its time is 30 minutes before the earliest working-hours start in the
 *   principal's preferences, or 07:30 while they have none, in main's time
 *   zone. `ncl matters morning --at` moves it, as main does while the
 *   principal travels.
 * - Its pre-task script, `ncl matters morning --brief`, prints a verdict as a
 *   look's does and always wakes main: whether the principal hears anything
 *   is main's judgment. The brief reads nothing live. Each look due at the
 *   morning comes in the same turn as a task of its own, read live by its
 *   own script, so the brief stays quick however many are due. Each thread
 *   still waiting to be placed comes back in it too (R27).
 */
import { CronExpressionParser } from 'cron-parser';

import { resolveGroupTimezone } from '../../container-config.js';
import type { TaskRecord } from '../../mailbox/index.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import { formatLocalTime } from '../../timezone.js';
import type { Session } from '../../types.js';
import { listUnplacedThreads, type UnplacedThread } from '../gws-ea-inbox/thread-map.js';
import { getSchedulingPreferenceValues } from '../gws-ea-preferences/db.js';
import { createScheduledTask, prepareScheduledTask, taskNameSlug } from '../scheduling/create.js';
import { listOpenLookSlots } from './db.js';
import {
  cancelTaskSeries,
  findTasks,
  lookSeries,
  mainConversations,
  oneAtATime,
  requireMainConversation,
  seriesKey,
  type HeldTask,
  type ScriptVerdict,
} from './looks.js';
import { principalTimezone } from './render.js';

const MORNING_TASK_NAME = 'gws-ea morning';
const MORNING_SLUG = taskNameSlug(MORNING_TASK_NAME);
const DEFAULT_MORNING_MINUTE = 7 * 60 + 30;
const BEFORE_WORK_MINUTES = 30;
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/u;
const DAILY = /^(\d{1,2}) (\d{1,2}) \* \* \*$/u;

/** The morning as main reads it: its time of day, the zone it is read in, and when it next comes, ISO. */
export interface MorningTime {
  readonly at: string;
  readonly timezone: string;
  readonly next: string;
}

/** The morning's next run and the cron it repeats on. */
interface MorningRun {
  readonly next: string;
  readonly recurrence: string;
}

function clock(minuteOfDay: number): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(Math.floor(minuteOfDay / 60))}:${pad(minuteOfDay % 60)}`;
}

function minuteOfDay(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

function daily(minute: number): string {
  return `${minute % 60} ${Math.floor(minute / 60)} * * *`;
}

/** The time of day a daily cron names, or the cron itself when it names some other repeat. */
function timeOf(recurrence: string): string {
  const match = DAILY.exec(recurrence);
  return match === null ? recurrence : clock(Number(match[2]) * 60 + Number(match[1]));
}

function nextRun(recurrence: string, timezone: string): string {
  return CronExpressionParser.parse(recurrence, { tz: timezone }).next().toDate().toISOString();
}

/** 30 minutes before the earliest working-hours start the principal has, or 07:30 while they have none. */
async function defaultMorningMinute(): Promise<number> {
  const starts = (await getSchedulingPreferenceValues()).working_hours.flatMap((day) =>
    day.off ? [] : [minuteOfDay(day.start)],
  );
  return starts.length === 0 ? DEFAULT_MORNING_MINUTE : Math.max(0, Math.min(...starts) - BEFORE_WORK_MINUTES);
}

/** The morning series in main's conversations: a live one first, or else whichever holds its latest run. */
async function findMorning(): Promise<HeldTask | undefined> {
  let latest: HeldTask | undefined;
  for (const session of await mainConversations()) {
    const task = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
      mailbox.findTaskBySeriesSlug(MORNING_SLUG),
    );
    if (task === undefined) continue;
    if (task.status === 'pending' || task.status === 'paused') return { session, task };
    latest ??= { session, task };
  }
  return latest;
}

/** When a morning series next runs, or undefined while it never will. */
function upcoming(task: TaskRecord, timezone: string): MorningRun | undefined {
  if (task.recurrence === null) return undefined;
  if (task.status === 'pending' && task.processAfter !== null) {
    return { next: task.processAfter, recurrence: task.recurrence };
  }
  // It has just run, and the sweep arms the next.
  if (task.status === 'completed' || task.status === 'failed') {
    return { next: nextRun(task.recurrence, timezone), recurrence: task.recurrence };
  }
  return undefined;
}

async function createMorning(conversation: Session, recurrence: string, timezone: string): Promise<MorningRun> {
  const prepared = prepareScheduledTask({
    name: MORNING_TASK_NAME,
    prompt: "Your morning look over the principal's day: the script output is today's brief.",
    script: 'ncl matters morning --brief',
    recurrence,
    timezone,
  });
  await createScheduledTask(conversation.agent_group_id, prepared, { session: conversation });
  return { next: prepared.processAfter, recurrence };
}

/**
 * Make sure the morning series exists (KTD7, step 1): created on the first
 * pass, and again once it was cancelled, paused (by the sweep after eight
 * failed runs, or by hand) or ended. A paused series comes back at its own
 * time. The caller holds `oneAtATime`.
 */
export async function keepMorning(conversation: Session): Promise<MorningRun> {
  const timezone = await resolveGroupTimezone(conversation.agent_group_id);
  const found = await findMorning();
  const run = found === undefined ? undefined : upcoming(found.task, timezone);
  if (run !== undefined) return run;
  if (found !== undefined) await cancelTaskSeries(seriesKey(found.task));
  return createMorning(conversation, found?.task.recurrence ?? daily(await defaultMorningMinute()), timezone);
}

/** The morning's time, the series made sure of first. */
export function currentMorning(): Promise<MorningTime> {
  return oneAtATime(async () => {
    const conversation = await requireMainConversation();
    const run = await keepMorning(conversation);
    return {
      at: timeOf(run.recurrence),
      timezone: await resolveGroupTimezone(conversation.agent_group_id),
      next: run.next,
    };
  });
}

/** Move the morning to `at`, 24-hour `HH:MM` in main's time zone: a new series replaces the one there was. */
export async function moveMorning(at: string): Promise<MorningTime> {
  const time = at.trim();
  if (!CLOCK.test(time)) {
    throw new Error(
      `--at must be a time of day, 24-hour HH:MM in the principal's time zone, such as 06:45; got ${JSON.stringify(at)}`,
    );
  }
  const minute = minuteOfDay(time);
  return oneAtATime(async () => {
    const conversation = await requireMainConversation();
    const timezone = await resolveGroupTimezone(conversation.agent_group_id);
    const found = await findMorning();
    if (found !== undefined) await cancelTaskSeries(seriesKey(found.task));
    const run = await createMorning(conversation, daily(minute), timezone);
    return { at: clock(minute), timezone, next: run.next };
  });
}

/** One part of the brief: its heading, and a line for each thing in it. */
export interface BriefSection {
  readonly heading: string;
  readonly lines: readonly string[];
}

function sectionLines(section: BriefSection): string[] {
  return section.lines.length === 0 ? [`${section.heading}: none.`] : [`${section.heading}:`, ...section.lines];
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
  const slots = await listOpenLookSlots();
  const tasks = await findTasks(slots.flatMap((slot) => (slot.look_task_id === null ? [] : [slot.look_task_id])));
  const due = slots.flatMap((slot): DueLook[] => {
    const task = slot.look_task_id === null ? undefined : tasks.get(slot.look_task_id)?.task;
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
 * A thread waiting to be placed, as main reads it in the brief and in the
 * host's reminder: its key, who its mail carried, when its latest came, and
 * the Gmail thread to read it by.
 */
export function unplacedThreadLine(thread: UnplacedThread, timezone: string): string {
  return [
    `- ${thread.threadKey}: ${thread.people.join(', ')}`,
    `latest mail ${formatLocalTime(thread.latestAt, timezone)}`,
    ...(thread.gmailThreadId === null ? [] : [`Gmail thread ${thread.gmailThreadId}`]),
  ].join('; ');
}

/** The start of tomorrow in `timezone`, ISO. */
function endOfToday(timezone: string): string {
  return nextRun('0 0 * * *', timezone);
}

/**
 * The morning's brief, from the host's own records alone: today's looks, by
 * time and title, the matters the host handed back at the morning for lack
 * of a look (R14), and the threads still waiting to be placed (R27). It
 * always wakes main.
 */
export async function morningBrief(): Promise<ScriptVerdict> {
  const timezone = await principalTimezone();
  const looks = await looksBefore(endOfToday(timezone));
  const unplaced = await listUnplacedThreads();
  const sections: BriefSection[] = [
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
    {
      heading: 'Threads waiting to be placed',
      lines: unplaced.map((thread) => unplacedThreadLine(thread, timezone)),
    },
  ];
  return { wakeAgent: true, data: sections.flatMap(sectionLines) };
}

function isMorningTime(answer: unknown): answer is MorningTime {
  if (typeof answer !== 'object' || answer === null) return false;
  const { at, timezone, next } = answer as Record<string, unknown>;
  return typeof at === 'string' && typeof timezone === 'string' && typeof next === 'string';
}

/**
 * What `ncl matters morning` prints: the brief as the runner reads a script's
 * verdict, one line of JSON; the morning's time in main's zone otherwise.
 */
export function formatMorningAnswer(answer: unknown): string {
  if (!isMorningTime(answer)) return JSON.stringify(answer);
  return `${answer.at} in ${answer.timezone}, next ${formatLocalTime(answer.next, answer.timezone)}`;
}
