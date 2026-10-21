import { createHash } from 'node:crypto';
import { invalidArgs } from '../../cli/delivery-action.js';
import { getDb } from '../../db/connection.js';
import type { DbDriver } from '../../db/driver.js';
import { isUniqueViolation } from '../../db/errors.js';
import { getPendingApproval, getSession } from '../../db/sessions.js';
import { DENY, HOLD, defineGuardedAction, guard } from '../../guard/index.js';
import { isRecord } from '../../gws-ea/validation.js';
import { requestWake } from '../../request-wake.js';
import { writeBrowserNotice } from './notices.js';
import { ianaTimezone } from '../../timezone.js';
import type { PendingApproval } from '../../types.js';
import {
  detachApproval,
  finishApprovalWithdrawal,
  registerApprovalHandler,
  requestApproval,
} from '../approvals/index.js';
import { registerApprovalResolvedHandler } from '../approvals/primitive.js';
import { findPrincipalCalendarConflicts } from '../gws-ea-meetings/calendar-facts.js';
import { isVerifiedPrincipalUser, principalApproverUserId } from '../gws-ea-profile/db.js';
import { PurchaseAuthorityStore, type ResolutionSource, type SpendingAuthority } from './authority.js';
import { readIsoTime } from './iso-time.js';
import { cardEventSpan, cardTime, ERRAND_ORIGIN_LINE, SELLER_TEXT_LIMIT } from './cards.js';
import { agreementsGranted } from './consent.js';
import { browserSite } from './leases.js';
import {
  amountMinor,
  completePurchaseFacts,
  formatMoney,
  materialPurchaseChange,
  venueKey,
  type FinancialCommitment,
  type GenericBookingFacts,
  type PurchaseBounds,
  type PurchaseFacts,
  type ReservationFacts,
} from './fingerprint.js';
import type { ReservationPolicy } from './merchant-contract.js';
import { merchantSignatures } from './merchant-signatures.js';
import { readBrowserRef, type BrowserRef } from './observe.js';
import { readBrowserPolicy } from './policy.js';
import { loadRecipe, recipeCheckKey, executeRecipe, type BrowserRecipe } from './recipes.js';
import { type StructuredBrowserLocator } from './locators.js';
import { type BrowserQueue } from './queue.js';
import type { BrowserExecutionContext, BrowserQueuedAction } from './actions.js';
import {
  WATCH_HOURLY_WAKES,
  WATCH_REGION_TEXT_LIMIT,
  principalClock,
  releaseInstants,
  watchSitePolicy,
  watchSlowdown,
  watchStartAt,
  type WatchReleaseRule,
} from './watch-policy.js';
import { quoted } from '../approvals/request-text.js';

export interface WatchFinancialBounds {
  freeOnly: boolean;
  currency: string;
  maxTotalMinor: number;
  maxDueNowMinor: number;
  policy?: ReservationPolicy;
}
export interface WatchBounds {
  /**
   * `region` for a watch on a site with no reader (KTD20): the agent watches the region it marked, and the host books
   * only through the site's own checkout, read when the agent finds a table. Absent for a reader watch.
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
  /** On a site with no reader (KTD20), the structured locator of the region the agent marked; null on a reader watch. */
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
const APPROVAL_ACTION = 'browser_watch_setup';
const liveStates = ['armed', 'checking', 'preparing'] as const;
const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
const boundsOf = (watch: WatchRow): WatchBounds => JSON.parse(watch.bounds_json) as WatchBounds;
/**
 * An unreviewed page states when a booking starts, not when it ends: its calendar check and slot claim cover the two
 * hours a table is usually held.
 */
const GENERIC_BOOKING_SPAN_MS = 2 * 60 * 60_000;
/** The most a booking's terms can charge: each for every guest it is per, an unread amount without bound. */
function financialExposure(
  commitments: ReadonlyArray<Pick<FinancialCommitment, 'amountMinor' | 'perPerson'>>,
  partySize: number,
): number {
  return commitments.reduce((sum, term) => sum + (term.amountMinor ?? Infinity) * (term.perPerson ? partySize : 1), 0);
}
/** Whether a checkout's total or its terms' most passes the watch's maximum, or its amount due now the most due now. */
function exceedsFinancialLimit(facts: PurchaseFacts, partySize: number, financial: WatchFinancialBounds): boolean {
  return (
    Math.max(facts.totalMinor, financialExposure(facts.commitments, partySize)) > financial.maxTotalMinor ||
    facts.dueNowMinor > financial.maxDueNowMinor
  );
}
/** The reservation a purchase books: a reviewed reader's, or a generic booking whose venue, party and start it read. */
function bookedSlot(facts: PurchaseFacts): ReservationFacts | undefined {
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
  return digest(
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
/** The release instants a watch's recorded rule sets for its windows; none without a rule. */
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

/**
 * Where a booking, as a page states it, falls outside a region watch's venue, party or windows (KTD20). A fact the
 * page does not state never places it outside.
 */
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

/**
 * A region watch's approval covers a booking (KTD20) when the site's own checkout, as the host reads it, is the
 * watched merchant's, for the venue and party, arriving within a window, with its total, amount due now and every fee
 * within the approved maximum. A recurring charge has no total a one-time maximum bounds.
 */
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
/** Joins the sole executor's authority/marker transaction. No mailbox, calendar or browser awaits here. */
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
 * claim and the watch final: booked, or the job's one claim spent and the watch cancelled. Only a booking its
 * page proved promotes its recipe.
 */
export async function finishWatchPurchase(
  db: DbDriver,
  watchId: string,
  attemptId: string,
  placed: boolean | undefined,
  source?: ResolutionSource,
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
  if (placed && source === 'page') await promoteWatchRecipe(db, watch, attemptId);
}

/** Records one notice for a watch's job, once per event key; `deliverWatchNotices` writes it and wakes the job. */
async function insertWatchNotice(
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

/** A region watch's wakes (KTD20), each a notice: every change it reported and every request to mark it again. */
const REGION_WAKE = /^(?:change|region_missing):/u;
/** When a region watch woke the agent in the hour before `now`. */
async function regionWakesThisHour(db: DbDriver, watchId: string, now: number): Promise<number[]> {
  const notices = await db.all<{ event_key: string; created_at: string }>(
    'SELECT event_key,created_at FROM gws_ea_browser_watch_notices WHERE watch_id = ? AND created_at > ?',
    watchId,
    new Date(now - 3_600_000).toISOString(),
  );
  return notices.filter((notice) => REGION_WAKE.test(notice.event_key)).map((notice) => Date.parse(notice.created_at));
}
/** The job's latest step toward a booking: a free commit's attempt, a purchase card, or a spending authority. */
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
 * How much slower a region check runs (KTD20). The agent decides on each wake: a wake that no step toward a booking
 * followed (a free commit, a purchase card or an authority) matched nothing, and each such wake this hour doubles the
 * cadence; a booking step resets it. A shared check keeps its least-slowed member's pace; a reader watch never slows.
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
const excerpt = (text: string): string =>
  text.length > WATCH_REGION_TEXT_LIMIT ? `${text.slice(0, WATCH_REGION_TEXT_LIMIT)}…` : text;
/** What one model-free check read of a region watch's region. */
export type RegionCheckRead =
  | { status: 'region_read'; text: string }
  | { status: 'region_missing'; reason: 'region_not_found' | 'route_changed' };
/**
 * Records what a check `checkId` read for a region watch it served (KTD20), while the watch is still that check's
 * and its region the one read. A changed text wakes the agent with the text before and after, untrusted, and the
 * baseline moves on; a change over the hourly cap keeps the old baseline, so it wakes once the hour allows. A
 * region found again ends its absence; one missing on two checks running wakes the agent once to mark it again.
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
            `region_missing:${digest(`${current.region_marked_at ?? ''}\0${current.region_missing_since}`)}`,
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
 * A booking that a region watch's errand commits on the watched site by a free commit or a card's approval spends
 * the job's one booking claim (KTD20), as the watch's own authority does: the watch stops checking, and the commit's
 * outcome ends it. A free commit's `booking`, as its page states it, spends only a watch it does not fall outside:
 * a table for another venue, party or time books and leaves every watch going, while one whose page leaves a fact
 * unstated may be the watched table and spends it. Joins the commit's transaction and waits on nothing outside the
 * database. A job with no such live region watch on the site, or whose claim is already spent, is left as it is.
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
 * Ends the watch whose claim a commit took, whatever took it (the watch's own authority, a card or guarantee
 * booking, or a free table on a region watch's site), once the commit's attempt is unconfirmed (`placed`
 * undefined) or resolved by any source. Joins the authority store's transaction; a claim already final is left.
 */
export async function finishWatchCommit(
  db: DbDriver,
  jobId: string,
  attemptId: string,
  placed: boolean | undefined,
  source?: ResolutionSource,
): Promise<void> {
  if (!(await db.hasTable('gws_ea_browser_watch_job_claims'))) return;
  const claim = await db.get<{ watch_id: string | null }>(
    "SELECT watch_id FROM gws_ea_browser_watch_job_claims WHERE job_id = ? AND attempt_id = ? AND state IN ('committing','unknown')",
    jobId,
    attemptId,
  );
  if (claim?.watch_id) await finishWatchPurchase(db, claim.watch_id, attemptId, placed, source);
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
        `browser-watch-${digest(`${notice.watch_id}\0${notice.event_key}`)}`,
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

async function promoteWatchRecipe(db: DbDriver, watch: WatchRow, attemptId: string): Promise<void> {
  if (!watch.booking_recipe_id) return;
  const recipe = await loadRecipe(watch.booking_recipe_id, db);
  const authority = await db.get<{ commit_request_id: string | null }>(
    'SELECT commit_request_id FROM gws_ea_browser_authorities WHERE attempt_id = ?',
    attemptId,
  );
  const request = authority?.commit_request_id
    ? await db.get<{ accepted_at: string }>(
        'SELECT accepted_at FROM gws_ea_browser_requests WHERE id = ?',
        authority.commit_request_id,
      )
    : undefined;
  const traced = recipe
    ? await db.get<{ created_at: string }>(
        'SELECT created_at FROM gws_ea_browser_action_trace WHERE job_id = ? AND action_index = ?',
        watch.job_id,
        recipe.lastAction,
      )
    : undefined;
  const claim = await db.get<{ last_action_index: number | null }>(
    'SELECT last_action_index FROM gws_ea_browser_watch_job_claims WHERE job_id = ? AND watch_id = ? AND attempt_id = ?',
    watch.job_id,
    watch.id,
    attemptId,
  );
  const attempt = await db.get<{ facts_json: string }>(
    'SELECT facts_json FROM gws_ea_browser_purchase_attempts WHERE id = ?',
    attemptId,
  );
  const facts = attempt ? (JSON.parse(attempt.facts_json) as PurchaseFacts) : undefined;
  const lastStep = recipe?.steps.at(-1);
  if (
    !recipe ||
    recipe.sourceJobId !== watch.job_id ||
    recipe.version !== watch.booking_recipe_version ||
    !traced ||
    !request ||
    traced.created_at > request.accepted_at ||
    claim?.last_action_index !== recipe.lastAction ||
    !facts ||
    lastStep?.targets.at(-1)?.name !== facts.control.label ||
    new URL(lastStep.before.url).origin !== facts.origin
  )
    return;
  await db.run(
    `INSERT INTO gws_ea_browser_watch_recipe_links(check_recipe_id,check_recipe_version,booking_recipe_id,booking_recipe_version,source_watch_id,source_attempt_id,verified_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
    watch.check_recipe_id,
    watch.check_recipe_version,
    recipe.id,
    recipe.version,
    watch.id,
    attemptId,
    new Date().toISOString(),
  );
}
/** Called directly by save_recipe after its immutable source provenance has been persisted. */
export async function linkWatchBookingRecipe(context: BrowserExecutionContext, recipe: BrowserRecipe): Promise<void> {
  if (
    recipe.readOnly ||
    recipe.sourceJobId !== context.job.id ||
    recipe.steps.at(-1)?.stopReason !== 'purchase_control'
  )
    return;
  const watches = await context.store.db.all<WatchRow>(
    "SELECT * FROM gws_ea_browser_watches WHERE job_id = ? AND site = ? AND status IN ('armed','checking','preparing','booked')",
    context.job.id,
    recipe.site,
  );
  for (const watch of watches) {
    const parameters = JSON.parse(watch.parameters_json) as Record<string, string>;
    if (
      JSON.stringify(Object.keys(parameters).sort()) !==
        JSON.stringify(recipe.parameters.map((entry) => entry.name).sort()) ||
      recipe.parameters.some((entry) => parameters[entry.name] !== entry.recordedValue)
    )
      continue;
    await context.store.db.run(
      'UPDATE gws_ea_browser_watches SET booking_recipe_id = ?,booking_recipe_version = ? WHERE id = ?',
      recipe.id,
      recipe.version,
      watch.id,
    );
    if (watch.status === 'booked') {
      const claim = await context.store.db.get<{ attempt_id: string }>(
        "SELECT attempt_id FROM gws_ea_browser_watch_job_claims WHERE job_id = ? AND watch_id = ? AND state = 'booked'",
        watch.job_id,
        watch.id,
      );
      if (claim)
        await promoteWatchRecipe(
          context.store.db,
          { ...watch, booking_recipe_id: recipe.id, booking_recipe_version: recipe.version },
          claim.attempt_id,
        );
    }
  }
}

interface WatchReleaseInput {
  schedule: WatchReleaseRule['schedule'];
  time: string;
  wording: string;
  /** The agent's reading of the venue's zone; the host's own read outranks it. */
  timeZone?: string;
}
interface WatchInput extends Record<string, unknown> {
  site: string;
  recipe_id: string;
  parameters: Record<string, string>;
  venue: { id: string; name: string };
  party_size: number;
  windows: Array<{ start: string; end: string }>;
  financial: { currency: string; max_total: string; terms: string };
  until: string;
  release?: WatchReleaseInput;
  /** On a site with no reader, the observation ref of the region that shows availability (KTD20). */
  region?: BrowserRef;
  /** A region watch to mark again, with the same bounds. */
  watch_id?: string;
}
function offsetInstant(value: unknown): string {
  const parsed = readIsoTime(value, 'required');
  if (!parsed) throw invalidArgs('Watch times need real ISO dates and times with explicit UTC offsets.');
  return parsed;
}
const RELEASE_FIELDS = ['wording', 'time', 'time_zone', 'days_ahead', 'day_of_month', 'months_ahead'];
const RELEASE_RULE =
  'A release rule needs the venue’s own wording, a time as HH:MM on its clock, and days_ahead, or day_of_month with months_ahead.';
const wholeBetween = (value: unknown, min: number, max: number): value is number =>
  Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
function validateRelease(raw: unknown): WatchReleaseInput {
  if (
    !isRecord(raw) ||
    Object.keys(raw).some((key) => !RELEASE_FIELDS.includes(key)) ||
    typeof raw.wording !== 'string' ||
    !raw.wording.trim() ||
    raw.wording.length > 500 ||
    typeof raw.time !== 'string' ||
    !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(raw.time)
  )
    throw invalidArgs(RELEASE_RULE);
  let schedule: WatchReleaseRule['schedule'];
  if (raw.day_of_month === undefined && raw.months_ahead === undefined && wholeBetween(raw.days_ahead, 0, 366))
    schedule = { kind: 'days_ahead', days: raw.days_ahead };
  else if (
    raw.days_ahead === undefined &&
    wholeBetween(raw.day_of_month, 1, 31) &&
    wholeBetween(raw.months_ahead, 0, 12)
  )
    schedule = { kind: 'monthly', day: raw.day_of_month, monthsAhead: raw.months_ahead };
  else throw invalidArgs(RELEASE_RULE);
  const timeZone = typeof raw.time_zone === 'string' ? ianaTimezone(raw.time_zone) : undefined;
  if (raw.time_zone !== undefined && !timeZone)
    throw invalidArgs('A release time_zone must be an IANA zone, such as Asia/Tokyo.');
  return { schedule, time: raw.time, wording: raw.wording.trim(), ...(timeZone ? { timeZone } : {}) };
}
/** The rule as stored: on the venue's zone as the host read it from the site, or else as the agent gave it. */
function watchReleaseRule(input: WatchReleaseInput, hostTimeZone: string | undefined): WatchReleaseRule | undefined {
  const timeZone = hostTimeZone ?? input.timeZone;
  return timeZone ? { schedule: input.schedule, time: input.time, timeZone, wording: input.wording } : undefined;
}
export function validateWatchRequest(raw: Record<string, unknown>): WatchInput {
  if (
    Object.keys(raw).some(
      (key) =>
        ![
          'action',
          'requestId',
          'site',
          'recipe_id',
          'parameters',
          'venue',
          'party_size',
          'windows',
          'financial',
          'until',
          'release',
          'region',
          'watch_id',
          'budget_ms',
        ].includes(key),
    )
  )
    throw invalidArgs('Unknown watch field.');
  if (
    typeof raw.site !== 'string' ||
    typeof raw.recipe_id !== 'string' ||
    !raw.recipe_id ||
    !isRecord(raw.parameters) ||
    Object.values(raw.parameters).some((value) => typeof value !== 'string') ||
    !isRecord(raw.venue) ||
    typeof raw.venue.id !== 'string' ||
    !raw.venue.id ||
    typeof raw.venue.name !== 'string' ||
    !raw.venue.name ||
    !Number.isSafeInteger(raw.party_size) ||
    Number(raw.party_size) < 1 ||
    !Array.isArray(raw.windows) ||
    !raw.windows.length ||
    !isRecord(raw.financial)
  )
    throw invalidArgs('A watch needs its recipe, exact venue, party, windows and financial bounds.');
  const financial = raw.financial;
  if (
    typeof financial.currency !== 'string' ||
    !/^[A-Z]{3}$/u.test(financial.currency) ||
    typeof financial.max_total !== 'string' ||
    amountMinor(financial.max_total, financial.currency) === undefined ||
    typeof financial.terms !== 'string' ||
    !financial.terms.trim()
  )
    throw invalidArgs('Financial bounds need a currency, exact nonnegative amount and terms.');
  try {
    if (new URL(raw.site).protocol !== 'https:') throw new Error('HTTPS required');
    browserSite(raw.site);
  } catch (_error) {
    throw invalidArgs('Watch site must be a public HTTPS URL.');
  }
  const windows = raw.windows.map((entry) => {
    if (!isRecord(entry)) throw invalidArgs('Each watch window needs start and end.');
    const start = offsetInstant(entry.start),
      end = offsetInstant(entry.end);
    if (start > end) throw invalidArgs('Watch window end must not precede its start.');
    return { start, end };
  });
  const until = offsetInstant(raw.until);
  if (until <= new Date().toISOString()) throw invalidArgs('Watch deadline has already passed.');
  const release = raw.release === undefined ? undefined : validateRelease(raw.release);
  const region =
    raw.region === undefined
      ? undefined
      : readBrowserRef(raw.region, 'region needs a ref and generation from the latest observation.');
  if (raw.watch_id !== undefined && (typeof raw.watch_id !== 'string' || !raw.watch_id || !region))
    throw invalidArgs('Marking a watch again needs its watch_id and a region.');
  return {
    site: raw.site,
    recipe_id: raw.recipe_id,
    parameters: raw.parameters as Record<string, string>,
    venue: { id: raw.venue.id, name: raw.venue.name },
    party_size: Number(raw.party_size),
    windows,
    financial: { currency: financial.currency, max_total: financial.max_total, terms: financial.terms },
    until,
    ...(release ? { release } : {}),
    ...(region ? { region } : {}),
    ...(typeof raw.watch_id === 'string' ? { watch_id: raw.watch_id } : {}),
  };
}
/** A queued watch keeps the agent's own fields: its execution reads them again, as the agent sent them. */
function validateQueuedWatch(raw: Record<string, unknown>): Record<string, unknown> {
  validateWatchRequest(raw);
  return Object.fromEntries(Object.entries(raw).filter(([key]) => !['action', 'requestId', 'budget_ms'].includes(key)));
}
/**
 * Whether the host reads a site's availability itself (Resy): its watches book through the reader, never a region.
 * The site's own home counts as well as the address given, so no other host name on it avoids the reader.
 */
function hasWatchReader(address: string, site: string): boolean {
  const urls = [new URL(address), new URL(`https://${site}/`)];
  return merchantSignatures.some(
    (signature) => signature.readAvailability !== undefined && urls.some((url) => signature.matches(url)),
  );
}
/** A region watch's bounds (KTD20): the venue by the name its site shows, and one maximum for every charge. */
function regionWatchBounds(input: WatchInput, site: string): WatchBounds {
  const maxTotalMinor = amountMinor(input.financial.max_total, input.financial.currency)!;
  return {
    kind: 'region',
    site,
    venue: input.venue,
    partySize: input.party_size,
    windows: input.windows,
    financial: {
      freeOnly: maxTotalMinor === 0,
      currency: input.financial.currency,
      maxTotalMinor,
      maxDueNowMinor: maxTotalMinor,
    },
    until: input.until,
  };
}
const watchSetupGuard = defineGuardedAction({
  action: 'gws_ea_browser.watch_setup',
  grantActionName: APPROVAL_ACTION,
  grantCoversRequest: (grant, input) => grant.payload === JSON.stringify(input.payload),
  async decide({ actor, payload }) {
    if (
      actor.kind !== 'agent' ||
      !actor.sessionId ||
      !(await readBrowserPolicy()).enabled ||
      typeof payload.watchId !== 'string'
    )
      return DENY('Only a live browser watch can request its setup approval.');
    const watch = await getBrowserWatch(payload.watchId);
    const job = watch
      ? await getDb().get<{ browser_session_id: string; cancelled: number; cancel_requested: number }>(
          'SELECT browser_session_id,cancelled,cancel_requested FROM gws_ea_browser_jobs WHERE id = ?',
          watch.job_id,
        )
      : undefined;
    if (
      !watch ||
      !job ||
      job.browser_session_id !== actor.sessionId ||
      job.cancelled ||
      job.cancel_requested ||
      !['awaiting_principal', 'armed'].includes(watch.status) ||
      Date.parse(boundsOf(watch).until) <= Date.now()
    )
      return DENY('This watch is no longer available.');
    const principal = await principalApproverUserId();
    return principal
      ? HOLD('The principal must authorize these exact reservation bounds.', principal)
      : DENY('No verified principal can approve the watch.');
  },
});
/** Arrival windows read on the venue's clock; conversions and the deadline on the principal's. */
export function renderWatchCard(watch: WatchRow, venueTimeZone: string, principalTimeZone: string): string {
  const bounds = boundsOf(watch),
    financial = bounds.financial;
  if (bounds.kind === 'region')
    return [
      'Approve one reservation across this errand’s watches, within these bounds:',
      `Site: ${quoted(watch.site, SELLER_TEXT_LIMIT)}`,
      `Venue: ${quoted(bounds.venue.name, SELLER_TEXT_LIMIT)}`,
      `Party size: ${bounds.partySize}`,
      ...bounds.windows.map(
        (window) => `Arrival window: ${cardEventSpan(window.start, window.end, venueTimeZone, principalTimeZone)}`,
      ),
      `Maximum total exposure, all guests and fees: ${formatMoney(financial.maxTotalMinor, financial.currency)} (${financial.currency})`,
      'A booking goes ahead without asking you again only when the site’s own checkout shows this venue, party and arrival window, with its total, amount due now and every fee within that maximum. Any other booking, a recurring charge included, comes to you on its own card.',
      `Watch deadline: ${cardTime(bounds.until, principalTimeZone)}`,
    ].join('\n');
  return [
    'Approve one reservation across this errand’s watches, within these bounds:',
    `Site: ${quoted(watch.site, SELLER_TEXT_LIMIT)}`,
    `Venue: ${quoted(bounds.venue.name, SELLER_TEXT_LIMIT)}; merchant identity ${quoted(bounds.venue.id, SELLER_TEXT_LIMIT)}`,
    `Party size: ${bounds.partySize}`,
    ...bounds.windows.map(
      (window) => `Arrival window: ${cardEventSpan(window.start, window.end, venueTimeZone, principalTimeZone)}`,
    ),
    `Maximum total exposure, all guests and fees: ${formatMoney(financial.maxTotalMinor, financial.currency)} (${financial.currency})`,
    `Maximum due now: ${formatMoney(financial.maxDueNowMinor, financial.currency)}`,
    ...financial.policy!.commitments.map(
      (term) =>
        `Merchant financial terms: ${quoted(term.terms, 1200)}; ${term.kind}; amount ${term.amountMinor === undefined ? 'unreadable' : formatMoney(term.amountMinor, financial.currency)}${term.perPerson ? ` per guest × ${bounds.partySize}` : ' total'}; trigger ${quoted(term.trigger ?? '', SELLER_TEXT_LIMIT)}; cancellation ${quoted(term.cancellationTerms ?? '', SELLER_TEXT_LIMIT)}${term.cancellationBeforeMs === undefined ? '' : `; cutoff ${term.cancellationBeforeMs / 60_000} minutes before arrival`}${term.frequency ? `; frequency ${quoted(term.frequency, SELLER_TEXT_LIMIT)}` : ''}${term.conversionAt ? `; converts ${cardTime(term.conversionAt, principalTimeZone)}` : ''}`,
    ),
    `Watch deadline: ${cardTime(bounds.until, principalTimeZone)}`,
  ].join('\n');
}
type PreparedWatch =
  | {
      status: 'ready';
      bounds: WatchBounds;
      release: WatchReleaseRule | undefined;
      /** The venue's clock for the card's arrival windows, when the host or the release rule names it. */
      venueTimeZone: string | undefined;
      region?: { locator: StructuredBrowserLocator; text: string };
    }
  | { status: 'refused'; reason: string };
/** A reader watch's bounds and release (Resy): the venue, its zone and its terms as the host reads them. */
async function prepareReaderWatch(
  context: BrowserExecutionContext,
  input: WatchInput,
  site: string,
): Promise<PreparedWatch> {
  if (input.region) return { status: 'refused', reason: 'site_has_reader' };
  const { readBrowserWatchSetup } = await import('./watch-runtime.js');
  const setup = await readBrowserWatchSetup(context, { site, venue: input.venue, partySize: input.party_size });
  if (
    !setup ||
    setup.availability.site !== site ||
    setup.availability.venue.id !== input.venue.id ||
    setup.availability.venue.name !== input.venue.name ||
    setup.availability.partySize !== input.party_size ||
    setup.availability.currency !== input.financial.currency
  )
    return { status: 'refused', reason: 'venue_unavailable' };
  const release = input.release && watchReleaseRule(input.release, setup.availability.timeZone);
  if (input.release && !release) return { status: 'refused', reason: 'release_zone_unknown' };
  const maxTotalMinor = amountMinor(input.financial.max_total, input.financial.currency)!;
  const freeOnly = maxTotalMinor === 0;
  const policy = setup.policy;
  if (!freeOnly) {
    const expectedTerms = policy?.commitments.map((term) => term.terms).join('; ');
    const exposure = policy ? financialExposure(policy.commitments, input.party_size) : Infinity;
    if (
      !policy ||
      policy.currency !== input.financial.currency ||
      !policy.commitments.length ||
      expectedTerms !== input.financial.terms ||
      !Number.isSafeInteger(policy.dueNowMinor) ||
      policy.dueNowMinor < 0 ||
      Math.max(exposure, policy.dueNowMinor) > maxTotalMinor ||
      policy.commitments.some(
        (term) =>
          !term.terms ||
          !Number.isSafeInteger(term.amountMinor) ||
          Number(term.amountMinor) < 0 ||
          !term.trigger ||
          !term.cancellationTerms ||
          !Number.isSafeInteger(term.cancellationBeforeMs) ||
          Number(term.cancellationBeforeMs) < 0,
      )
    )
      return { status: 'refused', reason: 'terms_unavailable' };
  }
  return {
    status: 'ready',
    bounds: {
      site,
      venue: setup.availability.venue,
      partySize: input.party_size,
      windows: input.windows,
      financial: {
        freeOnly,
        currency: input.financial.currency,
        maxTotalMinor,
        maxDueNowMinor: freeOnly ? 0 : policy!.dueNowMinor,
        ...(freeOnly ? {} : { policy }),
      },
      until: input.until,
    },
    release,
    venueTimeZone: setup.availability.timeZone,
  };
}
/**
 * A region watch on a site with no reader (KTD20): the recipe to the availability view, the region the agent marked
 * on it, and that region's normalized text as the baseline. Its release rule reads on the zone the agent gives.
 */
async function prepareRegionWatch(
  context: BrowserExecutionContext,
  input: WatchInput,
  site: string,
  recipe: BrowserRecipe,
): Promise<PreparedWatch> {
  if (!input.region) return { status: 'refused', reason: 'region_required' };
  const release = input.release && watchReleaseRule(input.release, undefined);
  if (input.release && !release) return { status: 'refused', reason: 'release_zone_unknown' };
  const { markWatchRegion } = await import('./watch-runtime.js');
  const mark = await markWatchRegion(context, input.region, recipe);
  if (mark.status === 'refused') return mark;
  return {
    status: 'ready',
    bounds: regionWatchBounds(input, site),
    release,
    venueTimeZone: release?.timeZone,
    region: { locator: mark.region, text: mark.text },
  };
}
/** The recipe a watch checks with: read-only, on the watch's site, taking exactly the watch's inputs. */
async function watchRecipe(input: WatchInput, site: string, db: DbDriver): Promise<BrowserRecipe | undefined> {
  const recipe = await loadRecipe(input.recipe_id, db);
  return recipe?.readOnly &&
    recipe.site === site &&
    JSON.stringify(recipe.parameters.map((entry) => entry.name).sort()) ===
      JSON.stringify(Object.keys(input.parameters).sort())
    ? recipe
    : undefined;
}
export async function createBrowserWatch(
  context: BrowserExecutionContext,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const input = validateWatchRequest(payload),
    db = context.store.db;
  if (input.watch_id) return markBrowserWatchAgain(context, input);
  const id = `watch-${digest(context.request.id)}`;
  const existing = await getBrowserWatch(id, db);
  if (existing)
    return {
      status: existing.status === 'awaiting_principal' ? 'awaiting_principal' : existing.status,
      watch_id: existing.id,
    };
  const site = browserSite(input.site);
  const recipe = await watchRecipe(input, site, db);
  if (!recipe) return { status: 'refused', reason: 'read_only_recipe_required' };
  const prepared = hasWatchReader(input.site, site)
    ? await prepareReaderWatch(context, input, site)
    : await prepareRegionWatch(context, input, site, recipe);
  if (prepared.status === 'refused') return prepared;
  const { bounds, release, region } = prepared;
  const freeOnly = bounds.financial.freeOnly;
  const at = new Date().toISOString();
  await db.transaction(async () => {
    const job = await context.store.getJob(context.job.id);
    const claim = await db.get<{ state: string }>(
      'SELECT state FROM gws_ea_browser_watch_job_claims WHERE job_id = ?',
      context.job.id,
    );
    if (!job || job.cancelled || (claim && claim.state !== 'available'))
      throw invalidArgs('This job cannot arm another booking watch.');
    await db.run(
      "INSERT INTO gws_ea_browser_watch_job_claims(job_id,state) VALUES(?,'available') ON CONFLICT(job_id) DO NOTHING",
      context.job.id,
    );
    await db.run(
      `INSERT INTO gws_ea_browser_watches(id,job_id,site,check_recipe_id,check_recipe_version,parameters_json,check_key,bounds_json,release_json,region_json,region_baseline,region_marked_at,status,created_at,updated_at,next_check_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      context.job.id,
      site,
      recipe.id,
      recipe.version,
      JSON.stringify(input.parameters),
      recipeCheckKey(recipe, input.parameters),
      JSON.stringify(bounds),
      release ? JSON.stringify(release) : null,
      region ? JSON.stringify(region.locator) : null,
      region?.text ?? null,
      region ? at : null,
      freeOnly ? 'armed' : 'awaiting_principal',
      at,
      at,
      at,
    );
    if (region) return;
    const links = await db.all<{ booking_recipe_id: string; booking_recipe_version: number }>(
      'SELECT * FROM gws_ea_browser_watch_recipe_links WHERE check_recipe_id = ? AND check_recipe_version = ? ORDER BY verified_at DESC',
      recipe.id,
      recipe.version,
    );
    for (const link of links) {
      const booking = await loadRecipe(link.booking_recipe_id, db);
      if (
        booking &&
        JSON.stringify(booking.parameters.map((entry) => entry.name).sort()) ===
          JSON.stringify(Object.keys(input.parameters).sort())
      ) {
        await db.run(
          'UPDATE gws_ea_browser_watches SET booking_recipe_id = ?,booking_recipe_version = ? WHERE id = ?',
          booking.id,
          booking.version,
          id,
        );
        break;
      }
    }
  });
  // The region's text is the page's, as the agent's own observation was.
  const marked = region ? { region: { untrusted: true, text: region.text } } : {};
  if (freeOnly) return { status: 'armed', watch_id: id, free_only: true, ...marked };
  const watch = (await getBrowserWatch(id, db))!;
  const approvalPayload = { watchId: id, jobId: watch.job_id, bounds: boundsOf(watch) };
  const decision = await guard(watchSetupGuard, {
    actor: { kind: 'agent', agentGroupId: context.session.agent_group_id, sessionId: context.session.id },
    payload: approvalPayload,
  });
  if (decision.effect !== 'hold') {
    await db.run("UPDATE gws_ea_browser_watches SET status = 'cancelled' WHERE id = ?", id);
    return { status: 'refused', reason: 'principal_unavailable' };
  }
  const principalTimeZone = await principalClock();
  const question = renderWatchCard(watch, prepared.venueTimeZone ?? principalTimeZone, principalTimeZone);
  const approvalId = await requestApproval({
    session: context.session,
    agentName: 'browser',
    action: APPROVAL_ACTION,
    payload: approvalPayload,
    title: 'Approve this reservation watch?',
    question,
    approverUserId: decision.approverUserId,
    expiresAt: bounds.until,
    originLine: ERRAND_ORIGIN_LINE,
  });
  if (approvalId) {
    const approval = await getPendingApproval(approvalId);
    await db.run(
      'UPDATE gws_ea_browser_watches SET approval_id = ?,approval_json = COALESCE(?,approval_json) WHERE id = ?',
      approvalId,
      approval ? JSON.stringify(approval) : null,
      id,
    );
  } else
    await db.run(
      "UPDATE gws_ea_browser_watches SET status = 'cancelled' WHERE id = ? AND status = 'awaiting_principal'",
      id,
    );
  return { status: approvalId ? 'awaiting_principal' : 'refused', watch_id: id, ...(approvalId ? marked : {}) };
}
/**
 * Marks a region watch's region again (KTD20) after the host could not find it, from a fresh observation of the view
 * its recipe reaches, with a new recipe when the route changed. Its bounds, approval and release stay; the new text is
 * its baseline, and it is checked again at once.
 */
async function markBrowserWatchAgain(
  context: BrowserExecutionContext,
  input: WatchInput,
): Promise<Record<string, unknown>> {
  const db = context.store.db;
  const watch = await getBrowserWatch(input.watch_id!, db);
  if (!watch || watch.job_id !== context.job.id) throw invalidArgs('This watch does not belong to the job.');
  if (!watch.region_json) return { status: 'refused', reason: 'site_has_reader', watch_id: watch.id };
  const markable = ['awaiting_principal', 'armed', 'checking'];
  if (!markable.includes(watch.status)) return { status: watch.status, watch_id: watch.id };
  const site = browserSite(input.site);
  if (JSON.stringify(regionWatchBounds(input, site)) !== watch.bounds_json)
    return { status: 'refused', reason: 'bounds_changed', watch_id: watch.id };
  const recipe = await watchRecipe(input, site, db);
  if (!recipe) return { status: 'refused', reason: 'read_only_recipe_required', watch_id: watch.id };
  const { markWatchRegion } = await import('./watch-runtime.js');
  const mark = await markWatchRegion(context, input.region!, recipe);
  if (mark.status === 'refused') return { ...mark, watch_id: watch.id };
  const at = new Date().toISOString();
  const marked = await db.run(
    `UPDATE gws_ea_browser_watches SET check_recipe_id = ?,check_recipe_version = ?,parameters_json = ?,check_key = ?,region_json = ?,region_baseline = ?,region_marked_at = ?,region_missing_since = NULL,next_check_at = ?,updated_at = ? WHERE id = ? AND status IN (${markable.map(() => '?').join(',')})`,
    recipe.id,
    recipe.version,
    JSON.stringify(input.parameters),
    recipeCheckKey(recipe, input.parameters),
    JSON.stringify(mark.region),
    mark.text,
    at,
    at,
    at,
    watch.id,
    ...markable,
  );
  if (!marked.changes) {
    const current = await getBrowserWatch(watch.id, db);
    return { status: current?.status ?? 'cancelled', watch_id: watch.id };
  }
  return { status: 'marked', watch_id: watch.id, region: { untrusted: true, text: mark.text } };
}

registerApprovalHandler(
  APPROVAL_ACTION,
  async ({ session, payload, approval, userId }) => {
    if (
      typeof payload.watchId !== 'string' ||
      !(await isVerifiedPrincipalUser(userId)) ||
      approval.approver_user_id !== userId
    )
      return;
    const decision = await guard(watchSetupGuard, {
      actor: { kind: 'agent', agentGroupId: session.agent_group_id, sessionId: session.id },
      payload,
      grant: approval,
    });
    if (decision.effect !== 'allow') return;
    await getDb().transaction(async () => {
      const watch = await getBrowserWatch(String(payload.watchId));
      if (
        !watch ||
        (watch.approval_id !== null && watch.approval_id !== approval.approval_id) ||
        JSON.stringify(payload.bounds) !== JSON.stringify(boundsOf(watch)) ||
        Date.parse(boundsOf(watch).until) <= Date.now()
      )
        return;
      const job = await getDb().get<{ cancelled: number; cancel_requested: number }>(
        'SELECT cancelled,cancel_requested FROM gws_ea_browser_jobs WHERE id = ?',
        watch.job_id,
      );
      if (!job || job.cancelled || job.cancel_requested) return;
      await getDb().run(
        "UPDATE gws_ea_browser_watches SET status = 'armed',approval_id = ?,approval_json = ?,updated_at = ? WHERE id = ? AND status IN ('awaiting_principal','armed')",
        approval.approval_id,
        JSON.stringify(approval),
        new Date().toISOString(),
        watch.id,
      );
    });
  },
  { restartSafe: true },
);
registerApprovalResolvedHandler(async ({ approval, outcome }) => {
  if (approval.action !== APPROVAL_ACTION || outcome === 'approve') return;
  const payload = JSON.parse(approval.payload) as { watchId?: string };
  if (payload.watchId)
    await getDb().run(
      "UPDATE gws_ea_browser_watches SET status = ?,updated_at = ? WHERE id = ? AND status = 'awaiting_principal'",
      outcome === 'expired' ? 'expired' : 'cancelled',
      new Date().toISOString(),
      payload.watchId,
    );
});

/** DB-only withdrawal used by cancellation and expiry; terminal card delivery follows commit. */
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
export async function recoverBrowserWatches(queue: BrowserQueue): Promise<void> {
  const db = queue.store.db;
  if (!(await db.hasTable('gws_ea_browser_watches'))) return;
  await db.transaction(async () => {
    await db.run(
      "UPDATE gws_ea_browser_watch_checks SET finished_at = ?,outcome = 'interrupted' WHERE finished_at IS NULL",
      new Date().toISOString(),
    );
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
  await expireBrowserWatches(db);
  await deliverWatchNotices(db);
}

export const watchAction: BrowserQueuedAction = { validate: validateQueuedWatch, execute: createBrowserWatch };
export const listWatchesAction: BrowserQueuedAction = {
  validate: () => ({}),
  async execute(context) {
    const watches = await context.store.db.all<WatchRow>(
      'SELECT * FROM gws_ea_browser_watches WHERE job_id = ? ORDER BY created_at,id',
      context.job.id,
    );
    const principalTimeZone = await principalClock();
    const now = Date.now();
    const listed: Array<Record<string, unknown>> = [];
    for (const watch of watches)
      listed.push({
        id: watch.id,
        status: watch.status,
        bounds: boundsOf(watch),
        release: watch.release_json ? (JSON.parse(watch.release_json) as WatchReleaseRule) : null,
        // An armed check also waits out the principal's night, on their clock as it is now, unless a release comes first.
        next_check_at:
          watch.status === 'armed'
            ? new Date(
                watchStartAt(
                  watchSitePolicy(watch.site),
                  Math.max(Date.parse(watch.next_check_at), now),
                  watchReleases(watch),
                  principalTimeZone,
                ),
              ).toISOString()
            : watch.next_check_at,
        // A region watch's mark: when it was made, whether the host still finds it, and the text it compares against.
        region: watch.region_json
          ? {
              marked_at: watch.region_marked_at,
              missing_since: watch.region_missing_since,
              wakes_this_hour: (await regionWakesThisHour(context.store.db, watch.id, now)).length,
              baseline: { untrusted: true, text: excerpt(watch.region_baseline ?? '') },
            }
          : null,
      });
    return { watches: listed };
  },
};
export const cancelWatchAction: BrowserQueuedAction = {
  validate(raw) {
    if (typeof raw.watch_id !== 'string') throw invalidArgs('watch_id is required');
    return { watch_id: raw.watch_id };
  },
  async execute(context, payload) {
    const watch = await getBrowserWatch(String(payload.watch_id), context.store.db);
    if (!watch || watch.job_id !== context.job.id) throw invalidArgs('This watch does not belong to the job.');
    if (watch.status === 'booking') return { status: 'in_progress', watch_id: watch.id };
    const withdrawn = await context.store.db.transaction(() =>
      detachBrowserWatchCards(watch.job_id, 'cancelled', watch.id),
    );
    for (const approval of withdrawn) await finishApprovalWithdrawal(approval, 'Withdrawn: this watch was cancelled.');
    for (const approval of withdrawn)
      await context.store.db.run(
        'UPDATE gws_ea_browser_watches SET approval_finished_at = ? WHERE approval_id = ?',
        new Date().toISOString(),
        approval.approval_id,
      );
    return { status: 'cancelled', watch_id: watch.id };
  },
};
export const watchBookAction: BrowserQueuedAction = {
  validate(raw) {
    if (typeof raw.watch_id !== 'string') throw invalidArgs('watch_id is required');
    return { watch_id: raw.watch_id };
  },
  async execute(context, payload) {
    const watch = await getBrowserWatch(String(payload.watch_id), context.store.db);
    if (
      !watch ||
      watch.job_id !== context.job.id ||
      !['armed', 'preparing'].includes(watch.status) ||
      !watch.booking_recipe_id
    )
      return { status: 'withdrawn' };
    await context.store.db.run(
      "UPDATE gws_ea_browser_watches SET status = 'preparing',pending_request_id = ? WHERE id = ? AND status = 'armed'",
      context.request.id,
      watch.id,
    );
    try {
      const result = await executeRecipe(context, {
        recipe_id: watch.booking_recipe_id,
        parameters: JSON.parse(watch.parameters_json) as Record<string, string>,
      });
      if (result.status !== 'reached_commit_point') {
        await context.store.db.run(
          "UPDATE gws_ea_browser_watches SET status = 'armed',pending_request_id = NULL WHERE id = ? AND status = 'preparing'",
          watch.id,
        );
        await emitWatchNotice(
          watch,
          'available',
          `recipe:${watch.booking_recipe_id}:${digest(JSON.stringify(result.expected))}`,
          { reason: 'booking_recipe_changed' },
        );
        return result;
      }
      const { executeBrowserPurchase } = await import('./purchase.js');
      const outcome = await executeBrowserPurchase(context, { target: result.target });
      return outcome;
    } finally {
      await context.store.db.run(
        "UPDATE gws_ea_browser_watches SET status = 'armed',pending_request_id = NULL WHERE id = ? AND status = 'preparing'",
        watch.id,
      );
    }
  },
};
