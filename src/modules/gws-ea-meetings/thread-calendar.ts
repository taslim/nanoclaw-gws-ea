/**
 * What each email thread placed on the principal's calendar (KTD7): its
 * bookings, which it alone may change or cancel; and the calendar `main` set
 * for its bookings, without which it books nothing. The tables are described
 * in gws-ea-inbox/migration.ts.
 *
 * Every timestamp is passed in as an ISO string; SQL never reads the clock.
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

/** The thread's booking of that event, or undefined when the thread booked no such event. */
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

/** Record an event the thread booked; recording it again changes nothing. */
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

/** Forget a booking once its event is cancelled or gone. */
export async function deleteThreadBooking(calendarId: string, eventId: string): Promise<void> {
  await getDb().run('DELETE FROM gws_ea_thread_bookings WHERE calendar_id = ? AND event_id = ?', calendarId, eventId);
}

/** The calendar `main` set for the thread's bookings, or null while it has set none. */
export async function getThreadBookingCalendar(threadKey: string): Promise<string | null> {
  const row = await getDb().get<{ booking_calendar_id: string | null }>(
    'SELECT booking_calendar_id FROM gws_ea_threads WHERE thread_key = ?',
    threadKey,
  );
  return row?.booking_calendar_id ?? null;
}

/** Set the calendar the thread's bookings go on. */
export async function setThreadBookingCalendar(threadKey: string, calendarId: string): Promise<void> {
  await getDb().run('UPDATE gws_ea_threads SET booking_calendar_id = ? WHERE thread_key = ?', calendarId, threadKey);
}
