import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readJson, writePrivate } from '../community-portal/private-file.js';
import { processLock } from '../community-portal/process-lock.js';
import { isErrno } from '../community-portal/errors.js';
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
  type InstanceMarker,
  type InstanceRegistry,
  type InstanceReservation,
  type InstanceReservationInput,
} from './types.js';

const INSTANCE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RELEASE_TRACK_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const GCP_PROJECT_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const ONECLI_PROJECT_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return code !== undefined && (code <= 0x1f || code === 0x7f);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new GwsEaError('invalid_claim', 'Endpoint URL is invalid');
  }
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== '/webhook/gchat'
  ) {
    throw new GwsEaError(
      'invalid_claim',
      'Endpoint must be an HTTPS URL with the exact /webhook/gchat path and no credentials, query, or fragment',
    );
  }
  return endpoint.href;
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
    ['endpoint_url', 'gcp_project_id', 'chat_app_id', 'chat_credential_id', 'workspace_email', 'onecli_project'],
    'exclusive_resource_claims',
  );
  const gcpProject = requireString(value.gcp_project_id, 'gcp_project_id', 30).toLowerCase();
  if (!GCP_PROJECT_PATTERN.test(gcpProject)) throw new GwsEaError('invalid_claim', 'GCP project ID is invalid');
  const workspaceEmail = requireString(value.workspace_email, 'workspace_email', 320).toLowerCase();
  if (!EMAIL_PATTERN.test(workspaceEmail)) throw new GwsEaError('invalid_claim', 'Workspace email is invalid');
  const onecliProject = requireString(value.onecli_project, 'onecli_project', 63).toLowerCase();
  if (!ONECLI_PROJECT_PATTERN.test(onecliProject)) {
    throw new GwsEaError('invalid_claim', 'OneCLI project identity is invalid');
  }
  return {
    endpoint_url: validateEndpoint(value.endpoint_url),
    gcp_project_id: gcpProject,
    chat_app_id: requireString(value.chat_app_id, 'chat_app_id', 256),
    chat_credential_id: requireString(value.chat_credential_id, 'chat_credential_id', 256),
    workspace_email: workspaceEmail,
    onecli_project: onecliProject,
  };
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
  assertExactKeys(value, ['schema_version', 'instances'], 'Machine registry');
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
  return { schema_version: REGISTRY_SCHEMA_VERSION, instances };
}

function emptyRegistry(): InstanceRegistry {
  return { schema_version: REGISTRY_SCHEMA_VERSION, instances: {} };
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
  return [
    `checkout:${instance.checkout_realpath}`,
    ...Object.values(instance.allocated_ports).map((port) => `port:${port}`),
    `endpoint:${claims.endpoint_url}`,
    `gcp-project:${claims.gcp_project_id}`,
    `chat-app:${claims.chat_app_id}`,
    `chat-credential:${claims.chat_credential_id}`,
    `workspace-email:${claims.workspace_email}`,
    `onecli-project:${claims.onecli_project}`,
  ];
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
    const next: InstanceRegistry = {
      schema_version: REGISTRY_SCHEMA_VERSION,
      instances: { ...registry.instances, [validated.instance_id]: validated },
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

function validateMarker(value: unknown): InstanceMarker {
  if (!isRecord(value)) throw new GwsEaError('invalid_marker', 'Instance marker is invalid');
  assertExactKeys(value, ['schema_version', 'instance_id'], 'Instance marker');
  if (value.schema_version !== INSTANCE_MARKER_SCHEMA_VERSION) {
    throw new GwsEaError('unsupported_marker', 'Instance marker schema version is unsupported');
  }
  const instanceId = requireString(value.instance_id, 'marker instance_id', 36);
  assertInstanceId(instanceId);
  return { schema_version: INSTANCE_MARKER_SCHEMA_VERSION, instance_id: instanceId };
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
  if (marker.instance_id !== instanceId) {
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
  } satisfies InstanceMarker);
}
