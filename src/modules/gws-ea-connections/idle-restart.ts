/**
 * A change to main's apps reaches each of main's sessions on its own, the first time that session has no running
 * turn: its container is stopped and comes back on the new configuration. A busy session never holds an idle one
 * on the old apps.
 */
import { getContainerConfigReadAtMs, isContainerRunning, killContainer } from '../../container-runner.js';
import { setStopIntent, shadowWrite } from '../../db/coordination.js';
import { getDb } from '../../db/connection.js';
import { getSession, getSessionsByAgentGroup } from '../../db/sessions.js';
import { log } from '../../log.js';
import { requestWake } from '../../request-wake.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { getMainAgentGroupId } from '../gws-ea-profile/db.js';
import { ConnectionsStoreError, type ConnectionsStore } from './store.js';

export const RESTART_CHECK_INTERVAL_MS = 5_000;
const RESTART_REASON = 'connections-changed';

/** Sessions whose container this module has stopped and that have not exited yet. */
const stopping = new Set<string>();

interface MailboxState {
  readonly turnRunning: boolean;
  readonly due: boolean;
}

/** A session with no mailbox has never run a turn. */
async function mailboxState(session: Session): Promise<MailboxState> {
  return (
    (await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) => ({
      turnRunning: mailbox.getProcessingClaims().length > 0,
      due: mailbox.countDueMessages() > 0,
    }))) ?? { turnRunning: false, due: false }
  );
}

/**
 * Only a container this host spawned carries the time it read its configuration; an adopted one may hold anything
 * a previous host gave it, so it counts as older than any change.
 */
function readBefore(sessionId: string, appliedAtMs: number): boolean {
  const readAt = getContainerConfigReadAtMs(sessionId);
  return readAt === undefined || readAt <= appliedAtMs;
}

/** Core's restart path: due messages bring the new container straight back, otherwise the next message does. */
async function restart(session: Session, due: boolean): Promise<boolean> {
  const intent = (value: 'respawn_after_stop' | null): Promise<void> =>
    shadowWrite(value ? 'stop-intent' : 'stop-intent-clear', () =>
      setStopIntent(session.id, value, new Date().toISOString()),
    );
  if (due) await intent('respawn_after_stop');
  // Checked in the same tick as the kill: a container that already exited would never call back.
  if (!isContainerRunning(session.id)) {
    if (due) await intent(null);
    return false;
  }
  stopping.add(session.id);
  killContainer(session.id, RESTART_REASON, () => {
    stopping.delete(session.id);
    if (!due) return;
    void (async () => {
      const current = await getSession(session.id);
      if (current) await requestWake(current, 'container-restart');
      await intent(null);
    })().catch((err: unknown) => {
      log.error('Main container did not come back after a connections change', { sessionId: session.id, err });
    });
  });
  return true;
}

/**
 * Serves the pending restart once: stops each of main's idle containers that read its configuration before the
 * latest apply, and clears the request once none is left. Returns whether a request is still pending.
 */
export async function servePendingRestart(store: ConnectionsStore): Promise<boolean> {
  const appliedAt = await store.pendingRestart();
  if (appliedAt === undefined) return false;
  const appliedAtMs = Date.parse(appliedAt);
  const mainAgentGroupId = (await getDb().hasTable('gws_ea_profile')) ? await getMainAgentGroupId() : null;
  const behind = mainAgentGroupId
    ? (await getSessionsByAgentGroup(mainAgentGroupId)).filter(
        (session) => isContainerRunning(session.id) && readBefore(session.id, appliedAtMs),
      )
    : [];
  if (behind.length === 0) return !(await store.clearRestart(appliedAt));

  const idle: Session[] = [];
  for (const session of behind) {
    if (stopping.has(session.id)) continue;
    if (!(await mailboxState(session)).turnRunning) idle.push(session);
  }
  let restarted = 0;
  for (const session of idle) {
    // A turn may have started since the first look; a claim taken after this one is replayed after the respawn.
    const state = await mailboxState(session);
    if (state.turnRunning || stopping.has(session.id) || !isContainerRunning(session.id)) continue;
    if (!readBefore(session.id, appliedAtMs)) continue;
    if (await restart(session, state.due)) restarted += 1;
  }
  if (restarted > 0) log.info('Restarting idle main sessions for a connections change', { count: restarted });
  return true;
}

let armed: { readonly store: ConnectionsStore; readonly signal: AbortSignal } | undefined;
let timer: NodeJS.Timeout | undefined;
let inFlight: Promise<void> | undefined;
/** A request recorded while a check ran, which that check may have read before it existed. */
let recheck = false;

function stopTimer(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}

/** Whether to keep checking: an unreadable store or a failed check leaves the request for the next one. */
async function check(store: ConnectionsStore): Promise<boolean> {
  try {
    return await servePendingRestart(store);
  } catch (error) {
    if (!(error instanceof ConnectionsStoreError)) throw error;
    log.warn('Connections restart check unavailable', { reason: error.reason });
    return true;
  }
}

function tick(): void {
  if (!armed || armed.signal.aborted) return;
  if (inFlight) {
    recheck = true;
    return;
  }
  inFlight = check(armed.store)
    .catch((err: unknown) => {
      log.error('Connections restart check failed', { err });
      return true;
    })
    .then((pending) => {
      inFlight = undefined;
      if (recheck) {
        recheck = false;
        checkRestartSoon();
      } else if (!pending) stopTimer();
    });
}

/** Checks now and every few seconds while a request is pending; does nothing until the host has armed the checks. */
export function checkRestartSoon(): void {
  if (!armed || armed.signal.aborted) return;
  if (!timer) {
    timer = setInterval(tick, RESTART_CHECK_INTERVAL_MS);
    timer.unref();
  }
  tick();
}

/** Arms the checks for this host; a request a previous host left pending is served from now on. */
export function startRestartChecks(store: ConnectionsStore, signal: AbortSignal): void {
  if (signal.aborted) return;
  armed = { store, signal };
  signal.addEventListener('abort', stopTimer, { once: true });
  checkRestartSoon();
}

/** Stops new checks and waits for one in flight, so a stop the check began is not left half done. */
export async function stopRestartChecks(): Promise<void> {
  armed = undefined;
  recheck = false;
  stopTimer();
  await inFlight;
}
