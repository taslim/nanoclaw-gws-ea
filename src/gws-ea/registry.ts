import { randomUUID } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { readJson, writePrivate } from '../community-portal/private-file.js';
import { processLock } from '../community-portal/process-lock.js';
import { isErrno } from '../community-portal/errors.js';
import { deriveGchatServiceAccountEmail, GCP_PROJECT_PATTERN } from './gcp-identity.js';
import { validateExistingGchatEndpoint } from './endpoint.js';
import { createProvisionJournal, discardProvisionJournal } from './journal.js';
import {
  assertOwnedDestination,
  assertOwnedDirectory,
  assertPrivateDirectory,
  assertPrivateStateFile,
  preparePrivateDirectory,
  type ControlPlanePaths,
} from './paths.js';
import {
  GwsEaError,
  INSTANCE_MARKER_SCHEMA_VERSION,
  REGISTRY_SCHEMA_VERSION,
  ingressEndpointUrl,
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
import { isRecord, parseJson, requireString as requireText } from './validation.js';

const INSTANCE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RELEASE_TRACK_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const ONECLI_PROJECT_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CLOUDFLARE_ID_PATTERN = /^[0-9a-f]{32}$/;
const DNS_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const DNS_NAME_PATTERN = new RegExp(`^(?:${DNS_LABEL}\\.)+${DNS_LABEL}$`);
const TUNNEL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Readers keep every ownership value exact and ignore fields they do not use (R14). */
function requireString(value: unknown, label: string, maxLength?: number): string {
  return requireText(value, label, 'invalid_state', maxLength);
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
    return { mode: 'existing', endpoint_url: validateEndpoint(value.endpoint_url) };
  }
  if (value.mode !== 'managed-cloudflare') {
    throw new GwsEaError('invalid_claim', 'Ingress mode is invalid');
  }
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
  return { cloudflare: validateSharedCloudflare(value.cloudflare) };
}

export function validateReservation(value: unknown, paths: ControlPlanePaths): InstanceReservation {
  if (!isRecord(value)) throw new GwsEaError('invalid_state', 'Instance reservation is invalid');
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

export async function activeRemovalInstanceIds(
  paths: ControlPlanePaths,
  registry: InstanceRegistry,
): Promise<readonly string[]> {
  try {
    await assertPrivateDirectory(paths.removalRoot);
    const entries = await readdir(paths.removalRoot, { withFileTypes: true });
    const active: string[] = [];
    for (const entry of entries) {
      // Only `<instance id>.json` is a receipt; `.DS_Store` or a leftover `.tmp` is not.
      const instanceId = entry.name.endsWith('.json') ? entry.name.slice(0, -'.json'.length) : '';
      if (!INSTANCE_ID_PATTERN.test(instanceId)) continue;
      await assertPrivateStateFile(path.join(paths.removalRoot, entry.name));
      if (registry.instances[instanceId]) active.push(instanceId);
    }
    return active.sort();
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return [];
    throw error;
  }
}

export async function readRegistry(paths: ControlPlanePaths): Promise<InstanceRegistry> {
  try {
    await assertPrivateDirectory(paths.configRoot);
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
    `endpoint:${ingressEndpointUrl(claims.ingress)}`,
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
  await preparePrivateDirectory(paths.configRoot);
  const deadline = Date.now() + 5_000;
  do {
    const release = await processLock(paths.registryLock);
    if (release) return release;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  throw new GwsEaError('registry_busy', 'The machine registry is busy; retry the command');
}

/**
 * Hold the machine lock for one machine-wide effect: the Cloudflare route-set
 * write, the last-assistant retirement decision, and connector repair
 * (KTD6 item 7). Everything else locks per instance.
 */
export async function withMachineLock<T>(paths: ControlPlanePaths, callback: () => Promise<T>): Promise<T> {
  const release = await acquireMachineLock(paths);
  try {
    return await callback();
  } finally {
    release();
  }
}

export interface CloudflareCoordinateUpdate {
  readonly tunnelId?: string;
  readonly dnsRecordIds?: Readonly<Record<string, string>>;
}

export interface LockedCloudflareRegistry {
  readonly registry: InstanceRegistry;
  updateCoordinates(update: CloudflareCoordinateUpdate): Promise<InstanceRegistry>;
  /** Forget a tunnel the last managed assistant's removal retired, so the next one creates its own (R12). */
  forgetTunnel(): Promise<InstanceRegistry>;
}

/**
 * Hold the machine registry lock across one shared Cloudflare reconciliation.
 * The callback can persist only remote coordinates; it cannot rewrite claims.
 * The tunnel coordinate never changes once recorded, except that retiring the
 * tunnel forgets it; a DNS record that vanished may be recreated, and its new
 * ID replaces the old one.
 */
export async function withLockedCloudflareRegistry<T>(
  paths: ControlPlanePaths,
  callback: (locked: LockedCloudflareRegistry) => Promise<T>,
): Promise<T> {
  return withMachineLock(paths, async () => {
    let current = await readRegistryFile(paths);
    const locked: LockedCloudflareRegistry = {
      get registry() {
        return current;
      },
      async updateCoordinates(update) {
        const cloudflare = current.shared_infrastructure_metadata.cloudflare;
        if (!cloudflare) {
          throw new GwsEaError('cloudflare_state_missing', 'Shared Cloudflare ownership is not reserved');
        }
        if (
          update.tunnelId !== undefined &&
          cloudflare.tunnel_id !== null &&
          update.tunnelId !== cloudflare.tunnel_id
        ) {
          throw new GwsEaError('reservation_mismatch', 'Cloudflare tunnel coordinate changed; refusing replacement');
        }
        const tunnelId = update.tunnelId ?? cloudflare.tunnel_id;
        if (tunnelId === null || !TUNNEL_ID_PATTERN.test(tunnelId)) {
          throw new GwsEaError('invalid_claim', 'Cloudflare tunnel ID is invalid');
        }
        const instances = { ...current.instances };
        for (const [instanceId, dnsRecordId] of Object.entries(update.dnsRecordIds ?? {})) {
          assertInstanceId(instanceId);
          if (!CLOUDFLARE_ID_PATTERN.test(dnsRecordId)) {
            throw new GwsEaError('invalid_claim', 'Cloudflare DNS record ID is invalid');
          }
          const instance = instances[instanceId];
          if (!instance || instance.exclusive_resource_claims.ingress.mode !== 'managed-cloudflare') {
            throw new GwsEaError('invalid_claim', 'Cloudflare DNS coordinate has no managed reservation');
          }
          instances[instanceId] = {
            ...instance,
            exclusive_resource_claims: {
              ...instance.exclusive_resource_claims,
              ingress: { ...instance.exclusive_resource_claims.ingress, dns_record_id: dnsRecordId },
            },
          };
        }
        const next = validateRegistry(
          {
            schema_version: REGISTRY_SCHEMA_VERSION,
            instances,
            shared_infrastructure_metadata: {
              cloudflare: { ...cloudflare, tunnel_id: tunnelId },
            },
          },
          paths,
        );
        await writePrivate(paths.registryFile, next);
        current = next;
        return current;
      },
      async forgetTunnel() {
        const cloudflare = current.shared_infrastructure_metadata.cloudflare;
        if (!cloudflare || cloudflare.tunnel_id === null) return current;
        const next = validateRegistry(
          { ...current, shared_infrastructure_metadata: { cloudflare: { ...cloudflare, tunnel_id: null } } },
          paths,
        );
        await writePrivate(paths.registryFile, next);
        current = next;
        return current;
      },
    };
    return callback(locked);
  });
}

/**
 * Reserve an instance's claims and start its provision journal as one
 * operation: the journal is written before the reservation is published, so a
 * reserved instance always has one.
 */
export async function reserveInstance(
  paths: ControlPlanePaths,
  input: InstanceReservationInput,
): Promise<InstanceReservation> {
  const validated = validateReservation(input, paths);
  await assertOwnedDestination(validated.checkout_realpath);
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
    await createProvisionJournal(paths, validated.instance_id);
    try {
      await writePrivate(paths.registryFile, next);
    } catch (error) {
      // Keep the journal unless the reservation certainly did not publish.
      const published = await readRegistryFile(paths).then(
        (current) => current.instances[validated.instance_id] !== undefined,
        () => true,
      );
      if (!published) await discardProvisionJournal(paths, validated.instance_id);
      throw error;
    }
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
    const hasManagedIngress = Object.values(instances).some(
      (instance) => instance.exclusive_resource_claims.ingress.mode === 'managed-cloudflare',
    );
    await writePrivate(paths.registryFile, {
      schema_version: REGISTRY_SCHEMA_VERSION,
      instances,
      shared_infrastructure_metadata: hasManagedIngress
        ? registry.shared_infrastructure_metadata
        : { cloudflare: null },
    });
  } finally {
    release();
  }
}

function validateMarker(value: unknown): InstanceMarker {
  if (!isRecord(value)) throw new GwsEaError('invalid_marker', 'Instance marker is invalid');
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

/** Read a checkout's instance marker; a missing file raises `marker_missing`. */
export async function readInstanceMarkerFile(file: string): Promise<InstanceMarker> {
  try {
    await assertPrivateStateFile(file);
    return validateMarker(parseJson(await readFile(file, 'utf8'), 'Instance marker', 'invalid_marker'));
  } catch (error) {
    if (isErrno(error, 'ENOENT')) throw new GwsEaError('marker_missing', 'Instance marker is missing');
    if (error instanceof GwsEaError) throw error;
    throw new GwsEaError('invalid_marker', 'Instance marker cannot be parsed safely');
  }
}

async function assertMarkerAgreement(paths: ControlPlanePaths, reservation: InstanceReservation): Promise<void> {
  await assertOwnedDirectory(reservation.checkout_realpath);
  const marker = await readInstanceMarkerFile(paths.markerFile(reservation.instance_id));
  if (marker.instance_id !== reservation.instance_id || marker.deployed_commit !== reservation.deployed_commit) {
    throw new GwsEaError('marker_mismatch', 'Instance marker mismatch; refusing mutation');
  }
}

export async function assertRegistryMarkerAgreement(
  paths: ControlPlanePaths,
  instanceId: string,
): Promise<InstanceReservation> {
  const reservation = await getInstanceReservation(paths, instanceId);
  await assertMarkerAgreement(paths, reservation);
  return reservation;
}

/**
 * A missing checkout without its marker is consistent: it was never
 * materialized, or is already removed. A present checkout must carry this
 * reservation's marker before anything touches it.
 */
export async function assertCheckoutConsistent(
  paths: ControlPlanePaths,
  reservation: InstanceReservation,
): Promise<void> {
  try {
    await lstat(reservation.checkout_realpath);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return;
    throw error;
  }
  await assertMarkerAgreement(paths, reservation);
}

export async function writeInstanceMarker(paths: ControlPlanePaths, instanceId: string): Promise<void> {
  const reservation = await getInstanceReservation(paths, instanceId);
  await assertOwnedDirectory(reservation.checkout_realpath);
  try {
    const existing = await readInstanceMarkerFile(paths.markerFile(instanceId));
    if (existing.instance_id !== instanceId) {
      throw new GwsEaError('marker_mismatch', 'Instance marker mismatch; refusing mutation');
    }
    return;
  } catch (error) {
    if (!(error instanceof GwsEaError) || error.code !== 'marker_missing') throw error;
  }
  await preparePrivateDirectory(path.dirname(paths.markerFile(instanceId)));
  await writePrivate(paths.markerFile(instanceId), {
    schema_version: INSTANCE_MARKER_SCHEMA_VERSION,
    instance_id: instanceId,
    deployed_commit: reservation.deployed_commit,
  } satisfies InstanceMarker);
}
