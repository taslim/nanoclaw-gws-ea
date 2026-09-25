import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Readable, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { errorCode, isErrno } from '../community-portal/errors.js';
import { CONTROL_PLANE_ROOT, isWithinDirectory } from './paths.js';
import { createStreamRedactor, redact, registerSecret } from './redact.js';
import { activeStep, type StepLog } from './run-log.js';
import { GwsEaError } from './types.js';

/** Ambient variables the instance host process inherits. Unchanged by KTD3. */
export const INSTANCE_HOST_ENVIRONMENT_KEYS = [
  'PATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TMPDIR',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
] as const;

/**
 * Ambient variables every tool the control plane runs inherits (KTD3). Never
 * SSH_AUTH_SOCK, GOOGLE_APPLICATION_CREDENTIALS, or any other CLOUDSDK_*,
 * CLOUDFLARE_*, ONECLI_*, ANTHROPIC_*, or GCHAT_* variable.
 */
export const TOOL_ENVIRONMENT_KEYS = [
  ...INSTANCE_HOST_ENVIRONMENT_KEYS,
  'DOCKER_CONFIG',
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
  'USER',
  'LOGNAME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
  'CLOUDSDK_CONFIG',
  'CLOUDSDK_PYTHON',
] as const;

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_PARSED_OUTPUT_LIMIT_BYTES = 16 * 1024 * 1024;
const STDERR_RETAINED_CHARACTERS = 64 * 1024;
const STDERR_TAIL_LINES = 20;
const STDERR_TAIL_CHARACTERS = 4000;
const DISPLAY_CHARACTERS = 400;
const PIPE_RELEASE_GRACE_MS = 2_000;
const SECRET_ENVIRONMENT_KEY = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/u;
const TEMPORARY_ROOTS = ['/tmp', '/var/tmp', '/dev/shm'];
const FORWARDED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

export interface SanitizedCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  /** Cap on parsed stdout. Streamed output is never capped. */
  readonly outputLimitBytes?: number;
  /**
   * Tee stdout and stderr, redacted, into the active step's raw log instead of
   * returning stdout. Only for output nobody parses: image builds and compose.
   */
  readonly stream?: boolean;
  /** Text written to the child's stdin, then closed. Never logged. */
  readonly input?: string;
}

export interface SanitizedCommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export type SanitizedCommandRunner = (command: SanitizedCommand) => Promise<SanitizedCommandResult>;

export interface SanitizedCommandOutcome extends SanitizedCommandResult {
  readonly exitCode: number;
}

export type SanitizedCommandOutcomeRunner = (command: SanitizedCommand) => Promise<SanitizedCommandOutcome>;

export interface PersistedExecutableOptions {
  readonly searchPath?: string;
  /** Checkout roots besides the control plane's own, such as the instances root. */
  readonly checkoutRoots?: readonly string[];
}

interface FailureFacts {
  readonly exitCode?: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly errno?: string;
  readonly stderr?: string;
  readonly timeoutMs?: number;
}

function buildEnvironment(
  keys: readonly string[],
  ambient: NodeJS.ProcessEnv,
  overrides: Readonly<Record<string, string>>,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of keys) {
    const value = ambient[key];
    if (value !== undefined) environment[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (!/^[A-Z_][A-Z0-9_]*$/u.test(key) || value.includes('\0')) {
      throw new GwsEaError('invalid_environment', 'A constructed process environment entry is invalid');
    }
    environment[key] = value;
  }
  return environment;
}

/** Whether an environment variable's name marks its value as a secret. */
export function isSecretEnvironmentKey(key: string): boolean {
  return SECRET_ENVIRONMENT_KEY.test(key);
}

/** Environment for a tool the control plane runs: the tool allowlist plus explicit overrides. */
export function buildToolEnvironment(
  ambient: NodeJS.ProcessEnv = process.env,
  overrides: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return buildEnvironment(TOOL_ENVIRONMENT_KEYS, ambient, overrides);
}

/** Environment for the instance host process: the host allowlist plus explicit overrides. */
export function buildHostEnvironment(
  ambient: NodeJS.ProcessEnv = process.env,
  overrides: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return buildEnvironment(INSTANCE_HOST_ENVIRONMENT_KEYS, ambient, overrides);
}

/** The operator's PATH minus empty and relative entries. */
function executableSearchPath(value: string | undefined): string[] {
  return (value ?? '').split(path.delimiter).filter((entry) => path.isAbsolute(entry));
}

async function isExecutableFile(candidate: string): Promise<boolean> {
  try {
    await access(candidate, fsConstants.X_OK);
    return (await stat(candidate)).isFile();
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'ELOOP'].includes(errorCode(error, ''))) return false;
    throw error;
  }
}

async function locateExecutable(command: string, searched: readonly string[]): Promise<string> {
  if (!command || command.includes('\0') || (!path.isAbsolute(command) && command !== path.basename(command))) {
    throw new GwsEaError('invalid_executable', `Executable must be a bare name or an absolute path: ${command}`);
  }
  const candidates = path.isAbsolute(command) ? [command] : searched.map((directory) => path.join(directory, command));
  for (const candidate of candidates) {
    if (await isExecutableFile(candidate)) return candidate;
  }
  throw new GwsEaError(
    'executable_not_found',
    path.isAbsolute(command) ? `${command} is not an executable file` : `${command} was not found on PATH`,
    { details: { program: command, searched: path.isAbsolute(command) ? [] : [...searched] } },
  );
}

/** Resolve a tool from the operator's PATH, ignoring empty and relative entries. */
export async function resolveExecutable(
  command: string,
  searchPath: string | undefined = process.env.PATH,
): Promise<string> {
  return locateExecutable(command, executableSearchPath(searchPath));
}

async function canonicalRoots(roots: readonly string[]): Promise<string[]> {
  return Promise.all(
    roots.map(async (root) => {
      try {
        return await realpath(root);
      } catch (error) {
        if (isErrno(error, 'ENOENT')) return path.resolve(root);
        throw error;
      }
    }),
  );
}

/**
 * Resolve an executable persisted into runtime.json and the service unit
 * (`node`, `onecli`) to its real path. Refused in a group- or world-writable
 * directory, inside any checkout, or inside a temporary directory.
 */
export async function resolvePersistedExecutable(
  command: string,
  options: PersistedExecutableOptions = {},
): Promise<string> {
  const executable = await realpath(await resolveExecutable(command, options.searchPath));
  const refuse = (reason: string): GwsEaError =>
    new GwsEaError(
      'untrusted_executable',
      `${path.basename(command)} at ${executable} ${reason}; install it in an operator-owned location, then retry`,
      { details: { program: command, executable } },
    );
  const [file, directory] = await Promise.all([stat(executable), stat(path.dirname(executable))]);
  if (((file.mode | directory.mode) & 0o022) !== 0) throw refuse('is in a group- or world-writable location');
  for (const root of await canonicalRoots([CONTROL_PLANE_ROOT, ...(options.checkoutRoots ?? [])])) {
    if (isWithinDirectory(executable, root)) throw refuse(`is inside a checkout (${root})`);
  }
  for (const root of await canonicalRoots([os.tmpdir(), ...TEMPORARY_ROOTS])) {
    if (isWithinDirectory(executable, root)) throw refuse(`is inside a temporary directory (${root})`);
  }
  return executable;
}

function displayArgument(argument: string): string {
  return argument === '' || /[\s"'\\$`]/u.test(argument) ? JSON.stringify(argument) : argument;
}

function displayCommand(command: SanitizedCommand): string {
  const display = [command.command, ...command.args.map(redact)].map(displayArgument).join(' ');
  return display.length > DISPLAY_CHARACTERS ? `${display.slice(0, DISPLAY_CHARACTERS)}…` : display;
}

function stderrTail(stderr: string): string {
  const tail = redact(stderr).trim().split('\n').slice(-STDERR_TAIL_LINES).join('\n');
  return tail.length > STDERR_TAIL_CHARACTERS ? tail.slice(-STDERR_TAIL_CHARACTERS) : tail;
}

function commandFailure(
  code: string,
  summary: string,
  command: SanitizedCommand,
  facts: FailureFacts,
  cause?: unknown,
): GwsEaError {
  const details = {
    program: command.command,
    args: command.args.map(redact),
    cwd: command.cwd,
    exitCode: facts.exitCode ?? null,
    signal: facts.signal ?? null,
    errno: facts.errno ?? null,
    stderrTail: stderrTail(facts.stderr ?? ''),
    ...(facts.timeoutMs === undefined ? {} : { timeoutMs: facts.timeoutMs }),
  };
  const message = `${summary}: ${displayCommand(command)}`;
  return new GwsEaError(code, message, cause === undefined ? { details } : { cause, details });
}

/** The error a caller raises for a command that exited non-zero. */
export function commandExitError(command: SanitizedCommand, outcome: SanitizedCommandOutcome): GwsEaError {
  return commandFailure('command_failed', `Command failed (exit code ${outcome.exitCode})`, command, {
    exitCode: outcome.exitCode,
    stderr: outcome.stderr,
  });
}

// Children run in their own process groups so a timeout can kill grandchildren.
// Signals the terminal sends to the control plane are forwarded to those groups,
// and every live group is killed if the control plane exits.
const activeGroups = new Set<number>();
let forwarding = false;

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!isErrno(error, 'ESRCH') && !isErrno(error, 'EPERM')) throw error;
  }
}

function killActiveGroups(): void {
  for (const pid of activeGroups) signalGroup(pid, 'SIGKILL');
}

const forwarders = new Map(
  FORWARDED_SIGNALS.map((signal) => [
    signal,
    (): void => {
      for (const pid of activeGroups) signalGroup(pid, signal);
      if (process.listenerCount(signal) === 1) {
        // Nothing else handles this signal: restore the default action and re-raise it.
        stopForwarding();
        process.kill(process.pid, signal);
      }
    },
  ]),
);

function stopForwarding(): void {
  if (!forwarding) return;
  forwarding = false;
  for (const [signal, listener] of forwarders) process.off(signal, listener);
  process.off('exit', killActiveGroups);
}

function trackGroup(pid: number): void {
  activeGroups.add(pid);
  if (forwarding) return;
  forwarding = true;
  for (const [signal, listener] of forwarders) process.on(signal, listener);
  process.on('exit', killActiveGroups);
}

function releaseGroup(pid: number): void {
  activeGroups.delete(pid);
  if (activeGroups.size === 0) stopForwarding();
}

async function assertWorkingDirectory(command: SanitizedCommand): Promise<void> {
  let isDirectory: boolean;
  try {
    isDirectory = (await stat(command.cwd)).isDirectory();
  } catch (error) {
    const errno = errorCode(error, 'unknown');
    throw commandFailure(
      'command_failed',
      `Working directory ${command.cwd} is unavailable (${errno})`,
      command,
      { errno },
      error,
    );
  }
  if (!isDirectory) {
    throw commandFailure('command_failed', `Working directory ${command.cwd} is not a directory`, command, {
      errno: 'ENOTDIR',
    });
  }
}

function execute(
  command: SanitizedCommand,
  executable: string,
  environment: Readonly<Record<string, string>>,
  step: StepLog | undefined,
): Promise<SanitizedCommandOutcome> {
  const timeoutMs = command.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const outputLimit = command.outputLimitBytes ?? DEFAULT_PARSED_OUTPUT_LIMIT_BYTES;
  return new Promise((resolve, reject) => {
    // stdin is a pipe only when there is input; stdout and stderr are always pipes.
    const child = spawn(executable, [...command.args], {
      cwd: command.cwd,
      env: environment,
      shell: false,
      detached: true,
      stdio: [command.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    }) as ChildProcessByStdio<Writable | null, Readable, Readable>;
    const pid = child.pid;
    if (pid !== undefined) trackGroup(pid);
    const tees = command.stream ? { stdout: createStreamRedactor(), stderr: createStreamRedactor() } : undefined;
    let stdout = '';
    let stdoutBytes = 0;
    let stderr = '';
    let startError: Error | undefined;
    let termination: 'timeout' | 'output_limit' | undefined;
    let pipeRelease: NodeJS.Timeout | undefined;

    const terminate = (reason: 'timeout' | 'output_limit'): void => {
      if (termination !== undefined) return;
      termination = reason;
      if (pid !== undefined) signalGroup(pid, 'SIGKILL');
      // A process that escaped the group can hold the pipes open; stop waiting for it.
      pipeRelease = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
      }, PIPE_RELEASE_GRACE_MS);
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (tees) {
        step?.write(tees.stdout.push(chunk));
        return;
      }
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > outputLimit) terminate('output_limit');
      else stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-STDERR_RETAINED_CHARACTERS);
      if (tees) step?.write(tees.stderr.push(chunk));
    });
    child.once('error', (error) => {
      startError = error;
    });
    if (command.input !== undefined && child.stdin) {
      // A child that exits without reading its input closes the pipe; its exit status tells the story.
      child.stdin.on('error', (error) => {
        if (!isErrno(error, 'EPIPE')) startError ??= error;
      });
      child.stdin.end(command.input);
    }
    const timer = setTimeout(() => terminate('timeout'), timeoutMs);

    child.once('close', (code, signal) => {
      clearTimeout(timer);
      clearTimeout(pipeRelease);
      if (pid !== undefined) releaseGroup(pid);
      if (tees) step?.write(`${tees.stdout.end()}${tees.stderr.end()}`);
      const facts: FailureFacts = { exitCode: code, signal, stderr };
      if (startError !== undefined) {
        const errno = errorCode(startError, 'unknown');
        reject(
          commandFailure(
            'command_failed',
            `Command could not start (${errno})`,
            command,
            { ...facts, errno },
            startError,
          ),
        );
      } else if (termination === 'timeout') {
        const seconds = (timeoutMs / 1000).toFixed(1);
        reject(
          commandFailure('command_timeout', `Command timed out after ${seconds}s`, command, { ...facts, timeoutMs }),
        );
      } else if (termination === 'output_limit') {
        reject(commandFailure('command_output_limit', `Command output exceeded ${outputLimit} bytes`, command, facts));
      } else if (signal !== null) {
        reject(commandFailure('command_failed', `Command was terminated by ${signal}`, command, facts));
      } else {
        resolve({ stdout, stderr, exitCode: code ?? 1 });
      }
    });
  });
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}

/**
 * The one runner for every child process. Parsed stdout is never logged; the
 * active step's raw log records the command, its outcome, the stdout byte
 * count, and redacted stderr. Streamed output is teed through the redactor.
 */
export const runSanitizedCommandOutcome: SanitizedCommandOutcomeRunner = async (command) => {
  const environment = { ...(command.env ?? buildToolEnvironment()) };
  const searched = executableSearchPath(environment.PATH);
  if (environment.PATH !== undefined) environment.PATH = searched.join(path.delimiter);
  for (const [key, value] of Object.entries(environment)) {
    if (isSecretEnvironmentKey(key)) registerSecret(value);
  }
  const step = activeStep();
  step?.write(
    `$ ${displayCommand(command)}\n  cwd: ${command.cwd}\n  env: ${Object.keys(environment).sort().join(', ')}\n`,
  );
  const started = performance.now();
  try {
    const executable = await locateExecutable(command.command, searched);
    await assertWorkingDirectory(command);
    const outcome = await execute(command, executable, environment, step);
    const elapsed = `${((performance.now() - started) / 1000).toFixed(1)}s`;
    const stdoutFact = command.stream
      ? ''
      : `; stdout: ${Buffer.byteLength(outcome.stdout)} bytes (parsed, not logged)`;
    const stderrFact =
      command.stream || !outcome.stderr.trim() ? '' : `\n  stderr:\n${indent(redact(outcome.stderr.trim()))}`;
    step?.write(`  exit ${outcome.exitCode} after ${elapsed}${stdoutFact}${stderrFact}\n`);
    if (!command.stream) step?.captureCommand({ program: command.command, args: command.args, ...outcome });
    return outcome;
  } catch (error) {
    const tail = error instanceof GwsEaError ? error.details?.stderrTail : undefined;
    step?.write(
      `  failed: ${error instanceof Error ? error.message : String(error)}\n${typeof tail === 'string' && tail ? `  stderr (tail):\n${indent(tail)}\n` : ''}`,
    );
    throw error;
  }
};

export const runSanitizedCommand: SanitizedCommandRunner = async (command) => {
  const outcome = await runSanitizedCommandOutcome(command);
  if (outcome.exitCode !== 0) throw commandExitError(command, outcome);
  return { stdout: outcome.stdout, stderr: outcome.stderr };
};

export function replaceProcess(
  executable: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>>,
  execve: NonNullable<NodeJS.Process['execve']> | undefined = process.execve,
): never {
  if (execve === undefined) {
    throw new GwsEaError('execve_unavailable', 'This Node.js runtime cannot replace the service launcher process');
  }
  return execve(executable, args, { ...environment });
}

async function runLauncherCommand(args: readonly string[]): Promise<void> {
  if (args[0] !== 'launch-host' || args.length !== 2) {
    throw new GwsEaError('invalid_arguments', 'Usage: process.js launch-host <runtime-config>');
  }
  const { launchInstanceHost } = await import('./service.js');
  await launchInstanceHost(args[1]);
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (invokedPath === import.meta.url) {
  runLauncherCommand(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof GwsEaError ? error.message : 'The instance host launcher failed';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
