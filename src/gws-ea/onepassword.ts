/**
 * Operator-led 1Password provisioning. The operator's own desktop sign-in
 * selects one account and mints a host management service account that may
 * only create vaults. Per compatible assistant, that account creates one vault
 * and grants the operator management rights on it, so the operator can mint
 * the assistant's runtime service account with read and write access to only
 * that vault. Enable and operator-led create/resume run the same
 * reconciliation under the assistant's native instance lock: intent is
 * persisted before each provider creation, completion is recorded only after
 * verification, and recovery follows recorded IDs, never display names. A
 * creation whose outcome is unknown pauses for the operator rather than
 * creating again. Tokens stay in their owner-only files; results carry IDs.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { isErrno } from '../community-portal/errors.js';
import { processLock } from '../community-portal/process-lock.js';
import {
  discardServiceAccountCreation,
  OnePasswordCli,
  serviceAccountCreationUnproven,
  type OnePasswordAccount,
  type OnePasswordAccountType,
  type OnePasswordCliOptions,
  type OnePasswordFailureReason,
  type OnePasswordResult,
  type OperatorIdentity,
  type ServiceAccountIdentity,
} from '../modules/gws-ea-browser/onepassword-cli.js';
import {
  isOnePasswordId,
  ONEPASSWORD_RUNTIME_GRANT,
  onePasswordHostPaths,
  onePasswordInstancePaths,
  onePasswordSignInAddress,
  readOnePasswordHostPolicy,
  readOnePasswordResources,
  readOnePasswordToken,
  writeOnePasswordHostPolicy,
  writeOnePasswordResources,
  type OnePasswordHostPaths,
  type OnePasswordHostPolicy,
  type OnePasswordInstancePaths,
  type OnePasswordResources,
  type OnePasswordVaultPermission,
} from '../modules/gws-ea-browser/onepassword-policy.js';
import { formatLocalTime } from '../timezone.js';
import { withAssistantLock } from './assistant-lock.js';
import type { InstanceOperation } from './journal.js';
import { preparePrivateDirectory, type ControlPlanePaths } from './paths.js';
import { exists } from './release-layout.js';
import { getInstanceReservation, readRegistry } from './registry.js';
import type { Changed, NextAction } from './result.js';
import { removePrivateFile, writeOwnerOnlyFileExclusive } from './secrets.js';
import {
  bindInstanceHostPolicies,
  loadInstanceRuntimeConfig,
  type InstanceRuntimeConfig,
  type UpsertEnvVars,
} from './service.js';
import { GwsEaError } from './types.js';
import { INSTANCE_ID_PATTERN, isRecord } from './validation.js';

export const ONEPASSWORD_CAPABILITY = {
  name: 'onepassword',
  actions: ['install', 'uninstall', 'show', 'check'],
  scope: 'host',
  summary: 'Give each compatible assistant its own 1Password vault for the logins it fills and saves.',
  prerequisites: [
    'The 1Password CLI (op) 2.29 or later, installed in an operator-owned location on the operator PATH (for example brew install 1password-cli).',
    'The 1Password desktop app on this host, signed in to the account assistants use, with Settings > Developer > Integrate with 1Password CLI turned on.',
    'An operator allowed to create service accounts in that account (an owner or administrator).',
  ],
  readiness_limits: [
    'show reads local records only; check makes service-account requests, which count against the account limit.',
    'Readiness proves authentication and vault reads; a recorded write grant is not a tested write.',
    'Every service account in the account shares one daily request limit, including those of other hosts.',
  ],
} as const;

/** The marker a release carries when it supports this policy and resource contract. */
export const ONEPASSWORD_CONTRACT = 'gws-ea-onepassword-vault-1';
const CONTRACT_FILE = 'src/gws-ea/onepassword-compatibility.json';
/**
 * What the management service account grants the operator on each vault it
 * creates: enough to mint its runtime account. Managing requires editing and
 * viewing, and a scripted grant must list every dependency.
 */
const OPERATOR_GRANT: readonly OnePasswordVaultPermission[] = ['allow_viewing', 'allow_editing', 'allow_managing'];
const MANAGEMENT_NAME = 'GWS-EA management';
/** An email address a provider name can hold whole. */
const NAMEABLE_EMAIL = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,79}$/u;
/** The `discardUnproven` value that names the host management service account. */
export const MANAGEMENT_TARGET = 'management';

export type OnePasswordReleaseCompatibility = 'compatible' | 'unsupported' | 'unknown';

/** A missing marker is a release without the contract, not a broken one. */
export async function onePasswordReleaseCompatibility(checkout: string): Promise<OnePasswordReleaseCompatibility> {
  try {
    const item: unknown = JSON.parse(await readFile(path.join(checkout, CONTRACT_FILE), 'utf8'));
    if (
      !isRecord(item) ||
      typeof item.schemaVersion !== 'number' ||
      !Number.isSafeInteger(item.schemaVersion) ||
      item.schemaVersion < 1 ||
      typeof item.contract !== 'string' ||
      !item.contract.trim()
    )
      return 'unknown';
    return item.schemaVersion === 1 && item.contract === ONEPASSWORD_CONTRACT ? 'compatible' : 'unsupported';
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) return 'unsupported';
    if (error instanceof SyntaxError) return 'unknown';
    throw error;
  }
}

/** Why an assistant's provisioning waits; each names its own recovery. */
export const ONEPASSWORD_PENDING_REASONS = [
  'instance_busy',
  'onepassword_busy',
  'operator_sign_in_needed',
  'cli_unavailable',
  'policy_invalid',
  'sign_in_required',
  'management_unavailable',
  'rate_limited',
  'forbidden',
  'wrong_account',
  'not_found',
  'provider_failed',
  'vault_creation_unproven',
  'service_account_creation_unproven',
  'runtime_unverified',
  'runtime_token_unavailable',
  'resources_invalid',
  'vault_not_owned',
] as const;
export type OnePasswordPendingReason = (typeof ONEPASSWORD_PENDING_REASONS)[number];
/** Why an assistant is left as it is. */
export const ONEPASSWORD_SKIP_REASONS = [
  'release_unsupported',
  'release_unknown',
  'not_created',
  'removal_in_progress',
] as const;
export type OnePasswordSkipReason = (typeof ONEPASSWORD_SKIP_REASONS)[number];

export interface OnePasswordAssistantProvisioning {
  readonly instance_id: string;
  readonly outcome: 'ready' | 'pending' | 'skipped';
  readonly reason: OnePasswordPendingReason | OnePasswordSkipReason | null;
  readonly message: string | null;
  readonly changed: Changed;
  readonly vault_id: string | null;
  readonly runtime_service_account_id: string | null;
  /** Earlier runtime service accounts whose tokens a disable deleted: only the operator can revoke them. */
  readonly retired_service_account_ids: readonly string[];
}

export interface OnePasswordInstallData {
  readonly name: 'onepassword';
  readonly scope: 'host';
  readonly enabled: true;
  readonly account_id: string;
  readonly management_service_account_id: string;
  readonly assistants: readonly OnePasswordAssistantProvisioning[];
  readonly future_compatible_assistants: true;
}

export interface OnePasswordInstallRequest {
  /** The exact account to use; only needed before the host has one. */
  readonly accountId?: string;
  /**
   * After the operator removed what an interrupted creation may have left in
   * 1Password: forget that attempt, for an assistant by ID or the host's
   * management service account (`management`).
   */
  readonly discardUnproven?: string;
}

/** The CLI seams; the command is the operator's `op` on enable and the recorded one afterwards. */
export type OnePasswordCliSeams = Omit<OnePasswordCliOptions, 'command'>;

export interface OnePasswordDependencies {
  readonly cli?: OnePasswordCliSeams;
  /** The launcher's native `.env` writer, which binds each assistant host's policy locator. */
  readonly upsertEnvVars?: UpsertEnvVars;
  /** A terminal's choice among the operator's accounts; absent, the account must be named. */
  readonly chooseAccount?: (accounts: readonly OnePasswordAccount[]) => Promise<string | undefined>;
  readonly recordEffect?: (changed: true | null) => void;
  readonly progress?: (line: string) => void;
  /** True only when the operator's terminal can handle desktop approval. */
  readonly operatorTerminal?: boolean;
  /** Shared by a bulk operation so a rate limit prevents later provider work. */
  readonly rateLimitState?: { limited: boolean };
}

function invalidArguments(message: string): GwsEaError {
  return new GwsEaError('invalid_arguments', message);
}

async function mintsFresh(tokenFile: string): Promise<boolean> {
  return (
    (await readOnePasswordToken(tokenFile)).status !== 'ready' && !(await serviceAccountCreationUnproven(tokenFile))
  );
}

/** An attempt left a creation record or a token here; it is unproven only while no ID is recorded for it. */
export async function creationAttempted(tokenFile: string): Promise<boolean> {
  return (
    (await serviceAccountCreationUnproven(tokenFile)) || (await readOnePasswordToken(tokenFile)).status !== 'absent'
  );
}

/** Where an assistant's vault creation is recorded while the provider has not answered with its ID. */
export function vaultCreationRecord(files: OnePasswordInstancePaths): string {
  return `${files.resourceFile}.pending`;
}

interface ResourceNames {
  /** The vault's stable name in the operator's account. */
  readonly vault: string;
  /** What the operator sees among the account's service accounts. */
  readonly runtimeServiceAccount: string;
}

/** Names from the assistant's own address, which never changes; a rename never touches them. */
export function resourceNames(workspaceEmail: string, instanceId: string): ResourceNames {
  const short = instanceId.slice(0, 8);
  const label = NAMEABLE_EMAIL.test(workspaceEmail) ? workspaceEmail : short;
  return { vault: `Assistant ${label}`, runtimeServiceAccount: `GWS-EA ${short} ${label}` };
}

class Effects {
  changed: Changed = false;
  readonly #record: ((changed: true | null) => void) | undefined;

  constructor(record: ((changed: true | null) => void) | undefined) {
    this.#record = record;
  }

  /** A write is about to start; until it completes its effect is unknown. */
  starting(): void {
    if (this.changed === false) this.changed = null;
    this.#record?.(null);
  }

  done(): void {
    this.changed = true;
    this.#record?.(true);
  }
}

function pendingMessage(
  reason: OnePasswordPendingReason,
  facts: { readonly names?: ResourceNames; readonly serviceAccountId?: string | null; readonly file?: string },
): string {
  switch (reason) {
    case 'onepassword_busy':
      return 'Another 1Password operation holds the host; retry once it finishes.';
    case 'operator_sign_in_needed':
      return 'Run gws-ea connectors install onepassword from an operator terminal to finish the vault, approving the 1Password app when it asks.';
    case 'instance_busy':
      return 'Another operation holds this assistant; retry once it finishes.';
    case 'cli_unavailable':
      return 'The 1Password CLI this host recorded is missing or too old. Install a current one, then run gws-ea connectors install onepassword to record it.';
    case 'policy_invalid':
      return `The 1Password host policy cannot be used safely${facts.file ? ` (${facts.file})` : ''}. Inspect it before retrying.`;
    case 'sign_in_required':
      return "Unlock the 1Password app, signed in to this host's account with Settings > Developer > Integrate with 1Password CLI turned on, approve gws-ea's request when it appears, then retry.";
    case 'management_unavailable':
      return "1Password refused the host management service account, or its token is missing. Inspect it on 1Password.com and in this host's configuration before retrying.";
    case 'rate_limited':
      return "1Password's request limit for this account is spent for now; nothing was retried. Retry later.";
    case 'forbidden':
      return '1Password refused the request. The operator must be an owner or administrator allowed to create service accounts, with management rights on this vault.';
    case 'wrong_account':
      return "1Password answered for another account or kind of identity than this host's.";
    case 'not_found':
      return '1Password no longer knows a recorded vault or user. Inspect the account before retrying.';
    case 'provider_failed':
      return '1Password did not complete the request. Retry.';
    case 'vault_creation_unproven':
      return `1Password may have created the vault "${facts.names?.vault ?? 'Assistant'}" without gws-ea recording it. In 1Password, delete that vault if it exists, then clear the attempt.`;
    case 'service_account_creation_unproven':
      return `1Password may have created the service account "${facts.names?.runtimeServiceAccount ?? 'GWS-EA'}" without gws-ea keeping its token. On 1Password.com, revoke it under Developer > Directory if it is listed, then clear the attempt.`;
    case 'runtime_unverified':
      return `The runtime service account's token is kept, but 1Password did not confirm its identity and vault. Retry; if it keeps failing, revoke "${facts.names?.runtimeServiceAccount ?? 'GWS-EA'}" on 1Password.com under Developer > Directory, then clear the attempt.`;
    case 'runtime_token_unavailable':
      return `The runtime service account ${facts.serviceAccountId ?? ''} is recorded, but its owner-only token file is missing or unreadable. Restore it; a replacement needs that account revoked first.`;
    case 'resources_invalid':
      return `The assistant's 1Password record cannot be used safely${facts.file ? ` (${facts.file})` : ''}. Inspect it before retrying.`;
    case 'vault_not_owned':
      return "The recorded vault was not created by this host's management service account; it is never adopted.";
  }
}

function skipMessage(reason: OnePasswordSkipReason): string {
  switch (reason) {
    case 'release_unsupported':
      return 'This release does not support 1Password vaults; update it, then install 1Password again.';
    case 'release_unknown':
      return 'Release compatibility could not be established; inspect the assistant.';
    case 'not_created':
      return 'Its creation has not finished; finishing it with resume provisions its vault.';
    case 'removal_in_progress':
      return 'It is being removed.';
  }
}

function pendingReasonFor(
  reason: OnePasswordFailureReason,
  identity: 'operator' | 'management' | 'runtime',
): OnePasswordPendingReason {
  switch (reason) {
    case 'rate_limited':
    case 'forbidden':
    case 'not_found':
    case 'wrong_account':
      return identity === 'runtime' && reason !== 'rate_limited' ? 'runtime_unverified' : reason;
    case 'not_signed_in':
    case 'token_unavailable':
      return identity === 'operator'
        ? 'sign_in_required'
        : identity === 'management'
          ? 'management_unavailable'
          : 'runtime_unverified';
    case 'unexpected_output':
    case 'failed':
    case 'outcome_unknown':
      return identity === 'runtime'
        ? 'runtime_unverified'
        : identity === 'operator'
          ? 'operator_sign_in_needed'
          : 'provider_failed';
  }
}

/** The CLI opened and the identities verified, which every provider change needs. */
interface Connection {
  readonly cli: OnePasswordCli;
  readonly operator: OperatorIdentity;
  readonly operatorUserId: string;
  readonly management: ServiceAccountIdentity;
}

type ConnectionResult =
  | { readonly status: 'ok'; readonly connection: Connection }
  | { readonly status: 'pending'; readonly reason: OnePasswordPendingReason };

interface Reconciliation {
  readonly paths: ControlPlanePaths;
  readonly policy: OnePasswordHostPolicy & { readonly managementServiceAccountId: string };
  /** Opens and verifies on first need, so an assistant already provisioned costs no request. */
  readonly connect: () => Promise<ConnectionResult>;
  readonly upsertEnvVars?: UpsertEnvVars;
  readonly recordEffect?: (changed: true | null) => void;
}

function provisioning(
  instanceId: string,
  outcome: OnePasswordAssistantProvisioning['outcome'],
  facts: {
    readonly reason?: OnePasswordPendingReason | OnePasswordSkipReason;
    readonly message?: string;
    readonly changed: Changed;
    readonly resources?: OnePasswordResources;
  },
): OnePasswordAssistantProvisioning {
  return {
    instance_id: instanceId,
    outcome,
    reason: facts.reason ?? null,
    message: facts.message ?? null,
    changed: facts.changed,
    vault_id: facts.resources?.vault.id ?? null,
    runtime_service_account_id: facts.resources?.runtimeServiceAccountId ?? null,
    retired_service_account_ids: facts.resources?.retiredRuntimeServiceAccountIds ?? [],
  };
}

/** The caller holds the assistant's instance lock. */
async function reconcileAssistant(
  context: Reconciliation,
  instanceId: string,
): Promise<OnePasswordAssistantProvisioning> {
  const { paths, policy } = context;
  const effects = new Effects(context.recordEffect);
  const skipped = (reason: OnePasswordSkipReason): OnePasswordAssistantProvisioning =>
    provisioning(instanceId, 'skipped', { reason, message: skipMessage(reason), changed: effects.changed });
  if (await exists(paths.removalFile(instanceId))) return skipped('removal_in_progress');
  let runtime: InstanceRuntimeConfig;
  try {
    runtime = await loadInstanceRuntimeConfig(paths.runtimeFile(instanceId));
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return skipped('not_created');
    throw error;
  }
  const compatibility = await onePasswordReleaseCompatibility(runtime.checkout_root);
  if (compatibility !== 'compatible')
    return skipped(compatibility === 'unsupported' ? 'release_unsupported' : 'release_unknown');
  if (context.upsertEnvVars && (await bindInstanceHostPolicies(runtime, paths.configRoot, context.upsertEnvVars)))
    effects.done();

  const reservation = await getInstanceReservation(paths, instanceId);
  const names = resourceNames(reservation.exclusive_resource_claims.workspace_email, instanceId);
  const files = onePasswordInstancePaths(runtime.instance_root);
  let resources: OnePasswordResources | undefined;
  const pending = (reason: OnePasswordPendingReason): OnePasswordAssistantProvisioning =>
    provisioning(instanceId, 'pending', {
      reason,
      message: pendingMessage(reason, {
        names,
        serviceAccountId: resources?.runtimeServiceAccountId ?? null,
        file: files.resourceFile,
      }),
      changed: effects.changed,
      ...(resources ? { resources } : {}),
    });
  const record = async (next: OnePasswordResources): Promise<void> => {
    effects.starting();
    await writeOnePasswordResources(files.resourceFile, next);
    resources = next;
    effects.done();
  };

  const read = await readOnePasswordResources(files.resourceFile, { instanceId, accountId: policy.accountId });
  if (read.status === 'invalid') return pending('resources_invalid');
  const vaultIntent = vaultCreationRecord(files);
  if (read.status === 'ready') {
    resources = read.resources;
    // A crash after the vault was recorded leaves its intent behind; the record settles it.
    await removePrivateFile(vaultIntent);
  } else {
    // Intent first: a vault the provider may have created is never created twice.
    if (await exists(vaultIntent)) return pending('vault_creation_unproven');
    const connected = await context.connect();
    if (connected.status !== 'ok') return pending(connected.reason);
    const { cli, management } = connected.connection;
    try {
      await writeOwnerOnlyFileExclusive(
        vaultIntent,
        `${JSON.stringify({ schemaVersion: 1, instanceId, accountId: policy.accountId, vaultName: names.vault, startedAt: new Date().toISOString() })}\n`,
      );
    } catch (error) {
      if (isErrno(error, 'EEXIST')) return pending('vault_creation_unproven');
      throw error;
    }
    effects.starting();
    const created = await cli.createVault(management, names.vault);
    if (created.status !== 'ok') {
      if (created.reason === 'outcome_unknown') return pending('vault_creation_unproven');
      await removePrivateFile(vaultIntent);
      return pending(pendingReasonFor(created.reason, 'management'));
    }
    effects.done();
    await record({
      schemaVersion: 2,
      instanceId,
      accountId: policy.accountId,
      vault: {
        id: created.vaultId,
        createdBy: { kind: 'management_service_account', serviceAccountId: policy.managementServiceAccountId },
      },
      operatorGrant: null,
      runtimeServiceAccountId: null,
      retiredRuntimeServiceAccountIds: [],
    });
    await removePrivateFile(vaultIntent);
  }
  if (!resources) throw new Error('The 1Password resources were not recorded');

  const runtimeIdentity: ServiceAccountIdentity = {
    kind: 'service_account',
    accountId: policy.accountId,
    tokenFile: files.runtimeTokenFile,
  };
  if (resources.runtimeServiceAccountId !== null) {
    const token = await readOnePasswordToken(files.runtimeTokenFile);
    return token.status === 'ready'
      ? provisioning(instanceId, 'ready', { changed: effects.changed, resources })
      : pending('runtime_token_unavailable');
  }
  const creator = resources.vault.createdBy;
  if (creator.kind !== 'management_service_account' || creator.serviceAccountId !== policy.managementServiceAccountId)
    return pending('vault_not_owned');
  const connected = await context.connect();
  if (connected.status !== 'ok') return pending(connected.reason);
  const { cli, management, operator, operatorUserId } = connected.connection;

  if (resources.operatorGrant?.userId !== operatorUserId) {
    // A grant is idempotent: one whose outcome is unknown is simply granted again.
    effects.starting();
    const granted = await cli.grantVaultAccess(management, {
      vaultId: resources.vault.id,
      userId: operatorUserId,
      permissions: OPERATOR_GRANT,
    });
    if (granted.status !== 'ok') return pending(pendingReasonFor(granted.reason, 'management'));
    effects.done();
    await record({ ...resources, operatorGrant: { userId: operatorUserId, permissions: [...OPERATOR_GRANT] } });
  }

  await preparePrivateDirectory(path.dirname(files.runtimeTokenFile));
  if (await mintsFresh(files.runtimeTokenFile)) effects.starting();
  const minted = await cli.createServiceAccount(operator, {
    name: names.runtimeServiceAccount,
    access: { kind: 'vault_items', vaultId: resources.vault.id },
    tokenFile: files.runtimeTokenFile,
  });
  if (minted.status === 'failed')
    return pending(
      minted.reason === 'outcome_unknown'
        ? 'service_account_creation_unproven'
        : pendingReasonFor(minted.reason, 'operator'),
    );
  if (minted.status === 'created') effects.done();

  // Verified before it is recorded: exactly a service account, in this account, reading exactly this vault.
  const identity = await cli.whoami(runtimeIdentity);
  if (identity.status !== 'ok') return pending(pendingReasonFor(identity.reason, 'runtime'));
  if (identity.userId === policy.managementServiceAccountId) return pending('runtime_unverified');
  const vault = await cli.getVault(runtimeIdentity, resources.vault.id);
  if (vault.status !== 'ok') return pending(pendingReasonFor(vault.reason, 'runtime'));
  await record({ ...resources, runtimeServiceAccountId: identity.userId });
  return provisioning(instanceId, 'ready', { changed: effects.changed, resources });
}

/** A lock another operation holds leaves the assistant pending; it is never waited on. */
async function reconcileLocked(context: Reconciliation, instanceId: string): Promise<OnePasswordAssistantProvisioning> {
  try {
    return await withAssistantLock(context.paths, instanceId, () => reconcileAssistant(context, instanceId));
  } catch (error) {
    if (!(error instanceof GwsEaError) || error.code !== 'instance_busy') throw error;
    return provisioning(instanceId, 'pending', {
      reason: 'instance_busy',
      message: pendingMessage('instance_busy', {}),
      changed: false,
    });
  }
}

function cliError(
  reason: 'cli_missing' | 'cli_untrusted' | 'cli_unavailable' | 'cli_too_old',
  version?: string,
): GwsEaError {
  const install =
    'Install the 1Password CLI 2.29 or later from 1Password (for example brew install 1password-cli), then retry.';
  switch (reason) {
    case 'cli_missing':
      return new GwsEaError('onepassword_cli_missing', `The 1Password CLI (op) is not on PATH. ${install}`);
    case 'cli_untrusted':
      return new GwsEaError(
        'onepassword_cli_untrusted',
        'The 1Password CLI found is in a location others could replace. Install it in an operator-owned location, then retry.',
      );
    case 'cli_unavailable':
      return new GwsEaError('onepassword_cli_unavailable', `The 1Password CLI did not report its version. ${install}`);
    case 'cli_too_old':
      return new GwsEaError('onepassword_cli_too_old', `The 1Password CLI is ${version ?? 'too old'}. ${install}`);
  }
}

function hostProviderError(reason: OnePasswordFailureReason, identity: 'operator' | 'management'): GwsEaError {
  switch (reason) {
    case 'not_signed_in':
    case 'token_unavailable':
      return identity === 'operator'
        ? new GwsEaError('onepassword_sign_in_required', pendingMessage('sign_in_required', {}))
        : new GwsEaError('onepassword_management_unavailable', pendingMessage('management_unavailable', {}));
    case 'rate_limited':
      return new GwsEaError('onepassword_rate_limited', pendingMessage('rate_limited', {}));
    case 'forbidden':
      return new GwsEaError('onepassword_forbidden', pendingMessage('forbidden', {}));
    case 'wrong_account':
      return new GwsEaError('onepassword_wrong_account', pendingMessage('wrong_account', {}));
    case 'not_found':
      return identity === 'operator'
        ? new GwsEaError(
            'onepassword_account_unknown',
            'The 1Password app holds no such account. Sign in to it in the app, or name one it holds.',
          )
        : new GwsEaError('onepassword_management_unavailable', pendingMessage('management_unavailable', {}));
    case 'unexpected_output':
    case 'failed':
    case 'outcome_unknown':
      return new GwsEaError('onepassword_provider_failed', pendingMessage('provider_failed', {}));
  }
}

async function openCli(seams: OnePasswordCliSeams | undefined, command?: string): Promise<OnePasswordCli> {
  const opening = await OnePasswordCli.open({ ...seams, ...(command === undefined ? {} : { command }) });
  if (opening.status === 'ready') return opening.cli;
  throw opening.reason === 'cli_too_old' ? cliError(opening.reason, opening.version) : cliError(opening.reason);
}

export async function withOnePasswordHostLock<T>(paths: ControlPlanePaths, work: () => Promise<T>): Promise<T> {
  await preparePrivateDirectory(paths.configRoot);
  const release = await processLock(path.join(paths.configRoot, 'onepassword.lock'));
  if (!release)
    throw new GwsEaError(
      'onepassword_busy',
      'Another 1Password operation is running on this host; retry once it finishes.',
    );
  try {
    return await work();
  } finally {
    release();
  }
}

/**
 * The one account every assistant on this host uses, as the 1Password app
 * lists it: the recorded one, or one the operator names or chooses. The
 * listing gives its sign-in address, which the host records beside its ID.
 */
async function selectAccount(
  cli: OnePasswordCli,
  recorded: OnePasswordHostPolicy | undefined,
  requested: string | undefined,
  choose: OnePasswordDependencies['chooseAccount'],
): Promise<{ readonly accountId: string; readonly signInAddress: string }> {
  if (recorded && requested !== undefined && requested !== recorded.accountId)
    throw new GwsEaError(
      'onepassword_account_mismatch',
      `1Password is set up on this host with account ${recorded.accountId}; assistants keep their vaults there, so another account is refused.`,
      { details: { accountId: recorded.accountId } },
    );
  const listed = await cli.listAccounts();
  if (listed.status !== 'ok') throw hostProviderError(listed.reason, 'operator');
  if (!listed.accounts.length)
    throw new GwsEaError(
      'onepassword_sign_in_required',
      'The 1Password app holds no account. Sign in to the account assistants should use, then retry.',
    );
  const named = recorded?.accountId ?? requested;
  const chosen = named ?? (choose ? await choose(listed.accounts) : undefined);
  if (chosen === undefined)
    throw new GwsEaError(
      'onepassword_account_required',
      'Choose the 1Password account assistants use: rerun with --account and one of the account IDs listed.',
      {
        details: {
          accounts: listed.accounts.map((account) => account.accountId),
          account_labels: listed.accounts.map((account) => `${account.email} on ${account.url}`),
        },
      },
    );
  const account = listed.accounts.find((candidate) => candidate.accountId === chosen);
  if (!account) {
    if (named === undefined) throw invalidArguments('The chosen 1Password account is not one the app holds.');
    throw hostProviderError('not_found', 'operator');
  }
  const signInAddress = onePasswordSignInAddress(account.url);
  if (signInAddress === undefined) throw hostProviderError('unexpected_output', 'operator');
  return { accountId: account.accountId, signInAddress };
}

async function verifyOperator(cli: OnePasswordCli, operator: OperatorIdentity): Promise<string> {
  const who = await cli.whoami(operator);
  if (who.status !== 'ok') throw hostProviderError(who.reason, 'operator');
  return who.userId;
}

/**
 * The recorded management service account no longer authenticates. Only it
 * may administer the vaults it created, so the recovery is its own token,
 * never a new management account.
 */
const MANAGEMENT_UNAVAILABLE: ReadonlySet<OnePasswordFailureReason> = new Set([
  'not_signed_in',
  'token_unavailable',
  'not_found',
]);

export function isManagementUnavailable(reason: OnePasswordFailureReason): boolean {
  return MANAGEMENT_UNAVAILABLE.has(reason);
}

export function managementUnavailable(serviceAccountId: string, tokenFile: string): GwsEaError {
  return new GwsEaError(
    'onepassword_management_unavailable',
    `The host management service account ${serviceAccountId} cannot authenticate: its token at ${tokenFile} is missing, expired or revoked. Restore that account's token. The vaults it created stay its own, and gws-ea never hands them to a new management account; if it was revoked, manage those vaults on 1Password.com.`,
    { details: { managementServiceAccountId: serviceAccountId } },
  );
}

/** The recorded management service account, proven to be exactly the one its token authenticates as. */
async function verifyManagement(
  cli: OnePasswordCli,
  identity: ServiceAccountIdentity,
  expected: string,
): Promise<void> {
  const who = await cli.whoami(identity);
  if (who.status === 'failed' && isManagementUnavailable(who.reason))
    throw managementUnavailable(expected, identity.tokenFile);
  if (who.status !== 'ok') throw hostProviderError(who.reason, 'management');
  if (who.userId !== expected)
    throw new GwsEaError(
      'onepassword_management_mismatch',
      `The host management token authenticates as another service account than the recorded ${expected}; its vaults are never handed to another identity.`,
      { details: { managementServiceAccountId: expected } },
    );
}

/** Recovers a management account already captured rather than minting another. */
async function bootstrapManagement(
  cli: OnePasswordCli,
  operator: OperatorIdentity,
  hostPaths: OnePasswordHostPaths,
  identity: ServiceAccountIdentity,
  effects: Effects,
): Promise<string> {
  await preparePrivateDirectory(hostPaths.directory);
  if (await mintsFresh(hostPaths.managementTokenFile)) effects.starting();
  const minted = await cli.createServiceAccount(operator, {
    name: MANAGEMENT_NAME,
    access: { kind: 'create_vaults' },
    tokenFile: hostPaths.managementTokenFile,
  });
  if (minted.status === 'failed') {
    if (minted.reason === 'outcome_unknown')
      throw new GwsEaError(
        'onepassword_management_unproven',
        `1Password may have created the service account "${MANAGEMENT_NAME}" without gws-ea keeping its token. On 1Password.com, revoke it under Developer > Directory if it is listed, then clear the attempt.`,
      );
    throw hostProviderError(minted.reason, 'operator');
  }
  if (minted.status === 'created') effects.done();
  const who = await cli.whoami(identity);
  if (who.status === 'failed' && who.reason === 'wrong_account')
    throw new GwsEaError(
      'onepassword_management_unproven',
      `The captured "${MANAGEMENT_NAME}" token belongs to another account or identity. On 1Password.com, revoke it under Developer > Directory, then clear the attempt.`,
    );
  if (who.status !== 'ok') throw hostProviderError(who.reason, 'management');
  return who.userId;
}

/** Forget an interrupted creation the operator has cleaned up, never a recorded identity. */
async function discardManagementAttempt(
  recorded: OnePasswordHostPolicy | undefined,
  hostPaths: OnePasswordHostPaths,
  effects: Effects,
): Promise<void> {
  // Without a recorded policy, any captured or attempted management account is unrecorded.
  const unproven = !recorded && (await creationAttempted(hostPaths.managementTokenFile));
  if (!unproven) throw nothingUnproven(MANAGEMENT_TARGET);
  effects.starting();
  await discardServiceAccountCreation(hostPaths.managementTokenFile);
  effects.done();
}

function nothingUnproven(target: string): GwsEaError {
  return new GwsEaError(
    'onepassword_nothing_unproven',
    `No 1Password creation is unproven for ${target}; nothing was discarded.`,
  );
}

async function discardAssistantAttempt(paths: ControlPlanePaths, instanceId: string, effects: Effects): Promise<void> {
  await withAssistantLock(paths, instanceId, async () => {
    const files = onePasswordInstancePaths(paths.instanceRoot(instanceId));
    const read = await readOnePasswordResources(files.resourceFile, { instanceId });
    const intent = vaultCreationRecord(files);
    if (read.status === 'absent' && (await exists(intent))) {
      effects.starting();
      await removePrivateFile(intent);
      effects.done();
      return;
    }
    const minting =
      read.status === 'ready' &&
      read.resources.runtimeServiceAccountId === null &&
      (await creationAttempted(files.runtimeTokenFile));
    if (!minting) throw nothingUnproven(`assistant ${instanceId}`);
    effects.starting();
    await discardServiceAccountCreation(files.runtimeTokenFile);
    effects.done();
  });
}

/**
 * Enable 1Password on this host and reconcile every registered assistant:
 * compatible ones, running or stopped, get their vault and runtime account;
 * the others are reported and left untouched. A partial enable keeps what it
 * finished, reports what waits, and a retry continues only what is incomplete.
 */
export async function installOnePassword(
  paths: ControlPlanePaths,
  request: OnePasswordInstallRequest = {},
  dependencies: OnePasswordDependencies = {},
): Promise<OnePasswordInstallData> {
  if (request.accountId !== undefined && !isOnePasswordId(request.accountId))
    throw invalidArguments('--account must be an exact 1Password account ID (26 letters and digits).');
  const discard = request.discardUnproven;
  if (discard !== undefined && discard !== MANAGEMENT_TARGET && !INSTANCE_ID_PATTERN.test(discard))
    throw invalidArguments(`--discard-unproven must be ${MANAGEMENT_TARGET} or a full assistant ID.`);
  const { inspectOnePasswordUninstall } = await import('./onepassword-uninstall.js');
  const assertUninstallComplete = async (): Promise<void> => {
    const inspection = await inspectOnePasswordUninstall(paths);
    if (!inspection.incomplete) return;
    const completed = inspection.receipt?.completed === true;
    throw new GwsEaError(
      'onepassword_uninstall_incomplete',
      completed
        ? 'Inspect the uninstall receipt and finish its manual cleanup on 1Password.com before acknowledging it with gws-ea connectors uninstall onepassword --abandon.'
        : 'Finish gws-ea connectors uninstall onepassword before installing again.',
      { details: { uninstall_completed: completed } },
    );
  };
  await assertUninstallComplete();
  if (dependencies.operatorTerminal === false)
    throw new GwsEaError('onepassword_operator_sign_in_needed', pendingMessage('operator_sign_in_needed', {}));
  // Nothing on disk changes until a trusted, current CLI is found.
  const cli = await openCli(dependencies.cli);
  return withOnePasswordHostLock(paths, async () => {
    await assertUninstallComplete();
    const effects = new Effects(dependencies.recordEffect);
    const hostPaths = onePasswordHostPaths(paths.configRoot);
    const existing = await readOnePasswordHostPolicy(hostPaths.policyFile);
    if (existing.status === 'invalid')
      throw new GwsEaError(
        'onepassword_policy_invalid',
        `The 1Password host policy cannot be used safely (${existing.problem}). Inspect ${hostPaths.policyFile} before retrying.`,
      );
    const recorded = existing.status === 'ready' ? existing.policy : undefined;
    if (recorded && recorded.managementServiceAccountId === null)
      throw new GwsEaError(
        'onepassword_policy_invalid',
        'This host policy has no management service account, which this release does not provision. Inspect it before retrying.',
      );
    const ids = Object.keys((await readRegistry(paths)).instances).sort();
    if (discard !== undefined && discard !== MANAGEMENT_TARGET && !ids.includes(discard))
      throw new GwsEaError('unknown_instance', 'Unknown instance ID');
    const upsertEnvVars = dependencies.upsertEnvVars;
    if (!upsertEnvVars && ids.length)
      throw new GwsEaError(
        'onepassword_binding_unavailable',
        'The gws-ea launcher must supply its native environment writer to install 1Password.',
      );

    const { accountId, signInAddress } = await selectAccount(
      cli,
      recorded,
      request.accountId,
      dependencies.chooseAccount,
    );
    const operator: OperatorIdentity = { kind: 'operator', accountId };
    dependencies.progress?.('Approve the 1Password app’s request if it asks.');
    const operatorUserId = await verifyOperator(cli, operator);
    const management: ServiceAccountIdentity = {
      kind: 'service_account',
      accountId,
      tokenFile: hostPaths.managementTokenFile,
    };
    if (discard === MANAGEMENT_TARGET) await discardManagementAttempt(recorded, hostPaths, effects);
    let managementServiceAccountId: string;
    if (recorded?.managementServiceAccountId) {
      await verifyManagement(cli, management, recorded.managementServiceAccountId);
      managementServiceAccountId = recorded.managementServiceAccountId;
    } else {
      managementServiceAccountId = await bootstrapManagement(cli, operator, hostPaths, management, effects);
    }
    const policy = {
      schemaVersion: 2,
      enabled: true,
      accountId,
      signInAddress,
      cliPath: cli.executable,
      managementServiceAccountId,
    } as const satisfies OnePasswordHostPolicy;
    if (JSON.stringify(recorded) !== JSON.stringify(policy)) {
      effects.starting();
      await writeOnePasswordHostPolicy(hostPaths.policyFile, policy);
      effects.done();
    }
    if (discard !== undefined && discard !== MANAGEMENT_TARGET) await discardAssistantAttempt(paths, discard, effects);

    const connection: Connection = { cli, operator, operatorUserId, management };
    // A 429 ends this run's provider work: the rest would spend more of the same limit.
    let limited = false;
    const context: Reconciliation = {
      paths,
      policy,
      connect: async () => (limited ? { status: 'pending', reason: 'rate_limited' } : { status: 'ok', connection }),
      ...(upsertEnvVars ? { upsertEnvVars } : {}),
      ...(dependencies.recordEffect ? { recordEffect: dependencies.recordEffect } : {}),
    };
    const assistants: OnePasswordAssistantProvisioning[] = [];
    for (const id of ids) {
      dependencies.progress?.(`Checking assistant ${id}'s vault…`);
      const provisioned = await reconcileLocked(context, id);
      if (provisioned.reason === 'rate_limited') limited = true;
      assistants.push(provisioned);
    }
    return {
      name: 'onepassword',
      scope: 'host',
      enabled: true,
      account_id: accountId,
      management_service_account_id: managementServiceAccountId,
      assistants,
      future_compatible_assistants: true,
    };
  });
}

/** Every registered assistant's instance lock, or none: a busy one refuses before anything changes. */
export async function withOnePasswordAssistantLocks<T>(
  paths: ControlPlanePaths,
  instanceIds: readonly string[],
  work: () => Promise<T>,
): Promise<T> {
  const releases: Array<() => void> = [];
  try {
    for (const instanceId of instanceIds) {
      await preparePrivateDirectory(path.dirname(paths.instanceLock(instanceId)));
      const release = await processLock(paths.instanceLock(instanceId));
      if (!release)
        throw new GwsEaError(
          'instance_busy',
          `Assistant ${instanceId} is undergoing another operation; nothing was changed. Retry once it finishes.`,
          { details: { instanceId } },
        );
      releases.push(release);
    }
    return await work();
  } finally {
    for (const release of releases.reverse()) release();
  }
}

/** An unusable policy counts as enabled, so its owner hears of it. */
export async function onePasswordEnabled(paths: ControlPlanePaths): Promise<boolean> {
  const read = await readOnePasswordHostPolicy(onePasswordHostPaths(paths.configRoot).policyFile);
  return read.status === 'invalid' || (read.status === 'ready' && read.policy.enabled);
}

/**
 * Install's reconciliation for one assistant during its operator-led create or
 * resume, under the instance operation the caller holds. Undefined when
 * 1Password is not enabled on this host. An assistant already provisioned
 * costs no provider request and no desktop prompt.
 */
export async function provisionAssistantVault(
  operation: InstanceOperation,
  dependencies: Pick<
    OnePasswordDependencies,
    'cli' | 'upsertEnvVars' | 'recordEffect' | 'operatorTerminal' | 'rateLimitState'
  > = {},
): Promise<OnePasswordAssistantProvisioning | undefined> {
  operation.assertActive();
  const { paths, instanceId } = operation;
  const { inspectOnePasswordUninstall } = await import('./onepassword-uninstall.js');
  if ((await inspectOnePasswordUninstall(paths)).incomplete) return undefined;
  const pending = (reason: OnePasswordPendingReason): OnePasswordAssistantProvisioning =>
    provisioning(instanceId, 'pending', { reason, message: pendingMessage(reason, {}), changed: false });
  if (dependencies.rateLimitState?.limited) return pending('rate_limited');
  try {
    return await withOnePasswordHostLock(paths, async () => {
      if ((await inspectOnePasswordUninstall(paths)).incomplete) return undefined;
      const hostPaths = onePasswordHostPaths(paths.configRoot);
      const read = await readOnePasswordHostPolicy(hostPaths.policyFile);
      if (read.status === 'absent' || (read.status === 'ready' && !read.policy.enabled)) return undefined;
      const hostPending = (reason: OnePasswordPendingReason): OnePasswordAssistantProvisioning =>
        provisioning(instanceId, 'pending', {
          reason,
          message: pendingMessage(reason, { file: hostPaths.policyFile }),
          changed: false,
        });
      if (read.status === 'invalid') return hostPending('policy_invalid');
      const managementServiceAccountId = read.policy.managementServiceAccountId;
      if (managementServiceAccountId === null) return hostPending('policy_invalid');
      const policy = { ...read.policy, managementServiceAccountId };
      let connection: Promise<ConnectionResult> | undefined;
      const connect = async (): Promise<ConnectionResult> => {
        if (dependencies.operatorTerminal === false) return { status: 'pending', reason: 'operator_sign_in_needed' };
        let cli: OnePasswordCli;
        try {
          cli = await openCli(dependencies.cli, policy.cliPath);
        } catch (error) {
          if (error instanceof GwsEaError && error.code.startsWith('onepassword_cli_'))
            return { status: 'pending', reason: 'cli_unavailable' };
          throw error;
        }
        const operator: OperatorIdentity = { kind: 'operator', accountId: policy.accountId };
        const who = await cli.whoami(operator);
        if (who.status !== 'ok') return { status: 'pending', reason: pendingReasonFor(who.reason, 'operator') };
        const management: ServiceAccountIdentity = {
          kind: 'service_account',
          accountId: policy.accountId,
          tokenFile: hostPaths.managementTokenFile,
        };
        const verified = await cli.whoami(management);
        if (verified.status !== 'ok')
          return { status: 'pending', reason: pendingReasonFor(verified.reason, 'management') };
        if (verified.userId !== managementServiceAccountId)
          return { status: 'pending', reason: 'management_unavailable' };
        return { status: 'ok', connection: { cli, operator, operatorUserId: who.userId, management } };
      };
      const result = await reconcileAssistant(
        {
          paths,
          policy,
          connect: () => (connection ??= connect()),
          ...(dependencies.upsertEnvVars ? { upsertEnvVars: dependencies.upsertEnvVars } : {}),
          ...(dependencies.recordEffect ? { recordEffect: dependencies.recordEffect } : {}),
        },
        instanceId,
      );
      if (result.reason === 'rate_limited' && dependencies.rateLimitState) dependencies.rateLimitState.limited = true;
      return result;
    });
  } catch (error) {
    if (error instanceof GwsEaError && error.code === 'onepassword_busy') return pending('onepassword_busy');
    throw error;
  }
}

export type OnePasswordTokenState = 'present' | 'absent' | 'invalid';
export type OnePasswordCheckState = 'not_checked' | 'verified' | 'failed';

export interface OnePasswordQuota {
  /** `unknown` when a usage lookup failed: never reported as no usage. */
  readonly status: 'not_checked' | 'observed' | 'unknown';
  readonly account_type: OnePasswordAccountType | null;
  /** This host's provisioned assistants; they share the account's one daily limit with every service account. */
  readonly sharing_assistant_ids: readonly string[];
  readonly daily: { readonly limit: number; readonly used: number; readonly remaining: number } | null;
  readonly hourly_per_token: { readonly read: number | null; readonly write: number | null } | null;
  readonly reason: string | null;
}

export interface OnePasswordAssistantReadiness {
  readonly instance_id: string;
  readonly compatibility: OnePasswordReleaseCompatibility;
  readonly provisioning: 'ready' | 'incomplete' | 'absent' | 'invalid' | 'not_applicable';
  readonly vault_id: string | null;
  readonly runtime_service_account_id: string | null;
  /** Runtime service accounts whose tokens a disable deleted; only the operator can revoke them. */
  readonly retired_service_account_ids: readonly string[];
  readonly recorded_grants: {
    readonly operator: { readonly user_id: string; readonly permissions: readonly string[] } | null;
    readonly runtime: readonly string[] | null;
  };
  readonly runtime_token: OnePasswordTokenState;
  readonly unproven_creation: 'vault' | 'service_account' | null;
  /** An authenticated read of the vault by its runtime account, for an explicit check. */
  readonly access: { readonly status: OnePasswordCheckState; readonly reason: string | null };
  /** No check writes to a vault; a recorded write grant is reported, never a tested write. */
  readonly write: 'untested';
  readonly reason: string | null;
}

export interface OnePasswordCapabilityObservation {
  readonly observed_at: string;
  readonly name: 'onepassword';
  readonly scope: 'host';
  readonly actions: typeof ONEPASSWORD_CAPABILITY.actions;
  readonly summary: string;
  readonly activation: { readonly status: 'enabled' | 'disabled' | 'unknown'; readonly reason: string | null };
  readonly account_id: string | null;
  readonly cli: {
    readonly path: string | null;
    readonly status: 'not_checked' | 'available' | 'unavailable';
    readonly version: string | null;
    readonly reason: string | null;
  };
  readonly management: {
    readonly service_account_id: string | null;
    readonly token: OnePasswordTokenState;
    readonly status: OnePasswordCheckState;
    readonly reason: string | null;
  };
  readonly quota: OnePasswordQuota;
  readonly assistants: readonly OnePasswordAssistantReadiness[];
  readonly prerequisites: readonly string[];
  readonly readiness_limits: readonly string[];
  readonly future_compatible_assistants: true;
}

export interface OnePasswordInspection {
  /** Make service-account requests: identities, vault reads and the shared usage. */
  readonly check?: boolean;
  /** Limit local observations and provider work to one selected assistant. */
  readonly instanceId?: string;
  /** Check runtime credentials only for reachable assistants selected by the caller. */
  readonly checkAssistantIds?: readonly string[];
  readonly cli?: OnePasswordCliSeams;
}

async function tokenState(file: string): Promise<OnePasswordTokenState> {
  const read = await readOnePasswordToken(file);
  return read.status === 'ready' ? 'present' : read.status;
}

async function localReadiness(
  paths: ControlPlanePaths,
  instanceId: string,
  accountId: string | undefined,
): Promise<{
  readonly readiness: OnePasswordAssistantReadiness;
  readonly resources?: OnePasswordResources;
  readonly files?: OnePasswordInstancePaths;
}> {
  const base: OnePasswordAssistantReadiness = {
    instance_id: instanceId,
    compatibility: 'unknown',
    provisioning: 'not_applicable',
    vault_id: null,
    runtime_service_account_id: null,
    retired_service_account_ids: [],
    recorded_grants: { operator: null, runtime: null },
    runtime_token: 'absent',
    unproven_creation: null,
    access: { status: 'not_checked', reason: null },
    write: 'untested',
    reason: null,
  };
  let runtime: InstanceRuntimeConfig;
  try {
    runtime = await loadInstanceRuntimeConfig(paths.runtimeFile(instanceId));
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return { readiness: { ...base, reason: skipMessage('not_created') } };
    if (!(error instanceof Error)) throw error;
    return {
      readiness: {
        ...base,
        reason: `Assistant runtime configuration is invalid or inaccessible. Inspect gws-ea status --id ${instanceId}.`,
      },
    };
  }
  const compatibility = await onePasswordReleaseCompatibility(runtime.checkout_root);
  if (compatibility !== 'compatible')
    return {
      readiness: {
        ...base,
        compatibility,
        reason: skipMessage(compatibility === 'unsupported' ? 'release_unsupported' : 'release_unknown'),
      },
    };
  const files = onePasswordInstancePaths(runtime.instance_root);
  const read = await readOnePasswordResources(files.resourceFile, {
    instanceId,
    ...(accountId === undefined ? {} : { accountId }),
  });
  const token = await tokenState(files.runtimeTokenFile);
  const unproven: OnePasswordAssistantReadiness['unproven_creation'] = (await exists(vaultCreationRecord(files)))
    ? 'vault'
    : (await serviceAccountCreationUnproven(files.runtimeTokenFile))
      ? 'service_account'
      : null;
  const facts = { ...base, compatibility, runtime_token: token, unproven_creation: unproven };
  if (read.status === 'invalid')
    return {
      readiness: {
        ...facts,
        provisioning: 'invalid',
        reason: pendingMessage('resources_invalid', { file: files.resourceFile }),
      },
    };
  if (read.status === 'absent') return { readiness: { ...facts, provisioning: 'absent' }, files };
  const resources = read.resources;
  const ready = resources.runtimeServiceAccountId !== null && token === 'present';
  const retired = resources.retiredRuntimeServiceAccountIds;
  return {
    resources,
    files,
    readiness: {
      ...facts,
      provisioning: ready ? 'ready' : 'incomplete',
      vault_id: resources.vault.id,
      runtime_service_account_id: resources.runtimeServiceAccountId,
      retired_service_account_ids: retired,
      recorded_grants: {
        operator: resources.operatorGrant
          ? { user_id: resources.operatorGrant.userId, permissions: resources.operatorGrant.permissions }
          : null,
        runtime: resources.runtimeServiceAccountId === null ? null : ONEPASSWORD_RUNTIME_GRANT,
      },
      reason:
        resources.runtimeServiceAccountId !== null && token !== 'present'
          ? pendingMessage('runtime_token_unavailable', { serviceAccountId: resources.runtimeServiceAccountId })
          : resources.runtimeServiceAccountId === null && retired.length
            ? `Its runtime token was deleted when 1Password was stopped; installing it again mints a replacement. Revoke ${retired.join(', ')} on 1Password.com if still listed.`
            : null,
    },
  };
}

const LIMIT_SPENT = "Not checked: 1Password's request limit is spent.";
const DISABLED_REASON =
  '1Password vault use is stopped. Rerun gws-ea connectors uninstall onepassword to finish the recorded cleanup.';

function checkReason(reason: OnePasswordFailureReason): string {
  return `1Password answered ${reason.replaceAll('_', ' ')}.`;
}

type WhoAmI = Awaited<ReturnType<OnePasswordCli['whoami']>>;
type VaultRead = Awaited<ReturnType<OnePasswordCli['getVault']>>;

function hostActivation(
  read: Awaited<ReturnType<typeof readOnePasswordHostPolicy>>,
  policyFile: string,
): OnePasswordCapabilityObservation['activation'] {
  if (read.status === 'invalid')
    return {
      status: 'unknown',
      reason: `The 1Password host policy cannot be used safely (${read.problem}). Inspect ${policyFile}.`,
    };
  if (read.status === 'absent') return { status: 'disabled', reason: null };
  return read.policy.enabled ? { status: 'enabled', reason: null } : { status: 'disabled', reason: DISABLED_REASON };
}

/** The management check's outcome; `who` is undefined when the request limit stopped the check. */
function checkedManagement(
  management: OnePasswordCapabilityObservation['management'],
  who: WhoAmI | undefined,
  expected: string | null,
): OnePasswordCapabilityObservation['management'] {
  if (!who) return { ...management, reason: LIMIT_SPENT };
  if (who.status !== 'ok') return { ...management, status: 'failed', reason: checkReason(who.reason) };
  if (who.userId !== expected)
    return {
      ...management,
      status: 'failed',
      reason: 'The management token authenticates as another service account.',
    };
  return { ...management, status: 'verified' };
}

/** A runtime account's access; undefined checks were stopped by the request limit. */
function runtimeAccess(
  who: WhoAmI | undefined,
  vault: VaultRead | undefined,
  expected: string | null,
): OnePasswordAssistantReadiness['access'] {
  if (!who) return { status: 'not_checked', reason: LIMIT_SPENT };
  if (who.status !== 'ok') return { status: 'failed', reason: checkReason(who.reason) };
  if (who.userId !== expected)
    return { status: 'failed', reason: 'The runtime token authenticates as another service account.' };
  if (!vault) return { status: 'not_checked', reason: LIMIT_SPENT };
  if (vault.status !== 'ok') return { status: 'failed', reason: checkReason(vault.reason) };
  return { status: 'verified', reason: null };
}

/**
 * Local facts, plus service-account requests only for an explicit check:
 * never the operator's desktop sign-in, never a write, never a repair.
 */
export async function inspectOnePasswordCapability(
  paths: ControlPlanePaths,
  options: OnePasswordInspection = {},
): Promise<OnePasswordCapabilityObservation> {
  const observedAt = new Date().toISOString();
  const hostPaths = onePasswordHostPaths(paths.configRoot);
  const read = await readOnePasswordHostPolicy(hostPaths.policyFile);
  const policy = read.status === 'ready' ? read.policy : undefined;
  const activation = hostActivation(read, hostPaths.policyFile);
  const ids = Object.keys((await readRegistry(paths)).instances)
    .filter((id) => options.instanceId === undefined || id === options.instanceId)
    .sort();
  const locals = [];
  for (const id of ids) locals.push({ id, ...(await localReadiness(paths, id, policy?.accountId)) });
  const sharing = locals.filter((local) => local.readiness.provisioning === 'ready').map((local) => local.id);

  let cli: OnePasswordCapabilityObservation['cli'] = {
    path: policy?.cliPath ?? null,
    status: 'not_checked',
    version: null,
    reason: null,
  };
  let management: OnePasswordCapabilityObservation['management'] = {
    service_account_id: policy?.managementServiceAccountId ?? null,
    token: policy ? await tokenState(hostPaths.managementTokenFile) : 'absent',
    status: 'not_checked',
    reason: null,
  };
  let quota: OnePasswordQuota = {
    status: 'not_checked',
    account_type: null,
    sharing_assistant_ids: sharing,
    daily: null,
    hourly_per_token: null,
    reason: null,
  };
  const assistants = locals.map((local) => local.readiness);
  if (options.check && policy) {
    let opened: OnePasswordCli | undefined;
    try {
      opened = await openCli(options.cli, policy.cliPath);
      cli = { ...cli, status: 'available', version: opened.version };
    } catch (error) {
      if (!(error instanceof GwsEaError) || !error.code.startsWith('onepassword_cli_')) throw error;
      cli = { ...cli, status: 'unavailable', reason: error.message };
      quota = {
        ...quota,
        status: 'unknown',
        reason: 'Current usage is unknown: the recorded 1Password CLI is unavailable.',
      };
    }
    if (opened) {
      const cli = opened;
      // A 429 ends the check's requests: what follows would spend more of the same limit.
      let spent = false;
      const ask = async <T extends object>(
        call: (provider: OnePasswordCli) => Promise<OnePasswordResult<T>>,
      ): Promise<OnePasswordResult<T> | undefined> => {
        if (spent) return undefined;
        const result = await call(cli);
        if (result.status === 'failed' && result.reason === 'rate_limited') spent = true;
        return result;
      };
      const identity: ServiceAccountIdentity = {
        kind: 'service_account',
        accountId: policy.accountId,
        tokenFile: hostPaths.managementTokenFile,
      };
      const who = await ask((provider) => provider.whoami(identity));
      management = checkedManagement(management, who, policy.managementServiceAccountId);
      const type = await ask((provider) => provider.accountType(identity));
      const limits = await ask((provider) => provider.rateLimits(identity));
      const accountType = type?.status === 'ok' ? type.accountType : null;
      if (limits?.status !== 'ok') {
        quota = {
          ...quota,
          status: 'unknown',
          account_type: accountType,
          reason: `Current usage is unknown: ${limits ? checkReason(limits.reason) : LIMIT_SPENT}`,
        };
      } else {
        const daily = limits.limits.find((limit) => limit.scope === 'account');
        const hourly = (action: 'read' | 'write'): number | null =>
          limits.limits.find((limit) => limit.scope === 'token' && limit.action === action)?.limit ?? null;
        quota = {
          ...quota,
          status: daily ? 'observed' : 'unknown',
          account_type: accountType,
          daily: daily ? { limit: daily.limit, used: daily.used, remaining: daily.remaining } : null,
          hourly_per_token: { read: hourly('read'), write: hourly('write') },
          reason: daily ? null : 'Current usage is unknown: 1Password reported no account-wide limit.',
        };
      }
      for (const [index, local] of locals.entries()) {
        if (
          (options.checkAssistantIds !== undefined && !options.checkAssistantIds.includes(local.id)) ||
          local.readiness.provisioning !== 'ready' ||
          !local.resources ||
          !local.files
        )
          continue;
        const runtimeIdentity: ServiceAccountIdentity = {
          kind: 'service_account',
          accountId: policy.accountId,
          tokenFile: local.files.runtimeTokenFile,
        };
        const expected = local.resources;
        const runtimeWho = await ask((provider) => provider.whoami(runtimeIdentity));
        const vault =
          runtimeWho?.status === 'ok' && runtimeWho.userId === expected.runtimeServiceAccountId
            ? await ask((provider) => provider.getVault(runtimeIdentity, expected.vault.id))
            : undefined;
        assistants[index] = {
          ...local.readiness,
          access: runtimeAccess(runtimeWho, vault, expected.runtimeServiceAccountId),
        };
      }
    }
  }
  return {
    observed_at: observedAt,
    name: ONEPASSWORD_CAPABILITY.name,
    scope: ONEPASSWORD_CAPABILITY.scope,
    actions: ONEPASSWORD_CAPABILITY.actions,
    summary: ONEPASSWORD_CAPABILITY.summary,
    activation,
    account_id: policy?.accountId ?? null,
    cli,
    management,
    quota,
    assistants,
    prerequisites: ONEPASSWORD_CAPABILITY.prerequisites,
    readiness_limits: ONEPASSWORD_CAPABILITY.readiness_limits,
    future_compatible_assistants: true,
  };
}

function installCommand(...flags: string[]): NextAction {
  return { kind: 'command', argv: ['gws-ea', 'connectors', 'install', 'onepassword', ...flags] };
}

function assistantActions(entry: OnePasswordAssistantProvisioning): readonly NextAction[] {
  const external = (instruction: string | null): NextAction[] =>
    instruction ? [{ kind: 'external', instruction }] : [];
  switch (entry.reason) {
    case null:
      return [];
    case 'release_unsupported':
      return [{ kind: 'command', argv: ['gws-ea', 'update', '--id', entry.instance_id] }];
    case 'release_unknown':
      return [{ kind: 'command', argv: ['gws-ea', 'status', '--id', entry.instance_id] }];
    case 'not_created':
      return [{ kind: 'command', argv: ['gws-ea', 'resume', '--id', entry.instance_id] }];
    case 'removal_in_progress':
      return [];
    case 'vault_creation_unproven':
    case 'service_account_creation_unproven':
      return [...external(entry.message), installCommand('--discard-unproven', entry.instance_id)];
    case 'runtime_unverified':
      return [...external(entry.message), installCommand(), installCommand('--discard-unproven', entry.instance_id)];
    case 'instance_busy':
    case 'onepassword_busy':
    case 'operator_sign_in_needed':
    case 'rate_limited':
    case 'provider_failed':
      return [...external(entry.message), installCommand()];
    case 'cli_unavailable':
    case 'policy_invalid':
    case 'sign_in_required':
    case 'management_unavailable':
    case 'forbidden':
    case 'wrong_account':
    case 'not_found':
    case 'runtime_token_unavailable':
    case 'resources_invalid':
    case 'vault_not_owned':
      return [...external(entry.message), installCommand()];
  }
}

function distinctActions(actions: readonly NextAction[]): NextAction[] {
  const seen = new Set<string>();
  return actions.filter((action) => {
    const key = JSON.stringify(action);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * What only the operator can do for runtime service accounts whose tokens
 * left this host: gws-ea never revokes one, and cannot tell whether it was.
 */
export function onePasswordRevocation(
  owed: readonly { readonly instanceId: string; readonly serviceAccountIds: readonly string[] }[],
): Extract<NextAction, { readonly kind: 'external' }> | undefined {
  const named = owed.flatMap(({ instanceId, serviceAccountIds }) =>
    serviceAccountIds.map((id) => `${id} (assistant ${instanceId})`),
  );
  return named.length
    ? {
        kind: 'external',
        instruction: `Revoke these runtime service accounts on 1Password.com under Developer > Directory, if still listed: ${named.join(', ')}. gws-ea deleted their tokens from this host but cannot revoke the accounts.`,
      }
    : undefined;
}

export function onePasswordInstallNextActions(data: OnePasswordInstallData): readonly NextAction[] {
  const actions = distinctActions(data.assistants.flatMap(assistantActions));
  const revocation = onePasswordRevocation(
    data.assistants.map((entry) => ({
      instanceId: entry.instance_id,
      serviceAccountIds: entry.retired_service_account_ids,
    })),
  );
  return [
    ...(actions.length
      ? actions
      : [{ kind: 'command', argv: ['gws-ea', 'connectors', 'check', 'onepassword'] } as const]),
    ...(revocation ? [revocation] : []),
  ];
}

/** Handoffs follow observed facts; an unchecked or unknown fact is never evidence of readiness. */
export function onePasswordCapabilityNextActions(
  observation: OnePasswordCapabilityObservation,
  checked: boolean,
): readonly NextAction[] {
  if (observation.activation.status === 'disabled') return [installCommand()];
  if (observation.activation.status === 'unknown')
    return [{ kind: 'external', instruction: observation.activation.reason ?? 'Inspect the 1Password host policy.' }];
  const actions: NextAction[] = [];
  for (const assistant of observation.assistants) {
    if (assistant.unproven_creation)
      actions.push(
        {
          kind: 'external',
          instruction: pendingMessage(
            assistant.unproven_creation === 'vault' ? 'vault_creation_unproven' : 'service_account_creation_unproven',
            {},
          ),
        },
        installCommand('--discard-unproven', assistant.instance_id),
      );
    else if (assistant.compatibility === 'compatible' && assistant.provisioning !== 'ready')
      actions.push(installCommand());
    else if (assistant.compatibility === 'unsupported')
      actions.push({ kind: 'command', argv: ['gws-ea', 'update', '--id', assistant.instance_id] });
    else if (assistant.compatibility === 'unknown')
      actions.push({ kind: 'command', argv: ['gws-ea', 'status', '--id', assistant.instance_id] });
    else if (checked && assistant.access.status === 'failed')
      actions.push({
        kind: 'external',
        instruction: `Assistant ${assistant.instance_id} cannot read its vault: ${assistant.access.reason ?? 'unknown'} Inspect its runtime service account on 1Password.com.`,
      });
  }
  if (checked && observation.cli.status === 'unavailable') actions.push(installCommand());
  if (checked && observation.management.status === 'failed')
    actions.push({ kind: 'external', instruction: pendingMessage('management_unavailable', {}) });
  if (!checked) actions.push({ kind: 'command', argv: ['gws-ea', 'connectors', 'check', 'onepassword'] });
  return distinctActions(actions);
}

function usageLine(quota: OnePasswordQuota): string {
  if (quota.status === 'not_checked') return 'not checked';
  if (!quota.daily) return 'unknown';
  return `${quota.daily.used} of ${quota.daily.limit} used (${quota.daily.remaining} remaining)`;
}

/** Terminal facts from the same observation as machine output. */
export function onePasswordCapabilityLines(
  capability: OnePasswordCapabilityObservation,
  detailed: boolean,
  timezone = Intl.DateTimeFormat().resolvedOptions().timeZone,
): readonly string[] {
  const lines = [
    `${capability.name} (host): ${capability.summary}`,
    `  Activation: ${capability.activation.status}${capability.account_id ? `; account: ${capability.account_id}` : ''}`,
    ...(capability.account_id !== null
      ? [
          `  Management service account: ${capability.management.service_account_id ?? 'none'} (token ${capability.management.token}; ${capability.management.status.replace('_', ' ')})`,
          `  Account type: ${capability.quota.account_type ?? (capability.quota.status === 'not_checked' ? 'not checked' : 'unknown')}`,
          `  Daily requests: ${usageLine(capability.quota)}`,
          `  Shared by: ${capability.quota.sharing_assistant_ids.join(', ') || 'no assistant yet'}`,
        ]
      : []),
    `  Ready assistants: ${
      capability.assistants
        .filter((assistant) => assistant.provisioning === 'ready')
        .map((assistant) => assistant.instance_id)
        .join(', ') || 'none'
    }`,
    ...[capability.activation.reason, capability.management.reason, capability.cli.reason, capability.quota.reason]
      .filter((reason): reason is string => reason !== null)
      .map((reason) => `  ${reason}`),
  ];
  if (detailed)
    lines.push(
      `  Actions: ${capability.actions.join(', ')}`,
      `  CLI: ${capability.cli.path ?? 'not recorded'} (${capability.cli.status.replace('_', ' ')}${capability.cli.version ? ` ${capability.cli.version}` : ''})`,
      ...(capability.quota.hourly_per_token
        ? [
            `  Hourly per token: ${capability.quota.hourly_per_token.read ?? 'unknown'} reads, ${capability.quota.hourly_per_token.write ?? 'unknown'} writes`,
          ]
        : []),
      ...capability.prerequisites.map((line) => `  Prerequisite: ${line}`),
      ...capability.assistants.flatMap((assistant) => [
        `  Assistant ${assistant.instance_id}`,
        `    Release: ${assistant.compatibility}; provisioning: ${assistant.provisioning.replace('_', ' ')}`,
        `    Vault: ${assistant.vault_id ?? 'none'}; runtime account: ${assistant.runtime_service_account_id ?? 'none'}; token: ${assistant.runtime_token}`,
        ...(assistant.retired_service_account_ids.length
          ? [
              `    Retired runtime accounts, to revoke on 1Password.com: ${assistant.retired_service_account_ids.join(', ')}`,
            ]
          : []),
        `    Grants: operator ${assistant.recorded_grants.operator?.permissions.join(', ') ?? 'none'}; runtime ${assistant.recorded_grants.runtime?.join(', ') ?? 'none'}`,
        `    Access: ${assistant.access.status.replace('_', ' ')}; Write: ${assistant.write}`,
        ...(assistant.unproven_creation
          ? [`    Unproven creation: ${assistant.unproven_creation.replace('_', ' ')}`]
          : []),
        ...(assistant.access.reason ? [`    Access cause: ${assistant.access.reason}`] : []),
        ...(assistant.reason ? [`    Cause: ${assistant.reason}`] : []),
      ]),
      ...capability.readiness_limits.map((line) => `  ${line}`),
    );
  lines.push(`Observed: ${formatLocalTime(capability.observed_at, timezone)}`);
  return lines;
}

/** `command` is what a busy run retries, as it was given. */
export function onePasswordRecovery(
  error: unknown,
  command: 'install' | 'uninstall' = 'install',
): readonly NextAction[] {
  if (!(error instanceof GwsEaError)) return [];
  const external: NextAction = { kind: 'external', instruction: error.message };
  switch (error.code) {
    case 'onepassword_account_required': {
      const accounts = error.details?.accounts;
      const labels = error.details?.account_labels;
      if (!Array.isArray(accounts)) return [external];
      return accounts.flatMap((accountId: string, index: number): NextAction[] => [
        {
          kind: 'external',
          instruction: `Account ${accountId}: ${Array.isArray(labels) ? (labels[index] ?? '') : ''}`.trim(),
        },
        installCommand('--account', accountId),
      ]);
    }
    case 'onepassword_uninstall_incomplete':
      return [
        external,
        {
          kind: 'command',
          argv: [
            'gws-ea',
            'connectors',
            'uninstall',
            'onepassword',
            ...(error.details?.uninstall_completed === true ? ['--abandon'] : []),
          ],
        },
      ];
    case 'onepassword_removal_pending':
      return [external, { kind: 'command', argv: ['gws-ea', 'connectors', 'uninstall', 'onepassword'] }];
    case 'onepassword_management_unproven':
      return [external, installCommand('--discard-unproven', MANAGEMENT_TARGET)];
    case 'onepassword_busy':
    case 'instance_busy':
    case 'registry_busy':
      return [
        { kind: 'external', instruction: 'Let the other operation finish, then retry.' },
        { kind: 'command', argv: ['gws-ea', 'connectors', command, 'onepassword'] },
      ];
    case 'onepassword_cli_missing':
    case 'onepassword_cli_untrusted':
    case 'onepassword_cli_unavailable':
    case 'onepassword_cli_too_old':
    case 'onepassword_operator_sign_in_needed':
    case 'onepassword_sign_in_required':
    case 'onepassword_rate_limited':
    case 'onepassword_forbidden':
    case 'onepassword_provider_failed':
    case 'onepassword_account_unknown':
      return [external, installCommand()];
    case 'onepassword_account_mismatch':
      return [external, installCommand()];
    case 'onepassword_policy_invalid':
    case 'onepassword_management_unavailable':
    case 'onepassword_management_mismatch':
    case 'onepassword_wrong_account':
    case 'onepassword_binding_unavailable':
    case 'onepassword_nothing_unproven':
      return [external, { kind: 'command', argv: ['gws-ea', 'connectors', 'check', 'onepassword'] }];
    default:
      return [];
  }
}

/** Host-level errors that wait on a person rather than a repair. */
export function onePasswordErrorPauses(error: unknown): boolean {
  return (
    error instanceof GwsEaError &&
    [
      'onepassword_account_required',
      'onepassword_operator_sign_in_needed',
      'onepassword_uninstall_incomplete',
      'onepassword_removal_pending',
      'onepassword_sign_in_required',
      'onepassword_management_unproven',
      'onepassword_rate_limited',
    ].includes(error.code)
  );
}
