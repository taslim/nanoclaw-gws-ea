import { getDomain } from 'tldts';

import type { DbDriver } from '../../db/driver.js';

export function browserSite(url: string): string {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Browser site requires HTTP or HTTPS');
  const domain = getDomain(parsed.hostname, { allowPrivateDomains: true });
  if (!domain) throw new Error('Browser site has no registrable domain');
  return domain;
}

export interface SiteLease {
  site: string;
  job_id: string;
  state: 'active' | 'idle' | 'purchase';
  updated_at: string;
}

/** Every mutation is atomic, including releasing idle sites while entering a wait. */
export class SiteLeaseStore {
  constructor(private readonly db: DbDriver) {}

  async acquire(
    jobId: string,
    url: string,
  ): Promise<{ acquired: boolean; site: string; releasedSites: string[]; waitingJobs: string[] }> {
    const site = browserSite(url);
    return this.db.transaction(async () => {
      const existing = await this.db.get<SiteLease>('SELECT * FROM gws_ea_browser_site_leases WHERE site = ?', site);
      const at = new Date().toISOString();
      if (!existing || existing.job_id === jobId) {
        await this.db.run(
          `INSERT INTO gws_ea_browser_site_leases (site, job_id, state, updated_at) VALUES (?, ?, 'active', ?)
           ON CONFLICT (site) DO UPDATE SET state = CASE WHEN gws_ea_browser_site_leases.state = 'purchase' THEN 'purchase' ELSE 'active' END, updated_at = excluded.updated_at`,
          site,
          jobId,
          at,
        );
        await this.db.run('DELETE FROM gws_ea_browser_site_waiters WHERE site = ? AND job_id = ?', site, jobId);
        return { acquired: true, site, releasedSites: [], waitingJobs: [] };
      }
      await this.db.run(
        'INSERT INTO gws_ea_browser_site_waiters (site, job_id, requested_at) VALUES (?, ?, ?) ON CONFLICT (site, job_id) DO NOTHING',
        site,
        jobId,
        at,
      );
      const idle = await this.db.all<{ site: string }>(
        "SELECT site FROM gws_ea_browser_site_leases WHERE job_id = ? AND state = 'idle' ORDER BY site",
        jobId,
      );
      const waitingJobs = new Set<string>();
      for (const row of idle) {
        const waiters = await this.db.all<{ job_id: string }>(
          'SELECT job_id FROM gws_ea_browser_site_waiters WHERE site = ? ORDER BY requested_at, job_id',
          row.site,
        );
        for (const waiter of waiters) waitingJobs.add(waiter.job_id);
      }
      await this.db.run("DELETE FROM gws_ea_browser_site_leases WHERE job_id = ? AND state = 'idle'", jobId);
      return { acquired: false, site, releasedSites: idle.map((row) => row.site), waitingJobs: [...waitingJobs] };
    });
  }

  async markIdle(jobId: string, site: string): Promise<void> {
    await this.db.transaction(async () => {
      const result = await this.db.run(
        "UPDATE gws_ea_browser_site_leases SET state = 'idle', updated_at = ? WHERE job_id = ? AND site = ? AND state <> 'purchase'",
        new Date().toISOString(),
        jobId,
        site,
      );
      if (!result.changes && !(await this.owned(jobId, site))) throw new Error('Site lease is not owned by this job');
    });
  }

  async holdForPurchase(jobId: string, site: string): Promise<void> {
    await this.db.transaction(async () => {
      const result = await this.db.run(
        "UPDATE gws_ea_browser_site_leases SET state = 'purchase', updated_at = ? WHERE job_id = ? AND site = ?",
        new Date().toISOString(),
        jobId,
        site,
      );
      if (!result.changes) throw new Error('Site lease is not owned by this job');
    });
  }

  async owned(jobId: string, site: string): Promise<boolean> {
    return (
      (await this.db.get('SELECT site FROM gws_ea_browser_site_leases WHERE site = ? AND job_id = ?', site, jobId)) !==
      undefined
    );
  }

  /** The caller wakes returned jobs after commit; it never awaits delivery inside a transaction. */
  async release(jobId: string, site?: string): Promise<string[]> {
    return this.db.transaction(async () => {
      const held =
        site === undefined
          ? await this.db.all<{ site: string }>('SELECT site FROM gws_ea_browser_site_leases WHERE job_id = ?', jobId)
          : await this.db.all<{ site: string }>(
              'SELECT site FROM gws_ea_browser_site_leases WHERE job_id = ? AND site = ?',
              jobId,
              site,
            );
      const waiting = new Set<string>();
      for (const row of held) {
        const waiters = await this.db.all<{ job_id: string }>(
          'SELECT job_id FROM gws_ea_browser_site_waiters WHERE site = ? ORDER BY requested_at, job_id',
          row.site,
        );
        for (const waiter of waiters) waiting.add(waiter.job_id);
        await this.db.run('DELETE FROM gws_ea_browser_site_leases WHERE site = ? AND job_id = ?', row.site, jobId);
      }
      if (site === undefined) await this.db.run('DELETE FROM gws_ea_browser_site_waiters WHERE job_id = ?', jobId);
      else await this.db.run('DELETE FROM gws_ea_browser_site_waiters WHERE job_id = ? AND site = ?', jobId, site);
      return [...waiting];
    });
  }
}
