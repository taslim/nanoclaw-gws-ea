/**
 * Proving a stopped assistant quiet before its fence (KTD18): `ps`, Docker,
 * and `lsof` answer through a fake runner, except one check that the real
 * `lsof` finds a real idle opener, and Linux's process table is read from a
 * planted one. And the serving gate (KTD12): a started release serves only
 * once its Google Chat receives, or when a broken Google sign-in is its only
 * fault, on the fixture's assistants.
 */
import { spawn } from 'node:child_process';
import { readlinkSync } from 'node:fs';
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
  readonly commands: SanitizedCommand[];
}

function observing(state: Observed): SanitizedCommandRunner {
  return async (command) => {
    state.commands.push(command);
    if (command.command === 'ps') return { stdout: state.processes, stderr: '' };
    if (command.command === 'docker') return { stdout: (state.containers.shift() ?? []).join('\n'), stderr: '' };
    if (command.command === 'sh' && command.args[2] === 'lsof') {
      return { stdout: state.openFiles, stderr: state.lsofError ?? '' };
    }
    throw new Error(`unexpected command: ${command.command} ${command.args.join(' ')}`);
  };
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
  const seams = (state: Observed) => ({
    runCommand: observing(state),
    platform: 'darwin' as const,
    ambientEnv: {},
    sleep: async () => undefined,
  });

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

  it('serves a release whose only fault is a broken Google sign-in, returning the sign-in needed', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const state = world(runtime);
    state.chatSignInNeeded = true;

    expect(await verifyLive(host, runtime, state)).toEqual({ signInNeeded: signInNeeded(runtime.instance_id) });
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
  it('rolls back a new release whose Google Chat consumer never connects', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host);
    const state = world(runtime);
    state.onStart = (root) => {
      state.chatDown = readlinkSync(root) === releaseName(next.commit);
    };
    const { run, err } = cli(host, state, next, runtime);

    expect(await run(['update', '--id', runtime.instance_id, '--yes'])).toBe(1);

    const failure = err.join('\n');
    expect(failure).toContain('Google Chat is not receiving: its consumer is not connected');
    expect(failure).toContain('so it was rolled back');
    expect(releaseOf(await getInstanceReservation(host.paths, runtime.instance_id))).toEqual(release(host, host.first));
    expect(await readlink(runtime.checkout_root)).toBe(releaseName(host.first));
    expect(state.running).toBe(true);
  });

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
