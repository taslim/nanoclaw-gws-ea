import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteDriver } from '../../db/drivers/sqlite.js';
import { SiteLeaseStore } from './leases.js';
import { browserSiteLeasesMigration } from './migration.js';

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
});
