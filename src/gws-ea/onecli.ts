import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

import { isErrno } from '../community-portal/errors.js';
import { preparePrivateDirectory } from './paths.js';
import { PRESENT, type Observation } from './phases.js';
import { findPortHolder, portInUseError, type PortHolder } from './ports.js';
import {
  buildToolEnvironment,
  runSanitizedCommand,
  type SanitizedCommand,
  type SanitizedCommandResult,
  type SanitizedCommandRunner,
} from './process.js';
import { registerSecret } from './redact.js';
import {
  ensureRandomOwnerOnlyFile,
  readOwnerOnlyFile,
  removePrivateFile,
  writeOwnerOnlyFileExclusive,
  writePrivateTextFile,
} from './secrets.js';
import {
  ONECLI_INSTANCE_LABEL,
  ONECLI_POSTGRES_IMAGE,
  ONECLI_RESOURCE_ROLE_LABEL,
  ONECLI_WAIT_TIMEOUT_SECONDS,
  onecliGatewayImage,
  renderOnecliCompose,
  type OnecliPins,
  type OnecliRuntimeLayout,
} from './onecli-compose.js';
import { ONECLI_SDK_VERSION } from './pins.js';
import { GwsEaError } from './types.js';
import {
  hasControlCharacters,
  isRecord,
  optionalString,
  parseJson,
  requireRecord,
  stringField,
  unwrapData,
} from './validation.js';
import type { ProviderCredential, ProviderCredentialMetadata } from '../provider-credential.js';

const INVALID_OUTPUT = 'invalid_onecli_output';
const INVALID_RUNTIME = 'invalid_onecli_runtime';

const EXPECTED_SERVICES = ['postgres', 'app', 'gateway'] as const;

/** Pulling runs on its own clock: a slow registry never eats into the health wait. */
const ONECLI_PULL_TIMEOUT_MS = 20 * 60_000;
/** `up --wait` itself waits `ONECLI_WAIT_TIMEOUT_SECONDS`; the margin covers creating the containers. */
const UP_TIMEOUT_MS = (ONECLI_WAIT_TIMEOUT_SECONDS + 120) * 1_000;
const INSPECT_TIMEOUT_MS = 30_000;

export type OnecliCommand = SanitizedCommand;
export type OnecliCommandResult = SanitizedCommandResult;
export type OnecliCommandRunner = SanitizedCommandRunner;

export interface ObservedOnecliContainer {
  readonly service: string;
  readonly image: string;
  readonly instanceId: string | undefined;
  readonly project: string | undefined;
  readonly running: boolean;
  /** Docker's health status: starting, healthy, or unhealthy; undefined without a healthcheck. */
  readonly health: string | undefined;
  readonly publishedPorts: Readonly<Record<string, readonly { hostIp: string; hostPort: string }[]>>;
  readonly networks: readonly string[];
  readonly volumes: readonly { name: string; destination: string }[];
}

export interface ObservedOnecliNetwork {
  readonly name: string;
  readonly instanceId: string | undefined;
  readonly role: string | undefined;
  readonly internal: boolean;
}

export interface ObservedOnecliVolume {
  readonly name: string;
  readonly instanceId: string | undefined;
  readonly role: string | undefined;
}

export interface ObservedOnecliRuntime {
  readonly containers: readonly ObservedOnecliContainer[];
  readonly networks: readonly ObservedOnecliNetwork[];
  readonly volumes: readonly ObservedOnecliVolume[];
}

export interface ImportedCredential {
  readonly id: string;
  readonly created: boolean;
}

export interface OnecliRuntimeDependencies {
  /** Runs the OneCLI CLI. */
  readonly runCommand?: OnecliCommandRunner;
  /** Runs Docker and the port-holder lookup. */
  readonly dockerCommandRunner?: OnecliCommandRunner;
  readonly fetch?: typeof globalThis.fetch;
  readonly ambientEnv?: NodeJS.ProcessEnv;
  readonly findPortHolder?: (port: number) => Promise<PortHolder | undefined>;
}

declare const runtimeReceiptBrand: unique symbol;
/** Proof that this process checked the runtime's health and versions, carrying its local API key. */
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
    throw new GwsEaError('onecli_unverified', 'The OneCLI runtime must pass its health and version check first');
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
  dependencies: Pick<OnecliRuntimeDependencies, 'dockerCommandRunner' | 'runCommand' | 'ambientEnv'>,
): OnecliDocker {
  return {
    layout,
    runner: dependencies.dockerCommandRunner ?? dependencies.runCommand ?? runSanitizedCommand,
    environment: buildComposeEnvironment(layout, dependencies.ambientEnv),
  };
}

export function buildComposeInvocation(layout: OnecliRuntimeLayout, args: readonly string[]): OnecliCommand {
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

export function buildOnecliCliEnvironment(
  layout: OnecliRuntimeLayout,
  ambient: NodeJS.ProcessEnv = process.env,
  apiKey?: string,
): Readonly<Record<string, string>> {
  const environment = buildToolEnvironment(ambient);
  environment.HOME = layout.cliHome;
  environment.ONECLI_API_HOST = layout.appUrl;
  if (apiKey !== undefined) environment.ONECLI_API_KEY = apiKey;
  return environment;
}

/** Docker's environment: the tool allowlist, the operator's HOME, and the instance's recorded endpoint. */
export function buildComposeEnvironment(
  layout: Pick<OnecliRuntimeLayout, 'dockerEndpoint'>,
  ambient: NodeJS.ProcessEnv = process.env,
): Readonly<Record<string, string>> {
  const environment = buildToolEnvironment(ambient, { DOCKER_HOST: layout.dockerEndpoint });
  if (ambient.HOME !== undefined) environment.HOME = ambient.HOME;
  return environment;
}

export async function prepareOnecliRuntime(layout: OnecliRuntimeLayout, pins: OnecliPins): Promise<void> {
  await preparePrivateDirectory(layout.rootDirectory);
  await Promise.all([preparePrivateDirectory(layout.cliHome), preparePrivateDirectory(layout.secretsDirectory)]);

  await Promise.all([
    ensureRandomOwnerOnlyFile(layout.postgresPasswordFile, 'base64url'),
    ensureRandomOwnerOnlyFile(layout.encryptionKeyFile, 'base64'),
    ensureRandomOwnerOnlyFile(layout.gatewayInternalSecretFile, 'base64url'),
  ]);
  await writePrivateTextFile(layout.composeFile, renderOnecliCompose(layout, pins));
  await writePrivateTextFile(layout.envFile, '# Intentionally empty: runtime coordinates are passed explicitly.\n');
}

export function validateObservedOnecliRuntime(
  layout: OnecliRuntimeLayout,
  pins: OnecliPins,
  observed: ObservedOnecliRuntime,
): void {
  for (const container of observed.containers) {
    const expectedNetworks = expectedNetworksForService(layout, container.service);
    if (!sameSet(container.networks, expectedNetworks)) {
      throw new GwsEaError('unsafe_onecli_topology', `OneCLI ${container.service} network topology is invalid`);
    }
  }

  assertExactNamedResources(
    observed.containers.map((container) => container.service),
    EXPECTED_SERVICES,
    'OneCLI services',
  );
  for (const service of EXPECTED_SERVICES) {
    const container = observed.containers.find((candidate) => candidate.service === service);
    if (!container) throw new GwsEaError(INVALID_RUNTIME, `OneCLI ${service} container is missing`);
    if (container.instanceId !== layout.instanceId || container.project !== layout.project) {
      throw new GwsEaError('unsafe_onecli_owner', `OneCLI ${service} ownership labels are invalid`);
    }
    if (!container.running || container.health !== 'healthy') {
      throw new GwsEaError('unhealthy_onecli', `OneCLI ${service} container is not healthy`);
    }
    const expectedImage = service === 'postgres' ? ONECLI_POSTGRES_IMAGE : onecliGatewayImage(pins);
    if (container.image !== expectedImage) {
      throw new GwsEaError(
        'unsafe_onecli_image',
        `OneCLI ${service} image is not this assistant's pinned ${expectedImage}`,
      );
    }
    validatePublishedPorts(layout, container);
    validateContainerVolumes(layout, container);
  }

  assertExactNamedResources(
    observed.networks.map((network) => network.name),
    [layout.backendNetwork, layout.agentEgressNetwork],
    'OneCLI networks',
  );
  for (const network of observed.networks) {
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
    observed.volumes.map((volume) => volume.name),
    [layout.postgresVolume, layout.appVolume],
    'OneCLI volumes',
  );
  for (const volume of observed.volumes) {
    const expectedRole = volume.name === layout.postgresVolume ? 'postgres-data' : 'app-data';
    if (volume.instanceId !== layout.instanceId || volume.role !== expectedRole) {
      throw new GwsEaError('unsafe_onecli_owner', `OneCLI volume ${volume.name} ownership labels are invalid`);
    }
  }
}

/**
 * The runtime as liveness sees it. Present when all three services run
 * healthy exactly as rendered; a service Docker still reports as starting is
 * unknown, so the engine waits; a missing, stopped, or unhealthy one is
 * absent, so it is repaired at once. Another instance's container in this
 * project stops the run; Docker failing to answer is unknown.
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
    validateObservedOnecliRuntime(layout, pins, await inspectOnecliRuntime(docker, containers));
    return PRESENT;
  } catch (error) {
    if (!(error instanceof GwsEaError) || !['command_failed', 'command_timeout'].includes(error.code)) throw error;
    return { status: 'unknown', reason: 'Docker did not report the OneCLI runtime', evidence: error.message };
  }
}

function serviceObservation(layout: OnecliRuntimeLayout, containers: readonly ObservedOnecliContainer[]): Observation {
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
  if (starting.length === 0) return PRESENT;
  return {
    status: 'unknown',
    reason: `OneCLI ${starting.join(' and ')} ${starting.length === 1 ? 'is' : 'are'} starting`,
    evidence: `health starting: ${starting.join(', ')}`,
  };
}

/**
 * The health and version check. The runtime must run healthy at this
 * instance's pinned images, answer on its health endpoints, and report this
 * instance's pinned CLI and gateway versions. The receipt carries the local
 * API key for importing the provider credential and persisting the key files.
 */
export async function verifyOnecliRuntime(
  layout: OnecliRuntimeLayout,
  pins: OnecliPins,
  dependencies: OnecliRuntimeDependencies = {},
): Promise<OnecliRuntimeReceipt> {
  const runCommand = dependencies.runCommand ?? runSanitizedCommand;
  const fetchImplementation = dependencies.fetch ?? globalThis.fetch;
  await removePrivateFile(layout.providerStagingFile);
  validateObservedOnecliRuntime(layout, pins, await inspectOnecliRuntime(dockerContext(layout, dependencies)));
  await Promise.all([
    assertHealthyEndpoint(fetchImplementation, `${layout.appUrl}/api/health`, 'OneCLI app'),
    assertHealthyEndpoint(fetchImplementation, `${layout.appUrl}/v1/health`, 'OneCLI versioned API'),
    assertHealthyEndpoint(fetchImplementation, `${layout.gatewayUrl}/healthz`, 'OneCLI gateway'),
  ]);

  const keylessEnvironment = buildOnecliCliEnvironment(layout, dependencies.ambientEnv);
  const apiKeyResponse = parseRecord(
    (await runOnecliCommand(layout, runCommand, keylessEnvironment, ['auth', 'api-key'])).stdout,
    'OneCLI API key',
  );
  const apiKey = stringField(apiKeyResponse, 'apiKey', 'OneCLI API key', INVALID_OUTPUT);
  if (!/^oc_[A-Za-z0-9_-]{20,}$/u.test(apiKey)) {
    throw new GwsEaError('incompatible_onecli', 'OneCLI returned an invalid local API key');
  }
  registerSecret(apiKey);
  const keyedEnvironment = buildOnecliCliEnvironment(layout, dependencies.ambientEnv, apiKey);
  const version = parseRecord(
    (await runOnecliCommand(layout, runCommand, keyedEnvironment, ['version'])).stdout,
    'OneCLI version',
  );
  const cli = optionalString(version.version) ?? '(unknown)';
  if (cli !== pins.cli) {
    throw new GwsEaError(
      'incompatible_onecli',
      `Installed OneCLI CLI ${cli} does not match this assistant's pinned ${pins.cli}; install OneCLI CLI ${pins.cli}, then retry`,
    );
  }
  // The gateway may not report its version; its image was checked against the pin above.
  const server = optionalString(version.server_version) ?? 'unknown';
  if (server !== pins.gateway && server !== 'unknown') {
    throw new GwsEaError(
      'incompatible_onecli',
      `The running OneCLI gateway ${server} does not match this assistant's pinned ${pins.gateway}`,
    );
  }
  const receipt = Object.freeze({}) as OnecliRuntimeReceipt;
  issuedReceipts.set(receipt, Object.freeze({ layout: Object.freeze({ ...layout }), apiKey }));
  return receipt;
}

export async function importProviderCredential(
  receipt: OnecliRuntimeReceipt,
  input: ProviderCredential,
  dependencies: Pick<OnecliRuntimeDependencies, 'runCommand' | 'ambientEnv'> = {},
): Promise<ImportedCredential> {
  const { layout, apiKey } = verifiedRuntime(receipt);
  assertCredentialMetadata(input);
  const runCommand = dependencies.runCommand ?? runSanitizedCommand;
  const environment = buildOnecliCliEnvironment(layout, dependencies.ambientEnv, apiKey);
  await removePrivateFile(layout.providerStagingFile);
  const secrets = parseArray(
    (await runOnecliCommand(layout, runCommand, environment, ['secrets', 'list', '--max', '0'])).stdout,
    'OneCLI secrets',
  );
  const existing = findCredentialSecret(secrets, input, {
    ambiguous: 'More than one OneCLI secret has the requested name',
    conflict: 'An existing OneCLI secret has incompatible metadata',
  });
  if (existing) return { id: stringField(existing, 'id', 'OneCLI secret', INVALID_OUTPUT), created: false };

  try {
    await writeOwnerOnlyFileExclusive(layout.providerStagingFile, input.value);
    const args = [
      'secrets',
      'create',
      '--name',
      input.name,
      '--type',
      input.type,
      '--host-pattern',
      input.hostPattern,
      '--file',
      layout.providerStagingFile,
    ];
    if (input.pathPattern !== undefined) args.push('--path-pattern', input.pathPattern);
    if (input.headerName !== undefined) args.push('--header-name', input.headerName);
    if (input.valueFormat !== undefined) args.push('--value-format', input.valueFormat);
    if (input.paramName !== undefined) args.push('--param-name', input.paramName);
    if (input.paramFormat !== undefined) args.push('--param-format', input.paramFormat);
    const created = parseRecord(
      (await runOnecliCommand(layout, runCommand, environment, args)).stdout,
      'OneCLI secret',
    );
    return { id: stringField(created, 'id', 'OneCLI secret', INVALID_OUTPUT), created: true };
  } finally {
    await removePrivateFile(layout.providerStagingFile);
  }
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
 * Start or repair the runtime: pull missing images under their own
 * timeout, force-recreate only a service Docker reports unhealthy, then
 * start everything and wait for health within the budget the healthchecks
 * allow. A failed start names a foreign process on an allocated port.
 */
export async function reconcileOnecliRuntime(
  layout: OnecliRuntimeLayout,
  pins: OnecliPins,
  dependencies: OnecliRuntimeDependencies = {},
): Promise<OnecliRuntimeReceipt> {
  const docker = dockerContext(layout, dependencies);
  const { runner, environment } = docker;
  await prepareOnecliRuntime(layout, pins);
  await removePrivateFile(layout.providerStagingFile);
  const kept = await cleanupOnecliDockerOrphans(docker);
  await runner({
    ...buildComposeInvocation(layout, ['pull', '--policy', 'missing']),
    env: environment,
    timeoutMs: ONECLI_PULL_TIMEOUT_MS,
    stream: true,
  });
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
  const receipt = await verifyOnecliRuntime(layout, pins, dependencies);
  await verifyAgentNetworkIsolation(docker, pins);
  return receipt;
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
  dependencies: Pick<OnecliRuntimeDependencies, 'dockerCommandRunner' | 'runCommand' | 'ambientEnv'> = {},
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
export async function cleanupOnecliDockerOrphans(docker: OnecliDocker): Promise<readonly InspectedOnecliContainer[]> {
  const { layout, runner, environment } = docker;
  const containers = await inspectProjectContainers(docker);
  assertOwnedContainers(layout, containers);
  const kept: InspectedOnecliContainer[] = [];
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

async function inspectOnecliRuntime(
  docker: OnecliDocker,
  inspected?: readonly InspectedOnecliContainer[],
): Promise<ObservedOnecliRuntime> {
  const { layout, runner, environment } = docker;
  const [containers, networkResult, volumeResult] = await Promise.all([
    inspected ?? inspectProjectContainers(docker),
    runner({
      command: 'docker',
      args: ['network', 'inspect', layout.backendNetwork, layout.agentEgressNetwork],
      cwd: path.dirname(layout.rootDirectory),
      env: environment,
      timeoutMs: INSPECT_TIMEOUT_MS,
    }),
    runner({
      command: 'docker',
      args: ['volume', 'inspect', layout.postgresVolume, layout.appVolume],
      cwd: path.dirname(layout.rootDirectory),
      env: environment,
      timeoutMs: INSPECT_TIMEOUT_MS,
    }),
  ]);
  return {
    containers: containers.map(({ id: _id, ...container }) => container),
    networks: parseDockerNetworks(networkResult.stdout),
    volumes: parseDockerVolumes(volumeResult.stdout),
  };
}

interface InspectedOnecliContainer extends ObservedOnecliContainer {
  readonly id: string;
}

async function inspectProjectContainers(docker: OnecliDocker): Promise<readonly InspectedOnecliContainer[]> {
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
  const ids = list.stdout
    .split(/\r?\n/u)
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
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

async function verifyAgentNetworkIsolation(docker: OnecliDocker, pins: OnecliPins): Promise<void> {
  const { layout, runner, environment } = docker;
  const script = [
    '(async () => {',
    "const dns = require('node:dns').promises;",
    "const response = await fetch('http://host.docker.internal:10255/healthz');",
    "if (!response.ok) throw new Error('gateway health failed');",
    "for (const host of ['app', 'postgres']) {",
    '  try { await dns.lookup(host); throw new Error(`${host} resolved`); }',
    "  catch (error) { if (String(error).includes('resolved')) throw error; }",
    '}',
    '})().catch((error) => { console.error(error.message); process.exit(1); });',
  ].join(' ');
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

function parseDockerContainers(source: string): readonly InspectedOnecliContainer[] {
  const values = parseDockerArray(source, 'Docker container inspection');
  return values.map((value) => {
    const config = requireRecord(value.Config, 'Docker container inspection', INVALID_RUNTIME);
    const labels = requireRecord(config.Labels, 'Docker container labels', INVALID_RUNTIME);
    const state = requireRecord(value.State, 'Docker container state', INVALID_RUNTIME);
    const networkSettings = requireRecord(value.NetworkSettings, 'Docker network settings', INVALID_RUNTIME);
    const networks = requireRecord(networkSettings.Networks, 'Docker container networks', INVALID_RUNTIME);
    const mounts = value.Mounts;
    if (!Array.isArray(mounts) || !mounts.every(isRecord)) {
      throw new GwsEaError(INVALID_RUNTIME, 'Docker container mounts are invalid');
    }
    const health = isRecord(state.Health) ? state.Health : undefined;
    return {
      id: stringField(value, 'Id', 'Docker container', INVALID_OUTPUT),
      service: stringField(labels, 'com.docker.compose.service', 'Docker container labels', INVALID_OUTPUT),
      image: stringField(config, 'Image', 'Docker container config', INVALID_OUTPUT),
      instanceId: optionalString(labels[ONECLI_INSTANCE_LABEL]),
      project: optionalString(labels['com.docker.compose.project']),
      running: state.Running === true,
      health: optionalString(health?.Status),
      publishedPorts: parseDockerPorts(networkSettings.Ports),
      networks: Object.keys(networks),
      volumes: mounts
        .filter((mount) => mount.Type === 'volume')
        .map((mount) => ({
          name: stringField(mount, 'Name', 'Docker container volume', INVALID_OUTPUT),
          destination: stringField(mount, 'Destination', 'Docker container mount', INVALID_OUTPUT),
        })),
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

async function runOnecliCommand(
  layout: OnecliRuntimeLayout,
  runner: OnecliCommandRunner,
  environment: Readonly<Record<string, string>>,
  args: readonly string[],
): Promise<OnecliCommandResult> {
  return runner({
    command: layout.cliExecutable,
    args,
    cwd: layout.rootDirectory,
    env: environment,
    timeoutMs: 30_000,
  });
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

function expectedNetworksForService(layout: OnecliRuntimeLayout, service: string): readonly string[] {
  if (service === 'postgres' || service === 'app') return [layout.backendNetwork];
  if (service === 'gateway') return [layout.backendNetwork, layout.agentEgressNetwork];
  return [];
}

function validatePublishedPorts(layout: OnecliRuntimeLayout, container: ObservedOnecliContainer): void {
  const entries = Object.entries(container.publishedPorts);
  if (container.service === 'postgres') {
    if (entries.length !== 0) throw new GwsEaError('unsafe_onecli_port', 'OneCLI database must not publish ports');
    return;
  }
  const containerPort = container.service === 'app' ? '10254/tcp' : '10255/tcp';
  const hostPort = String(container.service === 'app' ? layout.appPort : layout.gatewayPort);
  if (
    entries.length !== 1 ||
    entries[0]?.[0] !== containerPort ||
    entries[0][1].length !== 1 ||
    entries[0][1][0]?.hostIp !== '127.0.0.1' ||
    entries[0][1][0]?.hostPort !== hostPort
  ) {
    throw new GwsEaError('unsafe_onecli_port', `OneCLI ${container.service} port binding is invalid`);
  }
}

function validateContainerVolumes(layout: OnecliRuntimeLayout, container: ObservedOnecliContainer): void {
  const expected =
    container.service === 'postgres'
      ? [{ name: layout.postgresVolume, destination: '/var/lib/postgresql' }]
      : [{ name: layout.appVolume, destination: '/app/data' }];
  if (
    container.volumes.length !== expected.length ||
    container.volumes.some(
      (volume, index) => volume.name !== expected[index]?.name || volume.destination !== expected[index]?.destination,
    )
  ) {
    throw new GwsEaError('unsafe_onecli_volume', `OneCLI ${container.service} volume mounts are invalid`);
  }
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

function parseRecord(source: string, label: string): Record<string, unknown> {
  const parsed = unwrapData(parseJson(source, label, INVALID_OUTPUT));
  if (!isRecord(parsed)) throw new GwsEaError(INVALID_OUTPUT, `${label} response is invalid`);
  return parsed;
}

function parseArray(source: string, label: string): readonly Record<string, unknown>[] {
  const parsed = unwrapData(parseJson(source, label, INVALID_OUTPUT));
  if (!Array.isArray(parsed) || !parsed.every(isRecord)) {
    throw new GwsEaError(INVALID_OUTPUT, `${label} response is invalid`);
  }
  return parsed;
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
  const expectedInjection =
    input.headerName !== undefined
      ? { headerName: input.headerName, valueFormat: input.valueFormat ?? '' }
      : input.paramName !== undefined
        ? { paramName: input.paramName, paramFormat: input.paramFormat ?? '' }
        : null;
  return (
    optionalString(existing.name) === input.name &&
    optionalString(existing.type) === input.type &&
    optionalString(existing.hostPattern) === input.hostPattern &&
    nullableString(existing.pathPattern) === (input.pathPattern ?? null) &&
    JSON.stringify(existing.injectionConfig ?? null) === JSON.stringify(expectedInjection)
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

export async function assertInstalledOnecliSdkVersion(expectedVersion = ONECLI_SDK_VERSION): Promise<void> {
  const require = createRequire(import.meta.url);
  const entry = require.resolve('@onecli-sh/sdk');
  const manifest = parseRecord(
    await readFile(path.resolve(path.dirname(entry), '..', 'package.json'), 'utf8'),
    'OneCLI SDK manifest',
  );
  if (manifest.version !== expectedVersion) {
    throw new GwsEaError('incompatible_onecli', 'Installed OneCLI SDK does not match the sanctioned version');
  }
}
