import { getDb } from '../../db/connection.js';
import type { ModuleMigration } from '../../db/migrations/index.js';
import { updateSession } from '../../db/sessions.js';

/**
 * One row per evening close, in a session of its own: pending until its
 * verdict opens it, open until main marks it done or it fails. A completed
 * close's ledger coverage is where the next day ledger starts.
 */
export const closeRunsMigration: ModuleMigration = {
  version: 1,
  name: 'module:gws-ea-close:completion-evidence',
  async up(db) {
    await db.exec(`CREATE TABLE gws_ea_close_runs (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, scheduled_at TEXT NOT NULL,
      zone TEXT NOT NULL, timeline_version TEXT NOT NULL, weekly_day TEXT,
      state TEXT NOT NULL CHECK (state IN ('pending','open','completed','failed')),
      started_at TEXT,
      ledger_from_at TEXT, ledger_through_at TEXT, ledger_writes_json TEXT, ledger_inbound_json TEXT,
      CHECK (state <> 'completed' OR ledger_through_at IS NOT NULL)
    )`);
  },
};
export interface CloseRun {
  readonly id: string;
  readonly session_id: string;
  readonly scheduled_at: string;
  readonly zone: string;
  readonly timeline_version: string;
  readonly weekly_day: string | null;
  readonly state: 'pending' | 'open' | 'completed' | 'failed';
  readonly started_at: string | null;
  readonly ledger_from_at: string | null;
  readonly ledger_through_at: string | null;
  readonly ledger_writes_json: string | null;
  readonly ledger_inbound_json: string | null;
}
export interface ConsumedCalendarWrite {
  readonly requestId: string;
  readonly updatedAt: string;
}
export interface CloseLedgerCoverage {
  readonly from: string | null;
  readonly through: string;
  readonly writes: readonly ConsumedCalendarWrite[];
  /** Each main session's highest inbound `seq` the ledger read. */
  readonly inbound: Readonly<Record<string, number>>;
}
function instant(value: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new Error('Close evidence needs a valid instant.');
  return new Date(value).toISOString();
}
export async function getCloseRun(id: string, sessionId: string): Promise<CloseRun | undefined> {
  return getDb().get<CloseRun>('SELECT * FROM gws_ea_close_runs WHERE id=? AND session_id=?', id, sessionId);
}
/** A pending close opens once; opening it again leaves its start as it was. */
export async function beginCloseRun(id: string, sessionId: string): Promise<CloseRun> {
  await getDb().run(
    "UPDATE gws_ea_close_runs SET state='open',started_at=? WHERE id=? AND session_id=? AND state='pending'",
    new Date().toISOString(),
    id,
    sessionId,
  );
  const run = await getCloseRun(id, sessionId);
  if (!run) throw new Error('This session has no evening close.');
  return run;
}
export async function getOpenCloseRun(sessionId: string): Promise<CloseRun | undefined> {
  return getDb().get<CloseRun>("SELECT * FROM gws_ea_close_runs WHERE session_id=? AND state='open'", sessionId);
}
export async function lastCompletedClose(): Promise<CloseRun | undefined> {
  return getDb().get<CloseRun>(
    "SELECT * FROM gws_ea_close_runs WHERE state='completed' ORDER BY ledger_through_at DESC,id DESC LIMIT 1",
  );
}
export async function recordCloseLedger(
  runId: string,
  sessionId: string,
  coverage: CloseLedgerCoverage,
): Promise<void> {
  const through = instant(coverage.through);
  const from = coverage.from === null ? null : instant(coverage.from);
  if (from !== null && from > through) throw new Error('The ledger cutoff precedes its window.');
  const result = await getDb().run(
    "UPDATE gws_ea_close_runs SET ledger_from_at=?,ledger_through_at=?,ledger_writes_json=?,ledger_inbound_json=? WHERE id=? AND session_id=? AND state='open'",
    from,
    through,
    JSON.stringify(coverage.writes),
    JSON.stringify(coverage.inbound),
    runId,
    sessionId,
  );
  if (!result.changes) throw new Error('Only the open close run in this session may capture its ledger.');
}
/** A finished close's session closes with it, so nothing it still holds is delivered. */
export async function completeCloseRun(runId: string, sessionId: string): Promise<CloseRun> {
  return getDb().transaction(async () => {
    const run = await getOpenCloseRun(sessionId);
    if (!run || run.id !== runId) throw new Error('Only the open close run in this session may be marked done.');
    if (run.ledger_through_at === null || run.ledger_writes_json === null)
      throw new Error('Read the day ledger before marking this close done.');
    const writes = JSON.parse(run.ledger_writes_json) as ConsumedCalendarWrite[];
    await getDb().run("UPDATE gws_ea_close_runs SET state='completed' WHERE id=? AND state='open'", runId);
    await updateSession(sessionId, { status: 'closed' });
    for (const write of writes)
      await getDb().run(
        "DELETE FROM gws_ea_calendar_write_log WHERE request_id=? AND updated_at=? AND state='applied'",
        write.requestId,
        write.updatedAt,
      );
    return { ...run, state: 'completed' };
  });
}
/**
 * `startedAt` is when a close that never opened counts as having run: one
 * claimed and lost still spaces the next close twelve hours on, while one
 * replaced before it ran does not.
 */
export async function failCloseRun(runId: string, startedAt: string | null = null): Promise<void> {
  await getDb().transaction(async () => {
    const run = await getDb().get<CloseRun>(
      "SELECT * FROM gws_ea_close_runs WHERE id=? AND state IN ('pending','open')",
      runId,
    );
    if (!run) return;
    await getDb().run(
      "UPDATE gws_ea_close_runs SET state='failed',started_at=COALESCE(started_at,?) WHERE id=?",
      startedAt,
      runId,
    );
    await updateSession(run.session_id, { status: 'closed' });
  });
}
