/**
 * Removal from any partial state. A resource is observed only when
 * the provisioning step that owns it ever started: no journal means
 * nothing started, and a journal this launcher cannot read means every
 * resource is observed. An absent resource is done; an owned one is deleted
 * and observed again; a foreign one is refused by name; one that cannot be
 * observed pauses with evidence until the operator abandons it. Everything a
 * resource needs — Docker, NanoClaw's service helpers, Google sign-in, the
 * Cloudflare token — is checked before the first change, and removal locks
 * only its own instance, so one stuck removal never blocks another assistant.
 * NanoClaw's helpers stop the host; removal then cleans up what they leave.
 * An unfinished update or rollback never stops it: its staged, kept, and
 * outgoing releases all sit under the instance root, and go with it. So does
 * every image the assistant's updates and rollbacks built or displaced, while
 * the images assistants share stay (KTD19).
 */
import { access, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { writePrivate } from '../community-portal/private-file.js';
import { processLock } from '../community-portal/process-lock.js';
import { isErrno } from '../community-portal/errors.js';
import { getInstallScopedNames } from '../install-slug.js';
import {
  CloudflareAmbiguousMutationError,
  createCloudflareApi,
  type CloudflareApi,
  type CloudflareDnsRecord,
  type CloudflareTunnel,
} from './cloudflare-api.js';
import {
  connectorNetworking,
  createCloudflareConnectorLayout,
  stopCloudflareConnector,
  type CloudflareConnectorLayout,
  type CloudflareOriginHost,
} from './cloudflare-connector.js';
import {
  assertManagedCloudflareConfigurationOwnership,
  chooseOwnedDnsRecord,
  desiredDnsRecord,
  GCHAT_TUNNEL_PATH,
  renderManagedCloudflareConfiguration,
  replaceManagedCloudflareConfiguration,
} from './cloudflare-ingress.js';
import { imageTags } from './agent-image.js';
import {
  PauseRequired,
  runStep,
  withGoogleSignIn,
  type CloudflareTokenRequest,
  type StepIdentity,
  type StepReporter,
} from './events.js';
import {
  assertGcloudInstalled,
  assertGcloudSignedIn,
  deleteOwnedGcpProject,
  restoreKeyCreationPolicyForRemoval,
  type GcloudCommandRunner,
  type GcpProjectCoordinates,
} from './gcloud.js';
import { readProvisionJournal } from './journal.js';
import { createOnecliRuntimeLayout } from './onecli-compose.js';
import { removeOnecliRuntime } from './onecli.js';
import { liveCheckoutCommits, readOperationRecord, type OperationRecord } from './operation.js';
import {
  CONTROL_PLANE_ROOT,
  instanceRuntimeFile,
  preparePrivateDirectory,
  type ControlPlanePaths,
  type ReleaseSlot,
} from './paths.js';
import { pollUntil } from './poll.js';
import { probeRecordedDockerEndpoint, resolveDockerEndpoint } from './prerequisites.js';
import {
  buildToolEnvironment,
  checkedRunner,
  commandExitError,
  resolveExecutable,
  runSanitizedCommandOutcome,
  type SanitizedCommand,
  type SanitizedCommandOutcomeRunner,
} from './process.js';
import {
  activeRemovalInstanceIds,
  assertCheckoutConsistent,
  assertCheckoutMarker,
  assertInstanceId,
  getInstanceReservation,
  readRegistry,
  releaseInstanceReservation,
  validateReservation,
  withLockedCloudflareRegistry,
} from './registry.js';
import { activeStep } from './run-log.js';
import { readOwnerOnlyJson, removePrivateFile } from './secrets.js';
import { serviceManagerEnvironment } from './service.js';
import { createServiceControl, type NanoclawServiceHelpers } from './service-control.js';
import {
  createInstanceServiceCoordinates,
  instanceServicePlatform,
  type InstanceServiceCoordinates,
  type InstanceServicePlatform,
} from './service-coordinates.js';
import {
  GwsEaError,
  ingressEndpointUrl,
  type InstanceRegistry,
  type InstanceReservation,
  type ManagedCloudflareIngressClaim,
  type ProvisionStepId,
  type SharedCloudflareMetadata,
} from './types.js';
import { canonicalTimestamp, isRecord, requireDockerEndpoint, requirePath } from './validation.js';
import { forgetAccountToken, forgettingRefusedToken, usableKeptAccountToken } from './cloudflare-token.js';
import type { CloudflareZoneChoice } from './create-input.js';

/** Resources in teardown order; the registry entry is released after all of them. */
export const REMOVAL_RESOURCES = ['managed-ingress', 'nanoclaw', 'gcp-project', 'onecli', 'instance-files'] as const;
export type RemovalResource = (typeof REMOVAL_RESOURCES)[number];

/**
 * What an operator may leave behind when removal cannot observe it (`--abandon`):
 * the Google Cloud project, or the assistant's DNS record in a Cloudflare zone
 * the token can no longer see (a deleted zone takes its records with it).
 */
export const ABANDONABLE_RESOURCES = ['gcp-project', 'cloudflare-dns'] as const;
export type AbandonableResource = (typeof ABANDONABLE_RESOURCES)[number];

function isAbandonable(resource: RemovalResource): resource is RemovalResource & AbandonableResource {
  return ABANDONABLE_RESOURCES.some((candidate) => candidate === resource);
}

const RECEIPT_SCHEMA_VERSION = 3 as const;
const INVALID_RECORD = 'invalid_runtime_config';
const CONNECTION_ATTEMPTS = 30;
const CONNECTION_DELAY_MS = 1_000;
const DELETE_ATTEMPTS = 3;

const RESOURCE_STEPS: Readonly<Record<RemovalResource, StepIdentity>> = {
  'managed-ingress': { id: 'remove_managed_ingress', label: 'Removing the Cloudflare route…' },
  nanoclaw: { id: 'remove_nanoclaw', label: 'Stopping NanoClaw…' },
  'gcp-project': { id: 'remove_gcp_project', label: 'Deleting the Google Cloud project…' },
  onecli: { id: 'remove_onecli', label: 'Removing OneCLI…' },
  'instance-files': { id: 'remove_instance_files', label: 'Removing local files…' },
};

interface Evidence {
  readonly at: string;
  readonly evidence: string;
}

/** The durable record of a removal under way: its reservation snapshot and what each resource came to. */
interface RemovalReceipt {
  readonly schema_version: typeof RECEIPT_SCHEMA_VERSION;
  readonly instance_id: string;
  readonly reservation: InstanceReservation;
  readonly started_at: string;
  readonly completed: Readonly<Partial<Record<RemovalResource, string>>>;
  readonly abandoned: Readonly<Partial<Record<AbandonableResource, Evidence>>>;
  /** A key-creation policy `provision_gcp` lifted that Google refused to restore. */
  readonly key_policy_unrestored?: Evidence;
}

/** What local teardown uses, as the instance recorded it. */
export interface LocalRuntime {
  readonly homeDirectory: string;
  readonly dockerEndpoint: string;
  readonly onecliCliPath: string | undefined;
}

/** The human input removal may need, through the driver's `Interaction` port. */
export interface RemovalInteraction {
  signInToGoogleCloud(account: string): Promise<void>;
  requestCloudflareAccountToken(request: CloudflareTokenRequest): Promise<string>;
}

/** What the driver supplies to one removal. */
export interface RemovalOptions {
  readonly interaction: RemovalInteraction;
  /** Resources the operator accepts leaving behind if removal cannot observe them. */
  readonly abandon?: ReadonlySet<AbandonableResource>;
  readonly reporter?: StepReporter;
  /** NanoClaw's service helpers (`scripts/update/service.ts`), which stop the host; the driver supplies them. */
  readonly serviceHelpers?: NanoclawServiceHelpers;
}

/** Boundary seams; each defaults to the real one. */
export interface RemovalDependencies extends RemovalOptions {
  readonly platform?: InstanceServicePlatform;
  /** Runs local teardown: the service manager fallback, the stray-host kill, and Docker. */
  readonly runCommand?: SanitizedCommandOutcomeRunner;
  readonly runGcloud?: GcloudCommandRunner;
  /** Probe the recorded Docker endpoint, else resolve the active local one. */
  readonly resolveDocker?: (recorded: string | undefined) => Promise<string>;
  readonly createCloudflareApi?: (accountToken: string) => CloudflareApi;
  readonly uninstallNanoclaw?: (reservation: InstanceReservation, runtime: LocalRuntime) => Promise<void>;
  readonly removeOnecli?: (reservation: InstanceReservation, runtime: LocalRuntime) => Promise<void>;
  readonly stopCloudflareConnector?: (layout: CloudflareConnectorLayout, dockerEndpoint: string) => Promise<void>;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export interface AbandonedResource {
  readonly resource: AbandonableResource;
  readonly evidence: string;
}

export interface RemovalOutcome {
  /** Resources removal observed and removed, or found already gone. */
  readonly removed: readonly RemovalResource[];
  readonly abandoned: readonly AbandonedResource[];
  /** Why a lifted key-creation policy could not be restored. */
  readonly keyPolicyUnrestored?: string;
}

/**
 * Removal cannot observe a resource. It pauses with the evidence; the operator
 * fixes access and retries, or leaves the resource behind with `--abandon`.
 */
export class RemovalPause extends PauseRequired {
  readonly resource: AbandonableResource;

  constructor(resource: AbandonableResource, reason: string, evidence: string) {
    super(`${resource.replaceAll('-', '_')}_unobservable`, reason, [
      'Evidence:',
      ...evidence.split('\n').map((line) => `  ${line}`),
      `Leave it behind only if it is already gone or is not this assistant's; removal records this evidence.`,
    ]);
    this.name = 'RemovalPause';
    this.resource = resource;
  }
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

function evidenceOf(value: unknown): Evidence | undefined {
  if (!isRecord(value) || typeof value.evidence !== 'string') return undefined;
  const at = canonicalTimestamp(value.at);
  return at ? { at, evidence: value.evidence } : undefined;
}

function entries<K extends string, V>(keys: readonly K[], value: unknown, parse: (entry: unknown) => V | undefined) {
  const parsed: Partial<Record<K, V>> = {};
  if (!isRecord(value)) return parsed;
  for (const key of keys) {
    const entry = parse(value[key]);
    if (entry !== undefined) parsed[key] = entry;
  }
  return parsed;
}

/**
 * The receipt of a removal already under way. Unknown fields are ignored; a
 * receipt an earlier launcher wrote keeps only its reservation snapshot, so
 * every resource is observed again. A receipt that cannot be read safely is
 * set aside: everything it could say is re-observed.
 */
async function readReceipt(paths: ControlPlanePaths, instanceId: string): Promise<RemovalReceipt | undefined> {
  try {
    const raw = await readOwnerOnlyJson(paths.removalFile(instanceId), 'Removal receipt', 'invalid_removal');
    if (!isRecord(raw) || raw.instance_id !== instanceId) {
      throw new GwsEaError('invalid_removal', 'Removal receipt does not match this instance');
    }
    const reservation = validateReservation(raw.reservation, paths);
    if (reservation.instance_id !== instanceId) {
      throw new GwsEaError('invalid_removal', 'Removal receipt reservation does not match this instance');
    }
    const current = raw.schema_version === RECEIPT_SCHEMA_VERSION;
    const unrestored = current ? evidenceOf(raw.key_policy_unrestored) : undefined;
    return {
      schema_version: RECEIPT_SCHEMA_VERSION,
      instance_id: instanceId,
      reservation,
      started_at: canonicalTimestamp(raw.started_at) ?? new Date().toISOString(),
      completed: current ? entries(REMOVAL_RESOURCES, raw.completed, canonicalTimestamp) : {},
      abandoned: current ? entries(ABANDONABLE_RESOURCES, raw.abandoned, evidenceOf) : {},
      ...(unrestored ? { key_policy_unrestored: unrestored } : {}),
    };
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    if (!(error instanceof GwsEaError)) throw error;
    activeStep()?.write(`${error.message}; its resources are observed again\n`);
    return undefined;
  }
}

/** Which provisioning steps ever started, and whether `provision_gcp` left the key policy lifted. */
interface ProvisioningRecord {
  readonly started: (step: ProvisionStepId) => boolean;
  readonly keyPolicyLifted: boolean;
}

async function readProvisioningRecord(paths: ControlPlanePaths, instanceId: string): Promise<ProvisioningRecord> {
  try {
    const journal = await readProvisionJournal(paths, instanceId);
    return { started: (step) => journal.steps[step] !== undefined, keyPolicyLifted: journal.key_policy_lifted };
  } catch (error) {
    if (!(error instanceof GwsEaError)) throw error;
    if (error.code === 'journal_missing') return { started: () => false, keyPolicyLifted: false };
    activeStep()?.write(`${error.message}; every resource is observed\n`);
    return { started: () => true, keyPolicyLifted: false };
  }
}

async function readRecord(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const value = await readOwnerOnlyJson(file, 'Instance record', INVALID_RECORD);
    return isRecord(value) ? value : undefined;
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) return undefined;
    if (!(error instanceof GwsEaError)) throw error;
    activeStep()?.write(`${error.message}; not used for removal\n`);
    return undefined;
  }
}

/**
 * Where updates and rollbacks keep releases beside the live checkout, newest
 * first: the one an update stages, the one a rollback left, the rollback
 * point, and the rollback point an update set aside at its swap.
 */
const KEPT_RELEASES = ['next', 'outgoing', 'previous', 'superseded'] as const satisfies readonly ReleaseSlot[];

/**
 * The record of an unfinished update or rollback: undefined when there is
 * none, null when it cannot be read. Removal goes on without what an
 * unreadable one would say.
 */
async function readUnfinishedOperation(
  paths: ControlPlanePaths,
  instanceId: string,
): Promise<OperationRecord | undefined | null> {
  try {
    return await readOperationRecord(paths, instanceId);
  } catch (error) {
    if (!(error instanceof GwsEaError)) throw error;
    activeStep()?.write(
      `${error.message}; the live checkout is checked by its instance identity alone, and only the images its repository still tags are deleted\n`,
    );
    return null;
  }
}

/**
 * The agent images an unfinished update or rollback retagged or displaced, by
 * ID. A displaced image keeps no tag to be found by, and the record is the
 * only place that names it until its follow-ups delete it.
 */
function recordedAgentImages(record: OperationRecord | undefined | null): readonly string[] {
  if (!record) return [];
  const moved = record.images.flatMap((image) =>
    image.displaced_image_id === null ? [image.image_id] : [image.image_id, image.displaced_image_id],
  );
  const displaced = record.follow_ups.flatMap((followUp) =>
    followUp.kind === 'delete_image' ? [followUp.image_id] : [],
  );
  return [...new Set([...moved, ...displaced])];
}

/**
 * The live checkout must carry this assistant's marker at the registry's
 * commit, or at the one an unfinished update or rollback placed there; a
 * record that cannot be read cannot say which, so only the marker's instance
 * identity is checked. Every kept release, wherever an update or rollback
 * left it, is checked by its marker's instance identity alone, and staging
 * may have stopped before writing one.
 */
async function assertOwnCheckouts(
  paths: ControlPlanePaths,
  reservation: InstanceReservation,
  operation: OperationRecord | undefined | null,
): Promise<void> {
  await assertCheckoutConsistent(
    paths,
    reservation,
    operation === null ? null : liveCheckoutCommits(reservation, operation),
  );
  for (const slot of KEPT_RELEASES) {
    const checkout = paths.releaseCheckoutRoot(reservation.instance_id, slot);
    try {
      await assertCheckoutMarker(checkout, reservation.instance_id, null);
    } catch (error) {
      if (isErrno(error, 'ENOENT') || (error instanceof GwsEaError && error.code === 'marker_missing')) continue;
      throw error;
    }
  }
}

/**
 * The home directory, Docker endpoint, and OneCLI CLI the instance recorded:
 * `runtime.json` once the host started (in the live checkout, or, with an
 * update or rollback cut short, the newest kept release holding one), else
 * the bootstrap manifest create wrote. Only these fields are read, so files
 * an earlier launcher wrote still remove cleanly.
 */
async function readRecordedRuntime(
  paths: ControlPlanePaths,
  reservation: InstanceReservation,
): Promise<{ readonly homeDirectory?: string; readonly dockerEndpoint?: string; readonly onecliCliPath?: string }> {
  const records = await Promise.all([
    readRecord(instanceRuntimeFile(reservation.checkout_realpath)),
    ...KEPT_RELEASES.map((slot) =>
      readRecord(instanceRuntimeFile(paths.releaseCheckoutRoot(reservation.instance_id, slot))),
    ),
    readRecord(paths.bootstrapFile(reservation.instance_id)),
  ]);
  const field = (key: string, parse: (value: unknown, label: string, code: string) => string): string | undefined => {
    for (const record of records) {
      if (record?.[key] === undefined) continue;
      try {
        return parse(record[key], key, INVALID_RECORD);
      } catch (error) {
        if (!(error instanceof GwsEaError)) throw error;
      }
    }
    return undefined;
  };
  const homeDirectory = field('home_directory', requirePath);
  const dockerEndpoint = field('docker_endpoint', requireDockerEndpoint);
  const onecliCliPath = field('onecli_cli_path', requirePath);
  return {
    ...(homeDirectory ? { homeDirectory } : {}),
    ...(dockerEndpoint ? { dockerEndpoint } : {}),
    ...(onecliCliPath ? { onecliCliPath } : {}),
  };
}

function managedClaim(reservation: InstanceReservation): ManagedCloudflareIngressClaim | undefined {
  const ingress = reservation.exclusive_resource_claims.ingress;
  return ingress.mode === 'managed-cloudflare' ? ingress : undefined;
}

/**
 * Other managed assistants that still need the machine's tunnel: every live
 * one, and every removal that has not yet taken its route down. A receipt that
 * cannot be read counts as still needing it.
 */
async function tunnelUsers(paths: ControlPlanePaths, registry: InstanceRegistry, instanceId: string): Promise<number> {
  const peers = Object.values(registry.instances).filter(
    (instance) => instance.instance_id !== instanceId && managedClaim(instance) !== undefined,
  );
  const receipts = await Promise.all(peers.map((peer) => readReceipt(paths, peer.instance_id)));
  return receipts.filter((receipt) => receipt?.completed['managed-ingress'] === undefined).length;
}

/** Evaluate once, on first use. */
function once<T>(evaluate: () => Promise<T>): () => Promise<T> {
  let value: Promise<T> | undefined;
  return () => (value ??= evaluate());
}

/**
 * Delete, then observe again: gone is done even when the delete failed (it
 * was already deleted). Still there retries a delete Cloudflare did not
 * confirm; otherwise removal stops with the delete's error.
 */
async function deleteAndConfirm(send: () => Promise<void>, gone: () => Promise<boolean>, what: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    let failure: unknown;
    try {
      await send();
      // The observation below decides whether a failed delete matters.
      // eslint-disable-next-line no-catch-all/no-catch-all
    } catch (error) {
      failure = error;
    }
    if (await gone()) return;
    if (failure instanceof CloudflareAmbiguousMutationError && attempt < DELETE_ATTEMPTS) continue;
    throw (
      failure ?? new GwsEaError('cloudflare_removal_incomplete', `Cloudflare still shows ${what} after its deletion`)
    );
  }
}

/** This machine's tunnel, by the name only it uses; one with another ID than recorded is refused. */
async function observeTunnel(
  api: CloudflareApi,
  metadata: SharedCloudflareMetadata,
): Promise<CloudflareTunnel | undefined> {
  const tunnels = await api.listTunnels(metadata.account_id, metadata.tunnel_name);
  const [tunnel] = tunnels;
  if (!tunnel) return undefined;
  if (
    tunnels.length > 1 ||
    tunnel.name !== metadata.tunnel_name ||
    (metadata.tunnel_id !== null && tunnel.id !== metadata.tunnel_id)
  ) {
    throw new GwsEaError(
      'foreign_cloudflare_tunnel',
      `Cloudflare tunnel ${metadata.tunnel_name} is not the one this machine recorded; refusing to change it`,
    );
  }
  return tunnel;
}

function requireCloudflareMetadata(registry: InstanceRegistry): SharedCloudflareMetadata {
  const metadata = registry.shared_infrastructure_metadata.cloudflare;
  if (!metadata) throw new GwsEaError('cloudflare_state_missing', 'Shared Cloudflare ownership is not recorded');
  return metadata;
}

async function waitForTunnelConnectionsToClear(
  api: CloudflareApi,
  accountId: string,
  tunnelId: string,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<void> {
  const connections = await pollUntil(
    () => api.listTunnelConnections(accountId, tunnelId),
    (active) => active.length === 0,
    { intervalMs: CONNECTION_DELAY_MS, limitMs: (CONNECTION_ATTEMPTS - 1) * CONNECTION_DELAY_MS, sleep },
  );
  if (connections.length > 0) {
    throw new GwsEaError('cloudflare_connections_active', 'Cloudflare tunnel still has active connector sessions');
  }
}

/**
 * A Cloudflare client whose token lists zones in the reserved account, which
 * also proves it, account-owned tokens included: the token an unfinished
 * create kept, while Cloudflare still accepts it, else one the operator gives.
 */
async function authorizedApi(
  claim: ManagedCloudflareIngressClaim,
  interaction: RemovalInteraction,
  createApi: (accountToken: string) => CloudflareApi,
  keptTokenFile: string,
): Promise<{ readonly api: CloudflareApi; readonly zones: readonly CloudflareZoneChoice[] }> {
  let keptApi: CloudflareApi | undefined;
  const kept = await usableKeptAccountToken(keptTokenFile, claim.account_id, (token) => {
    keptApi = createApi(token);
    return keptApi.listActiveZones();
  });
  if (kept && keptApi) return { api: keptApi, zones: kept.zones };
  const token = await interaction.requestCloudflareAccountToken({
    accountId: claim.account_id,
    reason: `Removing managed callback ${claim.callback_url} requires temporary Cloudflare authorization.`,
  });
  const api = createApi(token);
  return { api, zones: await api.listActiveZones() };
}

interface CloudflareAuthority {
  readonly api: CloudflareApi;
  /** Set when the token cannot see the reserved zone and the operator leaves its DNS record behind. */
  readonly dnsLeftBehind?: string;
}

/**
 * A token that works, checked against the reserved zone. A zone it cannot see
 * pauses removal: Cloudflare answers the same for a deleted zone, whose
 * records went with it, and for a token without access, whose zone still
 * holds the record, so only the operator can say which it is.
 */
async function cloudflareAuthority(
  claim: ManagedCloudflareIngressClaim,
  interaction: RemovalInteraction,
  createApi: (accountToken: string) => CloudflareApi,
  options: { readonly leaveDnsBehind: boolean; readonly keptTokenFile: string },
): Promise<CloudflareAuthority> {
  const { leaveDnsBehind } = options;
  const { api, zones } = await authorizedApi(claim, interaction, createApi, options.keptTokenFile);
  if (
    zones.some(
      (zone) =>
        zone.accountId === claim.account_id &&
        zone.zoneId === claim.zone_id &&
        zone.name === claim.zone_name &&
        zone.status === 'active',
    )
  ) {
    return { api };
  }
  const inAccount = zones.filter((zone) => zone.accountId === claim.account_id);
  const renamed = inAccount.find((zone) => zone.name === claim.zone_name);
  const evidence = [
    `Reserved zone: ${claim.zone_name} (${claim.zone_id}) in account ${claim.account_id}`,
    `Active zones this token can see in that account: ${inAccount.map((zone) => zone.name).join(', ') || 'none'}`,
    ...(renamed ? [`${claim.zone_name} is now a different zone (${renamed.zoneId}), so the reserved one is gone`] : []),
  ].join('\n');
  if (leaveDnsBehind) return { api, dnsLeftBehind: evidence };
  // A kept token that cannot see the zone is not reused: the rerun asks for one that can.
  await forgetAccountToken(options.keptTokenFile);
  throw new RemovalPause(
    'cloudflare-dns',
    `Cloudflare cannot see zone ${claim.zone_name}, which holds this assistant's DNS record. If the zone was deleted, the record went with it; if not, rerun with a token that can read it.`,
    evidence,
  );
}

interface ManagedIngressRemoval {
  readonly paths: ControlPlanePaths;
  readonly reservation: InstanceReservation;
  readonly claim: ManagedCloudflareIngressClaim;
  readonly api: CloudflareApi;
  /** The assistant's own `establish_transport` started, so its DNS record may exist. */
  readonly ownTransport: boolean;
  readonly originHost: CloudflareOriginHost;
  readonly connector: CloudflareConnectorLayout;
  readonly stopConnector: () => Promise<void>;
  readonly sleep: (milliseconds: number) => Promise<void>;
  /** Record in the receipt that this route is gone; called under the machine lock. */
  readonly recordRouteRemoved: () => Promise<void>;
}

/**
 * The assistant's route leaves the shared route set under the machine lock;
 * peers write it there too, so it is observed whenever the machine has a
 * tunnel. Its own DNS record follows. Once no other assistant needs the
 * tunnel, this removal retires the connector and tunnel, still under the
 * machine lock, and forgets the tunnel so the next managed assistant creates
 * its own. Its route is recorded gone under that same lock, retiring or not,
 * so of two removals deciding back to back exactly one retires.
 */
async function removeManagedIngress(removal: ManagedIngressRemoval): Promise<void> {
  const { paths, reservation, claim, api } = removal;
  const tunnelId = await withLockedCloudflareRegistry(paths, async ({ registry }) => {
    const metadata = requireCloudflareMetadata(registry);
    const found = await observeTunnel(api, metadata);
    if (!found) return metadata.tunnel_id;
    const observed = await api.getTunnelConfiguration(claim.account_id, found.id);
    const universe = renderManagedCloudflareConfiguration(registry, removal.originHost);
    const current = assertManagedCloudflareConfigurationOwnership(observed.config, universe);
    if (current.ingress.some((rule) => 'hostname' in rule && rule.hostname === claim.hostname)) {
      const leaving = new Set([...(await activeRemovalInstanceIds(paths, registry)), reservation.instance_id]);
      const desired = renderManagedCloudflareConfiguration(registry, removal.originHost, leaving);
      await replaceManagedCloudflareConfiguration(api, claim.account_id, found.id, desired, current);
    }
    return found.id;
  });

  if (removal.ownTransport) {
    const observe = async (): Promise<CloudflareDnsRecord | undefined> => {
      const records = await api.listDnsRecords(claim.zone_id, claim.hostname);
      if (records.length === 0) return undefined;
      if (tunnelId === null) {
        throw new GwsEaError(
          'foreign_cloudflare_dns',
          `Cloudflare DNS name ${claim.hostname} has records, but this machine has no tunnel they could point to`,
        );
      }
      return chooseOwnedDnsRecord(records, desiredDnsRecord(reservation, tunnelId), claim.dns_record_id);
    };
    const record = await observe();
    if (record) {
      await deleteAndConfirm(
        () => api.deleteDnsRecord(claim.zone_id, record.id),
        async () => (await observe()) === undefined,
        `the DNS record for ${claim.hostname}`,
      );
    }
  }

  await withLockedCloudflareRegistry(paths, async (locked) => {
    if ((await tunnelUsers(paths, locked.registry, reservation.instance_id)) === 0) {
      const metadata = requireCloudflareMetadata(locked.registry);
      const retiring = await observeTunnel(api, metadata);
      await removal.stopConnector();
      if (retiring) {
        await waitForTunnelConnectionsToClear(api, metadata.account_id, retiring.id, removal.sleep);
        await deleteAndConfirm(
          () => api.deleteTunnel(metadata.account_id, retiring.id),
          async () => (await observeTunnel(api, metadata)) === undefined,
          `tunnel ${metadata.tunnel_name}`,
        );
      }
      await rm(removal.connector.rootDirectory, { recursive: true, force: true });
      await locked.forgetTunnel();
    }
    // A failed retirement records nothing, so a resumed removal retires again.
    await removal.recordRouteRemoved();
  });
}

/** How often, and how many times, removal checks that what it stopped (a launchd job, a stray host) is gone. */
const STOPPED_POLL_MS = 500;
const STOPPED_CHECKS = 10;
/** `launchctl print` exits with this, and only this, when the job is not loaded. */
const LAUNCHD_JOB_NOT_FOUND = 113;

/** What removing the host uses besides the runtime the instance recorded. */
interface NanoclawTeardown {
  readonly platform: InstanceServicePlatform;
  readonly run: SanitizedCommandOutcomeRunner;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly serviceHelpers: NanoclawServiceHelpers;
  /** The agent image IDs an unfinished update or rollback recorded. */
  readonly recordedImages: readonly string[];
}

/**
 * Stop the instance's host through NanoClaw's own service helpers, then clean
 * up whatever that stop leaves: the service definition (a launchd job whose
 * plist is gone, which NanoClaw cannot find, is booted out by its label, and
 * a systemd unit is disabled too, so neither login nor boot starts it again),
 * a host running outside the service, the agent containers (drained, then
 * removed with any that had already stopped), and the agent images.
 */
async function uninstallNanoclaw(
  reservation: InstanceReservation,
  runtime: LocalRuntime,
  teardown: NanoclawTeardown,
): Promise<void> {
  const { platform, run, sleep } = teardown;
  const installId = reservation.instance_id.replaceAll('-', '');
  const recorded = { home_directory: runtime.homeDirectory, docker_endpoint: runtime.dockerEndpoint };
  const incomplete = (message: string): GwsEaError => new GwsEaError('nanoclaw_removal_incomplete', message);
  const commandFor = (
    program: string,
    args: readonly string[],
    env: Readonly<Record<string, string>>,
  ): SanitizedCommand => ({ command: program, args, cwd: CONTROL_PLANE_ROOT, env, timeoutMs: 120_000 });
  /** Runs a command and returns its raw outcome, for callers that read the exit code themselves. */
  const execute = (program: string, args: readonly string[], env: Readonly<Record<string, string>>) => {
    const command = commandFor(program, args, env);
    return run(command).then((outcome) => ({ command, outcome }));
  };
  const runChecked = checkedRunner(run);
  const checked = async (program: string, args: readonly string[], env: Readonly<Record<string, string>>) =>
    (await runChecked(commandFor(program, args, env))).stdout;
  /** Whether `present` still holds once what removal stopped has had a moment to go. */
  const stillPresent = (present: () => Promise<boolean>): Promise<boolean> =>
    pollUntil(present, (still) => !still, {
      intervalMs: STOPPED_POLL_MS,
      limitMs: (STOPPED_CHECKS - 1) * STOPPED_POLL_MS,
      sleep,
    });
  const coordinates = (runningAsRoot: boolean) =>
    createInstanceServiceCoordinates({ installId, homeDirectory: runtime.homeDirectory, platform, runningAsRoot });
  /** Boot a launchd job out by its label, then wait until launchd no longer has it loaded. */
  const bootOutByLabel = async (service: InstanceServiceCoordinates): Promise<void> => {
    const uid = process.getuid?.();
    if (uid === undefined) throw new GwsEaError('unsupported_platform', 'launchd requires a user ID');
    const env = serviceManagerEnvironment(recorded, service.manager, {});
    const job = `gui/${uid}/${service.serviceIdentity}`;
    const loaded = async (): Promise<boolean> => {
      const printed = await execute('launchctl', ['print', job], env);
      if (printed.outcome.exitCode === LAUNCHD_JOB_NOT_FOUND) return false;
      if (printed.outcome.exitCode !== 0) throw commandExitError(printed.command, printed.outcome);
      return true;
    };
    if (!(await loaded())) return;
    // A bootout that failed leaves the job loaded, which the wait reports. One that worked returns before
    // launchd has finished removing the job, so the job gets a moment to go.
    await execute('launchctl', ['bootout', job], env);
    if (await stillPresent(loaded)) throw incomplete('The NanoClaw launchd service is still loaded');
  };

  const units: InstanceServiceCoordinates[] = [];
  if (platform === 'linux') {
    for (const runningAsRoot of [false, true]) {
      const service = coordinates(runningAsRoot);
      const defined = await access(service.serviceDefinitionPath).then(
        () => true,
        (error: unknown) => {
          if (isErrno(error, 'ENOENT')) return false;
          throw error;
        },
      );
      if (defined) units.push(service);
    }
  }
  // A system unit is root's to remove, so removal without root refuses before anything stops.
  const systemUnit = units.find((service) => service.manager === 'systemd-system');
  if (systemUnit && process.getuid?.() !== 0) {
    throw new GwsEaError(
      'root_required',
      `Re-run removal with root privileges to remove ${systemUnit.serviceDefinitionPath}`,
    );
  }

  const control = createServiceControl(
    teardown.serviceHelpers,
    {
      instanceId: reservation.instance_id,
      checkoutRoot: reservation.checkout_realpath,
      installId,
      homeDirectory: runtime.homeDirectory,
      dockerEndpoint: runtime.dockerEndpoint,
    },
    { platform: platform === 'macos' ? 'darwin' : 'linux', sleep },
  );
  const detected = control.detect();
  // A host running outside its service is not NanoClaw's to stop; the stray-host kill below takes it.
  if (detected.mode !== 'unmanaged') await control.stop();

  if (platform === 'macos') {
    const service = coordinates(false);
    // NanoClaw finds a launchd job by its plist, so a job still loaded after its plist was deleted is booted
    // out by its label, before the stray-host kill below: launchd would only start that host again.
    if (detected.mode !== 'launchd') await bootOutByLabel(service);
    await rm(service.serviceDefinitionPath, { force: true });
  }
  for (const service of units) {
    const env = serviceManagerEnvironment(recorded, service.manager, {});
    const scope = service.manager === 'systemd-user' ? ['--user'] : [];
    const unit = `${service.serviceIdentity}.service`;
    await execute('systemctl', [...scope, 'disable', '--now', unit], env);
    if ((await execute('systemctl', [...scope, 'is-active', unit], env)).outcome.exitCode === 0) {
      throw incomplete(`The NanoClaw service ${unit} is still active`);
    }
    await rm(service.serviceDefinitionPath, { force: true });
    await checked('systemctl', [...scope, 'daemon-reload'], env);
  }

  const tools = buildToolEnvironment(process.env, { DOCKER_HOST: runtime.dockerEndpoint });
  const host = path.join(reservation.checkout_realpath, 'dist', 'index.js').replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const killed = await execute('pkill', ['-f', host], tools);
  if (killed.outcome.exitCode !== 0 && killed.outcome.exitCode !== 1)
    throw commandExitError(killed.command, killed.outcome);
  // pkill only sends SIGTERM, so a stopping host gets a moment to exit before it counts as still running.
  const hostRunning = await stillPresent(async () => {
    const remaining = await execute('pgrep', ['-f', host], tools);
    if (remaining.outcome.exitCode === 1) return false;
    if (remaining.outcome.exitCode !== 0) throw commandExitError(remaining.command, remaining.outcome);
    return true;
  });
  if (hostRunning) throw incomplete('The NanoClaw host process is still running');

  // Nothing is left that could start another agent, so the drain is race-free.
  await control.drain();
  const { installLabel } = coordinates(false);
  const containers = async (): Promise<string[]> =>
    (await checked('docker', ['ps', '-aq', '--filter', `label=${installLabel}`], tools))
      .split(/\r?\n/u)
      .map((id) => id.trim())
      .filter(Boolean);
  const ids = await containers();
  if (ids.length > 0) {
    await checked('docker', ['rm', '--force', ...ids], tools);
    if ((await containers()).length > 0) throw incomplete('NanoClaw containers remain after removal');
  }

  // Every tag in the assistant's own image repository goes: `:latest`, the `:next` an update staged (and the
  // `:building` tag of an image its build had not yet labeled), the `:previous` it kept, and each agent group's own
  // image. Removing a tag deletes its image only with the last tag naming it, so an agent image another assistant
  // shares by content stays with that assistant's tags. Nothing outside the repository is named, so the OneCLI,
  // gateway, and connector images assistants share stay too (KTD19).
  const repository = getInstallScopedNames(installId).containerImageBase;
  const tagged = async (): Promise<string[]> =>
    (await checked('docker', ['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}', repository], tools))
      .split(/\r?\n/u)
      .map((reference) => reference.trim())
      .filter((reference) => reference.startsWith(`${repository}:`) && reference !== `${repository}:<none>`);
  const references = await tagged();
  if (references.length > 0) {
    await checked('docker', ['image', 'rm', ...references], tools);
    const remaining = await tagged();
    if (remaining.length > 0) throw incomplete(`NanoClaw images remain after removal: ${remaining.join(', ')}`);
  }
  // An image a retag or rebuild displaced has no tag left to find it by, so it goes by the ID its record holds,
  // unless another repository still tags it: assistants share agent images by content.
  for (const imageId of teardown.recordedImages) {
    const inspected = await execute('docker', ['image', 'inspect', '--format', '{{json .RepoTags}}', imageId], tools);
    if (inspected.outcome.exitCode !== 0) {
      if (/No such image/iu.test(inspected.outcome.stderr)) continue;
      throw commandExitError(inspected.command, inspected.outcome);
    }
    if (imageTags(inspected.outcome.stdout).length > 0) continue;
    await checked('docker', ['image', 'rm', imageId], tools);
  }
}

/** OneCLI's Compose project, through the recorded Docker endpoint; the CLI path is the one the instance stored. */
async function removeOnecli(
  paths: ControlPlanePaths,
  reservation: InstanceReservation,
  runtime: LocalRuntime,
  run: SanitizedCommandOutcomeRunner,
): Promise<void> {
  await removeOnecliRuntime(
    createOnecliRuntimeLayout({
      instanceId: reservation.instance_id,
      instanceRoot: paths.instanceRoot(reservation.instance_id),
      project: reservation.exclusive_resource_claims.onecli_project,
      appPort: reservation.allocated_ports.onecli_app,
      gatewayPort: reservation.allocated_ports.onecli_gateway,
      cliExecutable: runtime.onecliCliPath ?? (await resolveExecutable('onecli')),
      dockerEndpoint: runtime.dockerEndpoint,
    }),
    { dockerCommandRunner: checkedRunner(run) },
  );
}

export async function describeRemoval(paths: ControlPlanePaths, instanceId: string): Promise<RemovalPreview> {
  assertInstanceId(instanceId);
  const registry = await readRegistry(paths);
  const reservation =
    registry.instances[instanceId] ??
    (await readReceipt(paths, instanceId))?.reservation ??
    (await getInstanceReservation(paths, instanceId));
  const claims = reservation.exclusive_resource_claims;
  const ingress = claims.ingress;
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
            sharedIngress: (await tunnelUsers(paths, registry, instanceId)) > 0 ? 'retained-for-peers' : 'retired',
          },
  };
}

/** Remove one assistant from whatever state it is in, holding only its own lock. */
export async function removeAssistant(
  paths: ControlPlanePaths,
  instanceId: string,
  dependencies: RemovalDependencies,
): Promise<RemovalOutcome> {
  assertInstanceId(instanceId);
  await preparePrivateDirectory(path.dirname(paths.instanceLock(instanceId)));
  const release = await processLock(paths.instanceLock(instanceId));
  if (!release) throw new GwsEaError('instance_busy', 'Instance operation is already in progress');
  try {
    return await removeLocked(paths, instanceId, dependencies);
  } finally {
    release();
  }
}

async function removeLocked(
  paths: ControlPlanePaths,
  instanceId: string,
  dependencies: RemovalDependencies,
): Promise<RemovalOutcome> {
  const { interaction } = dependencies;
  const reporter = dependencies.reporter ?? {};
  const abandon = dependencies.abandon ?? new Set();
  const platform = dependencies.platform ?? instanceServicePlatform();
  const runGcloud = dependencies.runGcloud ?? runSanitizedCommandOutcome;
  const registry = await readRegistry(paths);
  const existing = await readReceipt(paths, instanceId);
  const reservation =
    registry.instances[instanceId] ?? existing?.reservation ?? (await getInstanceReservation(paths, instanceId));
  const claims = reservation.exclusive_resource_claims;
  const claim = managedClaim(reservation);
  let receipt: RemovalReceipt = existing ?? {
    schema_version: RECEIPT_SCHEMA_VERSION,
    instance_id: instanceId,
    reservation,
    started_at: new Date().toISOString(),
    completed: {},
    abandoned: {},
  };

  // Everything below reads; nothing changes until the receipt is written.
  const operation = await readUnfinishedOperation(paths, instanceId);
  await assertOwnCheckouts(paths, reservation, operation);
  const provisioning = await readProvisioningRecord(paths, instanceId);
  const recorded = await readRecordedRuntime(paths, reservation);
  // Released last, so a released reservation left only local files and the receipt behind.
  const released = registry.instances[instanceId] === undefined;
  const started = (step: ProvisionStepId): boolean => !released && provisioning.started(step);
  const shared = registry.shared_infrastructure_metadata.cloudflare;
  // A recorded tunnel, or one whose creation started, may exist under the machine's tunnel name.
  const tunnelRecorded = shared !== null && (shared.tunnel_id !== null || shared.tunnel_creation_started_at !== null);
  const owned: Readonly<Record<RemovalResource, boolean>> = {
    // Peers write every managed route into the shared set, so it is observed whenever the machine has a tunnel.
    'managed-ingress': claim !== undefined && (started('establish_transport') || (!released && tunnelRecorded)),
    nanoclaw: started('start_nanoclaw'),
    'gcp-project': started('provision_gcp'),
    onecli: started('start_onecli'),
    'instance-files': true,
  };
  const pending = new Set(
    REMOVAL_RESOURCES.filter(
      (resource) =>
        owned[resource] && !receipt.completed[resource] && !(isAbandonable(resource) && receipt.abandoned[resource]),
    ),
  );

  const docker = once(() =>
    (
      dependencies.resolveDocker ??
      ((endpoint) => (endpoint ? probeRecordedDockerEndpoint(endpoint) : resolveDockerEndpoint()))
    )(recorded.dockerEndpoint),
  );
  const localRuntime = async (): Promise<LocalRuntime> => ({
    homeDirectory: recorded.homeDirectory ?? os.homedir(),
    dockerEndpoint: await docker(),
    onecliCliPath: recorded.onecliCliPath,
  });
  const run = dependencies.runCommand ?? runSanitizedCommandOutcome;
  const serviceHelpers = dependencies.serviceHelpers;
  const uninstall =
    dependencies.uninstallNanoclaw ??
    (serviceHelpers
      ? (removed: InstanceReservation, runtime: LocalRuntime) =>
          uninstallNanoclaw(removed, runtime, {
            platform,
            run,
            sleep: dependencies.sleep ?? delay,
            serviceHelpers,
            recordedImages: recordedAgentImages(operation),
          })
      : undefined);
  /** Only the launcher supplies NanoClaw's service helpers, so removal refuses before any change without them. */
  const requireUninstall = (): NonNullable<typeof uninstall> => {
    if (uninstall) return uninstall;
    throw new GwsEaError('interactive_setup_unavailable', 'Run this command through the gws-ea launcher');
  };
  const account = claims.gcp_account;
  const withSignIn = <T>(body: () => Promise<T>): Promise<T> =>
    withGoogleSignIn(
      body,
      () => interaction.signInToGoogleCloud(account),
      (refusal) => activeStep()?.write(`${refusal.message}; signing in, then trying again\n`),
    );
  const cloudflare = once(async () => {
    if (!claim) throw new GwsEaError('invalid_removal', 'Only managed ingress needs Cloudflare authorization');
    return cloudflareAuthority(
      claim,
      interaction,
      dependencies.createCloudflareApi ?? ((accountToken) => createCloudflareApi({ accountToken })),
      {
        leaveDnsBehind: abandon.has('cloudflare-dns') || receipt.abandoned['cloudflare-dns'] !== undefined,
        keptTokenFile: paths.keptCloudflareTokenFile(instanceId),
      },
    );
  });

  await runStep(reporter, { id: 'prerequisites' }, async () => {
    if (pending.has('nanoclaw')) requireUninstall();
    const retiresConnector = pending.has('managed-ingress') && (await tunnelUsers(paths, registry, instanceId)) === 0;
    if (pending.has('nanoclaw') || pending.has('onecli') || retiresConnector) await docker();
    if (pending.has('gcp-project')) {
      await withSignIn(async () => {
        await assertGcloudInstalled(runGcloud);
        await assertGcloudSignedIn(account, runGcloud);
      });
    }
    if (pending.has('managed-ingress')) await cloudflare();
  });

  const file = paths.removalFile(instanceId);
  const record = async (change: (current: RemovalReceipt) => RemovalReceipt): Promise<void> => {
    receipt = change(receipt);
    await writePrivate(file, receipt);
  };
  await preparePrivateDirectory(paths.removalRoot);
  await record((current) => current);

  const removals: Readonly<Record<RemovalResource, () => Promise<Evidence | undefined>>> = {
    'managed-ingress': async () => {
      if (!claim) return undefined;
      const connector = createCloudflareConnectorLayout({ cloudflareRoot: paths.cloudflareRoot, platform });
      const { api, dnsLeftBehind } = await cloudflare();
      if (dnsLeftBehind !== undefined) {
        await record((current) => ({
          ...current,
          abandoned: {
            ...current.abandoned,
            'cloudflare-dns': { at: new Date().toISOString(), evidence: dnsLeftBehind },
          },
        }));
      }
      await forgettingRefusedToken(paths.keptCloudflareTokenFile(instanceId), () =>
        removeManagedIngress({
          paths,
          reservation,
          claim,
          api,
          // A record left behind in a zone the token cannot see is not looked for.
          ownTransport: provisioning.started('establish_transport') && dnsLeftBehind === undefined,
          originHost: connectorNetworking(connector.platform).originHost,
          connector,
          stopConnector: async () =>
            dependencies.stopCloudflareConnector
              ? dependencies.stopCloudflareConnector(connector, await docker())
              : stopCloudflareConnector(connector, { dockerEndpoint: await docker() }),
          sleep: dependencies.sleep ?? delay,
          recordRouteRemoved: () =>
            record((current) => ({
              ...current,
              completed: { ...current.completed, 'managed-ingress': new Date().toISOString() },
            })),
        }),
      );
      return undefined;
    },
    nanoclaw: async () => {
      await requireUninstall()(reservation, await localRuntime());
      return undefined;
    },
    'gcp-project': async () => {
      const coordinates: GcpProjectCoordinates = {
        instanceId,
        projectId: claims.gcp_project_id,
        account,
        cwd: CONTROL_PLANE_ROOT,
      };
      const gcloud = { runCommand: runGcloud };
      const unrestored = (evidence: string | undefined) =>
        evidence
          ? record((current) => ({ ...current, key_policy_unrestored: { at: new Date().toISOString(), evidence } }))
          : undefined;
      const seen = await withSignIn(() =>
        deleteOwnedGcpProject(coordinates, { restoreKeyPolicy: provisioning.keyPolicyLifted }, gcloud),
      );
      if (seen.status === 'deleted') {
        await unrestored(seen.keyPolicyUnrestored);
        return undefined;
      }
      activeStep()?.write(`${seen.reason}\n${seen.evidence}\n`);
      if (!abandon.has('gcp-project')) throw new RemovalPause('gcp-project', seen.reason, seen.evidence);
      if (provisioning.keyPolicyLifted) {
        await unrestored(await withSignIn(() => restoreKeyCreationPolicyForRemoval(coordinates, gcloud)));
      }
      return { at: new Date().toISOString(), evidence: seen.evidence };
    },
    onecli: async () => {
      const runtime = await localRuntime();
      await (dependencies.removeOnecli
        ? dependencies.removeOnecli(reservation, runtime)
        : removeOnecli(paths, reservation, runtime, run));
      return undefined;
    },
    'instance-files': async () => {
      await rm(paths.instanceRoot(instanceId), { recursive: true, force: true });
      return undefined;
    },
  };

  for (const resource of REMOVAL_RESOURCES) {
    if (!pending.has(resource)) continue;
    const abandoned = await runStep(reporter, RESOURCE_STEPS[resource], removals[resource]);
    await record((current) =>
      abandoned && isAbandonable(resource)
        ? { ...current, abandoned: { ...current.abandoned, [resource]: abandoned } }
        : { ...current, completed: { ...current.completed, [resource]: new Date().toISOString() } },
    );
  }
  await releaseInstanceReservation(paths, reservation);
  await removePrivateFile(file);

  return {
    removed: REMOVAL_RESOURCES.filter((resource) => receipt.completed[resource] !== undefined),
    abandoned: ABANDONABLE_RESOURCES.flatMap((resource) => {
      const entry = receipt.abandoned[resource];
      return entry ? [{ resource, evidence: entry.evidence }] : [];
    }),
    ...(receipt.key_policy_unrestored ? { keyPolicyUnrestored: receipt.key_policy_unrestored.evidence } : {}),
  };
}
