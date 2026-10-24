import { noVerifiedPrincipalMessage } from '../gws-ea-profile/approval-wording.js';
import { observePage } from './observe.js';
import { markWatchRegion, readBrowserWatchSetup } from './watch-runtime.js';
import { executeBrowserPurchase } from './purchase.js';
import {
  type WatchBounds,
  type WatchRow,
  APPROVAL_ACTION,
  boundsOf,
  financialExposure,
  getBrowserWatch,
  watchReleases,
  emitWatchNotice,
  insertWatchNotice,
  deliverWatchNotices,
  regionWakesThisHour,
  excerpt,
  detachBrowserWatchCards,
  watchDigest,
} from './watch-state.js';
import { invalidArgs } from '../../cli/delivery-action.js';
import { getDb } from '../../db/connection.js';
import type { DbDriver } from '../../db/driver.js';
import { getPendingApproval } from '../../db/sessions.js';
import { DENY, HOLD, defineGuardedAction, guard } from '../../guard/index.js';
import { log } from '../../log.js';
import { isRecord } from '../../gws-ea/validation.js';
import { ianaTimezone } from '../../timezone.js';
import { finishApprovalWithdrawal, registerApprovalHandler, requestApproval } from '../approvals/index.js';
import { registerApprovalResolvedHandler, type ApprovalResolvedEvent } from '../approvals/primitive.js';
import { isVerifiedPrincipalUser, principalApproverUserId } from '../gws-ea-profile/db.js';
import { readIsoTime } from './iso-time.js';
import { ERRAND_ORIGIN_LINE } from './cards.js';
import { browserSite } from './leases.js';
import { amountMinor } from './fingerprint.js';
import { merchantSignatures } from './merchant-signatures.js';
import { readBrowserRef, type BrowserRef } from './observe.js';
import { browserDelegators, readHostBrowserPolicy } from './access.js';
import { executeRecipe } from './recipes.js';
import { loadRecipe, recipeCheckKey, type BrowserRecipe } from './recipe-store.js';
import { type StructuredBrowserLocator } from './locators.js';
import type { BrowserExecutionContext, BrowserQueuedAction } from './actions.js';
import { principalClock, watchSitePolicy, watchStartAt, type WatchReleaseRule } from './watch-policy.js';
import {
  renderWatchCard,
  termsOverBounds,
  watchMessage,
  rejectedWatchMessage,
  watchCardTitle,
  watchCardWithdrawal,
} from './watch-wording.js';

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
  financial: { currency: string; max_total: string };
  until: string;
  release?: WatchReleaseInput;
  /** On a site with no reader, the observation ref of the region that shows availability (KTD20). */
  region?: BrowserRef;
  /** A region watch to mark again, with the same bounds. */
  watch_id?: string;
}
function offsetInstant(value: unknown): string {
  const parsed = readIsoTime(value, 'required');
  if (!parsed) throw invalidArgs(watchMessage('times'));
  return parsed;
}
const RELEASE_FIELDS = ['wording', 'time', 'time_zone', 'days_ahead', 'day_of_month', 'months_ahead'];
const RELEASE_RULE = watchMessage('release');
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
  if (raw.time_zone !== undefined && !timeZone) throw invalidArgs(watchMessage('releaseZone'));
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
    throw invalidArgs(watchMessage('unknownField'));
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
    throw invalidArgs(watchMessage('required'));
  const financial = raw.financial;
  if (
    typeof financial.currency !== 'string' ||
    !/^[A-Z]{3}$/u.test(financial.currency) ||
    typeof financial.max_total !== 'string' ||
    amountMinor(financial.max_total, financial.currency) === undefined
  )
    throw invalidArgs(watchMessage('financial'));
  try {
    if (new URL(raw.site).protocol !== 'https:') throw new Error(watchMessage('https'));
    browserSite(raw.site);
  } catch (_error) {
    throw invalidArgs(watchMessage('site'));
  }
  const windows = raw.windows.map((entry) => {
    if (!isRecord(entry)) throw invalidArgs(watchMessage('window'));
    const start = offsetInstant(entry.start),
      end = offsetInstant(entry.end);
    if (start > end) throw invalidArgs(watchMessage('windowOrder'));
    return { start, end };
  });
  const until = offsetInstant(raw.until);
  if (until <= new Date().toISOString()) throw invalidArgs(watchMessage('deadline'));
  const release = raw.release === undefined ? undefined : validateRelease(raw.release);
  const region = raw.region === undefined ? undefined : readBrowserRef(raw.region, watchMessage('region'));
  if (raw.watch_id !== undefined && (typeof raw.watch_id !== 'string' || !raw.watch_id || !region))
    throw invalidArgs(watchMessage('mark'));
  return {
    site: raw.site,
    recipe_id: raw.recipe_id,
    parameters: raw.parameters as Record<string, string>,
    venue: { id: raw.venue.id, name: raw.venue.name },
    party_size: Number(raw.party_size),
    windows,
    financial: { currency: financial.currency, max_total: financial.max_total },
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
      !(await readHostBrowserPolicy()).enabled ||
      typeof payload.watchId !== 'string'
    )
      return DENY(watchMessage('live'));
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
      return DENY(watchMessage('unavailable'));
    const principal = await principalApproverUserId();
    return principal ? HOLD(watchMessage('principalBounds'), principal) : DENY(noVerifiedPrincipalMessage());
  },
});
type PreparedWatch =
  | {
      status: 'ready';
      bounds: WatchBounds;
      release: WatchReleaseRule | undefined;
      /** The venue's clock for the card's arrival windows, when the host or the release rule names it. */
      venueTimeZone: string | undefined;
      region?: { locator: StructuredBrowserLocator; text: string };
    }
  | { status: 'refused'; reason: string; exposure?: string; max_total?: string; message?: string };
/** A reader watch's bounds and release (Resy): the venue, its zone and its terms as the host reads them. */
async function prepareReaderWatch(
  context: BrowserExecutionContext,
  input: WatchInput,
  site: string,
): Promise<PreparedWatch> {
  if (input.region) return { status: 'refused', reason: 'site_has_reader' };
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
    // The host reads the venue's terms itself: the card shows them, and the principal's maximum bounds them.
    if (
      !policy ||
      policy.currency !== input.financial.currency ||
      !policy.commitments.length ||
      !Number.isSafeInteger(policy.dueNowMinor) ||
      policy.dueNowMinor < 0 ||
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
    const exposure = Math.max(financialExposure(policy.commitments, input.party_size), policy.dueNowMinor);
    if (exposure > maxTotalMinor) return termsOverBounds(site, policy, exposure, maxTotalMinor, input.party_size);
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
  const id = `watch-${watchDigest(context.request.id)}`;
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
    if (!job || job.cancelled || (claim && claim.state !== 'available')) throw invalidArgs(watchMessage('cannotArm'));
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
    title: watchCardTitle(),
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
  if (!watch || watch.job_id !== context.job.id) throw invalidArgs(watchMessage('belongs'));
  if (!watch.region_json) return { status: 'refused', reason: 'site_has_reader', watch_id: watch.id };
  const markable = ['awaiting_principal', 'armed', 'checking'];
  if (!markable.includes(watch.status)) return { status: watch.status, watch_id: watch.id };
  const site = browserSite(input.site);
  if (JSON.stringify(regionWatchBounds(input, site)) !== watch.bounds_json)
    return { status: 'refused', reason: 'bounds_changed', watch_id: watch.id };
  const recipe = await watchRecipe(input, site, db);
  if (!recipe) return { status: 'refused', reason: 'read_only_recipe_required', watch_id: watch.id };
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
  {
    restartSafe: true,
    rejectionNote: () => null,
    finalizeRejection: settleWatchOutcome,
  },
);
async function settleWatchOutcome({ approval, outcome, reason }: ApprovalResolvedEvent): Promise<void> {
  if (approval.action !== APPROVAL_ACTION || outcome === 'approve') return;
  const payload = JSON.parse(approval.payload) as { watchId?: unknown; jobId?: unknown };
  if (typeof payload.watchId !== 'string') return;
  const watchId = payload.watchId;
  const db = getDb();
  // Read the delegators' names before the transaction: the policy file is no part of it. A name is
  // only wording, so a failed read leaves the notice addressed to the agent that sent the errand.
  const delegators =
    outcome === 'reject'
      ? await browserDelegators().catch((error: unknown) => {
          log.warn('A declined watch names no delegator: the browser policy could not be read', { error });
          return [];
        })
      : [];
  await db.transaction(async () => {
    const watch = await getBrowserWatch(watchId, db);
    const status = outcome === 'expired' ? 'expired' : 'cancelled';
    if (
      !watch ||
      watch.job_id !== payload.jobId ||
      (watch.approval_id !== null && watch.approval_id !== approval.approval_id) ||
      (watch.status !== 'awaiting_principal' && watch.status !== status)
    )
      return;
    // The card already shows its outcome, so the ended watch never withdraws it again.
    const at = new Date().toISOString();
    await db.run(
      'UPDATE gws_ea_browser_watches SET status = ?,approval_finished_at = COALESCE(approval_finished_at, ?),updated_at = ? WHERE id = ?',
      status,
      at,
      at,
      watch.id,
    );
    if (outcome === 'reject') {
      const job = await db.get<{ source_agent_group_id: string }>(
        'SELECT source_agent_group_id FROM gws_ea_browser_jobs WHERE id = ?',
        watch.job_id,
      );
      const delegator = delegators.find((entry) => entry.agentGroupId === job?.source_agent_group_id);
      await insertWatchNotice(db, watch, 'rejected', 'rejected', {
        message: rejectedWatchMessage(delegator?.name, reason),
      });
    }
  });
  if (outcome === 'reject') await deliverWatchNotices(db);
}

registerApprovalResolvedHandler(async (event) => {
  if (event.outcome !== 'reject') await settleWatchOutcome(event);
});

export const watchAction: BrowserQueuedAction = {
  validate: validateQueuedWatch,
  async execute(context, payload) {
    const result = await createBrowserWatch(context, payload);
    // Region marking needs its own default snapshot for the durable baseline. Return a current core view
    // after it so the next model action never targets the replaced native ref map.
    return result.region
      ? {
          ...result,
          observation: await observePage(await context.page(), context.assertActive, {
            remaining: context.remaining,
            signal: context.signal,
          }),
        }
      : result;
  },
};
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
    if (typeof raw.watch_id !== 'string') throw invalidArgs(watchMessage('watchId'));
    return { watch_id: raw.watch_id };
  },
  async execute(context, payload) {
    const watch = await getBrowserWatch(String(payload.watch_id), context.store.db);
    if (!watch || watch.job_id !== context.job.id) throw invalidArgs(watchMessage('belongs'));
    if (watch.status === 'booking') return { status: 'in_progress', watch_id: watch.id };
    const withdrawn = await context.store.db.transaction(() =>
      detachBrowserWatchCards(watch.job_id, 'cancelled', watch.id),
    );
    for (const approval of withdrawn) await finishApprovalWithdrawal(approval, watchCardWithdrawal());
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
    if (typeof raw.watch_id !== 'string') throw invalidArgs(watchMessage('watchId'));
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
          `recipe:${watch.booking_recipe_id}:${watchDigest(JSON.stringify(result.expected))}`,
          { reason: 'booking_recipe_changed' },
        );
        return result;
      }
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
