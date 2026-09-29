/**
 * The cutover's mechanics on real files and real SQLite: a WAL central
 * database and DELETE-journal session databases left as a stopped (or killed)
 * host leaves them, carried into a staged checkout seeded with stale side
 * files, and swapped by renames that a crash can interrupt anywhere. Docker,
 * `ps`, and `lsof` answer through a fake runner, except one check that the
 * real `lsof` finds a real idle opener.
 */
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, statSync } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  assertCarriable,
  assertCheckoutQuiet,
  carryState,
  finishSwap,
  keepReleaseFiles,
  keptReleaseFiles,
  openFileHolders,
  reverseSwap,
  settleCheckoutDatabases,
  stagedKeptFilesRoot,
  type QuietCheckout,
} from './cutover.js';
import { instanceMarkerFile, resolveControlPlanePaths, type ControlPlanePaths } from './paths.js';
import { runSanitizedCommand, type SanitizedCommand, type SanitizedCommandRunner } from './process.js';
import { allocateInstanceId } from './registry.js';
import { GwsEaError } from './types.js';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  roots.push(root);
  return root;
}

async function write(root: string, relativePath: string, contents: string | Buffer, mode = 0o600): Promise<void> {
  const file = path.join(root, relativePath);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, contents, { mode });
  await chmod(file, mode);
}

async function exists(target: string): Promise<boolean> {
  return lstat(target).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    },
  );
}

/** Every entry under `root`: type, mode, and content hash. */
async function tree(root: string): Promise<Map<string, string>> {
  const entries = new Map<string, string>();
  const walk = async (target: string): Promise<void> => {
    const info = await lstat(target);
    const key = path.relative(root, target) || '.';
    if (info.isSymbolicLink()) entries.set(key, `link ${await readlink(target)}`);
    else if (info.isFile()) {
      entries.set(
        key,
        `file ${info.mode} ${createHash('sha256')
          .update(await readFile(target))
          .digest('hex')}`,
      );
    } else if (info.isDirectory()) {
      entries.set(key, `dir ${info.mode}`);
      for (const name of await readdir(target)) await walk(path.join(target, name));
    } else entries.set(key, 'special');
  };
  await walk(root);
  return entries;
}

function rows(file: string, table: string): unknown[] {
  const database = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
  } finally {
    database.close();
  }
}

function integrity(file: string): string {
  const database = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return String(database.pragma('integrity_check', { simple: true }));
  } finally {
    database.close();
  }
}

/** A central database a host left closed: WAL, a message table, and the host lease table. */
function centralDatabase(file: string, lease?: { stopped: boolean }): void {
  const database = new Database(file);
  try {
    database.pragma('journal_mode = WAL');
    database.exec(`
      CREATE TABLE messages (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      INSERT INTO messages VALUES ('m1', 'before the update'), ('m2', 'during the week');
    `);
    if (lease) {
      database.exec(`CREATE TABLE host_instances (
        instance_id TEXT PRIMARY KEY, install_id TEXT, hostname TEXT, pid INTEGER,
        started_at TEXT NOT NULL, lease_expires_at TEXT NOT NULL, stopped_at TEXT)`);
      database
        .prepare('INSERT INTO host_instances VALUES (?, ?, NULL, 1, ?, ?, ?)')
        .run(
          'host-1',
          'install',
          '2026-09-28T09:00:00.000Z',
          '2026-09-28T10:01:00.000Z',
          lease.stopped ? '2026-09-28T09:59:59.000Z' : null,
        );
    }
  } finally {
    database.close();
  }
}

/** A session database as NanoClaw keeps it: DELETE journal mode. */
function sessionDatabase(file: string, messages: readonly string[]): void {
  const database = new Database(file);
  try {
    database.pragma('journal_mode = DELETE');
    database.exec('CREATE TABLE messages_in (id TEXT PRIMARY KEY, content TEXT NOT NULL)');
    for (const id of messages) database.prepare('INSERT INTO messages_in VALUES (?, ?)').run(id, `content ${id}`);
  } finally {
    database.close();
  }
}

/**
 * Leave `file` as a writer killed mid-transaction leaves it: the database
 * with uncommitted pages already spilled into it, and the hot journal holding
 * their originals. Returns the committed row count.
 */
function killedMidTransaction(file: string, into: string): number {
  const database = new Database(file);
  try {
    const committed = (database.prepare('SELECT count(*) AS n FROM messages_in').get() as { n: number }).n;
    const before = statSync(file).size;
    database.pragma('cache_size = 10');
    database.exec('BEGIN IMMEDIATE');
    const insert = database.prepare('INSERT INTO messages_in VALUES (?, ?)');
    for (let index = 0; index < 400; index += 1) insert.run(`uncommitted-${index}`, 'x'.repeat(1024));
    // The spill proves the database file itself now holds uncommitted pages.
    expect(statSync(file).size).toBeGreaterThan(before);
    expect(statSync(`${file}-journal`).size).toBeGreaterThan(0);
    copyFileSync(file, into);
    copyFileSync(`${file}-journal`, `${into}-journal`);
    database.exec('ROLLBACK');
    return committed;
  } finally {
    database.close();
  }
}

/**
 * Leave a WAL database as a killed writer leaves it: committed frames still
 * in `-wal`, not yet folded into the main file.
 */
function killedWithWalFrames(file: string, into: string): void {
  const database = new Database(file);
  try {
    database.pragma('wal_autocheckpoint = 0');
    database.prepare('INSERT INTO messages VALUES (?, ?)').run('m3', 'only in the WAL');
    expect(statSync(`${file}-wal`).size).toBeGreaterThan(0);
    copyFileSync(file, into);
    copyFileSync(`${file}-wal`, `${into}-wal`);
    copyFileSync(`${file}-shm`, `${into}-shm`);
  } finally {
    database.close();
  }
}

describe('settling a stopped checkout’s databases', () => {
  it('folds the central WAL into v2.db and rolls back a hot session journal, running no migration', async () => {
    const root = await temporaryRoot('gws-ea-settle-');
    const scratch = path.join(root, 'scratch');
    const checkout = path.join(root, 'nanoclaw');
    await mkdir(scratch);
    await mkdir(path.join(checkout, 'data', 'v2-sessions', 'ag-main', 's1'), { recursive: true });
    centralDatabase(path.join(scratch, 'v2.db'), { stopped: true });
    killedWithWalFrames(path.join(scratch, 'v2.db'), path.join(checkout, 'data', 'v2.db'));
    sessionDatabase(path.join(scratch, 'inbound.db'), ['in-1', 'in-2']);
    const inbound = path.join(checkout, 'data', 'v2-sessions', 'ag-main', 's1', 'inbound.db');
    const committed = killedMidTransaction(path.join(scratch, 'inbound.db'), inbound);

    expect(settleCheckoutDatabases(checkout, new Date('2026-09-28T10:00:00.000Z'))).toEqual({ graceful: true });

    const central = path.join(checkout, 'data', 'v2.db');
    const wal = await lstat(`${central}-wal`).catch(() => undefined);
    expect(wal === undefined || wal.size === 0).toBe(true);
    expect(rows(central, 'messages')).toHaveLength(3);
    expect(await exists(`${inbound}-journal`)).toBe(false);
    expect(rows(inbound, 'messages_in')).toHaveLength(committed);
    expect(integrity(inbound)).toBe('ok');
    // Nothing but the settled files: no table or column was added to either database.
    const database = new Database(inbound, { readonly: true });
    try {
      expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([
        { name: 'messages_in' },
      ]);
    } finally {
      database.close();
    }
  });

  it.each([
    ['a host that marked its lease stopped', { stopped: true }, true],
    ['a killed host whose lease is still live', { stopped: false }, false],
    ['a release that keeps no host lease', undefined, true],
  ] as const)('reports the stop of %s', async (_label, lease, graceful) => {
    const root = await temporaryRoot('gws-ea-settle-');
    await mkdir(path.join(root, 'data'));
    centralDatabase(path.join(root, 'data', 'v2.db'), lease);

    expect(settleCheckoutDatabases(root, new Date('2026-09-28T10:00:00.000Z'))).toEqual({ graceful });
  });

  it('refuses when a reader keeps the WAL from folding (busy frames), changing nothing', async () => {
    const root = await temporaryRoot('gws-ea-settle-');
    await mkdir(path.join(root, 'data'));
    const central = path.join(root, 'data', 'v2.db');
    centralDatabase(central);
    const writer = new Database(central);
    const reader = new Database(central);
    try {
      writer.pragma('wal_autocheckpoint = 0');
      reader.exec('BEGIN');
      reader.prepare('SELECT count(*) FROM messages').get();
      writer.prepare('INSERT INTO messages VALUES (?, ?)').run('m3', 'held back by the reader');

      let refusal: GwsEaError | undefined;
      try {
        settleCheckoutDatabases(root, new Date());
      } catch (error) {
        if (!(error instanceof GwsEaError)) throw error;
        refusal = error;
      }
      expect(refusal).toMatchObject({ code: 'database_busy' });
      reader.exec('COMMIT');
    } finally {
      reader.close();
      writer.close();
    }
  });
});

/** The live checkout a stopped host leaves, and a staged checkout carrying stale leftovers of its own. */
async function checkouts() {
  const root = await temporaryRoot('gws-ea-carry-');
  const live = path.join(root, 'nanoclaw');
  const staged = path.join(root, 'next', 'nanoclaw');
  const sessions = path.join('data', 'v2-sessions', 'ag-main', 's1');
  await mkdir(path.join(live, sessions), { recursive: true, mode: 0o700 });
  await mkdir(path.join(staged, sessions), { recursive: true, mode: 0o700 });
  centralDatabase(path.join(live, 'data', 'v2.db'), { stopped: true });
  sessionDatabase(path.join(live, sessions, 'inbound.db'), ['in-1', 'in-2']);
  sessionDatabase(path.join(live, sessions, 'outbound.db'), ['out-1']);
  await write(live, 'data/gws-ea/instance.json', '{"marker":"outgoing"}');
  await write(live, 'data/gws-ea/runtime.json', '{"runtime":"outgoing"}');
  await write(live, 'data/circuit-breaker.json', '{"crashes":3}');
  await write(live, 'data/upgrade-state.json', '{"commit":"outgoing"}');
  await write(live, 'groups/main/CLAUDE.local.md', 'remember the principal prefers mornings\n', 0o640);
  await write(live, 'logs/nanoclaw.log', 'outgoing host log\n');
  await write(live, '.env', 'INSTALL_CJK_FONTS=true\nWEBHOOK_PORT=1\n');
  await symlink('CLAUDE.local.md', path.join(live, 'groups', 'main', 'memory-link'));

  // What staging left: its dry-run database, the target's marker, and stale side files.
  await write(staged, 'data/v2.db', 'the dry run copy');
  await write(staged, 'data/v2.db-wal', 'stale frames from nowhere');
  await write(staged, path.join(sessions, 'inbound.db-journal'), 'a stale journal');
  await write(staged, 'data/gws-ea/instance.json', '{"marker":"target"}');
  await write(staged, 'data/staged-only.txt', 'must not survive');
  await write(staged, 'store/leftover', 'the live checkout has no store');
  await write(staged, 'groups/staged-only.md', 'must not survive');
  await write(staged, '.env', 'STALE=1\n');
  await write(staged, 'release.txt', 'release code\n');
  return { root, live, staged, sessions };
}

describe('carrying state into the staged checkout', () => {
  it('replaces each carried root whole, so no stale side file is replayed onto a copied database', async () => {
    const { root, live, staged, sessions } = await checkouts();
    const socket = net.createServer();
    await new Promise<void>((resolve) => socket.listen(path.join(live, 'data', 'ncl.sock'), resolve));
    try {
      const before = await tree(live);

      await carryState(live, staged);

      expect(await tree(live)).toEqual(before);
    } finally {
      await new Promise<void>((resolve) => socket.close(() => resolve()));
    }
    // Stale sidecars and anything staging put in a carried root are gone; nothing was merged.
    expect(await exists(path.join(staged, 'data', 'v2.db-wal'))).toBe(false);
    expect(await exists(path.join(staged, sessions, 'inbound.db-journal'))).toBe(false);
    expect(await exists(path.join(staged, 'data', 'staged-only.txt'))).toBe(false);
    expect(await exists(path.join(staged, 'groups', 'staged-only.md'))).toBe(false);
    expect(await exists(path.join(staged, 'store'))).toBe(false);
    expect(await readFile(path.join(staged, 'release.txt'), 'utf8')).toBe('release code\n');
    // The copies are the live databases, row for row, and intact.
    for (const [file, table] of [
      ['data/v2.db', 'messages'],
      [path.join(sessions, 'inbound.db'), 'messages_in'],
      [path.join(sessions, 'outbound.db'), 'messages_in'],
    ] as const) {
      expect(integrity(path.join(staged, file))).toBe('ok');
      expect(rows(path.join(staged, file), table)).toEqual(rows(path.join(live, file), table));
    }
    // Memory, logs, the environment, links, and modes come across; the release's own records and sockets do not.
    expect(await readFile(path.join(staged, 'groups', 'main', 'CLAUDE.local.md'), 'utf8')).toContain('mornings');
    expect((await stat(path.join(staged, 'groups', 'main', 'CLAUDE.local.md'))).mode & 0o777).toBe(0o640);
    expect(await readlink(path.join(staged, 'groups', 'main', 'memory-link'))).toBe('CLAUDE.local.md');
    expect(await readFile(path.join(staged, 'logs', 'nanoclaw.log'), 'utf8')).toBe('outgoing host log\n');
    expect(await readFile(path.join(staged, '.env'), 'utf8')).toBe('INSTALL_CJK_FONTS=true\nWEBHOOK_PORT=1\n');
    expect(await readFile(path.join(staged, 'data', 'upgrade-state.json'), 'utf8')).toBe('{"commit":"outgoing"}');
    for (const excluded of ['gws-ea/instance.json', 'gws-ea/runtime.json', 'circuit-breaker.json', 'ncl.sock']) {
      expect(await exists(path.join(staged, 'data', excluded))).toBe(false);
    }
    expect((await stat(path.join(staged, 'data'))).mode & 0o777).toBe(0o700);
    // Nothing is left beside the checkout either.
    expect(await readdir(path.join(root, 'next'))).toEqual(['nanoclaw']);
  });

  it('carries again from scratch after a carry cut short', async () => {
    const { root, live, staged } = await checkouts();
    await carryState(live, staged);
    // A killed carry leaves a half-built root beside the checkout; the next one discards it.
    await write(path.join(root, 'next'), 'carrying/data/half-built', 'partial');
    await write(live, 'groups/main/CLAUDE.local.md', 'written by a host the OS restarted\n', 0o640);

    await carryState(live, staged);

    expect(await readFile(path.join(staged, 'groups', 'main', 'CLAUDE.local.md'), 'utf8')).toBe(
      'written by a host the OS restarted\n',
    );
    expect(await readdir(path.join(root, 'next'))).toEqual(['nanoclaw']);
  });

  it('refuses a carried root that is a link, since its copy would share state with the previous release', async () => {
    const { root, live } = await checkouts();
    await mkdir(path.join(root, 'external'));
    await rm(path.join(live, 'groups'), { recursive: true });
    await symlink(path.join(root, 'external'), path.join(live, 'groups'));

    await expect(assertCarriable(live)).rejects.toMatchObject({
      code: 'uncarriable_state',
      message: expect.stringContaining(path.join(live, 'groups')),
    });
  });
});

/** A checkout whose host is stopped, and what `ps`, Docker, and `lsof` report about it. */
interface Observed {
  processes: string;
  containers: string[][];
  openFiles: string;
  readonly commands: SanitizedCommand[];
}

function observing(state: Observed): SanitizedCommandRunner {
  return async (command) => {
    state.commands.push(command);
    if (command.command === 'ps') return { stdout: state.processes, stderr: '' };
    if (command.command === 'docker') return { stdout: (state.containers.shift() ?? []).join('\n'), stderr: '' };
    if (command.command === 'lsof') {
      if (state.openFiles) return { stdout: state.openFiles, stderr: '' };
      throw new GwsEaError('command_failed', 'lsof exited with code 1', { details: { exitCode: 1 } });
    }
    throw new Error(`unexpected command: ${command.command} ${command.args.join(' ')}`);
  };
}

async function quietTarget(): Promise<QuietCheckout> {
  const root = await temporaryRoot('gws-ea-quiet-');
  const checkoutRoot = path.join(root, 'nanoclaw');
  await mkdir(path.join(checkoutRoot, 'data'), { recursive: true });
  return { checkoutRoot, installId: 'abc123', homeDirectory: root, dockerEndpoint: 'unix:///var/run/docker.sock' };
}

describe('proving a stopped checkout quiet', () => {
  const seams = (state: Observed) => ({
    runCommand: observing(state),
    platform: 'darwin' as const,
    ambientEnv: {},
    sleep: async () => undefined,
  });

  it('passes when nothing runs from it, holds its data open, or carries its label, ignoring a log reader', async () => {
    const target = await quietTarget();
    const state: Observed = {
      processes: [
        `  101 /usr/sbin/sshd`,
        `  202 tail -f ${target.checkoutRoot}/logs/nanoclaw.log`,
        `  303 node ${target.checkoutRoot}-other/dist/index.js`,
      ].join('\n'),
      containers: [[]],
      openFiles: '',
      commands: [],
    };

    await assertCheckoutQuiet(target, seams(state));

    const docker = state.commands.find((command) => command.command === 'docker')!;
    expect(docker.args).toEqual(['ps', '--all', '--quiet', '--filter', 'label=nanoclaw-install=abc123']);
    expect(docker.env).toMatchObject({ DOCKER_HOST: target.dockerEndpoint, HOME: target.homeDirectory });
    const lsof = state.commands.find((command) => command.command === 'lsof')!;
    expect(lsof.args).toContain(path.join(target.checkoutRoot, 'data'));
  });

  it('refuses a process running from the checkout, naming it', async () => {
    const target = await quietTarget();
    const state: Observed = {
      processes: `  4242 /usr/local/bin/node ${target.checkoutRoot}/dist/index.js\n`,
      containers: [[]],
      openFiles: '',
      commands: [],
    };

    await expect(assertCheckoutQuiet(target, seams(state))).rejects.toMatchObject({
      code: 'checkout_not_quiet',
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
    await assertCheckoutQuiet(target, seams(leaving));

    const staying: Observed = {
      processes: '',
      containers: Array.from({ length: 100 }, () => ['c-created']),
      openFiles: '',
      commands: [],
    };
    await expect(assertCheckoutQuiet(target, seams(staying))).rejects.toMatchObject({
      code: 'checkout_not_quiet',
      message: expect.stringContaining('c-created'),
    });
  });

  it('refuses any process holding a file under data/ open, even idle, naming the file', async () => {
    const target = await quietTarget();
    const wal = path.join(target.checkoutRoot, 'data', 'v2.db-wal');
    const state: Observed = {
      processes: '',
      containers: [[]],
      openFiles: `p777\ncsqlite3\nf3\nn${wal}\n`,
      commands: [],
    };

    await expect(assertCheckoutQuiet(target, seams(state))).rejects.toMatchObject({
      code: 'checkout_not_quiet',
      message: expect.stringContaining(`sqlite3 (PID 777) holds ${wal}`),
    });
  });
});

describe('finding what holds a directory open', () => {
  it.runIf(process.platform === 'darwin')(
    "finds a real idle opener through the system's lsof",
    async () => {
      const target = await quietTarget();
      const database = path.join(target.checkoutRoot, 'data', 'v2.db');
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

        const holders = await openFileHolders(path.join(target.checkoutRoot, 'data'), {
          runCommand: runSanitizedCommand,
          platform: 'darwin',
        });

        expect(holders).toContainEqual({ pid: holder.pid, command: expect.any(String), file: database });
      } finally {
        holder.kill('SIGKILL');
      }
    },
    30_000,
  );

  it("reads Linux's process table: open descriptors and working directories under the directory", async () => {
    const root = await temporaryRoot('gws-ea-proc-');
    const data = path.join(root, 'nanoclaw', 'data');
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

const FROM = 'a'.repeat(40);
const TO = 'b'.repeat(40);
const OLDER = 'c'.repeat(40);

async function checkoutAt(checkout: string, instanceId: string, commit: string): Promise<void> {
  await mkdir(path.join(checkout, 'data', 'gws-ea'), { recursive: true, mode: 0o700 });
  await writeFile(
    instanceMarkerFile(checkout),
    JSON.stringify({ schema_version: 1, instance_id: instanceId, deployed_commit: commit }),
    { mode: 0o600 },
  );
  await writeFile(path.join(checkout, 'release.txt'), commit);
}

function receipt(instanceId: string, commit: string): string {
  return `${JSON.stringify({ schema_version: 1, instance_id: instanceId, deployed_commit: commit })}\n`;
}

/** An instance stopped for its swap: the live release, the staged one, and the files kept with the live one. */
async function readyToSwap(withOlder: boolean): Promise<{ paths: ControlPlanePaths; instanceId: string }> {
  const root = await temporaryRoot('gws-ea-swap-');
  const paths = resolveControlPlanePaths({
    configRoot: path.join(root, 'config'),
    stateRoot: path.join(root, 'state'),
  });
  const instanceId = allocateInstanceId();
  await mkdir(paths.instanceRoot(instanceId), { recursive: true, mode: 0o700 });
  await checkoutAt(paths.checkoutRoot(instanceId), instanceId, FROM);
  await writeFile(paths.releasePreflightFile(instanceId), receipt(instanceId, FROM), { mode: 0o600 });
  await checkoutAt(paths.releaseCheckoutRoot(instanceId, 'next'), instanceId, TO);
  await writeFile(paths.releasePreflightFile(instanceId, 'next'), receipt(instanceId, TO), { mode: 0o600 });
  await mkdir(path.join(paths.releaseRoot(instanceId, 'next'), '.release-home'), { mode: 0o700 });
  const compose = path.join(paths.instanceRoot(instanceId), 'compose.yaml');
  await writeFile(compose, 'services: {}\n', { mode: 0o600 });
  await keepReleaseFiles(stagedKeptFilesRoot(paths, instanceId), {
    receipt: paths.releasePreflightFile(instanceId),
    compose,
    serviceDefinition: undefined,
    hostEnvironment: { WEBHOOK_PORT: '1' },
  });
  if (withOlder) {
    await checkoutAt(paths.releaseCheckoutRoot(instanceId, 'previous'), instanceId, OLDER);
    await writeFile(paths.releasePreflightFile(instanceId, 'previous'), receipt(instanceId, OLDER), { mode: 0o600 });
  }
  return { paths, instanceId };
}

/** The instance's release layout: each checkout's commit, and which receipts and kept files sit where. */
async function layout(paths: ControlPlanePaths, instanceId: string) {
  const commit = async (checkout: string): Promise<string | null> =>
    (await exists(checkout)) ? (await readFile(path.join(checkout, 'release.txt'), 'utf8')).slice(0, 1) : null;
  const deployed = async (file: string): Promise<string | null> =>
    (await exists(file))
      ? String((JSON.parse(await readFile(file, 'utf8')) as { deployed_commit: string }).deployed_commit).slice(0, 1)
      : null;
  const root = paths.instanceRoot(instanceId);
  const kept = (slot: string) => keptReleaseFiles(path.join(root, slot));
  return {
    live: await commit(paths.checkoutRoot(instanceId)),
    liveReceipt: await deployed(paths.releasePreflightFile(instanceId)),
    next: await exists(paths.releaseRoot(instanceId, 'next')),
    staged: await commit(paths.releaseCheckoutRoot(instanceId, 'next')),
    stagedReceipt: await deployed(paths.releasePreflightFile(instanceId, 'next')),
    stagedKept: await deployed(keptReleaseFiles(stagedKeptFilesRoot(paths, instanceId)).receipt),
    previous: await commit(paths.releaseCheckoutRoot(instanceId, 'previous')),
    previousReceipt: await deployed(kept('previous').receipt),
    previousEnvironment: (await exists(kept('previous').hostEnvironment))
      ? JSON.parse(await readFile(kept('previous').hostEnvironment, 'utf8'))
      : null,
    superseded: await commit(paths.releaseCheckoutRoot(instanceId, 'superseded')),
    supersededReceipt: await deployed(kept('superseded').receipt),
  };
}

const BEFORE_SWAP = (withOlder: boolean) => ({
  live: 'a',
  liveReceipt: 'a',
  next: true,
  staged: 'b',
  stagedReceipt: 'b',
  stagedKept: 'a',
  previous: withOlder ? 'c' : null,
  previousReceipt: withOlder ? 'c' : null,
  previousEnvironment: null,
  superseded: null,
  supersededReceipt: null,
});

const AFTER_SWAP = (withOlder: boolean) => ({
  live: 'b',
  liveReceipt: 'b',
  next: false,
  staged: null,
  stagedReceipt: null,
  stagedKept: null,
  previous: 'a',
  previousReceipt: 'a',
  previousEnvironment: { WEBHOOK_PORT: '1' },
  superseded: withOlder ? 'c' : null,
  supersededReceipt: withOlder ? 'c' : null,
});

/** A rename that is killed on its `at`th call: that rename and everything after it never happen. */
function killedRename(at: number): { rename: (from: string, to: string) => Promise<void> } {
  let calls = 0;
  return {
    rename: async (from, to) => {
      calls += 1;
      if (calls >= at) throw new Error('killed');
      await rename(from, to);
    },
  };
}

describe('swapping the releases', () => {
  it.each([true, false])('moves live to previous and staged to live, older previous set aside: %s', async (older) => {
    const { paths, instanceId } = await readyToSwap(older);
    expect(await layout(paths, instanceId)).toEqual(BEFORE_SWAP(older));

    await finishSwap(paths, instanceId, { from: FROM, to: TO });

    expect(await layout(paths, instanceId)).toEqual(AFTER_SWAP(older));
  });

  // With an older previous the swap renames five times (set aside, kept files, live, staged, receipt), then
  // removes next/; without one, four. Each case kills it at rename `at`, including between the two checkout
  // renames; one past the last lets the swap finish.
  const crashes = [
    ...[1, 2, 3, 4, 5].map((at) => [at, true] as const),
    ...[1, 2, 3, 4].map((at) => [at, false] as const),
  ];
  const killedSwap = async (paths: ControlPlanePaths, instanceId: string, at: number): Promise<void> => {
    await finishSwap(paths, instanceId, { from: FROM, to: TO }, { rename: killedRename(at).rename }).catch(
      (error: unknown) => {
        if (!(error instanceof Error) || error.message !== 'killed') throw error;
      },
    );
  };

  it.each(crashes)('finishes a swap killed at rename %i (older previous: %s)', async (at, older) => {
    const { paths, instanceId } = await readyToSwap(older);
    await killedSwap(paths, instanceId, at);

    await finishSwap(paths, instanceId, { from: FROM, to: TO });

    expect(await layout(paths, instanceId)).toEqual(AFTER_SWAP(older));
  });

  it.each([...crashes, [6, true] as const, [5, false] as const])(
    'reverses a swap killed at rename %i (older previous: %s)',
    async (at, older) => {
      const { paths, instanceId } = await readyToSwap(older);
      await killedSwap(paths, instanceId, at);

      await reverseSwap(paths, instanceId, { from: FROM, to: TO });

      expect(await layout(paths, instanceId)).toEqual(BEFORE_SWAP(older));
    },
  );

  it.each([1, 2, 3, 4, 5])('reverses again after a reversal killed at its rename %i', async (at) => {
    const { paths, instanceId } = await readyToSwap(true);
    await finishSwap(paths, instanceId, { from: FROM, to: TO });
    await reverseSwap(paths, instanceId, { from: FROM, to: TO }, { rename: killedRename(at).rename }).catch(
      (error: unknown) => {
        if (!(error instanceof Error) || error.message !== 'killed') throw error;
      },
    );

    await reverseSwap(paths, instanceId, { from: FROM, to: TO });

    expect(await layout(paths, instanceId)).toEqual(BEFORE_SWAP(true));
  });

  it.each([1, 2, 3, 4, 5])('finishes forward a reversal killed at its rename %i', async (at) => {
    const { paths, instanceId } = await readyToSwap(true);
    await finishSwap(paths, instanceId, { from: FROM, to: TO });
    await reverseSwap(paths, instanceId, { from: FROM, to: TO }, { rename: killedRename(at).rename }).catch(
      (error: unknown) => {
        if (!(error instanceof Error) || error.message !== 'killed') throw error;
      },
    );

    await finishSwap(paths, instanceId, { from: FROM, to: TO });

    expect(await layout(paths, instanceId)).toEqual(AFTER_SWAP(true));
  });

  it('refuses a layout it cannot place, renaming nothing', async () => {
    const { paths, instanceId } = await readyToSwap(true);
    // The live checkout is gone and previous/ still holds the older release: not a swap's own step.
    await rm(paths.checkoutRoot(instanceId), { recursive: true });
    const before = await layout(paths, instanceId);

    await expect(finishSwap(paths, instanceId, { from: FROM, to: TO })).rejects.toMatchObject({
      code: 'swap_layout_unknown',
    });
    await expect(reverseSwap(paths, instanceId, { from: FROM, to: TO })).rejects.toMatchObject({
      code: 'swap_layout_unknown',
    });
    expect(await layout(paths, instanceId)).toEqual(before);
    expect(existsSync(paths.releaseRoot(instanceId, 'superseded'))).toBe(false);
  });

  it('refuses to start a swap while a set-aside previous release is still kept', async () => {
    const { paths, instanceId } = await readyToSwap(true);
    await checkoutAt(paths.releaseCheckoutRoot(instanceId, 'superseded'), instanceId, 'd'.repeat(40));
    const before = await layout(paths, instanceId);

    await expect(finishSwap(paths, instanceId, { from: FROM, to: TO })).rejects.toMatchObject({
      code: 'swap_layout_unknown',
    });
    expect(await layout(paths, instanceId)).toEqual(before);
  });
});
