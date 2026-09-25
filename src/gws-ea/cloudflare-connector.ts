import { createRequire } from 'node:module';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { stringify } from 'yaml';

import { isErrno } from '../community-portal/errors.js';
import { assertPrivateLocalDirectory, preparePrivateLocalDirectory } from './paths.js';
import {
  buildToolEnvironment,
  runSanitizedCommand,
  type SanitizedCommand,
  type SanitizedCommandRunner,
} from './process.js';
import { readOwnerOnlyFile, writeOwnerOnlyFileExclusive, writePrivateTextFile } from './secrets.js';
import { GwsEaError } from './types.js';
import { hasControlCharacters, isRecord } from './validation.js';

const require = createRequire(import.meta.url);
const versionPins: unknown = require('../../versions.json');
const CLOUDFLARED_IMAGE_PATTERN = /^cloudflare\/cloudflared:(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)@sha256:[0-9a-f]{64}$/u;
const CONNECTOR_COMMAND = ['tunnel', '--no-autoupdate', 'run', '--token-file', '/run/secrets/tunnel_token'] as const;
const CONNECTOR_TOKEN_DESTINATION = '/run/secrets/tunnel_token';
const CONNECTOR_PROJECT = 'gws-ea-cloudflare';
const CONNECTOR_OWNER = 'shared-cloudflare-ingress';
const CONNECTOR_ROLE = 'connector';
const CONNECTOR_TMPFS = '/tmp:rw,nosuid,nodev,noexec,size=16m,mode=1777';
const CONNECTOR_ENV_FILE = '# Intentionally empty: the connector token is mounted from its owner-only file.\n';
const EXPECTED_IMAGE_ENVIRONMENT = [
  'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  'SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt',
] as const;

export const CLOUDFLARE_CONNECTOR_OWNER_LABEL = 'dev.gws-ea.resource-owner' as const;
export const CLOUDFLARE_CONNECTOR_ROLE_LABEL = 'dev.gws-ea.cloudflare-role' as const;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new GwsEaError('invalid_connector_pin', `${label} must be an object`);
  return value;
}

export function validateCloudflaredImagePin(value: unknown): string {
  if (typeof value !== 'string' || !CLOUDFLARED_IMAGE_PATTERN.test(value)) {
    throw new GwsEaError(
      'invalid_release_pin',
      'cloudflared must be pinned to an exact version and immutable sha256 manifest digest',
    );
  }
  return value;
}

export const CLOUDFLARED_IMAGE = validateCloudflaredImagePin(record(versionPins, 'versions.json').cloudflared);

export type CloudflareConnectorPlatform = 'macos' | 'linux';

export interface CloudflareConnectorLayout {
  readonly platform: CloudflareConnectorPlatform;
  readonly project: typeof CONNECTOR_PROJECT;
  readonly rootDirectory: string;
  readonly composeFile: string;
  readonly envFile: string;
  readonly secretsDirectory: string;
  readonly tokenFile: string;
  readonly runtimeUser: string;
}

export interface CloudflareConnectorLayoutInput {
  readonly cloudflareRoot: string;
  readonly platform: CloudflareConnectorPlatform;
  readonly ownerUid?: number;
  readonly ownerGid?: number;
}

export interface ObservedCloudflareConnectorMount {
  readonly type: string;
  readonly source: string;
  readonly destination: string;
  readonly readOnly: boolean;
}

export interface ObservedCloudflareConnector {
  readonly id: string;
  readonly service: string;
  readonly project: string;
  readonly owner: string | undefined;
  readonly role: string | undefined;
  readonly image: string;
  readonly user: string;
  readonly command: readonly string[];
  readonly environment: readonly string[];
  readonly running: boolean;
  readonly restarting: boolean;
  readonly restartPolicy: string;
  readonly readOnlyRootFilesystem: boolean;
  readonly privileged: boolean;
  readonly capabilitiesDropped: readonly string[];
  readonly securityOptions: readonly string[];
  readonly networkMode: string;
  readonly extraHosts: readonly string[];
  readonly mounts: readonly ObservedCloudflareConnectorMount[];
  readonly tmpfs: readonly string[];
  readonly publishedPorts: Readonly<Record<string, unknown>>;
}

export interface CloudflareConnectorDependencies {
  readonly runCommand?: SanitizedCommandRunner;
  readonly ambientEnv?: NodeJS.ProcessEnv;
  readonly stabilityDelay?: (milliseconds: number) => Promise<void>;
}

export function createCloudflareConnectorLayout(input: CloudflareConnectorLayoutInput): CloudflareConnectorLayout {
  if (input.platform !== 'macos' && input.platform !== 'linux') {
    throw new GwsEaError('unsupported_platform', 'Cloudflare connector platform is unsupported');
  }
  const rootDirectory = path.resolve(input.cloudflareRoot);
  if (rootDirectory !== input.cloudflareRoot) {
    throw new GwsEaError('unsafe_connector_path', 'Cloudflare connector root must be absolute and normalized');
  }
  const ownerUid = input.ownerUid ?? process.getuid?.();
  const ownerGid = input.ownerGid ?? process.getgid?.();
  if (
    ownerUid === undefined ||
    ownerGid === undefined ||
    !Number.isSafeInteger(ownerUid) ||
    !Number.isSafeInteger(ownerGid) ||
    ownerUid < 0 ||
    ownerGid < 0
  ) {
    throw new GwsEaError('unsupported_platform', 'Cloudflare connector requires numeric host user and group IDs');
  }
  const secretsDirectory = path.join(rootDirectory, 'secrets');
  return {
    platform: input.platform,
    project: CONNECTOR_PROJECT,
    rootDirectory,
    composeFile: path.join(rootDirectory, 'compose.yaml'),
    envFile: path.join(rootDirectory, 'compose.env'),
    secretsDirectory,
    tokenFile: path.join(secretsDirectory, 'tunnel-token'),
    runtimeUser: `${ownerUid}:${ownerGid}`,
  };
}

export function cloudflareOriginUrl(platform: CloudflareConnectorPlatform, port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new GwsEaError('invalid_connector_origin', 'Cloudflare origin port must be an integer from 1 to 65535');
  }
  return `http://${platform === 'macos' ? 'host.docker.internal' : '127.0.0.1'}:${port}`;
}

export function renderCloudflareConnectorCompose(layout: CloudflareConnectorLayout): string {
  const service: Record<string, unknown> = {
    image: CLOUDFLARED_IMAGE,
    restart: 'unless-stopped',
    command: [...CONNECTOR_COMMAND],
    // Local Compose secrets are bind mounts. Running as the host file owner
    // keeps the token 0600 on Linux instead of weakening its permissions.
    user: layout.runtimeUser,
    read_only: true,
    cap_drop: ['ALL'],
    security_opt: ['no-new-privileges:true'],
    tmpfs: [CONNECTOR_TMPFS],
    network_mode: layout.platform === 'linux' ? 'host' : 'bridge',
    secrets: ['tunnel_token'],
    labels: {
      [CLOUDFLARE_CONNECTOR_OWNER_LABEL]: CONNECTOR_OWNER,
      [CLOUDFLARE_CONNECTOR_ROLE_LABEL]: CONNECTOR_ROLE,
    },
  };
  if (layout.platform === 'macos') service.extra_hosts = ['host.docker.internal:host-gateway'];
  return stringify(
    {
      services: { connector: service },
      secrets: { tunnel_token: { file: layout.tokenFile } },
    },
    { lineWidth: 0, aliasDuplicateObjects: false },
  );
}

export function buildCloudflareComposeInvocation(
  layout: CloudflareConnectorLayout,
  args: readonly string[],
): SanitizedCommand {
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

function connectorEnvironment(ambient: NodeJS.ProcessEnv = process.env): Readonly<Record<string, string>> {
  const environment = buildToolEnvironment(ambient);
  if (ambient.HOME !== undefined) environment.HOME = ambient.HOME;
  return environment;
}

function assertConnectorToken(token: string): string {
  if (!token || token.trim() !== token || hasControlCharacters(token)) {
    throw new GwsEaError('invalid_connector_token', 'Cloudflare connector token is invalid');
  }
  return token;
}

async function writeOrVerifyConnectorToken(file: string, token: string): Promise<void> {
  try {
    if ((await readOwnerOnlyFile(file)) !== token) {
      throw new GwsEaError('connector_token_conflict', 'Existing Cloudflare connector token does not match');
    }
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error;
    await writeOwnerOnlyFileExclusive(file, token);
  }
}

export async function prepareCloudflareConnector(layout: CloudflareConnectorLayout, tokenInput: string): Promise<void> {
  const token = assertConnectorToken(tokenInput);
  await preparePrivateLocalDirectory(layout.rootDirectory);
  await preparePrivateLocalDirectory(layout.secretsDirectory);
  await writeOrVerifyConnectorToken(layout.tokenFile, token);
  await writePrivateTextFile(layout.composeFile, renderCloudflareConnectorCompose(layout));
  await writePrivateTextFile(layout.envFile, CONNECTOR_ENV_FILE);
}

export async function validateCloudflareConnectorState(layout: CloudflareConnectorLayout): Promise<void> {
  try {
    await assertPrivateLocalDirectory(layout.rootDirectory);
    await assertPrivateLocalDirectory(layout.secretsDirectory);
    assertConnectorToken(await readOwnerOnlyFile(layout.tokenFile));
    if ((await readOwnerOnlyFile(layout.composeFile)) !== renderCloudflareConnectorCompose(layout)) {
      throw new GwsEaError('cloudflare_connector_state_drift', 'Cloudflare connector Compose state has drifted');
    }
    if ((await readOwnerOnlyFile(layout.envFile)) !== CONNECTOR_ENV_FILE) {
      throw new GwsEaError('cloudflare_connector_state_drift', 'Cloudflare connector environment state has drifted');
    }
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      throw new GwsEaError('cloudflare_connector_state_missing', 'Cloudflare connector private state is missing');
    }
    throw error;
  }
}

function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length && new Set(left).size === left.length && left.every((value) => right.includes(value))
  );
}

export function validateObservedCloudflareConnector(
  layout: CloudflareConnectorLayout,
  observed: ObservedCloudflareConnector,
  options: { readonly requireRunning?: boolean } = {},
): void {
  if (observed.service !== CONNECTOR_ROLE || observed.project !== layout.project) {
    throw new GwsEaError('unsafe_connector_owner', 'Cloudflare connector Compose ownership is invalid');
  }
  if (observed.owner !== CONNECTOR_OWNER || observed.role !== CONNECTOR_ROLE) {
    throw new GwsEaError('unsafe_connector_owner', 'Cloudflare connector ownership labels are invalid');
  }
  if (observed.image !== CLOUDFLARED_IMAGE) {
    throw new GwsEaError('unsafe_connector_image', 'Cloudflare connector image is not the sanctioned immutable pin');
  }
  if (observed.user !== layout.runtimeUser) {
    throw new GwsEaError('unsafe_connector_user', 'Cloudflare connector user is invalid');
  }
  if (!sameArray(observed.command, CONNECTOR_COMMAND)) {
    throw new GwsEaError('unsafe_connector_command', 'Cloudflare connector command is invalid');
  }
  if (!sameSet(observed.environment, EXPECTED_IMAGE_ENVIRONMENT)) {
    throw new GwsEaError('unsafe_connector_environment', 'Cloudflare connector environment is invalid');
  }
  if ((options.requireRunning ?? true) && (!observed.running || observed.restarting)) {
    throw new GwsEaError('unhealthy_connector', 'Cloudflare connector is not running');
  }
  if (
    observed.restartPolicy !== 'unless-stopped' ||
    !observed.readOnlyRootFilesystem ||
    observed.privileged ||
    !sameSet(observed.capabilitiesDropped, ['ALL']) ||
    !sameSet(observed.securityOptions, ['no-new-privileges:true'])
  ) {
    throw new GwsEaError('unsafe_connector_security', 'Cloudflare connector security settings are invalid');
  }
  const expectedNetwork = layout.platform === 'linux' ? 'host' : 'bridge';
  const expectedExtraHosts = layout.platform === 'macos' ? ['host.docker.internal:host-gateway'] : [];
  if (observed.networkMode !== expectedNetwork || !sameSet(observed.extraHosts, expectedExtraHosts)) {
    throw new GwsEaError('unsafe_connector_network', 'Cloudflare connector network settings are invalid');
  }
  const mount = observed.mounts[0];
  if (
    observed.mounts.length !== 1 ||
    mount?.type !== 'bind' ||
    path.resolve(mount.source) !== layout.tokenFile ||
    mount.destination !== CONNECTOR_TOKEN_DESTINATION ||
    !mount.readOnly
  ) {
    throw new GwsEaError('unsafe_connector_mount', 'Cloudflare connector token mount is invalid');
  }
  if (!sameSet(observed.tmpfs, ['/tmp']) || Object.keys(observed.publishedPorts).length !== 0) {
    throw new GwsEaError('unsafe_connector_surface', 'Cloudflare connector runtime surface is invalid');
  }
}

export async function reconcileCloudflareConnector(
  layout: CloudflareConnectorLayout,
  token: string,
  dependencies: CloudflareConnectorDependencies = {},
): Promise<ObservedCloudflareConnector> {
  const runner = dependencies.runCommand ?? runSanitizedCommand;
  const environment = connectorEnvironment(dependencies.ambientEnv);
  await preparePrivateLocalDirectory(layout.rootDirectory);
  const before = await inspectCloudflareConnector(layout, runner, environment);
  if (before !== undefined) validateObservedCloudflareConnector(layout, before, { requireRunning: false });
  await prepareCloudflareConnector(layout, token);
  await runner({
    ...buildCloudflareComposeInvocation(layout, ['up', '--detach', '--remove-orphans']),
    env: environment,
    timeoutMs: 120_000,
    stream: true,
  });
  const after = await inspectCloudflareConnector(layout, runner, environment);
  if (after === undefined) throw new GwsEaError('unhealthy_connector', 'Cloudflare connector did not start');
  validateObservedCloudflareConnector(layout, after);
  await (dependencies.stabilityDelay ?? delay)(500);
  const stable = await inspectCloudflareConnector(layout, runner, environment);
  if (stable === undefined) throw new GwsEaError('unhealthy_connector', 'Cloudflare connector stopped after startup');
  validateObservedCloudflareConnector(layout, stable);
  return stable;
}

export async function stopCloudflareConnector(
  layout: CloudflareConnectorLayout,
  dependencies: CloudflareConnectorDependencies = {},
): Promise<void> {
  const runner = dependencies.runCommand ?? runSanitizedCommand;
  const environment = connectorEnvironment(dependencies.ambientEnv);
  const existing = await inspectCloudflareConnector(layout, runner, environment);
  if (existing === undefined) return;
  validateObservedCloudflareConnector(layout, existing, { requireRunning: false });
  await runner({
    ...buildCloudflareComposeInvocation(layout, ['down', '--remove-orphans']),
    env: environment,
    timeoutMs: 120_000,
    stream: true,
  });
  if ((await inspectCloudflareConnector(layout, runner, environment)) !== undefined) {
    throw new GwsEaError('connector_removal_incomplete', 'Cloudflare connector remains after shutdown');
  }
}

export async function inspectCloudflareConnector(
  layout: CloudflareConnectorLayout,
  runner: SanitizedCommandRunner = runSanitizedCommand,
  environment: Readonly<Record<string, string>> = connectorEnvironment(),
): Promise<ObservedCloudflareConnector | undefined> {
  // The first inspection runs before the connector's private directory exists.
  const cwd = path.dirname(path.dirname(layout.rootDirectory));
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
    cwd,
    env: environment,
    timeoutMs: 30_000,
  });
  const ids = list.stdout
    .split(/\r?\n/u)
    .map((id) => id.trim())
    .filter(Boolean);
  if (ids.length === 0) return undefined;
  if (ids.length !== 1)
    throw new GwsEaError('unsafe_connector_owner', 'Cloudflare connector project has unexpected containers');
  const result = await runner({
    command: 'docker',
    args: ['container', 'inspect', ids[0]!],
    cwd,
    env: environment,
    timeoutMs: 30_000,
  });
  return parseObservedConnector(result.stdout);
}

function requireObject(value: unknown, key: string, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new GwsEaError('invalid_connector_runtime', `${label} is invalid`);
  const nested = value[key];
  if (!isRecord(nested)) throw new GwsEaError('invalid_connector_runtime', `${label} is invalid`);
  return nested;
}

function requireString(value: Record<string, unknown>, key: string, label: string): string {
  const result = value[key];
  if (typeof result !== 'string' || !result) {
    throw new GwsEaError('invalid_connector_runtime', `${label} is missing ${key}`);
  }
  return result;
}

function optionalString(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === 'string' ? value[key] : undefined;
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw new GwsEaError('invalid_connector_runtime', `${label} is invalid`);
  }
  return value;
}

function parseObservedConnector(source: string): ObservedCloudflareConnector {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    throw new GwsEaError('invalid_connector_runtime', 'Docker connector inspection is not valid JSON');
  }
  if (!Array.isArray(parsed) || parsed.length !== 1 || !isRecord(parsed[0])) {
    throw new GwsEaError('invalid_connector_runtime', 'Docker connector inspection is invalid');
  }
  const value = parsed[0];
  const config = requireObject(value, 'Config', 'Docker connector config');
  const labels = requireObject(config, 'Labels', 'Docker connector labels');
  const state = requireObject(value, 'State', 'Docker connector state');
  const hostConfig = requireObject(value, 'HostConfig', 'Docker connector host config');
  const restartPolicy = requireObject(hostConfig, 'RestartPolicy', 'Docker connector restart policy');
  const mountsRaw = value.Mounts;
  if (!Array.isArray(mountsRaw) || !mountsRaw.every(isRecord)) {
    throw new GwsEaError('invalid_connector_runtime', 'Docker connector mounts are invalid');
  }
  const tmpfs = hostConfig.Tmpfs;
  if (!isRecord(tmpfs)) throw new GwsEaError('invalid_connector_runtime', 'Docker connector tmpfs is invalid');
  const portBindings = hostConfig.PortBindings;
  if (portBindings !== null && portBindings !== undefined && !isRecord(portBindings)) {
    throw new GwsEaError('invalid_connector_runtime', 'Docker connector port bindings are invalid');
  }
  return {
    id: requireString(value, 'Id', 'Docker connector'),
    service: requireString(labels, 'com.docker.compose.service', 'Docker connector labels'),
    project: requireString(labels, 'com.docker.compose.project', 'Docker connector labels'),
    owner: optionalString(labels, CLOUDFLARE_CONNECTOR_OWNER_LABEL),
    role: optionalString(labels, CLOUDFLARE_CONNECTOR_ROLE_LABEL),
    image: requireString(config, 'Image', 'Docker connector config'),
    user: requireString(config, 'User', 'Docker connector config'),
    command: stringArray(config.Cmd, 'Docker connector command'),
    environment: stringArray(config.Env, 'Docker connector environment'),
    running: state.Running === true,
    restarting: state.Restarting === true,
    restartPolicy: requireString(restartPolicy, 'Name', 'Docker connector restart policy'),
    readOnlyRootFilesystem: hostConfig.ReadonlyRootfs === true,
    privileged: hostConfig.Privileged === true,
    capabilitiesDropped: stringArray(hostConfig.CapDrop, 'Docker connector dropped capabilities'),
    securityOptions: stringArray(hostConfig.SecurityOpt, 'Docker connector security options'),
    networkMode: requireString(hostConfig, 'NetworkMode', 'Docker connector network mode'),
    extraHosts: stringArray(hostConfig.ExtraHosts, 'Docker connector extra hosts'),
    mounts: mountsRaw.map((mount) => ({
      type: requireString(mount, 'Type', 'Docker connector mount'),
      source: requireString(mount, 'Source', 'Docker connector mount'),
      destination: requireString(mount, 'Destination', 'Docker connector mount'),
      readOnly: mount.RW === false,
    })),
    tmpfs: Object.keys(tmpfs),
    publishedPorts: portBindings ?? {},
  };
}
