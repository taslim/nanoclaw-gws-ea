import type { Page } from 'playwright-core';
import { getSession } from '../../db/sessions.js';
import { isRecord } from '../../gws-ea/validation.js';
import { hasBrowserChallenge } from './observe.js';
import { browserSite, type SiteLease } from './leases.js';
import { merchantSignatureFor } from './merchant-signatures.js';
import type { ReservationAvailability, ReservationPolicy } from './merchant-contract.js';
import { readBrowserPolicy } from './policy.js';
import type { BrowserExecutionContext, BrowserQueue } from './queue.js';
import { executeRecipe } from './recipes.js';
import type { BrowserWatchCheckInput, BrowserWatchCheckResult } from './scheduler.js';
import { withSignedOutBrowserPage } from './signed-out.js';

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

/** Model-free checks retain native check provenance and never insert fictional tool requests. */
export async function runBrowserWatchCheck(
  queue: BrowserQueue,
  input: BrowserWatchCheckInput,
  signal: AbortSignal,
): Promise<BrowserWatchCheckResult> {
  const db = queue.store.db;
  const initial = await db.get<SiteLease>('SELECT * FROM gws_ea_browser_site_leases WHERE site = ?', input.site);
  if (initial && initial.job_id !== input.jobId && !(await pendingCheckout(queue, initial)))
    return { status: 'site_busy' };
  const locked = await queue.tryWithJobLocks(
    [input.jobId, ...(initial ? [initial.job_id] : [])],
    async (): Promise<BrowserWatchCheckResult> => {
      const job = await queue.store.getJob(input.jobId);
      const session = job ? await getSession(job.browser_session_id) : undefined;
      if (!job || !session || session.status !== 'active') return { status: 'failed' };
      const controller = new AbortController();
      const deadline = Date.now() + 90_000;
      const abort = (): void => controller.abort();
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      const timer = setTimeout(abort, 90_000);
      timer.unref();
      let page: Page | undefined;
      let temporaryLease = false;
      const assertActive = async (): Promise<void> => {
        const current = await db.get<{ cancelled: number; cancel_requested: number }>(
          'SELECT cancelled,cancel_requested FROM gws_ea_browser_jobs WHERE id = ?',
          job.id,
        );
        const check = await db.get<{ finished_at: string | null }>(
          'SELECT finished_at FROM gws_ea_browser_watch_checks WHERE id = ?',
          input.id,
        );
        if (
          controller.signal.aborted ||
          Date.now() >= deadline ||
          !current ||
          current.cancelled ||
          current.cancel_requested ||
          !check ||
          check.finished_at ||
          !(await readBrowserPolicy()).enabled
        )
          throw new Error('Watch check is no longer active');
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
        return await withSignedOutBrowserPage(await queue.runtime.connection(), async (signedOut) => {
          page = signedOut;
          controller.signal.addEventListener(
            'abort',
            () => {
              void signedOut.close().catch(() => undefined);
            },
            { once: true },
          );
          await assertActive();
          const context: BrowserExecutionContext = {
            job,
            session,
            request: { id: input.id },
            store: queue.store,
            runtime: queue.runtime,
            signal: controller.signal,
            deadline,
            page: async () => {
              await assertActive();
              return signedOut;
            },
            assertActive,
            remaining: () => Math.max(0, deadline - Date.now()),
            wakeWaiters: (ids, eventId) => queue.wakeWaiters(ids, eventId),
            markCommitStarted: async () => {
              throw new Error('A signed-out availability check cannot commit');
            },
          };
          const result = await executeRecipe(
            context,
            { recipe_id: input.recipeId, parameters: input.parameters },
            { page: signedOut, record: false, readOnly: true, siteAccess },
          );
          if (result.status !== 'completed') return watchCheckFailure(result);
          const availability = await merchantSignatureFor(signedOut)?.readAvailability?.(signedOut, {
            venueId: input.venueId,
            partySize: input.partySize,
          });
          await assertActive();
          return availability?.status === 'ready'
            ? { status: 'ready', availability }
            : { status: availability?.status === 'blocked' ? 'blocked' : 'failed' };
        });
      } catch {
        return { status: 'failed' };
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        await page?.close().catch(() => undefined);
        if (temporaryLease)
          await queue.wakeWaiters(await queue.leases.release(input.jobId, input.site), `watch-check-${input.id}`);
      }
    },
  );
  return locked.acquired ? locked.value : { status: 'site_busy' };
}
