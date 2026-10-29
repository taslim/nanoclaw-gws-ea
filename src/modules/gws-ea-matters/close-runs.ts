import { getDb } from '../../db/connection.js';
import type { ModuleMigration } from '../../db/migrations/index.js';

export const closeRunsMigration: ModuleMigration = {
  version: 1,
  name: 'module:gws-ea-close:completion-evidence',
  async up(db) {
    await db.exec(`CREATE TABLE gws_ea_close_runs (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, task_id TEXT NOT NULL UNIQUE, started_at TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('open','completed','failed')),
      ledger_from_at TEXT, ledger_through_at TEXT, ledger_writes_json TEXT,
      done_at TEXT, failed_at TEXT,
      CHECK ((state = 'completed') = (done_at IS NOT NULL)),
      CHECK ((state = 'failed') = (failed_at IS NOT NULL)),
      CHECK (state <> 'completed' OR ledger_through_at IS NOT NULL)
    ); CREATE UNIQUE INDEX gws_ea_close_one_open ON gws_ea_close_runs (session_id) WHERE state='open';`);
  },
};
export interface CloseRun {
  readonly id: string;
  readonly session_id: string;
  readonly task_id: string;
  readonly started_at: string;
  readonly state: 'open' | 'completed' | 'failed';
  readonly ledger_from_at: string | null;
  readonly ledger_through_at: string | null;
  readonly ledger_writes_json: string | null;
  readonly done_at: string | null;
  readonly failed_at: string | null;
}
export interface ConsumedCalendarWrite {
  readonly requestId: string;
  readonly updatedAt: string;
}
export interface CloseLedgerCoverage {
  readonly from: string | null;
  readonly through: string;
  readonly writes: readonly ConsumedCalendarWrite[];
}
function instant(value: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new Error('Close evidence needs a valid instant.');
  return new Date(value).toISOString();
}
export async function beginCloseRun(input: {
  readonly id: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly startedAt?: string;
}): Promise<CloseRun> {
  await getDb().run(
    "INSERT INTO gws_ea_close_runs (id,session_id,task_id,started_at,state) VALUES (?,?,?,?,'open') ON CONFLICT(id) DO NOTHING",
    input.id,
    input.sessionId,
    input.taskId,
    instant(input.startedAt ?? new Date().toISOString()),
  );
  const row = await getDb().get<CloseRun>('SELECT * FROM gws_ea_close_runs WHERE id=?', input.id);
  if (!row || row.session_id !== input.sessionId || row.task_id !== input.taskId)
    throw new Error('The close run belongs to another session or task.');
  return row;
}
export async function getOpenCloseRun(sessionId: string): Promise<CloseRun | undefined> {
  return getDb().get<CloseRun>("SELECT * FROM gws_ea_close_runs WHERE session_id=? AND state='open'", sessionId);
}
export async function listOpenCloseRuns(): Promise<CloseRun[]> {
  return getDb().all<CloseRun>("SELECT * FROM gws_ea_close_runs WHERE state='open' ORDER BY started_at,id");
}
export async function lastCompletedClose(): Promise<CloseRun | undefined> {
  return getDb().get<CloseRun>(
    "SELECT * FROM gws_ea_close_runs WHERE state='completed' ORDER BY ledger_through_at DESC,done_at DESC,id DESC LIMIT 1",
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
    "UPDATE gws_ea_close_runs SET ledger_from_at=?,ledger_through_at=?,ledger_writes_json=? WHERE id=? AND session_id=? AND state='open'",
    from,
    through,
    JSON.stringify(coverage.writes),
    runId,
    sessionId,
  );
  if (!result.changes) throw new Error('Only the open close run in this session may capture its ledger.');
}
export async function completeCloseRun(
  runId: string,
  sessionId: string,
  doneAt = new Date().toISOString(),
): Promise<CloseRun> {
  return getDb().transaction(async () => {
    const run = await getOpenCloseRun(sessionId);
    if (!run || run.id !== runId) throw new Error('Only the open close run in this session may be marked done.');
    if (run.ledger_through_at === null || run.ledger_writes_json === null)
      throw new Error('Read the day ledger before marking this close done.');
    const writes = JSON.parse(run.ledger_writes_json) as ConsumedCalendarWrite[];
    const done = instant(doneAt);
    await getDb().run(
      "UPDATE gws_ea_close_runs SET state='completed',done_at=? WHERE id=? AND state='open'",
      done,
      runId,
    );
    for (const write of writes)
      await getDb().run(
        "DELETE FROM gws_ea_calendar_write_log WHERE request_id=? AND updated_at=? AND state='applied'",
        write.requestId,
        write.updatedAt,
      );
    return { ...run, state: 'completed', done_at: done };
  });
}
export async function failCloseRun(runId: string, failedAt = new Date().toISOString()): Promise<void> {
  await getDb().run(
    "UPDATE gws_ea_close_runs SET state='failed',failed_at=? WHERE id=? AND state='open'",
    instant(failedAt),
    runId,
  );
}
