import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { SqliteDriver } from '../../db/drivers/sqlite.js';
import {
  browserConsentMigration,
  browserConsentOutcomesMigration,
  browserCredentialAttemptsMigration,
  browserCredentialConsentHoldMigration,
  browserCredentialUncertaintyMigration,
} from './migration.js';

it('recovers consent notices and converts old consent waits to uncertainty without losing candidates or evidence', async () => {
  const db = new SqliteDriver(new Database(':memory:'));
  try {
    await db.exec(
      "CREATE TABLE gws_ea_browser_jobs (id TEXT PRIMARY KEY); INSERT INTO gws_ea_browser_jobs(id) VALUES('job')",
    );
    await browserConsentMigration.up(db);
    await browserCredentialAttemptsMigration.up(db);
    await browserCredentialConsentHoldMigration.up(db);
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
    await db.run(
      `INSERT INTO gws_ea_browser_credential_attempts
        (id,kind,job_id,instance_id,account_id,vault_id,origin,site,username,phase,evidence_json,created_at,updated_at)
        VALUES('held-attempt','signup','job','instance','account','vault','https://join.example','join.example','aya@example.test','awaiting_consent',?,?,?)`,
      JSON.stringify({ held: true, stops: 'held' }),
      at,
      at,
    );
    await db.run(
      "UPDATE gws_ea_browser_credential_attempts SET candidate_item_id = 'saved-candidate', candidate_version = 3, exposed_at = ? WHERE id = 'held-attempt'",
      at,
    );
    const before = await db.get<Record<string, unknown>>(
      "SELECT * FROM gws_ea_browser_credential_attempts WHERE id = 'held-attempt'",
    );
    await browserConsentOutcomesMigration.up(db);
    await db.transaction(async () => {
      await browserCredentialUncertaintyMigration.up(db);
    });
    expect(await db.all('SELECT id,outcome_notified_at FROM gws_ea_browser_consent_stops ORDER BY id')).toEqual([
      { id: 'card', outcome_notified_at: null },
      { id: 'early-card', outcome_notified_at: null },
      { id: 'held', outcome_notified_at: null },
      { id: 'pending', outcome_notified_at: null },
      { id: 'prior', outcome_notified_at: expect.any(String) as unknown },
    ]);
    expect(await db.get("SELECT * FROM gws_ea_browser_credential_attempts WHERE id = 'held-attempt'")).toEqual({
      ...before,
      phase: 'unknown',
      updated_at: expect.any(String),
    });
    await expect(
      db.run("UPDATE gws_ea_browser_credential_attempts SET phase = 'awaiting_consent' WHERE id = 'held-attempt'"),
    ).rejects.toThrow();
  } finally {
    await db.close();
  }
});
