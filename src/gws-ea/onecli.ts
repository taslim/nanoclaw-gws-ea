import { access } from 'node:fs/promises';
import path from 'node:path';

import { isErrno } from '../community-portal/errors.js';
import { createOnecliAdmin, fetchOnecliApiKey, onecliInjection } from './onecli-admin.js';
import { isRegularFile, preparePrivateDirectory } from './paths.js';
import { PRESENT, type Observation } from './phases.js';
import { findPortHolder, portInUseError, type PortHolder } from './ports.js';
import {
  buildToolEnvironment,
  runSanitizedCommand,
  type SanitizedCommand,
  type SanitizedCommandRunner,
} from './process.js';
import {
  ensureRandomOwnerOnlyFile,
  readOwnerOnlyFile,
  writeOwnerOnlyFileExclusive,
  writePrivateTextFile,
} from './secrets.js';
import {
  ONECLI_INSTANCE_LABEL,
  ONECLI_RESOURCE_ROLE_LABEL,
  ONECLI_WAIT_TIMEOUT_SECONDS,
  onecliGatewayImage,
  parseOnecliComposeImages,
  renderOnecliCompose,
  type OnecliPins,
  type OnecliRuntimeLayout,
  type OnecliServiceImages,
} from './onecli-compose.js';
import {
  ONECLI_WRAPPER_BASE_ARG,
  ONECLI_WRAPPER_HASH_ARG,
  ONECLI_WRAPPER_LABEL,
  resolveWrapperGatewayImage,
  wrapperImageHash,
  wrapperImageSourceDir,
} from './onecli-gateway-image.js';
import { GwsEaError } from './types.js';
import { hasControlCharacters, isRecord, optionalString, parseJson, requireRecord, stringField } from './validation.js';
import type { ProviderCredential, ProviderCredentialMetadata } from '../provider-credential.js';

const INVALID_OUTPUT = 'invalid_onecli_output';
const INVALID_RUNTIME = 'invalid_onecli_runtime';

const EXPECTED_SERVICES = ['postgres', 'app', 'gateway'] as const;
/** The hash of the service configuration Compose created a container from, which `up` compares to recreate it. */
const CONFIG_HASH_LABEL = 'com.docker.compose.config-hash';

/** Pulling runs on its own clock: a slow registry never eats into the health wait. */
const ONECLI_PULL_TIMEOUT_MS = 20 * 60_000;
/** Building the wrapper gateway image (base already local; only the small firewall layer is added). */
const ONECLI_BUILD_TIMEOUT_MS = 10 * 60_000;
/** `up --wait` itself waits `ONECLI_WAIT_TIMEOUT_SECONDS`; the margin covers creating the containers. */
const UP_TIMEOUT_MS = (ONECLI_WAIT_TIMEOUT_SECONDS + 120) * 1_000;
const INSPECT_TIMEOUT_MS = 30_000;

export type OnecliCommand = SanitizedCommand;
export type OnecliCommandRunner = SanitizedCommandRunner;

interface ObservedOnecliContainer {
  readonly id: string;
  readonly service: string;
  readonly instanceId: string | undefined;
  readonly project: string | undefined;
  readonly configHash: string | undefined;
  readonly running: boolean;
  /** Docker's health status: starting, healthy, or unhealthy; undefined without a healthcheck. */
  readonly health: string | undefined;
  readonly publishedPorts: Readonly<Record<string, readonly { hostIp: string; hostPort: string }[]>>;
}

interface ObservedOnecliNetwork {
  readonly name: string;
  readonly instanceId: string | undefined;
  readonly role: string | undefined;
  readonly internal: boolean;
}

interface ObservedOnecliVolume {
  readonly name: string;
  readonly instanceId: string | undefined;
  readonly role: string | undefined;
}

/** What the service containers show; unlike an `Observation`, an absence always says why. */
type ServicesObservation =
  | { readonly status: 'present' }
  | { readonly status: 'absent'; readonly reason: string }
  | { readonly status: 'unknown'; readonly reason: string; readonly evidence: string };

export interface ImportedCredential {
  readonly id: string;
  readonly created: boolean;
}

export interface OnecliRuntimeDependencies {
  /** Runs Docker and the port-holder lookup. */
  readonly dockerCommandRunner?: OnecliCommandRunner;
  /** Reaches the runtime's health endpoints and its admin API. */
  readonly fetch?: typeof globalThis.fetch;
  readonly ambientEnv?: NodeJS.ProcessEnv;
  readonly findPortHolder?: (port: number) => Promise<PortHolder | undefined>;
}

declare const runtimeReceiptBrand: unique symbol;
/** Proof that this process checked the runtime's health and images, carrying its local API key. */
export interface OnecliRuntimeReceipt {
  readonly [runtimeReceiptBrand]: true;
}

interface VerifiedOnecliRuntime {
  readonly layout: OnecliRuntimeLayout;
  readonly apiKey: string;
}

export interface OnecliApiKeyFiles {
  readonly runtime: string;
  readonly admin: string;
}

const issuedReceipts = new WeakMap<object, VerifiedOnecliRuntime>();

function verifiedRuntime(receipt: OnecliRuntimeReceipt): VerifiedOnecliRuntime {
  const verified = issuedReceipts.get(receipt);
  if (verified === undefined) {
    throw new GwsEaError('onecli_unverified', 'The OneCLI runtime must pass its health check first');
  }
  return verified;
}

/** What every Docker command against one instance shares: its layout, the runner, and Compose's environment. */
interface OnecliDocker {
  readonly layout: OnecliRuntimeLayout;
  readonly runner: OnecliCommandRunner;
  readonly environment: Readonly<Record<string, string>>;
}

function dockerContext(
  layout: OnecliRuntimeLayout,
  dependencies: Pick<OnecliRuntimeDependencies, 'dockerCommandRunner' | 'ambientEnv'>,
): OnecliDocker {
  return {
    layout,
    runner: dependencies.dockerCommandRunner ?? runSanitizedCommand,
    environment: buildComposeEnvironment(layout, dependencies.ambientEnv),
  };
}

function buildComposeInvocation(layout: OnecliRuntimeLayout, args: readonly string[]): OnecliCommand {
  return {
    command: 'docker',
    args: [
      'compose',
      '--project-name',
      layout.project,
      '--file',
      layout.composeFile,
      '--project-directory',
      layout.rootDirectory,
      '--env-file',
      layout.envFile,
      ...args,
    ],
    cwd: layout.rootDirectory,
  };
}

/** Docker's environment: the tool allowlist, the operator's HOME, and the instance's recorded endpoint. */
function buildComposeEnvironment(
  layout: Pick<OnecliRuntimeLayout, 'dockerEndpoint'>,
  ambient: NodeJS.ProcessEnv = process.env,
): Readonly<Record<string, string>> {
  const environment = buildToolEnvironment(ambient, { DOCKER_HOST: layout.dockerEndpoint });
  if (ambient.HOME !== undefined) environment.HOME = ambient.HOME;
  return environment;
}

/**
 * Prepare the instance's private material. A new instance's Compose file is
 * rendered from this tool's tree, which is the release it deploys; an existing
 * one is the release's own record of what the instance runs, so it is never
 * rendered again here (KTD6).
 */
async function prepareOnecliRuntime(layout: OnecliRuntimeLayout, pins: OnecliPins): Promise<void> {
  await preparePrivateDirectory(layout.rootDirectory);
  await preparePrivateDirectory(layout.secretsDirectory);

  await Promise.all([
    ensureRandomOwnerOnlyFile(layout.postgresPasswordFile, 'base64url'),
    ensureRandomOwnerOnlyFile(layout.encryptionKeyFile, 'base64'),
    ensureRandomOwnerOnlyFile(layout.gatewayInternalSecretFile, 'base64url'),
  ]);
  if (!(await isRegularFile(layout.composeFile))) {
    const { image } = await resolveWrapperGatewayImage(pins);
    await writePrivateTextFile(layout.composeFile, renderOnecliCompose(layout, pins, image));
  }
  if (!(await isRegularFile(layout.envFile))) {
    await writePrivateTextFile(layout.envFile, '# Intentionally empty: runtime coordinates are passed explicitly.\n');
  }
}

/** What the instance runs, as its own Compose file names it, with the content hash its gateway tag carries. */
interface InstanceOnecliImages extends OnecliServiceImages {
  readonly gatewayHash: string;
}

/**
 * The images the instance's own Compose file runs, never recomputed from any
 * tree (KTD6). The app must run the OneCLI its release pinned, and the gateway
 * must be a wrapper tag, whose hash its image's provenance label carries. A
 * missing file raises the underlying ENOENT for the caller to interpret.
 */
async function instanceOnecliImages(layout: OnecliRuntimeLayout, pins: OnecliPins): Promise<InstanceOnecliImages> {
  const images = parseOnecliComposeImages(await readOwnerOnlyFile(layout.composeFile));
  const pinned = onecliGatewayImage(pins);
  if (images.app !== pinned) {
    throw new GwsEaError(
      INVALID_RUNTIME,
      `The OneCLI Compose file runs ${images.app}, not this assistant's pinned ${pinned}`,
    );
  }
  const gatewayHash = wrapperImageHash(images.gateway);
  if (gatewayHash === undefined) {
    throw new GwsEaError('unsafe_onecli_image', `OneCLI gateway image ${images.gateway} is not a gws-ea wrapper image`);
  }
  return { ...images, gatewayHash };
}

/**
 * Build the instance's wrapper gateway image when it is not already present.
 * The tag encodes the build-context content hash, so an unchanged wrapper
 * reuses the shared image (KTD5). Only this tool's tree can be built here, so
 * a missing image another release built is refused rather than replaced by
 * this tool's firewall. The base is already local (pulled for the app
 * service), so only the small firewall layer is built.
 */
async function ensureWrapperGatewayImage(docker: OnecliDocker, pins: OnecliPins, gatewayImage: string): Promise<void> {
  const { runner, environment, layout } = docker;
  // `image ls -q` exits 0 whether or not the tag exists (empty stdout when absent),
  // so a present image is a clean skip without catching a lookup failure.
  const present = await runner({
    command: 'docker',
    args: ['image', 'ls', '--quiet', gatewayImage],
    cwd: layout.rootDirectory,
    env: environment,
    timeoutMs: INSPECT_TIMEOUT_MS,
  });
  if (present.stdout.trim().length > 0) return;
  const wrapper = await resolveWrapperGatewayImage(pins);
  if (wrapper.image !== gatewayImage) {
    throw new GwsEaError(
      'onecli_gateway_image_missing',
      `This assistant's OneCLI gateway image ${gatewayImage} is missing, and this tool builds ${wrapper.image}. Resume it with the gws-ea release it runs to rebuild its gateway.`,
    );
  }
  await runner({
    command: 'docker',
    args: [
      'build',
      '--build-arg',
      `${ONECLI_WRAPPER_BASE_ARG}=${onecliGatewayImage(pins)}`,
      '--build-arg',
      `${ONECLI_WRAPPER_HASH_ARG}=${wrapper.hash}`,
      '--label',
      `${ONECLI_WRAPPER_LABEL}=${wrapper.hash}`,
      '--tag',
      gatewayImage,
      wrapperImageSourceDir(),
    ],
    cwd: layout.rootDirectory,
    env: environment,
    timeoutMs: ONECLI_BUILD_TIMEOUT_MS,
    stream: true,
  });
}

/** The gateway image an instance runs, and the one the release an update stages runs. */
export interface GatewayImageChange {
  readonly current: string;
  readonly release: string;
}

/**
 * Make the release's wrapper gateway image ready before an update's stop
 * (KTD8), from this tool's tree, which is the release it deploys (R6). Only
 * when its tag differs from the one the instance's Compose file names is
 * Docker asked for it, and built when absent; content-addressed tags never
 * collide, so a build never replaces what another assistant runs. The
 * Compose file and the running runtime are left for the cutover.
 */
export async function prepareReleaseGatewayImage(
  layout: OnecliRuntimeLayout,
  pins: OnecliPins,
  dependencies: Pick<OnecliRuntimeDependencies, 'dockerCommandRunner' | 'ambientEnv'> = {},
): Promise<GatewayImageChange> {
  const { gateway: current } = await instanceOnecliImages(layout, pins);
  const { image: release } = await resolveWrapperGatewayImage(pins);
  if (release !== current) await ensureWrapperGatewayImage(dockerContext(layout, dependencies), pins, release);
  return { current, release };
}

/**
 * Move an instance to the gateway the release an update deploys builds, at
 * its cutover (KTD8): that image, which staging built, is made present
 * first, so a failed build leaves the Compose file naming the gateway still
 * running; only then is the file rendered for it and only the gateway
 * recreated, and probed when it was (KTD15). `compose up` keeps every volume,
 * and Postgres and the app run on as they are, since an update never changes
 * their versions (R9). Rendered from this tool's tree, which is the release
 * (R6). Run again after an interruption, it converges.
 */
export async function applyReleaseGateway(
  layout: OnecliRuntimeLayout,
  pins: OnecliPins,
  dependencies: Pick<OnecliRuntimeDependencies, 'dockerCommandRunner' | 'ambientEnv'> = {},
): Promise<void> {
  const docker = dockerContext(layout, dependencies);
  const { image } = await resolveWrapperGatewayImage(pins);
  const { gateway } = await instanceOnecliImages(layout, pins);
  await ensureWrapperGatewayImage(docker, pins, image);
  if (gateway !== image) await writePrivateTextFile(layout.composeFile, renderOnecliCompose(layout, pins, image));
  await upGateway(docker, pins);
}

/**
 * Put back the Compose file a kept release ran with and recreate the gateway
 * it names, at a rollback (KTD8): the gateway image that release built is
 * still present, since assistant commands never delete one; only when it is
 * missing and this tool's tree builds the same content is it built again,
 * and otherwise it is refused before the Compose file changes. Only the
 * gateway is recreated, and probed when it was (KTD15), and every volume is
 * kept. Run again after an interruption, it converges.
 */
export async function restoreReleaseGateway(
  layout: OnecliRuntimeLayout,
  pins: OnecliPins,
  compose: string,
  dependencies: Pick<OnecliRuntimeDependencies, 'dockerCommandRunner' | 'ambientEnv'> = {},
): Promise<void> {
  const docker = dockerContext(layout, dependencies);
  const { gateway } = parseOnecliComposeImages(compose);
  if (wrapperImageHash(gateway) === undefined) {
    throw new GwsEaError('unsafe_onecli_image', `OneCLI gateway image ${gateway} is not a gws-ea wrapper image`);
  }
  await ensureWrapperGatewayImage(docker, pins, gateway);
  if ((await readOwnerOnlyFile(layout.composeFile)) !== compose)
    await writePrivateTextFile(layout.composeFile, compose);
  await upGateway(docker, pins);
}

/**
 * Bring the gateway to its Compose file, which recreates it only when its
 * configuration changed, and then prove the egress boundary again before
 * returning (KTD15): a recreated gateway is a new container whose firewall no
 * probe has seen. Compose gives a container it recreates a new ID.
 */
async function upGateway(docker: OnecliDocker, pins: OnecliPins): Promise<void> {
  const before = new Set(await projectContainerIds(docker));
  await docker.runner({
    ...buildComposeInvocation(docker.layout, [
      'up',
      '--detach',
      '--wait',
      '--wait-timeout',
      String(ONECLI_WAIT_TIMEOUT_SECONDS),
      '--pull',
      'never',
      '--no-deps',
      'gateway',
    ]),
    env: docker.environment,
    timeoutMs: UP_TIMEOUT_MS,
    stream: true,
  });
  if ((await projectContainerIds(docker)).some((id) => !before.has(id)))
    await verifyAgentNetworkIsolation(docker, pins);
}

/**
 * The networks and volumes, which no service's config hash covers: exactly
 * the instance's own, each labelled with its owner and role, and only the
 * agent-egress network internal, so an agent on it reaches nothing but the
 * gateway.
 */
async function assertOnecliNamedResources(docker: OnecliDocker): Promise<void> {
  const { layout, runner, environment } = docker;
  const inspect = (kind: 'network' | 'volume', names: readonly string[]) =>
    runner({
      command: 'docker',
      args: [kind, 'inspect', ...names],
      cwd: path.dirname(layout.rootDirectory),
      env: environment,
      timeoutMs: INSPECT_TIMEOUT_MS,
    });
  const [networkResult, volumeResult] = await Promise.all([
    inspect('network', [layout.backendNetwork, layout.agentEgressNetwork]),
    inspect('volume', [layout.postgresVolume, layout.appVolume]),
  ]);
  const networks = parseDockerNetworks(networkResult.stdout);
  const volumes = parseDockerVolumes(volumeResult.stdout);

  assertExactNamedResources(
    networks.map((network) => network.name),
    [layout.backendNetwork, layout.agentEgressNetwork],
    'OneCLI networks',
  );
  for (const network of networks) {
    const expectedRole = network.name === layout.backendNetwork ? 'backend' : 'agent-egress';
    const expectedInternal = network.name === layout.agentEgressNetwork;
    if (
      network.instanceId !== layout.instanceId ||
      network.role !== expectedRole ||
      network.internal !== expectedInternal
    ) {
      throw new GwsEaError('unsafe_onecli_topology', `OneCLI network ${network.name} is invalid`);
    }
  }

  assertExactNamedResources(
    volumes.map((volume) => volume.name),
    [layout.postgresVolume, layout.appVolume],
    'OneCLI volumes',
  );
  for (const volume of volumes) {
    const expectedRole = volume.name === layout.postgresVolume ? 'postgres-data' : 'app-data';
    if (volume.instanceId !== layout.instanceId || volume.role !== expectedRole) {
      throw new GwsEaError('unsafe_onecli_owner', `OneCLI volume ${volume.name} ownership labels are invalid`);
    }
  }
}

/**
 * The runtime as liveness sees it. Present when all three services run
 * healthy from the configuration the instance's own Compose file gives now,
 * its networks and volumes are its own, and the gateway's image carries the
 * provenance its tag names; a service Docker still reports as starting is
 * unknown, so the engine waits; a missing, stopped, or unhealthy one, one
 * created from another configuration, or a missing Compose file, is absent,
 * so it is repaired at once. Another instance's resource stops the run;
 * Docker failing to answer is unknown.
 */
export async function observeOnecliRuntime(
  layout: OnecliRuntimeLayout,
  pins: OnecliPins,
  dependencies: OnecliRuntimeDependencies = {},
): Promise<Observation> {
  const docker = dockerContext(layout, dependencies);
  try {
    const containers = await inspectProjectContainers(docker);
    const seen = serviceObservation(layout, containers);
    if (seen.status !== 'present') return seen;
    let expected: InstanceOnecliImages;
    try {
      expected = await instanceOnecliImages(layout, pins);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return { status: 'absent', reason: 'its Compose file is missing' };
      throw error;
    }
    const drift = await configDrift(docker, containers);
    if (drift.status !== 'present') return drift;
    await Promise.all([assertOnecliNamedResources(docker), assertWrapperGatewayProvenance(docker, expected)]);
    return PRESENT;
  } catch (error) {
    if (!(error instanceof GwsEaError) || !['command_failed', 'command_timeout'].includes(error.code)) throw error;
    return { status: 'unknown', reason: 'Docker did not report the OneCLI runtime', evidence: error.message };
  }
}

/**
 * Whether each service's container still runs the configuration the
 * instance's own Compose file gives now, by Compose's own config hash: the
 * one `up` labelled the container with, against `config --hash` through the
 * instance's invocation, so it is computed for the same resolved project
 * (KTD15). A service created from another configuration is absent, and the
 * repair's `up` recreates it, keeping its volumes. The hash covers each
 * service's image reference, ports, networks, mounts and labels; it does not
 * cover the networks and volumes themselves, nor what an image tag holds.
 */
async function configDrift(
  docker: OnecliDocker,
  containers: readonly ObservedOnecliContainer[],
): Promise<ServicesObservation> {
  const { stdout } = await docker.runner({
    ...buildComposeInvocation(docker.layout, ['config', '--hash', '*']),
    env: docker.environment,
    timeoutMs: INSPECT_TIMEOUT_MS,
  });
  const hashes = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/u)) {
    const [service, hash] = line.trim().split(/\s+/u);
    if (service && hash) hashes.set(service, hash);
  }
  const drifted = EXPECTED_SERVICES.filter((service) => {
    const created = containers.find((container) => container.service === service)?.configHash;
    return created === undefined || created !== hashes.get(service);
  });
  if (drifted.length === 0) return { status: 'present' };
  return {
    status: 'absent',
    reason: `the ${drifted.join(' and ')} ${drifted.length === 1 ? 'container runs' : 'containers run'} another configuration than its Compose file gives`,
  };
}

function serviceObservation(
  layout: OnecliRuntimeLayout,
  containers: readonly ObservedOnecliContainer[],
): ServicesObservation {
  if (containers.length === 0) return { status: 'absent', reason: 'it has not been created' };
  assertOwnedContainers(layout, containers);
  const starting: string[] = [];
  for (const service of EXPECTED_SERVICES) {
    const matching = containers.filter((container) => container.service === service);
    const container = matching[0];
    if (!container) return { status: 'absent', reason: `the ${service} container is missing` };
    if (matching.length > 1) return { status: 'absent', reason: `the ${service} service has extra containers` };
    if (!container.running) return { status: 'absent', reason: `the ${service} container is stopped` };
    if (container.health === 'unhealthy') return { status: 'absent', reason: `the ${service} container is unhealthy` };
    if (container.health === 'starting') starting.push(service);
  }
  if (containers.length !== EXPECTED_SERVICES.length) {
    return { status: 'absent', reason: 'its project has containers outside its three services' };
  }
  if (starting.length === 0) return { status: 'present' };
  return {
    status: 'unknown',
    reason: `OneCLI ${starting.join(' and ')} ${starting.length === 1 ? 'is' : 'are'} starting`,
    evidence: `health starting: ${starting.join(', ')}`,
  };
}

/**
 * The health check. The runtime must run healthy from the configuration the
 * instance's own Compose file gives now, whose app is its pinned OneCLI
 * (OneCLI reports no version of its own), on its own networks and volumes,
 * and answer on its health endpoints. The receipt carries the local API key,
 * read once, for importing the provider credential and persisting the key
 * files.
 */
export async function verifyOnecliRuntime(
  layout: OnecliRuntimeLayout,
  pins: OnecliPins,
  dependencies: OnecliRuntimeDependencies = {},
): Promise<OnecliRuntimeReceipt> {
  const fetchImplementation = dependencies.fetch ?? globalThis.fetch;
  const docker = dockerContext(layout, dependencies);
  const expected = await instanceOnecliImages(layout, pins);
  const containers = await inspectProjectContainers(docker);
  const services = serviceObservation(layout, containers);
  const seen = services.status === 'present' ? await configDrift(docker, containers) : services;
  if (seen.status !== 'present') {
    throw new GwsEaError('unhealthy_onecli', `The OneCLI runtime is not serving: ${seen.reason}`);
  }
  await Promise.all([
    assertOnecliNamedResources(docker),
    assertWrapperGatewayProvenance(docker, expected),
    assertHealthyEndpoint(fetchImplementation, `${layout.appUrl}/api/health`, 'OneCLI app'),
    assertHealthyEndpoint(fetchImplementation, `${layout.appUrl}/v1/health`, 'OneCLI versioned API'),
    assertHealthyEndpoint(fetchImplementation, `${layout.gatewayUrl}/healthz`, 'OneCLI gateway'),
  ]);
  // Prove the egress boundary from an agent's vantage on every admission path —
  // create and resume alike — so a healthy runtime is never accepted without it.
  await verifyAgentNetworkIsolation(docker, pins);

  const apiKey = await fetchOnecliApiKey(layout.appUrl, { fetch: fetchImplementation });
  const receipt = Object.freeze({}) as OnecliRuntimeReceipt;
  issuedReceipts.set(receipt, Object.freeze({ layout: Object.freeze({ ...layout }), apiKey }));
  return receipt;
}

/**
 * Store the provider credential in the verified runtime's vault, its value
 * only in the request body, unless a secret with its metadata is there
 * already.
 */
export async function importProviderCredential(
  receipt: OnecliRuntimeReceipt,
  input: ProviderCredential,
  dependencies: Pick<OnecliRuntimeDependencies, 'fetch'> = {},
): Promise<ImportedCredential> {
  const { layout, apiKey } = verifiedRuntime(receipt);
  assertCredentialMetadata(input);
  const admin = createOnecliAdmin(layout.appUrl, apiKey, dependencies.fetch ? { fetch: dependencies.fetch } : {});
  const existing = findCredentialSecret(await admin.listSecrets(), input, {
    ambiguous: 'More than one OneCLI secret has the requested name',
    conflict: 'An existing OneCLI secret has incompatible metadata',
  });
  if (existing) return { id: stringField(existing, 'id', 'OneCLI secret', INVALID_OUTPUT), created: false };
  return { id: await admin.createSecret(input), created: true };
}

export async function persistOnecliApiKeyFiles(receipt: OnecliRuntimeReceipt, files: OnecliApiKeyFiles): Promise<void> {
  const verified = verifiedRuntime(receipt);
  if (files.runtime === files.admin) {
    throw new GwsEaError('unsafe_secret', 'OneCLI runtime and administrative credentials require separate files');
  }
  await Promise.all([
    writeOrVerifyOwnerOnlySecret(files.runtime, verified.apiKey),
    writeOrVerifyOwnerOnlySecret(files.admin, verified.apiKey),
  ]);
}

async function writeOrVerifyOwnerOnlySecret(file: string, value: string): Promise<void> {
  try {
    if ((await readOwnerOnlyFile(file)).trim() !== value) {
      throw new GwsEaError('runtime_conflict', 'An existing OneCLI credential file does not match this runtime');
    }
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error;
    await writeOwnerOnlyFileExclusive(file, value);
  }
}

/**
 * Start or repair the runtime its Compose file describes: pull missing images
 * under their own timeout, force-recreate only a service Docker reports
 * unhealthy, then start everything and wait for health within the budget the
 * healthchecks allow. That `up` also recreates any service whose config hash
 * changed, keeping its volumes, and the health check that follows probes
 * isolation before a receipt is issued. A failed start names a foreign
 * process on an allocated port.
 */
export async function reconcileOnecliRuntime(
  layout: OnecliRuntimeLayout,
  pins: OnecliPins,
  dependencies: OnecliRuntimeDependencies = {},
): Promise<OnecliRuntimeReceipt> {
  const docker = dockerContext(layout, dependencies);
  const { runner, environment } = docker;
  await prepareOnecliRuntime(layout, pins);
  const { gateway: gatewayImage } = await instanceOnecliImages(layout, pins);
  const kept = await cleanupOnecliDockerOrphans(docker);
  // Pull only the registry-sourced services; the gateway runs the locally built
  // wrapper tag, which a registry pull would fail to resolve. The `app` image is
  // the same OneCLI base the wrapper builds `FROM`, so pulling here (under the
  // pull timeout) makes that base local before the build below.
  await runner({
    ...buildComposeInvocation(layout, ['pull', '--policy', 'missing', 'postgres', 'app']),
    env: environment,
    timeoutMs: ONECLI_PULL_TIMEOUT_MS,
    stream: true,
  });
  await ensureWrapperGatewayImage(docker, pins, gatewayImage);
  const up = (args: readonly string[]): Promise<unknown> =>
    runner({
      ...buildComposeInvocation(layout, [
        'up',
        '--detach',
        '--wait',
        '--wait-timeout',
        String(ONECLI_WAIT_TIMEOUT_SECONDS),
        '--pull',
        'never',
        ...args,
      ]),
      env: environment,
      timeoutMs: UP_TIMEOUT_MS,
      stream: true,
    });
  const unhealthy = kept.filter((container) => container.running && container.health === 'unhealthy');
  try {
    if (unhealthy.length > 0) {
      await up(['--no-deps', '--force-recreate', ...unhealthy.map((container) => container.service)]);
    }
    await up(['--remove-orphans']);
  } catch (error) {
    throw (await foreignPortError(docker, dependencies, error)) ?? error;
  }
  return verifyOnecliRuntime(layout, pins, dependencies);
}

/**
 * After a failed start, the allocated port a foreign process holds. A port
 * one of this instance's running containers publishes is its own: ownership
 * comes from the compose labels, never from trying to bind it.
 */
async function foreignPortError(
  docker: OnecliDocker,
  dependencies: OnecliRuntimeDependencies,
  cause: unknown,
): Promise<GwsEaError | undefined> {
  if (!(cause instanceof GwsEaError) || cause.code !== 'command_failed') return undefined;
  const { layout, runner } = docker;
  const owned = new Set(
    (await inspectProjectContainers(docker).catch(() => []))
      .filter((container) => container.running)
      .flatMap((container) => Object.values(container.publishedPorts).flat())
      .map((binding) => binding.hostPort),
  );
  const lookup = dependencies.findPortHolder ?? ((port: number) => findPortHolder(port, runner));
  const ports = [
    { label: 'OneCLI app', port: layout.appPort },
    { label: 'OneCLI gateway', port: layout.gatewayPort },
  ].filter(({ port }) => !owned.has(String(port)));
  for (const { label, port } of ports) {
    const holder = await lookup(port);
    if (holder) return portInUseError(label, port, holder, cause);
  }
  return undefined;
}

export async function removeOnecliRuntime(
  layout: OnecliRuntimeLayout,
  dependencies: Pick<OnecliRuntimeDependencies, 'dockerCommandRunner' | 'ambientEnv'> = {},
): Promise<void> {
  const docker = dockerContext(layout, dependencies);
  const { runner, environment } = docker;
  const containers = await inspectProjectContainers(docker);
  for (const container of containers) {
    if (container.instanceId !== layout.instanceId || container.project !== layout.project) {
      throw new GwsEaError('unsafe_onecli_owner', 'OneCLI removal found a Docker resource owned by another instance');
    }
  }
  const namedResources = await assertOwnedOnecliNamedResources(docker);
  if (containers.length === 0 && namedResources.length === 0) {
    try {
      await access(layout.composeFile);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return;
      throw error;
    }
  }
  await runner({
    ...buildComposeInvocation(layout, ['down', '--volumes', '--remove-orphans']),
    env: environment,
    timeoutMs: 120_000,
    stream: true,
  });
  if ((await inspectProjectContainers(docker)).length > 0) {
    throw new GwsEaError('onecli_removal_incomplete', 'OneCLI containers remain after removal');
  }
  if ((await presentOnecliNamedResources(docker)).length > 0) {
    throw new GwsEaError('onecli_removal_incomplete', 'OneCLI networks or volumes remain after removal');
  }
}

interface NamedDockerResource {
  readonly kind: 'network' | 'volume';
  readonly name: string;
  readonly role: string;
}

function onecliNamedResources(layout: OnecliRuntimeLayout): readonly NamedDockerResource[] {
  return [
    { kind: 'network', name: layout.backendNetwork, role: 'backend' },
    { kind: 'network', name: layout.agentEgressNetwork, role: 'agent-egress' },
    { kind: 'volume', name: layout.postgresVolume, role: 'postgres-data' },
    { kind: 'volume', name: layout.appVolume, role: 'app-data' },
  ];
}

async function listNamedDockerResource(
  docker: OnecliDocker,
  resource: NamedDockerResource,
  labels: readonly string[] = [],
): Promise<boolean> {
  const { layout, runner, environment } = docker;
  const result = await runner({
    command: 'docker',
    args: [
      resource.kind,
      'ls',
      '--filter',
      `name=^${resource.name}$`,
      ...labels.flatMap((label) => ['--filter', `label=${label}`]),
      '--format',
      '{{.Name}}',
    ],
    cwd: path.dirname(layout.rootDirectory),
    env: environment,
    timeoutMs: 30_000,
  });
  return result.stdout
    .split(/\r?\n/u)
    .map((name) => name.trim())
    .includes(resource.name);
}

async function presentOnecliNamedResources(docker: OnecliDocker): Promise<readonly NamedDockerResource[]> {
  const resources = onecliNamedResources(docker.layout);
  const present = await Promise.all(
    resources.map(async (resource) => ({
      resource,
      present: await listNamedDockerResource(docker, resource),
    })),
  );
  return present.filter((entry) => entry.present).map((entry) => entry.resource);
}

async function assertOwnedOnecliNamedResources(docker: OnecliDocker): Promise<readonly NamedDockerResource[]> {
  const resources = await presentOnecliNamedResources(docker);
  const ownership = await Promise.all(
    resources.map(async (resource) => ({
      resource,
      owned: await listNamedDockerResource(docker, resource, [
        `${ONECLI_INSTANCE_LABEL}=${docker.layout.instanceId}`,
        `${ONECLI_RESOURCE_ROLE_LABEL}=${resource.role}`,
      ]),
    })),
  );
  for (const { resource, owned } of ownership) {
    if (!owned) {
      throw new GwsEaError(
        'unsafe_onecli_owner',
        `OneCLI ${resource.kind} ${resource.name} is not owned by this instance`,
      );
    }
  }
  return resources;
}

/** Containers in this instance's Compose project must carry its instance label; anything else stops the run. */
function assertOwnedContainers(layout: OnecliRuntimeLayout, containers: readonly ObservedOnecliContainer[]): void {
  for (const container of containers) {
    if (container.instanceId !== layout.instanceId || container.project !== layout.project) {
      throw new GwsEaError(
        'unsafe_onecli_owner',
        'A Docker resource in the OneCLI project has invalid ownership labels',
      );
    }
  }
}

/**
 * Remove owned containers outside the three services, or duplicates of one,
 * and return the containers that remain.
 */
async function cleanupOnecliDockerOrphans(docker: OnecliDocker): Promise<readonly ObservedOnecliContainer[]> {
  const { layout, runner, environment } = docker;
  const containers = await inspectProjectContainers(docker);
  assertOwnedContainers(layout, containers);
  const kept: ObservedOnecliContainer[] = [];
  for (const container of containers) {
    const service = EXPECTED_SERVICES.find((candidate) => candidate === container.service);
    if (service && containers.filter((other) => other.service === service).length === 1) {
      kept.push(container);
      continue;
    }
    await runner({
      command: 'docker',
      args: ['container', 'rm', '--force', container.id],
      cwd: path.dirname(layout.rootDirectory),
      env: environment,
      timeoutMs: INSPECT_TIMEOUT_MS,
    });
  }
  return kept;
}

/** The IDs of every container in the instance's Compose project. */
async function projectContainerIds(docker: OnecliDocker): Promise<readonly string[]> {
  const { layout, runner, environment } = docker;
  const list = await runner({
    command: 'docker',
    args: [
      'container',
      'ls',
      '--all',
      '--filter',
      `label=com.docker.compose.project=${layout.project}`,
      '--format',
      '{{.ID}}',
    ],
    cwd: path.dirname(layout.rootDirectory),
    env: environment,
    timeoutMs: INSPECT_TIMEOUT_MS,
  });
  return list.stdout
    .split(/\r?\n/u)
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

async function inspectProjectContainers(docker: OnecliDocker): Promise<readonly ObservedOnecliContainer[]> {
  const { layout, runner, environment } = docker;
  const ids = await projectContainerIds(docker);
  if (ids.length === 0) return [];
  const inspection = await runner({
    command: 'docker',
    args: ['container', 'inspect', ...ids],
    cwd: path.dirname(layout.rootDirectory),
    env: environment,
    timeoutMs: INSPECT_TIMEOUT_MS,
  });
  return parseDockerContainers(inspection.stdout);
}

/**
 * Prove the egress boundary from an agent's vantage: a throwaway container on the
 * agent-egress network, reaching only the gateway proxy, must be unable to reach
 * this instance's own OneCLI app admin API (a real private listener) or link-local
 * metadata — while public egress still works. Each target is a forward-proxy GET
 * through the gateway: the gateway attempts the upstream connection to forward the
 * request, so a target counts as reachable when it returns any HTTP response, and
 * as blocked when the gateway cannot connect and resets/errors. Classifying on
 * "any response" (not a status range) means a leaked target that answers with a
 * 5xx is still caught, and a transient upstream 5xx on the public check is not a
 * false failure. A bare `fetch` would bypass the proxy and falsely pass, so raw
 * `http` is used; a CONNECT tunnel cannot be used because this gateway answers
 * CONNECT with 200 to MITM TLS before it touches the upstream. Any violation fails
 * closed (R11); provisioning refuses the runtime and spawns no agent. Cross-
 * instance isolation on the DB port (which needs a real peer listener and cannot
 * be probed for a non-HTTP port through an HTTP proxy), R4, R5, and R8 are proven
 * in the live re-proof, where a peer, a real credential, and a human approver exist.
 */
async function verifyAgentNetworkIsolation(docker: OnecliDocker, pins: OnecliPins): Promise<void> {
  const { layout, runner, environment } = docker;
  const script = [
    'const http = require("node:http");',
    'const dns = require("node:dns").promises;',
    // Forward-proxy GET through the gateway. Reachable = the gateway returned any
    // HTTP response (it connected to the upstream); blocked = it could not connect
    // and reset/errored. "Any response" catches a leaked target that answers 5xx.
    'function reached(url){return new Promise((resolve)=>{let done=false;const finish=(v)=>{if(!done){done=true;resolve(v);}};',
    'const u=new URL(url);const req=http.request({host:"host.docker.internal",port:10255,method:"GET",path:url,headers:{Host:u.host},timeout:7000},',
    '(res)=>{res.resume();finish(true);});',
    'req.on("timeout",()=>{req.destroy();finish(false);});req.on("error",()=>finish(false));req.end();});}',
    'function healthz(){return new Promise((resolve)=>{const req=http.get("http://host.docker.internal:10255/healthz",{timeout:7000},',
    '(res)=>{res.resume();resolve(res.statusCode===200);});req.on("timeout",()=>{req.destroy();resolve(false);});req.on("error",()=>resolve(false));});}',
    '(async()=>{',
    'if(!(await healthz()))throw new Error("gateway healthz unreachable");',
    // R6: public egress must work.
    'if(!(await reached("http://example.com/")))throw new Error("public egress blocked");',
    // R2: the instance\'s own OneCLI app admin API (a real private listener) must be blocked.
    'if(await reached("http://app:10254/v1/secrets"))throw new Error("own app admin API reachable through gateway");',
    // R3: link-local / cloud metadata must be blocked (a real listener on a cloud host).
    'if(await reached("http://169.254.169.254/"))throw new Error("link-local/metadata reachable through gateway");',
    // The agent container itself cannot resolve backend hosts (defense in depth).
    'for(const host of ["app","postgres"]){try{await dns.lookup(host);throw new Error(host+" resolved by agent");}catch(e){if(String(e).includes("resolved by agent"))throw e;}}',
    '})().catch((error)=>{console.error(error.message);process.exit(1);});',
  ].join('');
  await runner({
    command: 'docker',
    args: [
      'run',
      '--rm',
      '--network',
      layout.agentEgressNetwork,
      '--entrypoint',
      'node',
      onecliGatewayImage(pins),
      '--input-type=commonjs',
      '--eval',
      script,
    ],
    cwd: layout.rootDirectory,
    env: environment,
    timeoutMs: INSPECT_TIMEOUT_MS,
  });
}

/** Confirm the gateway image was built from the firewall content its tag names (KTD6). */
async function assertWrapperGatewayProvenance(docker: OnecliDocker, expected: InstanceOnecliImages): Promise<void> {
  const { runner, environment, layout } = docker;
  const { stdout } = await runner({
    command: 'docker',
    args: ['image', 'inspect', expected.gateway, '--format', `{{index .Config.Labels "${ONECLI_WRAPPER_LABEL}"}}`],
    cwd: layout.rootDirectory,
    env: environment,
    timeoutMs: INSPECT_TIMEOUT_MS,
  });
  if (stdout.trim() !== expected.gatewayHash) {
    throw new GwsEaError(
      'unsafe_onecli_image',
      `OneCLI gateway image ${expected.gateway} provenance label does not match its build content`,
    );
  }
}

function parseDockerContainers(source: string): readonly ObservedOnecliContainer[] {
  const values = parseDockerArray(source, 'Docker container inspection');
  return values.map((value) => {
    const config = requireRecord(value.Config, 'Docker container inspection', INVALID_RUNTIME);
    const labels = requireRecord(config.Labels, 'Docker container labels', INVALID_RUNTIME);
    const state = requireRecord(value.State, 'Docker container state', INVALID_RUNTIME);
    const networkSettings = requireRecord(value.NetworkSettings, 'Docker network settings', INVALID_RUNTIME);
    const health = isRecord(state.Health) ? state.Health : undefined;
    return {
      id: stringField(value, 'Id', 'Docker container', INVALID_OUTPUT),
      service: stringField(labels, 'com.docker.compose.service', 'Docker container labels', INVALID_OUTPUT),
      instanceId: optionalString(labels[ONECLI_INSTANCE_LABEL]),
      project: optionalString(labels['com.docker.compose.project']),
      configHash: optionalString(labels[CONFIG_HASH_LABEL]),
      running: state.Running === true,
      health: optionalString(health?.Status),
      publishedPorts: parseDockerPorts(networkSettings.Ports),
    };
  });
}

function parseDockerPorts(value: unknown): ObservedOnecliContainer['publishedPorts'] {
  if (!isRecord(value)) throw new GwsEaError(INVALID_RUNTIME, 'Docker published ports are invalid');
  const result: Record<string, { hostIp: string; hostPort: string }[]> = {};
  for (const [containerPort, bindings] of Object.entries(value)) {
    if (bindings === null) continue;
    if (!Array.isArray(bindings) || !bindings.every(isRecord)) {
      throw new GwsEaError(INVALID_RUNTIME, 'Docker published port binding is invalid');
    }
    result[containerPort] = bindings.map((binding) => ({
      hostIp: stringField(binding, 'HostIp', 'Docker port binding', INVALID_OUTPUT),
      hostPort: stringField(binding, 'HostPort', 'Docker port binding', INVALID_OUTPUT),
    }));
  }
  return result;
}

function parseDockerNetworks(source: string): readonly ObservedOnecliNetwork[] {
  return parseDockerArray(source, 'Docker network inspection').map((value) => {
    const labels = requireRecord(value.Labels, 'Docker network labels', INVALID_RUNTIME);
    return {
      name: stringField(value, 'Name', 'Docker network', INVALID_OUTPUT),
      instanceId: optionalString(labels[ONECLI_INSTANCE_LABEL]),
      role: optionalString(labels[ONECLI_RESOURCE_ROLE_LABEL]),
      internal: value.Internal === true,
    };
  });
}

function parseDockerVolumes(source: string): readonly ObservedOnecliVolume[] {
  return parseDockerArray(source, 'Docker volume inspection').map((value) => {
    const labels = requireRecord(value.Labels, 'Docker volume labels', INVALID_RUNTIME);
    return {
      name: stringField(value, 'Name', 'Docker volume', INVALID_OUTPUT),
      instanceId: optionalString(labels[ONECLI_INSTANCE_LABEL]),
      role: optionalString(labels[ONECLI_RESOURCE_ROLE_LABEL]),
    };
  });
}

function parseDockerArray(source: string, label: string): readonly Record<string, unknown>[] {
  const value = parseJson(source, label, INVALID_RUNTIME);
  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw new GwsEaError(INVALID_RUNTIME, `${label} is invalid`);
  }
  return value;
}

async function assertHealthyEndpoint(
  fetchImplementation: typeof globalThis.fetch,
  url: string,
  label: string,
): Promise<void> {
  let response: Response;
  try {
    response = await fetchImplementation(url, { signal: AbortSignal.timeout(5_000) });
  } catch {
    throw new GwsEaError('unhealthy_onecli', `${label} health endpoint is unreachable`);
  }
  if (!response.ok) throw new GwsEaError('unhealthy_onecli', `${label} health endpoint is not healthy`);
}

function assertExactNamedResources(actual: readonly string[], expected: readonly string[], label: string): void {
  if (!sameSet(actual, expected) || actual.length !== expected.length) {
    throw new GwsEaError(INVALID_RUNTIME, `${label} do not match the expected runtime`);
  }
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length && new Set(left).size === left.length && left.every((value) => right.includes(value))
  );
}

function assertCredentialMetadata(input: ProviderCredential): void {
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== 'string' || value.length === 0 || (key !== 'value' && hasControlCharacters(value))) {
      throw new GwsEaError('invalid_onecli_secret', `Provider credential ${key} is invalid`);
    }
  }
  if (!['anthropic', 'openai', 'generic'].includes(input.type)) {
    throw new GwsEaError('invalid_onecli_secret', 'Provider credential type is unsupported');
  }
  if (input.headerName !== undefined && input.paramName !== undefined) {
    throw new GwsEaError('invalid_onecli_secret', 'Provider credential cannot use header and query injection together');
  }
}

export function onecliSecretMatchesCredentialMetadata(
  existing: Record<string, unknown>,
  input: ProviderCredentialMetadata,
): boolean {
  return (
    optionalString(existing.name) === input.name &&
    optionalString(existing.type) === input.type &&
    optionalString(existing.hostPattern) === input.hostPattern &&
    nullableString(existing.pathPattern) === (input.pathPattern ?? null) &&
    JSON.stringify(existing.injectionConfig ?? null) === JSON.stringify(onecliInjection(input))
  );
}

/** What `findCredentialSecret`'s two refusals say. */
export interface CredentialSecretRefusals {
  readonly ambiguous: string;
  readonly conflict: string;
}

/**
 * The one OneCLI secret named like `credential`, or undefined when there is
 * none. More than one raises `ambiguous_onecli_secret`; one whose metadata
 * differs raises `onecli_secret_conflict`.
 */
export function findCredentialSecret(
  secrets: readonly Record<string, unknown>[],
  credential: ProviderCredentialMetadata,
  refusals: CredentialSecretRefusals,
): Record<string, unknown> | undefined {
  const matching = secrets.filter((candidate) => candidate.name === credential.name);
  if (matching.length > 1) throw new GwsEaError('ambiguous_onecli_secret', refusals.ambiguous);
  const existing = matching[0];
  if (existing && !onecliSecretMatchesCredentialMetadata(existing, credential)) {
    throw new GwsEaError('onecli_secret_conflict', refusals.conflict);
  }
  return existing;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
