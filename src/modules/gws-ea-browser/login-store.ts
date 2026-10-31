import { createCipheriv, createDecipheriv, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getDomain } from 'tldts';
import type { SanitizedCommandOutcomeRunner } from '../../gws-ea/process.js';
import { LoginKey } from './login-key.js';
import { browserPaths, ensurePrivateDirectory } from './paths.js';

export type LoginStoreReason = 'vault_unavailable' | 'no_item_for_site' | 'origin_mismatch' | 'pending_missing';
export class LoginStoreError extends Error {
  constructor(readonly reason: LoginStoreReason) {
    super(reason);
  }
}
export class LoginDetailsError extends Error {
  constructor(readonly reason: 'invalid_site' | 'invalid_details' | 'duplicate_login' | 'login_changed') {
    super(reason);
  }
}
export interface SavedLogin {
  readonly id: string;
  readonly hostname: string;
  readonly domain: string;
  readonly username: string;
  readonly title: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface LoginDetails {
  readonly site: string;
  readonly username: string;
  readonly title: string;
  readonly password: string;
}
export type LoginChanges = Partial<Omit<LoginDetails, 'password'>> & Pick<LoginDetails, 'password'>;
export type PendingConfirmation =
  | { readonly kind: 'signup'; readonly details: Omit<LoginDetails, 'password'> }
  | { readonly kind: 'rotation'; readonly loginId: string; readonly version: number };
export type LoginStoreAvailability =
  | { readonly available: true }
  | { readonly available: false; readonly reason: 'key_missing' | 'key_mismatch' | 'keychain_unavailable' };
export interface LoginStoreOptions {
  readonly browserRoot: string;
  readonly instanceId: string;
  readonly runCommand?: SanitizedCommandOutcomeRunner;
}

const CHECK = Buffer.from('gws-ea-logins-key-check:v1', 'utf8');
const COLUMNS = 'id, hostname, domain, username, title, version, created_at AS createdAt, updated_at AS updatedAt';
const SCHEMA = `
CREATE TABLE IF NOT EXISTS logins (
  id TEXT PRIMARY KEY, hostname TEXT NOT NULL, domain TEXT NOT NULL, username TEXT NOT NULL,
  title TEXT NOT NULL, password BLOB NOT NULL CHECK(length(password) >= 28), version INTEGER NOT NULL CHECK(version > 0),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(domain, username)
) STRICT;
CREATE TABLE IF NOT EXISTS pending (
  attempt_id TEXT PRIMARY KEY, password BLOB NOT NULL CHECK(length(password) >= 28)
) STRICT;
CREATE TABLE IF NOT EXISTS meta (
  id INTEGER PRIMARY KEY CHECK(id = 1), key_check BLOB NOT NULL
) STRICT;`;
// Serialize the async Keychain read with writes across bindings to the same host-owned file.
// These gates retain no keys, passwords, results or open database handles.
const gates = new Map<string, Promise<void>>();

function httpsWebsite(raw: string): URL | undefined {
  if (!URL.canParse(raw)) return undefined;
  const url = new URL(raw);
  return url.protocol === 'https:' && !url.username && !url.password ? url : undefined;
}
export function registrableDomain(origin: string): string | undefined {
  const url = httpsWebsite(origin);
  return (url && getDomain(url.hostname, { allowPrivateDomains: true })) || undefined;
}
function details(spec: Omit<LoginDetails, 'password'>): Pick<SavedLogin, 'hostname' | 'domain' | 'username' | 'title'> {
  const site = spec.site.trim();
  const url = httpsWebsite(site.includes('://') ? site : `https://${site}`);
  const domain = url && getDomain(url.hostname, { allowPrivateDomains: true });
  if (!site || /[\s\\]/u.test(site) || !url || !domain) throw new LoginDetailsError('invalid_site');
  if (!spec.username.trim() || spec.username.length > 320 || /\p{Cc}/u.test(spec.username))
    throw new LoginDetailsError('invalid_details');
  if (spec.title.length > 200 || /\p{Cc}/u.test(spec.title)) throw new LoginDetailsError('invalid_details');
  return { hostname: url.hostname, domain, username: spec.username, title: spec.title.trim() || url.hostname };
}
function passwordValid(password: string): void {
  if (!password || password.length > 64 * 1024) throw new LoginDetailsError('invalid_details');
}
function versionValid(version: number): void {
  if (!Number.isSafeInteger(version) || version < 1) throw new LoginDetailsError('login_changed');
}
function attemptValid(attemptId: string): void {
  if (!attemptId || attemptId.length > 200 || /\p{Cc}/u.test(attemptId)) throw new LoginDetailsError('invalid_details');
}

/** A direct, host-only file: only passwords are encrypted; every metadata read is independent of Keychain. */
export class LoginStore {
  private readonly file: string;
  private readonly key: LoginKey;
  private readonly aad: Buffer;
  constructor(private readonly options: LoginStoreOptions) {
    this.file = path.join(browserPaths(options.browserRoot).root, 'logins.db');
    this.key = new LoginKey(options);
    this.aad = Buffer.from(`gws-ea-logins:v1|${options.instanceId}`, 'utf8');
  }

  private async database(): Promise<Database.Database> {
    await ensurePrivateDirectory(this.options.browserRoot);
    const handle = await open(this.file, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || (process.getuid !== undefined && stat.uid !== process.getuid()))
        throw new LoginStoreError('vault_unavailable');
      if ((stat.mode & 0o7777) !== 0o600) await handle.chmod(0o600);
    } finally {
      await handle.close();
    }
    const db = new Database(this.file);
    try {
      db.pragma('journal_mode = DELETE');
      db.pragma('secure_delete = ON');
      db.pragma('synchronous = FULL');
      db.exec(SCHEMA);
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  private async use<T>(operation: (db: Database.Database) => T | Promise<T>): Promise<T> {
    const previous = gates.get(this.file);
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    gates.set(this.file, gate);
    await previous;
    try {
      const db = await this.database();
      try {
        return await operation(db);
      } finally {
        db.close();
      }
    } catch (error) {
      if (error instanceof LoginStoreError || error instanceof LoginDetailsError) throw error;
      throw new LoginStoreError('vault_unavailable');
    } finally {
      release();
      if (gates.get(this.file) === gate) gates.delete(this.file);
    }
  }

  private hasSecrets(db: Database.Database): boolean {
    return (
      db
        .prepare<
          [],
          { present: number }
        >('SELECT EXISTS(SELECT 1 FROM logins UNION ALL SELECT 1 FROM pending) AS present')
        .get()?.present === 1
    );
  }
  private seal(value: Buffer, key: Buffer): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    cipher.setAAD(this.aad);
    const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
  }
  private unseal(blob: Buffer, key: Buffer): Buffer {
    if (!Buffer.isBuffer(blob) || blob.length < 28) throw new LoginStoreError('vault_unavailable');
    const decipher = createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12), { authTagLength: 16 });
    decipher.setAAD(this.aad);
    decipher.setAuthTag(blob.subarray(12, 28));
    // Keep unauthenticated bytes out of returned values even when final() rejects.
    const decoded = decipher.update(blob.subarray(28));
    try {
      return Buffer.concat([decoded, decipher.final()]);
    } finally {
      decoded.fill(0);
    }
  }
  private matchesKey(db: Database.Database, key: Buffer): boolean {
    const check = db.prepare<[], { key_check: Buffer }>('SELECT key_check FROM meta WHERE id = 1').get();
    if (!check) return false;
    let value: Buffer | undefined;
    try {
      value = this.unseal(check.key_check, key);
      return value.length === CHECK.length && timingSafeEqual(value, CHECK);
      // eslint-disable-next-line no-catch-all/no-catch-all -- Authentication failure is the constant key_mismatch state.
    } catch {
      return false;
    } finally {
      value?.fill(0);
    }
  }
  private async withKey<T>(db: Database.Database, operation: (key: Buffer) => T): Promise<T> {
    const populated = this.hasSecrets(db);
    let read = await this.key.read();
    if (read.status === 'missing' && !populated) read = await this.key.create();
    if (read.status !== 'ready') throw new LoginStoreError('vault_unavailable');
    try {
      if (populated) {
        if (!this.matchesKey(db, read.key)) throw new LoginStoreError('vault_unavailable');
      } else {
        db.prepare(
          'INSERT INTO meta (id, key_check) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET key_check = excluded.key_check',
        ).run(this.seal(CHECK, read.key));
      }
      return operation(read.key);
    } finally {
      read.key.fill(0);
    }
  }

  async availability(): Promise<LoginStoreAvailability> {
    try {
      return await this.use(async (db) => {
        const populated = this.hasSecrets(db);
        const read = await this.key.read();
        if (read.status === 'unavailable') return { available: false, reason: 'keychain_unavailable' };
        if (read.status === 'missing')
          return populated ? { available: false, reason: 'key_missing' } : { available: true };
        try {
          return !populated || this.matchesKey(db, read.key)
            ? { available: true }
            : { available: false, reason: 'key_mismatch' };
        } finally {
          read.key.fill(0);
        }
      });
    } catch (error) {
      if (error instanceof LoginStoreError) return { available: false, reason: 'keychain_unavailable' };
      throw error;
    }
  }

  async all(): Promise<readonly SavedLogin[]> {
    return this.use((db) => db.prepare<[], SavedLogin>(`SELECT ${COLUMNS} FROM logins ORDER BY title, id`).all());
  }
  async forOrigin(origin: string): Promise<readonly SavedLogin[]> {
    const domain = registrableDomain(origin);
    if (!domain) return [];
    return this.use((db) =>
      db.prepare<[string], SavedLogin>(`SELECT ${COLUMNS} FROM logins WHERE domain = ? ORDER BY title, id`).all(domain),
    );
  }
  private login(db: Database.Database, id: string): SavedLogin {
    const row = db.prepare<[string], SavedLogin>(`SELECT ${COLUMNS} FROM logins WHERE id = ?`).get(id);
    if (!row) throw new LoginStoreError('no_item_for_site');
    return row;
  }
  async get(id: string): Promise<SavedLogin> {
    return this.use((db) => this.login(db, id));
  }
  async secret(id: string, field: 'username' | 'password', origin: string): Promise<string> {
    return this.use(async (db) => {
      const login = this.login(db, id);
      if (registrableDomain(origin) !== login.domain) throw new LoginStoreError('origin_mismatch');
      return this.withKey(db, (key) => {
        if (field === 'username') return login.username;
        const row = db.prepare<[string], { password: Buffer }>('SELECT password FROM logins WHERE id = ?').get(id);
        if (!row) throw new LoginStoreError('no_item_for_site');
        const plaintext = this.unseal(row.password, key);
        try {
          return plaintext.toString('utf8');
        } finally {
          plaintext.fill(0);
        }
      });
    });
  }

  private assertDistinct(db: Database.Database, domain: string, username: string, id = ''): void {
    if (db.prepare('SELECT 1 FROM logins WHERE domain = ? AND username = ? AND id != ?').get(domain, username, id))
      throw new LoginDetailsError('duplicate_login');
  }
  private insert(db: Database.Database, metadata: ReturnType<typeof details>, password: Buffer): SavedLogin {
    this.assertDistinct(db, metadata.domain, metadata.username);
    const at = new Date().toISOString();
    const login: SavedLogin = { ...metadata, id: `vault_${randomUUID()}`, version: 1, createdAt: at, updatedAt: at };
    db.prepare(
      'INSERT INTO logins (id, hostname, domain, username, title, password, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      login.id,
      login.hostname,
      login.domain,
      login.username,
      login.title,
      password,
      login.version,
      login.createdAt,
      login.updatedAt,
    );
    return login;
  }
  async create(spec: LoginDetails): Promise<SavedLogin> {
    const metadata = details(spec);
    passwordValid(spec.password);
    return this.use((db) =>
      this.withKey(db, (key) => {
        const plaintext = Buffer.from(spec.password, 'utf8');
        try {
          const sealed = this.seal(plaintext, key);
          return db.transaction(() => this.insert(db, metadata, sealed)).immediate();
        } finally {
          plaintext.fill(0);
        }
      }),
    );
  }
  async update(id: string, version: number, changes: LoginChanges): Promise<SavedLogin> {
    versionValid(version);
    if (changes.password) passwordValid(changes.password);
    return this.use(async (db) => {
      const before = this.login(db, id);
      if (before.version !== version) throw new LoginDetailsError('login_changed');
      const metadata = details({
        site: changes.site ?? before.hostname,
        username: changes.username ?? before.username,
        title: changes.title ?? before.title,
      });
      return this.withKey(db, (key) => {
        let plaintext: Buffer | undefined;
        try {
          plaintext = changes.password ? Buffer.from(changes.password, 'utf8') : undefined;
          const sealed = plaintext ? this.seal(plaintext, key) : undefined;
          return db
            .transaction(() => {
              this.assertDistinct(db, metadata.domain, metadata.username, id);
              const params = [
                metadata.hostname,
                metadata.domain,
                metadata.username,
                metadata.title,
                new Date().toISOString(),
              ];
              const result = sealed
                ? db
                    .prepare(
                      'UPDATE logins SET hostname = ?, domain = ?, username = ?, title = ?, updated_at = ?, password = ?, version = version + 1 WHERE id = ? AND version = ?',
                    )
                    .run(...params, sealed, id, version)
                : db
                    .prepare(
                      'UPDATE logins SET hostname = ?, domain = ?, username = ?, title = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?',
                    )
                    .run(...params, id, version);
              if (result.changes !== 1) throw new LoginDetailsError('login_changed');
              return this.login(db, id);
            })
            .immediate();
        } finally {
          plaintext?.fill(0);
        }
      });
    });
  }
  async remove(id: string, version: number): Promise<void> {
    versionValid(version);
    await this.use((db) => {
      const login = this.login(db, id);
      if (login.version !== version) throw new LoginDetailsError('login_changed');
      if (db.prepare('DELETE FROM logins WHERE id = ? AND version = ?').run(id, version).changes !== 1)
        throw new LoginDetailsError('login_changed');
    });
  }

  async savePending(attemptId: string, password: string): Promise<void> {
    attemptValid(attemptId);
    passwordValid(password);
    await this.use((db) =>
      this.withKey(db, (key) => {
        const plaintext = Buffer.from(password, 'utf8');
        try {
          if (db.prepare('SELECT 1 FROM pending WHERE attempt_id = ?').get(attemptId))
            throw new LoginDetailsError('login_changed');
          db.prepare('INSERT INTO pending (attempt_id, password) VALUES (?, ?)').run(
            attemptId,
            this.seal(plaintext, key),
          );
        } finally {
          plaintext.fill(0);
        }
      }),
    );
  }
  async pendingIds(): Promise<readonly string[]> {
    return this.use((db) =>
      db
        .prepare<[], { attempt_id: string }>('SELECT attempt_id FROM pending ORDER BY attempt_id')
        .all()
        .map((row) => row.attempt_id),
    );
  }
  async hasPending(attemptId: string): Promise<boolean> {
    return this.use((db) => Boolean(db.prepare('SELECT 1 FROM pending WHERE attempt_id = ?').get(attemptId)));
  }
  async disclosePending(attemptId: string): Promise<string> {
    return this.use((db) => {
      const row = db
        .prepare<[string], { password: Buffer }>('SELECT password FROM pending WHERE attempt_id = ?')
        .get(attemptId);
      if (!row) throw new LoginStoreError('pending_missing');
      return this.withKey(db, (key) => {
        const plaintext = this.unseal(row.password, key);
        try {
          return plaintext.toString('utf8');
        } finally {
          plaintext.fill(0);
        }
      });
    });
  }
  async deletePending(attemptId: string): Promise<void> {
    await this.use((db) => {
      db.prepare('DELETE FROM pending WHERE attempt_id = ?').run(attemptId);
    });
  }
  /** No Keychain operation: the same assistant-bound ciphertext moves atomically into its login. */
  async confirmPending(attemptId: string, target: PendingConfirmation): Promise<SavedLogin | undefined> {
    const metadata = target.kind === 'signup' ? details(target.details) : undefined;
    if (target.kind === 'rotation') versionValid(target.version);
    return this.use((db) =>
      db
        .transaction(() => {
          const row = db
            .prepare<[string], { password: Buffer }>('SELECT password FROM pending WHERE attempt_id = ?')
            .get(attemptId);
          if (!row) return undefined;
          let login: SavedLogin;
          if (target.kind === 'signup' && metadata) login = this.insert(db, metadata, row.password);
          else if (target.kind === 'rotation') {
            const result = db
              .prepare(
                'UPDATE logins SET password = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?',
              )
              .run(row.password, new Date().toISOString(), target.loginId, target.version);
            if (result.changes !== 1) throw new LoginDetailsError('login_changed');
            login = this.login(db, target.loginId);
          } else throw new LoginDetailsError('invalid_details');
          db.prepare('DELETE FROM pending WHERE attempt_id = ?').run(attemptId);
          return login;
        })
        .immediate(),
    );
  }
}

export async function loginStoreAvailability(store: LoginStore): Promise<LoginStoreAvailability> {
  return store.availability();
}
