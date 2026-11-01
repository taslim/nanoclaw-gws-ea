import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { SqliteDriver } from '../../db/drivers/sqlite.js';
import {
  browserConsentMigration,
  browserConsentOutcomesMigration,
  browserRetiredCredentialsMigration,
} from './migration.js';

it('recovers consent notices alongside the native credential attempts schema', async () => {
  const db = new SqliteDriver(new Database(':memory:'));
  try {
    await db.exec(
      "CREATE TABLE gws_ea_browser_jobs (id TEXT PRIMARY KEY); INSERT INTO gws_ea_browser_jobs(id) VALUES('job')",
    );
    await browserConsentMigration.up(db);
    await browserRetiredCredentialsMigration.up(db);
    const at = '2026-10-20T12:00:00.000Z';
    for (const [id, status] of [
      ['prior', 'approved'],
      ['card', 'rejected'],
      ['early-card', 'rejected'],
      ['held', 'expired'],
      ['pending', 'requested'],
    ])
      await db.run(
        `INSERT INTO gws_ea_browser_consent_stops
          (id,job_id,site,origin,wording,kind,form_fingerprint,status,created_at,decided_at)
          VALUES(?,'job','join.example','https://join.example','Agreement','agreement','form',?,?,?)`,
        id,
        status,
        at,
        status === 'requested' ? null : at,
      );
    await db.run("UPDATE gws_ea_browser_consent_stops SET approval_id = 'existing-card' WHERE id = 'card'");
    await db.run("UPDATE gws_ea_browser_consent_stops SET requested_at = ? WHERE id = 'early-card'", at);
    await browserConsentOutcomesMigration.up(db);
    expect(await db.all('SELECT id,outcome_notified_at FROM gws_ea_browser_consent_stops ORDER BY id')).toEqual([
      { id: 'card', outcome_notified_at: null },
      { id: 'early-card', outcome_notified_at: null },
      { id: 'held', outcome_notified_at: null },
      { id: 'pending', outcome_notified_at: null },
      { id: 'prior', outcome_notified_at: expect.any(String) as unknown },
    ]);
  } finally {
    await db.close();
  }
});
