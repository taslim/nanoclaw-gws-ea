/** Host-wide vault removal. Ownership and verified deletion stay with the assistant-removal helpers. */
import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { isErrno } from '../community-portal/errors.js';
import {
  isOnePasswordId,
  onePasswordHostPaths,
  onePasswordInstancePaths,
  readOnePasswordHostPolicy,
  writeOnePasswordHostPolicy,
} from '../modules/gws-ea-browser/onepassword-policy.js';
import { runInstanceNclJson } from './ncl.js';
import {
  creationAttempted,
  withOnePasswordAssistantLocks,
  withOnePasswordHostLock,
  vaultCreationRecord,
  type OnePasswordDependencies,
} from './onepassword.js';
import {
  captureOnePasswordCleanup,
  onePasswordRemovalOutcome,
  parseOnePasswordCleanup,
  previewOnePasswordCleanup,
  settleOnePasswordCleanup,
  type OnePasswordCleanup,
  type OnePasswordRemovalOutcome,
  type OnePasswordRemovalPreview,
} from './onepassword-removal.js';
import { preparePrivateDirectory, type ControlPlanePaths } from './paths.js';
import { readRegistry } from './registry.js';
import type { Changed } from './result.js';
import { readOwnerOnlyFile, removePrivateFile, writePrivateTextFile } from './secrets.js';
import { loadInstanceRuntimeConfig } from './service.js';
import { GwsEaError } from './types.js';
import { INSTANCE_ID_PATTERN, isRecord, canonicalTimestamp } from './validation.js';

interface UninstallAssistant {
  readonly cleanup: OnePasswordCleanup;
  readonly resources_removed: boolean;
}
interface UninstallGeneration {
  readonly account_id: string | null;
  readonly management_service_account_id: string | null;
  readonly management_creation_unproven: boolean;
  readonly started_at: string;
  readonly assistants: Readonly<Record<string, UninstallAssistant>>;
}
export interface OnePasswordUninstallReceipt extends UninstallGeneration {
  readonly schema_version: 1;
  readonly completed: boolean;
  /** Earlier completed uninstalls stay visible until the operator acknowledges the receipt. */
  readonly history: readonly UninstallGeneration[];
}
export interface OnePasswordUninstallInspection {
  readonly status: 'absent' | 'incomplete' | 'completed';
  readonly incomplete: boolean;
  readonly receipt_file: string | null;
  readonly receipt: OnePasswordUninstallReceipt | null;
  readonly revoke_service_account_ids: readonly string[];
}
export interface OnePasswordUninstallPreview {
  readonly account_id: string | null;
  readonly management_service_account_id: string | null;
  readonly management_creation_unproven: boolean;
  readonly vaults: readonly (OnePasswordRemovalPreview & {
    readonly instance_id: string;
    /** Unknown while the assistant is stopped or unreachable; never inferred to be empty. */
    readonly credential_attempts: number | null;
  })[];
}
export interface OnePasswordUninstallData {
  readonly name: 'onepassword';
  readonly scope: 'host';
  readonly outcome: 'paused' | 'completed';
  readonly changed: Changed;
  readonly preview: OnePasswordUninstallPreview;
  readonly assistants: readonly (OnePasswordRemovalOutcome & { readonly instance_id: string })[];
  readonly receipt_file: string | null;
  readonly revoke_service_account_ids: readonly string[];
  readonly reason: string | null;
}
export interface OnePasswordUninstallDependencies extends Pick<
  OnePasswordDependencies,
  'cli' | 'recordEffect' | 'rateLimitState'
> {
  readonly ncl?: typeof runInstanceNclJson;
}
export interface OnePasswordUninstallRequest {
  readonly deleteVaults?: boolean;
  /** Terminal confirmation applies only to the account, assistants and vaults shown to the operator. */
  readonly confirmedPreview?: OnePasswordUninstallPreview;
  /** Acknowledges completion of manual revocation/deletion kept in a completed receipt. */
  readonly abandon?: boolean;
}

export function onePasswordUninstallFile(paths: ControlPlanePaths): string {
  return path.join(paths.configRoot, 'connectors', 'onepassword-uninstall.json');
}

function invalidReceipt(): GwsEaError {
  return new GwsEaError(
    'onepassword_uninstall_receipt_invalid',
    'The 1Password uninstall receipt cannot be read safely. Inspect its owner-only file before continuing.',
  );
}
async function readReceipt(paths: ControlPlanePaths): Promise<OnePasswordUninstallReceipt | undefined> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readOwnerOnlyFile(onePasswordUninstallFile(paths)));
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    if (error instanceof SyntaxError) throw invalidReceipt();
    throw error;
  }
  if (!isRecord(raw) || raw.schema_version !== 1 || typeof raw.completed !== 'boolean' || !Array.isArray(raw.history))
    throw invalidReceipt();
  const current = parseGeneration(raw);
  const history = raw.history.map(parseGeneration);
  return { schema_version: 1, ...current, completed: raw.completed, history };
}

function parseGeneration(raw: unknown): UninstallGeneration {
  if (
    !isRecord(raw) ||
    (raw.account_id !== null && !isOnePasswordId(raw.account_id)) ||
    (raw.management_service_account_id !== null && !isOnePasswordId(raw.management_service_account_id)) ||
    typeof raw.management_creation_unproven !== 'boolean' ||
    typeof raw.started_at !== 'string' ||
    !Number.isFinite(Date.parse(raw.started_at)) ||
    !isRecord(raw.assistants)
  )
    throw invalidReceipt();
  const assistants: Record<string, UninstallAssistant> = {};
  for (const [id, entry] of Object.entries(raw.assistants)) {
    if (!INSTANCE_ID_PATTERN.test(id) || !isRecord(entry) || typeof entry.resources_removed !== 'boolean')
      throw invalidReceipt();
    const cleanup = parseOnePasswordCleanup(entry.cleanup);
    if (!cleanup) throw invalidReceipt();
    assistants[id] = { cleanup, resources_removed: entry.resources_removed };
  }
  return {
    account_id: raw.account_id,
    management_service_account_id: raw.management_service_account_id,
    management_creation_unproven: raw.management_creation_unproven,
    started_at: raw.started_at,
    assistants,
  };
}

function archive(receipt: OnePasswordUninstallReceipt): UninstallGeneration {
  const { account_id, management_service_account_id, management_creation_unproven, started_at, assistants } = receipt;
  return { account_id, management_service_account_id, management_creation_unproven, started_at, assistants };
}

function revocations(receipt: OnePasswordUninstallReceipt): string[] {
  return [
    ...new Set([
      ...[...receipt.history, receipt].flatMap((generation) => [
        ...(generation.management_service_account_id ? [generation.management_service_account_id] : []),
        ...Object.values(generation.assistants).flatMap(({ cleanup }) => [
          ...(cleanup.vault_creator ? [cleanup.vault_creator] : []),
          ...cleanup.runtime_service_account_ids,
        ]),
      ]),
    ]),
  ];
}

/** Local receipt only: no process, provider request or repair. */
export async function inspectOnePasswordUninstall(paths: ControlPlanePaths): Promise<OnePasswordUninstallInspection> {
  const receipt = await readReceipt(paths);
  if (!receipt)
    return { status: 'absent', incomplete: false, receipt_file: null, receipt: null, revoke_service_account_ids: [] };
  const incomplete =
    !receipt.completed ||
    [...receipt.history, receipt].some((generation) =>
      Object.values(generation.assistants).some(({ cleanup }) => cleanup.unproven.some(({ kind }) => kind === 'vault')),
    );
  return {
    status: incomplete ? 'incomplete' : 'completed',
    incomplete,
    receipt_file: onePasswordUninstallFile(paths),
    receipt,
    revoke_service_account_ids: revocations(receipt),
  };
}

async function snapshot(paths: ControlPlanePaths): Promise<OnePasswordUninstallReceipt | undefined> {
  const existing = await readReceipt(paths);
  if (existing && !existing.completed) return existing;
  const host = onePasswordHostPaths(paths.configRoot);
  const read = await readOnePasswordHostPolicy(host.policyFile);
  if (read.status === 'invalid')
    throw new GwsEaError(
      'onepassword_policy_invalid',
      'Restore the owner-only 1Password host policy before uninstalling.',
    );
  if (existing && read.status === 'absent') return existing;
  const managementCreation = read.status === 'absent' && (await creationAttempted(host.managementTokenFile));
  const assistants: Record<string, UninstallAssistant> = {};
  for (const reservation of Object.values((await readRegistry(paths)).instances)) {
    const captured = await captureOnePasswordCleanup(paths, reservation, 'delete');
    if (captured.status === 'unreadable')
      throw new GwsEaError('onepassword_resources_invalid', `${captured.reason} ${captured.evidence}`);
    if (captured.status === 'captured')
      assistants[reservation.instance_id] = { cleanup: captured.cleanup, resources_removed: false };
  }
  if (read.status === 'absent' && !managementCreation && !Object.keys(assistants).length) return undefined;
  return {
    schema_version: 1,
    account_id: read.status === 'ready' ? read.policy.accountId : null,
    management_service_account_id: read.status === 'ready' ? read.policy.managementServiceAccountId : null,
    management_creation_unproven: managementCreation,
    started_at: new Date().toISOString(),
    completed: false,
    assistants,
    history: existing ? [...existing.history, archive(existing)] : [],
  };
}

async function preview(
  paths: ControlPlanePaths,
  receipt: OnePasswordUninstallReceipt | undefined,
  dependencies: OnePasswordUninstallDependencies,
  rateLimitState = { limited: false },
): Promise<OnePasswordUninstallPreview> {
  const vaults: OnePasswordUninstallPreview['vaults'][number][] = [];
  for (const [id, { cleanup }] of Object.entries(receipt?.assistants ?? {})) {
    let attempts: number | null = null;
    try {
      const runtime = await loadInstanceRuntimeConfig(paths.runtimeFile(id));
      const health: unknown = await (dependencies.ncl ?? runInstanceNclJson)(runtime, ['gws-ea-browser-health']);
      if (
        isRecord(health) &&
        typeof health.credentialAttempts === 'number' &&
        Number.isSafeInteger(health.credentialAttempts) &&
        health.credentialAttempts >= 0
      )
        attempts = health.credentialAttempts;
    } catch (error) {
      // The preview preserves unknown work while a host is stopped; deletion still needs explicit confirmation.
      if (!(error instanceof Error)) throw error;
    }
    vaults.push({
      instance_id: id,
      ...(await previewOnePasswordCleanup(paths, cleanup, dependencies.cli, rateLimitState)),
      credential_attempts: attempts,
    });
  }
  return {
    account_id: receipt?.account_id ?? null,
    management_service_account_id: receipt?.management_service_account_id ?? null,
    management_creation_unproven: receipt?.management_creation_unproven ?? false,
    vaults,
  };
}

/** Read-only deletion preview; unknown item counts and credential work remain unknown. */
export async function previewOnePasswordUninstall(
  paths: ControlPlanePaths,
  dependencies: OnePasswordUninstallDependencies = {},
): Promise<OnePasswordUninstallPreview> {
  return preview(paths, await snapshot(paths), dependencies, dependencies.rateLimitState);
}

/** Compare deletion authority locally while holding the host and every affected assistant lock. */
async function matchesConfirmedPreview(
  paths: ControlPlanePaths,
  receipt: OnePasswordUninstallReceipt | undefined,
  confirmed: OnePasswordUninstallPreview,
): Promise<boolean> {
  if (
    (receipt?.account_id ?? null) !== confirmed.account_id ||
    (receipt?.management_service_account_id ?? null) !== confirmed.management_service_account_id ||
    (receipt?.management_creation_unproven ?? false) !== confirmed.management_creation_unproven
  )
    return false;
  const assistants = Object.entries(receipt?.assistants ?? {});
  if (assistants.length !== confirmed.vaults.length) return false;
  const host = await readOnePasswordHostPolicy(onePasswordHostPaths(paths.configRoot).policyFile);
  return assistants.every(([id, { cleanup }]) => {
    const approved = confirmed.vaults.find(({ instance_id }) => instance_id === id);
    const owned =
      cleanup.vault_creator !== null &&
      host.status === 'ready' &&
      host.policy.accountId === cleanup.account_id &&
      host.policy.managementServiceAccountId === cleanup.vault_creator;
    return (
      approved !== undefined &&
      approved.account_id === cleanup.account_id &&
      approved.vault_id === cleanup.vault_id &&
      approved.owned === owned
    );
  });
}

async function assertRemovalReceiptsSettled(
  paths: ControlPlanePaths,
  receipt: OnePasswordUninstallReceipt,
): Promise<void> {
  let names: string[];
  try {
    names = await readdir(paths.removalRoot);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return;
    throw error;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const raw: unknown = JSON.parse(await readOwnerOnlyFile(path.join(paths.removalRoot, name)));
    if (!isRecord(raw) || raw.onepassword === undefined) continue;
    const cleanup = parseOnePasswordCleanup(raw.onepassword);
    if (!cleanup)
      throw new GwsEaError(
        'onepassword_removal_pending',
        `Assistant removal receipt ${name} has unreadable 1Password ownership. Finish that removal first.`,
      );
    const abandoned = isRecord(raw.abandoned) ? raw.abandoned.onepassword : undefined;
    if (isRecord(abandoned) && typeof abandoned.evidence === 'string' && canonicalTimestamp(abandoned.at)) continue;
    if (
      cleanup.vault_id !== null &&
      !cleanup.vault &&
      cleanup.vault_creator !== null &&
      cleanup.vault_creator === receipt.management_service_account_id &&
      cleanup.account_id === receipt.account_id
    )
      throw new GwsEaError(
        'onepassword_removal_pending',
        `Assistant removal receipt ${name} still needs the management account to settle its vault. Finish that removal first.`,
      );
  }
}

function result(
  receipt: OnePasswordUninstallReceipt | undefined,
  previewData: OnePasswordUninstallPreview,
  changed: Changed,
  reason: string | null,
  paths: ControlPlanePaths,
  persisted = true,
): OnePasswordUninstallData {
  const file = receipt && persisted ? onePasswordUninstallFile(paths) : null;
  return {
    name: 'onepassword',
    scope: 'host',
    outcome: reason === null ? 'completed' : 'paused',
    changed,
    preview: previewData,
    assistants: Object.entries(receipt?.assistants ?? {}).map(([id, { cleanup }]) => ({
      instance_id: id,
      ...onePasswordRemovalOutcome(cleanup, undefined, file),
    })),
    receipt_file: file,
    revoke_service_account_ids: receipt ? revocations(receipt) : [],
    reason,
  };
}

/** Stops all use first, then deletes only recorded owned vaults, with a receipt before every next step. */
export async function uninstallOnePassword(
  paths: ControlPlanePaths,
  request: OnePasswordUninstallRequest = {},
  dependencies: OnePasswordUninstallDependencies = {},
): Promise<OnePasswordUninstallData> {
  const persisted = await readReceipt(paths);
  const initial = request.abandon ? persisted : await snapshot(paths);
  const rateLimitState = dependencies.rateLimitState ?? { limited: false };
  const previewData = await preview(paths, initial, dependencies, rateLimitState);
  const confirmedPreview = request.abandon ? undefined : request.confirmedPreview;
  if (!initial && !confirmedPreview) return result(undefined, previewData, false, null, paths);
  if (!request.deleteVaults && !confirmedPreview && !request.abandon && initial && !initial.completed)
    return result(
      initial,
      previewData,
      false,
      'Confirm deletion of every owned vault and its items with --delete-vaults, or in the operator terminal.',
      paths,
      persisted !== undefined,
    );
  if (rateLimitState.limited)
    return result(
      initial,
      previewData,
      false,
      '1Password is rate limited. Rerun uninstall once its request limit resets.',
      paths,
      persisted !== undefined,
    );
  let changed: Changed = false;
  const starting = (): void => {
    if (changed === false) changed = null;
    dependencies.recordEffect?.(null);
  };
  const done = (): void => {
    changed = true;
    dependencies.recordEffect?.(true);
  };
  return withOnePasswordHostLock(paths, async () => {
    const registered = Object.keys((await readRegistry(paths)).instances).sort();
    const ids = [...new Set([...registered, ...Object.keys(initial?.assistants ?? {})])].sort();
    return withOnePasswordAssistantLocks(paths, ids, async () => {
      if (JSON.stringify(Object.keys((await readRegistry(paths)).instances).sort()) !== JSON.stringify(registered))
        throw new GwsEaError(
          'onepassword_registry_changed',
          'The assistant registry changed while uninstall acquired its locks. Retry before anything changes.',
        );
      const currentSnapshot = request.abandon ? await readReceipt(paths) : await snapshot(paths);
      if (confirmedPreview && !(await matchesConfirmedPreview(paths, currentSnapshot, confirmedPreview)))
        return result(
          currentSnapshot,
          await preview(paths, currentSnapshot, dependencies, rateLimitState),
          false,
          'The 1Password account, assistants or vaults changed after the deletion preview. Review the fresh preview and confirm again.',
          paths,
          (await readReceipt(paths)) !== undefined,
        );
      if (!currentSnapshot) return result(undefined, previewData, changed, null, paths);
      let receipt: OnePasswordUninstallReceipt = currentSnapshot;
      if (request.abandon) {
        if (!receipt.completed)
          throw new GwsEaError(
            'onepassword_uninstall_incomplete',
            'Finish uninstalling the recorded resources before closing its receipt.',
          );
        starting();
        await removePrivateFile(onePasswordUninstallFile(paths));
        done();
        return result(undefined, previewData, changed, null, paths);
      }
      if (receipt.completed) return result(receipt, previewData, changed, null, paths);
      await assertRemovalReceiptsSettled(paths, receipt);
      const save = async (next: OnePasswordUninstallReceipt): Promise<void> => {
        await preparePrivateDirectory(path.dirname(onePasswordUninstallFile(paths)));
        starting();
        await writePrivateTextFile(onePasswordUninstallFile(paths), `${JSON.stringify(next)}\n`);
        receipt = next;
        done();
      };
      await save(receipt);
      const host = onePasswordHostPaths(paths.configRoot);
      const current = await readOnePasswordHostPolicy(host.policyFile);
      if (current.status === 'invalid')
        throw new GwsEaError(
          'onepassword_policy_invalid',
          'The 1Password host policy changed during uninstall. Restore it before retrying.',
        );
      if (current.status === 'ready') {
        if (
          current.policy.accountId !== receipt.account_id ||
          current.policy.managementServiceAccountId !== receipt.management_service_account_id
        )
          throw new GwsEaError(
            'onepassword_owner_mismatch',
            'The host management identity differs from the uninstall receipt; no vault is deleted.',
          );
        if (current.policy.enabled) {
          starting();
          await writeOnePasswordHostPolicy(host.policyFile, { ...current.policy, enabled: false });
          done();
        }
      }
      for (const [id, captured] of Object.entries(receipt.assistants)) {
        if (captured.resources_removed) continue;
        const blocked = await settleOnePasswordCleanup(paths, id, captured.cleanup, {
          seams: dependencies.cli,
          deleteRuntimeToken: false,
          retainUnverifiedOwnership: true,
          record: async (cleanup) => {
            await save({
              ...receipt,
              assistants: { ...receipt.assistants, [id]: { cleanup, resources_removed: false } },
            });
          },
        });
        if (blocked) return result(receipt, previewData, changed, blocked.reason, paths);
        const files = onePasswordInstancePaths(paths.instanceRoot(id));
        const tokenPresent = await readOwnerOnlyFile(files.runtimeTokenFile).then(
          () => true,
          (error: unknown) => {
            if (isErrno(error, 'ENOENT')) return false;
            throw error;
          },
        );
        starting();
        await removePrivateFile(files.runtimeTokenFile);
        await removePrivateFile(`${files.runtimeTokenFile}.pending`);
        await removePrivateFile(files.resourceFile);
        await removePrivateFile(vaultCreationRecord(files));
        done();
        const cleanup = receipt.assistants[id].cleanup;
        await save({
          ...receipt,
          assistants: {
            ...receipt.assistants,
            [id]: {
              resources_removed: true,
              cleanup: {
                ...cleanup,
                runtime_token: { outcome: tokenPresent ? 'deleted' : 'absent', at: new Date().toISOString() },
              },
            },
          },
        });
      }
      starting();
      await removePrivateFile(host.managementTokenFile);
      await removePrivateFile(`${host.managementTokenFile}.pending`);
      await removePrivateFile(host.policyFile);
      done();
      await save({ ...receipt, completed: true });
      return result(receipt, previewData, changed, null, paths);
    });
  });
}
