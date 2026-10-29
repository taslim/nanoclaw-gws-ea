/**
 * The daily sync: one recurring task in `main`'s conversation, kept by the
 * host (`loop.ts`), that wakes main seven days a week to look ahead and read
 * whatever has waited for it. It is the host's bookkeeping, never a message to
 * the principal: whether they hear about their day, and when, is main's
 * judgment, and a standing morning rundown is a task they ask for.
 *
 * - Its time is an hour before the earliest working-hours start in the
 *   principal's preferences, or 07:00 while they have none, in main's time
 *   zone, and it follows their working hours when those change. Nothing else
 *   sets it.
 * - Its pre-task script, `ncl matters sync`, always wakes main, carrying
 *   unread notes, threads still waiting to be placed, later looks and a
 *   morning rundown's time. Monday's month view follows the occurrence's
 *   scheduled day in the principal's zone.
 * - A matter left without a look gets a look of its own at its time, and a
 *   repeating look whose run failed is brought forward to it (`loop.ts`).
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
import { createScheduledTask, prepareScheduledTask, taskNameSlug } from '../scheduling/create.js';
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
import { getMatter } from './db.js';
import { loadTimeline } from '../gws-ea-whereabouts/timeline.js';
import { matterNeedsTimeline, matterPlanningLines } from './planning.js';

const SYNC_TASK_NAME = 'gws-ea daily sync';
const SYNC_SLUG = taskNameSlug(SYNC_TASK_NAME);
const DEFAULT_SYNC_MINUTE = 7 * 60;
const BEFORE_WORK_MINUTES = 60;
const SYNC_SCRIPT = 'ncl matters sync';
const SYNC_PROMPT = `Your daily sync. Read what has waited for you, then look closely at the next few days across work and personal life: preparation, timing, transitions and confirmations. Check open matters before raising anything, handle what you can, and set a matter look for anything that can wait.

When the script says this sync starts the week, also look at the month ahead through a subagent. Brief it with Core Memory's current priorities; a subagent does not receive your memory section. Ask for one line per candidate: what, when, and what may be owed. Decide what to act on yourself. Keep current priorities in Core Memory as short dated facts, with any evidence in a linked file. Record a priority the month reveals as inferred, apart from those the principal stated, and update or retire one when evidence shows it changed; a quiet calendar alone never retires a priority they stated. When a decision now rests on a priority you're unsure of, confirm it in one line with your recommendation, inside the morning's one message.

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

async function syncRecurrence(): Promise<string> {
  const starts = (await getSchedulingPreferenceValues()).working_hours.flatMap((day) =>
    day.off ? [] : [minuteOfDay(day.start)],
  );
  return daily(starts.length === 0 ? DEFAULT_SYNC_MINUTE : Math.max(0, Math.min(...starts) - BEFORE_WORK_MINUTES));
}

/** A live sync first, else the latest row in the newest of main's conversations that holds one. */
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

/** Whether the runner has claimed or finished this occurrence before the host applied its ack. */
async function occurrenceTaken({ session, task }: HeldTask): Promise<boolean> {
  // The runner may have read the due row before posting its processing claim.
  if (isContainerRunning(session.id)) return true;
  const taken = await withExistingMailboxSession(
    session.agent_group_id,
    session.id,
    (mailbox) =>
      mailbox.getTerminalProcessingAcks().some((ack) => ack.messageId === task.id) ||
      mailbox.getProcessingClaims().some((claim) => claim.messageId === task.id),
  );
  return taken ?? false;
}

/**
 * Keep the release's sync prompt, script and time on each host pass. An
 * identical task is left unchanged. A completed or failed row is the sweep's
 * to re-arm within a minute, as upstream's restamp leaves it; the next pass
 * replaces that successor. A due occurrence the runner has claimed or
 * finished runs its course, and is replaced the same way once re-armed. Any
 * other pending occurrence that is overdue or due today keeps its time when
 * the release or the principal's working hours change. The caller holds
 * `oneAtATime`.
 */
export async function keepSync(conversation: Session): Promise<string> {
  const timezone = await resolveGroupTimezone(conversation.agent_group_id);
  const recurrence = await syncRecurrence();
  const held = await findSync();
  if (held === undefined) return createSync(conversation, recurrence, timezone);
  const { task } = held;
  if (task.recurrence !== null && (task.status === 'completed' || task.status === 'failed')) {
    return nextRun(task.recurrence, timezone);
  }
  const content = parseTaskContent(task.content);
  const sameContent = content.prompt === SYNC_PROMPT && content.script === SYNC_SCRIPT;
  const sameSchedule = task.recurrence === recurrence;
  const due = task.processAfter !== null && Date.parse(task.processAfter) <= Date.now();
  if (task.status === 'pending' && task.processAfter !== null) {
    if (sameContent && sameSchedule) return task.processAfter;
    if (due && (await occurrenceTaken(held))) return task.processAfter;
  }
  // A changed prompt, script or schedule takes over from the next run; today's run keeps its time.
  const keepTime =
    task.status === 'pending' &&
    task.processAfter !== null &&
    (due || localDay(task.processAfter, timezone) === localDay(new Date().toISOString(), timezone));
  await cancelTaskSeries(seriesKey(task));
  return createSync(conversation, recurrence, timezone, keepTime ? (task.processAfter ?? undefined) : undefined);
}

interface ScriptSection {
  readonly heading: string;
  readonly lines: readonly string[];
}

function sectionLines(section: ScriptSection): string[] {
  return section.lines.length === 0 ? [`${section.heading}: none.`] : [`${section.heading}:`, ...section.lines];
}

/** The one line main reads for a thread waiting to be placed, wherever it is shown one. */
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
  // The occurrence running now is still pending and due; a call at any other
  // time reads tomorrow's row, which starts nothing yet.
  const at = sync?.task.processAfter;
  const startsWeek =
    at !== undefined &&
    at !== null &&
    Date.parse(at) <= Date.now() &&
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
 * Always wakes main: it runs as the script of a rundown the principal asked
 * for, main's own list to fold into a rundown built from their calendar.
 */
export async function todayVerdict(): Promise<ScriptVerdict> {
  const timezone = await principalTimezone();
  const looks = await looksBefore(nextRun('0 0 * * *', timezone));
  const matters = await Promise.all(looks.map((look) => getMatter(look.matterId)));
  const timeline = matters.some((matter) => matter !== undefined && matterNeedsTimeline(matter))
    ? await loadTimeline()
    : null;
  const facts = new Map(
    matters.flatMap((matter) =>
      matter === undefined ? [] : [[matter.id, matterPlanningLines(matter, timeline, timezone).join(' ')] as const],
    ),
  );
  const suffix = (id: string): string => (facts.get(id) ? `; ${facts.get(id)}` : '');
  const sections: ScriptSection[] = [
    {
      heading: 'Looks today',
      lines: looks
        .filter((look) => !look.handedBack)
        .map(
          (look) => `- ${look.matterId}, ${formatLocalTime(look.at, timezone)}: ${look.title}${suffix(look.matterId)}`,
        ),
    },
    {
      heading: 'Handed back without a next look',
      lines: looks
        .filter((look) => look.handedBack)
        .map((look) => `- ${look.matterId}: ${look.title}${suffix(look.matterId)}`),
    },
    unplacedSection(await listUnplacedThreads(), timezone),
  ];
  return { wakeAgent: true, data: sections.flatMap(sectionLines) };
}
