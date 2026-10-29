import { randomUUID } from 'node:crypto';
import { CronExpressionParser } from 'cron-parser';

import { getDb } from '../../db/connection.js';
import type { TaskRecord } from '../../mailbox/index.js';
import type { InboundRecord } from '../../mailbox/model.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import { formatLocalTime } from '../../timezone.js';
import type { Session } from '../../types.js';
import { writeNoteForMain } from '../gws-ea-profile/main-note.js';
import { dateString, iso, wallClock, zonedInstant, type WallClock } from '../gws-ea-whereabouts/clock.js';
import type { ClockSpan, PendingClockItem } from '../gws-ea-whereabouts/changes.js';
import { zoneAt, zoneSegments, type Timeline } from '../gws-ea-whereabouts/timeline.js';
import { mainConversations, seriesKey } from './looks.js';

const TRIP_CORRECTION_SETTLE_MS = 2 * 60_000;
const DAY_MS = 86_400_000;
// The close and morning gate time these series themselves.
const HOST_TIMED_SERIES = /^(?:gws-ea-close-|gws-ea-morning-)/u;

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
  readonly originalAt: string;
  readonly originalZone: string;
  readonly createdAt: string;
  /** The local time main set; null while a repeating series is armed by its cron alone. */
  readonly wall: WallClock | null;
  readonly recurrence: string | null;
  readonly fixed: boolean;
  readonly rowId: string;
  readonly appliedAt: string;
  readonly appliedZone: string;
  readonly timelineVersion: string;
  readonly timelineChangedAt: string;
  readonly lastRun: string | null;
  readonly lastLocalRun: string | null;
  readonly hostRetryRowId: string | null;
  readonly notices: readonly Retime[];
}

function localKey(wall: WallClock): string {
  return `${dateString(wall)}T${String(wall.hour).padStart(2, '0')}:${String(wall.minute).padStart(2, '0')}:${String(wall.second).padStart(2, '0')}`;
}

function instant(wall: WallClock, zone: string, milliseconds: number): number {
  return zonedInstant(wall, wall.hour * 60 + wall.minute, zone) + wall.second * 1000 + milliseconds;
}

function knownSegments(timeline: Timeline, from: number): { start: number; end: number; zone: string }[] {
  return zoneSegments(timeline, from).flatMap(({ start, end, zone }) => (zone === null ? [] : [{ start, end, zone }]));
}

export interface AnchorMoment {
  readonly at: string;
  readonly zone: string;
}

/** Local occurrence identity survives westward travel as well as the strict instant-after-last-run rule. */
export function retimeAnchor(anchor: TimeAnchor, timeline: Timeline, now: number): AnchorMoment | null {
  const original = Date.parse(anchor.originalAt);
  const last = anchor.lastRun === null ? null : Date.parse(anchor.lastRun);
  const { wall } = anchor;
  // A time main set holds for its own occurrence; after it runs, the cron arms the series again.
  if (anchor.recurrence === null || (wall !== null && (last === null || last < Date.parse(anchor.appliedAt)))) {
    if (anchor.fixed) return { at: anchor.originalAt, zone: anchor.originalZone };
    const local = wall ?? wallClock(original, anchor.originalZone);
    const milliseconds = ((original % 1000) + 1000) % 1000;
    const candidates = knownSegments(timeline, original - 2 * DAY_MS).flatMap(({ start, end, zone }) => {
      const at = instant(local, zone, milliseconds);
      return start <= at && at < end ? [{ at, zone }] : [];
    });
    const chosen = candidates.sort((a, b) => a.at - b.at)[0];
    return chosen ? { at: iso(Math.max(chosen.at, now)), zone: chosen.zone } : null;
  }
  // Before its first run, a cron-armed series starts after it was set.
  const after = Math.max(last ?? Number.NEGATIVE_INFINITY, Date.parse(anchor.createdAt));
  if (anchor.fixed) {
    const next = CronExpressionParser.parse(anchor.recurrence, { tz: anchor.originalZone, currentDate: after })
      .next()
      .getTime();
    return { at: iso(Math.max(next, now)), zone: anchor.originalZone };
  }
  const found: { at: number; zone: string }[] = [];
  for (const { start, end, zone } of knownSegments(timeline, after)) {
    const interval = CronExpressionParser.parse(anchor.recurrence, {
      tz: zone,
      currentDate: Math.max(start - 1, after),
    });
    for (let next = interval.next().getTime(); next < end; next = interval.next().getTime()) {
      if (anchor.lastLocalRun !== null && localKey(wallClock(next, zone)) <= anchor.lastLocalRun) continue;
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

/**
 * A moment's local clock is the wall time its instant shows in the zone in
 * effect then, read when the anchor first sees it. Undefined while that zone
 * is unknown.
 */
function sight(
  session: Session,
  task: TaskRecord,
  timeline: Timeline,
  options: {
    readonly fixed: boolean;
    readonly createdAt: string;
    readonly armedByCron: boolean;
    readonly previous?: TimeAnchor;
  },
): TimeAnchor | undefined {
  if (task.processAfter === null) return undefined;
  const at = Date.parse(task.processAfter);
  const zone = zoneAt(timeline, at);
  if (zone === null) return undefined;
  return {
    sessionId: session.id,
    seriesId: seriesKey(task),
    originalAt: task.processAfter,
    originalZone: zone,
    createdAt: options.createdAt,
    wall: options.armedByCron ? null : wallClock(at, zone),
    recurrence: task.recurrence,
    fixed: options.fixed,
    rowId: task.id,
    appliedAt: task.processAfter,
    appliedZone: zone,
    timelineVersion: timeline.version,
    timelineChangedAt: iso(Date.now()),
    lastRun: options.previous?.lastRun ?? null,
    lastLocalRun: options.previous?.lastLocalRun ?? null,
    hostRetryRowId: null,
    notices: options.previous?.notices ?? [],
  };
}

/** Anchors a moment main has just set; the matters loop anchors every other task when it first sees it. */
export async function anchorTask(session: Session, task: TaskRecord, timeline: Timeline, fixed = false): Promise<void> {
  const anchor = sight(session, task, timeline, {
    fixed,
    createdAt: task.timestamp,
    armedByCron: task.recurrence !== null,
  });
  if (anchor) await save(anchor);
}

async function notify(anchor: TimeAnchor): Promise<TimeAnchor> {
  let current = anchor;
  for (const notice of anchor.notices) {
    const { id, oldAt, newAt, oldZone, newZone } = notice;
    const result = await writeNoteForMain({
      id,
      timestamp: iso(Date.now()),
      noteKind: 'clock-retimed',
      wake: false,
      text: `Local clock re-timed task ${anchor.seriesId}: ${formatLocalTime(oldAt, oldZone)} (${oldZone}) → ${formatLocalTime(newAt, newZone)} (${newZone}).`,
    });
    if (result !== 'written' && result !== 'already-written') break;
    current = { ...current, notices: current.notices.filter((entry) => entry.id !== id) };
    await save(current);
  }
  return current;
}

/** `report` is false for a time core's cron armed, which main never set or saw. */
async function apply(
  session: Session,
  task: TaskRecord,
  anchor: TimeAnchor,
  moment: AnchorMoment,
  report: boolean,
): Promise<TimeAnchor> {
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
      current.recurrence !== task.recurrence
    )
      return 0;
    return mailbox.updateTask(task.id, { processAfter: moment.at });
  });
  if (!touched || task.processAfter === null) return anchor;
  const retime: Retime = {
    id: `clock-${randomUUID()}`,
    oldAt: task.processAfter,
    newAt: moment.at,
    oldZone: anchor.appliedZone,
    newZone: moment.zone,
  };
  const moved = {
    ...anchor,
    appliedAt: moment.at,
    appliedZone: moment.zone,
    notices: report ? [...anchor.notices, retime] : anchor.notices,
  };
  await save(moved);
  return notify(moved);
}

/** A host retry keeps its cron and local anchor while this occurrence waits at the close. */
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

/**
 * Main's edit shows as the anchored row carrying a time the anchor did not
 * apply, or a changed recurrence; it is re-anchored, never reverted. A new row
 * in the series is core's re-arm. Undefined while the moment's zone is unknown.
 */
async function observeAnchor(
  session: Session,
  task: TaskRecord,
  timeline: Timeline,
  lastRun: string | null,
): Promise<TimeAnchor | undefined> {
  if (task.processAfter === null) return undefined;
  const held = await getTimeAnchor(session.id, seriesKey(task));
  let anchor =
    held ??
    sight(session, task, timeline, { fixed: false, createdAt: task.timestamp, armedByCron: task.recurrence !== null });
  if (!anchor) return undefined;
  if (anchor.timelineVersion !== timeline.version)
    anchor = { ...anchor, timelineVersion: timeline.version, timelineChangedAt: iso(Date.now()) };
  anchor = afterRun(anchor, lastRun);
  const sameRow = anchor.rowId === task.id;
  const retimedByMain = sameRow && anchor.hostRetryRowId !== task.id && task.processAfter !== anchor.appliedAt;
  if (retimedByMain || task.recurrence !== anchor.recurrence) {
    const edited = sight(session, task, timeline, {
      fixed: anchor.fixed,
      createdAt: iso(Date.now()),
      armedByCron: task.recurrence !== null && !retimedByMain,
      previous: anchor,
    });
    if (!edited) return undefined;
    anchor = edited;
  } else if (!sameRow) {
    anchor = { ...anchor, rowId: task.id, hostRetryRowId: null, wall: anchor.recurrence === null ? anchor.wall : null };
  }
  if (anchor !== held) await save(anchor);
  return anchor;
}

async function upkeep(session: Session, task: TaskRecord, timeline: Timeline, evidence: RunEvidence): Promise<void> {
  if (
    task.status !== 'pending' ||
    task.processAfter === null ||
    HOST_TIMED_SERIES.test(seriesKey(task)) ||
    evidence.claimed
  )
    return;
  const anchor = await observeAnchor(session, task, timeline, evidence.lastRun);
  if (!anchor || anchor.hostRetryRowId === task.id || Date.parse(task.processAfter) <= Date.now()) return;
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
  await apply(session, task, anchor, moment, anchor.appliedAt === task.processAfter);
}

/** Retries unsent notices, and forgets an anchor once its series has nothing left to run or report. */
async function settleAnchors(session: Session, records: readonly InboundRecord[]): Promise<void> {
  const live = new Set(
    records
      .filter(
        (row) =>
          row.kind === 'task' && (row.status === 'pending' || row.status === 'paused' || row.recurrence !== null),
      )
      .map((row) => row.seriesId ?? row.id),
  );
  const saved = await getDb().all<{ anchor: string }>(
    'SELECT anchor FROM gws_ea_time_anchors WHERE session_id=?',
    session.id,
  );
  for (const entry of saved) {
    const anchor = await notify(JSON.parse(entry.anchor) as TimeAnchor);
    if (anchor.notices.length === 0 && !live.has(anchor.seriesId))
      await getDb().run(
        'DELETE FROM gws_ea_time_anchors WHERE session_id=? AND series_id=?',
        session.id,
        anchor.seriesId,
      );
  }
}

/** The caller serializes this isolated loop step with matter slot writes. */
export async function anchorPendingTasks(timeline: Timeline): Promise<void> {
  for (const session of await mainConversations()) {
    const snapshot = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) => ({
      records: mailbox.getInboundRecords(),
      tasks: mailbox.listLiveTasks(),
      claimed: new Set(
        [...mailbox.getProcessingClaims(), ...mailbox.getTerminalProcessingAcks()].map((ack) => ack.messageId),
      ),
    }));
    if (!snapshot) continue;
    const runs = latestRuns(snapshot.records);
    for (const task of snapshot.tasks)
      await upkeep(session, task, timeline, {
        claimed: snapshot.claimed.has(task.id),
        lastRun: runs.get(seriesKey(task)) ?? null,
      });
    await settleAnchors(session, snapshot.records);
  }
}

/** Preview only: a whereabouts command never moves a task or wakes a model. */
export async function pendingLocalItems(span: ClockSpan): Promise<PendingClockItem[]> {
  const result: PendingClockItem[] = [];
  for (const session of await mainConversations()) {
    const tasks = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
      mailbox.listLiveTasks(),
    );
    for (const task of tasks ?? []) {
      if (task.status !== 'pending' || !task.processAfter || HOST_TIMED_SERIES.test(seriesKey(task))) continue;
      const at = Date.parse(task.processAfter);
      if (at < span.start || (span.end !== null && at >= span.end)) continue;
      const anchor = await getTimeAnchor(session.id, seriesKey(task));
      if (!anchor || anchor.fixed) continue;
      result.push({ task: seriesKey(task), at: task.processAfter, zone: anchor.appliedZone });
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
    if (HOST_TIMED_SERIES.test(seriesKey(task))) throw new Error('The host keeps the close and morning clock');
    const lastRun = await withExistingMailboxSession(
      session.agent_group_id,
      session.id,
      (mailbox) => latestRuns(mailbox.getInboundRecords()).get(seriesKey(task)) ?? null,
    );
    const observed = await observeAnchor(session, task, timeline, lastRun ?? null);
    if (!observed) throw new Error('The zone in effect at this task’s time is unknown; record the stay’s zone first');
    let anchor = { ...observed, fixed };
    await save(anchor);
    const moment = retimeAnchor(anchor, timeline, Date.now());
    if (moment && moment.at !== task.processAfter) anchor = await apply(session, task, anchor, moment, true);
    return { task: seriesKey(task), fixed, at: anchor.appliedAt };
  }
  throw new Error(`No pending task ${JSON.stringify(id)} in main's conversations`);
}
