/** One operator policy; assistants never own voice enablement or shared assets. */
import { readFile, rm } from 'node:fs/promises';
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
  bindInstanceVoicePolicy,
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
    return isRecord(item) && item.schemaVersion === 1 && item.recipe === VOICE_RECIPE_ID ? 'compatible' : 'unsupported';
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
        if (!release)
          throw new GwsEaError(
            'instance_busy',
            `Assistant ${id} is undergoing another operation; retry after it finishes.`,
          );
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

/** Explicit installation selects assets while leaving the shared policy disabled. */
export async function installLocalVoice(
  paths: ControlPlanePaths,
  request: VoiceInstallRequest = {},
  dependencies: VoiceOperatorDependencies = {},
): Promise<VerifiedVoiceInstallation> {
  return underVoiceLock(paths, async () => {
    const policy = await readLocalVoicePolicy(paths);
    if (policy.enabled)
      throw new GwsEaError(
        'voice_enabled',
        'Run gws-ea capabilities disable voice before installing or selecting voice assets.',
      );
    dependencies.recordEffect?.(null);
    const installation = await installVoiceAssets(paths, request, dependencies);
    dependencies.recordEffect?.(null);
    await writePrivate(voicePolicyFile(paths), {
      schemaVersion: 1,
      enabled: false,
      installationDir: installation.installationDir,
    } satisfies VoiceHostPolicy);
    dependencies.recordEffect?.(true);
    return installation;
  });
}

/** One enablement, inherited by every compatible current and future release. */
export async function enableLocalVoice(
  paths: ControlPlanePaths,
  dependencies: VoiceOperatorDependencies = {},
): Promise<VoiceHostPolicy> {
  return underVoiceLock(paths, async () => {
    const policy = await readLocalVoicePolicy(paths);
    if (!policy.installationDir)
      throw new GwsEaError(
        'voice_not_installed',
        'Voice is not installed. Run gws-ea capabilities install voice, then gws-ea capabilities enable voice.',
      );
    const model = (Object.keys(VOICE_MODEL_CATALOG) as VoiceModelId[]).find(
      (model) => voiceInstallationDirectory(paths, model) === policy.installationDir,
    );
    if (!model)
      throw new GwsEaError(
        'voice_assets_unowned',
        'Selected voice assets are outside this operator recipe-owned cache.',
      );
    try {
      const installation = await verifyVoiceInstallation(policy.installationDir);
      if (installation.receipt.model !== model)
        throw new GwsEaError('voice_assets_invalid', 'Selected model differs from its recipe-owned directory.');
    } catch (error) {
      throw new GwsEaError(
        'voice_assets_invalid',
        'Voice assets are unhealthy. Run gws-ea capabilities disable voice, gws-ea capabilities uninstall voice, then gws-ea capabilities install voice.',
        { cause: error, details: { model } },
      );
    }
    return withManagedInstances(paths, async (runtimes) => {
      const upsert = dependencies.upsertEnvVars;
      if (runtimes.length && !upsert)
        throw new GwsEaError(
          'voice_binding_unavailable',
          'The gws-ea launcher must supply its native environment writer to enable voice.',
        );
      if (upsert)
        for (const runtime of runtimes) {
          dependencies.recordEffect?.(null);
          await bindInstanceVoicePolicy(runtime, voicePolicyFile(paths), upsert);
          dependencies.recordEffect?.(true);
        }
      const enabled = { ...policy, enabled: true } satisfies VoiceHostPolicy;
      dependencies.recordEffect?.(null);
      await writePrivate(voicePolicyFile(paths), enabled);
      dependencies.recordEffect?.(true);
      return enabled;
    });
  });
}

/** Stops new recognition without restarting text service or deleting assets. */
export async function disableLocalVoice(
  paths: ControlPlanePaths,
  dependencies: Pick<VoiceOperatorDependencies, 'recordEffect'> = {},
): Promise<VoiceHostPolicy> {
  return underVoiceLock(paths, async () => {
    const disabled = { ...(await readLocalVoicePolicy(paths)), enabled: false } satisfies VoiceHostPolicy;
    dependencies.recordEffect?.(null);
    await writePrivate(voicePolicyFile(paths), disabled);
    dependencies.recordEffect?.(true);
    return disabled;
  });
}

async function proveIdle(runtime: InstanceRuntimeConfig, dependencies: VoiceOperatorDependencies): Promise<void> {
  const compatibility = await voiceReleaseCompatibility(runtime.checkout_root);
  if (compatibility === 'unsupported') return;
  const drain = `Assistant ${runtime.instance_id}: wait for voice work to finish, or run gws-ea stop --id ${runtime.instance_id}, then retry gws-ea capabilities uninstall voice.`;
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
  if (health.enabled || health.queued || health.inflight)
    throw new GwsEaError(
      'voice_not_drained',
      `The assistant still has voice work or has not observed disablement. ${drain}`,
      { details: { instanceId: runtime.instance_id } },
    );
}

/** Deletion is disabled-first, fenced against enable/cutover, and proves orphaned asset consumers absent. */
export async function uninstallLocalVoice(
  paths: ControlPlanePaths,
  dependencies: VoiceOperatorDependencies = {},
): Promise<void> {
  return underVoiceLock(paths, async () => {
    const policy = await readLocalVoicePolicy(paths);
    if (policy.enabled)
      throw new GwsEaError(
        'voice_enabled',
        'Run gws-ea capabilities disable voice before gws-ea capabilities uninstall voice.',
      );
    try {
      await assertPrivateDirectory(path.join(paths.stateRoot, 'voice'));
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error;
    }
    const directories: string[] = [];
    const ownedDirectories = (Object.keys(VOICE_MODEL_CATALOG) as VoiceModelId[]).map((model) =>
      voiceInstallationDirectory(paths, model),
    );
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
          `Runtime configuration is missing for assistant ${unobservedInstanceIds.join(', ')}; its voice work cannot be observed. Restore the recorded runtime or finish removing that assistant before retrying gws-ea capabilities uninstall voice.`,
        );
      for (const runtime of runtimes) await proveIdle(runtime, dependencies);
      for (const directory of directories) {
        const holders = await (dependencies.fileHolders ?? openFileHolders)(directory);
        if (holders.length)
          throw new GwsEaError(
            'voice_not_drained',
            `Voice assets are held by process ${holders[0].pid}; let it exit before retrying gws-ea capabilities uninstall voice.`,
          );
      }
      // Clear selection before any deletion so a partial removal remains safely disabled.
      dependencies.recordEffect?.(null);
      await writePrivate(voicePolicyFile(paths), emptyPolicy());
      dependencies.recordEffect?.(true);
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
  const policy = await readLocalVoicePolicy(paths);
  const compatibility = await voiceReleaseCompatibility(runtime.checkout_root);
  if (!policy.installationDir)
    return {
      ...view,
      status: policy.enabled ? 'degraded' : 'ok',
      reason: 'Voice is not installed; text service remains available.',
      enabled: policy.enabled,
      assets: 'absent',
      compatibility,
      readiness: 'unavailable',
    };
  try {
    await verifyVoiceInstallation(policy.installationDir);
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
  if (compatibility !== 'compatible')
    return {
      ...view,
      status: !policy.enabled ? 'ok' : compatibility === 'unsupported' ? 'degraded' : 'unknown',
      reason: !policy.enabled
        ? 'Voice is disabled host-wide.'
        : 'This release needs an operator update for voice; text service remains available.',
      enabled: policy.enabled,
      assets: 'verified',
      compatibility,
      readiness: 'unavailable',
    };
  let health: ObservedVoiceHealth;
  try {
    health = parseVoiceHealth(await ncl(runtime, VOICE_HEALTH_ARGS));
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
    return { ...facts, status: 'ok', reason: 'Voice is disabled host-wide.', readiness: 'unavailable' };
  if (!health.enabled || health.readiness !== 'ready' || health.lastFailure)
    return {
      ...facts,
      status: 'degraded',
      reason: health.lastFailure?.reason ?? health.reason ?? 'The host has not observed voice enablement.',
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
