import { access, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { readJson, writePrivate } from '../community-portal/private-file.js';
import { processLock } from '../community-portal/process-lock.js';
import { isErrno } from '../community-portal/errors.js';
import { deleteOwnedGcpProject } from './gcloud.js';
import {
  createCloudflareApi,
  type CloudflareApi,
  type CloudflareDnsRecord,
  type CloudflareDnsRecordWrite,
} from './cloudflare-api.js';
import {
  createCloudflareConnectorLayout,
  inspectCloudflareConnector,
  stopCloudflareConnector,
  validateObservedCloudflareConnector,
  type CloudflareConnectorLayout,
  type CloudflareConnectorPlatform,
  type ObservedCloudflareConnector,
} from './cloudflare-connector.js';
import {
  assertManagedCloudflareConfigurationOwnership,
  chooseOwnedDnsRecord,
  desiredDnsRecord,
  GCHAT_TUNNEL_PATH,
  renderManagedCloudflareConfiguration,
  replaceManagedCloudflareConfiguration,
  type CloudflareOriginHost,
  type ManagedCloudflareConfiguration,
} from './cloudflare-ingress.js';
import { createOnecliRuntimeLayout } from './onecli-compose.js';
import { removeOnecliRuntime } from './onecli.js';
import {
  assertPrivateDirectory,
  assertPrivateStateFile,
  preparePrivateDirectory,
  type ControlPlanePaths,
} from './paths.js';
import { buildToolEnvironment, runSanitizedCommand, runSanitizedCommandOutcome } from './process.js';
import {
  activeRemovalInstanceIds,
  assertInstanceId,
  assertRegistryMarkerAgreement,
  getInstanceReservation,
  readRegistry,
  releaseInstanceReservation,
  validateReservation,
  withLockedCloudflareRegistry,
} from './registry.js';
import { removePrivateFile } from './secrets.js';
import { readRecordedHomeDirectory } from './service.js';
import { createInstanceServiceCoordinates, type InstanceServicePlatform } from './service-coordinates.js';
import {
  GwsEaError,
  ingressEndpointUrl,
  type InstanceRegistry,
  type InstanceReservation,
  type ManagedCloudflareIngressClaim,
} from './types.js';
import { isRecord } from './validation.js';

const REMOVAL_SCHEMA_VERSION = 2 as const;
const REMOVAL_PHASES = ['ingress', 'nanoclaw', 'gcp_project', 'onecli', 'instance_files', 'registry'] as const;
type RemovalPhase = (typeof REMOVAL_PHASES)[number];
const MANAGED_INGRESS_STEPS = ['configuration', 'dns', 'connector', 'connections', 'tunnel', 'private_state'] as const;
type ManagedIngressStep = (typeof MANAGED_INGRESS_STEPS)[number];

interface RemovalStepReceipt {
  readonly intended_at: string | null;
  readonly completed_at: string | null;
}

interface ManagedIngressRemovalReceipt {
  readonly final: boolean | null;
  readonly steps: Record<ManagedIngressStep, RemovalStepReceipt>;
}

interface RemovalReceipt {
  readonly schema_version: typeof REMOVAL_SCHEMA_VERSION;
  readonly instance_id: string;
  readonly reservation: InstanceReservation;
  readonly started_at: string;
  readonly managed_ingress: ManagedIngressRemovalReceipt | null;
  readonly completed: Record<RemovalPhase, string | null>;
}

export interface RemovalDependencies {
  readonly uninstallNanoclaw?: (reservation: InstanceReservation) => Promise<void>;
  readonly deleteGcpProject?: (reservation: InstanceReservation) => Promise<void>;
  readonly removeOnecli?: (reservation: InstanceReservation) => Promise<void>;
  readonly removeInstanceFiles?: (reservation: InstanceReservation) => Promise<void>;
  readonly requestCloudflareAccountToken?: (accountId: string, observation: string) => Promise<string>;
  readonly createCloudflareApi?: (accountToken: string) => CloudflareApi;
  readonly connectorPlatform?: CloudflareConnectorPlatform;
  readonly originHost?: CloudflareOriginHost;
  readonly inspectCloudflareConnector?: (
    layout: CloudflareConnectorLayout,
  ) => Promise<ObservedCloudflareConnector | undefined>;
  readonly validateCloudflareConnector?: (
    layout: CloudflareConnectorLayout,
    observed: ObservedCloudflareConnector,
  ) => void;
  readonly stopCloudflareConnector?: (layout: CloudflareConnectorLayout) => Promise<void>;
  readonly removeCloudflarePrivateState?: (layout: CloudflareConnectorLayout) => Promise<void>;
  readonly connectionDelay?: (milliseconds: number) => Promise<void>;
}

export interface ExistingRemovalPreview {
  readonly mode: 'existing';
  readonly endpoint: string;
}

export interface ManagedRemovalPreview {
  readonly mode: 'managed-cloudflare';
  readonly hostname: string;
  readonly callback: string;
  readonly dnsRecordId: string | null;
  readonly route: string;
  readonly sharedIngress: 'retained-for-peers' | 'retired';
}

export interface RemovalPreview {
  readonly instanceId: string;
  readonly checkout: string;
  readonly gcpProject: string;
  readonly gcpAccount: string;
  readonly onecliProject: string;
  readonly ingress: ExistingRemovalPreview | ManagedRemovalPreview;
}

function isoTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new GwsEaError('invalid_removal', `${label} is invalid`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new GwsEaError('invalid_removal', `${label} is invalid`);
  }
  return value;
}

function nullableTimestamp(value: unknown, label: string): string | null {
  return value === null ? null : isoTimestamp(value, label);
}

function validateManagedIngressReceipt(value: unknown): ManagedIngressRemovalReceipt | null {
  if (value === null) return null;
  if (!isRecord(value)) throw new GwsEaError('invalid_removal', 'Managed ingress removal state is invalid');
  if (value.final !== null && typeof value.final !== 'boolean') {
    throw new GwsEaError('invalid_removal', 'Managed ingress removal scope is invalid');
  }
  if (!isRecord(value.steps)) throw new GwsEaError('invalid_removal', 'Managed ingress removal steps are invalid');
  const steps = {} as Record<ManagedIngressStep, RemovalStepReceipt>;
  for (const step of MANAGED_INGRESS_STEPS) {
    const raw = value.steps[step];
    if (!isRecord(raw)) throw new GwsEaError('invalid_removal', `Managed ingress ${step} step is invalid`);
    const intendedAt = nullableTimestamp(raw.intended_at, `${step} intent`);
    const completedAt = nullableTimestamp(raw.completed_at, `${step} completion`);
    if (completedAt !== null && intendedAt === null) {
      throw new GwsEaError('invalid_removal', `Managed ingress ${step} completed without intent`);
    }
    steps[step] = { intended_at: intendedAt, completed_at: completedAt };
  }
  return { final: value.final, steps };
}

function assertManagedIngressReceiptOrder(
  managed: ManagedIngressRemovalReceipt,
  ingressCompletedAt: string | null,
): void {
  let priorCompleted = true;
  for (const step of MANAGED_INGRESS_STEPS) {
    const state = managed.steps[step];
    if (!priorCompleted && state.intended_at !== null) {
      throw new GwsEaError('invalid_removal', `Managed ingress ${step} started before its predecessor completed`);
    }
    priorCompleted = state.completed_at !== null;
  }
  if (managed.final === null && MANAGED_INGRESS_STEPS.some((step) => managed.steps[step].intended_at !== null)) {
    throw new GwsEaError('invalid_removal', 'Managed ingress teardown began before its scope was recorded');
  }
  if (
    managed.final === false &&
    MANAGED_INGRESS_STEPS.slice(2).some((step) => managed.steps[step].intended_at !== null)
  ) {
    throw new GwsEaError('invalid_removal', 'Peer-preserving removal contains final-ingress teardown steps');
  }
  if (
    ingressCompletedAt !== null &&
    (!managed.steps.configuration.completed_at ||
      !managed.steps.dns.completed_at ||
      (managed.final === true && MANAGED_INGRESS_STEPS.some((step) => !managed.steps[step].completed_at)))
  ) {
    throw new GwsEaError('invalid_removal', 'Ingress removal completed before its managed teardown steps');
  }
}

function validateReceipt(value: unknown, paths: ControlPlanePaths, instanceId: string): RemovalReceipt {
  if (!isRecord(value)) throw new GwsEaError('invalid_removal', 'Removal receipt is invalid');
  if (value.schema_version !== REMOVAL_SCHEMA_VERSION || value.instance_id !== instanceId) {
    throw new GwsEaError('invalid_removal', 'Removal receipt does not match this instance');
  }
  if (!isRecord(value.completed)) throw new GwsEaError('invalid_removal', 'Removal phases are invalid');
  const completed = {} as Record<RemovalPhase, string | null>;
  for (const phase of REMOVAL_PHASES) {
    const stamp = value.completed[phase];
    completed[phase] = stamp === null ? null : isoTimestamp(stamp, `${phase} completion`);
  }
  const reservation = validateReservation(value.reservation, paths);
  if (reservation.instance_id !== instanceId) {
    throw new GwsEaError('invalid_removal', 'Removal reservation does not match this instance');
  }
  const managedIngress = validateManagedIngressReceipt(value.managed_ingress);
  if ((reservation.exclusive_resource_claims.ingress.mode === 'managed-cloudflare') !== (managedIngress !== null)) {
    throw new GwsEaError('invalid_removal', 'Removal ingress state does not match the reservation');
  }
  if (managedIngress) assertManagedIngressReceiptOrder(managedIngress, completed.ingress);
  return {
    schema_version: REMOVAL_SCHEMA_VERSION,
    instance_id: instanceId,
    reservation,
    started_at: isoTimestamp(value.started_at, 'Removal start'),
    managed_ingress: managedIngress,
    completed,
  };
}

async function readReceipt(paths: ControlPlanePaths, instanceId: string): Promise<RemovalReceipt | undefined> {
  const file = paths.removalFile(instanceId);
  try {
    await assertPrivateStateFile(file);
    return validateReceipt(await readJson<unknown>(file), paths, instanceId);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    if (error instanceof GwsEaError) throw error;
    throw new GwsEaError('invalid_removal', 'Removal receipt cannot be read safely');
  }
}

function emptyManagedIngressReceipt(): ManagedIngressRemovalReceipt {
  const steps = {} as Record<ManagedIngressStep, RemovalStepReceipt>;
  for (const step of MANAGED_INGRESS_STEPS) steps[step] = { intended_at: null, completed_at: null };
  return { final: null, steps };
}

async function ensureReceipt(
  paths: ControlPlanePaths,
  instanceId: string,
  reservation: InstanceReservation,
): Promise<RemovalReceipt> {
  const existing = await readReceipt(paths, instanceId);
  if (existing) return existing;
  const receipt: RemovalReceipt = {
    schema_version: REMOVAL_SCHEMA_VERSION,
    instance_id: instanceId,
    reservation,
    started_at: new Date().toISOString(),
    managed_ingress:
      reservation.exclusive_resource_claims.ingress.mode === 'managed-cloudflare' ? emptyManagedIngressReceipt() : null,
    completed: {
      ingress: null,
      nanoclaw: null,
      gcp_project: null,
      onecli: null,
      instance_files: null,
      registry: null,
    },
  };
  await withLockedCloudflareRegistry(paths, async (locked) => {
    const stored = locked.registry.instances[instanceId];
    if (!stored || JSON.stringify(stored) !== JSON.stringify(reservation)) {
      throw new GwsEaError('reservation_mismatch', 'Instance reservation changed before removal began');
    }
    const activeRemovals = await activeRemovalInstanceIds(paths, locked.registry);
    if (activeRemovals.some((activeInstanceId) => activeInstanceId !== instanceId)) {
      throw new GwsEaError('removal_in_progress', 'Another assistant removal is already in progress');
    }
    await preparePrivateDirectory(paths.removalRoot);
    await writePrivate(paths.removalFile(instanceId), receipt);
  });
  return receipt;
}

async function completePhase(
  paths: ControlPlanePaths,
  receipt: RemovalReceipt,
  phase: RemovalPhase,
  effect: () => Promise<void>,
): Promise<RemovalReceipt> {
  if (receipt.completed[phase] !== null) return receipt;
  await effect();
  const next: RemovalReceipt = {
    ...receipt,
    completed: { ...receipt.completed, [phase]: new Date().toISOString() },
  };
  await writePrivate(paths.removalFile(receipt.instance_id), next);
  return next;
}

async function writeReceipt(paths: ControlPlanePaths, receipt: RemovalReceipt): Promise<RemovalReceipt> {
  await writePrivate(paths.removalFile(receipt.instance_id), receipt);
  return receipt;
}

async function setManagedRemovalScope(
  paths: ControlPlanePaths,
  receipt: RemovalReceipt,
  final: boolean,
): Promise<RemovalReceipt> {
  const managed = receipt.managed_ingress;
  if (!managed) throw new GwsEaError('invalid_removal', 'Managed ingress removal state is missing');
  if (managed.final !== null && managed.final !== final) {
    throw new GwsEaError('reservation_mismatch', 'Managed ingress removal scope changed during teardown');
  }
  if (managed.final === final) return receipt;
  return writeReceipt(paths, { ...receipt, managed_ingress: { ...managed, final } });
}

async function intendManagedIngressStep(
  paths: ControlPlanePaths,
  receipt: RemovalReceipt,
  step: ManagedIngressStep,
): Promise<RemovalReceipt> {
  const managed = receipt.managed_ingress;
  if (!managed) throw new GwsEaError('invalid_removal', 'Managed ingress removal state is missing');
  const current = managed.steps[step];
  if (current.intended_at !== null) return receipt;
  return writeReceipt(paths, {
    ...receipt,
    managed_ingress: {
      ...managed,
      steps: {
        ...managed.steps,
        [step]: { intended_at: new Date().toISOString(), completed_at: null },
      },
    },
  });
}

async function completeManagedIngressStep(
  paths: ControlPlanePaths,
  receipt: RemovalReceipt,
  step: ManagedIngressStep,
): Promise<RemovalReceipt> {
  const managed = receipt.managed_ingress;
  if (!managed) throw new GwsEaError('invalid_removal', 'Managed ingress removal state is missing');
  const current = managed.steps[step];
  if (current.completed_at !== null) return receipt;
  if (current.intended_at === null) {
    throw new GwsEaError('invalid_removal', `Managed ingress ${step} completed without intent`);
  }
  return writeReceipt(paths, {
    ...receipt,
    managed_ingress: {
      ...managed,
      steps: {
        ...managed.steps,
        [step]: { ...current, completed_at: new Date().toISOString() },
      },
    },
  });
}

function stable(value: unknown): string {
  return JSON.stringify(value);
}

function registryWithoutInstance(registry: InstanceRegistry, instanceId: string): InstanceRegistry {
  const instances = { ...registry.instances };
  delete instances[instanceId];
  return { ...registry, instances };
}

function exactOwnedDnsRecord(
  records: readonly CloudflareDnsRecord[],
  desired: CloudflareDnsRecordWrite,
  recordId: string,
): CloudflareDnsRecord {
  const record = chooseOwnedDnsRecord(records, desired, recordId);
  if (!record) {
    throw new GwsEaError('foreign_cloudflare_dns', `Cloudflare DNS name ${desired.name} changed ownership`);
  }
  return record;
}

function assertOwnedTunnel(
  tunnels: Awaited<ReturnType<CloudflareApi['listTunnels']>>,
  tunnelId: string,
  tunnelName: string,
): void {
  if (
    tunnels.length !== 1 ||
    tunnels[0]?.id !== tunnelId ||
    tunnels[0].name !== tunnelName ||
    tunnels[0].configSource !== 'cloudflare'
  ) {
    throw new GwsEaError('foreign_cloudflare_tunnel', 'Cloudflare tunnel changed ownership during removal');
  }
}

const CONNECTION_ATTEMPTS = 30;
const CONNECTION_DELAY_MS = 1_000;

async function waitForTunnelConnectionsToClear(
  api: CloudflareApi,
  accountId: string,
  tunnelId: string,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<void> {
  for (let attempt = 0; attempt < CONNECTION_ATTEMPTS; attempt += 1) {
    if ((await api.listTunnelConnections(accountId, tunnelId)).length === 0) return;
    if (attempt + 1 < CONNECTION_ATTEMPTS) await sleep(CONNECTION_DELAY_MS);
  }
  throw new GwsEaError('cloudflare_connections_active', 'Cloudflare tunnel still has active connector sessions');
}

async function verifyManagedRemovalAuthority(
  claim: ManagedCloudflareIngressClaim,
  dependencies: RemovalDependencies,
): Promise<CloudflareApi> {
  if (!dependencies.requestCloudflareAccountToken) {
    throw new GwsEaError(
      'cloudflare_token_required',
      'A fresh Cloudflare API token is required to remove managed ingress.',
    );
  }
  const token = await dependencies.requestCloudflareAccountToken(
    claim.account_id,
    `Removing managed callback ${claim.callback_url} requires temporary Cloudflare authorization.`,
  );
  const api = (dependencies.createCloudflareApi ?? ((accountToken) => createCloudflareApi({ accountToken })))(token);
  await api.verifyToken();
  const zones = await api.listActiveZones();
  if (
    !zones.some(
      (zone) =>
        zone.accountId === claim.account_id &&
        zone.zoneId === claim.zone_id &&
        zone.name === claim.zone_name &&
        zone.status === 'active',
    )
  ) {
    throw new GwsEaError(
      'cloudflare_capability_missing',
      `Cloudflare authorization cannot access reserved active zone ${claim.zone_name}.`,
    );
  }
  return api;
}

async function inspectCloudflareConnectorForRemoval(
  layout: CloudflareConnectorLayout,
): Promise<ObservedCloudflareConnector | undefined> {
  return inspectCloudflareConnector(layout, (command) =>
    runSanitizedCommand({ ...command, cwd: path.dirname(path.dirname(layout.rootDirectory)) }),
  );
}

function stepCompleted(receipt: RemovalReceipt, step: ManagedIngressStep): boolean {
  return receipt.managed_ingress?.steps[step].completed_at !== null;
}

function stepIntended(receipt: RemovalReceipt, step: ManagedIngressStep): boolean {
  return receipt.managed_ingress?.steps[step].intended_at !== null;
}

async function removeManagedCloudflareIngress(
  paths: ControlPlanePaths,
  receiptInput: RemovalReceipt,
  api: CloudflareApi,
  dependencies: RemovalDependencies,
): Promise<RemovalReceipt> {
  return withLockedCloudflareRegistry(paths, async (locked) => {
    let receipt = receiptInput;
    const reservation = receipt.reservation;
    const claim = reservation.exclusive_resource_claims.ingress;
    if (claim.mode !== 'managed-cloudflare' || !receipt.managed_ingress) {
      throw new GwsEaError('invalid_removal', 'Managed ingress removal requires a managed reservation');
    }
    const stored = locked.registry.instances[reservation.instance_id];
    if (!stored || stable(stored) !== stable(reservation)) {
      throw new GwsEaError('reservation_mismatch', 'Managed ingress reservation changed during removal');
    }
    const activeRemovals = await activeRemovalInstanceIds(paths, locked.registry);
    if (activeRemovals.some((instanceId) => instanceId !== reservation.instance_id)) {
      throw new GwsEaError('removal_in_progress', 'Another assistant removal is already in progress');
    }
    const metadata = locked.registry.shared_infrastructure_metadata.cloudflare;
    if (!metadata || metadata.account_id !== claim.account_id) {
      throw new GwsEaError('cloudflare_state_missing', 'Shared Cloudflare ownership is incomplete');
    }
    const tunnelId = metadata.tunnel_id;
    const managedReservations = Object.values(locked.registry.instances).filter(
      (instance) => instance.exclusive_resource_claims.ingress.mode === 'managed-cloudflare',
    );
    const final = managedReservations.length === 1;
    receipt = await setManagedRemovalScope(paths, receipt, final);

    const originHost =
      dependencies.originHost ?? (process.platform === 'darwin' ? 'host.docker.internal' : '127.0.0.1');
    const ownershipUniverse = renderManagedCloudflareConfiguration(locked.registry, originHost);
    const desired = renderManagedCloudflareConfiguration(
      registryWithoutInstance(locked.registry, reservation.instance_id),
      originHost,
    );
    const tunnels = await api.listTunnels(claim.account_id, metadata.tunnel_name);
    const tunnelMissing = tunnels.length === 0;
    if (tunnelId === null) {
      if (!tunnelMissing) {
        throw new GwsEaError(
          'foreign_cloudflare_tunnel',
          'A Cloudflare tunnel exists by name without a durably recorded owned ID',
        );
      }
      if (claim.dns_record_id !== null) {
        throw new GwsEaError('invalid_removal', 'Managed DNS ownership exists without a recorded tunnel');
      }
    } else if (tunnelMissing) {
      if (!final || !stepIntended(receipt, 'tunnel')) {
        throw new GwsEaError('cloudflare_tunnel_missing', 'The owned Cloudflare tunnel is missing before teardown');
      }
    } else {
      assertOwnedTunnel(tunnels, tunnelId, metadata.tunnel_name);
    }

    let currentConfiguration: ManagedCloudflareConfiguration | undefined;
    if (tunnelId !== null && !tunnelMissing) {
      const observed = await api.getTunnelConfiguration(claim.account_id, tunnelId);
      currentConfiguration = assertManagedCloudflareConfigurationOwnership(observed.config, ownershipUniverse);
      if (stepCompleted(receipt, 'configuration')) {
        if (stable(currentConfiguration) !== stable(desired)) {
          throw new GwsEaError(
            'cloudflare_configuration_drift',
            'Cloudflare tunnel configuration changed after route teardown',
          );
        }
      } else if (!stepIntended(receipt, 'configuration') && stable(currentConfiguration) === stable(desired)) {
        throw new GwsEaError(
          'cloudflare_configuration_drift',
          'The managed route disappeared before removal intent was recorded',
        );
      }
    } else if (tunnelId !== null && !stepCompleted(receipt, 'configuration')) {
      throw new GwsEaError('invalid_removal', 'Cloudflare tunnel disappeared before route teardown completed');
    }

    const desiredDns = tunnelId === null ? undefined : desiredDnsRecord(reservation, tunnelId);
    let dnsRecords = await api.listDnsRecords(claim.zone_id, claim.hostname);
    if (claim.dns_record_id === null) {
      if (dnsRecords.length !== 0) {
        throw new GwsEaError('foreign_cloudflare_dns', `Cloudflare DNS name ${claim.hostname} is not owned`);
      }
    } else if (dnsRecords.length === 0) {
      if (!stepIntended(receipt, 'dns')) {
        throw new GwsEaError('cloudflare_dns_missing', 'The owned Cloudflare DNS record is missing before teardown');
      }
    } else {
      if (!desiredDns) throw new GwsEaError('invalid_removal', 'Managed DNS ownership has no recorded tunnel');
      exactOwnedDnsRecord(dnsRecords, desiredDns, claim.dns_record_id);
      if (stepCompleted(receipt, 'dns')) {
        throw new GwsEaError('cloudflare_dns_drift', 'The owned Cloudflare DNS record reappeared after deletion');
      }
    }

    const platform = dependencies.connectorPlatform ?? (process.platform === 'darwin' ? 'macos' : 'linux');
    const layout = createCloudflareConnectorLayout({ cloudflareRoot: paths.cloudflareRoot, platform });
    let privateRootPresent = true;
    try {
      await assertPrivateDirectory(paths.cloudflareRoot);
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error;
      privateRootPresent = false;
    }
    let observedConnector: ObservedCloudflareConnector | undefined;
    if (final && !stepCompleted(receipt, 'connector')) {
      observedConnector = await (dependencies.inspectCloudflareConnector ?? inspectCloudflareConnectorForRemoval)(
        layout,
      );
      if (observedConnector) {
        (dependencies.validateCloudflareConnector ?? validateObservedCloudflareConnector)(layout, observedConnector);
        if (!privateRootPresent) {
          throw new GwsEaError(
            'unsafe_connector_owner',
            'Cloudflare connector exists without its owned private runtime state',
          );
        }
      }
    }

    if (!stepCompleted(receipt, 'configuration')) {
      receipt = await intendManagedIngressStep(paths, receipt, 'configuration');
      if (tunnelId !== null && (!currentConfiguration || tunnelMissing)) {
        throw new GwsEaError('cloudflare_tunnel_missing', 'The owned Cloudflare tunnel is missing during teardown');
      }
      if (tunnelId !== null && currentConfiguration && stable(currentConfiguration) !== stable(desired)) {
        await replaceManagedCloudflareConfiguration(api, claim.account_id, tunnelId, desired, currentConfiguration);
      }
      receipt = await completeManagedIngressStep(paths, receipt, 'configuration');
    }

    if (!stepCompleted(receipt, 'dns')) {
      const wasIntended = stepIntended(receipt, 'dns');
      receipt = await intendManagedIngressStep(paths, receipt, 'dns');
      if (claim.dns_record_id !== null && dnsRecords.length > 0) {
        if (!desiredDns) throw new GwsEaError('invalid_removal', 'Managed DNS ownership has no recorded tunnel');
        let deletionError: unknown;
        try {
          await api.deleteDnsRecord(claim.zone_id, claim.dns_record_id);
          // The post-delete observation below resolves ambiguous failures safely.
          // eslint-disable-next-line no-catch-all/no-catch-all
        } catch (error) {
          deletionError = error;
        }
        dnsRecords = await api.listDnsRecords(claim.zone_id, claim.hostname);
        if (dnsRecords.length > 0) {
          exactOwnedDnsRecord(dnsRecords, desiredDns, claim.dns_record_id);
          if (deletionError) throw deletionError;
          throw new GwsEaError('cloudflare_dns_removal_incomplete', 'The owned Cloudflare DNS record remains');
        }
      } else if (claim.dns_record_id !== null && !wasIntended) {
        throw new GwsEaError('cloudflare_dns_missing', 'The owned Cloudflare DNS record disappeared before deletion');
      }
      receipt = await completeManagedIngressStep(paths, receipt, 'dns');
    }

    if (!final) return receipt;

    if (!stepCompleted(receipt, 'connector')) {
      receipt = await intendManagedIngressStep(paths, receipt, 'connector');
      if (observedConnector) await (dependencies.stopCloudflareConnector ?? stopCloudflareConnector)(layout);
      receipt = await completeManagedIngressStep(paths, receipt, 'connector');
    }
    if (!stepCompleted(receipt, 'connections')) {
      receipt = await intendManagedIngressStep(paths, receipt, 'connections');
      if (tunnelId !== null) {
        await waitForTunnelConnectionsToClear(api, claim.account_id, tunnelId, dependencies.connectionDelay ?? delay);
      }
      receipt = await completeManagedIngressStep(paths, receipt, 'connections');
    }
    if (!stepCompleted(receipt, 'tunnel')) {
      const wasIntended = stepIntended(receipt, 'tunnel');
      receipt = await intendManagedIngressStep(paths, receipt, 'tunnel');
      if (tunnelId !== null && !tunnelMissing) {
        let deletionError: unknown;
        try {
          await api.deleteTunnel(claim.account_id, tunnelId);
          // The post-delete observation below resolves ambiguous failures safely.
          // eslint-disable-next-line no-catch-all/no-catch-all
        } catch (error) {
          deletionError = error;
        }
        const after = await api.listTunnels(claim.account_id, metadata.tunnel_name);
        if (after.length > 0) {
          assertOwnedTunnel(after, tunnelId, metadata.tunnel_name);
          if (deletionError) throw deletionError;
          throw new GwsEaError('cloudflare_tunnel_removal_incomplete', 'The owned Cloudflare tunnel remains');
        }
      } else if (tunnelId !== null && !wasIntended) {
        throw new GwsEaError('cloudflare_tunnel_missing', 'The owned Cloudflare tunnel disappeared before deletion');
      }
      receipt = await completeManagedIngressStep(paths, receipt, 'tunnel');
    }
    if (!stepCompleted(receipt, 'private_state')) {
      receipt = await intendManagedIngressStep(paths, receipt, 'private_state');
      if (privateRootPresent) {
        await (
          dependencies.removeCloudflarePrivateState ?? (async () => rm(paths.cloudflareRoot, { recursive: true }))
        )(layout);
      }
      receipt = await completeManagedIngressStep(paths, receipt, 'private_state');
    }
    return receipt;
  });
}

async function uninstallNanoclaw(reservation: InstanceReservation): Promise<void> {
  const installId = reservation.instance_id.replaceAll('-', '');
  const homeDirectory =
    (await readRecordedHomeDirectory(path.join(reservation.checkout_realpath, 'data', 'gws-ea', 'runtime.json'))) ??
    os.homedir();
  const coordinates = (platform: InstanceServicePlatform, runningAsRoot: boolean) =>
    createInstanceServiceCoordinates({ installId, homeDirectory, platform, runningAsRoot });
  const environment = buildToolEnvironment(
    {},
    { HOME: homeDirectory, PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin' },
  );
  const outcome = (command: string, args: readonly string[]) =>
    runSanitizedCommandOutcome({
      command,
      args,
      cwd: reservation.checkout_realpath,
      env: environment,
      timeoutMs: 120_000,
    });
  const run = async (command: string, args: readonly string[], acceptFailure = false): Promise<string> => {
    const result = await outcome(command, args);
    if (result.exitCode !== 0 && !acceptFailure) {
      throw new GwsEaError('nanoclaw_removal_incomplete', `Could not remove the instance ${command} resource`);
    }
    return result.stdout;
  };

  if (process.platform === 'darwin') {
    const service = coordinates('macos', false);
    await run('launchctl', ['unload', service.serviceDefinitionPath], true);
    const uid = process.getuid?.();
    if (uid === undefined) throw new GwsEaError('unsupported_platform', 'launchd requires a user ID');
    const serviceDomain = `gui/${uid}/${service.serviceIdentity}`;
    await run('launchctl', ['bootout', serviceDomain], true);
    if ((await outcome('launchctl', ['print', serviceDomain])).exitCode === 0) {
      throw new GwsEaError('nanoclaw_removal_incomplete', 'NanoClaw launchd service is still loaded');
    }
    await rm(service.serviceDefinitionPath, { force: true });
  } else if (process.platform === 'linux') {
    const userService = coordinates('linux', false);
    try {
      await access(userService.serviceDefinitionPath);
      await run('systemctl', ['--user', 'disable', '--now', `${userService.serviceIdentity}.service`], true);
      if (
        (await outcome('systemctl', ['--user', 'is-active', `${userService.serviceIdentity}.service`])).exitCode === 0
      ) {
        throw new GwsEaError('nanoclaw_removal_incomplete', 'NanoClaw user service is still active');
      }
      await rm(userService.serviceDefinitionPath, { force: true });
      await run('systemctl', ['--user', 'daemon-reload']);
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error;
    }
    const systemService = coordinates('linux', true);
    try {
      await access(systemService.serviceDefinitionPath);
      if (process.getuid?.() !== 0) {
        throw new GwsEaError(
          'root_required',
          `Re-run removal with root privileges to remove ${systemService.serviceDefinitionPath}`,
        );
      }
      await run('systemctl', ['disable', '--now', `${systemService.serviceIdentity}.service`], true);
      if ((await outcome('systemctl', ['is-active', `${systemService.serviceIdentity}.service`])).exitCode === 0) {
        throw new GwsEaError('nanoclaw_removal_incomplete', 'NanoClaw system service is still active');
      }
      await rm(systemService.serviceDefinitionPath, { force: true });
      await run('systemctl', ['daemon-reload']);
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error;
    }
  }

  const hostPattern = path
    .join(reservation.checkout_realpath, 'dist', 'index.js')
    .replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const killed = await outcome('pkill', ['-f', hostPattern]);
  if (killed.exitCode !== 0 && killed.exitCode !== 1) {
    throw new GwsEaError('nanoclaw_removal_incomplete', 'Could not stop the NanoClaw host process');
  }
  const remaining = await outcome('pgrep', ['-f', hostPattern]);
  if (remaining.exitCode === 0) {
    throw new GwsEaError('nanoclaw_removal_incomplete', 'NanoClaw host process is still running');
  }
  if (remaining.exitCode !== 1) {
    throw new GwsEaError('nanoclaw_removal_incomplete', 'Could not verify the NanoClaw host process stopped');
  }

  const resources = coordinates(process.platform === 'darwin' ? 'macos' : 'linux', process.getuid?.() === 0);
  const ids = (await run('docker', ['ps', '-aq', '--filter', `label=${resources.installLabel}`]))
    .split(/\r?\n/u)
    .map((id) => id.trim())
    .filter(Boolean);
  if (ids.length > 0) await run('docker', ['rm', '--force', ...ids]);
  if ((await run('docker', ['ps', '-aq', '--filter', `label=${resources.installLabel}`])).trim()) {
    throw new GwsEaError('nanoclaw_removal_incomplete', 'NanoClaw containers remain after removal');
  }
  if ((await run('docker', ['image', 'ls', '--quiet', '--no-trunc', resources.imageTag])).trim()) {
    await run('docker', ['image', 'rm', resources.imageTag]);
  }
  if ((await run('docker', ['image', 'ls', '--quiet', '--no-trunc', resources.imageTag])).trim()) {
    throw new GwsEaError('nanoclaw_removal_incomplete', 'NanoClaw image remains after removal');
  }
}

async function deleteGcpProject(reservation: InstanceReservation): Promise<void> {
  const claims = reservation.exclusive_resource_claims;
  await deleteOwnedGcpProject({
    instanceId: reservation.instance_id,
    projectId: claims.gcp_project_id,
    account: claims.gcp_account,
    cwd: path.dirname(reservation.checkout_realpath),
  });
}

async function removeOnecli(reservation: InstanceReservation): Promise<void> {
  const claims = reservation.exclusive_resource_claims;
  await removeOnecliRuntime(
    createOnecliRuntimeLayout({
      instanceId: reservation.instance_id,
      instanceRoot: path.dirname(reservation.checkout_realpath),
      project: claims.onecli_project,
      appPort: reservation.allocated_ports.onecli_app,
      gatewayPort: reservation.allocated_ports.onecli_gateway,
      cliExecutable: '/usr/local/bin/onecli',
    }),
  );
}

export async function describeRemoval(paths: ControlPlanePaths, instanceId: string): Promise<RemovalPreview> {
  assertInstanceId(instanceId);
  const receipt = await readReceipt(paths, instanceId);
  const reservation = receipt?.reservation ?? (await getInstanceReservation(paths, instanceId));
  const claims = reservation.exclusive_resource_claims;
  const registry = await readRegistry(paths);
  const ingress = claims.ingress;
  const managedPeerExists = Object.values(registry.instances).some(
    (instance) =>
      instance.instance_id !== instanceId && instance.exclusive_resource_claims.ingress.mode === 'managed-cloudflare',
  );
  return {
    instanceId,
    checkout: reservation.checkout_realpath,
    gcpProject: claims.gcp_project_id,
    gcpAccount: claims.gcp_account,
    onecliProject: claims.onecli_project,
    ingress:
      ingress.mode === 'existing'
        ? { mode: 'existing', endpoint: ingressEndpointUrl(ingress) }
        : {
            mode: 'managed-cloudflare',
            hostname: ingress.hostname,
            callback: ingress.callback_url,
            dnsRecordId: ingress.dns_record_id,
            route: `${ingress.hostname} ${GCHAT_TUNNEL_PATH}`,
            sharedIngress: managedPeerExists ? 'retained-for-peers' : 'retired',
          },
  };
}

export async function removeAssistant(
  paths: ControlPlanePaths,
  instanceId: string,
  dependencies: RemovalDependencies = {},
): Promise<void> {
  assertInstanceId(instanceId);
  await preparePrivateDirectory(path.dirname(paths.instanceLock(instanceId)));
  const release = await processLock(paths.instanceLock(instanceId));
  if (!release) throw new GwsEaError('instance_busy', 'Instance operation is already in progress');
  try {
    const existingReceipt = await readReceipt(paths, instanceId);
    const reservation = existingReceipt?.reservation ?? (await assertRegistryMarkerAgreement(paths, instanceId));
    const ingress = reservation.exclusive_resource_claims.ingress;
    const api =
      ingress.mode === 'managed-cloudflare' &&
      (existingReceipt === undefined || existingReceipt.completed.ingress === null)
        ? await verifyManagedRemovalAuthority(ingress, dependencies)
        : undefined;
    let receipt = existingReceipt ?? (await ensureReceipt(paths, instanceId, reservation));
    if (receipt.completed.ingress === null) {
      if (ingress.mode === 'managed-cloudflare') {
        if (!api) throw new GwsEaError('cloudflare_token_required', 'Cloudflare authorization is missing');
        receipt = await removeManagedCloudflareIngress(paths, receipt, api, dependencies);
      }
      receipt = await completePhase(paths, receipt, 'ingress', async () => undefined);
    }
    receipt = await completePhase(paths, receipt, 'nanoclaw', () =>
      (dependencies.uninstallNanoclaw ?? uninstallNanoclaw)(receipt.reservation),
    );
    receipt = await completePhase(paths, receipt, 'gcp_project', () =>
      (dependencies.deleteGcpProject ?? deleteGcpProject)(receipt.reservation),
    );
    receipt = await completePhase(paths, receipt, 'onecli', () =>
      (dependencies.removeOnecli ?? removeOnecli)(receipt.reservation),
    );
    receipt = await completePhase(paths, receipt, 'instance_files', () =>
      dependencies.removeInstanceFiles
        ? dependencies.removeInstanceFiles(receipt.reservation)
        : rm(paths.instanceRoot(instanceId), { recursive: true, force: true }),
    );
    receipt = await completePhase(paths, receipt, 'registry', () =>
      releaseInstanceReservation(paths, receipt.reservation),
    );
    await removePrivateFile(paths.removalFile(instanceId));
  } finally {
    release();
  }
}
