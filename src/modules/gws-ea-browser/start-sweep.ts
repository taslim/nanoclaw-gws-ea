import { recoverBrowserWatchState } from './watch-state.js';
import { log } from '../../log.js';
import type { BrowserQueue } from './queue.js';
import { recoverBrowserPurchases } from './purchase.js';

import { recoverCredentialAttempts, settleConfirmedAttempts } from './credential-operations.js';

/** Runs before workers: a marker is never interpreted as permission to repeat a press. */
export async function sweepBrowserStartup(queue: BrowserQueue): Promise<void> {
  await recoverBrowserPurchases(queue);
  await recoverBrowserWatchState(queue);
  // Each interrupted request records its own durable outcome before its answer: a credential
  // attempt it disclosed becomes unknown, never a purchase, and is never submitted again.
  for (const request of await queue.store.pending())
    await queue.finish(request, await queue.interruptedAnswer(request, !request.started_at));
  const credentials = await queue.store.db.hasTable('gws_ea_browser_credential_attempts');
  if (credentials) await recoverCredentialAttempts();
  for (const request of await queue.store.undelivered()) await queue.deliver(request);
  // Purchase leases are kept until the purchase module resolves their cards/authorities, and a
  // site held for an unresolved credential attempt stays with its job.
  const jobs = await queue.store.db.all<{ job_id: string }>(
    "SELECT DISTINCT job_id FROM gws_ea_browser_site_leases WHERE state <> 'purchase'",
  );
  for (const job of jobs) {
    const sites = await queue.store.db.all<{ site: string }>(
      "SELECT site FROM gws_ea_browser_site_leases WHERE job_id = ? AND state <> 'purchase'",
      job.job_id,
    );
    for (const site of sites)
      await queue.wakeWaiters(await queue.leases.release(job.job_id, site.site), `startup:${job.job_id}:${site.site}`);
  }
  // A confirmed credential attempt waits only on 1Password: it settles without its job, and no provider call
  // holds up the browser's admission.
  if (credentials)
    void settleConfirmedAttempts(queue).catch(() =>
      log.warn('Credential attempts could not be settled at start', { reason: 'settlement_failed' }),
    );
}
