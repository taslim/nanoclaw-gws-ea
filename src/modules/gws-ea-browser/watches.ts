import { createHash } from 'node:crypto';
import { TIMEZONE } from '../../config.js';
import { invalidArgs } from '../../cli/delivery-action.js';
import { getDb } from '../../db/connection.js';
import type { DbDriver } from '../../db/driver.js';
import { isUniqueViolation } from '../../db/errors.js';
import { getPendingApproval, getSession } from '../../db/sessions.js';
import { DENY, HOLD, defineGuardedAction, guard } from '../../guard/index.js';
import { isRecord } from '../../gws-ea/validation.js';
import { requestWake } from '../../request-wake.js';
import { writeSessionMessage } from '../../session-manager.js';
import { formatLocalTime } from '../../timezone.js';
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
import { PurchaseAuthorityStore, type SpendingAuthority } from './authority.js';
import { quotePurchaseText } from './cards.js';
import { browserSite } from './leases.js';
import {
  amountMinor,
  completePurchaseFacts,
  formatMoney,
  materialPurchaseChange,
  type PurchaseBounds,
  type PurchaseFacts,
  type ReservationFacts,
} from './fingerprint.js';
import type { ReservationPolicy } from './merchant-contract.js';
import { readBrowserPolicy } from './policy.js';
import { loadRecipe, recipeCheckKey, executeRecipe, type BrowserRecipe } from './recipes.js';
import { registerBrowserQueuedAction, type BrowserExecutionContext, type BrowserQueue } from './queue.js';

export interface WatchFinancialBounds {
  freeOnly: boolean;
  currency: string;
  maxTotalMinor: number;
  maxDueNowMinor: number;
  policy?: ReservationPolicy;
}
export interface WatchBounds {
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

/** Start windows constrain arrival; the full host-read duration is checked against the calendar. */
export function compareWatchBounds(bounds: WatchBounds, facts: PurchaseFacts, now: string): WatchBoundResult {
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
  const exposure = facts.commitments.reduce(
    (sum, term) => sum + (term.amountMinor ?? Infinity) * (term.perPerson ? slot.partySize : 1),
    0,
  );
  if (Math.max(facts.totalMinor, exposure) > financial.maxTotalMinor || facts.dueNowMinor > financial.maxDueNowMinor)
    return refuse('financial_limit');
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
  if (
    compareWatchBounds(boundsOf(watch), input.facts, input.at).status !== 'within_bounds' ||
    watchSlotKey(input.facts.reservation!) !== watchSlotKey(input.calendarCheckedReservation) ||
    input.facts.reservation!.venueName !== input.calendarCheckedReservation.venueName
  )
    throw new Error('Watch bounds or calendar-checked slot changed');
  await db.run(
    'INSERT INTO gws_ea_browser_watch_slot_claims(site,slot_key,job_id,watch_id,attempt_id) VALUES(?,?,?,?,?)',
    watch.site,
    watchSlotKey(input.facts.reservation!),
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

/** Called inside authority.conclude's transaction; common purchase notification owns its terminal message. */
export async function finishWatchPurchase(
  db: DbDriver,
  watchId: string,
  attemptId: string,
  outcome: Record<string, unknown>,
): Promise<void> {
  const watch = await getBrowserWatch(watchId, db);
  if (!watch) return;
  const at = new Date().toISOString();
  const certain = outcome.status === 'booked' || outcome.status === 'placed';
  const updated = await db.run(
    `UPDATE gws_ea_browser_watch_job_claims SET state = ?,finished_at = ? WHERE job_id = ? AND watch_id = ? AND attempt_id = ? AND state = 'committing'`,
    certain ? 'booked' : 'unknown',
    at,
    watch.job_id,
    watchId,
    attemptId,
  );
  if (!updated.changes) return;
  await db.run(
    'UPDATE gws_ea_browser_watches SET status = ?,updated_at = ?,pending_request_id = NULL WHERE id = ?',
    certain ? 'booked' : 'outcome_unknown',
    at,
    watchId,
  );
  await detachBrowserWatchCards(watch.job_id, 'cancelled', undefined, db);
  await db.run(
    "UPDATE gws_ea_browser_authorities SET state = 'revoked' WHERE job_id = ? AND kind = 'watch' AND state = 'live'",
    watch.job_id,
  );
  if (certain) await promoteWatchRecipe(db, watch, attemptId);
}

export async function emitWatchNotice(
  watch: WatchRow,
  status: string,
  eventKey: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  const db = getDb();
  await db.run(
    `INSERT INTO gws_ea_browser_watch_notices(watch_id,event_key,outcome_json,created_at) VALUES(?,?,?,?) ON CONFLICT(watch_id,event_key) DO NOTHING`,
    watch.id,
    eventKey,
    JSON.stringify({ type: 'browser_watch_outcome', job: watch.job_id, watch_id: watch.id, status, ...details }),
    new Date().toISOString(),
  );
  await deliverWatchNotices(db);
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
      await writeSessionMessage(session.agent_group_id, session.id, {
        id: `browser-watch-${digest(`${notice.watch_id}\0${notice.event_key}`)}`,
        kind: 'system',
        timestamp: new Date().toISOString(),
        trigger: true,
        content: notice.outcome_json,
      });
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
  if (!facts.reservation) return { status: 'outside_bounds', watchId: watch.id };
  let status: 'calendar_conflict' | 'calendar_unavailable' | undefined;
  try {
    const result = await findPrincipalCalendarConflicts(facts.reservation.at, facts.reservation.endAt);
    if (result.conflicts.length || result.conflicts_not_listed) status = 'calendar_conflict';
    // eslint-disable-next-line no-catch-all/no-catch-all -- Missing access, fetch failures and unreadable calendar data all fail closed.
  } catch (_error) {
    status = 'calendar_unavailable';
  }
  if (status) {
    await emitWatchNotice(watch, status, `${status}:${digest(JSON.stringify(facts.reservation))}`);
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
    for (const candidate of active)
      await emitWatchNotice(candidate, 'outside_bounds', `outside:${digest(JSON.stringify(facts.reservation))}`);
    return { status: 'outside_bounds', watchId: watches[0].id };
  }
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
  const window = bounds.windows.find(
    (entry) =>
      Date.parse(facts.reservation!.at) >= Date.parse(entry.start) &&
      Date.parse(facts.reservation!.at) <= Date.parse(entry.end),
  );
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
        venueId: bounds.venue.id,
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
  const checked = facts.reservation!;
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

interface WatchInput extends Record<string, unknown> {
  site: string;
  recipe_id: string;
  parameters: Record<string, string>;
  venue: { id: string; name: string };
  party_size: number;
  windows: Array<{ start: string; end: string }>;
  financial: { currency: string; max_total: string; terms: string };
  until: string;
}
function offsetInstant(value: unknown): string {
  if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/u.test(value) || !Number.isFinite(Date.parse(value)))
    throw invalidArgs('Watch times need explicit UTC offsets.');
  return new Date(value).toISOString();
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
  return {
    site: raw.site,
    recipe_id: raw.recipe_id,
    parameters: raw.parameters as Record<string, string>,
    venue: { id: raw.venue.id, name: raw.venue.name },
    party_size: Number(raw.party_size),
    windows,
    financial: { currency: financial.currency, max_total: financial.max_total, terms: financial.terms },
    until,
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
function renderWatchCard(watch: WatchRow): string {
  const bounds = boundsOf(watch),
    financial = bounds.financial;
  return [
    'Approve one reservation across this errand’s watches, within these bounds:',
    `Site: ${quotePurchaseText(watch.site)}`,
    `Venue: ${quotePurchaseText(bounds.venue.name)}; merchant identity ${quotePurchaseText(bounds.venue.id)}`,
    `Party size: ${bounds.partySize}`,
    ...bounds.windows.map(
      (window) =>
        `Arrival window: ${formatLocalTime(window.start, TIMEZONE)} through ${formatLocalTime(window.end, TIMEZONE)}`,
    ),
    `Maximum total exposure, all guests and fees: ${formatMoney(financial.maxTotalMinor, financial.currency)} (${financial.currency})`,
    `Maximum due now: ${formatMoney(financial.maxDueNowMinor, financial.currency)}`,
    ...financial.policy!.commitments.map(
      (term) =>
        `Merchant financial terms: ${quotePurchaseText(term.terms, 1200)}; ${term.kind}; amount ${term.amountMinor === undefined ? 'unreadable' : formatMoney(term.amountMinor, financial.currency)}${term.perPerson ? ` per guest × ${bounds.partySize}` : ' total'}; trigger ${quotePurchaseText(term.trigger ?? '')}; cancellation ${quotePurchaseText(term.cancellationTerms ?? '')}${term.cancellationBeforeMs === undefined ? '' : `; cutoff ${term.cancellationBeforeMs / 60_000} minutes before arrival`}${term.frequency ? `; frequency ${quotePurchaseText(term.frequency)}` : ''}${term.conversionAt ? `; converts ${term.conversionAt}` : ''}`,
    ),
    `Watch deadline: ${formatLocalTime(bounds.until, TIMEZONE)}`,
  ].join('\n');
}
export async function createBrowserWatch(
  context: BrowserExecutionContext,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const input = validateWatchRequest(payload),
    db = context.store.db;
  const id = `watch-${digest(context.request.id)}`;
  const existing = await getBrowserWatch(id, db);
  if (existing)
    return {
      status: existing.status === 'awaiting_principal' ? 'awaiting_principal' : existing.status,
      watch_id: existing.id,
    };
  const recipe = await loadRecipe(input.recipe_id, db),
    site = browserSite(input.site);
  if (
    !recipe?.readOnly ||
    recipe.site !== site ||
    JSON.stringify(recipe.parameters.map((entry) => entry.name).sort()) !==
      JSON.stringify(Object.keys(input.parameters).sort())
  )
    return { status: 'refused', reason: 'read_only_recipe_required' };
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
  const maxTotalMinor = amountMinor(input.financial.max_total, input.financial.currency)!;
  const freeOnly = maxTotalMinor === 0;
  const policy = setup.policy;
  if (!freeOnly) {
    const expectedTerms = policy?.commitments.map((term) => term.terms).join('; ');
    const exposure =
      policy?.commitments.reduce(
        (sum, term) => sum + (term.amountMinor ?? Infinity) * (term.perPerson ? input.party_size : 1),
        0,
      ) ?? Infinity;
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
  const bounds: WatchBounds = {
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
  };
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
      `INSERT INTO gws_ea_browser_watches(id,job_id,site,check_recipe_id,check_recipe_version,parameters_json,check_key,bounds_json,status,created_at,updated_at,next_check_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      context.job.id,
      site,
      recipe.id,
      recipe.version,
      JSON.stringify(input.parameters),
      recipeCheckKey(recipe, input.parameters),
      JSON.stringify(bounds),
      freeOnly ? 'armed' : 'awaiting_principal',
      at,
      at,
      at,
    );
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
  if (freeOnly) return { status: 'armed', watch_id: id, free_only: true };
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
  const approvalId = await requestApproval({
    session: context.session,
    agentName: 'browser',
    action: APPROVAL_ACTION,
    payload: approvalPayload,
    title: 'Approve this reservation watch?',
    question: renderWatchCard(watch),
    approverUserId: decision.approverUserId,
    expiresAt: bounds.until,
    originLine: `From your browser errand ${context.job.thread_id}.`,
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
  return { status: approvalId ? 'awaiting_principal' : 'refused', watch_id: id };
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

registerBrowserQueuedAction('watch', { validate: validateWatchRequest, execute: createBrowserWatch });
registerBrowserQueuedAction('list_watches', {
  validate: () => ({}),
  async execute(context) {
    const watches = await context.store.db.all<WatchRow>(
      'SELECT * FROM gws_ea_browser_watches WHERE job_id = ? ORDER BY created_at,id',
      context.job.id,
    );
    return {
      watches: watches.map((watch) => ({
        id: watch.id,
        status: watch.status,
        bounds: boundsOf(watch),
        next_check_at: watch.next_check_at,
      })),
    };
  },
});
registerBrowserQueuedAction('cancel_watch', {
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
});
registerBrowserQueuedAction('browser_watch_book', {
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
});
