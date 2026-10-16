/**
 * The private 1Password contracts (KTD2): one host policy beside the host
 * management token, under the control plane's configuration root, and per
 * assistant a runtime token in its secrets plus an owner-only record of the
 * provider resources it owns. Identifiers only ever leave these files; a
 * token is registered for redaction before anything reads it. Malformed or
 * unsafe state fails closed.
 */
import path from 'node:path';

import { errorCode, isErrno } from '../../community-portal/errors.js';
import { assertPrivateDirectory, instanceRootName, preparePrivateDirectory } from '../../gws-ea/paths.js';
import { registerSecret } from '../../gws-ea/redact.js';
import { readOwnerOnlyFile, writePrivateTextFile } from '../../gws-ea/secrets.js';
import { GwsEaError } from '../../gws-ea/types.js';
import { hasControlCharacters, INSTANCE_ID_PATTERN, isRecord } from '../../gws-ea/validation.js';
import type { ServiceAccountIdentity } from './onepassword-cli.js';

/** 1Password's identifiers for accounts, users, service accounts and vaults. */
const ONEPASSWORD_ID = /^[A-Za-z0-9]{26}$/u;
/** One service account token on one line; never a shell word, a JSON document or a prompt. */
const SERVICE_ACCOUNT_TOKEN = /^[A-Za-z0-9_\-.+/=]{20,16384}$/u;
const MAX_CLI_PATH_CHARACTERS = 4096;

/** The host-process locator of the host policy, bound like the voice policy's; it names a file, never a value. */
export const ONEPASSWORD_POLICY_FILE_ENV = 'GWS_EA_ONEPASSWORD_POLICY_FILE';

const HOST_DIRECTORY = 'onepassword';
const POLICY_FILE = 'policy.json';
const MANAGEMENT_TOKEN_FILE = 'management-token';
const RESOURCE_FILE = 'onepassword.json';
/** The runtime token's file in the instance's secrets, where the browser vault reads it. */
const RUNTIME_TOKEN_FILE = path.join('secrets', 'browser-1password');

export function isOnePasswordId(value: unknown): value is string {
  return typeof value === 'string' && ONEPASSWORD_ID.test(value);
}

/** Why a private file was refused; never its contents. */
export type OnePasswordStateProblem = 'unsafe' | 'malformed' | 'wrong_instance' | 'wrong_account';

export interface OnePasswordHostPaths {
  readonly directory: string;
  readonly policyFile: string;
  /** The host management service account's token: shared operator authority, never an assistant's grant. */
  readonly managementTokenFile: string;
}

export interface OnePasswordHostPolicy {
  readonly schemaVersion: 1;
  /** The one account every assistant on this host uses, by its exact ID: never a shorthand, URL or name. */
  readonly accountId: string;
  /** The `op` the operator enabled, re-checked before each use: assistant services run with a PATH that may not reach it. */
  readonly cliPath: string;
  /** The host management service account; null when the operator's CLI creates each vault itself (KTD1's fallback). */
  readonly managementServiceAccountId: string | null;
}

export type OnePasswordHostPolicyRead =
  | { readonly status: 'absent' }
  | { readonly status: 'ready'; readonly policy: OnePasswordHostPolicy; readonly paths: OnePasswordHostPaths }
  | { readonly status: 'invalid'; readonly problem: 'unsafe' | 'malformed' };

export interface OnePasswordInstancePaths {
  /** The runtime service account's token, in the instance's private secrets directory. */
  readonly runtimeTokenFile: string;
  /**
   * The record of the provider resources the assistant owns. It holds
   * identifiers, never values, so it sits outside `secrets/`, whose every
   * file a run log registers for redaction.
   */
  readonly resourceFile: string;
}

/** Who created the vault, and so who may delete it: a service account deletes only the vaults it created. */
export type OnePasswordVaultCreator =
  | { readonly kind: 'management_service_account'; readonly serviceAccountId: string }
  | { readonly kind: 'operator' };

export interface OnePasswordResources {
  readonly schemaVersion: 1;
  /** The assistant these resources belong to; immutable, and matching the record's location. */
  readonly instanceId: string;
  readonly accountId: string;
  /** Only a vault the app created is ever recorded: no vault is adopted. */
  readonly vault: { readonly id: string; readonly createdBy: OnePasswordVaultCreator };
  /** Null while the vault exists and its runtime service account is not minted yet. */
  readonly runtimeServiceAccountId: string | null;
}

export type OnePasswordResourcesRead =
  | { readonly status: 'absent' }
  | { readonly status: 'ready'; readonly resources: OnePasswordResources }
  | { readonly status: 'invalid'; readonly problem: OnePasswordStateProblem };

export type OnePasswordTokenRead =
  | { readonly status: 'absent' }
  | { readonly status: 'ready'; readonly token: string }
  | { readonly status: 'invalid' };

function hostPathsIn(directory: string): OnePasswordHostPaths {
  return {
    directory,
    policyFile: path.join(directory, POLICY_FILE),
    managementTokenFile: path.join(directory, MANAGEMENT_TOKEN_FILE),
  };
}

export function onePasswordHostPaths(configRoot: string): OnePasswordHostPaths {
  return hostPathsIn(path.join(configRoot, HOST_DIRECTORY));
}

export function onePasswordInstancePaths(instanceRoot: string): OnePasswordInstancePaths {
  return {
    runtimeTokenFile: path.join(instanceRoot, RUNTIME_TOKEN_FILE),
    resourceFile: path.join(instanceRoot, RESOURCE_FILE),
  };
}

/** The management identity a policy configures: exactly its token file, in exactly its account. */
export function onePasswordManagementIdentity(
  policy: OnePasswordHostPolicy,
  paths: OnePasswordHostPaths,
): ServiceAccountIdentity | null {
  return policy.managementServiceAccountId === null
    ? null
    : { kind: 'service_account', accountId: policy.accountId, tokenFile: paths.managementTokenFile };
}

function isNormalizedAbsolute(file: string): boolean {
  return path.isAbsolute(file) && path.normalize(file) === file && !file.includes('\0');
}

/** The host paths a policy file names, when it sits exactly where `onePasswordHostPaths` puts one. */
function hostPathsFor(policyFile: string): OnePasswordHostPaths | undefined {
  if (!isNormalizedAbsolute(policyFile) || path.basename(policyFile) !== POLICY_FILE) return undefined;
  const directory = path.dirname(policyFile);
  return path.basename(directory) === HOST_DIRECTORY ? hostPathsIn(directory) : undefined;
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(record);
  return present.length === keys.length && keys.every((key) => present.includes(key));
}

function parseHostPolicy(value: unknown): OnePasswordHostPolicy | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ['schemaVersion', 'accountId', 'cliPath', 'managementServiceAccountId']))
    return undefined;
  const { schemaVersion, accountId, cliPath, managementServiceAccountId } = value;
  if (
    schemaVersion !== 1 ||
    !isOnePasswordId(accountId) ||
    typeof cliPath !== 'string' ||
    cliPath.length > MAX_CLI_PATH_CHARACTERS ||
    !isNormalizedAbsolute(cliPath) ||
    hasControlCharacters(cliPath) ||
    (managementServiceAccountId !== null && !isOnePasswordId(managementServiceAccountId))
  )
    return undefined;
  return { schemaVersion, accountId, cliPath, managementServiceAccountId };
}

function parseVaultCreator(value: unknown): OnePasswordVaultCreator | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind === 'operator' && hasExactKeys(value, ['kind'])) return { kind: 'operator' };
  if (
    value.kind === 'management_service_account' &&
    hasExactKeys(value, ['kind', 'serviceAccountId']) &&
    isOnePasswordId(value.serviceAccountId)
  )
    return { kind: 'management_service_account', serviceAccountId: value.serviceAccountId };
  return undefined;
}

function parseResources(value: unknown): OnePasswordResources | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['schemaVersion', 'instanceId', 'accountId', 'vault', 'runtimeServiceAccountId'])
  )
    return undefined;
  const { schemaVersion, instanceId, accountId, vault, runtimeServiceAccountId } = value;
  if (
    schemaVersion !== 1 ||
    typeof instanceId !== 'string' ||
    !INSTANCE_ID_PATTERN.test(instanceId) ||
    !isOnePasswordId(accountId) ||
    !isRecord(vault) ||
    !hasExactKeys(vault, ['id', 'createdBy']) ||
    !isOnePasswordId(vault.id) ||
    (runtimeServiceAccountId !== null && !isOnePasswordId(runtimeServiceAccountId))
  )
    return undefined;
  const createdBy = parseVaultCreator(vault.createdBy);
  if (!createdBy) return undefined;
  return { schemaVersion, instanceId, accountId, vault: { id: vault.id, createdBy }, runtimeServiceAccountId };
}

/**
 * An owner-only file in an owner-only directory, or why it cannot be read: a
 * missing file is absent; a refusal of the owner-only checks or by the file
 * system is unsafe state.
 */
async function readPrivateState(file: string): Promise<{ readonly text: string } | 'absent' | 'unsafe'> {
  try {
    await assertPrivateDirectory(path.dirname(file));
    return { text: await readOwnerOnlyFile(file) };
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return 'absent';
    if (error instanceof GwsEaError || /^E[A-Z0-9]+$/u.test(errorCode(error, ''))) return 'unsafe';
    throw error;
  }
}

function parseText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

/** Re-read for every use. Absent means 1Password was never enabled on this host. */
export async function readOnePasswordHostPolicy(policyFile: string): Promise<OnePasswordHostPolicyRead> {
  const paths = hostPathsFor(policyFile);
  if (!paths) return { status: 'invalid', problem: 'unsafe' };
  const state = await readPrivateState(policyFile);
  if (state === 'absent') return { status: 'absent' };
  if (state === 'unsafe') return { status: 'invalid', problem: 'unsafe' };
  const policy = parseHostPolicy(parseText(state.text));
  return policy ? { status: 'ready', policy, paths } : { status: 'invalid', problem: 'malformed' };
}

export async function writeOnePasswordHostPolicy(policyFile: string, policy: OnePasswordHostPolicy): Promise<void> {
  const paths = hostPathsFor(policyFile);
  if (!paths)
    throw new GwsEaError(
      'unsafe_path',
      `The 1Password host policy must be ${HOST_DIRECTORY}/${POLICY_FILE}: ${policyFile}`,
    );
  const valid = parseHostPolicy(policy);
  if (!valid) throw new GwsEaError('invalid_onepassword_policy', 'The 1Password host policy is invalid');
  await preparePrivateDirectory(paths.directory);
  await writePrivateTextFile(paths.policyFile, `${JSON.stringify(valid, null, 2)}\n`);
}

function resourceLocationMatches(file: string, instanceId: string): boolean {
  return (
    isNormalizedAbsolute(file) &&
    path.basename(file) === RESOURCE_FILE &&
    path.basename(path.dirname(file)) === instanceRootName(instanceId)
  );
}

/** The resources of exactly `expected.instanceId`, and of `expected.accountId` when the caller holds the host policy. */
export async function readOnePasswordResources(
  file: string,
  expected: { readonly instanceId: string; readonly accountId?: string },
): Promise<OnePasswordResourcesRead> {
  if (!INSTANCE_ID_PATTERN.test(expected.instanceId))
    throw new GwsEaError('invalid_instance_id', 'Instance ID is invalid');
  if (!isNormalizedAbsolute(file) || path.basename(file) !== RESOURCE_FILE)
    return { status: 'invalid', problem: 'unsafe' };
  if (!resourceLocationMatches(file, expected.instanceId)) return { status: 'invalid', problem: 'wrong_instance' };
  const state = await readPrivateState(file);
  if (state === 'absent') return { status: 'absent' };
  if (state === 'unsafe') return { status: 'invalid', problem: 'unsafe' };
  const resources = parseResources(parseText(state.text));
  if (!resources) return { status: 'invalid', problem: 'malformed' };
  if (resources.instanceId !== expected.instanceId) return { status: 'invalid', problem: 'wrong_instance' };
  if (expected.accountId !== undefined && resources.accountId !== expected.accountId)
    return { status: 'invalid', problem: 'wrong_account' };
  return { status: 'ready', resources };
}

/** Written into the existing private instance root of the assistant the record names. */
export async function writeOnePasswordResources(file: string, resources: OnePasswordResources): Promise<void> {
  const valid = parseResources(resources);
  if (!valid) throw new GwsEaError('invalid_onepassword_resources', 'The 1Password resource record is invalid');
  if (!resourceLocationMatches(file, valid.instanceId))
    throw new GwsEaError('unsafe_path', `The 1Password resource record must be in its own instance root: ${file}`);
  await assertPrivateDirectory(path.dirname(file));
  await writePrivateTextFile(file, `${JSON.stringify(valid, null, 2)}\n`);
}

/**
 * A service account token file: one token, owner-only, in an owner-only
 * directory. The token is registered for redaction before it is returned;
 * an unsafe or malformed file is invalid, never repaired.
 */
export async function readOnePasswordToken(file: string): Promise<OnePasswordTokenRead> {
  if (!isNormalizedAbsolute(file)) return { status: 'invalid' };
  const state = await readPrivateState(file);
  if (state === 'absent') return { status: 'absent' };
  if (state === 'unsafe') return { status: 'invalid' };
  const token = state.text.trim();
  if (!SERVICE_ACCOUNT_TOKEN.test(token)) return { status: 'invalid' };
  registerSecret(token);
  return { status: 'ready', token };
}
