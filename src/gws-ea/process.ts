import { spawn } from 'node:child_process';
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

export const runSanitizedCommand: SanitizedCommandRunner = async (command) =>
  new Promise<SanitizedCommandResult>((resolve, reject) => {
    const child = spawn(command.command, [...command.args], {
      cwd: command.cwd,
      env: command.env ?? buildAllowlistedEnvironment(),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const limit = command.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES;
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
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(
        new GwsEaError(
          'command_failed',
          signal === 'SIGKILL' ? 'A required child process timed out' : 'A required child process failed',
        ),
      );
    });

    const timeout = setTimeout(
      () => fail(new GwsEaError('command_timeout', 'A required child process timed out')),
      command.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    timeout.unref();
    child.once('close', () => clearTimeout(timeout));
  });

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
