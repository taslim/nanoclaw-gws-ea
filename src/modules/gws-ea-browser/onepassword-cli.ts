/**
 * The one 1Password CLI boundary. Each action is a fixed argument list; no caller supplies an argument the CLI
 * parses as a flag. Operator calls authenticate through the operator's own desktop sign-in in exactly the selected
 * account and can never inherit a service-account or Connect credential; service-account calls authenticate with
 * exactly the token in their file. Provider output never reaches a log or a result: every failure is a constant
 * reason, a minted token is captured privately before anything else reads it, and nothing is retried here.
 */
import { lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { errorCode, isErrno } from '../../community-portal/errors.js';
import { assertPrivateDirectory, CONTROL_PLANE_ROOT } from '../../gws-ea/paths.js';
import {
  buildToolEnvironment,
  resolvePersistedExecutable,
  runSanitizedCommandOutcome,
  type SanitizedCommand,
  type SanitizedCommandOutcomeRunner,
} from '../../gws-ea/process.js';
import { registerSecret } from '../../gws-ea/redact.js';
import { removePrivateFile, writeOwnerOnlyFileExclusive } from '../../gws-ea/secrets.js';
import { GwsEaError } from '../../gws-ea/types.js';
import { hasControlCharacters, isRecord } from '../../gws-ea/validation.js';
import {
  isNormalizedAbsolute,
  isOnePasswordId,
  ONEPASSWORD_RUNTIME_GRANT,
  parseText,
  ONEPASSWORD_VAULT_PERMISSIONS,
  readOnePasswordToken,
  type OnePasswordVaultPermission,
} from './onepassword-policy.js';

/** Delegated service-account creation by a vault manager arrived in 2.29.0. */
export const ONEPASSWORD_CLI_MINIMUM_VERSION = '2.29.0';
const MINIMUM_VERSION = ONEPASSWORD_CLI_MINIMUM_VERSION.split('.').map(Number);
const VERSION = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(-[0-9A-Za-z.-]{1,64})?$/u;
const VERSION_TIMEOUT_MS = 15_000;
/** Long enough for the operator to approve the desktop app's prompt. */
const OPERATOR_TIMEOUT_MS = 120_000;
const SERVICE_ACCOUNT_TIMEOUT_MS = 60_000;
const OUTPUT_LIMIT_BYTES = 1024 * 1024;
/** A vault or service account name, which may hold an email address: never empty, never read as a flag. */
const RESOURCE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._@+-]{0,99}$/u;
const MAX_DISPLAY_CHARACTERS = 254;
/** Runner failures that leave a provider call's effect unknown; anything else is this code's own fault. */
const INTERRUPTIONS = new Set(['command_failed', 'command_timeout', 'command_output_limit']);

/** The operator's own desktop sign-in, in exactly this account; never a service-account or Connect credential. */
export interface OperatorIdentity {
  readonly kind: 'operator';
  readonly accountId: string;
}

/** Exactly the service account whose token `tokenFile` holds, in the account `accountId` names. */
export interface ServiceAccountIdentity {
  readonly kind: 'service_account';
  readonly accountId: string;
  readonly tokenFile: string;
}

export type OnePasswordIdentity = OperatorIdentity | ServiceAccountIdentity;

/**
 * A constant reason; no provider text ever accompanies it.
 * - `token_unavailable`: the service account's token file is missing, unsafe or malformed.
 * - `not_signed_in`: the operator is not signed in, or the provider refused the credential.
 * - `wrong_account`: the call authenticated to another account, or as another kind of identity.
 * - `forbidden` / `not_found`: the provider refused the action, or does not know its vault or user.
 * - `rate_limited`: an hourly or account-wide daily request limit is spent; never retried here.
 * - `unexpected_output`: a read succeeded with output this release does not recognize.
 * - `outcome_unknown`: a write may have taken effect; observe before trying again.
 * - `failed`: a read failed for a reason this release does not recognize, or the CLI was gone, so no call ran.
 */
export type OnePasswordFailureReason =
  | 'token_unavailable'
  | 'not_signed_in'
  | 'wrong_account'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'unexpected_output'
  | 'outcome_unknown'
  | 'failed';

export interface OnePasswordFailure {
  readonly status: 'failed';
  readonly reason: OnePasswordFailureReason;
}

export type OnePasswordResult<T extends object = Record<never, never>> =
  | ({ readonly status: 'ok' } & Readonly<T>)
  | OnePasswordFailure;

export type OnePasswordCliOpening =
  | { readonly status: 'ready'; readonly cli: OnePasswordCli }
  | { readonly status: 'failed'; readonly reason: 'cli_missing' | 'cli_untrusted' | 'cli_unavailable' }
  | { readonly status: 'failed'; readonly reason: 'cli_too_old'; readonly version: string };

export interface OnePasswordCliOptions {
  /** `op` on `searchPath`, or the absolute path a host policy recorded. */
  readonly command?: string;
  readonly searchPath?: string;
  /** Checkout roots besides the control plane's own; a trusted CLI never lives in one. */
  readonly checkoutRoots?: readonly string[];
  readonly resolve?: typeof resolvePersistedExecutable;
  readonly runCommand?: SanitizedCommandOutcomeRunner;
  /** Where the tool allowlist draws from; no 1Password variable in it is ever passed on. */
  readonly ambient?: NodeJS.ProcessEnv;
}

/** A person 1Password holds in the account, as a service account reads them. */
export interface OnePasswordUser {
  readonly userId: string;
  readonly email: string;
  /** `MEMBER`, `GUEST` or `SERVICE_ACCOUNT` as 1Password reports it; anything else is `other`. */
  readonly type: 'member' | 'guest' | 'service_account' | 'other';
  /** `ACTIVE`: they accepted their invitation, were confirmed, and are not suspended. */
  readonly active: boolean;
}

export interface OnePasswordAccount {
  readonly accountId: string;
  /** The operator's own user in that account. */
  readonly userId: string;
  readonly url: string;
  readonly email: string;
}

export interface OnePasswordRateLimit {
  readonly scope: 'token' | 'account';
  readonly action: 'read' | 'write' | 'read_write';
  readonly limit: number;
  readonly used: number;
  readonly remaining: number;
}

/** The plan an account is on, which sets the daily request limit every service account in it shares. */
export type OnePasswordAccountType = 'individual' | 'families' | 'teams' | 'business';

/** The CLI's account types, as `op account get` reports them. */
const ACCOUNT_TYPES: ReadonlyMap<string, OnePasswordAccountType> = new Map([
  ['INDIVIDUAL', 'individual'],
  ['FAMILY', 'families'],
  ['TEAM', 'teams'],
  ['BUSINESS', 'business'],
]);

export interface VaultAccessRequest {
  readonly vaultId: string;
  /** The exact provider user: an ID, never an email or name the provider would resolve. */
  readonly userId: string;
  readonly permissions: readonly OnePasswordVaultPermission[];
}

export interface VaultAccessRevocation {
  readonly vaultId: string;
  readonly userId: string;
  /** Omitted, every permission the user holds on the vault is revoked. */
  readonly permissions?: readonly OnePasswordVaultPermission[];
}

export interface ServiceAccountRequest {
  readonly name: string;
  /** Vault creation for the host management account, or one vault's items for an assistant's runtime account. */
  readonly access: { readonly kind: 'create_vaults' } | { readonly kind: 'vault_items'; readonly vaultId: string };
  /** Where the token is captured: an owner-only file in an owner-only directory, and nowhere else. */
  readonly tokenFile: string;
}

/**
 * `recovered`: an earlier attempt's token is already captured; nothing was minted. `outcome_unknown`: a service
 * account may exist whose token was not captured. Its creation record stays, so no retry mints another, until the
 * operator has revoked it on 1Password.com and `discardServiceAccountCreation` clears the record.
 */
export type ServiceAccountCreation =
  | { readonly status: 'created' }
  | { readonly status: 'recovered' }
  | OnePasswordFailure;

interface Invocation {
  readonly executable: string;
  readonly runCommand: SanitizedCommandOutcomeRunner;
  readonly ambient: NodeJS.ProcessEnv;
}

type Ran =
  | { readonly kind: 'exited'; readonly exitCode: number; readonly stdout: string; readonly stderr: string }
  | { readonly kind: 'interrupted' }
  | { readonly kind: 'refused'; readonly failure: OnePasswordFailure };

type Completed = { readonly status: 'ok'; readonly stdout: string } | OnePasswordFailure;

type ProviderRejection = Extract<
  OnePasswordFailureReason,
  'rate_limited' | 'not_signed_in' | 'forbidden' | 'not_found'
>;

/**
 * Refusals the provider made before acting, recognized in its error text. Only the 429 wording is documented; text
 * matching none of these is never a refusal, so a write it ends stays unknown.
 */
const REJECTIONS: ReadonlyArray<readonly [ProviderRejection, RegExp]> = [
  ['rate_limited', /\(429\)|too many requests|maximum number of this type of requests/iu],
  [
    'not_signed_in',
    /\(401\)|\bunauthori[sz]ed\b|not currently signed in|account is not signed in|authorization prompt dismissed|session (?:has )?expired/iu,
  ],
  ['forbidden', /\(403\)|\bforbidden\b|(?:do not|don't|does not|doesn't) have (?:the )?permission|permission denied/iu],
  ['not_found', /\(404\)|\bisn't an? (?:vault|user)\b|\bnot found\b|\bdoes(?: not|n't) exist\b/iu],
];

function failed(reason: OnePasswordFailureReason): OnePasswordFailure {
  return { status: 'failed', reason };
}

function rejection(stderr: string): ProviderRejection | undefined {
  return REJECTIONS.find(([, pattern]) => pattern.test(stderr))?.[0];
}

function invalidRequest(message: string): GwsEaError {
  return new GwsEaError('invalid_onepassword_request', message);
}

function assertId(value: string, label: string): void {
  if (!isOnePasswordId(value)) throw invalidRequest(`${label} must be an exact 1Password ID`);
}

/** A lowercase address that can never be read as a flag; the caller normalizes before asking. */
const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/u;
function assertEmail(email: string): void {
  if (email.length > 254 || email.startsWith('-') || hasControlCharacters(email) || !EMAIL.test(email))
    throw invalidRequest('An email must be one lowercase address');
}

const USER_TYPES: ReadonlyMap<string, OnePasswordUser['type']> = new Map([
  ['MEMBER', 'member'],
  ['GUEST', 'guest'],
  ['SERVICE_ACCOUNT', 'service_account'],
]);

function assertName(name: string): void {
  if (!RESOURCE_NAME.test(name))
    throw invalidRequest('A 1Password name must be letters, digits, spaces, dots, dashes or underscores');
}

function permissionList(permissions: readonly OnePasswordVaultPermission[]): string {
  const known: readonly string[] = ONEPASSWORD_VAULT_PERMISSIONS;
  if (
    !permissions.length ||
    new Set(permissions).size !== permissions.length ||
    !permissions.every((p) => known.includes(p))
  )
    throw invalidRequest('Vault permissions must be distinct documented permissions');
  return permissions.join(',');
}

function isFileSystemError(error: unknown): boolean {
  return /^E[A-Z0-9]+$/u.test(errorCode(error, ''));
}

function cliEnvironment(ambient: NodeJS.ProcessEnv, token: string | undefined): Record<string, string> {
  // The allowlist names no OP_ variable; filtering anyway keeps authentication exactly the identity's.
  const inherited = Object.entries(buildToolEnvironment(ambient, { HOME: os.homedir() })).filter(
    ([key]) => !key.startsWith('OP_'),
  );
  return Object.fromEntries(token === undefined ? inherited : [...inherited, ['OP_SERVICE_ACCOUNT_TOKEN', token]]);
}

function cliCommand(
  invocation: Invocation,
  args: readonly string[],
  token: string | undefined,
  timeoutMs: number,
): SanitizedCommand {
  return {
    command: invocation.executable,
    args,
    cwd: CONTROL_PLANE_ROOT,
    env: cliEnvironment(invocation.ambient, token),
    timeoutMs,
    outputLimitBytes: OUTPUT_LIMIT_BYTES,
    privateOutput: true,
  };
}

async function run(invocation: Invocation, command: SanitizedCommand): Promise<Ran> {
  try {
    const outcome = await invocation.runCommand(command);
    return { kind: 'exited', exitCode: outcome.exitCode, stdout: outcome.stdout, stderr: outcome.stderr };
  } catch (error) {
    if (error instanceof GwsEaError && INTERRUPTIONS.has(error.code)) return { kind: 'interrupted' };
    // The executable left its resolved path before anything was spawned, so the provider never saw the call.
    if (error instanceof GwsEaError && error.code === 'executable_not_found')
      return { kind: 'refused', failure: failed('failed') };
    throw error;
  }
}

function isDisplayText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_DISPLAY_CHARACTERS &&
    !hasControlCharacters(value)
  );
}

function parseAccounts(value: unknown): OnePasswordAccount[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const accounts: OnePasswordAccount[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      !isOnePasswordId(entry.account_uuid) ||
      !isOnePasswordId(entry.user_uuid) ||
      !isDisplayText(entry.url) ||
      !isDisplayText(entry.email)
    )
      return undefined;
    accounts.push({ accountId: entry.account_uuid, userId: entry.user_uuid, url: entry.url, email: entry.email });
  }
  return accounts;
}

const RATE_LIMIT_HEADER = /^TYPE\s+ACTION\s+LIMIT\s+USED\s+REMAINING\s+RESET$/u;
const COUNT = /^\d{1,12}$/u;

/** The documented `op service-account ratelimit` table; its RESET column is not kept. */
function parseRateLimits(stdout: string): OnePasswordRateLimit[] | undefined {
  const [header, ...rows] = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (header === undefined || !RATE_LIMIT_HEADER.test(header) || !rows.length) return undefined;
  const limits: OnePasswordRateLimit[] = [];
  for (const row of rows) {
    const [scope, action, limit, used, remaining, reset] = row.split(/\s+/u);
    if (
      (scope !== 'token' && scope !== 'account') ||
      (action !== 'read' && action !== 'write' && action !== 'read_write') ||
      [limit, used, remaining].some((count) => count === undefined || !COUNT.test(count)) ||
      reset === undefined ||
      limits.some((seen) => seen.scope === scope && seen.action === action)
    )
      return undefined;
    limits.push({ scope, action, limit: Number(limit), used: Number(used), remaining: Number(remaining) });
  }
  return limits;
}

function parseVersion(stdout: string): { readonly text: string; readonly supported: boolean } | undefined {
  const text = stdout.trim();
  const match = VERSION.exec(text);
  if (!match) return undefined;
  const version = [match[1], match[2], match[3]].map(Number);
  const difference = version.map((part, index) => part - MINIMUM_VERSION[index]).find((part) => part !== 0) ?? 0;
  return { text, supported: difference > 0 || (difference === 0 && match[4] === undefined) };
}

/** Where an attempt to mint the token for `tokenFile` is recorded while its outcome is unproven. */
function creationRecord(tokenFile: string): string {
  return `${tokenFile}.pending`;
}

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return false;
    throw error;
  }
}

export function serviceAccountCreationUnproven(tokenFile: string): Promise<boolean> {
  return exists(creationRecord(tokenFile));
}

/** After the operator has revoked an unproven service account on 1Password.com: forget the attempt and its capture. */
export async function discardServiceAccountCreation(tokenFile: string): Promise<void> {
  await removePrivateFile(creationRecord(tokenFile));
  await removePrivateFile(tokenFile);
}

/**
 * Disabling's half of a capture no one verified: the token goes, and its creation stays unproven, so no retry mints
 * over an account that may exist until the operator revokes it on 1Password.com and discards the attempt.
 */
export async function retireCapturedServiceAccount(tokenFile: string, name: string): Promise<void> {
  const record = creationRecord(tokenFile);
  if (!(await exists(record)))
    await writeOwnerOnlyFileExclusive(
      record,
      `${JSON.stringify({ schemaVersion: 1, name, tokenDeletedAt: new Date().toISOString() })}\n`,
    );
  await removePrivateFile(tokenFile);
}

export class OnePasswordCli {
  readonly #invocation: Invocation;
  /** At least `ONEPASSWORD_CLI_MINIMUM_VERSION`. */
  readonly version: string;

  private constructor(invocation: Invocation, version: string) {
    this.#invocation = invocation;
    this.version = version;
  }

  /** The executable as it resolved: what a host policy records. */
  get executable(): string {
    return this.#invocation.executable;
  }

  /** Find a trusted CLI, then prove it is new enough. Nothing authenticates. */
  static async open(options: OnePasswordCliOptions = {}): Promise<OnePasswordCliOpening> {
    let executable: string;
    try {
      executable = await (options.resolve ?? resolvePersistedExecutable)(options.command ?? 'op', {
        ...(options.searchPath === undefined ? {} : { searchPath: options.searchPath }),
        ...(options.checkoutRoots === undefined ? {} : { checkoutRoots: options.checkoutRoots }),
      });
    } catch (error) {
      const code = errorCode(error, '');
      if (code === 'executable_not_found' || code === 'ENOENT') return { status: 'failed', reason: 'cli_missing' };
      if (code === 'untrusted_executable' || code === 'invalid_executable')
        return { status: 'failed', reason: 'cli_untrusted' };
      throw error;
    }
    const invocation: Invocation = {
      executable,
      runCommand: options.runCommand ?? runSanitizedCommandOutcome,
      ambient: options.ambient ?? process.env,
    };
    const ran = await run(invocation, cliCommand(invocation, ['--version'], undefined, VERSION_TIMEOUT_MS));
    const version = ran.kind === 'exited' && ran.exitCode === 0 ? parseVersion(ran.stdout) : undefined;
    if (!version) return { status: 'failed', reason: 'cli_unavailable' };
    if (!version.supported) return { status: 'failed', reason: 'cli_too_old', version: version.text };
    return { status: 'ready', cli: new OnePasswordCli(invocation, version.text) };
  }

  async #invoke(identity: OnePasswordIdentity | undefined, args: readonly string[]): Promise<Ran> {
    if (identity === undefined)
      return run(this.#invocation, cliCommand(this.#invocation, args, undefined, OPERATOR_TIMEOUT_MS));
    assertId(identity.accountId, 'The account');
    if (identity.kind === 'operator') {
      const selected = [...args, '--account', identity.accountId];
      return run(this.#invocation, cliCommand(this.#invocation, selected, undefined, OPERATOR_TIMEOUT_MS));
    }
    const token = await readOnePasswordToken(identity.tokenFile);
    if (token.status !== 'ready') return { kind: 'refused', failure: failed('token_unavailable') };
    return run(this.#invocation, cliCommand(this.#invocation, args, token.token, SERVICE_ACCOUNT_TIMEOUT_MS));
  }

  /** A failed read is `failed` unless the provider recognizably refused it. */
  async #read(identity: OnePasswordIdentity | undefined, args: readonly string[]): Promise<Completed> {
    const ran = await this.#invoke(identity, args);
    switch (ran.kind) {
      case 'refused':
        return ran.failure;
      case 'interrupted':
        return failed('failed');
      case 'exited':
        return ran.exitCode === 0 ? { status: 'ok', stdout: ran.stdout } : failed(rejection(ran.stderr) ?? 'failed');
    }
  }

  /** A failed write may have taken effect unless the provider recognizably refused it. */
  async #write(identity: OnePasswordIdentity, args: readonly string[]): Promise<Completed> {
    const ran = await this.#invoke(identity, args);
    switch (ran.kind) {
      case 'refused':
        return ran.failure;
      case 'interrupted':
        return failed('outcome_unknown');
      case 'exited':
        return ran.exitCode === 0
          ? { status: 'ok', stdout: ran.stdout }
          : failed(rejection(ran.stderr) ?? 'outcome_unknown');
    }
  }

  /** The accounts the operator's desktop app holds, for selecting one by its exact ID. */
  async listAccounts(): Promise<OnePasswordResult<{ readonly accounts: readonly OnePasswordAccount[] }>> {
    const result = await this.#read(undefined, ['account', 'list', '--format', 'json']);
    if (result.status !== 'ok') return result;
    const accounts = parseAccounts(parseText(result.stdout));
    return accounts ? { status: 'ok', accounts } : failed('unexpected_output');
  }

  /** Who `identity` authenticates as: exactly its account, and the kind of identity it claims to be. */
  async whoami(
    identity: OnePasswordIdentity,
  ): Promise<OnePasswordResult<{ readonly accountId: string; readonly userId: string }>> {
    const result = await this.#read(identity, ['whoami', '--format', 'json']);
    if (result.status !== 'ok') return result;
    const value = parseText(result.stdout);
    if (
      !isRecord(value) ||
      !isOnePasswordId(value.account_uuid) ||
      !isOnePasswordId(value.user_uuid) ||
      (value.user_type !== undefined && typeof value.user_type !== 'string')
    )
      return failed('unexpected_output');
    const serviceAccount =
      typeof value.user_type === 'string' ? value.user_type.toUpperCase() === 'SERVICE_ACCOUNT' : undefined;
    if (
      value.account_uuid !== identity.accountId ||
      (serviceAccount !== undefined && serviceAccount !== (identity.kind === 'service_account'))
    )
      return failed('wrong_account');
    return { status: 'ok', accountId: value.account_uuid, userId: value.user_uuid };
  }

  /** A new vault named exactly `name`; success only names the vault the provider reports it created. */
  async createVault(
    identity: OnePasswordIdentity,
    name: string,
  ): Promise<OnePasswordResult<{ readonly vaultId: string }>> {
    assertName(name);
    const result = await this.#write(identity, ['vault', 'create', name, '--format', 'json']);
    if (result.status !== 'ok') return result;
    const value = parseText(result.stdout);
    return isRecord(value) && value.name === name && isOnePasswordId(value.id)
      ? { status: 'ok', vaultId: value.id }
      : failed('outcome_unknown');
  }

  async grantVaultAccess(identity: OnePasswordIdentity, request: VaultAccessRequest): Promise<OnePasswordResult> {
    assertId(request.vaultId, 'The vault');
    assertId(request.userId, 'The user');
    const permissions = permissionList(request.permissions);
    // Scripted grants need --no-input and every dependent permission listed.
    const args = [
      'vault',
      'user',
      'grant',
      '--no-input',
      '--vault',
      request.vaultId,
      '--user',
      request.userId,
      '--permissions',
      permissions,
    ];
    const result = await this.#write(identity, args);
    return result.status === 'ok' ? { status: 'ok' } : result;
  }

  async revokeVaultAccess(identity: OnePasswordIdentity, request: VaultAccessRevocation): Promise<OnePasswordResult> {
    assertId(request.vaultId, 'The vault');
    assertId(request.userId, 'The user');
    const permissions = request.permissions === undefined ? [] : ['--permissions', permissionList(request.permissions)];
    const result = await this.#write(identity, [
      'vault',
      'user',
      'revoke',
      '--no-input',
      '--vault',
      request.vaultId,
      '--user',
      request.userId,
      ...permissions,
    ]);
    return result.status === 'ok' ? { status: 'ok' } : result;
  }

  /** A service account may delete only a vault it created; the provider enforces it. */
  async deleteVault(identity: OnePasswordIdentity, vaultId: string): Promise<OnePasswordResult> {
    assertId(vaultId, 'The vault');
    const result = await this.#write(identity, ['vault', 'delete', vaultId]);
    return result.status === 'ok' ? { status: 'ok' } : result;
  }

  /**
   * Whether `identity` can read exactly this vault: success names the vault the provider returned, its name, and
   * the item count it reports; each is null when it reports none, so an unknown count is never an empty vault.
   */
  async getVault(
    identity: OnePasswordIdentity,
    vaultId: string,
  ): Promise<
    OnePasswordResult<{ readonly vaultId: string; readonly name: string | null; readonly itemCount: number | null }>
  > {
    assertId(vaultId, 'The vault');
    const result = await this.#read(identity, ['vault', 'get', vaultId, '--format', 'json']);
    if (result.status !== 'ok') return result;
    const value = parseText(result.stdout);
    if (!isRecord(value) || value.id !== vaultId) return failed('unexpected_output');
    const { items, name } = value;
    return {
      status: 'ok',
      vaultId,
      name: isDisplayText(name) ? name : null,
      itemCount: typeof items === 'number' && Number.isSafeInteger(items) && items >= 0 ? items : null,
    };
  }

  /** The user 1Password holds under exactly this email; matching it to a request is the caller's. */
  async getUser(
    identity: OnePasswordIdentity,
    email: string,
  ): Promise<OnePasswordResult<{ readonly user: OnePasswordUser }>> {
    assertEmail(email);
    const result = await this.#read(identity, ['user', 'get', email, '--format', 'json']);
    if (result.status !== 'ok') return result;
    const value = parseText(result.stdout);
    if (
      !isRecord(value) ||
      !isOnePasswordId(value.id) ||
      !isDisplayText(value.email) ||
      typeof value.type !== 'string' ||
      typeof value.state !== 'string'
    )
      return failed('unexpected_output');
    return {
      status: 'ok',
      user: {
        userId: value.id,
        email: value.email,
        type: USER_TYPES.get(value.type.toUpperCase()) ?? 'other',
        active: value.state.toUpperCase() === 'ACTIVE',
      },
    };
  }

  /** The users with direct access to the vault. */
  async listVaultUsers(
    identity: OnePasswordIdentity,
    vaultId: string,
  ): Promise<OnePasswordResult<{ readonly userIds: readonly string[] }>> {
    assertId(vaultId, 'The vault');
    const result = await this.#read(identity, ['user', 'list', '--vault', vaultId, '--format', 'json']);
    if (result.status !== 'ok') return result;
    const value = parseText(result.stdout);
    if (!Array.isArray(value)) return failed('unexpected_output');
    const userIds: string[] = [];
    for (const entry of value) {
      if (!isRecord(entry) || !isOnePasswordId(entry.id)) return failed('unexpected_output');
      userIds.push(entry.id);
    }
    return { status: 'ok', userIds };
  }

  async accountType(
    identity: OnePasswordIdentity,
  ): Promise<OnePasswordResult<{ readonly accountType: OnePasswordAccountType }>> {
    const result = await this.#read(identity, ['account', 'get', '--format', 'json']);
    if (result.status !== 'ok') return result;
    const value = parseText(result.stdout);
    if (!isRecord(value) || value.id !== identity.accountId) return failed('unexpected_output');
    const accountType = typeof value.type === 'string' ? ACCOUNT_TYPES.get(value.type.toUpperCase()) : undefined;
    return accountType ? { status: 'ok', accountType } : failed('unexpected_output');
  }

  /** The service account's hourly usage and its account's shared daily usage. */
  async rateLimits(
    identity: ServiceAccountIdentity,
  ): Promise<OnePasswordResult<{ readonly limits: readonly OnePasswordRateLimit[] }>> {
    const result = await this.#read(identity, ['service-account', 'ratelimit']);
    if (result.status !== 'ok') return result;
    const limits = parseRateLimits(result.stdout);
    return limits ? { status: 'ok', limits } : failed('unexpected_output');
  }

  /**
   * Mint a service account as the operator: a service account cannot. The output is registered for redaction and
   * written to `tokenFile` before it is parsed, so a token the provider printed is never lost to a parsing failure
   * and never re-minted: while an attempt's outcome is unproven, its creation record makes every retry
   * `outcome_unknown`.
   */
  async createServiceAccount(
    operator: OperatorIdentity,
    request: ServiceAccountRequest,
  ): Promise<ServiceAccountCreation> {
    // Every refusal of the request comes before its creation record exists.
    assertId(operator.accountId, 'The account');
    assertName(request.name);
    if (!isNormalizedAbsolute(request.tokenFile))
      throw invalidRequest('The token file must be a normalized absolute path');
    if (request.access.kind === 'vault_items') assertId(request.access.vaultId, 'The vault');
    const access =
      request.access.kind === 'create_vaults'
        ? ['--can-create-vaults']
        : ['--vault', `${request.access.vaultId}:${ONEPASSWORD_RUNTIME_GRANT.join(',')}`];
    await assertPrivateDirectory(path.dirname(request.tokenFile));
    const record = creationRecord(request.tokenFile);
    const captured = await readOnePasswordToken(request.tokenFile);
    if (captured.status === 'ready') {
      await removePrivateFile(record);
      return { status: 'recovered' };
    }
    if (captured.status === 'invalid' || (await exists(record))) return failed('outcome_unknown');

    try {
      await writeOwnerOnlyFileExclusive(
        record,
        `${JSON.stringify({ schemaVersion: 1, name: request.name, accountId: operator.accountId, startedAt: new Date().toISOString() })}\n`,
      );
    } catch (error) {
      // Another attempt holds the record.
      if (isErrno(error, 'EEXIST')) return failed('outcome_unknown');
      throw error;
    }
    const ran = await this.#invoke(operator, ['service-account', 'create', request.name, ...access, '--raw']);
    if (ran.kind === 'interrupted') return failed('outcome_unknown');
    if (ran.kind === 'refused' || ran.exitCode !== 0) {
      const refused = ran.kind === 'refused' ? ran.failure.reason : rejection(ran.stderr);
      if (refused === undefined) return failed('outcome_unknown');
      // Refused before anything was created: a retry may mint.
      await removePrivateFile(record);
      return failed(refused);
    }
    registerSecret(ran.stdout);
    try {
      await writeOwnerOnlyFileExclusive(request.tokenFile, ran.stdout);
    } catch (error) {
      if (isFileSystemError(error)) return failed('outcome_unknown');
      throw error;
    }
    if ((await readOnePasswordToken(request.tokenFile)).status !== 'ready') return failed('outcome_unknown');
    await removePrivateFile(record);
    return { status: 'created' };
  }
}
