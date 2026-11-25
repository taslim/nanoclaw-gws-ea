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
import { canonicalJson, normalizeToolDefinition, sha256Hex, toolListHash, type ToolDefinition } from './canonical.js';
import { ConnectionsKey } from './key.js';

export type AppAuth = 'none' | 'oauth' | 'token';
export type AppStatus = 'connected' | 'needs_reconnecting' | 'not_connected';
export type ToolLabel = 'ask_first' | 'just_do';
export type ToolLabelSource = 'sorter' | 'floor' | 'principal' | 'approved_request' | 'fallback';
export type RelayCallState = 'executing' | 'completed' | 'unsent' | 'too_large' | 'unknown';
export type RelayInvocationMode = 'direct' | 'held';
export type RelayInvocationState = 'active' | 'settled' | 'declined' | 'expired' | 'withdrawn';
export type ToolSortStatus = 'pending' | 'completed' | 'failed' | 'timed_out';
export type ConnectionsStoreAvailability = SealAvailability;

export interface ToolSortRecord {
  readonly id: string;
  readonly appId: string;
  readonly listHash: string;
  readonly sorterVersion: string;
  readonly status: ToolSortStatus;
  readonly attempt: number;
  readonly createdAt: string;
  readonly completedAt: string | null;
}

export interface AppPin {
  readonly appId: string;
  readonly instructions: string | null;
  readonly listHash: string;
  readonly pinnedAt: string;
  readonly confirmedAt: string;
  readonly reviewedListHash: string | null;
  readonly reviewedAt: string | null;
  readonly needsReview: boolean;
}

export interface PinnedAppTool {
  readonly appId: string;
  readonly name: string;
  readonly definitionHash: string;
  readonly definition: ToolDefinition;
  readonly label: ToolLabel | null;
  readonly labelSource: ToolLabelSource | null;
  readonly summary: string | null;
  readonly reason: string | null;
  readonly sorterVersion: string | null;
  readonly principalFloor: boolean;
  readonly unsettled: boolean;
  readonly sortAttempts: number;
  readonly updatedAt: string;
}

export interface PinToolsResult {
  readonly pin: AppPin;
  readonly tools: readonly PinnedAppTool[];
  readonly changed: boolean;
  readonly unsortedCount: number;
}

export interface ToolLabelUpdate {
  readonly name: string;
  readonly definitionHash: string;
  readonly label: ToolLabel;
  readonly source: ToolLabelSource;
  readonly summary?: string | null;
  readonly reason: string;
}

export interface RelayCallRecord {
  readonly id: string;
  readonly approvalId: string | null;
  readonly appId: string;
  readonly grantGeneration: number;
  readonly toolName: string;
  readonly definitionHash: string;
  readonly argsHash: string;
  readonly state: RelayCallState;
  readonly outcomeJson: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RelayInvocationRecord {
  readonly invocationId: string;
  readonly appId: string;
  readonly grantGeneration: number;
  readonly toolName: string;
  readonly argsHash: string;
  readonly stripSummary: boolean;
  readonly mode: RelayInvocationMode;
  readonly approvalId: string | null;
  readonly state: RelayInvocationState;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ClaimApprovedCallResult =
  | { readonly status: 'claimed' }
  | { readonly status: 'app_not_found' }
  | { readonly status: 'already_executing'; readonly record: RelayCallRecord }
  | { readonly status: 'already_settled'; readonly record: RelayCallRecord }
  | { readonly status: 'already_dispatched' };

export type ClaimDirectCallResult =
  | { readonly status: 'claimed' }
  | { readonly status: 'app_not_found' }
  | { readonly status: 'already_executing'; readonly record: RelayCallRecord }
  | { readonly status: 'already_settled'; readonly record: RelayCallRecord }
  | { readonly status: 'already_held'; readonly invocation: RelayInvocationRecord }
  | { readonly status: 'conflict' };

export type ReserveHeldInvocationResult =
  | { readonly status: 'reserved' }
  | { readonly status: 'app_not_found' }
  | { readonly status: 'existing'; readonly invocation: RelayInvocationRecord }
  | { readonly status: 'conflict' };

export interface RecentRelayResult {
  readonly id: string;
  readonly toolName: string;
  readonly outcomeJson: string;
  readonly updatedAt: string;
}
export type ConnectionsStoreReason =
  'store_unavailable' | 'app_not_found' | 'app_changed' | 'duplicate_name' | 'duplicate_host' | 'invalid_details';

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
  readonly kind?: 'document';
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
        readonly hasAccessToken: boolean;
      }
    | { readonly kind: 'token' }
    | { readonly kind: 'none' }
  );

export type NewGrant =
  | {
      readonly kind: 'oauth';
      readonly refreshToken?: string;
      readonly accessToken: string;
      readonly accessIssuedAt: string;
      readonly accessExpiresAt: string;
    }
  | { readonly kind: 'token'; readonly token: string }
  | { readonly kind: 'none' };

export interface StoredAccessToken {
  readonly generation: number;
  readonly token: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

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
  readonly accessToken: string;
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

export const APP_ID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export const SIGN_IN_TTL_MS = 10 * 60_000;
export const NAME_MAX = 100;

/**
 * Deterministic digest of a pinned app's current tool labels and settled states. Used alongside `listHash` so a
 * principal's Confirm submission cannot approve labels that changed in the background after the page was loaded.
 */
export function toolLabelsHash(
  tools: readonly Pick<PinnedAppTool, 'name' | 'definitionHash' | 'label' | 'unsettled'>[],
): string {
  const ordered = [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return sha256Hex(canonicalJson(ordered.map((tool) => [tool.name, tool.definitionHash, tool.label, tool.unsettled])));
}
const SECRET_MAX = 64 * 1024;
const STATE_MAX = 512;
const MAX_RECENT_DIRECT_CALLS_PER_APP = 30;

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
CREATE TABLE IF NOT EXISTS access_tokens (
  app_id TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL CHECK(generation > 0),
  token BLOB NOT NULL CHECK(length(token) >= ${SEALED_MIN_BYTES}),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS sign_ins (
  app_id TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  state_hash TEXT NOT NULL UNIQUE CHECK(length(state_hash) = 64),
  principal_id TEXT NOT NULL, verifier BLOB NOT NULL CHECK(length(verifier) >= ${SEALED_MIN_BYTES}),
  issuer TEXT NOT NULL, redirect_uri TEXT NOT NULL, resource TEXT NOT NULL,
  expires_at TEXT NOT NULL, claimed_at TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS app_pins (
  app_id TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  instructions TEXT,
  list_hash TEXT NOT NULL,
  pinned_at TEXT NOT NULL,
  confirmed_at TEXT NOT NULL,
  reviewed_list_hash TEXT,
  reviewed_at TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS app_tools (
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  definition_hash TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  label TEXT CHECK(label IS NULL OR label IN ('ask_first','just_do')),
  label_source TEXT CHECK(label_source IS NULL OR label_source IN ('sorter','floor','principal','approved_request','fallback')),
  summary TEXT,
  reason TEXT,
  sorter_version TEXT,
  principal_floor INTEGER NOT NULL DEFAULT 0 CHECK(principal_floor IN (0,1)),
  unsettled INTEGER NOT NULL DEFAULT 0 CHECK(unsettled IN (0,1)),
  sort_attempts INTEGER NOT NULL DEFAULT 0 CHECK(sort_attempts >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (app_id, name)
) STRICT;
CREATE TABLE IF NOT EXISTS app_tool_floors (
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (app_id, name)
) STRICT;
CREATE TABLE IF NOT EXISTS app_tool_revisions (
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  PRIMARY KEY (app_id, name)
) STRICT;
CREATE TABLE IF NOT EXISTS app_tool_sorts (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  list_hash TEXT NOT NULL,
  sorter_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','completed','failed','timed_out')),
  attempt INTEGER NOT NULL CHECK(attempt > 0),
  created_at TEXT NOT NULL,
  completed_at TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_app_tool_sorts_app ON app_tool_sorts(app_id, created_at, id);
CREATE TABLE IF NOT EXISTS relay_calls (
  id TEXT PRIMARY KEY,
  approval_id TEXT UNIQUE,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  grant_generation INTEGER NOT NULL CHECK(grant_generation > 0),
  tool_name TEXT NOT NULL,
  definition_hash TEXT NOT NULL,
  args_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('executing','completed','unsent','too_large','unknown')),
  outcome_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_relay_calls_app_updated ON relay_calls(app_id, grant_generation, state, updated_at DESC);
CREATE TABLE IF NOT EXISTS relay_invocations (
  invocation_id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  grant_generation INTEGER NOT NULL CHECK(grant_generation > 0),
  tool_name TEXT NOT NULL,
  args_hash TEXT NOT NULL,
  strip_summary INTEGER NOT NULL DEFAULT 1 CHECK(strip_summary IN (0,1)),
  mode TEXT NOT NULL CHECK(mode IN ('direct','held')),
  approval_id TEXT,
  state TEXT NOT NULL CHECK(state IN ('active','settled','declined','expired','withdrawn')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS restart_request (
  id INTEGER PRIMARY KEY CHECK(id = 1), applied_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS pending_gateway_cleanups (
  host TEXT PRIMARY KEY, created_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS settled_tool_ask_requests (
  request_id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  settled_at TEXT NOT NULL
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
  readonly has_access_token: number;
  readonly client: Buffer | null;
}
interface AccessTokenRow {
  readonly generation: number;
  readonly token: Buffer;
  readonly issued_at: string;
  readonly expires_at: string;
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
interface AppPinRow {
  readonly app_id: string;
  readonly instructions: string | null;
  readonly list_hash: string;
  readonly pinned_at: string;
  readonly confirmed_at: string;
  readonly reviewed_list_hash: string | null;
  readonly reviewed_at: string | null;
}
interface AppToolRow {
  readonly app_id: string;
  readonly name: string;
  readonly definition_hash: string;
  readonly definition_json: string;
  readonly label: ToolLabel | null;
  readonly label_source: ToolLabelSource | null;
  readonly summary: string | null;
  readonly reason: string | null;
  readonly sorter_version: string | null;
  readonly principal_floor: number;
  readonly unsettled: number;
  readonly sort_attempts: number;
  readonly updated_at: string;
}
interface ToolSortRow {
  readonly id: string;
  readonly app_id: string;
  readonly list_hash: string;
  readonly sorter_version: string;
  readonly status: ToolSortStatus;
  readonly attempt: number;
  readonly created_at: string;
  readonly completed_at: string | null;
}
interface RelayCallRow {
  readonly id: string;
  readonly approval_id: string | null;
  readonly app_id: string;
  readonly grant_generation: number;
  readonly tool_name: string;
  readonly definition_hash: string;
  readonly args_hash: string;
  readonly state: RelayCallState;
  readonly outcome_json: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}
interface RelayInvocationRow {
  readonly invocation_id: string;
  readonly app_id: string;
  readonly grant_generation: number;
  readonly tool_name: string;
  readonly args_hash: string;
  readonly strip_summary: number;
  readonly mode: RelayInvocationMode;
  readonly approval_id: string | null;
  readonly state: RelayInvocationState;
  readonly created_at: string;
  readonly updated_at: string;
}

function toAppPin(row: AppPinRow): AppPin {
  return {
    appId: row.app_id,
    instructions: row.instructions,
    listHash: row.list_hash,
    pinnedAt: row.pinned_at,
    confirmedAt: row.confirmed_at,
    reviewedListHash: row.reviewed_list_hash,
    reviewedAt: row.reviewed_at,
    needsReview: row.reviewed_list_hash !== row.list_hash,
  };
}

function toPinnedTool(row: AppToolRow): PinnedAppTool {
  return {
    appId: row.app_id,
    name: row.name,
    definitionHash: row.definition_hash,
    definition: normalizeToolDefinition(JSON.parse(row.definition_json)),
    label: row.label,
    labelSource: row.label_source,
    summary: row.summary ?? null,
    reason: row.reason,
    sorterVersion: row.sorter_version,
    principalFloor: row.principal_floor === 1,
    unsettled: row.unsettled === 1,
    sortAttempts: row.sort_attempts,
    updatedAt: row.updated_at,
  };
}

function toToolSort(row: ToolSortRow): ToolSortRecord {
  return {
    id: row.id,
    appId: row.app_id,
    listHash: row.list_hash,
    sorterVersion: row.sorter_version,
    status: row.status,
    attempt: row.attempt,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

function toRelayCall(row: RelayCallRow): RelayCallRecord {
  return {
    id: row.id,
    approvalId: row.approval_id,
    appId: row.app_id,
    grantGeneration: row.grant_generation,
    toolName: row.tool_name,
    definitionHash: row.definition_hash,
    argsHash: row.args_hash,
    state: row.state,
    outcomeJson: row.outcome_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRelayInvocation(row: RelayInvocationRow): RelayInvocationRecord {
  return {
    invocationId: row.invocation_id,
    appId: row.app_id,
    grantGeneration: row.grant_generation,
    toolName: row.tool_name,
    argsHash: row.args_hash,
    stripSummary: row.strip_summary === 1,
    mode: row.mode,
    approvalId: row.approval_id,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function invocationIdFromDirectCallId(id: string): string {
  return id.startsWith('direct:') ? id.slice('direct:'.length) : id;
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
  const { clientId, clientSecret, tokenEndpointAuthMethod, kind } = value as Record<string, unknown>;
  if (typeof clientId !== 'string') throw new Error('Sealed client is malformed');
  return {
    clientId,
    ...(typeof clientSecret === 'string' ? { clientSecret } : {}),
    ...(typeof tokenEndpointAuthMethod === 'string' ? { tokenEndpointAuthMethod } : {}),
    ...(kind === 'document' ? { kind } : {}),
  };
}
function grantValid(grant: NewGrant): void {
  switch (grant.kind) {
    case 'oauth':
      if (grant.refreshToken !== undefined) secretValid(grant.refreshToken);
      secretValid(grant.accessToken);
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

  private ensureSchema(db: Database.Database): void {
    const columns = db.prepare<[], { name: string }>('PRAGMA table_info(app_tools)').all();
    if (!columns.some((col) => col.name === 'summary')) {
      db.exec('ALTER TABLE app_tools ADD COLUMN summary TEXT');
    }
  }

  private async use<T>(operation: (db: Database.Database) => T | Promise<T>): Promise<T> {
    try {
      return await withPrivateDatabase(this.file, SCHEMA, (db) => {
        this.ensureSchema(db);
        return operation(db);
      });
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
              SELECT 1 FROM grants WHERE secret IS NOT NULL UNION ALL
              SELECT 1 FROM access_tokens UNION ALL
              SELECT 1 FROM sign_ins) AS present`,
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
  async byServerKey(serverKey: string): Promise<ConnectionApp | undefined> {
    return this.use((db) => {
      const row = db
        .prepare<[string], AppRow>(`SELECT ${APP_COLUMNS} FROM ${APP_FROM} WHERE a.server_key = ?`)
        .get(serverKey);
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
          g.access_issued_at, g.access_expires_at,
          (t.token IS NOT NULL) AS has_access_token, a.client
          FROM grants g
          JOIN apps a ON a.id = g.app_id
          LEFT JOIN access_tokens t ON t.app_id = g.app_id AND t.generation = g.generation
          WHERE g.app_id = ?`,
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
      hasAccessToken: row.has_access_token === 1,
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
    let sealedAccess: Buffer | undefined;
    if (grant.kind === 'oauth') {
      if (!key) throw new ConnectionsStoreError('store_unavailable');
      sealedAccess = this.sealText(grant.accessToken, key);
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
    db.prepare('DELETE FROM access_tokens WHERE app_id = ?').run(app.id);
    db.prepare('DELETE FROM app_pins WHERE app_id = ?').run(app.id);
    db.prepare('DELETE FROM app_tools WHERE app_id = ?').run(app.id);
    db.prepare('UPDATE relay_calls SET outcome_json = NULL WHERE app_id = ? AND approval_id IS NULL').run(app.id);
    if (grant.kind === 'oauth' && sealedAccess) {
      db.prepare(
        `INSERT INTO access_tokens (app_id, generation, token, issued_at, expires_at)
          VALUES (?, ?, ?, ?, ?)`,
      ).run(app.id, generation, sealedAccess, grant.accessIssuedAt, grant.accessExpiresAt);
    }
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
        .prepare<[], { appId: string; generation: number }>(
          "SELECT app_id AS appId, generation FROM grants WHERE state = 'refused' ORDER BY app_id",
        )
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

  /** The sealed OAuth access token for a live grant at this exact generation, or undefined when none is stored. */
  async readAccessToken(appId: string, generation: number): Promise<StoredAccessToken | undefined> {
    const find = (db: Database.Database): AccessTokenRow | undefined =>
      db
        .prepare<[string, number, number], AccessTokenRow>(
          `SELECT t.generation, t.token, t.issued_at, t.expires_at
            FROM access_tokens t
            JOIN grants g ON g.app_id = t.app_id
            WHERE t.app_id = ? AND g.state = 'live' AND g.kind = 'oauth' AND g.generation = ? AND t.generation = ?`,
        )
        .get(appId, generation, generation);
    return this.use(async (db) => {
      if (!find(db)) return undefined;
      return this.withKey(db, (key) => {
        const row = find(db);
        if (!row) return undefined;
        return {
          generation: row.generation,
          token: this.unsealText(row.token, key),
          issuedAt: row.issued_at,
          expiresAt: row.expires_at,
        };
      });
    });
  }

  /** Persists a renewal and its sealed access token atomically; false when the grant moved on meanwhile. */
  async rotateGrant(appId: string, generation: number, rotation: GrantRotation): Promise<boolean> {
    if (rotation.refreshToken !== undefined) secretValid(rotation.refreshToken);
    secretValid(rotation.accessToken);
    isoValid(rotation.accessIssuedAt);
    isoValid(rotation.accessExpiresAt);
    return this.use(async (db) => {
      const row = this.grantRow(db, appId);
      if (row?.state !== 'live' || row.generation !== generation || row.kind !== 'oauth') return false;
      return this.withKey(db, (key) => {
        const sealedRefresh = rotation.refreshToken === undefined ? null : this.sealText(rotation.refreshToken, key);
        const sealedAccess = this.sealText(rotation.accessToken, key);
        return db
          .transaction(() => {
            const changed = db
              .prepare(
                `UPDATE grants SET secret = COALESCE(?, secret), access_issued_at = ?, access_expires_at = ?,
                    access_published = 0, updated_at = ?
                  WHERE app_id = ? AND generation = ? AND state = 'live' AND kind = 'oauth'`,
              )
              .run(
                sealedRefresh,
                rotation.accessIssuedAt,
                rotation.accessExpiresAt,
                new Date().toISOString(),
                appId,
                generation,
              ).changes;
            if (changed !== 1) return false;
            db.prepare(
              `INSERT INTO access_tokens (app_id, generation, token, issued_at, expires_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(app_id) DO UPDATE SET generation = excluded.generation, token = excluded.token,
                  issued_at = excluded.issued_at, expires_at = excluded.expires_at`,
            ).run(appId, generation, sealedAccess, rotation.accessIssuedAt, rotation.accessExpiresAt);
            return true;
          })
          .immediate();
      });
    });
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
    db.prepare('DELETE FROM access_tokens WHERE app_id = ?').run(appId);
    db.prepare('UPDATE relay_calls SET outcome_json = NULL WHERE app_id = ? AND approval_id IS NULL').run(appId);
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

  /** Forgets the app, its client, grant and sign-in in one step; optionally queues legacy gateway cleanup for its host. */
  async remove(
    id: string,
    version: number,
    options?: { readonly pendingGatewayCleanup?: boolean; readonly at?: string },
  ): Promise<ReleaseResult> {
    versionValid(version);
    const at = options?.at ?? new Date().toISOString();
    isoValid(at);
    return this.use(async (db) => {
      this.appAt(db, id, version);
      return this.withReadableKey(db, (key) =>
        db
          .transaction(() => {
            const app = this.appAt(db, id, version);
            const row = this.grantRow(db, id);
            const released = row && this.credentials(row, key);
            if (options?.pendingGatewayCleanup) {
              db.prepare(
                `INSERT INTO pending_gateway_cleanups (host, created_at) VALUES (?, ?)
                  ON CONFLICT(host) DO NOTHING`,
              ).run(app.host, at);
            }
            if (db.prepare('DELETE FROM apps WHERE id = ? AND version = ?').run(id, version).changes !== 1)
              throw new ConnectionsStoreError('app_changed');
            return { released };
          })
          .immediate(),
      );
    });
  }

  async listPendingGatewayCleanups(): Promise<readonly string[]> {
    return this.use((db) =>
      db
        .prepare<[], { host: string }>('SELECT host FROM pending_gateway_cleanups ORDER BY created_at, host')
        .all()
        .map((row) => row.host),
    );
  }

  async clearPendingGatewayCleanup(host: string): Promise<void> {
    await this.use((db) => {
      db.prepare('DELETE FROM pending_gateway_cleanups WHERE host = ?').run(host);
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
        .prepare<[string], SignInRow>(
          `SELECT s.*, a.host FROM sign_ins s JOIN apps a ON a.id = s.app_id WHERE s.state_hash = ?`,
        )
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

  async getPin(appId: string): Promise<AppPin | undefined> {
    return this.use((db) => {
      const row = db.prepare<[string], AppPinRow>('SELECT * FROM app_pins WHERE app_id = ?').get(appId);
      return row && toAppPin(row);
    });
  }

  async listPins(): Promise<readonly AppPin[]> {
    return this.use((db) => db.prepare<[], AppPinRow>('SELECT * FROM app_pins ORDER BY app_id').all().map(toAppPin));
  }

  async listTools(appId: string): Promise<readonly PinnedAppTool[]> {
    return this.use((db) =>
      db
        .prepare<[string], AppToolRow>('SELECT * FROM app_tools WHERE app_id = ? ORDER BY name')
        .all(appId)
        .map(toPinnedTool),
    );
  }

  async listAllTools(): Promise<readonly PinnedAppTool[]> {
    return this.use((db) =>
      db.prepare<[], AppToolRow>('SELECT * FROM app_tools ORDER BY app_id, name').all().map(toPinnedTool),
    );
  }

  async getTool(appId: string, name: string): Promise<PinnedAppTool | undefined> {
    return this.use((db) => {
      const row = db
        .prepare<[string, string], AppToolRow>('SELECT * FROM app_tools WHERE app_id = ? AND name = ?')
        .get(appId, name);
      return row && toPinnedTool(row);
    });
  }

  async readAppTools(appId: string): Promise<
    | {
        readonly app: ConnectionApp;
        readonly grantGeneration: number | undefined;
        readonly pin: AppPin | undefined;
        readonly tools: readonly PinnedAppTool[];
      }
    | undefined
  > {
    return this.use((db) => {
      const row = db.prepare<[string], AppRow>(`SELECT ${APP_COLUMNS} FROM ${APP_FROM} WHERE a.id = ?`).get(appId);
      if (!row) return undefined;
      const grant = this.grantRow(db, appId);
      const pinRow = db.prepare<[string], AppPinRow>('SELECT * FROM app_pins WHERE app_id = ?').get(appId);
      const tools = db
        .prepare<[string], AppToolRow>('SELECT * FROM app_tools WHERE app_id = ? ORDER BY name')
        .all(appId)
        .map(toPinnedTool);
      return {
        app: toApp(row),
        grantGeneration: grant?.state === 'live' ? grant.generation : undefined,
        pin: pinRow && toAppPin(pinRow),
        tools,
      };
    });
  }

  /**
   * Pins an app's current tool definitions and server instructions. Unchanged definitions keep their labels;
   * changed or new definitions become unsorted while preserving any principal-set Ask-first floor.
   */
  async pinTools(
    appId: string,
    input: {
      readonly instructions: string | null;
      readonly tools: readonly ToolDefinition[];
      readonly expectedGrantGeneration?: number;
      readonly at?: string;
    },
  ): Promise<PinToolsResult> {
    const at = input.at ?? new Date().toISOString();
    isoValid(at);
    const deduped = new Map<string, { readonly definition: ToolDefinition; readonly hash: string }>();
    for (const tool of input.tools) {
      const definition = normalizeToolDefinition(tool);
      if (!deduped.has(definition.name)) {
        deduped.set(definition.name, { definition, hash: sha256Hex(canonicalJson(definition)) });
      }
    }
    const normalized = [...deduped.values()];
    const nextListHash = toolListHash(
      normalized.map(({ definition, hash }) => ({ name: definition.name, definitionHash: hash })),
      input.instructions,
    );
    return this.use((db) =>
      db
        .transaction((): PinToolsResult => {
          this.app(db, appId);
          if (input.expectedGrantGeneration !== undefined) {
            const grant = this.grantRow(db, appId);
            if (!grant || grant.state !== 'live' || grant.generation !== input.expectedGrantGeneration) {
              throw new ConnectionsStoreError('app_changed');
            }
          }
          const existingPin = db.prepare<[string], AppPinRow>('SELECT * FROM app_pins WHERE app_id = ?').get(appId);
          const existingTools = new Map(
            db
              .prepare<[string], AppToolRow>('SELECT * FROM app_tools WHERE app_id = ?')
              .all(appId)
              .map((row) => [row.name, row]),
          );
          const persistedFloors = new Set(
            db
              .prepare<[string], { name: string }>('SELECT name FROM app_tool_floors WHERE app_id = ?')
              .all(appId)
              .map((row) => row.name),
          );
          const incomingNames = new Set(normalized.map(({ definition }) => definition.name));
          let changed = existingPin?.list_hash !== nextListHash;

          const deleteTool = db.prepare('DELETE FROM app_tools WHERE app_id = ? AND name = ?');
          for (const oldName of existingTools.keys()) {
            if (!incomingNames.has(oldName)) {
              deleteTool.run(appId, oldName);
              changed = true;
            }
          }

          const insertTool = db.prepare(
            `INSERT INTO app_tools
              (app_id, name, definition_hash, definition_json, label, label_source, summary, reason, sorter_version,
               principal_floor, unsettled, sort_attempts, updated_at)
              VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, 1, 0, ?)`,
          );
          const updateChangedTool = db.prepare(
            `UPDATE app_tools SET definition_hash = ?, definition_json = ?, label = NULL, label_source = NULL,
              summary = NULL, reason = NULL, sorter_version = NULL, principal_floor = ?, unsettled = 1, sort_attempts = 0,
              updated_at = ?
              WHERE app_id = ? AND name = ?`,
          );
          const updateToolJson = db.prepare(
            'UPDATE app_tools SET definition_json = ?, updated_at = ? WHERE app_id = ? AND name = ?',
          );

          for (const { definition, hash } of normalized) {
            const json = JSON.stringify(definition);
            const prev = existingTools.get(definition.name);
            const hasPersistedFloor = persistedFloors.has(definition.name);
            if (!prev) {
              insertTool.run(appId, definition.name, hash, json, hasPersistedFloor ? 1 : 0, at);
              changed = true;
            } else if (prev.definition_hash !== hash) {
              const keepFloor =
                hasPersistedFloor ||
                prev.principal_floor === 1 ||
                (prev.label === 'ask_first' &&
                  (prev.label_source === 'principal' || prev.label_source === 'approved_request'))
                  ? 1
                  : 0;
              updateChangedTool.run(hash, json, keepFloor, at, appId, definition.name);
              changed = true;
            } else if (prev.definition_json !== json) {
              updateToolJson.run(json, at, appId, definition.name);
            }
          }

          const pinnedAt = !existingPin || existingPin.list_hash !== nextListHash ? at : existingPin.pinned_at;
          db.prepare(
            `INSERT INTO app_pins (app_id, instructions, list_hash, pinned_at, confirmed_at, reviewed_list_hash, reviewed_at)
              VALUES (?, ?, ?, ?, ?, NULL, NULL)
              ON CONFLICT(app_id) DO UPDATE SET instructions = excluded.instructions, list_hash = excluded.list_hash,
                pinned_at = excluded.pinned_at, confirmed_at = excluded.confirmed_at,
                reviewed_list_hash = CASE WHEN app_pins.list_hash = excluded.list_hash THEN app_pins.reviewed_list_hash ELSE NULL END,
                reviewed_at = CASE WHEN app_pins.list_hash = excluded.list_hash THEN app_pins.reviewed_at ELSE NULL END`,
          ).run(appId, input.instructions, nextListHash, pinnedAt, at);

          const pinRow = db.prepare<[string], AppPinRow>('SELECT * FROM app_pins WHERE app_id = ?').get(appId);
          if (!pinRow) throw new ConnectionsStoreError('store_unavailable');
          const tools = db
            .prepare<[string], AppToolRow>('SELECT * FROM app_tools WHERE app_id = ? ORDER BY name')
            .all(appId)
            .map(toPinnedTool);
          const unsortedCount = tools.filter((tool) => tool.label === null).length;
          return { pin: toAppPin(pinRow), tools, changed, unsortedCount };
        })
        .immediate(),
    );
  }

  /**
   * Applies sorter or floor labels for tools whose stored definition hash still matches. A principal-set Ask-first
   * floor can never be lowered by sorter or floor updates.
   */
  async applyToolLabels(
    appId: string,
    updates: readonly ToolLabelUpdate[],
    options: { readonly expectedGrantGeneration?: number; readonly sorterVersion?: string; readonly at?: string } = {},
  ): Promise<number> {
    const at = options.at ?? new Date().toISOString();
    isoValid(at);
    return this.use((db) =>
      db
        .transaction(() => {
          if (options.expectedGrantGeneration !== undefined) {
            const grant = this.grantRow(db, appId);
            if (!grant || grant.state !== 'live' || grant.generation !== options.expectedGrantGeneration) {
              return 0;
            }
          }
          const selectTool = db.prepare<[string, string], AppToolRow>(
            'SELECT * FROM app_tools WHERE app_id = ? AND name = ?',
          );
          const updateTool = db.prepare(
            `UPDATE app_tools SET label = ?, label_source = ?, summary = ?, reason = ?, sorter_version = COALESCE(?, sorter_version),
              principal_floor = ?, unsettled = 0, sort_attempts = 0, updated_at = ?
              WHERE app_id = ? AND name = ? AND definition_hash = ?`,
          );
          const backfillSummary = db.prepare(
            `UPDATE app_tools SET summary = COALESCE(summary, ?), updated_at = ?
              WHERE app_id = ? AND name = ? AND definition_hash = ?`,
          );
          const upsertFloor = db.prepare(
            `INSERT INTO app_tool_floors (app_id, name, updated_at) VALUES (?, ?, ?)
              ON CONFLICT(app_id, name) DO UPDATE SET updated_at = excluded.updated_at`,
          );
          const deleteFloor = db.prepare('DELETE FROM app_tool_floors WHERE app_id = ? AND name = ?');
          let applied = 0;
          let labelChangedBySorter = false;
          for (const update of updates) {
            const row = selectTool.get(appId, update.name);
            if (!row || row.definition_hash !== update.definitionHash) continue;
            const nextSummary = update.summary !== undefined ? update.summary : row.summary;
            const principalOverride = update.source === 'principal' || update.source === 'approved_request';
            if (
              !principalOverride &&
              row.label !== null &&
              (row.label_source === 'principal' || row.label_source === 'approved_request')
            ) {
              if (row.summary === null && nextSummary) {
                backfillSummary.run(nextSummary, at, appId, update.name, update.definitionHash);
              }
              continue;
            }
            const floorLocked = !principalOverride && row.principal_floor === 1 && update.label === 'just_do';
            const label: ToolLabel = floorLocked ? 'ask_first' : update.label;
            const labelSource: ToolLabelSource = floorLocked ? 'principal' : update.source;
            const reason = floorLocked ? 'Kept as ask first per your earlier choice' : update.reason;
            const principalFloor = principalOverride ? (label === 'ask_first' ? 1 : 0) : row.principal_floor;
            if (!principalOverride && row.label !== null && row.label !== label) {
              labelChangedBySorter = true;
            }
            updateTool.run(
              label,
              labelSource,
              nextSummary,
              reason,
              options.sorterVersion ?? null,
              principalFloor,
              at,
              appId,
              update.name,
              update.definitionHash,
            );
            if (principalOverride) {
              if (principalFloor === 1) upsertFloor.run(appId, update.name, at);
              else deleteFloor.run(appId, update.name);
              this.bumpToolDecisionRevision(db, appId, update.name);
            }
            applied += 1;
          }
          if (labelChangedBySorter) {
            db.prepare('UPDATE app_pins SET reviewed_list_hash = NULL, reviewed_at = NULL WHERE app_id = ?').run(appId);
          }
          return applied;
        })
        .immediate(),
    );
  }

  private bumpToolDecisionRevision(db: Database.Database, appId: string, name: string): void {
    db.prepare(
      `INSERT INTO app_tool_revisions (app_id, name, revision) VALUES (?, ?, 1)
        ON CONFLICT(app_id, name) DO UPDATE SET revision = revision + 1`,
    ).run(appId, name);
  }

  private readToolDecisionRevision(db: Database.Database, appId: string, name: string): number {
    return (
      db
        .prepare<[string, string], { revision: number }>(
          'SELECT revision FROM app_tool_revisions WHERE app_id = ? AND name = ?',
        )
        .get(appId, name)?.revision ?? 0
    );
  }

  async getToolDecisionRevision(appId: string, name: string): Promise<number> {
    return this.use((db) => this.readToolDecisionRevision(db, appId, name));
  }

  /** Reads live grant generation, pinned tool, and principal decision revision from one consistent store snapshot. */
  async readToolForAsk(
    appId: string,
    name: string,
  ): Promise<{
    readonly grantGeneration: number | undefined;
    readonly tool: PinnedAppTool | undefined;
    readonly decisionRevision: number;
  }> {
    return this.use((db) =>
      db.transaction(() => {
        const grant = this.grantRow(db, appId);
        const row = db
          .prepare<[string, string], AppToolRow>('SELECT * FROM app_tools WHERE app_id = ? AND name = ?')
          .get(appId, name);
        return {
          grantGeneration: grant?.state === 'live' ? grant.generation : undefined,
          tool: row ? toPinnedTool(row) : undefined,
          decisionRevision: this.readToolDecisionRevision(db, appId, name),
        };
      })(),
    );
  }

  /**
   * Records a failed/timed-out/malformed sort attempt for the given tools. Each affected tool defaults to Ask-first
   * and remains unsettled until `maxAttempts` failures, after which it stays Ask-first with "couldn't be checked".
   */
  async markToolSortFailed(
    appId: string,
    targets: readonly { readonly name: string; readonly definitionHash: string }[],
    options: {
      readonly expectedGrantGeneration?: number;
      readonly maxAttempts?: number;
      readonly sorterVersion?: string;
      readonly at?: string;
    } = {},
  ): Promise<void> {
    const at = options.at ?? new Date().toISOString();
    isoValid(at);
    const maxAttempts = options.maxAttempts ?? 3;
    await this.use((db) =>
      db
        .transaction(() => {
          if (options.expectedGrantGeneration !== undefined) {
            const grant = this.grantRow(db, appId);
            if (!grant || grant.state !== 'live' || grant.generation !== options.expectedGrantGeneration) {
              return;
            }
          }
          const selectTool = db.prepare<[string, string], AppToolRow>(
            'SELECT * FROM app_tools WHERE app_id = ? AND name = ?',
          );
          const updateTool = db.prepare(
            `UPDATE app_tools SET label = 'ask_first', label_source = 'fallback', reason = ?,
              sorter_version = COALESCE(?, sorter_version), unsettled = ?, sort_attempts = ?, updated_at = ?
              WHERE app_id = ? AND name = ? AND definition_hash = ?`,
          );
          let labelChanged = false;
          for (const target of targets) {
            const row = selectTool.get(appId, target.name);
            if (!row || row.definition_hash !== target.definitionHash) continue;
            if (row.label_source === 'principal' || row.label_source === 'approved_request') continue;
            if (row.label !== null && row.label !== 'ask_first') labelChanged = true;
            const attempts =
              options.sorterVersion && row.sorter_version !== null && row.sorter_version !== options.sorterVersion
                ? 1
                : row.sort_attempts + 1;
            const unsettled = attempts < maxAttempts ? 1 : 0;
            const reason = unsettled === 1 ? 'Checking again' : "Couldn't be checked";
            updateTool.run(
              reason,
              options.sorterVersion ?? null,
              unsettled,
              attempts,
              at,
              appId,
              target.name,
              target.definitionHash,
            );
          }
          if (labelChanged) {
            db.prepare('UPDATE app_pins SET reviewed_list_hash = NULL, reviewed_at = NULL WHERE app_id = ?').run(appId);
          }
        })
        .immediate(),
    );
  }

  /**
   * Atomically settles an approved `app_tool_ask` label change once per `requestId`, refusing to overwrite a newer
   * principal decision (from the Connections page or an approved request), a changed tool definition, or a replaced
   * grant, and recording a main restart atomically in the same transaction.
   */
  async applyApprovedToolAsk(input: {
    readonly requestId: string;
    readonly appId: string;
    readonly name: string;
    readonly label: ToolLabel;
    readonly expectedGrantGeneration?: number;
    readonly expectedHash?: string;
    readonly expectedDecisionRevision?: number;
    readonly reason?: string;
    readonly at?: string;
  }): Promise<'applied' | 'already_settled' | 'grant_changed' | 'definition_changed' | 'principal_changed'> {
    const at = input.at ?? new Date().toISOString();
    isoValid(at);
    const reason = input.reason ?? (input.label === 'ask_first' ? 'Set to ask first' : 'Set to run without asking');
    const principalFloor = input.label === 'ask_first' ? 1 : 0;
    return this.use((db) =>
      db
        .transaction(
          (): 'applied' | 'already_settled' | 'grant_changed' | 'definition_changed' | 'principal_changed' => {
            const settled = db
              .prepare<[string], { request_id: string }>(
                'SELECT request_id FROM settled_tool_ask_requests WHERE request_id = ?',
              )
              .get(input.requestId);
            if (settled) return 'already_settled';
            if (input.expectedGrantGeneration !== undefined) {
              const grant = this.grantRow(db, input.appId);
              if (!grant || grant.state !== 'live' || grant.generation !== input.expectedGrantGeneration) {
                return 'grant_changed';
              }
            }
            const row = db
              .prepare<[string, string], AppToolRow>('SELECT * FROM app_tools WHERE app_id = ? AND name = ?')
              .get(input.appId, input.name);
            if (!row || (input.expectedHash !== undefined && row.definition_hash !== input.expectedHash)) {
              return 'definition_changed';
            }
            if (
              input.expectedDecisionRevision !== undefined &&
              this.readToolDecisionRevision(db, input.appId, input.name) !== input.expectedDecisionRevision
            ) {
              return 'principal_changed';
            }
            db.prepare(
              `UPDATE app_tools SET label = ?, label_source = 'approved_request', reason = ?, principal_floor = ?,
                unsettled = 0, updated_at = ?
                WHERE app_id = ? AND name = ?`,
            ).run(input.label, reason, principalFloor, at, input.appId, input.name);
            if (principalFloor === 1) {
              db.prepare(
                `INSERT INTO app_tool_floors (app_id, name, updated_at) VALUES (?, ?, ?)
                  ON CONFLICT(app_id, name) DO UPDATE SET updated_at = excluded.updated_at`,
              ).run(input.appId, input.name, at);
            } else {
              db.prepare('DELETE FROM app_tool_floors WHERE app_id = ? AND name = ?').run(input.appId, input.name);
            }
            this.bumpToolDecisionRevision(db, input.appId, input.name);
            db.prepare('INSERT INTO settled_tool_ask_requests (request_id, app_id, settled_at) VALUES (?, ?, ?)').run(
              input.requestId,
              input.appId,
              at,
            );
            db.prepare(
              `INSERT INTO restart_request (id, applied_at) VALUES (1, ?)
                ON CONFLICT(id) DO UPDATE SET applied_at = max(applied_at, excluded.applied_at)`,
            ).run(at);
            return 'applied';
          },
        )
        .immediate(),
    );
  }

  async setToolLabel(
    appId: string,
    name: string,
    label: ToolLabel,
    source: 'principal' | 'approved_request',
    options: { readonly expectedHash?: string; readonly reason?: string; readonly at?: string } = {},
  ): Promise<boolean> {
    const at = options.at ?? new Date().toISOString();
    isoValid(at);
    const reason = options.reason ?? (label === 'ask_first' ? 'Set to ask first' : 'Set to run without asking');
    const principalFloor = label === 'ask_first' ? 1 : 0;
    return this.use((db) =>
      db
        .transaction(() => {
          const row = db
            .prepare<[string, string], AppToolRow>('SELECT * FROM app_tools WHERE app_id = ? AND name = ?')
            .get(appId, name);
          if (!row) return false;
          if (options.expectedHash !== undefined && row.definition_hash !== options.expectedHash) return false;
          const updated =
            db
              .prepare(
                `UPDATE app_tools SET label = ?, label_source = ?, reason = ?, principal_floor = ?, unsettled = 0,
                  updated_at = ?
                  WHERE app_id = ? AND name = ?`,
              )
              .run(label, source, reason, principalFloor, at, appId, name).changes === 1;
          if (updated) {
            if (principalFloor === 1) {
              db.prepare(
                `INSERT INTO app_tool_floors (app_id, name, updated_at) VALUES (?, ?, ?)
                  ON CONFLICT(app_id, name) DO UPDATE SET updated_at = excluded.updated_at`,
              ).run(appId, name, at);
            } else {
              db.prepare('DELETE FROM app_tool_floors WHERE app_id = ? AND name = ?').run(appId, name);
            }
            this.bumpToolDecisionRevision(db, appId, name);
            db.prepare(
              `INSERT INTO restart_request (id, applied_at) VALUES (1, ?)
                ON CONFLICT(id) DO UPDATE SET applied_at = max(applied_at, excluded.applied_at)`,
            ).run(at);
          }
          return updated;
        })
        .immediate(),
    );
  }

  async markToolsReviewed(
    appId: string,
    expectedListHash?: string,
    at = new Date().toISOString(),
    expectedLabelsHash?: string,
  ): Promise<boolean> {
    isoValid(at);
    return this.use((db) =>
      db
        .transaction(() => {
          const pin = db.prepare<[string], AppPinRow>('SELECT * FROM app_pins WHERE app_id = ?').get(appId);
          if (!pin) return false;
          if (expectedListHash !== undefined && pin.list_hash !== expectedListHash) return false;
          const rows = db
            .prepare<[string], AppToolRow>('SELECT * FROM app_tools WHERE app_id = ? ORDER BY name')
            .all(appId);
          if (rows.some((row) => row.label === null || row.unsettled === 1)) return false;
          if (expectedLabelsHash !== undefined && toolLabelsHash(rows.map(toPinnedTool)) !== expectedLabelsHash) {
            return false;
          }
          return (
            db
              .prepare('UPDATE app_pins SET reviewed_list_hash = list_hash, reviewed_at = ? WHERE app_id = ?')
              .run(at, appId).changes === 1
          );
        })
        .immediate(),
    );
  }

  async recordToolSortStart(input: {
    readonly id: string;
    readonly appId: string;
    readonly listHash: string;
    readonly sorterVersion: string;
    readonly attempt: number;
    readonly at?: string;
  }): Promise<void> {
    const at = input.at ?? new Date().toISOString();
    isoValid(at);
    await this.use((db) => {
      db.prepare(
        `INSERT INTO app_tool_sorts (id, app_id, list_hash, sorter_version, status, attempt, created_at, completed_at)
          VALUES (?, ?, ?, ?, 'pending', ?, ?, NULL)`,
      ).run(input.id, input.appId, input.listHash, input.sorterVersion, input.attempt, at);
    });
  }

  async finishToolSort(
    id: string,
    status: Exclude<ToolSortStatus, 'pending'>,
    at = new Date().toISOString(),
  ): Promise<void> {
    isoValid(at);
    await this.use((db) => {
      db.prepare('UPDATE app_tool_sorts SET status = ?, completed_at = ? WHERE id = ?').run(status, at, id);
    });
  }

  async listToolSorts(appId: string): Promise<readonly ToolSortRecord[]> {
    return this.use((db) =>
      db
        .prepare<[string], ToolSortRow>('SELECT * FROM app_tool_sorts WHERE app_id = ? ORDER BY created_at, id')
        .all(appId)
        .map(toToolSort),
    );
  }

  /** Connected apps whose pinned tools have unsorted, unsettled, or stale-sorter-version rows. */
  async appsNeedingSort(
    currentSorterVersion?: string,
  ): Promise<readonly { readonly appId: string; readonly listHash: string }[]> {
    return this.use((db) => {
      if (currentSorterVersion === undefined) {
        return db
          .prepare<[], { appId: string; listHash: string }>(
            `SELECT DISTINCT p.app_id AS appId, p.list_hash AS listHash
              FROM app_pins p
              JOIN grants g ON g.app_id = p.app_id AND g.state = 'live'
              JOIN app_tools t ON t.app_id = p.app_id
              WHERE t.label IS NULL OR t.unsettled = 1
              ORDER BY p.app_id`,
          )
          .all();
      }
      return db
        .prepare<[string], { appId: string; listHash: string }>(
          `SELECT DISTINCT p.app_id AS appId, p.list_hash AS listHash
            FROM app_pins p
            JOIN grants g ON g.app_id = p.app_id AND g.state = 'live'
            JOIN app_tools t ON t.app_id = p.app_id
            WHERE t.label IS NULL
               OR t.unsettled = 1
               OR (t.sorter_version IS NOT NULL AND t.sorter_version <> ? AND t.label_source IN ('sorter', 'floor', 'fallback'))
            ORDER BY p.app_id`,
        )
        .all(currentSorterVersion);
    });
  }

  /**
   * Atomically claims an approved call before sending anything upstream. Replays find the existing row and never
   * dispatch a second upstream call, even if the same invocation already ran directly or under another approval.
   */
  async claimApprovedCall(input: {
    readonly approvalId: string;
    readonly invocationId?: string;
    readonly appId: string;
    readonly grantGeneration: number;
    readonly toolName: string;
    readonly definitionHash: string;
    readonly argsHash: string;
    readonly at?: string;
  }): Promise<ClaimApprovedCallResult> {
    const at = input.at ?? new Date().toISOString();
    isoValid(at);
    return this.use((db) =>
      db
        .transaction((): ClaimApprovedCallResult => {
          const existing = db
            .prepare<[string], RelayCallRow>('SELECT * FROM relay_calls WHERE approval_id = ?')
            .get(input.approvalId);
          if (existing) {
            const record = toRelayCall(existing);
            return record.state === 'executing'
              ? { status: 'already_executing', record }
              : { status: 'already_settled', record };
          }
          if (input.invocationId) {
            const inv = db
              .prepare<[string], RelayInvocationRow>('SELECT * FROM relay_invocations WHERE invocation_id = ?')
              .get(input.invocationId);
            if (inv) {
              if (inv.mode === 'direct') {
                const directRow = db
                  .prepare<[string], RelayCallRow>('SELECT * FROM relay_calls WHERE id = ?')
                  .get(`direct:${input.invocationId}`);
                if (directRow) {
                  const record = toRelayCall(directRow);
                  return record.state === 'executing'
                    ? { status: 'already_executing', record }
                    : { status: 'already_settled', record };
                }
                return { status: 'already_dispatched' };
              }
              if (inv.approval_id !== null && inv.approval_id !== input.approvalId) {
                return { status: 'already_dispatched' };
              }
            }
          }
          const appExists = db.prepare<[string], { id: string }>('SELECT id FROM apps WHERE id = ?').get(input.appId);
          if (!appExists) return { status: 'app_not_found' };
          if (input.invocationId) {
            db.prepare(
              `INSERT INTO relay_invocations
                (invocation_id, app_id, grant_generation, tool_name, args_hash, mode, approval_id, state, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, 'held', ?, 'settled', ?, ?)
                ON CONFLICT(invocation_id) DO UPDATE SET approval_id = excluded.approval_id, state = 'settled', updated_at = excluded.updated_at`,
            ).run(
              input.invocationId,
              input.appId,
              input.grantGeneration,
              input.toolName,
              input.argsHash,
              input.approvalId,
              at,
              at,
            );
          }
          db.prepare(
            `INSERT INTO relay_calls
              (id, approval_id, app_id, grant_generation, tool_name, definition_hash, args_hash, state, outcome_json,
               created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, 'executing', NULL, ?, ?)`,
          ).run(
            input.approvalId,
            input.approvalId,
            input.appId,
            input.grantGeneration,
            input.toolName,
            input.definitionHash,
            input.argsHash,
            at,
            at,
          );
          return { status: 'claimed' };
        })
        .immediate(),
    );
  }

  /**
   * Atomically claims a direct ("just do it") call before sending anything upstream. Replays find the existing row
   * so settled outcomes are returned without re-invoking upstream, held invocations never dispatch directly, and
   * mismatched arguments for the same invocation ID are refused.
   */
  async claimDirectCall(input: {
    readonly id: string;
    readonly invocationId?: string;
    readonly appId: string;
    readonly grantGeneration: number;
    readonly toolName: string;
    readonly definitionHash: string;
    readonly argsHash: string;
    readonly stripSummary?: boolean;
    readonly at?: string;
  }): Promise<ClaimDirectCallResult> {
    const at = input.at ?? new Date().toISOString();
    isoValid(at);
    const invocationId = input.invocationId ?? invocationIdFromDirectCallId(input.id);
    const stripSummary = input.stripSummary === false ? 0 : 1;
    return this.use((db) =>
      db
        .transaction((): ClaimDirectCallResult => {
          const inv = db
            .prepare<[string], RelayInvocationRow>('SELECT * FROM relay_invocations WHERE invocation_id = ?')
            .get(invocationId);
          if (inv) {
            if (inv.app_id !== input.appId || inv.tool_name !== input.toolName || inv.args_hash !== input.argsHash) {
              return { status: 'conflict' };
            }
            if (inv.mode === 'held') {
              return { status: 'already_held', invocation: toRelayInvocation(inv) };
            }
            const directRow = db
              .prepare<[string], RelayCallRow>('SELECT * FROM relay_calls WHERE id = ?')
              .get(input.id);
            if (directRow) {
              const record = toRelayCall(directRow);
              return record.state === 'executing'
                ? { status: 'already_executing', record }
                : { status: 'already_settled', record };
            }
          }
          const existing = db.prepare<[string], RelayCallRow>('SELECT * FROM relay_calls WHERE id = ?').get(input.id);
          if (existing) {
            if (
              existing.app_id !== input.appId ||
              existing.tool_name !== input.toolName ||
              existing.args_hash !== input.argsHash
            ) {
              return { status: 'conflict' };
            }
            const record = toRelayCall(existing);
            return record.state === 'executing'
              ? { status: 'already_executing', record }
              : { status: 'already_settled', record };
          }
          const appExists = db.prepare<[string], { id: string }>('SELECT id FROM apps WHERE id = ?').get(input.appId);
          if (!appExists) return { status: 'app_not_found' };
          db.prepare(
            `INSERT INTO relay_invocations
              (invocation_id, app_id, grant_generation, tool_name, args_hash, strip_summary, mode, approval_id, state, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, 'direct', NULL, 'active', ?, ?)`,
          ).run(invocationId, input.appId, input.grantGeneration, input.toolName, input.argsHash, stripSummary, at, at);
          db.prepare(
            `INSERT INTO relay_calls
              (id, approval_id, app_id, grant_generation, tool_name, definition_hash, args_hash, state, outcome_json,
               created_at, updated_at)
              VALUES (?, NULL, ?, ?, ?, ?, ?, 'executing', NULL, ?, ?)`,
          ).run(
            input.id,
            input.appId,
            input.grantGeneration,
            input.toolName,
            input.definitionHash,
            input.argsHash,
            at,
            at,
          );
          return { status: 'claimed' };
        })
        .immediate(),
    );
  }

  async getRelayCall(id: string): Promise<RelayCallRecord | undefined> {
    return this.use((db) => {
      const row = db.prepare<[string], RelayCallRow>('SELECT * FROM relay_calls WHERE id = ?').get(id);
      return row ? toRelayCall(row) : undefined;
    });
  }

  async getRelayInvocation(invocationId: string): Promise<RelayInvocationRecord | undefined> {
    return this.use((db) => {
      const row = db
        .prepare<[string], RelayInvocationRow>('SELECT * FROM relay_invocations WHERE invocation_id = ?')
        .get(invocationId);
      return row ? toRelayInvocation(row) : undefined;
    });
  }

  /** Atomically converts an unsent direct claim into a held invocation so no replay can dispatch directly in between. */
  async rerouteDirectCallToHold(input: {
    readonly id: string;
    readonly invocationId: string;
    readonly argsHash: string;
    readonly stripSummary?: boolean;
    readonly at?: string;
  }): Promise<void> {
    const at = input.at ?? new Date().toISOString();
    isoValid(at);
    const stripSummary = input.stripSummary === undefined ? null : input.stripSummary ? 1 : 0;
    await this.use((db) =>
      db
        .transaction(() => {
          db.prepare("DELETE FROM relay_calls WHERE id = ? AND approval_id IS NULL AND state = 'executing'").run(
            input.id,
          );
          db.prepare(
            `UPDATE relay_invocations
              SET mode = 'held', state = 'active', args_hash = ?,
                  strip_summary = COALESCE(?, strip_summary), updated_at = ?
              WHERE invocation_id = ?`,
          ).run(input.argsHash, stripSummary, at, input.invocationId);
        })
        .immediate(),
    );
  }

  /** Atomically reserves an invocation for a held approval card, preventing duplicate cards or direct dispatch races. */
  async reserveHeldInvocation(input: {
    readonly invocationId: string;
    readonly appId: string;
    readonly grantGeneration: number;
    readonly toolName: string;
    readonly argsHash: string;
    readonly stripSummary?: boolean;
    readonly at?: string;
  }): Promise<ReserveHeldInvocationResult> {
    const at = input.at ?? new Date().toISOString();
    isoValid(at);
    const stripSummary = input.stripSummary === false ? 0 : 1;
    return this.use((db) =>
      db
        .transaction((): ReserveHeldInvocationResult => {
          const existing = db
            .prepare<[string], RelayInvocationRow>('SELECT * FROM relay_invocations WHERE invocation_id = ?')
            .get(input.invocationId);
          if (existing) {
            if (
              existing.app_id !== input.appId ||
              existing.tool_name !== input.toolName ||
              existing.args_hash !== input.argsHash
            ) {
              return { status: 'conflict' };
            }
            if (existing.mode === 'held' && existing.state === 'active' && existing.approval_id === null) {
              return { status: 'reserved' };
            }
            return { status: 'existing', invocation: toRelayInvocation(existing) };
          }
          const appExists = db.prepare<[string], { id: string }>('SELECT id FROM apps WHERE id = ?').get(input.appId);
          if (!appExists) return { status: 'app_not_found' };
          db.prepare(
            `INSERT INTO relay_invocations
              (invocation_id, app_id, grant_generation, tool_name, args_hash, strip_summary, mode, approval_id, state, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, 'held', NULL, 'active', ?, ?)`,
          ).run(
            input.invocationId,
            input.appId,
            input.grantGeneration,
            input.toolName,
            input.argsHash,
            stripSummary,
            at,
            at,
          );
          return { status: 'reserved' };
        })
        .immediate(),
    );
  }

  async bindHeldApproval(invocationId: string, approvalId: string, at = new Date().toISOString()): Promise<void> {
    isoValid(at);
    await this.use((db) => {
      db.prepare(
        "UPDATE relay_invocations SET approval_id = ?, updated_at = ? WHERE invocation_id = ? AND mode = 'held'",
      ).run(approvalId, at, invocationId);
    });
  }

  async releaseUnpostedHeldInvocation(invocationId: string): Promise<void> {
    await this.use((db) => {
      db.prepare(
        "DELETE FROM relay_invocations WHERE invocation_id = ? AND mode = 'held' AND approval_id IS NULL AND state = 'active'",
      ).run(invocationId);
    });
  }

  async markHeldInvocationResolved(
    invocationId: string,
    approvalId: string,
    state: Exclude<RelayInvocationState, 'active'>,
    at = new Date().toISOString(),
  ): Promise<void> {
    isoValid(at);
    await this.use((db) => {
      db.prepare(
        `UPDATE relay_invocations
          SET approval_id = COALESCE(approval_id, ?),
              state = CASE WHEN state = 'settled' THEN 'settled' ELSE ? END,
              updated_at = ?
          WHERE invocation_id = ?`,
      ).run(approvalId, state, at, invocationId);
    });
  }

  /** Removes a direct relay_calls record and its invocation claim when pre-send verification aborts before sending. */
  async deleteRelayCall(id: string): Promise<void> {
    const invocationId = invocationIdFromDirectCallId(id);
    await this.use((db) =>
      db
        .transaction(() => {
          db.prepare('DELETE FROM relay_calls WHERE id = ? AND approval_id IS NULL').run(id);
          db.prepare("DELETE FROM relay_invocations WHERE invocation_id = ? AND mode = 'direct'").run(invocationId);
        })
        .immediate(),
    );
  }

  async settleRelayCall(
    id: string,
    outcome: {
      readonly state: Exclude<RelayCallState, 'executing'>;
      readonly outcomeJson?: string | null;
      readonly at?: string;
    },
  ): Promise<void> {
    const at = outcome.at ?? new Date().toISOString();
    isoValid(at);
    await this.use((db) =>
      db
        .transaction(() => {
          const row = db
            .prepare<[string], { app_id: string; approval_id: string | null; grant_generation: number }>(
              'SELECT app_id, approval_id, grant_generation FROM relay_calls WHERE id = ?',
            )
            .get(id);
          let persistedOutcome = outcome.outcomeJson ?? null;
          if (row && row.approval_id === null && persistedOutcome !== null) {
            const grant = this.grantRow(db, row.app_id);
            if (!grant || grant.state !== 'live' || grant.generation !== row.grant_generation) {
              persistedOutcome = null;
            }
          }
          db.prepare('UPDATE relay_calls SET state = ?, outcome_json = ?, updated_at = ? WHERE id = ?').run(
            outcome.state,
            persistedOutcome,
            at,
            id,
          );
          if (row && row.approval_id === null) {
            db.prepare(
              "UPDATE relay_invocations SET state = 'settled', updated_at = ? WHERE invocation_id = ? AND mode = 'direct'",
            ).run(at, invocationIdFromDirectCallId(id));
            db.prepare(
              `UPDATE relay_calls SET outcome_json = NULL
                WHERE app_id = ? AND approval_id IS NULL AND state != 'executing' AND outcome_json IS NOT NULL
                  AND id NOT IN (
                    SELECT id FROM relay_calls
                      WHERE app_id = ? AND approval_id IS NULL AND state != 'executing'
                      ORDER BY updated_at DESC, id DESC LIMIT ?
                  )`,
            ).run(row.app_id, row.app_id, MAX_RECENT_DIRECT_CALLS_PER_APP);
          }
        })
        .immediate(),
    );
  }

  async recentCompletedResults(
    appId: string,
    grantGeneration: number,
    limit = 20,
  ): Promise<readonly RecentRelayResult[]> {
    return this.use((db) =>
      db
        .prepare<[string, number, number], RecentRelayResult>(
          `SELECT id, tool_name AS toolName, outcome_json AS outcomeJson, updated_at AS updatedAt
            FROM relay_calls
            WHERE app_id = ? AND grant_generation = ? AND state = 'completed' AND outcome_json IS NOT NULL
            ORDER BY updated_at DESC
            LIMIT ?`,
        )
        .all(appId, grantGeneration, limit),
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
