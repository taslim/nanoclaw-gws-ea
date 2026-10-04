/**
 * Whether the inbox is working (KTD4, KTD12). Polling that keeps failing
 * makes it unhealthy: the principal hears one plain sentence, follow-through
 * deadlines read `getInboxHealth()` and pause, and status shows it. The first
 * good poll makes it healthy again.
 */
import { getDb } from '../../db/connection.js';
import { log } from '../../log.js';
import { getInboxState, updateInboxState } from './db.js';
import { noticeUnhealthy } from './notices.js';

/** Consecutive failed polls, a minute apart, before the inbox counts as unhealthy. */
export const UNHEALTHY_AFTER_FAILURES = 3;

export interface InboxHealth {
  readonly state: 'healthy' | 'unhealthy';
  /** Why it is unhealthy; null while healthy. */
  readonly reason: string | null;
  readonly since: string | null;
  readonly lastSuccessAt: string | null;
  readonly consecutiveFailures: number;
  /** Turning on calendar notifications for the principal's calendars. */
  readonly calendarNotifications: { readonly state: 'unknown' | 'ok' | 'failing'; readonly reason: string | null };
}

/** The inbox's health, for follow-through deadlines and status. */
export async function getInboxHealth(): Promise<InboxHealth> {
  const state = await getInboxState();
  return {
    state: state.health,
    reason: state.health_reason,
    since: state.health_since,
    lastSuccessAt: state.last_success_at,
    consecutiveFailures: state.consecutive_failures,
    calendarNotifications: { state: state.calendar_sync, reason: state.calendar_sync_reason },
  };
}

export async function recordPollSuccess(at: string): Promise<void> {
  const state = await getInboxState();
  if (state.health === 'unhealthy') log.info('The inbox is reachable again');
  await getDb().run(
    `UPDATE gws_ea_inbox_state
        SET health = 'healthy', health_reason = NULL, health_since = NULL, consecutive_failures = 0,
            unhealthy_notified_at = NULL, last_success_at = ?
      WHERE singleton = 1`,
    at,
  );
}

export async function recordPollFailure(reason: string, at: string): Promise<void> {
  const state = await getInboxState();
  const failures = state.consecutive_failures + 1;
  const unhealthy = state.health === 'unhealthy' || failures >= UNHEALTHY_AFTER_FAILURES;
  await updateInboxState({
    consecutive_failures: failures,
    ...(unhealthy ? { health: 'unhealthy', health_reason: reason, health_since: state.health_since ?? at } : {}),
  });
  if (!unhealthy || state.unhealthy_notified_at !== null) return;
  log.error('The inbox is unhealthy; telling the principal once', { reason, failures });
  // Recorded before the send: a notice that fails is never repeated into a stream.
  await updateInboxState({ unhealthy_notified_at: at });
  await noticeUnhealthy();
}

export async function recordCalendarSync(state: 'ok' | 'failing', reason: string | null): Promise<void> {
  await getDb().run(
    'UPDATE gws_ea_inbox_state SET calendar_sync = ?, calendar_sync_reason = ? WHERE singleton = 1',
    state,
    reason,
  );
}
