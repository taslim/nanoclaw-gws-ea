import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../../log.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { createSession } from '../../db/sessions.js';
import { artifactsMigration } from './migration.js';
import {
  deleteArtifact,
  getArtifact,
  getArtifactRevision,
  listArtifacts,
  prepareArtifactSource,
  saveArtifact,
  type ArtifactActor,
} from './db.js';

const NOW = '2026-10-22T20:00:00.000Z';
const actor: ArtifactActor = { agentGroupId: 'author', sessionId: 'session', isMain: false };
const source = () => prepareArtifactSource(Buffer.from('<!doctype html><html><body>Trip plan</body></html>'));
const create = { create_key: 'trip-key', title: 'Trip' } as const;
const request = (requestId: string) => ({ requestId, fingerprint: 'envelope', action: 'save' as const });

beforeEach(async () => {
  await runMigrations(await initTestDb());
  await runMigrations(getDb(), [artifactsMigration]);
  for (const id of ['author', 'peer', 'main'])
    await createAgentGroup({ id, name: id, folder: id, created_at: NOW, agent_provider: null });
  await createSession({
    id: 'session',
    agent_group_id: 'author',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'idle',
    created_at: NOW,
    last_active: NOW,
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await closeDb();
});

it('commits one immutable source, replays a lost result and reuses the stable create key across request IDs', async () => {
  const made = await saveArtifact(actor, request('one'), create, source());
  expect(made).toMatchObject({ revision: 1, generation: 1, byte_count: 50 });
  expect(await saveArtifact(actor, request('one'), create, source())).toEqual(made);
  expect(await saveArtifact(actor, request('two'), create, source())).toEqual(made);
  expect(await getArtifactRevision(made.artifact_id, 1)).toMatchObject({
    html: source().html,
    source_hash: made.source_hash,
  });
  expect(await getDb().all('SELECT request_id FROM gws_ea_artifact_requests ORDER BY request_id')).toEqual([
    { request_id: 'one' },
    { request_id: 'two' },
  ]);
});
it('rejects key/content conflict, changed request fingerprints, and stale heads without partial revisions', async () => {
  const made = await saveArtifact(actor, request('one'), create, source());
  await expect(
    saveArtifact(actor, request('two'), create, prepareArtifactSource(Buffer.from('changed'))),
  ).rejects.toThrow(/create key/);
  await expect(saveArtifact(actor, { ...request('one'), fingerprint: 'different' }, create, source())).rejects.toThrow(
    /different work/,
  );
  const updated = await saveArtifact(
    actor,
    request('edit'),
    { artifact_id: made.artifact_id, expected_revision: 1, title: 'New trip' },
    prepareArtifactSource(Buffer.from('revision two')),
  );
  expect(updated).toMatchObject({ revision: 2, generation: 2 });
  await expect(
    saveArtifact(
      actor,
      request('stale'),
      { artifact_id: made.artifact_id, expected_revision: 1, title: 'Stale' },
      source(),
    ),
  ).rejects.toThrow(/changed/);
  expect(await getDb().all('SELECT revision FROM gws_ea_artifact_revisions ORDER BY revision')).toEqual([
    { revision: 1 },
    { revision: 2 },
  ]);
  expect(
    await getDb().get('SELECT request_id FROM gws_ea_artifact_requests WHERE request_id=?', 'stale'),
  ).toBeUndefined();
});
it('scopes metadata and edits to own authorship while main oversees all artifacts', async () => {
  const made = await saveArtifact(actor, request('one'), create, source());
  const peer = { ...actor, agentGroupId: 'peer' };
  expect(await getArtifact(peer, made.artifact_id)).toBeUndefined();
  expect((await listArtifacts(peer)).artifacts).toEqual([]);
  await expect(
    saveArtifact(
      peer,
      request('peer'),
      { artifact_id: made.artifact_id, expected_revision: 1, title: 'Stolen' },
      source(),
    ),
  ).rejects.toThrow(/own/);
  const main = { ...actor, agentGroupId: 'main', isMain: true };
  expect((await getArtifact(main, made.artifact_id))?.author_group_id).toBe('author');
  expect((await listArtifacts(main)).artifacts).toHaveLength(1);
});
it('lists metadata without reading source and paginates by immutable artifact ID', async () => {
  await saveArtifact(actor, request('one'), create, source());
  await saveArtifact(actor, request('two'), { ...create, create_key: 'two' }, source());
  const all = vi.spyOn(getDb(), 'all');
  const first = await listArtifacts(actor, { limit: 1 });
  expect(first.artifacts).toHaveLength(1);
  expect(JSON.stringify(first)).not.toContain('<html>');
  const next = await listArtifacts(actor, { limit: 1, after: first.next_cursor ?? undefined });
  expect(next.artifacts).toHaveLength(1);
  expect(next.artifacts[0].artifact_id).not.toBe(first.artifacts[0].artifact_id);
  expect(all.mock.calls.every(([sql]) => !sql.includes('html'))).toBe(true);
});
it('deletes source atomically, retains create-key evidence and cannot resurrect a deleted artifact', async () => {
  const made = await saveArtifact(actor, request('one'), create, source());
  await expect(deleteArtifact(actor, { ...request('bad'), action: 'delete' }, made.artifact_id, 8)).rejects.toThrow(
    /changed/,
  );
  const deleted = await deleteArtifact(actor, { ...request('delete'), action: 'delete' }, made.artifact_id, 1);
  expect(deleted).toMatchObject({ artifact_id: made.artifact_id, deleted: true, generation: 2 });
  expect(await deleteArtifact(actor, { ...request('delete'), action: 'delete' }, made.artifact_id, 1)).toEqual(deleted);
  expect(await getArtifact(actor, made.artifact_id)).toBeUndefined();
  expect(await getArtifactRevision(made.artifact_id, 1)).toBeUndefined();
  await expect(saveArtifact(actor, request('late'), create, source())).rejects.toThrow(/deleted/);
  expect(await getDb().get('SELECT title FROM gws_ea_artifacts WHERE artifact_id=?', made.artifact_id)).toEqual({
    title: null,
  });
});
it('rolls back source, head and request settlement together when a durable write fails', async () => {
  const run = getDb().run.bind(getDb());
  vi.spyOn(getDb(), 'run').mockImplementation(async (sql, ...params) => {
    if (sql.startsWith('INSERT INTO gws_ea_artifact_requests')) throw new Error('disk failure');
    return run(sql, ...params);
  });
  await expect(saveArtifact(actor, request('one'), create, source())).rejects.toThrow('disk failure');
  expect(await getDb().all('SELECT artifact_id FROM gws_ea_artifacts')).toEqual([]);
  expect(await getDb().all('SELECT revision FROM gws_ea_artifact_revisions')).toEqual([]);
  expect(await getDb().all('SELECT request_id FROM gws_ea_artifact_requests')).toEqual([]);
});
it('refuses invalid UTF-8, excessive bytes and mismatched preview hashes before saving', () => {
  expect(() => prepareArtifactSource(Buffer.from([0xc3, 0x28]))).toThrow(/UTF-8/);
  expect(() => prepareArtifactSource(Buffer.alloc(4 * 1024 * 1024 + 1))).toThrow(/4 MiB/);
  expect(() => prepareArtifactSource(Buffer.from('html'), '0'.repeat(64))).toThrow(/hash/);
});

it('preserves assistant-owned source when a historical author group is physically removed', async () => {
  const made = await saveArtifact(actor, request('one'), create, source());
  await getDb().run('DELETE FROM sessions WHERE agent_group_id=?', 'author');
  await getDb().run('DELETE FROM agent_groups WHERE id=?', 'author');
  expect(await getArtifact({ ...actor, agentGroupId: 'main', isMain: true }, made.artifact_id)).toMatchObject({
    author_group_id: 'author',
    title: 'Trip',
  });
  expect((await getArtifactRevision(made.artifact_id, 1))?.html).toContain('Trip plan');
});
it('keeps immutable revision titles and sources independent of the current head', async () => {
  const made = await saveArtifact(actor, request('one'), create, source());
  await saveArtifact(
    actor,
    request('edit'),
    { artifact_id: made.artifact_id, expected_revision: 1, title: 'Private revision title' },
    prepareArtifactSource(Buffer.from('Private revision body')),
  );
  expect(await getArtifactRevision(made.artifact_id, 1)).toMatchObject({
    title: 'Trip',
    html: '<!doctype html><html><body>Trip plan</body></html>',
  });
  expect(await getArtifact(actor, made.artifact_id)).toMatchObject({
    title: 'Private revision title',
    head_revision: 2,
  });
});
it('expires access without deleting source and preserves settled replay after the expiry passes', async () => {
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const input = { ...create, expires_at: tomorrow };
  const made = await saveArtifact(actor, request('one'), input, source());
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date(Date.parse(tomorrow) + 1));
    expect(await getArtifact(actor, made.artifact_id)).toBeUndefined();
    expect((await listArtifacts(actor)).artifacts).toEqual([]);
    expect(await saveArtifact(actor, request('one'), input, source())).toEqual(made);
    expect(await getArtifactRevision(made.artifact_id, 1)).toBeDefined();
  } finally {
    vi.useRealTimers();
  }
});
