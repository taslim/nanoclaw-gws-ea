import { randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { readJson, writePrivate } from '../community-portal/private-file.js';
import { processLock } from '../community-portal/process-lock.js';
import { isErrno } from '../community-portal/errors.js';
import { deriveGcpClaims } from './gcp-identity.js';
import { RELEASE_TRACK_PATTERN } from './release-tracks.js';
import {
  assertOwnedDirectory,
  assertPrivateDirectory,
  assertPrivateStateFile,
  instanceMarkerFile,
  instanceRootName,
  preparePrivateDirectory,
  type ControlPlanePaths,
} from './paths.js';
import {
  GwsEaError,
  INSTANCE_MARKER_SCHEMA_VERSION,
  REGISTRY_SCHEMA_VERSION,
  sameRelease,
  type AllocatedPorts,
  type ArtifactsNamespaceClaim,
  type ExclusiveResourceClaims,
  type InstanceMarker,
  type InstanceRegistry,
  type InstanceReservation,
  type ReleaseCoordinates,
} from './types.js';
import { EMAIL_PATTERN, INSTANCE_ID_PATTERN, isRecord, parseJson, requireString as requireText } from './validation.js';

const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const ONECLI_PROJECT_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/** Readers ignore fields they do not use. */
function requireString(value: unknown, label: string, maxLength?: number): string {
  return requireText(value, label, 'invalid_state', maxLength);
}

export function assertInstanceId(value: string): void {
  if (!INSTANCE_ID_PATTERN.test(value)) throw new GwsEaError('invalid_instance_id', 'Instance ID is invalid');
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return false;
    throw error;
  }
}

/**
 * Drawn until its root, `<state root>/<first 8 hex>`, is free: no registered
 * assistant shares those digits and nothing is there yet. Checked under the
 * machine lock; the reservation's claim on the root then keeps a concurrent
 * create from taking it too.
 */
export async function allocateInstanceId(
  paths: ControlPlanePaths,
  generate: () => string = randomUUID,
): Promise<string> {
  return withMachineLock(paths, async () => {
    const taken = new Set(Object.keys((await readRegistryFile(paths)).instances).map(instanceRootName));
    for (;;) {
      const instanceId = generate();
      assertInstanceId(instanceId);
      if (!taken.has(instanceRootName(instanceId)) && !(await pathExists(paths.instanceRoot(instanceId)))) {
        return instanceId;
      }
    }
  });
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
    onecli_app: validatePort(value.onecli_app, 'onecli_app'),
    onecli_gateway: validatePort(value.onecli_gateway, 'onecli_gateway'),
  };
  if (new Set(Object.values(ports)).size !== Object.values(ports).length) {
    throw new GwsEaError('invalid_claim', 'Allocated ports must be distinct');
  }
  return ports;
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

/**
 * The claims of the assistant `instanceId` names. Its Google Cloud project is
 * exactly the one derived from that ID, which the host's environment names
 * too, and so are the topic, subscription, and subscriber account derived
 * from the project: none can name another assistant's.
 */
function validateClaims(value: unknown, instanceId: string): ExclusiveResourceClaims {
  if (!isRecord(value)) throw new GwsEaError('invalid_claim', 'exclusive_resource_claims is invalid');
  const gcp = deriveGcpClaims(instanceId);
  for (const [claim, derived] of Object.entries(gcp)) {
    if (value[claim] !== derived) throw new GwsEaError('invalid_claim', `${claim} is not this assistant's`);
  }
  const gcpAccount = requireString(value.gcp_account, 'gcp_account', 320).toLowerCase();
  if (!EMAIL_PATTERN.test(gcpAccount)) throw new GwsEaError('invalid_claim', 'GCP account is invalid');
  const workspaceEmail = requireString(value.workspace_email, 'workspace_email', 320).toLowerCase();
  if (!EMAIL_PATTERN.test(workspaceEmail)) throw new GwsEaError('invalid_claim', 'Workspace email is invalid');
  const onecliProject = requireString(value.onecli_project, 'onecli_project', 63).toLowerCase();
  if (!ONECLI_PROJECT_PATTERN.test(onecliProject)) {
    throw new GwsEaError('invalid_claim', 'OneCLI project identity is invalid');
  }
  const aliasEmail = value.alias_email === undefined ? undefined : validateAliasEmail(value.alias_email);
  if (aliasEmail === workspaceEmail) {
    throw new GwsEaError('invalid_claim', "The web alias is the assistant's own workspace email");
  }
  return {
    ...gcp,
    gcp_account: gcpAccount,
    workspace_email: workspaceEmail,
    ...(aliasEmail === undefined ? {} : { alias_email: aliasEmail }),
    onecli_project: onecliProject,
    ...(value.artifacts === undefined ? {} : { artifacts: validateArtifactsClaim(value.artifacts) }),
    ...(value.whatsapp_number === undefined ? {} : { whatsapp_number: validateWhatsAppNumber(value.whatsapp_number) }),
  };
}

function validateArtifactsClaim(value: unknown): ArtifactsNamespaceClaim {
  if (
    !isRecord(value) ||
    typeof value.hostname !== 'string' ||
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(value.hostname) ||
    typeof value.path_prefix !== 'string'
  )
    throw new GwsEaError('invalid_claim', 'Artifact namespace is invalid');
  const prefix = value.path_prefix;
  if (prefix !== '') {
    let decoded: string;
    try {
      decoded = decodeURIComponent(prefix.slice(1));
    } catch (cause) {
      throw new GwsEaError('invalid_claim', 'Artifact namespace encoding is invalid', { cause });
    }
    if (
      !decoded ||
      decoded === '.' ||
      decoded === '..' ||
      /[\\/%\p{Cc}]/u.test(decoded) ||
      decoded !== decoded.normalize('NFKC').toLowerCase().replace(/\s+/gu, '-') ||
      prefix !== `/${encodeURIComponent(decoded)}` ||
      ['public', 'private', 'guest', 'assets', 'api', 'cdn-cgi', 'health', 'login', 'logout'].includes(decoded)
    )
      throw new GwsEaError('invalid_claim', 'Artifact namespace is invalid');
  }
  return {
    hostname: value.hostname,
    path_prefix: prefix,
    listen_port: validatePort(value.listen_port, 'artifact listener'),
  };
}

function validateWhatsAppNumber(value: unknown): string {
  if (typeof value !== 'string' || !/^\+[1-9]\d{6,14}$/u.test(value))
    throw new GwsEaError('invalid_claim', 'WhatsApp account number must be E.164');
  return value;
}

function validateAliasEmail(value: unknown): string {
  const aliasEmail = requireString(value, 'alias_email', 320).toLowerCase();
  if (!EMAIL_PATTERN.test(aliasEmail)) throw new GwsEaError('invalid_claim', 'Web alias is invalid');
  return aliasEmail;
}

export function validateReleaseCoordinates(value: unknown): ReleaseCoordinates {
  if (!isRecord(value)) throw new GwsEaError('invalid_state', 'Release coordinates are invalid');
  const releaseTrack = requireString(value.release_track, 'release_track', 64);
  if (!RELEASE_TRACK_PATTERN.test(releaseTrack)) throw new GwsEaError('invalid_state', 'Release track is invalid');
  const deployedCommit = requireString(value.deployed_commit, 'deployed_commit', 40).toLowerCase();
  if (!COMMIT_PATTERN.test(deployedCommit)) throw new GwsEaError('invalid_state', 'Deployed commit is invalid');
  return {
    source_remote: validateSourceRemote(value.source_remote),
    release_track: releaseTrack,
    deployed_commit: deployedCommit,
  };
}

export function validateReservation(value: unknown): InstanceReservation {
  if (!isRecord(value)) throw new GwsEaError('invalid_state', 'Instance reservation is invalid');
  const instanceId = requireString(value.instance_id, 'instance_id', 36);
  assertInstanceId(instanceId);
  const release = validateReleaseCoordinates(value);
  const allocatedPorts = validatePorts(value.allocated_ports);
  const claims = validateClaims(value.exclusive_resource_claims, instanceId);
  if (claims.artifacts && Object.values(allocatedPorts).includes(claims.artifacts.listen_port))
    throw new GwsEaError('invalid_claim', 'The artifact listener must have its own distinct port');
  return {
    instance_id: instanceId,
    release_track: release.release_track,
    source_remote: release.source_remote,
    deployed_commit: release.deployed_commit,
    allocated_ports: allocatedPorts,
    exclusive_resource_claims: claims,
  };
}

function validateRegistry(value: unknown, file: string): InstanceRegistry {
  if (!isRecord(value)) throw new GwsEaError('invalid_registry', 'Machine registry is invalid');
  const version = value.schema_version;
  if (typeof version === 'number' && version < REGISTRY_SCHEMA_VERSION) {
    // Nothing converts it: the assistants it holds were built for a Chat app and its webhook.
    throw new GwsEaError(
      'unsupported_registry',
      `The machine registry ${file} is from an earlier gws-ea release. Remove each assistant in it with that release (gws-ea remove --id <instance_id>), then delete ${file} and retry.`,
    );
  }
  if (version !== REGISTRY_SCHEMA_VERSION) {
    throw new GwsEaError('unsupported_registry', 'Machine registry schema version is unsupported');
  }
  if (!isRecord(value.instances)) throw new GwsEaError('invalid_registry', 'Machine registry instances are invalid');
  const instances: Record<string, InstanceReservation> = {};
  for (const [key, raw] of Object.entries(value.instances)) {
    assertInstanceId(key);
    const parsed = validateReservation(raw);
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
    return validateRegistry(raw, paths.registryFile);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return emptyRegistry();
    if (error instanceof GwsEaError) throw error;
    throw new GwsEaError('invalid_registry', 'Machine registry cannot be parsed safely');
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
    // Distinct IDs can still share a root's name, their first eight hex digits.
    `instance-root:${instanceRootName(instance.instance_id)}`,
    ...Object.values(instance.allocated_ports).map((port) => `port:${port}`),
    `gcp-project:${claims.gcp_project_id}`,
    `gchat-events-topic:${claims.gchat_events_topic}`,
    `gchat-events-subscription:${claims.gchat_events_subscription}`,
    `gchat-subscriber-account:${claims.gchat_subscriber_account}`,
    // An assistant's workspace email and its web alias are both mailboxes: no address is two assistants'.
    `mailbox:${claims.workspace_email}`,
    ...(claims.alias_email === undefined ? [] : [`mailbox:${claims.alias_email}`]),
    `onecli-project:${claims.onecli_project}`,
    ...(claims.whatsapp_number === undefined ? [] : [`whatsapp-number:${claims.whatsapp_number}`]),
    ...(claims.artifacts === undefined ? [] : [`port:${claims.artifacts.listen_port}`]),
  ];
  return keys;
}

export function otherAssistantsMailboxes(registry: InstanceRegistry, instanceId: string): ReadonlySet<string> {
  return new Set(
    Object.values(registry.instances)
      .filter((instance) => instance.instance_id !== instanceId)
      .flatMap(({ exclusive_resource_claims: claims }) => [
        claims.workspace_email,
        ...(claims.alias_email === undefined ? [] : [claims.alias_email]),
      ]),
  );
}

function assertNoClaimCollisions(instances: readonly InstanceReservation[]): void {
  const seen = new Map<string, string>();
  for (const instance of instances) {
    const namespace = instance.exclusive_resource_claims.artifacts;
    if (
      namespace &&
      instances.some((other) => {
        const claim = other.exclusive_resource_claims.artifacts;
        return (
          other.instance_id !== instance.instance_id &&
          claim?.hostname === namespace.hostname &&
          (claim.path_prefix === '' || namespace.path_prefix === '' || claim.path_prefix === namespace.path_prefix)
        );
      })
    )
      throw new GwsEaError(
        'claim_conflict',
        'Artifact namespace is already claimed. Configure a different assistant hostname.',
      );
    for (const claim of claimKeys(instance)) {
      const owner = seen.get(claim);
      if (owner && owner !== instance.instance_id) {
        throw new GwsEaError('claim_conflict', 'An exclusive operational resource is already claimed');
      }
      seen.set(claim, instance.instance_id);
    }
  }
}

/** The claim outlives a disable, and a re-enable must claim the same hostname, prefix and port. */
export async function claimInstanceArtifacts(
  paths: ControlPlanePaths,
  instanceId: string,
  claim: ArtifactsNamespaceClaim,
): Promise<InstanceReservation> {
  return withMachineLock(paths, async () => {
    const registry = await readRegistryFile(paths);
    const stored = registry.instances[instanceId];
    if (!stored) throw new GwsEaError('unknown_instance', 'Unknown instance ID');
    const previous = stored.exclusive_resource_claims.artifacts;
    if (previous) {
      if (JSON.stringify(previous) !== JSON.stringify(validateArtifactsClaim(claim)))
        throw new GwsEaError(
          'claim_conflict',
          'Existing artifact links retain their claimed hostname, prefix and port.',
        );
      return stored;
    }
    const next = validateReservation({
      ...stored,
      exclusive_resource_claims: { ...stored.exclusive_resource_claims, artifacts: claim },
    });
    const instances = { ...registry.instances, [instanceId]: next };
    assertNoClaimCollisions(Object.values(instances));
    await writePrivate(paths.registryFile, { ...registry, instances });
    return next;
  });
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
 * Hold the machine lock for one machine-wide effect, such as an instance
 * reservation. Everything else locks per instance.
 */
export async function withMachineLock<T>(paths: ControlPlanePaths, callback: () => Promise<T>): Promise<T> {
  const release = await acquireMachineLock(paths);
  try {
    return await callback();
  } finally {
    release();
  }
}

export interface StagedReservation {
  publish(): Promise<void>;
  /** A registry that cannot be read counts as holding the reservation. */
  published(): Promise<boolean>;
}

/**
 * Check a validated reservation against the registry: an existing instance ID
 * or a claim another instance holds is refused. Call it under
 * `withMachineLock` and publish under the same lock, so nothing can claim the
 * same resources in between.
 */
export async function stageReservation(
  paths: ControlPlanePaths,
  reservation: InstanceReservation,
): Promise<StagedReservation> {
  const registry = await readRegistryFile(paths);
  if (registry.instances[reservation.instance_id]) {
    throw new GwsEaError('instance_exists', 'Instance ID already exists');
  }
  assertNoClaimCollisions([...Object.values(registry.instances), reservation]);
  const next: InstanceRegistry = {
    schema_version: REGISTRY_SCHEMA_VERSION,
    instances: { ...registry.instances, [reservation.instance_id]: reservation },
  };
  return {
    publish: () => writePrivate(paths.registryFile, next),
    published: () =>
      readRegistryFile(paths).then(
        (current) => current.instances[reservation.instance_id] !== undefined,
        () => true,
      ),
  };
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

/**
 * The single commit point of an update or rollback: under the machine lock,
 * move one reservation's release from `expected` to `next`. Nothing else in
 * the registry changes, and a reservation whose release is not `expected` is
 * refused, so two writers can never both commit.
 */
export async function swapInstanceRelease(
  paths: ControlPlanePaths,
  instanceId: string,
  expected: ReleaseCoordinates,
  next: ReleaseCoordinates,
): Promise<InstanceReservation> {
  assertInstanceId(instanceId);
  const release = validateReleaseCoordinates(next);
  return withMachineLock(paths, async () => {
    const registry = await readRegistryFile(paths);
    const stored = registry.instances[instanceId];
    if (!stored) throw new GwsEaError('unknown_instance', 'Unknown instance ID');
    if (!sameRelease(stored, expected)) {
      throw new GwsEaError('reservation_mismatch', "The assistant's recorded release changed; refusing to replace it");
    }
    const moved = validateReservation({ ...stored, ...release });
    await writePrivate(
      paths.registryFile,
      validateRegistry({ ...registry, instances: { ...registry.instances, [instanceId]: moved } }, paths.registryFile),
    );
    return moved;
  });
}

/**
 * Point one assistant's web alias claim at `aliasEmail`, or drop it when
 * undefined. Under the machine lock, so of two assistants claiming one
 * address only the first holds it; an address another assistant holds as its
 * alias or workspace email is refused with `claim_conflict`. Nothing else in
 * the registry changes, and a claim already held writes nothing.
 */
export async function claimInstanceAlias(
  paths: ControlPlanePaths,
  instanceId: string,
  aliasEmail: string | undefined,
): Promise<InstanceReservation> {
  assertInstanceId(instanceId);
  return withMachineLock(paths, async () => {
    const registry = await readRegistryFile(paths);
    const stored = registry.instances[instanceId];
    if (!stored) throw new GwsEaError('unknown_instance', 'Unknown instance ID');
    const { alias_email: _previous, ...claims } = stored.exclusive_resource_claims;
    const claimed = validateReservation({
      ...stored,
      exclusive_resource_claims: { ...claims, ...(aliasEmail === undefined ? {} : { alias_email: aliasEmail }) },
    });
    if (claimed.exclusive_resource_claims.alias_email === stored.exclusive_resource_claims.alias_email) return stored;
    await writePrivate(
      paths.registryFile,
      validateRegistry(
        { ...registry, instances: { ...registry.instances, [instanceId]: claimed } },
        paths.registryFile,
      ),
    );
    return claimed;
  });
}

/** Undefined releases the claim; no other claim changes. */
export async function claimInstanceWhatsApp(
  paths: ControlPlanePaths,
  instanceId: string,
  number: string | undefined,
): Promise<InstanceReservation> {
  assertInstanceId(instanceId);
  if (number !== undefined) validateWhatsAppNumber(number);
  return withMachineLock(paths, async () => {
    const registry = await readRegistryFile(paths);
    const stored = registry.instances[instanceId];
    if (!stored) throw new GwsEaError('unknown_instance', 'Unknown instance ID');
    if (
      number !== undefined &&
      Object.values(registry.instances).some(
        (instance) =>
          instance.instance_id !== instanceId && instance.exclusive_resource_claims.whatsapp_number === number,
      )
    )
      throw new GwsEaError('claim_conflict', `WhatsApp number ${number} is already held by another assistant`);
    if (stored.exclusive_resource_claims.whatsapp_number === number) return stored;
    const { whatsapp_number: _previous, ...claims } = stored.exclusive_resource_claims;
    const next = validateReservation({
      ...stored,
      exclusive_resource_claims: { ...claims, ...(number === undefined ? {} : { whatsapp_number: number }) },
    });
    await writePrivate(
      paths.registryFile,
      validateRegistry({ ...registry, instances: { ...registry.instances, [instanceId]: next } }, paths.registryFile),
    );
    return next;
  });
}

export async function releaseInstanceReservation(
  paths: ControlPlanePaths,
  expected: InstanceReservation,
): Promise<void> {
  const validated = validateReservation(expected);
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
    await writePrivate(paths.registryFile, { schema_version: REGISTRY_SCHEMA_VERSION, instances });
  } finally {
    release();
  }
}

/** Read the marker's instance, ignoring every other field: which release runs is the live link, not the marker. */
function validateMarker(value: unknown): InstanceMarker {
  if (!isRecord(value)) throw new GwsEaError('invalid_marker', 'Instance marker is invalid');
  if (value.schema_version !== INSTANCE_MARKER_SCHEMA_VERSION) {
    throw new GwsEaError('unsupported_marker', 'Instance marker schema version is unsupported');
  }
  const instanceId = requireString(value.instance_id, 'marker instance_id', 36);
  assertInstanceId(instanceId);
  return { schema_version: INSTANCE_MARKER_SCHEMA_VERSION, instance_id: instanceId };
}

/** A missing file raises `marker_missing`. */
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

/**
 * `stateRoot` is a physical directory whose marker, in a physical
 * `data/gws-ea`, names `instanceId`. Nothing on the way is a link, so the
 * check holds while the live link is absent.
 */
export async function assertStateMarker(stateRoot: string, instanceId: string): Promise<void> {
  await assertOwnedDirectory(stateRoot);
  const file = instanceMarkerFile(stateRoot);
  await assertOwnedDirectory(path.dirname(file));
  const marker = await readInstanceMarkerFile(file);
  if (marker.instance_id !== instanceId) {
    throw new GwsEaError('marker_mismatch', 'Instance marker mismatch; refusing mutation');
  }
}

/** The registry's reservation, once the assistant's own `state/` carries its marker. */
export async function assertRegistryMarkerAgreement(
  paths: ControlPlanePaths,
  instanceId: string,
): Promise<InstanceReservation> {
  const reservation = await getInstanceReservation(paths, instanceId);
  await assertStateMarker(paths.instanceLayout(instanceId).state, instanceId);
  return reservation;
}

/**
 * A missing `state/` is consistent: create never made it, or removal already
 * did away with it. A present one must carry this reservation's marker before
 * anything touches it.
 */
export async function assertStateConsistent(paths: ControlPlanePaths, reservation: InstanceReservation): Promise<void> {
  const state = paths.instanceLayout(reservation.instance_id).state;
  if (!(await pathExists(state))) return;
  await assertStateMarker(state, reservation.instance_id);
}

/** Into the assistant's physical `state/`; an existing marker naming another assistant is refused. */
export async function writeInstanceMarker(paths: ControlPlanePaths, instanceId: string): Promise<void> {
  await getInstanceReservation(paths, instanceId);
  const file = paths.markerFile(instanceId);
  await preparePrivateDirectory(path.dirname(file));
  await assertOwnedDirectory(paths.instanceLayout(instanceId).state);
  try {
    const existing = await readInstanceMarkerFile(file);
    if (existing.instance_id !== instanceId) {
      throw new GwsEaError('marker_mismatch', 'Instance marker mismatch; refusing mutation');
    }
    return;
  } catch (error) {
    if (!(error instanceof GwsEaError) || error.code !== 'marker_missing') throw error;
  }
  await writePrivate(file, {
    schema_version: INSTANCE_MARKER_SCHEMA_VERSION,
    instance_id: instanceId,
  } satisfies InstanceMarker);
}
