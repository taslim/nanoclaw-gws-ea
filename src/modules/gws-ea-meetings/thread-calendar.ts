import { getDb } from '../../db/connection.js';

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
