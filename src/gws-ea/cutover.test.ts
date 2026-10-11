/**
 * Proving a stopped assistant quiet before its fence (KTD18): `ps`, Docker,
 * and `lsof` answer through a fake runner, except one check that the real
 * `lsof` finds a real idle opener, and Linux's process table is read from a
 * planted one. And the serving gate (KTD12): a started release serves only
 * once its Google Chat receives, or when a broken Google sign-in is its only
 * fault, on the fixture's assistants.
 */
import { spawn } from 'node:child_process';
import { mkdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  assertInstanceQuiet,
  openCutoverHost,
  openFileHolders,
  verifyServingRelease,
  type CutoverDependencies,
  type QuietInstance,
  type ServedRelease,
} from './cutover.js';
import { withInstanceOperation } from './journal.js';
import { runSanitizedCommand, type SanitizedCommand, type SanitizedCommandRunner } from './process.js';
import { getInstanceReservation } from './registry.js';
import { releaseName } from './release-layout.js';
import type { InstanceRuntimeConfig } from './service.js';
import {
  assistant,
  cli,
  dependencies,
  machine,
  nextRelease,
  release,
  removeTemporaryRoots,
  temporaryRoot,
  world,
  type Machine,
  type World,
} from './testing/cutover-fixture.js';
import { releaseOf } from './types.js';

afterEach(removeTemporaryRoots);

/** An assistant whose host is stopped, and what `ps`, Docker, and `lsof` report about it. */
interface Observed {
  processes: string;
  containers: string[][];
  openFiles: string;
  /** What lsof reports on stderr: an error it met. */
  lsofError?: string;
  desktopInfo?: string;
  vmCommand?: string;
  vmFiles?: string;
  allContainers?: readonly string[];
  inspectedContainers?: string;
  inspectedVolumes?: string;
  inspectionError?: Error;
  readonly commands: SanitizedCommand[];
}

function observing(state: Observed): SanitizedCommandRunner {
  return async (command) => {
    state.commands.push(command);
    if (command.command === 'ps') {
      return { stdout: command.args.includes('-p') ? (state.vmCommand ?? '') : state.processes, stderr: '' };
    }
    if (command.command === 'docker') {
      if (command.args[0] === 'info') return { stdout: state.desktopInfo ?? '{}', stderr: '' };
      if (command.args[1] === 'inspect') {
        if (state.inspectionError) throw state.inspectionError;
        return {
          stdout: command.args[0] === 'volume' ? (state.inspectedVolumes ?? '') : (state.inspectedContainers ?? ''),
          stderr: '',
        };
      }
      if (command.args[0] === 'ps') {
        return {
          stdout: (command.args.includes('--filter')
            ? (state.containers.shift() ?? [])
            : (state.allContainers ?? [])
          ).join('\n'),
          stderr: '',
        };
      }
    }
    if (command.command === 'sh' && command.args[2] === 'lsof') {
      return {
        stdout: command.args.includes('-p') ? (state.vmFiles ?? '') : state.openFiles,
        stderr: state.lsofError ?? '',
      };
    }
    throw new Error(`unexpected command: ${command.command} ${command.args.join(' ')}`);
  };
}

const seams = (state: Observed) => ({
  runCommand: observing(state),
  platform: 'darwin' as const,
  ambientEnv: {},
  sleep: async () => undefined,
});

const APPLE_VM =
  '/System/Library/Frameworks/Virtualization.framework/Versions/A/XPCServices/com.apple.Virtualization.VirtualMachine.xpc/Contents/MacOS/com.apple.Virtualization.VirtualMachine';

function desktopObservation(target: QuietInstance): Observed {
  const desktopData = path.join(target.homeDirectory, 'Library/Containers/com.docker.docker/Data');
  return {
    processes: '',
    containers: [[]],
    openFiles: `p5677\nccom.apple.Virtualization.Virtua\nn${target.state}/data/v2.db\n`,
    desktopInfo: JSON.stringify({
      os: 'Docker Desktop',
      kernel: '7.0.14-linuxkit',
      version: '29.6.0',
      labels: [`com.docker.desktop.address=unix://${desktopData}/docker-cli.sock`],
    }),
    vmCommand: `${APPLE_VM}\n`,
    vmFiles: `p5677\nccom.apple.Virtualization.Virtua\nn${desktopData}/vms/0/data/Docker.raw\n`,
    commands: [],
  };
}

function inspectedContainer(source: string, status = 'running', type = 'bind'): string {
  return JSON.stringify({
    id: 'other-container',
    name: '/another-assistant',
    status,
    mounts: [{ Type: type, Source: source, Name: 'shared-volume', RW: true }],
    configuredMounts: null,
    privileged: false,
    capabilities: null,
  });
}

async function quietTarget(): Promise<QuietInstance> {
  const root = await temporaryRoot('gws-ea-quiet-');
  const instanceRoot = path.join(root, '0123abcd');
  const state = path.join(instanceRoot, 'state');
  await mkdir(path.join(state, 'data'), { recursive: true });
  return {
    instanceRoot,
    state,
    installId: 'abc123',
    homeDirectory: root,
    dockerEndpoint: 'unix:///var/run/docker.sock',
  };
}

describe('proving a stopped assistant quiet', () => {
  it('passes when nothing runs from it, holds its state open, or carries its label, ignoring a log reader', async () => {
    const target = await quietTarget();
    const state: Observed = {
      processes: [
        `  101 /usr/sbin/sshd`,
        `  202 tail -f ${target.instanceRoot}/logs/nanoclaw.log`,
        `  303 node ${target.instanceRoot}-other/0123abcd/dist/index.js`,
      ].join('\n'),
      containers: [[]],
      openFiles: '',
      commands: [],
    };

    await assertInstanceQuiet(target, seams(state));

    const docker = state.commands.find((command) => command.command === 'docker')!;
    expect(docker.args).toEqual(['ps', '--all', '--quiet', '--filter', 'label=nanoclaw-install=abc123']);
    expect(docker.env).toMatchObject({ DOCKER_HOST: target.dockerEndpoint, HOME: target.homeDirectory });
    const lsof = state.commands.find((command) => command.command === 'sh')!;
    expect(lsof.args.slice(2)).toEqual(['lsof', '-n', '-P', '-w', '-F', 'pcn', '+D', target.state]);
  });

  it('refuses a process running from any release of the instance, naming it', async () => {
    const target = await quietTarget();
    const state: Observed = {
      processes: `  4242 /usr/local/bin/node ${target.instanceRoot}/0123abcd/dist/index.js\n`,
      containers: [[]],
      openFiles: '',
      commands: [],
    };

    await expect(assertInstanceQuiet(target, seams(state))).rejects.toMatchObject({
      code: 'instance_not_quiet',
      message: expect.stringContaining('PID 4242'),
    });
  });

  it('waits for stopped containers to go, and refuses one that stays in any state', async () => {
    const target = await quietTarget();
    const leaving: Observed = {
      processes: '',
      containers: [['c-exited'], ['c-exited'], []],
      openFiles: '',
      commands: [],
    };
    await assertInstanceQuiet(target, seams(leaving));

    const staying: Observed = {
      processes: '',
      containers: Array.from({ length: 100 }, () => ['c-created']),
      openFiles: '',
      commands: [],
    };
    await expect(assertInstanceQuiet(target, seams(staying))).rejects.toMatchObject({
      code: 'instance_not_quiet',
      message: expect.stringContaining('c-created'),
    });
  });

  it('refuses any process holding a file under its state open, even idle, naming the file', async () => {
    const target = await quietTarget();
    const wal = path.join(target.state, 'data', 'v2.db-wal');
    const state: Observed = {
      processes: '',
      containers: [[]],
      openFiles: `p777\ncsqlite3\nf3\nn${wal}\n`,
      commands: [],
    };

    await expect(assertInstanceQuiet(target, seams(state))).rejects.toMatchObject({
      code: 'instance_not_quiet',
      message: expect.stringContaining(`sqlite3 (PID 777) holds ${wal}`),
    });
  });
});

describe('what lsof reports', () => {
  it('summarizes repeated holders by process with only a few examples', async () => {
    const target = await quietTarget();
    const state: Observed = {
      processes: '',
      containers: [[]],
      openFiles: `p777\ncsqlite3\n${Array.from({ length: 12 }, (_, index) => `n${target.state}/data/file-${index}`).join('\n')}\n`,
      commands: [],
    };

    const proof = assertInstanceQuiet(target, seams(state));
    await expect(proof).rejects.toMatchObject({
      code: 'instance_not_quiet',
      message: expect.stringContaining('sqlite3 (PID 777) holds 12 paths'),
    });
    await expect(proof).rejects.not.toThrow('file-11');
  });

  it('fails the check on an error it met, rather than reading what it printed as all that is open', async () => {
    const target = await quietTarget();
    const state: Observed = {
      processes: '',
      containers: [[]],
      openFiles: '',
      lsofError: 'lsof: status error on /dev/disk9: Input/output error',
      commands: [],
    };

    await expect(
      assertInstanceQuiet(target, { runCommand: observing(state), platform: 'darwin', sleep: async () => undefined }),
    ).rejects.toMatchObject({ code: 'command_failed', message: expect.stringContaining('Input/output error') });
  });
});

describe('Docker Desktop filesystem handles after agents have exited', () => {
  it('allows confirmed read-only binds such as gateway secret files', async () => {
    const target = await quietTarget();
    const state = {
      ...desktopObservation(target),
      allContainers: ['other-container'],
      inspectedContainers: JSON.stringify({
        id: 'other-container',
        name: '/gateway',
        status: 'running',
        mounts: [{ Type: 'bind', Destination: '/run/secrets/probe', RW: false }],
        configuredMounts: [{ Type: 'bind', Target: '/run/secrets/probe', ReadOnly: true, BindOptions: {} }],
        privileged: false,
        capabilities: null,
      }),
    };

    await expect(assertInstanceQuiet(target, seams(state))).resolves.toBeUndefined();
  });

  it.each(['legacy', 'missing options', 'null options', 'different target', 'unknown readonly', 'missing destination'])(
    'refuses an ambiguously read-only bind: %s',
    async (kind) => {
      const target = await quietTarget();
      const state = {
        ...desktopObservation(target),
        allContainers: ['other-container'],
        inspectedContainers: JSON.stringify({
          id: 'other-container',
          name: '/ambiguous-reader',
          status: 'running',
          mounts: [{ Type: 'bind', Destination: kind === 'missing destination' ? undefined : '/proof', RW: false }],
          configuredMounts:
            kind === 'legacy'
              ? null
              : [
                  {
                    Type: 'bind',
                    Target: kind === 'different target' ? '/elsewhere' : '/proof',
                    ReadOnly: kind === 'unknown readonly' ? undefined : true,
                    BindOptions: kind === 'missing options' ? undefined : kind === 'null options' ? null : {},
                  },
                ],
          privileged: false,
          capabilities: null,
        }),
      };

      await expect(assertInstanceQuiet(target, seams(state))).rejects.toMatchObject({
        code: 'instance_not_quiet',
        message: expect.stringContaining('ambiguous-reader'),
      });
    },
  );

  it.each([undefined, 'false'])('refuses a bind with an unknown write flag: %s', async (rw) => {
    const target = await quietTarget();
    const state = {
      ...desktopObservation(target),
      allContainers: ['other-container'],
      inspectedContainers: JSON.stringify({
        id: 'other-container',
        name: '/unknown-writer',
        status: 'running',
        mounts: [{ Type: 'bind', Destination: '/proof', RW: rw }],
        configuredMounts: [{ Type: 'bind', Target: '/proof', ReadOnly: true, BindOptions: {} }],
        privileged: false,
        capabilities: null,
      }),
    };

    await expect(assertInstanceQuiet(target, seams(state))).rejects.toMatchObject({ code: 'instance_not_quiet' });
  });

  it('refuses a read-only bind explicitly leaving submounts writable', async () => {
    const target = await quietTarget();
    const state = {
      ...desktopObservation(target),
      allContainers: ['other-container'],
      inspectedContainers: JSON.stringify({
        id: 'other-container',
        name: '/recursive-writer',
        status: 'running',
        mounts: [{ Type: 'bind', Destination: '/proof', RW: false }],
        configuredMounts: [
          { Type: 'bind', Target: '/proof', ReadOnly: true, BindOptions: { ReadOnlyNonRecursive: true } },
        ],
        privileged: false,
        capabilities: null,
      }),
    };

    await expect(assertInstanceQuiet(target, seams(state))).rejects.toMatchObject({ code: 'instance_not_quiet' });
  });

  it.each(['privileged', 'mount admin', 'unknown capabilities'])(
    'refuses read-only binds whose protections can be changed: %s',
    async (kind) => {
      const target = await quietTarget();
      const state = {
        ...desktopObservation(target),
        allContainers: ['other-container'],
        inspectedContainers: JSON.stringify({
          id: 'other-container',
          name: '/mount-admin',
          status: 'running',
          mounts: [{ Type: 'bind', Destination: '/proof', RW: false }],
          configuredMounts: [{ Type: 'bind', Target: '/proof', ReadOnly: true, BindOptions: {} }],
          privileged: kind === 'privileged',
          capabilities: kind === 'mount admin' ? ['SYS_ADMIN'] : kind === 'unknown capabilities' ? 'unknown' : null,
        }),
      };

      await expect(assertInstanceQuiet(target, seams(state))).rejects.toMatchObject({ code: 'instance_not_quiet' });
    },
  );

  it.each(['5.11.0-linuxkit', 'unknown'])(
    'cannot discount VM handles without recursive read-only kernel support: %s',
    async (kernel) => {
      const target = await quietTarget();
      const state = desktopObservation(target);
      state.desktopInfo = JSON.stringify({
        ...(JSON.parse(state.desktopInfo ?? '{}') as Record<string, unknown>),
        kernel,
      });

      await expect(assertInstanceQuiet(target, seams(state))).rejects.toMatchObject({ code: 'instance_not_quiet' });
    },
  );

  it.each(['24.0.9', 'unknown'])('keeps refusing VM handles on an unsupported Docker engine: %s', async (version) => {
    const target = await quietTarget();
    const state = desktopObservation(target);
    state.desktopInfo = JSON.stringify({
      ...(JSON.parse(state.desktopInfo ?? '{}') as Record<string, unknown>),
      version,
    });

    await expect(assertInstanceQuiet(target, seams(state))).rejects.toMatchObject({ code: 'instance_not_quiet' });
  });

  it('passes retained handles only for the Apple VM holding this Docker Desktop runtime disk', async () => {
    const target = await quietTarget();
    const state = desktopObservation(target);

    await expect(assertInstanceQuiet(target, seams(state))).resolves.toBeUndefined();
    for (const command of state.commands.filter((entry) => entry.command === 'docker')) {
      expect(command.env).toMatchObject({ DOCKER_HOST: target.dockerEndpoint, HOME: target.homeDirectory });
    }
  });

  it.each(['direct', 'release link', 'parent', 'unrelated', 'retargeted link'])(
    'refuses an active host bind even when its current source is %s',
    async (kind) => {
      const target = await quietTarget();
      let source = path.join(target.state, 'data');
      if (kind === 'release link') {
        const release = path.join(target.instanceRoot, '12345678');
        await mkdir(release);
        source = path.join(release, 'data');
        await symlink('../state/data', source);
      } else if (kind === 'parent') source = target.instanceRoot;
      else if (kind === 'unrelated') source = await temporaryRoot('gws-ea-unrelated-');
      else if (kind === 'retargeted link') {
        source = path.join(target.homeDirectory, 'alias');
        await symlink(target.instanceRoot, source);
        await rm(source);
        await symlink(await temporaryRoot('gws-ea-retarget-'), source);
      }
      const state = {
        ...desktopObservation(target),
        allContainers: ['other-container'],
        inspectedContainers: inspectedContainer(source),
      };

      await expect(assertInstanceQuiet(target, seams(state))).rejects.toMatchObject({
        code: 'instance_not_quiet',
        message: expect.stringContaining('another-assistant'),
      });
    },
  );

  it.each(['paused', 'restarting', 'removing'])('refuses a %s container with a host bind', async (status) => {
    const target = await quietTarget();
    const state = {
      ...desktopObservation(target),
      allContainers: ['other-container'],
      inspectedContainers: inspectedContainer(target.state, status),
    };

    await expect(assertInstanceQuiet(target, seams(state))).rejects.toMatchObject({ code: 'instance_not_quiet' });
  });

  it.each(['created', 'exited', 'dead'])(
    'does not mistake a %s unrelated container for an active writer',
    async (status) => {
      const target = await quietTarget();
      const state = {
        ...desktopObservation(target),
        allContainers: ['other-container'],
        inspectedContainers: inspectedContainer(target.state, status),
      };

      await expect(assertInstanceQuiet(target, seams(state))).resolves.toBeUndefined();
    },
  );

  it.each(['other runtime', 'other executable', 'other disk'])('keeps refusing an unverified VM: %s', async (kind) => {
    const target = await quietTarget();
    const state = desktopObservation(target);
    if (kind === 'other runtime') state.desktopInfo = JSON.stringify({ os: 'OrbStack', labels: [] });
    else if (kind === 'other executable')
      state.vmCommand = '/Applications/Other.app/Contents/MacOS/com.apple.Virtualization.VirtualMachine';
    else state.vmFiles = 'p5677\nn/private/tmp/another-vm.raw\n';

    await expect(assertInstanceQuiet(target, seams(state))).rejects.toMatchObject({
      code: 'instance_not_quiet',
      message: expect.stringContaining('PID 5677'),
    });
  });

  it.each(['malformed inspection', 'missing container', 'unknown mount', 'unknown status'])(
    'cannot pass on %s',
    async (kind) => {
      const target = await quietTarget();
      const state: Observed = {
        ...desktopObservation(target),
        allContainers: ['other-container'],
        inspectedContainers: inspectedContainer(target.state),
      };
      if (kind === 'malformed inspection') state.inspectedContainers = '{';
      else if (kind === 'missing container') state.inspectedContainers = '';
      else if (kind === 'unknown mount')
        state.inspectedContainers = inspectedContainer(target.state, 'running', 'unknown');
      else state.inspectedContainers = inspectedContainer(target.state, 'unknown');

      await expect(assertInstanceQuiet(target, seams(state))).rejects.toMatchObject({ code: 'invalid_docker_output' });
    },
  );

  it('propagates a failed inspection instead of discounting VM holders', async () => {
    const target = await quietTarget();
    const state = {
      ...desktopObservation(target),
      allContainers: ['other-container'],
      inspectionError: new Error('Docker inspection failed'),
    };

    await expect(assertInstanceQuiet(target, seams(state))).rejects.toThrow('Docker inspection failed');
  });

  it('refuses a named volume backed by a host bind regardless of source', async () => {
    const target = await quietTarget();
    const state = {
      ...desktopObservation(target),
      allContainers: ['other-container'],
      inspectedContainers: inspectedContainer('/var/lib/docker/volumes/shared-volume/_data', 'running', 'volume'),
      inspectedVolumes: JSON.stringify({
        name: 'shared-volume',
        driver: 'local',
        options: { type: 'none', o: 'bind', device: '/unrelated/path' },
      }),
    };

    await expect(assertInstanceQuiet(target, seams(state))).rejects.toThrow();
  });

  it('allows ordinary Docker-managed volumes inside the VM', async () => {
    const target = await quietTarget();
    const state = {
      ...desktopObservation(target),
      allContainers: ['other-container'],
      inspectedContainers: inspectedContainer('/var/lib/docker/volumes/shared-volume/_data', 'running', 'volume'),
      inspectedVolumes: JSON.stringify({ name: 'shared-volume', driver: 'local', options: null }),
    };

    await expect(assertInstanceQuiet(target, seams(state))).resolves.toBeUndefined();
  });

  it('refuses a volume whose host access cannot be determined', async () => {
    const target = await quietTarget();
    const state = {
      ...desktopObservation(target),
      allContainers: ['other-container'],
      inspectedContainers: inspectedContainer('/plugin/volume', 'running', 'volume'),
      inspectedVolumes: JSON.stringify({ name: 'shared-volume', driver: 'unknown', options: null }),
    };

    await expect(assertInstanceQuiet(target, seams(state))).rejects.toThrow();
  });

  it('still refuses a host database opener alongside retained VM handles', async () => {
    const target = await quietTarget();
    const state = desktopObservation(target);
    state.openFiles += `p777\ncsqlite3\nn${target.state}/data/v2.db-wal\n`;

    await expect(assertInstanceQuiet(target, seams(state))).rejects.toMatchObject({
      code: 'instance_not_quiet',
      message: expect.stringContaining('sqlite3 (PID 777)'),
    });
    expect(state.commands.some((command) => command.args[0] === 'info')).toBe(false);
  });
});

describe('proving quiet an assistant whose restore was cut short', () => {
  it('checks processes and containers alone while the state is held aside whole', async () => {
    const target = await quietTarget();
    await rm(target.state, { recursive: true });
    const state: Observed = { processes: '', containers: [[]], openFiles: '', commands: [] };

    await assertInstanceQuiet(target, {
      runCommand: observing(state),
      platform: 'darwin',
      ambientEnv: {},
      sleep: async () => undefined,
    });

    expect(state.commands.map((command) => command.command)).toEqual(['ps', 'docker']);
  });
});

describe('finding what holds a directory open', () => {
  it.runIf(process.platform === 'darwin')(
    "finds a real idle opener through the system's lsof",
    async () => {
      const target = await quietTarget();
      const database = path.join(target.state, 'data', 'v2.db');
      await writeFile(database, '');
      const holder = spawn(
        process.execPath,
        [
          '-e',
          "require('fs').openSync(process.argv[1], 'r'); console.log('open'); setInterval(() => {}, 1000);",
          database,
        ],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      );
      try {
        await new Promise<void>((resolve) => holder.stdout.once('data', () => resolve()));

        const holders = await openFileHolders(target.state, {
          runCommand: runSanitizedCommand,
          platform: 'darwin',
        });

        // Only the holder: never the probe's own processes, whose working directory a check from inside would be.
        expect(holders).toEqual([{ pid: holder.pid, command: expect.any(String), file: database }]);
      } finally {
        holder.kill('SIGKILL');
      }
    },
    30_000,
  );

  it.runIf(process.platform === 'darwin')(
    "finds nothing holding a quiet directory through the system's lsof",
    async () => {
      const target = await quietTarget();

      expect(await openFileHolders(target.state, { runCommand: runSanitizedCommand, platform: 'darwin' })).toEqual([]);
    },
    30_000,
  );

  it("reads Linux's process table: open descriptors and working directories under the directory", async () => {
    const root = await temporaryRoot('gws-ea-proc-');
    const data = path.join(root, 'state', 'data');
    await mkdir(data, { recursive: true });
    const proc = path.join(root, 'proc');
    const running = async (pid: string, command: string, fds: Readonly<Record<string, string>>, cwd: string) => {
      await mkdir(path.join(proc, pid, 'fd'), { recursive: true });
      await writeFile(path.join(proc, pid, 'comm'), `${command}\n`);
      await symlink(cwd, path.join(proc, pid, 'cwd'));
      for (const [fd, target] of Object.entries(fds)) await symlink(target, path.join(proc, pid, 'fd', fd));
    };
    await running('11', 'node', { '0': '/dev/null', '7': `${data}/v2.db-shm` }, '/');
    await running('22', 'bash', { '0': '/dev/null' }, data);
    await running('33', 'sshd', { '0': '/dev/null', '4': `${data}-other/v2.db` }, '/');
    await mkdir(path.join(proc, 'self'));

    const holders = await openFileHolders(data, { platform: 'linux', procRoot: proc });

    expect(holders).toEqual([
      { pid: 11, command: 'node', file: `${data}/v2.db-shm` },
      { pid: 22, command: 'bash', file: data },
    ]);
  });
});

/** The fixture's broken sign-in, as the host's report names it and the operator is told it. */
function signInNeeded(instanceId: string): string {
  return (
    "Sign-in needed for Google Chat: Google no longer accepts the assistant's sign-in; sign in again. " +
    `Sign the assistant in again with gws-ea connect-google --id ${instanceId}`
  );
}

// Each case builds a git-backed machine and assistant, as the update and rollback cases below do.
describe('the serving gate: a release serves once its Google Chat receives (KTD12)', { timeout: 90_000 }, () => {
  /** Run the gate on the assistant's live release, as an update or rollback runs it once the release started. */
  async function verifyLive(
    host: Machine,
    runtime: InstanceRuntimeConfig,
    state: World,
    overrides: Partial<CutoverDependencies> = {},
  ): Promise<ServedRelease> {
    const view = await getInstanceReservation(host.paths, runtime.instance_id);
    const served = await withInstanceOperation(host.paths, runtime.instance_id, async (operation) =>
      verifyServingRelease(
        await openCutoverHost(operation, {
          ...dependencies(state, { commit: host.first, tool: host.work }, runtime),
          ...overrides,
        }),
        { view, pins: { gateway: '1.41.3' }, leaseHeld: false, subject: 'The release' },
      ),
    );
    if (!served) throw new Error('The test instance operation was busy');
    return served;
  }

  it('serves a release whose consumer is connected and subscription active', async () => {
    const host = await machine();
    const runtime = await assistant(host);

    expect(await verifyLive(host, runtime, world(runtime))).toEqual({ signInNeeded: null });
  });

  it('waits for a consumer that connects only after the host started, asking the host each time', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const state = world(runtime);
    state.chatDown = true;
    const fixtureNcl = dependencies(state, { commit: host.first, tool: host.work }, runtime).ncl!;
    let asked = 0;
    const ncl: NonNullable<CutoverDependencies['ncl']> = async (config, args, options) => {
      if (args.join(' ') === 'gws-ea-chat health' && (asked += 1) === 3) delete state.chatDown;
      return fixtureNcl(config, args, options);
    };

    expect(await verifyLive(host, runtime, state, { ncl })).toEqual({ signInNeeded: null });
    expect(asked).toBe(3);
  });

  it('refuses a release whose consumer never connects, naming why and where its host logs', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const state = world(runtime);
    state.chatDown = true;

    await expect(verifyLive(host, runtime, state)).rejects.toMatchObject({
      code: 'chat_not_receiving',
      message:
        "The release's host is up, but Google Chat is not receiving: its consumer is not connected " +
        `(Pub/Sub refused the subscriber (HTTP 403)). Check ${path.join(runtime.instance_root, 'logs', 'nanoclaw.error.log')}.`,
    });
  });

  it('refuses a broken sign-in beside any other fault', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const state = world(runtime);
    state.chatSignInNeeded = true;
    state.onecliObservation = { status: 'absent', reason: 'its gateway is not running' };

    await expect(verifyLive(host, runtime, state)).rejects.toMatchObject({ code: 'onecli_not_serving' });
  });
});

describe('update and rollback through the serving gate (KTD12)', { timeout: 90_000 }, () => {
  it('serves an update and a rollback whose only fault is a broken Google sign-in, reporting the sign-in needed', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host);
    const state = world(runtime);
    state.chatSignInNeeded = true;
    const id = runtime.instance_id;
    const { run, out } = cli(host, state, next, runtime);

    expect(await run(['update', '--id', id, '--yes'])).toBe(0);

    expect(out).toContain(`Assistant ${id} was updated to dogfood ${next.commit.slice(0, 12)}.`);
    expect(out).toContain(`${signInNeeded(id)}.`);
    expect(releaseOf(await getInstanceReservation(host.paths, id))).toEqual(release(host, next.commit));
    expect(await readlink(runtime.checkout_root)).toBe(releaseName(next.commit));
    out.length = 0;

    expect(await run(['rollback', '--id', id, '--yes'])).toBe(0);

    expect(out).toContain(`Assistant ${id} was rolled back to dogfood ${host.first.slice(0, 12)}.`);
    expect(out).toContain(`${signInNeeded(id)}.`);
    expect(await readlink(runtime.checkout_root)).toBe(releaseName(host.first));
  });
});
