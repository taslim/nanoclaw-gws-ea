import {
  chmod,
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { SanitizedCommand, SanitizedCommandOutcomeRunner } from '../../gws-ea/process.js';
import { LoginStore, LoginStoreError, loginStoreAvailability } from './login-store.js';

const INSTANCE = '38d6fb28-6c7f-4cc4-afaf-2919e8868cce';
const PASSWORD = 'Crane!7-river-timber';
const DETAILS = { site: 'accounts.cedar.example', username: 'alden', title: 'Cedar', password: PASSWORD };
let directory: string;
let browserRoot: string;
let key: string | undefined;
let unavailable: boolean;
let calls: SanitizedCommand[];
let store: LoginStore;
const dbFile = (): string => path.join(browserRoot, 'logins.db');
function raw<T>(read: (db: Database.Database) => T): T {
  const db = new Database(dbFile());
  try {
    return read(db);
  } finally {
    db.close();
  }
}
const blob = (id: string): Buffer =>
  raw((db) => {
    const result = db.prepare<[string], { password: Buffer }>('SELECT password FROM logins WHERE id = ?').get(id);
    if (!result) throw new Error('Fixture login missing');
    return result.password;
  });
const runCommand: SanitizedCommandOutcomeRunner = async (command) => {
  calls.push(command);
  if (unavailable) return { exitCode: 36, stdout: '', stderr: '' };
  if (command.args[0] === '-i') {
    key = command.input?.match(/-w ([a-f0-9]{64})/u)?.[1];
    return { exitCode: 0, stdout: '', stderr: '' };
  }
  return { exitCode: key ? 0 : 44, stdout: key ?? '', stderr: '' };
};

beforeEach(async () => {
  directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'login-store-')));
  browserRoot = path.join(directory, 'browser');
  key = undefined;
  unavailable = false;
  calls = [];
  store = new LoginStore({ browserRoot, instanceId: INSTANCE, runCommand });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

it('creates on the first add and decrypts using a fresh key read', async () => {
  const login = await store.create(DETAILS);
  expect(key).toMatch(/^[a-f0-9]{64}$/u);
  expect(login).toMatchObject({
    hostname: 'accounts.cedar.example',
    domain: 'cedar.example',
    username: 'alden',
    version: 1,
  });
  expect(await store.secret(login.id, 'password', 'https://www.cedar.example')).toBe(PASSWORD);
  expect(await loginStoreAvailability(store)).toEqual({ available: true });
  expect(calls.filter((call) => call.args[0] === '-i')).toHaveLength(1);
});

it('does not create a replacement key while a login exists, and metadata and removal still work', async () => {
  const login = await store.create(DETAILS);
  key = undefined;
  calls = [];
  expect(await loginStoreAvailability(store)).toEqual({ available: false, reason: 'key_missing' });
  await expect(store.create({ ...DETAILS, username: 'briar' })).rejects.toMatchObject({ reason: 'vault_unavailable' });
  await expect(store.secret(login.id, 'password', 'https://cedar.example')).rejects.toMatchObject({
    reason: 'vault_unavailable',
  });
  calls = [];
  expect(await store.all()).toEqual([login]);
  expect(await store.get(login.id)).toEqual(login);
  expect(await store.forOrigin('https://cedar.example')).toEqual([login]);
  await store.remove(login.id, login.version);
  expect(calls).toHaveLength(0);
  await store.create(DETAILS);
  expect(calls.filter((call) => call.args[0] === '-i')).toHaveLength(1);
});

it('detects a different key without decrypting a login, and adopts it after the last login is removed', async () => {
  const login = await store.create(DETAILS);
  key = 'b4'.repeat(32);
  calls = [];
  expect(await loginStoreAvailability(store)).toEqual({ available: false, reason: 'key_mismatch' });
  await expect(store.secret(login.id, 'password', 'https://cedar.example')).rejects.toMatchObject({
    reason: 'vault_unavailable',
  });
  await expect(store.create({ ...DETAILS, username: 'briar' })).rejects.toMatchObject({ reason: 'vault_unavailable' });
  await store.remove(login.id, login.version);
  const replacement = await store.create(DETAILS);
  expect(await store.secret(replacement.id, 'password', 'https://cedar.example')).toBe(PASSWORD);
  expect(calls.filter((call) => call.args[0] === '-i')).toHaveLength(0);
});

it('never creates or adopts a key while only a pending secret exists', async () => {
  await store.savePending('attempt-lark', PASSWORD);
  key = undefined;
  calls = [];
  expect(await loginStoreAvailability(store)).toEqual({ available: false, reason: 'key_missing' });
  await expect(store.savePending('attempt-finch', PASSWORD)).rejects.toMatchObject({ reason: 'vault_unavailable' });
  key = 'f2'.repeat(32);
  expect(await loginStoreAvailability(store)).toEqual({ available: false, reason: 'key_mismatch' });
  await expect(store.create(DETAILS)).rejects.toMatchObject({ reason: 'vault_unavailable' });
  expect(calls.filter((call) => call.args[0] === '-i')).toHaveLength(0);
  await store.deletePending('attempt-lark');
  const login = await store.create(DETAILS);
  expect(await store.secret(login.id, 'password', 'https://cedar.example')).toBe(PASSWORD);
});

it('reports locked Keychain availability and keeps listing and removing usable', async () => {
  const login = await store.create(DETAILS);
  unavailable = true;
  expect(await loginStoreAvailability(store)).toEqual({ available: false, reason: 'keychain_unavailable' });
  expect(await store.all()).toEqual([login]);
  await store.remove(login.id, login.version);
  await expect(store.create(DETAILS)).rejects.toMatchObject({ reason: 'vault_unavailable' });
});

it('checks a fresh empty store without creating a key', async () => {
  expect(await store.availability()).toEqual({ available: true });
  expect(key).toBeUndefined();
  expect(calls.filter((call) => call.args[0] === '-i')).toHaveLength(0);
});

it('keeps every password encrypted with a fresh IV and private file permissions', async () => {
  const first = await store.create(DETAILS);
  const second = await store.create({ ...DETAILS, username: 'briar' });
  const a = blob(first.id);
  const b = blob(second.id);
  expect(a.length).toBe(28 + Buffer.byteLength(PASSWORD));
  expect(a.equals(b)).toBe(false);
  expect(a.subarray(0, 12).equals(b.subarray(0, 12))).toBe(false);
  const contents = await readFile(dbFile());
  expect(contents.includes(Buffer.from(PASSWORD))).toBe(false);
  expect(contents.includes(Buffer.from(key ?? 'missing'))).toBe(false);
  expect((await stat(dbFile())).mode & 0o777).toBe(0o600);
  expect((await stat(browserRoot)).mode & 0o777).toBe(0o700);
  expect(raw((db) => db.pragma('journal_mode', { simple: true }))).toBe('delete');
  expect(first.createdAt).toBe(first.updatedAt);
});

it('overwrites a replaced encrypted password in the file contents and rejects stale edits and removals', async () => {
  const login = await store.create(DETAILS);
  const previous = blob(login.id);
  const nextPassword = 'Juniper$4-replacement';
  const updated = await store.update(login.id, login.version, { password: nextPassword, title: 'Cedar account' });
  expect(updated).toMatchObject({ id: login.id, version: 2, title: 'Cedar account' });
  expect(await store.secret(login.id, 'password', 'https://cedar.example')).toBe(nextPassword);
  expect((await readFile(dbFile())).includes(previous)).toBe(false);
  expect((await readFile(dbFile())).includes(Buffer.from(nextPassword))).toBe(false);
  await expect(store.update(login.id, 1, { password: PASSWORD })).rejects.toMatchObject({ reason: 'login_changed' });
  await expect(store.remove(login.id, 1)).rejects.toMatchObject({ reason: 'login_changed' });
  const keep = await store.update(login.id, 2, { password: '', username: 'briar' });
  expect(keep).toMatchObject({ username: 'briar', version: 3 });
  expect(await store.secret(login.id, 'password', 'https://cedar.example')).toBe(nextPassword);
  const removed = blob(login.id);
  await store.remove(login.id, 3);
  expect((await readFile(dbFile())).includes(removed)).toBe(false);
});

it('refuses a foreign domain before reading the key and isolates private registrable domains', async () => {
  const login = await store.create(DETAILS);
  calls = [];
  for (const origin of ['https://elm.example', 'http://cedar.example', 'https://cedar.example@elm.example']) {
    await expect(store.secret(login.id, 'password', origin)).rejects.toMatchObject({ reason: 'origin_mismatch' });
  }
  expect(calls).toHaveLength(0);
  const privateLogin = await store.create({ ...DETAILS, site: 'alden.github.io' });
  expect(await store.forOrigin('https://briar.github.io')).toEqual([]);
  await expect(store.secret(privateLogin.id, 'password', 'https://briar.github.io')).rejects.toMatchObject({
    reason: 'origin_mismatch',
  });
  expect(await store.forOrigin('https://sub.alden.github.io')).toEqual([privateLogin]);
});

it('requires a usable key for username fills and metadata-only saves, while retaining metadata reads', async () => {
  const login = await store.create(DETAILS);
  unavailable = true;
  expect((await store.get(login.id)).username).toBe('alden');
  await expect(store.secret(login.id, 'username', 'https://cedar.example')).rejects.toMatchObject({
    reason: 'vault_unavailable',
  });
  await expect(store.update(login.id, 1, { password: '', title: 'Edited' })).rejects.toMatchObject({
    reason: 'vault_unavailable',
  });
  expect((await store.get(login.id)).title).toBe('Cedar');
});

it('returns only a constant error after tampering, without plaintext, keys, causes or logging', async () => {
  const login = await store.create(DETAILS);
  const sealed = blob(login.id);
  sealed[12] ^= 1;
  raw((db) => {
    db.prepare('UPDATE logins SET password = ? WHERE id = ?').run(sealed, login.id);
  });
  const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'error'), vi.spyOn(console, 'warn')];
  const failure: unknown = await store
    .secret(login.id, 'password', 'https://cedar.example')
    .catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(LoginStoreError);
  expect(failure).toMatchObject({ reason: 'vault_unavailable', message: 'vault_unavailable' });
  expect(JSON.stringify(failure, Object.getOwnPropertyNames(failure))).not.toContain(PASSWORD);
  expect(JSON.stringify(failure, Object.getOwnPropertyNames(failure))).not.toContain(key);
  expect(failure).not.toHaveProperty('cause');
  for (const log of logs) expect(log).not.toHaveBeenCalled();
});

it('binds ciphertext to the assistant even if the same key is supplied', async () => {
  const login = await store.create(DETAILS);
  const copiedRoot = path.join(directory, 'other-browser');
  await mkdir(copiedRoot);
  await copyFile(dbFile(), path.join(copiedRoot, 'logins.db'));
  const copied = new LoginStore({
    browserRoot: copiedRoot,
    instanceId: 'b4530151-e71e-42e3-8edb-b139426b08ee',
    runCommand,
  });
  expect(await copied.availability()).toEqual({ available: false, reason: 'key_mismatch' });
  await expect(copied.secret(login.id, 'password', 'https://cedar.example')).rejects.toMatchObject({
    reason: 'vault_unavailable',
  });
});

it('copies and deletes a pending password in one key-free confirmation, including rotation version checks', async () => {
  await store.savePending('attempt-lark', PASSWORD);
  expect(await store.disclosePending('attempt-lark')).toBe(PASSWORD);
  const pending = raw(
    (db) =>
      db
        .prepare<[string], { password: Buffer }>('SELECT password FROM pending WHERE attempt_id = ?')
        .get('attempt-lark')?.password,
  );
  unavailable = true;
  calls = [];
  expect(await store.pendingIds()).toEqual(['attempt-lark']);
  const login = await store.confirmPending('attempt-lark', { kind: 'signup', details: DETAILS });
  expect(login).toBeDefined();
  if (!login) throw new Error('Fixture confirmation failed');
  expect(blob(login.id).equals(pending ?? Buffer.alloc(0))).toBe(true);
  expect(await store.hasPending('attempt-lark')).toBe(false);
  expect(await store.confirmPending('attempt-lark', { kind: 'signup', details: DETAILS })).toBeUndefined();
  expect(calls).toHaveLength(0);
  unavailable = false;
  const changedPassword = 'Finch!6-new-password';
  await store.savePending('attempt-finch', changedPassword);
  unavailable = true;
  calls = [];
  await expect(
    store.confirmPending('attempt-finch', { kind: 'rotation', loginId: login.id, version: 2 }),
  ).rejects.toMatchObject({ reason: 'login_changed' });
  expect(await store.hasPending('attempt-finch')).toBe(true);
  const updated = await store.confirmPending('attempt-finch', { kind: 'rotation', loginId: login.id, version: 1 });
  expect(updated?.version).toBe(2);
  expect(await store.hasPending('attempt-finch')).toBe(false);
  expect(calls).toHaveLength(0);
  unavailable = false;
  expect(await store.secret(login.id, 'password', 'https://cedar.example')).toBe(changedPassword);
  expect((await readFile(dbFile())).includes(pending ?? Buffer.alloc(0))).toBe(false);
});

it('deletes orphan and released pending rows without a key and leaves the login password intact', async () => {
  const login = await store.create(DETAILS);
  await store.savePending('attempt-lark', 'Wren$8-not-confirmed');
  const pending = raw(
    (db) =>
      db
        .prepare<[string], { password: Buffer }>('SELECT password FROM pending WHERE attempt_id = ?')
        .get('attempt-lark')?.password,
  );
  unavailable = true;
  calls = [];
  await store.deletePending('attempt-lark');
  await store.deletePending('attempt-lark');
  expect(await store.pendingIds()).toEqual([]);
  expect(calls).toHaveLength(0);
  expect((await readFile(dbFile())).includes(pending ?? Buffer.alloc(0))).toBe(false);
  unavailable = false;
  expect(await store.secret(login.id, 'password', 'https://cedar.example')).toBe(PASSWORD);
});

it('does not overwrite an existing pending secret', async () => {
  await store.savePending('attempt-lark', PASSWORD);
  await expect(store.savePending('attempt-lark', 'Different!7')).rejects.toMatchObject({ reason: 'login_changed' });
  expect(await store.disclosePending('attempt-lark')).toBe(PASSWORD);
});

it('serializes first-use key creation across store instances without losing either password', async () => {
  const other = new LoginStore({ browserRoot, instanceId: INSTANCE, runCommand });
  const [first, second] = await Promise.all([store.create(DETAILS), other.create({ ...DETAILS, username: 'briar' })]);
  expect(calls.filter((call) => call.args[0] === '-i')).toHaveLength(1);
  expect(await store.secret(first.id, 'password', 'https://cedar.example')).toBe(PASSWORD);
  expect(await other.secret(second.id, 'password', 'https://cedar.example')).toBe(PASSWORD);
});

it('enforces native site and duplicate validation without disclosing input in errors', async () => {
  for (const site of [
    'http://cedar.example',
    'https://alden:private@cedar.example',
    'https://127.0.0.1',
    'cedar example',
  ]) {
    await expect(store.create({ ...DETAILS, site })).rejects.toMatchObject({
      reason: 'invalid_site',
      message: 'invalid_site',
    });
  }
  await expect(store.create({ ...DETAILS, password: '' })).rejects.toMatchObject({ reason: 'invalid_details' });
  await store.create(DETAILS);
  await expect(store.create({ ...DETAILS, site: 'https://other.cedar.example/path?private=1' })).rejects.toMatchObject({
    reason: 'duplicate_login',
  });
  expect(await store.all()).toHaveLength(1);
});

it('refuses symlinked and hard-linked store files before reading any key', async () => {
  await mkdir(browserRoot);
  const target = path.join(directory, 'target.db');
  await writeFile(target, 'private fixture');
  await symlink(target, dbFile());
  await expect(store.all()).rejects.toMatchObject({ reason: 'vault_unavailable' });
  await rm(dbFile());
  await link(target, dbFile());
  await expect(store.all()).rejects.toMatchObject({ reason: 'vault_unavailable' });
  expect(calls).toHaveLength(0);
});

it('repairs existing owner-only modes and turns invalid databases into constant errors', async () => {
  await store.create(DETAILS);
  await chmod(browserRoot, 0o755);
  await chmod(dbFile(), 0o644);
  await store.all();
  expect((await stat(browserRoot)).mode & 0o777).toBe(0o700);
  expect((await stat(dbFile())).mode & 0o777).toBe(0o600);
  await writeFile(dbFile(), PASSWORD);
  await expect(store.all()).rejects.toMatchObject({ reason: 'vault_unavailable', message: 'vault_unavailable' });
});
