import { createHash, randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import Database from 'better-sqlite3';
import { instanceMarkerFile } from '../../gws-ea/paths.js';
import type { SanitizedCommandOutcomeRunner } from '../../gws-ea/process.js';
import { readInstanceMarkerFile } from '../../gws-ea/registry.js';
import { instanceLayout } from '../../gws-ea/release-layout.js';
import { GwsEaError } from '../../gws-ea/types.js';
import { hasControlCharacters } from '../../gws-ea/validation.js';
import { withPrivateDatabase } from '../gws-ea-vault/file.js';
import {
  SEALED_MIN_BYTES,
  SealUnavailableError,
  StoreSeal,
  type SealAvailability,
  type SealedFile,
} from '../gws-ea-vault/seal.js';
import { connectionsRoot } from './config.js';
import { ConnectionsKey } from './key.js';

export type AppAuth = 'none' | 'oauth' | 'token';
export type AppStatus = 'connected' | 'needs_reconnecting' | 'not_connected';
export type ConnectionsStoreAvailability = SealAvailability;
export type ConnectionsStoreReason =
  | 'store_unavailable'
  | 'app_not_found'
  | 'app_changed'
  | 'duplicate_name'
  | 'duplicate_host'
  | 'invalid_details';

export class ConnectionsStoreError extends Error {
  constructor(readonly reason: ConnectionsStoreReason) {
    super(reason);
  }
}

/** Every field is stored sealed as a whole, so one more optional field needs no schema change. */
export interface ClientRegistration {
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly tokenEndpointAuthMethod?: string;
  /** The app's client metadata document, whose address is the client ID; otherwise registered or entered. */
  readonly kind?: 'document';
  /** The server refused this app's document, so the document is never chosen for it again. */
  readonly documentRefused?: true;
}

export interface ConnectionApp {
  readonly id: string;
  /** Main's MCP server key, fixed at add; the name is only a label. */
  readonly serverKey: string;
  readonly name: string;
  readonly url: string;
  readonly host: string;
  readonly auth: AppAuth;
  readonly issuer: string | null;
  readonly hasClient: boolean;
  /** The principal entered the client's details, so they may change them; a registration made for the app is not theirs. */
  readonly clientEntered: boolean;
  readonly status: AppStatus;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type NewApp =
  | { readonly name: string; readonly url: string; readonly auth: 'oauth'; readonly issuer: string }
  | { readonly name: string; readonly url: string; readonly auth: 'none' | 'token' };

interface GrantFacts {
  readonly appId: string;
  readonly serverKey: string;
  readonly host: string;
  readonly url: string;
  readonly generation: number;
}
export type LiveGrant = GrantFacts &
  (
    | {
        readonly kind: 'oauth';
        /** False when the server issued no refresh token: the access token lapses at its expiry. */
        readonly renewable: boolean;
        readonly accessIssuedAt: string;
        readonly accessExpiresAt: string;
        /**
         * The current access token reached the gateway. Only the refresher holds a renewed token until it is
         * published, so after a restart an unpublished one is renewed or, with nothing to renew it, ended.
         */
        readonly published: boolean;
      }
    | { readonly kind: 'token' | 'none' }
  );

export type NewGrant =
  | {
      readonly kind: 'oauth';
      readonly refreshToken?: string;
      readonly accessIssuedAt: string;
      readonly accessExpiresAt: string;
    }
  | { readonly kind: 'token'; readonly token: string }
  | { readonly kind: 'none' };

/** What only the host may hold: a live grant's secret, and for OAuth the app's client. */
export type GrantCredentials =
  | {
      readonly kind: 'oauth';
      readonly generation: number;
      readonly refreshToken: string | undefined;
      readonly client: ClientRegistration | undefined;
    }
  | { readonly kind: 'token'; readonly generation: number; readonly token: string }
  | { readonly kind: 'none'; readonly generation: number };

export interface GrantRotation {
  /** Omitted when the server kept the refresh token it had issued. */
  readonly refreshToken?: string;
  readonly accessIssuedAt: string;
  readonly accessExpiresAt: string;
}

export interface ConnectResult {
  readonly app: ConnectionApp;
  readonly generation: number;
  /** The grant this one replaced, for revocation once the new one is in place. */
  readonly replaced: GrantCredentials | undefined;
}

export interface ReleaseResult {
  /** The live grant that was ended, when it could be read, for best-effort revocation. */
  readonly released: GrantCredentials | undefined;
}

export interface SignInStart {
  readonly principalId: string;
  readonly verifier: string;
  readonly issuer: string;
  readonly redirectUri: string;
  readonly resource: string;
}

export interface ClaimedSignIn extends SignInStart {
  readonly appId: string;
  readonly stateHash: string;
}

export type SignInCompletion = ({ readonly status: 'connected' } & ConnectResult) | { readonly status: 'expired' };

export interface ConnectionsStoreOptions {
  readonly connectionsRoot: string;
  readonly instanceId: string;
  readonly runCommand?: SanitizedCommandOutcomeRunner;
}

/** Every app ID the store issues is a lowercase random UUID. */
export const APP_ID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export const SIGN_IN_TTL_MS = 10 * 60_000;
export const NAME_MAX = 100;
const SECRET_MAX = 64 * 1024;
const STATE_MAX = 512;

const SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS apps (
  id TEXT PRIMARY KEY, server_key TEXT NOT NULL UNIQUE CHECK(server_key GLOB 'app_[0-9a-f]*'),
  name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE, url TEXT NOT NULL, host TEXT NOT NULL UNIQUE,
  auth TEXT NOT NULL CHECK(auth IN ('none','oauth','token')), issuer TEXT,
  client BLOB CHECK(client IS NULL OR length(client) >= ${SEALED_MIN_BYTES}),
  client_entered INTEGER NOT NULL DEFAULT 0 CHECK(client_entered IN (0,1)),
  version INTEGER NOT NULL CHECK(version > 0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK(client IS NOT NULL OR client_entered = 0)
) STRICT;
CREATE TABLE IF NOT EXISTS grants (
  app_id TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL CHECK(generation > 0),
  kind TEXT NOT NULL CHECK(kind IN ('none','oauth','token')),
  state TEXT NOT NULL CHECK(state IN ('live','disconnected','refused')),
  secret BLOB CHECK(secret IS NULL OR length(secret) >= ${SEALED_MIN_BYTES}),
  access_issued_at TEXT, access_expires_at TEXT,
  access_published INTEGER NOT NULL DEFAULT 0 CHECK(access_published IN (0,1)), updated_at TEXT NOT NULL,
  CHECK(state = 'live' OR secret IS NULL),
  CHECK(access_published = 0 OR (kind = 'oauth' AND state = 'live')),
  CHECK(kind <> 'none' OR secret IS NULL),
  CHECK(kind <> 'token' OR state <> 'live' OR secret IS NOT NULL),
  CHECK((kind = 'oauth' AND state = 'live') = (access_expires_at IS NOT NULL)),
  CHECK((access_issued_at IS NULL) = (access_expires_at IS NULL))
) STRICT;
CREATE TABLE IF NOT EXISTS sign_ins (
  app_id TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  state_hash TEXT NOT NULL UNIQUE CHECK(length(state_hash) = 64),
  principal_id TEXT NOT NULL, verifier BLOB NOT NULL CHECK(length(verifier) >= ${SEALED_MIN_BYTES}),
  issuer TEXT NOT NULL, redirect_uri TEXT NOT NULL, resource TEXT NOT NULL,
  expires_at TEXT NOT NULL, claimed_at TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS restart_request (
  id INTEGER PRIMARY KEY CHECK(id = 1), applied_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS meta (
  id INTEGER PRIMARY KEY CHECK(id = 1), key_check BLOB NOT NULL
) STRICT;`;

const APP_COLUMNS = `a.id, a.server_key AS serverKey, a.name, a.url, a.host, a.auth, a.issuer,
  a.client IS NOT NULL AS hasClient, a.client_entered AS clientEntered,
  CASE g.state WHEN 'live' THEN 'connected' WHEN 'refused' THEN 'needs_reconnecting' ELSE 'not_connected' END AS status,
  a.version, a.created_at AS createdAt, a.updated_at AS updatedAt`;
const APP_FROM = 'apps a LEFT JOIN grants g ON g.app_id = a.id';

interface AppRow extends Omit<ConnectionApp, 'hasClient' | 'clientEntered'> {
  readonly hasClient: number;
  readonly clientEntered: number;
}
interface GrantRow {
  readonly app_id: string;
  readonly server_key: string;
  readonly host: string;
  readonly url: string;
  readonly generation: number;
  readonly kind: AppAuth;
  readonly state: 'live' | 'disconnected' | 'refused';
  readonly secret: Buffer | null;
  readonly access_issued_at: string | null;
  readonly access_expires_at: string | null;
  readonly access_published: number;
  readonly client: Buffer | null;
}
interface SignInRow {
  readonly app_id: string;
  readonly state_hash: string;
  readonly principal_id: string;
  readonly verifier: Buffer;
  readonly issuer: string;
  readonly redirect_uri: string;
  readonly resource: string;
  readonly expires_at: string;
  readonly claimed_at: string | null;
  readonly host: string;
}

function toApp(row: AppRow): ConnectionApp {
  return { ...row, hasClient: row.hasClient === 1, clientEntered: row.clientEntered === 1 };
}
function invalid(): never {
  throw new ConnectionsStoreError('invalid_details');
}
function versionValid(version: number): void {
  if (!Number.isSafeInteger(version) || version < 1) throw new ConnectionsStoreError('app_changed');
}
function isoValid(value: string): void {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value)
    invalid();
}
function secretValid(value: string): void {
  if (typeof value !== 'string' || !value || value.length > SECRET_MAX) invalid();
}
function nameOf(value: string): { name: string; key: string } {
  const name = typeof value === 'string' ? value.normalize('NFC').trim() : '';
  if (!name || name.length > NAME_MAX || hasControlCharacters(name)) invalid();
  return { name, key: name.normalize('NFKC').toLowerCase() };
}
function httpsUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return invalid();
  }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) invalid();
  return url;
}
function hashState(state: string): string {
  return createHash('sha256').update(state, 'utf8').digest('hex');
}
function clientValid(client: ClientRegistration): void {
  secretValid(client.clientId);
  if (client.clientSecret !== undefined) secretValid(client.clientSecret);
  if (client.tokenEndpointAuthMethod !== undefined) secretValid(client.tokenEndpointAuthMethod);
}
function parseClient(json: string): ClientRegistration {
  const value: unknown = JSON.parse(json);
  if (typeof value !== 'object' || value === null) throw new Error('Sealed client is malformed');
  const { clientId, clientSecret, tokenEndpointAuthMethod, kind, documentRefused } = value as Record<string, unknown>;
  if (typeof clientId !== 'string') throw new Error('Sealed client is malformed');
  return {
    clientId,
    ...(typeof clientSecret === 'string' ? { clientSecret } : {}),
    ...(typeof tokenEndpointAuthMethod === 'string' ? { tokenEndpointAuthMethod } : {}),
    ...(kind === 'document' ? { kind } : {}),
    ...(documentRefused === true ? { documentRefused } : {}),
  };
}
function grantValid(grant: NewGrant): void {
  switch (grant.kind) {
    case 'oauth':
      if (grant.refreshToken !== undefined) secretValid(grant.refreshToken);
      isoValid(grant.accessIssuedAt);
      isoValid(grant.accessExpiresAt);
      return;
    case 'token':
      secretValid(grant.token);
      return;
    case 'none':
      return;
  }
}

/**
 * A direct, host-only file. Client registrations, grant secrets and sign-in verifiers are sealed; app metadata, grant
 * state and the restart request are read without Keychain.
 */
export class ConnectionsStore {
  private readonly file: string;
  private readonly sealing: StoreSeal;
  constructor(options: ConnectionsStoreOptions) {
    if (!path.isAbsolute(options.connectionsRoot) || path.resolve(options.connectionsRoot) !== options.connectionsRoot)
      throw new ConnectionsStoreError('store_unavailable');
    this.file = path.join(options.connectionsRoot, 'apps.db');
    this.sealing = new StoreSeal({
      key: new ConnectionsKey(options),
      label: `gws-ea-connections:v1|${options.instanceId}`,
      check: 'gws-ea-connections-key-check:v1',
    });
  }

  private async use<T>(operation: (db: Database.Database) => T | Promise<T>): Promise<T> {
    try {
      return await withPrivateDatabase(this.file, SCHEMA, operation);
    } catch (error) {
      if (error instanceof ConnectionsStoreError) throw error;
      throw new ConnectionsStoreError('store_unavailable');
    }
  }

  private sealedFile(db: Database.Database): SealedFile {
    return {
      hasSecrets: () =>
        db
          .prepare<[], { present: number }>(
            `SELECT EXISTS(SELECT 1 FROM apps WHERE client IS NOT NULL UNION ALL
              SELECT 1 FROM grants WHERE secret IS NOT NULL UNION ALL SELECT 1 FROM sign_ins) AS present`,
          )
          .get()?.present === 1,
      readCheck: () =>
        db.prepare<[], { key_check: Buffer }>('SELECT key_check FROM meta WHERE id = 1').get()?.key_check,
      writeCheck: (sealed) => {
        db.prepare(
          'INSERT INTO meta (id, key_check) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET key_check = excluded.key_check',
        ).run(sealed);
      },
    };
  }
  private withKey<T>(db: Database.Database, operation: (key: Buffer) => T): Promise<T> {
    return this.sealing.withKey(this.sealedFile(db), operation);
  }
  /** Ending or replacing a grant never depends on Keychain: without the key the old secret is forgotten unread. */
  private async withReadableKey<T>(db: Database.Database, operation: (key: Buffer | undefined) => T): Promise<T> {
    const file = this.sealedFile(db);
    if (!file.hasSecrets()) return operation(undefined);
    try {
      return await this.sealing.withKey(file, operation);
    } catch (error) {
      if (!(error instanceof SealUnavailableError)) throw error;
      return operation(undefined);
    }
  }
  private sealText(value: string, key: Buffer): Buffer {
    const plaintext = Buffer.from(value, 'utf8');
    try {
      return this.sealing.seal(plaintext, key);
    } finally {
      plaintext.fill(0);
    }
  }
  private unsealText(blob: Buffer, key: Buffer): string {
    const plaintext = this.sealing.unseal(blob, key);
    try {
      return plaintext.toString('utf8');
    } finally {
      plaintext.fill(0);
    }
  }

  async availability(): Promise<ConnectionsStoreAvailability> {
    try {
      return await this.use((db) => this.sealing.availability(this.sealedFile(db)));
    } catch (error) {
      if (error instanceof ConnectionsStoreError) return { available: false, reason: 'keychain_unavailable' };
      throw error;
    }
  }

  private app(db: Database.Database, id: string): ConnectionApp {
    const row = db.prepare<[string], AppRow>(`SELECT ${APP_COLUMNS} FROM ${APP_FROM} WHERE a.id = ?`).get(id);
    if (!row) throw new ConnectionsStoreError('app_not_found');
    return toApp(row);
  }
  private appAt(db: Database.Database, id: string, version: number): ConnectionApp {
    const app = this.app(db, id);
    if (app.version !== version) throw new ConnectionsStoreError('app_changed');
    return app;
  }
  private touch(db: Database.Database, id: string, version: number, assignments = '', ...params: unknown[]): void {
    const changed = db
      .prepare(
        `UPDATE apps SET ${assignments}${assignments ? ', ' : ''}version = version + 1, updated_at = ? WHERE id = ? AND version = ?`,
      )
      .run(...params, new Date().toISOString(), id, version);
    if (changed.changes !== 1) throw new ConnectionsStoreError('app_changed');
  }

  async apps(): Promise<readonly ConnectionApp[]> {
    return this.use((db) =>
      db.prepare<[], AppRow>(`SELECT ${APP_COLUMNS} FROM ${APP_FROM} ORDER BY a.name_key, a.id`).all().map(toApp),
    );
  }
  async get(id: string): Promise<ConnectionApp> {
    return this.use((db) => this.app(db, id));
  }
  async byHost(host: string): Promise<ConnectionApp | undefined> {
    return this.use((db) => {
      const row = db.prepare<[string], AppRow>(`SELECT ${APP_COLUMNS} FROM ${APP_FROM} WHERE a.host = ?`).get(host);
      return row && toApp(row);
    });
  }

  private assertDistinct(db: Database.Database, field: 'name_key' | 'host', value: string, id = ''): void {
    if (db.prepare(`SELECT 1 FROM apps WHERE ${field} = ? AND id != ?`).get(value, id))
      throw new ConnectionsStoreError(field === 'host' ? 'duplicate_host' : 'duplicate_name');
  }

  /** Stored Not connected; credentials arrive later through connect or sign-in. */
  async create(spec: NewApp): Promise<ConnectionApp> {
    const { name, key } = nameOf(spec.name);
    const url = httpsUrl(spec.url);
    if (!['none', 'oauth', 'token'].includes(spec.auth)) invalid();
    const issuer = spec.auth === 'oauth' ? httpsUrl(spec.issuer).href : null;
    return this.use((db) =>
      db
        .transaction(() => {
          this.assertDistinct(db, 'name_key', key);
          this.assertDistinct(db, 'host', url.hostname);
          const id = randomUUID();
          const at = new Date().toISOString();
          db.prepare(
            `INSERT INTO apps (id, server_key, name, name_key, url, host, auth, issuer, client, version, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?)`,
          ).run(
            id,
            `app_${randomBytes(6).toString('hex')}`,
            name,
            key,
            url.href,
            url.hostname,
            spec.auth,
            issuer,
            at,
            at,
          );
          return this.app(db, id);
        })
        .immediate(),
    );
  }

  async rename(id: string, version: number, name: string): Promise<ConnectionApp> {
    versionValid(version);
    const next = nameOf(name);
    return this.use((db) =>
      db
        .transaction(() => {
          this.appAt(db, id, version);
          this.assertDistinct(db, 'name_key', next.key, id);
          this.touch(db, id, version, 'name = ?, name_key = ?', next.name, next.key);
          return this.app(db, id);
        })
        .immediate(),
    );
  }

  /** A client belongs to the issuer it was registered with, so both change together. */
  async setClient(
    id: string,
    version: number,
    registration: { readonly issuer: string; readonly client: ClientRegistration; readonly entered: boolean },
  ): Promise<ConnectionApp> {
    versionValid(version);
    const issuer = httpsUrl(registration.issuer).href;
    clientValid(registration.client);
    return this.use(async (db) => {
      this.appAt(db, id, version);
      return this.withKey(db, (key) => {
        const sealed = this.sealText(JSON.stringify(registration.client), key);
        return db
          .transaction(() => {
            this.touch(
              db,
              id,
              version,
              'issuer = ?, client = ?, client_entered = ?',
              issuer,
              sealed,
              registration.entered ? 1 : 0,
            );
            return this.app(db, id);
          })
          .immediate();
      });
    });
  }

  /**
   * The app's client whatever its grant, for a sign-in to start or finish. A sign-in's return carries no version, so
   * the version is checked only when given.
   */
  async readClient(
    id: string,
    version?: number,
  ): Promise<{ readonly issuer: string | null; readonly client: ClientRegistration | undefined }> {
    if (version !== undefined) versionValid(version);
    return this.use(async (db) => {
      const read = (key: Buffer | undefined) => {
        const app = version === undefined ? this.app(db, id) : this.appAt(db, id, version);
        const sealed = db.prepare<[string], { client: Buffer | null }>('SELECT client FROM apps WHERE id = ?').get(id);
        if (!sealed?.client) return { issuer: app.issuer, client: undefined };
        if (!key) throw new ConnectionsStoreError('store_unavailable');
        return { issuer: app.issuer, client: parseClient(this.unsealText(sealed.client, key)) };
      };
      const app = version === undefined ? this.app(db, id) : this.appAt(db, id, version);
      return app.hasClient ? this.withKey(db, read) : read(undefined);
    });
  }

  /** A sign-in still pending with the forgotten client reads as expired. */
  async clearClient(id: string, version: number): Promise<ConnectionApp> {
    versionValid(version);
    return this.use((db) =>
      db
        .transaction(() => {
          this.appAt(db, id, version);
          db.prepare('DELETE FROM sign_ins WHERE app_id = ?').run(id);
          this.touch(db, id, version, 'client = NULL, client_entered = 0');
          return this.app(db, id);
        })
        .immediate(),
    );
  }

  private credentials(row: GrantRow, key: Buffer | undefined): GrantCredentials | undefined {
    if (row.state !== 'live') return undefined;
    if (row.kind === 'none') return { kind: 'none', generation: row.generation };
    if (!key) return undefined;
    try {
      if (row.kind === 'token') {
        if (!row.secret) return undefined;
        return { kind: 'token', generation: row.generation, token: this.unsealText(row.secret, key) };
      }
      return {
        kind: 'oauth',
        generation: row.generation,
        refreshToken: row.secret ? this.unsealText(row.secret, key) : undefined,
        client: row.client ? parseClient(this.unsealText(row.client, key)) : undefined,
      };
      // eslint-disable-next-line no-catch-all/no-catch-all -- An unreadable grant is ended unread; revocation is best-effort.
    } catch {
      return undefined;
    }
  }
  private grantRow(db: Database.Database, appId: string): GrantRow | undefined {
    return db
      .prepare<[string], GrantRow>(
        `SELECT g.app_id, a.server_key, a.host, a.url, g.generation, g.kind, g.state, g.secret,
          g.access_issued_at, g.access_expires_at, g.access_published, a.client
          FROM grants g JOIN apps a ON a.id = g.app_id WHERE g.app_id = ?`,
      )
      .get(appId);
  }
  private liveGrant(row: GrantRow): LiveGrant {
    const facts: GrantFacts = {
      appId: row.app_id,
      serverKey: row.server_key,
      host: row.host,
      url: row.url,
      generation: row.generation,
    };
    if (row.kind !== 'oauth') return { ...facts, kind: row.kind };
    // The schema requires both times on a live OAuth grant.
    if (!row.access_issued_at || !row.access_expires_at) throw new ConnectionsStoreError('store_unavailable');
    return {
      ...facts,
      kind: 'oauth',
      renewable: row.secret !== null,
      accessIssuedAt: row.access_issued_at,
      accessExpiresAt: row.access_expires_at,
      published: row.access_published === 1,
    };
  }

  /** Inside a write transaction: the next generation replaces whatever grant the app had. */
  private replaceGrant(
    db: Database.Database,
    app: ConnectionApp,
    grant: NewGrant,
    key: Buffer | undefined,
    issuer?: string,
  ): ConnectResult {
    const previous = this.grantRow(db, app.id);
    const replaced = previous && this.credentials(previous, key);
    const generation = (previous?.generation ?? 0) + 1;
    let secret: Buffer | null = null;
    if (grant.kind === 'token' || (grant.kind === 'oauth' && grant.refreshToken !== undefined)) {
      if (!key) throw new ConnectionsStoreError('store_unavailable');
      secret = this.sealText(grant.kind === 'token' ? grant.token : (grant.refreshToken ?? ''), key);
    }
    const at = new Date().toISOString();
    db.prepare(
      `INSERT INTO grants (app_id, generation, kind, state, secret, access_issued_at, access_expires_at,
          access_published, updated_at)
        VALUES (?, ?, ?, 'live', ?, ?, ?, 0, ?)
        ON CONFLICT(app_id) DO UPDATE SET generation = excluded.generation, kind = excluded.kind, state = 'live',
          secret = excluded.secret, access_issued_at = excluded.access_issued_at,
          access_expires_at = excluded.access_expires_at, access_published = 0, updated_at = excluded.updated_at`,
    ).run(
      app.id,
      generation,
      grant.kind,
      secret,
      grant.kind === 'oauth' ? grant.accessIssuedAt : null,
      grant.kind === 'oauth' ? grant.accessExpiresAt : null,
      at,
    );
    if (issuer === undefined) this.touch(db, app.id, app.version, 'auth = ?', grant.kind);
    else this.touch(db, app.id, app.version, 'auth = ?, issuer = ?', grant.kind, issuer);
    return { app: this.app(db, app.id), generation, replaced };
  }

  /** A pasted token or a server without sign-in; OAuth grants arrive only through a claimed sign-in. */
  async connect(
    id: string,
    version: number,
    grant: Extract<NewGrant, { kind: 'token' | 'none' }>,
  ): Promise<ConnectResult> {
    versionValid(version);
    grantValid(grant);
    return this.use(async (db) => {
      this.appAt(db, id, version);
      const run = (key: Buffer | undefined): ConnectResult =>
        db
          .transaction(() => {
            const app = this.appAt(db, id, version);
            db.prepare('DELETE FROM sign_ins WHERE app_id = ?').run(id);
            return this.replaceGrant(db, app, grant, key);
          })
          .immediate();
      return grant.kind === 'token' ? this.withKey(db, run) : this.withReadableKey(db, run);
    });
  }

  /** The app's grant as it is now, undefined unless live. */
  async currentGrant(appId: string): Promise<LiveGrant | undefined> {
    return this.use((db) => {
      const row = this.grantRow(db, appId);
      return row?.state === 'live' ? this.liveGrant(row) : undefined;
    });
  }

  /** Each app whose server refused renewal and that nobody has reconnected, disconnected or deleted since. */
  async refusedGrants(): Promise<readonly { readonly appId: string; readonly generation: number }[]> {
    return this.use((db) =>
      db
        .prepare<
          [],
          { appId: string; generation: number }
        >("SELECT app_id AS appId, generation FROM grants WHERE state = 'refused' ORDER BY app_id")
        .all(),
    );
  }

  /** Undefined unless the grant is still live at exactly this generation. */
  async readGrant(appId: string, generation: number): Promise<GrantCredentials | undefined> {
    const read = (row: GrantRow | undefined, key: Buffer | undefined): GrantCredentials | undefined => {
      if (row?.state !== 'live' || row.generation !== generation) return undefined;
      const open = (blob: Buffer): string => {
        if (!key) throw new ConnectionsStoreError('store_unavailable');
        return this.unsealText(blob, key);
      };
      switch (row.kind) {
        case 'none':
          return { kind: 'none', generation };
        case 'token':
          if (!row.secret) throw new ConnectionsStoreError('store_unavailable');
          return { kind: 'token', generation, token: open(row.secret) };
        case 'oauth':
          return {
            kind: 'oauth',
            generation,
            refreshToken: row.secret ? open(row.secret) : undefined,
            client: row.client ? parseClient(open(row.client)) : undefined,
          };
      }
    };
    return this.use(async (db) => {
      const row = this.grantRow(db, appId);
      if (!row?.secret && !row?.client) return read(row, undefined);
      return this.withKey(db, (key) => read(this.grantRow(db, appId), key));
    });
  }

  /** Persists a renewal, unpublished, before its access token is published; false when the grant moved on meanwhile. */
  async rotateGrant(appId: string, generation: number, rotation: GrantRotation): Promise<boolean> {
    if (rotation.refreshToken !== undefined) secretValid(rotation.refreshToken);
    isoValid(rotation.accessIssuedAt);
    isoValid(rotation.accessExpiresAt);
    return this.use(async (db) => {
      const row = this.grantRow(db, appId);
      if (row?.state !== 'live' || row.generation !== generation || row.kind !== 'oauth') return false;
      const update = (secret: Buffer | undefined): boolean =>
        db
          .prepare(
            `UPDATE grants SET secret = COALESCE(?, secret), access_issued_at = ?, access_expires_at = ?,
                access_published = 0, updated_at = ?
              WHERE app_id = ? AND generation = ? AND state = 'live' AND kind = 'oauth'`,
          )
          .run(
            secret ?? null,
            rotation.accessIssuedAt,
            rotation.accessExpiresAt,
            new Date().toISOString(),
            appId,
            generation,
          ).changes === 1;
      const refreshToken = rotation.refreshToken;
      if (refreshToken === undefined) return update(undefined);
      return this.withKey(db, (key) => update(this.sealText(refreshToken, key)));
    });
  }

  /**
   * Records that the OAuth access token expiring at `accessExpiresAt` reached the gateway; false when the grant was
   * ended, replaced or renewed meanwhile.
   */
  async markPublished(appId: string, generation: number, accessExpiresAt: string): Promise<boolean> {
    return this.use(
      (db) =>
        db
          .prepare(
            `UPDATE grants SET access_published = 1, updated_at = ?
              WHERE app_id = ? AND generation = ? AND state = 'live' AND kind = 'oauth' AND access_expires_at = ?`,
          )
          .run(new Date().toISOString(), appId, generation, accessExpiresAt).changes === 1,
    );
  }

  /** The server refused renewal: Needs reconnecting. True only for the call that ended this generation. */
  async markRefused(appId: string, generation: number): Promise<boolean> {
    return this.use((db) =>
      db
        .transaction(() => {
          const row = this.grantRow(db, appId);
          if (row?.state !== 'live' || row.generation !== generation) return false;
          this.endGrant(db, appId, 'refused');
          const app = this.app(db, appId);
          this.touch(db, appId, app.version);
          return true;
        })
        .immediate(),
    );
  }

  private endGrant(db: Database.Database, appId: string, state: 'disconnected' | 'refused'): void {
    db.prepare(
      `UPDATE grants SET state = ?, secret = NULL, access_issued_at = NULL, access_expires_at = NULL,
          access_published = 0, updated_at = ?
        WHERE app_id = ?`,
    ).run(state, new Date().toISOString(), appId);
  }

  /** Ends the grant durably before anything is removed elsewhere; the app stays, Not connected. */
  async disconnect(id: string, version: number): Promise<ReleaseResult & { readonly app: ConnectionApp }> {
    versionValid(version);
    return this.use(async (db) => {
      this.appAt(db, id, version);
      return this.withReadableKey(db, (key) =>
        db
          .transaction(() => {
            this.appAt(db, id, version);
            const row = this.grantRow(db, id);
            const released = row && this.credentials(row, key);
            db.prepare('DELETE FROM sign_ins WHERE app_id = ?').run(id);
            if (row) this.endGrant(db, id, 'disconnected');
            this.touch(db, id, version);
            return { app: this.app(db, id), released };
          })
          .immediate(),
      );
    });
  }

  /** Forgets the app, its client, grant and sign-in in one step. */
  async remove(id: string, version: number): Promise<ReleaseResult> {
    versionValid(version);
    return this.use(async (db) => {
      this.appAt(db, id, version);
      return this.withReadableKey(db, (key) =>
        db
          .transaction(() => {
            this.appAt(db, id, version);
            const row = this.grantRow(db, id);
            const released = row && this.credentials(row, key);
            if (db.prepare('DELETE FROM apps WHERE id = ? AND version = ?').run(id, version).changes !== 1)
              throw new ConnectionsStoreError('app_changed');
            return { released };
          })
          .immediate(),
      );
    });
  }

  /** One pending sign-in per app: a new start replaces the old, whose state then reads as expired. */
  async startSignIn(
    id: string,
    version: number,
    start: SignInStart,
  ): Promise<{ readonly state: string; readonly expiresAt: string }> {
    versionValid(version);
    if (typeof start.principalId !== 'string' || !start.principalId) invalid();
    secretValid(start.verifier);
    for (const value of [start.issuer, start.redirectUri, start.resource]) httpsUrl(value);
    return this.use(async (db) => {
      this.appAt(db, id, version);
      return this.withKey(db, (key) => {
        const state = randomBytes(32).toString('base64url');
        const expiresAt = new Date(Date.now() + SIGN_IN_TTL_MS).toISOString();
        const verifier = this.sealText(start.verifier, key);
        db.transaction(() => {
          this.appAt(db, id, version);
          db.prepare(
            `INSERT INTO sign_ins (app_id, state_hash, principal_id, verifier, issuer, redirect_uri, resource, expires_at, claimed_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
              ON CONFLICT(app_id) DO UPDATE SET state_hash = excluded.state_hash, principal_id = excluded.principal_id,
                verifier = excluded.verifier, issuer = excluded.issuer, redirect_uri = excluded.redirect_uri,
                resource = excluded.resource, expires_at = excluded.expires_at, claimed_at = NULL`,
          ).run(
            id,
            hashState(state),
            start.principalId,
            verifier,
            start.issuer,
            start.redirectUri,
            start.resource,
            expiresAt,
          );
        }).immediate();
        return { state, expiresAt };
      });
    });
  }

  /**
   * Single use. Unknown, expired, consumed and another principal's states, and a state for another app's host, all
   * answer undefined; only a matching unclaimed row is claimed.
   */
  async claimSignIn(
    state: string,
    match: { readonly host: string; readonly principalId: string },
  ): Promise<ClaimedSignIn | undefined> {
    if (typeof state !== 'string' || !state || state.length > STATE_MAX) return undefined;
    const stateHash = hashState(state);
    const pending = (db: Database.Database): SignInRow | undefined => {
      const row = db
        .prepare<
          [string],
          SignInRow
        >(`SELECT s.*, a.host FROM sign_ins s JOIN apps a ON a.id = s.app_id WHERE s.state_hash = ?`)
        .get(stateHash);
      if (!row || row.host !== match.host || row.principal_id !== match.principalId || row.claimed_at !== null)
        return undefined;
      if (row.expires_at <= new Date().toISOString()) {
        db.prepare('DELETE FROM sign_ins WHERE app_id = ? AND state_hash = ?').run(row.app_id, stateHash);
        return undefined;
      }
      return row;
    };
    return this.use(async (db) => {
      if (!pending(db)) return undefined;
      return this.withKey(db, (key) =>
        db
          .transaction((): ClaimedSignIn | undefined => {
            const row = pending(db);
            if (!row) return undefined;
            db.prepare(
              'UPDATE sign_ins SET claimed_at = ? WHERE app_id = ? AND state_hash = ? AND claimed_at IS NULL',
            ).run(new Date().toISOString(), row.app_id, stateHash);
            return {
              appId: row.app_id,
              stateHash,
              principalId: row.principal_id,
              verifier: this.unsealText(row.verifier, key),
              issuer: row.issuer,
              redirectUri: row.redirect_uri,
              resource: row.resource,
            };
          })
          .immediate(),
      );
    });
  }

  /** The grant and the claimed row's removal commit together; a cleared or replaced row means the sign-in expired. */
  async completeSignIn(claim: ClaimedSignIn, grant: Extract<NewGrant, { kind: 'oauth' }>): Promise<SignInCompletion> {
    grantValid(grant);
    return this.use((db) =>
      this.withKey(db, (key) =>
        db
          .transaction((): SignInCompletion => {
            const claimed = db
              .prepare('SELECT 1 FROM sign_ins WHERE app_id = ? AND state_hash = ? AND claimed_at IS NOT NULL')
              .get(claim.appId, claim.stateHash);
            if (!claimed) return { status: 'expired' };
            const result = this.replaceGrant(db, this.app(db, claim.appId), grant, key, claim.issuer);
            db.prepare('DELETE FROM sign_ins WHERE app_id = ?').run(claim.appId);
            return { status: 'connected', ...result };
          })
          .immediate(),
      ),
    );
  }

  /** Cancelled or failed at the server: the app stays as it was. */
  async discardSignIn(claim: Pick<ClaimedSignIn, 'appId' | 'stateHash'>): Promise<void> {
    await this.use((db) => {
      db.prepare('DELETE FROM sign_ins WHERE app_id = ? AND state_hash = ?').run(claim.appId, claim.stateHash);
    });
  }

  async sweepExpiredSignIns(): Promise<number> {
    return this.use(
      (db) => db.prepare('DELETE FROM sign_ins WHERE expires_at <= ?').run(new Date().toISOString()).changes,
    );
  }

  /** Several applies coalesce: the request keeps only the latest apply time. */
  async requestRestart(appliedAt: string): Promise<void> {
    isoValid(appliedAt);
    await this.use((db) => {
      db.prepare(
        `INSERT INTO restart_request (id, applied_at) VALUES (1, ?)
          ON CONFLICT(id) DO UPDATE SET applied_at = max(applied_at, excluded.applied_at)`,
      ).run(appliedAt);
    });
  }
  async pendingRestart(): Promise<string | undefined> {
    return this.use(
      (db) =>
        db.prepare<[], { applied_at: string }>('SELECT applied_at FROM restart_request WHERE id = 1').get()?.applied_at,
    );
  }
  /** Clears only the request served; an apply recorded since keeps it pending. */
  async clearRestart(appliedAt: string): Promise<boolean> {
    return this.use(
      (db) => db.prepare('DELETE FROM restart_request WHERE id = 1 AND applied_at = ?').run(appliedAt).changes === 1,
    );
  }
}

/** Bind from the running assistant's own marker; nothing else configures the store. */
export async function getConnectionsStore(): Promise<ConnectionsStore> {
  const root = connectionsRoot();
  if (!root || !path.isAbsolute(root) || path.resolve(root) !== root || path.basename(root) !== 'connections')
    throw new ConnectionsStoreError('store_unavailable');
  try {
    const marker = await readInstanceMarkerFile(instanceMarkerFile(instanceLayout(path.dirname(root)).state));
    return new ConnectionsStore({ connectionsRoot: root, instanceId: marker.instance_id });
  } catch (error) {
    if (!(error instanceof GwsEaError)) throw error;
    throw new ConnectionsStoreError('store_unavailable');
  }
}
