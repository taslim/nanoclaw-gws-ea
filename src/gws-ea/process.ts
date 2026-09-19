import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { GwsEaError } from './types.js';

const SAFE_AMBIENT_KEYS = [
  'PATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TMPDIR',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
] as const;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const DEFAULT_EXECUTABLE_PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];

export interface SanitizedCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly outputLimitBytes?: number;
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

function currentUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

function isAllowedOwner(uid: number): boolean {
  const owner = currentUid();
  return uid === 0 || (owner !== undefined && uid === owner);
}

function isFilesystemError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && typeof error.code === 'string';
}

async function assertTrustedPathComponent(
  component: string,
  expectFile: boolean,
  allowUnownedComponent = false,
): Promise<void> {
  const info = await stat(component);
  if (expectFile ? !info.isFile() : !info.isDirectory()) {
    throw new GwsEaError('untrusted_executable', 'A required executable has an invalid filesystem type');
  }
  if ((info.mode & 0o002) !== 0) {
    throw new GwsEaError('untrusted_executable', 'A required executable is stored in an unsafe location');
  }
  const allowedOwner = isAllowedOwner(info.uid);
  if (!allowedOwner && !allowUnownedComponent) {
    throw new GwsEaError('untrusted_executable', 'A required executable is stored in an unsafe location');
  }
  // Homebrew and /Applications commonly have group-writable, root/current-user
  // owned directories. Executable files themselves must not be group writable.
  if ((info.mode & 0o020) !== 0 && expectFile) {
    throw new GwsEaError('untrusted_executable', 'A required executable is stored in an unsafe location');
  }
}

async function assertTrustedCanonicalPath(
  canonicalPath: string,
  expectFile: boolean,
  allowUnownedComponents = false,
): Promise<void> {
  await assertTrustedPathComponent(canonicalPath, expectFile, allowUnownedComponents);
  let directory = expectFile ? path.dirname(canonicalPath) : canonicalPath;
  while (true) {
    await assertTrustedPathComponent(directory, false, allowUnownedComponents);
    const parent = path.dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
}

async function trustedDirectory(directory: string): Promise<string | undefined> {
  if (!path.isAbsolute(directory) || directory.includes('\0')) return undefined;
  try {
    const canonical = await realpath(directory);
    await assertTrustedCanonicalPath(canonical, false);
    return canonical;
  } catch (error) {
    if (!(error instanceof GwsEaError) && !isFilesystemError(error)) throw error;
    return undefined;
  }
}

async function trustedSearchPath(searchPath: string | undefined): Promise<readonly string[]> {
  const requested = searchPath?.split(path.delimiter) ?? [];
  const candidates = [...requested, ...DEFAULT_EXECUTABLE_PATH];
  const trusted = await Promise.all(candidates.map(trustedDirectory));
  return [...new Set(trusted.filter((entry): entry is string => entry !== undefined))];
}

async function resolveFromTrustedDirectories(command: string, directories: readonly string[]): Promise<string> {
  if (!command || command.includes('\0')) {
    throw new GwsEaError('untrusted_executable', 'A required executable name is invalid');
  }
  const candidates = path.isAbsolute(command)
    ? [command]
    : command === path.basename(command)
      ? directories.map((directory) => path.join(directory, command))
      : [];
  const runningNode = await realpath(process.execPath);
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      const canonical = await realpath(candidate);
      await assertTrustedCanonicalPath(canonical, true, canonical === runningNode);
      return canonical;
    } catch (error) {
      if (!(error instanceof GwsEaError) && !isFilesystemError(error)) throw error;
      // A hostile PATH entry must not shadow a later trusted installation.
    }
  }
  if (!path.isAbsolute(command) && command === path.basename(process.execPath)) {
    try {
      await access(runningNode, fsConstants.X_OK);
      await assertTrustedCanonicalPath(runningNode, true, true);
      return runningNode;
    } catch (error) {
      if (!(error instanceof GwsEaError) && !isFilesystemError(error)) throw error;
    }
  }
  throw new GwsEaError('untrusted_executable', `No trusted ${path.basename(command)} executable is available`);
}

/** Resolve a child-process executable to a canonical, non-publicly-writable path. */
export async function resolveTrustedExecutable(command: string, searchPath?: string): Promise<string> {
  return resolveFromTrustedDirectories(command, await trustedSearchPath(searchPath));
}

async function prepareTrustedCommand(command: SanitizedCommand): Promise<SanitizedCommand> {
  const directories = await trustedSearchPath(command.env?.PATH);
  const executable = await resolveFromTrustedDirectories(command.command, directories);
  return {
    ...command,
    command: executable,
    env: { ...command.env, PATH: directories.join(path.delimiter) },
  };
}

export function buildAllowlistedEnvironment(
  ambient: NodeJS.ProcessEnv = process.env,
  overrides: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of SAFE_AMBIENT_KEYS) {
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

export const runSanitizedCommandOutcome: SanitizedCommandOutcomeRunner = async (command) => {
  const trusted = await prepareTrustedCommand({
    ...command,
    env: command.env ?? buildAllowlistedEnvironment(),
  });
  return new Promise<SanitizedCommandOutcome>((resolve, reject) => {
    const child = spawn(trusted.command, [...trusted.args], {
      cwd: trusted.cwd,
      env: trusted.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const limit = trusted.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES;
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let settled = false;

    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(error);
    };
    const capture = (chunk: Buffer, destination: 'stdout' | 'stderr'): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes > limit) {
        fail(new GwsEaError('command_output_limit', 'A required child process exceeded its output limit'));
        return;
      }
      if (destination === 'stdout') stdout += chunk.toString('utf8');
      else stderr += chunk.toString('utf8');
    };

    child.stdout.on('data', (chunk: Buffer) => capture(chunk, 'stdout'));
    child.stderr.on('data', (chunk: Buffer) => capture(chunk, 'stderr'));
    child.once('error', () => fail(new GwsEaError('command_failed', 'A required child process could not be started')));
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (signal === 'SIGKILL') {
        reject(new GwsEaError('command_timeout', 'A required child process timed out'));
        return;
      }
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });

    const timeout = setTimeout(
      () => fail(new GwsEaError('command_timeout', 'A required child process timed out')),
      trusted.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    timeout.unref();
    child.once('close', () => clearTimeout(timeout));
  });
};

export const runSanitizedCommand: SanitizedCommandRunner = async (command) => {
  const result = await runSanitizedCommandOutcome(command);
  if (result.exitCode !== 0) {
    throw new GwsEaError('command_failed', 'A required child process failed');
  }
  return { stdout: result.stdout, stderr: result.stderr };
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
