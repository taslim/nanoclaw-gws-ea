import { createDecipheriv } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { closeDb, getDb, initDb, initTestDb, runMigrations } from '../../db/index.js';
import '../gws-ea-profile/index.js';
import { recordWebAlias } from '../gws-ea-profile/testing/web-alias.js';
import { CredentialAttempts } from './credential-attempts.js';
import type { CredentialAttempt } from './credential-types.js';
import { testLoginStore, TEST_INSTANCE_ID } from './testing/login-store.js';

const JOB = 'system:a2a:main:orchard';
const ORIGIN = 'https://accounts.orchard.example';
const USERNAME = 'elara.wren@example.com';
let directory: string;
let fixture: ReturnType<typeof testLoginStore>;
let attempts: CredentialAttempts;
const service = () => new CredentialAttempts({ store: fixture.store });
const prepared = (result: { status: string; attempt?: CredentialAttempt }): CredentialAttempt => {
  expect(result.status).toBe('prepared');
  if (!result.attempt) throw new Error('No prepared attempt');
  return result.attempt;
};
function local<T>(read: (db: Database.Database) => T): T {
  const db = new Database(path.join(directory, 'browser', 'logins.db'));
  try {
    return read(db);
  } finally {
    db.close();
  }
}
async function snapshotCentral(): Promise<string> {
  const file = path.join(directory, 'central-snapshot.db');
  await getDb().exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
  return file;
}
async function restoreCentral(file: string): Promise<void> {
  await closeDb();
  await initDb(file, { role: 'test' });
}
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
  await recordWebAlias(USERNAME);
  attempts = service();
});
afterEach(async () => {
  await closeDb();
  await rm(directory, { recursive: true, force: true });
});

it('durably saves an encrypted password with its attempt before disclosure and keeps central storage credential-free', async () => {
  const attempt = await signup();
  expect(attempt.phase).toBe('saved');
  expect(fixture.hasPending(attempt.id)).toBe(true);
  expect(await fixture.store.all()).toEqual([]);
  const password = await expose(attempt);
  expect(password).toHaveLength(20);
  expect(password).toMatch(/[0-9]/u);
  expect(password).toMatch(/[^a-z0-9]/iu);
  expect((await readFile(path.join(directory, 'browser', 'logins.db'))).includes(Buffer.from(password))).toBe(false);
  const result = await attempts.confirm(attempt.id, { signal: 'account_page' });
  expect(result).toMatchObject({ status: 'finalized', attempt: { phase: 'finalized' } });
  expect(fixture.pendingIds()).toEqual([]);
  expect(await fixture.store.secret(result.attempt.owned_login_id!, 'password', ORIGIN)).toBe(password);
  expect(await getDb().hasTable('gws_ea_browser_credential_attempts')).toBe(false);
});

it('does not record an attempt when its password cannot be saved', async () => {
  fixture.setUnavailable(true);
  expect(await attempts.prepareSignup({ jobId: JOB, origin: ORIGIN, username: USERNAME })).toEqual({
    status: 'vault_unavailable',
  });
  expect(await attempts.unresolved()).toEqual([]);
});

it('replaces only the owned password and erases old ciphertext in the atomic confirmation', async () => {
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
  const blobs = local((db) =>
    db
      .prepare<
        [],
        { password: Buffer }
      >('SELECT password FROM logins UNION ALL SELECT password FROM attempts WHERE password IS NOT NULL')
      .all(),
  );
  expect(blobs).toHaveLength(1);
  const blob = blobs[0].password;
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from('3d'.repeat(32), 'hex'), blob.subarray(0, 12));
  decipher.setAAD(Buffer.from(`gws-ea-logins:v1|${TEST_INSTANCE_ID}`));
  decipher.setAuthTag(blob.subarray(12, 28));
  expect(Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]).toString()).toBe(
    result.credential.password,
  );
});

it.each(['signup', 'rotation'] as const)(
  'rolls back the %s login and attempt together when finalization fails',
  async (kind) => {
    const source = kind === 'rotation' ? await owned() : undefined;
    const attempt = source ? await rotation(source.id) : await signup();
    const password = await expose(attempt);
    await attempts.markUnknown(attempt.id);
    local((db) =>
      db.exec(
        "CREATE TRIGGER fail_finalization BEFORE UPDATE OF phase ON attempts WHEN NEW.phase = 'finalized' BEGIN SELECT RAISE(ABORT, 'interrupted finalization'); END",
      ),
    );
    fixture.setUnavailable(true);
    const reads = fixture.keyReads();
    await expect(attempts.confirm(attempt.id, { signal: 'late_response' })).rejects.toMatchObject({
      reason: 'vault_unavailable',
    });
    expect(await attempts.get(attempt.id)).toMatchObject({ phase: 'unknown', owned_login_id: null });
    expect(fixture.hasPending(attempt.id)).toBe(true);
    expect(await fixture.store.all()).toHaveLength(source ? 1 : 0);
    local((db) => db.exec('DROP TRIGGER fail_finalization'));
    const confirmed = await service().confirm(attempt.id, { signal: 'late_response' });
    expect(confirmed.attempt.phase).toBe('finalized');
    expect(fixture.keyReads()).toBe(reads);
    fixture.setUnavailable(false);
    expect(await fixture.store.secret(confirmed.attempt.owned_login_id!, 'password', ORIGIN)).toBe(password);
  },
);

it.each(['release', 'confirm'] as const)(
  'settles independent services exactly once when %s starts first',
  async (first) => {
    const login = await owned();
    const attempt = await rotation(login.id);
    const password = await expose(attempt);
    await attempts.markUnknown(attempt.id);
    const other = new CredentialAttempts({ store: testLoginStore(path.join(directory, 'browser')).store });
    const release = () => attempts.release(attempt.id, 'principal-card');
    const confirm = () => other.confirm(attempt.id, { signal: 'late_response' });
    await Promise.allSettled(first === 'release' ? [release(), confirm()] : [confirm(), release()]);
    expect((await attempts.get(attempt.id))?.phase).toBe(first === 'release' ? 'rejected' : 'finalized');
    expect(await fixture.store.secret(login.id, 'password', ORIGIN)).toBe(
      first === 'release' ? login.password : password,
    );
    expect(fixture.pendingIds()).toEqual([]);
  },
);

it('releases an unknown rotation without a key and preserves the previous login', async () => {
  const login = await owned();
  const attempt = await rotation(login.id);
  await expose(attempt);
  await attempts.markUnknown(attempt.id);
  fixture.setUnavailable(true);
  const reads = fixture.keyReads();
  expect(await attempts.release(attempt.id, 'principal-card')).toMatchObject({ status: 'released', from: 'unknown' });
  expect(fixture.hasPending(attempt.id)).toBe(false);
  expect(fixture.keyReads()).toBe(reads);
  fixture.setUnavailable(false);
  expect(await fixture.store.secret(login.id, 'password', ORIGIN)).toBe(login.password);
});

it('cancels saved attempts and clears their passwords atomically while keeping disclosed attempts', async () => {
  const saved = await signup();
  const exposed = await signup('soren_exposed');
  await expose(exposed);
  fixture.setUnavailable(true);
  const reads = fixture.keyReads();
  const ended = await getDb().transaction(() => attempts.abandonForJob(JOB));
  expect(ended.map(({ id }) => id)).toEqual([saved.id]);
  expect(fixture.hasPending(saved.id)).toBe(false);
  expect(await attempts.get(saved.id)).toMatchObject({ phase: 'rejected' });
  expect(fixture.hasPending(exposed.id)).toBe(true);
  expect(fixture.keyReads()).toBe(reads);
});

it('retains non-email ownership across removing and re-adding a login', async () => {
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

it('makes exposure unknown on recovery without redisclosing its password', async () => {
  const attempt = await signup();
  await attempts.disclose(attempt.id, { jobId: JOB, origin: ORIGIN });
  fixture.setUnavailable(true);
  const reads = fixture.keyReads();
  await service().recover();
  expect(await attempts.get(attempt.id)).toMatchObject({ phase: 'unknown' });
  expect(await attempts.disclose(attempt.id, { jobId: JOB, origin: ORIGIN })).toMatchObject({
    status: 'refused',
    reason: 'not_saved',
  });
  await attempts.confirm(attempt.id, { signal: 'late_response' });
  expect((await attempts.get(attempt.id))?.phase).toBe('finalized');
  expect(fixture.keyReads()).toBe(reads);
});

it('gives an unsent rotation way to the login edit in the same transaction', async () => {
  const login = await owned();
  const saved = await rotation(login.id);
  const metadata = await fixture.store.get(login.id);
  await fixture.store.update(login.id, metadata.version, { title: 'Edited', password: '' });
  expect(await attempts.get(saved.id)).toMatchObject({
    phase: 'rejected',
    evidence_json: JSON.stringify({ reason: 'login_edited' }),
  });
  expect(fixture.hasPending(saved.id)).toBe(false);
  expect((await fixture.store.get(login.id)).title).toBe('Edited');
});

it('keeps an unsent attempt intact if the page edit transaction fails', async () => {
  const login = await owned();
  const saved = await rotation(login.id);
  local((db) =>
    db.exec("CREATE TRIGGER fail_page BEFORE UPDATE ON logins BEGIN SELECT RAISE(ABORT, 'interrupted edit'); END"),
  );
  await expect(fixture.store.update(login.id, 1, { title: 'Edited', password: '' })).rejects.toMatchObject({
    reason: 'vault_unavailable',
  });
  expect(await attempts.get(saved.id)).toMatchObject({ phase: 'saved' });
  expect(fixture.hasPending(saved.id)).toBe(true);
  expect((await fixture.store.get(login.id)).title).toBe('orchard.example');
});

it('refuses edits and removals after password disclosure', async () => {
  const login = await owned();
  const attempt = await rotation(login.id);
  await expose(attempt);
  await expect(fixture.store.update(login.id, 1, { title: 'Edited', password: '' })).rejects.toMatchObject({
    reason: 'login_busy',
  });
  await expect(fixture.store.remove(login.id, 1)).rejects.toMatchObject({ reason: 'login_busy' });
  expect(fixture.hasPending(attempt.id)).toBe(true);
});

it('lets a page add win the gap before exposure without returning the generated password', async () => {
  const attempt = await signup('soren_page');
  const result = await attempts.disclose(attempt.id, { jobId: JOB, origin: ORIGIN }, async () => {
    await fixture.store.create({
      site: ORIGIN,
      username: 'soren_page',
      title: 'Orchard',
      password: 'principal-password',
    });
  });
  expect(result).toEqual({ status: 'refused', reason: 'not_saved' });
  expect(await attempts.get(attempt.id)).toMatchObject({ phase: 'rejected' });
  expect(fixture.hasPending(attempt.id)).toBe(false);
});

it('allows a central cancellation check before exposure without holding the local file gate', async () => {
  const attempt = await signup();
  const result = await attempts.disclose(attempt.id, { jobId: JOB, origin: ORIGIN }, async () => {
    await getDb().transaction(() => attempts.abandonForJob(JOB));
  });
  expect(result).toEqual({ status: 'refused', reason: 'not_saved' });
  expect(await attempts.get(attempt.id)).toMatchObject({ phase: 'rejected' });
});

it('preserves an active-check failure without marking the attempt exposed', async () => {
  const attempt = await signup();
  await expect(
    attempts.disclose(attempt.id, { jobId: JOB, origin: ORIGIN }, () => Promise.reject(new Error('Errand closed'))),
  ).rejects.toThrow('Errand closed');
  expect(await attempts.get(attempt.id)).toMatchObject({ phase: 'saved', exposed_at: null });
});

it('enforces job, origin and current source version before disclosure', async () => {
  const login = await owned();
  const attempt = await rotation(login.id);
  expect(await attempts.disclose(attempt.id, { jobId: 'another', origin: ORIGIN })).toMatchObject({
    reason: 'wrong_job',
  });
  expect(await attempts.disclose(attempt.id, { jobId: JOB, origin: 'https://another.example' })).toMatchObject({
    reason: 'origin_mismatch',
  });
  const result = await attempts.disclose(attempt.id, { jobId: JOB, origin: ORIGIN }, async () => {
    local((db) => db.prepare('UPDATE logins SET version = version + 1 WHERE id = ?').run(login.id));
  });
  expect(result).toEqual({ status: 'refused', reason: 'source_changed' });
  expect((await attempts.get(attempt.id))?.phase).toBe('saved');
});

it('rejects a refused response and removes its encrypted password atomically', async () => {
  const attempt = await signup();
  await expose(attempt);
  fixture.setUnavailable(true);
  const reads = fixture.keyReads();
  await attempts.markRejected(attempt.id, { signal: 'password_policy' });
  expect(await attempts.get(attempt.id)).toMatchObject({ phase: 'rejected' });
  expect(fixture.hasPending(attempt.id)).toBe(false);
  expect(fixture.keyReads()).toBe(reads);
});

it.each(['signup', 'rotation'] as const)(
  'confirms a %s directly from exposure when the site proves success',
  async (kind) => {
    const source = kind === 'rotation' ? await owned() : undefined;
    const attempt = source ? await rotation(source.id) : await signup();
    await attempts.disclose(attempt.id, { jobId: JOB, origin: ORIGIN });
    expect(await attempts.confirm(attempt.id, { signal: 'success_text' })).toMatchObject({
      status: 'finalized',
      attempt: { phase: 'finalized' },
    });
  },
);

it('keeps generated values and page prose out of evidence', async () => {
  const attempt = await signup();
  const password = await expose(attempt);
  await expect(attempts.confirm(attempt.id, { signal: password })).rejects.toMatchObject({ reason: 'invalid_request' });
  await expect(attempts.markUnknown(attempt.id, { page_text: 'Account created' })).rejects.toMatchObject({
    reason: 'invalid_request',
  });
  expect(await attempts.get(attempt.id)).toMatchObject({ phase: 'awaiting_verification', evidence_json: null });
});

it.each(['saved', 'exposed', 'awaiting_verification', 'unknown'] as const)(
  'keeps a released %s attempt rejected after the central snapshot is restored',
  async (phase) => {
    const username = `soren_${phase}`;
    const attempt = await signup(username);
    if (phase !== 'saved') {
      await attempts.disclose(attempt.id, { jobId: JOB, origin: ORIGIN });
      if (phase === 'awaiting_verification') await attempts.markAwaitingVerification(attempt.id);
      if (phase === 'unknown') await attempts.markUnknown(attempt.id);
    }
    const snapshot = await snapshotCentral();
    if (phase === 'saved') await attempts.abandon(attempt.id);
    else {
      if (phase === 'exposed') await attempts.markUnknown(attempt.id);
      await attempts.release(attempt.id, 'principal-approved-release');
    }
    const principalLogin = await fixture.store.create({
      site: ORIGIN,
      username,
      title: 'Orchard',
      password: 'principal-chosen-password',
    });
    await restoreCentral(snapshot);
    fixture.setUnavailable(true);
    const reads = fixture.keyReads();
    await service().recover();
    expect(await attempts.get(attempt.id)).toMatchObject({ phase: 'rejected' });
    expect(await attempts.accountForLogin(principalLogin)).toBe('principal');
    expect(await attempts.ownedHandle(ORIGIN, username)).toEqual({ status: 'not_owned' });
    expect(fixture.keyReads()).toBe(reads);
  },
);

it('keeps a disclosed password when the central rollback predates its attempt', async () => {
  const snapshot = await snapshotCentral();
  const attempt = await signup('soren_new');
  const disclosed = await attempts.disclose(attempt.id, { jobId: JOB, origin: ORIGIN });
  if (disclosed.status !== 'disclosed') throw new Error(disclosed.status);
  await restoreCentral(snapshot);
  fixture.setUnavailable(true);
  const reads = fixture.keyReads();
  await service().recover();
  expect(await attempts.get(attempt.id)).toMatchObject({ phase: 'unknown' });
  expect(fixture.hasPending(attempt.id)).toBe(true);
  expect(fixture.keyReads()).toBe(reads);
  await attempts.release(attempt.id, 'principal-after-rollback');
  expect(fixture.hasPending(attempt.id)).toBe(false);
  expect(await fixture.store.all()).toEqual([]);
});

it('keeps finalized non-email ownership when the central rollback predates its attempt', async () => {
  const snapshot = await snapshotCentral();
  const login = await owned('soren_owned');
  await restoreCentral(snapshot);
  await service().recover();
  expect(await attempts.accountForLogin(await fixture.store.get(login.id))).toBe('assistant');
});

it('refuses a direct login add while the same signup password has been disclosed', async () => {
  const attempt = await signup('soren_busy');
  await attempts.disclose(attempt.id, { jobId: JOB, origin: ORIGIN });
  await expect(
    fixture.store.create({
      site: ORIGIN,
      username: 'soren_busy',
      title: 'Orchard',
      password: 'principal-chosen-password',
    }),
  ).rejects.toMatchObject({ reason: 'login_busy' });
  expect(await fixture.store.all()).toEqual([]);
});

it('enforces the atomic phase-password invariant in SQLite', async () => {
  const attempt = await signup();
  expect(() =>
    local((db) => db.prepare("UPDATE attempts SET phase = 'finalized' WHERE id = ?").run(attempt.id)),
  ).toThrow(/CHECK constraint/u);
  expect(() => local((db) => db.prepare('UPDATE attempts SET password = NULL WHERE id = ?').run(attempt.id))).toThrow(
    /CHECK constraint/u,
  );
  expect(await attempts.get(attempt.id)).toMatchObject({ phase: 'saved' });
  expect(fixture.hasPending(attempt.id)).toBe(true);
});

it('reports a disclosed signup busy without needing its encryption key', async () => {
  const attempt = await signup('soren_locked');
  await attempts.disclose(attempt.id, { jobId: JOB, origin: ORIGIN });
  fixture.setUnavailable(true);
  const reads = fixture.keyReads();
  await expect(
    fixture.store.create({
      site: ORIGIN,
      username: 'soren_locked',
      title: 'Orchard',
      password: 'principal-chosen-password',
    }),
  ).rejects.toMatchObject({ reason: 'login_busy' });
  expect(fixture.keyReads()).toBe(reads);
});
