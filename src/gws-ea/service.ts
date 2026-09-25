import { constants as fsConstants } from 'node:fs';
import { access, lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { userInfo } from 'node:os';
import path from 'node:path';

import { isErrno } from '../community-portal/errors.js';
import { renderLaunchdService, renderSystemdService } from '../service-definition.js';
import type { OnecliRuntimeLayout } from './onecli-compose.js';
import { preparePrivateDirectory, assertPrivateDirectory } from './paths.js';
import {
  buildHostEnvironment,
  buildToolEnvironment,
  replaceProcess,
  runSanitizedCommand,
  type SanitizedCommand,
  type SanitizedCommandResult,
  type SanitizedCommandRunner,
} from './process.js';
import { activeStep } from './run-log.js';
import { readOwnerOnlyFile, readOwnerOnlyJson, writePrivateTextFile } from './secrets.js';
import {
  createInstanceServiceCoordinates,
  instanceServicePlatform,
  type InstanceServicePlatform,
} from './service-coordinates.js';
import { validateExistingGchatEndpoint } from './endpoint.js';
import { deriveWorkspaceAddOnIdentity, parseGcpProjectNumber } from './gcp-identity.js';
import { assertInstanceId } from './registry.js';
import { GwsEaError, ingressEndpointUrl, type AllocatedPorts, type InstanceReservation } from './types.js';
import { parseJson, requireDockerEndpoint, requirePath, requireRecord, requireString } from './validation.js';

export const INSTANCE_RUNTIME_SCHEMA_VERSION = 1 as const;
const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const ONECLI_PROJECT_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/u;
const SERVICE_PATH = '/usr/local/bin:/usr/bin:/bin';
const INVALID_RUNTIME = 'invalid_runtime_config';

export interface InstanceSecretFiles {
  readonly gchat_credentials: string;
  readonly onecli_runtime_api_key: string;
  readonly onecli_admin_api_key: string;
}

/**
 * What `runtime.json` stores: the values nothing else determines, plus the
 * local Docker endpoint create resolved. Everything derivable from
 * them is recomputed on every read, so it can never disagree with them.
 */
export interface PersistedInstanceRuntime {
  readonly schema_version: typeof INSTANCE_RUNTIME_SCHEMA_VERSION;
  readonly instance_id: string;
  readonly deployed_commit: string;
  readonly checkout_realpath: string;
  readonly node_path: string;
  readonly home_directory: string;
  readonly allocated_ports: AllocatedPorts;
  readonly onecli_project: string;
  readonly onecli_cli_path: string;
  readonly selected_provider: string;
  readonly endpoint_url: string;
  readonly docker_endpoint: string;
}

export interface InstanceRuntimeConfig extends PersistedInstanceRuntime {
  readonly install_id: string;
  readonly agent_egress_network: string;
  readonly onecli_app_url: string;
  readonly onecli_gateway_url: string;
  readonly onecli_gateway_container: string;
  readonly secret_files: InstanceSecretFiles;
}

export interface InstanceRuntimeInput {
  readonly nodePath: string;
  readonly homeDirectory: string;
  readonly selectedProvider: string;
  readonly dockerEndpoint: string;
}

/**
 * Upstream `setup/set-env.ts` `upsertEnvVars`, injected by the driver because
 * `src/` cannot import `setup/`: it rewrites only the given keys of a
 * checkout's `.env`, atomically, keeping every other writer's keys.
 */
export type UpsertEnvVars = (values: Record<string, string>, projectRoot: string) => unknown;

/** The options upstream `waitForHost` takes that gws-ea uses. */
export interface WaitForHostOptions {
  readonly channel?: string;
  readonly pid?: number;
  readonly alive?: () => boolean;
  readonly timeoutMs?: number;
}

/**
 * Upstream `setup/lib/host-status.mjs`, injected by the driver because `src/`
 * cannot import `setup/`. `queryHost` asks a checkout's running host for its
 * status over `data/ncl.sock` and throws unless the host identifies that
 * checkout; `waitForHost` polls it until the host (and a channel) is ready and
 * throws the last reason, naming the checkout-relative `logs/nanoclaw.error.log`.
 */
export interface HostStatusHelpers {
  readonly queryHost: (root: string, timeoutMs?: number) => Promise<unknown>;
  readonly waitForHost: (root: string, options?: WaitForHostOptions) => Promise<unknown>;
}

export type { InstanceServicePlatform } from './service-coordinates.js';

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
  /** Where the user-bus variables are read; absent ones are derived from the UID. */
  readonly ambientEnv?: NodeJS.ProcessEnv;
}

/** A (re)started service, with the pid its manager reports when it has one. */
export interface InstanceServiceStart {
  readonly layout: InstanceServiceLayout;
  readonly pid: number | undefined;
}

export interface InstanceRuntimeDependencies extends InstanceServiceDependencies {
  readonly upsertEnvVars: UpsertEnvVars;
}

function assertPort(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new GwsEaError(INVALID_RUNTIME, `${label} is invalid`);
  }
  return value;
}

function expectedSecretFiles(checkout: string): InstanceSecretFiles {
  const root = path.join(path.dirname(checkout), 'secrets');
  return {
    gchat_credentials: path.join(root, 'gchat-service-account.json'),
    onecli_runtime_api_key: path.join(root, 'onecli-runtime-api-key'),
    onecli_admin_api_key: path.join(root, 'onecli-admin-api-key'),
  };
}

export function googleChatProjectNumberFile(config: Pick<InstanceRuntimeConfig, 'secret_files'>): string {
  return path.join(path.dirname(config.secret_files.gchat_credentials), 'gchat-project-number');
}

function installId(instanceId: string): string {
  assertInstanceId(instanceId);
  return instanceId.replaceAll('-', '');
}

function deriveRuntime(persisted: PersistedInstanceRuntime): InstanceRuntimeConfig {
  const project = persisted.onecli_project;
  return {
    ...persisted,
    install_id: installId(persisted.instance_id),
    agent_egress_network: `${project}-agent-egress`,
    onecli_app_url: `http://127.0.0.1:${persisted.allocated_ports.onecli_app}`,
    onecli_gateway_url: `http://127.0.0.1:${persisted.allocated_ports.onecli_gateway}`,
    onecli_gateway_container: `${project}-gateway-1`,
    secret_files: expectedSecretFiles(persisted.checkout_realpath),
  };
}

function persistedRuntime(config: PersistedInstanceRuntime): PersistedInstanceRuntime {
  return {
    schema_version: config.schema_version,
    instance_id: config.instance_id,
    deployed_commit: config.deployed_commit,
    checkout_realpath: config.checkout_realpath,
    node_path: config.node_path,
    home_directory: config.home_directory,
    allocated_ports: config.allocated_ports,
    onecli_project: config.onecli_project,
    onecli_cli_path: config.onecli_cli_path,
    selected_provider: config.selected_provider,
    endpoint_url: config.endpoint_url,
    docker_endpoint: config.docker_endpoint,
  };
}

function runtimeFileContents(config: InstanceRuntimeConfig): string {
  return `${JSON.stringify(persistedRuntime(config), null, 2)}\n`;
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
  return validateRuntimeConfig({
    schema_version: INSTANCE_RUNTIME_SCHEMA_VERSION,
    instance_id: reservation.instance_id,
    deployed_commit: reservation.deployed_commit,
    checkout_realpath: path.resolve(reservation.checkout_realpath),
    node_path: path.resolve(input.nodePath),
    home_directory: path.resolve(input.homeDirectory),
    allocated_ports: { ...reservation.allocated_ports },
    onecli_project: onecli.project,
    onecli_cli_path: onecli.cliExecutable,
    selected_provider: input.selectedProvider.toLowerCase(),
    endpoint_url: ingressEndpointUrl(reservation.exclusive_resource_claims.ingress),
    docker_endpoint: input.dockerEndpoint,
  } satisfies PersistedInstanceRuntime);
}

/** Read the persisted values, ignoring any other field, and recompute the derived ones. */
export function validateRuntimeConfig(value: unknown): InstanceRuntimeConfig {
  const raw = requireRecord(value, 'Runtime config', INVALID_RUNTIME);
  if (raw.schema_version !== INSTANCE_RUNTIME_SCHEMA_VERSION) {
    throw new GwsEaError('unsupported_runtime_config', 'Runtime config schema version is unsupported');
  }
  const instanceId = requireString(raw.instance_id, 'instance_id', INVALID_RUNTIME);
  assertInstanceId(instanceId);
  const portsRaw = requireRecord(raw.allocated_ports, 'allocated_ports', INVALID_RUNTIME);
  const ports: AllocatedPorts = {
    nanoclaw_webhook: assertPort(portsRaw.nanoclaw_webhook, 'nanoclaw_webhook'),
    onecli_app: assertPort(portsRaw.onecli_app, 'onecli_app'),
    onecli_gateway: assertPort(portsRaw.onecli_gateway, 'onecli_gateway'),
  };
  if (new Set(Object.values(ports)).size !== 3) {
    throw new GwsEaError(INVALID_RUNTIME, 'Allocated ports must be distinct');
  }
  const project = requireString(raw.onecli_project, 'onecli_project', INVALID_RUNTIME);
  if (!ONECLI_PROJECT_PATTERN.test(project)) throw new GwsEaError(INVALID_RUNTIME, 'onecli_project is invalid');
  const provider = requireString(raw.selected_provider, 'selected_provider', INVALID_RUNTIME);
  if (!PROVIDER_PATTERN.test(provider)) throw new GwsEaError(INVALID_RUNTIME, 'selected_provider is invalid');
  let endpointUrl: string;
  try {
    endpointUrl = validateExistingGchatEndpoint(requireString(raw.endpoint_url, 'endpoint_url', INVALID_RUNTIME));
  } catch {
    throw new GwsEaError(INVALID_RUNTIME, 'endpoint_url is invalid');
  }
  const commit = requireString(raw.deployed_commit, 'deployed_commit', INVALID_RUNTIME);
  if (!/^[0-9a-f]{40}$/u.test(commit)) throw new GwsEaError(INVALID_RUNTIME, 'deployed_commit is invalid');
  return deriveRuntime({
    schema_version: INSTANCE_RUNTIME_SCHEMA_VERSION,
    instance_id: instanceId,
    deployed_commit: commit,
    checkout_realpath: requirePath(raw.checkout_realpath, 'checkout_realpath', INVALID_RUNTIME),
    node_path: requirePath(raw.node_path, 'node_path', INVALID_RUNTIME),
    home_directory: requirePath(raw.home_directory, 'home_directory', INVALID_RUNTIME),
    allocated_ports: ports,
    onecli_project: project,
    onecli_cli_path: requirePath(raw.onecli_cli_path, 'onecli_cli_path', INVALID_RUNTIME),
    selected_provider: provider,
    endpoint_url: endpointUrl,
    docker_endpoint: requireDockerEndpoint(raw.docker_endpoint, 'docker_endpoint', INVALID_RUNTIME),
  });
}

function runtimeConfigFile(config: InstanceRuntimeConfig): string {
  return path.join(config.checkout_realpath, 'data', 'gws-ea', 'runtime.json');
}

/** The `.env` keys gws-ea owns; every other key belongs to another writer. */
function instanceHostConfiguration(config: InstanceRuntimeConfig): Readonly<Record<string, string>> {
  return {
    NANOCLAW_INSTALL_ID: config.install_id,
    DEFAULT_AGENT_PROVIDER: config.selected_provider,
    NANOCLAW_GATEWAY_PROVIDER: 'onecli',
    WEBHOOK_PORT: String(config.allocated_ports.nanoclaw_webhook),
    WEBHOOK_HOST: '127.0.0.1',
    NANOCLAW_EGRESS_LOCKDOWN: 'true',
    NANOCLAW_EGRESS_NETWORK: config.agent_egress_network,
    ONECLI_GATEWAY_CONTAINER: config.onecli_gateway_container,
    ONECLI_URL: config.onecli_app_url,
    GCHAT_ENDPOINT_URL: config.endpoint_url,
  };
}

/**
 * Write `runtime.json` once. A later run leaves the file as it is when its
 * persisted values agree, so fields another launcher added survive, and
 * refuses when they disagree.
 */
async function persistRuntimeFile(config: InstanceRuntimeConfig): Promise<void> {
  const file = runtimeConfigFile(config);
  let existing: InstanceRuntimeConfig;
  try {
    existing = await loadInstanceRuntimeConfig(file);
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error;
    await writePrivateTextFile(file, runtimeFileContents(config));
    return;
  }
  if (runtimeFileContents(existing) !== runtimeFileContents(config)) {
    throw new GwsEaError(
      'runtime_conflict',
      `Existing instance runtime file disagrees with reserved coordinates: ${file}`,
    );
  }
}

export async function persistInstanceRuntime(
  configInput: InstanceRuntimeConfig,
  upsertEnvVars: UpsertEnvVars,
): Promise<void> {
  const config = validateRuntimeConfig(configInput);
  const root = path.join(config.checkout_realpath, 'data', 'gws-ea');
  await preparePrivateDirectory(root);
  await preparePrivateDirectory(path.dirname(config.secret_files.gchat_credentials));
  await preparePrivateDirectory(path.join(config.checkout_realpath, 'logs'));
  await persistRuntimeFile(config);
  const owned = instanceHostConfiguration(config);
  upsertEnvVars({ ...owned }, config.checkout_realpath);
  activeStep()?.envFile(
    path.join(config.checkout_realpath, '.env'),
    Object.entries(owned)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(''),
  );
}

export async function loadInstanceRuntimeConfig(file: string): Promise<InstanceRuntimeConfig> {
  const config = validateRuntimeConfig(await readOwnerOnlyJson(file, 'Runtime config', INVALID_RUNTIME));
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
  const coordinates = createInstanceServiceCoordinates({
    installId: config.install_id,
    homeDirectory: config.home_directory,
    platform: options.platform,
    runningAsRoot: options.runningAsRoot ?? process.getuid?.() === 0,
  });
  return {
    ...coordinates,
    runtimeConfigFile: runtimeConfigFile(config),
    environmentFile: path.join(config.checkout_realpath, '.env'),
    launcherEntrypoint: path.join(config.checkout_realpath, 'dist', 'gws-ea', 'process.js'),
    hostEntrypoint: path.join(config.checkout_realpath, 'dist', 'index.js'),
    cliPath: path.join(config.checkout_realpath, 'bin', 'ncl'),
    cliSocket: path.join(config.checkout_realpath, 'data', 'ncl.sock'),
    standardOutputPath: path.join(config.checkout_realpath, 'logs', 'nanoclaw.log'),
    standardErrorPath: path.join(config.checkout_realpath, 'logs', 'nanoclaw.error.log'),
  };
}

/** The runtime values a service manager's environment derives from. */
export type ServiceManagerRuntime = Pick<PersistedInstanceRuntime, 'home_directory' | 'docker_endpoint'>;

/** What the service manager starts the launcher with, and what the image build runs under. */
function serviceEnvironment(config: ServiceManagerRuntime): Readonly<Record<string, string>> {
  return {
    HOME: config.home_directory,
    PATH: `${SERVICE_PATH}:${path.join(config.home_directory, '.local', 'bin')}`,
    DOCKER_HOST: config.docker_endpoint,
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

function requireUid(dependencies: Pick<InstanceServiceDependencies, 'uid'>): number {
  const uid = dependencies.uid ?? process.getuid?.();
  if (uid === undefined) throw new GwsEaError('unsupported_platform', 'The service manager requires a user ID');
  return uid;
}

/**
 * The environment `launchctl`, `systemctl`, and `loginctl` run with. A user
 * service manager is reached over the user bus, so `systemctl --user` gets
 * `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS`, derived from the UID when
 * the caller has none (a non-login shell, sudo, cron).
 */
export function serviceManagerEnvironment(
  config: ServiceManagerRuntime,
  manager: InstanceServiceLayout['manager'],
  dependencies: Pick<InstanceServiceDependencies, 'uid' | 'ambientEnv'>,
): Readonly<Record<string, string>> {
  if (manager !== 'systemd-user') return buildToolEnvironment({}, serviceEnvironment(config));
  const ambient = dependencies.ambientEnv ?? process.env;
  const runtimeDirectory = ambient.XDG_RUNTIME_DIR || `/run/user/${requireUid(dependencies)}`;
  return buildToolEnvironment(
    {},
    {
      ...serviceEnvironment(config),
      XDG_RUNTIME_DIR: runtimeDirectory,
      DBUS_SESSION_BUS_ADDRESS: ambient.DBUS_SESSION_BUS_ADDRESS || `unix:path=${runtimeDirectory}/bus`,
    },
  );
}

function servicePid(value: string | undefined): number | undefined {
  const pid = Number(value?.trim());
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

/** `launchctl bootout` of a job that is not loaded fails in launchd's own words; nothing needed stopping. */
function notLoaded(error: unknown): boolean {
  return (
    error instanceof GwsEaError &&
    error.code === 'command_failed' &&
    /No such process|Could not find/iu.test(String(error.details?.stderrTail ?? ''))
  );
}

/**
 * Lingering keeps a user's services running after logout. Enabling it
 * for oneself needs no password where polkit allows it, so it is enabled
 * here, once; where it is refused, the operator gets the one command to run.
 */
async function ensureLingering(
  command: (program: string, args: readonly string[]) => Promise<string>,
  dependencies: InstanceServiceDependencies,
): Promise<void> {
  const uid = String(requireUid(dependencies));
  const lingering = await command('loginctl', ['show-user', uid, '--property', 'Linger', '--value']).then(
    (value) => value.trim() === 'yes',
    () => false,
  );
  if (lingering) return;
  await command('loginctl', ['enable-linger']).catch((error: unknown) => {
    const user = (dependencies.ambientEnv ?? process.env).USER || userInfo().username;
    throw new GwsEaError(
      'linger_required',
      `Could not enable lingering, so this assistant would stop at logout. Run: sudo loginctl enable-linger ${user}, then resume.`,
      { cause: error },
    );
  });
}

/**
 * Write the service definition and (re)start it. launchd reloads a changed
 * definition only through `bootout` then `bootstrap`; `kickstart` without
 * `-k` then demand-starts a job launchd left pended, without restarting a
 * running one. systemd user services need lingering to survive logout.
 */
export async function reconcileInstanceService(
  configInput: InstanceRuntimeConfig,
  dependencies: InstanceServiceDependencies,
): Promise<InstanceServiceStart> {
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
  const environment = serviceManagerEnvironment(config, layout.manager, dependencies);
  const command = async (program: string, args: readonly string[]): Promise<string> =>
    (await run({ command: program, args, cwd: config.checkout_realpath, env: environment, timeoutMs: 30_000 })).stdout;
  if (layout.manager === 'launchd') {
    const domain = `gui/${requireUid(dependencies)}`;
    await command('launchctl', ['bootout', `${domain}/${layout.serviceIdentity}`]).catch((error: unknown) => {
      if (!notLoaded(error)) throw error;
    });
    await command('launchctl', ['bootstrap', domain, layout.serviceDefinitionPath]);
    await command('launchctl', ['kickstart', `${domain}/${layout.serviceIdentity}`]);
  } else {
    const prefix = layout.manager === 'systemd-user' ? ['--user'] : [];
    if (layout.manager === 'systemd-user') await ensureLingering(command, dependencies);
    await command('systemctl', [...prefix, 'daemon-reload']);
    await command('systemctl', [...prefix, 'enable', layout.serviceIdentity]);
    await command('systemctl', [...prefix, 'restart', layout.serviceIdentity]);
  }
  return { layout, pid: await instanceServicePid(config, dependencies) };
}

/**
 * The pid of the instance's service process, or undefined when its manager
 * runs none (not loaded, stopped, or waiting to restart). Liveness uses it to
 * tell a host that is starting from one that is stopped.
 */
export async function instanceServicePid(
  configInput: InstanceRuntimeConfig,
  dependencies: InstanceServiceDependencies,
): Promise<number | undefined> {
  const config = validateRuntimeConfig(configInput);
  const layout = createInstanceServiceLayout(config, dependencies);
  const run = dependencies.runCommand ?? runSanitizedCommand;
  const args =
    layout.manager === 'launchd'
      ? ['print', `gui/${requireUid(dependencies)}/${layout.serviceIdentity}`]
      : [
          ...(layout.manager === 'systemd-user' ? ['--user'] : []),
          'show',
          layout.serviceIdentity,
          '--property',
          'MainPID',
          '--value',
        ];
  let stdout: string;
  try {
    ({ stdout } = await run({
      command: layout.manager === 'launchd' ? 'launchctl' : 'systemctl',
      args,
      cwd: config.checkout_realpath,
      env: serviceManagerEnvironment(config, layout.manager, dependencies),
      timeoutMs: 30_000,
    }));
  } catch (error) {
    // A manager that cannot report the service runs no process for it; starting it surfaces why.
    if (error instanceof GwsEaError && error.code === 'command_failed') return undefined;
    throw error;
  }
  return servicePid(layout.manager === 'launchd' ? /^\s*pid = (\d+)\s*$/mu.exec(stdout)?.[1] : stdout);
}

export function buildInstanceCliCommand(
  configInput: InstanceRuntimeConfig,
  args: readonly string[],
  ambient: NodeJS.ProcessEnv = process.env,
): SanitizedCommand {
  const config = validateRuntimeConfig(configInput);
  const layout = createInstanceServiceLayout(config, {
    platform: instanceServicePlatform(),
    homeDirectory: config.home_directory,
  });
  return {
    command: layout.cliPath,
    args,
    cwd: config.checkout_realpath,
    env: buildToolEnvironment(ambient, {
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
  await assertPrivateDirectory(path.dirname(config.secret_files.gchat_credentials));
  const [gchatCredentials, onecliRuntimeApiKey, projectNumberFile] = await Promise.all([
    readOwnerOnlyFile(config.secret_files.gchat_credentials),
    readOwnerOnlyFile(config.secret_files.onecli_runtime_api_key),
    readOwnerOnlyFile(googleChatProjectNumberFile(config)),
  ]);
  if (!gchatCredentials.trim() || !onecliRuntimeApiKey.trim()) {
    throw new GwsEaError('invalid_secret', 'A required instance host credential is empty');
  }
  const projectNumber = parseGcpProjectNumber(projectNumberFile.trim());
  if (!projectNumber) throw new GwsEaError('invalid_runtime_config', 'Google Chat project number is invalid');
  return buildHostEnvironment(ambient, {
    HOME: config.home_directory,
    DOCKER_HOST: config.docker_endpoint,
    ...instanceHostConfiguration(config),
    ONECLI_API_KEY: onecliRuntimeApiKey.trim(),
    GCHAT_CREDENTIALS: gchatCredentials,
    GCHAT_WORKSPACE_ADDON_SERVICE_ACCOUNT_EMAIL: deriveWorkspaceAddOnIdentity(projectNumber),
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
    env: buildToolEnvironment(dependencies.ambientEnv, {
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
    platform: instanceServicePlatform(),
    homeDirectory: config.home_directory,
  });
  await Promise.all([assertExecutable(config.node_path), assertRegularFile(layout.hostEntrypoint)]);
  const environment = await buildInstanceHostEnvironment(config, ambient);
  process.chdir(config.checkout_realpath);
  return replaceProcess(config.node_path, [config.node_path, layout.hostEntrypoint], environment, execve);
}

export async function reconcileInstanceRuntime(
  configInput: InstanceRuntimeConfig,
  dependencies: InstanceRuntimeDependencies,
): Promise<InstanceServiceStart> {
  const config = validateRuntimeConfig(configInput);
  await persistInstanceRuntime(config, dependencies.upsertEnvVars);
  const run = dependencies.runCommand ?? runSanitizedCommand;
  const environment = buildToolEnvironment(
    {},
    { ...serviceEnvironment(config), NANOCLAW_INSTALL_ID: config.install_id },
  );
  const packageManifest = requireRecord(
    parseJson(
      await readFile(path.join(config.checkout_realpath, 'package.json'), 'utf8'),
      'The selected checkout package.json',
      'invalid_release',
    ),
    'The selected checkout package.json',
    'invalid_release',
  );
  const version = requireString(packageManifest.version, 'The selected checkout package version', 'invalid_release');
  await run({
    command: 'pnpm',
    args: ['exec', 'tsx', 'scripts/upgrade-state.ts', 'set', version, 'gws-ea'],
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
    stream: true,
  });
  return reconcileInstanceService(config, dependencies);
}
