/**
 * `rollback` returns an assistant, built and updated as the fixture's world
 * leaves it, to its rollback point: code only when no schema moved, the
 * snapshot its update took once a shown discard is confirmed when one did.
 * The switch moves no state; a snapshot restore quarantines the state it
 * replaces and hands the host every person forgotten since the snapshot. Git,
 * tar, SQLite, and the files are real; the service manager, Docker and
 * OneCLI, `ps`, `lsof`, the release's scripts, the host's status and
 * listener, and `ncl` are faked at their boundaries (see
 * `testing/cutover-fixture.ts`).
 */
import { mkdirSync, readlinkSync, writeFileSync } from 'node:fs';
import { readdir, readFile, readlink, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { peopleForgetHandoffFile, readPeopleForgetHandoff } from '../modules/gws-ea-people/forget-handoff.js';
import {
  ADDED_MIGRATION,
  applying,
  assistant,
  cli,
  converse,
  dependencies,
  exists,
  imageBase,
  killDuringUpdate,
  layoutOf,
  LIVE_MIGRATIONS,
  machine,
  MAIN_SKILLS,
  MEMORY,
  messages,
  NEW_IMAGE,
  nextRelease,
  release,
  releaseTag,
  removeTemporaryRoots,
  repositoryImages,
  SESSION,
  status,
  temporaryRoot,
  world,
  type Machine,
  type Release,
  type World,
} from './testing/cutover-fixture.js';
import { acquireInstanceOperation } from './journal.js';
import { readOperationRecord, readRollbackPoint, type OperationPhase } from './operation.js';
import { getInstanceReservation } from './registry.js';
import { releaseName } from './release-layout.js';
import { rollBack, rollbackPreviewLines, summarizeDiscard, type RollbackPreview } from './rollback.js';
import type { InstanceRuntimeConfig } from './service.js';
import { releaseOf } from './types.js';
import { readCentralMigrations } from './verify.js';

/**
 * Kill the process once the operation record is written at `phase`, or just
 * before it is written at `before`, as a crash then would.
 */
const records = vi.hoisted(() => ({
  killAfter: undefined as string | undefined,
  killBefore: undefined as string | undefined,
  killReturning: false,
  reached: undefined as (() => void) | undefined,
}));
vi.mock('../community-portal/private-file.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../community-portal/private-file.js')>();
  const writePrivate: typeof actual.writePrivate = async (file, value) => {
    const phase = typeof value === 'object' && value !== null && 'phase' in value ? value.phase : undefined;
    const record = file.endsWith('/operation.json') && phase !== undefined;
    if (record && phase === records.killBefore) {
      records.killBefore = undefined;
      records.reached?.();
      await new Promise(() => undefined);
    }
    await actual.writePrivate(file, value);
    const returning =
      record && typeof value === 'object' && value !== null && 'returning' in value && value.returning === true;
    if ((record && phase === records.killAfter) || (returning && records.killReturning)) {
      records.killAfter = undefined;
      records.killReturning = false;
      records.reached?.();
      await new Promise(() => undefined);
    }
  };
  return { ...actual, writePrivate };
});

afterEach(removeTemporaryRoots);
afterEach(() => {
  records.killAfter = undefined;
  records.killBefore = undefined;
  records.killReturning = false;
});

/** Each case stages and switches real Git releases twice, which a loaded machine slows. */
const GIT_HEAVY = { timeout: 90_000 } as const;

/** An assistant created at the machine's first release, holding message `m1`, then updated to the next release. */
async function updatedAssistant(
  files: Readonly<Record<string, string>> = {},
  migrate = applying(),
): Promise<{ host: Machine; runtime: InstanceRuntimeConfig; next: Release; state: World }> {
  const host = await machine();
  const runtime = await assistant(host);
  await converse(runtime, 'm1');
  const next = await nextRelease(host, { ...NEW_IMAGE, ...files });
  const state = world(runtime, migrate);
  expect(await cli(host, state, next, runtime).run(['update', '--id', runtime.instance_id, '--yes'])).toBe(0);
  return { host, runtime, next, state };
}

/** Have the release the update deployed migrate the live database and serve a message, as its host does. */
function migratedByNext(runtime: InstanceRuntimeConfig, ...served: readonly string[]): void {
  applying(ADDED_MIGRATION)(path.join(runtime.state_root, 'data', 'v2.db'));
  if (served.length > 0) void converse(runtime, ...served);
}

/** The inode of the central database, which a code-only rollback never moves. */
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

/**
 * The assistant once a rollback from `next` to the machine's first release is
 * committed and finished: the registry and the live link name the first
 * release again, there is nothing left to roll back to, and everything only
 * `next` used is pruned.
 */
async function expectRolledBack(host: Machine, runtime: InstanceRuntimeConfig, next: Release, state: World) {
  const id = runtime.instance_id;
  const layout = layoutOf(host, runtime);
  expect(releaseOf(await getInstanceReservation(host.paths, id))).toEqual(release(host, host.first));
  expect(await readlink(runtime.checkout_root)).toBe(releaseName(host.first));
  expect(JSON.parse(await readFile(path.join(runtime.state_root, 'data', 'upgrade-state.json'), 'utf8'))).toEqual({
    commit: host.first,
    via: 'gws-ea',
  });
  expect(await readRollbackPoint(host.paths, id)).toBeUndefined();
  expect(await readOperationRecord(host.paths, id)).toBeUndefined();
  expect(await exists(layout.release(releaseName(next.commit)))).toBe(false);
  expect(await exists(layout.kept(releaseName(next.commit)))).toBe(false);
  expect(state.tags.has(releaseTag(runtime, next.commit))).toBe(false);
  expect(await readdir(path.join(layout.root, 'snapshots')).catch(() => [])).toEqual([]);
  expect(repositoryImages(state, imageBase(runtime)).untagged).toEqual([]);
  expect(state.running).toBe(true);
}

describe('gws-ea rollback when no schema moved', GIT_HEAVY, () => {
  it('moves only the live link: every message since the update is kept, and main gets its own skills back', async () => {
    const { host, runtime, next, state } = await updatedAssistant({
      [MAIN_SKILLS]: `${JSON.stringify(['agent-browser', 'gmail'])}\n`,
    });
    await converse(runtime, 'm2');
    expect(mainSkills(runtime)).toEqual(['agent-browser', 'gmail']);
    const inode = await centralInode(runtime);
    const { run, out } = cli(host, state, next, runtime);

    expect(await run(['rollback', '--id', runtime.instance_id])).toBe(0);

    await expectRolledBack(host, runtime, next, state);
    expect(await centralInode(runtime)).toBe(inode);
    expect(messages(runtime.state_root)).toEqual(['m1', 'm2']);
    expect(await readFile(path.join(runtime.checkout_root, MEMORY), 'utf8')).toContain('mornings');
    expect(mainSkills(runtime)).toEqual(['agent-browser']);
    expect(await exists(path.join(layoutOf(host, runtime).root, 'quarantine'))).toBe(false);
    expect(out).toContain(`Assistant ${runtime.instance_id} was rolled back to dogfood ${host.first.slice(0, 12)}.`);
    expect(out).toContain(
      'Only its code went back: every conversation, memory, and setting since the update was kept.',
    );
  });

  it('refuses an assistant that keeps no rollback point, changing nothing', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host);
    const state = world(runtime);
    const { run, err } = cli(host, state, next, runtime);

    expect(await run(['rollback', '--id', runtime.instance_id])).toBe(1);

    expect(err.join('\n')).toContain('keeps no rollback point, so there is nothing to roll back to');
    expect(state.events).toEqual([]);
  });

  it('goes back to the release it left, serving, when something holds its state open at the fence', async () => {
    const { host, runtime, next, state } = await updatedAssistant();
    const database = path.join(runtime.state_root, 'data', 'v2.db');
    state.openFiles = `p777\ncsqlite3\nf3\nn${database}\n`;
    const { run, err } = cli(host, state, next, runtime);

    expect(await run(['rollback', '--id', runtime.instance_id])).toBe(1);

    expect(err.join('\n')).toContain(`went back: the assistant runs dogfood ${next.commit.slice(0, 12)} again`);
    expect(await readlink(runtime.checkout_root)).toBe(releaseName(next.commit));
    expect(state.running).toBe(true);
    expect(await readOperationRecord(host.paths, runtime.instance_id)).toBeUndefined();
    expect((await readRollbackPoint(host.paths, runtime.instance_id))?.release).toEqual(release(host, host.first));
  });

  it("rebuilds the release's agent image when it is gone, before it stops anything", async () => {
    const { host, runtime, next, state } = await updatedAssistant();
    const gone = state.tags.get(releaseTag(runtime, host.first))!;
    state.tags.delete(releaseTag(runtime, host.first));
    state.ids.delete(gone);
    const events = state.events.length;

    expect(await cli(host, state, next, runtime).run(['rollback', '--id', runtime.instance_id])).toBe(0);

    expect(state.events.slice(events)).toEqual(['build', 'stop running', 'start']);
    expect(state.tags.has(releaseTag(runtime, host.first))).toBe(true);
    await expectRolledBack(host, runtime, next, state);
  });
});

describe('gws-ea rollback when a schema moved', GIT_HEAVY, () => {
  /** An assistant whose update migrated the database and served `m2` on the new release. */
  async function migrated() {
    const updated = await updatedAssistant();
    migratedByNext(updated.runtime, 'm2');
    return updated;
  }

  it('shows the snapshot time and what it discards, and refuses without --yes when nobody can be asked', async () => {
    const { host, runtime, next, state } = await migrated();
    const events = state.events.length;
    const { run, out, err } = cli(host, state, next, runtime);

    expect(await run(['rollback', '--id', runtime.instance_id])).toBe(1);

    const printed = out.join('\n');
    expect(printed).toMatch(/Restores the snapshot taken .*, because the update migrated the central database\./u);
    expect(printed).toContain('Inbound messages lost: 1 (m2)');
    expect(printed).toContain('Central rows added since: schema_version 1');
    expect(printed).toContain(`kept in ${path.join(layoutOf(host, runtime).root, 'quarantine')}`);
    expect(err.join('\n')).toContain('needs confirmation: pass --yes');
    // Nothing changed: the assistant was never stopped, and no record was written.
    expect(state.events.slice(events)).toEqual([]);
    expect(state.running).toBe(true);
    expect(await readOperationRecord(host.paths, runtime.instance_id)).toBeUndefined();
    expect(await readlink(runtime.checkout_root)).toBe(releaseName(next.commit));
  });

  it('serves the release it would leave again when the restore is declined', async () => {
    const { host, runtime, next, state } = await migrated();
    const shown: RollbackPreview[] = [];
    const { run, out } = cli(host, state, next, runtime, {
      confirmRollback: async (preview) => {
        shown.push(preview);
        return false;
      },
    });

    expect(await run(['rollback', '--id', runtime.instance_id])).toBe(0);

    expect(shown).toHaveLength(1);
    expect(out).toContain(
      `Rollback cancelled. Assistant ${runtime.instance_id} stays on dogfood ${next.commit.slice(0, 12)} as before.`,
    );
    expect(await readlink(runtime.checkout_root)).toBe(releaseName(next.commit));
    expect(messages(runtime.state_root)).toEqual(['m1', 'm2']);
    expect(readCentralMigrations(runtime.state_root)).toEqual([...LIVE_MIGRATIONS, ADDED_MIGRATION]);
    expect(state.running).toBe(true);
    expect(await readOperationRecord(host.paths, runtime.instance_id)).toBeUndefined();
    expect((await readRollbackPoint(host.paths, runtime.instance_id))?.release).toEqual(release(host, host.first));
  });

  it('restores the snapshot once confirmed, keeping the state it replaced in quarantine', async () => {
    const { host, runtime, next, state } = await migrated();
    const { run, out } = cli(host, state, next, runtime);

    expect(await run(['rollback', '--id', runtime.instance_id, '--yes'])).toBe(0);

    await expectRolledBack(host, runtime, next, state);
    expect(readCentralMigrations(runtime.state_root)).toEqual([...LIVE_MIGRATIONS]);
    expect(messages(runtime.state_root)).toEqual(['m1']);
    const quarantine = path.join(layoutOf(host, runtime).root, 'quarantine');
    const [kept] = await readdir(quarantine);
    expect(messages(path.join(quarantine, kept!))).toEqual(['m1', 'm2']);
    expect(out.join('\n')).toContain(`is kept in ${path.join(quarantine, kept!)}`);
    // Its receipt records what it discarded, kept with the release it returned to.
    const receipt = JSON.parse(
      await readFile(path.join(layoutOf(host, runtime).kept(releaseName(host.first)), 'rollback.json'), 'utf8'),
    ) as { mode: string; discarded: { inbound: { ids: string[] } } };
    expect(receipt.mode).toBe('snapshot');
    expect(receipt.discarded.inbound.ids).toEqual(['m2']);
  });

  it('goes back to the release it left with the state it had when the restored release fails its checks', async () => {
    const { host, runtime, next, state } = await migrated();
    // The release it returns to never answers on its callback route.
    state.onStart = (root) => {
      state.routeDown = readlinkSync(root) === releaseName(host.first);
      if (state.routeDown) void converse(runtime, 'written-by-the-restored-release');
    };
    const { run, err } = cli(host, state, next, runtime);

    expect(await run(['rollback', '--id', runtime.instance_id, '--yes'])).toBe(1);

    expect(err.join('\n')).toContain(`went back: the assistant runs dogfood ${next.commit.slice(0, 12)} again`);
    expect(await readlink(runtime.checkout_root)).toBe(releaseName(next.commit));
    expect(readCentralMigrations(runtime.state_root)).toEqual([...LIVE_MIGRATIONS, ADDED_MIGRATION]);
    expect(messages(runtime.state_root)).toEqual(['m1', 'm2']);
    const quarantine = path.join(layoutOf(host, runtime).root, 'quarantine');
    const [returned] = await readdir(quarantine);
    expect(returned).toMatch(/-returned$/u);
    expect(messages(path.join(quarantine, returned!))).toEqual(['m1', 'written-by-the-restored-release']);
    expect(state.running).toBe(true);
    expect(await readOperationRecord(host.paths, runtime.instance_id)).toBeUndefined();
    expect((await readRollbackPoint(host.paths, runtime.instance_id))?.release).toEqual(release(host, host.first));
  });

  it('closes for fix-forward when going back fails too, and a newer update supersedes it', async () => {
    const { host, runtime, next, state } = await migrated();
    // Neither release answers on its callback route.
    state.routeDown = true;
    const id = runtime.instance_id;
    const { run, err } = cli(host, state, next, runtime);

    expect(await run(['rollback', '--id', id, '--yes'])).toBe(1);

    expect(err.join('\n')).toContain(`Fix it forward: update it to a newer release with gws-ea update --id ${id}`);
    expect(await readOperationRecord(host.paths, id)).toMatchObject({ closed: 'failed', kind: 'rollback' });
    expect((await status(host, state, next, runtime)).operation).toMatchObject({ state: 'failed' });
    expect(await run(['rollback', '--id', id, '--yes'])).toBe(1);
    expect(await run(['start', '--id', id])).toBe(1);
    const newer = await nextRelease(host);
    delete state.routeDown;

    expect(await cli(host, state, newer, runtime).run(['update', '--id', id, '--yes'])).toBe(0);

    expect(releaseOf(await getInstanceReservation(host.paths, id))).toEqual(release(host, newer.commit));
    expect(await readlink(runtime.checkout_root)).toBe(releaseName(newer.commit));
    expect(await readOperationRecord(host.paths, id)).toBeUndefined();
  });
});

describe('a person forgotten after the snapshot (KTD8)', GIT_HEAVY, () => {
  const FORGOTTEN = { fingerprint: 'f'.repeat(64), forgotten_at: '2026-10-08T09:00:00.000Z' };

  /** Record the fingerprints of identities forgotten in the central database under `stateRoot`. */
  function forget(stateRoot: string, ...rows: ReadonlyArray<typeof FORGOTTEN>): void {
    const database = new Database(path.join(stateRoot, 'data', 'v2.db'));
    try {
      database.exec(
        'CREATE TABLE IF NOT EXISTS gws_ea_people_fingerprints (fingerprint TEXT PRIMARY KEY, forgotten_at TEXT NOT NULL)',
      );
      for (const row of rows) {
        database.prepare('INSERT INTO gws_ea_people_fingerprints VALUES (?, ?)').run(row.fingerprint, row.forgotten_at);
      }
    } finally {
      database.close();
    }
  }

  it('is handed to the host to forget again when a rollback restores a snapshot from before the forget', async () => {
    const { host, runtime, next, state } = await updatedAssistant();
    // Forgotten after the snapshot, on the new release.
    migratedByNext(runtime);
    forget(runtime.state_root, FORGOTTEN);

    expect(await cli(host, state, next, runtime).run(['rollback', '--id', runtime.instance_id, '--yes'])).toBe(0);

    const handoff = await readPeopleForgetHandoff(peopleForgetHandoffFile(path.join(runtime.state_root, 'data')));
    expect(handoff).toEqual({ fingerprints: [FORGOTTEN] });
    const file = await stat(peopleForgetHandoffFile(path.join(runtime.state_root, 'data')));
    expect(file.mode & 0o777).toBe(0o600);
  });

  it('hands nothing over for an identity the restored state already forgot', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    forget(runtime.state_root, FORGOTTEN);
    const next = await nextRelease(host, NEW_IMAGE);
    const state = world(runtime);
    expect(await cli(host, state, next, runtime).run(['update', '--id', runtime.instance_id, '--yes'])).toBe(0);
    migratedByNext(runtime);

    expect(await cli(host, state, next, runtime).run(['rollback', '--id', runtime.instance_id, '--yes'])).toBe(0);

    expect(
      await readPeopleForgetHandoff(peopleForgetHandoffFile(path.join(runtime.state_root, 'data'))),
    ).toBeUndefined();
  });

  it('hands nothing over for an identity forgotten after the snapshot and added back by the principal since', async () => {
    const { host, runtime, next, state } = await updatedAssistant();
    migratedByNext(runtime);
    forget(runtime.state_root, FORGOTTEN);
    // Adding the identity back clears its fingerprint, so the state the restore replaces holds none.
    const database = new Database(path.join(runtime.state_root, 'data', 'v2.db'));
    try {
      database.prepare('DELETE FROM gws_ea_people_fingerprints WHERE fingerprint = ?').run(FORGOTTEN.fingerprint);
    } finally {
      database.close();
    }

    expect(await cli(host, state, next, runtime).run(['rollback', '--id', runtime.instance_id, '--yes'])).toBe(0);

    expect(
      await readPeopleForgetHandoff(peopleForgetHandoffFile(path.join(runtime.state_root, 'data'))),
    ).toBeUndefined();
  });

  it('is handed over again by a rollback resumed after its restore, before the record moved on', async () => {
    const { host, runtime, next, state } = await updatedAssistant();
    migratedByNext(runtime);
    forget(runtime.state_root, FORGOTTEN);
    const handoff = peopleForgetHandoffFile(path.join(runtime.state_root, 'data'));
    await killRollback(host, runtime, state, next, { before: 'snapshotted' });
    // Killed between the restore and the handoff's write: the restored state holds no handoff yet.
    await rm(handoff, { force: true });

    expect(await cli(host, state, next, runtime).run(['rollback', '--id', runtime.instance_id, '--yes'])).toBe(0);

    expect(await readPeopleForgetHandoff(handoff)).toEqual({ fingerprints: [FORGOTTEN] });
    expect(readCentralMigrations(runtime.state_root)).toEqual([...LIVE_MIGRATIONS]);
  });
});

/**
 * Run a rollback with `--yes` and kill it once its record is written at
 * `after`, or just before it is written at `before`, or at `state.hangAt`.
 */
async function killRollback(
  host: Machine,
  runtime: InstanceRuntimeConfig,
  state: World,
  next: Release,
  at: { readonly after?: OperationPhase; readonly before?: OperationPhase },
): Promise<void> {
  records.killAfter = at.after;
  records.killBefore = at.before;
  const reached = new Promise<'killed'>((resolve) => (records.reached = () => resolve('killed')));
  state.reached = () => records.reached?.();
  const operation = await acquireInstanceOperation(host.paths, runtime.instance_id, { command: 'rollback' });
  if (!operation) throw new Error('The test instance operation was busy');
  const run = rollBack(operation, dependencies(state, next, runtime), {
    present: () => undefined,
    confirm: async () => true,
  }).then(() => 'finished' as const);
  expect(await Promise.race([reached, run])).toBe('killed');
  operation.release();
}

const PHASES: ReadonlyArray<readonly [OperationPhase, 'code_only' | 'snapshot']> = [
  ['staged', 'code_only'],
  ['fenced', 'snapshot'],
  ['snapshotted', 'snapshot'],
  ['switched', 'code_only'],
  ['started', 'snapshot'],
  ['verified', 'code_only'],
];

describe('a rollback killed at each phase', GIT_HEAVY, () => {
  it.each(PHASES)('killed once %s is recorded (%s), is finished the same by rollback --id', async (phase, mode) => {
    const { host, runtime, next, state } = await updatedAssistant();
    if (mode === 'snapshot') migratedByNext(runtime, 'm2');
    await killRollback(host, runtime, state, next, { after: phase });
    expect((await readOperationRecord(host.paths, runtime.instance_id))?.phase).toBe(phase);
    const { run, err } = cli(host, state, next, runtime);
    expect(await run(['start', '--id', runtime.instance_id])).toBe(1);
    expect(err.join('\n')).toContain(`Continue it with gws-ea rollback --id ${runtime.instance_id}`);

    expect(await run(['rollback', '--id', runtime.instance_id, '--yes'])).toBe(0);

    await expectRolledBack(host, runtime, next, state);
    expect(messages(runtime.state_root)).toEqual(['m1']);
    expect(readCentralMigrations(runtime.state_root)).toEqual([...LIVE_MIGRATIONS]);
  });

  it('killed while going back, finishes going back on the next rollback --id', async () => {
    const { host, runtime, next, state } = await updatedAssistant();
    migratedByNext(runtime, 'm2');
    // The release it returns to never answers on its callback route, so the rollback goes back.
    state.onStart = (root) => {
      state.routeDown = readlinkSync(root) === releaseName(host.first);
    };
    records.killReturning = true;
    await killRollback(host, runtime, state, next, {});
    expect(await readOperationRecord(host.paths, runtime.instance_id)).toMatchObject({ returning: true });
    const { run, err } = cli(host, state, next, runtime);

    expect(await run(['rollback', '--id', runtime.instance_id, '--yes'])).toBe(1);

    expect(err.join('\n')).toContain(
      `An earlier attempt failed. The rollback to dogfood ${host.first.slice(0, 12)} went back: the assistant runs dogfood ${next.commit.slice(0, 12)} again.`,
    );
    expect(await readlink(runtime.checkout_root)).toBe(releaseName(next.commit));
    expect(readCentralMigrations(runtime.state_root)).toEqual([...LIVE_MIGRATIONS, ADDED_MIGRATION]);
    expect(messages(runtime.state_root)).toEqual(['m1', 'm2']);
    expect(await readOperationRecord(host.paths, runtime.instance_id)).toBeUndefined();
    expect(state.running).toBe(true);
  });
});

describe('gws-ea rollback of an update that is unfinished', GIT_HEAVY, () => {
  it('reverts an update whose release started, from the snapshot it took, committing by its own record', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    await converse(runtime, 'm1');
    const next = await nextRelease(host, NEW_IMAGE);
    const state = world(runtime);
    records.killAfter = 'started';
    records.reached = () => state.reached?.();
    await killDuringUpdate(host, runtime, state, next);
    expect((await readOperationRecord(host.paths, runtime.instance_id))?.phase).toBe('started');
    const { run } = cli(host, state, next, runtime);

    expect(await run(['rollback', '--id', runtime.instance_id, '--yes'])).toBe(0);

    expect(releaseOf(await getInstanceReservation(host.paths, runtime.instance_id))).toEqual(release(host, host.first));
    expect(await readlink(runtime.checkout_root)).toBe(releaseName(host.first));
    expect(messages(runtime.state_root)).toEqual(['m1']);
    expect(await readOperationRecord(host.paths, runtime.instance_id)).toBeUndefined();
    expect(state.running).toBe(true);
  });

  it('takes over a committed update whose follow-ups failed, and gives them back when the rollback is declined', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host, NEW_IMAGE);
    const state = world(runtime);
    state.rebuildFails = true;
    expect(await cli(host, state, next, runtime).run(['update', '--id', runtime.instance_id, '--yes'])).toBe(1);
    const pending = (await readOperationRecord(host.paths, runtime.instance_id))?.follow_ups;
    expect(pending).toContainEqual({ kind: 'rebuild_group_image', agent_group_id: 'ag-research' });
    migratedByNext(runtime);
    const { run } = cli(host, state, next, runtime, { confirmRollback: async () => false });

    expect(await run(['rollback', '--id', runtime.instance_id])).toBe(0);

    expect(await readOperationRecord(host.paths, runtime.instance_id)).toMatchObject({
      kind: 'update',
      phase: 'committed',
      to: release(host, next.commit),
      follow_ups: pending,
    });
    delete state.rebuildFails;

    expect(await cli(host, state, next, runtime).run(['rollback', '--id', runtime.instance_id, '--yes'])).toBe(0);

    await expectRolledBack(host, runtime, next, state);
  });
});

describe('rollback isolation', GIT_HEAVY, () => {
  it("rolls one assistant back without touching another's files, registry entry, or the image they share", async () => {
    const host = await machine();
    const a = await assistant(host);
    const b = await assistant(host, { port: 38_001 });
    const next = await nextRelease(host, NEW_IMAGE);
    const state = world(a);
    state.tags.set(releaseTag(b, host.first), state.tags.get(releaseTag(a, host.first))!);
    state.tags.set(`${imageBase(b)}:ag-research`, state.tags.get(`${imageBase(a)}:ag-research`)!);
    for (const runtime of [a, b]) {
      expect(await cli(host, state, next, runtime).run(['update', '--id', runtime.instance_id, '--yes'])).toBe(0);
    }
    const shared = state.tags.get(releaseTag(a, next.commit))!;
    expect(state.tags.get(releaseTag(b, next.commit))).toBe(shared);
    const bRoot = host.paths.instanceRoot(b.instance_id);
    const before = await readdir(bRoot, { recursive: true });

    expect(await cli(host, state, next, a).run(['rollback', '--id', a.instance_id])).toBe(0);

    expect(await readlink(a.checkout_root)).toBe(releaseName(host.first));
    expect(await readlink(b.checkout_root)).toBe(releaseName(next.commit));
    expect(await readdir(bRoot, { recursive: true })).toEqual(before);
    expect(releaseOf(await getInstanceReservation(host.paths, b.instance_id))).toEqual(release(host, next.commit));
    // A's prune removed only its own tag: the image stays while B's tag names it.
    expect(state.tags.has(releaseTag(a, next.commit))).toBe(false);
    expect(state.tags.get(releaseTag(b, next.commit))).toBe(shared);
    expect(state.ids.has(shared)).toBe(true);
  });
});

describe('what a snapshot restore discards', () => {
  it('counts lost messages, reruns, task firings, redeliveries, central rows, changed files, and orphaned agents', async () => {
    const root = await temporaryRoot('gws-ea-discard-');
    const snapshotRoot = path.join(root, 'snapshot');
    const currentRoot = path.join(root, 'current');
    const session = (state: string) => path.join(state, SESSION);
    for (const state of [snapshotRoot, currentRoot]) {
      mkdirSync(session(state), { recursive: true });
      mkdirSync(path.join(state, 'groups', 'main'), { recursive: true });
      const central = new Database(path.join(state, 'data', 'v2.db'));
      central.exec('CREATE TABLE agent_groups (id TEXT PRIMARY KEY, name TEXT NOT NULL)');
      central.prepare('INSERT INTO agent_groups VALUES (?, ?)').run('ag-main', 'main');
      central.close();
      const inbound = new Database(path.join(session(state), 'inbound.db'));
      inbound.exec(`CREATE TABLE messages_in (id TEXT PRIMARY KEY, seq INTEGER, kind TEXT NOT NULL, status TEXT);
        CREATE TABLE delivered (message_out_id TEXT PRIMARY KEY, status TEXT NOT NULL, delivered_at TEXT NOT NULL);`);
      inbound
        .prepare('INSERT INTO messages_in VALUES (?, ?, ?, ?)')
        .run('m1', 2, 'chat', state === snapshotRoot ? 'pending' : 'completed');
      inbound
        .prepare('INSERT INTO messages_in VALUES (?, ?, ?, ?)')
        .run('task-1', 4, 'task', state === snapshotRoot ? 'pending' : 'completed');
      if (state === currentRoot) {
        inbound.prepare('INSERT INTO messages_in VALUES (?, ?, ?, ?)').run('m2', 6, 'chat', 'pending');
        inbound.prepare('INSERT INTO delivered VALUES (?, ?, ?)').run('out-1', 'delivered', '2026-09-28T12:00:00.000Z');
      }
      inbound.close();
      const outbound = new Database(path.join(session(state), 'outbound.db'));
      outbound.exec('CREATE TABLE messages_out (id TEXT PRIMARY KEY, seq INTEGER)');
      outbound.prepare('INSERT INTO messages_out VALUES (?, ?)').run('out-1', 3);
      outbound.close();
      writeFileSync(path.join(state, 'groups', 'main', 'CLAUDE.local.md'), state === snapshotRoot ? 'old\n' : 'new\n');
    }
    const central = new Database(path.join(currentRoot, 'data', 'v2.db'));
    central.prepare('INSERT INTO agent_groups VALUES (?, ?)').run('ag-new', 'new');
    central.close();

    const summary = await summarizeDiscard(currentRoot, snapshotRoot);

    expect(summary).toEqual({
      inbound: { count: 1, ids: ['m2'] },
      rerun: { count: 2, ids: ['m1', 'task-1'] },
      taskFirings: { count: 1, ids: ['task-1'] },
      redelivered: { count: 1, ids: ['out-1'] },
      centralRows: [{ table: 'agent_groups', count: 1 }],
      files: { count: 1, paths: [path.join('main', 'CLAUDE.local.md')] },
      orphanedAgents: ['ag-new'],
    });
    expect(await summarizeDiscard(snapshotRoot, snapshotRoot)).toEqual({
      inbound: { count: 0, ids: [] },
      rerun: { count: 0, ids: [] },
      taskFirings: { count: 0, ids: [] },
      redelivered: { count: 0, ids: [] },
      centralRows: [],
      files: { count: 0, paths: [] },
      orphanedAgents: [],
    });
  });

  it('shows the files an agent named with their control characters escaped, the summary keeping each name exactly', async () => {
    const root = await temporaryRoot('gws-ea-discard-');
    const [snapshotRoot, currentRoot] = [path.join(root, 'snapshot'), path.join(root, 'current')];
    for (const state of [snapshotRoot, currentRoot]) {
      mkdirSync(path.join(state, 'data'), { recursive: true });
      mkdirSync(path.join(state, 'groups', 'main'), { recursive: true });
      const central = new Database(path.join(state, 'data', 'v2.db'));
      central.exec('CREATE TABLE agent_groups (id TEXT PRIMARY KEY, name TEXT NOT NULL)');
      central.close();
    }
    // A name the agent chose in its own folder: an escape that erases the line it is on, then a line break.
    const planted = 'notes\u001b[2K\rNothing is lost.\n.md';
    writeFileSync(path.join(currentRoot, 'groups', 'main', planted), 'planted\n');

    const discarded = await summarizeDiscard(currentRoot, snapshotRoot);
    const lines = rollbackPreviewLines(
      {
        instanceId: '00000000-0000-4000-8000-000000000000',
        from: {
          source_remote: 'https://example.test/nanoclaw.git',
          release_track: 'dogfood',
          deployed_commit: 'b'.repeat(40),
        },
        to: {
          source_remote: 'https://example.test/nanoclaw.git',
          release_track: 'dogfood',
          deployed_commit: 'a'.repeat(40),
        },
        snapshotAt: '2026-09-28T12:00:00.000Z',
        reason: 'requested',
        discarded,
        keptAt: path.join(root, 'quarantine'),
      },
      'UTC',
    );

    // What the rollback receipt records keeps the name as it is; what the operator reads shows it inert.
    expect(discarded.files).toEqual({ count: 1, paths: [path.join('main', planted)] });
    for (const line of lines) expect(line).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect(lines).toContain(
      `  Memory and group files changed since: 1 (${path.join('main', 'notes\\u001b[2K\\rNothing is lost.\\n.md')})`,
    );
  });
});
