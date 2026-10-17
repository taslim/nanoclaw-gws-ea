import { getDomain } from 'tldts';

import type { DbDriver } from '../../db/driver.js';
import type { PurchaseFacts } from './fingerprint.js';

export function browserSite(url: string): string {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Browser site requires HTTP or HTTPS');
  const domain = getDomain(parsed.hostname, { allowPrivateDomains: true });
  if (!domain) throw new Error('Browser site has no registrable domain');
  return domain;
}

/**
 * Credential phases whose site stays held by their job (KTD8): the website
 * may have taken a credential, and only that job's verification or
 * reconciliation may settle it. Another errand can neither submit there
 * again nor take the site meanwhile; every other site stays free.
 */
export const HELD_CREDENTIAL_PHASES = ['exposed', 'awaiting_verification', 'unknown', 'confirmed'] as const;

/** The sites a job holds for its unresolved credential attempts. */
export async function heldCredentialSites(db: DbDriver, jobId: string): Promise<Set<string>> {
  if (!(await db.hasTable('gws_ea_browser_credential_attempts'))) return new Set();
  const rows = await db.all<{ site: string }>(
    `SELECT DISTINCT site FROM gws_ea_browser_credential_attempts
      WHERE job_id = ? AND phase IN (${HELD_CREDENTIAL_PHASES.map(() => '?').join(',')})`,
    jobId,
    ...HELD_CREDENTIAL_PHASES,
  );
  return new Set(rows.map((row) => row.site));
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
      const held = await heldCredentialSites(this.db, jobId);
      const idle = (
        await this.db.all<{ site: string }>(
          "SELECT site FROM gws_ea_browser_site_leases WHERE job_id = ? AND state = 'idle' ORDER BY site",
          jobId,
        )
      ).filter((row) => !held.has(row.site));
      const waitingJobs = new Set<string>();
      for (const row of idle) {
        const waiters = await this.db.all<{ job_id: string }>(
          'SELECT job_id FROM gws_ea_browser_site_waiters WHERE site = ? ORDER BY requested_at, job_id',
          row.site,
        );
        for (const waiter of waiters) waitingJobs.add(waiter.job_id);
        await this.db.run(
          "DELETE FROM gws_ea_browser_site_leases WHERE site = ? AND job_id = ? AND state = 'idle'",
          row.site,
          jobId,
        );
      }
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

  /** Only a current card or unspent/in-progress authority keeps its own site's cart. */
  async releaseUnheldPurchases(jobId: string): Promise<string[]> {
    if (!(await this.db.hasTable('gws_ea_browser_authorities'))) return [];
    return this.db.transaction(async () => {
      const at = new Date().toISOString();
      const current = await this.db.all<{ facts_json: string }>(
        `SELECT facts_json FROM gws_ea_browser_purchase_cards WHERE job_id = ? AND status = 'open' AND expires_at > ?
         UNION ALL
         SELECT facts_json FROM gws_ea_browser_authorities WHERE job_id = ? AND (state = 'committing' OR (state = 'live' AND expires_at > ?))`,
        jobId,
        at,
        jobId,
        at,
      );
      const held = new Set(current.map((row) => (JSON.parse(row.facts_json) as PurchaseFacts).site));
      const leases = await this.db.all<{ site: string }>(
        "SELECT site FROM gws_ea_browser_site_leases WHERE job_id = ? AND state = 'purchase'",
        jobId,
      );
      const waiting = new Set<string>();
      for (const lease of leases)
        if (!held.has(lease.site)) for (const job of await this.release(jobId, lease.site)) waiting.add(job);
      return [...waiting];
    });
  }

  /**
   * The caller wakes returned jobs after commit; it never awaits delivery inside a transaction.
   * A site the job holds for an unresolved credential attempt stays leased to it.
   */
  async release(jobId: string, site?: string): Promise<string[]> {
    return this.db.transaction(async () => {
      const credentials = await heldCredentialSites(this.db, jobId);
      const held = (
        site === undefined
          ? await this.db.all<{ site: string }>('SELECT site FROM gws_ea_browser_site_leases WHERE job_id = ?', jobId)
          : await this.db.all<{ site: string }>(
              'SELECT site FROM gws_ea_browser_site_leases WHERE job_id = ? AND site = ?',
              jobId,
              site,
            )
      ).filter((row) => !credentials.has(row.site));
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
