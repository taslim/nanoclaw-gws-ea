/**
 * The machine's one shared cloudflared connector. Ownership is the
 * Compose project plus the owner label, checked exactly. Any other difference
 * from the rendered service (image, environment, token, user, security,
 * network, mounts) is drift, repaired by force-recreating the connector from
 * the stored connector token under the machine lock. Repair never needs the
 * Cloudflare account token.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';

import { stringify } from 'yaml';

import { isErrno } from '../community-portal/errors.js';
import { assertPrivateDirectory, preparePrivateDirectory, type ControlPlanePaths } from './paths.js';
import { PRESENT, type Observation } from './phases.js';
import { CLOUDFLARED_IMAGE } from './pins.js';
import {
  buildToolEnvironment,
  runSanitizedCommand,
  type SanitizedCommand,
  type SanitizedCommandRunner,
} from './process.js';
import { registerSecret } from './redact.js';
import { withMachineLock } from './registry.js';
import { readOwnerOnlyFile, writePrivateTextFile } from './secrets.js';
import { GwsEaError } from './types.js';
import { hasControlCharacters, isRecord, optionalString, parseJson, stringField } from './validation.js';

const CONNECTOR_COMMAND = ['tunnel', '--no-autoupdate', 'run', '--token-file', '/run/secrets/tunnel_token'] as const;
const CONNECTOR_TOKEN_DESTINATION = '/run/secrets/tunnel_token';
const CONNECTOR_PROJECT = 'gws-ea-cloudflare';
const CONNECTOR_OWNER = 'shared-cloudflare-ingress';
const CONNECTOR_SERVICE = 'connector';
const CONNECTOR_TMPFS = '/tmp:rw,nosuid,nodev,noexec,size=16m,mode=1777';
const CONNECTOR_ENV_FILE = '# Intentionally empty: the connector token is mounted from its owner-only file.\n';
const INSPECT_TIMEOUT_MS = 30_000;
const PULL_TIMEOUT_MS = 300_000;
const COMPOSE_TIMEOUT_MS = 120_000;
const INVALID_CONNECTOR = 'invalid_connector_runtime';

export const CLOUDFLARE_CONNECTOR_OWNER_LABEL = 'dev.gws-ea.resource-owner' as const;
export const CLOUDFLARE_CONNECTOR_ROLE_LABEL = 'dev.gws-ea.cloudflare-role' as const;
/** SHA-256 of the connector token the container was created with: a rotated token recreates it. */
export const CLOUDFLARE_CONNECTOR_TOKEN_LABEL = 'dev.gws-ea.connector-token-sha256' as const;

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

/** `docker container inspect`, read tolerantly: absent optional fields read as empty. */
export interface ObservedCloudflareConnector {
  readonly id: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly image: string;
  readonly user: string;
  readonly command: readonly string[];
  readonly environment: readonly string[];
  /** Docker's state: running, restarting, created, exited, paused, or dead. */
  readonly state: string;
  readonly exitCode: number | undefined;
  readonly restartCount: number | undefined;
  readonly restartPolicy: string;
  readonly readOnlyRootFilesystem: boolean;
  readonly privileged: boolean;
  readonly capabilitiesAdded: readonly string[];
  readonly capabilitiesDropped: readonly string[];
  readonly securityOptions: readonly string[];
  readonly networkMode: string;
  readonly extraHosts: readonly string[];
  readonly mounts: readonly ObservedCloudflareConnectorMount[];
  readonly tmpfs: readonly string[];
  readonly publishedPorts: readonly string[];
}

export interface CloudflareConnectorDependencies {
  readonly runCommand?: SanitizedCommandRunner;
  readonly ambientEnv?: NodeJS.ProcessEnv;
  /** The Docker endpoint the assistant recorded; without one, Docker's active context. */
  readonly dockerEndpoint?: string;
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

function tokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function renderCloudflareConnectorCompose(
  layout: CloudflareConnectorLayout,
  connectorTokenDigest: string,
): string {
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
      [CLOUDFLARE_CONNECTOR_ROLE_LABEL]: CONNECTOR_SERVICE,
      [CLOUDFLARE_CONNECTOR_TOKEN_LABEL]: connectorTokenDigest,
    },
  };
  if (layout.platform === 'macos') service.extra_hosts = ['host.docker.internal:host-gateway'];
  return stringify(
    {
      services: { [CONNECTOR_SERVICE]: service },
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

function connectorEnvironment(
  dependencies: Pick<CloudflareConnectorDependencies, 'ambientEnv' | 'dockerEndpoint'> = {},
): Readonly<Record<string, string>> {
  const ambient = dependencies.ambientEnv ?? process.env;
  const environment = buildToolEnvironment(
    ambient,
    dependencies.dockerEndpoint === undefined ? {} : { DOCKER_HOST: dependencies.dockerEndpoint },
  );
  if (ambient.HOME !== undefined) environment.HOME = ambient.HOME;
  return environment;
}

/** Docker runs before the connector's private directory exists, so it runs from the state root. */
function dockerDirectory(layout: CloudflareConnectorLayout): string {
  return path.dirname(path.dirname(layout.rootDirectory));
}

function isValidToken(token: string): boolean {
  return token !== '' && token.trim() === token && !hasControlCharacters(token);
}

async function readStoredToken(layout: CloudflareConnectorLayout): Promise<string | undefined> {
  try {
    await assertPrivateDirectory(layout.secretsDirectory);
    return await readOwnerOnlyFile(layout.tokenFile);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
  }
}

async function requireStoredToken(layout: CloudflareConnectorLayout): Promise<string> {
  const token = await readStoredToken(layout);
  if (token === undefined || !isValidToken(token)) {
    throw new GwsEaError(
      'cloudflare_connector_token_missing',
      'The stored Cloudflare connector token is missing; the Cloudflare route step stores it again',
    );
  }
  return token;
}

/** Whether a usable connector token is stored for repair. */
export async function hasConnectorToken(layout: CloudflareConnectorLayout): Promise<boolean> {
  const token = await readStoredToken(layout);
  return token !== undefined && isValidToken(token);
}

/** Store the connector token read from the owned tunnel; it replaces a rotated one. */
export async function storeConnectorToken(layout: CloudflareConnectorLayout, token: string): Promise<void> {
  if (!isValidToken(token)) throw new GwsEaError('invalid_connector_token', 'Cloudflare connector token is invalid');
  registerSecret(token);
  await preparePrivateDirectory(layout.rootDirectory);
  await preparePrivateDirectory(layout.secretsDirectory);
  if ((await readStoredToken(layout)) !== token) await writePrivateTextFile(layout.tokenFile, token);
}

/** The Compose project and owner label, exactly: anything else in the project is refused, never replaced. */
export function assertCloudflareConnectorOwnership(
  layout: CloudflareConnectorLayout,
  observed: ObservedCloudflareConnector,
): void {
  const { labels } = observed;
  if (
    labels['com.docker.compose.project'] !== layout.project ||
    labels['com.docker.compose.service'] !== CONNECTOR_SERVICE ||
    labels[CLOUDFLARE_CONNECTOR_OWNER_LABEL] !== CONNECTOR_OWNER ||
    labels[CLOUDFLARE_CONNECTOR_ROLE_LABEL] !== CONNECTOR_SERVICE
  ) {
    throw new GwsEaError(
      'unsafe_connector_owner',
      'A container in the Cloudflare connector project is not the owned connector; refusing to change it',
    );
  }
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

/** How an owned connector differs from its rendered service, or undefined when it does not. */
function connectorDrift(
  layout: CloudflareConnectorLayout,
  observed: ObservedCloudflareConnector,
  expected: { readonly tokenDigest: string; readonly imageEnvironment: readonly string[] },
): string | undefined {
  if (observed.image !== CLOUDFLARED_IMAGE) return `runs ${observed.image}, not the pinned ${CLOUDFLARED_IMAGE}`;
  // Only variable names: an injected value could be a secret.
  const added = observed.environment.filter((entry) => !expected.imageEnvironment.includes(entry));
  if (added.length > 0) {
    return `has environment its image does not set: ${added.map((entry) => entry.split('=')[0]).join(', ')}`;
  }
  if (observed.labels[CLOUDFLARE_CONNECTOR_TOKEN_LABEL] !== expected.tokenDigest) {
    return 'was started with a different connector token';
  }
  if (
    observed.user !== layout.runtimeUser ||
    observed.command.length !== CONNECTOR_COMMAND.length ||
    observed.command.some((word, index) => word !== CONNECTOR_COMMAND[index])
  ) {
    return 'runs a different user or command';
  }
  if (
    observed.restartPolicy !== 'unless-stopped' ||
    !observed.readOnlyRootFilesystem ||
    observed.privileged ||
    observed.capabilitiesAdded.length > 0 ||
    !sameSet(observed.capabilitiesDropped, ['ALL']) ||
    !sameSet(observed.securityOptions, ['no-new-privileges:true'])
  ) {
    return 'security settings differ';
  }
  const network = layout.platform === 'linux' ? 'host' : 'bridge';
  const extraHosts = layout.platform === 'macos' ? ['host.docker.internal:host-gateway'] : [];
  if (observed.networkMode !== network || !sameSet(observed.extraHosts, extraHosts)) {
    return 'network settings differ';
  }
  const [mount] = observed.mounts;
  if (
    observed.mounts.length !== 1 ||
    mount?.type !== 'bind' ||
    path.resolve(mount.source) !== layout.tokenFile ||
    mount.destination !== CONNECTOR_TOKEN_DESTINATION ||
    !mount.readOnly
  ) {
    return 'does not mount exactly its token file, read-only';
  }
  if (!sameSet(observed.tmpfs, ['/tmp']) || observed.publishedPorts.length > 0) {
    return 'exposes a different runtime surface';
  }
  return undefined;
}

async function imageEnvironment(
  runner: SanitizedCommandRunner,
  layout: CloudflareConnectorLayout,
  environment: Readonly<Record<string, string>>,
): Promise<readonly string[]> {
  const { stdout } = await runner({
    command: 'docker',
    args: ['image', 'inspect', '--format', '{{json .Config.Env}}', CLOUDFLARED_IMAGE],
    cwd: dockerDirectory(layout),
    env: environment,
    timeoutMs: INSPECT_TIMEOUT_MS,
  });
  return strings(parseJson(stdout, 'Docker image environment', INVALID_CONNECTOR));
}

/**
 * Present when the owned connector runs exactly as rendered. A restarting
 * connector is unknown (it may still be starting); a missing, stopped, or
 * drifted one is absent, so liveness repairs it at once.
 */
export async function observeCloudflareConnector(
  layout: CloudflareConnectorLayout,
  dependencies: CloudflareConnectorDependencies = {},
): Promise<Observation> {
  const runner = dependencies.runCommand ?? runSanitizedCommand;
  const environment = connectorEnvironment(dependencies);
  const observed = await inspectCloudflareConnector(layout, runner, environment);
  if (!observed) return { status: 'absent', reason: 'it has not been created' };
  assertCloudflareConnectorOwnership(layout, observed);
  const drift = connectorDrift(layout, observed, {
    tokenDigest: tokenDigest(await requireStoredToken(layout)),
    imageEnvironment: observed.image === CLOUDFLARED_IMAGE ? await imageEnvironment(runner, layout, environment) : [],
  });
  if (drift) return { status: 'absent', reason: `it ${drift}` };
  if (observed.state === 'running') return PRESENT;
  if (observed.state === 'restarting') {
    return {
      status: 'unknown',
      reason: 'The Cloudflare connector is restarting',
      evidence: `state restarting, exit code ${observed.exitCode ?? 'unknown'}, ${observed.restartCount ?? 0} restarts`,
    };
  }
  return { status: 'absent', reason: `it is ${observed.state}` };
}

/**
 * Recreate the connector from the stored connector token. The image is pulled
 * first, outside the machine lock, only for a new or re-pinned connector; the
 * recreate runs under the lock after one more look, so concurrent repairs by
 * two assistants recreate it once.
 */
export async function repairCloudflareConnector(
  paths: ControlPlanePaths,
  layout: CloudflareConnectorLayout,
  dependencies: CloudflareConnectorDependencies = {},
): Promise<void> {
  const runner = dependencies.runCommand ?? runSanitizedCommand;
  const environment = connectorEnvironment(dependencies);
  const token = await requireStoredToken(layout);
  const before = await inspectCloudflareConnector(layout, runner, environment);
  if (before) assertCloudflareConnectorOwnership(layout, before);
  if (before?.image !== CLOUDFLARED_IMAGE) {
    await runner({
      command: 'docker',
      args: ['pull', CLOUDFLARED_IMAGE],
      cwd: dockerDirectory(layout),
      env: environment,
      timeoutMs: PULL_TIMEOUT_MS,
      stream: true,
    });
  }
  await withMachineLock(paths, async () => {
    if ((await observeCloudflareConnector(layout, dependencies)).status === 'present') return;
    await preparePrivateDirectory(layout.rootDirectory);
    await writePrivateTextFile(layout.composeFile, renderCloudflareConnectorCompose(layout, tokenDigest(token)));
    await writePrivateTextFile(layout.envFile, CONNECTOR_ENV_FILE);
    await runner({
      ...buildCloudflareComposeInvocation(layout, ['up', '--detach', '--force-recreate', '--remove-orphans']),
      env: environment,
      timeoutMs: COMPOSE_TIMEOUT_MS,
      stream: true,
    });
  });
}

/** Stop and remove the owned connector, drifted or not; a foreign container is refused. */
export async function stopCloudflareConnector(
  layout: CloudflareConnectorLayout,
  dependencies: CloudflareConnectorDependencies = {},
): Promise<void> {
  const runner = dependencies.runCommand ?? runSanitizedCommand;
  const environment = connectorEnvironment(dependencies);
  const existing = await inspectCloudflareConnector(layout, runner, environment);
  if (existing === undefined) return;
  assertCloudflareConnectorOwnership(layout, existing);
  await runner({
    ...buildCloudflareComposeInvocation(layout, ['down', '--remove-orphans']),
    env: environment,
    timeoutMs: COMPOSE_TIMEOUT_MS,
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
  const cwd = dockerDirectory(layout);
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
    timeoutMs: INSPECT_TIMEOUT_MS,
  });
  const ids = list.stdout
    .split(/\r?\n/u)
    .map((id) => id.trim())
    .filter(Boolean);
  if (ids.length === 0) return undefined;
  if (ids.length !== 1) {
    throw new GwsEaError('unsafe_connector_owner', 'Cloudflare connector project has unexpected containers');
  }
  const result = await runner({
    command: 'docker',
    args: ['container', 'inspect', ids[0]!],
    cwd,
    env: environment,
    timeoutMs: INSPECT_TIMEOUT_MS,
  });
  return parseObservedConnector(result.stdout);
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function parseObservedConnector(source: string): ObservedCloudflareConnector {
  const parsed = parseJson(source, 'Docker connector inspection', INVALID_CONNECTOR);
  if (!Array.isArray(parsed) || parsed.length !== 1 || !isRecord(parsed[0])) {
    throw new GwsEaError(INVALID_CONNECTOR, 'Docker connector inspection is invalid');
  }
  const value = parsed[0];
  const config = record(value.Config);
  const state = record(value.State);
  const host = record(value.HostConfig);
  const labels = Object.fromEntries(
    Object.entries(record(config.Labels)).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
  return {
    id: stringField(value, 'Id', 'Docker connector', INVALID_CONNECTOR),
    labels,
    image: stringField(config, 'Image', 'Docker connector config', INVALID_CONNECTOR),
    user: optionalString(config.User) ?? '',
    command: strings(config.Cmd),
    environment: strings(config.Env),
    state:
      optionalString(state.Status) ??
      (state.Restarting === true ? 'restarting' : state.Running === true ? 'running' : 'exited'),
    exitCode: count(state.ExitCode),
    restartCount: count(value.RestartCount),
    restartPolicy: optionalString(record(host.RestartPolicy).Name) ?? '',
    readOnlyRootFilesystem: host.ReadonlyRootfs === true,
    privileged: host.Privileged === true,
    capabilitiesAdded: strings(host.CapAdd),
    capabilitiesDropped: strings(host.CapDrop),
    securityOptions: strings(host.SecurityOpt),
    networkMode: optionalString(host.NetworkMode) ?? '',
    extraHosts: strings(host.ExtraHosts),
    mounts: (Array.isArray(value.Mounts) ? value.Mounts : []).filter(isRecord).map((mount) => ({
      type: optionalString(mount.Type) ?? '',
      source: optionalString(mount.Source) ?? '',
      destination: optionalString(mount.Destination) ?? '',
      readOnly: mount.RW === false,
    })),
    tmpfs: Object.keys(record(host.Tmpfs)),
    publishedPorts: Object.keys(record(host.PortBindings)),
  };
}
