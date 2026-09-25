/**
 * Prerequisites: what create and resume need from this machine and the
 * operator's Google sign-in, checked before anything is reserved and again on
 * every resume. Local checks run first, so a stopped Docker is named before
 * anyone is asked to sign in.
 */
import { request as httpRequest } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { errorCode } from '../community-portal/errors.js';
import { SignInRequired, withGoogleSignIn, type Interaction } from './events.js';
import {
  activeGcloudAccount,
  assertGcloudInstalled,
  assertGcloudSignedIn,
  isConsumerGoogleAccount,
  isGoogleAccountAddress,
} from './gcloud.js';
import { ONECLI_CLI_VERSION } from './pins.js';
import { protectFromAgentMounts } from './mount-allowlist.js';
import { CONTROL_PLANE_ROOT, type ControlPlanePaths } from './paths.js';
import {
  buildToolEnvironment,
  checkedRunner,
  missingExecutable,
  resolvePersistedExecutable,
  runSanitizedCommandOutcome,
  type SanitizedCommand,
  type SanitizedCommandOutcomeRunner,
} from './process.js';
import { assertInstalledOnecliCli } from './release-preflight.js';
import { instanceServicePlatform } from './service-coordinates.js';
import { GwsEaError, type GwsEaErrorDetails } from './types.js';
import { isRecord, parseJson, unixSocketPath } from './validation.js';

const DOCKER_PING_TIMEOUT_MS = 5_000;
const TOOL_TIMEOUT_MS = 30_000;

/** gws-ea's own roots: executables may not live in its instances, and agent mounts may not reach any of them. */
export type PrerequisitePaths = Pick<ControlPlanePaths, 'configRoot' | 'stateRoot' | 'logsRoot' | 'instancesRoot'>;

export type PrerequisiteRequest =
  /** `account` is `--google-account`; without it the operator confirms the signed-in account. */
  | { readonly command: 'create'; readonly paths: PrerequisitePaths; readonly account?: string }
  /**
   * `account` is the reserved account, which must still be signed in;
   * `dockerEndpoint`, once create recorded it, is probed instead of the active context.
   */
  | {
      readonly command: 'resume';
      readonly paths: PrerequisitePaths;
      readonly account: string;
      readonly dockerEndpoint?: string;
    };

/** What the prerequisites established about this host, as create records it. */
export interface Prerequisites {
  readonly platform: 'macos' | 'linux';
  readonly homeDirectory: string;
  readonly runningAsRoot: boolean;
  /** Real path of the Node.js running gws-ea, which can replace a process (`process.execve`). */
  readonly nodePath: string;
  /** Real path of the OneCLI CLI; at create it reports the pinned version. */
  readonly onecliCliPath: string;
  /** The active Docker context's local `unix://` endpoint, answered by a running daemon. */
  readonly dockerEndpoint: string;
  /** The signed-in Google Workspace account that owns the assistant's Google Cloud project. */
  readonly account: string;
}

export type PrerequisiteInteraction = Pick<Interaction, 'signInToGoogleCloud' | 'confirmGoogleAccount'>;

export interface PrerequisiteDependencies {
  /** Runs git, pnpm, onecli, docker, and gcloud. */
  readonly runCommand?: SanitizedCommandOutcomeRunner;
  /** Resolves an executable the instance service will run (`node`, `onecli`). */
  readonly resolvePersisted?: typeof resolvePersistedExecutable;
  readonly node?: Pick<NodeJS.Process, 'version' | 'execPath' | 'execve'>;
  readonly platform?: NodeJS.Platform;
  /** The shared NanoClaw mount allowlist; its documented location under the home directory by default. */
  readonly mountAllowlistFile?: string;
}

function toolEnvironment(): Readonly<Record<string, string>> {
  return buildToolEnvironment(process.env, { HOME: os.homedir() });
}

function toolCommand(command: string, args: readonly string[]): SanitizedCommand {
  return { command, args, cwd: CONTROL_PLANE_ROOT, env: toolEnvironment(), timeoutMs: TOOL_TIMEOUT_MS };
}

function supportedPlatform(platform: NodeJS.Platform): Prerequisites['platform'] {
  if (platform !== 'darwin' && platform !== 'linux') {
    throw new GwsEaError('unsupported_platform', 'GWS-EA supports macOS and Linux hosts');
  }
  return instanceServicePlatform(platform);
}

/** The instance service replaces its launcher with the host process, which needs `process.execve`. */
function assertNodeExecve(node: Pick<NodeJS.Process, 'version' | 'execve'>): void {
  if (typeof node.execve === 'function') return;
  throw new GwsEaError(
    'node_unsupported',
    `Node.js ${node.version} cannot replace a process (process.execve), which the assistant service needs. Install Node.js 22.15 or later on 22.x, or 23.11 or later, then retry.`,
    { details: { version: node.version } },
  );
}

async function assertTools(runner: SanitizedCommandOutcomeRunner): Promise<void> {
  const run = checkedRunner(runner);
  await run(toolCommand('git', ['--version'])).catch((error: unknown) =>
    missingExecutable(error, 'git_required', 'Git is required but was not found on PATH. Install it, then retry.'),
  );
  await run(toolCommand('pnpm', ['--version'])).catch((error: unknown) =>
    missingExecutable(
      error,
      'pnpm_required',
      'pnpm is required but was not found on PATH. Install it (https://pnpm.io/installation), then retry.',
    ),
  );
}

async function locateOnecli(
  resolvePersisted: typeof resolvePersistedExecutable,
  checkoutRoots: readonly string[],
): Promise<string> {
  const searchPath = [path.join(os.homedir(), '.local', 'bin'), process.env.PATH ?? ''].join(path.delimiter);
  return resolvePersisted('onecli', { searchPath, checkoutRoots }).catch((error: unknown) =>
    missingExecutable(
      error,
      'onecli_required',
      `OneCLI CLI ${ONECLI_CLI_VERSION} is required but was not found on PATH or in ~/.local/bin. Install it, then retry.`,
    ),
  );
}

type DockerDaemonState =
  | { readonly state: 'running' }
  | { readonly state: 'stopped' | 'no-permission'; readonly evidence: string };

/** Ask the daemon behind a unix socket for the Engine API's `GET /_ping`. */
function pingDocker(socketPath: string): Promise<DockerDaemonState> {
  return new Promise((resolve) => {
    const request = httpRequest(
      { socketPath, path: '/_ping', method: 'GET', agent: false, timeout: DOCKER_PING_TIMEOUT_MS },
      (response) => {
        response.resume();
        resolve(
          response.statusCode === 200
            ? { state: 'running' }
            : { state: 'stopped', evidence: `HTTP ${response.statusCode}` },
        );
      },
    );
    request.once('timeout', () => {
      resolve({ state: 'stopped', evidence: `no answer within ${DOCKER_PING_TIMEOUT_MS / 1000}s` });
      request.destroy();
    });
    request.once('error', (error) => {
      const errno = errorCode(error, 'unknown');
      resolve({ state: errno === 'EACCES' || errno === 'EPERM' ? 'no-permission' : 'stopped', evidence: errno });
    });
    request.end();
  });
}

function parseDockerContext(stdout: string): { readonly name: string; readonly endpoint: string } {
  const parsed = parseJson(stdout, 'docker context inspect output', 'invalid_docker_output');
  const context: unknown = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : undefined;
  const endpoints = isRecord(context) && isRecord(context.Endpoints) ? context.Endpoints : undefined;
  const docker = endpoints && isRecord(endpoints.docker) ? endpoints.docker : undefined;
  if (!isRecord(context) || typeof context.Name !== 'string' || typeof docker?.Host !== 'string') {
    throw new GwsEaError('invalid_docker_output', 'docker context inspect returned no Docker endpoint');
  }
  return { name: context.Name, endpoint: docker.Host };
}

/**
 * Resolve the active Docker context, under the same environment every tool
 * gets, to its endpoint. Only a local `unix://` socket answered by a
 * running daemon is accepted.
 */
export async function resolveDockerEndpoint(
  runner: SanitizedCommandOutcomeRunner = runSanitizedCommandOutcome,
): Promise<string> {
  const { stdout } = await checkedRunner(runner)(toolCommand('docker', ['context', 'inspect'])).catch(
    (error: unknown) =>
      missingExecutable(
        error,
        'docker_required',
        'Docker is required but was not found on PATH. Install Docker Desktop (macOS) or Docker Engine (Linux), then retry.',
      ),
  );
  const { name, endpoint } = parseDockerContext(stdout);
  const socket = unixSocketPath(endpoint);
  if (!socket) {
    throw new GwsEaError(
      'docker_remote',
      `The active Docker context ${name} points at ${endpoint}; GWS-EA needs a local Docker daemon on a unix:// socket. Switch to a local context (docker context use <name>), then retry.`,
      { details: { context: name, endpoint } },
    );
  }
  await assertDockerRunning(endpoint, socket, {
    where: `the endpoint of the active context ${name}`,
    fix: 'Start Docker, or switch to a running local context (docker context use <name>), then retry.',
    details: { context: name },
  });
  return endpoint;
}

/**
 * Resume probes the endpoint create recorded rather than the active context,
 * so switching contexts can neither move nor strand a running assistant.
 */
export async function probeRecordedDockerEndpoint(endpoint: string): Promise<string> {
  const socket = unixSocketPath(endpoint);
  if (!socket) throw new GwsEaError('docker_remote', `The recorded Docker endpoint ${endpoint} is not a local socket`);
  await assertDockerRunning(endpoint, socket, {
    where: 'the endpoint this assistant was created with',
    fix: 'Start Docker there, then retry.',
    details: {},
  });
  return endpoint;
}

async function assertDockerRunning(
  endpoint: string,
  socket: string,
  context: { readonly where: string; readonly fix: string; readonly details: GwsEaErrorDetails },
): Promise<void> {
  const daemon = await pingDocker(socket);
  if (daemon.state === 'running') return;
  const details = { ...context.details, endpoint, evidence: daemon.evidence };
  if (daemon.state === 'no-permission') {
    throw new GwsEaError(
      'docker_permission_denied',
      `This user may not use the Docker daemon at ${endpoint} (${daemon.evidence}). Grant access to its socket (on Linux, add the user to the docker group and sign in again), then retry.`,
      { details },
    );
  }
  throw new GwsEaError(
    'docker_stopped',
    `Docker is not running at ${endpoint}, ${context.where} (${daemon.evidence}). ${context.fix}`,
    { details },
  );
}

function assertWorkspaceAccount(account: string): void {
  if (!isConsumerGoogleAccount(account)) return;
  throw new GwsEaError(
    'consumer_google_account',
    `${account} is a personal Google account; the assistant's Google Cloud project needs a Google Workspace account. Sign in with one (gcloud auth login <account> --force) or pass --google-account <account>, then retry.`,
  );
}

/** Create without `--google-account`: the signed-in account, once the operator confirms it. */
async function confirmedAccount(
  interaction: PrerequisiteInteraction,
  runner: SanitizedCommandOutcomeRunner,
): Promise<string> {
  for (let signedIn = false; ; signedIn = true) {
    const active = await activeGcloudAccount(runner);
    if (active !== undefined) {
      assertWorkspaceAccount(active);
      if (await interaction.confirmGoogleAccount(active)) return active;
    } else if (signedIn) {
      throw new SignInRequired('Google Cloud sign-in finished without a signed-in account');
    }
    // Nobody is signed in, or the operator wants another account: the browser flow lets them pick one.
    await interaction.signInToGoogleCloud();
  }
}

/** The Google account for this run, signed in with credentials that still refresh. */
async function googleAccount(
  request: PrerequisiteRequest,
  interaction: PrerequisiteInteraction,
  runner: SanitizedCommandOutcomeRunner,
): Promise<string> {
  if (request.account !== undefined) {
    if (!isGoogleAccountAddress(request.account)) {
      throw new GwsEaError('invalid_arguments', '--google-account: enter the email address of a Google account', {
        details: { flag: '--google-account' },
      });
    }
    assertWorkspaceAccount(request.account);
  }
  await assertGcloudInstalled(runner);
  const account = request.account ?? (await confirmedAccount(interaction, runner));
  await withGoogleSignIn(
    () => assertGcloudSignedIn(account, runner),
    () => interaction.signInToGoogleCloud(account),
  );
  return account;
}

/** Check every prerequisite, guiding sign-in through the `Interaction` port, and report the host. */
export async function checkPrerequisites(
  request: PrerequisiteRequest,
  interaction: PrerequisiteInteraction,
  dependencies: PrerequisiteDependencies = {},
): Promise<Prerequisites> {
  const runner = dependencies.runCommand ?? runSanitizedCommandOutcome;
  const resolvePersisted = dependencies.resolvePersisted ?? resolvePersistedExecutable;
  const node = dependencies.node ?? process;
  const checkoutRoots = [request.paths.instancesRoot];
  const homeDirectory = os.homedir();

  const platform = supportedPlatform(dependencies.platform ?? process.platform);
  assertNodeExecve(node);
  await protectFromAgentMounts(request.paths, {
    homeDirectory,
    ...(dependencies.mountAllowlistFile ? { file: dependencies.mountAllowlistFile } : {}),
  });
  const nodePath = await resolvePersisted(node.execPath, { checkoutRoots });
  await assertTools(runner);
  const onecliCliPath = await locateOnecli(resolvePersisted, checkoutRoots);
  // Pins are compared when an assistant is created; a later launcher upgrade must not block its resume.
  if (request.command === 'create') {
    await assertInstalledOnecliCli(
      onecliCliPath,
      ONECLI_CLI_VERSION,
      CONTROL_PLANE_ROOT,
      toolEnvironment(),
      checkedRunner(runner),
    );
  }
  const dockerEndpoint =
    request.command === 'resume' && request.dockerEndpoint !== undefined
      ? await probeRecordedDockerEndpoint(request.dockerEndpoint)
      : await resolveDockerEndpoint(runner);
  const account = await googleAccount(request, interaction, runner);
  return {
    platform,
    homeDirectory,
    runningAsRoot: process.getuid?.() === 0,
    nodePath,
    onecliCliPath,
    dockerEndpoint,
    account,
  };
}
