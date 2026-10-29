import { getDb } from '../../../db/connection.js';
import type { Span } from '../slots.js';

export interface BookingWriteWindow {
  readonly sessionId: string;
  readonly requestId: string;
  readonly calendarId: string;
  readonly eventId: string;
  readonly previous: Span;
  readonly current: Span;
}
interface Row {
  readonly session_id: string;
  readonly request_id: string;
  readonly calendar_id: string;
  readonly event_id: string;
  readonly previous_start: string;
  readonly previous_end: string;
  readonly current_start: string;
  readonly current_end: string;
}

/** Recorded with the applied booking receipt, before its request payload can be removed. */
export async function recordBookingWriteWindow(write: BookingWriteWindow): Promise<void> {
  await getDb().run(
    `INSERT INTO gws_ea_booking_write_windows
      (session_id,request_id,calendar_id,event_id,previous_start,previous_end,current_start,current_end)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(session_id,request_id) DO NOTHING`,
    write.sessionId,
    write.requestId,
    write.calendarId,
    write.eventId,
    new Date(write.previous.start).toISOString(),
    new Date(write.previous.end).toISOString(),
    new Date(write.current.start).toISOString(),
    new Date(write.current.end).toISOString(),
  );
}

export async function pendingBookingWriteWindows(): Promise<BookingWriteWindow[]> {
  return (
    await getDb().all<Row>(
      'SELECT * FROM gws_ea_booking_write_windows WHERE refreshed=0 ORDER BY session_id,request_id',
    )
  ).map((row) => ({
    sessionId: row.session_id,
    requestId: row.request_id,
    calendarId: row.calendar_id,
    eventId: row.event_id,
    previous: { start: Date.parse(row.previous_start), end: Date.parse(row.previous_end) },
    current: { start: Date.parse(row.current_start), end: Date.parse(row.current_end) },
  }));
}

/** Only the snapshot successfully published by this refresh may be acknowledged. */
export async function completeBookingWriteWindows(writes: readonly BookingWriteWindow[]): Promise<void> {
  if (!writes.length) return;
  await getDb().transaction(async () => {
    for (const write of writes)
      await getDb().run(
        'UPDATE gws_ea_booking_write_windows SET refreshed=1 WHERE session_id=? AND request_id=?',
        write.sessionId,
        write.requestId,
      );
  });
}
