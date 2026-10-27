import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SqliteDriver } from '../../db/drivers/sqlite.js';
import { heldCredentialSites, SiteLeaseStore } from './leases.js';
import { browserCredentialAttemptsMigration, browserSiteLeasesMigration } from './migration.js';

let root: string;
let db: SqliteDriver;
let leases: SiteLeaseStore;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'browser-leases-'));
  db = new SqliteDriver(new Database(path.join(root, 'leases.db')));
  await browserSiteLeasesMigration.up(db);
  leases = new SiteLeaseStore(db);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await db.close();
  await rm(root, { recursive: true, force: true });
});

describe('persistent browser site leases', () => {
  it('serializes a registrable domain but runs different domains concurrently', async () => {
    expect(await leases.acquire('first', 'https://shop.example.co.uk/')).toMatchObject({
      acquired: true,
      site: 'example.co.uk',
    });
    expect(await leases.acquire('second', 'https://www.example.co.uk/')).toMatchObject({
      acquired: false,
      site: 'example.co.uk',
    });
    expect(await leases.acquire('second', 'https://another.example/')).toMatchObject({ acquired: true });
    expect(await leases.release('first')).toEqual(['second']);
    expect(await leases.acquire('second', 'https://www.example.co.uk/')).toMatchObject({ acquired: true });
  });
  it('releases idle leases when a job waits elsewhere but retains purchase holds', async () => {
    await leases.acquire('first', 'https://alpha.example/');
    await leases.acquire('first', 'https://purchase.example/');
    await leases.holdForPurchase('first', 'purchase.example');
    await leases.markIdle('first', 'alpha.example');
    expect(await leases.acquire('waiting', 'https://alpha.example/')).toMatchObject({ acquired: false });
    await leases.acquire('second', 'https://beta.example/');
    expect(await leases.acquire('first', 'https://beta.example/')).toMatchObject({
      acquired: false,
      releasedSites: ['alpha.example'],
      waitingJobs: ['waiting'],
    });
    expect(await leases.acquire('third', 'https://alpha.example/')).toMatchObject({ acquired: true });
    expect(await leases.acquire('third', 'https://purchase.example/')).toMatchObject({ acquired: false });
  });
  it('keeps held purchases and waiters through a host restart', async () => {
    await leases.acquire('first', 'https://shop.example/');
    await leases.holdForPurchase('first', 'shop.example');
    await leases.acquire('second', 'https://shop.example/');
    await db.close();
    db = new SqliteDriver(new Database(path.join(root, 'leases.db')));
    leases = new SiteLeaseStore(db);
    expect(await leases.acquire('third', 'https://shop.example/')).toMatchObject({ acquired: false });
    expect(await leases.release('first', 'shop.example')).toEqual(['second', 'third']);
  });
  it('does not let an unrelated job change a lease or release another job', async () => {
    await leases.acquire('first', 'https://shop.example/');
    await expect(leases.holdForPurchase('second', 'shop.example')).rejects.toThrow('not owned');
    await leases.acquire('second', 'https://shop.example/');
    expect(await leases.release('second')).toEqual([]);
    expect(await db.all('SELECT * FROM gws_ea_browser_site_waiters WHERE job_id = ?', 'second')).toEqual([]);
    expect(await leases.acquire('second', 'https://shop.example/')).toMatchObject({ acquired: false });
  });

  it('releases an obsolete lease to its waiters when its last mutation predates retirement', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime('2026-01-01T00:00:00.000Z');
    await leases.acquire('first', 'https://shop.example/');
    await leases.acquire('second', 'https://shop.example/');

    expect(await leases.release('first', 'shop.example', '2026-01-01T00:00:01.000Z')).toEqual(['second']);
    expect(await leases.owned('first', 'shop.example')).toBe(false);
    expect(await leases.acquire('second', 'https://shop.example/')).toMatchObject({ acquired: true });
  });

  it.each([
    ['reacquired', '2026-01-01T00:00:01.000Z'],
    ['reacquired', '2026-01-01T00:00:02.000Z'],
    ['marked idle', '2026-01-01T00:00:01.000Z'],
    ['marked idle', '2026-01-01T00:00:02.000Z'],
  ] as const)('keeps a lease %s at %s from historical cleanup, then permits normal release', async (mutation, at) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime('2026-01-01T00:00:00.000Z');
    await leases.acquire('first', 'https://shop.example/');
    await leases.acquire('second', 'https://shop.example/');
    vi.setSystemTime(at);
    if (mutation === 'reacquired') await leases.acquire('first', 'https://shop.example/');
    else await leases.markIdle('first', 'shop.example');

    expect(await leases.release('first', 'shop.example', '2026-01-01T00:00:01.000Z')).toEqual([]);
    expect(await leases.owned('first', 'shop.example')).toBe(true);
    expect(await db.all('SELECT job_id FROM gws_ea_browser_site_waiters')).toEqual([{ job_id: 'second' }]);
    expect(await leases.release('first', 'shop.example')).toEqual(['second']);
    expect(await leases.owned('first', 'shop.example')).toBe(false);
  });

  it.each(['reacquired', 'held for purchase'] as const)(
    'does not release or wake waiters for a lease %s after selection but before deletion',
    async (mutation) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime('2026-01-01T00:00:00.000Z');
      await leases.acquire('first', 'https://shop.example/');
      await leases.acquire('second', 'https://shop.example/');
      const run = db.run.bind(db);
      let raced = false;
      vi.spyOn(db, 'run').mockImplementation(async (sql, ...params) => {
        if (!raced && sql.startsWith('DELETE FROM gws_ea_browser_site_leases')) {
          raced = true;
          vi.setSystemTime(mutation === 'reacquired' ? '2026-01-01T00:00:02.000Z' : '2026-01-01T00:00:00.500Z');
          if (mutation === 'reacquired') await leases.acquire('first', 'https://shop.example/');
          else await leases.holdForPurchase('first', 'shop.example');
        }
        return run(sql, ...params);
      });

      expect(await leases.release('first', 'shop.example', '2026-01-01T00:00:01.000Z')).toEqual([]);
      expect(raced).toBe(true);
      expect(await leases.owned('first', 'shop.example')).toBe(true);
      expect(await db.all('SELECT job_id FROM gws_ea_browser_site_waiters')).toEqual([{ job_id: 'second' }]);
    },
  );

  describe('while a credential change on a site is unresolved', () => {
    const attempt = async (id: string, jobId: string, site: string, phase: string): Promise<void> => {
      const at = new Date().toISOString();
      await db.run(
        `INSERT INTO gws_ea_browser_credential_attempts(id,kind,job_id,instance_id,account_id,vault_id,origin,site,username,phase,created_at,updated_at,exposed_at)
         VALUES(?,'signup',?,'instance','account','vault',?,?,'morgan.ellery@example.com',?,?,?,?)`,
        id,
        jobId,
        `https://accounts.${site}`,
        site,
        phase,
        at,
        at,
        at,
      );
    };
    const move = (id: string, phase: string) =>
      db.run('UPDATE gws_ea_browser_credential_attempts SET phase = ? WHERE id = ?', phase, id);
    beforeEach(async () => {
      await browserCredentialAttemptsMigration.up(db);
    });

    it.each(['exposed', 'awaiting_verification', 'unknown', 'confirmed'])(
      'keeps that site held by its job (%s) while every other site is released and reusable',
      async (phase) => {
        await leases.acquire('first', 'https://accounts.shop.example/');
        await leases.acquire('first', 'https://news.example/');
        await attempt('held', 'first', 'shop.example', phase);
        expect(await leases.acquire('second', 'https://www.shop.example/')).toMatchObject({ acquired: false });
        expect(await leases.release('first')).toEqual([]);
        expect(await leases.release('first', 'shop.example')).toEqual([]);
        expect(await leases.release('first', 'shop.example', '2099-01-01T00:00:00.000Z')).toEqual([]);
        expect(await db.all('SELECT site, job_id FROM gws_ea_browser_site_leases')).toEqual([
          { site: 'shop.example', job_id: 'first' },
        ]);
        expect(await heldCredentialSites(db, 'first')).toEqual(new Set(['shop.example']));
        expect(await leases.acquire('second', 'https://news.example/')).toMatchObject({ acquired: true });
        // The holding job itself keeps using its own site.
        expect(await leases.acquire('first', 'https://accounts.shop.example/settings')).toMatchObject({
          acquired: true,
        });
      },
    );

    it.each(['preparing', 'saved', 'rejected', 'finalized', 'conflict'])(
      'holds nothing for an attempt that is %s',
      async (phase) => {
        await leases.acquire('first', 'https://accounts.shop.example/');
        await attempt('settled', 'first', 'shop.example', phase);
        expect(await heldCredentialSites(db, 'first')).toEqual(new Set());
        expect(await leases.release('first')).toEqual([]);
        expect(await db.all('SELECT * FROM gws_ea_browser_site_leases')).toEqual([]);
      },
    );

    it('releases the site to its waiters once the attempt settles', async () => {
      await leases.acquire('first', 'https://accounts.shop.example/');
      await attempt('held', 'first', 'shop.example', 'unknown');
      expect(await leases.acquire('second', 'https://shop.example/')).toMatchObject({ acquired: false });
      expect(await leases.release('first', 'shop.example')).toEqual([]);
      await move('held', 'rejected');
      expect(await leases.release('first', 'shop.example')).toEqual(['second']);
      expect(await leases.acquire('second', 'https://shop.example/')).toMatchObject({ acquired: true });
    });

    it("never gives up a held site when its job waits on another job's site", async () => {
      await leases.acquire('first', 'https://accounts.shop.example/');
      await db.run("UPDATE gws_ea_browser_site_leases SET state = 'idle' WHERE job_id = 'first'");
      await attempt('held', 'first', 'shop.example', 'unknown');
      await leases.acquire('second', 'https://other.example/');
      expect(await leases.acquire('first', 'https://other.example/')).toMatchObject({
        acquired: false,
        releasedSites: [],
      });
      expect(await leases.owned('first', 'shop.example')).toBe(true);
    });
  });
});
