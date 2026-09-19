import { constants as fsConstants } from 'node:fs';
import { access, lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import { isErrno } from '../community-portal/errors.js';
import { renderLaunchdService, renderSystemdService } from '../service-definition.js';
import type { OnecliRuntimeLayout } from './onecli-compose.js';
import { preparePrivateLocalDirectory, assertPrivateLocalDirectory } from './paths.js';
import {
  buildAllowlistedEnvironment,
  replaceProcess,
  runSanitizedCommand,
  type SanitizedCommand,
  type SanitizedCommandResult,
  type SanitizedCommandRunner,
} from './process.js';
import { readOwnerOnlyFile, writePrivateTextFile } from './secrets.js';
import { assertInstanceId } from './registry.js';
import { GwsEaError, type AllocatedPorts, type InstanceReservation } from './types.js';
import { hasControlCharacters } from './validation.js';

export const INSTANCE_RUNTIME_SCHEMA_VERSION = 1 as const;
const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const ONECLI_PROJECT_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/u;
const SERVICE_PATH = '/usr/local/bin:/usr/bin:/bin';

export interface InstanceSecretFiles {
  readonly gchat_credentials: string;
  readonly onecli_runtime_api_key: string;
  readonly onecli_admin_api_key: string;
}

export interface InstanceRuntimeConfig {
  readonly schema_version: typeof INSTANCE_RUNTIME_SCHEMA_VERSION;
  readonly instance_id: string;
  readonly install_id: string;
  readonly deployed_commit: string;
  readonly checkout_realpath: string;
  readonly node_path: string;
  readonly home_directory: string;
  readonly allocated_ports: AllocatedPorts;
  readonly agent_egress_network: string;
  readonly onecli_project: string;
  readonly onecli_app_url: string;
  readonly onecli_gateway_url: string;
  readonly onecli_gateway_container: string;
  readonly onecli_cli_path: string;
  readonly selected_provider: string;
  readonly endpoint_url: string;
  readonly secret_files: InstanceSecretFiles;
}

export interface InstanceRuntimeInput {
  readonly nodePath: string;
  readonly homeDirectory: string;
  readonly selectedProvider: string;
}

export type InstanceServicePlatform = 'macos' | 'linux';

export interface InstanceServiceLayout {
  readonly manager: 'launchd' | 'systemd-system' | 'systemd-user';
  readonly serviceIdentity: string;
  readonly serviceDefinitionPath: string;
  readonly runtimeConfigFile: string;
  readonly environmentFile: string;
  readonly launcherEntrypoint: string;
  readonly hostEntrypoint: string;
  readonly cliPath: string;
  readonly cliSocket: string;
  readonly standardOutputPath: string;
  readonly standardErrorPath: string;
  readonly imageTag: string;
  readonly installLabel: string;
}

export interface ServiceLayoutOptions {
  readonly platform: InstanceServicePlatform;
  readonly homeDirectory: string;
  readonly runningAsRoot?: boolean;
}

export interface InstanceServiceDependencies extends ServiceLayoutOptions {
  readonly runCommand?: SanitizedCommandRunner;
  readonly uid?: number;
}

function assertControlFree(value: string, label: string): string {
  if (!value || hasControlCharacters(value)) {
    throw new GwsEaError('invalid_runtime_config', `${label} is invalid`);
  }
  return value;
}

function assertPort(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new GwsEaError('invalid_runtime_config', `${label} is invalid`);
  }
  return value;
}

function expectedSecretFiles(checkout: string): InstanceSecretFiles {
  const root = path.join(checkout, 'data', 'gws-ea', 'secrets');
  return {
    gchat_credentials: path.join(root, 'gchat-service-account.json'),
    onecli_runtime_api_key: path.join(root, 'onecli-runtime-api-key'),
    onecli_admin_api_key: path.join(root, 'onecli-admin-api-key'),
  };
}

function installId(instanceId: string): string {
  assertInstanceId(instanceId);
  return instanceId.replaceAll('-', '');
}

export function createInstanceRuntimeConfig(
  reservation: InstanceReservation,
  onecli: OnecliRuntimeLayout,
  input: InstanceRuntimeInput,
): InstanceRuntimeConfig {
  if (onecli.instanceId !== reservation.instance_id) {
    throw new GwsEaError('runtime_mismatch', 'OneCLI and NanoClaw instance identities disagree');
  }
  if (
    onecli.project !== reservation.exclusive_resource_claims.onecli_project ||
    onecli.appPort !== reservation.allocated_ports.onecli_app ||
    onecli.gatewayPort !== reservation.allocated_ports.onecli_gateway
  ) {
    throw new GwsEaError('runtime_mismatch', 'OneCLI coordinates disagree with the immutable reservation');
  }
  const checkout = path.resolve(reservation.checkout_realpath);
  const config: InstanceRuntimeConfig = {
    schema_version: INSTANCE_RUNTIME_SCHEMA_VERSION,
    instance_id: reservation.instance_id,
    install_id: installId(reservation.instance_id),
    deployed_commit: reservation.deployed_commit,
    checkout_realpath: checkout,
    node_path: path.resolve(input.nodePath),
    home_directory: path.resolve(input.homeDirectory),
    allocated_ports: { ...reservation.allocated_ports },
    agent_egress_network: onecli.agentEgressNetwork,
    onecli_project: onecli.project,
    onecli_app_url: onecli.appUrl,
    onecli_gateway_url: onecli.gatewayUrl,
    onecli_gateway_container: `${onecli.project}-gateway-1`,
    onecli_cli_path: onecli.cliExecutable,
    selected_provider: input.selectedProvider.toLowerCase(),
    endpoint_url: reservation.exclusive_resource_claims.endpoint_url,
    secret_files: expectedSecretFiles(checkout),
  };
  validateRuntimeConfig(config);
  return config;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new GwsEaError('invalid_runtime_config', `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, key: string): string {
  if (typeof value[key] !== 'string') throw new GwsEaError('invalid_runtime_config', `${key} is invalid`);
  return assertControlFree(value[key], key);
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new GwsEaError('invalid_runtime_config', `${label} contains unknown or missing fields`);
  }
}

export function validateRuntimeConfig(value: unknown): InstanceRuntimeConfig {
  const raw = record(value, 'Runtime config');
  assertExactKeys(
    raw,
    [
      'schema_version',
      'instance_id',
      'install_id',
      'deployed_commit',
      'checkout_realpath',
      'node_path',
      'home_directory',
      'allocated_ports',
      'agent_egress_network',
      'onecli_project',
      'onecli_app_url',
      'onecli_gateway_url',
      'onecli_gateway_container',
      'onecli_cli_path',
      'selected_provider',
      'endpoint_url',
      'secret_files',
    ],
    'Runtime config',
  );
  if (raw.schema_version !== INSTANCE_RUNTIME_SCHEMA_VERSION) {
    throw new GwsEaError('unsupported_runtime_config', 'Runtime config schema version is unsupported');
  }
  const instanceId = stringField(raw, 'instance_id');
  assertInstanceId(instanceId);
  const checkout = path.resolve(stringField(raw, 'checkout_realpath'));
  if (checkout !== stringField(raw, 'checkout_realpath')) {
    throw new GwsEaError('invalid_runtime_config', 'checkout_realpath must be absolute and normalized');
  }
  const portsRaw = record(raw.allocated_ports, 'allocated_ports');
  assertExactKeys(portsRaw, ['nanoclaw_webhook', 'onecli_app', 'onecli_gateway'], 'allocated_ports');
  const ports: AllocatedPorts = {
    nanoclaw_webhook: assertPort(portsRaw.nanoclaw_webhook, 'nanoclaw_webhook'),
    onecli_app: assertPort(portsRaw.onecli_app, 'onecli_app'),
    onecli_gateway: assertPort(portsRaw.onecli_gateway, 'onecli_gateway'),
  };
  if (new Set(Object.values(ports)).size !== 3) {
    throw new GwsEaError('invalid_runtime_config', 'Allocated ports must be distinct');
  }
  const project = stringField(raw, 'onecli_project');
  if (!ONECLI_PROJECT_PATTERN.test(project))
    throw new GwsEaError('invalid_runtime_config', 'onecli_project is invalid');
  const provider = stringField(raw, 'selected_provider');
  if (!PROVIDER_PATTERN.test(provider)) throw new GwsEaError('invalid_runtime_config', 'selected_provider is invalid');
  let endpoint: URL;
  try {
    endpoint = new URL(stringField(raw, 'endpoint_url'));
  } catch {
    throw new GwsEaError('invalid_runtime_config', 'endpoint_url is invalid');
  }
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== '/webhook/gchat'
  ) {
    throw new GwsEaError('invalid_runtime_config', 'endpoint_url is invalid');
  }
  const secretRaw = record(raw.secret_files, 'secret_files');
  assertExactKeys(secretRaw, ['gchat_credentials', 'onecli_runtime_api_key', 'onecli_admin_api_key'], 'secret_files');
  const secretFiles: InstanceSecretFiles = {
    gchat_credentials: stringField(secretRaw, 'gchat_credentials'),
    onecli_runtime_api_key: stringField(secretRaw, 'onecli_runtime_api_key'),
    onecli_admin_api_key: stringField(secretRaw, 'onecli_admin_api_key'),
  };
  const expectedSecrets = expectedSecretFiles(checkout);
  if (JSON.stringify(secretFiles) !== JSON.stringify(expectedSecrets)) {
    throw new GwsEaError('invalid_runtime_config', 'Secret files must stay in the instance-private secret directory');
  }
  const expectedInstallId = installId(instanceId);
  if (
    stringField(raw, 'install_id') !== expectedInstallId ||
    stringField(raw, 'onecli_app_url') !== `http://127.0.0.1:${ports.onecli_app}` ||
    stringField(raw, 'onecli_gateway_url') !== `http://127.0.0.1:${ports.onecli_gateway}` ||
    stringField(raw, 'agent_egress_network') !== `${project}-agent-egress` ||
    stringField(raw, 'onecli_gateway_container') !== `${project}-gateway-1`
  ) {
    throw new GwsEaError('runtime_mismatch', 'Runtime coordinates do not match the immutable instance identity');
  }
  const commit = stringField(raw, 'deployed_commit');
  if (!/^[0-9a-f]{40}$/u.test(commit)) throw new GwsEaError('invalid_runtime_config', 'deployed_commit is invalid');
  const nodePath = stringField(raw, 'node_path');
  const onecliCliPath = stringField(raw, 'onecli_cli_path');
  const homeDirectory = stringField(raw, 'home_directory');
  if (
    !path.isAbsolute(nodePath) ||
    path.resolve(nodePath) !== nodePath ||
    !path.isAbsolute(onecliCliPath) ||
    path.resolve(onecliCliPath) !== onecliCliPath ||
    !path.isAbsolute(homeDirectory) ||
    path.resolve(homeDirectory) !== homeDirectory
  ) {
    throw new GwsEaError('invalid_runtime_config', 'Runtime paths must be absolute and normalized');
  }
  return {
    schema_version: INSTANCE_RUNTIME_SCHEMA_VERSION,
    instance_id: instanceId,
    install_id: expectedInstallId,
    deployed_commit: commit,
    checkout_realpath: checkout,
    node_path: nodePath,
    home_directory: homeDirectory,
    allocated_ports: ports,
    agent_egress_network: `${project}-agent-egress`,
    onecli_project: project,
    onecli_app_url: `http://127.0.0.1:${ports.onecli_app}`,
    onecli_gateway_url: `http://127.0.0.1:${ports.onecli_gateway}`,
    onecli_gateway_container: `${project}-gateway-1`,
    onecli_cli_path: onecliCliPath,
    selected_provider: provider,
    endpoint_url: endpoint.href,
    secret_files: secretFiles,
  };
}

function runtimeConfigFile(config: InstanceRuntimeConfig): string {
  return path.join(config.checkout_realpath, 'data', 'gws-ea', 'runtime.json');
}

function environmentFileContents(config: InstanceRuntimeConfig): string {
  const values: Readonly<Record<string, string>> = {
    NANOCLAW_INSTALL_ID: config.install_id,
    DEFAULT_AGENT_PROVIDER: config.selected_provider,
    NANOCLAW_GATEWAY_PROVIDER: 'onecli',
    WEBHOOK_PORT: String(config.allocated_ports.nanoclaw_webhook),
    NANOCLAW_EGRESS_LOCKDOWN: 'true',
    NANOCLAW_EGRESS_NETWORK: config.agent_egress_network,
    ONECLI_GATEWAY_CONTAINER: config.onecli_gateway_container,
    ONECLI_URL: config.onecli_app_url,
    GCHAT_ENDPOINT_URL: config.endpoint_url,
  };
  return `${Object.entries(values)
    .map(([key, value]) => `${key}=${assertControlFree(value, key)}`)
    .join('\n')}\n`;
}

async function writeOrVerify(file: string, contents: string): Promise<void> {
  try {
    const existing = await readOwnerOnlyFile(file);
    if (existing !== contents) {
      throw new GwsEaError(
        'runtime_conflict',
        `Existing instance runtime file disagrees with reserved coordinates: ${file}`,
      );
    }
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error;
    await writePrivateTextFile(file, contents);
  }
}

export async function persistInstanceRuntime(configInput: InstanceRuntimeConfig): Promise<void> {
  const config = validateRuntimeConfig(configInput);
  const root = path.join(config.checkout_realpath, 'data', 'gws-ea');
  await preparePrivateLocalDirectory(root);
  await preparePrivateLocalDirectory(path.dirname(config.secret_files.gchat_credentials));
  await preparePrivateLocalDirectory(path.join(config.checkout_realpath, 'logs'));
  await writeOrVerify(runtimeConfigFile(config), `${JSON.stringify(config, null, 2)}\n`);
  await writeOrVerify(path.join(config.checkout_realpath, '.env'), environmentFileContents(config));
}

export async function loadInstanceRuntimeConfig(file: string): Promise<InstanceRuntimeConfig> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readOwnerOnlyFile(file)) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new GwsEaError('invalid_runtime_config', 'Runtime config is not valid JSON');
    throw error;
  }
  const config = validateRuntimeConfig(parsed);
  if (file !== runtimeConfigFile(config)) {
    throw new GwsEaError('runtime_mismatch', 'Runtime config path does not match the selected checkout');
  }
  return config;
}

export function createInstanceServiceLayout(
  configInput: InstanceRuntimeConfig,
  options: ServiceLayoutOptions,
): InstanceServiceLayout {
  const config = validateRuntimeConfig(configInput);
  if (path.resolve(options.homeDirectory) !== config.home_directory) {
    throw new GwsEaError('runtime_mismatch', 'Service home does not match the persisted runtime');
  }
  const isRoot = options.runningAsRoot ?? process.getuid?.() === 0;
  const serviceIdentity =
    options.platform === 'macos' ? `com.nanoclaw-v2-${config.install_id}` : `nanoclaw-v2-${config.install_id}`;
  const manager = options.platform === 'macos' ? 'launchd' : isRoot ? 'systemd-system' : 'systemd-user';
  const serviceDefinitionPath =
    manager === 'launchd'
      ? path.join(config.home_directory, 'Library', 'LaunchAgents', `${serviceIdentity}.plist`)
      : manager === 'systemd-system'
        ? path.join('/etc/systemd/system', `${serviceIdentity}.service`)
        : path.join(config.home_directory, '.config', 'systemd', 'user', `${serviceIdentity}.service`);
  return {
    manager,
    serviceIdentity,
    serviceDefinitionPath,
    runtimeConfigFile: runtimeConfigFile(config),
    environmentFile: path.join(config.checkout_realpath, '.env'),
    launcherEntrypoint: path.join(config.checkout_realpath, 'dist', 'gws-ea', 'process.js'),
    hostEntrypoint: path.join(config.checkout_realpath, 'dist', 'index.js'),
    cliPath: path.join(config.checkout_realpath, 'bin', 'ncl'),
    cliSocket: path.join(config.checkout_realpath, 'data', 'ncl.sock'),
    standardOutputPath: path.join(config.checkout_realpath, 'logs', 'nanoclaw.log'),
    standardErrorPath: path.join(config.checkout_realpath, 'logs', 'nanoclaw.error.log'),
    imageTag: `nanoclaw-agent-v2-${config.install_id}:latest`,
    installLabel: `nanoclaw-install=${config.install_id}`,
  };
}

function serviceEnvironment(config: InstanceRuntimeConfig): Readonly<Record<string, string>> {
  return {
    HOME: config.home_directory,
    PATH: `${SERVICE_PATH}:${path.join(config.home_directory, '.local', 'bin')}`,
  };
}

function renderInstanceService(config: InstanceRuntimeConfig, layout: InstanceServiceLayout): string {
  const input = {
    programArguments: [config.node_path, layout.launcherEntrypoint, 'launch-host', layout.runtimeConfigFile],
    workingDirectory: config.checkout_realpath,
    environment: serviceEnvironment(config),
    standardOutputPath: layout.standardOutputPath,
    standardErrorPath: layout.standardErrorPath,
  };
  return layout.manager === 'launchd'
    ? renderLaunchdService({ ...input, label: layout.serviceIdentity })
    : renderSystemdService({
        ...input,
        wantedBy: layout.manager === 'systemd-system' ? 'multi-user.target' : 'default.target',
      });
}

async function assertRegularFile(file: string): Promise<void> {
  const info = await lstat(file);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new GwsEaError('unsafe_runtime', `Runtime executable must be a regular non-symlink file: ${file}`);
  }
}

async function assertExecutable(file: string): Promise<void> {
  await assertRegularFile(file);
  await access(file, fsConstants.X_OK);
}

export async function reconcileInstanceService(
  configInput: InstanceRuntimeConfig,
  dependencies: InstanceServiceDependencies,
): Promise<InstanceServiceLayout> {
  const config = validateRuntimeConfig(configInput);
  const layout = createInstanceServiceLayout(config, dependencies);
  await Promise.all([
    assertRegularFile(layout.launcherEntrypoint),
    assertRegularFile(layout.hostEntrypoint),
    assertExecutable(layout.cliPath),
  ]);
  await mkdir(path.dirname(layout.serviceDefinitionPath), { recursive: true, mode: 0o700 });
  await writePrivateTextFile(layout.serviceDefinitionPath, renderInstanceService(config, layout));
  const run = dependencies.runCommand ?? runSanitizedCommand;
  const environment = buildAllowlistedEnvironment({}, serviceEnvironment(config));
  const command = async (program: string, args: readonly string[]): Promise<void> => {
    await run({ command: program, args, cwd: config.checkout_realpath, env: environment, timeoutMs: 30_000 });
  };
  if (layout.manager === 'launchd') {
    await command('launchctl', ['unload', layout.serviceDefinitionPath]).catch(() => undefined);
    await command('launchctl', ['load', layout.serviceDefinitionPath]);
    const uid = dependencies.uid ?? process.getuid?.();
    if (uid === undefined) throw new GwsEaError('unsupported_platform', 'launchd requires a user ID');
    const domain = `gui/${uid}/${layout.serviceIdentity}`;
    await command('launchctl', ['kickstart', '-k', domain]);
    await command('launchctl', ['print', domain]);
  } else {
    const prefix = layout.manager === 'systemd-user' ? ['--user'] : [];
    await command('systemctl', [...prefix, 'daemon-reload']);
    await command('systemctl', [...prefix, 'enable', layout.serviceIdentity]);
    await command('systemctl', [...prefix, 'restart', layout.serviceIdentity]);
    await command('systemctl', [...prefix, 'is-active', layout.serviceIdentity]);
  }
  return layout;
}

export function buildInstanceCliCommand(
  configInput: InstanceRuntimeConfig,
  args: readonly string[],
  ambient: NodeJS.ProcessEnv = process.env,
): SanitizedCommand {
  const config = validateRuntimeConfig(configInput);
  const layout = createInstanceServiceLayout(config, {
    platform: process.platform === 'darwin' ? 'macos' : 'linux',
    homeDirectory: config.home_directory,
  });
  return {
    command: layout.cliPath,
    args,
    cwd: config.checkout_realpath,
    env: buildAllowlistedEnvironment(ambient, {
      HOME: config.home_directory,
      NANOCLAW_INSTALL_ID: config.install_id,
    }),
  };
}

export async function buildInstanceHostEnvironment(
  configInput: InstanceRuntimeConfig,
  ambient: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, string>> {
  const config = validateRuntimeConfig(configInput);
  await assertPrivateLocalDirectory(path.dirname(config.secret_files.gchat_credentials));
  const [gchatCredentials, onecliRuntimeApiKey] = await Promise.all([
    readOwnerOnlyFile(config.secret_files.gchat_credentials),
    readOwnerOnlyFile(config.secret_files.onecli_runtime_api_key),
  ]);
  if (!gchatCredentials.trim() || !onecliRuntimeApiKey.trim()) {
    throw new GwsEaError('invalid_secret', 'A required instance host credential is empty');
  }
  return buildAllowlistedEnvironment(ambient, {
    HOME: config.home_directory,
    NANOCLAW_INSTALL_ID: config.install_id,
    DEFAULT_AGENT_PROVIDER: config.selected_provider,
    NANOCLAW_GATEWAY_PROVIDER: 'onecli',
    WEBHOOK_PORT: String(config.allocated_ports.nanoclaw_webhook),
    NANOCLAW_EGRESS_LOCKDOWN: 'true',
    NANOCLAW_EGRESS_NETWORK: config.agent_egress_network,
    ONECLI_GATEWAY_CONTAINER: config.onecli_gateway_container,
    ONECLI_URL: config.onecli_app_url,
    ONECLI_API_KEY: onecliRuntimeApiKey.trim(),
    GCHAT_CREDENTIALS: gchatCredentials,
    GCHAT_ENDPOINT_URL: config.endpoint_url,
  });
}

export async function runInstanceOnecliAdminCommand(
  configInput: InstanceRuntimeConfig,
  args: readonly string[],
  dependencies: { readonly runCommand?: SanitizedCommandRunner; readonly ambientEnv?: NodeJS.ProcessEnv } = {},
): Promise<SanitizedCommandResult> {
  const config = validateRuntimeConfig(configInput);
  const apiKey = (await readOwnerOnlyFile(config.secret_files.onecli_admin_api_key)).trim();
  if (!apiKey) throw new GwsEaError('invalid_secret', 'The OneCLI administrative credential is empty');
  await assertExecutable(config.onecli_cli_path);
  const run = dependencies.runCommand ?? runSanitizedCommand;
  return run({
    command: config.onecli_cli_path,
    args,
    cwd: config.checkout_realpath,
    env: buildAllowlistedEnvironment(dependencies.ambientEnv, {
      HOME: path.join(path.dirname(config.checkout_realpath), 'onecli', 'cli-home'),
      ONECLI_API_HOST: config.onecli_app_url,
      ONECLI_API_KEY: apiKey,
    }),
    timeoutMs: 30_000,
  });
}

export async function launchInstanceHost(
  configFile: string,
  ambient: NodeJS.ProcessEnv = process.env,
  execve: NonNullable<NodeJS.Process['execve']> | undefined = process.execve,
): Promise<never> {
  const config = await loadInstanceRuntimeConfig(path.resolve(configFile));
  if ((await realpath(config.checkout_realpath)) !== config.checkout_realpath) {
    throw new GwsEaError('unsafe_runtime', 'The instance checkout is not the persisted physical path');
  }
  const layout = createInstanceServiceLayout(config, {
    platform: process.platform === 'darwin' ? 'macos' : 'linux',
    homeDirectory: config.home_directory,
  });
  await Promise.all([assertExecutable(config.node_path), assertRegularFile(layout.hostEntrypoint)]);
  const environment = await buildInstanceHostEnvironment(config, ambient);
  process.chdir(config.checkout_realpath);
  return replaceProcess(config.node_path, [config.node_path, layout.hostEntrypoint], environment, execve);
}

export async function reconcileInstanceRuntime(
  configInput: InstanceRuntimeConfig,
  dependencies: InstanceServiceDependencies,
): Promise<InstanceServiceLayout> {
  const config = validateRuntimeConfig(configInput);
  await persistInstanceRuntime(config);
  const run = dependencies.runCommand ?? runSanitizedCommand;
  const environment = buildAllowlistedEnvironment(
    {},
    {
      HOME: config.home_directory,
      PATH: `${SERVICE_PATH}:${path.join(config.home_directory, '.local', 'bin')}`,
      NANOCLAW_INSTALL_ID: config.install_id,
    },
  );
  const packageManifest = JSON.parse(await readFile(path.join(config.checkout_realpath, 'package.json'), 'utf8')) as {
    version?: unknown;
  };
  if (typeof packageManifest.version !== 'string' || !packageManifest.version) {
    throw new GwsEaError('invalid_release', 'The selected checkout package version is invalid');
  }
  await run({
    command: 'pnpm',
    args: ['exec', 'tsx', 'scripts/upgrade-state.ts', 'set', packageManifest.version, 'gws-ea'],
    cwd: config.checkout_realpath,
    env: environment,
    timeoutMs: 30_000,
  });
  await run({
    command: 'pnpm',
    args: ['exec', 'tsx', 'setup/index.ts', '--step', 'container'],
    cwd: config.checkout_realpath,
    env: environment,
    timeoutMs: 15 * 60_000,
  });
  return reconcileInstanceService(config, dependencies);
}
