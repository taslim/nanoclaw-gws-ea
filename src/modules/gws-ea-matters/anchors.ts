import { randomUUID } from 'node:crypto';
import { CronExpressionParser } from 'cron-parser';

import { getDb } from '../../db/connection.js';
import type { TaskRecord } from '../../mailbox/index.js';
import type { InboundRecord } from '../../mailbox/model.js';
import type { TaskClock } from '../../mailbox/types.js';
import { parseTaskContent } from '../scheduling/task-content.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import { formatLocalTime } from '../../timezone.js';
import type { Session } from '../../types.js';
import { writeNoteForMain } from '../gws-ea-profile/main-note.js';
import { dateString, iso, wallClock, zonedInstant, type WallClock } from '../gws-ea-whereabouts/clock.js';
import type { PendingClockItem } from '../gws-ea-whereabouts/changes.js';
import { zoneAt, type Timeline } from '../gws-ea-whereabouts/timeline.js';
import { mainConversations, seriesKey } from './looks.js';

const TRIP_CORRECTION_SETTLE_MS = 2 * 60_000;

export interface Retime {
  readonly id: string;
  readonly oldAt: string;
  readonly newAt: string;
  readonly oldZone: string;
  readonly newZone: string;
}

export interface TimeAnchor {
  readonly sessionId: string;
  readonly seriesId: string;
  readonly sourceClock: TaskClock;
  readonly originalAt: string;
  readonly originalZone: string;
  readonly createdAt: string;
  readonly wall: WallClock;
  readonly recurrence: string | null;
  readonly fixed: boolean;
  readonly rowId: string;
  readonly content: string;
  readonly appliedAt: string;
  readonly appliedZone: string;
  readonly timelineVersion: string;
  readonly timelineChangedAt: string;
  readonly lastRun: string | null;
  readonly lastLocalRun: string | null;
  readonly hostRetryRowId: string | null;
  readonly change: Retime | null;
  readonly notices: readonly Retime[];
}

/** The close and morning gate own these series, including their generic-loop exclusion. */
export function isHostTimedSeries(id: string): boolean {
  return /^(?:gws-ea-close-|gws-ea-morning-|gws-ea-daily-sync-)/u.test(id);
}

function localKey(wall: WallClock): string {
  return `${dateString(wall)}T${String(wall.hour).padStart(2, '0')}:${String(wall.minute).padStart(2, '0')}:${String(wall.second).padStart(2, '0')}`;
}

function instant(wall: WallClock, zone: string, milliseconds: number): number {
  return zonedInstant(wall, wall.hour * 60 + wall.minute, zone) + wall.second * 1000 + milliseconds;
}

function zoneIntervals(timeline: Timeline, from: number): { start: number; end: number; zone: string }[] {
  const boundaries = new Set([
    from,
    ...timeline.stays.flatMap((stay) => (stay.end === null ? [stay.start] : [stay.start, stay.end])),
    ...timeline.legs.flatMap((leg) => [leg.departure, leg.arrival]),
  ]);
  const points = [...boundaries].filter((point) => point >= from).sort((a, b) => a - b);
  return points.flatMap((start, i) => {
    const zone = zoneAt(timeline, start);
    return zone === null ? [] : [{ start, end: points[i + 1] ?? Number.POSITIVE_INFINITY, zone }];
  });
}

export interface AnchorMoment {
  readonly at: string;
  readonly zone: string;
}

/** Local occurrence identity survives westward travel as well as the strict instant-after-last-run rule. */
export function retimeAnchor(anchor: TimeAnchor, timeline: Timeline, now: number): AnchorMoment | null {
  const original = Date.parse(anchor.originalAt);
  if (anchor.recurrence === null) {
    if (anchor.fixed) return { at: anchor.originalAt, zone: anchor.originalZone };
    const milliseconds = ((original % 1000) + 1000) % 1000;
    const candidates = zoneIntervals(timeline, original - 2 * 86_400_000).flatMap(({ start, end, zone }) => {
      const at = instant(anchor.wall, zone, milliseconds);
      return start <= at && at < end ? [{ at, zone }] : [];
    });
    const chosen = candidates.sort((a, b) => a.at - b.at)[0];
    return chosen ? { at: iso(Math.max(chosen.at, now)), zone: chosen.zone } : null;
  }
  const last = anchor.lastRun === null ? null : Date.parse(anchor.lastRun);
  if (anchor.fixed) {
    const next = CronExpressionParser.parse(anchor.recurrence, {
      tz: anchor.originalZone,
      currentDate: last ?? original - 1,
    })
      .next()
      .getTime();
    return { at: iso(Math.max(next, now)), zone: anchor.originalZone };
  }
  const earliest = last ?? original - 2 * 86_400_000;
  const firstLocal = localKey(anchor.wall);
  const found: { at: number; zone: string }[] = [];
  for (const { start, end, zone } of zoneIntervals(timeline, earliest)) {
    const interval = CronExpressionParser.parse(anchor.recurrence, {
      tz: zone,
      currentDate: Math.max(start - 1, last ?? instant(anchor.wall, zone, 0) - 1, Date.parse(anchor.createdAt)),
    });
    for (let next = interval.next().getTime(); next < end; next = interval.next().getTime()) {
      const key = localKey(wallClock(next, zone));
      if ((last === null && key < firstLocal) || (anchor.lastLocalRun !== null && key <= anchor.lastLocalRun)) continue;
      found.push({ at: next, zone });
      break;
    }
  }
  const chosen = found.sort((a, b) => a.at - b.at)[0];
  return chosen ? { at: iso(Math.max(chosen.at, now)), zone: chosen.zone } : null;
}

export async function getTimeAnchor(sessionId: string, seriesId: string): Promise<TimeAnchor | undefined> {
  const row = await getDb().get<{ anchor: string }>(
    'SELECT anchor FROM gws_ea_time_anchors WHERE session_id=? AND series_id=?',
    sessionId,
    seriesId,
  );
  return row === undefined ? undefined : (JSON.parse(row.anchor) as TimeAnchor);
}

async function save(anchor: TimeAnchor): Promise<void> {
  await getDb().run(
    `INSERT INTO gws_ea_time_anchors (session_id,series_id,anchor) VALUES (?,?,?)
     ON CONFLICT (session_id,series_id) DO UPDATE SET anchor=excluded.anchor`,
    anchor.sessionId,
    anchor.seriesId,
    JSON.stringify(anchor),
  );
}

/** UTC alone cannot recover the interpretation zone after a stay is entered. */
export async function anchorTask(
  session: Session,
  task: TaskRecord,
  timeline: Timeline,
  clock: TaskClock,
  fixed = false,
  createdAt: string = task.timestamp,
): Promise<TimeAnchor> {
  if (task.processAfter === null) throw new Error('A clock anchor requires a scheduled moment');
  const previous = await getTimeAnchor(session.id, seriesKey(task));
  const anchor: TimeAnchor = {
    sessionId: session.id,
    seriesId: seriesKey(task),
    sourceClock: clock,
    originalAt: clock.instant,
    originalZone: clock.zone,
    createdAt,
    wall: wallClock(Date.parse(clock.instant), clock.zone),
    recurrence: task.recurrence,
    fixed,
    rowId: task.id,
    content: task.content,
    appliedAt: task.processAfter,
    appliedZone: clock.zone,
    timelineVersion: timeline.version,
    timelineChangedAt: iso(Date.now()),
    lastRun: previous?.lastRun ?? null,
    lastLocalRun: previous?.lastLocalRun ?? null,
    hostRetryRowId: null,
    change: null,
    notices: previous?.notices ?? [],
  };
  await save(anchor);
  return anchor;
}

async function notify(anchor: TimeAnchor): Promise<TimeAnchor> {
  let current = anchor;
  for (const notice of anchor.notices) {
    const { id, oldAt, newAt, oldZone, newZone } = notice;
    const result = await writeNoteForMain({
      id,
      timestamp: iso(Date.now()),
      wake: false,
      text: `Local clock re-timed task ${anchor.seriesId}: ${formatLocalTime(oldAt, oldZone)} (${oldZone}) → ${formatLocalTime(newAt, newZone)} (${newZone}).`,
    });
    if (result !== 'written' && result !== 'already-written') break;
    current = { ...current, notices: current.notices.filter((entry) => entry.id !== id) };
    await save(current);
  }
  return current;
}

async function apply(
  session: Session,
  task: TaskRecord,
  anchor: TimeAnchor,
  moment: AnchorMoment,
): Promise<TimeAnchor> {
  if (task.processAfter === moment.at) return notify(anchor);
  const change =
    anchor.change?.newAt === moment.at
      ? anchor.change
      : {
          id: `clock-${randomUUID()}`,
          oldAt: task.processAfter ?? anchor.appliedAt,
          newAt: moment.at,
          oldZone: anchor.appliedZone,
          newZone: moment.zone,
        };
  const planned = { ...anchor, change };
  await save(planned);
  const touched = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) => {
    if (
      mailbox.getProcessingClaims().some((claim) => claim.messageId === task.id) ||
      mailbox.getTerminalProcessingAcks().some((ack) => ack.messageId === task.id)
    )
      return 0;
    const current = mailbox.getTask(task.id);
    if (
      !current ||
      current.id !== task.id ||
      current.processAfter !== task.processAfter ||
      current.recurrence !== task.recurrence ||
      current.content !== task.content
    )
      return 0;
    return mailbox.updateTask(task.id, { processAfter: moment.at });
  });
  if (!touched) return planned;
  const moved = {
    ...planned,
    appliedAt: moment.at,
    appliedZone: moment.zone,
    change: null,
    notices: [...planned.notices, change],
  };
  await save(moved);
  return notify(moved);
}

/** A host retry keeps its cron and local anchor while this occurrence waits at the close/sync. */
export async function rememberHostRetry(session: Session, seriesId: string): Promise<void> {
  const anchor = await getTimeAnchor(session.id, seriesId);
  if (!anchor) return;
  const task = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
    mailbox.getTask(seriesId),
  );
  if (!task?.processAfter) return;
  await save({ ...anchor, appliedAt: task.processAfter, rowId: task.id, hostRetryRowId: task.id });
}

interface RunEvidence {
  readonly claimed: boolean;
  readonly lastRun: string | null;
}

function latestRuns(records: readonly InboundRecord[]): ReadonlyMap<string, string> {
  const runs = new Map<string, { at: string; seq: number }>();
  for (const row of records) {
    if (row.kind !== 'task' || row.processAfter === null || (row.status !== 'completed' && row.status !== 'failed'))
      continue;
    const series = row.seriesId ?? row.id;
    const seq = row.sequence ?? 0;
    if (seq > (runs.get(series)?.seq ?? -1)) runs.set(series, { at: row.processAfter, seq });
  }
  return new Map([...runs].map(([series, run]) => [series, run.at]));
}

function afterRun(anchor: TimeAnchor, lastRun: string | null): TimeAnchor {
  return lastRun !== null && anchor.lastRun !== lastRun
    ? { ...anchor, lastRun, lastLocalRun: localKey(wallClock(Date.parse(lastRun), anchor.appliedZone)) }
    : anchor;
}

async function observeAnchor(
  session: Session,
  task: TaskRecord,
  timeline: Timeline,
  lastRun: string | null,
): Promise<TimeAnchor | undefined> {
  if (task.processAfter === null) return undefined;
  const clock = parseTaskContent(task.content).clock;
  let anchor = await getTimeAnchor(session.id, seriesKey(task));
  if (!anchor) {
    if (!clock) return undefined;
    anchor = await anchorTask(session, task, timeline, clock);
  }
  let persisted = anchor;
  if (anchor.change !== null && task.processAfter === anchor.change.newAt) {
    anchor = {
      ...anchor,
      appliedAt: task.processAfter,
      appliedZone: anchor.change.newZone,
      notices: [...anchor.notices, anchor.change],
      change: null,
    };
    await save(anchor);
    anchor = await notify(anchor);
    persisted = anchor;
  }
  if (anchor.timelineVersion !== timeline.version) {
    anchor = { ...anchor, timelineVersion: timeline.version, timelineChangedAt: iso(Date.now()) };
  }
  const newRow = anchor.rowId !== task.id;
  const mainEdited =
    clock !== undefined &&
    (clock.instant !== anchor.sourceClock.instant ||
      clock.zone !== anchor.sourceClock.zone ||
      task.recurrence !== anchor.recurrence);
  if (mainEdited && clock) {
    anchor = await anchorTask(session, task, timeline, clock, anchor.fixed, iso(Date.now()));
    persisted = anchor;
  }
  anchor = afterRun(anchor, lastRun);
  if (anchor.rowId !== task.id || anchor.content !== task.content || (newRow && anchor.hostRetryRowId !== null))
    anchor = { ...anchor, rowId: task.id, content: task.content, ...(newRow ? { hostRetryRowId: null } : {}) };
  if (anchor !== persisted) await save(anchor);
  anchor = await notify(anchor);
  return anchor;
}

async function upkeep(session: Session, task: TaskRecord, timeline: Timeline, evidence: RunEvidence): Promise<void> {
  if (task.status !== 'pending' || task.processAfter === null || isHostTimedSeries(seriesKey(task)) || evidence.claimed)
    return;
  const anchor = await observeAnchor(session, task, timeline, evidence.lastRun);
  if (!anchor) return;
  if (anchor.hostRetryRowId === task.id || Date.parse(task.processAfter) <= Date.now()) return;
  const moment = retimeAnchor(anchor, timeline, Date.now());
  if (
    !moment ||
    (Date.parse(moment.at) <= Date.now() &&
      Date.now() - Date.parse(anchor.timelineChangedAt) < TRIP_CORRECTION_SETTLE_MS)
  )
    return;
  if (moment.at === task.processAfter) {
    if (anchor.appliedAt !== task.processAfter || anchor.appliedZone !== moment.zone)
      await save({ ...anchor, appliedAt: task.processAfter, appliedZone: moment.zone });
    return;
  }
  await apply(session, task, anchor, moment);
}

async function recoverReceipts(session: Session, records: readonly InboundRecord[]): Promise<void> {
  const rows = new Map(records.map((row) => [row.id, row]));
  const saved = await getDb().all<{ anchor: string }>(
    'SELECT anchor FROM gws_ea_time_anchors WHERE session_id=?',
    session.id,
  );
  for (const entry of saved) {
    let anchor = JSON.parse(entry.anchor) as TimeAnchor;
    if (anchor.change !== null && rows.get(anchor.rowId)?.processAfter === anchor.change.newAt) {
      anchor = {
        ...anchor,
        appliedAt: anchor.change.newAt,
        appliedZone: anchor.change.newZone,
        notices: [...anchor.notices, anchor.change],
        change: null,
      };
      await save(anchor);
    }
    if (anchor.notices.length > 0) await notify(anchor);
  }
}

/** The caller serializes this isolated loop step with matter slot writes. */
export async function anchorPendingTasks(timeline: Timeline): Promise<void> {
  for (const session of await mainConversations()) {
    const snapshot = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) => {
      const records = mailbox.getInboundRecords();
      return {
        records,
        tasks: mailbox.listLiveTasks(),
        claimed: new Set(
          [...mailbox.getProcessingClaims(), ...mailbox.getTerminalProcessingAcks()].map((ack) => ack.messageId),
        ),
        runs: latestRuns(records),
      };
    });
    if (!snapshot) continue;
    await recoverReceipts(session, snapshot.records);
    for (const task of snapshot.tasks)
      await upkeep(session, task, timeline, {
        claimed: snapshot.claimed.has(task.id),
        lastRun: snapshot.runs.get(seriesKey(task)) ?? null,
      });
  }
}

/** Preview only: a whereabouts command never moves a task or wakes a model. */
export async function pendingLocalItems(_timeline: Timeline): Promise<PendingClockItem[]> {
  const result: PendingClockItem[] = [];
  for (const session of await mainConversations()) {
    const tasks = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
      mailbox.listLiveTasks(),
    );
    for (const task of tasks ?? []) {
      if (task.status !== 'pending' || !task.processAfter || isHostTimedSeries(seriesKey(task))) continue;
      const anchor = await getTimeAnchor(session.id, seriesKey(task));
      const clock = parseTaskContent(task.content).clock;
      if (anchor?.fixed || (!anchor && !clock)) continue;
      result.push({
        task: seriesKey(task),
        at: task.processAfter,
        zone: anchor?.appliedZone ?? clock?.zone ?? 'zone unknown',
      });
    }
  }
  return result;
}

export async function setTaskClock(
  id: string,
  fixed: boolean,
  timeline: Timeline,
): Promise<{ task: string; fixed: boolean; at: string }> {
  for (const session of await mainConversations()) {
    const task = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) => mailbox.getTask(id));
    if (!task?.processAfter || (task.status !== 'pending' && task.status !== 'paused')) continue;
    if (isHostTimedSeries(seriesKey(task))) throw new Error('The host keeps the close and morning clock');
    const lastRun = await withExistingMailboxSession(
      session.agent_group_id,
      session.id,
      (mailbox) => latestRuns(mailbox.getInboundRecords()).get(seriesKey(task)) ?? null,
    );
    const observed = await observeAnchor(session, task, timeline, lastRun ?? null);
    if (!observed)
      throw new Error('This task’s clock is unknown; update its scheduled moment before choosing local or fixed');
    let anchor = { ...observed, fixed };
    await save(anchor);
    const moment = retimeAnchor(anchor, timeline, Date.now());
    if (moment) anchor = await apply(session, task, anchor, moment);
    return { task: seriesKey(task), fixed, at: anchor.appliedAt };
  }
  throw new Error(`No pending task ${JSON.stringify(id)} in main's conversations`);
}
