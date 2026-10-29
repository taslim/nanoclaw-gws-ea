import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CronExpressionParser } from 'cron-parser';

import { TIMEZONE, GROUPS_DIR } from '../../config.js';
import { isContainerRunning, killContainer } from '../../container-runner.js';
import { getDb } from '../../db/connection.js';
import { waitForSessionChannelDelivery } from '../../delivery.js';
import { getSession, updateSession } from '../../db/sessions.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { resolveSystemSession, withExistingMailboxSession } from '../../session-manager.js';
import { formatLocalTime, formatLocalTimeWithZone } from '../../timezone.js';
import type { Session } from '../../types.js';
import { ECHO_CHANNEL_TYPE } from '../cross-session-context/config.js';
import { listUnplacedThreads, type UnplacedThread } from '../gws-ea-inbox/thread-map.js';
import { getMainAgentGroupId } from '../gws-ea-profile/db.js';
import { writeNoteForMain } from '../gws-ea-profile/main-note.js';
import { createScheduledTask, prepareScheduledTask } from '../scheduling/create.js';
import { loadTimeline, zoneAt, type Timeline } from '../gws-ea-whereabouts/timeline.js';
import { beginCloseRun, completeCloseRun, failCloseRun, getOpenCloseRun, type CloseRun } from './close-runs.js';
import {
  listHeldLookSlots,
  lookSeries,
  mainConversations,
  oneAtATime,
  seriesKey,
  type HeldTask,
  type ScriptVerdict,
} from './looks.js';
import type { Matter } from './db.js';
import { matterPlanningLines } from './planning.js';
import { nextLocalMoment, sundayOnOrBefore, type LocalMoment } from './moments.js';

const HALF_DAY = 12 * 60 * 60 * 1000;
export const CLOSE_PROMPT = `The evening close. Run ncl matters evening for this run's facts, then ncl day to capture the ledger in this session. Use days and check for the live calendar; an unavailable ambient week view does not replace those tools.
Start look-back as a background Agent call; when it returns, start look-ahead as a background Agent call. Include this close-run id and its ledger/date scope in each delegation, and require the same header in the result. Retain the returned agentId for each role: their exact files are /workspace/agent/planning-runs/<agentId>-look-back.md and /workspace/agent/planning-runs/<agentId>-look-ahead.md. Read only those exact files once both agents return; ignore stale files and mismatched close-run/scope headers. Wait for both before acting. Record the close step and both returned ids so compaction can resume it.
Look back catches still-open promises without matters; create the matters they need. Look ahead checks slipped check-ins and proposes tomorrow's moments: set any that matter as ordinary looks. Act on proposals yourself; planning agents make no external writes.
When the verdict says weekly pass, look at the week and month ahead, refresh or close stale open matters after reading their links fresh, and consolidate memory. Before launching look-back for that consolidation, replace /workspace/agent/sunday-memory-latest with a copy of /workspace/agent/memory; keep only this latest snapshot.
Judge the verdict's lateness: what still belongs tonight, and what waits for morning. Keep a quiet close quiet. This separate close session leaves main a note: after acting on both results use ncl matters evening --done <run> --report '<your report>' and add --notify only if your judgment says main needs to take a turn for the principal now. Otherwise the note waits for main's next wake. Do not send a second principal message from this session. The verdict says whether this run's report was already recorded; reuse it on retry, never send it again. Only --done completes the close; a task acknowledgment does not.`;

export interface CloseSchedule {
  readonly id: string;
  readonly session_id: string;
  readonly scheduled_at: string;
  readonly zone: string;
  readonly timeline_version: string;
  readonly weekly_day: string | null;
  readonly report_text: string | null;
  readonly report_notify: number | null;
  readonly retired_at: string | null;
}

export function nextClosePlacement(timeline: Timeline, notBefore: number, previous: number | null = null): LocalMoment {
  return nextLocalMoment(
    timeline,
    Math.max(notBefore, previous === null ? notBefore : previous + HALF_DAY),
    () => 21 * 60,
  );
}

function nextRun(recurrence: string, timezone: string): string {
  return CronExpressionParser.parse(recurrence, { tz: timezone }).next().toDate().toISOString();
}

export async function closeSchedules(): Promise<CloseSchedule[]> {
  return getDb().all<CloseSchedule>('SELECT * FROM gws_ea_close_schedule ORDER BY scheduled_at,id');
}

async function heldClose(schedule: CloseSchedule): Promise<HeldTask | undefined> {
  const session = await getSession(schedule.session_id);
  if (!session) return undefined;
  const task = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
    mailbox.getTask(schedule.id),
  );
  return task === undefined ? undefined : { session, task };
}

async function occurrenceState(held: HeldTask): Promise<{ readonly claimed: boolean; readonly acked: boolean }> {
  const evidence = await withExistingMailboxSession(held.session.agent_group_id, held.session.id, (mailbox) => ({
    claimed: mailbox.getProcessingClaims().some((claim) => claim.messageId === held.task.id),
    acked: mailbox.getTerminalProcessingAcks().some((ack) => ack.messageId === held.task.id),
  }));
  return {
    claimed:
      evidence?.claimed === true ||
      evidence?.acked === true ||
      held.task.status === 'completed' ||
      held.task.status === 'failed' ||
      isContainerRunning(held.session.id),
    acked: evidence?.acked === true || held.task.status === 'completed' || held.task.status === 'failed',
  };
}

async function retireDailySync(): Promise<void> {
  for (const session of await mainConversations()) {
    const task = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
      mailbox.findTaskBySeriesSlug('gws-ea-daily-sync'),
    );
    if (!task) continue;
    const state = await occurrenceState({ session, task });
    const due = task.processAfter !== null && Date.parse(task.processAfter) <= Date.now();
    if (due && state.claimed && (isContainerRunning(session.id) || !state.acked)) continue;
    await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
      mailbox.cancelTask(seriesKey(task)),
    );
  }
}

async function weeklyDay(at: number, zone: string): Promise<string | null> {
  const sunday = sundayOnOrBefore(at, zone);
  const last = await getDb().get<{ weekly_day: string | null }>(`SELECT MAX(s.weekly_day) AS weekly_day
    FROM gws_ea_close_schedule s JOIN gws_ea_close_runs r ON r.id=s.id WHERE r.state='completed'`);
  return last?.weekly_day !== null && last?.weekly_day !== undefined && last.weekly_day >= sunday ? null : sunday;
}

async function createClose(main: Session, moment: LocalMoment, timeline: Timeline): Promise<string> {
  const id = `gws-ea-close-${randomUUID().replaceAll('-', '')}`;
  const { session } = await resolveSystemSession(main.agent_group_id, `system:gws-ea-close:${id}`);
  const at = new Date(moment.at).toISOString();
  await getDb().run(
    `INSERT INTO gws_ea_close_schedule (id,session_id,scheduled_at,zone,timeline_version,weekly_day)
    VALUES (?,?,?,?,?,?)`,
    id,
    session.id,
    at,
    moment.zone,
    timeline.version,
    await weeklyDay(moment.at, moment.zone),
  );
  await ensureCloseTask({
    id,
    session_id: session.id,
    scheduled_at: at,
    zone: moment.zone,
    timeline_version: timeline.version,
    weekly_day: null,
    report_text: null,
    report_notify: null,
    retired_at: null,
  });
  return at;
}

async function ensureCloseTask(schedule: CloseSchedule): Promise<void> {
  const session = await getSession(schedule.session_id);
  if (!session) throw new Error('The close session is unavailable.');
  const prepared = prepareScheduledTask({
    name: 'gws-ea close',
    prompt: `${CLOSE_PROMPT}\nClose-run: ${schedule.id}.`,
    script: `ncl matters evening --run ${schedule.id}`,
    processAfter: schedule.scheduled_at,
    timezone: schedule.zone,
  });
  prepared.clock = { instant: schedule.scheduled_at, zone: schedule.zone };
  await createScheduledTask(session.agent_group_id, prepared, { session, id: schedule.id });
}

async function activeCloseSchedules(): Promise<CloseSchedule[]> {
  return getDb().all<CloseSchedule>(
    'SELECT * FROM gws_ea_close_schedule WHERE retired_at IS NULL ORDER BY scheduled_at,id',
  );
}

/** Closure revokes native outbound authority before waiting on the runtime's stop receipt. */
async function retireClose(schedule: CloseSchedule, failed: boolean): Promise<void> {
  await getDb().transaction(async () => {
    if (failed) await failCloseRun(schedule.id);
    await updateSession(schedule.session_id, { status: 'closed' });
  });
  const session = await getSession(schedule.session_id);
  if (session)
    await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) => mailbox.cancelTask(schedule.id));
  if (isContainerRunning(schedule.session_id)) {
    let timeout: NodeJS.Timeout | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error('The close container has not stopped; cleanup will resume.')),
          30_000,
        );
        killContainer(schedule.session_id, 'gws-ea-close-retired', resolve);
      });
    } finally {
      clearTimeout(timeout);
    }
  }
  await waitForSessionChannelDelivery(schedule.session_id);
  await getDb().run('UPDATE gws_ea_close_schedule SET retired_at=? WHERE id=?', new Date().toISOString(), schedule.id);
}

async function retireEarlierCloses(schedule: CloseSchedule): Promise<void> {
  const earlier = await getDb().all<CloseSchedule>(
    `SELECT * FROM gws_ea_close_schedule
    WHERE retired_at IS NULL AND id<>? AND scheduled_at<=? ORDER BY scheduled_at,id`,
    schedule.id,
    schedule.scheduled_at,
  );
  for (const previous of earlier) {
    const run = await getDb().get<CloseRun>('SELECT * FROM gws_ea_close_runs WHERE id=?', previous.id);
    await retireClose(previous, run?.state === 'open');
  }
}

/** The caller serializes this clock with slot edits. Acknowledgments never advance ledger coverage. */
export async function keepClose(main: Session): Promise<string> {
  const timeline = await loadTimeline();
  await retireDailySync();
  const attempted = await getDb().get<{ started_at: string | null }>(
    'SELECT MAX(started_at) AS started_at FROM gws_ea_close_runs',
  );
  let previous = attempted?.started_at ? Date.parse(attempted.started_at) : null;
  for (const schedule of await activeCloseSchedules()) {
    const run = await getDb().get<CloseRun>('SELECT * FROM gws_ea_close_runs WHERE id=?', schedule.id);
    const session = await getSession(schedule.session_id);
    if (session?.status !== 'active' || (run && run.state !== 'open')) {
      await retireClose(schedule, run?.state === 'open');
      continue;
    }
    await ensureCloseTask(schedule);
    const held = await heldClose(schedule);
    if (!held) continue;
    const state = await occurrenceState(held);
    if (run || state.claimed) {
      const started = Date.parse(run?.started_at ?? schedule.scheduled_at);
      previous = Math.max(previous ?? started, started);
      const next = nextClosePlacement(timeline, started + HALF_DAY, started);
      if (run?.state === 'open' && ((state.acked && !isContainerRunning(held.session.id)) || next.at <= Date.now())) {
        await retireClose(schedule, true);
      } else if (!run && state.acked && !isContainerRunning(held.session.id)) {
        await beginCloseRun({
          id: schedule.id,
          sessionId: held.session.id,
          taskId: schedule.id,
          startedAt: schedule.scheduled_at,
        });
        await retireClose(schedule, true);
      }
      continue;
    }
    if (held.task.status !== 'pending') {
      await retireClose(schedule, false);
      continue;
    }
    if (schedule.timeline_version !== timeline.version) {
      const moment = nextClosePlacement(timeline, Math.min(Date.now(), Date.parse(schedule.scheduled_at)), previous);
      const at = new Date(moment.at).toISOString();
      if (at === schedule.scheduled_at) {
        await getDb().run(
          'UPDATE gws_ea_close_schedule SET timeline_version=?,zone=? WHERE id=?',
          timeline.version,
          moment.zone,
          schedule.id,
        );
        return at;
      }
      const touched = await withExistingMailboxSession(main.agent_group_id, held.session.id, (mailbox) => {
        if (
          mailbox.getProcessingClaims().some((claim) => claim.messageId === schedule.id) ||
          mailbox.getTerminalProcessingAcks().some((ack) => ack.messageId === schedule.id)
        )
          return 'claimed' as const;
        return mailbox.updateTask(schedule.id, { processAfter: at, clock: { instant: at, zone: moment.zone } })
          ? ('updated' as const)
          : ('immutable' as const);
      });
      if (touched === 'claimed' || isContainerRunning(held.session.id)) return schedule.scheduled_at;
      if (touched !== 'updated') {
        // Native due rows are immutable. Retire this unclaimed occurrence before arming its new clock.
        await retireClose(schedule, false);
        return createClose(main, moment, timeline);
      }
      await getDb().run(
        'UPDATE gws_ea_close_schedule SET scheduled_at=?,zone=?,timeline_version=?,weekly_day=? WHERE id=?',
        at,
        moment.zone,
        timeline.version,
        await weeklyDay(moment.at, moment.zone),
        schedule.id,
      );
      return at;
    }
    return schedule.scheduled_at;
  }
  return createClose(
    main,
    nextClosePlacement(timeline, previous === null ? Date.now() : previous + HALF_DAY, previous),
    timeline,
  );
}

export function closeVerdict(sessionId: string, runId?: string): Promise<ScriptVerdict> {
  return oneAtATime(async () => {
    const schedule =
      runId === undefined
        ? await getDb().get<CloseSchedule>('SELECT * FROM gws_ea_close_schedule WHERE session_id=?', sessionId)
        : await getDb().get<CloseSchedule>(
            'SELECT * FROM gws_ea_close_schedule WHERE id=? AND session_id=?',
            runId,
            sessionId,
          );
    if (!schedule) throw new Error('This session has no evening close.');
    if (schedule.retired_at !== null || (await getSession(sessionId))?.status !== 'active')
      return { wakeAgent: false, data: ['This close session has ended.'] };
    if (Date.parse(schedule.scheduled_at) > Date.now()) return { wakeAgent: false, data: [] };
    await retireEarlierCloses(schedule);
    const run = await beginCloseRun({ id: schedule.id, sessionId, taskId: schedule.id });
    if (run.state !== 'open') return { wakeAgent: false, data: [`Close ${run.id} is ${run.state}.`] };
    const timeline = await loadTimeline();
    const weekly = await weeklyDay(
      Date.parse(run.started_at),
      zoneAt(timeline, Date.parse(run.started_at)) ?? schedule.zone,
    );
    await getDb().run('UPDATE gws_ea_close_schedule SET weekly_day=? WHERE id=?', weekly, schedule.id);
    const [notes, threads, looks] = await Promise.all([unreadNotes(), listUnplacedThreads(), listHeldLookSlots()]);
    const scheduledZone = zoneAt(timeline, Date.parse(schedule.scheduled_at));
    const scheduledTime =
      scheduledZone === null
        ? `${schedule.scheduled_at} (zone unknown)`
        : formatLocalTimeWithZone(schedule.scheduled_at, scheduledZone);
    const late = Math.max(0, Math.floor((Date.now() - Date.parse(schedule.scheduled_at)) / 60_000));
    const hours = Math.floor(late / 60);
    const remaining = late % 60;
    const duration =
      hours === 0
        ? `${late} ${late === 1 ? 'minute' : 'minutes'}`
        : `${hours} ${hours === 1 ? 'hour' : 'hours'}${remaining === 0 ? '' : ` ${remaining} ${remaining === 1 ? 'minute' : 'minutes'}`}`;
    return {
      wakeAgent: true,
      data: [
        `Close-run: ${schedule.id}; scheduled ${scheduledTime}; ${duration} late.`,
        `Report already recorded: ${schedule.report_text === null ? 'no' : 'yes'}.`,
        ...(schedule.report_text === null ? [] : [`Recorded report: ${schedule.report_text}`]),
        ...(notes === 0 ? [] : [`${notes} unread notes; read ncl day for their content and the day's ledger.`]),
        ...sectionLines(unplacedSection(threads, timeline)),
        ...sectionLines({
          heading: 'Hand-backs',
          lines: looks
            .filter(({ held }) => held && lookSeries(seriesKey(held.task))?.handedBack)
            .map(({ slot }) => `- ${slot.id}: ${slot.title}`),
        }),
        ...(weekly === null
          ? []
          : [
              `Weekly pass for Sunday ${weekly}: the week and month ahead, stale open matters and consolidation. Snapshot memory before consolidation.`,
            ]),
      ],
    };
  });
}

/** Persist the agent's decision before the native note write, so either side of a retry sends once. */
export function finishClose(sessionId: string, runId: string, report?: string, notify = false): Promise<CloseRun> {
  return oneAtATime(async () => {
    const existing = await getDb().get<CloseRun>(
      'SELECT * FROM gws_ea_close_runs WHERE id=? AND session_id=?',
      runId,
      sessionId,
    );
    if (existing?.state === 'completed') return existing;
    const run = await getOpenCloseRun(sessionId);
    if (!run || run.id !== runId || run.ledger_through_at === null)
      throw new Error('Only this open close with captured day ledger may be marked done.');
    const prior = await getDb().get<CloseSchedule>(
      'SELECT * FROM gws_ea_close_schedule WHERE id=? AND session_id=?',
      runId,
      sessionId,
    );
    if (prior?.report_text === null && (report === undefined || report.trim() === ''))
      throw new Error(
        '--report is required: leave main the result of your close, including your decision to stay quiet.',
      );
    if (report !== undefined)
      await getDb().run(
        'UPDATE gws_ea_close_schedule SET report_text=?,report_notify=? WHERE id=? AND session_id=? AND report_text IS NULL',
        report,
        notify ? 1 : 0,
        runId,
        sessionId,
      );
    const schedule = await getDb().get<CloseSchedule>(
      'SELECT * FROM gws_ea_close_schedule WHERE id=? AND session_id=?',
      runId,
      sessionId,
    );
    if (!schedule || schedule.report_text === null) throw new Error('This close has no report decision.');
    const written = await writeNoteForMain({
      id: `close-report-${runId}`,
      timestamp: new Date().toISOString(),
      text: schedule.report_text,
      wake: schedule.report_notify === 1,
      ...(schedule.report_notify === 1 ? {} : { noteKind: 'host-receipt' as const }),
    });
    if (written !== 'written' && written !== 'already-written')
      throw new Error('The close report has no main conversation yet.');
    return completeCloseRun(runId, sessionId);
  });
}

/** Forgetting deletes the latest snapshot by path; the host never reads memory contents. */
export async function forgetSundaySnapshot(): Promise<void> {
  const main = await getMainAgentGroupId();
  const group = main === null ? undefined : await getAgentGroup(main);
  if (group) await fs.rm(path.join(GROUPS_DIR, group.folder, 'sunday-memory-latest'), { recursive: true, force: true });
}

interface ScriptSection {
  readonly heading: string;
  readonly lines: readonly string[];
}

function sectionLines(section: ScriptSection): string[] {
  return section.lines.length === 0 ? [`${section.heading}: none.`] : [`${section.heading}:`, ...section.lines];
}

/** The one line main reads for a thread waiting to be placed, wherever it is shown one. */
export function unplacedThreadLine(thread: UnplacedThread, timeline: Timeline): string {
  const timezone = zoneAt(timeline, Date.parse(thread.latestAt)) ?? TIMEZONE;
  return [
    `- ${thread.threadKey}: ${thread.people.join(', ')}`,
    `latest mail ${formatLocalTime(thread.latestAt, timezone)}`,
    ...(thread.gmailThreadId === null ? [] : [`Gmail thread ${thread.gmailThreadId}`]),
  ].join('; ');
}

function unplacedSection(threads: readonly UnplacedThread[], timeline: Timeline): ScriptSection {
  return {
    heading: 'Threads waiting to be placed',
    lines: threads.map((thread) => unplacedThreadLine(thread, timeline)),
  };
}

/** How many notes main has not read, across its conversations: each rides along with its next turn. */
export async function unreadNotes(): Promise<number> {
  let count = 0;
  for (const session of await mainConversations()) {
    count +=
      (await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
        mailbox.countUnreadContext(ECHO_CHANNEL_TYPE),
      )) ?? 0;
  }
  return count;
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
  const timeline = await loadTimeline();
  const timezone = zoneAt(timeline, Date.now()) ?? TIMEZONE;
  const looks = await looksBefore(nextRun('0 0 * * *', timezone));
  const matters =
    looks.length === 0
      ? []
      : await getDb().all<Pick<Matter, 'id' | 'due_at' | 'needs_minutes' | 'place' | 'deferrals'>>(
          `SELECT id, due_at, needs_minutes, place, deferrals FROM gws_ea_matters WHERE id IN (${looks.map(() => '?').join(', ')})`,
          ...looks.map((look) => look.matterId),
        );
  const facts = new Map(
    matters.map((matter) => [matter.id, matterPlanningLines(matter, timeline, timezone).join(' ')] as const),
  );
  const suffix = (id: string): string => (facts.get(id) ? `; ${facts.get(id)}` : '');
  const sections: ScriptSection[] = [
    {
      heading: 'Looks today',
      lines: looks
        .filter((look) => !look.handedBack)
        .map(
          (look) =>
            `- ${look.matterId}, ${formatLocalTime(look.at, zoneAt(timeline, Date.parse(look.at)) ?? timezone)}: ${look.title}${suffix(look.matterId)}`,
        ),
    },
    {
      heading: 'Handed back without a next look',
      lines: looks
        .filter((look) => look.handedBack)
        .map((look) => `- ${look.matterId}: ${look.title}${suffix(look.matterId)}`),
    },
    unplacedSection(await listUnplacedThreads(), timeline),
  ];
  return { wakeAgent: true, data: sections.flatMap(sectionLines) };
}
