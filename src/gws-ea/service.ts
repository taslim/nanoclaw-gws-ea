import { constants as fsConstants } from 'node:fs';
import { access, lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { userInfo } from 'node:os';
import path from 'node:path';

import { isErrno } from '../community-portal/errors.js';
import { readEnvFile } from '../env.js';
import { getInstallScopedNames } from '../install-slug.js';
import { renderLaunchdService, renderSystemdService } from './service-definition.js';
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
import { deriveGcpProjectId } from './gcp-identity.js';
import { assertInstanceId } from './registry.js';
import { instanceLayout, readCurrent, releaseName } from './release-layout.js';
import { GCHAT_PROJECT_ID_ENV, GCHAT_SUBSCRIBER_KEY_FILE_ENV } from '../modules/gws-ea-chat/config.js';
import { GOOGLE_GRANT_FILE_ENV, GOOGLE_GRANT_FILE_NAME } from '../modules/gws-ea-google/grant.js';
import { BROWSER_POLICY_FILE_ENV } from '../modules/gws-ea-browser/policy.js';
import { ARTIFACTS_POLICY_FILE_ENV } from '../modules/gws-ea-artifacts/policy.js';
import { ONEPASSWORD_POLICY_FILE_ENV, onePasswordHostPaths } from '../modules/gws-ea-browser/onepassword-policy.js';
import { VOICE_POLICY_FILE_ENV } from '../modules/gws-ea-voice/config.js';
import { GwsEaError, type AllocatedPorts, type InstanceReservation } from './types.js';
import { parseJson, requireDockerEndpoint, requirePath, requireRecord, requireString } from './validation.js';

const INSTANCE_RUNTIME_SCHEMA_VERSION = 3 as const;
const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const ONECLI_PROJECT_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/u;
const SERVICE_PATH = '/usr/local/bin:/usr/bin:/bin';
const INVALID_RUNTIME = 'invalid_runtime_config';

export interface InstanceSecretFiles {
  readonly gchat_subscriber_key: string;
  readonly onecli_runtime_api_key: string;
  readonly onecli_admin_api_key: string;
}

/**
 * What `runtime.json` stores: the values nothing else determines, plus the
 * local Docker endpoint create resolved. Everything derivable from them is
 * recomputed on every read, so it can never disagree with them. It belongs to
 * the assistant, not to a release: create writes it once into the physical
 * `state/`, and which release runs is the live link.
 */
export interface PersistedInstanceRuntime {
  readonly schema_version: typeof INSTANCE_RUNTIME_SCHEMA_VERSION;
  readonly instance_id: string;
  /** Canonical and physical: `<state root>/<first 8 hex>`. */
  readonly instance_root: string;
  readonly node_path: string;
  readonly home_directory: string;
  readonly allocated_ports: AllocatedPorts;
  readonly onecli_project: string;
  readonly selected_provider: string;
  readonly docker_endpoint: string;
}

export interface InstanceRuntimeConfig extends PersistedInstanceRuntime {
  /** The live release's link, `<instance root>/nanoclaw`, not a physical folder. */
  readonly checkout_root: string;
  /** The physical `state/`, holding NanoClaw's state roots whatever release is live, or none. */
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
  /** Stands in for `process.env`; user-bus variables absent from it are derived from the UID. */
  readonly ambientEnv?: NodeJS.ProcessEnv;
  /**
   * (Re)starts the installed service as `gws-ea restart` does: a running host
   * is stopped and its manager waited out before it starts again.
   */
  readonly restartService?: (config: InstanceRuntimeConfig) => Promise<unknown>;
}

export interface InstanceServiceStart {
  readonly layout: InstanceServiceLayout;
  readonly pid: number | undefined;
}

export interface InstanceRuntimeDependencies extends InstanceServiceDependencies {
  readonly upsertEnvVars: UpsertEnvVars;
  /** The control plane's config root; when set, the host-policy locators are bound as well. */
  readonly hostPolicyRoot?: string;
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
    gchat_subscriber_key: path.join(root, 'gchat-subscriber-key.json'),
    onecli_runtime_api_key: path.join(root, 'onecli-runtime-api-key'),
    onecli_admin_api_key: path.join(root, 'onecli-admin-api-key'),
  };
}

/** The assistant's Google sign-in, which the host refreshes. */
export function googleGrantFile(config: Pick<InstanceRuntimeConfig, 'secret_files'>): string {
  return path.join(path.dirname(config.secret_files.gchat_subscriber_key), GOOGLE_GRANT_FILE_NAME);
}

/** The OAuth client the operator supplied, kept until a sign-in turns it into a grant. */
export function googleOAuthClientFile(config: Pick<InstanceRuntimeConfig, 'secret_files'>): string {
  return path.join(path.dirname(config.secret_files.gchat_subscriber_key), 'google-oauth-client.json');
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
    docker_endpoint: input.dockerEndpoint,
  } satisfies PersistedInstanceRuntime);
}

/** Ignores fields it does not persist, and recomputes the derived ones. */
export function validateRuntimeConfig(value: unknown): InstanceRuntimeConfig {
  const raw = requireRecord(value, 'Runtime config', INVALID_RUNTIME);
  if (raw.schema_version !== INSTANCE_RUNTIME_SCHEMA_VERSION) {
    throw new GwsEaError('unsupported_runtime_config', 'Runtime config schema version is unsupported');
  }
  const instanceId = requireString(raw.instance_id, 'instance_id', INVALID_RUNTIME);
  assertInstanceId(instanceId);
  const portsRaw = requireRecord(raw.allocated_ports, 'allocated_ports', INVALID_RUNTIME);
  const ports: AllocatedPorts = {
    onecli_app: assertPort(portsRaw.onecli_app, 'onecli_app'),
    onecli_gateway: assertPort(portsRaw.onecli_gateway, 'onecli_gateway'),
  };
  if (ports.onecli_app === ports.onecli_gateway) {
    throw new GwsEaError(INVALID_RUNTIME, 'Allocated ports must be distinct');
  }
  const project = requireString(raw.onecli_project, 'onecli_project', INVALID_RUNTIME);
  if (!ONECLI_PROJECT_PATTERN.test(project)) throw new GwsEaError(INVALID_RUNTIME, 'onecli_project is invalid');
  const provider = requireString(raw.selected_provider, 'selected_provider', INVALID_RUNTIME);
  if (!PROVIDER_PATTERN.test(provider)) throw new GwsEaError(INVALID_RUNTIME, 'selected_provider is invalid');
  return deriveRuntime({
    schema_version: INSTANCE_RUNTIME_SCHEMA_VERSION,
    instance_id: instanceId,
    instance_root: requirePath(raw.instance_root, 'instance_root', INVALID_RUNTIME),
    node_path: requirePath(raw.node_path, 'node_path', INVALID_RUNTIME),
    home_directory: requirePath(raw.home_directory, 'home_directory', INVALID_RUNTIME),
    allocated_ports: ports,
    onecli_project: project,
    selected_provider: provider,
    docker_endpoint: requireDockerEndpoint(raw.docker_endpoint, 'docker_endpoint', INVALID_RUNTIME),
  });
}

/**
 * gws-ea's `.env` keys that each release keeps (`kept-release.ts`). The
 * host-policy locators `bindInstanceHostPolicies` writes are not among them.
 */
export const INSTANCE_HOST_ENV_KEYS = [
  'NANOCLAW_INSTALL_ID',
  'DEFAULT_AGENT_PROVIDER',
  'NANOCLAW_GATEWAY_PROVIDER',
  'NANOCLAW_EGRESS_LOCKDOWN',
  'NANOCLAW_EGRESS_NETWORK',
  'ONECLI_GATEWAY_CONTAINER',
  'ONECLI_URL',
  BROWSER_POLICY_FILE_ENV,
  ARTIFACTS_POLICY_FILE_ENV,
] as const;

type InstanceHostEnvKey = (typeof INSTANCE_HOST_ENV_KEYS)[number];

export function instanceHostConfiguration(config: InstanceRuntimeConfig): Readonly<Record<InstanceHostEnvKey, string>> {
  return {
    NANOCLAW_INSTALL_ID: config.install_id,
    DEFAULT_AGENT_PROVIDER: config.selected_provider,
    NANOCLAW_GATEWAY_PROVIDER: 'onecli',
    NANOCLAW_EGRESS_LOCKDOWN: 'true',
    NANOCLAW_EGRESS_NETWORK: config.agent_egress_network,
    ONECLI_GATEWAY_CONTAINER: config.onecli_gateway_container,
    ONECLI_URL: config.onecli_app_url,
    [BROWSER_POLICY_FILE_ENV]: path.join(config.instance_root, 'browser', 'policy.json'),
    [ARTIFACTS_POLICY_FILE_ENV]: path.join(config.instance_root, 'artifacts', 'policy.json'),
  };
}

/**
 * A later run leaves an existing `runtime.json` as it is when its persisted
 * values agree, so fields another launcher added survive, and refuses when
 * they disagree.
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
 * Write `runtime.json` once, re-bind the host-policy locators that differ, and
 * add the release keys (`INSTANCE_HOST_ENV_KEYS`) the assistant's `.env` does
 * not set. All are in the physical `state/`, never written through a link. A
 * release key already set is the release's own, written by the create that
 * deployed it, so a later start never rewrites it; every other writer's keys
 * are kept.
 */
export async function persistInstanceRuntime(
  configInput: InstanceRuntimeConfig,
  upsertEnvVars: UpsertEnvVars,
  hostPolicyRoot?: string,
): Promise<void> {
  const config = validateRuntimeConfig(configInput);
  await preparePrivateDirectory(path.dirname(instanceRuntimeFile(config.state_root)));
  await preparePrivateDirectory(path.dirname(config.secret_files.gchat_subscriber_key));
  await preparePrivateDirectory(instanceLayout(config.instance_root).logs);
  await persistRuntimeFile(config);
  if (hostPolicyRoot) await bindInstanceHostPolicies(config, hostPolicyRoot, upsertEnvVars);
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

/**
 * Each names a policy file, never a value, and never the 1Password management
 * token beside its policy.
 */
export function hostPolicyLocators(configRoot: string): Readonly<Record<string, string>> {
  return {
    [VOICE_POLICY_FILE_ENV]: path.join(configRoot, 'voice.json'),
    [ONEPASSWORD_POLICY_FILE_ENV]: onePasswordHostPaths(configRoot).policyFile,
  };
}

/**
 * Bind the host-only gws-ea locators in the assistant's `.env`, rewriting only
 * values that differ. A policy locator conveys no per-assistant consent: each
 * policy decides for itself. These keys stay out of runtime.json, container
 * env and the files kept with a release; an operation's `state/` snapshot
 * copies them with the `.env`.
 */
export async function bindInstanceHostPolicies(
  config: InstanceRuntimeConfig,
  configRoot: string,
  upsertEnvVars: UpsertEnvVars,
): Promise<boolean> {
  if (!path.isAbsolute(configRoot)) throw new GwsEaError('invalid_arguments', 'Host policy locators must be absolute');
  const locators = {
    ...hostPolicyLocators(configRoot),
    GWS_EA_INSTANCE_LOCK_FILE: path.join(configRoot, 'locks', `${config.instance_id}.lock`),
    GWS_EA_CONFIG_ROOT: configRoot,
    GWS_EA_STATE_ROOT: path.dirname(config.instance_root),
    GWS_EA_INSTANCE_ID: config.instance_id,
    GWS_EA_WHATSAPP_DIR: path.join(config.instance_root, 'secrets', 'whatsapp'),
  };
  const present = readEnvFile(Object.keys(locators), config.state_root);
  const changed = Object.entries(locators).filter(([key, file]) => present[key] !== file);
  if (changed.length) upsertEnvVars(Object.fromEntries(changed), config.state_root);
  return changed.length > 0;
}

export function readInstanceHostEnvironment(root: string): Record<string, string> {
  return readEnvFile([...INSTANCE_HOST_ENV_KEYS], root);
}

/** `file` must be where the record itself says it lives: its own `state/`. */
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
 * In the physical `logs/` every release links its own to, so they are there
 * while no release is live. The service definition sends the host's standard
 * output and error here, so `gws-ea logs` reads what the host writes.
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

export type ServiceManagerRuntime = Pick<PersistedInstanceRuntime, 'home_directory' | 'docker_endpoint'>;

/** Upstream NanoClaw's minimal service PATH, which the service manager's own commands run with. */
function serviceEnvironment(config: ServiceManagerRuntime): Readonly<Record<string, string>> {
  return {
    HOME: config.home_directory,
    PATH: `${SERVICE_PATH}:${path.join(config.home_directory, '.local', 'bin')}`,
    DOCKER_HOST: config.docker_endpoint,
  };
}

/**
 * As upstream NanoClaw gives its own service (setup/service.ts), so a Docker
 * CLI installed by Homebrew is found as it is by NanoClaw.
 */
function launcherPath(config: InstanceRuntimeConfig, manager: InstanceServiceLayout['manager']): string {
  const directories = [
    ...(manager === 'launchd' ? ['/opt/homebrew/bin', '/opt/homebrew/sbin'] : []),
    ...SERVICE_PATH.split(':'),
    path.join(config.home_directory, '.local', 'bin'),
  ];
  const nodeDirectory = path.dirname(config.node_path);
  return (directories.includes(nodeDirectory) ? directories : [nodeDirectory, ...directories]).join(':');
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
    environment: { ...serviceEnvironment(config), PATH: launcherPath(config, layout.manager) },
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

export function instanceServiceDefinitionFile(
  configInput: InstanceRuntimeConfig,
  options: ServiceLayoutOptions,
): string {
  return createInstanceServiceLayout(configInput, options).serviceDefinitionPath;
}

export function renderInstanceServiceDefinition(
  configInput: InstanceRuntimeConfig,
  options: ServiceLayoutOptions,
): string {
  const config = validateRuntimeConfig(configInput);
  return renderInstanceService(config, createInstanceServiceLayout(config, options));
}

/**
 * Put back the service definition a kept release ran with, while its service
 * is stopped: a switch installs the one the release kept rather than rendering
 * one. Written, and systemd told to reload, only when it differs from the one
 * installed; returns whether it did.
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
  await reloadServiceManager(config, layout, dependencies);
  return true;
}

/** launchd needs no reload: it reads a definition when its job is bootstrapped. */
async function reloadServiceManager(
  config: InstanceRuntimeConfig,
  layout: InstanceServiceLayout,
  dependencies: InstanceServiceDependencies,
): Promise<void> {
  if (layout.manager === 'launchd') return;
  await (dependencies.runCommand ?? runSanitizedCommand)({
    command: 'systemctl',
    args: [...(layout.manager === 'systemd-user' ? ['--user'] : []), 'daemon-reload'],
    cwd: config.home_directory,
    env: serviceManagerEnvironment(config, layout.manager, dependencies),
    timeoutMs: 30_000,
  });
}

/**
 * Have the service manager read the assistant's service definition as it is
 * now, before a start: systemd is told to reload, so a switch resumed after
 * the definition was written, which then finds it unchanged, never starts a
 * unit systemd read before. launchd reads the definition when its job is
 * bootstrapped, which a start after a stop does.
 */
export async function reloadInstanceService(
  configInput: InstanceRuntimeConfig,
  dependencies: InstanceServiceDependencies,
): Promise<void> {
  const config = validateRuntimeConfig(configInput);
  await reloadServiceManager(config, createInstanceServiceLayout(config, dependencies), dependencies);
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
 * A user service manager is reached over the user bus, so `systemctl --user`
 * gets `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS`, derived from the UID
 * when the caller has none (a non-login shell, sudo, cron).
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
 * deployed it, so a later start never renders it again. The start is
 * `restartService`: a running host is stopped and its job waited out, so
 * launchd never sees a `bootstrap` while it still removes the old job.
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

/**
 * Chat delivery reaches the host as the owner-only path of the subscriber key
 * and the assistant's project, from which the host names its topic and pull
 * subscription: the key itself never enters an environment.
 */
async function buildInstanceHostEnvironment(
  configInput: InstanceRuntimeConfig,
  containerImage: string,
  ambient: NodeJS.ProcessEnv,
): Promise<Record<string, string>> {
  const config = validateRuntimeConfig(configInput);
  await assertPrivateDirectory(path.dirname(config.secret_files.gchat_subscriber_key));
  const [subscriberKey, onecliRuntimeApiKey] = await Promise.all([
    readOwnerOnlyFile(config.secret_files.gchat_subscriber_key),
    readOwnerOnlyFile(config.secret_files.onecli_runtime_api_key),
  ]);
  if (!subscriberKey.trim() || !onecliRuntimeApiKey.trim()) {
    throw new GwsEaError('invalid_secret', 'A required instance host credential is empty');
  }
  return buildHostEnvironment(ambient, {
    HOME: config.home_directory,
    DOCKER_HOST: config.docker_endpoint,
    ...instanceHostConfiguration(config),
    CONTAINER_IMAGE: containerImage,
    ONECLI_API_KEY: onecliRuntimeApiKey.trim(),
    [GOOGLE_GRANT_FILE_ENV]: googleGrantFile(config),
    [GCHAT_SUBSCRIBER_KEY_FILE_ENV]: config.secret_files.gchat_subscriber_key,
    [GCHAT_PROJECT_ID_ENV]: deriveGcpProjectId(config.instance_id),
  });
}

async function readOnecliAdminApiKey(config: InstanceRuntimeConfig): Promise<string> {
  const apiKey = (await readOwnerOnlyFile(config.secret_files.onecli_admin_api_key)).trim();
  if (!apiKey) throw new GwsEaError('invalid_secret', 'The OneCLI administrative credential is empty');
  return apiKey;
}

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
 * on the release's own image, `<base>:r-<hex8>`.
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
 * The release's agent image was provided when the release was staged
 * (`release-stage.ts`), and its host runs that image's tag.
 */
export async function reconcileInstanceRuntime(
  configInput: InstanceRuntimeConfig,
  commit: string,
  dependencies: InstanceRuntimeDependencies,
): Promise<InstanceServiceStart> {
  const config = validateRuntimeConfig(configInput);
  const release = instanceLayout(config.instance_root).release(releaseName(commit));
  await persistInstanceRuntime(config, dependencies.upsertEnvVars, dependencies.hostPolicyRoot);
  // Run with the operator's tools, as release preflight's commands are; only the service keeps its minimal PATH.
  const environment = buildToolEnvironment(dependencies.ambientEnv ?? process.env, {
    HOME: config.home_directory,
    DOCKER_HOST: config.docker_endpoint,
    NANOCLAW_INSTALL_ID: config.install_id,
  });
  await stampUpgradeState(release, dependencies.runCommand ?? runSanitizedCommand, environment);
  return reconcileInstanceService(config, dependencies);
}
