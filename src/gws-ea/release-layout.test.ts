/**
 * The release layout (KTD1, KTD4, KTD5): releases switch by one link and
 * never move or copy state; a snapshot is a copy taken while fenced, retaken
 * after any later fence, and restored whole with what it replaces kept; and
 * NanoClaw itself, run from a release through the live link, finds its
 * state, install name, environment, ncl socket, host status, upgrade
 * tripwire, and databases exactly where the layout says.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { copyFileSync, lstatSync, mkdtempSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { mkdir, readdir, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { CONTROL_PLANE_ROOT } from './paths.js';
import {
  createState,
  discardIncompleteRelease,
  fence,
  instanceLayout,
  isReleaseComplete,
  linkReleaseState,
  operationName,
  pointCurrent,
  pruneInstance,
  readCurrent,
  releaseName,
  restoreSnapshot,
  returnQuarantinedState,
  STATE_ROOTS,
  takeSnapshot,
  type InstanceLayout,
} from './release-layout.js';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const TSX = path.join(CONTROL_PLANE_ROOT, 'node_modules', '.bin', 'tsx');
const INSTALL_ID = '0123456789abcdef0123456789abcdef';
const UPDATE = operationName('2026-10-07T10:00:00.000Z');
const LATER_UPDATE = operationName('2026-10-08T10:00:00.000Z');
const ROLLBACK = operationName('2026-10-09T10:00:00.000Z');

/**
 * A fresh instance root, under a real path so `process.cwd()` and the
 * layout's paths compare as written, and short enough that NanoClaw can bind
 * its ncl socket inside a release.
 */
function instanceRoot(): string {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'gws-ea-layout-')));
  roots.push(root);
  return root;
}

/** Git with a fixed author and time, so a release staged again from the same content has the same commit. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Morgan Ellery',
      GIT_AUTHOR_EMAIL: 'morgan@example.test',
      GIT_AUTHOR_DATE: '2026-10-07T10:00:00Z',
      GIT_COMMITTER_NAME: 'Morgan Ellery',
      GIT_COMMITTER_EMAIL: 'morgan@example.test',
      GIT_COMMITTER_DATE: '2026-10-07T10:00:00Z',
    },
  }).trim();
}

/**
 * Stage a release as an update would: a Git checkout of one commit, carrying
 * upstream's `.gitignore` and a tiny host that records which release ran it
 * in the state and the logs, then its links. With `complete`, its receipt is
 * written last. Returns its name.
 */
async function stageRelease(layout: InstanceLayout, label: string, complete = true): Promise<string> {
  const scratch = path.join(layout.root, `staging-${label}`);
  await mkdir(path.join(scratch, 'dist'), { recursive: true });
  copyFileSync(path.join(CONTROL_PLANE_ROOT, '.gitignore'), path.join(scratch, '.gitignore'));
  await writeFile(path.join(scratch, 'package.json'), `{"name":"nanoclaw","version":"2.0.0"}\n`);
  await writeFile(
    path.join(scratch, 'dist', 'host.mjs'),
    [
      "import fs from 'node:fs';",
      `fs.appendFileSync('data/started', ${JSON.stringify(`${label}\n`)});`,
      `fs.appendFileSync('logs/nanoclaw.log', ${JSON.stringify(`${label} started\n`)});`,
      '',
    ].join('\n'),
  );
  git(scratch, 'init', '-q');
  git(scratch, 'add', '.');
  git(scratch, 'commit', '-q', '-m', `release ${label}`);
  const name = releaseName(git(scratch, 'rev-parse', 'HEAD'));
  await rename(scratch, layout.release(name));
  await linkReleaseState(layout, name);
  if (complete) {
    await mkdir(layout.kept(name), { recursive: true, mode: 0o700 });
    await writeFile(layout.receipt(name), '{}\n', { mode: 0o600 });
  }
  return name;
}

async function layoutWithReleases(): Promise<{ layout: InstanceLayout; a: string; b: string }> {
  const layout = instanceLayout(instanceRoot());
  await createState(layout);
  const a = await stageRelease(layout, 'alpha');
  const b = await stageRelease(layout, 'bravo');
  return { layout, a, b };
}

function inode(file: string): number {
  return lstatSync(file).ino;
}

/** Start the live release's host as the service manager does: its working directory and entrypoint through the link. */
function startHost(layout: InstanceLayout) {
  return spawnSync(process.execPath, [path.join(layout.current, 'dist', 'host.mjs')], {
    cwd: layout.current,
    encoding: 'utf8',
  });
}

const RELEASE_LINK_NAMES = [...STATE_ROOTS, 'logs'];

// Each test stages releases with Git, and some start NanoClaw's own code under tsx: seconds apiece on a loaded machine.
const STAGING = { timeout: 60_000 };

describe('switching releases', STAGING, () => {
  it('switches and switches back by one link, never moving or copying the state', async () => {
    const { layout, a, b } = await layoutWithReleases();
    await writeFile(path.join(layout.state, 'data', 'v2.db'), 'conversations');
    const before = inode(path.join(layout.state, 'data', 'v2.db'));

    await pointCurrent(layout, a);
    expect(startHost(layout).status).toBe(0);
    await fence(layout);
    await pointCurrent(layout, b);
    expect(startHost(layout).status).toBe(0);
    await fence(layout);
    await pointCurrent(layout, a);
    expect(startHost(layout).status).toBe(0);

    expect(await readlink(layout.current)).toBe(a);
    expect(await readFile(path.join(layout.state, 'data', 'started'), 'utf8')).toBe('alpha\nbravo\nalpha\n');
    expect(await readFile(path.join(layout.logs, 'nanoclaw.log'), 'utf8')).toBe(
      'alpha started\nbravo started\nalpha started\n',
    );
    expect(inode(path.join(layout.current, 'data', 'v2.db'))).toBe(before);
    expect(await readFile(path.join(layout.release(b), 'data', 'v2.db'), 'utf8')).toBe('conversations');
    for (const name of [a, b]) {
      for (const link of RELEASE_LINK_NAMES) {
        expect(lstatSync(path.join(layout.release(name), link)).isSymbolicLink()).toBe(true);
      }
    }
  });

  it('keeps the live link whole when a switch is cut short, and the next switch finishes', async () => {
    const { layout, a, b } = await layoutWithReleases();
    await pointCurrent(layout, a);
    // Killed after writing the new link, before the rename that makes it live.
    await symlink(b, `${layout.current}.pending`);

    expect(await readCurrent(layout)).toBe(a);
    await pointCurrent(layout, b);
    expect(await readCurrent(layout)).toBe(b);
    expect(await readdir(layout.root)).not.toContain('nanoclaw.pending');
  });

  it('starts nothing while a switch has fenced the live link, so no host writes the state meanwhile', async () => {
    const { layout, a, b } = await layoutWithReleases();
    await pointCurrent(layout, a);
    const epoch = await fence(layout);
    expect(await fence(layout)).toBe(epoch);

    // What the service manager does at a reboot: its working directory and entrypoint are through the link.
    const fenced = startHost(layout);
    expect(fenced.status).not.toBe(0);
    const direct = spawnSync(process.execPath, [path.join(layout.current, 'dist', 'host.mjs')], {
      cwd: layout.root,
      encoding: 'utf8',
    });
    expect(direct.stderr).toContain('Cannot find module');
    expect(await readdir(path.join(layout.state, 'data'))).toEqual([]);
    expect(await readdir(layout.logs)).toEqual([]);
    expect(await readCurrent(layout)).toBeUndefined();

    await pointCurrent(layout, b);
    expect(startHost(layout).status).toBe(0);
    expect(await readFile(path.join(layout.state, 'data', 'started'), 'utf8')).toBe('bravo\n');
  });

  it('refuses a live link naming anything but a release beside it', async () => {
    const { layout, a } = await layoutWithReleases();
    await expect(pointCurrent(layout, '../../etc')).rejects.toMatchObject({ code: 'unsafe_release_layout' });

    for (const target of ['../elsewhere', path.join(layout.root, a), `./${a}`, 'state']) {
      await rm(layout.current, { force: true });
      await symlink(target, layout.current);
      await expect(readCurrent(layout)).rejects.toMatchObject({ code: 'unsafe_release_layout' });
      await expect(fence(layout)).rejects.toMatchObject({ code: 'unsafe_release_layout' });
    }
  });

  it.each([
    ['holding its own data', 'data', null],
    ['linking data elsewhere by an absolute path', 'data', '/tmp/state/data'],
    ['linking data out of the instance', 'data', '../../state/data'],
    ['linking data to another root', 'data', '../state/groups'],
    ['linking .env out of the instance', '.env', '../../.env'],
    ['linking logs into the state', 'logs', '../state/logs'],
  ])('refuses a release %s', async (_case, link, target) => {
    const layout = instanceLayout(instanceRoot());
    await createState(layout);
    const stray = layout.release('deadbeef');
    await mkdir(stray, { recursive: true });
    if (target === null) await mkdir(path.join(stray, link));
    else await symlink(target, path.join(stray, link));

    await expect(linkReleaseState(layout, 'deadbeef')).rejects.toMatchObject({ code: 'unsafe_release_layout' });
    await mkdir(layout.kept('deadbeef'), { recursive: true });
    await writeFile(layout.receipt('deadbeef'), '{}\n');
    await expect(pointCurrent(layout, 'deadbeef')).rejects.toMatchObject({ code: 'unsafe_release_layout' });
    expect(await readCurrent(layout)).toBeUndefined();
  });
});

describe('release completeness', STAGING, () => {
  it('points only at a release whose receipt is written, and restages one without it', async () => {
    const layout = instanceLayout(instanceRoot());
    await createState(layout);
    await writeFile(path.join(layout.state, 'groups', 'memory.md'), 'Juno Hale prefers mornings');
    const name = await stageRelease(layout, 'alpha', false);
    // Killed while keeping its files: the compose file is written, the receipt is not.
    await mkdir(layout.kept(name), { recursive: true });
    await writeFile(path.join(layout.kept(name), 'onecli-compose.yaml'), 'services: {}\n');

    expect(await isReleaseComplete(layout, name)).toBe(false);
    await expect(pointCurrent(layout, name)).rejects.toMatchObject({ code: 'unsafe_release_layout' });

    await discardIncompleteRelease(layout, name);
    expect(await readdir(layout.root)).not.toContain(name);
    expect(await readdir(path.join(layout.root, 'kept'))).toEqual([]);
    expect(await readFile(path.join(layout.state, 'groups', 'memory.md'), 'utf8')).toBe('Juno Hale prefers mornings');

    const restaged = await stageRelease(layout, 'alpha');
    expect(restaged).toBe(name);
    expect(await isReleaseComplete(layout, name)).toBe(true);
    await expect(discardIncompleteRelease(layout, name)).rejects.toMatchObject({ code: 'unsafe_release_layout' });
    await pointCurrent(layout, name);
    expect(await readCurrent(layout)).toBe(name);
  });

  it('links a staged release without writing through its links, before any state exists', async () => {
    const layout = instanceLayout(instanceRoot());
    const name = await stageRelease(layout, 'alpha', false);

    expect(await readdir(layout.root)).not.toContain('state');
    expect(await readdir(layout.root)).not.toContain('logs');
    for (const link of RELEASE_LINK_NAMES) {
      expect(await readlink(path.join(layout.release(name), link))).toBe(
        link === 'logs' ? path.join('..', 'logs') : path.join('..', 'state', link),
      );
    }
    // A staging resumed after its links were made links again, keeping them.
    await expect(linkReleaseState(layout, name)).resolves.toBeUndefined();
  });
});

describe('pruning', STAGING, () => {
  it('keeps the live release, the rollback point, the staging, and the newest quarantine, never following links', async () => {
    const { layout, a, b } = await layoutWithReleases();
    const staging = await stageRelease(layout, 'charlie');
    const old = await stageRelease(layout, 'delta');
    const incomplete = await stageRelease(layout, 'echo', false);
    await writeFile(path.join(layout.state, 'groups', 'memory.md'), 'Juno Hale prefers mornings');
    await pointCurrent(layout, b);
    for (const op of [UPDATE, LATER_UPDATE]) {
      await mkdir(path.join(layout.snapshot(op), 'data'), { recursive: true });
    }
    for (const quarantined of [UPDATE, `${ROLLBACK}-returned`, ROLLBACK]) {
      await mkdir(path.join(layout.root, 'quarantine', quarantined, 'data'), { recursive: true });
    }
    const untagged: string[] = [];

    const pruned = await pruneInstance(
      layout,
      { rollbackPoint: { release: a, snapshot: LATER_UPDATE }, staging },
      (release) => {
        untagged.push(release);
        return Promise.resolve();
      },
    );

    expect(pruned).toEqual([old, incomplete].sort());
    expect(untagged).toEqual(pruned);
    const left = await readdir(layout.root);
    for (const name of [a, b, staging]) expect(left).toContain(name);
    for (const name of pruned) expect(left).not.toContain(name);
    expect((await readdir(path.join(layout.root, 'kept'))).sort()).toEqual([a, b, staging].sort());
    expect(await readdir(path.join(layout.root, 'snapshots'))).toEqual([LATER_UPDATE]);
    expect(await readdir(path.join(layout.root, 'quarantine'))).toEqual([`${ROLLBACK}-returned`]);
    expect(await readFile(path.join(layout.state, 'groups', 'memory.md'), 'utf8')).toBe('Juno Hale prefers mornings');
    expect(await readCurrent(layout)).toBe(b);
  });

  it('prunes nothing while fenced, when the release going live is not settled', async () => {
    const { layout, a } = await layoutWithReleases();
    await pointCurrent(layout, a);
    await fence(layout);

    await expect(pruneInstance(layout, {}, () => Promise.resolve())).rejects.toMatchObject({
      code: 'unsafe_release_layout',
    });
    expect((await readdir(layout.root)).filter((entry) => /^[0-9a-f]{8}$/u.test(entry))).toHaveLength(2);
  });
});

describe('snapshots', STAGING, () => {
  async function stateWith(layout: InstanceLayout): Promise<void> {
    await mkdir(path.join(layout.state, 'data', 'v2-sessions', 'ag-main', 'sess-1'), { recursive: true });
    await writeFile(path.join(layout.state, 'data', 'v2.db'), 'central v1');
    await writeFile(path.join(layout.state, 'data', 'v2-sessions', 'ag-main', 'sess-1', 'inbound.db'), 'inbound v1');
    await writeFile(path.join(layout.state, 'groups', 'CLAUDE.md'), 'Remy Vance is the principal');
    await writeFile(path.join(layout.state, '.env'), 'WEBHOOK_PORT=4100\n');
  }

  /** Releases a and b with state, a live and then fenced for an update. */
  async function fencedForUpdate(): Promise<{ layout: InstanceLayout; a: string; b: string }> {
    const releases = await layoutWithReleases();
    await stateWith(releases.layout);
    await pointCurrent(releases.layout, releases.a);
    await fence(releases.layout);
    return releases;
  }

  it('takes a copy that later writes never reach', async () => {
    const { layout, a } = await fencedForUpdate();

    const snapshot = await takeSnapshot(layout, UPDATE, a);
    await writeFile(path.join(layout.state, 'data', 'v2.db'), 'central v2');

    expect(await readFile(path.join(snapshot, 'data', 'v2.db'), 'utf8')).toBe('central v1');
    expect(inode(path.join(snapshot, 'data', 'v2.db'))).not.toBe(inode(path.join(layout.state, 'data', 'v2.db')));
    expect(JSON.parse(await readFile(path.join(snapshot, 'snapshot.json'), 'utf8'))).toMatchObject({ release: a });
    expect(statSync(path.join(snapshot, '.env')).mode & 0o777).toBe(
      statSync(path.join(layout.state, '.env')).mode & 0o777,
    );
    expect(statSync(snapshot).mode & 0o777).toBe(0o700);
  });

  it('takes no snapshot while a release is live', async () => {
    const { layout, a } = await layoutWithReleases();
    await pointCurrent(layout, a);

    await expect(takeSnapshot(layout, UPDATE, a)).rejects.toMatchObject({ code: 'unsafe_release_layout' });
    expect(await readdir(layout.root)).not.toContain('snapshots');
  });

  it('takes a snapshot cut short again from scratch', async () => {
    const { layout, a } = await fencedForUpdate();
    await mkdir(path.join(`${layout.snapshot(UPDATE)}.building`, 'data'), { recursive: true });
    await writeFile(path.join(`${layout.snapshot(UPDATE)}.building`, 'data', 'v2.db'), 'torn');

    const snapshot = await takeSnapshot(layout, UPDATE, a);

    expect(await readFile(path.join(snapshot, 'data', 'v2.db'), 'utf8')).toBe('central v1');
    expect(await readdir(path.join(layout.root, 'snapshots'))).toEqual([UPDATE]);
  });

  it('keeps a snapshot taken under the fence still in force', async () => {
    const { layout, a } = await fencedForUpdate();
    const snapshot = await takeSnapshot(layout, UPDATE, a);
    const copied = inode(path.join(snapshot, 'data', 'v2.db'));

    // The update resumed after a crash: it fences again (still fenced) and snapshots again.
    await fence(layout);
    await takeSnapshot(layout, UPDATE, a);

    expect(inode(path.join(snapshot, 'data', 'v2.db'))).toBe(copied);
  });

  it('retakes a snapshot an earlier fence took, since the release that fence ended may have run since', async () => {
    const { layout, a } = await fencedForUpdate();
    await takeSnapshot(layout, UPDATE, a);
    // Refused before its target started: the old release went live again and recorded more.
    await pointCurrent(layout, a);
    await writeFile(path.join(layout.state, 'data', 'v2.db'), 'central v1, and what came after the refusal');

    await fence(layout);
    const snapshot = await takeSnapshot(layout, UPDATE, a);

    expect(await readFile(path.join(snapshot, 'data', 'v2.db'), 'utf8')).toBe(
      'central v1, and what came after the refusal',
    );
    expect(await readdir(path.join(layout.root, 'snapshots'))).toEqual([UPDATE]);
  });

  it('restores a snapshot whole, keeping the state it replaces in quarantine and the snapshot for another attempt', async () => {
    const { layout, a, b } = await fencedForUpdate();
    await takeSnapshot(layout, UPDATE, a);
    await pointCurrent(layout, b);
    await writeFile(path.join(layout.state, 'data', 'v2.db'), 'central v2, migrated');
    await writeFile(path.join(layout.state, 'data', 'v2.db-wal'), 'a log the old schema must never see');

    await fence(layout);
    await expect(restoreSnapshot(layout, LATER_UPDATE, ROLLBACK)).rejects.toMatchObject({
      code: 'unsafe_release_layout',
    });
    await restoreSnapshot(layout, UPDATE, ROLLBACK);
    await pointCurrent(layout, a);

    expect(await readFile(path.join(layout.current, 'data', 'v2.db'), 'utf8')).toBe('central v1');
    expect((await readdir(path.join(layout.state, 'data'))).sort()).toEqual(['v2-sessions', 'v2.db']);
    expect(await readdir(layout.state)).not.toContain('snapshot.json');
    expect(await readFile(path.join(layout.quarantine(ROLLBACK), 'data', 'v2.db'), 'utf8')).toBe(
      'central v2, migrated',
    );
    expect(await readFile(path.join(layout.snapshot(UPDATE), 'data', 'v2.db'), 'utf8')).toBe('central v1');
  });

  it.each(['after setting the state aside', 'while building its copy'])(
    'finishes a restore cut short %s',
    async (when) => {
      const { layout, a } = await fencedForUpdate();
      await takeSnapshot(layout, UPDATE, a);
      await writeFile(path.join(layout.state, 'data', 'v2.db'), 'central v2');
      await mkdir(path.join(layout.root, 'quarantine'), { recursive: true });
      await rename(layout.state, layout.quarantine(ROLLBACK));
      if (when === 'while building its copy') {
        await mkdir(path.join(`${layout.state}.building`, 'data'), { recursive: true });
        await writeFile(path.join(`${layout.state}.building`, 'data', 'v2.db'), 'torn');
      }

      await restoreSnapshot(layout, UPDATE, ROLLBACK);
      await restoreSnapshot(layout, UPDATE, ROLLBACK);

      expect(await readFile(path.join(layout.state, 'data', 'v2.db'), 'utf8')).toBe('central v1');
      expect(await readFile(path.join(layout.quarantine(ROLLBACK), 'data', 'v2.db'), 'utf8')).toBe('central v2');
      expect(await readdir(layout.root)).not.toContain('state.building');
    },
  );

  /** An update from a to b that recorded more, then a snapshot rollback to a whose target ran and wrote. */
  async function failedRollback(): Promise<{ layout: InstanceLayout; a: string; b: string; before: number }> {
    const releases = await fencedForUpdate();
    const { layout, a, b } = releases;
    await takeSnapshot(layout, UPDATE, a);
    await pointCurrent(layout, b);
    await writeFile(path.join(layout.state, 'data', 'v2.db'), 'central v2, with what b recorded');
    const before = inode(path.join(layout.state, 'data', 'v2.db'));
    await fence(layout);
    await restoreSnapshot(layout, UPDATE, ROLLBACK);
    await pointCurrent(layout, a);
    await writeFile(path.join(layout.state, 'data', 'v2.db'), 'central v1, written by a before it failed');
    await fence(layout);
    return { ...releases, before };
  }

  it('returns the state a failed rollback replaced, keeping what its target produced', async () => {
    const { layout, b, before } = await failedRollback();

    await returnQuarantinedState(layout, ROLLBACK);
    await pointCurrent(layout, b);

    expect(inode(path.join(layout.current, 'data', 'v2.db'))).toBe(before);
    expect(await readFile(path.join(layout.state, 'data', 'v2.db'), 'utf8')).toBe('central v2, with what b recorded');
    expect(await readdir(path.join(layout.root, 'quarantine'))).toEqual([`${ROLLBACK}-returned`]);
    expect(await readFile(path.join(layout.root, 'quarantine', `${ROLLBACK}-returned`, 'data', 'v2.db'), 'utf8')).toBe(
      'central v1, written by a before it failed',
    );
  });

  it.each(['after setting the target state aside', 'after returning the state'])(
    'finishes a return cut short %s',
    async (when) => {
      const { layout, before } = await failedRollback();
      await rename(layout.state, path.join(layout.root, 'quarantine', `${ROLLBACK}-returned`));
      if (when === 'after returning the state') await rename(layout.quarantine(ROLLBACK), layout.state);

      await returnQuarantinedState(layout, ROLLBACK);
      await returnQuarantinedState(layout, ROLLBACK);

      expect(inode(path.join(layout.state, 'data', 'v2.db'))).toBe(before);
      expect(await readdir(path.join(layout.root, 'quarantine'))).toEqual([`${ROLLBACK}-returned`]);
    },
  );

  it('copies a planted link as a link, leaves out a pipe, and copies a planted database side file untouched', async () => {
    const { layout, a } = await fencedForUpdate();
    const session = path.join(layout.state, 'data', 'v2-sessions', 'ag-main', 'sess-1');
    await symlink('/etc/passwd', path.join(session, 'outbox'));
    await writeFile(path.join(session, 'outbound.db'), 'not a database');
    await writeFile(path.join(session, 'outbound.db-journal'), 'garbage an agent planted');
    execFileSync('mkfifo', [path.join(session, 'pipe')]);

    const snapshot = await takeSnapshot(layout, UPDATE, a);

    const copied = path.join(snapshot, 'data', 'v2-sessions', 'ag-main', 'sess-1');
    expect(await readlink(path.join(copied, 'outbox'))).toBe('/etc/passwd');
    expect((await readdir(copied)).sort()).toEqual(['inbound.db', 'outbound.db', 'outbound.db-journal', 'outbox']);
    expect(await readFile(path.join(copied, 'outbound.db-journal'), 'utf8')).toBe('garbage an agent planted');
    expect(await readFile(path.join(session, 'outbound.db-journal'), 'utf8')).toBe('garbage an agent planted');
  });

  it('names operations by when they began, so their names sort that way', () => {
    expect(operationName('2026-10-09T10:15:00.123Z')).toBe('20261009T101500123Z');
    expect([ROLLBACK, UPDATE, LATER_UPDATE].sort()).toEqual([UPDATE, LATER_UPDATE, ROLLBACK]);
    expect(() => operationName('2026-10-09T10:15:00Z')).toThrow(/not a start time/u);
    expect(() => instanceLayout('/x').snapshot('../state')).toThrow(/not an operation name/u);
  });
});

/** Run `args` under tsx with NanoClaw's sources, from `cwd`, the way the service starts the host. */
function tsx(cwd: string, args: readonly string[], env: Readonly<Record<string, string>> = {}): string {
  const result = spawnSync(TSX, args, { cwd, encoding: 'utf8', env: hostEnvironment(env) });
  if (result.status !== 0) throw new Error(`tsx failed (${result.status}): ${result.stderr}`);
  return result.stdout.trim().split('\n').at(-1) ?? '';
}

function hostEnvironment(env: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '',
    HOME: os.homedir(),
    NANOCLAW_INSTALL_ID: INSTALL_ID,
    LOG_LEVEL: 'error',
    ...env,
  };
}

function wrapped(code: string): string {
  return `(async () => {\n${code}\n})().catch((error) => { console.error(error); process.exit(1); });`;
}

function inNanoClaw(cwd: string, code: string, env: Readonly<Record<string, string>> = {}): string {
  return tsx(cwd, ['--eval', wrapped(code)], env);
}

const SOURCE = (file: string): string => JSON.stringify(path.join(CONTROL_PLANE_ROOT, file));

describe('NanoClaw run through the live link', STAGING, () => {
  it('roots its state in state/, its code in the release, and its names in the install ID, not the path', async () => {
    const { layout, a } = await layoutWithReleases();
    await writeFile(path.join(layout.state, '.env'), 'ASSISTANT_NAME=Juno\n');
    await pointCurrent(layout, a);

    const seen = JSON.parse(
      inNanoClaw(
        layout.current,
        `const c = await import(${SOURCE('src/config.ts')});
         const e = await import(${SOURCE('src/env.ts')});
         console.log(JSON.stringify({ cwd: process.cwd(), data: c.DATA_DIR, groups: c.GROUPS_DIR, store: c.STORE_DIR,
           slug: c.INSTALL_SLUG, image: c.CONTAINER_IMAGE, label: c.CONTAINER_INSTALL_LABEL,
           env: e.readEnvFile(['ASSISTANT_NAME']) }));`,
        { CONTAINER_IMAGE: `nanoclaw-agent-v2-${INSTALL_ID}:r-${a}` },
      ),
    ) as Record<string, unknown>;

    expect(seen.cwd).toBe(layout.release(a));
    expect(realpathSync(seen.data as string)).toBe(path.join(layout.state, 'data'));
    expect(realpathSync(seen.groups as string)).toBe(path.join(layout.state, 'groups'));
    expect(realpathSync(seen.store as string)).toBe(path.join(layout.state, 'store'));
    expect(seen).toMatchObject({
      slug: INSTALL_ID,
      label: `nanoclaw-install=${INSTALL_ID}`,
      image: `nanoclaw-agent-v2-${INSTALL_ID}:r-${a}`,
      env: { ASSISTANT_NAME: 'Juno' },
    });
    // The ncl socket NanoClaw binds is exactly as long as one under `<instance>/nanoclaw`.
    expect(path.join(seen.data as string, 'ncl.sock').length).toBe(
      path.join(layout.root, 'nanoclaw', 'data', 'ncl.sock').length,
    );
  });

  it("keeps the release's .env link when NanoClaw's own writer updates it", async () => {
    const { layout, a } = await layoutWithReleases();
    await writeFile(path.join(layout.state, '.env'), 'WEBHOOK_PORT=4100\n', { mode: 0o600 });
    await pointCurrent(layout, a);

    // Upstream's writer, from the release's working directory as the host and setup run it.
    inNanoClaw(
      layout.current,
      `const s = await import(${SOURCE('setup/set-env.ts')}); s.upsertEnvVars({ WEBHOOK_HOST: '127.0.0.1' }); console.log('ok');`,
    );

    expect(lstatSync(path.join(layout.release(a), '.env')).isSymbolicLink()).toBe(true);
    expect(readFileSync(path.join(layout.state, '.env'), 'utf8')).toBe('WEBHOOK_PORT=4100\nWEBHOOK_HOST=127.0.0.1\n');
  });

  it('stamps the upgrade tripwire per release in the state they share, so only the stamped release starts', async () => {
    const { layout, a, b } = await layoutWithReleases();
    const current = `const u = await import(${SOURCE('src/upgrade-state.ts')}); console.log(String(u.isUpgradeCurrent()));`;
    // The switch's stamp: NanoClaw's own script, run while fenced from the target release's directory.
    const switchTo = async (name: string): Promise<void> => {
      await fence(layout);
      tsx(layout.release(name), [path.join(CONTROL_PLANE_ROOT, 'scripts', 'upgrade-state.ts'), 'set', '', 'gws-ea']);
      await pointCurrent(layout, name);
    };

    await switchTo(a);
    expect(inNanoClaw(layout.current, current)).toBe('true');
    expect(JSON.parse(readFileSync(path.join(layout.state, 'data', 'upgrade-state.json'), 'utf8'))).toMatchObject({
      commit: git(layout.release(a), 'rev-parse', 'HEAD'),
      via: 'gws-ea',
    });
    // B was staged against the same state, but its own commit was never stamped.
    expect(inNanoClaw(layout.release(b), current)).toBe('false');

    await switchTo(b);
    expect(inNanoClaw(layout.current, current)).toBe('true');
    expect(inNanoClaw(layout.release(a), current)).toBe('false');
  });

  it('shares one SQLite database between releases through their links, its log beside it in state/', async () => {
    const { layout, a, b } = await layoutWithReleases();
    await pointCurrent(layout, a);
    const fromA = new Database(path.join(layout.current, 'data', 'v2.db'));
    fromA.pragma('journal_mode = WAL');
    fromA.exec("CREATE TABLE messages (body TEXT); INSERT INTO messages VALUES ('from Morgan Ellery')");

    const fromB = new Database(path.join(layout.release(b), 'data', 'v2.db'));
    fromB.exec("INSERT INTO messages VALUES ('reply to Morgan Ellery')");
    expect(fromA.prepare('SELECT count(*) AS n FROM messages').get()).toEqual({ n: 2 });
    expect(await readdir(path.join(layout.state, 'data'))).toContain('v2.db-wal');
    fromB.close();
    fromA.close();

    await fence(layout);
    await pointCurrent(layout, b);
    const again = new Database(path.join(layout.current, 'data', 'v2.db'), { readonly: true });
    expect(again.prepare('SELECT body FROM messages ORDER BY rowid').all()).toEqual([
      { body: 'from Morgan Ellery' },
      { body: 'reply to Morgan Ellery' },
    ]);
    again.close();
    for (const name of [a, b]) expect(lstatSync(path.join(layout.release(name), 'data')).isSymbolicLink()).toBe(true);
  });

  it("answers upstream's host status through the live link, its socket in state/", async () => {
    const { layout, a } = await layoutWithReleases();
    await pointCurrent(layout, a);
    // The host's startup, cut to what its status needs: the central database, the instance lease, and the ncl socket.
    const host = spawn(
      TSX,
      [
        '--eval',
        wrapped(
          `const c = await import(${SOURCE('src/config.ts')});
           const db = await (await import(${SOURCE('src/db/connection.ts')})).initDb(c.CENTRAL_DB_PATH, { role: 'host' });
           await (await import(${SOURCE('src/db/migrations/index.ts')})).runMigrations(db, undefined, { mode: 'auto' });
           const id = await (await import(${SOURCE('src/host-instance.ts')})).startHostInstanceLease();
           await import(${SOURCE('src/cli/commands/status.ts')});
           await (await import(${SOURCE('src/cli/socket-server.ts')})).startCliServer();
           console.log('serving ' + id);`,
        ),
      ],
      { cwd: layout.current, env: hostEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] },
    );
    try {
      const instanceId = await new Promise<string>((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        host.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
          const serving = /^serving (\S+)$/mu.exec(stdout);
          if (serving) resolve(serving[1]!);
        });
        host.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
        host.once('exit', (code) => reject(new Error(`The host exited (${code}): ${stderr}`)));
      });

      // Upstream's own status query, as gws-ea's status and NanoClaw's restart run it, given the live link.
      const status = spawnSync(
        process.execPath,
        [path.join(CONTROL_PLANE_ROOT, 'setup', 'lib', 'host-status.mjs'), 'snapshot', layout.current],
        { encoding: 'utf8' },
      );
      expect(status.stderr).toBe('');
      expect(status.stdout.trim()).toBe(instanceId);
      expect(lstatSync(path.join(layout.state, 'data', 'ncl.sock')).isSocket()).toBe(true);
      expect(lstatSync(path.join(layout.state, 'data', 'v2.db')).isFile()).toBe(true);
    } finally {
      host.kill('SIGKILL');
    }
  });

  it('leaves a release clean to Git with its five links in place, as upstream ignores them', async () => {
    const { layout, a } = await layoutWithReleases();
    expect(git(layout.release(a), 'status', '--porcelain=v1', '--untracked-files=all', '--ignored=no')).toBe('');
    for (const link of RELEASE_LINK_NAMES) {
      expect(lstatSync(path.join(layout.release(a), link)).isSymbolicLink()).toBe(true);
    }
  });
});

describe("NanoClaw's own update's install state", () => {
  /**
   * The launcher and PID file of setup's nohup fallback (`setup/service.ts`,
   * for hosts without a usable service manager). gws-ea runs each assistant
   * under launchd or systemd only (`InstanceServiceManager` in
   * service-coordinates.ts), so no release ever writes either, and the
   * layout keeps them out of its state.
   */
  const NOHUP_ONLY = ['start-nanoclaw.sh', 'nanoclaw.pid'];

  it('is all state the layout links, save the nohup files gws-ea never runs', () => {
    const transaction = readFileSync(path.join(CONTROL_PLANE_ROOT, 'scripts', 'update', 'transaction.ts'), 'utf8');
    const declared = /^const MUTABLE_PATHS = \[([^\]]*)\];$/mu.exec(transaction)?.[1];
    expect(
      declared,
      "scripts/update/transaction.ts no longer declares MUTABLE_PATHS; re-derive STATE_ROOTS from NanoClaw's update",
    ).toBeDefined();
    const nanoclawRoots = [...(declared ?? '').matchAll(/'([^']+)'/gu)].map((match) => match[1]);

    expect(nanoclawRoots.length).toBeGreaterThan(0);
    for (const root of nanoclawRoots) expect([...STATE_ROOTS, ...NOHUP_ONLY]).toContain(root);
  });
});
