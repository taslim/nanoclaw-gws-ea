import { randomBytes } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

import { OneCLI } from '@onecli-sh/sdk';

import { isErrno } from '../community-portal/errors.js';
import { preparePrivateDirectory } from './paths.js';
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
  ONECLI_RESOURCE_ROLE_LABEL,
  renderOnecliCompose,
  type OnecliRuntimeLayout,
} from './onecli-compose.js';
import { ONECLI_CLI_VERSION, ONECLI_GATEWAY_VERSION, ONECLI_SDK_VERSION } from './pins.js';
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

const INVALID_OUTPUT = 'invalid_onecli_output';
const INVALID_RUNTIME = 'invalid_onecli_runtime';
import type { ProviderCredential, ProviderCredentialMetadata } from '../provider-credential.js';

const EXPECTED_SERVICES = ['app', 'gateway', 'postgres'] as const;

export type OnecliCommand = SanitizedCommand;
export type OnecliCommandResult = SanitizedCommandResult;
export type OnecliCommandRunner = SanitizedCommandRunner;

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

export interface ImportedCredential {
  readonly id: string;
  readonly created: boolean;
}

export interface OnecliCompatibilityDependencies {
  readonly runCommand?: OnecliCommandRunner;
  readonly createSdkClient?: (layout: OnecliRuntimeLayout, apiKey: string) => OnecliSdkClient;
  readonly fetch?: typeof globalThis.fetch;
  readonly ambientEnv?: NodeJS.ProcessEnv;
}

export interface OnecliRuntimeDependencies extends OnecliCompatibilityDependencies {
  readonly dockerCommandRunner?: OnecliCommandRunner;
  readonly beforeBind?: () => Promise<void>;
}

declare const compatibilityReceiptBrand: unique symbol;
export interface OnecliCompatibilityReceipt {
  readonly [compatibilityReceiptBrand]: true;
}

interface VerifiedOnecliRuntime {
  readonly layout: OnecliRuntimeLayout;
  readonly apiKey: string;
}

export interface OnecliApiKeyFiles {
  readonly runtime: string;
  readonly admin: string;
}

const issuedCompatibilityReceipts = new WeakMap<object, VerifiedOnecliRuntime>();

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

export function buildComposeEnvironment(ambient: NodeJS.ProcessEnv = process.env): Readonly<Record<string, string>> {
  const environment = buildToolEnvironment(ambient);
  if (ambient.HOME !== undefined) environment.HOME = ambient.HOME;
  return environment;
}

export async function prepareOnecliRuntime(layout: OnecliRuntimeLayout): Promise<void> {
  await preparePrivateDirectory(layout.rootDirectory);
  await Promise.all([preparePrivateDirectory(layout.cliHome), preparePrivateDirectory(layout.secretsDirectory)]);

  await Promise.all([
    ensureRandomOwnerOnlyFile(layout.postgresPasswordFile, 'base64url'),
    ensureRandomOwnerOnlyFile(layout.encryptionKeyFile, 'base64'),
    ensureRandomOwnerOnlyFile(layout.gatewayInternalSecretFile, 'base64url'),
  ]);
  await writePrivateTextFile(layout.composeFile, renderOnecliCompose(layout));
  await writePrivateTextFile(layout.envFile, '# Intentionally empty: runtime coordinates are passed explicitly.\n');
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
    if (!container) throw new GwsEaError(INVALID_RUNTIME, `OneCLI ${service} container is missing`);
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

  const bootstrapEnvironment = buildOnecliCliEnvironment(layout, dependencies.ambientEnv);
  const apiKeyResponse = parseRecord(
    (await runOnecliCommand(layout, bootstrapEnvironment, ['auth', 'api-key'], runCommand)).stdout,
    'OneCLI API key',
  );
  const apiKey = stringField(apiKeyResponse, 'apiKey', 'OneCLI API key', INVALID_OUTPUT);
  if (!/^oc_[A-Za-z0-9_-]{20,}$/u.test(apiKey)) {
    throw new GwsEaError('incompatible_onecli', 'OneCLI returned an invalid local API key');
  }
  registerSecret(apiKey);
  const environment = buildOnecliCliEnvironment(layout, dependencies.ambientEnv, apiKey);
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
  await assertInstalledOnecliSdkVersion();

  const canarySecretName = 'GWS-EA compatibility canary';
  const canaryAgentName = `gws-ea-compat-${layout.instanceId}`;
  let secretId: string | undefined;
  let agentId: string | undefined;
  try {
    const existingSecrets = parseArray(
      (await runOnecliCommand(layout, environment, ['secrets', 'list', '--max', '0'], runCommand)).stdout,
      'OneCLI secrets',
    );
    for (const candidate of existingSecrets.filter((value) => optionalString(value.name) === canarySecretName)) {
      if (optionalString(candidate.type) !== 'generic' || optionalString(candidate.hostPattern) !== 'canary.invalid') {
        throw new GwsEaError('onecli_canary_collision', 'A conflicting OneCLI compatibility canary secret exists');
      }
      await runOnecliCommand(
        layout,
        environment,
        ['secrets', 'delete', '--id', stringField(candidate, 'id', 'OneCLI canary secret', INVALID_OUTPUT)],
        runCommand,
      );
    }
    const staleAgents = parseArray(
      (await runOnecliCommand(layout, environment, ['agents', 'list', '--max', '0'], runCommand)).stdout,
      'OneCLI agents',
    ).filter(
      (candidate) =>
        optionalString(candidate.identifier) === canaryAgentName || optionalString(candidate.name) === canaryAgentName,
    );
    for (const candidate of staleAgents) {
      if (
        optionalString(candidate.identifier) !== canaryAgentName ||
        optionalString(candidate.name) !== canaryAgentName
      ) {
        throw new GwsEaError('onecli_canary_collision', 'A conflicting OneCLI compatibility canary agent exists');
      }
      await runOnecliCommand(
        layout,
        environment,
        ['agents', 'delete', '--id', stringField(candidate, 'id', 'OneCLI canary agent', INVALID_OUTPUT)],
        runCommand,
      );
    }

    const sdk = dependencies.createSdkClient?.(layout, apiKey) ?? createDefaultSdkClient(layout, apiKey);
    await sdk.ensureAgent({ name: canaryAgentName, identifier: canaryAgentName });

    await writeOwnerOnlyFileExclusive(layout.canaryStagingFile, `canary-${randomBytes(24).toString('hex')}`);
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
    secretId = stringField(createdSecret, 'id', 'OneCLI canary secret', INVALID_OUTPUT);

    const agents = parseArray(
      (await runOnecliCommand(layout, environment, ['agents', 'list', '--max', '0'], runCommand)).stdout,
      'OneCLI agents',
    );
    const agent = agents.find(
      (candidate) =>
        optionalString(candidate.identifier) === canaryAgentName || optionalString(candidate.name) === canaryAgentName,
    );
    if (!agent)
      throw new GwsEaError('incompatible_onecli', 'OneCLI SDK-created canary agent was not visible to the CLI');
    agentId = stringField(agent, 'id', 'OneCLI canary agent', INVALID_OUTPUT);
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
    const verifiedAgent = verifiedAgents.find((candidate) => optionalString(candidate.id) === agentId);
    if (optionalString(verifiedAgent?.secretMode) !== 'selective') {
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
    const proxy = optionalString(config.env.HTTPS_PROXY) ?? optionalString(config.env.HTTP_PROXY);
    if (proxy === undefined || !isExpectedGatewayProxy(proxy)) {
      throw new GwsEaError('incompatible_onecli', 'OneCLI SDK returned an invalid gateway proxy');
    }
  } catch (error) {
    await cleanupCompatibilityCanary(layout, environment, runCommand, agentId, secretId, false);
    throw error;
  }
  await cleanupCompatibilityCanary(layout, environment, runCommand, agentId, secretId, true);

  const receipt = Object.freeze({}) as OnecliCompatibilityReceipt;
  issuedCompatibilityReceipts.set(receipt, Object.freeze({ layout: Object.freeze({ ...layout }), apiKey }));
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
  await removePrivateFile(layout.canaryStagingFile);
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
  input: ProviderCredential,
  dependencies: Pick<OnecliCompatibilityDependencies, 'runCommand' | 'ambientEnv'> = {},
): Promise<ImportedCredential> {
  const verified = issuedCompatibilityReceipts.get(receipt);
  if (verified === undefined) {
    throw new GwsEaError('onecli_canary_required', 'A successful OneCLI compatibility canary is required');
  }
  const { layout, apiKey } = verified;
  assertCredentialMetadata(input);
  const runCommand = dependencies.runCommand ?? runSanitizedCommand;
  const environment = buildOnecliCliEnvironment(layout, dependencies.ambientEnv, apiKey);
  await removePlaintextStagingFiles(layout);
  const secrets = parseArray(
    (await runOnecliCommand(layout, environment, ['secrets', 'list', '--max', '0'], runCommand)).stdout,
    'OneCLI secrets',
  );
  const matching = secrets.filter((candidate) => optionalString(candidate.name) === input.name);
  if (matching.length > 1) {
    throw new GwsEaError('ambiguous_onecli_secret', 'More than one OneCLI secret has the requested name');
  }
  if (matching.length === 1) {
    const existing = matching[0];
    if (!onecliSecretMatchesCredentialMetadata(existing, input)) {
      throw new GwsEaError('onecli_secret_conflict', 'An existing OneCLI secret has incompatible metadata');
    }
    return { id: stringField(existing, 'id', 'OneCLI secret', INVALID_OUTPUT), created: false };
  }

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
      (await runOnecliCommand(layout, environment, args, runCommand)).stdout,
      'OneCLI secret',
    );
    return { id: stringField(created, 'id', 'OneCLI secret', INVALID_OUTPUT), created: true };
  } finally {
    await removePrivateFile(layout.providerStagingFile);
  }
}

export async function persistOnecliApiKeyFiles(
  receipt: OnecliCompatibilityReceipt,
  files: OnecliApiKeyFiles,
): Promise<void> {
  const verified = issuedCompatibilityReceipts.get(receipt);
  if (verified === undefined) {
    throw new GwsEaError('onecli_canary_required', 'A successful OneCLI compatibility canary is required');
  }
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
  await dependencies.beforeBind?.();
  await dockerRunner({ ...up, env: composeEnvironment, timeoutMs: 120_000, stream: true });
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

export async function removeOnecliRuntime(
  layout: OnecliRuntimeLayout,
  dependencies: Pick<OnecliRuntimeDependencies, 'dockerCommandRunner' | 'runCommand' | 'ambientEnv'> = {},
): Promise<void> {
  const runner = dependencies.dockerCommandRunner ?? dependencies.runCommand ?? runSanitizedCommand;
  const environment = buildComposeEnvironment(dependencies.ambientEnv);
  const containers = await inspectProjectContainers(layout, runner, environment);
  for (const container of containers) {
    if (container.instanceId !== layout.instanceId || container.project !== layout.project) {
      throw new GwsEaError('unsafe_onecli_owner', 'OneCLI removal found a Docker resource owned by another instance');
    }
  }
  const namedResources = await assertOwnedOnecliNamedResources(layout, runner, environment);
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
  if ((await inspectProjectContainers(layout, runner, environment)).length > 0) {
    throw new GwsEaError('onecli_removal_incomplete', 'OneCLI containers remain after removal');
  }
  if ((await presentOnecliNamedResources(layout, runner, environment)).length > 0) {
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
  resource: NamedDockerResource,
  runner: OnecliCommandRunner,
  layout: OnecliRuntimeLayout,
  environment: Readonly<Record<string, string>>,
  labels: readonly string[] = [],
): Promise<boolean> {
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

async function presentOnecliNamedResources(
  layout: OnecliRuntimeLayout,
  runner: OnecliCommandRunner,
  environment: Readonly<Record<string, string>>,
): Promise<readonly NamedDockerResource[]> {
  const resources = onecliNamedResources(layout);
  const present = await Promise.all(
    resources.map(async (resource) => ({
      resource,
      present: await listNamedDockerResource(resource, runner, layout, environment),
    })),
  );
  return present.filter((entry) => entry.present).map((entry) => entry.resource);
}

async function assertOwnedOnecliNamedResources(
  layout: OnecliRuntimeLayout,
  runner: OnecliCommandRunner,
  environment: Readonly<Record<string, string>>,
): Promise<readonly NamedDockerResource[]> {
  const resources = await presentOnecliNamedResources(layout, runner, environment);
  const ownership = await Promise.all(
    resources.map(async (resource) => ({
      resource,
      owned: await listNamedDockerResource(resource, runner, layout, environment, [
        `${ONECLI_INSTANCE_LABEL}=${layout.instanceId}`,
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
        cwd: path.dirname(layout.rootDirectory),
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
      cwd: path.dirname(layout.rootDirectory),
      env: environment,
      timeoutMs: 30_000,
    }),
    runner({
      command: 'docker',
      args: ['volume', 'inspect', layout.postgresVolume, layout.appVolume],
      cwd: path.dirname(layout.rootDirectory),
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
    cwd: path.dirname(layout.rootDirectory),
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
    cwd: path.dirname(layout.rootDirectory),
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
      healthy: health?.Status === 'healthy',
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

function createDefaultSdkClient(layout: OnecliRuntimeLayout, apiKey: string): OnecliSdkClient {
  return new OneCLI({ url: layout.appUrl, apiKey });
}

async function runOnecliCommand(
  layout: OnecliRuntimeLayout,
  environment: Readonly<Record<string, string>>,
  args: readonly string[],
  runner: OnecliCommandRunner,
): Promise<OnecliCommandResult> {
  return runner({
    command: layout.cliExecutable,
    args,
    cwd: layout.rootDirectory,
    env: environment,
    timeoutMs: 30_000,
  });
}

async function removePlaintextStagingFiles(layout: OnecliRuntimeLayout): Promise<void> {
  await removePrivateFile(layout.providerStagingFile);
  await removePrivateFile(layout.canaryStagingFile);
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

function parseStringArray(source: string, label: string): readonly string[] {
  const parsed = unwrapData(parseJson(source, label, INVALID_OUTPUT));
  if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === 'string')) {
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

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function isExpectedGatewayProxy(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return url.protocol === 'http:' && url.hostname === 'host.docker.internal' && url.port === '10255';
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
