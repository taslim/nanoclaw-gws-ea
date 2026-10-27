/** One operator policy; assistants never own voice enablement or shared assets. */
import type { VoiceCapabilityObservation } from './voice-inspection.js';
import { lstat, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import { isErrno } from '../community-portal/errors.js';
import { writePrivate } from '../community-portal/private-file.js';
import { processLock } from '../community-portal/process-lock.js';
import { assertInstanceQuiet, openFileHolders, type OpenFileHolder, type QuiescenceSeams } from './cutover.js';
import {
  installVoiceAssets,
  voiceInstallationDirectory,
  type VoiceInstallDependencies,
  type VoiceInstallRequest,
} from './install-voice.js';
import { runInstanceNclJson } from './ncl.js';
import {
  assertOwnedDirectory,
  assertPrivateDirectory,
  preparePrivateDirectory,
  type ControlPlanePaths,
} from './paths.js';
import { readRegistry, withMachineLock } from './registry.js';
import {
  bindInstanceHostPolicies,
  loadInstanceRuntimeConfig,
  type InstanceRuntimeConfig,
  type UpsertEnvVars,
} from './service.js';
import { createServiceControl, runtimeServiceTarget, type NanoclawServiceHelpers } from './service-control.js';
import { GwsEaError } from './types.js';
import { isRecord, unwrapData } from './validation.js';
import {
  VOICE_MODEL_CATALOG,
  VOICE_RECIPE_ID,
  readVoiceHostPolicy,
  verifyVoiceInstallation,
  type VoiceHostPolicy,
  type VoiceModelId,
  type VerifiedVoiceInstallation,
} from './voice-assets.js';

export const VOICE_HEALTH_ARGS = ['gws-ea-voice-health'] as const;
export const VOICE_UNINSTALL_INCOMPLETE_REASON =
  'Voice uninstall is incomplete. Run gws-ea connectors uninstall voice to remove the remaining owned assets.';
export function voicePolicyFile(paths: Pick<ControlPlanePaths, 'configRoot'>): string {
  return path.join(paths.configRoot, 'voice.json');
}
const emptyPolicy = (): VoiceHostPolicy => ({ schemaVersion: 1, enabled: false, installationDir: null });

export interface ObservedVoiceHealth {
  readonly schemaVersion: 1;
  readonly recipe: typeof VOICE_RECIPE_ID;
  readonly enabled: boolean;
  readonly readiness: 'ready' | 'unavailable';
  readonly reason: string | null;
  readonly queued: number;
  readonly inflight: number;
  readonly lastOutcome: {
    readonly status: 'recognized' | 'no-speech' | 'unavailable' | 'failed';
    readonly at: string;
  } | null;
  readonly lastFailure: { readonly reason: string; readonly at: string } | null;
}

export function parseVoiceHealth(value: unknown): ObservedVoiceHealth {
  const item = unwrapData(value);
  const invalid = (): never => {
    throw new GwsEaError('invalid_voice_health', 'The host returned invalid voice health');
  };
  if (
    !isRecord(item) ||
    item.schemaVersion !== 1 ||
    item.recipe !== VOICE_RECIPE_ID ||
    typeof item.enabled !== 'boolean' ||
    (item.readiness !== 'ready' && item.readiness !== 'unavailable') ||
    typeof item.queued !== 'number' ||
    !Number.isSafeInteger(item.queued) ||
    item.queued < 0 ||
    typeof item.inflight !== 'number' ||
    !Number.isSafeInteger(item.inflight) ||
    item.inflight < 0 ||
    (item.reason !== undefined && typeof item.reason !== 'string')
  )
    return invalid();
  const timestamp = (value: unknown): value is string =>
    typeof value === 'string' && /^\d{4}-\d\d-\d\dT.*Z$/u.test(value) && Number.isFinite(Date.parse(value));
  const outcome = item.lastOutcome;
  let lastOutcome: ObservedVoiceHealth['lastOutcome'] = null;
  if (outcome !== null) {
    if (
      !isRecord(outcome) ||
      !timestamp(outcome.at) ||
      (outcome.status !== 'recognized' &&
        outcome.status !== 'no-speech' &&
        outcome.status !== 'unavailable' &&
        outcome.status !== 'failed')
    )
      return invalid();
    lastOutcome = { status: outcome.status, at: outcome.at };
  }
  const failure = item.lastFailure;
  let lastFailure: ObservedVoiceHealth['lastFailure'] = null;
  if (failure !== null) {
    if (!isRecord(failure) || typeof failure.reason !== 'string' || !timestamp(failure.at)) return invalid();
    lastFailure = { reason: failure.reason, at: failure.at };
  }
  return {
    schemaVersion: 1,
    recipe: VOICE_RECIPE_ID,
    enabled: item.enabled,
    readiness: item.readiness,
    reason: typeof item.reason === 'string' ? item.reason : null,
    queued: item.queued,
    inflight: item.inflight,
    lastOutcome,
    lastFailure,
  };
}

export type VoiceReleaseCompatibility = 'compatible' | 'unsupported' | 'unknown';
/** Missing marker is a release that does not support this recipe, not a broken text service. */
export async function voiceReleaseCompatibility(checkout: string): Promise<VoiceReleaseCompatibility> {
  try {
    const item: unknown = JSON.parse(
      await readFile(path.join(checkout, 'src/gws-ea/voice-compatibility.json'), 'utf8'),
    );
    if (!isRecord(item) || !Number.isSafeInteger(item.schemaVersion) || typeof item.recipe !== 'string')
      return 'unknown';
    return item.schemaVersion === 1 && item.recipe === VOICE_RECIPE_ID ? 'compatible' : 'unsupported';
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return 'unsupported';
    if (error instanceof SyntaxError) return 'unknown';
    throw error;
  }
}

export async function readLocalVoicePolicy(paths: ControlPlanePaths): Promise<VoiceHostPolicy> {
  try {
    return await readVoiceHostPolicy(voicePolicyFile(paths));
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return emptyPolicy();
    throw new GwsEaError(
      'voice_policy_invalid',
      `The shared voice policy cannot be read. Inspect ${voicePolicyFile(paths)}; restore a valid disabled policy before retrying the voice command.`,
      { cause: error },
    );
  }
}

async function underVoiceLock<T>(paths: ControlPlanePaths, work: () => Promise<T>): Promise<T> {
  await preparePrivateDirectory(paths.configRoot);
  await preparePrivateDirectory(paths.stateRoot);
  const release = await processLock(path.join(paths.configRoot, 'voice.lock'));
  if (!release) throw new GwsEaError('voice_busy', 'Another voice operation is running; retry this command.');
  try {
    return await work();
  } finally {
    release();
  }
}

export interface VoiceOperatorDependencies extends VoiceInstallDependencies {
  readonly recordEffect?: (changed: true | null) => void;
  readonly upsertEnvVars?: UpsertEnvVars;
  readonly serviceHelpers?: NanoclawServiceHelpers;
  readonly ncl?: (runtime: InstanceRuntimeConfig, args: readonly string[]) => Promise<unknown>;
  readonly fileHolders?: (directory: string) => Promise<readonly OpenFileHolder[]>;
  readonly quiescence?: QuiescenceSeams;
}

async function withManagedInstances<T>(
  paths: ControlPlanePaths,
  work: (runtimes: readonly InstanceRuntimeConfig[], unobservedInstanceIds: readonly string[]) => Promise<T>,
  skipBusy?: (instanceId: string) => void,
): Promise<T> {
  return withMachineLock(paths, async () => {
    const releases: Array<() => void> = [];
    const runtimes: InstanceRuntimeConfig[] = [];
    const unobservedInstanceIds: string[] = [];
    try {
      const ids = Object.keys((await readRegistry(paths)).instances).sort();
      for (const id of ids) {
        await preparePrivateDirectory(path.dirname(paths.instanceLock(id)));
        const release = await processLock(paths.instanceLock(id));
        if (!release) {
          if (skipBusy) {
            skipBusy(id);
            continue;
          }
          throw new GwsEaError(
            'instance_busy',
            `Assistant ${id} is undergoing another operation; retry after it finishes.`,
          );
        }
        releases.push(release);
        try {
          runtimes.push(await loadInstanceRuntimeConfig(paths.runtimeFile(id)));
        } catch (error) {
          if (!isErrno(error, 'ENOENT')) throw error;
          unobservedInstanceIds.push(id);
        }
      }
      return await work(runtimes, unobservedInstanceIds);
    } finally {
      for (const release of releases.reverse()) release();
    }
  });
}

/** Installing verified shared assets makes recognition available immediately. */
export async function installLocalVoice(
  paths: ControlPlanePaths,
  request: VoiceInstallRequest = {},
  dependencies: VoiceOperatorDependencies = {},
): Promise<VerifiedVoiceInstallation> {
  return underVoiceLock(paths, async () => {
    const policy = await readLocalVoicePolicy(paths);
    const directories = ownedVoiceDirectories(paths);
    if (policy.installationDir && !directories.includes(policy.installationDir))
      throw new GwsEaError('voice_assets_unowned', 'Selected voice assets are outside this recipe-owned host cache.');
    dependencies.recordEffect?.(null);
    const installation = await installVoiceAssets(paths, request, dependencies);
    dependencies.recordEffect?.(null);
    await writePrivate(voicePolicyFile(paths), {
      schemaVersion: 1,
      enabled: true,
      installationDir: installation.installationDir,
    } satisfies VoiceHostPolicy);
    dependencies.recordEffect?.(true);
    const busyInstanceIds: string[] = [];
    await withManagedInstances(
      paths,
      async (runtimes, missing) => {
        const upsert = dependencies.upsertEnvVars;
        if (runtimes.length && !upsert)
          throw new GwsEaError(
            'voice_binding_unavailable',
            'The gws-ea launcher must supply its native environment writer to install voice.',
          );
        if (upsert)
          for (const runtime of runtimes) {
            dependencies.recordEffect?.(null);
            await bindInstanceHostPolicies(runtime, paths.configRoot, upsert);
            dependencies.recordEffect?.(true);
          }
        for (const id of missing)
          dependencies.progress?.(
            `Assistant ${id}: runtime is not recorded yet; creation will bind shared voice automatically.`,
          );
        const previousDirectories: string[] = [];
        for (const directory of directories) {
          if (directory === installation.installationDir) continue;
          try {
            await assertOwnedDirectory(directory);
            previousDirectories.push(directory);
          } catch (error) {
            if (!isErrno(error, 'ENOENT')) throw error;
          }
        }
        if (previousDirectories.length === 0) return;
        const unobserved = [...busyInstanceIds, ...missing];
        if (unobserved.length) {
          dependencies.progress?.(
            `Retaining previous voice assets because voice work cannot be observed for assistants ${unobserved.join(', ')}.`,
          );
          return;
        }
        // Admission counts before reading the policy. After publishing the new
        // selection, zero counters prove no note still owns the previous one,
        // including the gap between ffmpeg exiting and whisper starting. Keep
        // instance locks through removal so a lifecycle operation cannot race
        // this consumer proof.
        for (const runtime of runtimes) {
          try {
            await proveIdle(runtime, dependencies, { requireDisabledPolicy: false });
            // eslint-disable-next-line no-catch-all/no-catch-all -- Any unproved consumer state retains assets; installing the new selection still succeeds.
          } catch (_error) {
            dependencies.progress?.(
              `Retaining previous voice assets because assistant ${runtime.instance_id} has active or unobserved voice work.`,
            );
            return;
          }
        }
        for (const directory of previousDirectories) {
          let holders: readonly OpenFileHolder[];
          try {
            holders = await (dependencies.fileHolders ?? openFileHolders)(directory);
            // eslint-disable-next-line no-catch-all/no-catch-all -- An unobservable process may still own these files; retain them for a later install or uninstall.
          } catch (_error) {
            dependencies.progress?.(
              `Retaining previous voice assets because file holders cannot be observed: ${directory}`,
            );
            continue;
          }
          if (holders.length) {
            dependencies.progress?.(
              `Retaining previous voice assets while process ${holders[0].pid} uses them: ${directory}`,
            );
            continue;
          }
          dependencies.recordEffect?.(null);
          await rm(directory, { recursive: true });
          dependencies.recordEffect?.(true);
        }
      },
      (id) => {
        busyInstanceIds.push(id);
        dependencies.progress?.(
          `Assistant ${id}: another operation is running; its next create, update or rollback binds shared voice automatically.`,
        );
      },
    );
    return installation;
  });
}

function ownedVoiceDirectories(paths: ControlPlanePaths): string[] {
  return (Object.keys(VOICE_MODEL_CATALOG) as VoiceModelId[]).map((model) => voiceInstallationDirectory(paths, model));
}

async function hasOwnedVoiceAssets(paths: ControlPlanePaths): Promise<boolean> {
  for (const directory of ownedVoiceDirectories(paths)) {
    try {
      await lstat(directory);
      return true;
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error;
    }
  }
  return false;
}

async function proveIdle(
  runtime: InstanceRuntimeConfig,
  dependencies: VoiceOperatorDependencies,
  options: { readonly requireDisabledPolicy: boolean } = { requireDisabledPolicy: true },
): Promise<void> {
  const compatibility = await voiceReleaseCompatibility(runtime.checkout_root);
  if (compatibility === 'unsupported') return;
  const drain = `Assistant ${runtime.instance_id}: wait for voice work to finish, or run gws-ea stop --id ${runtime.instance_id}, then retry gws-ea connectors uninstall voice.`;
  const service = dependencies.serviceHelpers
    ? createServiceControl(dependencies.serviceHelpers, runtimeServiceTarget(runtime)).detect()
    : undefined;
  if (service && !service.active && !service.transitional && service.mode !== 'unmanaged') {
    try {
      await assertInstanceQuiet(
        {
          instanceRoot: runtime.instance_root,
          state: runtime.state_root,
          installId: runtime.install_id,
          homeDirectory: runtime.home_directory,
          dockerEndpoint: runtime.docker_endpoint,
        },
        dependencies.quiescence,
      );
      return;
    } catch (error) {
      throw new GwsEaError('voice_drain_unproven', `The stopped assistant is not yet quiet. ${drain}`, {
        cause: error,
        details: { instanceId: runtime.instance_id },
      });
    }
  }
  if (compatibility === 'unknown')
    throw new GwsEaError('voice_drain_unproven', `Voice release compatibility cannot be observed. ${drain}`, {
      details: { instanceId: runtime.instance_id },
    });
  let health: ObservedVoiceHealth;
  try {
    health = parseVoiceHealth(await (dependencies.ncl ?? runInstanceNclJson)(runtime, VOICE_HEALTH_ARGS));
  } catch (error) {
    throw new GwsEaError('voice_drain_unproven', `The assistant's voice work could not be observed. ${drain}`, {
      cause: error,
      details: { instanceId: runtime.instance_id },
    });
  }
  if ((options.requireDisabledPolicy && health.enabled) || health.queued || health.inflight)
    throw new GwsEaError(
      'voice_not_drained',
      `The assistant still has voice work or has not observed the stopped policy. ${drain}`,
      { details: { instanceId: runtime.instance_id } },
    );
}

/** Stop admission before waiting for every managed consumer and orphaned child to drain. */
export async function uninstallLocalVoice(
  paths: ControlPlanePaths,
  dependencies: VoiceOperatorDependencies = {},
): Promise<void> {
  return underVoiceLock(paths, async () => {
    const policy = await readLocalVoicePolicy(paths);
    dependencies.recordEffect?.(null);
    await writePrivate(voicePolicyFile(paths), emptyPolicy());
    dependencies.recordEffect?.(true);
    try {
      await assertPrivateDirectory(path.join(paths.stateRoot, 'voice'));
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error;
    }
    const directories: string[] = [];
    const ownedDirectories = ownedVoiceDirectories(paths);
    for (const directory of ownedDirectories) {
      try {
        await assertOwnedDirectory(directory);
        directories.push(directory);
      } catch (error) {
        if (!isErrno(error, 'ENOENT')) throw error;
      }
    }
    if (policy.installationDir !== null && !ownedDirectories.includes(policy.installationDir))
      throw new GwsEaError(
        'voice_assets_unowned',
        'The selected voice directory is outside this recipe-owned host cache; it will not be removed.',
      );
    await withManagedInstances(paths, async (runtimes, unobservedInstanceIds) => {
      if (unobservedInstanceIds.length)
        throw new GwsEaError(
          'voice_drain_unproven',
          `Runtime configuration is missing for assistant ${unobservedInstanceIds.join(', ')}; its voice work cannot be observed. Restore the recorded runtime or finish removing that assistant before retrying gws-ea connectors uninstall voice.`,
        );
      for (const runtime of runtimes) await proveIdle(runtime, dependencies);
      for (const directory of directories) {
        const holders = await (dependencies.fileHolders ?? openFileHolders)(directory);
        if (holders.length)
          throw new GwsEaError(
            'voice_not_drained',
            `Voice assets are held by process ${holders[0].pid}; let it exit before retrying gws-ea connectors uninstall voice.`,
          );
      }
      for (const directory of directories) await rm(directory, { recursive: true });
    });
  });
}

export interface VoiceObservation {
  readonly status: 'ok' | 'degraded' | 'unknown';
  readonly reason: string | null;
  readonly enabled: boolean | null;
  readonly assets: 'verified' | 'absent' | 'invalid' | 'unknown';
  readonly compatibility: VoiceReleaseCompatibility;
  readonly readiness: 'ready' | 'unavailable' | 'unknown';
  readonly queued: number | null;
  readonly inflight: number | null;
  readonly last_outcome: ObservedVoiceHealth['lastOutcome'];
  readonly last_failure: ObservedVoiceHealth['lastFailure'];
}

/** Read-only; capability flags and installed bytes are never presented as successful recognition. */
export async function observeLocalVoice(
  paths: ControlPlanePaths,
  runtime: InstanceRuntimeConfig,
  ncl: (runtime: InstanceRuntimeConfig, args: readonly string[]) => Promise<unknown> = runInstanceNclJson,
  inspection?: VoiceCapabilityObservation,
): Promise<VoiceObservation> {
  const view: VoiceObservation = {
    status: 'unknown',
    reason: null,
    enabled: null,
    assets: 'unknown',
    compatibility: 'unknown',
    readiness: 'unknown',
    queued: null,
    inflight: null,
    last_outcome: null,
    last_failure: null,
  };
  const observedAssistant = inspection?.assistants.find((entry) => entry.instance_id === runtime.instance_id);
  const policy = inspection
    ? { enabled: inspection.activation.enabled === true, installationDir: inspection.assets.selected_directory }
    : await readLocalVoicePolicy(paths);
  const compatibility = inspection
    ? (observedAssistant?.compatibility ?? 'unknown')
    : await voiceReleaseCompatibility(runtime.checkout_root);
  if (inspection?.activation.enabled === null) return { ...view, compatibility, reason: inspection.activation.reason };
  if (!policy.installationDir) {
    if (!policy.enabled && (inspection ? inspection.assets.installations.length > 0 : await hasOwnedVoiceAssets(paths)))
      return {
        ...view,
        status: 'degraded',
        reason: VOICE_UNINSTALL_INCOMPLETE_REASON,
        enabled: false,
        compatibility,
        readiness: 'unavailable',
      };
    return {
      ...view,
      status: policy.enabled ? 'degraded' : 'ok',
      reason: 'Voice is not installed; text service remains available.',
      enabled: policy.enabled,
      assets: 'absent',
      compatibility,
      readiness: 'unavailable',
    };
  }
  let selectedModel = inspection?.assets.selected_model;
  try {
    if (inspection) {
      if (inspection.assets.status !== 'verified')
        throw new Error(inspection.assets.reason ?? 'Asset verification was not established.');
    } else selectedModel = (await verifyVoiceInstallation(policy.installationDir)).receipt.model;
    // eslint-disable-next-line no-catch-all/no-catch-all -- Asset verification is an observation boundary; any failure is optional capability state, never a repair.
  } catch (error) {
    return {
      ...view,
      status: 'degraded',
      reason: `Voice assets are invalid: ${error instanceof Error ? error.message : 'verification failed'}`,
      enabled: policy.enabled,
      assets: 'invalid',
      compatibility,
      readiness: 'unavailable',
    };
  }
  const installCommand = `gws-ea connectors install voice${selectedModel ? ` --model ${selectedModel}` : ''}`;
  if (compatibility !== 'compatible')
    return {
      ...view,
      status: !policy.enabled ? 'ok' : compatibility === 'unsupported' ? 'degraded' : 'unknown',
      reason: !policy.enabled
        ? `Voice is installed, stopped. Run ${installCommand}.`
        : 'This release needs an operator update for voice; text service remains available.',
      enabled: policy.enabled,
      assets: 'verified',
      compatibility,
      readiness: 'unavailable',
    };
  let health: ObservedVoiceHealth;
  try {
    if (inspection) {
      if (
        !observedAssistant ||
        observedAssistant.consumer.status !== 'observed' ||
        observedAssistant.consumer.enabled === null ||
        observedAssistant.consumer.queued === null ||
        observedAssistant.consumer.inflight === null
      )
        throw new Error(observedAssistant?.reason ?? 'Consumer readiness was not observed.');
      health = {
        schemaVersion: 1,
        recipe: VOICE_RECIPE_ID,
        enabled: observedAssistant.consumer.enabled,
        readiness: observedAssistant.readiness === 'ready' ? 'ready' : 'unavailable',
        reason: observedAssistant.reason,
        queued: observedAssistant.consumer.queued,
        inflight: observedAssistant.consumer.inflight,
        lastOutcome: observedAssistant.last_outcome,
        lastFailure: observedAssistant.last_failure,
      };
    } else health = parseVoiceHealth(await ncl(runtime, VOICE_HEALTH_ARGS));
    // eslint-disable-next-line no-catch-all/no-catch-all -- A failed host query is unknown readiness, never evidence of healthy recognition.
  } catch (error) {
    return {
      ...view,
      status: policy.enabled ? 'unknown' : 'ok',
      reason: `Voice host readiness is unobserved: ${error instanceof Error ? error.message : 'probe failed'}`,
      enabled: policy.enabled,
      assets: 'verified',
      compatibility,
      readiness: policy.enabled ? 'unknown' : 'unavailable',
    };
  }
  const facts = {
    enabled: policy.enabled,
    assets: 'verified' as const,
    compatibility,
    readiness: health.readiness,
    queued: health.queued,
    inflight: health.inflight,
    last_outcome: health.lastOutcome,
    last_failure: health.lastFailure,
  };
  if (!policy.enabled)
    return {
      ...facts,
      status: 'ok',
      reason: `Voice is installed, stopped. Run ${installCommand}.`,
      readiness: 'unavailable',
    };
  if (!health.enabled || health.readiness !== 'ready' || health.lastFailure)
    return {
      ...facts,
      status: 'degraded',
      reason: health.lastFailure?.reason ?? health.reason ?? 'The host has not observed installed voice.',
    };
  if (health.lastOutcome?.status !== 'recognized')
    return {
      ...facts,
      status: 'unknown',
      reason:
        health.lastOutcome === null
          ? 'The host is ready; successful recognition has not been observed yet.'
          : `The host is ready; its latest voice note ended as ${health.lastOutcome.status}.`,
    };
  return { ...facts, status: 'ok', reason: null };
}
