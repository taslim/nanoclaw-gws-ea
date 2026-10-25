/**
 * An assistant's 1Password resources at its removal. Before anything changes,
 * the IDs cleanup needs are copied from the instance into its removal receipt,
 * which lives outside the instance and so outlives its files. So is the name
 * of each creation never proven, a vault or runtime service account 1Password
 * may hold with no recorded ID: its intent record goes with the instance. Once
 * the host has stopped, the local runtime token goes. The vault is deleted only
 * when this host's management service account created it and it is empty, or
 * the operator chose its deletion in the removal's confirmation, and only
 * through that same account: any other vault is kept. Revoking a service
 * account, and deleting or revoking an unproven creation, is the operator's,
 * on 1Password.com; the receipt names each one until the operator closes it.
 */
import { lstat, rm } from 'node:fs/promises';

import { isErrno } from '../community-portal/errors.js';
import { OnePasswordCli, type ServiceAccountIdentity } from '../modules/gws-ea-browser/onepassword-cli.js';
import {
  isOnePasswordId,
  onePasswordHostPaths,
  onePasswordInstancePaths,
  readOnePasswordHostPolicy,
  readOnePasswordResources,
} from '../modules/gws-ea-browser/onepassword-policy.js';
import {
  creationAttempted,
  isManagementUnavailable,
  managementUnavailable,
  onePasswordRevocation,
  resourceNames,
  vaultCreationRecord,
  type OnePasswordCliSeams,
} from './onepassword.js';
import type { ControlPlanePaths } from './paths.js';
import type { NextAction } from './result.js';
import type { InstanceReservation } from './types.js';
import { canonicalTimestamp, isRecord } from './validation.js';

/** The operator's choice, in the removal's confirmation, for a vault that still holds items. */
export type OnePasswordVaultSelection = 'retain' | 'delete';
export type OnePasswordVaultOutcome = 'deleted' | 'retained' | 'gone';

/** A creation 1Password may have completed with no ID recorded: only its deterministic name finds it. */
export interface OnePasswordUnprovenCreation {
  readonly kind: 'vault' | 'service_account';
  readonly name: string;
}

/** Kept in the removal receipt: identifiers and outcomes, never a token. */
export interface OnePasswordCleanup {
  readonly account_id: string;
  /** Null when no vault was recorded; one whose creation was never proven is named in `unproven`. */
  readonly vault_id: string | null;
  /** The management service account that created the vault, the only one that may delete it; null for any other. */
  readonly vault_creator: string | null;
  /** Every runtime service account the assistant held, current and retired: only the operator can revoke them. */
  readonly runtime_service_account_ids: readonly string[];
  readonly unproven: readonly OnePasswordUnprovenCreation[];
  readonly selection: OnePasswordVaultSelection;
  /** What only the operator can do on 1Password.com; null when there is nothing to revoke or delete. */
  readonly operator_action: string | null;
  readonly runtime_token?: { readonly outcome: 'deleted' | 'absent'; readonly at: string };
  /** Recorded before the deletion request, so a later run tells its own deletion from a vault already gone. */
  readonly deletion_requested_at?: string;
  readonly vault?: {
    readonly outcome: OnePasswordVaultOutcome;
    readonly item_count: number | null;
    readonly reason: string;
    readonly at: string;
  };
}

export type OnePasswordCapture =
  | { readonly status: 'none' }
  | { readonly status: 'captured'; readonly cleanup: OnePasswordCleanup }
  | { readonly status: 'unreadable'; readonly reason: string; readonly evidence: string };

/** What removal will do with the vault, or did; shown before the operator confirms. */
export interface OnePasswordRemovalPreview {
  readonly account_id: string;
  /** Null, with `unrecorded`, when no vault was recorded. */
  readonly vault_id: string | null;
  /** Created by this host's management service account, so removal may delete it. */
  readonly owned: boolean;
  /** Null when it could not be read: never counted as empty. */
  readonly item_count: number | null;
  readonly vault: 'delete' | 'retain' | OnePasswordVaultOutcome | 'unrecorded';
  readonly reason: string;
  readonly runtime_service_account_ids: readonly string[];
  readonly unproven: readonly OnePasswordUnprovenCreation[];
}

export interface OnePasswordRemovalOutcome {
  readonly account_id: string;
  /** Null, with `unrecorded`, when no vault was recorded. */
  readonly vault_id: string | null;
  readonly vault: OnePasswordVaultOutcome | 'left_behind' | 'unrecorded';
  readonly item_count: number | null;
  readonly reason: string;
  readonly runtime_token: 'deleted' | 'absent';
  /** Runtime service accounts removal did not revoke: revoking is the operator's, on 1Password.com. */
  readonly revoke_service_account_ids: readonly string[];
  readonly unproven: readonly OnePasswordUnprovenCreation[];
  /** The receipt that keeps these until the operator closes it; null once nothing is tracked. */
  readonly receipt_file: string | null;
}

/** Why the vault cannot be settled now; removal pauses on it, or leaves the vault behind on request. */
export interface OnePasswordBlock {
  readonly reason: string;
  readonly evidence: string;
}

const now = (): string => new Date().toISOString();
const UNRECORDED = 'No vault was recorded for this assistant, so removal deletes none.';

export function onePasswordOperatorActions(
  instanceId: string,
  serviceAccountIds: readonly string[],
  unproven: readonly OnePasswordUnprovenCreation[],
): Extract<NextAction, { readonly kind: 'external' }>[] {
  const revocation = onePasswordRevocation([{ instanceId, serviceAccountIds }]);
  return [
    ...(revocation ? [revocation] : []),
    ...unproven.map(({ kind, name }) => ({
      kind: 'external' as const,
      instruction:
        kind === 'vault'
          ? `Assistant ${instanceId}: 1Password may hold a vault named "${name}" that gws-ea never recorded. Delete it on 1Password.com if it is listed.`
          : `Assistant ${instanceId}: 1Password may hold a runtime service account named "${name}" that gws-ea never verified. Revoke it on 1Password.com under Developer > Directory if it is listed.`,
    })),
  ];
}

function operatorAction(
  instanceId: string,
  ids: readonly string[],
  unproven: readonly OnePasswordUnprovenCreation[],
): string | null {
  return (
    onePasswordOperatorActions(instanceId, ids, unproven)
      .map((action) => action.instruction)
      .join(' ') || null
  );
}

/** The receipt still names something only the operator can settle on 1Password.com, so it stays until they close it. */
export function onePasswordCleanupOwed(cleanup: OnePasswordCleanup): boolean {
  return cleanup.runtime_service_account_ids.length > 0 || cleanup.unproven.length > 0;
}

export function onePasswordEvidence(cleanup: OnePasswordCleanup, reason: string): string {
  return [
    ...(cleanup.vault_id === null
      ? [`Vault: none recorded, in account ${cleanup.account_id}`]
      : [
          `Vault: ${cleanup.vault_id} in account ${cleanup.account_id}`,
          `Created by: ${cleanup.vault_creator ?? 'not this host'}`,
        ]),
    `Runtime service accounts to revoke: ${cleanup.runtime_service_account_ids.join(', ') || 'none'}`,
    ...(cleanup.unproven.length
      ? [
          `Never proven, to delete or revoke if listed: ${cleanup.unproven
            .map(({ kind, name }) => `${kind === 'vault' ? 'vault' : 'runtime service account'} "${name}"`)
            .join(', ')}`,
        ]
      : []),
    reason,
  ].join('\n');
}

/** Called before anything changes: the records it copies from go with the instance. */
export async function captureOnePasswordCleanup(
  paths: ControlPlanePaths,
  reservation: InstanceReservation,
  selection: OnePasswordVaultSelection,
): Promise<OnePasswordCapture> {
  const instanceId = reservation.instance_id;
  const files = onePasswordInstancePaths(paths.instanceRoot(instanceId));
  const names = resourceNames(reservation.exclusive_resource_claims.workspace_email, instanceId);
  const read = await readOnePasswordResources(files.resourceFile, { instanceId });
  if (read.status === 'invalid')
    return {
      status: 'unreadable',
      reason:
        "The assistant's 1Password record cannot be read safely, so removal cannot keep the vault and service account IDs it would need.",
      evidence: `Record: ${files.resourceFile} (${read.problem})`,
    };
  if (read.status === 'absent') {
    // An interrupted vault creation leaves only its intent: a vault 1Password may hold that only its name finds.
    if (!(await exists(vaultCreationRecord(files)))) return { status: 'none' };
    const { policyFile } = onePasswordHostPaths(paths.configRoot);
    const host = await readOnePasswordHostPolicy(policyFile);
    if (host.status !== 'ready')
      return {
        status: 'unreadable',
        reason:
          "1Password may hold a vault whose creation was never proven, and this host's 1Password policy, which names its account, cannot be read safely.",
        evidence: `Never proven, to delete if listed: vault "${names.vault}"\nPolicy: ${policyFile} (${host.status === 'absent' ? 'absent' : host.problem})`,
      };
    const unproven: OnePasswordUnprovenCreation[] = [{ kind: 'vault', name: names.vault }];
    return {
      status: 'captured',
      cleanup: {
        account_id: host.policy.accountId,
        vault_id: null,
        vault_creator: null,
        runtime_service_account_ids: [],
        unproven,
        selection,
        operator_action: operatorAction(instanceId, [], unproven),
      },
    };
  }
  const { resources } = read;
  const ids = [
    ...resources.retiredRuntimeServiceAccountIds,
    ...(resources.runtimeServiceAccountId === null ? [] : [resources.runtimeServiceAccountId]),
  ];
  // A runtime account minted but never verified, or whose minting was cut off, has no recorded ID either.
  const unproven: OnePasswordUnprovenCreation[] =
    resources.runtimeServiceAccountId === null && (await creationAttempted(files.runtimeTokenFile))
      ? [{ kind: 'service_account', name: names.runtimeServiceAccount }]
      : [];
  return {
    status: 'captured',
    cleanup: {
      account_id: resources.accountId,
      vault_id: resources.vault.id,
      vault_creator:
        resources.vault.createdBy.kind === 'management_service_account'
          ? resources.vault.createdBy.serviceAccountId
          : null,
      runtime_service_account_ids: ids,
      unproven,
      selection,
      operator_action: operatorAction(instanceId, ids, unproven),
    },
  };
}

/** This run's choice applies while the vault is unsettled. */
export function withSelection(cleanup: OnePasswordCleanup, selection: OnePasswordVaultSelection): OnePasswordCleanup {
  return cleanup.vault ? cleanup : { ...cleanup, selection };
}

function isIdList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isOnePasswordId) && new Set(value).size === value.length;
}

function isCount(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
}

function isVaultOutcome(value: unknown): value is OnePasswordVaultOutcome {
  return value === 'deleted' || value === 'retained' || value === 'gone';
}

function parseUnproven(value: unknown): OnePasswordUnprovenCreation[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries: unknown[] = value;
  const parsed: OnePasswordUnprovenCreation[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) return undefined;
    const { kind, name } = entry;
    if ((kind !== 'vault' && kind !== 'service_account') || typeof name !== 'string' || !name) return undefined;
    parsed.push({ kind, name });
  }
  return parsed;
}

/** The receipt's record, or undefined when any part is malformed: its IDs are then never assumed. */
export function parseOnePasswordCleanup(value: unknown): OnePasswordCleanup | undefined {
  if (!isRecord(value)) return undefined;
  const { account_id, vault_id, vault_creator, runtime_service_account_ids, selection, operator_action } = value;
  const unproven = parseUnproven(value.unproven);
  if (
    !isOnePasswordId(account_id) ||
    (vault_id !== null && !isOnePasswordId(vault_id)) ||
    // Only a recorded vault has a creator.
    (vault_creator !== null && (vault_id === null || !isOnePasswordId(vault_creator))) ||
    !isIdList(runtime_service_account_ids) ||
    !unproven ||
    (selection !== 'retain' && selection !== 'delete') ||
    (operator_action !== null && typeof operator_action !== 'string')
  )
    return undefined;
  let cleanup: OnePasswordCleanup = {
    account_id,
    vault_id,
    vault_creator,
    runtime_service_account_ids,
    unproven,
    selection,
    operator_action,
  };
  if (value.runtime_token !== undefined) {
    const token = value.runtime_token;
    if (!isRecord(token)) return undefined;
    const { outcome } = token;
    const at = canonicalTimestamp(token.at);
    if (!at || (outcome !== 'deleted' && outcome !== 'absent')) return undefined;
    cleanup = { ...cleanup, runtime_token: { outcome, at } };
  }
  if (value.deletion_requested_at !== undefined) {
    const at = canonicalTimestamp(value.deletion_requested_at);
    if (!at || vault_id === null) return undefined;
    cleanup = { ...cleanup, deletion_requested_at: at };
  }
  if (value.vault !== undefined) {
    const vault = value.vault;
    if (!isRecord(vault)) return undefined;
    const { outcome, item_count, reason } = vault;
    const at = canonicalTimestamp(vault.at);
    if (!at || vault_id === null || !isVaultOutcome(outcome) || !isCount(item_count) || typeof reason !== 'string')
      return undefined;
    cleanup = { ...cleanup, vault: { outcome, item_count, reason, at } };
  }
  return cleanup;
}

type Ownership =
  | { readonly status: 'not_owned'; readonly reason: string }
  | { readonly status: 'unavailable'; readonly reason: string }
  | { readonly status: 'owned'; readonly cli: OnePasswordCli; readonly management: ServiceAccountIdentity };

/** Whether this host may delete the vault, from local records alone, with no 1Password request. */
async function localOwnership(
  paths: ControlPlanePaths,
  cleanup: OnePasswordCleanup,
): Promise<
  | Exclude<Ownership, { readonly status: 'owned' }>
  | { readonly status: 'owned'; readonly cliPath: string; readonly management: ServiceAccountIdentity }
> {
  const hostPaths = onePasswordHostPaths(paths.configRoot);
  const read = await readOnePasswordHostPolicy(hostPaths.policyFile);
  if (read.status === 'invalid')
    return {
      status: 'unavailable',
      reason: `The 1Password host policy cannot be used safely (${read.problem}); inspect ${hostPaths.policyFile}.`,
    };
  const creator = cleanup.vault_creator;
  if (creator === null)
    return {
      status: 'not_owned',
      reason: "This host's management service account did not create it, so gws-ea never deletes it.",
    };
  if (read.status === 'absent')
    return {
      status: 'not_owned',
      reason: `This host no longer records the management service account ${creator} that created it, and only that account may delete it.`,
    };
  const { policy } = read;
  if (policy.accountId !== cleanup.account_id)
    return {
      status: 'not_owned',
      reason: `It is in 1Password account ${cleanup.account_id}, not this host's ${policy.accountId}, so gws-ea never deletes it.`,
    };
  if (policy.managementServiceAccountId !== creator)
    return {
      status: 'not_owned',
      reason: `Management service account ${creator} created it, not this host's ${policy.managementServiceAccountId ?? 'none'}; only the account that created a vault may delete it.`,
    };
  return {
    status: 'owned',
    cliPath: policy.cliPath,
    management: { kind: 'service_account', accountId: policy.accountId, tokenFile: hostPaths.managementTokenFile },
  };
}

/** The management account that created the vault, proven to be exactly it; never another one standing in for it. */
async function ownership(
  paths: ControlPlanePaths,
  cleanup: OnePasswordCleanup,
  seams: OnePasswordCliSeams | undefined,
): Promise<Ownership> {
  const local = await localOwnership(paths, cleanup);
  if (local.status !== 'owned') return local;
  const opening = await OnePasswordCli.open({ ...seams, command: local.cliPath });
  if (opening.status !== 'ready')
    return {
      status: 'unavailable',
      reason: `The 1Password CLI this host recorded (${local.cliPath}) cannot run (${opening.reason.replaceAll('_', ' ')}); install a current one, then retry.`,
    };
  const creator = cleanup.vault_creator ?? '';
  const who = await opening.cli.whoami(local.management);
  if (who.status === 'failed')
    return {
      status: 'unavailable',
      reason: isManagementUnavailable(who.reason)
        ? managementUnavailable(creator, local.management.tokenFile).message
        : `1Password answered ${who.reason.replaceAll('_', ' ')} for the host management service account ${creator}.`,
    };
  if (who.userId !== creator)
    return {
      status: 'unavailable',
      reason: `The host management token authenticates as another service account than ${creator}, which created the vault; it is never used in its place.`,
    };
  return { status: 'owned', cli: opening.cli, management: local.management };
}

function deletes(count: number | null, selection: OnePasswordVaultSelection): boolean {
  return count === 0 || selection === 'delete';
}

function keptReason(count: number | null): string {
  return count === null
    ? 'Its item count could not be read, so it is kept.'
    : 'It holds items, and its deletion was not chosen.';
}

/** Read before the operator confirms: two management reads at most, and no write. */
export async function previewOnePasswordCleanup(
  paths: ControlPlanePaths,
  cleanup: OnePasswordCleanup,
  seams: OnePasswordCliSeams | undefined,
): Promise<OnePasswordRemovalPreview> {
  const vaultId = cleanup.vault_id;
  const facts = {
    account_id: cleanup.account_id,
    vault_id: vaultId,
    runtime_service_account_ids: cleanup.runtime_service_account_ids,
    unproven: cleanup.unproven,
  };
  if (vaultId === null) return { ...facts, owned: false, item_count: null, vault: 'unrecorded', reason: UNRECORDED };
  const base = { ...facts, owned: (await localOwnership(paths, cleanup)).status === 'owned' };
  if (cleanup.vault)
    return {
      ...base,
      item_count: cleanup.vault.item_count,
      vault: cleanup.vault.outcome,
      reason: cleanup.vault.reason,
    };
  const owner = await ownership(paths, cleanup, seams);
  if (owner.status === 'not_owned') return { ...base, item_count: null, vault: 'retain', reason: owner.reason };
  const unreadable = (why: string): OnePasswordRemovalPreview =>
    cleanup.selection === 'delete'
      ? {
          ...base,
          item_count: null,
          vault: 'delete',
          reason: `${why} Deleting it needs that account, so removal will pause before any change.`,
        }
      : { ...base, item_count: null, vault: 'retain', reason: `${keptReason(null)} ${why}` };
  if (owner.status === 'unavailable') return unreadable(owner.reason);
  const got = await owner.cli.getVault(owner.management, vaultId);
  if (got.status === 'failed')
    return got.reason === 'not_found'
      ? { ...base, item_count: null, vault: 'gone', reason: 'It is already gone from 1Password.' }
      : unreadable(`1Password answered ${got.reason.replaceAll('_', ' ')} when its items were counted.`);
  return deletes(got.itemCount, cleanup.selection)
    ? {
        ...base,
        item_count: got.itemCount,
        vault: 'delete',
        reason: got.itemCount === 0 ? 'It holds no items.' : 'Its deletion was chosen with --delete-vault.',
      }
    : { ...base, item_count: got.itemCount, vault: 'retain', reason: keptReason(got.itemCount) };
}

/**
 * A chosen deletion needs the account that created the vault, so removal
 * checks it before anything changes. Undefined when nothing needs checking.
 */
export async function onePasswordDeletionBlock(
  paths: ControlPlanePaths,
  cleanup: OnePasswordCleanup,
  seams: OnePasswordCliSeams | undefined,
): Promise<OnePasswordBlock | undefined> {
  if (cleanup.vault || cleanup.vault_id === null || cleanup.selection !== 'delete') return undefined;
  const owner = await ownership(paths, cleanup, seams);
  return owner.status === 'unavailable'
    ? { reason: owner.reason, evidence: onePasswordEvidence(cleanup, 'The vault was chosen for deletion.') }
    : undefined;
}

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) return false;
    throw error;
  }
}

/**
 * Once the host has stopped: delete the local runtime token, then settle the
 * vault. Each step is recorded through `record` before the next, so a failure
 * at any point leaves a receipt naming what is done and what remains. A
 * deletion that did not happen blocks; a retained vault never needs 1Password
 * to answer.
 */
export async function settleOnePasswordCleanup(
  paths: ControlPlanePaths,
  instanceId: string,
  cleanup: OnePasswordCleanup,
  options: {
    readonly seams: OnePasswordCliSeams | undefined;
    readonly record: (next: OnePasswordCleanup) => Promise<void>;
  },
): Promise<OnePasswordBlock | undefined> {
  let current = cleanup;
  const save = async (next: OnePasswordCleanup): Promise<void> => {
    current = next;
    await options.record(next);
  };
  if (!current.runtime_token) {
    const { runtimeTokenFile } = onePasswordInstancePaths(paths.instanceRoot(instanceId));
    const present = await exists(runtimeTokenFile);
    // The instance's own file, deleted whatever its mode: it goes with the instance anyway.
    if (present) await rm(runtimeTokenFile, { force: true });
    await save({ ...current, runtime_token: { outcome: present ? 'deleted' : 'absent', at: now() } });
  }
  const vaultId = current.vault_id;
  if (current.vault || vaultId === null) return undefined;
  const settle = async (outcome: OnePasswordVaultOutcome, itemCount: number | null, reason: string) => {
    await save({ ...current, vault: { outcome, item_count: itemCount, reason, at: now() } });
    return undefined;
  };
  const blocked = (reason: string): OnePasswordBlock => ({ reason, evidence: onePasswordEvidence(current, reason) });

  const owner = await ownership(paths, current, options.seams);
  if (owner.status === 'not_owned') return settle('retained', null, owner.reason);
  if (owner.status === 'unavailable') {
    if (current.selection === 'delete') return blocked(owner.reason);
    return settle('retained', null, `${keptReason(null)} ${owner.reason}`);
  }
  const { cli, management } = owner;
  const got = await cli.getVault(management, vaultId);
  if (got.status === 'failed') {
    if (got.reason === 'not_found')
      return current.deletion_requested_at
        ? settle('deleted', null, 'Removal deleted it.')
        : settle('gone', null, 'It was already gone from 1Password.');
    const why = `1Password answered ${got.reason.replaceAll('_', ' ')} when its items were counted.`;
    if (current.selection === 'delete') return blocked(why);
    return settle('retained', null, `${keptReason(null)} ${why}`);
  }
  const count = got.itemCount;
  if (!deletes(count, current.selection)) return settle('retained', count, keptReason(count));

  if (!current.deletion_requested_at) await save({ ...current, deletion_requested_at: now() });
  const deleted = await cli.deleteVault(management, vaultId);
  // Whatever the request answered, only an observed absence counts as deleted.
  const after = await cli.getVault(management, vaultId);
  if (after.status === 'failed' && after.reason === 'not_found')
    return settle(
      'deleted',
      count,
      count === 0 ? 'It held no items.' : 'Its deletion, with every item it held, was chosen with the removal.',
    );
  return blocked(
    after.status === 'ok'
      ? `1Password did not delete vault ${vaultId}${deleted.status === 'failed' ? ` (it answered ${deleted.reason.replaceAll('_', ' ')})` : ''}; it is still there.`
      : `Whether 1Password deleted vault ${vaultId} is unknown: it answered ${after.reason.replaceAll('_', ' ')} when removal looked again. A retry looks before deleting anything.`,
  );
}

export function onePasswordRemovalOutcome(
  cleanup: OnePasswordCleanup,
  leftBehind: string | undefined,
  receiptFile: string | null,
): OnePasswordRemovalOutcome {
  const unrecorded = cleanup.vault_id === null;
  return {
    account_id: cleanup.account_id,
    vault_id: cleanup.vault_id,
    vault: unrecorded ? 'unrecorded' : (cleanup.vault?.outcome ?? 'left_behind'),
    item_count: cleanup.vault?.item_count ?? null,
    reason: unrecorded
      ? UNRECORDED
      : (cleanup.vault?.reason ?? leftBehind?.split('\n').at(-1) ?? 'Removal could not settle it.'),
    runtime_token: cleanup.runtime_token?.outcome ?? 'absent',
    revoke_service_account_ids: cleanup.runtime_service_account_ids,
    unproven: cleanup.unproven,
    receipt_file: receiptFile,
  };
}
