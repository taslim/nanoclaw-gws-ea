import { getDb } from '../../../db/connection.js';
import { registerPersonForgetHook } from '../../gws-ea-people/db.js';
import type { CalendarNotice } from '../../gws-ea-inbox/calendar-notifications.js';

export const CALENDAR_SETTLE_MS = 60_000;
export interface PendingCalendarChange {
  readonly notice: CalendarNotice;
  readonly messageIds: readonly string[];
  readonly lastReceivedAt: string;
}
interface Row {
  message_id: string;
  calendar_id: string;
  event_id: string;
  change_kind: CalendarNotice['change'];
  received_at: string;
}
/** Mail settles only after this durable, idempotent insert succeeds. */
export async function recordPendingCalendarChange(messageId: string, notice: CalendarNotice, at: Date): Promise<void> {
  await getDb().run(
    `INSERT INTO gws_ea_pending_calendar_changes (message_id,calendar_id,event_id,change_kind,received_at) VALUES (?,?,?,?,?) ON CONFLICT(message_id) DO NOTHING`,
    messageId,
    notice.calendarId,
    notice.eventId,
    notice.change,
    at.toISOString(),
  );
}
export async function hasPendingCalendarChanges(): Promise<boolean> {
  return (await getDb().get<{ n: number }>('SELECT COUNT(*) AS n FROM gws_ea_pending_calendar_changes'))?.n !== 0;
}
export async function settledCalendarChanges(at: Date): Promise<PendingCalendarChange[]> {
  const groups = new Map<string, Row[]>();
  for (const row of await getDb().all<Row>(
    'SELECT * FROM gws_ea_pending_calendar_changes ORDER BY received_at,message_id',
  )) {
    const key = `${row.calendar_id}/${row.event_id}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.values()].flatMap((rows) => {
    const last = rows[rows.length - 1];
    if (Date.parse(last.received_at) + CALENDAR_SETTLE_MS > at.getTime()) return [];
    return [
      {
        notice: {
          calendarId: last.calendar_id,
          eventId: last.event_id,
          change: rows.some((r) => r.change_kind === 'created') ? ('created' as const) : last.change_kind,
        },
        messageIds: rows.map((r) => r.message_id),
        lastReceivedAt: last.received_at,
      },
    ];
  });
}
/** Delete only this snapshot's Gmail ids; a change arriving during rendering stays pending. */
export async function settleCalendarChanges(changes: readonly PendingCalendarChange[]): Promise<void> {
  await getDb().transaction(async () => {
    for (const change of changes)
      for (const id of change.messageIds)
        await getDb().run('DELETE FROM gws_ea_pending_calendar_changes WHERE message_id=?', id);
  });
}
registerPersonForgetHook('gws-ea-meetings:pending-calendar-changes', async ({ id, handles }) => {
  const db = getDb();
  if (!(await db.hasTable('gws_ea_pending_calendar_changes'))) return;
  const tokens = [id, ...handles, ...handles.filter((h) => h.startsWith('email:')).map((h) => h.slice(6))].map((h) =>
    h.toLowerCase(),
  );
  for (const row of await db.all<Row>('SELECT * FROM gws_ea_pending_calendar_changes'))
    if (tokens.some((token) => `${row.calendar_id}/${row.event_id}`.toLowerCase().includes(token)))
      await db.run('DELETE FROM gws_ea_pending_calendar_changes WHERE message_id=?', row.message_id);
});
