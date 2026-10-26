/** Local discovery and bounded verification share one connector result contract. */
import type { OnePasswordCliSeams, OnePasswordCapabilityObservation } from './onepassword.js';
import {
  inspectOnePasswordCapability,
  onePasswordCapabilityLines,
  onePasswordCapabilityNextActions,
} from './onepassword.js';
import { inspectOnePasswordUninstall } from './onepassword-uninstall.js';
import {
  inspectArtifactsCapability,
  supportedCloudflaredVersion,
  artifactsReleaseCompatibility,
  inspectArtifactsUninstall,
  type ArtifactsCapabilityDependencies,
  type ArtifactsCapabilityObservation,
} from './artifacts-connector.js';
import {
  readArtifactsOperatorConfig,
  artifactsOperatorFiles,
  artifactsApi,
  type ArtifactsOperatorConfig,
} from './artifacts-cloudflare.js';
import { CONNECTOR_ACTIONS, connectorDefinition, type ConnectorName, type ConnectorDefinition } from './connectors.js';
import {
  inspectVoiceCapability,
  capabilityLines,
  type VoiceCapabilityInspection,
  type VoiceCapabilityObservation,
} from './voice-inspection.js';
import { runInstanceNclJson } from './ncl.js';
import { buildToolEnvironment, runSanitizedCommandOutcome } from './process.js';
import { readRegistry, getInstanceReservation } from './registry.js';
import { loadInstanceRuntimeConfig, type HostStatusHelpers } from './service.js';
import { createServiceControl, runtimeServiceTarget, type NanoclawServiceHelpers } from './service-control.js';
import type { ControlPlanePaths } from './paths.js';
import type { NextAction } from './result.js';
import { GwsEaError } from './types.js';
import { isRecord } from './validation.js';
import { formatLocalTime } from '../timezone.js';

export type ConnectorSetup = 'not_installed' | 'installed' | 'pending' | 'uninstall_incomplete' | 'unknown' | 'failed';
export type ConnectorCompatibility = 'compatible' | 'unsupported' | 'unknown';
export interface ConnectorReadiness {
  readonly status: 'ready' | 'not_ready' | 'not_checked' | 'unknown';
  readonly checked: boolean;
}
export interface ConnectorAssistantObservation {
  readonly instance_id: string;
  readonly compatibility: ConnectorCompatibility;
  readonly setup: ConnectorSetup;
  readonly readiness: ConnectorReadiness;
  readonly reasons: readonly string[];
  readonly next_actions: readonly NextAction[];
}
interface ConnectorPrerequisite {
  readonly requirement: string;
  readonly status: 'satisfied' | 'missing' | 'not_checked' | 'unknown';
  readonly reason: string | null;
}
export interface ConnectorObservation {
  readonly name: ConnectorName;
  readonly summary: string;
  readonly observed_at: string;
  readonly target: string | null;
  readonly actions: typeof CONNECTOR_ACTIONS;
  readonly scope: ConnectorDefinition['scope'];
  readonly account: string;
  readonly compatibility: ConnectorCompatibility;
  readonly prerequisites: readonly ConnectorPrerequisite[];
  readonly setup: ConnectorSetup;
  readonly readiness: ConnectorReadiness;
  readonly assistants: readonly ConnectorAssistantObservation[];
  readonly reasons: readonly string[];
  readonly next_actions: readonly NextAction[];
  readonly details:
    | VoiceCapabilityObservation
    | OnePasswordCapabilityObservation
    | readonly ArtifactsCapabilityObservation[];
}
export interface ConnectorInspection {
  readonly check?: boolean;
  readonly instanceId?: string;
  readonly voice?: VoiceCapabilityInspection;
  readonly onePassword?: OnePasswordCliSeams;
  readonly artifacts?: ArtifactsCapabilityDependencies;
  readonly serviceHelpers?: NanoclawServiceHelpers;
  readonly hostStatus?: Pick<HostStatusHelpers, 'queryHost'>;
}
const readiness = (checked: boolean, ready = false): ConnectorReadiness => ({
  status: checked ? (ready ? 'ready' : 'not_ready') : 'not_checked',
  checked,
});
const repair = (name: ConnectorName): NextAction => ({
  kind: 'command',
  argv: ['gws-ea', 'connectors', 'install', name],
});
const uninstall = (name: ConnectorName): NextAction => ({
  kind: 'command',
  argv: ['gws-ea', 'connectors', 'uninstall', name],
});
const update = (instanceId: string): NextAction => ({
  kind: 'command',
  argv: ['gws-ea', 'update', '--id', instanceId],
});
const start = (instanceId: string): NextAction => ({ kind: 'command', argv: ['gws-ea', 'start', '--id', instanceId] });
const status = (instanceId: string): NextAction => ({
  kind: 'command',
  argv: ['gws-ea', 'status', '--id', instanceId],
});
const uniqueActions = (actions: readonly NextAction[]): NextAction[] => [
  ...new Map(actions.map((action) => [JSON.stringify(action), action])).values(),
];

/** Failed reachability is not a readiness failure: the host check reports the local facts only. */
async function reachable(paths: ControlPlanePaths, id: string, options: ConnectorInspection): Promise<boolean> {
  if (!options.serviceHelpers && !options.hostStatus) return true;
  try {
    const runtime = await loadInstanceRuntimeConfig(paths.runtimeFile(id));
    if (
      options.serviceHelpers &&
      !createServiceControl(options.serviceHelpers, runtimeServiceTarget(runtime)).detect().active
    )
      return false;
    if (options.hostStatus) await options.hostStatus.queryHost(runtime.checkout_root);
    return true;
    // eslint-disable-next-line no-catch-all/no-catch-all -- Reachability is an observation; failed helpers do not prove the assistant is unhealthy.
  } catch (_error) {
    return false;
  }
}

interface UninstallObservation {
  readonly incomplete: boolean;
  readonly unknown: boolean;
  readonly reasons: readonly string[];
  readonly nextActions: readonly NextAction[];
}
async function observeUninstall(paths: ControlPlanePaths, name: ConnectorName): Promise<UninstallObservation> {
  try {
    if (name === 'onepassword') {
      const inspection = await inspectOnePasswordUninstall(paths);
      const reasons: string[] = [];
      const actions: NextAction[] = [];
      if (inspection.incomplete) {
        reasons.push(
          `1Password uninstall is incomplete. Its ownership and recovery receipt is ${inspection.receipt_file}.`,
        );
        actions.push(uninstall(name));
      }
      if (inspection.receipt) {
        for (const generation of [...inspection.receipt.history, inspection.receipt]) {
          if (generation.management_creation_unproven)
            reasons.push(
              'A management service account may have been created without a recorded ID. Inspect and revoke that unproven creation on 1Password.com.',
            );
          for (const [id, entry] of Object.entries(generation.assistants)) {
            for (const creation of entry.cleanup.unproven)
              reasons.push(
                `Assistant ${id}: unproven ${creation.kind.replaceAll('_', ' ')} ${creation.name}. Inspect its possible remote creation before acknowledging this receipt.`,
              );
            if (entry.cleanup.operator_action) reasons.push(entry.cleanup.operator_action);
          }
        }
      }
      if (inspection.revoke_service_account_ids.length) {
        const instruction = `Revoke these service accounts on 1Password.com: ${inspection.revoke_service_account_ids.join(', ')}. Keep the receipt until every recorded account has been revoked.`;
        reasons.push(instruction);
        actions.push({ kind: 'external', instruction });
      }
      if (inspection.status === 'completed')
        actions.push({ kind: 'command', argv: ['gws-ea', 'connectors', 'uninstall', name, '--abandon'] });
      return { incomplete: inspection.incomplete, unknown: false, reasons, nextActions: actions };
    }
    if (name === 'artifacts') {
      const receipt = await inspectArtifactsUninstall(paths);
      if (receipt)
        return {
          incomplete: true,
          unknown: false,
          reasons: ['Artifacts uninstall is incomplete.', ...(receipt.reason ? [receipt.reason] : [])],
          nextActions: [uninstall(name)],
        };
    }
    return { incomplete: false, unknown: false, reasons: [], nextActions: [] };
    // eslint-disable-next-line no-catch-all/no-catch-all -- An unreadable receipt remains an explicit unknown and fences live checks; never infer completed cleanup.
  } catch (_error) {
    return {
      incomplete: false,
      unknown: true,
      reasons: [
        `The ${name} uninstall receipt is invalid or inaccessible. Inspect its owner-only file before continuing.`,
      ],
      nextActions: [],
    };
  }
}

/** Verify shared prerequisites even on a host with no eligible assistants; every provider call is a GET. */
async function checkArtifactsHost(
  paths: ControlPlanePaths,
  config: ArtifactsOperatorConfig,
  dependencies: ArtifactsCapabilityDependencies,
): Promise<readonly [ConnectorPrerequisite['status'], ConnectorPrerequisite['status'], string | null]> {
  try {
    const result = await (dependencies.runCommand ?? runSanitizedCommandOutcome)({
      command: config.cloudflaredPath,
      args: ['--version'],
      cwd: artifactsOperatorFiles(paths).root,
      env: buildToolEnvironment({}, { HOME: config.connector?.homeDirectory ?? process.env.HOME ?? '/' }),
      timeoutMs: 5000,
      outputLimitBytes: 4096,
    });
    if (result.exitCode !== 0 || !supportedCloudflaredVersion(result.stdout))
      return ['not_checked', 'missing', 'cloudflared 2025.4.0 or later is required at the recorded operator path.'];
    // eslint-disable-next-line no-catch-all/no-catch-all -- A missing external binary is an optional prerequisite, never a failed discovery command.
  } catch (_error) {
    return [
      'not_checked',
      'missing',
      'The recorded cloudflared executable is missing or could not report its version.',
    ];
  }
  try {
    const api = await artifactsApi(config, dependencies);
    const zone = await api.request('GET', `/zones/${config.zoneId}`);
    if (
      !isRecord(zone) ||
      zone.id !== config.zoneId ||
      zone.status !== 'active' ||
      !isRecord(zone.account) ||
      zone.account.id !== config.accountId ||
      typeof zone.name !== 'string' ||
      !(config.hostname === zone.name || config.hostname.endsWith(`.${zone.name}`))
    )
      return [
        'missing',
        'satisfied',
        'The recorded artifact hostname does not belong to its active Cloudflare zone and account.',
      ];
    const organization = await api.request('GET', `/accounts/${config.accountId}/access/organizations`);
    if (!isRecord(organization) || organization.auth_domain !== `${config.teamName}.cloudflareaccess.com`)
      return ['missing', 'satisfied', 'The recorded Cloudflare Access team could not be verified.'];
    return ['satisfied', 'satisfied', null];
    // eslint-disable-next-line no-catch-all/no-catch-all -- Provider failures are bounded read-only readiness facts; their raw payloads must never reach output.
  } catch (error) {
    return [
      'unknown',
      'satisfied',
      error instanceof GwsEaError ? error.message : 'Cloudflare account prerequisites could not be observed.',
    ];
  }
}

export async function inspectConnector(
  paths: ControlPlanePaths,
  name: ConnectorName,
  options: ConnectorInspection = {},
): Promise<ConnectorObservation> {
  const definition = connectorDefinition(name);
  const checked = options.check === true;
  if (options.instanceId) await getInstanceReservation(paths, options.instanceId);
  const ids = options.instanceId ? [options.instanceId] : Object.keys((await readRegistry(paths)).instances).sort();
  const removal = await observeUninstall(paths, name);
  const canCheck = checked && !removal.incomplete && !removal.unknown;
  const unavailable = new Set<string>();
  if (canCheck)
    for (let offset = 0; offset < ids.length; offset += 4) {
      const batch = ids.slice(offset, offset + 4);
      const states = await Promise.all(
        batch.map(async (id) => ({ id, reachable: await reachable(paths, id, options) })),
      );
      for (const state of states) if (!state.reachable) unavailable.add(state.id);
    }
  const assistants: ConnectorAssistantObservation[] = [];
  const reasons = [...removal.reasons];
  const hostActions = [...removal.nextActions];
  const prerequisiteStates: ConnectorPrerequisite['status'][] = definition.prerequisites.map(() => 'not_checked');
  let setup: ConnectorSetup = 'not_installed';
  let compatible: ConnectorCompatibility = 'compatible';
  let hostReady = false;
  let needsRepair = false;
  let details: ConnectorObservation['details'];
  if (name === 'voice') {
    const ncl = options.voice?.ncl ?? runInstanceNclJson;
    const voice = await inspectVoiceCapability(paths, {
      ...options.voice,
      checkConsumers: canCheck,
      verifyAssets: canCheck,
      instanceId: options.instanceId,
      ncl: (runtime, args) => {
        if (unavailable.has(runtime.instance_id))
          throw new GwsEaError(
            'connector_not_checked',
            'The assistant is stopped or unreachable; its consumer was not checked.',
          );
        return ncl(runtime, args);
      },
    });
    details = voice;
    setup =
      voice.assets.status === 'absent'
        ? 'not_installed'
        : voice.assets.status === 'invalid'
          ? 'failed'
          : voice.assets.status === 'unknown'
            ? 'unknown'
            : 'installed';
    compatible = voice.availability.status === 'supported' ? 'compatible' : 'unsupported';
    hostReady =
      compatible === 'compatible' && voice.activation.status === 'enabled' && voice.assets.status === 'verified';
    prerequisiteStates[0] = compatible === 'compatible' ? 'satisfied' : 'missing';
    if (voice.activation.reason) reasons.push(voice.activation.reason);
    if (voice.assets.reason) reasons.push(voice.assets.reason);
    if (setup === 'installed' && voice.activation.status === 'disabled') {
      reasons.push('Installed, stopped. Run gws-ea connectors install voice to make recognition available.');
      needsRepair = true;
    }
    for (const assistant of voice.assistants) {
      const observed = canCheck && assistant.consumer.status === 'observed';
      if (canCheck && assistant.compatibility === 'compatible' && !observed) unavailable.add(assistant.instance_id);
      assistants.push({
        instance_id: assistant.instance_id,
        compatibility: assistant.compatibility,
        setup,
        readiness: readiness(observed, assistant.readiness === 'ready'),
        reasons: assistant.reason ? [assistant.reason] : [],
        next_actions:
          assistant.compatibility === 'unsupported'
            ? [update(assistant.instance_id)]
            : unavailable.has(assistant.instance_id)
              ? [start(assistant.instance_id)]
              : assistant.compatibility === 'unknown'
                ? [status(assistant.instance_id)]
                : observed && assistant.readiness !== 'ready'
                  ? [repair(name)]
                  : [],
      });
    }
  } else if (name === 'onepassword') {
    const observation = await inspectOnePasswordCapability(paths, {
      check: canCheck,
      cli: options.onePassword,
      instanceId: options.instanceId,
      checkAssistantIds: ids.filter((id) => !unavailable.has(id)),
    });
    details = observation;
    if (!removal.incomplete && !removal.unknown)
      hostActions.push(...onePasswordCapabilityNextActions(observation, canCheck));
    setup =
      observation.activation.status === 'unknown'
        ? 'unknown'
        : observation.account_id === null
          ? 'not_installed'
          : observation.activation.status === 'enabled'
            ? 'installed'
            : 'pending';
    hostReady =
      observation.activation.status === 'enabled' &&
      observation.cli.status === 'available' &&
      observation.management.status === 'verified' &&
      observation.quota.daily?.remaining !== 0 &&
      observation.quota.reason?.includes('request limit is spent') !== true;
    prerequisiteStates[0] =
      observation.cli.status === 'available'
        ? 'satisfied'
        : observation.cli.status === 'unavailable'
          ? 'missing'
          : 'not_checked';
    if (observation.quota.daily?.remaining === 0) reasons.push('The shared 1Password account request limit is spent.');
    for (const reason of [observation.activation.reason, observation.management.reason, observation.cli.reason])
      if (reason) reasons.push(reason);
    for (const assistant of observation.assistants) {
      const state: ConnectorSetup =
        assistant.provisioning === 'ready'
          ? 'installed'
          : assistant.provisioning === 'invalid'
            ? 'failed'
            : observation.account_id === null
              ? 'not_installed'
              : 'pending';
      const observed = canCheck && !unavailable.has(assistant.instance_id) && assistant.compatibility === 'compatible';
      const ready = assistant.access.status === 'verified';
      const why = [assistant.reason, assistant.access.reason].filter((reason): reason is string => reason !== null);
      if (state === 'pending' && why.length === 0)
        why.push('The assistant vault and runtime credentials have not been provisioned.');
      if (unavailable.has(assistant.instance_id))
        why.push('The assistant is stopped or unreachable; runtime access was not checked.');
      assistants.push({
        instance_id: assistant.instance_id,
        compatibility: assistant.compatibility,
        setup: state,
        readiness: readiness(observed, ready),
        reasons: why,
        next_actions:
          assistant.compatibility === 'unsupported'
            ? [update(assistant.instance_id)]
            : assistant.compatibility === 'unknown'
              ? [status(assistant.instance_id)]
              : unavailable.has(assistant.instance_id)
                ? [start(assistant.instance_id)]
                : state !== 'installed' || (observed && !ready)
                  ? [repair(name)]
                  : [],
      });
    }
  } else {
    let config: ArtifactsOperatorConfig | undefined;
    try {
      config = await readArtifactsOperatorConfig(artifactsOperatorFiles(paths).configFile);
      setup = config ? 'installed' : 'not_installed';
      // eslint-disable-next-line no-catch-all/no-catch-all -- Invalid optional local configuration remains a fact in discovery rather than hiding the catalog.
    } catch (_error) {
      setup = 'unknown';
      reasons.push('Artifacts operator configuration is invalid or inaccessible.');
    }
    if (config?.pending) {
      setup = 'pending';
      reasons.push(`Unresolved ${config.pending.kind}: ${config.pending.key}.`);
      if (!removal.incomplete && !removal.unknown)
        hostActions.push({
          kind: 'command',
          argv: ['gws-ea', 'connectors', 'install', name, '--discard-unproven', config.pending.key],
        });
    }
    if (canCheck && config && !config.pending) {
      const [account, executable, reason] = await checkArtifactsHost(paths, config, options.artifacts ?? {});
      prerequisiteStates[0] = account;
      prerequisiteStates[1] = executable;
      hostReady = account === 'satisfied' && executable === 'satisfied';
      if (reason) reasons.push(reason);
    }
    const observations: ArtifactsCapabilityObservation[] = [];
    for (const id of ids) {
      let compatibility: ConnectorCompatibility = 'unknown';
      try {
        const runtime = await loadInstanceRuntimeConfig(paths.runtimeFile(id));
        compatibility = await artifactsReleaseCompatibility(runtime.checkout_root);
        const live = canCheck && compatibility === 'compatible' && !unavailable.has(id);
        const observation = await inspectArtifactsCapability(paths, id, { ...options.artifacts, check: live });
        observations.push(observation);
        const state: ConnectorSetup =
          observation.activation === 'enabled'
            ? 'installed'
            : observation.activation === 'unavailable'
              ? 'failed'
              : config
                ? 'pending'
                : 'not_installed';
        if (live && observation.reason?.includes('could not be observed')) unavailable.add(id);
        const observed = live && !unavailable.has(id);
        const why = observation.reason
          ? [observation.reason]
          : state === 'pending'
            ? ['Artifact serving has not been provisioned for this assistant.']
            : [];
        if (unavailable.has(id)) why.push('The assistant is stopped or unreachable; serving was not checked.');
        assistants.push({
          instance_id: id,
          compatibility,
          setup: state,
          readiness: readiness(observed, observation.ready),
          reasons: why,
          next_actions:
            compatibility === 'unsupported'
              ? [update(id)]
              : compatibility === 'unknown'
                ? [status(id)]
                : unavailable.has(id)
                  ? [start(id)]
                  : state !== 'installed' || (observed && !observation.ready)
                    ? [repair(name)]
                    : [],
        });
        // eslint-disable-next-line no-catch-all/no-catch-all -- An unreadable runtime remains unknown local state; other assistants and connectors still report.
      } catch (_error) {
        assistants.push({
          instance_id: id,
          compatibility,
          setup: 'unknown',
          readiness: readiness(false),
          reasons: ['Assistant runtime or local artifact state could not be observed.'],
          next_actions: [status(id)],
        });
      }
    }
    details = observations;
  }
  if (removal.incomplete) setup = 'uninstall_incomplete';
  else if (removal.unknown) setup = 'unknown';
  if (setup === 'not_installed') reasons.push(`${name} is not installed.`);
  const selected = options.instanceId
    ? assistants.find((assistant) => assistant.instance_id === options.instanceId)
    : undefined;
  const eligible = assistants.filter(
    (assistant) => assistant.compatibility !== 'unsupported' && !unavailable.has(assistant.instance_id),
  );
  const targetReady = options.instanceId
    ? selected?.compatibility === 'compatible' && selected.readiness.status === 'ready'
    : eligible.every(
        (assistant) =>
          assistant.compatibility === 'compatible' &&
          assistant.setup === 'installed' &&
          assistant.readiness.status === 'ready',
      );
  const ready = hostReady && targetReady && setup === 'installed';
  if (!removal.incomplete && !removal.unknown && (needsRepair || setup !== 'installed' || (checked && !hostReady)))
    hostActions.push(repair(name));
  return {
    name,
    summary: definition.summary,
    observed_at: new Date().toISOString(),
    target: options.instanceId ?? null,
    actions: CONNECTOR_ACTIONS,
    scope: definition.scope,
    account: definition.account,
    compatibility: selected?.compatibility ?? compatible,
    prerequisites: definition.prerequisites.map((requirement, index) => ({
      requirement,
      status: prerequisiteStates[index],
      reason: null,
    })),
    setup,
    readiness: readiness(checked, ready),
    assistants,
    reasons,
    next_actions: uniqueActions([...hostActions, ...assistants.flatMap((assistant) => assistant.next_actions)]),
    details,
  };
}

export function connectorLines(
  observation: ConnectorObservation,
  detailed = true,
  timezone = Intl.DateTimeFormat().resolvedOptions().timeZone,
): readonly string[] {
  const details = observation.details;
  const specific = !detailed
    ? []
    : 'name' in details
      ? (details.name === 'voice'
          ? capabilityLines(details, true, timezone)
          : onePasswordCapabilityLines(details, true, timezone)
        ).slice(1, -1)
      : details.flatMap((assistant) => [
          `  Assistant ${assistant.instance_id}: ${assistant.hostname ?? 'hostname not configured'}${assistant.path_prefix ?? ''}`,
          `    Origin: ${assistant.activation}; remote: ${assistant.remote.replaceAll('_', ' ')}; listener: ${assistant.listener.replaceAll('_', ' ')}`,
        ]);
  return [
    `${observation.name} (host): ${observation.summary}`,
    `  Setup: ${observation.setup.replaceAll('_', ' ')}; readiness: ${observation.readiness.status.replaceAll('_', ' ')}.`,
    `  Resources: ${observation.scope.resources}. ${observation.account}`,
    ...observation.reasons.map((reason) => `  ${reason}`),
    ...observation.assistants.map(
      (assistant) =>
        `  Assistant ${assistant.instance_id}: ${assistant.compatibility}; ${assistant.setup.replaceAll('_', ' ')}; ${assistant.readiness.status.replaceAll('_', ' ')}${assistant.reasons.length ? ` (${assistant.reasons.join(' ')})` : ''}`,
    ),
    ...observation.prerequisites.map(
      (prerequisite) => `  Prerequisite: ${prerequisite.requirement} (${prerequisite.status.replaceAll('_', ' ')})`,
    ),
    ...specific,
    `Observed: ${formatLocalTime(observation.observed_at, timezone)}`,
  ];
}
