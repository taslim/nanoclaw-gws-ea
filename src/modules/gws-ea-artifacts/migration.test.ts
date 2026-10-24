import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../../log.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
import { closeDb, createAgentGroup, getDb, initSqliteTestDb } from '../../db/index.js';
import { sqliteRaw } from '../../db/drivers/sqlite.js';
import { migrations, runMigrations } from '../../db/migrations/index.js';
import { createSession } from '../../db/sessions.js';
import { artifactRequestResult, getArtifactRequest, prepareArtifactSource, saveArtifact } from './db.js';
import { artifactsMigration } from './migration.js';

afterEach(async () => {
  await closeDb();
});
const actor = { agentGroupId: 'author', sessionId: 'session', isMain: false };
const now = '2026-10-22T00:00:00.000Z';
async function seed(): Promise<void> {
  await createAgentGroup({
    id: actor.agentGroupId,
    name: 'Author',
    folder: 'author',
    created_at: now,
    agent_provider: null,
  });
  await createSession({
    id: actor.sessionId,
    agent_group_id: actor.agentGroupId,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'idle',
    last_active: now,
    created_at: now,
  });
}
it('migrates an existing central database to the same concrete schema as a fresh install', async () => {
  const upgraded = await initSqliteTestDb();
  await runMigrations(upgraded, migrations);
  await seed();
  await runMigrations(upgraded, [artifactsMigration]);
  const schema = () =>
    sqliteRaw(getDb())
      .prepare<
        [],
        { name: string; sql: string | null }
      >("SELECT name,sql FROM sqlite_master WHERE name LIKE 'gws_ea_artifact%' ORDER BY name")
      .all();
  const expected = schema();
  expect(expected.map((entry) => entry.name)).toEqual(
    expect.arrayContaining([
      'gws_ea_artifacts',
      'gws_ea_artifact_revisions',
      'gws_ea_artifact_shares',
      'gws_ea_artifact_share_recipients',
      'gws_ea_artifact_requests',
    ]),
  );
  const fresh = await initSqliteTestDb();
  await runMigrations(fresh, [...migrations, artifactsMigration]);
  expect(schema()).toEqual(expected);
  await runMigrations(fresh, [artifactsMigration]);
  expect(schema()).toEqual(expected);
});
it('enforces pinned revision references, one stable public slot and pending/settled request shapes', async () => {
  await runMigrations(await initSqliteTestDb(), [...migrations, artifactsMigration]);
  await seed();
  const made = await saveArtifact(
    actor,
    { requestId: 'save', action: 'save', fingerprint: 'save' },
    { create_key: 'key', title: 'Trip' },
    prepareArtifactSource(Buffer.from('<p>Trip</p>')),
  );
  const share = (id: string, revision: number) =>
    getDb().run(
      "INSERT INTO gws_ea_artifact_shares(share_id,artifact_id,kind,revision,source_hash,generation,state,scope_hash,created_at,updated_at) VALUES(?,?,'public',?,?,1,'active','scope',?,?)",
      id,
      made.artifact_id,
      revision,
      made.source_hash,
      now,
      now,
    );
  await expect(share('bad-revision', 2)).rejects.toThrow(/FOREIGN KEY/u);
  await share('public', 1);
  await expect(share('second-public', 1)).rejects.toThrow(/UNIQUE/u);
  await getDb().run(
    "INSERT INTO gws_ea_artifact_requests(session_id,request_id,actor_group_id,action,fingerprint,state,payload_json,created_at) VALUES('session','pending','author','share','scope','pending','{}',?)",
    now,
  );
  const pending = await getArtifactRequest(actor, { requestId: 'pending', action: 'share', fingerprint: 'scope' });
  expect(pending).toMatchObject({ state: 'pending', result_json: null, payload_json: '{}' });
  if (!pending) throw new Error('Missing pending request');
  expect(() => artifactRequestResult(pending)).toThrow(/not settled/u);
  await expect(
    getDb().run(
      "INSERT INTO gws_ea_artifact_requests(session_id,request_id,actor_group_id,action,fingerprint,state,payload_json,created_at) VALUES('session','bad','author','save','scope','pending','{}',?)",
      now,
    ),
  ).rejects.toThrow(/CHECK/u);
});
