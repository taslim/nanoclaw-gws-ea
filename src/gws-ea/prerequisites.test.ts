import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { SignInRequired } from './events.js';
import { ONECLI_CLI_VERSION } from './pins.js';
import {
  checkPrerequisites,
  resolveDockerEndpoint,
  type PrerequisiteDependencies,
  type PrerequisiteInteraction,
  type PrerequisiteRequest,
} from './prerequisites.js';
import type { SanitizedCommandOutcomeRunner } from './process.js';
import { GwsEaError } from './types.js';

const cleanups: Array<() => Promise<void>> = [];

function neverCalled(): never {
  throw new Error('process.execve is only called by the service launcher');
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gws-ea-prereq-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** A Docker Engine API stand-in on a unix socket, answering `GET /_ping`. */
async function dockerDaemon(status = 200): Promise<{ readonly host: string; readonly socket: string }> {
  const socket = path.join(await tempDirectory(), 'docker.sock');
  const server = createServer((request, response) => {
    response.writeHead(request.url === '/_ping' ? status : 404).end('OK');
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { host: `unix://${socket}`, socket };
}

interface FakeHost {
  /** Programs that are not on PATH. */
  readonly missing: Set<string>;
  dockerContext: string;
  dockerHost: string;
  onecliVersion: string;
  /** The account gcloud runs as; undefined when nobody is signed in. */
  active: string | undefined;
  /** Accounts whose credentials no longer refresh. */
  readonly expired: Set<string>;
  readonly commands: string[];
}

function fakeHost(dockerHost: string): FakeHost {
  return {
    missing: new Set(),
    dockerContext: 'desktop-linux',
    dockerHost,
    onecliVersion: ONECLI_CLI_VERSION,
    active: 'operator@example.com',
    expired: new Set(),
    commands: [],
  };
}

const REAUTHENTICATION_FAILED = [
  'ERROR: (gcloud.auth.print-access-token) There was a problem refreshing your current auth tokens: Reauthentication failed. cannot prompt during non-interactive execution.',
  'Please run:',
  '',
  '  $ gcloud auth login',
  '',
  'to obtain new credentials.',
].join('\n');

function notFound(program: string): GwsEaError {
  return new GwsEaError('executable_not_found', `${program} was not found on PATH`, {
    details: { program, searched: ['/usr/bin', '/bin'] },
  });
}

function hostRunner(host: FakeHost): SanitizedCommandOutcomeRunner {
  return async (command) => {
    const program = path.basename(command.command);
    const signature = [program, ...command.args].join(' ');
    host.commands.push(signature);
    if (host.missing.has(program)) throw notFound(program);
    const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0 });
    if (signature === 'git --version') return ok('git version 2.50.1\n');
    if (signature === 'pnpm --version') return ok('10.18.0\n');
    if (signature === 'onecli version') return ok(JSON.stringify({ version: host.onecliVersion }));
    if (signature === 'docker context inspect') {
      return ok(
        JSON.stringify([
          {
            Name: host.dockerContext,
            Metadata: { Description: 'Docker Desktop' },
            Endpoints: { docker: { Host: host.dockerHost, SkipTLSVerify: false } },
            TLSMaterial: {},
            Storage: { MetadataPath: '/Users/operator/.docker/contexts/meta/x', TLSPath: '<IN MEMORY>' },
          },
        ]),
      );
    }
    if (signature === 'gcloud version --format=json') return ok('{"Google Cloud SDK":"540.0.0"}');
    if (signature === 'gcloud auth list --filter=status:ACTIVE --format=value(account)') {
      return ok(host.active ? `${host.active}\n` : '');
    }
    const token = /^gcloud auth print-access-token --account=(\S+) --quiet$/u.exec(signature);
    if (token) {
      return host.expired.has(token[1]!)
        ? { stdout: '', stderr: REAUTHENTICATION_FAILED, exitCode: 1 }
        : ok('ya29.discard-me\n');
    }
    throw new Error(`Unexpected command: ${signature}`);
  };
}

function dependencies(host: FakeHost, overrides: Partial<PrerequisiteDependencies> = {}): PrerequisiteDependencies {
  return {
    runCommand: hostRunner(host),
    resolvePersisted: async (command) => {
      if (command === 'onecli') {
        if (host.missing.has('onecli')) throw notFound('onecli');
        return '/Users/operator/.local/bin/onecli';
      }
      return '/opt/homebrew/Cellar/node/22.20.0/bin/node';
    },
    node: { version: 'v22.20.0', execPath: '/opt/homebrew/bin/node', execve: neverCalled },
    platform: 'darwin',
    // No shared NanoClaw mount allowlist unless a test writes one.
    mountAllowlistFile: path.join(os.tmpdir(), `gws-ea-prereq-no-allowlist-${process.pid}`, 'mount-allowlist.json'),
    ...overrides,
  };
}

/** The operator at the terminal: answers confirmations and signs in, choosing an account in the browser. */
function operator(host: FakeHost, answers: { confirm?: boolean[]; browserAccounts?: string[] } = {}) {
  const confirmations = [...(answers.confirm ?? [])];
  const browserAccounts = [...(answers.browserAccounts ?? [])];
  const interaction = {
    signInToGoogleCloud: vi.fn(async (account?: string) => {
      const chosen = account ?? browserAccounts.shift() ?? host.active;
      if (chosen) host.expired.delete(chosen);
      host.active = chosen;
    }),
    confirmGoogleAccount: vi.fn(async () => confirmations.shift() ?? true),
  } satisfies PrerequisiteInteraction;
  return interaction;
}

const PATHS = {
  configRoot: '/Users/operator/.config/gws-ea',
  stateRoot: '/Users/operator/.local/share/gws-ea',
  logsRoot: '/Users/operator/.local/share/gws-ea/logs',
  instancesRoot: '/Users/operator/.local/share/gws-ea/instances',
} as const;
const CREATE: PrerequisiteRequest = { command: 'create', paths: PATHS };

/** gws-ea's roots under a home directory, as the XDG defaults place them. */
function rootsUnder(home: string) {
  const stateRoot = path.join(home, '.local', 'share', 'gws-ea');
  return {
    configRoot: path.join(home, '.config', 'gws-ea'),
    stateRoot,
    logsRoot: path.join(stateRoot, 'logs'),
    instancesRoot: path.join(stateRoot, 'instances'),
  };
}

/** Resume names the Docker endpoint create recorded. */
function resume(dockerEndpoint: string): PrerequisiteRequest {
  return { command: 'resume', paths: PATHS, account: 'reserved@example.com', dockerEndpoint };
}

describe('prerequisites', () => {
  it('reports the host facts create records, confirming the signed-in Workspace account', async () => {
    const daemon = await dockerDaemon();
    const host = fakeHost(daemon.host);
    const person = operator(host);

    await expect(checkPrerequisites(CREATE, person, dependencies(host))).resolves.toEqual({
      platform: 'macos',
      homeDirectory: os.homedir(),
      runningAsRoot: process.getuid?.() === 0,
      nodePath: '/opt/homebrew/Cellar/node/22.20.0/bin/node',
      onecliCliPath: '/Users/operator/.local/bin/onecli',
      dockerEndpoint: daemon.host,
      account: 'operator@example.com',
    });
    expect(person.confirmGoogleAccount).toHaveBeenCalledWith('operator@example.com');
    expect(person.signInToGoogleCloud).not.toHaveBeenCalled();
    expect(host.commands).toEqual([
      'git --version',
      'pnpm --version',
      'onecli version',
      'docker context inspect',
      'gcloud version --format=json',
      'gcloud auth list --filter=status:ACTIVE --format=value(account)',
      'gcloud auth print-access-token --account=operator@example.com --quiet',
    ]);
  });

  it('refuses a Node.js without process.execve, naming its version, before running anything', async () => {
    const host = fakeHost('unix:///var/run/docker.sock');

    await expect(
      checkPrerequisites(
        CREATE,
        operator(host),
        dependencies(host, { node: { version: 'v22.14.0', execPath: '/usr/local/bin/node' } }),
      ),
    ).rejects.toMatchObject({
      code: 'node_unsupported',
      message: expect.stringMatching(/v22\.14\.0.*22\.15.*23\.11/su),
      details: { version: 'v22.14.0' },
    });
    expect(host.commands).toEqual([]);
  });

  it('refuses an unsupported platform', async () => {
    const host = fakeHost('unix:///var/run/docker.sock');
    await expect(
      checkPrerequisites(CREATE, operator(host), dependencies(host, { platform: 'win32' })),
    ).rejects.toMatchObject({ code: 'unsupported_platform' });
  });

  it.each(['git', 'pnpm'])('names a missing %s with where it looked', async (tool) => {
    const host = fakeHost('unix:///var/run/docker.sock');
    host.missing.add(tool);

    await expect(checkPrerequisites(CREATE, operator(host), dependencies(host))).rejects.toMatchObject({
      code: `${tool}_required`,
      message: expect.stringMatching(new RegExp(`^${tool} is required`, 'iu')),
      details: { program: tool, searched: ['/usr/bin', '/bin'] },
    });
    expect(host.commands.some((command) => command.startsWith('gcloud'))).toBe(false);
  });

  it('requires the OneCLI CLI, pinned at create and present on resume', async () => {
    const daemon = await dockerDaemon();
    const host = fakeHost(daemon.host);
    host.onecliVersion = '2.0.0';

    await expect(checkPrerequisites(CREATE, operator(host), dependencies(host))).rejects.toMatchObject({
      code: 'incompatible_onecli',
      message: expect.stringMatching(new RegExp(`2\\.0\\.0.*${ONECLI_CLI_VERSION.replaceAll('.', '\\.')}`, 'su')),
    });

    host.commands.length = 0;
    await expect(checkPrerequisites(resume(daemon.host), operator(host), dependencies(host))).resolves.toMatchObject({
      account: 'reserved@example.com',
    });
    expect(host.commands).not.toContain('onecli version');

    host.missing.add('onecli');
    await expect(checkPrerequisites(resume(daemon.host), operator(host), dependencies(host))).rejects.toMatchObject({
      code: 'onecli_required',
      message: expect.stringContaining(ONECLI_CLI_VERSION),
    });
  });

  it('probes the Docker endpoint create recorded on resume, not the active context', async () => {
    const daemon = await dockerDaemon();
    const host = fakeHost('tcp://192.0.2.10:2376');
    host.dockerContext = 'remote-builder';

    await expect(checkPrerequisites(resume(daemon.host), operator(host), dependencies(host))).resolves.toMatchObject({
      dockerEndpoint: daemon.host,
    });
    expect(host.commands).not.toContain('docker context inspect');

    const stopped = `unix://${path.join(await tempDirectory(), 'docker.sock')}`;
    await expect(checkPrerequisites(resume(stopped), operator(host), dependencies(host))).rejects.toMatchObject({
      code: 'docker_stopped',
      message: expect.stringContaining('the endpoint this assistant was created with'),
      details: { endpoint: stopped, evidence: 'ENOENT' },
    });
  });

  it.each(['create', 'resume'] as const)(
    'stops %s before any other check when a mount allowlist root contains gws-ea state, naming the entry',
    async (command) => {
      const daemon = await dockerDaemon();
      const host = fakeHost(daemon.host);
      const allowlist = path.join(await tempDirectory(), 'mount-allowlist.json');
      await writeFile(
        allowlist,
        JSON.stringify({ allowedRoots: [{ path: '~', allowReadWrite: false }], blockedPatterns: [] }),
      );
      const request = command === 'create' ? CREATE : resume(daemon.host);

      await expect(
        checkPrerequisites(
          { ...request, paths: { ...PATHS, ...rootsUnder(os.homedir()) } },
          operator(host),
          dependencies(host, { mountAllowlistFile: allowlist }),
        ),
      ).rejects.toMatchObject({ code: 'mount_allowlist_exposes_gws_ea', details: { entry: '~' } });
      expect(host.commands).toEqual([]);
      expect(JSON.parse(await readFile(allowlist, 'utf8'))).toMatchObject({
        blockedPatterns: Object.values(rootsUnder(os.homedir())).slice(0, 3),
      });
    },
  );

  it('continues after an expired sign-in is renewed', async () => {
    const daemon = await dockerDaemon();
    const host = fakeHost(daemon.host);
    host.expired.add('reserved@example.com');
    const person = operator(host);

    await expect(checkPrerequisites(resume(daemon.host), person, dependencies(host))).resolves.toMatchObject({
      account: 'reserved@example.com',
    });
    expect(person.signInToGoogleCloud).toHaveBeenCalledExactlyOnceWith('reserved@example.com');
    expect(person.confirmGoogleAccount).not.toHaveBeenCalled();
    expect(host.commands.filter((command) => command.startsWith('gcloud auth print-access-token'))).toHaveLength(2);
  });

  it('stops when a renewed sign-in still does not refresh', async () => {
    const daemon = await dockerDaemon();
    const host = fakeHost(daemon.host);
    host.expired.add('reserved@example.com');
    const person = operator(host);
    person.signInToGoogleCloud.mockImplementation(async () => undefined);

    await expect(checkPrerequisites(resume(daemon.host), person, dependencies(host))).rejects.toBeInstanceOf(
      SignInRequired,
    );
    expect(person.signInToGoogleCloud).toHaveBeenCalledOnce();
  });

  it('uses the account named on the command line without asking', async () => {
    const daemon = await dockerDaemon();
    const host = fakeHost(daemon.host);
    const person = operator(host);

    await expect(
      checkPrerequisites({ ...CREATE, account: 'owner@example.com' }, person, dependencies(host)),
    ).resolves.toMatchObject({ account: 'owner@example.com' });
    expect(person.confirmGoogleAccount).not.toHaveBeenCalled();
    expect(host.commands).not.toContain('gcloud auth list --filter=status:ACTIVE --format=value(account)');
    expect(host.commands).toContain('gcloud auth print-access-token --account=owner@example.com --quiet');

    await expect(
      checkPrerequisites({ ...CREATE, account: 'not an email' }, person, dependencies(host)),
    ).rejects.toMatchObject({ code: 'invalid_arguments', message: expect.stringContaining('--google-account') });
  });

  it('signs in with another account when the operator declines the signed-in one', async () => {
    const daemon = await dockerDaemon();
    const host = fakeHost(daemon.host);
    const person = operator(host, { confirm: [false, true], browserAccounts: ['owner@example.com'] });

    await expect(checkPrerequisites(CREATE, person, dependencies(host))).resolves.toMatchObject({
      account: 'owner@example.com',
    });
    expect(person.confirmGoogleAccount.mock.calls).toEqual([['operator@example.com'], ['owner@example.com']]);
    expect(person.signInToGoogleCloud.mock.calls).toEqual([[]]);
  });

  it('signs in first when nobody is signed in to gcloud', async () => {
    const daemon = await dockerDaemon();
    const host = fakeHost(daemon.host);
    host.active = undefined;
    const person = operator(host, { browserAccounts: ['owner@example.com'] });

    await expect(checkPrerequisites(CREATE, person, dependencies(host))).resolves.toMatchObject({
      account: 'owner@example.com',
    });
    expect(person.signInToGoogleCloud.mock.calls).toEqual([[]]);
    expect(person.confirmGoogleAccount).toHaveBeenCalledExactlyOnceWith('owner@example.com');
  });

  it.each([
    ['signed in', undefined],
    ['named on the command line', 'operator@gmail.com'],
  ])('refuses a consumer Google account %s before checking its credentials', async (_how, account) => {
    const daemon = await dockerDaemon();
    const host = fakeHost(daemon.host);
    host.active = 'operator@gmail.com';
    const person = operator(host);

    await expect(
      checkPrerequisites({ ...CREATE, ...(account ? { account } : {}) }, person, dependencies(host)),
    ).rejects.toMatchObject({
      code: 'consumer_google_account',
      message: expect.stringMatching(/operator@gmail\.com.*Google Workspace/su),
    });
    expect(person.confirmGoogleAccount).not.toHaveBeenCalled();
    expect(host.commands.some((command) => command.startsWith('gcloud auth print-access-token'))).toBe(false);
  });

  it('names a missing Google Cloud CLI after the local checks pass', async () => {
    const daemon = await dockerDaemon();
    const host = fakeHost(daemon.host);
    host.missing.add('gcloud');

    await expect(checkPrerequisites(CREATE, operator(host), dependencies(host))).rejects.toMatchObject({
      code: 'gcloud_required',
      message: expect.stringContaining('https://cloud.google.com/sdk/docs/install'),
    });
    expect(host.commands).toContain('docker context inspect');
  });
});

describe('Docker endpoint', () => {
  it('resolves the active context to its running local socket', async () => {
    const daemon = await dockerDaemon();
    const host = fakeHost(daemon.host);

    await expect(resolveDockerEndpoint(hostRunner(host))).resolves.toBe(daemon.host);
  });

  it('names a missing Docker CLI', async () => {
    const host = fakeHost('unix:///var/run/docker.sock');
    host.missing.add('docker');

    await expect(resolveDockerEndpoint(hostRunner(host))).rejects.toMatchObject({
      code: 'docker_required',
      details: { program: 'docker', searched: ['/usr/bin', '/bin'] },
    });
  });

  it.each(['tcp://192.0.2.10:2376', 'ssh://builder@192.0.2.10', 'unix://relative/docker.sock'])(
    'refuses a context that is not a local socket (%s) without contacting it',
    async (endpoint) => {
      const host = fakeHost(endpoint);
      host.dockerContext = 'remote-builder';

      await expect(resolveDockerEndpoint(hostRunner(host))).rejects.toMatchObject({
        code: 'docker_remote',
        message: expect.stringMatching(/remote-builder.*unix:\/\//su),
        details: { context: 'remote-builder', endpoint },
      });
    },
  );

  it('names a stopped daemon when nothing listens on the socket', async () => {
    const socket = path.join(await tempDirectory(), 'docker.sock');
    const host = fakeHost(`unix://${socket}`);

    await expect(resolveDockerEndpoint(hostRunner(host))).rejects.toMatchObject({
      code: 'docker_stopped',
      message: expect.stringMatching(/not running.*Start Docker/su),
      details: { endpoint: `unix://${socket}`, evidence: 'ENOENT' },
    });
  });

  it('names a daemon that answers but is not ready', async () => {
    const daemon = await dockerDaemon(503);
    const host = fakeHost(daemon.host);

    await expect(resolveDockerEndpoint(hostRunner(host))).rejects.toMatchObject({
      code: 'docker_stopped',
      details: { evidence: 'HTTP 503' },
    });
  });

  it.skipIf(process.getuid?.() === 0)('names a socket this user may not open', async () => {
    const daemon = await dockerDaemon();
    await chmod(daemon.socket, 0o000);
    const host = fakeHost(daemon.host);

    await expect(resolveDockerEndpoint(hostRunner(host))).rejects.toMatchObject({
      code: 'docker_permission_denied',
      details: { endpoint: daemon.host, evidence: 'EACCES' },
    });
  });

  it('reports an unreadable context as the failed command', async () => {
    const runner: SanitizedCommandOutcomeRunner = async () => ({
      stdout: '',
      stderr: 'context "gone": context not found: open /Users/operator/.docker/contexts/meta/x/meta.json',
      exitCode: 1,
    });

    await expect(resolveDockerEndpoint(runner)).rejects.toMatchObject({
      code: 'command_failed',
      message: expect.stringContaining('docker context inspect'),
      details: { exitCode: 1, stderrTail: expect.stringContaining('context not found') },
    });
  });
});
