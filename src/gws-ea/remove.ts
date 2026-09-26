/**
 * Removal from any partial state. A resource is observed only when
 * the provisioning step that owns it ever started: no journal means
 * nothing started, and a journal this launcher cannot read means every
 * resource is observed. An absent resource is done; an owned one is deleted
 * and observed again; a foreign one is refused by name; one that cannot be
 * observed pauses with evidence until the operator abandons it. Everything a
 * resource needs — Docker, Google sign-in, the Cloudflare token — is checked
 * before the first change, and removal locks only its own instance, so one
 * stuck removal never blocks another assistant.
 */
import { access, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { writePrivate } from '../community-portal/private-file.js';
import { processLock } from '../community-portal/process-lock.js';
import { isErrno } from '../community-portal/errors.js';
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
import { CONTROL_PLANE_ROOT, preparePrivateDirectory, type ControlPlanePaths } from './paths.js';
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
import {
  createInstanceServiceCoordinates,
  instanceServicePlatform,
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
import { usableKeptAccountToken } from './cloudflare-token.js';
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
}

/** Boundary seams; each defaults to the real one. */
export interface RemovalDependencies extends RemovalOptions {
  readonly platform?: InstanceServicePlatform;
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
 * The home directory, Docker endpoint, and OneCLI CLI the instance recorded:
 * `runtime.json` once the host started, else the bootstrap manifest create
 * wrote. Only these fields are read, so files an earlier launcher wrote still
 * remove cleanly.
 */
async function readRecordedRuntime(
  paths: ControlPlanePaths,
  reservation: InstanceReservation,
): Promise<{ readonly homeDirectory?: string; readonly dockerEndpoint?: string; readonly onecliCliPath?: string }> {
  const records = await Promise.all([
    readRecord(path.join(reservation.checkout_realpath, 'data', 'gws-ea', 'runtime.json')),
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
  for (let attempt = 1; attempt <= CONNECTION_ATTEMPTS; attempt += 1) {
    if ((await api.listTunnelConnections(accountId, tunnelId)).length === 0) return;
    if (attempt < CONNECTION_ATTEMPTS) await sleep(CONNECTION_DELAY_MS);
  }
  throw new GwsEaError('cloudflare_connections_active', 'Cloudflare tunnel still has active connector sessions');
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

/** Stop the instance service through its manager, then its host process, containers, and image. */
async function uninstallNanoclaw(
  reservation: InstanceReservation,
  runtime: LocalRuntime,
  platform: InstanceServicePlatform,
  run: SanitizedCommandOutcomeRunner,
): Promise<void> {
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
  const coordinates = (runningAsRoot: boolean) =>
    createInstanceServiceCoordinates({ installId, homeDirectory: runtime.homeDirectory, platform, runningAsRoot });

  if (platform === 'macos') {
    const service = coordinates(false);
    const uid = process.getuid?.();
    if (uid === undefined) throw new GwsEaError('unsupported_platform', 'launchd requires a user ID');
    const env = serviceManagerEnvironment(recorded, service.manager, {});
    const domain = `gui/${uid}/${service.serviceIdentity}`;
    // A job that is not loaded refuses bootout; `print` then decides.
    await execute('launchctl', ['bootout', domain], env);
    if ((await execute('launchctl', ['print', domain], env)).outcome.exitCode === 0) {
      throw incomplete('The NanoClaw launchd service is still loaded');
    }
    await rm(service.serviceDefinitionPath, { force: true });
  } else {
    for (const runningAsRoot of [false, true]) {
      const service = coordinates(runningAsRoot);
      const defined = await access(service.serviceDefinitionPath).then(
        () => true,
        (error: unknown) => {
          if (isErrno(error, 'ENOENT')) return false;
          throw error;
        },
      );
      if (!defined) continue;
      if (runningAsRoot && process.getuid?.() !== 0) {
        throw new GwsEaError(
          'root_required',
          `Re-run removal with root privileges to remove ${service.serviceDefinitionPath}`,
        );
      }
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
  }

  const tools = buildToolEnvironment(process.env, { DOCKER_HOST: runtime.dockerEndpoint });
  const host = path.join(reservation.checkout_realpath, 'dist', 'index.js').replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const killed = await execute('pkill', ['-f', host], tools);
  if (killed.outcome.exitCode !== 0 && killed.outcome.exitCode !== 1)
    throw commandExitError(killed.command, killed.outcome);
  const remaining = await execute('pgrep', ['-f', host], tools);
  if (remaining.outcome.exitCode === 0) throw incomplete('The NanoClaw host process is still running');
  if (remaining.outcome.exitCode !== 1) throw commandExitError(remaining.command, remaining.outcome);

  const { installLabel, imageTag } = coordinates(false);
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
  const image = async (): Promise<boolean> =>
    (await checked('docker', ['image', 'ls', '--quiet', '--no-trunc', imageTag], tools)).trim() !== '';
  if (await image()) {
    await checked('docker', ['image', 'rm', imageTag], tools);
    if (await image()) throw incomplete('The NanoClaw image remains after removal');
  }
}

/** OneCLI's Compose project, through the recorded Docker endpoint; the CLI path is the one the instance stored. */
async function removeOnecli(
  paths: ControlPlanePaths,
  reservation: InstanceReservation,
  runtime: LocalRuntime,
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
  await assertCheckoutConsistent(paths, reservation);
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
      await removeManagedIngress({
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
      });
      return undefined;
    },
    nanoclaw: async () => {
      const runtime = await localRuntime();
      await (dependencies.uninstallNanoclaw
        ? dependencies.uninstallNanoclaw(reservation, runtime)
        : uninstallNanoclaw(reservation, runtime, platform, dependencies.runCommand ?? runSanitizedCommandOutcome));
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
        : removeOnecli(paths, reservation, runtime));
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
