import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

import { OneCLI } from '@onecli-sh/sdk';

import { isErrno } from '../community-portal/errors.js';
import { preparePrivateLocalDirectory, assertPrivateStateFile } from './paths.js';
import {
  ONECLI_CLI_VERSION,
  ONECLI_GATEWAY_VERSION,
  ONECLI_SDK_VERSION,
  ONECLI_INSTANCE_LABEL,
  ONECLI_RESOURCE_ROLE_LABEL,
  renderOnecliCompose,
  type OnecliRuntimeLayout,
} from './onecli-compose.js';
import { GwsEaError } from './types.js';

const SAFE_ENVIRONMENT_KEYS = [
  'PATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TMPDIR',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
] as const;
const EXPECTED_SERVICES = ['app', 'gateway', 'postgres'] as const;
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;

export interface OnecliCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

export interface OnecliCommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export type OnecliCommandRunner = (command: OnecliCommand) => Promise<OnecliCommandResult>;

export type OnecliSdkClient = Pick<OneCLI, 'ensureAgent' | 'getContainerConfig'>;

export interface ObservedOnecliContainer {
  readonly service: string;
  readonly image: string;
  readonly instanceId: string | undefined;
  readonly project: string | undefined;
  readonly running: boolean;
  readonly healthy: boolean;
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

export interface ProviderCredentialInput {
  readonly name: string;
  readonly type: string;
  readonly value: string;
  readonly hostPattern: string;
  readonly pathPattern?: string;
  readonly headerName?: string;
  readonly valueFormat?: string;
  readonly paramName?: string;
  readonly paramFormat?: string;
}

export interface ImportedCredential {
  readonly id: string;
  readonly created: boolean;
}

export interface OnecliCompatibilityDependencies {
  readonly runCommand?: OnecliCommandRunner;
  readonly createSdkClient?: (layout: OnecliRuntimeLayout) => OnecliSdkClient;
  readonly fetch?: typeof globalThis.fetch;
  readonly ambientEnv?: NodeJS.ProcessEnv;
}

export interface OnecliRuntimeDependencies extends OnecliCompatibilityDependencies {
  readonly dockerCommandRunner?: OnecliCommandRunner;
}

declare const compatibilityReceiptBrand: unique symbol;
export interface OnecliCompatibilityReceipt {
  readonly [compatibilityReceiptBrand]: true;
}

const issuedCompatibilityReceipts = new WeakMap<object, OnecliRuntimeLayout>();

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
  const environment = copySafeEnvironment(ambient);
  environment.HOME = layout.cliHome;
  environment.ONECLI_API_HOST = layout.appUrl;
  if (apiKey !== undefined) environment.ONECLI_API_KEY = apiKey;
  return environment;
}

export function buildComposeEnvironment(ambient: NodeJS.ProcessEnv = process.env): Readonly<Record<string, string>> {
  const environment = copySafeEnvironment(ambient);
  if (ambient.HOME !== undefined) environment.HOME = ambient.HOME;
  return environment;
}

export async function prepareOnecliRuntime(layout: OnecliRuntimeLayout): Promise<void> {
  await preparePrivateLocalDirectory(layout.rootDirectory);
  await preparePrivateLocalDirectory(layout.cliHome);
  await preparePrivateLocalDirectory(layout.secretsDirectory);

  await Promise.all([
    ensurePrivateRandomFile(layout.postgresPasswordFile, 'base64url'),
    ensurePrivateRandomFile(layout.encryptionKeyFile, 'base64'),
    ensurePrivateRandomFile(layout.gatewayInternalSecretFile, 'base64url'),
  ]);
  await ensurePrivateTextFile(layout.composeFile, renderOnecliCompose(layout));
  await ensurePrivateTextFile(layout.envFile, '# Intentionally empty: runtime coordinates are passed explicitly.\n');
}

export function validateObservedOnecliRuntime(layout: OnecliRuntimeLayout, observed: ObservedOnecliRuntime): void {
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
    if (!container) throw new GwsEaError('invalid_onecli_runtime', `OneCLI ${service} container is missing`);
    if (container.instanceId !== layout.instanceId || container.project !== layout.project) {
      throw new GwsEaError('unsafe_onecli_owner', `OneCLI ${service} ownership labels are invalid`);
    }
    if (!container.running || !container.healthy) {
      throw new GwsEaError('unhealthy_onecli', `OneCLI ${service} container is not healthy`);
    }
    const expectedImage =
      service === 'postgres' ? 'postgres:18-alpine' : `ghcr.io/onecli/onecli:${ONECLI_GATEWAY_VERSION}`;
    if (container.image !== expectedImage) {
      throw new GwsEaError('unsafe_onecli_image', `OneCLI ${service} image is not the sanctioned pin`);
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

export async function runOnecliCompatibilityCanary(
  layout: OnecliRuntimeLayout,
  dependencies: OnecliCompatibilityDependencies = {},
): Promise<OnecliCompatibilityReceipt> {
  return runCompatibilityCanary(layout, dependencies, false);
}

async function runCompatibilityCanary(
  layout: OnecliRuntimeLayout,
  dependencies: OnecliCompatibilityDependencies,
  verifiedGatewayImage: boolean,
): Promise<OnecliCompatibilityReceipt> {
  const runCommand = dependencies.runCommand ?? runSanitizedCommand;
  const fetchImplementation = dependencies.fetch ?? globalThis.fetch;
  await removePlaintextStagingFiles(layout);
  const healthResults = await Promise.allSettled([
    assertHealthyEndpoint(fetchImplementation, `${layout.appUrl}/api/health`, 'OneCLI app'),
    assertHealthyEndpoint(fetchImplementation, `${layout.appUrl}/v1/health`, 'OneCLI versioned API'),
    assertHealthyEndpoint(fetchImplementation, `${layout.gatewayUrl}/healthz`, 'OneCLI gateway'),
  ]);
  for (const result of healthResults) {
    if (result.status === 'rejected') throw result.reason;
  }

  const environment = buildOnecliCliEnvironment(layout, dependencies.ambientEnv);
  const version = parseRecord(
    (await runOnecliCommand(layout, environment, ['version'], runCommand)).stdout,
    'OneCLI version',
  );
  if (version.version !== ONECLI_CLI_VERSION) {
    throw new GwsEaError('incompatible_onecli', 'Installed OneCLI CLI does not match the sanctioned version');
  }
  if (
    version.server_version !== ONECLI_GATEWAY_VERSION &&
    !(verifiedGatewayImage && version.server_version === 'unknown')
  ) {
    throw new GwsEaError('incompatible_onecli', 'Running OneCLI gateway does not match the sanctioned version');
  }
  await assertInstalledSdkVersion();

  const canarySecretName = 'GWS-EA compatibility canary';
  const canaryAgentName = `gws-ea-compat-${layout.instanceId}`;
  let secretId: string | undefined;
  let agentId: string | undefined;
  try {
    const existingSecrets = parseArray(
      (await runOnecliCommand(layout, environment, ['secrets', 'list', '--max', '0'], runCommand)).stdout,
      'OneCLI secrets',
    );
    for (const candidate of existingSecrets.filter((value) => recordString(value, 'name') === canarySecretName)) {
      if (
        recordString(candidate, 'type') !== 'generic' ||
        recordString(candidate, 'hostPattern') !== 'canary.invalid'
      ) {
        throw new GwsEaError('onecli_canary_collision', 'A conflicting OneCLI compatibility canary secret exists');
      }
      await runOnecliCommand(
        layout,
        environment,
        ['secrets', 'delete', '--id', requireRecordString(candidate, 'id', 'OneCLI canary secret')],
        runCommand,
      );
    }
    const staleAgents = parseArray(
      (await runOnecliCommand(layout, environment, ['agents', 'list', '--max', '0'], runCommand)).stdout,
      'OneCLI agents',
    ).filter(
      (candidate) =>
        recordString(candidate, 'identifier') === canaryAgentName ||
        recordString(candidate, 'name') === canaryAgentName,
    );
    for (const candidate of staleAgents) {
      if (
        recordString(candidate, 'identifier') !== canaryAgentName ||
        recordString(candidate, 'name') !== canaryAgentName
      ) {
        throw new GwsEaError('onecli_canary_collision', 'A conflicting OneCLI compatibility canary agent exists');
      }
      await runOnecliCommand(
        layout,
        environment,
        ['agents', 'delete', '--id', requireRecordString(candidate, 'id', 'OneCLI canary agent')],
        runCommand,
      );
    }

    const sdk = dependencies.createSdkClient?.(layout) ?? createDefaultSdkClient(layout);
    await sdk.ensureAgent({ name: canaryAgentName, identifier: canaryAgentName });

    await writeExclusiveSecret(layout.canaryStagingFile, `canary-${randomBytes(24).toString('hex')}`);
    const createdSecret = parseRecord(
      (
        await runOnecliCommand(
          layout,
          environment,
          [
            'secrets',
            'create',
            '--name',
            canarySecretName,
            '--type',
            'generic',
            '--host-pattern',
            'canary.invalid',
            '--header-name',
            'Authorization',
            '--value-format',
            'Bearer {value}',
            '--file',
            layout.canaryStagingFile,
          ],
          runCommand,
        )
      ).stdout,
      'OneCLI canary secret',
    );
    secretId = requireRecordString(createdSecret, 'id', 'OneCLI canary secret');

    const agents = parseArray(
      (await runOnecliCommand(layout, environment, ['agents', 'list', '--max', '0'], runCommand)).stdout,
      'OneCLI agents',
    );
    const agent = agents.find(
      (candidate) =>
        recordString(candidate, 'identifier') === canaryAgentName ||
        recordString(candidate, 'name') === canaryAgentName,
    );
    if (!agent)
      throw new GwsEaError('incompatible_onecli', 'OneCLI SDK-created canary agent was not visible to the CLI');
    agentId = requireRecordString(agent, 'id', 'OneCLI canary agent');
    await runOnecliCommand(
      layout,
      environment,
      ['agents', 'set-secrets', '--id', agentId, '--secret-ids', secretId],
      runCommand,
    );
    const verifiedAgents = parseArray(
      (await runOnecliCommand(layout, environment, ['agents', 'list', '--max', '0'], runCommand)).stdout,
      'OneCLI agents',
    );
    const verifiedAgent = verifiedAgents.find((candidate) => recordString(candidate, 'id') === agentId);
    if (recordString(verifiedAgent ?? {}, 'secretMode') !== 'selective') {
      throw new GwsEaError('incompatible_onecli', 'OneCLI canary agent did not enter selective secret mode');
    }
    const assignedSecretIds = parseStringArray(
      (await runOnecliCommand(layout, environment, ['agents', 'secrets', '--id', agentId], runCommand)).stdout,
      'OneCLI agent secrets',
    );
    if (assignedSecretIds.length !== 1 || assignedSecretIds[0] !== secretId) {
      throw new GwsEaError('incompatible_onecli', 'OneCLI canary secret grant did not reconcile');
    }
    const config = await sdk.getContainerConfig({ agent: canaryAgentName });
    if (
      typeof config.caCertificate !== 'string' ||
      config.caCertificate.length === 0 ||
      typeof config.caCertificateContainerPath !== 'string' ||
      !isRecord(config.env)
    ) {
      throw new GwsEaError('incompatible_onecli', 'OneCLI SDK returned an invalid container configuration');
    }
    const proxy = recordString(config.env, 'HTTPS_PROXY') ?? recordString(config.env, 'HTTP_PROXY');
    if (proxy === undefined || !isExpectedGatewayProxy(proxy)) {
      throw new GwsEaError('incompatible_onecli', 'OneCLI SDK returned an invalid gateway proxy');
    }
  } catch (error) {
    await cleanupCompatibilityCanary(layout, environment, runCommand, agentId, secretId, false);
    throw error;
  }
  await cleanupCompatibilityCanary(layout, environment, runCommand, agentId, secretId, true);

  const receipt = Object.freeze({}) as OnecliCompatibilityReceipt;
  issuedCompatibilityReceipts.set(receipt, Object.freeze({ ...layout }));
  return receipt;
}

async function cleanupCompatibilityCanary(
  layout: OnecliRuntimeLayout,
  environment: Readonly<Record<string, string>>,
  runCommand: OnecliCommandRunner,
  agentId: string | undefined,
  secretId: string | undefined,
  failClosed: boolean,
): Promise<void> {
  await removeFileAndSyncParent(layout.canaryStagingFile);
  const results = await Promise.allSettled([
    agentId === undefined
      ? Promise.resolve()
      : runOnecliCommand(layout, environment, ['agents', 'delete', '--id', agentId], runCommand),
    secretId === undefined
      ? Promise.resolve()
      : runOnecliCommand(layout, environment, ['secrets', 'delete', '--id', secretId], runCommand),
  ]);
  if (failClosed && results.some((result) => result.status === 'rejected')) {
    throw new GwsEaError('onecli_canary_cleanup_failed', 'OneCLI compatibility canary cleanup failed');
  }
}

export async function importProviderCredential(
  receipt: OnecliCompatibilityReceipt,
  input: ProviderCredentialInput,
  dependencies: Pick<OnecliCompatibilityDependencies, 'runCommand' | 'ambientEnv'> = {},
): Promise<ImportedCredential> {
  const layout = issuedCompatibilityReceipts.get(receipt);
  if (layout === undefined) {
    throw new GwsEaError('onecli_canary_required', 'A successful OneCLI compatibility canary is required');
  }
  assertCredentialMetadata(input);
  const runCommand = dependencies.runCommand ?? runSanitizedCommand;
  const environment = buildOnecliCliEnvironment(layout, dependencies.ambientEnv);
  await removePlaintextStagingFiles(layout);
  const secrets = parseArray(
    (await runOnecliCommand(layout, environment, ['secrets', 'list', '--max', '0'], runCommand)).stdout,
    'OneCLI secrets',
  );
  const matching = secrets.filter((candidate) => recordString(candidate, 'name') === input.name);
  if (matching.length > 1) {
    throw new GwsEaError('ambiguous_onecli_secret', 'More than one OneCLI secret has the requested name');
  }
  if (matching.length === 1) {
    const existing = matching[0];
    if (!credentialMetadataMatches(existing, input)) {
      throw new GwsEaError('onecli_secret_conflict', 'An existing OneCLI secret has incompatible metadata');
    }
    return { id: requireRecordString(existing, 'id', 'OneCLI secret'), created: false };
  }

  try {
    await writeExclusiveSecret(layout.providerStagingFile, input.value);
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
      (await runOnecliCommand(layout, environment, args, runCommand)).stdout,
      'OneCLI secret',
    );
    return { id: requireRecordString(created, 'id', 'OneCLI secret'), created: true };
  } finally {
    await removeFileAndSyncParent(layout.providerStagingFile);
  }
}

export async function reconcileOnecliRuntime(
  layout: OnecliRuntimeLayout,
  dependencies: OnecliRuntimeDependencies = {},
): Promise<OnecliCompatibilityReceipt> {
  const dockerRunner = dependencies.dockerCommandRunner ?? dependencies.runCommand ?? runSanitizedCommand;
  const composeEnvironment = buildComposeEnvironment(dependencies.ambientEnv);
  await prepareOnecliRuntime(layout);
  await removePlaintextStagingFiles(layout);
  await cleanupOnecliDockerOrphans(layout, dockerRunner, composeEnvironment);

  const up = buildComposeInvocation(layout, ['up', '--detach', '--wait', '--remove-orphans']);
  await dockerRunner({ ...up, env: composeEnvironment, timeoutMs: 120_000 });
  const observed = await inspectOnecliRuntime(layout, dockerRunner, composeEnvironment);
  validateObservedOnecliRuntime(layout, observed);
  await verifyAgentNetworkIsolation(layout, dockerRunner, composeEnvironment);
  return runCompatibilityCanary(
    layout,
    {
      ...dependencies,
      runCommand: dependencies.runCommand ?? runSanitizedCommand,
    },
    true,
  );
}

export async function cleanupOnecliDockerOrphans(
  layout: OnecliRuntimeLayout,
  runner: OnecliCommandRunner = runSanitizedCommand,
  environment: Readonly<Record<string, string>> = buildComposeEnvironment(),
): Promise<void> {
  const containers = await inspectProjectContainers(layout, runner, environment);
  const serviceCounts = new Map<string, number>();
  for (const container of containers) {
    serviceCounts.set(container.service, (serviceCounts.get(container.service) ?? 0) + 1);
  }
  for (const container of containers) {
    if (container.instanceId !== layout.instanceId || container.project !== layout.project) {
      throw new GwsEaError(
        'unsafe_onecli_owner',
        'A Docker resource in the OneCLI project has invalid ownership labels',
      );
    }
    if (
      !EXPECTED_SERVICES.includes(container.service as (typeof EXPECTED_SERVICES)[number]) ||
      serviceCounts.get(container.service) !== 1
    ) {
      await runner({
        command: 'docker',
        args: ['container', 'rm', '--force', container.id],
        cwd: layout.rootDirectory,
        env: environment,
        timeoutMs: 30_000,
      });
    }
  }
}

export async function inspectOnecliRuntime(
  layout: OnecliRuntimeLayout,
  runner: OnecliCommandRunner = runSanitizedCommand,
  environment: Readonly<Record<string, string>> = buildComposeEnvironment(),
): Promise<ObservedOnecliRuntime> {
  const [containers, networkResult, volumeResult] = await Promise.all([
    inspectProjectContainers(layout, runner, environment),
    runner({
      command: 'docker',
      args: ['network', 'inspect', layout.backendNetwork, layout.agentEgressNetwork],
      cwd: layout.rootDirectory,
      env: environment,
      timeoutMs: 30_000,
    }),
    runner({
      command: 'docker',
      args: ['volume', 'inspect', layout.postgresVolume, layout.appVolume],
      cwd: layout.rootDirectory,
      env: environment,
      timeoutMs: 30_000,
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

async function inspectProjectContainers(
  layout: OnecliRuntimeLayout,
  runner: OnecliCommandRunner,
  environment: Readonly<Record<string, string>>,
): Promise<readonly InspectedOnecliContainer[]> {
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
    cwd: layout.rootDirectory,
    env: environment,
    timeoutMs: 30_000,
  });
  const ids = list.stdout
    .split(/\r?\n/u)
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  if (ids.length === 0) return [];
  const inspection = await runner({
    command: 'docker',
    args: ['container', 'inspect', ...ids],
    cwd: layout.rootDirectory,
    env: environment,
    timeoutMs: 30_000,
  });
  return parseDockerContainers(inspection.stdout);
}

async function verifyAgentNetworkIsolation(
  layout: OnecliRuntimeLayout,
  runner: OnecliCommandRunner,
  environment: Readonly<Record<string, string>>,
): Promise<void> {
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
      `ghcr.io/onecli/onecli:${ONECLI_GATEWAY_VERSION}`,
      '--input-type=commonjs',
      '--eval',
      script,
    ],
    cwd: layout.rootDirectory,
    env: environment,
    timeoutMs: 30_000,
  });
}

function parseDockerContainers(source: string): readonly InspectedOnecliContainer[] {
  const values = parseDockerArray(source, 'Docker container inspection');
  return values.map((value) => {
    const config = requireNestedRecord(value, 'Config', 'Docker container inspection');
    const labels = requireNestedRecord(config, 'Labels', 'Docker container labels');
    const state = requireNestedRecord(value, 'State', 'Docker container state');
    const networkSettings = requireNestedRecord(value, 'NetworkSettings', 'Docker network settings');
    const networks = requireNestedRecord(networkSettings, 'Networks', 'Docker container networks');
    const mounts = value.Mounts;
    if (!Array.isArray(mounts) || !mounts.every(isRecord)) {
      throw new GwsEaError('invalid_onecli_runtime', 'Docker container mounts are invalid');
    }
    const health = isRecord(state.Health) ? state.Health : undefined;
    return {
      id: requireRecordString(value, 'Id', 'Docker container'),
      service: requireRecordString(labels, 'com.docker.compose.service', 'Docker container labels'),
      image: requireRecordString(config, 'Image', 'Docker container config'),
      instanceId: recordString(labels, ONECLI_INSTANCE_LABEL),
      project: recordString(labels, 'com.docker.compose.project'),
      running: state.Running === true,
      healthy: health?.Status === 'healthy',
      publishedPorts: parseDockerPorts(networkSettings.Ports),
      networks: Object.keys(networks),
      volumes: mounts
        .filter((mount) => mount.Type === 'volume')
        .map((mount) => ({
          name: requireRecordString(mount, 'Name', 'Docker container volume'),
          destination: requireRecordString(mount, 'Destination', 'Docker container mount'),
        })),
    };
  });
}

function parseDockerPorts(value: unknown): ObservedOnecliContainer['publishedPorts'] {
  if (!isRecord(value)) throw new GwsEaError('invalid_onecli_runtime', 'Docker published ports are invalid');
  const result: Record<string, { hostIp: string; hostPort: string }[]> = {};
  for (const [containerPort, bindings] of Object.entries(value)) {
    if (bindings === null) continue;
    if (!Array.isArray(bindings) || !bindings.every(isRecord)) {
      throw new GwsEaError('invalid_onecli_runtime', 'Docker published port binding is invalid');
    }
    result[containerPort] = bindings.map((binding) => ({
      hostIp: requireRecordString(binding, 'HostIp', 'Docker port binding'),
      hostPort: requireRecordString(binding, 'HostPort', 'Docker port binding'),
    }));
  }
  return result;
}

function parseDockerNetworks(source: string): readonly ObservedOnecliNetwork[] {
  return parseDockerArray(source, 'Docker network inspection').map((value) => {
    const labels = requireNestedRecord(value, 'Labels', 'Docker network labels');
    return {
      name: requireRecordString(value, 'Name', 'Docker network'),
      instanceId: recordString(labels, ONECLI_INSTANCE_LABEL),
      role: recordString(labels, ONECLI_RESOURCE_ROLE_LABEL),
      internal: value.Internal === true,
    };
  });
}

function parseDockerVolumes(source: string): readonly ObservedOnecliVolume[] {
  return parseDockerArray(source, 'Docker volume inspection').map((value) => {
    const labels = requireNestedRecord(value, 'Labels', 'Docker volume labels');
    return {
      name: requireRecordString(value, 'Name', 'Docker volume'),
      instanceId: recordString(labels, ONECLI_INSTANCE_LABEL),
      role: recordString(labels, ONECLI_RESOURCE_ROLE_LABEL),
    };
  });
}

function parseDockerArray(source: string, label: string): readonly Record<string, unknown>[] {
  const value = parseJson(source, label);
  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw new GwsEaError('invalid_onecli_runtime', `${label} is invalid`);
  }
  return value;
}

function requireNestedRecord(value: Record<string, unknown>, key: string, label: string): Record<string, unknown> {
  const nested = value[key];
  if (!isRecord(nested)) throw new GwsEaError('invalid_onecli_runtime', `${label} is invalid`);
  return nested;
}

function createDefaultSdkClient(layout: OnecliRuntimeLayout): OnecliSdkClient {
  return new OneCLI({ url: layout.appUrl });
}

async function runOnecliCommand(
  layout: OnecliRuntimeLayout,
  environment: Readonly<Record<string, string>>,
  args: readonly string[],
  runner: OnecliCommandRunner,
): Promise<OnecliCommandResult> {
  return runner({ command: 'onecli', args, cwd: layout.rootDirectory, env: environment, timeoutMs: 30_000 });
}

export const runSanitizedCommand: OnecliCommandRunner = async (command) =>
  new Promise<OnecliCommandResult>((resolve, reject) => {
    const child = spawn(command.command, [...command.args], {
      cwd: command.cwd,
      env: command.env ?? copySafeEnvironment(process.env),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let settled = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), command.timeoutMs ?? 30_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const capture = (chunk: string, destination: 'stdout' | 'stderr'): void => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        return;
      }
      if (destination === 'stdout') stdout += chunk;
      else stderr += chunk;
    };
    child.stdout.on('data', (chunk: string) => capture(chunk, 'stdout'));
    child.stderr.on('data', (chunk: string) => capture(chunk, 'stderr'));
    child.once('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new GwsEaError('onecli_command_failed', 'A required OneCLI runtime command could not be started'));
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) {
        reject(new GwsEaError('onecli_command_failed', 'A required OneCLI runtime command exceeded its output limit'));
      } else if (code !== 0) {
        reject(
          new GwsEaError(
            'onecli_command_failed',
            signal === 'SIGKILL'
              ? 'A required OneCLI runtime command timed out'
              : 'A required OneCLI runtime command failed',
          ),
        );
      } else {
        resolve({ stdout, stderr });
      }
    });
  });

function copySafeEnvironment(ambient: NodeJS.ProcessEnv): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    const value = ambient[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

async function ensurePrivateRandomFile(file: string, encoding: 'base64' | 'base64url'): Promise<void> {
  try {
    await assertPrivateStateFile(file);
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error;
    await writeExclusiveSecret(file, randomBytes(32).toString(encoding));
  }
}

async function ensurePrivateTextFile(file: string, contents: string): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, contents, { mode: 0o600, flag: 'wx' });
    const handle = await open(temporary, fsConstants.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
    await chmod(file, 0o600);
    await syncDirectory(path.dirname(file));
    await assertPrivateStateFile(file);
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (!isErrno(error, 'ENOENT')) throw error;
    });
  }
}

async function writeExclusiveSecret(file: string, secret: string): Promise<void> {
  const handle = await open(file, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(secret, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await assertPrivateStateFile(file);
  await syncDirectory(path.dirname(file));
}

async function removePlaintextStagingFiles(layout: OnecliRuntimeLayout): Promise<void> {
  await removeFileAndSyncParent(layout.providerStagingFile);
  await removeFileAndSyncParent(layout.canaryStagingFile);
}

async function removeFileAndSyncParent(file: string): Promise<void> {
  let removed = false;
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new GwsEaError('unsafe_onecli_staging', 'OneCLI staging path is not a regular file');
    }
    await unlink(file);
    removed = true;
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error;
  }
  if (removed) await syncDirectory(path.dirname(file));
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
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
    throw new GwsEaError('invalid_onecli_runtime', `${label} do not match the expected runtime`);
  }
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length && new Set(left).size === left.length && left.every((value) => right.includes(value))
  );
}

function parseRecord(source: string, label: string): Record<string, unknown> {
  const parsed = unwrapData(parseJson(source, label));
  if (!isRecord(parsed)) throw new GwsEaError('invalid_onecli_output', `${label} response is invalid`);
  return parsed;
}

function parseArray(source: string, label: string): readonly Record<string, unknown>[] {
  const parsed = unwrapData(parseJson(source, label));
  if (!Array.isArray(parsed) || !parsed.every(isRecord)) {
    throw new GwsEaError('invalid_onecli_output', `${label} response is invalid`);
  }
  return parsed;
}

function parseStringArray(source: string, label: string): readonly string[] {
  const parsed = unwrapData(parseJson(source, label));
  if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === 'string')) {
    throw new GwsEaError('invalid_onecli_output', `${label} response is invalid`);
  }
  return parsed;
}

function parseJson(source: string, label: string): unknown {
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new GwsEaError('invalid_onecli_output', `${label} response is not valid JSON`);
  }
}

function unwrapData(value: unknown): unknown {
  if (isRecord(value) && 'data' in value) return value.data;
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordString(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === 'string' ? value[key] : undefined;
}

function requireRecordString(value: Record<string, unknown>, key: string, label: string): string {
  const result = recordString(value, key);
  if (result === undefined || result.length === 0) {
    throw new GwsEaError('invalid_onecli_output', `${label} response is missing ${key}`);
  }
  return result;
}

function assertCredentialMetadata(input: ProviderCredentialInput): void {
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

function credentialMetadataMatches(existing: Record<string, unknown>, input: ProviderCredentialInput): boolean {
  const expectedInjection =
    input.headerName !== undefined
      ? { headerName: input.headerName, valueFormat: input.valueFormat ?? '' }
      : input.paramName !== undefined
        ? { paramName: input.paramName, paramFormat: input.paramFormat ?? '' }
        : null;
  return (
    recordString(existing, 'type') === input.type &&
    recordString(existing, 'hostPattern') === input.hostPattern &&
    nullableString(existing.pathPattern) === (input.pathPattern ?? null) &&
    JSON.stringify(existing.injectionConfig ?? null) === JSON.stringify(expectedInjection)
  );
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function isExpectedGatewayProxy(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return url.protocol === 'http:' && url.hostname === 'host.docker.internal' && url.port === '10255';
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return code !== undefined && (code <= 0x1f || code === 0x7f);
  });
}

async function assertInstalledSdkVersion(): Promise<void> {
  const require = createRequire(import.meta.url);
  const entry = require.resolve('@onecli-sh/sdk');
  const manifest = parseRecord(
    await readFile(path.resolve(path.dirname(entry), '..', 'package.json'), 'utf8'),
    'OneCLI SDK manifest',
  );
  if (manifest.version !== ONECLI_SDK_VERSION) {
    throw new GwsEaError('incompatible_onecli', 'Installed OneCLI SDK does not match the sanctioned version');
  }
}
