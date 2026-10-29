import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CronExpressionParser } from 'cron-parser';

import { TIMEZONE, GROUPS_DIR } from '../../config.js';
import { isContainerRunning } from '../../container-runner.js';
import { getDb } from '../../db/connection.js';
import { getSession } from '../../db/sessions.js';
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
import {
  beginCloseRun,
  completeCloseRun,
  failCloseRun,
  getCloseRun,
  lastCompletedClose,
  type CloseRun,
} from './close-runs.js';
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
export const CLOSE_PROMPT = `The evening close. Run ncl matters evening for this run's facts. Use days and check for the live calendar; an unavailable ambient week view does not replace those tools.
Start look-back as a background Agent call; when it returns, start look-ahead as a background Agent call. Include this close-run id and its ledger/date scope in each delegation, and require the same header in the result. Look-back reads ncl day in this session, which records the day this close covers; --done needs that read. Retain the returned agentId for each role: their exact files are /workspace/agent/planning-runs/<agentId>-look-back.md and /workspace/agent/planning-runs/<agentId>-look-ahead.md. Read only those exact files once both agents return; ignore stale files and mismatched close-run/scope headers. Wait for both before acting. Record the close step and both returned ids so compaction can resume it.
Look back catches still-open promises without matters; create the matters they need. Look ahead checks slipped check-ins and proposes tomorrow's moments: set any that matter as ordinary looks. Act on proposals yourself; planning agents make no external writes.
When the verdict says weekly pass, look at the week and month ahead, refresh or close stale open matters after reading their links fresh, and consolidate memory. Before launching look-back for that consolidation, replace /workspace/agent/sunday-memory-latest with a copy of /workspace/agent/memory; keep only this latest snapshot.
Judge the verdict's lateness: what still belongs tonight, and what waits for morning. Keep a quiet close quiet. Main talks with the principal; this session reaches main through its report. After acting on both results, use ncl matters evening --done <run> --report '<your report>': the report reaches main as a note, which waits for main's next wake unless you add --notify, which wakes main now. --done records one report per run; a repeat keeps the first. Only --done completes the close; a task acknowledgment does not.`;

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

async function heldClose(run: CloseRun): Promise<HeldTask | undefined> {
  const session = await getSession(run.session_id);
  if (!session) return undefined;
  const task = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
    mailbox.getTask(run.id),
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

/** The evening close replaced the daily sync: its series ends, with no successor. */
export async function cancelDailySync(): Promise<void> {
  for (const session of await mainConversations())
    await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) => {
      const task = mailbox.findTaskBySeriesSlug('gws-ea-daily-sync');
      if (task) mailbox.cancelTask(seriesKey(task));
    });
}

async function weeklyDay(at: number, zone: string): Promise<string | null> {
  const sunday = sundayOnOrBefore(at, zone);
  const last = await getDb().get<{ weekly_day: string | null }>(
    "SELECT MAX(weekly_day) AS weekly_day FROM gws_ea_close_runs WHERE state='completed'",
  );
  return last?.weekly_day !== null && last?.weekly_day !== undefined && last.weekly_day >= sunday ? null : sunday;
}

async function createClose(main: Session, moment: LocalMoment, timeline: Timeline): Promise<string> {
  const id = `gws-ea-close-${randomUUID().replaceAll('-', '')}`;
  const { session } = await resolveSystemSession(main.agent_group_id, `system:gws-ea-close:${id}`);
  const at = new Date(moment.at).toISOString();
  await getDb().run(
    `INSERT INTO gws_ea_close_runs (id,session_id,scheduled_at,zone,timeline_version,state)
    VALUES (?,?,?,?,?,'pending')`,
    id,
    session.id,
    at,
    moment.zone,
    timeline.version,
  );
  await ensureCloseTask({ id, session_id: session.id, scheduled_at: at, zone: moment.zone });
  return at;
}

async function ensureCloseTask(run: Pick<CloseRun, 'id' | 'session_id' | 'scheduled_at' | 'zone'>): Promise<void> {
  const session = await getSession(run.session_id);
  if (!session) throw new Error('The close session is unavailable.');
  const prepared = prepareScheduledTask({
    name: 'gws-ea close',
    prompt: `${CLOSE_PROMPT}\nClose-run: ${run.id}.`,
    script: `ncl matters evening --run ${run.id}`,
    processAfter: run.scheduled_at,
    timezone: run.zone,
  });
  await createScheduledTask(session.agent_group_id, prepared, { session, id: run.id });
}

/** A close that never ran gives way to another. */
async function replaceClose(run: CloseRun, held: HeldTask): Promise<void> {
  await withExistingMailboxSession(held.session.agent_group_id, held.session.id, (mailbox) =>
    mailbox.cancelTask(run.id),
  );
  await failCloseRun(run.id);
}

/** The caller serializes this clock with slot edits. Acknowledgments never advance ledger coverage. */
export async function keepClose(main: Session): Promise<string> {
  const timeline = await loadTimeline();
  const attempted = await getDb().get<{ started_at: string | null }>(
    'SELECT MAX(started_at) AS started_at FROM gws_ea_close_runs',
  );
  let previous = attempted?.started_at ? Date.parse(attempted.started_at) : null;
  for (const run of await getDb().all<CloseRun>(
    "SELECT * FROM gws_ea_close_runs WHERE state IN ('pending','open') ORDER BY scheduled_at,id",
  )) {
    await ensureCloseTask(run);
    const held = await heldClose(run);
    if (!held) continue;
    const state = await occurrenceState(held);
    if (run.state === 'open' || state.claimed) {
      const started = Date.parse(run.started_at ?? run.scheduled_at);
      previous = Math.max(previous ?? started, started);
      const ended = state.acked && !isContainerRunning(held.session.id);
      // A close still open when the next one is due has failed, so a container kept busy never skips a close.
      const overdue =
        run.state === 'open' && nextClosePlacement(timeline, started + HALF_DAY, started).at <= Date.now();
      if (ended || overdue) await failCloseRun(run.id, run.scheduled_at);
      continue;
    }
    if (held.task.status !== 'pending') {
      await replaceClose(run, held);
      continue;
    }
    if (run.timeline_version === timeline.version) return run.scheduled_at;
    const moment = nextClosePlacement(timeline, Math.min(Date.now(), Date.parse(run.scheduled_at)), previous);
    const at = new Date(moment.at).toISOString();
    if (at === run.scheduled_at) {
      await getDb().run(
        'UPDATE gws_ea_close_runs SET timeline_version=?,zone=? WHERE id=?',
        timeline.version,
        moment.zone,
        run.id,
      );
      return at;
    }
    const touched = await withExistingMailboxSession(main.agent_group_id, held.session.id, (mailbox) => {
      if (
        mailbox.getProcessingClaims().some((claim) => claim.messageId === run.id) ||
        mailbox.getTerminalProcessingAcks().some((ack) => ack.messageId === run.id)
      )
        return 'claimed' as const;
      return mailbox.updateTask(run.id, { processAfter: at }) ? ('updated' as const) : ('immutable' as const);
    });
    if (touched === 'claimed' || isContainerRunning(held.session.id)) return run.scheduled_at;
    if (touched !== 'updated') {
      await replaceClose(run, held);
      return createClose(main, moment, timeline);
    }
    await getDb().run(
      'UPDATE gws_ea_close_runs SET scheduled_at=?,zone=?,timeline_version=? WHERE id=?',
      at,
      moment.zone,
      timeline.version,
      run.id,
    );
    return at;
  }
  return createClose(
    main,
    nextClosePlacement(timeline, previous === null ? Date.now() : previous + HALF_DAY, previous),
    timeline,
  );
}

function localInstant(at: string, timeline: Timeline): string {
  const zone = zoneAt(timeline, Date.parse(at));
  return zone === null ? `${at} (zone unknown)` : formatLocalTimeWithZone(at, zone);
}

export function closeVerdict(sessionId: string, runId?: string): Promise<ScriptVerdict> {
  return oneAtATime(async () => {
    const run =
      runId === undefined
        ? await getDb().get<CloseRun>('SELECT * FROM gws_ea_close_runs WHERE session_id=?', sessionId)
        : await getCloseRun(runId, sessionId);
    if (!run) throw new Error('This session has no evening close.');
    if (run.state === 'completed' || run.state === 'failed')
      return { wakeAgent: false, data: [`Close ${run.id} is ${run.state}.`] };
    if (Date.parse(run.scheduled_at) > Date.now()) return { wakeAgent: false, data: [] };
    const started = Date.parse((await beginCloseRun(run.id, sessionId)).started_at ?? run.scheduled_at);
    const timeline = await loadTimeline();
    const weekly = await weeklyDay(started, zoneAt(timeline, started) ?? run.zone);
    await getDb().run('UPDATE gws_ea_close_runs SET weekly_day=? WHERE id=?', weekly, run.id);
    const [notes, threads, covered] = await Promise.all([unreadNotes(), listUnplacedThreads(), lastCompletedClose()]);
    const late = Math.max(0, Math.floor((Date.now() - Date.parse(run.scheduled_at)) / 60_000));
    const hours = Math.floor(late / 60);
    const remaining = late % 60;
    const duration =
      hours === 0
        ? `${late} ${late === 1 ? 'minute' : 'minutes'}`
        : `${hours} ${hours === 1 ? 'hour' : 'hours'}${remaining === 0 ? '' : ` ${remaining} ${remaining === 1 ? 'minute' : 'minutes'}`}`;
    const ledgerFrom = covered?.ledger_through_at ?? null;
    return {
      wakeAgent: true,
      data: [
        `Close-run: ${run.id}; scheduled ${localInstant(run.scheduled_at, timeline)}; ${duration} late.`,
        ledgerFrom === null
          ? 'Day ledger: everything so far; no close has completed yet.'
          : `Day ledger since ${localInstant(ledgerFrom, timeline)}, when the last completed close read it.`,
        ...(notes === 0 ? [] : [`${notes} unread notes in main's conversations; the day ledger carries them.`]),
        ...sectionLines(unplacedSection(threads, timeline)),
        ...(weekly === null
          ? []
          : [
              `Weekly pass for Sunday ${weekly}: the week and month ahead, stale open matters and consolidation. Snapshot memory before consolidation.`,
            ]),
      ],
    };
  });
}

/** The note's id makes the report one per run: a retry after it was written adds nothing, and its first text stands. */
export function finishClose(sessionId: string, runId: string, report?: string, notify = false): Promise<CloseRun> {
  return oneAtATime(async () => {
    const run = await getCloseRun(runId, sessionId);
    if (run?.state === 'completed') return run;
    if (run?.state !== 'open' || run.ledger_through_at === null)
      throw new Error(
        'Only this session’s open close may be marked done, after ncl day has been read in this session.',
      );
    if (report === undefined || report.trim() === '')
      throw new Error(
        '--report is required: leave main the result of your close, including your decision to stay quiet.',
      );
    const written = await writeNoteForMain({
      id: `close-report-${runId}`,
      timestamp: new Date().toISOString(),
      text: report,
      wake: notify,
      ...(notify ? {} : { noteKind: 'host-receipt' as const }),
    });
    if (written !== 'written' && written !== 'already-written')
      throw new Error('The close report has no main conversation yet.');
    return completeCloseRun(runId, sessionId);
  });
}

/** Forgetting deletes the latest memory snapshot and the planning results by path; the host never reads either. */
export async function forgetSundaySnapshot(): Promise<void> {
  const main = await getMainAgentGroupId();
  const group = main === null ? undefined : await getAgentGroup(main);
  if (!group) return;
  for (const copy of ['sunday-memory-latest', 'planning-runs'])
    await fs.rm(path.join(GROUPS_DIR, group.folder, copy), { recursive: true, force: true });
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
