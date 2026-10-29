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
}
export interface CalendarWrite extends CalendarWriteInput {
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
    state: row.state,
    outcome: row.outcome,
    findingsChecked: row.findings_checked === 1,
  };
}
export async function getCalendarWrite(requestId: string): Promise<CalendarWrite | undefined> {
  const row = await getDb().get<Row>('SELECT * FROM gws_ea_calendar_write_log WHERE request_id = ?', requestId);
  return row ? parsed(row) : undefined;
}
export async function beginCalendarWrite(input: CalendarWriteInput): Promise<CalendarWrite> {
  const fingerprint = digest([input.action, input.calendarId, input.eventId, input.request]);
  await getDb().run(
    `INSERT INTO gws_ea_calendar_write_log
    (request_id,calendar_id,event_id,action,fingerprint,request_json,before_json,plan_json,affected_start,affected_end,state,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,'pending',?) ON CONFLICT(request_id) DO NOTHING`,
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
    new Date().toISOString(),
  );
  const row = await getDb().get<Row>('SELECT * FROM gws_ea_calendar_write_log WHERE request_id = ?', input.requestId);
  if (!row) throw new Error('Calendar write receipt was not recorded');
  if (row.fingerprint !== fingerprint) throw invalidArgs('This calendar request id already names a different change.');
  return parsed(row);
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
