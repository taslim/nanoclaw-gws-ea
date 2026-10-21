import { createHash } from 'node:crypto';
import {
  type WatchRow,
  type WatchPurchaseRefusal,
  type WatchClaimCallback,
  liveStates,
  boundsOf,
  bookedSlot,
  getBrowserWatch,
  compareWatchBounds,
  claimWatchBooking,
  emitWatchNotice,
} from './watch-state.js';
import { findPrincipalCalendarConflicts } from '../gws-ea-meetings/calendar-facts.js';
import { PurchaseAuthorityStore, type SpendingAuthority } from './authority.js';
import { agreementsGranted } from './consent.js';
import { materialPurchaseChange, type PurchaseBounds, type PurchaseFacts } from './fingerprint.js';
import type { BrowserExecutionContext } from './actions.js';

async function checkWatchCalendar(watch: WatchRow, facts: PurchaseFacts): Promise<WatchPurchaseRefusal | undefined> {
  const slot = bookedSlot(facts);
  if (!slot) return { status: 'outside_bounds', watchId: watch.id };
  let status: 'calendar_conflict' | 'calendar_unavailable' | undefined;
  try {
    const result = await findPrincipalCalendarConflicts(slot.at, slot.endAt);
    if (result.conflicts.length || result.conflicts_not_listed) status = 'calendar_conflict';
    // eslint-disable-next-line no-catch-all/no-catch-all -- Missing access, fetch failures and unreadable calendar data all fail closed.
  } catch (_error) {
    status = 'calendar_unavailable';
  }
  if (status) {
    await emitWatchNotice(watch, status, `${status}:${digest(JSON.stringify(slot))}`);
    return { status, watchId: watch.id };
  }
  return undefined;
}
export async function prepareWatchPurchase(
  context: BrowserExecutionContext,
  facts: PurchaseFacts,
): Promise<{ status: 'ready'; watchId: string; authorityId: string } | WatchPurchaseRefusal | undefined> {
  const db = context.store.db;
  if (!(await db.hasTable('gws_ea_browser_watches'))) return undefined;
  const watches = await db.all<WatchRow>(
    'SELECT * FROM gws_ea_browser_watches WHERE job_id = ? ORDER BY created_at,id',
    context.job.id,
  );
  if (!watches.length) return undefined;
  const claim = await db.get<{ state: string }>(
    'SELECT state FROM gws_ea_browser_watch_job_claims WHERE job_id = ?',
    context.job.id,
  );
  if (claim?.state !== 'available') return { status: 'watch_spent', watchId: watches[0].id };
  const active = watches.filter((watch) => liveStates.some((state) => state === watch.status));
  const watch = active.find(
    (candidate) => compareWatchBounds(boundsOf(candidate), facts, new Date().toISOString()).status === 'within_bounds',
  );
  if (!watch) {
    const pending = watches.find((candidate) => candidate.status === 'awaiting_principal');
    if (!active.length && pending) return { status: 'awaiting_principal', watchId: pending.id };
    if (!active.length) return undefined;
    // A region watch approved only what its bounds cover: any other booking is the principal's on its own card.
    if (active.every((candidate) => boundsOf(candidate).kind === 'region')) return undefined;
    for (const candidate of active)
      await emitWatchNotice(candidate, 'outside_bounds', `outside:${digest(JSON.stringify(facts.reservation))}`);
    return { status: 'outside_bounds', watchId: watches[0].id };
  }
  // An agreement the principal has not approved goes on the purchase's card, which approves it with the booking.
  if (
    boundsOf(watch).kind === 'region' &&
    facts.agreements?.length &&
    !(await agreementsGranted(db, facts.site, facts.agreements))
  )
    return undefined;
  const failure = await checkWatchCalendar(watch, facts);
  if (failure) return failure;
  await context.assertActive();
  const store = new PurchaseAuthorityStore(db);
  if (watch.authority_id) {
    const existing = await store.get(watch.authority_id);
    if (existing?.state === 'live') {
      if (
        !materialPurchaseChange(
          JSON.parse(existing.facts_json) as PurchaseFacts,
          facts,
          JSON.parse(existing.bounds_json) as PurchaseBounds,
        )
      )
        return { status: 'ready', watchId: watch.id, authorityId: existing.id };
      // The parent watch still covers these facts. Retire its unspent child before deriving another.
      await db.run(
        "UPDATE gws_ea_browser_authorities SET state = 'revoked' WHERE id = ? AND state = 'live'",
        existing.id,
      );
    }
  }
  const id = `watch-authority-${digest(`${watch.id}\0${context.request.id}`)}`;
  const bounds = boundsOf(watch);
  const arrival = Date.parse(bookedSlot(facts)?.at ?? '');
  const window = bounds.windows.find((entry) => arrival >= Date.parse(entry.start) && arrival <= Date.parse(entry.end));
  if (!window) return { status: 'outside_bounds', watchId: watch.id };
  const authority = await store.create({
    id,
    jobId: watch.job_id,
    kind: 'watch',
    watchId: watch.id,
    ...(watch.approval_id ? { approvalId: watch.approval_id } : {}),
    facts,
    bounds: {
      reservation: {
        // A generic booking names its venue only as the page shows it.
        venueId: bounds.kind === 'region' ? bounds.venue.name : bounds.venue.id,
        partySize: bounds.partySize,
        windowStart: window.start,
        windowEnd: window.end,
      },
    },
    attemptId: `watch-attempt-${digest(id)}`,
    expiresAt: bounds.until,
  });
  await db.run('UPDATE gws_ea_browser_watches SET authority_id = ? WHERE id = ?', authority.id, watch.id);
  return { status: 'ready', watchId: watch.id, authorityId: authority.id };
}
export async function prepareWatchCommit(
  context: BrowserExecutionContext,
  authority: SpendingAuthority,
  facts: PurchaseFacts,
): Promise<WatchClaimCallback | WatchPurchaseRefusal> {
  const watchId = authority.watch_id;
  const watch = watchId ? await getBrowserWatch(watchId, context.store.db) : undefined;
  if (!watch || compareWatchBounds(boundsOf(watch), facts, new Date().toISOString()).status !== 'within_bounds')
    return { status: 'outside_bounds', watchId: watchId ?? '' };
  const failure = await checkWatchCalendar(watch, facts);
  if (failure) return failure;
  const checked = bookedSlot(facts);
  if (!checked) return { status: 'outside_bounds', watchId: watch.id };
  return (db, currentAuthority, immediatelyRereadFacts) =>
    claimWatchBooking(db, {
      watchId: watch.id,
      jobId: watch.job_id,
      authorityId: currentAuthority.id,
      attemptId: currentAuthority.attempt_id,
      requestId: context.request.id,
      facts: immediatelyRereadFacts,
      calendarCheckedReservation: checked,
      at: new Date().toISOString(),
    });
}

const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
