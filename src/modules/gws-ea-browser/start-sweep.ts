import type { BrowserQueue } from './queue.js';

/** Runs before workers: a marker is never interpreted as permission to repeat a press. */
export async function sweepBrowserStartup(queue: BrowserQueue): Promise<void> {
  const { recoverBrowserPurchases } = await import('./purchase.js');
  await recoverBrowserPurchases(queue);
  const { recoverBrowserWatches } = await import('./watches.js');
  await recoverBrowserWatches(queue);
  // Each interrupted request records its own durable outcome before its answer: a credential
  // attempt it disclosed becomes unknown, never a purchase, and is never submitted again.
  for (const request of await queue.store.pending())
    await queue.finish(request, await queue.interruptedAnswer(request, !request.started_at));
  if (await queue.store.db.hasTable('gws_ea_browser_credential_attempts')) {
    const { recoverCredentialAttempts } = await import('./credential-operations.js');
    await recoverCredentialAttempts();
  }
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
}
