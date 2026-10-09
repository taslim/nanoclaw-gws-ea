/**
 * `update` on the release layout: an assistant built as create leaves it
 * (`state/` with a closed central database, its release staged and kept, the
 * live link naming it) gets the tool's release staged beside the running
 * one, then is fenced, snapshotted, switched, started, verified, and
 * committed, its state never moved. Git, tar, SQLite, and the files are
 * real; the service manager, Docker and OneCLI, `ps`, `lsof`, the release's
 * install, build, migration, and tripwire scripts, the host's status and
 * listener, and `ncl` are faked at their boundaries.
 */
import { readlinkSync } from 'node:fs';
import { mkdir, readdir, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ADDED_MIGRATION,
  applying,
  assistant,
  cli,
  converse,
  DEPLOYED_GATEWAY,
  dependencies,
  exists,
  FAILING_MIGRATION,
  git,
  IMAGE_BYTES,
  imageBase,
  killDuringUpdate,
  layoutOf,
  LIVE_MIGRATIONS,
  LOCKFILE,
  machine,
  MAIN_FOLDER,
  MAIN_SKILLS,
  mainTemplate,
  MEMORY,
  messages,
  NEW_IMAGE,
  nextRelease,
  reboot,
  release,
  releaseAgentImageKey,
  RELEASE_GATEWAY,
  releaseTag,
  removeTemporaryRoots,
  repositoryImages,
  SERVICE,
  serviceDefinitionFile,
  snapshot,
  status,
  temporaryRoot,
  world,
  write,
  type Machine,
  type Release,
  type World,
} from './testing/cutover-fixture.js';
import { openCutoverHost, switchTo } from './cutover.js';
import { acquireInstanceOperation } from './journal.js';
import { readOperationRecord, readRollbackPoint, type OperationPhase } from './operation.js';
import type { SanitizedCommandRunner } from './process.js';
import { getInstanceReservation } from './registry.js';
import { releaseName } from './release-layout.js';
import { launchInstanceHost, type InstanceRuntimeConfig } from './service.js';
import { GwsEaError, PROVISION_STEPS, releaseOf, type ReleaseCoordinates } from './types.js';
import {
  dryRunReleaseMigrations,
  prepareUpdate,
  resolveUpdateIntent,
  updatePreviewLines,
  type StagedUpdate,
  type UpdateDependencies,
  type UpdatePreview,
} from './update.js';
import { readCentralMigrations } from './verify.js';

/**
 * Kill the process once the operation record is written at `phase`, as a
 * crash right after recording it would; or fail the write of the committed
 * record once, as a full disk fails it, right after the registry's
 * compare-and-swap.
 */
const records = vi.hoisted(() => ({
  killAfter: undefined as string | undefined,
  reached: undefined as (() => void) | undefined,
  failCommitted: false,
}));
vi.mock('../community-portal/private-file.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../community-portal/private-file.js')>();
  const writePrivate: typeof actual.writePrivate = async (file, value) => {
    const phase = typeof value === 'object' && value !== null && 'phase' in value ? value.phase : undefined;
    const record = file.endsWith('/operation.json');
    if (records.failCommitted && record && phase === 'committed') {
      records.failCommitted = false;
      throw Object.assign(new Error(`ENOSPC: no space left on device, write '${file}'`), { code: 'ENOSPC' });
    }
    await actual.writePrivate(file, value);
    if (record && phase !== undefined && phase === records.killAfter) {
      records.killAfter = undefined;
      records.reached?.();
      await new Promise(() => undefined);
    }
  };
  return { ...actual, writePrivate };
});

afterEach(removeTemporaryRoots);
afterEach(() => {
  records.killAfter = undefined;
  records.failCommitted = false;
});

/** Each case clones, fetches, and stages real Git repositories, which a loaded machine slows. */
const GIT_HEAVY = { timeout: 60_000 } as const;

/** Stage an update of `runtime`'s assistant under its instance lock, as the command does. */
async function stage(host: Machine, runtime: InstanceRuntimeConfig, deps: UpdateDependencies): Promise<StagedUpdate> {
  const intent = await resolveUpdateIntent(host.paths, { instanceId: runtime.instance_id }, deps);
  const operation = await acquireInstanceOperation(host.paths, runtime.instance_id, {
    command: 'update',
    target: intent.target,
  });
  if (!operation) throw new Error('The test instance operation was busy');
  try {
    return await prepareUpdate(operation, intent, deps);
  } finally {
    operation.release();
  }
}

/** Run an update, killing it once its record is written at `phase`. */
async function killAfter(
  phase: OperationPhase,
  host: Machine,
  runtime: InstanceRuntimeConfig,
  state: World,
  next: Release,
): Promise<void> {
  records.killAfter = phase;
  records.reached = () => state.reached?.();
  await killDuringUpdate(host, runtime, state, next);
}

/**
 * The assistant once an update from the machine's first release to `to` is
 * committed and finished: the registry and the live link name `to`, whose
 * tripwire its own script stamped; the release it left is the rollback
 * point, with the snapshot the update took; its host runs `to`'s image tag;
 * and nothing of the update is left open.
 */
async function expectUpdated(host: Machine, runtime: InstanceRuntimeConfig, to: Release, state: World) {
  const id = runtime.instance_id;
  const layout = layoutOf(host, runtime);
  expect(releaseOf(await getInstanceReservation(host.paths, id))).toEqual(release(host, to.commit));
  expect(await readlink(layout.current)).toBe(releaseName(to.commit));
  expect(git(runtime.checkout_root, 'rev-parse', 'HEAD')).toBe(to.commit);
  expect(git(runtime.checkout_root, 'status', '--porcelain', '--untracked-files=all')).toBe('');
  expect(JSON.parse(await readFile(path.join(runtime.state_root, 'data', 'upgrade-state.json'), 'utf8'))).toEqual({
    commit: to.commit,
    via: 'gws-ea',
  });
  const point = await readRollbackPoint(host.paths, id);
  expect(point?.release).toEqual(release(host, host.first));
  expect(await exists(layout.snapshot(point!.snapshot))).toBe(true);
  expect(await exists(layout.release(releaseName(host.first)))).toBe(true);
  expect(await readOperationRecord(host.paths, id)).toBeUndefined();
  expect(state.tags.has(releaseTag(runtime, to.commit))).toBe(true);
  expect(state.tags.has(releaseTag(runtime, host.first))).toBe(true);
  expect(repositoryImages(state, imageBase(runtime)).untagged).toEqual([]);
  expect(state.running).toBe(true);
}

describe('staging an update while the assistant serves', GIT_HEAVY, () => {
  it("stages the tool's release in its own folder, writing nothing into the assistant's state, and previews it", async () => {
    const host = await machine();
    const runtime = await assistant(host, { gateway: DEPLOYED_GATEWAY });
    const next = await nextRelease(host);
    const state = world(runtime, applying(ADDED_MIGRATION));
    const layout = layoutOf(host, runtime);
    const before = await snapshot(layout.state);

    const staged = await stage(host, runtime, dependencies(state, next, runtime));

    const id = runtime.instance_id;
    expect(staged.preview).toEqual({
      instanceId: id,
      from: release(host, host.first),
      to: release(host, next.commit),
      migrations: [ADDED_MIGRATION],
      gateway: { current: DEPLOYED_GATEWAY, release: RELEASE_GATEWAY },
      groupImages: [{ id: 'ag-research', name: 'research' }],
      agentRunnerLockChanged: false,
      sessionSchemaChanged: false,
    });
    // It served throughout, and staging wrote nothing into its state: the dry run ran on a copy in the release.
    expect(state.running).toBe(true);
    expect(state.events).toEqual(['setup install', 'setup build']);
    expect(await snapshot(layout.state)).toEqual(before);
    expect(await readlink(layout.current)).toBe(releaseName(host.first));
    // The release is complete in its own folder, linked to the state, its receipt kept last.
    const staging = layout.release(releaseName(next.commit));
    expect(git(staging, 'rev-parse', 'HEAD')).toBe(next.commit);
    expect(await readlink(path.join(staging, 'data'))).toBe(path.join('..', 'state', 'data'));
    expect(JSON.parse(await readFile(layout.receipt(releaseName(next.commit)), 'utf8'))).toMatchObject({
      instance_id: id,
      deployed_commit: next.commit,
    });
    // Its image was built hermetically and labeled with its key, under the release's own tag.
    const key = releaseAgentImageKey(next);
    expect(state.labels.get(state.tags.get(releaseTag(runtime, next.commit))!)).toBe(key);
    expect(repositoryImages(state, imageBase(runtime)).untagged).toEqual([]);
    // Nothing is recorded until the operator confirms.
    expect(await readOperationRecord(host.paths, id)).toBeUndefined();
    expect(staged.manifest).toEqual({ central_migrations: [...LIVE_MIGRATIONS], session_tables: {} });

    const preview = updatePreviewLines(staged.preview).join('\n');
    expect(preview).toContain(`dogfood ${host.first.slice(0, 12)}`);
    expect(preview).toContain(`dogfood ${next.commit.slice(0, 12)}`);
    expect(preview).toContain(ADDED_MIGRATION);
    expect(preview).toContain(`${DEPLOYED_GATEWAY} → ${RELEASE_GATEWAY}`);
    expect(preview).toContain('research (ag-research)');
    expect(preview).toMatch(/failure after it starts may restore the pre-update snapshot/u);
  });

  it.each([
    [
      'only the session-schema sources',
      { 'src/mailbox/sqlite/session-db.ts': '// session columns 2\n' },
      { sessionSchemaChanged: true, agentRunnerLockChanged: false },
    ],
    [
      'only the agent-runner lockfile',
      { [LOCKFILE]: 'lock 2\n' },
      { sessionSchemaChanged: false, agentRunnerLockChanged: true },
    ],
  ] as const)('previews a release that changes %s for what it is', async (_label, files, expected) => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host, files);

    const staged = await stage(host, runtime, dependencies(world(runtime), next, runtime));

    expect(staged.preview).toMatchObject({ ...expected, migrations: [] });
  });

  it('reuses a release an earlier staging completed, with the dry run it kept, staging nothing again', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host);
    const state = world(runtime, applying(ADDED_MIGRATION));
    await stage(host, runtime, dependencies(state, next, runtime));
    expect(state.setups).toHaveLength(2);

    const again = await stage(host, runtime, dependencies(state, next, runtime));

    expect(again.preview.migrations).toEqual([ADDED_MIGRATION]);
    expect(state.setups).toHaveLength(2);
  });

  it('keeps nothing live changed and records nothing when the agent image build fails', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host, NEW_IMAGE);
    const state = world(runtime);
    state.buildFails = true;
    const layout = layoutOf(host, runtime);
    const before = await snapshot(layout.state);

    await expect(stage(host, runtime, dependencies(state, next, runtime))).rejects.toMatchObject({
      code: 'command_failed',
    });

    expect(await snapshot(layout.state)).toEqual(before);
    expect(state.running).toBe(true);
    expect(await readOperationRecord(host.paths, runtime.instance_id)).toBeUndefined();
    // Left incomplete, without its receipt, for the next update to stage again.
    expect(await exists(layout.receipt(releaseName(next.commit)))).toBe(false);
  });

  it('refuses a release whose migrations fail on a copy of the database, naming them, with nothing live changed', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host);
    const state = world(runtime, (file) => {
      applying(ADDED_MIGRATION)(file);
      throw new GwsEaError('command_failed', 'pnpm exited with code 1', {
        details: { exitCode: 1, stderrTail: `Error: migration ${FAILING_MIGRATION} left FK violations` },
      });
    });

    await expect(stage(host, runtime, dependencies(state, next, runtime))).rejects.toMatchObject({
      code: 'migration_dry_run_failed',
      message: expect.stringContaining(ADDED_MIGRATION),
      details: { stderrTail: expect.stringContaining(FAILING_MIGRATION), applied: [ADDED_MIGRATION] },
    });
    expect(readCentralMigrations(runtime.state_root)).toEqual([...LIVE_MIGRATIONS]);
  });

  it('refuses a live release with tracked edits, naming them, and stages nothing', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host);
    await write(runtime.checkout_root, 'release.txt', 'patched in place\n');
    const state = world(runtime);

    await expect(stage(host, runtime, dependencies(state, next, runtime))).rejects.toMatchObject({
      code: 'deployment_checkout_modified',
      message: expect.stringContaining('release.txt'),
    });

    expect(await exists(layoutOf(host, runtime).release(releaseName(next.commit)))).toBe(false);
  });

  it('refuses before staging when the disk cannot hold the staged release, a snapshot of its state, and a new image', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host, NEW_IMAGE);
    const state = world(runtime);
    const measured: string[] = [];
    const deps: UpdateDependencies = {
      ...dependencies(state, next, runtime),
      freeBytes: async (directory) => {
        measured.push(directory);
        return IMAGE_BYTES;
      },
    };

    const refusal = stage(host, runtime, deps);

    await expect(refusal).rejects.toMatchObject({ code: 'insufficient_disk' });
    await expect(refusal).rejects.toSatisfy(
      (error: GwsEaError) => typeof error.details?.needed === 'number' && error.details.needed > IMAGE_BYTES,
    );
    expect(await exists(layoutOf(host, runtime).release(releaseName(next.commit)))).toBe(false);
    // Measured where the snapshot goes: the filesystem holding the physical state.
    expect(measured).toEqual([runtime.state_root]);
  });

  it('refuses an assistant whose create has not finished, naming resume', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host);
    const journal = JSON.parse(await readFile(host.paths.journalFile(runtime.instance_id), 'utf8')) as {
      steps: Record<string, unknown>;
    };
    delete journal.steps[PROVISION_STEPS.at(-1)!];
    await writeFile(host.paths.journalFile(runtime.instance_id), JSON.stringify(journal), { mode: 0o600 });

    await expect(stage(host, runtime, dependencies(world(runtime), next, runtime))).rejects.toMatchObject({
      code: 'instance_not_created',
      message: expect.stringContaining(`gws-ea resume --id ${runtime.instance_id}`),
    });
  });
});

/** The inode of the central database, which a switch never moves or copies. */
async function centralInode(runtime: InstanceRuntimeConfig): Promise<number> {
  return (await stat(path.join(runtime.state_root, 'data', 'v2.db'))).ino;
}

/** Main's shared skills, as the assistant's central database records them. */
function mainSkills(runtime: InstanceRuntimeConfig): unknown {
  const database = new Database(path.join(runtime.state_root, 'data', 'v2.db'), { readonly: true });
  try {
    const row = database.prepare("SELECT skills FROM container_configs WHERE agent_group_id = 'ag-main'").get() as {
      skills: string | null;
    };
    return row.skills === null ? null : (JSON.parse(row.skills) as unknown);
  } finally {
    database.close();
  }
}

describe('gws-ea update', GIT_HEAVY, () => {
  it("switches the assistant to the tool's release without moving its state, keeping the release it left to roll back to", async () => {
    const host = await machine();
    const runtime = await assistant(host);
    await converse(runtime, 'm1', 'm2');
    const next = await nextRelease(host, NEW_IMAGE);
    const state = world(runtime);
    const inode = await centralInode(runtime);
    const displaced = state.tags.get(`${imageBase(runtime)}:ag-research`)!;
    const { run, out } = cli(host, state, next, runtime);

    expect(await run(['update', '--id', runtime.instance_id, '--yes'])).toBe(0);

    await expectUpdated(host, runtime, next, state);
    // The state stayed where it was, whole: the release reaches it through its links.
    expect(await centralInode(runtime)).toBe(inode);
    expect(messages(runtime.state_root)).toEqual(['m1', 'm2']);
    expect(await readFile(path.join(runtime.checkout_root, MEMORY), 'utf8')).toContain('mornings');
    // Offline only for the switch: staged while serving, then stopped once, started once.
    expect(state.events).toEqual(['setup install', 'setup build', 'build', 'stop running', 'start']);
    // The snapshot is a copy of the state as the release it left last wrote it.
    const point = await readRollbackPoint(host.paths, runtime.instance_id);
    const snapshotted = layoutOf(host, runtime).snapshot(point!.snapshot);
    expect(messages(snapshotted)).toEqual(['m1', 'm2']);
    expect((await stat(path.join(snapshotted, 'data', 'v2.db'))).ino).not.toBe(inode);
    expect(point?.manifest.central_migrations).toEqual([...LIVE_MIGRATIONS]);
    // Main's skills were reconciled through its own host, and the group image rebuilt on the release's image.
    expect(state.skills).toEqual([['agent-browser']]);
    expect(state.rebuilds.map((rebuild) => rebuild.args)).toEqual([
      ['groups', 'restart', '--id', 'ag-research', '--rebuild'],
    ]);
    expect(state.ids.has(displaced)).toBe(false);
    expect(out).toContain(`Assistant ${runtime.instance_id} was updated to dogfood ${next.commit.slice(0, 12)}.`);
  });

  it("reaches main with a release's changed list of shared skills, its template never stamped again", async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const main = await snapshot(path.join(runtime.state_root, MAIN_FOLDER));
    const next = await nextRelease(host, {
      [MAIN_SKILLS]: `${JSON.stringify(['agent-browser', 'gmail'])}\n`,
      ...mainTemplate('2'),
    });
    const state = world(runtime);

    expect(await cli(host, state, next, runtime).run(['update', '--id', runtime.instance_id, '--yes'])).toBe(0);

    expect(mainSkills(runtime)).toEqual(['agent-browser', 'gmail']);
    expect(await snapshot(path.join(runtime.state_root, MAIN_FOLDER))).toEqual(main);
  });

  it('prunes the release before the rollback point, its kept files, image tag, and snapshot, and a saved file still resolves', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const layout = layoutOf(host, runtime);
    // A file saved under the first release, recorded by its place in the data directory.
    const saved = path.join('gws-ea', 'inbox', 'thread-1', 'notes.txt');
    await write(path.join(runtime.checkout_root, 'data'), saved, 'saved under the first release\n');
    const second = await nextRelease(host, NEW_IMAGE);
    const state = world(runtime);
    expect(await cli(host, state, second, runtime).run(['update', '--id', runtime.instance_id, '--yes'])).toBe(0);
    const firstSnapshot = (await readRollbackPoint(host.paths, runtime.instance_id))!.snapshot;
    const third = await nextRelease(host, { 'container/Dockerfile': 'FROM scratch\nRUN false\n' });

    expect(await cli(host, state, third, runtime).run(['update', '--id', runtime.instance_id, '--yes'])).toBe(0);

    const first = releaseName(host.first);
    expect(await exists(layout.release(first))).toBe(false);
    expect(await exists(layout.kept(first))).toBe(false);
    expect(state.tags.has(releaseTag(runtime, host.first))).toBe(false);
    expect(await exists(layout.snapshot(firstSnapshot))).toBe(false);
    const point = await readRollbackPoint(host.paths, runtime.instance_id);
    expect(point?.release).toEqual(release(host, second.commit));
    expect(await readdir(path.join(layout.root, 'snapshots'))).toEqual([point!.snapshot]);
    expect(await readFile(path.join(runtime.checkout_root, 'data', saved), 'utf8')).toBe(
      'saved under the first release\n',
    );
    expect(repositoryImages(state, imageBase(runtime)).untagged).toEqual([]);
  });

  it('gives a second assistant updated to the same release the image the first built: no build, no new image', async () => {
    const host = await machine();
    const a = await assistant(host);
    const b = await assistant(host, { port: 38_001 });
    const next = await nextRelease(host, NEW_IMAGE);
    const state = world(a);
    for (const tag of [releaseTag(b, host.first), `${imageBase(b)}:ag-research`]) {
      state.tags.set(tag, state.tags.get(tag.startsWith(imageBase(b)) ? releaseTag(a, host.first) : tag) ?? tag);
    }
    state.tags.set(`${imageBase(b)}:ag-research`, state.tags.get(`${imageBase(a)}:ag-research`)!);
    expect(await cli(host, state, next, a).run(['update', '--id', a.instance_id, '--yes'])).toBe(0);
    const built = state.tags.get(releaseTag(a, next.commit))!;
    const builds = state.commands.filter((command) => command.command === 'bash').length;

    expect(await cli(host, state, next, b).run(['update', '--id', b.instance_id, '--yes'])).toBe(0);

    expect(state.commands.filter((command) => command.command === 'bash')).toHaveLength(builds);
    expect(state.tags.get(releaseTag(b, next.commit))).toBe(built);
  });

  it('stands by a release the registry committed when the record write after it fails, and update settles it', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host);
    const state = world(runtime);
    const id = runtime.instance_id;
    const { run, err, out } = cli(host, state, next, runtime);
    records.failCommitted = true;

    expect(await run(['update', '--id', id, '--yes'])).toBe(1);

    expect(records.failCommitted).toBe(false);
    const summary = err.join('\n');
    expect(summary).toContain(
      `Assistant ${id} runs dogfood ${next.commit.slice(0, 12)}: its update was committed before that failed, so it stands, and gws-ea update --id ${id} finishes recording it.`,
    );
    expect(summary).not.toContain('rolled back');
    expect(releaseOf(await getInstanceReservation(host.paths, id))).toEqual(release(host, next.commit));
    expect((await readOperationRecord(host.paths, id))?.phase).toBe('verified');
    const checks = state.healthWaits.length;

    expect(await run(['update', '--id', id, '--yes'])).toBe(0);

    // The gate settled it, rollback point included, and ran its follow-ups, without verifying again.
    expect(state.healthWaits).toHaveLength(checks);
    await expectUpdated(host, runtime, next, state);
    expect(out).toContain(`Assistant ${id} runs dogfood ${next.commit.slice(0, 12)}; its update is finished.`);
  });

  it("allows a killed host's claim lease when the stop was not graceful", async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host);
    const state = world(runtime);
    // The host leaves its lease live: killed, it never marked itself stopped.
    const database = new Database(path.join(runtime.state_root, 'data', 'v2.db'));
    try {
      database.exec(
        'CREATE TABLE host_instances (instance_id TEXT PRIMARY KEY, lease_expires_at TEXT NOT NULL, stopped_at TEXT)',
      );
      database.prepare('INSERT INTO host_instances VALUES (?, ?, NULL)').run('host-1', '2999-01-01T00:00:00.000Z');
    } finally {
      database.close();
    }

    expect(await cli(host, state, next, runtime).run(['update', '--id', runtime.instance_id, '--yes'])).toBe(0);

    expect(state.healthWaits.at(-1)).toBe(150_000);
  });

  it('keeps a failed image rebuild as a follow-up that leaves the release in place, and retries it next time', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host);
    const state = world(runtime);
    state.rebuildFails = true;
    const displaced = state.tags.get(`${imageBase(runtime)}:ag-research`)!;
    const { run, err, out } = cli(host, state, next, runtime);

    expect(await run(['update', '--id', runtime.instance_id, '--yes'])).toBe(1);

    expect(err.join('\n')).toContain("rebuilding agent group ag-research's image");
    expect(releaseOf(await getInstanceReservation(host.paths, runtime.instance_id))).toEqual(
      release(host, next.commit),
    );
    // The image the rebuild displaces was recorded before it ran, and is reclaimed only once the rebuild succeeds.
    expect((await readOperationRecord(host.paths, runtime.instance_id))?.follow_ups).toEqual([
      { kind: 'rebuild_group_image', agent_group_id: 'ag-research' },
      { kind: 'prune' },
      { kind: 'reclaim_image', image_id: displaced },
    ]);
    expect(state.ids.has(displaced)).toBe(true);
    const observed = await status(host, state, next, runtime);
    expect(observed.operation).toMatchObject({ state: 'committed', follow_ups: expect.any(Array) });
    delete state.rebuildFails;

    expect(await run(['update', '--id', runtime.instance_id, '--yes'])).toBe(0);

    await expectUpdated(host, runtime, next, state);
    expect(out).toContain(
      `Assistant ${runtime.instance_id} runs dogfood ${next.commit.slice(0, 12)}; its update is finished.`,
    );
  });

  it("updates one assistant without touching another's release, state, or service", async () => {
    const host = await machine();
    const a = await assistant(host);
    const b = await assistant(host, { port: 38_001 });
    const next = await nextRelease(host);
    const bRoot = host.paths.instanceRoot(b.instance_id);
    const before = await snapshot(bRoot);
    const state = world(a);

    expect(await cli(host, state, next, a).run(['update', '--id', a.instance_id, '--yes'])).toBe(0);

    expect(await snapshot(bRoot)).toEqual(before);
    expect(releaseOf(await getInstanceReservation(host.paths, b.instance_id))).toEqual(release(host, host.first));
    expect(state.commands.some((command) => JSON.stringify(command).includes(b.install_id))).toBe(false);
  });

  it('refuses a stopped assistant naming gws-ea start, staging nothing', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host);
    const state = world(runtime);
    state.loaded = false;
    state.running = false;
    const { run, err } = cli(host, state, next, runtime);

    expect(await run(['update', '--id', runtime.instance_id, '--yes'])).toBe(1);

    expect(err.join('\n')).toContain(`start it with gws-ea start --id ${runtime.instance_id}`);
    expect(await exists(layoutOf(host, runtime).release(releaseName(next.commit)))).toBe(false);
  });

  it('asks on a terminal with the preview, and a decline records nothing and leaves the staging for the next update', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host);
    const state = world(runtime);
    const asked: UpdatePreview[] = [];
    const { run, out } = cli(host, state, next, runtime, {
      confirmUpdate: async (preview) => {
        asked.push(preview);
        return false;
      },
    });

    expect(await run(['update', '--id', runtime.instance_id])).toBe(0);

    expect(asked).toHaveLength(1);
    expect(out).toContain('Update cancelled. The assistant is unchanged.');
    expect(await readOperationRecord(host.paths, runtime.instance_id)).toBeUndefined();
    expect(await readlink(runtime.checkout_root)).toBe(releaseName(host.first));
    expect(state.running).toBe(true);
    expect(await exists(layoutOf(host, runtime).receipt(releaseName(next.commit)))).toBe(true);
  });
});

/** Phases an update is killed right after recording, and whether the live link then names a release. */
const PHASES: ReadonlyArray<readonly [OperationPhase, 'first' | 'none' | 'next']> = [
  ['staged', 'first'],
  ['fenced', 'none'],
  ['snapshotted', 'none'],
  ['switched', 'next'],
  ['started', 'next'],
  ['verified', 'next'],
];

describe('an update killed at each phase', GIT_HEAVY, () => {
  it.each(PHASES)(
    'killed once %s is recorded, is reported, refuses conflicting commands, and update finishes it the same',
    async (phase, live) => {
      const host = await machine();
      const runtime = await assistant(host);
      await converse(runtime, 'm1');
      const next = await nextRelease(host, NEW_IMAGE);
      const state = world(runtime);
      const id = runtime.instance_id;

      await killAfter(phase, host, runtime, state, next);

      expect((await readOperationRecord(host.paths, id))?.phase).toBe(phase);
      const pointer = live === 'none' ? undefined : releaseName(live === 'first' ? host.first : next.commit);
      expect(await readlink(runtime.checkout_root).catch(() => undefined)).toBe(pointer);
      expect((await status(host, state, next, runtime)).operation).toMatchObject({
        state: 'open',
        phase,
        continue_with: `gws-ea update --id ${id}`,
        revert_with: `gws-ea rollback --id ${id}`,
      });
      const { run, err } = cli(host, state, next, runtime);
      expect(await run(['start', '--id', id])).toBe(1);
      expect(err.join('\n')).toContain(`Continue it with gws-ea update --id ${id}`);

      expect(await run(['update', '--id', id, '--yes'])).toBe(0);

      await expectUpdated(host, runtime, next, state);
      expect(messages(runtime.state_root)).toEqual(['m1']);
      // It went on from its record: the release was staged once.
      expect(state.setups).toHaveLength(2);
    },
  );

  it('killed once committed with follow-ups left, finishes them on the next update', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host);
    const state = world(runtime);
    state.hangAt = 'rebuild';

    await killDuringUpdate(host, runtime, state, next);

    expect((await readOperationRecord(host.paths, runtime.instance_id))?.phase).toBe('committed');
    delete state.hangAt;
    const { run, out } = cli(host, state, next, runtime);
    expect(await run(['start', '--id', runtime.instance_id])).toBe(0);

    expect(await run(['update', '--id', runtime.instance_id, '--yes'])).toBe(0);

    await expectUpdated(host, runtime, next, state);
    expect(out).toContain(
      `Assistant ${runtime.instance_id} runs dogfood ${next.commit.slice(0, 12)}; its update is finished.`,
    );
  });

  it.each(['stop', 'stamp', 'verify'] as const)(
    'killed mid-step at its %s, finishes the same on the next update',
    async (point) => {
      const host = await machine();
      const runtime = await assistant(host);
      const next = await nextRelease(host);
      const state = world(runtime);
      state.hangAt = point;

      await killDuringUpdate(host, runtime, state, next);

      delete state.hangAt;
      expect(await cli(host, state, next, runtime).run(['update', '--id', runtime.instance_id, '--yes'])).toBe(0);
      await expectUpdated(host, runtime, next, state);
    },
  );

  it.each(['fenced', 'snapshotted'] as const)(
    'cannot start a host after a reboot while fenced (%s): no release is live for the service to run',
    async (phase) => {
      const host = await machine();
      const runtime = await assistant(host);
      const next = await nextRelease(host);
      const state = world(runtime);
      await killAfter(phase, host, runtime, state, next);

      reboot(state, runtime);

      expect(state.loaded).toBe(true);
      expect(state.running).toBe(false);
      // The definition names the launcher through the live link, which is absent while fenced.
      const definition = await readFile(serviceDefinitionFile(runtime), 'utf8');
      expect(definition).toContain(path.join(runtime.checkout_root, 'dist', 'gws-ea', 'process.js'));
      expect(await exists(runtime.checkout_root)).toBe(false);
      // Even run from a release's own folder, the launcher starts nothing that is not the live release.
      const execve = vi.fn<NonNullable<NodeJS.Process['execve']>>();
      await expect(
        launchInstanceHost(
          host.paths.runtimeFile(runtime.instance_id),
          {},
          execve,
          layoutOf(host, runtime).release(releaseName(host.first)),
        ),
      ).rejects.toMatchObject({ code: 'not_live_release' });
      expect(execve).not.toHaveBeenCalled();

      expect(await cli(host, state, next, runtime).run(['update', '--id', runtime.instance_id, '--yes'])).toBe(0);
      await expectUpdated(host, runtime, next, state);
    },
  );

  it('starts a switch resumed after it installed a changed definition from that definition, not the one launchd loaded', async () => {
    const host = await machine();
    const older = '<plist>the definition an older release rendered</plist>\n';
    const runtime = await assistant(host, { serviceDefinition: older });
    const next = await nextRelease(host);
    const state = world(runtime);
    // A login while fenced loads the job from the definition installed then, before the switch replaces it.
    state.onStamp = () => reboot(state, runtime);
    await killAfter('switched', host, runtime, state, next);
    delete state.onStamp;
    expect(state.loadedDefinition).toBe(older);
    const installed = await readFile(serviceDefinitionFile(runtime), 'utf8');
    expect(installed).not.toBe(older);
    state.events.length = 0;

    expect(await cli(host, state, next, runtime).run(['update', '--id', runtime.instance_id, '--yes'])).toBe(0);

    // The fence's stop booted the job out, so the start bootstrapped it from the definition the switch installed.
    expect(state.events).toEqual(['stop', 'start']);
    expect(state.loadedDefinition).toBe(installed);
    await expectUpdated(host, runtime, next, state);
  });
});

describe('an update refused before its release starts', GIT_HEAVY, () => {
  it('serves the release it left again, keeping the staging, when something still holds the state open', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host);
    const state = world(runtime);
    const database = path.join(runtime.state_root, 'data', 'v2.db');
    state.openFiles = `p777\ncsqlite3\nf3\nn${database}\n`;
    const { run, err } = cli(host, state, next, runtime);

    expect(await run(['update', '--id', runtime.instance_id, '--yes'])).toBe(1);

    expect(err.join('\n')).toContain(`sqlite3 (PID 777) holds ${database}`);
    expect(err.join('\n')).toContain(`runs dogfood ${host.first.slice(0, 12)} again`);
    expect(await readlink(runtime.checkout_root)).toBe(releaseName(host.first));
    expect(state.running).toBe(true);
    expect(await readOperationRecord(host.paths, runtime.instance_id)).toBeUndefined();
    expect(await exists(layoutOf(host, runtime).receipt(releaseName(next.commit)))).toBe(true);
    state.openFiles = '';

    expect(await run(['update', '--id', runtime.instance_id, '--yes'])).toBe(0);

    await expectUpdated(host, runtime, next, state);
    expect(state.setups).toHaveLength(2);
  });

  it('probes a gateway the switch recreated before the start, and a failed probe serves the release it left again', async () => {
    const host = await machine();
    const runtime = await assistant(host, { gateway: DEPLOYED_GATEWAY });
    await converse(runtime, 'm1');
    const next = await nextRelease(host);
    const state = world(runtime);
    state.failingGateway = RELEASE_GATEWAY;
    const { run, err } = cli(host, state, next, runtime);

    expect(await run(['update', '--id', runtime.instance_id, '--yes'])).toBe(1);

    // The new gateway was probed before any start, failed, and the old one came back and was probed in turn.
    expect(state.probes).toEqual([RELEASE_GATEWAY, DEPLOYED_GATEWAY]);
    expect(state.events).toEqual(['setup install', 'setup build', 'stop running', 'start']);
    expect(err.join('\n')).toContain(`runs dogfood ${host.first.slice(0, 12)} again`);
    expect(await readlink(runtime.checkout_root)).toBe(releaseName(host.first));
    expect(
      await readFile(layoutOf(host, runtime).kept(releaseName(host.first)) + '/onecli-compose.yaml', 'utf8'),
    ).toContain(DEPLOYED_GATEWAY);
    expect(state.running).toBe(true);
    expect(messages(runtime.state_root)).toEqual(['m1']);
    expect(await readOperationRecord(host.paths, runtime.instance_id)).toBeUndefined();
  });

  it('re-verifies the serving gateway before the fence, and a failure there leaves the assistant serving', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host);
    const state = world(runtime);
    state.reverifyFails = true;

    expect(await cli(host, state, next, runtime).run(['update', '--id', runtime.instance_id, '--yes'])).toBe(1);

    expect(state.reverified).toHaveLength(1);
    expect(state.events).toEqual(['setup install', 'setup build']);
    expect(state.running).toBe(true);
    expect(await readOperationRecord(host.paths, runtime.instance_id)).toBeUndefined();
  });
});

describe('an update that fails once its release started', GIT_HEAVY, () => {
  it('rolls back code only when neither schema moved, keeping what the new release recorded', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    await converse(runtime, 'm1');
    const next = await nextRelease(host);
    const state = world(runtime);
    // The new release's callback route never reaches it, and its host serves one message before it is rolled back.
    state.onStart = (root) => {
      state.routeDown = readlinkSync(root) === releaseName(next.commit);
      if (state.routeDown) void converse(runtime, 'm2');
    };
    const inode = await centralInode(runtime);
    const { run, err } = cli(host, state, next, runtime);

    expect(await run(['update', '--id', runtime.instance_id, '--yes'])).toBe(1);

    expect(err.join('\n')).toContain('so it was rolled back');
    expect(releaseOf(await getInstanceReservation(host.paths, runtime.instance_id))).toEqual(release(host, host.first));
    expect(await readlink(runtime.checkout_root)).toBe(releaseName(host.first));
    expect(await centralInode(runtime)).toBe(inode);
    expect(messages(runtime.state_root)).toEqual(['m1', 'm2']);
    expect(await readOperationRecord(host.paths, runtime.instance_id)).toBeUndefined();
    expect(await readRollbackPoint(host.paths, runtime.instance_id)).toBeUndefined();
  });

  it('restores the snapshot it took when the new release migrated the database, keeping what it replaced', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    await converse(runtime, 'm1');
    const next = await nextRelease(host);
    const state = world(runtime, applying(ADDED_MIGRATION));
    // The new release migrates the live database as its host starts, serves one message, and is never reached.
    state.onStart = (root) => {
      state.routeDown = readlinkSync(root) === releaseName(next.commit);
      if (!state.routeDown) return;
      applying(ADDED_MIGRATION)(path.join(runtime.state_root, 'data', 'v2.db'));
      void converse(runtime, 'm2');
    };
    const { run, err } = cli(host, state, next, runtime);

    expect(await run(['update', '--id', runtime.instance_id, '--yes'])).toBe(1);

    expect(err.join('\n')).toContain('so it was rolled back');
    expect(readCentralMigrations(runtime.state_root)).toEqual([...LIVE_MIGRATIONS]);
    expect(messages(runtime.state_root)).toEqual(['m1']);
    const quarantine = path.join(layoutOf(host, runtime).root, 'quarantine');
    const [kept] = await readdir(quarantine);
    expect(readCentralMigrations(path.join(quarantine, kept!))).toEqual([...LIVE_MIGRATIONS, ADDED_MIGRATION]);
    expect(await readlink(runtime.checkout_root)).toBe(releaseName(host.first));
    expect(state.running).toBe(true);
  });

  it('closes for fix-forward when rolling back fails too, and a newer release supersedes it', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host);
    const state = world(runtime);
    // Nothing serves: neither the new release nor the one it left.
    state.routeDown = true;
    const id = runtime.instance_id;
    const { run, err } = cli(host, state, next, runtime);

    expect(await run(['update', '--id', id, '--yes'])).toBe(1);

    expect(err.join('\n')).toContain('rolling it back failed too');
    expect(await readOperationRecord(host.paths, id)).toMatchObject({ closed: 'failed' });
    expect((await status(host, state, next, runtime)).operation).toMatchObject({ state: 'failed' });
    err.length = 0;
    expect(await run(['update', '--id', id, '--yes'])).toBe(1);
    expect(err.join('\n')).toContain(`Fix it forward: update it to a newer release with gws-ea update --id ${id}`);
    expect(await run(['rollback', '--id', id, '--yes'])).toBe(1);
    const newer = await nextRelease(host);
    delete state.routeDown;

    expect(await cli(host, state, newer, runtime).run(['update', '--id', id, '--yes'])).toBe(0);

    expect(releaseOf(await getInstanceReservation(host.paths, id))).toEqual(release(host, newer.commit));
    expect(await readlink(runtime.checkout_root)).toBe(releaseName(newer.commit));
    expect(await readOperationRecord(host.paths, id)).toBeUndefined();
    // A superseding update has no release to return to, so it leaves no rollback point.
    expect(await readRollbackPoint(host.paths, id)).toBeUndefined();
  });
});

describe('the update preview', () => {
  it('shows the group names an agent chose with their control characters escaped', () => {
    // A group named with an OSC 52 clipboard write.
    const group = 'research\u001b]52;c;cHduZWQ=\u0007';
    const coordinates = (commit: string): ReleaseCoordinates => ({
      source_remote: 'https://example.test/nanoclaw.git',
      release_track: 'dogfood',
      deployed_commit: commit.repeat(40),
    });
    const preview: UpdatePreview = {
      instanceId: '00000000-0000-4000-8000-000000000000',
      from: coordinates('a'),
      to: coordinates('b'),
      migrations: [],
      gateway: { current: DEPLOYED_GATEWAY, release: DEPLOYED_GATEWAY },
      groupImages: [{ id: 'ag-research', name: group }],
      agentRunnerLockChanged: true,
      sessionSchemaChanged: false,
    };

    const lines = updatePreviewLines(preview);

    for (const line of lines) expect(line).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    const shown = 'research\\u001b]52;c;cHduZWQ=\\u0007 (ag-research)';
    expect(lines).toContain(`Agent group images rebuilt after the update: ${shown}`);
    expect(lines).toContain(
      `Until rebuilt, ${shown} run the previous agent-runner dependencies, so their first turns may fail and retry.`,
    );
  });
});

describe("the dry run of a release's migrations", () => {
  /** The assistant's state with the host's closed database, and a staged release beside it, before its links. */
  async function instance() {
    const root = await temporaryRoot('gws-ea-dry-run-');
    const state = path.join(root, 'state');
    const staged = path.join(root, '0123abcd');
    await mkdir(path.join(state, 'data'), { recursive: true });
    await mkdir(staged, { recursive: true, mode: 0o700 });
    const database = new Database(path.join(state, 'data', 'v2.db'));
    try {
      database.pragma('journal_mode = WAL');
      database.exec(
        'CREATE TABLE schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied TEXT NOT NULL)',
      );
      LIVE_MIGRATIONS.forEach((name, index) =>
        database
          .prepare('INSERT INTO schema_version VALUES (?, ?, ?)')
          .run(index + 1, name, '2026-09-01T00:00:00.000Z'),
      );
    } finally {
      database.close();
    }
    return { root, state, staged };
  }

  /** The release's migration script, standing in: it records where it ran and what the database held, then migrates it. */
  function migrationScript(seen: Array<{ cwd: string; migrations: readonly string[] }>): SanitizedCommandRunner {
    return async (spec) => {
      if (spec.command !== 'pnpm' || spec.args.join(' ') !== 'run migrate') throw new Error('unexpected command');
      seen.push({ cwd: spec.cwd, migrations: readCentralMigrations(spec.cwd) });
      applying(ADDED_MIGRATION)(path.join(spec.cwd, 'data', 'v2.db'));
      return { stdout: '', stderr: '' };
    };
  }

  it('runs on a copy in a scratch data/ of the release, removed after, leaving the live state as it was', async () => {
    const { root, state, staged } = await instance();
    const before = await snapshot(root);
    const seen: Array<{ cwd: string; migrations: readonly string[] }> = [];

    await expect(
      dryRunReleaseMigrations(
        { liveState: state, liveMigrations: LIVE_MIGRATIONS, stagedRelease: staged },
        migrationScript(seen),
        {},
      ),
    ).resolves.toEqual([ADDED_MIGRATION]);

    // The script ran from the release, on a copy holding everything the live database records.
    expect(seen).toEqual([{ cwd: staged, migrations: [...LIVE_MIGRATIONS] }]);
    expect(readCentralMigrations(state)).toEqual([...LIVE_MIGRATIONS]);
    // Nothing is left where the release's links go, and nothing else changed.
    expect(await snapshot(root)).toEqual(before);
  });

  it.each([
    ["the release's data is a link to the live data", 'data'],
    ['the release is a link to a directory elsewhere', 'elsewhere'],
  ] as const)('refuses before running or writing anything when %s', async (_label, linked) => {
    const { root, state, staged } = await instance();
    const elsewhere = path.join(root, 'elsewhere');
    await mkdir(elsewhere);
    if (linked === 'data') await symlink(path.join(state, 'data'), path.join(staged, 'data'));
    else {
      await rm(staged, { recursive: true });
      await symlink(elsewhere, staged);
    }
    const resolved = path.join(linked === 'elsewhere' ? elsewhere : state, 'data', 'v2.db');
    const before = await snapshot(root);
    const seen: Array<{ cwd: string; migrations: readonly string[] }> = [];

    await expect(
      dryRunReleaseMigrations(
        { liveState: state, liveMigrations: LIVE_MIGRATIONS, stagedRelease: staged },
        migrationScript(seen),
        {},
      ),
    ).rejects.toMatchObject({
      code: 'unsafe_dry_run',
      message: expect.stringContaining(`would run against ${resolved}`),
    });

    expect(seen).toEqual([]);
    expect(await snapshot(root)).toEqual(before);
  });

  it('refuses before running when the release already holds a database where the copy goes', async () => {
    const { state, staged } = await instance();
    await mkdir(path.join(staged, 'data'));
    await writeFile(path.join(staged, 'data', 'v2.db'), 'a database the release shipped\n');
    const seen: Array<{ cwd: string; migrations: readonly string[] }> = [];

    await expect(
      dryRunReleaseMigrations(
        { liveState: state, liveMigrations: LIVE_MIGRATIONS, stagedRelease: staged },
        migrationScript(seen),
        {},
      ),
    ).rejects.toMatchObject({ code: 'unsafe_dry_run', message: expect.stringContaining('already holds a database') });

    expect(seen).toEqual([]);
    expect(await readFile(path.join(staged, 'data', 'v2.db'), 'utf8')).toBe('a database the release shipped\n');
  });

  it('refuses when the live migrations changed while the dry run ran', async () => {
    const { state, staged } = await instance();
    const runLive: SanitizedCommandRunner = async () => {
      applying(ADDED_MIGRATION)(path.join(state, 'data', 'v2.db'));
      return { stdout: '', stderr: '' };
    };

    await expect(
      dryRunReleaseMigrations(
        { liveState: state, liveMigrations: LIVE_MIGRATIONS, stagedRelease: staged },
        runLive,
        {},
      ),
    ).rejects.toMatchObject({ code: 'live_schema_changed' });
    expect(await exists(path.join(staged, 'data'))).toBe(false);
  });
});

describe('the update gate', GIT_HEAVY, () => {
  it('refuses another update while one to a different release is unfinished, naming what continues it', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host);
    const state = world(runtime);
    await killAfter('fenced', host, runtime, state, next);
    const newer = await nextRelease(host);
    const { run, err } = cli(host, state, newer, runtime);

    expect(await run(['update', '--id', runtime.instance_id, '--yes'])).toBe(1);

    expect(err.join('\n')).toContain(`Continue it with gws-ea update --id ${runtime.instance_id} from the gws-ea at`);
    expect((await readOperationRecord(host.paths, runtime.instance_id))?.to).toEqual(release(host, next.commit));
  });

  it('discards an update whose release had not started when rollback --id reverts it, serving the release it left', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host);
    const state = world(runtime);
    await killAfter('snapshotted', host, runtime, state, next);
    const { run, out } = cli(host, state, next, runtime);

    expect(await run(['rollback', '--id', runtime.instance_id])).toBe(0);

    expect(out.join('\n')).toContain(`dogfood ${host.first.slice(0, 12)}`);
    expect(await readlink(runtime.checkout_root)).toBe(releaseName(host.first));
    expect(state.running).toBe(true);
    expect(await readOperationRecord(host.paths, runtime.instance_id)).toBeUndefined();
    expect(await exists(layoutOf(host, runtime).receipt(releaseName(next.commit)))).toBe(true);
  });
});

describe('the switch', GIT_HEAVY, () => {
  it('has systemd read the service definition before every start, a resumed switch that finds it installed included', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host);
    const state = world(runtime);
    const deps: UpdateDependencies = {
      ...dependencies(state, next, runtime),
      service: { ...SERVICE, platform: 'linux' },
    };
    await stage(host, runtime, deps);
    const operation = await acquireInstanceOperation(host.paths, runtime.instance_id);
    if (!operation) throw new Error('The test instance operation was busy');
    try {
      const switching = await openCutoverHost(operation, deps);
      expect(await switchTo(switching, release(host, next.commit), 'Switching…')).toBe(true);
      const resumed = state.commands.length;

      // Resumed after it installed the definition: unchanged now, and systemd is still told to read it.
      expect(await switchTo(switching, release(host, next.commit), 'Switching…')).toBe(false);

      const reloads = state.commands.slice(resumed).filter((command) => command.command === 'systemctl');
      expect(reloads.map((command) => command.args)).toEqual([['--user', 'daemon-reload']]);
      expect(await readlink(runtime.checkout_root)).toBe(releaseName(next.commit));
    } finally {
      operation.release();
    }
  });
});
