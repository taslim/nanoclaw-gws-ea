/** The shipped optional host catalog. Voice owns its actions, locks, policy, and asset recipe. */
import { lstat } from 'node:fs/promises';

import { formatLocalTime } from '../timezone.js';
import { isErrno } from '../community-portal/errors.js';
import { DEFAULT_VOICE_MODEL, voiceInstallationDirectory } from './install-voice.js';
import {
  parseVoiceHealth,
  readLocalVoicePolicy,
  voiceReleaseCompatibility,
  VOICE_HEALTH_ARGS,
  type ObservedVoiceHealth,
  type VoiceReleaseCompatibility,
} from './local-voice.js';
import { runInstanceNclJson } from './ncl.js';
import type { ControlPlanePaths } from './paths.js';
import { safeErrorMessage } from './redact.js';
import type { NextAction } from './result.js';
import { GwsEaError } from './types.js';
import { readRegistry } from './registry.js';
import { loadInstanceRuntimeConfig, type InstanceRuntimeConfig } from './service.js';
import {
  verifyVoiceInstallation,
  VoiceAssetsError,
  VOICE_MODEL_CATALOG,
  VOICE_RECIPE_ID,
  VOICE_SOURCE_ARTIFACTS,
  type VoiceAssetReceipt,
  type VoiceModelId,
} from './voice-assets.js';

export const VOICE_CAPABILITY = {
  name: 'voice',
  actions: ['show', 'check', 'install', 'enable', 'disable', 'uninstall'],
  scope: 'host',
  summary: 'Recognize voice notes locally for compatible assistants.',
  default_model: DEFAULT_VOICE_MODEL,
  models: Object.keys(VOICE_MODEL_CATALOG) as VoiceModelId[],
  prerequisites: [
    'macOS or Linux on arm64 or x64.',
    'Installation requires CMake, C/C++ compilers, make, and tar; installed programs do not need build tools.',
    'Enabling requires verified recipe-owned installed assets.',
  ],
  readiness_limits: [
    'Readiness is an observation of the host, not proof of successful recognition or model quality.',
    'Checks do not download, enable, restart, or process recordings.',
    'Principal response preferences remain owned by the principal.',
  ],
  recipe: VOICE_RECIPE_ID,
  sources: VOICE_SOURCE_ARTIFACTS,
} as const;

type AssetState = 'verified' | 'absent' | 'invalid' | 'unknown';
export interface VoiceCapabilityAssistant {
  readonly instance_id: string;
  readonly compatibility: VoiceReleaseCompatibility;
  readonly readiness: 'ready' | 'unavailable' | 'unknown';
  readonly reason: string | null;
  readonly consumer: {
    readonly status: 'observed' | 'unknown' | 'not-applicable';
    readonly enabled: boolean | null;
    readonly queued: number | null;
    readonly inflight: number | null;
  };
  readonly last_outcome: ObservedVoiceHealth['lastOutcome'];
  readonly last_failure: ObservedVoiceHealth['lastFailure'];
}
interface VoiceInstallationObservation {
  readonly model: VoiceModelId;
  readonly directory: string;
  readonly status: AssetState;
  readonly reason: string | null;
  readonly receipt: VoiceAssetReceipt | null;
}
export interface VoiceCapabilityObservation {
  readonly observed_at: string;
  readonly name: 'voice';
  readonly actions: typeof VOICE_CAPABILITY.actions;
  readonly scope: 'host';
  readonly summary: string;
  readonly availability: {
    readonly status: 'supported' | 'unsupported';
    readonly platform: string;
    readonly architecture: string;
  };
  readonly activation: {
    readonly status: 'enabled' | 'disabled' | 'unknown';
    readonly enabled: boolean | null;
    readonly reason: string | null;
  };
  readonly assets: {
    readonly status: AssetState;
    readonly reason: string | null;
    readonly selected_directory: string | null;
    readonly selected_model: VoiceModelId | null;
    readonly installations: readonly VoiceInstallationObservation[];
    readonly provenance: VoiceAssetReceipt | null;
  };
  readonly default_model: VoiceModelId;
  readonly models: readonly VoiceModelId[];
  readonly prerequisites: readonly string[];
  readonly readiness_limits: readonly string[];
  readonly recipe: typeof VOICE_RECIPE_ID;
  readonly sources: typeof VOICE_SOURCE_ARTIFACTS;
  readonly assistants: readonly VoiceCapabilityAssistant[];
  readonly compatible_assistant_ids: readonly string[];
  readonly unsupported_assistant_ids: readonly string[];
  readonly unknown_assistant_ids: readonly string[];
  readonly future_compatible_assistants: true;
}
export interface CapabilityList {
  readonly capabilities: readonly VoiceCapabilityObservation[];
}
export interface VoiceCapabilityInspection {
  readonly checkConsumers?: boolean;
  readonly platform?: NodeJS.Platform;
  readonly architecture?: string;
  readonly ncl?: (runtime: InstanceRuntimeConfig, args: readonly string[]) => Promise<unknown>;
}

async function inspectInstallation(directory: string, model: VoiceModelId): Promise<VoiceInstallationObservation> {
  const facts = { model, directory };
  try {
    await lstat(directory);
    // eslint-disable-next-line no-catch-all/no-catch-all -- Any failure to inspect a directory is retained as unknown optional asset state.
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return { ...facts, status: 'absent', reason: null, receipt: null };
    return { ...facts, status: 'unknown', reason: safeErrorMessage(error), receipt: null };
  }
  try {
    const installation = await verifyVoiceInstallation(directory);
    if (installation.receipt.model !== model)
      return {
        ...facts,
        status: 'invalid',
        reason: 'The installed model does not match its recipe-owned directory.',
        receipt: null,
      };
    return { ...facts, status: 'verified', reason: null, receipt: installation.receipt };
    // eslint-disable-next-line no-catch-all/no-catch-all -- Verification failures are retained observations, never repairs.
  } catch (error) {
    return {
      ...facts,
      status: 'invalid',
      reason: error instanceof VoiceAssetsError ? error.message : safeErrorMessage(error),
      receipt: null,
    };
  }
}

async function inspectAssistant(
  paths: ControlPlanePaths,
  instanceId: string,
  options: VoiceCapabilityInspection,
): Promise<VoiceCapabilityAssistant> {
  const unknown: VoiceCapabilityAssistant = {
    instance_id: instanceId,
    compatibility: 'unknown',
    readiness: 'unknown',
    reason: null,
    consumer: { status: 'unknown', enabled: null, queued: null, inflight: null },
    last_outcome: null,
    last_failure: null,
  };
  let runtime: InstanceRuntimeConfig;
  let compatibility: VoiceReleaseCompatibility;
  try {
    runtime = await loadInstanceRuntimeConfig(paths.runtimeFile(instanceId));
    compatibility = await voiceReleaseCompatibility(runtime.checkout_root);
    // eslint-disable-next-line no-catch-all/no-catch-all -- An unreadable runtime or marker leaves this registered assistant unknown.
  } catch (error) {
    return { ...unknown, reason: safeErrorMessage(error) };
  }
  if (compatibility === 'unsupported')
    return {
      ...unknown,
      compatibility,
      readiness: 'unavailable',
      reason: 'This release does not support voice.',
      consumer: { ...unknown.consumer, status: 'not-applicable' },
    };
  if (compatibility === 'unknown' || !options.checkConsumers)
    return {
      ...unknown,
      compatibility,
      reason:
        compatibility === 'unknown'
          ? 'Release compatibility could not be established.'
          : 'Run gws-ea capabilities check voice to observe the consumer.',
    };
  try {
    const health = parseVoiceHealth(await (options.ncl ?? runInstanceNclJson)(runtime, VOICE_HEALTH_ARGS));
    return {
      instance_id: instanceId,
      compatibility,
      readiness: health.readiness,
      reason: health.reason,
      consumer: { status: 'observed', enabled: health.enabled, queued: health.queued, inflight: health.inflight },
      last_outcome: health.lastOutcome,
      last_failure: health.lastFailure,
    };
    // eslint-disable-next-line no-catch-all/no-catch-all -- Unreachability is unknown consumer state, never evidence of drainage.
  } catch (error) {
    return { ...unknown, compatibility, reason: safeErrorMessage(error) };
  }
}

type VoiceConsumers = Pick<
  VoiceCapabilityObservation,
  'assistants' | 'compatible_assistant_ids' | 'unsupported_assistant_ids' | 'unknown_assistant_ids'
>;

export async function inspectVoiceConsumers(
  paths: ControlPlanePaths,
  options: Pick<VoiceCapabilityInspection, 'checkConsumers' | 'ncl'> = {},
): Promise<VoiceConsumers> {
  const instanceIds = Object.keys((await readRegistry(paths)).instances).sort();
  const assistants: VoiceCapabilityAssistant[] = [];
  // Bound simultaneous native host queries while preserving the registry's sorted output.
  const batchSize = 4;
  for (let offset = 0; offset < instanceIds.length; offset += batchSize) {
    const batch = instanceIds.slice(offset, offset + batchSize);
    assistants.push(...(await Promise.all(batch.map((id) => inspectAssistant(paths, id, options)))));
  }
  const ids = (compatibility: VoiceReleaseCompatibility): string[] =>
    assistants
      .filter((assistant) => assistant.compatibility === compatibility)
      .map((assistant) => assistant.instance_id);
  return {
    assistants,
    compatible_assistant_ids: ids('compatible'),
    unsupported_assistant_ids: ids('unsupported'),
    unknown_assistant_ids: ids('unknown'),
  };
}

/** Local independent facts, plus bounded native health only for an explicit check. No runtime mutation. */
export async function inspectVoiceCapability(
  paths: ControlPlanePaths,
  options: VoiceCapabilityInspection = {},
): Promise<VoiceCapabilityObservation> {
  const observedAt = new Date().toISOString();
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  const availability = {
    status:
      (platform === 'darwin' || platform === 'linux') && (architecture === 'arm64' || architecture === 'x64')
        ? ('supported' as const)
        : ('unsupported' as const),
    platform,
    architecture,
  };
  let activation: VoiceCapabilityObservation['activation'];
  let selectedDirectory: string | null = null;
  try {
    const policy = await readLocalVoicePolicy(paths);
    selectedDirectory = policy.installationDir;
    activation = { status: policy.enabled ? 'enabled' : 'disabled', enabled: policy.enabled, reason: null };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    activation = { status: 'unknown', enabled: null, reason: safeErrorMessage(error) };
  }
  const installations: VoiceInstallationObservation[] = [];
  for (const model of VOICE_CAPABILITY.models)
    installations.push(
      await inspectInstallation(voiceInstallationDirectory(paths, model, platform, architecture), model),
    );
  const selected = installations.find((installation) => installation.directory === selectedDirectory);
  const assets: VoiceCapabilityObservation['assets'] = {
    status:
      activation.status === 'unknown'
        ? 'unknown'
        : selectedDirectory === null
          ? 'absent'
          : (selected?.status ?? 'invalid'),
    reason:
      activation.status === 'unknown'
        ? 'The selected installation cannot be observed from the policy.'
        : selectedDirectory !== null && !selected
          ? 'Selected assets are outside this recipe-owned host cache.'
          : (selected?.reason ?? null),
    selected_directory: selectedDirectory,
    // Directory identity retains the operator's selection; provenance separately proves verified assets.
    selected_model: selected?.model ?? null,
    installations: installations.filter((installation) => installation.status !== 'absent'),
    provenance: selected?.receipt ?? null,
  };
  const consumers = await inspectVoiceConsumers(paths, options);
  return {
    ...VOICE_CAPABILITY,
    observed_at: observedAt,
    availability,
    activation,
    assets,
    ...consumers,
    future_compatible_assistants: true,
  };
}

/** Scope-conscious terminal facts use the same inspection data as machine output. */
export function capabilityLines(
  capability: VoiceCapabilityObservation,
  detailed: boolean,
  timezone = Intl.DateTimeFormat().resolvedOptions().timeZone,
): readonly string[] {
  const lines = [
    `${capability.name} (host): ${capability.summary}`,
    `  Host: ${capability.availability.status} (${capability.availability.platform}/${capability.availability.architecture})`,
    `  Selected assets: ${capability.assets.status}; installed directories: ${capability.assets.installations.length}; activation: ${capability.activation.status}`,
    `  Selected model: ${capability.assets.selected_model ?? 'unobserved'}; default: ${capability.default_model}`,
    `  Applies to compatible current and future assistants: ${capability.compatible_assistant_ids.join(', ') || 'none observed'}`,
    `  Unsupported assistants: ${capability.unsupported_assistant_ids.join(', ') || 'none observed'}`,
    `  Unknown compatibility: ${capability.unknown_assistant_ids.join(', ') || 'none observed'}`,
    ...[capability.activation.reason, capability.assets.reason]
      .filter((reason): reason is string => reason !== null)
      .map((reason) => `  ${reason}`),
  ];
  if (detailed)
    lines.push(
      `  Actions: ${capability.actions.join(', ')}`,
      `  Recipe: ${capability.recipe}`,
      `  Selected directory: ${capability.assets.selected_directory ?? 'none'}`,
      ...capability.assets.installations.map(
        (installation) => `  Installed ${installation.model}: ${installation.status} (${installation.directory})`,
      ),
      ...Object.entries(capability.sources).map(
        ([name, source]) => `  Source ${name}: ${source.url} (sha256 ${source.sha256})`,
      ),
      ...(capability.assets.provenance
        ? [`  Verified build: ${formatLocalTime(capability.assets.provenance.builtAt, timezone)}`]
        : []),
      ...capability.prerequisites.map((line) => `  Prerequisite: ${line}`),
      ...capability.assistants.flatMap((assistant) => [
        `  Assistant ${assistant.instance_id}`,
        `    Release: ${assistant.compatibility}; readiness: ${assistant.readiness}; consumer: ${assistant.consumer.status}`,
        `    Work: queued ${assistant.consumer.queued ?? 'unknown'}; inflight ${assistant.consumer.inflight ?? 'unknown'}`,
        `    Last recognition: ${assistant.last_outcome ? `${assistant.last_outcome.status} ${formatLocalTime(assistant.last_outcome.at, timezone)}` : 'unobserved'}`,
        ...(assistant.last_failure
          ? [
              `    Last failure: ${assistant.last_failure.reason} ${formatLocalTime(assistant.last_failure.at, timezone)}`,
            ]
          : []),
        ...(assistant.reason ? [`    Cause: ${assistant.reason}`] : []),
      ]),
      ...capability.readiness_limits.map((line) => `  ${line}`),
    );
  lines.push(`Observed: ${formatLocalTime(capability.observed_at, timezone)}`);
  return lines;
}

/** Handoffs follow observed facts; an unknown consumer never becomes evidence of readiness. */
export function voiceCapabilityNextActions(
  capability: VoiceCapabilityObservation,
  checked: boolean,
): readonly NextAction[] {
  const command = (action: string, ...args: string[]): NextAction => ({
    kind: 'command',
    argv: ['gws-ea', 'capabilities', action, 'voice', ...args],
  });
  if (capability.availability.status === 'unsupported')
    return [
      {
        kind: 'external',
        instruction: 'Voice requires macOS/Linux on arm64/x64. Use a supported host for local voice.',
      },
    ];
  if (capability.activation.status === 'unknown')
    return [
      {
        kind: 'external',
        instruction:
          capability.activation.reason ?? 'Inspect and restore a valid disabled voice policy before continuing.',
      },
    ];
  if (capability.assets.status === 'absent')
    return [
      command('install', ...(capability.assets.selected_model ? ['--model', capability.assets.selected_model] : [])),
    ];
  if (capability.assets.status === 'unknown')
    return [
      {
        kind: 'external',
        instruction: capability.assets.reason ?? 'Inspect the selected voice assets before continuing.',
      },
    ];
  if (capability.assets.status === 'invalid') {
    const selected = capability.assets.installations.find(
      (installation) => installation.directory === capability.assets.selected_directory,
    );
    return voiceCapabilityRecovery(
      new GwsEaError(
        selected ? 'voice_assets_invalid' : 'voice_assets_unowned',
        capability.assets.reason ?? 'Selected assets are invalid.',
        { details: selected ? { model: selected.model } : {} },
      ),
    );
  }
  const actions: NextAction[] =
    capability.activation.status === 'disabled' ? [command('enable')] : checked ? [] : [command('check')];
  for (const id of capability.unsupported_assistant_ids)
    actions.push({ kind: 'command', argv: ['gws-ea', 'update', '--id', id] });
  for (const assistant of capability.assistants)
    if (
      assistant.compatibility === 'unknown' ||
      (checked && assistant.compatibility === 'compatible' && assistant.consumer.status === 'unknown')
    ) {
      actions.push(
        {
          kind: 'external',
          instruction: `Voice state could not be observed for assistant ${assistant.instance_id}. Inspect its runtime, release, and service status.`,
        },
        { kind: 'command', argv: ['gws-ea', 'status', '--id', assistant.instance_id] },
      );
    }
  return actions;
}

/** Exact recovery commands for the voice domain's existing error codes. */
export function voiceCapabilityRecovery(
  error: unknown,
  request: { readonly action?: string; readonly model?: string; readonly cmake?: string } = {},
): readonly NextAction[] {
  if (!(error instanceof GwsEaError)) return [];
  const selected = request.model ?? error.details?.model;
  const model =
    selected === 'base' || selected === 'small' || selected === 'large-v3-turbo-q5_0' ? selected : undefined;
  const installOptions = [...(model ? ['--model', model] : []), ...(request.cmake ? ['--cmake', request.cmake] : [])];
  const command = (action: 'install' | 'enable' | 'disable' | 'uninstall' | 'check'): NextAction => ({
    kind: 'command',
    argv: ['gws-ea', 'capabilities', action, 'voice', ...(action === 'install' ? installOptions : [])],
  });
  const retry: NextAction = {
    kind: 'command',
    argv: [
      'gws-ea',
      'capabilities',
      request.action ?? 'install',
      'voice',
      ...(request.action === 'install' || !request.action ? installOptions : []),
    ],
  };
  switch (error.code) {
    case 'voice_build_prerequisite':
      return [
        {
          kind: 'external',
          instruction: typeof error.details?.instruction === 'string' ? error.details.instruction : error.message,
        },
        retry,
      ];
    case 'voice_download_failed':
    case 'voice_checksum_failed':
    case 'voice_build_failed':
    case 'voice_install_failed':
    case 'voice_cleanup_failed':
      return [
        {
          kind: 'external',
          instruction:
            'Inspect the retained step log and repair the reported network, toolchain, or filesystem failure before retrying. Published assets, if any, remain disabled.',
        },
        retry,
      ];
    case 'voice_busy':
    case 'instance_busy':
    case 'registry_busy':
      return [{ kind: 'external', instruction: 'Let the other operation finish, then retry.' }, retry];
    case 'voice_not_installed':
      return [command('install'), command('enable')];
    case 'voice_assets_invalid':
      return [command('disable'), command('uninstall'), command('install')];
    case 'voice_enabled':
      return [command('disable')];
    case 'voice_assets_unowned':
      return [
        {
          kind: 'external',
          instruction:
            'Selected assets are outside the recipe-owned cache. Inspect the policy; disable voice before explicitly installing/selecting recipe-owned assets. External assets will not be deleted.',
        },
        command('disable'),
        command('install'),
      ];
    case 'voice_policy_invalid':
      return [{ kind: 'external', instruction: error.message }];
    case 'voice_operation_failed':
      return [
        { kind: 'external', instruction: error.message },
        { kind: 'command', argv: ['gws-ea', 'capabilities', 'check', 'voice'] },
        retry,
      ];
    case 'voice_drain_unproven':
    case 'voice_not_drained':
      return [
        command('check'),
        {
          kind: 'external',
          instruction: error.message,
        },
        ...(typeof error.details?.instanceId === 'string'
          ? [{ kind: 'command' as const, argv: ['gws-ea', 'stop', '--id', error.details.instanceId] }]
          : []),
        command('uninstall'),
      ];
    default:
      return [];
  }
}
