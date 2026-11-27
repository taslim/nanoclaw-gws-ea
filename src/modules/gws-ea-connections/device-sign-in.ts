/**
 * A host-run app's sign-in: the CLI's own polling device login, run on the host against a pending auth file beside the
 * real one, so a sign-in that never finishes leaves the earlier credentials as they were. The principal approves a
 * phrase in the app. Only a record saying `authenticated: true`, from the login or from a status check of the pending
 * file, counts as approval; an exit status never does.
 *
 * One login per app runs at a time and is held here across page requests, so returning to the page mid-login shows the
 * same address and phrase. Each run has its own public-only proxy, and nothing the CLI prints goes anywhere but the
 * address and phrase: its records carry a token preview and the credentials' path.
 */
import { spawn } from 'node:child_process';
import { access, chmod, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

import { isRecord } from '../../gws-ea/validation.js';
import { log } from '../../log.js';
import { startPublicBrowserProxy } from '../gws-ea-browser/proxy.js';
import { getGwsEaProfile } from '../gws-ea-profile/db.js';
import {
  hostCliEnvironment,
  hostCliPaths,
  HostCliUnavailableError,
  resolveInstalledHostCli,
  type HostCliEntry,
  type HostCliLaunch,
} from './host-process.js';

/** Without a positive interval the CLI only saves a pending code and exits. */
const LOGIN_INTERVAL_S = 5;
const LOGIN_TIMEOUT_S = 300;
/** The login prints its address and phrase as soon as the sign-in server answers; one that has not by then is stuck. */
const FIRST_RECORD_MS = 30_000;
/** A login still running well past the CLI's own timeout is killed. */
const LOGIN_DEADLINE_MS = (LOGIN_TIMEOUT_S + 30) * 1000;
const COMMAND_DEADLINE_MS = 30_000;
const KILL_GRACE_MS = 2_000;
const PENDING_FILE = 'auth.pending.json';

export type DeviceSignInFailure = 'expired' | 'refused' | 'failed';

export type DeviceSignInView =
  | { readonly status: 'idle' }
  | { readonly status: 'waiting'; readonly verificationUrl: string; readonly phrase: string }
  | { readonly status: 'connected' }
  | { readonly status: 'ended'; readonly reason: DeviceSignInFailure };

const IDLE: DeviceSignInView = { status: 'idle' };

export interface DeviceSignInStart {
  readonly appId: string;
  readonly launch: HostCliLaunch;
  /** Shown in the app where the principal approves, so they can tell which assistant asks. */
  readonly clientName: string;
  /**
   * Puts the approved pending file in place and connects the app; false when it did not, for instance because the
   * sign-in stopped being `current` while it waited for the app's lock.
   */
  readonly complete: (pendingFile: string, current: () => boolean) => Promise<boolean>;
}

/** The CLI's `--format jsonl` lines: each record as it is made, then how the command ended. */
type CliLine =
  | { readonly type: 'chunk'; readonly data: Record<string, unknown> }
  | { readonly type: 'done' }
  | { readonly type: 'error'; readonly message: string };

function parseLine(line: string): CliLine | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  if (!isRecord(value)) return undefined;
  if (value.type === 'chunk' && isRecord(value.data)) return { type: 'chunk', data: value.data };
  if (value.type === 'done') return { type: 'done' };
  if (value.type === 'error' && isRecord(value.error) && typeof value.error.message === 'string')
    return { type: 'error', message: value.error.message };
  return undefined;
}

interface CliRun {
  /** Settles once the child has exited and its proxy has closed. */
  readonly finished: Promise<void>;
  kill(): void;
}

/** Each line is handed over parsed, or undefined when it is not a line the CLI writes. */
async function runCli(
  launch: HostCliLaunch,
  authFile: string,
  args: readonly string[],
  deadlineMs: number,
  onLine: (line: CliLine | undefined) => void,
): Promise<CliRun> {
  const proxy = await startPublicBrowserProxy();
  const child = spawn(process.execPath, [launch.entryFile, ...args], {
    cwd: launch.workDir,
    env: hostCliEnvironment({ workDir: launch.workDir, authFile, proxyUrl: proxy.url }),
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  let exited = false;
  const kill = (): void => {
    if (exited) return;
    child.kill('SIGTERM');
    setTimeout(() => {
      if (!exited) child.kill('SIGKILL');
    }, KILL_GRACE_MS).unref();
  };
  const deadline = setTimeout(kill, deadlineMs);
  readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
    if (line.trim()) onLine(parseLine(line));
  });
  const finished = new Promise<void>((resolve) => {
    const settle = (): void => {
      if (exited) return;
      exited = true;
      clearTimeout(deadline);
      void proxy.close().finally(resolve);
    };
    child.once('close', settle);
    child.once('error', settle);
  });
  return { finished, kill };
}

function loginArgs(clientName: string): readonly string[] {
  return [
    'auth',
    'login',
    '--client-name',
    clientName,
    '--interval',
    String(LOGIN_INTERVAL_S),
    '--timeout',
    String(LOGIN_TIMEOUT_S),
    '--format',
    'jsonl',
  ];
}

function addressAndPhrase(
  data: Record<string, unknown>,
): { readonly verificationUrl: string; readonly phrase: string } | undefined {
  const { verification_url: url, phrase } = data;
  if (typeof url !== 'string' || !URL.canParse(url) || new URL(url).protocol !== 'https:') return undefined;
  if (typeof phrase !== 'string' || !phrase.trim()) return undefined;
  return { verificationUrl: url, phrase: phrase.trim() };
}

/** The CLI's messages for a device code that lapsed and for a sign-in the principal or Link turned down. */
function failureOf(message: string): DeviceSignInFailure {
  if (message.startsWith('Device code expired')) return 'expired';
  if (message.startsWith('Authorization denied') || message.startsWith('Authorization declined')) return 'refused';
  return 'failed';
}

async function statusAuthenticated(launch: HostCliLaunch, authFile: string): Promise<boolean> {
  let authenticated = false;
  const run = await runCli(launch, authFile, ['auth', 'status', '--format', 'jsonl'], COMMAND_DEADLINE_MS, (line) => {
    if (line?.type === 'chunk' && line.data.authenticated === true) authenticated = true;
  });
  await run.finished;
  return authenticated;
}

class DeviceSignIn {
  view: DeviceSignInView = IDLE;
  starting = true;
  readonly ready: Promise<DeviceSignInView>;
  readonly #start: DeviceSignInStart;
  readonly #pendingFile: string;
  #resolveReady: (view: DeviceSignInView) => void = () => undefined;
  #run: CliRun | undefined;
  #cancelled = false;

  constructor(start: DeviceSignInStart) {
    this.#start = start;
    this.#pendingFile = path.join(start.launch.workDir, PENDING_FILE);
    this.ready = new Promise((resolve) => {
      this.#resolveReady = resolve;
    });
  }

  get inProgress(): boolean {
    return this.starting || this.view.status === 'waiting';
  }

  begin(): void {
    this.#login().catch((error: unknown) => {
      log.warn('Host-run app sign-in failed', {
        appId: this.#start.appId,
        error: error instanceof Error ? error.name : 'unknown',
      });
      void rm(this.#pendingFile, { force: true }).catch(() => undefined);
      if (!this.#cancelled) this.#settle({ status: 'ended', reason: 'failed' });
    });
  }

  cancel(): void {
    this.#cancelled = true;
    this.#run?.kill();
    this.#settle(IDLE);
  }

  #current(): boolean {
    return !this.#cancelled && attempts.get(this.#start.appId) === this;
  }

  #settle(view: DeviceSignInView): void {
    this.view = view;
    this.starting = false;
    this.#resolveReady(view);
  }

  async #end(reason: DeviceSignInFailure): Promise<void> {
    await rm(this.#pendingFile, { force: true });
    if (!this.#cancelled) this.#settle({ status: 'ended', reason });
  }

  async #login(): Promise<void> {
    const { launch, clientName, complete } = this.#start;
    await rm(this.#pendingFile, { force: true });
    if (this.#cancelled) return;
    let shown = false;
    let unreadable = false;
    let authenticated = false;
    let failure: DeviceSignInFailure | undefined;
    const run = await runCli(launch, this.#pendingFile, loginArgs(clientName), LOGIN_DEADLINE_MS, (line) => {
      if (!line) {
        unreadable = true;
        run.kill();
      } else if (!shown) {
        const first = line.type === 'chunk' ? addressAndPhrase(line.data) : undefined;
        if (first) {
          shown = true;
          if (!this.#cancelled) this.#settle({ status: 'waiting', ...first });
        } else {
          if (line.type === 'error') failure = failureOf(line.message);
          else unreadable = true;
          run.kill();
        }
      } else if (line.type === 'chunk' && line.data.authenticated === true) authenticated = true;
      else if (line.type === 'error') failure = failureOf(line.message);
    });
    this.#run = run;
    if (this.#cancelled) run.kill();
    const firstDeadline = setTimeout(() => {
      if (shown) return;
      unreadable = true;
      run.kill();
    }, FIRST_RECORD_MS);
    await run.finished;
    clearTimeout(firstDeadline);
    if (this.#cancelled) {
      await rm(this.#pendingFile, { force: true });
      return;
    }
    if (!shown || unreadable) return this.#end(unreadable ? 'failed' : (failure ?? 'failed'));
    // A login that ended without saying so may still have saved an approval before it stopped.
    if (!authenticated) authenticated = await statusAuthenticated(launch, this.#pendingFile);
    if (!authenticated) return this.#end(failure ?? 'expired');
    if (await complete(this.#pendingFile, () => this.#current())) {
      if (!this.#cancelled) this.#settle({ status: 'connected' });
      return;
    }
    await this.#end('failed');
  }
}

const attempts = new Map<string, DeviceSignIn>();

/** Starts the app's login, or answers the one already under way; settles once its address and phrase are known. */
export function startDeviceSignIn(start: DeviceSignInStart): Promise<DeviceSignInView> {
  const current = attempts.get(start.appId);
  if (current?.inProgress) return current.ready;
  const attempt = new DeviceSignIn(start);
  attempts.set(start.appId, attempt);
  attempt.begin();
  return attempt.ready;
}

export function deviceSignInView(appId: string): DeviceSignInView {
  return attempts.get(appId)?.view ?? IDLE;
}

export function cancelDeviceSignIn(appId: string): void {
  const attempt = attempts.get(appId);
  if (!attempt) return;
  attempts.delete(appId);
  attempt.cancel();
}

export function cancelAllDeviceSignIns(): void {
  for (const appId of [...attempts.keys()]) cancelDeviceSignIn(appId);
}

/** Moves an approved pending file into place, owner-only, replacing whatever an earlier sign-in left. */
export async function adoptApprovedSignIn(pendingFile: string, authFile: string): Promise<void> {
  await rename(pendingFile, authFile);
  await chmod(authFile, 0o600);
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

/** Revokes the sign-in where the CLI still can, then deletes the credentials whatever the revocation's outcome. */
export async function signOutHostCli(entry: HostCliEntry): Promise<void> {
  let paths: ReturnType<typeof hostCliPaths>;
  try {
    paths = hostCliPaths(entry);
  } catch (error) {
    if (error instanceof HostCliUnavailableError) return;
    throw error;
  }
  if (await exists(paths.authFile)) {
    try {
      const launch = await resolveInstalledHostCli(entry);
      const run = await runCli(
        launch,
        paths.authFile,
        ['auth', 'logout', '--format', 'jsonl'],
        COMMAND_DEADLINE_MS,
        () => undefined,
      );
      await run.finished;
      /* eslint-disable-next-line no-catch-all/no-catch-all -- revocation is best-effort; the credentials are deleted below whatever happens */
    } catch (error) {
      log.info('Host-run app sign-in not revoked; deleting its credentials', {
        entry: entry.id,
        reason:
          error instanceof HostCliUnavailableError ? error.reason : error instanceof Error ? error.name : 'unknown',
      });
    }
  }
  await rm(paths.authFile, { force: true });
  await rm(path.join(paths.workDir, PENDING_FILE), { force: true });
}

/** The assistant's first name, so the principal sees which assistant asks to connect. */
export async function hostCliClientName(): Promise<string> {
  const { assistant_first_name: firstName } = await getGwsEaProfile();
  return firstName ? `${firstName} (GWS-EA)` : 'GWS-EA';
}
