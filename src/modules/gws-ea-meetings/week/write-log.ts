import { getDb } from '../../../db/connection.js';
import { invalidArgs } from '../../../cli/delivery-action.js';
import { registerPersonForgetHook } from '../../gws-ea-people/db.js';
import type { DetailedEvent, EventWrite, NewEvent } from '../calendar-api.js';
import { digest } from './model.js';

export interface CalendarSplitPlan {
  readonly masterId: string;
  readonly master: DetailedEvent;
  readonly trim: readonly string[];
  readonly deleteMaster: boolean;
  readonly followingId: string;
  readonly following: NewEvent | null;
}
export interface CalendarWriteInput {
  readonly requestId: string;
  readonly calendarId: string;
  readonly eventId: string;
  readonly action: 'create_event' | 'change_event' | 'cancel_event' | 'change_guests' | 'respond_to_event';
  readonly request: Readonly<Record<string, unknown>>;
  readonly before: DetailedEvent | null;
  readonly plan?: { readonly patch: EventWrite; readonly split?: CalendarSplitPlan };
  readonly affectedStart: string;
  readonly affectedEnd: string;
  readonly refreshScope?: 'event' | 'series';
}
export interface CalendarWrite extends CalendarWriteInput {
  readonly refreshScope: 'event' | 'series';
  readonly state: 'pending' | 'applied';
  readonly outcome: string | null;
  readonly findingsChecked: boolean;
}
interface Row {
  request_id: string;
  calendar_id: string;
  event_id: string;
  action: CalendarWriteInput['action'];
  fingerprint: string;
  request_json: string;
  plan_json: string | null;
  before_json: string | null;
  affected_start: string;
  affected_end: string;
  state: CalendarWrite['state'];
  outcome: string | null;
  findings_checked: number;
  refresh_scope: CalendarWrite['refreshScope'];
}
function parsed(row: Row): CalendarWrite {
  return {
    requestId: row.request_id,
    calendarId: row.calendar_id,
    eventId: row.event_id,
    action: row.action,
    request: JSON.parse(row.request_json) as Record<string, unknown>,
    ...(row.plan_json ? { plan: JSON.parse(row.plan_json) as NonNullable<CalendarWriteInput['plan']> } : {}),
    before: row.before_json === null ? null : (JSON.parse(row.before_json) as DetailedEvent),
    affectedStart: row.affected_start,
    affectedEnd: row.affected_end,
    refreshScope: row.refresh_scope,
    state: row.state,
    outcome: row.outcome,
    findingsChecked: row.findings_checked === 1,
  };
}
export async function getCalendarWrite(requestId: string): Promise<CalendarWrite | undefined> {
  const row = await getDb().get<Row>('SELECT * FROM gws_ea_calendar_write_log WHERE request_id = ?', requestId);
  return row ? parsed(row) : undefined;
}
export async function beginCalendarWrite(
  input: CalendarWriteInput,
  splitSessionId?: string,
  splitStartedAt?: string,
): Promise<CalendarWrite> {
  return getDb().transaction(async () => {
    const fingerprint = digest([input.action, input.calendarId, input.eventId, input.request]);
    await getDb().run(
      `INSERT INTO gws_ea_calendar_write_log
    (request_id,calendar_id,event_id,action,fingerprint,request_json,before_json,plan_json,affected_start,affected_end,refresh_scope,state,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,'pending',?) ON CONFLICT(request_id) DO NOTHING`,
      input.requestId,
      input.calendarId,
      input.eventId,
      input.action,
      fingerprint,
      JSON.stringify(input.request),
      input.before === null ? null : JSON.stringify(input.before),
      input.plan ? JSON.stringify(input.plan) : null,
      input.affectedStart,
      input.affectedEnd,
      input.refreshScope ?? 'event',
      new Date().toISOString(),
    );
    const row = await getDb().get<Row>('SELECT * FROM gws_ea_calendar_write_log WHERE request_id = ?', input.requestId);
    if (!row) throw new Error('Calendar write receipt was not recorded');
    if (row.fingerprint !== fingerprint)
      throw invalidArgs('This calendar request id already names a different change.');
    if (input.plan?.split && splitSessionId) {
      const at = new Date().toISOString();
      await getDb().run(
        `INSERT INTO gws_ea_calendar_split_recovery(request_id,session_id,created_at,next_attempt_at)
       VALUES(?,?,?,?) ON CONFLICT(request_id) DO NOTHING`,
        input.requestId,
        splitSessionId,
        splitStartedAt ?? at,
        at,
      );
      const recovery = await getCalendarSplitRecovery(input.requestId);
      if (recovery?.sessionId !== splitSessionId)
        throw invalidArgs('This recurring-series request belongs to a different session.');
    }
    return parsed(row);
  });
}

export interface CalendarSplitRecovery {
  readonly requestId: string;
  readonly sessionId: string;
  readonly createdAt: string;
  readonly nextAttemptAt: string;
  readonly attempts: number;
  readonly masterChanged: boolean;
  readonly terminalError: string | null;
  readonly reported: boolean;
}
interface SplitRecoveryRow {
  request_id: string;
  session_id: string;
  created_at: string;
  next_attempt_at: string;
  attempts: number;
  master_changed: number;
  terminal_error: string | null;
  reported: number;
}
function recoveryOf(row: SplitRecoveryRow): CalendarSplitRecovery {
  return {
    requestId: row.request_id,
    sessionId: row.session_id,
    createdAt: row.created_at,
    nextAttemptAt: row.next_attempt_at,
    attempts: row.attempts,
    masterChanged: row.master_changed === 1,
    terminalError: row.terminal_error,
    reported: row.reported === 1,
  };
}
export async function getCalendarSplitRecovery(requestId: string): Promise<CalendarSplitRecovery | undefined> {
  const row = await getDb().get<SplitRecoveryRow>(
    'SELECT * FROM gws_ea_calendar_split_recovery WHERE request_id=?',
    requestId,
  );
  return row ? recoveryOf(row) : undefined;
}
export async function pendingCalendarSplitRecoveries(at = new Date()): Promise<CalendarSplitRecovery[]> {
  return (
    await getDb().all<SplitRecoveryRow>(
      `SELECT recovery.* FROM gws_ea_calendar_split_recovery recovery
       JOIN gws_ea_calendar_write_log receipt ON receipt.request_id=recovery.request_id
       WHERE recovery.reported=0 AND recovery.next_attempt_at<=?
       ORDER BY CASE WHEN receipt.state='pending' THEN 0 ELSE 1 END,recovery.next_attempt_at,recovery.request_id LIMIT 20`,
      at.toISOString(),
    )
  ).map(recoveryOf);
}
export async function markCalendarSplitMasterChanged(requestId: string): Promise<void> {
  await getDb().run('UPDATE gws_ea_calendar_split_recovery SET master_changed=1 WHERE request_id=?', requestId);
}
export async function deferCalendarSplitRecovery(requestId: string, attempts: number): Promise<void> {
  const retryAt = new Date(Date.now() + Math.min(60_000, 1_000 * 2 ** (attempts - 1))).toISOString();
  await getDb().run(
    'UPDATE gws_ea_calendar_split_recovery SET attempts=?,next_attempt_at=? WHERE request_id=?',
    attempts,
    retryAt,
    requestId,
  );
}
export async function deferCalendarSplitReport(requestId: string): Promise<void> {
  await getDb().run(
    'UPDATE gws_ea_calendar_split_recovery SET next_attempt_at=? WHERE request_id=?',
    new Date(Date.now() + 60_000).toISOString(),
    requestId,
  );
}
export async function failCalendarSplitRecovery(requestId: string, message: string, attempts?: number): Promise<void> {
  await getDb().transaction(async () => {
    await getDb().run(
      'UPDATE gws_ea_calendar_split_recovery SET terminal_error=?,next_attempt_at=?,attempts=COALESCE(?,attempts) WHERE request_id=?',
      message,
      new Date().toISOString(),
      attempts ?? null,
      requestId,
    );
    await markCalendarWriteApplied(requestId, message);
  });
}
export async function markCalendarSplitReported(requestId: string): Promise<void> {
  await getDb().run('UPDATE gws_ea_calendar_split_recovery SET reported=1 WHERE request_id=?', requestId);
}
export async function markCalendarWriteApplied(requestId: string, outcome: string): Promise<void> {
  await getDb().run(
    "UPDATE gws_ea_calendar_write_log SET state='applied',outcome=?,updated_at=? WHERE request_id=?",
    outcome,
    new Date().toISOString(),
    requestId,
  );
}
export async function completeCalendarWriteFindings(requestId: string): Promise<void> {
  await getDb().run(
    'UPDATE gws_ea_calendar_write_log SET findings_checked=1,updated_at=? WHERE request_id=?',
    new Date().toISOString(),
    requestId,
  );
}
export async function listCalendarWriteGaps(): Promise<CalendarWrite[]> {
  return (
    await getDb().all<Row>(
      "SELECT * FROM gws_ea_calendar_write_log WHERE state='applied' AND findings_checked=0 ORDER BY updated_at,request_id",
    )
  ).map(parsed);
}
registerPersonForgetHook('gws-ea-meetings:calendar-write-log', async ({ id, handles }) => {
  const db = getDb();
  if (!(await db.hasTable('gws_ea_calendar_write_log'))) return;
  const tokens = [id, ...handles, ...handles.filter((h) => h.startsWith('email:')).map((h) => h.slice(6))].map((h) =>
    h.toLowerCase(),
  );
  for (const row of await db.all<Row>('SELECT * FROM gws_ea_calendar_write_log')) {
    const text =
      `${row.request_json}\n${row.before_json ?? ''}\n${row.plan_json ?? ''}\n${row.outcome ?? ''}`.toLowerCase();
    if (tokens.some((token) => text.includes(token)))
      await db.run(
        "UPDATE gws_ea_calendar_write_log SET request_json='{}',before_json=NULL,plan_json=NULL,outcome=?,state='applied',findings_checked=1 WHERE request_id=?",
        'This request involved a forgotten person; its event was not changed again.',
        row.request_id,
      );
  }
});

export async function calendarWriteVersion(): Promise<string> {
  return digest(
    await getDb().all<{ request_id: string; calendar_id: string; event_id: string }>(
      "SELECT request_id,calendar_id,event_id FROM gws_ea_calendar_write_log WHERE state='applied' ORDER BY request_id",
    ),
  );
}

export async function appliedCalendarWrites(): Promise<CalendarWrite[]> {
  return (
    await getDb().all<Row>(
      "SELECT * FROM gws_ea_calendar_write_log WHERE state='applied' ORDER BY updated_at,request_id",
    )
  ).map(parsed);
}
