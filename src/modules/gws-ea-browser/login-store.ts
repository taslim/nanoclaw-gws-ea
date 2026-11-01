import { createCipheriv, createDecipheriv, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getDomain } from 'tldts';
import { instanceMarkerFile } from '../../gws-ea/paths.js';
import { readInstanceMarkerFile } from '../../gws-ea/registry.js';
import { instanceLayout } from '../../gws-ea/release-layout.js';
import { GwsEaError } from '../../gws-ea/types.js';
import { browserRoot } from './availability.js';
import type { SanitizedCommandOutcomeRunner } from '../../gws-ea/process.js';
import { hasControlCharacters } from '../../gws-ea/validation.js';
import { httpsOrigin } from './authentication-signatures.js';
import { LoginKey } from './login-key.js';
import { browserPaths, ensurePrivateDirectory } from './paths.js';
import {
  CredentialAttemptError,
  RELEASABLE_PHASES,
  HELD_CREDENTIAL_PHASES,
  credentialEvidenceJson,
  type CredentialAttempt,
  type CredentialAttemptPhase,
  type CredentialEvidence,
} from './credential-types.js';

export type LoginStoreReason = 'vault_unavailable' | 'no_item_for_site' | 'origin_mismatch';
export class LoginStoreError extends Error {
  constructor(readonly reason: LoginStoreReason) {
    super(reason);
  }
}
export class LoginDetailsError extends Error {
  constructor(
    readonly reason: 'invalid_site' | 'invalid_details' | 'duplicate_login' | 'login_changed' | 'login_busy',
  ) {
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
const ATTEMPT_COLUMNS =
  'id, kind, job_id, origin, site, username, source_login_id, source_version, phase, evidence_json, owned_login_id, created_at, updated_at, exposed_at, finalized_at';
const SCHEMA = `
CREATE TABLE IF NOT EXISTS logins (
  id TEXT PRIMARY KEY, hostname TEXT NOT NULL, domain TEXT NOT NULL, username TEXT NOT NULL,
  title TEXT NOT NULL, password BLOB NOT NULL CHECK(length(password) >= 28), version INTEGER NOT NULL CHECK(version > 0),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(domain, username)
) STRICT;
CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('signup','rotation')),
  job_id TEXT NOT NULL, origin TEXT NOT NULL, site TEXT NOT NULL, username TEXT NOT NULL,
  source_login_id TEXT, source_version INTEGER,
  phase TEXT NOT NULL CHECK(phase IN ('saved','exposed','awaiting_verification','unknown','finalized','rejected')),
  password BLOB, evidence_json TEXT, owned_login_id TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, exposed_at TEXT, finalized_at TEXT,
  CHECK((kind = 'rotation') = (source_login_id IS NOT NULL)),
  CHECK((source_login_id IS NULL) = (source_version IS NULL)),
  CHECK(owned_login_id IS NULL OR phase = 'finalized'),
  CHECK(CASE WHEN phase IN ('rejected','finalized') THEN password IS NULL
    ELSE password IS NOT NULL AND length(password) >= 28 END)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS open_rotation ON attempts(source_login_id)
  WHERE source_login_id IS NOT NULL AND phase NOT IN ('rejected','finalized');
CREATE INDEX IF NOT EXISTS signup_ownership ON attempts(site,username)
  WHERE kind = 'signup' AND phase = 'finalized';
CREATE TABLE IF NOT EXISTS meta (
  id INTEGER PRIMARY KEY CHECK(id = 1), key_check BLOB NOT NULL
) STRICT;`;
const fileOperationGates = new Map<string, Promise<void>>();

export function registrableDomain(origin: string): string | undefined {
  const url = httpsOrigin(origin);
  return (url && getDomain(url.hostname, { allowPrivateDomains: true })) || undefined;
}
export function loginMetadata(
  spec: Omit<LoginDetails, 'password'>,
): Pick<SavedLogin, 'hostname' | 'domain' | 'username' | 'title'> {
  const site = spec.site.trim();
  const url = httpsOrigin(site.includes('://') ? site : `https://${site}`);
  const domain = url && getDomain(url.hostname, { allowPrivateDomains: true });
  if (!site || /[\s\\]/u.test(site) || !url || !domain) throw new LoginDetailsError('invalid_site');
  if (!spec.username.trim() || spec.username.length > 320 || hasControlCharacters(spec.username))
    throw new LoginDetailsError('invalid_details');
  if (spec.title.length > 200 || hasControlCharacters(spec.title)) throw new LoginDetailsError('invalid_details');
  return { hostname: url.hostname, domain, username: spec.username, title: spec.title.trim() || url.hostname };
}
function passwordValid(password: string): void {
  if (!password || password.length > 64 * 1024) throw new LoginDetailsError('invalid_details');
}
function versionValid(version: number): void {
  if (!Number.isSafeInteger(version) || version < 1) throw new LoginDetailsError('login_changed');
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
    const previous = fileOperationGates.get(this.file);
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fileOperationGates.set(this.file, gate);
    await previous;
    try {
      const db = await this.database();
      try {
        return await operation(db);
      } finally {
        db.close();
      }
    } catch (error) {
      if (
        error instanceof LoginStoreError ||
        error instanceof LoginDetailsError ||
        error instanceof CredentialAttemptError
      )
        throw error;
      throw new LoginStoreError('vault_unavailable');
    } finally {
      release();
      if (fileOperationGates.get(this.file) === gate) fileOperationGates.delete(this.file);
    }
  }

  private hasSecrets(db: Database.Database): boolean {
    return (
      db
        .prepare<
          [],
          { present: number }
        >('SELECT EXISTS(SELECT 1 FROM logins UNION ALL SELECT 1 FROM attempts WHERE password IS NOT NULL) AS present')
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
  private insert(db: Database.Database, metadata: ReturnType<typeof loginMetadata>, password: Buffer): SavedLogin {
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
    const metadata = loginMetadata(spec);
    passwordValid(spec.password);
    return this.use((db) => {
      this.editableAttempts(db, null, metadata);
      return this.withKey(db, (key) => {
        const plaintext = Buffer.from(spec.password, 'utf8');
        try {
          const sealed = this.seal(plaintext, key);
          return db
            .transaction(() => {
              this.giveWay(db, null, metadata);
              return this.insert(db, metadata, sealed);
            })
            .immediate();
        } finally {
          plaintext.fill(0);
        }
      });
    });
  }
  async update(id: string, version: number, changes: LoginChanges): Promise<SavedLogin> {
    versionValid(version);
    if (changes.password) passwordValid(changes.password);
    return this.use(async (db) => {
      const before = this.login(db, id);
      if (before.version !== version) throw new LoginDetailsError('login_changed');
      const metadata = loginMetadata({
        site: changes.site ?? before.hostname,
        username: changes.username ?? before.username,
        title: changes.title ?? before.title,
      });
      this.editableAttempts(db, id, metadata);
      return this.withKey(db, (key) => {
        let plaintext: Buffer | undefined;
        try {
          plaintext = changes.password ? Buffer.from(changes.password, 'utf8') : undefined;
          const sealed = plaintext ? this.seal(plaintext, key) : undefined;
          return db
            .transaction(() => {
              this.assertDistinct(db, metadata.domain, metadata.username, id);
              this.giveWay(db, id, metadata);
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
    await this.use((db) =>
      db
        .transaction(() => {
          const login = this.login(db, id);
          if (login.version !== version) throw new LoginDetailsError('login_changed');
          this.giveWay(db, id);
          if (db.prepare('DELETE FROM logins WHERE id = ? AND version = ?').run(id, version).changes !== 1)
            throw new LoginDetailsError('login_changed');
        })
        .immediate(),
    );
  }

  private attempt(db: Database.Database, id: string): CredentialAttempt {
    const attempt = db
      .prepare<[string], CredentialAttempt>(`SELECT ${ATTEMPT_COLUMNS} FROM attempts WHERE id = ?`)
      .get(id);
    if (!attempt) throw new CredentialAttemptError('not_found');
    return attempt;
  }
  async getAttempt(id: string): Promise<CredentialAttempt | undefined> {
    return this.use((db) =>
      db.prepare<[string], CredentialAttempt>(`SELECT ${ATTEMPT_COLUMNS} FROM attempts WHERE id = ?`).get(id),
    );
  }
  async unresolvedAttempts(): Promise<CredentialAttempt[]> {
    return this.use((db) =>
      db
        .prepare<
          [],
          CredentialAttempt
        >(`SELECT ${ATTEMPT_COLUMNS} FROM attempts WHERE phase NOT IN ('rejected','finalized') ORDER BY created_at, id`)
        .all(),
    );
  }
  async unresolvedAttemptCount(): Promise<number> {
    return this.use(
      (db) =>
        db
          .prepare<
            [],
            { count: number }
          >("SELECT COUNT(*) AS count FROM attempts WHERE phase NOT IN ('rejected','finalized')")
          .get()?.count ?? 0,
    );
  }
  async heldSites(jobId: string): Promise<string[]> {
    return this.use((db) =>
      db
        .prepare<string[], { site: string }>(
          `SELECT site FROM attempts WHERE job_id = ? AND phase IN (${HELD_CREDENTIAL_PHASES.map(() => '?').join(',')}) ORDER BY created_at, id`,
        )
        .all(jobId, ...HELD_CREDENTIAL_PHASES)
        .map(({ site }) => site),
    );
  }
  async siteHeldByOther(jobId: string, site: string): Promise<boolean> {
    return this.use((db) =>
      Boolean(
        db
          .prepare(
            `SELECT 1 FROM attempts WHERE job_id <> ? AND site = ? AND phase IN (${HELD_CREDENTIAL_PHASES.map(() => '?').join(',')}) LIMIT 1`,
          )
          .get(jobId, site, ...HELD_CREDENTIAL_PHASES),
      ),
    );
  }
  async hasOwnedSignup(site: string, username: string): Promise<boolean> {
    return this.use((db) =>
      Boolean(
        db
          .prepare(
            "SELECT 1 FROM attempts WHERE kind = 'signup' AND phase = 'finalized' AND site = ? AND username = ? LIMIT 1",
          )
          .get(site, username),
      ),
    );
  }
  async saveAttempt(attempt: CredentialAttempt, password: string): Promise<'prepared' | 'busy'> {
    passwordValid(password);
    return this.use((db) =>
      this.withKey(db, (key) => {
        const plaintext = Buffer.from(password, 'utf8');
        try {
          const sealed = this.seal(plaintext, key);
          return db
            .transaction(() => {
              if (attempt.kind === 'rotation') {
                const login = this.login(db, attempt.source_login_id);
                if (
                  login.version !== attempt.source_version ||
                  login.domain !== attempt.site ||
                  login.username !== attempt.username
                )
                  throw new LoginDetailsError('login_changed');
                const open = db
                  .prepare<
                    [string],
                    CredentialAttempt
                  >(`SELECT ${ATTEMPT_COLUMNS} FROM attempts WHERE source_login_id = ? AND phase NOT IN ('rejected','finalized')`)
                  .get(login.id);
                if (open) {
                  if (open.job_id === attempt.job_id || open.phase !== 'saved') return 'busy';
                  this.move(db, open.id, ['saved'], 'rejected');
                }
              } else if (
                db
                  .prepare<[string, string], { id: string }>('SELECT id FROM logins WHERE domain = ? AND username = ?')
                  .get(attempt.site, attempt.username)
              )
                return 'busy';
              db.prepare(
                `INSERT INTO attempts (${ATTEMPT_COLUMNS}, password) VALUES (${Array.from({ length: 16 }, () => '?').join(',')})`,
              ).run(
                attempt.id,
                attempt.kind,
                attempt.job_id,
                attempt.origin,
                attempt.site,
                attempt.username,
                attempt.source_login_id,
                attempt.source_version,
                attempt.phase,
                attempt.evidence_json,
                attempt.owned_login_id,
                attempt.created_at,
                attempt.updated_at,
                attempt.exposed_at,
                attempt.finalized_at,
                sealed,
              );
              return 'prepared';
            })
            .immediate();
        } finally {
          plaintext.fill(0);
        }
      }),
    );
  }
  async exposeAttempt(
    id: string,
    assertActive: () => Promise<void>,
  ): Promise<
    { status: 'exposed'; password: string; currentPassword?: string } | { status: 'not_saved' | 'source_changed' }
  > {
    const credential = await this.use(async (db) => {
      const attempt = this.attempt(db, id);
      if (attempt.phase !== 'saved') return { status: 'not_saved' as const };
      if (attempt.kind === 'rotation' && this.login(db, attempt.source_login_id).version !== attempt.source_version)
        return { status: 'source_changed' as const };
      return this.withKey(db, (key) => {
        const read = (table: 'attempts' | 'logins', rowId: string): string => {
          const row = db
            .prepare<[string], { password: Buffer }>(`SELECT password FROM ${table} WHERE id = ?`)
            .get(rowId);
          if (!row) throw new CredentialAttemptError('not_found');
          const plaintext = this.unseal(row.password, key);
          try {
            return plaintext.toString('utf8');
          } finally {
            plaintext.fill(0);
          }
        };
        return {
          status: 'ready' as const,
          password: read('attempts', id),
          ...(attempt.kind === 'rotation' ? { currentPassword: read('logins', attempt.source_login_id) } : {}),
        };
      });
    });
    if (credential.status !== 'ready') return credential;
    await assertActive();
    return this.use((db) =>
      db
        .transaction(() => {
          const attempt = this.attempt(db, id);
          if (attempt.phase !== 'saved') return { status: 'not_saved' as const };
          if (attempt.kind === 'rotation' && this.login(db, attempt.source_login_id).version !== attempt.source_version)
            return { status: 'source_changed' as const };
          const at = new Date().toISOString();
          const changed = db
            .prepare(
              "UPDATE attempts SET phase = 'exposed', exposed_at = ?, updated_at = ? WHERE id = ? AND phase = 'saved'",
            )
            .run(at, at, id);
          return changed.changes
            ? {
                status: 'exposed' as const,
                password: credential.password,
                ...(credential.currentPassword === undefined ? {} : { currentPassword: credential.currentPassword }),
              }
            : { status: 'not_saved' as const };
        })
        .immediate(),
    );
  }
  private move(
    db: Database.Database,
    id: string,
    from: readonly CredentialAttemptPhase[],
    to: CredentialAttemptPhase,
    evidence?: CredentialEvidence,
  ): CredentialAttempt {
    const json = evidence === undefined ? null : credentialEvidenceJson(evidence);
    const changed = db
      .prepare(
        `UPDATE attempts SET phase = ?, evidence_json = COALESCE(?, evidence_json), updated_at = ?, password = CASE WHEN ? = 'rejected' THEN NULL ELSE password END WHERE id = ? AND phase IN (${from.map(() => '?').join(',')})`,
      )
      .run(to, json, new Date().toISOString(), to, id, ...from);
    if (!changed.changes) {
      this.attempt(db, id);
      throw new CredentialAttemptError('invalid_phase');
    }
    return this.attempt(db, id);
  }
  async moveAttempt(
    id: string,
    from: readonly CredentialAttemptPhase[],
    to: CredentialAttemptPhase,
    evidence?: CredentialEvidence,
  ): Promise<CredentialAttempt> {
    return this.use((db) => this.move(db, id, from, to, evidence));
  }
  async releaseAttempt(
    id: string,
    approvalId: string,
  ): Promise<
    | { status: 'finalized'; attempt: CredentialAttempt }
    | { status: 'released'; from: CredentialAttemptPhase; attempt: CredentialAttempt }
  > {
    return this.use((db) =>
      db
        .transaction(() => {
          const current = this.attempt(db, id);
          if (current.phase === 'finalized') return { status: 'finalized' as const, attempt: current };
          const previous =
            current.evidence_json === null ? {} : (JSON.parse(current.evidence_json) as CredentialEvidence);
          const attempt = this.move(db, id, RELEASABLE_PHASES, 'rejected', {
            ...previous,
            release: 'principal',
            approval: approvalId,
            released_from: current.phase,
          });
          return { status: 'released' as const, from: current.phase, attempt };
        })
        .immediate(),
    );
  }
  async abandonAttemptsForJob(jobId: string): Promise<CredentialAttempt[]> {
    return this.use((db) =>
      db
        .transaction(() => {
          const saved = db
            .prepare<
              [string],
              CredentialAttempt
            >(`SELECT ${ATTEMPT_COLUMNS} FROM attempts WHERE job_id = ? AND phase = 'saved' ORDER BY created_at, id`)
            .all(jobId);
          return saved.map((attempt) => this.move(db, attempt.id, ['saved'], 'rejected'));
        })
        .immediate(),
    );
  }
  private editableAttempts(
    db: Database.Database,
    loginId: string | null,
    destination?: Pick<SavedLogin, 'domain' | 'username'>,
  ): CredentialAttempt[] {
    const open = db
      .prepare<
        [string | null, string | null, string | null],
        CredentialAttempt
      >(`SELECT ${ATTEMPT_COLUMNS} FROM attempts WHERE (source_login_id = ? OR (kind = 'signup' AND site = ? AND username = ?)) AND phase NOT IN ('rejected','finalized')`)
      .all(loginId, destination?.domain ?? null, destination?.username ?? null);
    if (open.some((attempt) => attempt.phase !== 'saved')) throw new LoginDetailsError('login_busy');
    return open;
  }
  private giveWay(
    db: Database.Database,
    loginId: string | null,
    destination?: Pick<SavedLogin, 'domain' | 'username'>,
  ): void {
    for (const attempt of this.editableAttempts(db, loginId, destination))
      this.move(db, attempt.id, ['saved'], 'rejected', { reason: 'login_edited' });
  }
  /** Ciphertext, final status and ownership change together without reading Keychain. */
  async confirmAttempt(id: string, evidence: CredentialEvidence): Promise<CredentialAttempt> {
    const json = credentialEvidenceJson(evidence);
    return this.use((db) =>
      db
        .transaction(() => {
          const attempt = this.attempt(db, id);
          if (attempt.phase === 'finalized') return attempt;
          if (!['exposed', 'awaiting_verification', 'unknown'].includes(attempt.phase))
            throw new CredentialAttemptError('invalid_phase');
          const row = db.prepare<[string], { password: Buffer }>('SELECT password FROM attempts WHERE id = ?').get(id);
          if (!row) throw new CredentialAttemptError('not_found');
          let login: SavedLogin;
          if (attempt.kind === 'signup')
            login = this.insert(
              db,
              loginMetadata({ site: attempt.origin, username: attempt.username, title: attempt.site }),
              row.password,
            );
          else {
            const changed = db
              .prepare(
                'UPDATE logins SET password = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?',
              )
              .run(row.password, new Date().toISOString(), attempt.source_login_id, attempt.source_version);
            if (changed.changes !== 1) throw new LoginDetailsError('login_changed');
            login = this.login(db, attempt.source_login_id);
          }
          const at = new Date().toISOString();
          db.prepare(
            "UPDATE attempts SET phase = 'finalized', password = NULL, owned_login_id = ?, evidence_json = ?, finalized_at = ?, updated_at = ? WHERE id = ?",
          ).run(login.id, json, at, at, id);
          return this.attempt(db, id);
        })
        .immediate(),
    );
  }
  async recoverAttempts(): Promise<void> {
    await this.use((db) => {
      db.prepare(
        "UPDATE attempts SET phase = 'unknown', evidence_json = ?, updated_at = ? WHERE phase = 'exposed'",
      ).run(credentialEvidenceJson({ signal: 'interrupted' }), new Date().toISOString());
    });
  }
}

export async function loginStoreAvailability(store: LoginStore): Promise<LoginStoreAvailability> {
  return store.availability();
}

/** Bind from the running assistant's own marker; no policy or provider setup is needed. */
export async function getLoginStore(): Promise<LoginStore> {
  const root = browserRoot();
  if (!root || !path.isAbsolute(root) || path.resolve(root) !== root || path.basename(root) !== 'browser')
    throw new LoginStoreError('vault_unavailable');
  try {
    const marker = await readInstanceMarkerFile(instanceMarkerFile(instanceLayout(path.dirname(root)).state));
    return new LoginStore({ browserRoot: root, instanceId: marker.instance_id });
  } catch (error) {
    if (!(error instanceof GwsEaError)) throw error;
    throw new LoginStoreError('vault_unavailable');
  }
}
