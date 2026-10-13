import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';

export class VoiceProcessError extends Error {
  constructor(
    readonly code: 'aborted' | 'timeout' | 'output-limit' | 'process-failed',
    cause?: unknown,
  ) {
    super(`Local voice process ${code}`, cause === undefined ? undefined : { cause });
    this.name = 'VoiceProcessError';
  }
}

export interface VoiceProcessOptions {
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
  watchedFile?: { path: string; maxBytes: number };
}

/** Complete bounded output, never a successful prefix. Children inherit no credentials. */
export function runVoiceProcess(
  executable: string,
  args: readonly string[],
  options: VoiceProcessOptions,
): Promise<Buffer> {
  if (options.signal?.aborted) return Promise.reject(new VoiceProcessError('aborted'));
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C.UTF-8', TMPDIR: options.cwd },
    });
    const output: Buffer[] = [];
    let outputBytes = 0;
    let diagnosticBytes = 0;
    let failure: VoiceProcessError | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let polling: NodeJS.Timeout | undefined;
    let checkPending: Promise<void> | undefined;

    function kill(signal: NodeJS.Signals): void {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') child.kill(signal);
        else process.kill(-child.pid, signal);
        /* eslint-disable no-catch-all/no-catch-all -- retain termination failures until child close */
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
          failure ??= new VoiceProcessError('process-failed', error);
        }
      }
      /* eslint-enable no-catch-all/no-catch-all */
    }

    function stop(error: VoiceProcessError): void {
      if (failure) return;
      failure = error;
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 1000);
      killTimer.unref();
    }

    async function inspectFile(): Promise<void> {
      if (!options.watchedFile) return;
      try {
        const info = await stat(options.watchedFile.path);
        if (info.size > options.watchedFile.maxBytes) stop(new VoiceProcessError('output-limit'));
        /* eslint-disable no-catch-all/no-catch-all -- file-monitor failure must terminate the child */
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
          stop(new VoiceProcessError('process-failed', error));
      }
      /* eslint-enable no-catch-all/no-catch-all */
    }

    async function checkFile(): Promise<void> {
      if (checkPending) await checkPending;
      checkPending = inspectFile();
      await checkPending;
      checkPending = undefined;
    }

    const timeout = setTimeout(() => stop(new VoiceProcessError('timeout')), options.timeoutMs);
    const abort = () => stop(new VoiceProcessError('aborted'));
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    if (options.watchedFile)
      polling = setInterval(() => {
        if (!checkPending) void checkFile();
      }, 25);
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > options.maxOutputBytes) stop(new VoiceProcessError('output-limit'));
      else if (!failure) output.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      diagnosticBytes += chunk.length;
      if (diagnosticBytes > 512 * 1024) stop(new VoiceProcessError('output-limit'));
    });
    child.once('error', (error) => {
      failure ??= new VoiceProcessError('process-failed', error);
    });
    // close waits for inherited pipes too. End this child's process group
    // on exit so a descendant cannot keep recognition or shutdown hanging.
    child.once('exit', () => kill('SIGKILL'));
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (polling) clearInterval(polling);
      options.signal?.removeEventListener('abort', abort);
      // A wrapper or decoder may leave descendants behind even after exiting.
      kill('SIGKILL');
      void (async () => {
        await checkFile();
        if (failure) reject(failure);
        else if (code !== 0 || signal !== null) reject(new VoiceProcessError('process-failed'));
        else resolve(Buffer.concat(output, outputBytes));
      })();
    });
  });
}
