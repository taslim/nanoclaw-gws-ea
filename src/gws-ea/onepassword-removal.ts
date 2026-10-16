/**
 * An assistant's 1Password resources at its removal (KTD9, R14, R15). Before
 * anything changes, the IDs cleanup needs are copied from the instance into
 * its removal receipt, which lives outside the instance and so outlives its
 * files. Once the host has stopped, the local runtime token goes. The vault is
 * deleted only when this host's management service account created it and it
 * is empty, or the operator chose its deletion in the removal's confirmation,
 * and only through that same account: any other vault is kept. Revoking a
 * service account is the operator's, on 1Password.com; the receipt names each
 * one until the operator closes it.
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
import { managementUnavailable, onePasswordRevocation, type OnePasswordCliSeams } from './onepassword.js';
import type { ControlPlanePaths } from './paths.js';
import { canonicalTimestamp, isRecord } from './validation.js';

/** The operator's choice, in the removal's confirmation, for a vault that still holds items. */
export type OnePasswordVaultSelection = 'retain' | 'delete';
export type OnePasswordVaultOutcome = 'deleted' | 'retained' | 'gone';

/** What removal keeps in its receipt of an assistant's 1Password resources: identifiers and outcomes, never a token. */
export interface OnePasswordCleanup {
  readonly account_id: string;
  readonly vault_id: string;
  /** The management service account that created the vault, the only identity that may delete it; null for any other creator. */
  readonly vault_creator: string | null;
  /** Every runtime service account the assistant held, current and retired: only the operator can revoke them. */
  readonly runtime_service_account_ids: readonly string[];
  readonly selection: OnePasswordVaultSelection;
  /** What only the operator can do on 1Password.com; null when there is nothing to revoke. */
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
  readonly vault_id: string;
  /** Created by this host's management service account, so removal may delete it. */
  readonly owned: boolean;
  /** Null when it could not be read: never counted as empty. */
  readonly item_count: number | null;
  readonly vault: 'delete' | 'retain' | OnePasswordVaultOutcome;
  readonly reason: string;
  readonly runtime_service_account_ids: readonly string[];
}

/** What removal did, and what it leaves to the operator. */
export interface OnePasswordRemovalOutcome {
  readonly account_id: string;
  readonly vault_id: string;
  readonly vault: OnePasswordVaultOutcome | 'left_behind';
  readonly item_count: number | null;
  readonly reason: string;
  readonly runtime_token: 'deleted' | 'absent';
  /** Runtime service accounts removal did not revoke: revoking is the operator's, on 1Password.com. */
  readonly revoke_service_account_ids: readonly string[];
  /** The receipt that keeps these IDs until the operator closes it; null once nothing is tracked. */
  readonly receipt_file: string | null;
}

/** Why the vault cannot be settled now; removal pauses on it, or leaves the vault behind on request. */
export interface OnePasswordBlock {
  readonly reason: string;
  readonly evidence: string;
}

const now = (): string => new Date().toISOString();

function revocationText(ids: readonly string[], instanceId: string): string | null {
  return onePasswordRevocation([{ instanceId, serviceAccountIds: ids }])?.instruction ?? null;
}

/** The facts a pause or abandonment records: every ID the operator may need on 1Password.com. */
export function onePasswordEvidence(cleanup: OnePasswordCleanup, reason: string): string {
  return [
    `Vault: ${cleanup.vault_id} in account ${cleanup.account_id}`,
    `Created by: ${cleanup.vault_creator ?? 'not this host'}`,
    `Runtime service accounts to revoke: ${cleanup.runtime_service_account_ids.join(', ') || 'none'}`,
    reason,
  ].join('\n');
}

/** Copy the IDs removal needs from the assistant's own record, before anything changes. */
export async function captureOnePasswordCleanup(
  paths: ControlPlanePaths,
  instanceId: string,
  selection: OnePasswordVaultSelection,
): Promise<OnePasswordCapture> {
  const { resourceFile } = onePasswordInstancePaths(paths.instanceRoot(instanceId));
  const read = await readOnePasswordResources(resourceFile, { instanceId });
  if (read.status === 'absent') return { status: 'none' };
  if (read.status === 'invalid')
    return {
      status: 'unreadable',
      reason:
        "The assistant's 1Password record cannot be read safely, so removal cannot keep the vault and service account IDs it would need.",
      evidence: `Record: ${resourceFile} (${read.problem})`,
    };
  const { resources } = read;
  const ids = [
    ...resources.retiredRuntimeServiceAccountIds,
    ...(resources.runtimeServiceAccountId === null ? [] : [resources.runtimeServiceAccountId]),
  ];
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
      selection,
      operator_action: revocationText(ids, instanceId),
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

/** The receipt's record, or undefined when any part is malformed: its IDs are then never assumed. */
export function parseOnePasswordCleanup(value: unknown): OnePasswordCleanup | undefined {
  if (!isRecord(value)) return undefined;
  const { account_id, vault_id, vault_creator, runtime_service_account_ids, selection, operator_action } = value;
  if (
    !isOnePasswordId(account_id) ||
    !isOnePasswordId(vault_id) ||
    (vault_creator !== null && !isOnePasswordId(vault_creator)) ||
    !isIdList(runtime_service_account_ids) ||
    (selection !== 'retain' && selection !== 'delete') ||
    (operator_action !== null && typeof operator_action !== 'string')
  )
    return undefined;
  let cleanup: OnePasswordCleanup = {
    account_id,
    vault_id,
    vault_creator,
    runtime_service_account_ids,
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
    if (!at) return undefined;
    cleanup = { ...cleanup, deletion_requested_at: at };
  }
  if (value.vault !== undefined) {
    const vault = value.vault;
    if (!isRecord(vault)) return undefined;
    const { outcome, item_count, reason } = vault;
    const at = canonicalTimestamp(vault.at);
    if (!at || !isVaultOutcome(outcome) || !isCount(item_count) || typeof reason !== 'string') return undefined;
    cleanup = { ...cleanup, vault: { outcome, item_count, reason, at } };
  }
  return cleanup;
}

type Ownership =
  | { readonly status: 'not_owned'; readonly reason: string }
  | { readonly status: 'unavailable'; readonly reason: string }
  | { readonly status: 'owned'; readonly cli: OnePasswordCli; readonly management: ServiceAccountIdentity };

/** Whether this host may delete the vault, from local records alone: its account and its exact creator. */
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
      reason: ['not_signed_in', 'token_unavailable', 'not_found'].includes(who.reason)
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

/** An empty vault is deleted; one that holds items only on the operator's explicit choice. */
function deletes(count: number | null, selection: OnePasswordVaultSelection): boolean {
  return count === 0 || selection === 'delete';
}

function keptReason(count: number | null): string {
  return count === null
    ? 'Its item count could not be read, so it is kept.'
    : 'It holds items, and its deletion was not chosen.';
}

/** What removal will do with the vault, read before the operator confirms: two management reads at most, no write. */
export async function previewOnePasswordCleanup(
  paths: ControlPlanePaths,
  cleanup: OnePasswordCleanup,
  seams: OnePasswordCliSeams | undefined,
): Promise<OnePasswordRemovalPreview> {
  const base = {
    account_id: cleanup.account_id,
    vault_id: cleanup.vault_id,
    owned: (await localOwnership(paths, cleanup)).status === 'owned',
    runtime_service_account_ids: cleanup.runtime_service_account_ids,
  };
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
  const got = await owner.cli.getVault(owner.management, cleanup.vault_id);
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
  if (cleanup.vault || cleanup.selection !== 'delete') return undefined;
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
  if (current.vault) return undefined;
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
  const got = await cli.getVault(management, current.vault_id);
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
  const deleted = await cli.deleteVault(management, current.vault_id);
  // Whatever the request answered, only an observed absence counts as deleted.
  const after = await cli.getVault(management, current.vault_id);
  if (after.status === 'failed' && after.reason === 'not_found')
    return settle(
      'deleted',
      count,
      count === 0 ? 'It held no items.' : 'Its deletion, with every item it held, was chosen with the removal.',
    );
  return blocked(
    after.status === 'ok'
      ? `1Password did not delete vault ${current.vault_id}${deleted.status === 'failed' ? ` (it answered ${deleted.reason.replaceAll('_', ' ')})` : ''}; it is still there.`
      : `Whether 1Password deleted vault ${current.vault_id} is unknown: it answered ${after.reason.replaceAll('_', ' ')} when removal looked again. A retry looks before deleting anything.`,
  );
}

/** The result's account of the cleanup, once removal has run every step it could. */
export function onePasswordRemovalOutcome(
  cleanup: OnePasswordCleanup,
  leftBehind: string | undefined,
  receiptFile: string | null,
): OnePasswordRemovalOutcome {
  return {
    account_id: cleanup.account_id,
    vault_id: cleanup.vault_id,
    vault: cleanup.vault?.outcome ?? 'left_behind',
    item_count: cleanup.vault?.item_count ?? null,
    reason: cleanup.vault?.reason ?? leftBehind?.split('\n').at(-1) ?? 'Removal could not settle it.',
    runtime_token: cleanup.runtime_token?.outcome ?? 'absent',
    revoke_service_account_ids: cleanup.runtime_service_account_ids,
    receipt_file: receiptFile,
  };
}
