/**
 * `rollback` returns an assistant, built and updated as the fixture's world
 * leaves it, to the release its update kept. Git, SQLite, and the files are
 * real; the service manager, Docker, `ps`, `lsof`, the release's scripts, the
 * host's status and listener, OneCLI, and `ncl` are faked at their boundaries
 * (see `testing/cutover-fixture.ts`).
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { finishFollowUps, readKeptReleaseManifest, restoredReleaseRoot } from './cutover.js';
import {
  ADDED_MIGRATION,
  applying,
  assistant,
  cli,
  converse,
  DEPLOYED_GATEWAY,
  dependencies,
  exists,
  git,
  imageBase,
  imageId,
  killDuringCutover,
  LIVE_MIGRATIONS,
  machine,
  MAIN_TEMPLATE_DIR,
  mainTemplate,
  MEMORY,
  messages,
  nextRelease,
  PERSONA,
  PROCEDURE,
  receiptCommit,
  release,
  RELEASE_GATEWAY,
  removeTemporaryRoots,
  repositoryImages,
  runtimeCommit,
  SESSION,
  snapshot,
  stampedPersona,
  status,
  world,
  type Machine,
  type Release,
  type World,
} from './testing/cutover-fixture.js';
import { acquireInstanceOperation } from './journal.js';
import { readOperationRecord, type OperationPhase, type OperationRecord } from './operation.js';
import { instanceMarkerFile } from './paths.js';
import { getInstanceReservation } from './registry.js';
import { rollBack, summarizeDiscard, type RollbackPreview } from './rollback.js';
import type { InstanceRuntimeConfig } from './service.js';
import { releaseOf } from './types.js';
import { readCentralMigrations } from './verify.js';

afterEach(removeTemporaryRoots);

/** Each case clones, stages, and swaps real Git checkouts twice, which a loaded machine slows. */
const GIT_HEAVY = { timeout: 90_000 } as const;

/** The service definition create installed, told apart from any a release renders by its first line. */
const CREATED_DEFINITION = '<!-- installed by create -->\n';

/**
 * An assistant created at the machine's first release, holding message `m1`
 * and a memory file, with the service definition create installed, then
 * updated to the next release: the fixture's own update, recorded and
 * finished. `files` changes what that release changes.
 */
async function updatedAssistant(
  files: Readonly<Record<string, string>> = {},
  port = 37_001,
  host?: Machine,
): Promise<{
  host: Machine;
  runtime: InstanceRuntimeConfig;
  next: Release;
  state: World;
  /** The agent image the first release ran, and the one the update built. */
  images: { readonly first: string; readonly next: string };
}> {
  const machineHost = host ?? (await machine());
  const runtime = await assistant(machineHost, port);
  await converse(runtime, 'm1');
  const definition = serviceDefinitionFile(machineHost, runtime);
  mkdirSync(path.dirname(definition), { recursive: true });
  writeFileSync(definition, CREATED_DEFINITION, { mode: 0o600 });
  const next = await nextRelease(machineHost, files);
  const state = world(runtime);
  const first = state.tags.get(`${imageBase(runtime)}:latest`)!;
  expect(await cli(machineHost, state, next, runtime).run(['update', '--id', runtime.instance_id, '--yes'])).toBe(0);
  return {
    host: machineHost,
    runtime,
    next,
    state,
    images: { first, next: state.tags.get(`${imageBase(runtime)}:latest`)! },
  };
}

function serviceDefinitionFile(host: Machine, runtime: InstanceRuntimeConfig): string {
  return path.join(host.root, 'Library', 'LaunchAgents', `com.nanoclaw-v2-${runtime.install_id}.plist`);
}

function commitOf(checkout: string): string {
  return git(checkout, 'rev-parse', 'HEAD');
}

/** What the release `checkout` holds would run: the commit its host is, as its own start would find it. */
function startsAs(checkout: string, commit: string): boolean {
  return commitOf(checkout) === commit;
}

/** Add the column a newer release's host adds to every session database when it opens it. */
function addSessionColumn(checkout: string): void {
  const database = new Database(path.join(checkout, SESSION, 'inbound.db'));
  try {
    database.exec('ALTER TABLE messages_in ADD COLUMN routed_by TEXT');
  } finally {
    database.close();
  }
}

/** A host that crash-loops: it records its crashes and an error, and never becomes healthy. */
function crashLoop(state: World, checkout: string): void {
  state.running = false;
  writeFileSync(path.join(checkout, 'data', 'circuit-breaker.json'), '{"crashes":5,"sleep_until":"2999-01-01"}');
  mkdirSync(path.join(checkout, 'logs'), { recursive: true });
  appendFileSync(path.join(checkout, 'logs', 'nanoclaw.error.log'), 'fatal: the new release crashed\n');
}

/**
 * Leave a WAL beside `file` holding committed frames of its own, as a
 * connection that never checkpointed would: its frames are a row the
 * database does not otherwise hold.
 */
function staleWal(file: string): void {
  const writer = new Database(file);
  let frames: Buffer;
  try {
    writer.pragma('wal_autocheckpoint = 0');
    writer
      .prepare('INSERT INTO agent_groups VALUES (?, ?, ?, NULL, ?)')
      .run('ag-stale', 'stale', 'ag-stale', '2026-09-28T00:00:00.000Z');
    frames = readFileSync(`${file}-wal`);
  } finally {
    writer.close();
  }
  const cleaner = new Database(file);
  try {
    cleaner.prepare("DELETE FROM agent_groups WHERE id = 'ag-stale'").run();
  } finally {
    cleaner.close();
  }
  writeFileSync(`${file}-wal`, frames);
}

/** Every entry under `root` but those under `except`, by type, mode, and content: what a copy keeps. */
async function contents(root: string, except: readonly string[] = []): Promise<Map<string, string>> {
  const entries = await snapshot(root, except);
  return new Map([...entries].map(([key, value]) => [key, value.replace(/^file (\d+) \S+ /u, 'file $1 ')]));
}

/** The rows of `table` in a database, in rowid order. */
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

/** Every image ID Docker holds that no tag names and that `record` does not name: one leaked for good. */
function forgottenImages(state: World, runtime: InstanceRuntimeConfig, record: OperationRecord | undefined): string[] {
  const named = new Set([
    ...(record?.images.flatMap((image) => [image.image_id, image.displaced_image_id ?? '']) ?? []),
    ...(record?.follow_ups.flatMap((followUp) => (followUp.kind === 'delete_image' ? [followUp.image_id] : [])) ?? []),
  ]);
  return repositoryImages(state, imageBase(runtime)).untagged.filter((id) => !named.has(id));
}

/**
 * The assistant once a rollback from `next` to the machine's first release is
 * recorded and finished: every record names the first release, the release
 * left is kept whole in `outgoing/`, `:latest` is the first release's image
 * again and the one the update built is gone, and nothing is kept to roll
 * back to or left open.
 */
async function expectRolledBack(
  host: Machine,
  runtime: InstanceRuntimeConfig,
  next: Release,
  state: World,
  ran: string,
) {
  const id = runtime.instance_id;
  const live = runtime.checkout_realpath;
  const outgoing = host.paths.releaseCheckoutRoot(id, 'outgoing');
  expect(releaseOf(await getInstanceReservation(host.paths, id))).toEqual(release(host, host.first));
  expect(commitOf(live)).toBe(host.first);
  expect(git(live, 'status', '--porcelain', '--untracked-files=all')).toBe('');
  expect(await receiptCommit(instanceMarkerFile(live))).toBe(host.first);
  expect(await runtimeCommit(live)).toBe(host.first);
  expect(await receiptCommit(host.paths.releasePreflightFile(id))).toBe(host.first);
  // The restored release boots past NanoClaw's tripwire: stamped by its own script, for its own commit.
  expect(JSON.parse(await readFile(path.join(live, 'data', 'upgrade-state.json'), 'utf8'))).toEqual({
    commit: host.first,
    via: 'gws-ea',
  });
  expect(commitOf(outgoing)).toBe(next.commit);
  expect(await receiptCommit(instanceMarkerFile(outgoing))).toBe(next.commit);
  expect(await receiptCommit(path.join(host.paths.releaseRoot(id, 'outgoing'), 'release-preflight.json'))).toBe(
    next.commit,
  );
  expect(await exists(host.paths.releaseRoot(id, 'previous'))).toBe(false);
  expect(await readOperationRecord(host.paths, id)).toBeUndefined();
  const base = imageBase(runtime);
  expect(state.tags.get(`${base}:latest`)).toBe(ran);
  expect(state.tags.has(`${base}:next`)).toBe(false);
  expect(repositoryImages(state, base).untagged).toEqual([]);
  expect(state.running).toBe(true);
  // Status: the previous commit is live, nothing is open, and no rollback is left.
  const observed = await status(host, state, next, runtime);
  expect(observed.operation).toEqual({ state: 'none', abandoned_staging: false });
  expect(observed.rollback).toMatchObject({ available: false, previous_commit: null });
  expect(observed.registry).toMatchObject({ deployed_commit: host.first });
}

/** Start a rollback and abandon it at `state.hangAt` or the swap's rename `state.renameKill`, as if killed there. */
async function killDuringRollback(host: Machine, runtime: InstanceRuntimeConfig, state: World, next: Release) {
  const deps = dependencies(state, next, runtime);
  const operation = await acquireInstanceOperation(host.paths, runtime.instance_id, { command: 'rollback' });
  if (!operation) throw new Error('The test instance operation was busy');
  const reached = new Promise<'killed'>((resolve) => (state.reached = () => resolve('killed')));
  const run = async (): Promise<'finished'> => {
    await rollBack(operation, deps, { present: () => undefined, confirm: async () => true });
    await finishFollowUps(operation, deps);
    return 'finished';
  };
  expect(await Promise.race([reached, run()])).toBe('killed');
  operation.release();
}

describe('gws-ea rollback of an update that moved no schema (AE6)', GIT_HEAVY, () => {
  it('keeps every message since the update, restores the release-owned files, and boots the old release', async () => {
    const { host, runtime, next, state, images } = await updatedAssistant();
    const id = runtime.instance_id;
    const live = runtime.checkout_realpath;
    // A message the new release received after the update.
    await converse(runtime, 'm2');
    const asked: RollbackPreview[] = [];
    const { run, out } = cli(host, state, next, runtime, {
      confirmRollback: async (preview) => {
        asked.push(preview);
        return true;
      },
    });

    expect(await run(['rollback', '--id', id])).toBe(0);

    await expectRolledBack(host, runtime, next, state, images.first);
    // Only the code went back: nothing was asked, and every message and memory came along.
    expect(asked).toEqual([]);
    expect(messages(live)).toEqual(['m1', 'm2']);
    expect(await readFile(path.join(live, MEMORY), 'utf8')).toContain('mornings');
    expect(await readFile(path.join(live, '.env'), 'utf8')).toContain('INSTALL_CJK_FONTS=true');
    // The release left is kept whole, its own state with it, until the next update.
    expect(messages(host.paths.releaseCheckoutRoot(id, 'outgoing'))).toEqual(['m1', 'm2']);
    // Its gateway, Compose file, and service definition are those the first release ran (KTD6, KTD8).
    expect(await readFile(runtimeCompose(host, runtime), 'utf8')).toContain(DEPLOYED_GATEWAY);
    expect(state.onecli.slice(-2)).toEqual([`restore ${runtime.onecli_project}`, `verify ${runtime.onecli_project}`]);
    expect(await readFile(serviceDefinitionFile(host, runtime), 'utf8')).toBe(CREATED_DEFINITION);
    // The per-group image was rebuilt on the restored base, and the update's image deleted by ID.
    expect(state.rebuilds.at(-1)?.args).toEqual(['groups', 'restart', '--id', 'ag-research', '--rebuild']);
    expect(state.ids.has(images.next)).toBe(false);
    const receipt = JSON.parse(
      await readFile(path.join(host.paths.releaseRoot(id, 'outgoing'), 'rollback.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(receipt).toMatchObject({ instance_id: id, mode: 'code_only', discarded: null });
    expect(out.slice(-3)).toEqual([
      `Assistant ${id} was rolled back to dogfood ${host.first.slice(0, 12)}.`,
      'Only its code went back: every conversation, memory, and setting since the update was kept.',
      `The release it left, dogfood ${next.commit.slice(0, 12)}, is kept in ${host.paths.releaseRoot(id, 'outgoing')} until the next update or removal.`,
    ]);
  });

  it('carries the state whole: stale side files beside the kept release never replay onto what it takes over', async () => {
    const { host, runtime, next, state, images } = await updatedAssistant();
    const id = runtime.instance_id;
    await converse(runtime, 'm2');
    const previous = host.paths.releaseCheckoutRoot(id, 'previous');
    // Leftovers beside the kept release's own databases: a WAL holding frames of its central database, which
    // would replay onto any database put beside it, and a session journal.
    staleWal(path.join(previous, 'data', 'v2.db'));
    await writeFile(path.join(previous, SESSION, 'inbound.db-journal'), '');
    expect(rows(path.join(previous, 'data', 'v2.db'), 'agent_groups')).toContainEqual(
      expect.objectContaining({ id: 'ag-stale' }),
    );
    const source = runtime.checkout_realpath;
    const centralRows = rows(path.join(source, 'data', 'v2.db'), 'agent_groups');
    const sessionRows = rows(path.join(source, SESSION, 'inbound.db'), 'messages_in');

    expect(await cli(host, state, next, runtime).run(['rollback', '--id', id, '--yes'])).toBe(0);

    await expectRolledBack(host, runtime, next, state, images.first);
    const live = runtime.checkout_realpath;
    expect(await exists(path.join(live, 'data', 'v2.db-wal'))).toBe(false);
    expect(await exists(path.join(live, SESSION, 'inbound.db-journal'))).toBe(false);
    expect(integrity(path.join(live, 'data', 'v2.db'))).toBe('ok');
    expect(integrity(path.join(live, SESSION, 'inbound.db'))).toBe('ok');
    expect(rows(path.join(live, 'data', 'v2.db'), 'agent_groups')).toEqual(centralRows);
    expect(centralRows).not.toContainEqual(expect.objectContaining({ id: 'ag-stale' }));
    expect(rows(path.join(live, SESSION, 'inbound.db'), 'messages_in')).toEqual(sessionRows);
    // The kept release's own state, leftovers and all, is kept aside with what it left behind.
    const setAside = path.join(host.paths.releaseRoot(id, 'outgoing'), 'restored', 'state');
    expect(await exists(path.join(setAside, 'data', 'v2.db-wal'))).toBe(true);
    expect(messages(setAside)).toEqual(['m1']);
  });
});

function runtimeCompose(host: Machine, runtime: InstanceRuntimeConfig): string {
  return path.join(host.paths.instanceRoot(runtime.instance_id), 'onecli', 'compose.yaml');
}

describe('gws-ea rollback of an update that moved a schema (AE6)', GIT_HEAVY, () => {
  /** An update whose new host applies a migration to the live database when it starts, as NanoClaw's does. */
  async function migratedAssistant() {
    const updated = await updatedAssistantWith((state, _runtime, next) => {
      state.onStart = (checkout) => {
        if (startsAs(checkout, next.commit)) applying(ADDED_MIGRATION)(path.join(checkout, 'data', 'v2.db'));
      };
    });
    await converse(updated.runtime, 'm2');
    return updated;
  }

  it('shows the snapshot time and what it discards, and refuses without --yes when nobody can be asked', async () => {
    const { host, runtime, next, state } = await migratedAssistant();
    const id = runtime.instance_id;
    const before = await snapshot(host.paths.instanceRoot(id));
    const events = state.events.length;
    const { run, out, err } = cli(host, state, next, runtime);

    expect(await run(['rollback', '--id', id])).toBe(1);

    const printed = out.join('\n');
    expect(printed).toMatch(/Restores the snapshot taken .*, because the update migrated the central database\./u);
    expect(printed).toContain('Inbound messages lost: 1 (m2)');
    expect(printed).toContain('Central rows added since: schema_version 1');
    expect(printed).toContain(`kept in ${host.paths.releaseRoot(id, 'outgoing')}`);
    expect(err.join('\n')).toContain('pass --yes');
    // Nothing changed: the assistant was never stopped, and no record was written.
    expect(state.events.slice(events)).toEqual([]);
    expect(state.running).toBe(true);
    expect(await snapshot(host.paths.instanceRoot(id))).toEqual(before);
  });

  it('restores the snapshot once confirmed, keeping what it discards in outgoing/', async () => {
    const { host, runtime, next, state, images } = await migratedAssistant();
    const id = runtime.instance_id;
    const asked: RollbackPreview[] = [];
    const { run, out } = cli(host, state, next, runtime, {
      confirmRollback: async (preview) => {
        asked.push(preview);
        return true;
      },
    });

    expect(await run(['rollback', '--id', id])).toBe(0);

    await expectRolledBack(host, runtime, next, state, images.first);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      reason: 'central_schema',
      discarded: { inbound: { count: 1, ids: ['m2'] }, centralRows: [{ table: 'schema_version', count: 1 }] },
    });
    // The snapshot: the first release's schema and messages as the update's stop left them.
    const live = runtime.checkout_realpath;
    expect(readCentralMigrations(live)).toEqual([...LIVE_MIGRATIONS]);
    expect(messages(live)).toEqual(['m1']);
    // What it discarded is quarantined with the release left.
    const outgoing = host.paths.releaseCheckoutRoot(id, 'outgoing');
    expect(readCentralMigrations(outgoing)).toEqual([...LIVE_MIGRATIONS, ADDED_MIGRATION]);
    expect(messages(outgoing)).toEqual(['m1', 'm2']);
    const receipt = JSON.parse(
      await readFile(path.join(host.paths.releaseRoot(id, 'outgoing'), 'rollback.json'), 'utf8'),
    ) as { mode: string; discarded: { inbound: { count: number } } };
    expect(receipt).toMatchObject({ mode: 'snapshot', discarded: { inbound: { count: 1 } } });
    expect(out.join('\n')).toContain('was restored');
  });

  it('leaves an assistant the operator stopped stopped when its snapshot restore is declined', async () => {
    const { host, runtime, next, state } = await migratedAssistant();
    const id = runtime.instance_id;
    state.running = false;
    const starts = state.serviceCalls.filter((call) => call.startsWith('start')).length;
    const { run, out } = cli(host, state, next, runtime, { confirmRollback: async () => false });

    expect(await run(['rollback', '--id', id])).toBe(0);

    expect(out.at(-1)).toBe(
      `Rollback cancelled. Assistant ${id} stays on dogfood ${next.commit.slice(0, 12)} as before.`,
    );
    expect(state.running).toBe(false);
    expect(state.serviceCalls.filter((call) => call.startsWith('start')).length).toBe(starts);
    expect(await readOperationRecord(host.paths, id)).toBeUndefined();
  });

  it('changes nothing when the snapshot restore is declined, and runs the release it would leave again', async () => {
    const { host, runtime, next, state } = await migratedAssistant();
    const id = runtime.instance_id;
    const { run, out } = cli(host, state, next, runtime, { confirmRollback: async () => false });

    expect(await run(['rollback', '--id', id])).toBe(0);

    expect(out.at(-1)).toBe(
      `Rollback cancelled. Assistant ${id} stays on dogfood ${next.commit.slice(0, 12)} as before.`,
    );
    expect(releaseOf(await getInstanceReservation(host.paths, id))).toEqual(release(host, next.commit));
    expect(commitOf(runtime.checkout_realpath)).toBe(next.commit);
    expect(messages(runtime.checkout_realpath)).toEqual(['m1', 'm2']);
    const previous = host.paths.releaseCheckoutRoot(id, 'previous');
    expect(messages(previous)).toEqual(['m1']);
    expect(await exists(path.join(host.paths.releaseRoot(id, 'previous'), 'state'))).toBe(false);
    expect(await readOperationRecord(host.paths, id)).toBeUndefined();
    expect(state.running).toBe(true);
  });

  it('chooses the snapshot when only a session column moved, though the central migrations are equal', async () => {
    const { host, runtime, next, state } = await updatedAssistantWith((world_, _runtime, release_) => {
      world_.onStart = (checkout) => {
        if (startsAs(checkout, release_.commit)) addSessionColumn(checkout);
      };
    });
    const id = runtime.instance_id;
    const asked: RollbackPreview[] = [];
    const { run } = cli(host, state, next, runtime, {
      confirmRollback: async (preview) => {
        asked.push(preview);
        return true;
      },
    });

    expect(await run(['rollback', '--id', id])).toBe(0);

    expect(asked.map((preview) => preview.reason)).toEqual(['session_schema']);
    expect(readCentralMigrations(runtime.checkout_realpath)).toEqual([...LIVE_MIGRATIONS]);
    const columns = rows(path.join(runtime.checkout_realpath, SESSION, 'inbound.db'), 'messages_in');
    expect(Object.keys(columns[0] as object)).not.toContain('routed_by');
  });
});

/** `updatedAssistant`, with `prepare` arranging the world before the update runs. */
async function updatedAssistantWith(prepare: (state: World, runtime: InstanceRuntimeConfig, next: Release) => void) {
  const host = await machine();
  const runtime = await assistant(host);
  await converse(runtime, 'm1');
  const definition = serviceDefinitionFile(host, runtime);
  mkdirSync(path.dirname(definition), { recursive: true });
  writeFileSync(definition, CREATED_DEFINITION, { mode: 0o600 });
  const next = await nextRelease(host);
  const state = world(runtime);
  const first = state.tags.get(`${imageBase(runtime)}:latest`)!;
  prepare(state, runtime, next);
  expect(await cli(host, state, next, runtime).run(['update', '--id', runtime.instance_id, '--yes'])).toBe(0);
  return { host, runtime, next, state, images: { first, next: state.tags.get(`${imageBase(runtime)}:latest`)! } };
}

describe('an update that fails after its swap (AE2, R14)', GIT_HEAVY, () => {
  it('rolls back on its own: every record, image, gateway, and the definition back on the previous release, the failed logs kept', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    await converse(runtime, 'm1');
    const definition = serviceDefinitionFile(host, runtime);
    mkdirSync(path.dirname(definition), { recursive: true });
    writeFileSync(definition, CREATED_DEFINITION, { mode: 0o600 });
    const next = await nextRelease(host);
    const state = world(runtime);
    const ran = state.tags.get(`${imageBase(runtime)}:latest`)!;
    // The new release's host crash-loops: NanoClaw's circuit breaker records it, and it never serves.
    state.onStart = (checkout) => {
      if (startsAs(checkout, next.commit)) crashLoop(state, checkout);
    };
    const { run, err } = cli(host, state, next, runtime);

    expect(await run(['update', '--id', runtime.instance_id, '--yes'])).toBe(1);

    const summary = err.join('\n');
    expect(summary).toContain("The new release's host service never became healthy.");
    expect(summary).toContain(
      `The update to dogfood ${next.commit.slice(0, 12)} stopped at started, so it was rolled back`,
    );
    await expectRolledBack(host, runtime, next, state, ran);
    const id = runtime.instance_id;
    const live = runtime.checkout_realpath;
    expect(messages(live)).toEqual(['m1']);
    expect(await readFile(runtimeCompose(host, runtime), 'utf8')).toContain(DEPLOYED_GATEWAY);
    expect(await readFile(definition, 'utf8')).toBe(CREATED_DEFINITION);
    // The restored host starts without the crashed release's circuit-breaker delay.
    expect(await exists(path.join(live, 'data', 'circuit-breaker.json'))).toBe(false);
    // The failed release's logs, and its crash count, are kept with it for diagnosis.
    const outgoing = host.paths.releaseCheckoutRoot(id, 'outgoing');
    expect(await readFile(path.join(outgoing, 'logs', 'nanoclaw.error.log'), 'utf8')).toContain('crashed');
    expect(await exists(path.join(outgoing, 'data', 'circuit-breaker.json'))).toBe(true);
    // No per-group image was rebuilt: the update's rebuilds never ran.
    expect(state.rebuilds).toEqual([]);
  });

  it('asks nothing, since the update was confirmed, and restores the snapshot when the release migrated before failing', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    await converse(runtime, 'm1');
    const next = await nextRelease(host);
    const state = world(runtime);
    state.onStart = (checkout) => {
      if (!startsAs(checkout, next.commit)) return;
      applying(ADDED_MIGRATION)(path.join(checkout, 'data', 'v2.db'));
      crashLoop(state, checkout);
    };
    const asked: RollbackPreview[] = [];
    const { run, err } = cli(host, state, next, runtime, {
      confirmRollback: async (preview) => {
        asked.push(preview);
        return false;
      },
    });

    expect(await run(['update', '--id', runtime.instance_id, '--yes'])).toBe(1);

    expect(asked).toEqual([]);
    expect(err.join('\n')).toContain('on its snapshot from');
    expect(readCentralMigrations(runtime.checkout_realpath)).toEqual([...LIVE_MIGRATIONS]);
    expect(releaseOf(await getInstanceReservation(host.paths, runtime.instance_id))).toEqual(release(host, host.first));
    expect(await readOperationRecord(host.paths, runtime.instance_id)).toBeUndefined();
  });
});

describe('a rollback whose restored release fails its checks', GIT_HEAVY, () => {
  it('in code-only mode goes back to the release it left with its data intact, and offers the snapshot', async () => {
    const { host, runtime, next, state, images } = await updatedAssistant();
    const id = runtime.instance_id;
    await converse(runtime, 'm2');
    const previous = host.paths.releaseCheckoutRoot(id, 'previous');
    const kept = await contents(previous);
    state.onStart = (checkout) => {
      if (startsAs(checkout, host.first)) crashLoop(state, checkout);
    };
    const { run, err } = cli(host, state, next, runtime);

    expect(await run(['rollback', '--id', id, '--yes'])).toBe(1);

    const summary = err.join('\n');
    expect(summary).toContain("The restored release's host service never became healthy.");
    expect(summary).toContain(`gws-ea rollback --id ${id} --snapshot`);
    expect(summary).not.toContain('Retry with');
    // Back on the release it left, recorded, with its data and files as they were.
    expect(releaseOf(await getInstanceReservation(host.paths, id))).toEqual(release(host, next.commit));
    expect(commitOf(runtime.checkout_realpath)).toBe(next.commit);
    expect(await receiptCommit(host.paths.releasePreflightFile(id))).toBe(next.commit);
    expect(messages(runtime.checkout_realpath)).toEqual(['m1', 'm2']);
    expect(state.tags.get(`${imageBase(runtime)}:latest`)).toBe(images.next);
    expect(await readFile(runtimeCompose(host, runtime), 'utf8')).toContain(RELEASE_GATEWAY);
    expect(await readFile(serviceDefinitionFile(host, runtime), 'utf8')).not.toBe(CREATED_DEFINITION);
    expect(state.running).toBe(true);
    // The kept release is kept again as its update left it, so a rollback is still available.
    expect(await contents(previous)).toEqual(kept);
    expect(await readOperationRecord(host.paths, id)).toBeUndefined();
    expect((await status(host, state, next, runtime)).rollback).toMatchObject({ available: true });
    // Its failed run's logs are kept for diagnosis.
    const failedLogs = path.join(host.paths.releaseRoot(id, 'outgoing'), 'failed-logs', 'nanoclaw.error.log');
    expect(await readFile(failedLogs, 'utf8')).toContain('crashed');
    expect(forgottenImages(state, runtime, undefined)).toEqual([]);
  });

  it('in snapshot mode goes back to the release it left with its data intact, the snapshot kept pristine', async () => {
    const { host, runtime, next, state, images } = await updatedAssistant();
    const id = runtime.instance_id;
    await converse(runtime, 'm2');
    const previous = host.paths.releaseCheckoutRoot(id, 'previous');
    const kept = await contents(previous);
    state.onStart = (checkout) => {
      if (!startsAs(checkout, host.first)) return;
      // The restored host touches its state before it crashes.
      const database = new Database(path.join(checkout, SESSION, 'inbound.db'));
      try {
        database.prepare('INSERT INTO messages_in VALUES (?, ?)').run('during-the-failed-run', 'x');
      } finally {
        database.close();
      }
      crashLoop(state, checkout);
    };

    expect(await cli(host, state, next, runtime).run(['rollback', '--id', id, '--snapshot', '--yes'])).toBe(1);

    expect(commitOf(runtime.checkout_realpath)).toBe(next.commit);
    expect(messages(runtime.checkout_realpath)).toEqual(['m1', 'm2']);
    expect(state.tags.get(`${imageBase(runtime)}:latest`)).toBe(images.next);
    // The snapshot ran on a copy: what the failed run wrote went with it.
    expect(await contents(previous)).toEqual(kept);
    expect(messages(previous)).toEqual(['m1']);
    expect(await readOperationRecord(host.paths, id)).toBeUndefined();
  });
});

describe('after a rollback', GIT_HEAVY, () => {
  it('keeps nothing more to roll back to, and the next update deletes the release it left once recorded', async () => {
    const { host, runtime, next, state, images } = await updatedAssistant();
    const id = runtime.instance_id;
    const { run, err } = cli(host, state, next, runtime);
    expect(await run(['rollback', '--id', id, '--yes'])).toBe(0);

    expect(await run(['rollback', '--id', id, '--yes'])).toBe(1);
    expect(err.join('\n')).toContain(`Assistant ${id} keeps no previous release`);
    expect(await exists(host.paths.releaseRoot(id, 'outgoing'))).toBe(true);

    expect(await run(['update', '--id', id, '--yes'])).toBe(0);

    expect(commitOf(runtime.checkout_realpath)).toBe(next.commit);
    expect(commitOf(host.paths.releaseCheckoutRoot(id, 'previous'))).toBe(host.first);
    expect(await exists(host.paths.releaseRoot(id, 'outgoing'))).toBe(false);
    expect(await readOperationRecord(host.paths, id)).toBeUndefined();
    expect(state.tags.get(`${imageBase(runtime)}:previous`)).toBe(images.first);
    expect(repositoryImages(state, imageBase(runtime)).untagged).toEqual([]);
  });
});

describe('gws-ea rollback refusals', GIT_HEAVY, () => {
  it('gives up before changing anything when something still holds the live data open, and starts it again', async () => {
    const { host, runtime, next, state } = await updatedAssistant();
    const id = runtime.instance_id;
    const live = runtime.checkout_realpath;
    const previous = host.paths.releaseCheckoutRoot(id, 'previous');
    const kept = await contents(previous);
    // A leftover opener, idle: an operator's sqlite3 shell on a session database.
    state.openFiles = `p4242\ncsqlite3\nf5\nn${path.join(live, SESSION, 'inbound.db')}\n`;
    const { run, err } = cli(host, state, next, runtime);

    expect(await run(['rollback', '--id', id, '--yes'])).toBe(1);

    const summary = err.join('\n');
    expect(summary).toContain(`sqlite3 (PID 4242) holds ${path.join(live, SESSION, 'inbound.db')}`);
    expect(summary).toContain(
      `stopped before changing anything, and the assistant stays on dogfood ${next.commit.slice(0, 12)}`,
    );
    expect(await readOperationRecord(host.paths, id)).toBeUndefined();
    expect(state.running).toBe(true);
    expect(commitOf(live)).toBe(next.commit);
    expect(await contents(previous)).toEqual(kept);
    expect(await exists(path.join(host.paths.releaseRoot(id, 'previous'), 'state'))).toBe(false);
  });

  it('refuses an assistant that keeps no previous release, without offering to retry', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const state = world(runtime);
    const next = await nextRelease(host);
    const { run, err } = cli(host, state, next, runtime);

    expect(await run(['rollback', '--id', runtime.instance_id, '--yes'])).toBe(1);

    expect(err.join('\n')).toContain(`Assistant ${runtime.instance_id} keeps no previous release`);
    expect(err.join('\n')).not.toContain('Retry with');
    expect(state.events).toEqual([]);
    expect(await readOperationRecord(host.paths, runtime.instance_id)).toBeUndefined();
  });

  it('refuses a previous release whose manifest names another assistant, changing nothing', async () => {
    const { host, runtime, next, state } = await updatedAssistant();
    const id = runtime.instance_id;
    const manifest = path.join(host.paths.releaseRoot(id, 'previous'), 'release-manifest.json');
    const other = JSON.parse(await readFile(manifest, 'utf8')) as Record<string, unknown>;
    await writeFile(manifest, JSON.stringify({ ...other, instance_id: '00000000-0000-4000-8000-000000000000' }), {
      mode: 0o600,
    });
    const before = await snapshot(host.paths.instanceRoot(id));
    const events = state.events.length;
    const { run, err } = cli(host, state, next, runtime);

    expect(await run(['rollback', '--id', id, '--yes'])).toBe(1);

    expect(err.join('\n')).toContain('belongs to another assistant');
    expect(state.events.slice(events)).toEqual([]);
    expect(await snapshot(host.paths.instanceRoot(id))).toEqual(before);
  });
});

/** Where each kill leaves the rollback's record. */
const KILLS: ReadonlyArray<readonly [string, (state: World) => void, OperationPhase]> = [
  ['while stopping the host', (state) => (state.hangAt = 'stop'), 'staged'],
  ['after the stop, while preparing the kept release', (state) => (state.hangAt = 'stamp'), 'stopped'],
  ["at the swap's first rename", (state) => (state.renameKill = 1), 'swapping'],
  ['between the two checkout renames', (state) => (state.renameKill = 2), 'swapping'],
  ["before the kept release's files leave previous/", (state) => (state.renameKill = 4), 'swapping'],
  ['after the swap, while moving images', (state) => (state.hangAt = 'retag'), 'swapped'],
  ['after the start, while verifying', (state) => (state.hangAt = 'verify'), 'started'],
  ['once recorded, while rebuilding group images', (state) => (state.hangAt = 'rebuild'), 'recorded'],
];

describe('a rollback killed partway', GIT_HEAVY, () => {
  it.each(KILLS)(
    'killed %s, is reported by status, refuses conflicting commands, and is finished by rollback',
    async (_label, kill, phase) => {
      const { host, runtime, next, state, images } = await updatedAssistant();
      const id = runtime.instance_id;
      await converse(runtime, 'm2');
      kill(state);

      await killDuringRollback(host, runtime, state, next);

      const record = await readOperationRecord(host.paths, id);
      expect(record).toMatchObject({ kind: 'rollback', phase });
      const observed = await status(host, state, next, runtime);
      expect(observed.operation).toMatchObject(
        phase === 'recorded'
          ? { state: 'recorded' }
          : { state: 'open', phase, continue_with: `gws-ea rollback --id ${id}`, revert_with: null },
      );
      // Every image the rollback may delete stays named until it is.
      expect(forgottenImages(state, runtime, record)).toEqual([]);

      delete state.hangAt;
      delete state.renameKill;
      const { run, err, out } = cli(host, state, next, runtime);
      if (phase === 'recorded') {
        expect(await run(['start', '--id', id])).toBe(0);
      } else {
        expect(await run(['update', '--id', id, '--yes'])).toBe(1);
        expect(err.join('\n')).toContain(`Continue it with gws-ea rollback --id ${id}.`);
      }

      expect(await run(['rollback', '--id', id, '--yes'])).toBe(0);

      await expectRolledBack(host, runtime, next, state, images.first);
      expect(messages(runtime.checkout_realpath)).toEqual(['m1', 'm2']);
      expect(out).toContain(
        phase === 'recorded'
          ? `Assistant ${id} runs dogfood ${host.first.slice(0, 12)}; its rollback is finished.`
          : `Assistant ${id} was rolled back to dogfood ${host.first.slice(0, 12)}.`,
      );
    },
  );

  it('re-stops a host the OS started at stopped, and carries the messages it received since', async () => {
    const { host, runtime, next, state, images } = await updatedAssistant();
    const id = runtime.instance_id;
    state.hangAt = 'stamp';
    await killDuringRollback(host, runtime, state, next);
    expect((await readOperationRecord(host.paths, id))?.phase).toBe('stopped');
    // The OS starts the release being left again (RunAtLoad), and it receives a message.
    state.running = true;
    await converse(runtime, 'm2');
    delete state.hangAt;
    const stops = state.serviceCalls.filter((call) => call.startsWith('stop')).length;

    expect(await cli(host, state, next, runtime).run(['rollback', '--id', id, '--yes'])).toBe(0);

    expect(state.serviceCalls.filter((call) => call.startsWith('stop')).length).toBeGreaterThan(stops);
    await expectRolledBack(host, runtime, next, state, images.first);
    expect(messages(runtime.checkout_realpath)).toEqual(['m1', 'm2']);
  });

  it('stops a host the OS started at swapped before it moves any image, then starts the restored release', async () => {
    const { host, runtime, next, state, images } = await updatedAssistant();
    const id = runtime.instance_id;
    state.hangAt = 'retag';
    await killDuringRollback(host, runtime, state, next);
    expect((await readOperationRecord(host.paths, id))?.phase).toBe('swapped');
    // The OS starts the host, now from the restored release's checkout, still on the update's agent image.
    state.running = true;
    delete state.hangAt;
    state.events.length = 0;

    expect(await cli(host, state, next, runtime).run(['rollback', '--id', id, '--yes'])).toBe(0);

    expect(state.events).toEqual(['stop running', 'tag', 'start']);
    await expectRolledBack(host, runtime, next, state, images.first);
  });
});

describe('gws-ea rollback of an update that is unfinished', GIT_HEAVY, () => {
  it.each([
    [
      'killed while stopping the host',
      (state: World): void => {
        state.hangAt = 'stop';
      },
      'staged',
    ],
    [
      'killed while carrying its state',
      (state: World): void => {
        state.hangAt = 'stamp';
      },
      'stopped',
    ],
    [
      'killed between the two checkout renames',
      (state: World): void => {
        state.renameKill = 3;
      },
      'swapping',
    ],
  ] as const)('discards an update %s and starts the old host again', async (_label, kill, phase) => {
    const host = await machine();
    const runtime = await assistant(host);
    await converse(runtime, 'm1');
    const next = await nextRelease(host);
    const state = world(runtime);
    const ran = state.tags.get(`${imageBase(runtime)}:latest`)!;
    kill(state);
    await killDuringCutover(host, runtime, state, next);
    expect((await readOperationRecord(host.paths, runtime.instance_id))?.phase).toBe(phase);
    delete state.hangAt;
    delete state.renameKill;
    const { run, out } = cli(host, state, next, runtime);

    expect(await run(['rollback', '--id', runtime.instance_id, '--yes'])).toBe(0);

    const id = runtime.instance_id;
    expect(out.at(-1)).toBe(
      `The update of assistant ${id} to dogfood ${next.commit.slice(0, 12)} was discarded; it runs dogfood ${host.first.slice(0, 12)} again.`,
    );
    expect(await readOperationRecord(host.paths, id)).toBeUndefined();
    expect(await exists(host.paths.releaseRoot(id, 'next'))).toBe(false);
    expect(await exists(host.paths.releaseRoot(id, 'previous'))).toBe(false);
    expect(commitOf(runtime.checkout_realpath)).toBe(host.first);
    expect(await receiptCommit(host.paths.releasePreflightFile(id))).toBe(host.first);
    expect(messages(runtime.checkout_realpath)).toEqual(['m1']);
    expect(state.tags.get(`${imageBase(runtime)}:latest`)).toBe(ran);
    expect(state.tags.has(`${imageBase(runtime)}:next`)).toBe(false);
    expect(state.running).toBe(true);
  });

  it.each([
    [
      'once its release moved live, before its receipt was promoted',
      (state: World): void => {
        state.renameKill = 4;
      },
    ],
    [
      'after the swap, between the two image tags',
      (state: World): void => {
        state.hangAt = 'second-tag';
      },
    ],
    [
      'after the start, while verifying',
      (state: World): void => {
        state.hangAt = 'verify';
      },
    ],
  ] as const)('rolls back an update killed %s, putting every image back', async (_label, kill) => {
    const host = await machine();
    const runtime = await assistant(host);
    await converse(runtime, 'm1');
    const next = await nextRelease(host);
    const state = world(runtime);
    const ran = state.tags.get(`${imageBase(runtime)}:latest`)!;
    kill(state);
    await killDuringCutover(host, runtime, state, next);
    const id = runtime.instance_id;
    // Before the rollback replaces it, and after, the update's images stay named.
    expect(forgottenImages(state, runtime, await readOperationRecord(host.paths, id))).toEqual([]);
    delete state.hangAt;
    delete state.renameKill;

    expect(await cli(host, state, next, runtime).run(['rollback', '--id', id, '--yes'])).toBe(0);

    await expectRolledBack(host, runtime, next, state, ran);
    expect(messages(runtime.checkout_realpath)).toEqual(['m1']);
    expect(state.rebuilds).toEqual([]);
  });

  it('gives the unrecorded update back, running, when a snapshot revert is declined or nobody can confirm it', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    await converse(runtime, 'm1');
    const next = await nextRelease(host);
    const state = world(runtime);
    // The update's release migrated the database when it started, so reverting it restores the snapshot.
    state.onStart = (checkout) => {
      if (startsAs(checkout, next.commit)) applying(ADDED_MIGRATION)(path.join(checkout, 'data', 'v2.db'));
    };
    state.hangAt = 'verify';
    await killDuringCutover(host, runtime, state, next);
    delete state.hangAt;
    const id = runtime.instance_id;
    const update = await readOperationRecord(host.paths, id);
    expect(update).toMatchObject({ kind: 'update', phase: 'started' });

    const declined = cli(host, state, next, runtime, { confirmRollback: async () => false });
    expect(await declined.run(['rollback', '--id', id])).toBe(0);
    expect(declined.out.at(-1)).toBe(
      `Rollback cancelled. Assistant ${id} stays on dogfood ${next.commit.slice(0, 12)} as before.`,
    );
    expect(await readOperationRecord(host.paths, id)).toEqual({ ...update, updated_at: expect.any(String) });
    expect(state.running).toBe(true);

    const unasked = cli(host, state, next, runtime);
    expect(await unasked.run(['rollback', '--id', id])).toBe(1);
    expect(unasked.err.join('\n')).toContain('pass --yes');
    expect(await readOperationRecord(host.paths, id)).toMatchObject({ kind: 'update', phase: 'started' });
    expect(commitOf(runtime.checkout_realpath)).toBe(next.commit);
    expect(state.running).toBe(true);

    // Continued, the update verifies its release and records it.
    expect(await cli(host, state, next, runtime).run(['update', '--id', id, '--yes'])).toBe(0);
    expect(releaseOf(await getInstanceReservation(host.paths, id))).toEqual(release(host, next.commit));
  });

  it('puts back the previous release an unrecorded update set aside, so the rollback point before it stays', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const first = await nextRelease(host);
    const state = world(runtime);
    expect(await cli(host, state, first, runtime).run(['update', '--id', runtime.instance_id, '--yes'])).toBe(0);
    const second = await nextRelease(host);
    const base = imageBase(runtime);
    const [latest, previous] = [state.tags.get(`${base}:latest`)!, state.tags.get(`${base}:previous`)!];
    state.hangAt = 'verify';
    await killDuringCutover(host, runtime, state, second);
    const id = runtime.instance_id;
    delete state.hangAt;

    expect(await cli(host, state, second, runtime).run(['rollback', '--id', id, '--yes'])).toBe(0);

    expect(commitOf(runtime.checkout_realpath)).toBe(first.commit);
    expect(releaseOf(await getInstanceReservation(host.paths, id))).toEqual(release(host, first.commit));
    expect(commitOf(host.paths.releaseCheckoutRoot(id, 'previous'))).toBe(host.first);
    expect(await exists(host.paths.releaseRoot(id, 'superseded'))).toBe(false);
    expect(commitOf(host.paths.releaseCheckoutRoot(id, 'outgoing'))).toBe(second.commit);
    expect([state.tags.get(`${base}:latest`), state.tags.get(`${base}:previous`)]).toEqual([latest, previous]);
    expect(repositoryImages(state, base).untagged).toEqual([]);
    expect((await status(host, state, second, runtime)).rollback).toMatchObject({
      available: true,
      previous_commit: host.first,
    });
  });
});

describe('a rollback of an update whose follow-ups are pending', GIT_HEAVY, () => {
  /** Two updates, the second recorded with its group image rebuild failing, so its cleanup is still pending. */
  async function pendingUpdate() {
    const host = await machine();
    const runtime = await assistant(host);
    const first = await nextRelease(host);
    const state = world(runtime);
    expect(await cli(host, state, first, runtime).run(['update', '--id', runtime.instance_id, '--yes'])).toBe(0);
    const base = imageBase(runtime);
    const oldest = state.tags.get(`${base}:previous`)!;
    const second = await nextRelease(host);
    state.rebuildFails = true;
    expect(await cli(host, state, second, runtime).run(['update', '--id', runtime.instance_id, '--yes'])).toBe(1);
    const record = await readOperationRecord(host.paths, runtime.instance_id);
    // The image the second update displaced from `:previous` is tagged nowhere: only its record names it.
    expect(repositoryImages(state, base).untagged).toEqual([oldest]);
    expect(record?.follow_ups).toContainEqual({ kind: 'delete_image', image_id: oldest });
    state.rebuildFails = false;
    return { host, runtime, first, second, state, oldest };
  }

  it('takes the update over, carrying every image deletion it planned, and leaves no image behind', async () => {
    const { host, runtime, first, second, state } = await pendingUpdate();
    const id = runtime.instance_id;

    expect(await cli(host, state, second, runtime).run(['rollback', '--id', id, '--yes'])).toBe(0);

    expect(commitOf(runtime.checkout_realpath)).toBe(first.commit);
    expect(await readOperationRecord(host.paths, id)).toBeUndefined();
    expect(repositoryImages(state, imageBase(runtime)).untagged).toEqual([]);
    expect(await exists(host.paths.releaseRoot(id, 'superseded'))).toBe(false);
  });

  it('puts the update and its follow-ups back when the rollback goes back, and update then finishes them', async () => {
    const { host, runtime, first, second, state, oldest } = await pendingUpdate();
    const id = runtime.instance_id;
    const pending = await readOperationRecord(host.paths, id);
    state.onStart = (checkout) => {
      if (startsAs(checkout, first.commit)) crashLoop(state, checkout);
    };

    expect(await cli(host, state, second, runtime).run(['rollback', '--id', id, '--yes'])).toBe(1);

    const restored = await readOperationRecord(host.paths, id);
    expect(restored).toMatchObject({ kind: 'update', phase: 'recorded', follow_ups: pending?.follow_ups });
    expect(forgottenImages(state, runtime, restored)).toEqual([]);
    delete state.onStart;

    expect(await cli(host, state, second, runtime).run(['update', '--id', id, '--yes'])).toBe(0);

    expect(commitOf(runtime.checkout_realpath)).toBe(second.commit);
    expect(state.ids.has(oldest)).toBe(false);
    expect(repositoryImages(state, imageBase(runtime)).untagged).toEqual([]);
  });
});

describe('rollback isolation (AE3)', GIT_HEAVY, () => {
  it("rolls one assistant back without touching another's files, registry entry, or images", async () => {
    const host = await machine();
    const b = await assistant(host, 37_101);
    const bRegistered = await getInstanceReservation(host.paths, b.instance_id);
    const bFiles = await snapshot(host.paths.instanceRoot(b.instance_id));
    const { runtime: a, next, state } = await updatedAssistant({}, 37_001, host);
    const bLatest = imageId();
    state.tags.set(`${imageBase(b)}:latest`, bLatest);
    state.ids.add(bLatest);
    state.commands.length = 0;
    state.serviceCalls.length = 0;
    state.onecli.length = 0;
    state.fetched.length = 0;

    expect(await cli(host, state, next, a).run(['rollback', '--id', a.instance_id, '--yes'])).toBe(0);

    const identifiers = [
      b.instance_id,
      b.install_id,
      b.checkout_realpath,
      b.onecli_project,
      imageBase(b),
      String(b.allocated_ports.nanoclaw_webhook),
      b.endpoint_url,
    ];
    const reached = [
      ...state.commands.map((command) => JSON.stringify(command)),
      ...state.serviceCalls,
      ...state.onecli,
      ...state.fetched,
      ...state.rebuilds.map((call) => call.args.join(' ')),
    ].join('\n');
    for (const identifier of identifiers) expect(reached).not.toContain(identifier);
    expect(reached).not.toContain('cloudflared');
    expect(await getInstanceReservation(host.paths, b.instance_id)).toEqual(bRegistered);
    expect(await snapshot(host.paths.instanceRoot(b.instance_id))).toEqual(bFiles);
    expect(state.tags.get(`${imageBase(b)}:latest`)).toBe(bLatest);
  });
});

describe('what a snapshot restore discards', () => {
  it('counts lost messages, reruns, task firings, redeliveries, central rows, changed files, and orphaned agents', async () => {
    const host = await machine();
    const snapshotRoot = path.join(host.root, 'snapshot');
    const currentRoot = path.join(host.root, 'current');
    const session = (root: string) => path.join(root, SESSION);
    for (const root of [snapshotRoot, currentRoot]) {
      mkdirSync(session(root), { recursive: true });
      mkdirSync(path.join(root, 'groups', 'main'), { recursive: true });
      const central = new Database(path.join(root, 'data', 'v2.db'));
      central.exec('CREATE TABLE agent_groups (id TEXT PRIMARY KEY, name TEXT NOT NULL)');
      central.prepare('INSERT INTO agent_groups VALUES (?, ?)').run('ag-main', 'main');
      central.close();
      const inbound = new Database(path.join(session(root), 'inbound.db'));
      inbound.exec(`CREATE TABLE messages_in (id TEXT PRIMARY KEY, seq INTEGER, kind TEXT NOT NULL, status TEXT);
        CREATE TABLE delivered (message_out_id TEXT PRIMARY KEY, status TEXT NOT NULL, delivered_at TEXT NOT NULL);`);
      inbound
        .prepare('INSERT INTO messages_in VALUES (?, ?, ?, ?)')
        .run('m1', 2, 'chat', root === snapshotRoot ? 'pending' : 'completed');
      inbound
        .prepare('INSERT INTO messages_in VALUES (?, ?, ?, ?)')
        .run('task-1', 4, 'task', root === snapshotRoot ? 'pending' : 'completed');
      if (root === currentRoot) {
        inbound.prepare('INSERT INTO messages_in VALUES (?, ?, ?, ?)').run('m2', 6, 'chat', 'pending');
        inbound.prepare('INSERT INTO delivered VALUES (?, ?, ?)').run('out-1', 'delivered', '2026-09-28T12:00:00.000Z');
      }
      inbound.close();
      const outbound = new Database(path.join(session(root), 'outbound.db'));
      outbound.exec('CREATE TABLE messages_out (id TEXT PRIMARY KEY, seq INTEGER)');
      outbound.prepare('INSERT INTO messages_out VALUES (?, ?)').run('out-1', 3);
      outbound.close();
      writeFileSync(path.join(root, 'groups', 'main', 'CLAUDE.local.md'), root === snapshotRoot ? 'old\n' : 'new\n');
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
});

describe("main's template across a rollback (KTD12)", GIT_HEAVY, () => {
  const PLAN = ['groups', 'create', '--template', 'gws-ea/main', '--id', 'ag-main'];

  async function persona(runtime: InstanceRuntimeConfig): Promise<string> {
    return readFile(path.join(runtime.checkout_realpath, PERSONA), 'utf8');
  }

  it("reverses the update's refresh with the restored release's own restamp after a code-only rollback", async () => {
    const { host, runtime, next, state, images } = await updatedAssistant(mainTemplate('2'));
    const id = runtime.instance_id;
    expect(await persona(runtime)).toBe(stampedPersona('2'));
    state.restamps.length = 0;
    // The restored release's restamp brings back the task series the update's had removed.
    state.restampPlan = [{ surface: 'task', name: 'Morning brief', action: 'create', note: 'created paused' }];
    const { run, out } = cli(host, state, next, runtime);

    expect(await run(['rollback', '--id', id])).toBe(0);

    await expectRolledBack(host, runtime, next, state, images.first);
    expect(await persona(runtime)).toBe(stampedPersona('1'));
    expect(await readFile(path.join(runtime.checkout_realpath, PROCEDURE), 'utf8')).toBe('Operating procedure 1.\n');
    expect(state.restamps).toEqual([
      { instanceId: id, args: PLAN },
      { instanceId: id, args: [...PLAN, '--yes'] },
    ]);
    expect(out.join('\n')).toContain(
      "Main's template was restored to this release's. It created these scheduled tasks, paused: Morning brief.",
    );
  });

  it('plans no reversal after an update that kept main customized', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    await writeFile(path.join(runtime.checkout_realpath, PERSONA), 'My own instructions.\n');
    const next = await nextRelease(host, mainTemplate('2'));
    const state = world(runtime);
    expect(await cli(host, state, next, runtime).run(['update', '--id', runtime.instance_id, '--yes'])).toBe(0);
    state.hangAt = 'rebuild';

    // Stopped at its first follow-up, the recorded rollback shows what it planned.
    await killDuringRollback(host, runtime, state, next);

    const record = await readOperationRecord(host.paths, runtime.instance_id);
    expect(record).toMatchObject({ kind: 'rollback', phase: 'recorded', mode: 'code_only' });
    expect(record?.follow_ups).not.toContainEqual({ kind: 'reverse_template_restamp' });
    expect(state.restamps).toEqual([]);
    expect(await persona(runtime)).toBe('My own instructions.\n');
  });

  it('plans no reversal when it takes over an update whose refresh never ran', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host, mainTemplate('2'));
    const state = world(runtime);
    state.restampFails = true;
    const { run, out } = cli(host, state, next, runtime);
    expect(await run(['update', '--id', runtime.instance_id, '--yes'])).toBe(1);
    state.restamps.length = 0;
    const updating = out.length;

    expect(await run(['rollback', '--id', runtime.instance_id, '--yes'])).toBe(0);

    expect(state.restamps).toEqual([]);
    expect(await persona(runtime)).toBe(stampedPersona('1'));
    expect(out.slice(updating).join('\n')).not.toContain("Main's template");
    expect(await readOperationRecord(host.paths, runtime.instance_id)).toBeUndefined();
  });

  /** A task series the release's template stamps, in a session mailbox of main's. */
  function taskMailbox(checkout: string, prompt: string): void {
    const directory = path.join(checkout, 'data', 'v2-sessions', 'ag-main', 'tasks-1');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const database = new Database(path.join(directory, 'inbound.db'));
    try {
      database.pragma('journal_mode = DELETE');
      database.exec(`CREATE TABLE IF NOT EXISTS messages_in (
        id TEXT PRIMARY KEY, kind TEXT, series_id TEXT, status TEXT, recurrence TEXT, content TEXT, seq INTEGER)`);
      database
        .prepare(
          "INSERT OR REPLACE INTO messages_in VALUES ('weekly-review-1a2b', 'task', 'weekly-review-1a2b', 'paused', '0 9 * * 1', ?, 2)",
        )
        .run(JSON.stringify({ prompt, script: null }));
    } finally {
      database.close();
    }
  }

  it.each([
    [
      'its files',
      (runtime: InstanceRuntimeConfig) =>
        writeFileSync(path.join(runtime.checkout_realpath, PERSONA), 'Edited since the update.\n'),
      'instructions.prepend.md',
    ],
    [
      'its plugin MCP servers',
      (runtime: InstanceRuntimeConfig) => {
        const database = new Database(path.join(runtime.checkout_realpath, 'data', 'v2.db'));
        try {
          database
            .prepare("UPDATE container_configs SET mcp_servers = ? WHERE agent_group_id = 'ag-main'")
            .run(
              JSON.stringify({ calendar: { type: 'http', url: 'https://example.test/mcp', plugin: 'gws-ea-main' } }),
            );
        } finally {
          database.close();
        }
      },
      'its plugin MCP servers',
    ],
    [
      'its template tasks',
      (runtime: InstanceRuntimeConfig) => taskMailbox(runtime.checkout_realpath, 'Review the week, and the month.'),
      'its template tasks',
    ],
  ] as const)(
    'leaves main as the update refreshed it when %s changed since, and says so',
    async (_label, change, named) => {
      const host = await machine();
      const runtime = await assistant(host);
      taskMailbox(runtime.checkout_realpath, 'Review the week.');
      const next = await nextRelease(host, {
        ...mainTemplate('2'),
        [path.join(MAIN_TEMPLATE_DIR, 'ai.nanoco.nanoclaw', 'tasks', 'Weekly review.md')]:
          '---\nschedule: 0 9 * * 1\n---\nReview the week.\n',
      });
      const state = world(runtime);
      const { run, out } = cli(host, state, next, runtime);
      expect(await run(['update', '--id', runtime.instance_id, '--yes'])).toBe(0);
      expect(
        (await readKeptReleaseManifest(host.paths.releaseRoot(runtime.instance_id, 'previous'), runtime.instance_id))
          .template_restamp,
      ).toMatchObject({ task_slugs: ['weekly-review'] });
      const refreshed = await persona(runtime);
      change(runtime);
      state.restamps.length = 0;

      expect(await run(['rollback', '--id', runtime.instance_id])).toBe(0);

      expect(commitOf(runtime.checkout_realpath)).toBe(host.first);
      expect(out.join('\n')).toContain(
        `Main's template was left as the update refreshed it, because ${named} changed since the update.`,
      );
      // Only planned when NanoClaw's plan was consulted, never applied.
      expect(state.restamps.filter((call) => call.args.includes('--yes'))).toEqual([]);
      if (named !== 'instructions.prepend.md') expect(await persona(runtime)).toBe(refreshed);
    },
  );

  it('finishes a reversal killed partway when the rollback is run again', async () => {
    const { host, runtime, next, state } = await updatedAssistant(mainTemplate('2'));
    const id = runtime.instance_id;
    state.hangAt = 'restamp-partway';

    await killDuringRollback(host, runtime, state, next);

    // It was marked as reversing before the restored release's restamp ran, which stopped after the plugin.
    const marked = (await readKeptReleaseManifest(restoredReleaseRoot(host.paths, id), id)).template_restamp;
    expect(marked).toMatchObject({ reversing: true });
    expect(await persona(runtime)).toBe(stampedPersona('2'));
    delete state.hangAt;
    state.restamps.length = 0;
    const { run, out } = cli(host, state, next, runtime);

    expect(await run(['rollback', '--id', id])).toBe(0);

    expect(await persona(runtime)).toBe(stampedPersona('1'));
    expect(state.restamps).toEqual([{ instanceId: id, args: [...PLAN, '--yes'] }]);
    expect(out.join('\n')).toContain("Main's template was restored to this release's.");
    expect(await readOperationRecord(host.paths, id)).toBeUndefined();
  });
});
