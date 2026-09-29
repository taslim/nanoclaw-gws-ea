import { copyFileSync, existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { getInstallScopedNames, getInstallSlug } from '../install-slug.js';
import { resolveControlPlanePaths, type ControlPlanePaths } from './paths.js';
import type { SanitizedCommandOutcome, SanitizedCommandOutcomeRunner } from './process.js';
import type { HostStatusHelpers } from './service.js';
import type { NanoclawServiceHandle, NanoclawServiceHelpers } from './service-control.js';
import {
  detectStrayInstall,
  removeStrayInstall,
  strayNote,
  strayParts,
  type StrayInstall,
  type ToolCheckout,
} from './stray-install.js';
import { GwsEaError } from './types.js';

// These tests must never reach a real Docker, service manager, or process.
vi.mock('./process.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./process.js')>();
  const refuse = async (command: { readonly command: string }): Promise<never> => {
    throw new Error(`A real ${command.command} command ran`);
  };
  return { ...actual, runSanitizedCommand: refuse, runSanitizedCommandOutcome: refuse };
});
/** Paths whose removal fails, as a permission error would. */
const failingRemovals = vi.hoisted(() => new Set<string>());
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const rm: typeof actual.rm = async (target, options) => {
    if (typeof target === 'string' && failingRemovals.has(target)) {
      throw Object.assign(new Error(`EACCES: permission denied, rm '${target}'`), { code: 'EACCES' });
    }
    return actual.rm(target, options);
  };
  return { ...actual, rm };
});

const temporaryRoots: string[] = [];
afterEach(async () => {
  failingRemovals.clear();
  vi.unstubAllEnvs();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function ok(stdout = ''): SanitizedCommandOutcome {
  return { stdout, stderr: '', exitCode: 0 };
}

function failed(stderr: string): SanitizedCommandOutcome {
  return { stdout: '', stderr, exitCode: 1 };
}

interface FakeContainer {
  readonly id: string;
  readonly image: string;
  readonly labels: Readonly<Record<string, string>>;
}

/** One Docker daemon: removing an image's last tag deletes it, and never while a container runs it. */
class FakeDocker {
  readonly images = new Map<string, Set<string>>();
  containers: FakeContainer[] = [];
  unreachable = false;

  image(id: string, ...references: string[]): this {
    this.images.set(id, new Set(references));
    return this;
  }

  container(id: string, image: string, install: string): this {
    this.containers.push({ id, image, labels: { 'nanoclaw-install': install } });
    return this;
  }

  tags(repository: string): string[] {
    return [...this.images.values()]
      .flatMap((references) => [...references])
      .filter((reference) => reference.startsWith(`${repository}:`))
      .sort();
  }

  run(args: readonly string[]): SanitizedCommandOutcome {
    if (this.unreachable) return failed('Cannot connect to the Docker daemon at unix:///var/run/docker.sock.');
    const [group, verb, ...rest] = args;
    const listed = (items: readonly string[]) => ok(items.map((item) => `${item}\n`).join(''));
    if (group === 'ps') {
      const label = args[args.indexOf('--filter') + 1]?.replace(/^label=/u, '') ?? '';
      const [key, value] = label.split('=');
      return listed(this.containers.filter((container) => container.labels[key ?? ''] === value).map(({ id }) => id));
    }
    if (group === 'rm' && verb === '--force') {
      this.containers = this.containers.filter((container) => !rest.includes(container.id));
      return ok();
    }
    if (group === 'image' && verb === 'ls') return listed(this.tags(args.at(-1) ?? ''));
    if (group === 'image' && verb === 'rm') {
      const refusals: string[] = [];
      for (const reference of rest) {
        const entry = [...this.images].find(([, references]) => references.has(reference));
        if (!entry) continue;
        const [id, references] = entry;
        const user = this.containers.find((container) => container.image === id);
        if (references.size === 1 && user) {
          refusals.push(
            `conflict: unable to remove repository reference "${reference}" (container ${user.id} uses it)`,
          );
          continue;
        }
        references.delete(reference);
        if (references.size === 0) this.images.delete(id);
      }
      return refusals.length === 0 ? ok() : failed(refusals.join('\n'));
    }
    throw new Error(`Unexpected docker command: ${args.join(' ')}`);
  }
}

/** The host a person started by hand in the tool checkout, answering on its socket. */
interface FakeHost {
  pid?: number;
  /** It answers nothing in time: a busy or wedged host. */
  silent?: boolean;
  ignoresSigterm?: boolean;
}

/** A tool checkout in a temporary root, with its own home, control-plane roots, Docker, and host. */
async function world(options: { readonly platform?: 'macos' | 'linux' } = {}) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'gws-ea-stray-')));
  temporaryRoots.push(base);
  const root = path.join(base, 'nanoclaw-gws-ea');
  const home = path.join(base, 'home');
  await mkdir(root, { recursive: true });
  await mkdir(home, { recursive: true });
  const paths: ControlPlanePaths = resolveControlPlanePaths({
    configRoot: path.join(base, 'config'),
    stateRoot: path.join(base, 'state'),
  });
  // NanoClaw's own slug for this checkout, as its setup derives it with no install ID in the environment.
  const slug = getInstallSlug(root);
  const names = getInstallScopedNames(slug);
  const docker = new FakeDocker();
  const host: FakeHost = {};
  const order: string[] = [];
  const calls: string[] = [];
  const runCommand: SanitizedCommandOutcomeRunner = async (command) => {
    const line = `${command.command} ${command.args.join(' ')}`;
    calls.push(line);
    order.push(line);
    if (command.command === 'docker') return docker.run(command.args);
    // No launchd job is loaded and no host runs from the checkout's dist/.
    if (command.command === 'launchctl' && command.args[0] === 'print') return { ...failed(''), exitCode: 113 };
    if (command.command === 'pkill' || command.command === 'pgrep') return failed('');
    if (command.command === 'systemctl') return command.args.includes('is-active') ? failed('inactive') : ok();
    throw new Error(`Unexpected command: ${line}`);
  };
  const plist = path.join(home, 'Library', 'LaunchAgents', `${names.launchdLabel}.plist`);
  let service: NanoclawServiceHandle = { mode: 'none', active: false };
  const serviceHelpers = {
    createCommandRunner: vi.fn<NanoclawServiceHelpers['createCommandRunner']>(() => ({
      run: () => '',
      tryRun: () => ({ ok: true, stdout: '' }),
    })),
    detectService: vi.fn<NanoclawServiceHelpers['detectService']>(() =>
      existsSync(plist) ? service : { mode: 'none', active: false },
    ),
    stopService: vi.fn<NanoclawServiceHelpers['stopService']>(async (handle) => {
      order.push('service-stop');
      service = { ...handle, active: false };
    }),
    startService: vi.fn<NanoclawServiceHelpers['startService']>(),
    drainContainers: vi.fn<NanoclawServiceHelpers['drainContainers']>(async () => void order.push('drain')),
    verifyServiceHealth: vi.fn<NanoclawServiceHelpers['verifyServiceHealth']>(async () => true),
  } satisfies NanoclawServiceHelpers;
  const hostStatus: HostStatusHelpers = {
    queryHost: vi.fn(async (queried: string) => {
      if (queried !== root) throw new Error(`Queried ${queried}`);
      if (host.silent) throw new Error('Host status timed out');
      if (host.pid === undefined) {
        throw Object.assign(new Error(`connect ECONNREFUSED ${root}/data/ncl.sock`), { code: 'ECONNREFUSED' });
      }
      return { pid: host.pid, project_root: root, instance_id: 'host', channels: [] };
    }),
    waitForHost: vi.fn(),
  };
  const checkout: ToolCheckout = {
    root,
    platform: options.platform ?? 'macos',
    homeDirectory: home,
    runCommand,
    resolveDocker: async () => 'unix:///fake/docker.sock',
    terminate: (pid) => {
      order.push(`terminate ${pid}`);
      if (pid === host.pid && !host.ignoresSigterm) host.pid = undefined;
    },
    sleep: async () => undefined,
    backupEnv: (envPath) => {
      const backup = path.join(path.dirname(envPath), '.env.bak');
      copyFileSync(envPath, backup);
      return backup;
    },
  };
  const write = async (relative: string, content = ''): Promise<void> => {
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  };
  /** A launchd service NanoClaw's setup installed and started. */
  const installService = async (): Promise<void> => {
    await mkdir(path.dirname(plist), { recursive: true });
    await writeFile(plist, '<plist/>');
    service = { mode: 'launchd', active: true, name: names.launchdLabel, definition: plist };
  };
  return {
    base,
    root,
    home,
    paths,
    slug,
    names,
    plist,
    docker,
    host,
    order,
    calls,
    runCommand,
    checkout,
    serviceHelpers,
    hostStatus,
    launcher: { hostStatus, serviceHelpers },
    write,
    installService,
  };
}

type World = Awaited<ReturnType<typeof world>>;

async function present(file: string): Promise<boolean> {
  return lstat(file).then(
    () => true,
    () => false,
  );
}

/** What a clean tool checkout holds: empty directories tests and gws-ea's own logs leave, and its build. */
async function leaveTestResidue(w: World): Promise<void> {
  await mkdir(path.join(w.root, 'data', 'v2-sessions'), { recursive: true });
  await mkdir(path.join(w.root, 'groups'), { recursive: true });
  await w.write('logs/setup-steps/01-environment.log', 'ok');
  await w.write('logs/gws-ea-setup.log', 'gws-ea');
  await w.write('dist/index.js', '// build');
  await w.write('node_modules/kleur/package.json', '{}');
  await w.write('package.json', '{}');
}

describe('detectStrayInstall', () => {
  it('finds nothing in a clean tool checkout, running only the Docker probes, at once', async () => {
    const w = await world();
    await leaveTestResidue(w);
    let running = 0;
    let concurrent = 0;
    const checkout: ToolCheckout = {
      ...w.checkout,
      runCommand: async (command) => {
        running += 1;
        concurrent = Math.max(concurrent, running);
        await new Promise((resolve) => setImmediate(resolve));
        running -= 1;
        return w.runCommand(command);
      },
    };

    const found = await detectStrayInstall(checkout, w.paths);

    expect(strayParts(found)).toEqual([]);
    expect(found.unchecked).toBeUndefined();
    expect(strayNote(found)).toBeUndefined();
    expect(w.calls).toEqual([
      `docker ps -aq --filter label=nanoclaw-install=${w.slug}`,
      `docker image ls --format {{.Repository}}:{{.Tag}} ${w.names.containerImageBase}`,
    ]);
    expect(concurrent).toBe(2);
  });

  const SIGNALS: ReadonlyArray<{
    readonly signal: string;
    readonly platform: 'macos' | 'linux';
    readonly arrange: (w: World) => Promise<void>;
    readonly part: (w: World) => string;
  }> = [
    {
      signal: 'its launchd service',
      platform: 'macos',
      arrange: (w) => w.installService(),
      part: (w) => `~/Library/LaunchAgents/${w.names.launchdLabel}.plist`,
    },
    {
      signal: 'its systemd user service',
      platform: 'linux',
      arrange: async (w) => {
        const unit = path.join(w.home, '.config', 'systemd', 'user', `${w.names.systemdUnit}.service`);
        await mkdir(path.dirname(unit), { recursive: true });
        await writeFile(unit, '[Unit]');
      },
      part: (w) => `~/.config/systemd/user/${w.names.systemdUnit}.service`,
    },
    {
      signal: 'its nohup launcher',
      platform: 'linux',
      arrange: (w) => w.write('start-nanoclaw.sh', '#!/bin/sh'),
      part: () => 'start-nanoclaw.sh',
    },
    {
      signal: 'its nohup PID file',
      platform: 'linux',
      arrange: (w) => w.write('nanoclaw.pid', '4242'),
      part: () => 'nanoclaw.pid',
    },
    { signal: 'its database', platform: 'macos', arrange: (w) => w.write('data/v2.db'), part: () => 'data/v2.db' },
    {
      signal: 'its host socket',
      platform: 'macos',
      arrange: (w) => w.write('data/ncl.sock'),
      part: () => 'data/ncl.sock',
    },
    {
      signal: 'a container it labeled',
      platform: 'macos',
      arrange: async (w) => void w.docker.container('c1', 'sha256:a', w.slug),
      part: () => '1 container',
    },
    {
      signal: 'a tag in its image repository',
      platform: 'macos',
      arrange: async (w) => void w.docker.image('sha256:a', `${w.names.containerImageBase}:latest`),
      part: () => '1 image tag',
    },
  ];
  it.each(SIGNALS)('finds $signal alone', async ({ platform, arrange, part }) => {
    const w = await world({ platform });
    await leaveTestResidue(w);
    await arrange(w);

    const found = await detectStrayInstall(w.checkout, w.paths);

    expect(strayParts(found)).toEqual([part(w)]);
    expect(strayNote(found)).toBe(
      `Note: a stray NanoClaw install is in ${w.root} (${part(w)}); gws-ea cleanup removes it.`,
    );
  });

  it('does not take a .env alone for an install', async () => {
    const w = await world();
    await w.write('.env', 'ANTHROPIC_API_KEY=developer');

    expect(strayParts(await detectStrayInstall(w.checkout, w.paths))).toEqual([]);
  });

  it("looks for the checkout's own install, whatever install ID the environment names", async () => {
    const w = await world();
    const assistant = '0123456789abcdef0123456789abcdef';
    const theirs = getInstallScopedNames(assistant);
    vi.stubEnv('NANOCLAW_INSTALL_ID', assistant);
    w.docker
      .image('sha256:theirs', `${theirs.containerImageBase}:latest`)
      .container('theirs', 'sha256:theirs', assistant);
    const theirPlist = path.join(w.home, 'Library', 'LaunchAgents', `${theirs.launchdLabel}.plist`);
    await mkdir(path.dirname(theirPlist), { recursive: true });
    await writeFile(theirPlist, '<plist/>');

    expect(strayParts(await detectStrayInstall(w.checkout, w.paths))).toEqual([]);

    await w.write('data/v2.db');
    const found = await detectStrayInstall(w.checkout, w.paths);
    await removeStrayInstall(w.checkout, found, w.launcher);

    expect(w.serviceHelpers.detectService).toHaveBeenCalledWith(
      w.root,
      expect.objectContaining({ installSlug: w.slug }),
    );
    expect(w.serviceHelpers.createCommandRunner).toHaveBeenCalledWith({
      env: expect.objectContaining({ NANOCLAW_INSTALL_ID: w.slug }),
    });
    expect(w.docker.tags(theirs.containerImageBase)).toEqual([`${theirs.containerImageBase}:latest`]);
    expect(w.docker.containers.map(({ id }) => id)).toEqual(['theirs']);
    expect(await present(theirPlist)).toBe(true);
    expect(w.calls.join('\n')).not.toContain(assistant);
  });

  it.each([
    ["an assistant's checkout", async (w: World) => w.write('data/gws-ea/instance.json', '{}'), (w: World) => w.paths],
    [
      "a checkout holding gws-ea's state",
      async () => undefined,
      (w: World) =>
        resolveControlPlanePaths({ configRoot: path.join(w.base, 'config'), stateRoot: path.join(w.root, 'state') }),
    ],
  ] as const)('never looks inside %s', async (_case, arrange, paths) => {
    const w = await world();
    await w.write('data/v2.db');
    w.docker.image('sha256:a', `${w.names.containerImageBase}:latest`);
    await arrange(w);

    const found = await detectStrayInstall(w.checkout, paths(w));

    expect(strayParts(found)).toEqual([]);
    expect(w.calls).toEqual([]);
  });

  it('leaves a Docker probe that does not answer in time unchecked, and returns by its deadline', async () => {
    const w = await world();
    const deadlines: Array<number | undefined> = [];
    const checkout: ToolCheckout = {
      ...w.checkout,
      // The runner kills a command at its timeout, as the real one does.
      runCommand: async (command) => {
        deadlines.push(command.timeoutMs);
        await new Promise((resolve) => setTimeout(resolve, command.timeoutMs));
        throw new GwsEaError('command_timeout', `Command timed out after 0.1s: docker ${command.args.join(' ')}`);
      },
    };
    const started = performance.now();

    const found = await detectStrayInstall(checkout, w.paths, 100);

    expect(performance.now() - started).toBeLessThan(1_000);
    expect(deadlines).toEqual([100, 100]);
    expect(strayParts(found)).toEqual([]);
    expect(found.unchecked).toContain('timed out');
  });

  it('leaves Docker unchecked when its daemon is unreachable', async () => {
    const w = await world();
    w.docker.unreachable = true;

    const found = await detectStrayInstall(w.checkout, w.paths);

    expect(strayParts(found)).toEqual([]);
    expect(found.unchecked).toContain('Cannot connect to the Docker daemon');
  });
});

describe('removeStrayInstall', () => {
  /** A stray install NanoClaw's setup left whole in the tool checkout. */
  async function strayWorld(): Promise<World> {
    const w = await world();
    await leaveTestResidue(w);
    await w.installService();
    await w.write('data/v2.db', 'db');
    await w.write('data/v2-sessions/ag/s1/inbound.db', 'db');
    await w.write('groups/main/CLAUDE.md', 'memory');
    await w.write('store/messages.db', 'db');
    await w.write('logs/nanoclaw.log', 'host');
    await w.write('.env', 'ANTHROPIC_API_KEY=stray');
    const repository = w.names.containerImageBase;
    w.docker
      .image('sha256:shared', `${repository}:latest`, 'nanoclaw-agent-v2-f2201907:latest')
      .image('sha256:group', `${repository}:ag-main`)
      .container('agent', 'sha256:group', w.slug)
      .container('exited', 'sha256:shared', w.slug)
      .container('soji-agent', 'sha256:shared', 'f2201907');
    await mkdir(path.join(w.home, '.local', 'bin'), { recursive: true });
    await symlink(path.join(w.root, 'bin', 'ncl'), path.join(w.home, '.local', 'bin', 'ncl'));
    return w;
  }

  it('removes the install whole and keeps what gws-ea runs from', async () => {
    const w = await strayWorld();
    const found = await detectStrayInstall(w.checkout, w.paths);

    const removed = await removeStrayInstall(w.checkout, found, w.launcher);

    expect(removed).toEqual([
      `~/Library/LaunchAgents/${w.names.launchdLabel}.plist`,
      '2 containers',
      '2 image tags',
      '.env (kept as .env.bak)',
      'groups/',
      'store/',
      "NanoClaw's logs",
      '~/.local/bin/ncl',
      'data/',
    ]);
    expect(w.serviceHelpers.stopService).toHaveBeenCalledOnce();
    expect(await present(w.plist)).toBe(false);
    expect(w.docker.containers.map(({ id }) => id)).toEqual(['soji-agent']);
    expect(w.docker.tags(w.names.containerImageBase)).toEqual([]);
    // The image another install tags survives with that tag.
    expect([...(w.docker.images.get('sha256:shared') ?? [])]).toEqual(['nanoclaw-agent-v2-f2201907:latest']);
    for (const gone of ['data', 'groups', 'store', '.env', 'logs/nanoclaw.log', 'logs/setup-steps']) {
      expect(await present(path.join(w.root, gone))).toBe(false);
    }
    expect(await readdir(path.join(w.root, 'logs'))).toEqual(['gws-ea-setup.log']);
    for (const kept of ['dist/index.js', 'node_modules/kleur/package.json', 'package.json']) {
      expect(await present(path.join(w.root, kept))).toBe(true);
    }
    expect(await readFile(path.join(w.root, '.env.bak'), 'utf8')).toBe('ANTHROPIC_API_KEY=stray');
    expect(await present(path.join(w.home, '.local', 'bin', 'ncl'))).toBe(false);
    expect(strayParts(await detectStrayInstall(w.checkout, w.paths))).toEqual([]);
  });

  it('removes a nohup install on Linux, its launcher and PID file included', async () => {
    const w = await world({ platform: 'linux' });
    await w.write('start-nanoclaw.sh', '#!/bin/sh');
    await w.write('nanoclaw.pid', '4242');

    const removed = await removeStrayInstall(w.checkout, await detectStrayInstall(w.checkout, w.paths), w.launcher);

    expect(removed).toEqual(['start-nanoclaw.sh', 'nanoclaw.pid']);
    expect(await readdir(w.root)).toEqual([]);
  });

  it("keeps an ncl link to another install's checkout", async () => {
    const w = await strayWorld();
    const link = path.join(w.home, '.local', 'bin', 'ncl');
    await rm(link);
    await symlink(path.join(w.base, 'sojiclaw', 'bin', 'ncl'), link);

    const removed = await removeStrayInstall(w.checkout, await detectStrayInstall(w.checkout, w.paths), w.launcher);

    expect(removed).not.toContain('~/.local/bin/ncl');
    expect(await present(link)).toBe(true);
  });

  it('stops a host started by hand before removing its containers', async () => {
    const w = await strayWorld();
    w.host.pid = 4242;

    await removeStrayInstall(w.checkout, await detectStrayInstall(w.checkout, w.paths), w.launcher);

    const containersRemoved = w.order.findIndex((line) => line.startsWith('docker rm --force'));
    expect(w.order.indexOf('terminate 4242')).toBeGreaterThanOrEqual(0);
    expect(w.order.indexOf('terminate 4242')).toBeLessThan(containersRemoved);
    expect(await present(path.join(w.root, 'data'))).toBe(false);
  });

  it.each([
    ['keeps answering after SIGTERM', (host: FakeHost) => Object.assign(host, { pid: 4242, ignoresSigterm: true })],
    ['exists but does not answer in time', (host: FakeHost) => Object.assign(host, { silent: true })],
  ] as const)('keeps all state while a host %s', async (_case, arrange) => {
    const w = await strayWorld();
    arrange(w.host);

    await expect(
      removeStrayInstall(w.checkout, await detectStrayInstall(w.checkout, w.paths), w.launcher),
    ).rejects.toMatchObject({ code: 'nanoclaw_removal_incomplete', message: expect.stringContaining('data/ncl.sock') });
    for (const kept of ['data/v2.db', 'groups/main/CLAUDE.md', 'store/messages.db', '.env', 'logs/nanoclaw.log']) {
      expect(await present(path.join(w.root, kept))).toBe(true);
    }
  });

  it('keeps all state when the teardown cannot remove a tag', async () => {
    const w = await strayWorld();
    // A container outside the install runs the image only the stray's `:ag-main` tags.
    w.docker.container('outsider', 'sha256:group', 'someone-else');

    await expect(
      removeStrayInstall(w.checkout, await detectStrayInstall(w.checkout, w.paths), w.launcher),
    ).rejects.toMatchObject({ code: 'command_failed' });
    expect(w.docker.tags(w.names.containerImageBase)).toEqual([`${w.names.containerImageBase}:ag-main`]);
    for (const kept of ['data/v2.db', 'groups/main/CLAUDE.md', '.env']) {
      expect(await present(path.join(w.root, kept))).toBe(true);
    }
  });

  it('fails naming Docker when Docker is gone, keeping all state', async () => {
    const w = await strayWorld();
    w.docker.unreachable = true;
    const found = await detectStrayInstall(w.checkout, w.paths);
    const checkout: ToolCheckout = {
      ...w.checkout,
      resolveDocker: async () => {
        throw new GwsEaError('docker_stopped', 'Docker is not running at unix:///fake/docker.sock');
      },
    };

    expect(found.unchecked).toContain('Cannot connect to the Docker daemon');
    await expect(removeStrayInstall(checkout, found, w.launcher)).rejects.toMatchObject({ code: 'docker_stopped' });
    expect(await present(path.join(w.root, 'data', 'v2.db'))).toBe(true);
  });

  it('finishes on a rerun what an interrupted removal left', async () => {
    const w = await strayWorld();
    failingRemovals.add(path.join(w.root, 'store/'));

    await expect(
      removeStrayInstall(w.checkout, await detectStrayInstall(w.checkout, w.paths), w.launcher),
    ).rejects.toMatchObject({ code: 'EACCES' });
    expect(await present(path.join(w.root, 'groups'))).toBe(false);

    failingRemovals.clear();
    const rerun: StrayInstall = await detectStrayInstall(w.checkout, w.paths);
    expect(strayParts(rerun)).toEqual(['data/v2.db']);
    expect(await removeStrayInstall(w.checkout, rerun, w.launcher)).toEqual([
      'store/',
      "NanoClaw's logs",
      '~/.local/bin/ncl',
      'data/',
    ]);
    expect(strayParts(await detectStrayInstall(w.checkout, w.paths))).toEqual([]);
  });
});
