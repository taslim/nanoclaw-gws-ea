import type { BrowserQueue } from './queue.js';
import { stopped } from './queue.js';

/** Runs before workers: a marker is never interpreted as permission to repeat a press. */
export async function sweepBrowserStartup(queue: BrowserQueue): Promise<void> {
  for (const request of await queue.store.pending()) {
    await queue.finish(
      request,
      stopped(
        request.commit_started_at ? 'outcome_unknown' : 'interrupted',
        !request.commit_started_at && !request.started_at,
      ),
    );
  }
  for (const request of await queue.store.undelivered()) await queue.deliver(request);
  // Purchase leases are kept until the purchase module resolves their cards/authorities.
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
