import { constants as fsConstants } from 'node:fs';
import { access, lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { userInfo } from 'node:os';
import path from 'node:path';

import { isErrno } from '../community-portal/errors.js';
import { readEnvFile } from '../env.js';
import { getInstallScopedNames } from '../install-slug.js';
import { renderLaunchdService, renderSystemdService } from './service-definition.js';
import { adoptSharedAgentImage, agentImageKey, readAgentImageInputs } from './agent-image.js';
import { createOnecliAdmin, type OnecliAdmin, type OnecliAdminDependencies } from './onecli-admin.js';
import type { OnecliRuntimeLayout } from './onecli-compose.js';
import {
  CONTROL_PLANE_ROOT,
  assertPrivateDirectory,
  instanceRuntimeFile,
  isRegularFile,
  preparePrivateDirectory,
  type ControlPlanePaths,
} from './paths.js';
import {
  buildHostEnvironment,
  buildToolEnvironment,
  replaceProcess,
  runSanitizedCommand,
  type SanitizedCommand,
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
import { instanceLayout, readCurrent, releaseName } from './release-layout.js';
import { GOOGLE_GRANT_FILE_ENV, GOOGLE_GRANT_FILE_NAME } from '../modules/gws-ea-google/grant.js';
import { GwsEaError, ingressEndpointUrl, type AllocatedPorts, type InstanceReservation } from './types.js';
import { parseJson, requireDockerEndpoint, requirePath, requireRecord, requireString } from './validation.js';

const INSTANCE_RUNTIME_SCHEMA_VERSION = 2 as const;
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
 * It belongs to the assistant, not to a release: create writes it once into
 * the physical `state/`, and which release runs is the live link (KTD2).
 */
export interface PersistedInstanceRuntime {
  readonly schema_version: typeof INSTANCE_RUNTIME_SCHEMA_VERSION;
  readonly instance_id: string;
  /** The assistant's canonical physical root, `<state root>/<first 8 hex>`. */
  readonly instance_root: string;
  readonly node_path: string;
  readonly home_directory: string;
  readonly allocated_ports: AllocatedPorts;
  readonly onecli_project: string;
  readonly selected_provider: string;
  readonly endpoint_url: string;
  readonly docker_endpoint: string;
}

export interface InstanceRuntimeConfig extends PersistedInstanceRuntime {
  /** The live release's link, `<instance root>/nanoclaw`: what the service, `ncl`, and the host's status run from. */
  readonly checkout_root: string;
  /** The physical `state/`, which holds NanoClaw's `.env` and `data` whatever release is live, or none. */
  readonly state_root: string;
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
  /**
   * (Re)starts the installed service the way `gws-ea start`, update, and
   * rollback do: NanoClaw's own helpers, stopping a running host and waiting
   * until its manager has let it go before starting it again.
   */
  readonly restartService?: (config: InstanceRuntimeConfig) => Promise<unknown>;
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

function expectedSecretFiles(instanceRoot: string): InstanceSecretFiles {
  const root = path.join(instanceRoot, 'secrets');
  return {
    gchat_credentials: path.join(root, 'gchat-service-account.json'),
    onecli_runtime_api_key: path.join(root, 'onecli-runtime-api-key'),
    onecli_admin_api_key: path.join(root, 'onecli-admin-api-key'),
  };
}

export function googleChatProjectNumberFile(config: Pick<InstanceRuntimeConfig, 'secret_files'>): string {
  return path.join(path.dirname(config.secret_files.gchat_credentials), 'gchat-project-number');
}

/** The assistant's Google sign-in, which the host refreshes (KTD2). */
export function googleGrantFile(config: Pick<InstanceRuntimeConfig, 'secret_files'>): string {
  return path.join(path.dirname(config.secret_files.gchat_credentials), GOOGLE_GRANT_FILE_NAME);
}

/** The OAuth client the operator supplied, kept until a sign-in turns it into a grant. */
export function googleOAuthClientFile(config: Pick<InstanceRuntimeConfig, 'secret_files'>): string {
  return path.join(path.dirname(config.secret_files.gchat_credentials), 'google-oauth-client.json');
}

function installId(instanceId: string): string {
  assertInstanceId(instanceId);
  return instanceId.replaceAll('-', '');
}

function deriveRuntime(persisted: PersistedInstanceRuntime): InstanceRuntimeConfig {
  const project = persisted.onecli_project;
  const layout = instanceLayout(persisted.instance_root);
  return {
    ...persisted,
    checkout_root: layout.current,
    state_root: layout.state,
    install_id: installId(persisted.instance_id),
    agent_egress_network: `${project}-agent-egress`,
    onecli_app_url: `http://127.0.0.1:${persisted.allocated_ports.onecli_app}`,
    onecli_gateway_url: `http://127.0.0.1:${persisted.allocated_ports.onecli_gateway}`,
    onecli_gateway_container: `${project}-gateway-1`,
    secret_files: expectedSecretFiles(persisted.instance_root),
  };
}

function persistedRuntime(config: PersistedInstanceRuntime): PersistedInstanceRuntime {
  return {
    schema_version: config.schema_version,
    instance_id: config.instance_id,
    instance_root: config.instance_root,
    node_path: config.node_path,
    home_directory: config.home_directory,
    allocated_ports: config.allocated_ports,
    onecli_project: config.onecli_project,
    selected_provider: config.selected_provider,
    endpoint_url: config.endpoint_url,
    docker_endpoint: config.docker_endpoint,
  };
}

function runtimeFileContents(config: InstanceRuntimeConfig): string {
  return `${JSON.stringify(persistedRuntime(config), null, 2)}\n`;
}

export function createInstanceRuntimeConfig(
  paths: Pick<ControlPlanePaths, 'instanceRoot'>,
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
    instance_root: paths.instanceRoot(reservation.instance_id),
    node_path: path.resolve(input.nodePath),
    home_directory: path.resolve(input.homeDirectory),
    allocated_ports: { ...reservation.allocated_ports },
    onecli_project: onecli.project,
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
  return deriveRuntime({
    schema_version: INSTANCE_RUNTIME_SCHEMA_VERSION,
    instance_id: instanceId,
    instance_root: requirePath(raw.instance_root, 'instance_root', INVALID_RUNTIME),
    node_path: requirePath(raw.node_path, 'node_path', INVALID_RUNTIME),
    home_directory: requirePath(raw.home_directory, 'home_directory', INVALID_RUNTIME),
    allocated_ports: ports,
    onecli_project: project,
    selected_provider: provider,
    endpoint_url: endpointUrl,
    docker_endpoint: requireDockerEndpoint(raw.docker_endpoint, 'docker_endpoint', INVALID_RUNTIME),
  });
}

/** The `.env` keys gws-ea owns; every other key belongs to another writer. */
export const INSTANCE_HOST_ENV_KEYS = [
  'NANOCLAW_INSTALL_ID',
  'DEFAULT_AGENT_PROVIDER',
  'NANOCLAW_GATEWAY_PROVIDER',
  'WEBHOOK_PORT',
  'WEBHOOK_HOST',
  'NANOCLAW_EGRESS_LOCKDOWN',
  'NANOCLAW_EGRESS_NETWORK',
  'ONECLI_GATEWAY_CONTAINER',
  'ONECLI_URL',
  'GCHAT_ENDPOINT_URL',
] as const;

type InstanceHostEnvKey = (typeof INSTANCE_HOST_ENV_KEYS)[number];

function instanceHostConfiguration(config: InstanceRuntimeConfig): Readonly<Record<InstanceHostEnvKey, string>> {
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
  const file = instanceRuntimeFile(config.state_root);
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

/**
 * Write `runtime.json` once, and gws-ea's `.env` keys where the assistant's
 * `.env` does not set them, as NanoClaw reads it. Both are in the physical
 * `state/`, never written through a link. A key it sets is the release's own,
 * written by the create that deployed it, so a later start never rewrites it
 * (KTD6); every other writer's keys are kept.
 */
export async function persistInstanceRuntime(
  configInput: InstanceRuntimeConfig,
  upsertEnvVars: UpsertEnvVars,
): Promise<void> {
  const config = validateRuntimeConfig(configInput);
  await preparePrivateDirectory(path.dirname(instanceRuntimeFile(config.state_root)));
  await preparePrivateDirectory(path.dirname(config.secret_files.gchat_credentials));
  await preparePrivateDirectory(instanceLayout(config.instance_root).logs);
  await persistRuntimeFile(config);
  const owned = instanceHostConfiguration(config);
  const present = readInstanceHostEnvironment(config.state_root);
  const missing = Object.entries(owned).filter(([key]) => present[key] === undefined);
  if (missing.length === 0) return;
  upsertEnvVars(Object.fromEntries(missing), config.state_root);
  activeStep()?.envFile(
    path.join(config.state_root, '.env'),
    missing.map(([key, value]) => `${key}=${value}\n`).join(''),
  );
}

/** gws-ea's `.env` keys as the `.env` in `root` holds them, as NanoClaw reads it; other writers' keys are not read. */
export function readInstanceHostEnvironment(root: string): Record<string, string> {
  return readEnvFile([...INSTANCE_HOST_ENV_KEYS], root);
}

/**
 * Write gws-ea's `.env` keys of the release an update deploys into the `.env`
 * in `root` (KTD6, KTD9). Only create and update render them; here they are
 * the release's own, so every gws-ea key is written, replacing the outgoing
 * release's, while every other writer's key the `.env` holds is kept.
 */
export function writeReleaseEnvironment(
  configInput: InstanceRuntimeConfig,
  root: string,
  upsertEnvVars: UpsertEnvVars,
): void {
  const config = validateRuntimeConfig(configInput);
  const owned = instanceHostConfiguration(config);
  upsertEnvVars({ ...owned }, root);
  activeStep()?.envFile(
    path.join(root, '.env'),
    Object.entries(owned)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(''),
  );
}

/** Load the runtime record at `file`, which must be where the record itself says it lives: its own `state/`. */
export async function loadInstanceRuntimeConfig(file: string): Promise<InstanceRuntimeConfig> {
  const config = validateRuntimeConfig(await readOwnerOnlyJson(file, 'Runtime config', INVALID_RUNTIME));
  if (file !== instanceRuntimeFile(config.state_root)) {
    throw new GwsEaError('runtime_mismatch', "Runtime config path does not match the instance's own state");
  }
  return config;
}

export interface HostLogFiles {
  readonly output: string;
  readonly errors: string;
}

/**
 * The log files of the host of the assistant at `instanceRoot`: NanoClaw's
 * `logs/nanoclaw.log` and `logs/nanoclaw.error.log`, read in the physical
 * `logs/` every release links its own to, so they are there while no release
 * is live. The service definition below sends standard output and error
 * here, so `logs` reads what the host writes.
 */
export function hostLogFiles(instanceRoot: string): HostLogFiles {
  const logs = instanceLayout(instanceRoot).logs;
  return { output: path.join(logs, 'nanoclaw.log'), errors: path.join(logs, 'nanoclaw.error.log') };
}

function createInstanceServiceLayout(
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
  const logs = hostLogFiles(config.instance_root);
  return {
    ...coordinates,
    runtimeConfigFile: instanceRuntimeFile(config.state_root),
    environmentFile: path.join(config.state_root, '.env'),
    launcherEntrypoint: path.join(config.checkout_root, 'dist', 'gws-ea', 'process.js'),
    hostEntrypoint: path.join(config.checkout_root, 'dist', 'index.js'),
    cliPath: path.join(config.checkout_root, 'bin', 'ncl'),
    cliSocket: path.join(config.state_root, 'data', 'ncl.sock'),
    standardOutputPath: logs.output,
    standardErrorPath: logs.errors,
  };
}

/** The runtime values a service manager's environment derives from. */
export type ServiceManagerRuntime = Pick<PersistedInstanceRuntime, 'home_directory' | 'docker_endpoint'>;

/** What the service manager starts the launcher with: upstream NanoClaw's minimal service PATH. */
function serviceEnvironment(config: ServiceManagerRuntime): Readonly<Record<string, string>> {
  return {
    HOME: config.home_directory,
    PATH: `${SERVICE_PATH}:${path.join(config.home_directory, '.local', 'bin')}`,
    DOCKER_HOST: config.docker_endpoint,
  };
}

/**
 * The service runs the launcher through the live link, from the live link:
 * while a switch has removed it, the program does not exist, so the service
 * manager can start nothing, even after a reboot.
 */
function renderInstanceService(config: InstanceRuntimeConfig, layout: InstanceServiceLayout): string {
  const input = {
    programArguments: [config.node_path, layout.launcherEntrypoint, 'launch-host', layout.runtimeConfigFile],
    workingDirectory: config.checkout_root,
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

/** Where the service manager reads the assistant's service definition. */
export function instanceServiceDefinitionFile(
  configInput: InstanceRuntimeConfig,
  options: ServiceLayoutOptions,
): string {
  return createInstanceServiceLayout(configInput, options).serviceDefinitionPath;
}

/**
 * Write the service definition the release an update deploys renders, while
 * its service is stopped (KTD6): only when it differs from the one installed,
 * and systemd is then told to reload it. launchd reads a definition when the
 * job is bootstrapped, which the next start does. Returns whether it changed.
 */
export async function writeInstanceServiceDefinition(
  configInput: InstanceRuntimeConfig,
  dependencies: InstanceServiceDependencies,
): Promise<boolean> {
  const config = validateRuntimeConfig(configInput);
  const layout = createInstanceServiceLayout(config, dependencies);
  const rendered = renderInstanceService(config, layout);
  const installed = await readFile(layout.serviceDefinitionPath, 'utf8').catch((error: unknown) => {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
  });
  return installServiceDefinition(config, layout, rendered, installed, dependencies);
}

/**
 * Put back the service definition a kept release ran with, while its service
 * is stopped (KTD6): a rollback restores it rather than rendering one. Only
 * when it differs from the one installed, and systemd is then told to reload
 * it. Returns whether it changed.
 */
export async function restoreInstanceServiceDefinition(
  configInput: InstanceRuntimeConfig,
  kept: string,
  dependencies: InstanceServiceDependencies,
): Promise<boolean> {
  const config = validateRuntimeConfig(configInput);
  const layout = createInstanceServiceLayout(config, dependencies);
  const installed = await readFile(layout.serviceDefinitionPath, 'utf8').catch((error: unknown) => {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
  });
  return installServiceDefinition(config, layout, kept, installed, dependencies);
}

async function installServiceDefinition(
  config: InstanceRuntimeConfig,
  layout: InstanceServiceLayout,
  definition: string,
  installed: string | undefined,
  dependencies: InstanceServiceDependencies,
): Promise<boolean> {
  if (installed === definition) return false;
  await mkdir(path.dirname(layout.serviceDefinitionPath), { recursive: true, mode: 0o700 });
  await writePrivateTextFile(layout.serviceDefinitionPath, definition);
  if (layout.manager !== 'launchd') {
    await (dependencies.runCommand ?? runSanitizedCommand)({
      command: 'systemctl',
      args: [...(layout.manager === 'systemd-user' ? ['--user'] : []), 'daemon-reload'],
      cwd: config.home_directory,
      env: serviceManagerEnvironment(config, layout.manager, dependencies),
      timeoutMs: 30_000,
    });
  }
  return true;
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
 * Install the service when its definition is missing, then (re)start it. An
 * existing definition is the release's own, rendered by the create that
 * deployed it, so a later start never renders it again (KTD6). systemd is
 * told about a new unit, enables it, and keeps a user's services running
 * after logout (lingering). The start itself is the one every other command
 * uses (`restartService`): a running host is stopped and its job waited out,
 * so launchd never sees a `bootstrap` while it still removes the old job.
 */
export async function reconcileInstanceService(
  configInput: InstanceRuntimeConfig,
  dependencies: InstanceServiceDependencies,
): Promise<InstanceServiceStart> {
  const config = validateRuntimeConfig(configInput);
  const layout = createInstanceServiceLayout(config, dependencies);
  const { restartService } = dependencies;
  if (!restartService) {
    throw new GwsEaError('interactive_setup_unavailable', 'Run this command through the gws-ea launcher');
  }
  await Promise.all([
    assertRegularFile(layout.launcherEntrypoint),
    assertRegularFile(layout.hostEntrypoint),
    assertExecutable(layout.cliPath),
  ]);
  const run = dependencies.runCommand ?? runSanitizedCommand;
  const environment = serviceManagerEnvironment(config, layout.manager, dependencies);
  const command = async (program: string, args: readonly string[]): Promise<string> =>
    (await run({ command: program, args, cwd: config.instance_root, env: environment, timeoutMs: 30_000 })).stdout;
  if (layout.manager === 'systemd-user') await ensureLingering(command, dependencies);
  if (!(await isRegularFile(layout.serviceDefinitionPath))) {
    await installServiceDefinition(config, layout, renderInstanceService(config, layout), undefined, dependencies);
  }
  if (layout.manager !== 'launchd') {
    await command('systemctl', [
      ...(layout.manager === 'systemd-user' ? ['--user'] : []),
      'enable',
      layout.serviceIdentity,
    ]);
  }
  await restartService(config);
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
      cwd: config.instance_root,
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
    cwd: config.checkout_root,
    env: buildToolEnvironment(ambient, {
      HOME: config.home_directory,
      NANOCLAW_INSTALL_ID: config.install_id,
    }),
  };
}

async function buildInstanceHostEnvironment(
  configInput: InstanceRuntimeConfig,
  containerImage: string,
  ambient: NodeJS.ProcessEnv,
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
    CONTAINER_IMAGE: containerImage,
    ONECLI_API_KEY: onecliRuntimeApiKey.trim(),
    GCHAT_CREDENTIALS: gchatCredentials,
    GCHAT_WORKSPACE_ADDON_SERVICE_ACCOUNT_EMAIL: deriveWorkspaceAddOnIdentity(projectNumber),
    [GOOGLE_GRANT_FILE_ENV]: googleGrantFile(config),
  });
}

/** The instance's OneCLI administrative key, from its owner-only secret file; an empty file is refused. */
async function readOnecliAdminApiKey(config: InstanceRuntimeConfig): Promise<string> {
  const apiKey = (await readOwnerOnlyFile(config.secret_files.onecli_admin_api_key)).trim();
  if (!apiKey) throw new GwsEaError('invalid_secret', 'The OneCLI administrative credential is empty');
  return apiKey;
}

/** The instance's OneCLI administration: its own app URL, with the admin key its owner-only file holds. */
export async function instanceOnecliAdmin(
  configInput: InstanceRuntimeConfig,
  dependencies: OnecliAdminDependencies = {},
): Promise<OnecliAdmin> {
  const config = validateRuntimeConfig(configInput);
  return createOnecliAdmin(config.onecli_app_url, await readOnecliAdminApiKey(config), dependencies);
}

/**
 * The service's entry: replace this process with the host of the release it
 * runs from, which must be the live one. Node resolves the launcher's links,
 * so `releaseRoot` is the physical release folder the service reached through
 * the live link; a launcher anywhere else, or one whose release a switch has
 * since replaced, starts nothing. The host runs from that folder, so NanoClaw
 * reaches the assistant's state through the release's links, and runs agents
 * on the release's own image, `<base>:r-<hex8>` (KTD6).
 */
export async function launchInstanceHost(
  configFile: string,
  ambient: NodeJS.ProcessEnv = process.env,
  execve: NonNullable<NodeJS.Process['execve']> | undefined = process.execve,
  releaseRoot: string = CONTROL_PLANE_ROOT,
): Promise<never> {
  const config = await loadInstanceRuntimeConfig(path.resolve(configFile));
  const layout = instanceLayout(config.instance_root);
  const live = await readCurrent(layout);
  const liveRoot =
    live === undefined
      ? undefined
      : await realpath(layout.current).catch((error: unknown) => {
          if (isErrno(error, 'ENOENT')) return undefined;
          throw error;
        });
  if (live === undefined || liveRoot !== releaseRoot) {
    throw new GwsEaError(
      'not_live_release',
      `The launcher at ${releaseRoot} is not the live release of assistant ${config.instance_id}` +
        (liveRoot === undefined ? ', which has none' : `, which is ${liveRoot}`) +
        ', so it starts no host.',
    );
  }
  const hostEntrypoint = path.join(releaseRoot, 'dist', 'index.js');
  await Promise.all([assertExecutable(config.node_path), assertRegularFile(hostEntrypoint)]);
  const containerImage = `${getInstallScopedNames(config.install_id).containerImageBase}:r-${live}`;
  const environment = await buildInstanceHostEnvironment(config, containerImage, ambient);
  process.chdir(releaseRoot);
  return replaceProcess(config.node_path, [config.node_path, hostEntrypoint], environment, execve);
}

/**
 * Stamp NanoClaw's upgrade marker in `checkoutRoot` with the checkout's own
 * script, as a sanctioned upgrade path does: the host's startup tripwire then
 * accepts exactly the commit and tree the checkout holds, and refuses any
 * other.
 */
export async function stampUpgradeState(
  checkoutRoot: string,
  run: SanitizedCommandRunner,
  environment: Readonly<Record<string, string>>,
): Promise<void> {
  const packageManifest = requireRecord(
    parseJson(
      await readFile(path.join(checkoutRoot, 'package.json'), 'utf8'),
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
    cwd: checkoutRoot,
    env: environment,
    timeoutMs: 30_000,
  });
}

/**
 * Persist the runtime, prepare the release at `commit` (its upgrade tripwire
 * and its agent image), and install and start the service.
 */
export async function reconcileInstanceRuntime(
  configInput: InstanceRuntimeConfig,
  commit: string,
  dependencies: InstanceRuntimeDependencies,
): Promise<InstanceServiceStart> {
  const config = validateRuntimeConfig(configInput);
  const release = instanceLayout(config.instance_root).release(releaseName(commit));
  await persistInstanceRuntime(config, dependencies.upsertEnvVars);
  const run = dependencies.runCommand ?? runSanitizedCommand;
  // The build runs with the operator's tools, as release preflight's commands do; only the service keeps its minimal PATH.
  const environment = buildToolEnvironment(dependencies.ambientEnv ?? process.env, {
    HOME: config.home_directory,
    DOCKER_HOST: config.docker_endpoint,
    NANOCLAW_INSTALL_ID: config.install_id,
  });
  await stampUpgradeState(release, run, environment);
  if (!(await adoptReleaseAgentImage(config, { release, commit }, run, environment))) {
    await run({
      command: 'pnpm',
      args: ['exec', 'tsx', 'setup/index.ts', '--step', 'container'],
      cwd: release,
      env: environment,
      timeoutMs: 15 * 60_000,
      stream: true,
    });
  }
  return reconcileInstanceService(config, dependencies);
}

/**
 * Tag the agent image an update already built for this release and these
 * build flags as the new assistant's `:latest`, and say whether there was one
 * (see `agent-image.ts`): its content key is read from the checkout create
 * deployed and its `.env`. Without one, NanoClaw's own container step builds
 * and smoke-tests the image as it always has. That image is not labeled: the
 * step runs `docker build` itself, without the agent-runner lockfile label
 * `container/build.sh` adds, so it is not the image the key names. The
 * assistant's first update moves it onto a shared one.
 */
async function adoptReleaseAgentImage(
  config: InstanceRuntimeConfig,
  { release, commit }: { readonly release: string; readonly commit: string },
  run: SanitizedCommandRunner,
  environment: Readonly<Record<string, string>>,
): Promise<boolean> {
  const inputs = await readAgentImageInputs(
    { repository: release, commit, checkout: config.state_root },
    { runCommand: run },
  );
  const names = getInstallScopedNames(config.install_id);
  return adoptSharedAgentImage(
    { run, cwd: release, env: environment },
    agentImageKey(inputs),
    names.containerImageBase,
    names.defaultContainerImage,
  );
}
