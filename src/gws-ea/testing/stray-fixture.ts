/**
 * A checkout like the one gws-ea runs from, in a temporary root, with its own
 * home, control-plane roots, Docker, NanoClaw service, and host: everything a
 * stray NanoClaw install there touches, faked at its boundary. Files are real,
 * and `.env` is kept aside by NanoClaw's own backup.
 */
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { vi } from 'vitest';

import { getInstallScopedNames, getInstallSlug } from '../../install-slug.js';
import { CONTROL_PLANE_ROOT, resolveControlPlanePaths, type ControlPlanePaths } from '../paths.js';
import type { SanitizedCommandOutcome, SanitizedCommandOutcomeRunner } from '../process.js';
import type { HostStatusHelpers } from '../service.js';
import type { NanoclawServiceHandle, NanoclawServiceHelpers } from '../service-control.js';
import type { ToolCheckout } from '../stray-install.js';

/** NanoClaw's own `.env` backup, which the driver injects; loaded by path because `src/` cannot import `setup/`. */
export const { backupEnv } = (await import(path.join(CONTROL_PLANE_ROOT, 'setup', 'uninstall', 'remove.ts'))) as {
  readonly backupEnv: (envPath: string) => string;
};

const roots: string[] = [];

/** Remove every tool checkout made since the last call; each test file using them runs it after each test. */
export async function removeToolCheckouts(): Promise<void> {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}

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
export class FakeDocker {
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
export interface FakeHost {
  pid?: number;
  /** It answers nothing in time: a busy or wedged host. */
  silent?: boolean;
  ignoresSigterm?: boolean;
}

/** A tool checkout in a temporary root, with its own home, control-plane roots, Docker, and host. */
export async function toolCheckoutWorld(options: { readonly platform?: 'macos' | 'linux' } = {}) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'gws-ea-stray-')));
  roots.push(base);
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
    backupEnv,
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

export type ToolCheckoutWorld = Awaited<ReturnType<typeof toolCheckoutWorld>>;

export async function present(file: string): Promise<boolean> {
  return lstat(file).then(
    () => true,
    () => false,
  );
}

/** What a clean tool checkout holds: empty directories tests and gws-ea's own logs leave, and its build. */
export async function leaveTestResidue(w: ToolCheckoutWorld): Promise<void> {
  await mkdir(path.join(w.root, 'data', 'v2-sessions'), { recursive: true });
  await mkdir(path.join(w.root, 'groups'), { recursive: true });
  await w.write('logs/setup-steps/01-environment.log', 'ok');
  await w.write('logs/gws-ea-setup.log', 'gws-ea');
  await w.write('dist/index.js', '// build');
  await w.write('node_modules/kleur/package.json', '{}');
  await w.write('package.json', '{}');
}
