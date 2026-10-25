/**
 * What each email thread placed on the principal's calendar: its bookings,
 * which it alone may change or cancel; and the calendar `main` set for its
 * bookings, without which it books nothing. The tables are described in
 * gws-ea-inbox/migration.ts.
 */
import { getDb } from '../../db/connection.js';

export interface ThreadBooking {
  readonly threadKey: string;
  readonly calendarId: string;
  readonly eventId: string;
  readonly bookedAt: string;
}

interface BookingRow {
  thread_key: string;
  calendar_id: string;
  event_id: string;
  booked_at: string;
}

export async function getThreadBooking(threadKey: string, eventId: string): Promise<ThreadBooking | undefined> {
  const row = await getDb().get<BookingRow>(
    'SELECT thread_key, calendar_id, event_id, booked_at FROM gws_ea_thread_bookings WHERE thread_key = ? AND event_id = ?',
    threadKey,
    eventId,
  );
  return row
    ? { threadKey: row.thread_key, calendarId: row.calendar_id, eventId: row.event_id, bookedAt: row.booked_at }
    : undefined;
}

/** The calendar id matches in any case. */
export async function bookingThread(calendarId: string, eventId: string): Promise<string | undefined> {
  const row = await getDb().get<{ thread_key: string }>(
    'SELECT thread_key FROM gws_ea_thread_bookings WHERE lower(calendar_id) = ? AND event_id = ?',
    calendarId.toLowerCase(),
    eventId,
  );
  return row?.thread_key;
}

export async function recordThreadBooking(booking: ThreadBooking): Promise<void> {
  await getDb().run(
    `INSERT INTO gws_ea_thread_bookings (thread_key, calendar_id, event_id, booked_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (calendar_id, event_id) DO NOTHING`,
    booking.threadKey,
    booking.calendarId,
    booking.eventId,
    booking.bookedAt,
  );
}

export async function deleteThreadBooking(calendarId: string, eventId: string): Promise<void> {
  await getDb().run('DELETE FROM gws_ea_thread_bookings WHERE calendar_id = ? AND event_id = ?', calendarId, eventId);
}

/** Null until `main` sets one. */
export async function getThreadBookingCalendar(threadKey: string): Promise<string | null> {
  const row = await getDb().get<{ booking_calendar_id: string | null }>(
    'SELECT booking_calendar_id FROM gws_ea_threads WHERE thread_key = ?',
    threadKey,
  );
  return row?.booking_calendar_id ?? null;
}

export async function setThreadBookingCalendar(threadKey: string, calendarId: string): Promise<void> {
  await getDb().run('UPDATE gws_ea_threads SET booking_calendar_id = ? WHERE thread_key = ?', calendarId, threadKey);
}
