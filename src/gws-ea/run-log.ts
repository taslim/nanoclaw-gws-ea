/**
 * Run observability for the GWS-EA control plane, implementing upstream
 * docs/setup-flow.md's three output levels outside every instance root:
 *
 *   Level 1: the driver's terminal summary (not here)
 *   Level 2: <run>/progress.log — structured, append-only progression log
 *   Level 3: <run>/steps/NN-name.log — raw, redacted evidence per step
 *
 * Runs live at <stateRoot>/logs/<instance_id>/<run>/, or at
 * <stateRoot>/logs/runs/<run>/ until an instance is reserved. Each run owns
 * an exclusively created directory, so concurrent runs never share a file.
 * Logs are kept after the instance is removed.
 *
 * The flag-gated fixture capture sink also lives here: it stages allowlisted
 * parsed reads for fixture curation and never writes to the run log.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { isErrno } from '../community-portal/errors.js';
import { PauseRequired } from './events.js';
import { CONTROL_PLANE_ROOT, preparePrivateDirectory, type ControlPlanePaths } from './paths.js';
import { envKeyNames, redact, registerSecretDirectory, safeErrorCode } from './redact.js';
import { assertInstanceId } from './registry.js';
import { GwsEaError } from './types.js';

/** Gitignored staging directory for fixture captures during live gates. */
export const FIXTURE_STAGING_DIRECTORY = path.join(CONTROL_PLANE_ROOT, '.gws-ea-fixture-staging');

const PROGRESS_LOG = 'progress.log';
const STEPS_DIRECTORY = 'steps';
const MAX_FIELD_CHARACTERS = 300;

export type LogFieldValue = string | number | boolean;
export type StepStatus = 'success' | 'skipped' | 'failed' | 'interactive' | 'paused';

export interface CommandCapture {
  readonly program: string;
  readonly args: readonly string[];
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface HttpCapture {
  readonly method: string;
  readonly url: string;
  readonly status: number;
  readonly body: string;
}

export interface StepLog {
  readonly name: string;
  /** Absolute path of this step's raw log; follows the run when an instance is reserved. */
  readonly rawLog: string;
  /** Record a short parsed fact on this step's progression entry. */
  fact(key: string, value: LogFieldValue): void;
  mark(status: 'skipped' | 'interactive' | 'paused'): void;
  /** Append redacted text to this step's raw log. */
  write(text: string): void;
  /** Record a dotenv file by its key names only. */
  envFile(file: string, contents: string): void;
  captureCommand(capture: CommandCapture): void;
  captureHttp(capture: HttpCapture): void;
}

export interface RunLog {
  readonly id: string;
  readonly directory: string;
  readonly progressLog: string;
  step<T>(name: string, body: (step: StepLog) => Promise<T>): Promise<T>;
  userInput(key: string, value: string): void;
  /** Move a pre-reservation run under its newly reserved instance. */
  assignInstance(instanceId: string): Promise<void>;
  complete(): void;
  /** `step` is the step that paused, when a later check ran after it. */
  pause(reason: string, step?: string): void;
  /** The run was stopped by a signal, such as Ctrl-C. */
  interrupt(signal: NodeJS.Signals): void;
  /** Close the run as failed, naming the step that raised this error. */
  abort(error: unknown): void;
}

export interface StartRunOptions {
  readonly paths: ControlPlanePaths;
  readonly command: string;
  readonly instanceId?: string;
  readonly meta?: Readonly<Record<string, LogFieldValue>>;
  /** Directories whose files are registered as secrets before anything is logged. */
  readonly secretDirectories?: readonly string[];
  /** Enables the fixture capture sink, writing to this directory. Off when absent. */
  readonly captureFixturesTo?: string;
  readonly now?: () => Date;
}

const activeSteps = new AsyncLocalStorage<StepLog>();

/** The step the current async context runs inside, if any. The command runner logs through it. */
export function activeStep(): StepLog | undefined {
  return activeSteps.getStore();
}

function field(value: LogFieldValue): string {
  const single = redact(String(value)).replace(/\s+/gu, ' ').trim();
  return single.length > MAX_FIELD_CHARACTERS ? `${single.slice(0, MAX_FIELD_CHARACTERS)}…` : single;
}

function formatDuration(milliseconds: number): string {
  return milliseconds < 1000 ? `${Math.round(milliseconds)}ms` : `${(milliseconds / 1000).toFixed(1)}s`;
}

function formatTotal(milliseconds: number): string {
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.round((milliseconds % 60_000) / 1000);
  return minutes > 0 ? `${minutes}m${seconds}s` : `${seconds}s`;
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, '-')
      .replace(/^-+|-+$/gu, '')
      .slice(0, 80) || 'step'
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function commandWords(args: readonly string[]): string[] {
  return args.filter((arg) => !arg.startsWith('-'));
}

/** Allowlisted reads only: never token endpoints or commands that print secrets. */
function isCapturableCommand(program: string, args: readonly string[]): boolean {
  const words = commandWords(args);
  switch (path.basename(program)) {
    case 'gcloud':
      return (
        !words.includes('auth') && !words.includes('config') && (words.includes('describe') || words.includes('list'))
      );
    case 'docker':
      return words.includes('inspect');
    case 'ncl':
      return true;
    default:
      return false;
  }
}

function capturableHttpPath(method: string, url: string): string | undefined {
  if (method.toUpperCase() !== 'GET' || !URL.canParse(url)) return undefined;
  const { pathname } = new URL(url);
  return /\/tokens?(?:\/|$)/u.test(pathname) ? undefined : pathname;
}

async function createRunDirectory(parent: string, now: Date): Promise<{ id: string; directory: string }> {
  const stamp = now
    .toISOString()
    .replace(/[-:]/gu, '')
    .replace(/\.\d+Z$/u, 'Z');
  for (;;) {
    const id = `${stamp}-${process.pid}-${randomBytes(4).toString('hex')}`;
    const directory = path.join(parent, id);
    try {
      await mkdir(directory, { mode: 0o700 });
      return { id, directory };
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) throw error;
    }
  }
}

class Run implements RunLog {
  readonly id: string;
  #directory: string;
  readonly #paths: ControlPlanePaths;
  readonly #now: () => Date;
  readonly #started = performance.now();
  readonly #captureDirectory: string | undefined;
  readonly #failures = new WeakMap<object, string>();
  #captureCount = 0;
  #stepCount = 0;
  #lastStep: string | undefined;

  constructor(
    id: string,
    directory: string,
    paths: ControlPlanePaths,
    now: () => Date,
    captureDirectory: string | undefined,
  ) {
    this.id = id;
    this.#directory = directory;
    this.#paths = paths;
    this.#now = now;
    this.#captureDirectory = captureDirectory;
  }

  get directory(): string {
    return this.#directory;
  }

  get progressLog(): string {
    return path.join(this.#directory, PROGRESS_LOG);
  }

  append(lines: readonly string[]): void {
    fs.appendFileSync(this.progressLog, `${lines.join('\n')}\n`, { mode: 0o600 });
  }

  header(command: string, instanceId: string | undefined, meta: Readonly<Record<string, LogFieldValue>>): void {
    this.append([
      `## ${this.#now().toISOString()} · gws-ea ${command} started`,
      `  run: ${this.id}`,
      `  instance: ${instanceId ?? 'unreserved'}`,
      `  pid: ${process.pid}`,
      ...Object.entries(meta).map(([key, value]) => `  ${key.toLowerCase()}: ${field(value)}`),
      '',
    ]);
  }

  async step<T>(name: string, body: (step: StepLog) => Promise<T>): Promise<T> {
    this.#stepCount += 1;
    this.#lastStep = name;
    const relativeRawLog = path.join(STEPS_DIRECTORY, `${String(this.#stepCount).padStart(2, '0')}-${slug(name)}.log`);
    const runDirectory = (): string => this.#directory;
    const descriptor = fs.openSync(path.join(this.#directory, relativeRawLog), 'wx', 0o600);
    let open = true;
    const facts: Array<readonly [string, string]> = [];
    let marked: 'skipped' | 'interactive' | 'paused' | undefined;
    const write = (text: string): void => {
      if (open && text) fs.writeSync(descriptor, redact(text));
    };
    const step: StepLog = {
      name,
      get rawLog() {
        return path.join(runDirectory(), relativeRawLog);
      },
      fact: (key, value) => facts.push([key.toLowerCase(), field(value)]),
      mark: (status) => {
        marked = status;
      },
      write,
      envFile: (file, contents) => write(`.env ${file}: keys ${envKeyNames(contents).join(', ')}\n`),
      captureCommand: (capture) => this.#captureCommand(capture),
      captureHttp: (capture) => this.#captureHttp(capture),
    };

    const startedAt = this.#now().toISOString();
    const started = performance.now();
    const entry = (status: StepStatus, error?: unknown): void => {
      this.append([
        `=== [${startedAt}] ${name} [${formatDuration(performance.now() - started)}] → ${status} ===`,
        ...facts.map(([key, value]) => `  ${key}: ${value}`),
        ...(status === 'failed'
          ? [`  error: ${safeErrorCode(error)}`, `  message: ${field(errorMessage(error))}`]
          : []),
        `  raw: ${relativeRawLog}`,
        '',
      ]);
    };
    try {
      const result = await activeSteps.run(step, () => body(step));
      entry(marked ?? 'success');
      return result;
    } catch (error) {
      if (error instanceof PauseRequired) {
        entry('paused');
        throw error;
      }
      // Attribute each failure to the innermost step that raised it.
      if (typeof error === 'object' && error !== null && !this.#failures.has(error)) this.#failures.set(error, name);
      entry('failed', error);
      throw error;
    } finally {
      open = false;
      fs.closeSync(descriptor);
    }
  }

  userInput(key: string, value: string): void {
    this.append([`=== [${this.#now().toISOString()}] user-input → ${key} ===`, `  value: ${field(value)}`, '']);
  }

  async assignInstance(instanceId: string): Promise<void> {
    assertInstanceId(instanceId);
    const parent = this.#paths.instanceLogsRoot(instanceId);
    const target = path.join(parent, this.id);
    if (target === this.#directory) return;
    if (path.dirname(this.#directory) !== this.#paths.preReservationLogsRoot) {
      throw new GwsEaError('run_log_conflict', 'This run already belongs to another instance');
    }
    await preparePrivateDirectory(parent);
    await rename(this.#directory, target);
    this.#directory = target;
    this.append([`=== [${this.#now().toISOString()}] instance-reserved → ${instanceId} ===`, '']);
  }

  complete(): void {
    this.append([
      `## ${this.#now().toISOString()} · completed (total ${formatTotal(performance.now() - this.#started)})`,
    ]);
  }

  pause(reason: string, step?: string): void {
    const pausedAt = step ?? this.#lastStep;
    const at = pausedAt ? ` at ${pausedAt}` : '';
    this.append([`## ${this.#now().toISOString()} · paused${at} (${field(reason)})`]);
  }

  interrupt(signal: NodeJS.Signals): void {
    const at = this.#lastStep ? ` at ${this.#lastStep}` : '';
    this.append([`## ${this.#now().toISOString()} · interrupted${at} (${signal})`]);
  }

  abort(error: unknown): void {
    const step = typeof error === 'object' && error !== null ? this.#failures.get(error) : undefined;
    this.append([
      `## ${this.#now().toISOString()} · aborted${step ? ` at ${step}` : ''} (err=${safeErrorCode(error)})`,
    ]);
  }

  #stage(label: string, capture: Readonly<Record<string, unknown>>): void {
    if (this.#captureDirectory === undefined) return;
    this.#captureCount += 1;
    const name = `${this.id}-${String(this.#captureCount).padStart(3, '0')}-${slug(label)}.json`;
    fs.writeFileSync(path.join(this.#captureDirectory, name), `${JSON.stringify(capture, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
  }

  #captureCommand(capture: CommandCapture): void {
    if (this.#captureDirectory === undefined || !isCapturableCommand(capture.program, capture.args)) return;
    const program = path.basename(capture.program);
    this.#stage([program, ...commandWords(capture.args).slice(0, 4)].join('-'), {
      kind: 'command',
      program,
      args: capture.args.map(redact),
      exit_code: capture.exitCode,
      stdout: redact(capture.stdout),
      stderr: redact(capture.stderr),
    });
  }

  #captureHttp(capture: HttpCapture): void {
    if (this.#captureDirectory === undefined) return;
    const pathname = capturableHttpPath(capture.method, capture.url);
    if (pathname === undefined) return;
    this.#stage(`http-${capture.method}-${pathname}`, {
      kind: 'http',
      method: capture.method.toUpperCase(),
      url: redact(capture.url),
      status: capture.status,
      body: redact(capture.body),
    });
  }
}

/** Open a new run: register secrets first, then create its private, exclusive log directory. */
export async function startRunLog(options: StartRunOptions): Promise<RunLog> {
  if (options.instanceId !== undefined) assertInstanceId(options.instanceId);
  await Promise.all((options.secretDirectories ?? []).map(registerSecretDirectory));
  const now = options.now ?? (() => new Date());
  const parent =
    options.instanceId === undefined
      ? options.paths.preReservationLogsRoot
      : options.paths.instanceLogsRoot(options.instanceId);
  await preparePrivateDirectory(options.paths.logsRoot);
  await preparePrivateDirectory(parent);
  if (options.captureFixturesTo !== undefined) await preparePrivateDirectory(options.captureFixturesTo);
  const { id, directory } = await createRunDirectory(parent, now());
  await mkdir(path.join(directory, STEPS_DIRECTORY), { mode: 0o700 });
  const run = new Run(id, directory, options.paths, now, options.captureFixturesTo);
  run.header(options.command, options.instanceId, options.meta ?? {});
  return run;
}
