import path from 'node:path';

import { isErrno } from '../community-portal/errors.js';
import { processLock } from '../community-portal/process-lock.js';
import { readArtifactsPolicy } from '../modules/gws-ea-artifacts/policy.js';
import {
  artifactsOperatorFiles,
  readArtifactsOperatorConfig,
  writeArtifactsOperatorConfig,
} from './artifacts-cloudflare.js';
import { parseArtifactsCleanup, settleArtifactsCleanup, type ArtifactsCleanup } from './artifacts-removal.js';
import type { ArtifactsCapabilityDependencies } from './artifacts-connector.js';
import { preparePrivateDirectory, type ControlPlanePaths } from './paths.js';
import { readRegistry, releaseInstanceArtifacts, withMachineLock } from './registry.js';
import { readOwnerOnlyJson, removePrivateFile, writePrivateTextFile } from './secrets.js';
import { GwsEaError } from './types.js';
import { INSTANCE_ID_PATTERN, isRecord } from './validation.js';

export interface ArtifactsUninstallReceipt {
  readonly schemaVersion: 1;
  readonly started_at: string;
  readonly assistants: Readonly<Record<string, ArtifactsCleanup>>;
  readonly completed_assistant_ids: readonly string[];
  readonly shared: ArtifactsCleanup;
  readonly stopped: boolean;
  readonly reason: string | null;
}

export interface ArtifactsConnectorUninstallData {
  readonly name: 'artifacts';
  readonly scope: 'host';
  readonly installed: false;
  readonly outcome: 'removed' | 'pending';
  readonly changed: boolean;
  readonly reason: string | null;
  readonly receipt_file: string | null;
}

export function artifactsUninstallFile(paths: Pick<ControlPlanePaths, 'configRoot'>): string {
  return path.join(paths.configRoot, 'connectors', 'artifacts-uninstall.json');
}

/** Shared by install, operation-scoped provisioning and uninstall; never waits on another operation. */
export async function withArtifactsHostLock<T>(paths: ControlPlanePaths, work: () => Promise<T>): Promise<T> {
  const root = path.join(paths.configRoot, 'connectors');
  await preparePrivateDirectory(root);
  const release = await processLock(path.join(root, 'artifacts.lock'));
  if (!release) throw new GwsEaError('artifacts_busy', 'Another artifacts connector operation is in progress.');
  try {
    return await work();
  } finally {
    release();
  }
}

/** Local evidence only. A malformed receipt refuses new provisioning rather than silently adopting resources. */
export async function inspectArtifactsUninstall(
  paths: ControlPlanePaths,
): Promise<ArtifactsUninstallReceipt | undefined> {
  let raw: unknown;
  try {
    raw = await readOwnerOnlyJson(
      artifactsUninstallFile(paths),
      'Artifacts uninstall receipt',
      'artifacts_uninstall_invalid',
    );
  } catch (cause) {
    if (isErrno(cause, 'ENOENT')) return undefined;
    throw cause;
  }
  const invalid = (): never => {
    throw new GwsEaError(
      'artifacts_uninstall_invalid',
      'The artifacts uninstall receipt is invalid; restore its owner-only record.',
    );
  };
  if (
    !isRecord(raw) ||
    raw.schemaVersion !== 1 ||
    typeof raw.started_at !== 'string' ||
    !Number.isFinite(Date.parse(raw.started_at)) ||
    !isRecord(raw.assistants) ||
    !Array.isArray(raw.completed_assistant_ids) ||
    !raw.completed_assistant_ids.every((id): id is string => typeof id === 'string' && INSTANCE_ID_PATTERN.test(id)) ||
    typeof raw.stopped !== 'boolean' ||
    (raw.reason !== null && typeof raw.reason !== 'string')
  )
    return invalid();
  const assistants: Record<string, ArtifactsCleanup> = {};
  for (const [id, value] of Object.entries(raw.assistants)) {
    const cleanup = parseArtifactsCleanup(value);
    if (
      !INSTANCE_ID_PATTERN.test(id) ||
      !cleanup ||
      Object.keys(cleanup.ownership.assistants).some((key) => key !== id)
    )
      return invalid();
    assistants[id] = cleanup;
  }
  if (raw.completed_assistant_ids.some((id) => !(id in assistants))) return invalid();
  const shared = parseArtifactsCleanup(raw.shared);
  if (!shared || Object.keys(shared.ownership.assistants).length !== 0) return invalid();
  return {
    schemaVersion: 1,
    started_at: raw.started_at,
    assistants,
    completed_assistant_ids: raw.completed_assistant_ids,
    shared,
    stopped: raw.stopped,
    reason: raw.reason,
  };
}

async function recordReceipt(paths: ControlPlanePaths, receipt: ArtifactsUninstallReceipt): Promise<void> {
  await writePrivateTextFile(artifactsUninstallFile(paths), `${JSON.stringify(receipt)}\n`);
}

async function withInstanceLocks<T>(
  paths: ControlPlanePaths,
  ids: readonly string[],
  work: () => Promise<T>,
): Promise<T> {
  const releases: (() => void)[] = [];
  try {
    for (const id of ids) {
      await preparePrivateDirectory(path.dirname(paths.instanceLock(id)));
      const release = await processLock(paths.instanceLock(id));
      if (!release) throw new GwsEaError('instance_busy', `Assistant ${id} is undergoing another operation.`);
      releases.push(release);
    }
    return await work();
  } finally {
    for (const release of releases.reverse()) release();
  }
}

/** Close every origin before remote effects, then resume exact ownership records until shared cleanup finishes. */
export async function uninstallArtifactsConnector(
  paths: ControlPlanePaths,
  dependencies: ArtifactsCapabilityDependencies = {},
): Promise<ArtifactsConnectorUninstallData> {
  return withArtifactsHostLock(paths, async () => {
    let receipt = await inspectArtifactsUninstall(paths);
    const files = artifactsOperatorFiles(paths);
    const config = await readArtifactsOperatorConfig(files.configFile);
    const registry = await readRegistry(paths);
    const ids = [
      ...new Set([
        ...Object.keys(registry.instances),
        ...Object.keys(config?.assistants ?? {}),
        ...Object.keys(receipt?.assistants ?? {}),
      ]),
    ].sort();
    let changed = false;
    const effect = async (): Promise<void> => {
      changed = true;
      await dependencies.recordEffect?.(true);
    };
    return withInstanceLocks(paths, ids, async () => {
      // The host lock excludes connector provisioning and all instance locks exclude create/update/removal.
      const currentRegistry = await readRegistry(paths);
      if (Object.keys(currentRegistry.instances).some((id) => !ids.includes(id)))
        throw new GwsEaError(
          'artifacts_busy',
          'The assistant registry changed while artifacts uninstall acquired its locks. Retry uninstall.',
        );
      if (
        !receipt &&
        !config &&
        Object.values(currentRegistry.instances).some((reservation) => reservation.exclusive_resource_claims.artifacts)
      )
        throw new GwsEaError('artifacts_owner_missing', 'A claimed artifact namespace has no owned resource record.');
      if (!receipt && !config)
        return {
          name: 'artifacts',
          scope: 'host',
          installed: false,
          outcome: 'removed',
          changed: false,
          reason: null,
          receipt_file: null,
        };
      if (!receipt) {
        if (!config) throw new GwsEaError('artifacts_owner_missing', 'Artifacts ownership is unavailable.');
        const assistants: Record<string, ArtifactsCleanup> = {};
        for (const [id, assistant] of Object.entries(config.assistants).sort(([left], [right]) =>
          left.localeCompare(right),
        )) {
          const claim = currentRegistry.instances[id]?.exclusive_resource_claims.artifacts;
          if (claim && JSON.stringify(claim) !== JSON.stringify(assistant.claim))
            throw new GwsEaError(
              'artifacts_owner_mismatch',
              'A recorded artifact namespace differs from its registry claim.',
            );
          assistants[id] = {
            schemaVersion: 1,
            ownership: { ...config, assistants: { [id]: assistant } },
            completed: [],
            sharedRetained: false,
          };
        }
        if (
          Object.values(currentRegistry.instances).some(
            (reservation) => reservation.exclusive_resource_claims.artifacts && !assistants[reservation.instance_id],
          )
        )
          throw new GwsEaError('artifacts_owner_missing', 'A claimed artifact namespace has no owned resource record.');
        receipt = {
          schemaVersion: 1,
          started_at: new Date().toISOString(),
          assistants,
          completed_assistant_ids: [],
          shared: { schemaVersion: 1, ownership: { ...config, assistants: {} }, completed: [], sharedRetained: false },
          stopped: false,
          reason: null,
        };
        await dependencies.recordEffect?.(null);
        await recordReceipt(paths, receipt);
        await effect();
      }
      if (!receipt.stopped) {
        for (const id of ids) {
          const file = path.join(paths.instanceRoot(id), 'artifacts', 'policy.json');
          const policy = await readArtifactsPolicy(file);
          if (policy.status !== 'unavailable' && policy.config?.enabled) {
            await dependencies.recordEffect?.(null);
            await writePrivateTextFile(file, `${JSON.stringify({ ...policy.config, enabled: false })}\n`);
            await effect();
          }
        }
        await withMachineLock(paths, async () => {
          const live = await readArtifactsOperatorConfig(files.configFile);
          if (!live) return;
          await dependencies.recordEffect?.(null);
          await writeArtifactsOperatorConfig(files.configFile, {
            ...live,
            assistants: Object.fromEntries(
              Object.entries(live.assistants).map(([id, assistant]) => [
                id,
                { ...assistant, enabled: false, publicationReady: false },
              ]),
            ),
          });
          await effect();
        });
        receipt = { ...receipt, stopped: true };
        await recordReceipt(paths, receipt);
      }
      for (const [id, cleanup] of Object.entries(receipt.assistants)) {
        if (receipt.completed_assistant_ids.includes(id)) continue;
        const blocked = await settleArtifactsCleanup(paths, id, cleanup, {
          fetch: dependencies.fetch,
          runCommand: dependencies.runCommand,
          record: async (next) => {
            if (!receipt) throw new Error('Missing artifacts uninstall receipt');
            receipt = { ...receipt, assistants: { ...receipt.assistants, [id]: next } };
            await recordReceipt(paths, receipt);
          },
        });
        if (blocked) {
          receipt = { ...receipt, reason: blocked.evidence };
          await recordReceipt(paths, receipt);
          return {
            name: 'artifacts',
            scope: 'host',
            installed: false,
            outcome: 'pending',
            changed,
            reason: blocked.reason,
            receipt_file: artifactsUninstallFile(paths),
          };
        }
        const owned = cleanup.ownership.assistants[id];
        if (owned) await releaseInstanceArtifacts(paths, id, owned.claim);
        receipt = { ...receipt, completed_assistant_ids: [...receipt.completed_assistant_ids, id], reason: null };
        await recordReceipt(paths, receipt);
        await effect();
      }
      // Per-assistant cleanup may already have removed shared resources. Its latest progress is authoritative.
      const lastId = receipt.completed_assistant_ids.at(-1);
      const last = lastId ? receipt.assistants[lastId] : undefined;
      if (!last || last.sharedRetained) {
        const blocked = await settleArtifactsCleanup(paths, null, receipt.shared, {
          fetch: dependencies.fetch,
          runCommand: dependencies.runCommand,
          record: async (shared) => {
            if (!receipt) throw new Error('Missing artifacts uninstall receipt');
            receipt = { ...receipt, shared };
            await recordReceipt(paths, receipt);
          },
        });
        if (blocked) {
          receipt = { ...receipt, reason: blocked.evidence };
          await recordReceipt(paths, receipt);
          return {
            name: 'artifacts',
            scope: 'host',
            installed: false,
            outcome: 'pending',
            changed,
            reason: blocked.reason,
            receipt_file: artifactsUninstallFile(paths),
          };
        }
      }
      await removePrivateFile(artifactsUninstallFile(paths));
      await effect();
      return {
        name: 'artifacts',
        scope: 'host',
        installed: false,
        outcome: 'removed',
        changed,
        reason: null,
        receipt_file: null,
      };
    });
  });
}
