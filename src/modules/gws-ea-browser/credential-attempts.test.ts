import { createDecipheriv } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { closeDb, getDb, initTestDb, runMigrations } from '../../db/index.js';
import '../gws-ea-profile/index.js';
import { recordWebAlias } from '../gws-ea-profile/testing/web-alias.js';
import { CredentialAttempts, type CredentialAttempt } from './credential-attempts.js';
import { browserCredentialAttemptsMigration, browserQueueMigration } from './migration.js';
import { heldCredentialSites } from './leases.js';
import { testLoginStore, TEST_INSTANCE_ID } from './testing/login-store.js';

const JOB = 'system:a2a:main:orchard';
const ORIGIN = 'https://accounts.orchard.example';
const USERNAME = 'elara.wren@example.com';
let directory: string;
let fixture: ReturnType<typeof testLoginStore>;
let attempts: CredentialAttempts;
const service = () => new CredentialAttempts({ db: getDb(), store: fixture.store });
const prepared = (result: { status: string; attempt?: CredentialAttempt }): CredentialAttempt => {
  expect(result.status).toBe('prepared');
  if (!result.attempt) throw new Error('No prepared attempt');
  return result.attempt;
};
async function signup(username = USERNAME): Promise<CredentialAttempt> {
  return prepared(await attempts.prepareSignup({ jobId: JOB, origin: ORIGIN, username }));
}
async function expose(attempt: CredentialAttempt): Promise<string> {
  const result = await attempts.disclose(attempt.id, { jobId: JOB, origin: ORIGIN });
  if (result.status !== 'disclosed') throw new Error(result.status);
  await attempts.markAwaitingVerification(attempt.id);
  return result.credential.password;
}
async function owned(username = USERNAME): Promise<{ id: string; password: string }> {
  const attempt = await signup(username);
  const password = await expose(attempt);
  const result = await attempts.confirm(attempt.id, { signal: 'account_page' });
  expect(result.status).toBe('finalized');
  if (!result.attempt.owned_login_id) throw new Error('No resulting login');
  return { id: result.attempt.owned_login_id, password };
}
async function rotation(id: string, username = USERNAME): Promise<CredentialAttempt> {
  return prepared(await attempts.prepareRotation({ jobId: JOB, origin: ORIGIN, username, itemHandle: id }));
}
beforeEach(async () => {
  directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'credential-store-')));
  fixture = testLoginStore(path.join(directory, 'browser'));
  await runMigrations(await initTestDb());
  await browserQueueMigration.up(getDb());
  await browserCredentialAttemptsMigration.up(getDb());
  await recordWebAlias(USERNAME);
  attempts = service();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await closeDb();
  await rm(directory, { recursive: true, force: true });
});

it('seals a generated password before recording saved, and confirms a signup without central secrets', async () => {
  const attempt = await signup();
  expect(attempt.phase).toBe('saved');
  expect(await fixture.store.hasPending(attempt.id)).toBe(true);
  expect(await fixture.store.all()).toEqual([]);
  const password = await expose(attempt);
  expect(password).toHaveLength(20);
  expect(password).toMatch(/[0-9]/u);
  expect(password).toMatch(/[^a-z0-9]/iu);
  const result = await attempts.confirm(attempt.id, { signal: 'account_page' });
  expect(result).toMatchObject({ status: 'finalized', attempt: { phase: 'finalized' } });
  expect(await fixture.store.pendingIds()).toEqual([]);
  expect(await fixture.store.secret(result.attempt.owned_login_id!, 'password', ORIGIN)).toBe(password);
  const columns = await getDb().all<{ name: string }>('PRAGMA table_info(gws_ea_browser_credential_attempts)');
  expect(columns.map(({ name }) => name).join(' ')).not.toMatch(
    /password|cipher|candidate|vault|account_id|settlement/u,
  );
  expect(JSON.stringify(await getDb().all('SELECT * FROM gws_ea_browser_credential_attempts'))).not.toContain(password);
});

it('does not record an attempt when its pending password cannot be saved', async () => {
  fixture.setUnavailable(true);
  expect(await attempts.prepareSignup({ jobId: JOB, origin: ORIGIN, username: USERNAME })).toEqual({
    status: 'vault_unavailable',
  });
  expect(await attempts.unresolved()).toEqual([]);
});

it('replaces only the owned login password and erases the old sealed contents on confirm', async () => {
  const login = await owned();
  const attempt = await rotation(login.id);
  const result = await attempts.disclose(attempt.id, { jobId: JOB, origin: ORIGIN });
  if (result.status !== 'disclosed') throw new Error(result.status);
  expect(result.credential.currentPassword).toBe(login.password);
  await attempts.markAwaitingVerification(attempt.id);
  fixture.setUnavailable(true);
  const reads = fixture.keyReads();
  await attempts.confirm(attempt.id, { signal: 'password_changed' });
  expect(fixture.keyReads()).toBe(reads);
  fixture.setUnavailable(false);
  expect(await fixture.store.secret(login.id, 'password', ORIGIN)).toBe(result.credential.password);
  const db = new Database(path.join(directory, 'browser', 'logins.db'));
  try {
    const blobs = db
      .prepare<[], { password: Buffer }>('SELECT password FROM logins UNION ALL SELECT password FROM pending')
      .all();
    expect(blobs).toHaveLength(1);
    for (const { password: blob } of blobs) {
      const decipher = createDecipheriv('aes-256-gcm', Buffer.from('3d'.repeat(32), 'hex'), blob.subarray(0, 12));
      decipher.setAAD(Buffer.from(`gws-ea-logins:v1|${TEST_INSTANCE_ID}`));
      decipher.setAuthTag(blob.subarray(12, 28));
      expect(Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]).toString()).toBe(
        result.credential.password,
      );
    }
  } finally {
    db.close();
  }
  expect((await readFile(path.join(directory, 'browser', 'logins.db'))).includes(Buffer.from(login.password))).toBe(
    false,
  );
});

it.each(['signup', 'rotation'] as const)(
  'recovers a %s confirmed in the store before the central phase write',
  async (kind) => {
    const source = kind === 'rotation' ? await owned() : undefined;
    const attempt = source ? await rotation(source.id) : await signup();
    const password = await expose(attempt);
    await fixture.store.confirmPending(
      attempt.id,
      source
        ? { kind: 'rotation', loginId: source.id, version: attempt.source_version! }
        : { kind: 'signup', details: { site: ORIGIN, username: USERNAME, title: 'orchard.example' } },
    );
    fixture.setUnavailable(true);
    const reads = fixture.keyReads();
    attempts = service();
    await attempts.recover();
    expect(fixture.keyReads()).toBe(reads);
    const finished = await attempts.get(attempt.id);
    expect(finished).toMatchObject({ phase: 'finalized', owned_login_id: expect.any(String) });
    fixture.setUnavailable(false);
    expect(await fixture.store.secret(finished!.owned_login_id!, 'password', ORIGIN)).toBe(password);
  },
);

it('cleans rejected, finalized and orphan pending rows after an interrupted prepare or release without reading the key', async () => {
  const rejected = await signup();
  await expose(rejected);
  await attempts.markUnknown(rejected.id);
  await getDb().run("UPDATE gws_ea_browser_credential_attempts SET phase = 'rejected' WHERE id = ?", rejected.id);
  const finished = await owned('another_handle');
  const finalized = await getDb().get<{ id: string }>(
    'SELECT id FROM gws_ea_browser_credential_attempts WHERE owned_login_id = ?',
    finished.id,
  );
  await fixture.store.savePending(finalized!.id, 'unused-finalized-value');
  await fixture.store.savePending('orphan-after-prepare', 'unused-orphan-value');
  fixture.setUnavailable(true);
  const reads = fixture.keyReads();
  await service().recover();
  expect(await fixture.store.pendingIds()).toEqual([]);
  expect((await attempts.get(rejected.id))?.phase).toBe('rejected');
  expect(fixture.keyReads()).toBe(reads);
});

it.each(['release', 'confirm'] as const)(
  'settles a release racing confirm exactly once when %s starts first',
  async (first) => {
    const login = await owned();
    const attempt = await rotation(login.id);
    const password = await expose(attempt);
    await attempts.markUnknown(attempt.id);
    const release = () => attempts.release(attempt.id, 'principal-card');
    const confirm = () => attempts.confirm(attempt.id, { signal: 'late_response' });
    await Promise.allSettled(first === 'release' ? [release(), confirm()] : [confirm(), release()]);
    const current = await attempts.get(attempt.id);
    expect(current?.phase).toBe(first === 'release' ? 'rejected' : 'finalized');
    expect(await fixture.store.secret(login.id, 'password', ORIGIN)).toBe(
      first === 'release' ? login.password : password,
    );
    expect(await fixture.store.pendingIds()).toEqual([]);
  },
);

it.each(['signup', 'rotation'] as const)(
  'does not release a %s already committed to the store after its central phase write failed',
  async (kind) => {
    const source = kind === 'rotation' ? await owned() : undefined;
    const attempt = source ? await rotation(source.id) : await signup();
    const password = await expose(attempt);
    await attempts.markUnknown(attempt.id);
    const run = getDb().run.bind(getDb());
    const interrupted = vi.spyOn(getDb(), 'run').mockImplementation(async (sql, ...parameters) => {
      if (sql.includes("SET phase = 'finalized'")) throw new Error('Central write interrupted');
      return run(sql, ...parameters);
    });
    await expect(attempts.confirm(attempt.id, { signal: 'late_response' })).rejects.toThrow(
      'Central write interrupted',
    );
    interrupted.mockRestore();
    expect((await attempts.get(attempt.id))?.phase).toBe('unknown');
    expect(await fixture.store.hasPending(attempt.id)).toBe(false);
    fixture.setUnavailable(true);
    const reads = fixture.keyReads();
    expect(await attempts.release(attempt.id, 'principal-card')).toMatchObject({ status: 'finalized' });
    const current = await attempts.get(attempt.id);
    expect(current).toMatchObject({ phase: 'finalized', owned_login_id: expect.any(String) });
    expect(fixture.keyReads()).toBe(reads);
    fixture.setUnavailable(false);
    expect(await fixture.store.secret(current!.owned_login_id!, 'password', ORIGIN)).toBe(password);
    expect(await fixture.store.all()).toHaveLength(1);
    expect(await fixture.store.pendingIds()).toEqual([]);
  },
);

it('releases an unknown rotation without a key, deletes pending and preserves the previous login password', async () => {
  const login = await owned();
  const attempt = await rotation(login.id);
  await expose(attempt);
  await attempts.markUnknown(attempt.id);
  fixture.setUnavailable(true);
  const reads = fixture.keyReads();
  expect(await attempts.release(attempt.id, 'principal-card')).toMatchObject({ status: 'released', from: 'unknown' });
  expect(await fixture.store.hasPending(attempt.id)).toBe(false);
  expect(fixture.keyReads()).toBe(reads);
  fixture.setUnavailable(false);
  expect(await fixture.store.secret(login.id, 'password', ORIGIN)).toBe(login.password);
});

it('cancels saved attempts by rejecting before key-free pending cleanup, and leaves exposed attempts held', async () => {
  const saved = await signup();
  const exposed = await signup('exposed_handle');
  await expose(exposed);
  const ended = await getDb().transaction(() => attempts.abandonForJob(JOB));
  expect(ended.map(({ id }) => id)).toEqual([saved.id]);
  expect(await fixture.store.hasPending(saved.id)).toBe(true);
  fixture.setUnavailable(true);
  await attempts.retirePending(ended);
  expect(await fixture.store.hasPending(saved.id)).toBe(false);
  expect((await attempts.get(saved.id))?.phase).toBe('rejected');
  expect(await heldCredentialSites(getDb(), JOB)).toEqual(new Set(['orchard.example']));
});

it('retains non-email ownership across removing and re-adding a saved login', async () => {
  const login = await owned('elara_wren');
  const metadata = await fixture.store.get(login.id);
  await fixture.store.remove(login.id, metadata.version);
  const replacement = await fixture.store.create({
    site: ORIGIN,
    username: 'elara_wren',
    title: 'Orchard',
    password: 'replacement',
  });
  expect(await attempts.accountForLogin(replacement)).toBe('assistant');
  expect(await attempts.ownedHandle(ORIGIN, 'elara_wren')).toEqual({ status: 'found', itemHandle: replacement.id });
});

it('makes exposed unknown on recovery and confirms a reconciled late response without redisclosing', async () => {
  const attempt = await signup();
  const disclosed = await attempts.disclose(attempt.id, { jobId: JOB, origin: ORIGIN });
  expect(disclosed.status).toBe('disclosed');
  await service().recover();
  expect((await attempts.get(attempt.id))?.phase).toBe('unknown');
  expect(await attempts.disclose(attempt.id, { jobId: JOB, origin: ORIGIN })).toMatchObject({
    status: 'refused',
    reason: 'not_saved',
  });
  await attempts.confirm(attempt.id, { signal: 'late_response' });
  expect((await attempts.get(attempt.id))?.phase).toBe('finalized');
});

it('lets saved rotations give way to an edit and refuses edits after disclosure', async () => {
  const login = await owned();
  const saved = await rotation(login.id);
  expect(await attempts.giveWayForLogin(login.id)).toBe('ready');
  expect(await attempts.get(saved.id)).toMatchObject({
    phase: 'rejected',
    evidence_json: JSON.stringify({ reason: 'login_edited' }),
  });
  expect(await fixture.store.hasPending(saved.id)).toBe(false);
  const exposed = await rotation(login.id);
  await expose(exposed);
  expect(await attempts.giveWayForLogin(login.id)).toBe('login_busy');
  expect(await fixture.store.hasPending(exposed.id)).toBe(true);
});

it('enforces job, site, source version and ownership before disclosure', async () => {
  const login = await owned();
  const attempt = await rotation(login.id);
  expect(await attempts.disclose(attempt.id, { jobId: 'another', origin: ORIGIN })).toMatchObject({
    reason: 'wrong_job',
  });
  expect(await attempts.disclose(attempt.id, { jobId: JOB, origin: 'https://another.example' })).toMatchObject({
    reason: 'origin_mismatch',
  });
  const metadata = await fixture.store.get(login.id);
  await fixture.store.update(login.id, metadata.version, { title: 'edited', password: '' });
  expect(await attempts.disclose(attempt.id, { jobId: JOB, origin: ORIGIN })).toMatchObject({
    reason: 'source_changed',
  });
});

it('rejects a refused website response before deleting the pending password', async () => {
  const attempt = await signup();
  await expose(attempt);
  await attempts.markRejected(attempt.id, { signal: 'password_policy' });
  expect((await attempts.get(attempt.id))?.phase).toBe('rejected');
  expect(await fixture.store.hasPending(attempt.id)).toBe(false);
});

it.each(['signup', 'rotation'] as const)(
  'confirms a %s directly from exposure when the site proves success',
  async (kind) => {
    const source = kind === 'rotation' ? await owned() : undefined;
    const attempt = source ? await rotation(source.id) : await signup();
    const disclosed = await attempts.disclose(attempt.id, { jobId: JOB, origin: ORIGIN });
    if (disclosed.status !== 'disclosed') throw new Error(disclosed.status);
    expect(await attempts.confirm(attempt.id, { signal: 'success_text' })).toMatchObject({
      status: 'finalized',
      attempt: { phase: 'finalized' },
    });
  },
);

it('keeps generated values and page prose out of central evidence', async () => {
  const attempt = await signup();
  const password = await expose(attempt);
  await expect(attempts.confirm(attempt.id, { signal: password })).rejects.toMatchObject({ reason: 'invalid_request' });
  await expect(attempts.markUnknown(attempt.id, { page_text: 'Account created' })).rejects.toMatchObject({
    reason: 'invalid_request',
  });
  expect(await attempts.get(attempt.id)).toMatchObject({ phase: 'awaiting_verification', evidence_json: null });
});

it('writes pending before the central saved record can be inserted', async () => {
  const db = getDb();
  const run = db.run.bind(db);
  let witnessed = false;
  vi.spyOn(db, 'run').mockImplementation(async (sql, ...params) => {
    if (sql.includes('INSERT INTO gws_ea_browser_credential_attempts')) {
      witnessed = true;
      expect(await fixture.store.hasPending(String(params[0]))).toBe(true);
    }
    return run(sql, ...params);
  });
  await signup();
  expect(witnessed).toBe(true);
});
