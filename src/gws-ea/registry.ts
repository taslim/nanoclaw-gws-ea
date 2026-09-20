import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readJson, writePrivate } from '../community-portal/private-file.js';
import { processLock } from '../community-portal/process-lock.js';
import { isErrno } from '../community-portal/errors.js';
import { deriveGchatServiceAccountEmail, GCP_PROJECT_PATTERN } from './gcp-identity.js';
import { validateExistingGchatEndpoint } from './endpoint.js';
import {
  assertLocalOwnedDestination,
  assertOwnedLocalDirectory,
  assertPrivateLocalDirectory,
  assertPrivateStateFile,
  preparePrivateLocalDirectory,
  type ControlPlanePaths,
} from './paths.js';
import {
  GwsEaError,
  INSTANCE_MARKER_SCHEMA_VERSION,
  REGISTRY_SCHEMA_VERSION,
  type AllocatedPorts,
  type ExclusiveResourceClaims,
  type IngressClaim,
  type InstanceMarker,
  type InstanceRegistry,
  type InstanceReservation,
  type InstanceReservationInput,
  type SharedCloudflareMetadata,
  type SharedInfrastructureMetadata,
} from './types.js';
import { hasControlCharacters, isRecord } from './validation.js';

const INSTANCE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RELEASE_TRACK_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const ONECLI_PROJECT_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CLOUDFLARE_ID_PATTERN = /^[0-9a-f]{32}$/;
const DNS_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const DNS_NAME_PATTERN = new RegExp(`^(?:${DNS_LABEL}\\.)+${DNS_LABEL}$`);
const TUNNEL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new GwsEaError('invalid_state', `${label} contains unknown or missing fields`);
  }
}

function requireString(value: unknown, label: string, maxLength = 2048): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || hasControlCharacters(value)) {
    throw new GwsEaError('invalid_state', `${label} is invalid`);
  }
  return value;
}

export function assertInstanceId(value: string): void {
  if (!INSTANCE_ID_PATTERN.test(value)) throw new GwsEaError('invalid_instance_id', 'Instance ID is invalid');
}

export function allocateInstanceId(): string {
  return randomUUID();
}

function validatePort(value: unknown, label: string): number {
  if (!Number.isInteger(value) || typeof value !== 'number' || value < 1 || value > 65_535) {
    throw new GwsEaError('invalid_claim', `${label} must be an integer port from 1 to 65535`);
  }
  return value;
}

function validatePorts(value: unknown): AllocatedPorts {
  if (!isRecord(value)) throw new GwsEaError('invalid_claim', 'allocated_ports is invalid');
  assertExactKeys(value, ['nanoclaw_webhook', 'onecli_app', 'onecli_gateway'], 'allocated_ports');
  const ports = {
    nanoclaw_webhook: validatePort(value.nanoclaw_webhook, 'nanoclaw_webhook'),
    onecli_app: validatePort(value.onecli_app, 'onecli_app'),
    onecli_gateway: validatePort(value.onecli_gateway, 'onecli_gateway'),
  };
  if (new Set(Object.values(ports)).size !== Object.values(ports).length) {
    throw new GwsEaError('invalid_claim', 'Allocated ports must be distinct');
  }
  return ports;
}

function validateEndpoint(value: unknown): string {
  const raw = requireString(value, 'endpoint_url');
  try {
    return validateExistingGchatEndpoint(raw);
  } catch {
    throw new GwsEaError(
      'invalid_claim',
      'Endpoint must be an HTTPS URL with the exact /webhook/gchat path and no credentials, query, or fragment',
    );
  }
}

function requireCloudflareId(value: unknown, label: string): string {
  const id = requireString(value, label, 32).toLowerCase();
  if (!CLOUDFLARE_ID_PATTERN.test(id)) throw new GwsEaError('invalid_claim', `${label} is invalid`);
  return id;
}

function validateIngress(value: unknown): IngressClaim {
  if (!isRecord(value)) throw new GwsEaError('invalid_claim', 'ingress is invalid');
  if (value.mode === 'existing') {
    assertExactKeys(value, ['mode', 'endpoint_url'], 'existing ingress');
    return { mode: 'existing', endpoint_url: validateEndpoint(value.endpoint_url) };
  }
  if (value.mode !== 'managed-cloudflare') {
    throw new GwsEaError('invalid_claim', 'Ingress mode is invalid');
  }
  assertExactKeys(
    value,
    ['mode', 'account_id', 'zone_id', 'zone_name', 'hostname', 'callback_url', 'dns_record_id'],
    'managed Cloudflare ingress',
  );
  const accountId = requireCloudflareId(value.account_id, 'Cloudflare account ID');
  const zoneId = requireCloudflareId(value.zone_id, 'Cloudflare zone ID');
  const zoneName = requireString(value.zone_name, 'Cloudflare zone name', 253);
  const hostname = requireString(value.hostname, 'Cloudflare hostname', 253);
  if (
    zoneName !== zoneName.toLowerCase() ||
    hostname !== hostname.toLowerCase() ||
    !DNS_NAME_PATTERN.test(zoneName) ||
    !DNS_NAME_PATTERN.test(hostname) ||
    !hostname.endsWith(`.${zoneName}`) ||
    hostname.slice(0, -(zoneName.length + 1)).includes('.')
  ) {
    throw new GwsEaError('invalid_claim', 'Managed hostname must be one first-level label in the selected zone');
  }
  const callbackUrl = validateEndpoint(value.callback_url);
  if (callbackUrl !== `https://${hostname}/webhook/gchat`) {
    throw new GwsEaError('invalid_claim', 'Managed callback does not match its claimed hostname');
  }
  let dnsRecordId: string | null = null;
  if (value.dns_record_id !== null) {
    dnsRecordId = requireCloudflareId(value.dns_record_id, 'Cloudflare DNS record ID');
  }
  return {
    mode: 'managed-cloudflare',
    account_id: accountId,
    zone_id: zoneId,
    zone_name: zoneName,
    hostname,
    callback_url: callbackUrl,
    dns_record_id: dnsRecordId,
  };
}

function validateSourceRemote(value: unknown): string {
  const remote = requireString(value, 'source_remote');
  try {
    const parsed = new URL(remote);
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new GwsEaError('invalid_state', 'Source remote must not contain credentials, a query, or a fragment');
    }
  } catch (error) {
    if (error instanceof GwsEaError) throw error;
    // Git also accepts SCP-like remotes such as git@github.com:owner/repo.git.
  }
  return remote;
}

function validateClaims(value: unknown): ExclusiveResourceClaims {
  if (!isRecord(value)) throw new GwsEaError('invalid_claim', 'exclusive_resource_claims is invalid');
  assertExactKeys(
    value,
    ['ingress', 'gcp_project_id', 'gcp_account', 'gchat_service_account', 'workspace_email', 'onecli_project'],
    'exclusive_resource_claims',
  );
  const gcpProject = requireString(value.gcp_project_id, 'gcp_project_id', 30).toLowerCase();
  if (!GCP_PROJECT_PATTERN.test(gcpProject)) throw new GwsEaError('invalid_claim', 'GCP project ID is invalid');
  const gcpAccount = requireString(value.gcp_account, 'gcp_account', 320).toLowerCase();
  if (!EMAIL_PATTERN.test(gcpAccount)) throw new GwsEaError('invalid_claim', 'GCP account is invalid');
  const serviceAccount = requireString(value.gchat_service_account, 'gchat_service_account', 320).toLowerCase();
  if (serviceAccount !== deriveGchatServiceAccountEmail(gcpProject)) {
    throw new GwsEaError('invalid_claim', 'Google Chat service-account identity is invalid');
  }
  const workspaceEmail = requireString(value.workspace_email, 'workspace_email', 320).toLowerCase();
  if (!EMAIL_PATTERN.test(workspaceEmail)) throw new GwsEaError('invalid_claim', 'Workspace email is invalid');
  const onecliProject = requireString(value.onecli_project, 'onecli_project', 63).toLowerCase();
  if (!ONECLI_PROJECT_PATTERN.test(onecliProject)) {
    throw new GwsEaError('invalid_claim', 'OneCLI project identity is invalid');
  }
  return {
    ingress: validateIngress(value.ingress),
    gcp_project_id: gcpProject,
    gcp_account: gcpAccount,
    gchat_service_account: serviceAccount,
    workspace_email: workspaceEmail,
    onecli_project: onecliProject,
  };
}

function validateSharedCloudflare(value: unknown): SharedCloudflareMetadata | null {
  if (value === null) return null;
  if (!isRecord(value)) throw new GwsEaError('invalid_registry', 'Shared Cloudflare metadata is invalid');
  assertExactKeys(value, ['ownership_id', 'account_id', 'tunnel_name', 'tunnel_id'], 'Shared Cloudflare metadata');
  const ownershipId = requireString(value.ownership_id, 'Cloudflare ownership ID', 36);
  assertInstanceId(ownershipId);
  const accountId = requireCloudflareId(value.account_id, 'Cloudflare account ID');
  const tunnelName = requireString(value.tunnel_name, 'Cloudflare tunnel name', 63);
  if (tunnelName !== `gws-ea-${ownershipId.replaceAll('-', '')}`) {
    throw new GwsEaError('invalid_registry', 'Shared Cloudflare tunnel name does not match its ownership ID');
  }
  let tunnelId: string | null = null;
  if (value.tunnel_id !== null) {
    tunnelId = requireString(value.tunnel_id, 'Cloudflare tunnel ID', 36).toLowerCase();
    if (!TUNNEL_ID_PATTERN.test(tunnelId)) {
      throw new GwsEaError('invalid_registry', 'Cloudflare tunnel ID is invalid');
    }
  }
  return {
    ownership_id: ownershipId,
    account_id: accountId,
    tunnel_name: tunnelName,
    tunnel_id: tunnelId,
  };
}

function validateSharedInfrastructure(value: unknown): SharedInfrastructureMetadata {
  if (!isRecord(value)) throw new GwsEaError('invalid_registry', 'Shared infrastructure metadata is invalid');
  assertExactKeys(value, ['cloudflare'], 'Shared infrastructure metadata');
  return { cloudflare: validateSharedCloudflare(value.cloudflare) };
}

export function validateReservation(value: unknown, paths: ControlPlanePaths): InstanceReservation {
  if (!isRecord(value)) throw new GwsEaError('invalid_state', 'Instance reservation is invalid');
  assertExactKeys(
    value,
    [
      'instance_id',
      'checkout_realpath',
      'release_track',
      'source_remote',
      'deployed_commit',
      'allocated_ports',
      'exclusive_resource_claims',
    ],
    'Instance reservation',
  );
  const instanceId = requireString(value.instance_id, 'instance_id', 36);
  assertInstanceId(instanceId);
  const checkout = requireString(value.checkout_realpath, 'checkout_realpath');
  const expectedCheckout = paths.checkoutRoot(instanceId);
  if (path.resolve(checkout) !== expectedCheckout) {
    throw new GwsEaError('unsafe_path', 'Checkout path does not match the reserved instance path');
  }
  const releaseTrack = requireString(value.release_track, 'release_track', 64);
  if (!RELEASE_TRACK_PATTERN.test(releaseTrack)) throw new GwsEaError('invalid_state', 'Release track is invalid');
  const deployedCommit = requireString(value.deployed_commit, 'deployed_commit', 40).toLowerCase();
  if (!COMMIT_PATTERN.test(deployedCommit)) throw new GwsEaError('invalid_state', 'Deployed commit is invalid');
  return {
    instance_id: instanceId,
    checkout_realpath: expectedCheckout,
    release_track: releaseTrack,
    source_remote: validateSourceRemote(value.source_remote),
    deployed_commit: deployedCommit,
    allocated_ports: validatePorts(value.allocated_ports),
    exclusive_resource_claims: validateClaims(value.exclusive_resource_claims),
  };
}

function validateRegistry(value: unknown, paths: ControlPlanePaths): InstanceRegistry {
  if (!isRecord(value)) throw new GwsEaError('invalid_registry', 'Machine registry is invalid');
  assertExactKeys(value, ['schema_version', 'instances', 'shared_infrastructure_metadata'], 'Machine registry');
  if (value.schema_version !== REGISTRY_SCHEMA_VERSION) {
    throw new GwsEaError('unsupported_registry', 'Machine registry schema version is unsupported');
  }
  if (!isRecord(value.instances)) throw new GwsEaError('invalid_registry', 'Machine registry instances are invalid');
  const instances: Record<string, InstanceReservation> = {};
  for (const [key, raw] of Object.entries(value.instances)) {
    assertInstanceId(key);
    const parsed = validateReservation(raw, paths);
    if (parsed.instance_id !== key) throw new GwsEaError('invalid_registry', 'Registry key and instance ID disagree');
    instances[key] = parsed;
  }
  assertNoClaimCollisions(Object.values(instances));
  const sharedInfrastructure = validateSharedInfrastructure(value.shared_infrastructure_metadata);
  const managedAccounts = new Set(
    Object.values(instances)
      .map((instance) => instance.exclusive_resource_claims.ingress)
      .filter((ingress) => ingress.mode === 'managed-cloudflare')
      .map((ingress) => ingress.account_id),
  );
  if (managedAccounts.size > 1) {
    throw new GwsEaError('invalid_registry', 'Managed Cloudflare claims span more than one account');
  }
  if (managedAccounts.size === 1 && sharedInfrastructure.cloudflare?.account_id !== [...managedAccounts][0]) {
    throw new GwsEaError('invalid_registry', 'Managed Cloudflare claims disagree with shared infrastructure');
  }
  return {
    schema_version: REGISTRY_SCHEMA_VERSION,
    instances,
    shared_infrastructure_metadata: sharedInfrastructure,
  };
}

function emptyRegistry(): InstanceRegistry {
  return {
    schema_version: REGISTRY_SCHEMA_VERSION,
    instances: {},
    shared_infrastructure_metadata: { cloudflare: null },
  };
}

async function readRegistryFile(paths: ControlPlanePaths): Promise<InstanceRegistry> {
  try {
    await assertPrivateStateFile(paths.registryFile);
    const raw = await readJson<unknown>(paths.registryFile);
    return validateRegistry(raw, paths);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return emptyRegistry();
    if (error instanceof GwsEaError) throw error;
    throw new GwsEaError('invalid_registry', 'Machine registry cannot be parsed safely');
  }
}

export async function readRegistry(paths: ControlPlanePaths): Promise<InstanceRegistry> {
  try {
    await assertPrivateLocalDirectory(paths.configRoot);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return emptyRegistry();
    throw error;
  }
  return readRegistryFile(paths);
}

function claimKeys(instance: InstanceReservation): string[] {
  const claims = instance.exclusive_resource_claims;
  const keys = [
    `checkout:${instance.checkout_realpath}`,
    ...Object.values(instance.allocated_ports).map((port) => `port:${port}`),
    `endpoint:${claims.ingress.mode === 'existing' ? claims.ingress.endpoint_url : claims.ingress.callback_url}`,
    `gcp-project:${claims.gcp_project_id}`,
    `gchat-service-account:${claims.gchat_service_account}`,
    `workspace-email:${claims.workspace_email}`,
    `onecli-project:${claims.onecli_project}`,
  ];
  if (claims.ingress.mode === 'managed-cloudflare') {
    keys.push(
      `hostname:${claims.ingress.hostname}`,
      `dns:${claims.ingress.zone_id}:${claims.ingress.hostname}`,
      `route:${claims.ingress.hostname}:/webhook/gchat`,
    );
    if (claims.ingress.dns_record_id) keys.push(`dns-record-id:${claims.ingress.dns_record_id}`);
  }
  return keys;
}

function sharedInfrastructureForReservation(
  current: SharedInfrastructureMetadata,
  reservation: InstanceReservation,
): SharedInfrastructureMetadata {
  const ingress = reservation.exclusive_resource_claims.ingress;
  if (ingress.mode === 'existing') return current;
  if (current.cloudflare) {
    if (current.cloudflare.account_id !== ingress.account_id) {
      throw new GwsEaError(
        'cloudflare_account_conflict',
        'Managed Cloudflare ingress on this machine already belongs to another account',
      );
    }
    return current;
  }
  const ownershipId = randomUUID();
  return {
    cloudflare: {
      ownership_id: ownershipId,
      account_id: ingress.account_id,
      tunnel_name: `gws-ea-${ownershipId.replaceAll('-', '')}`,
      tunnel_id: null,
    },
  };
}

function assertNoClaimCollisions(instances: readonly InstanceReservation[]): void {
  const seen = new Map<string, string>();
  for (const instance of instances) {
    for (const claim of claimKeys(instance)) {
      const owner = seen.get(claim);
      if (owner && owner !== instance.instance_id) {
        throw new GwsEaError('claim_conflict', 'An exclusive operational resource is already claimed');
      }
      seen.set(claim, instance.instance_id);
    }
  }
}

async function acquireMachineLock(paths: ControlPlanePaths): Promise<() => void> {
  await preparePrivateLocalDirectory(paths.configRoot);
  const deadline = Date.now() + 5_000;
  do {
    const release = await processLock(paths.registryLock);
    if (release) return release;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  throw new GwsEaError('registry_busy', 'The machine registry is busy; retry the command');
}

export async function reserveInstance(
  paths: ControlPlanePaths,
  input: InstanceReservationInput,
): Promise<InstanceReservation> {
  const validated = validateReservation(input, paths);
  await assertLocalOwnedDestination(validated.checkout_realpath);
  const release = await acquireMachineLock(paths);
  try {
    const registry = await readRegistryFile(paths);
    if (registry.instances[validated.instance_id]) {
      throw new GwsEaError('instance_exists', 'Instance ID already exists');
    }
    assertNoClaimCollisions([...Object.values(registry.instances), validated]);
    const sharedInfrastructure = sharedInfrastructureForReservation(registry.shared_infrastructure_metadata, validated);
    const next: InstanceRegistry = {
      schema_version: REGISTRY_SCHEMA_VERSION,
      instances: { ...registry.instances, [validated.instance_id]: validated },
      shared_infrastructure_metadata: sharedInfrastructure,
    };
    await writePrivate(paths.registryFile, next);
    return validated;
  } finally {
    release();
  }
}

export async function getInstanceReservation(
  paths: ControlPlanePaths,
  instanceId: string,
): Promise<InstanceReservation> {
  assertInstanceId(instanceId);
  const registry = await readRegistry(paths);
  const instance = registry.instances[instanceId];
  if (!instance) throw new GwsEaError('unknown_instance', 'Unknown instance ID');
  return instance;
}

export async function releaseInstanceReservation(
  paths: ControlPlanePaths,
  expected: InstanceReservation,
): Promise<void> {
  const validated = validateReservation(expected, paths);
  const release = await acquireMachineLock(paths);
  try {
    const registry = await readRegistryFile(paths);
    const stored = registry.instances[validated.instance_id];
    if (!stored) return;
    if (JSON.stringify(stored) !== JSON.stringify(validated)) {
      throw new GwsEaError('reservation_mismatch', 'Instance reservation changed during removal; refusing release');
    }
    const instances = { ...registry.instances };
    delete instances[validated.instance_id];
    await writePrivate(paths.registryFile, {
      schema_version: REGISTRY_SCHEMA_VERSION,
      instances,
      shared_infrastructure_metadata: registry.shared_infrastructure_metadata,
    });
  } finally {
    release();
  }
}

function validateMarker(value: unknown): InstanceMarker {
  if (!isRecord(value)) throw new GwsEaError('invalid_marker', 'Instance marker is invalid');
  assertExactKeys(value, ['schema_version', 'instance_id', 'deployed_commit'], 'Instance marker');
  if (value.schema_version !== INSTANCE_MARKER_SCHEMA_VERSION) {
    throw new GwsEaError('unsupported_marker', 'Instance marker schema version is unsupported');
  }
  const instanceId = requireString(value.instance_id, 'marker instance_id', 36);
  assertInstanceId(instanceId);
  const deployedCommit = requireString(value.deployed_commit, 'marker deployed_commit', 40).toLowerCase();
  if (!COMMIT_PATTERN.test(deployedCommit)) {
    throw new GwsEaError('invalid_marker', 'Instance marker deployed commit is invalid');
  }
  return { schema_version: INSTANCE_MARKER_SCHEMA_VERSION, instance_id: instanceId, deployed_commit: deployedCommit };
}

async function readMarker(paths: ControlPlanePaths, instanceId: string): Promise<InstanceMarker> {
  const file = paths.markerFile(instanceId);
  try {
    await assertPrivateStateFile(file);
    return validateMarker(JSON.parse(await readFile(file, 'utf8')) as unknown);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) throw new GwsEaError('marker_missing', 'Instance marker is missing');
    if (error instanceof GwsEaError) throw error;
    throw new GwsEaError('invalid_marker', 'Instance marker cannot be parsed safely');
  }
}

export async function assertRegistryMarkerAgreement(
  paths: ControlPlanePaths,
  instanceId: string,
): Promise<InstanceReservation> {
  const reservation = await getInstanceReservation(paths, instanceId);
  await assertOwnedLocalDirectory(reservation.checkout_realpath);
  const marker = await readMarker(paths, instanceId);
  if (marker.instance_id !== instanceId || marker.deployed_commit !== reservation.deployed_commit) {
    throw new GwsEaError('marker_mismatch', 'Instance marker mismatch; refusing mutation');
  }
  return reservation;
}

export async function writeInstanceMarker(paths: ControlPlanePaths, instanceId: string): Promise<void> {
  const reservation = await getInstanceReservation(paths, instanceId);
  await assertOwnedLocalDirectory(reservation.checkout_realpath);
  try {
    const existing = await readMarker(paths, instanceId);
    if (existing.instance_id !== instanceId) {
      throw new GwsEaError('marker_mismatch', 'Instance marker mismatch; refusing mutation');
    }
    return;
  } catch (error) {
    if (!(error instanceof GwsEaError) || error.code !== 'marker_missing') throw error;
  }
  await preparePrivateLocalDirectory(path.dirname(paths.markerFile(instanceId)));
  await writePrivate(paths.markerFile(instanceId), {
    schema_version: INSTANCE_MARKER_SCHEMA_VERSION,
    instance_id: instanceId,
    deployed_commit: reservation.deployed_commit,
  } satisfies InstanceMarker);
}
