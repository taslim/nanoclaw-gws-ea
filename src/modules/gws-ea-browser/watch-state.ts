import { createHash } from 'node:crypto';
import { getDb } from '../../db/connection.js';
import type { DbDriver } from '../../db/driver.js';
import { isUniqueViolation } from '../../db/errors.js';
import { getSession } from '../../db/sessions.js';
import { requestWake } from '../../request-wake.js';
import { writeBrowserNotice } from './notices.js';
import type { PendingApproval } from '../../types.js';
import { detachApproval, finishApprovalWithdrawal } from '../approvals/index.js';
import { type SpendingAuthority } from './authority.js';
import {
  completePurchaseFacts,
  venueKey,
  type FinancialCommitment,
  type GenericBookingFacts,
  type PurchaseFacts,
  type ReservationFacts,
} from './fingerprint.js';
import type { ReservationPolicy } from './merchant-contract.js';
import { type BrowserQueue } from './queue.js';
import {
  WATCH_HOURLY_WAKES,
  WATCH_REGION_TEXT_LIMIT,
  releaseInstants,
  watchSlowdown,
  type WatchReleaseRule,
} from './watch-policy.js';

export interface WatchFinancialBounds {
  freeOnly: boolean;
  currency: string;
  maxTotalMinor: number;
  maxDueNowMinor: number;
  policy?: ReservationPolicy;
}
export interface WatchBounds {
  /**
   * `region` for a watch on a site with no reader: the agent watches the region it marked, and the host books only
   * through the site's own checkout, read when the agent finds a table. Absent for a reader watch.
   */
  kind?: 'region';
  site: string;
  venue: { id: string; name: string };
  partySize: number;
  windows: Array<{ start: string; end: string }>;
  financial: WatchFinancialBounds;
  until: string;
}
export type WatchStatus =
  | 'awaiting_principal'
  | 'armed'
  | 'checking'
  | 'preparing'
  | 'booking'
  | 'booked'
  | 'expired'
  | 'cancelled'
  | 'blocked'
  | 'outcome_unknown';
export interface WatchRow {
  id: string;
  job_id: string;
  site: string;
  check_recipe_id: string;
  check_recipe_version: number;
  parameters_json: string;
  check_key: string;
  bounds_json: string;
  approval_id: string | null;
  approval_json: string | null;
  approval_finished_at: string | null;
  authority_id: string | null;
  status: WatchStatus;
  pending_request_id: string | null;
  booking_recipe_id: string | null;
  booking_recipe_version: number | null;
  /** The venue's release schedule, written once at creation; null when the venue states none. */
  release_json: string | null;
  /** The structured locator of the region the agent marked; null on a reader watch. */
  region_json: string | null;
  /** The region's normalized text as the agent last saw it: at its marking, then at each change that woke it. */
  region_baseline: string | null;
  /** When the agent marked the region, which a missing-region wake is keyed to. */
  region_marked_at: string | null;
  /** Since when the host has not found the region; null while it finds it. */
  region_missing_since: string | null;
  created_at: string;
  updated_at: string;
  next_check_at: string;
}
export type WatchBoundResult = { status: 'within_bounds' } | { status: 'outside_bounds'; reason: string };
export type WatchPurchaseRefusal = {
  status: 'calendar_conflict' | 'calendar_unavailable' | 'outside_bounds' | 'watch_spent' | 'awaiting_principal';
  watchId: string;
};
export type WatchClaimCallback = (
  db: DbDriver,
  authority: SpendingAuthority,
  immediatelyRereadFacts: PurchaseFacts,
) => Promise<void>;
export const APPROVAL_ACTION = 'browser_watch_setup';
export const liveStates = ['armed', 'checking', 'preparing'] as const;
export const watchDigest = (text: string): string => createHash('sha256').update(text).digest('hex');
export const boundsOf = (watch: WatchRow): WatchBounds => JSON.parse(watch.bounds_json) as WatchBounds;
const GENERIC_BOOKING_SPAN_MS = 2 * 60 * 60_000;
/** The most a booking's terms can charge: a per-person term counts per guest, an unread amount is unbounded. */
export function financialExposure(
  commitments: ReadonlyArray<Pick<FinancialCommitment, 'amountMinor' | 'perPerson'>>,
  partySize: number,
): number {
  return commitments.reduce((sum, term) => sum + (term.amountMinor ?? Infinity) * (term.perPerson ? partySize : 1), 0);
}
function exceedsFinancialLimit(facts: PurchaseFacts, partySize: number, financial: WatchFinancialBounds): boolean {
  return (
    Math.max(facts.totalMinor, financialExposure(facts.commitments, partySize)) > financial.maxTotalMinor ||
    facts.dueNowMinor > financial.maxDueNowMinor
  );
}
/** The reservation a purchase books: a reviewed reader's, or a generic booking whose venue, party and start it read. */
export function bookedSlot(facts: PurchaseFacts): ReservationFacts | undefined {
  if (facts.reservation) return facts.reservation;
  const booking = facts.generic?.booking;
  if (!booking?.venue || booking.partySize === undefined || !booking.at || !Number.isFinite(Date.parse(booking.at)))
    return undefined;
  return {
    venueId: venueKey(booking.venue),
    venueName: booking.venue,
    partySize: booking.partySize,
    at: new Date(booking.at).toISOString(),
    endAt: new Date(Date.parse(booking.at) + GENERIC_BOOKING_SPAN_MS).toISOString(),
    timeZone: booking.timeZone ?? 'UTC',
  };
}
export function watchSlotKey(slot: ReservationFacts): string {
  return watchDigest(
    JSON.stringify([
      slot.venueId,
      slot.partySize,
      new Date(slot.at).toISOString(),
      new Date(slot.endAt).toISOString(),
      slot.timeZone,
    ]),
  );
}
export const getBrowserWatch = (id: string, db: DbDriver = getDb()): Promise<WatchRow | undefined> =>
  db.get<WatchRow>('SELECT * FROM gws_ea_browser_watches WHERE id = ?', id);
export function watchReleases(watch: WatchRow): number[] {
  if (!watch.release_json) return [];
  const bounds = boundsOf(watch);
  return releaseInstants(
    JSON.parse(watch.release_json) as WatchReleaseRule,
    bounds.windows,
    Date.parse(watch.created_at),
    Date.parse(bounds.until),
  );
}

function regionBookingOutside(
  bounds: WatchBounds,
  booking: Pick<GenericBookingFacts, 'venue' | 'partySize' | 'at'>,
): 'venue_or_party' | 'time' | undefined {
  if (
    (booking.venue !== undefined && venueKey(booking.venue) !== venueKey(bounds.venue.name)) ||
    (booking.partySize !== undefined && booking.partySize !== bounds.partySize)
  )
    return 'venue_or_party';
  if (booking.at === undefined) return undefined;
  const start = Date.parse(booking.at);
  return bounds.windows.some((window) => start >= Date.parse(window.start) && start <= Date.parse(window.end))
    ? undefined
    : 'time';
}

function compareRegionWatchBounds(bounds: WatchBounds, facts: PurchaseFacts, now: string): WatchBoundResult {
  const refuse = (reason: string): WatchBoundResult => ({ status: 'outside_bounds', reason });
  if (!(Date.parse(now) < Date.parse(bounds.until))) return refuse('deadline');
  if (facts.site !== bounds.site) return refuse('merchant');
  const slot = bookedSlot(facts);
  if (!slot) return refuse('venue_or_party');
  const outside = regionBookingOutside(bounds, { venue: slot.venueName, partySize: slot.partySize, at: slot.at });
  if (outside) return refuse(outside);
  const financial = bounds.financial;
  if (
    financial.currency !== facts.currency ||
    ![facts.totalMinor, facts.dueNowMinor].every((n) => Number.isSafeInteger(n) && n >= 0)
  )
    return refuse('currency_or_total');
  if (
    !completePurchaseFacts(facts) ||
    facts.addOns?.length ||
    facts.commitments.some((term) => term.kind === 'subscription' || term.kind === 'trial')
  )
    return refuse('financial_terms');
  return exceedsFinancialLimit(facts, slot.partySize, financial)
    ? refuse('financial_limit')
    : { status: 'within_bounds' };
}

/** Start windows constrain arrival; the full host-read duration is checked against the calendar. */
export function compareWatchBounds(bounds: WatchBounds, facts: PurchaseFacts, now: string): WatchBoundResult {
  if (bounds.kind === 'region') return compareRegionWatchBounds(bounds, facts, now);
  const refuse = (reason: string): WatchBoundResult => ({ status: 'outside_bounds', reason });
  const slot = facts.reservation;
  if (
    !Number.isFinite(Date.parse(now)) ||
    !Number.isFinite(Date.parse(bounds.until)) ||
    Date.parse(now) >= Date.parse(bounds.until)
  )
    return refuse('deadline');
  if (
    !slot ||
    facts.site !== bounds.site ||
    slot.venueId !== bounds.venue.id ||
    slot.venueName !== bounds.venue.name ||
    slot.partySize !== bounds.partySize
  )
    return refuse('venue_or_party');
  const start = Date.parse(slot.at),
    end = Date.parse(slot.endAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return refuse('unreadable_duration');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: slot.timeZone });
  } catch (error) {
    if (error instanceof RangeError) return refuse('unreadable_timezone');
    throw error;
  }
  if (!bounds.windows.some((window) => start >= Date.parse(window.start) && start <= Date.parse(window.end)))
    return refuse('time');
  const financial = bounds.financial;
  if (
    financial.currency !== facts.currency ||
    ![facts.totalMinor, facts.dueNowMinor].every((n) => Number.isSafeInteger(n) && n >= 0)
  )
    return refuse('currency_or_total');
  if (exceedsFinancialLimit(facts, slot.partySize, financial)) return refuse('financial_limit');
  if (financial.freeOnly)
    return facts.totalMinor === 0 &&
      facts.dueNowMinor === 0 &&
      facts.commitments.length === 0 &&
      Boolean(facts.noCommitmentTerms?.trim())
      ? { status: 'within_bounds' }
      : refuse('financial_commitment');
  if (
    !completePurchaseFacts(facts) ||
    !financial.policy ||
    facts.commitments.length !== financial.policy.commitments.length
  )
    return refuse('financial_terms');
  for (let i = 0; i < facts.commitments.length; i++) {
    const actual = facts.commitments[i],
      approved = financial.policy.commitments[i];
    for (const key of [
      'kind',
      'terms',
      'trigger',
      'conditionalTrigger',
      'cancellationTerms',
      'perPerson',
      'conversionAt',
      'frequency',
    ] as const)
      if (actual[key] !== approved[key]) return refuse('financial_terms');
    if ((actual.amountMinor ?? Infinity) > (approved.amountMinor ?? -1)) return refuse('financial_limit');
    if (
      approved.cancellationBeforeMs !== undefined &&
      Date.parse(actual.cancellationDeadline ?? '') !== start - approved.cancellationBeforeMs
    )
      return refuse('cancellation_deadline');
  }
  return { status: 'within_bounds' };
}

export interface ClaimWatchInput {
  watchId: string;
  jobId: string;
  authorityId: string;
  attemptId: string;
  requestId: string;
  facts: PurchaseFacts;
  calendarCheckedReservation: ReservationFacts;
  at: string;
}
/** Runs inside the authority's commit transaction, so it awaits no mailbox, calendar or browser. */
export async function claimWatchBooking(db: DbDriver, input: ClaimWatchInput): Promise<void> {
  const watch = await getBrowserWatch(input.watchId, db);
  const job = await db.get<{ cancelled: number; cancel_requested: number }>(
    'SELECT cancelled,cancel_requested FROM gws_ea_browser_jobs WHERE id = ?',
    input.jobId,
  );
  if (
    !watch ||
    watch.job_id !== input.jobId ||
    !job ||
    job.cancelled ||
    job.cancel_requested ||
    !['armed', 'preparing'].includes(watch.status)
  )
    throw new Error('Watch is no longer armed');
  const slot = bookedSlot(input.facts);
  if (
    compareWatchBounds(boundsOf(watch), input.facts, input.at).status !== 'within_bounds' ||
    !slot ||
    watchSlotKey(slot) !== watchSlotKey(input.calendarCheckedReservation) ||
    slot.venueName !== input.calendarCheckedReservation.venueName
  )
    throw new Error('Watch bounds or calendar-checked slot changed');
  await db.run(
    'INSERT INTO gws_ea_browser_watch_slot_claims(site,slot_key,job_id,watch_id,attempt_id) VALUES(?,?,?,?,?)',
    watch.site,
    watchSlotKey(slot),
    input.jobId,
    watch.id,
    input.attemptId,
  );
  const lastAction = await db.get<{ action_index: number | null }>(
    'SELECT MAX(action_index) AS action_index FROM gws_ea_browser_action_trace WHERE job_id = ?',
    input.jobId,
  );
  const claimed = await db.run(
    `UPDATE gws_ea_browser_watch_job_claims SET state = 'committing',watch_id = ?,authority_id = ?,attempt_id = ?,request_id = ?,commit_started_at = ?,last_action_index = ? WHERE job_id = ? AND state = 'available'`,
    input.watchId,
    input.authorityId,
    input.attemptId,
    input.requestId,
    input.at,
    lastAction?.action_index ?? null,
    input.jobId,
  );
  if (!claimed.changes) throw new Error('This job already claimed its booking');
  const moved = await db.run(
    "UPDATE gws_ea_browser_watches SET status = 'booking',authority_id = ?,updated_at = ? WHERE id = ? AND status IN ('armed','preparing')",
    input.authorityId,
    input.at,
    input.watchId,
  );
  if (!moved.changes) throw new Error('Watch is no longer armed');
}

/**
 * A watch booking's attempt, unconfirmed (`placed` undefined) or resolved by any source, inside the authority
 * store's transaction; common purchase notification owns its terminal message. A resolved booking leaves the
 * claim and the watch final: booked, or the job's one claim spent and the watch cancelled. Recipe promotion
 * consumes the settled outcome separately, after this authority transaction.
 */
export async function finishWatchPurchase(
  db: DbDriver,
  watchId: string,
  attemptId: string,
  placed: boolean | undefined,
): Promise<void> {
  const watch = await getBrowserWatch(watchId, db);
  if (!watch) return;
  const at = new Date().toISOString();
  const updated = await db.run(
    `UPDATE gws_ea_browser_watch_job_claims SET state = ?,finished_at = ? WHERE job_id = ? AND watch_id = ? AND attempt_id = ? AND state IN ('committing','unknown')`,
    placed ? 'booked' : 'unknown',
    at,
    watch.job_id,
    watchId,
    attemptId,
  );
  if (!updated.changes) return;
  await db.run(
    'UPDATE gws_ea_browser_watches SET status = ?,updated_at = ?,pending_request_id = NULL WHERE id = ?',
    placed ? 'booked' : placed === false ? 'cancelled' : 'outcome_unknown',
    at,
    watchId,
  );
  await detachBrowserWatchCards(watch.job_id, 'cancelled', undefined, db);
  await db.run(
    "UPDATE gws_ea_browser_authorities SET state = 'revoked' WHERE job_id = ? AND kind = 'watch' AND state = 'live'",
    watch.job_id,
  );
}

export async function insertWatchNotice(
  db: DbDriver,
  watch: WatchRow,
  status: string,
  eventKey: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  await db.run(
    `INSERT INTO gws_ea_browser_watch_notices(watch_id,event_key,outcome_json,created_at) VALUES(?,?,?,?) ON CONFLICT(watch_id,event_key) DO NOTHING`,
    watch.id,
    eventKey,
    JSON.stringify({ type: 'browser_watch_outcome', job: watch.job_id, watch_id: watch.id, status, ...details }),
    new Date().toISOString(),
  );
}
export async function emitWatchNotice(
  watch: WatchRow,
  status: string,
  eventKey: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  const db = getDb();
  await insertWatchNotice(db, watch, status, eventKey, details);
  await deliverWatchNotices(db);
}

const REGION_WAKE = /^(?:change|region_missing):/u;
export async function regionWakesThisHour(db: DbDriver, watchId: string, now: number): Promise<number[]> {
  const notices = await db.all<{ event_key: string; created_at: string }>(
    'SELECT event_key,created_at FROM gws_ea_browser_watch_notices WHERE watch_id = ? AND created_at > ?',
    watchId,
    new Date(now - 3_600_000).toISOString(),
  );
  return notices.filter((notice) => REGION_WAKE.test(notice.event_key)).map((notice) => Date.parse(notice.created_at));
}
async function latestBookingStep(db: DbDriver, jobId: string): Promise<number> {
  const step = await db.get<{ at: string | null }>(
    `SELECT MAX(at) AS at FROM (
      SELECT MAX(attempted_at) AS at FROM gws_ea_browser_free_attempts WHERE job_id = ?
      UNION ALL SELECT MAX(created_at) AS at FROM gws_ea_browser_purchase_cards WHERE job_id = ?
      UNION ALL SELECT MAX(created_at) AS at FROM gws_ea_browser_authorities WHERE job_id = ?)`,
    jobId,
    jobId,
    jobId,
  );
  return Date.parse(step?.at ?? '') || 0;
}
/**
 * How much slower a region check runs. A wake that no step toward a booking followed (a free commit, a purchase card
 * or an authority) matched nothing, and each such wake this hour doubles the interval; a booking step resets it. A
 * shared check keeps its least-slowed member's pace, and one that serves a reader watch never slows.
 */
export async function regionWatchSlowdown(db: DbDriver, watches: readonly WatchRow[]): Promise<number> {
  const now = Date.now();
  let slowdown = Infinity;
  for (const watch of watches) {
    if (!watch.region_json) return 1;
    const booking = await latestBookingStep(db, watch.job_id);
    const unmatched = (await regionWakesThisHour(db, watch.id, now)).filter((at) => at > booking).length;
    slowdown = Math.min(slowdown, watchSlowdown(unmatched));
  }
  return Number.isFinite(slowdown) ? slowdown : 1;
}
export const excerpt = (text: string): string =>
  text.length > WATCH_REGION_TEXT_LIMIT ? `${text.slice(0, WATCH_REGION_TEXT_LIMIT)}…` : text;
/** What one model-free check read of a region watch's region. */
export type RegionCheckRead =
  | { status: 'region_read'; text: string }
  | { status: 'region_missing'; reason: 'region_not_found' | 'route_changed' };
/**
 * Records what check `checkId` read for a region watch it served, while the watch is still that check's and its region
 * the one read. A changed text wakes the agent with the text before and after, untrusted, and the baseline moves on; a
 * change over the hourly cap keeps the old baseline, so it wakes once the hour allows. A region found again ends its
 * absence; one missing on two checks running wakes the agent once to mark it again.
 */
export async function recordRegionCheck(
  db: DbDriver,
  watch: WatchRow,
  checkId: string,
  read: RegionCheckRead,
): Promise<void> {
  const now = Date.now();
  const at = new Date(now).toISOString();
  await db.transaction(async () => {
    const current = await getBrowserWatch(watch.id, db);
    if (
      !current?.region_json ||
      current.status !== 'checking' ||
      current.pending_request_id !== checkId ||
      current.region_marked_at !== watch.region_marked_at
    )
      return;
    const capped = (await regionWakesThisHour(db, current.id, now)).length >= WATCH_HOURLY_WAKES;
    switch (read.status) {
      case 'region_read':
        if (current.region_missing_since)
          await db.run('UPDATE gws_ea_browser_watches SET region_missing_since = NULL WHERE id = ?', current.id);
        if (read.text === current.region_baseline || capped) return;
        await db.run(
          'UPDATE gws_ea_browser_watches SET region_baseline = ?,updated_at = ? WHERE id = ?',
          read.text,
          at,
          current.id,
        );
        await insertWatchNotice(db, current, 'changed', `change:${checkId}`, {
          region: { untrusted: true, before: excerpt(current.region_baseline ?? ''), after: excerpt(read.text) },
        });
        return;
      case 'region_missing':
        if (!current.region_missing_since) {
          await db.run('UPDATE gws_ea_browser_watches SET region_missing_since = ? WHERE id = ?', at, current.id);
          return;
        }
        if (!capped)
          await insertWatchNotice(
            db,
            current,
            'region_missing',
            `region_missing:${watchDigest(`${current.region_marked_at ?? ''}\0${current.region_missing_since}`)}`,
            { reason: read.reason },
          );
        return;
      default: {
        const unknown: never = read;
        throw new Error(`Unknown region read ${JSON.stringify(unknown)}`);
      }
    }
  });
}

/**
 * A commit a region watch's errand makes on the watched site other than through the watch's own authority spends the
 * job's one booking claim as that authority would: the watch stops checking, and the commit's outcome ends it. A
 * `booking`, as its page states it, spends only a watch it does not fall outside: a table for another venue, party or
 * time books and leaves every watch going, while one whose page leaves a fact unstated may be the watched table and
 * spends it. Joins the commit's transaction and waits on nothing outside the database. A job with no such live region
 * watch on the site, or whose claim is already spent, is left as it is.
 */
export async function claimRegionWatchCommit(
  db: DbDriver,
  input: {
    jobId: string;
    site: string;
    attemptId: string;
    requestId: string;
    at: string;
    booking?: GenericBookingFacts;
  },
): Promise<void> {
  if (!(await db.hasTable('gws_ea_browser_watches'))) return;
  const live = await db.all<WatchRow>(
    "SELECT * FROM gws_ea_browser_watches WHERE job_id = ? AND site = ? AND region_json IS NOT NULL AND status IN ('armed','checking','preparing') ORDER BY created_at,id",
    input.jobId,
    input.site,
  );
  const { booking } = input;
  const watch = booking ? live.find((candidate) => !regionBookingOutside(boundsOf(candidate), booking)) : live[0];
  if (!watch) return;
  const claimed = await db.run(
    "UPDATE gws_ea_browser_watch_job_claims SET state = 'committing',watch_id = ?,attempt_id = ?,request_id = ?,commit_started_at = ? WHERE job_id = ? AND state = 'available'",
    watch.id,
    input.attemptId,
    input.requestId,
    input.at,
    input.jobId,
  );
  if (claimed.changes)
    await db.run(
      "UPDATE gws_ea_browser_watches SET status = 'booking',pending_request_id = NULL,updated_at = ? WHERE id = ?",
      input.at,
      watch.id,
    );
}
/**
 * Ends the watch whose claim a commit took, whatever took it, once the commit's attempt is unconfirmed (`placed`
 * undefined) or resolved by any source. Joins the authority store's transaction; a claim already final is left.
 */
export async function finishWatchCommit(
  db: DbDriver,
  jobId: string,
  attemptId: string,
  placed: boolean | undefined,
): Promise<void> {
  if (!(await db.hasTable('gws_ea_browser_watch_job_claims'))) return;
  const claim = await db.get<{ watch_id: string | null }>(
    "SELECT watch_id FROM gws_ea_browser_watch_job_claims WHERE job_id = ? AND attempt_id = ? AND state IN ('committing','unknown')",
    jobId,
    attemptId,
  );
  if (claim?.watch_id) await finishWatchPurchase(db, claim.watch_id, attemptId, placed);
}
export async function deliverWatchNotices(db: DbDriver = getDb()): Promise<void> {
  const withdrawn = await db.all<WatchRow>(
    "SELECT * FROM gws_ea_browser_watches WHERE status IN ('cancelled','expired') AND approval_json IS NOT NULL AND approval_finished_at IS NULL",
  );
  for (const watch of withdrawn) {
    await finishApprovalWithdrawal(
      JSON.parse(watch.approval_json!) as PendingApproval,
      watch.status === 'expired' ? 'Expired: the watch deadline passed.' : 'Withdrawn: this watch ended.',
      watch.status === 'expired' ? 'expired' : 'withdrawn',
    );
    await db.run(
      'UPDATE gws_ea_browser_watches SET approval_finished_at = ? WHERE id = ?',
      new Date().toISOString(),
      watch.id,
    );
  }
  const notices = await db.all<{ watch_id: string; event_key: string; outcome_json: string }>(
    'SELECT * FROM gws_ea_browser_watch_notices WHERE delivered_at IS NULL ORDER BY created_at',
  );
  for (const notice of notices) {
    const watch = await getBrowserWatch(notice.watch_id, db);
    const job = watch
      ? await db.get<{ browser_session_id: string }>(
          'SELECT browser_session_id FROM gws_ea_browser_jobs WHERE id = ?',
          watch.job_id,
        )
      : undefined;
    const session = job ? await getSession(job.browser_session_id) : undefined;
    if (!session || session.status !== 'active') continue;
    try {
      await writeBrowserNotice(
        session,
        `browser-watch-${watchDigest(`${notice.watch_id}\0${notice.event_key}`)}`,
        notice.outcome_json,
      );
      // eslint-disable-next-line no-catch-all/no-catch-all -- Retain a durable notice when its mailbox cannot be written.
    } catch (error) {
      if (!isUniqueViolation(error)) continue;
    }
    await db.run(
      'UPDATE gws_ea_browser_watch_notices SET delivered_at = ? WHERE watch_id = ? AND event_key = ?',
      new Date().toISOString(),
      notice.watch_id,
      notice.event_key,
    );
    void requestWake(session, 'browser-watch').catch(() => undefined);
  }
}

/** DB-only: terminal card delivery for the withdrawn approvals follows the transaction's commit. */
export async function detachBrowserWatchCards(
  jobId: string,
  status: 'cancelled' | 'expired',
  watchId?: string,
  db: DbDriver = getDb(),
): Promise<PendingApproval[]> {
  if (!(await db.hasTable('gws_ea_browser_watches'))) return [];
  const watches = await db.all<WatchRow>(
    `SELECT * FROM gws_ea_browser_watches WHERE job_id = ?${watchId === undefined ? '' : ' AND id = ?'} AND status IN ('awaiting_principal','armed','checking','preparing')`,
    ...[jobId, ...(watchId ? [watchId] : [])],
  );
  const withdrawn: PendingApproval[] = [];
  const approvals = await db.all<PendingApproval>('SELECT * FROM pending_approvals WHERE action = ?', APPROVAL_ACTION);
  const approvalsByWatch = new Map<string, PendingApproval[]>();
  for (const approval of approvals) {
    const payload = JSON.parse(approval.payload) as { watchId?: string };
    if (typeof payload.watchId === 'string')
      approvalsByWatch.set(payload.watchId, [...(approvalsByWatch.get(payload.watchId) ?? []), approval]);
  }
  for (const watch of watches) {
    for (const approval of approvalsByWatch.get(watch.id) ?? []) {
      const detached = await detachApproval(approval.approval_id);
      if (detached) {
        withdrawn.push(detached);
        await db.run(
          'UPDATE gws_ea_browser_watches SET approval_id = ?,approval_json = COALESCE(approval_json,?) WHERE id = ?',
          detached.approval_id,
          JSON.stringify(detached),
          watch.id,
        );
      }
    }
    await db.run(
      'UPDATE gws_ea_browser_watches SET status = ?,updated_at = ?,pending_request_id = NULL WHERE id = ?',
      status,
      new Date().toISOString(),
      watch.id,
    );
    if (watch.authority_id)
      await db.run(
        "UPDATE gws_ea_browser_authorities SET state = 'revoked' WHERE id = ? AND state = 'live'",
        watch.authority_id,
      );
  }
  return withdrawn;
}
export async function expireBrowserWatches(db: DbDriver = getDb()): Promise<void> {
  const watches = await db.all<WatchRow>(
    "SELECT * FROM gws_ea_browser_watches WHERE status IN ('awaiting_principal','armed','checking','preparing')",
  );
  for (const watch of watches)
    if (Date.parse(boundsOf(watch).until) <= Date.now()) {
      const withdrawn = await db.transaction(() => detachBrowserWatchCards(watch.job_id, 'expired', watch.id));
      for (const approval of withdrawn) {
        await finishApprovalWithdrawal(approval, 'Expired: the watch deadline passed.', 'expired');
        await db.run(
          'UPDATE gws_ea_browser_watches SET approval_finished_at = ? WHERE approval_id = ?',
          new Date().toISOString(),
          approval.approval_id,
        );
      }
      await emitWatchNotice(watch, 'expired', 'expired');
    }
}
export async function recoverBrowserWatchState(queue: BrowserQueue): Promise<void> {
  const db = queue.store.db;
  if (!(await db.hasTable('gws_ea_browser_watches'))) return;
  await db.transaction(async () => {
    const interrupted = await db.all<WatchRow>(
      "SELECT * FROM gws_ea_browser_watches WHERE status IN ('checking','preparing','booking')",
    );
    for (const watch of interrupted) {
      const claim = await db.get<{ state: string }>(
        'SELECT state FROM gws_ea_browser_watch_job_claims WHERE job_id = ?',
        watch.job_id,
      );
      if (claim?.state === 'committing' || claim?.state === 'unknown') {
        await db.run(
          "UPDATE gws_ea_browser_watches SET status = 'outcome_unknown',pending_request_id = NULL WHERE id = ?",
          watch.id,
        );
        continue;
      }
      if (claim?.state === 'booked') continue;
      await db.run(
        "UPDATE gws_ea_browser_watches SET status = 'armed',authority_id = NULL,pending_request_id = NULL WHERE id = ?",
        watch.id,
      );
      if (watch.authority_id)
        await db.run(
          "UPDATE gws_ea_browser_authorities SET state = 'revoked' WHERE id = ? AND state = 'live'",
          watch.authority_id,
        );
    }
  });
}
