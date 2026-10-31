import type { Page } from 'playwright-core';
import { getSession } from '../../db/sessions.js';
import { isRecord } from '../../gws-ea/validation.js';
import { settleCookieBanners } from './cookie-banners.js';
import {
  BrowserRefError,
  invalidateBrowserRefs,
  disposeBrowserRefs,
  hasBrowserChallenge,
  pinBrowserRefs,
  type BrowserRef,
} from './observe.js';
import { collectSecretFields, redactPageText } from './page-privacy.js';
import { browserSite, type SiteLease } from './leases.js';
import { merchantSignatureFor } from './merchant-read.js';
import type { ReservationAvailability, ReservationPolicy } from './merchant-contract.js';
import { browserAvailability } from './availability.js';

import type { BrowserQueue } from './queue.js';
import type { BrowserExecutionContext, BrowserWatchExecutionContext } from './actions.js';
import { BrowserOperation } from './operation.js';
import { captureRecipeRegion, executeRecipe } from './recipes.js';
import { type BrowserRecipe } from './recipe-store.js';
import { locateStructured, type StructuredBrowserLocator } from './locators.js';
import type { BrowserWatchCheckInput, BrowserWatchCheckResult } from './scheduler.js';
import { withSignedOutBrowserPage } from './signed-out.js';
import { WATCH_REGION_TEXT_LIMIT } from './watch-policy.js';

const UNIT = String.raw`(?:d|days?|h|hrs?|hours?|m|mins?|minutes?|s|secs?|seconds?)`;
const DURATION = String.raw`(?:\d{1,2}:\d{2}(?::\d{2})?|\d+\s*${UNIT}\b(?:\s*,?\s*(?:and\s+)?\d+\s*${UNIT}\b)*)`;
const PEOPLE = String.raw`(?:people|persons?|others?|users?|guests?|diners?|visitors?|travell?ers?|shoppers?|customers?)`;
const SINCE = String.raw`(?:today|this\s+week|(?:in\s+)?the\s+(?:last|past)\s+\d+\s+(?:hours?|days?))`;
/**
 * Text in a region that changes on its own, never availability: stripped before the region is compared. A slot's own
 * time ("7:30 PM", "19:30") is availability and stays; a clock's is not.
 */
const VOLATILE_REGION_TEXT: Readonly<Record<string, RegExp>> = {
  /** A clock with seconds, which no slot shows: "19:42:13", "7:42:13 PM". */
  clockSeconds: /\b\d{1,2}:\d{2}:\d{2}(?:\s*[ap]\.?m\.?)?/giu,
  /** A clock reading the page's own time: "Updated 7:42 PM", "As of 19:42", "Local time 7 PM". */
  clockReading:
    /\b(?:as\s+of|(?:last\s+)?(?:updated|checked|refreshed|synced)(?:\s+at)?|(?:current|local)\s+time(?:\s+is)?|time\s+now|it(?:'|’)?s\s+now)\s*:?\s*\d{1,2}(?::\d{2}(?:\s*[ap]\.?m\.?)?|\s*[ap]\.?m\.?)/giu,
  /** A countdown: "ends in 04:59", "opens in 2h 13m", "12 minutes left". */
  countdown: new RegExp(
    String.raw`\b(?:(?:ends?|ending|closes?|closing|expires?|expiring|opens?|opening|releases?|starts?|starting|resets?|refreshes|updates?)\s+in\s+${DURATION}|${DURATION}\s+(?:left|remaining|to\s+go)\b)`,
    'giu',
  ),
  /** A relative time, with what it dates: "5 minutes ago", "Last checked an hour ago", "Updated just now". */
  relative: new RegExp(
    String.raw`\b(?:(?:last\s+)?(?:updated|checked|refreshed|synced)\s+)?(?:(?:\d+|an?|one|a\s+few)\s+${UNIT}\s+ago|just\s+now|moments?\s+ago)\b`,
    'giu',
  ),
  /** Who else is looking: "12 people viewing", "3 others are looking at this". */
  viewers: new RegExp(
    String.raw`\b\d[\d,]*\+?\s+(?:other\s+)?${PEOPLE}\s+(?:are\s+|is\s+)?(?:(?:currently|now|also|right\s+now)\s+)?(?:viewing|looking|watching|browsing|considering|searching)\b(?:\s+(?:at\s+)?(?:this|it)\b)?(?:\s+(?:right\s+)?now\b)?`,
    'giu',
  ),
  /** A running tally: "Booked 23 times today", "40 bookings in the last 24 hours". */
  tally: new RegExp(
    String.raw`\b(?:(?:booked|reserved|viewed|searched|ordered)\s+\d[\d,]*\+?\s+times?(?:\s+${SINCE})?|\d[\d,]*\+?\s+(?:bookings?|reservations?|views?|orders?)\s+${SINCE})\b`,
    'giu',
  ),
};
const SEPARATOR = '[·•|,;–—]';
const STRIPPED = '\u0000';
/** Each volatile pattern with the separator before it, so "7:30 PM · 12 people viewing" leaves "7:30 PM". */
const VOLATILE_SPANS = Object.values(VOLATILE_REGION_TEXT).map(
  (pattern) => new RegExp(`(?:\\s*${SEPARATOR})?\\s*(?:${pattern.source})`, pattern.flags),
);

/**
 * A region's accessibility snapshot as a watch compares it: its roles, names, states and text, without link addresses
 * (which carry sessions and cache keys) or volatile text. A line left with nothing but its role once its volatile text
 * is gone is dropped, so a counter that comes and goes changes nothing.
 */
export function normalizeWatchRegion(snapshot: string): string {
  const lines: string[] = [];
  for (const line of snapshot.split('\n')) {
    if (/^\s*- \/url:/u.test(line)) continue;
    let text = line;
    for (const span of VOLATILE_SPANS) text = text.replace(span, STRIPPED);
    if (text === line) {
      if (line.trim()) lines.push(line.trimEnd());
      continue;
    }
    const indent = /^\s*/u.exec(line)?.[0] ?? '';
    const body = text
      .slice(indent.length)
      .replaceAll(STRIPPED, ' ')
      .replace(new RegExp(`(:\\s*)${SEPARATOR}\\s*`, 'u'), '$1')
      .replace(new RegExp(`\\s*${SEPARATOR}\\s*$`, 'u'), '')
      .replace(/\s+/gu, ' ')
      .trim();
    if (body.replace(/^-\s*[a-z]+\b/u, '').replace(/[^\p{L}\p{N}]+/gu, '')) lines.push(`${indent}${body}`);
  }
  return lines.join('\n');
}

/** Undefined when the page no longer shows the region where `region` locates it. */
export async function readWatchRegion(
  page: Page,
  region: StructuredBrowserLocator,
  checkMainUrl = true,
): Promise<string | undefined> {
  await collectSecretFields(page);
  try {
    const target = await locateStructured(page, region, checkMainUrl);
    // Default snapshots replace Playwright's ref map too; failures must leave earlier model refs stale.
    invalidateBrowserRefs(page);
    return normalizeWatchRegion(redactPageText(page, await target.ariaSnapshot({ timeout: 1_000 })));
  } catch (error) {
    if (error instanceof Error) return undefined;
    throw error;
  }
}

export type WatchRegionMark =
  | { status: 'marked'; region: StructuredBrowserLocator; text: string }
  | { status: 'refused'; reason: 'stale_ref' | 'region_off_route' | 'region_unmarkable' | 'region_too_large' };

/**
 * The region the agent marked from an observation ref, on the page `recipe` reaches: its structured locator and its
 * normalized text, which becomes the watch's baseline. Nothing on the page is pressed.
 */
export async function markWatchRegion(
  context: BrowserExecutionContext,
  ref: BrowserRef,
  recipe: BrowserRecipe,
): Promise<WatchRegionMark> {
  await context.assertActive();
  const page = await context.page();
  let pinned;
  try {
    pinned = await pinBrowserRefs(page, [ref]);
  } catch (error) {
    if (error instanceof BrowserRefError) return { status: 'refused', reason: 'stale_ref' };
    throw error;
  }
  try {
    const target = pinned.get(ref.ref);
    const region = target ? await captureRecipeRegion(page, target, recipe) : undefined;
    if (region === 'off_route') return { status: 'refused', reason: 'region_off_route' };
    const text = region ? await readWatchRegion(page, region) : undefined;
    await context.assertActive();
    if (!region || !text) return { status: 'refused', reason: 'region_unmarkable' };
    if (text.length > WATCH_REGION_TEXT_LIMIT) return { status: 'refused', reason: 'region_too_large' };
    return { status: 'marked', region, text };
  } finally {
    await disposeBrowserRefs(pinned);
  }
}

export async function readBrowserWatchSetup(
  context: BrowserExecutionContext,
  expected: {
    site: string;
    venue: { id: string; name: string };
    partySize: number;
  },
): Promise<
  { availability: Extract<ReservationAvailability, { status: 'ready' }>; policy?: ReservationPolicy } | undefined
> {
  await context.assertActive();
  const page = await context.page();
  if (browserSite(page.url()) !== expected.site) return undefined;
  const signature = merchantSignatureFor(page);
  const availability = await signature?.readAvailability?.(page, {
    venueId: expected.venue.id,
    partySize: expected.partySize,
  });
  const policy = await signature?.readReservationPolicy?.(page, expected.venue.id);
  await context.assertActive();
  return availability?.status === 'ready' ? { availability, ...(policy ? { policy } : {}) } : undefined;
}

/** Only a real pending checkout permits a second, signed-out read on this exact site. */
async function pendingCheckout(queue: BrowserQueue, lease: SiteLease): Promise<boolean> {
  if (lease.state !== 'purchase') return false;
  const cards = await queue.store.db.all<{ facts_json: string }>(
    "SELECT facts_json FROM gws_ea_browser_purchase_cards WHERE job_id = ? AND status = 'open' AND expires_at > ?",
    lease.job_id,
    new Date().toISOString(),
  );
  return cards.some((card) => {
    const facts: unknown = JSON.parse(card.facts_json);
    return typeof facts === 'object' && facts !== null && 'site' in facts && facts.site === lease.site;
  });
}

export function watchCheckFailure(
  result: Record<string, unknown>,
): Exclude<BrowserWatchCheckResult, { status: 'ready' }> {
  const reason = result.reason ?? (isRecord(result.found) ? result.found.reason : undefined);
  if (reason === 'site_busy') return { status: 'site_busy' };
  const snapshot = isRecord(result.observation) ? result.observation.snapshot : undefined;
  return {
    status:
      reason === 'challenge' ||
      reason === 'blocked_address' ||
      reason === 'sign_in_wall' ||
      (typeof snapshot === 'string' && hasBrowserChallenge(snapshot))
        ? 'blocked'
        : 'failed',
  };
}

/** Whether a replay failed on the page's own structure (its heading, address or elements), not on a stop. */
function structuralFailure(result: Record<string, unknown>): boolean {
  return result.status === 'checkpoint_failed' && isRecord(result.found) && result.found.reason === undefined;
}

/**
 * A region check after its replay: the region's normalized text, or that the route to it or the region itself is gone.
 * A cookie banner left on the page, a challenge or an operational stop fails or blocks the check instead, so nothing
 * the site shows over the page asks the agent to mark it again.
 */
async function readRegionCheck(
  context: BrowserWatchExecutionContext,
  page: Page,
  region: StructuredBrowserLocator,
  result: Record<string, unknown>,
): Promise<BrowserWatchCheckResult> {
  const banner = await settleCookieBanners(page, {
    scope: { jobId: context.job.id, db: context.store.db },
    assertActive: context.assertActive,
    remaining: context.remaining,
  });
  const covered = banner !== undefined && banner.status !== 'rejected';
  if (result.status !== 'completed') {
    const failure = watchCheckFailure(result);
    return failure.status === 'failed' && !covered && structuralFailure(result)
      ? { status: 'region_missing', reason: 'route_changed' }
      : failure;
  }
  const snapshot = isRecord(result.observation) ? result.observation.snapshot : undefined;
  if (typeof snapshot === 'string' && hasBrowserChallenge(snapshot)) return { status: 'blocked' };
  // The replay checked the route; the region's own frames are checked as it is found.
  const text = await readWatchRegion(page, region, false);
  await context.assertActive();
  if (text !== undefined) return { status: 'region_read', text };
  return covered ? { status: 'failed' } : { status: 'region_missing', reason: 'region_not_found' };
}

/** Model-free: the check runs under its watch-check id and inserts no tool request of its own. */
export async function runBrowserWatchCheck(
  queue: BrowserQueue,
  input: BrowserWatchCheckInput,
  signal: AbortSignal,
): Promise<BrowserWatchCheckResult> {
  const db = queue.store.db;
  const initial = await db.get<SiteLease>('SELECT * FROM gws_ea_browser_site_leases WHERE site = ?', input.site);
  if (initial && initial.job_id !== input.jobId && !(await pendingCheckout(queue, initial)))
    return { status: 'site_busy' };
  const locked = await queue.tryWithJobLocks([input.jobId, ...(initial ? [initial.job_id] : [])], () =>
    queue.runtime.withActivity(async (): Promise<BrowserWatchCheckResult> => {
      const job = await queue.store.getJob(input.jobId);
      const session = job ? await getSession(job.browser_session_id) : undefined;
      if (!job || !session || session.status !== 'active') return { status: 'failed' };
      const operation = new BrowserOperation(Date.now() + 90_000, undefined, signal);
      let temporaryLease = false;
      const assertActive = async (): Promise<void> => {
        operation.assertActive();
        const current = await db.get<{ cancelled: number; cancel_requested: number }>(
          'SELECT cancelled,cancel_requested FROM gws_ea_browser_jobs WHERE id = ?',
          job.id,
        );
        const check = await db.get<{ finished_at: string | null }>(
          'SELECT finished_at FROM gws_ea_browser_watch_checks WHERE id = ?',
          input.id,
        );
        if (
          !current ||
          current.cancelled ||
          current.cancel_requested ||
          !check ||
          check.finished_at ||
          !(await browserAvailability()).available
        )
          throw new Error('Watch check is no longer active');
        operation.assertActive();
      };
      const siteAccess = async (url: URL): Promise<'ordinary' | 'site_busy' | 'blocked_address'> => {
        await assertActive();
        try {
          if (url.protocol !== 'https:' || browserSite(url.href) !== input.site) return 'blocked_address';
        } catch {
          return 'blocked_address';
        }
        const lease = await db.get<SiteLease>('SELECT * FROM gws_ea_browser_site_leases WHERE site = ?', input.site);
        if (lease) {
          if (lease.job_id === input.jobId) return 'ordinary';
          return initial?.job_id === lease.job_id && (await pendingCheckout(queue, lease)) ? 'ordinary' : 'site_busy';
        }
        const acquired = await queue.leases.acquire(input.jobId, url.href);
        temporaryLease ||= acquired.acquired;
        return acquired.acquired ? 'ordinary' : 'site_busy';
      };
      try {
        await assertActive();
        const outcome = await operation.run<BrowserWatchCheckResult>(async () =>
          withSignedOutBrowserPage(await queue.runtime.connection(), async (signedOut) => {
            operation.ownPage(signedOut);
            await assertActive();
            const context: BrowserWatchExecutionContext = {
              kind: 'watch_check',
              job,
              session,
              check: { id: input.id },
              store: queue.store,
              runtime: queue.runtime,
              signal: operation.signal,
              deadline: operation.deadline,
              page: async () => {
                await assertActive();
                return signedOut;
              },
              assertActive,
              remaining: operation.remaining,
              wakeWaiters: (ids, eventId) => queue.wakeWaiters(ids, eventId),
            };
            const result = await executeRecipe(
              context,
              { recipe_id: input.recipeId, parameters: input.parameters },
              { page: signedOut, record: false, readOnly: true, siteAccess },
            );
            if (input.region) return readRegionCheck(context, signedOut, input.region, result);
            if (result.status !== 'completed') return watchCheckFailure(result);
            const availability = await merchantSignatureFor(signedOut)?.readAvailability?.(signedOut, {
              venueId: input.venueId,
              partySize: input.partySize,
            });
            await assertActive();
            return availability?.status === 'ready'
              ? { status: 'ready', availability }
              : { status: availability?.status === 'blocked' ? 'blocked' : 'failed' };
          }),
        );
        return 'value' in outcome ? outcome.value : { status: 'failed' };
      } catch {
        return { status: 'failed' };
      } finally {
        await operation.finish();
        if (temporaryLease)
          await queue.wakeWaiters(await queue.leases.release(input.jobId, input.site), `watch-check-${input.id}`);
      }
    }),
  );
  return locked.acquired ? locked.value : { status: 'site_busy' };
}
