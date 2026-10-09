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
import { afterEach, describe, expect, it, vi } from 'vitest';

import { heldImageTag } from './agent-image.js';
import { finishFollowUps } from './cutover.js';
import type { RunEvent } from './events.js';
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
  isHold,
  killDuringCutover,
  LIVE_MIGRATIONS,
  machine,
  MEMORY,
  messages,
  nextRelease,
  receiptCommit,
  release,
  releaseAgentImageKey,
  RELEASE_GATEWAY,
  removeTemporaryRoots,
  repositoryImages,
  runtimeCommit,
  SESSION,
  snapshot,
  SQLITE_HEADER,
  status,
  temporaryRoot,
  world,
  type Machine,
  type Release,
  type World,
} from './testing/cutover-fixture.js';
import { acquireInstanceOperation } from './journal.js';
import { advanceOperation, readOperationRecord, type OperationPhase, type OperationRecord } from './operation.js';
import { instanceMarkerFile } from './paths.js';
import { getInstanceReservation, swapInstanceRelease } from './registry.js';
import {
  readKeptPreviousRelease,
  rollBack,
  rollbackPreviewLines,
  summarizeDiscard,
  type RollbackPreview,
} from './rollback.js';
import type { InstanceRuntimeConfig } from './service.js';
import { releaseOf } from './types.js';
import { readCentralMigrations } from './verify.js';

/**
 * The operation record's write as its release is recorded, failed once as a
 * full disk fails it when `recordedWrite` is armed: the one right after the
 * registry's compare-and-swap.
 */
const failing = vi.hoisted(() => ({ recordedWrite: false }));
vi.mock('../community-portal/private-file.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../community-portal/private-file.js')>();
  const writePrivate: typeof actual.writePrivate = async (file, value) => {
    const recorded = typeof value === 'object' && value !== null && 'phase' in value && value.phase === 'recorded';
    if (failing.recordedWrite && file.endsWith('/operation.json') && recorded) {
      failing.recordedWrite = false;
      throw Object.assign(new Error(`ENOSPC: no space left on device, write '${file}'`), { code: 'ENOSPC' });
    }
    return actual.writePrivate(file, value);
  };
  return { ...actual, writePrivate };
});

afterEach(removeTemporaryRoots);
afterEach(() => {
  failing.recordedWrite = false;
});

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
 * again and the one the update built is gone, no `:previous` tag is left
 * naming it, and nothing is kept to roll back to or left open.
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
  expect(state.tags.has(`${base}:previous`)).toBe(false);
  expect(repositoryImages(state, base).untagged).toEqual([]);
  // Nothing is held once the rollback's cleanup released what it displaced.
  expect([...state.tags.keys()].filter(isHold)).toEqual([]);
  expect(state.running).toBe(true);
  // Status: the previous commit is live, nothing is open, and no rollback is left.
  const observed = await status(host, state, next, runtime);
  expect(observed.operation).toEqual({ state: 'none', abandoned_staging: false });
  expect(observed.rollback).toMatchObject({ available: false, previous_commit: null });
  expect(observed.registry).toMatchObject({ deployed_commit: host.first });
}

/** Leave every agent group on the base image, so none has an image of its own to rebuild. */
function withoutGroupImages(checkout: string): void {
  const database = new Database(path.join(checkout, 'data', 'v2.db'));
  try {
    database.prepare('UPDATE container_configs SET image_tag = NULL').run();
  } finally {
    database.close();
  }
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

  it('reports its stop once, and names the checks before the swap and the start that it is still stopped', async () => {
    const { host, runtime, next, state } = await updatedAssistant();
    const started: Array<readonly [string, string | undefined]> = [];
    const deps = {
      ...dependencies(state, next, runtime),
      reporter: {
        emit: (event: RunEvent) => {
          if (event.type === 'step-started') started.push([event.step, event.label]);
        },
      },
    };
    const operation = await acquireInstanceOperation(host.paths, runtime.instance_id, { command: 'rollback' });
    if (!operation) throw new Error('The test instance operation was busy');
    try {
      expect(await rollBack(operation, deps, { present: () => undefined })).toMatchObject({ kind: 'rolled_back' });
    } finally {
      operation.release();
    }

    // One stop step throughout; the checks that no host started since read as what they are.
    expect(started.filter(([step]) => ['stop_host', 'swap_releases', 'move_images'].includes(step))).toEqual([
      ['stop_host', 'Stopping the assistant for the rollback…'],
      ['stop_host', 'Making sure the assistant is still stopped…'],
      ['swap_releases', 'Switching to the previous release…'],
      ['stop_host', 'Making sure the assistant is still stopped…'],
      ['move_images', "Moving the assistant's images back…"],
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

  it('never opens a file an agent planted beside a -journal or -wal, even with SQLite’s header, and carries it back as it is', async () => {
    const { host, runtime, next, state, images } = await updatedAssistant();
    const session = path.join(runtime.checkout_realpath, SESSION);
    // SQLite's header and nothing a database holds: SQLite would delete each side file as it refused the file.
    const planted = {
      'evil.db': SQLITE_HEADER,
      'evil.db-journal': 'Not a journal.\n',
      'forged.db': `${SQLITE_HEADER}${'junk'.repeat(256)}`,
      'forged.db-wal': 'Not a log.\n',
    };
    for (const [file, contents] of Object.entries(planted)) await writeFile(path.join(session, file), contents);

    expect(await cli(host, state, next, runtime).run(['rollback', '--id', runtime.instance_id, '--yes'])).toBe(0);

    await expectRolledBack(host, runtime, next, state, images.first);
    for (const [file, contents] of Object.entries(planted)) {
      expect(await readFile(path.join(session, file), 'utf8'), file).toBe(contents);
    }
    expect(messages(runtime.checkout_realpath)).toEqual(['m1']);
  });
});

function runtimeCompose(host: Machine, runtime: InstanceRuntimeConfig): string {
  return path.join(host.paths.instanceRoot(runtime.instance_id), 'onecli', 'compose.yaml');
}

describe('gws-ea rollback of an update that moved a schema (AE6)', GIT_HEAVY, () => {
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

/**
 * `updatedAssistant`, whose new host applies a migration to the live database
 * when it starts, as NanoClaw's does, and then receives message `m2`.
 */
async function migratedAssistant() {
  const updated = await updatedAssistantWith((state, _runtime, next) => {
    state.onStart = (checkout) => {
      if (startsAs(checkout, next.commit)) applying(ADDED_MIGRATION)(path.join(checkout, 'data', 'v2.db'));
    };
  });
  await converse(updated.runtime, 'm2');
  return updated;
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
    expect(state.tags.has(`${imageBase(runtime)}:previous`)).toBe(false);

    expect(await run(['rollback', '--id', id, '--yes'])).toBe(1);
    expect(err.join('\n')).toContain(`Assistant ${id} keeps no previous release`);
    expect(await exists(host.paths.releaseRoot(id, 'outgoing'))).toBe(true);

    // With no `:previous` tag to displace, the next update's retag still keeps the image the assistant ran.
    expect(await run(['update', '--id', id, '--yes'])).toBe(0);

    expect(commitOf(runtime.checkout_realpath)).toBe(next.commit);
    expect(commitOf(host.paths.releaseCheckoutRoot(id, 'previous'))).toBe(host.first);
    expect(await exists(host.paths.releaseRoot(id, 'outgoing'))).toBe(false);
    expect(await readOperationRecord(host.paths, id)).toBeUndefined();
    expect(state.tags.get(`${imageBase(runtime)}:previous`)).toBe(images.first);
    expect(repositoryImages(state, imageBase(runtime)).untagged).toEqual([]);
  });

  it('drops the :previous tag of one recorded with nothing else to follow up, and rollback finishes a drop cut short', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const id = runtime.instance_id;
    withoutGroupImages(runtime.checkout_realpath);
    const next = await nextRelease(host);
    const state = world(runtime);
    const base = imageBase(runtime);
    const ran = state.tags.get(`${base}:latest`)!;
    // The image the assistant runs already carries the release's key, so the update tags it rather than building.
    state.labels.set(ran, releaseAgentImageKey(next));
    expect(await cli(host, state, next, runtime).run(['update', '--id', id, '--yes'])).toBe(0);
    expect([state.tags.get(`${base}:latest`), state.tags.get(`${base}:previous`)]).toEqual([ran, ran]);
    state.hangAt = 'untag';

    await killDuringRollback(host, runtime, state, next);

    // Recorded with nothing else to follow up, it left no record: only its tag says it is unfinished.
    expect(await readOperationRecord(host.paths, id)).toBeUndefined();
    expect(releaseOf(await getInstanceReservation(host.paths, id))).toEqual(release(host, host.first));
    expect(state.tags.get(`${base}:previous`)).toBe(ran);
    delete state.hangAt;
    const { run, out, err } = cli(host, state, next, runtime);

    expect(await run(['rollback', '--id', id, '--yes'])).toBe(0);

    expect(out).toContain(`Assistant ${id} runs dogfood ${host.first.slice(0, 12)}; its rollback is finished.`);
    expect(state.tags.has(`${base}:previous`)).toBe(false);
    expect(state.tags.get(`${base}:latest`)).toBe(ran);
    expect(state.ids.has(ran)).toBe(true);
    // Finished, it refuses again, as any assistant that keeps nothing to roll back to does.
    expect(await run(['rollback', '--id', id, '--yes'])).toBe(1);
    expect(err.join('\n')).toContain(`Assistant ${id} keeps no previous release`);
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

  it('gives up when something opens the live data just before the first rename, moving nothing, and starts it again', async () => {
    const { host, runtime, next, state, images } = await updatedAssistant();
    const id = runtime.instance_id;
    const live = runtime.checkout_realpath;
    await converse(runtime, 'm2');
    const previous = host.paths.releaseCheckoutRoot(id, 'previous');
    const kept = await contents(previous);
    // Opened once the kept release is prepared: stamping its tripwire is the last of that.
    state.onStamp = () => {
      state.openFiles = `p5150\ncnode\nf9\nn${path.join(live, 'data', 'v2.db')}\n`;
    };
    const { run, err } = cli(host, state, next, runtime);

    expect(await run(['rollback', '--id', id, '--yes'])).toBe(1);

    const summary = err.join('\n');
    expect(summary).toContain(`node (PID 5150) holds ${path.join(live, 'data', 'v2.db')}`);
    expect(summary).toContain(
      `stopped before changing anything, and the assistant stays on dogfood ${next.commit.slice(0, 12)}`,
    );
    expect(await readOperationRecord(host.paths, id)).toBeUndefined();
    expect(state.running).toBe(true);
    expect(commitOf(live)).toBe(next.commit);
    expect(messages(live)).toEqual(['m1', 'm2']);
    expect(await contents(previous)).toEqual(kept);
    expect(await exists(host.paths.releaseCheckoutRoot(id, 'outgoing'))).toBe(false);

    // Once it lets go, the rollback runs.
    state.openFiles = '';
    delete state.onStamp;
    expect(await run(['rollback', '--id', id, '--yes'])).toBe(0);
    await expectRolledBack(host, runtime, next, state, images.first);
    expect(messages(live)).toEqual(['m1', 'm2']);
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

  /** Rewrite the commit a checkout's marker names, as a hand edit or a copy from elsewhere would. */
  async function markAt(checkout: string, commit: string): Promise<void> {
    const file = instanceMarkerFile(checkout);
    const marker = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    await writeFile(file, JSON.stringify({ ...marker, deployed_commit: commit }), { mode: 0o600 });
  }

  type Updated = Awaited<ReturnType<typeof updatedAssistant>>;

  /** Each refusal's case: what it changes on the updated assistant, and what it then says. */
  const UNAVAILABLE: ReadonlyArray<
    readonly [string, (updated: Updated) => Promise<void> | void, (updated: Updated) => string]
  > = [
    [
      'its live checkout runs a release the registry does not name',
      ({ runtime }) => markAt(runtime.checkout_realpath, 'c'.repeat(40)),
      ({ host, runtime }) =>
        `Assistant ${runtime.instance_id} runs ${'c'.repeat(12)}, and its kept release is ${host.first.slice(0, 12)}, so there is nothing to roll back to.`,
    ],
    [
      'the release it keeps is the one it runs',
      async ({ host, runtime, next }) => {
        const id = runtime.instance_id;
        const manifest = path.join(host.paths.releaseRoot(id, 'previous'), 'release-manifest.json');
        const kept = JSON.parse(await readFile(manifest, 'utf8')) as { release: Record<string, unknown> };
        await writeFile(
          manifest,
          JSON.stringify({ ...kept, release: { ...kept.release, deployed_commit: next.commit } }),
          { mode: 0o600 },
        );
        await markAt(host.paths.releaseCheckoutRoot(id, 'previous'), next.commit);
      },
      ({ runtime, next }) =>
        `Assistant ${runtime.instance_id} runs ${next.commit.slice(0, 12)}, and its kept release is ${next.commit.slice(0, 12)}, so there is nothing to roll back to.`,
    ],
    ...(['latest', 'previous'] as const).map(
      (tag) =>
        [
          `its agent image :${tag} is gone`,
          ({ runtime, state }: Updated) => {
            state.tags.delete(`${imageBase(runtime)}:${tag}`);
          },
          ({ host, runtime }: Updated) =>
            `Assistant ${runtime.instance_id}'s agent image ${imageBase(runtime)}:${tag} is missing, so dogfood ${host.first.slice(0, 12)} cannot run again.`,
        ] as const,
    ),
  ];

  it.each(UNAVAILABLE)('refuses when %s, before changing anything', async (_label, arrange, refusal) => {
    const updated = await updatedAssistant();
    const { host, runtime, next, state } = updated;
    const id = runtime.instance_id;
    await arrange(updated);
    const before = await snapshot(host.paths.instanceRoot(id));
    const registered = await getInstanceReservation(host.paths, id);
    const tags = new Map(state.tags);
    const events = state.events.length;
    const { run, err } = cli(host, state, next, runtime);

    expect(await run(['rollback', '--id', id, '--yes'])).toBe(1);

    expect(err.join('\n')).toContain(refusal(updated));
    expect(state.events.slice(events)).toEqual([]);
    expect(state.running).toBe(true);
    expect(state.tags).toEqual(tags);
    expect(await getInstanceReservation(host.paths, id)).toEqual(registered);
    expect(await readOperationRecord(host.paths, id)).toBeUndefined();
    expect(await snapshot(host.paths.instanceRoot(id))).toEqual(before);
  });

  it('refuses a kept release whose checkout is at another commit than its manifest names, changing nothing', async () => {
    const { host, runtime, next, state } = await updatedAssistant();
    const id = runtime.instance_id;
    const checkout = host.paths.releaseCheckoutRoot(id, 'previous');
    await markAt(checkout, 'c'.repeat(40));
    const before = await snapshot(host.paths.instanceRoot(id));
    const events = state.events.length;
    const { run, err } = cli(host, state, next, runtime);

    expect(await run(['rollback', '--id', id, '--yes'])).toBe(1);

    expect(err.join('\n')).toContain(
      `The release kept in ${checkout} is at ${'c'.repeat(12)}, not the ${host.first.slice(0, 12)} its manifest names.`,
    );
    await expect(readKeptPreviousRelease(host.paths, id)).rejects.toMatchObject({ code: 'invalid_kept_release' });
    expect(state.events.slice(events)).toEqual([]);
    expect(await readOperationRecord(host.paths, id)).toBeUndefined();
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
  ['after the swap, while holding the images it moves', (state) => (state.hangAt = 'hold'), 'swapped'],
  ['after the swap, while moving images', (state) => (state.hangAt = 'retag'), 'swapped'],
  ['after the start, while verifying', (state) => (state.hangAt = 'verify'), 'started'],
  ['once recorded, while rebuilding group images', (state) => (state.hangAt = 'rebuild'), 'recorded'],
  ['once recorded, while dropping the :previous tag it leaves', (state) => (state.hangAt = 'untag'), 'recorded'],
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

  it.each(['verified', 'committed to the registry'] as const)(
    'killed once %s, is recorded and finished by rollback without verifying again',
    async (point) => {
      const { host, runtime, next, state, images } = await updatedAssistant();
      const id = runtime.instance_id;
      state.hangAt = 'verify';
      await killDuringRollback(host, runtime, state, next);
      // The process got past verification and recorded it, then (for the second case) moved the registry too.
      const operation = await acquireInstanceOperation(host.paths, id, { command: 'rollback' });
      if (!operation) throw new Error('The test instance operation was busy');
      try {
        await advanceOperation(operation, 'verified');
      } finally {
        operation.release();
      }
      if (point === 'committed to the registry') {
        await swapInstanceRelease(host.paths, id, release(host, next.commit), release(host, host.first));
      }
      delete state.hangAt;
      const checks = state.healthWaits.length;

      expect(await cli(host, state, next, runtime).run(['rollback', '--id', id, '--yes'])).toBe(0);

      expect(state.healthWaits).toHaveLength(checks);
      await expectRolledBack(host, runtime, next, state, images.first);
    },
  );

  it('stands by a rollback the registry committed when the record write after it fails, and rollback settles it', async () => {
    const { host, runtime, next, state, images } = await updatedAssistant();
    const id = runtime.instance_id;
    const live = runtime.checkout_realpath;
    await converse(runtime, 'm2');
    const { run, err, out } = cli(host, state, next, runtime);
    failing.recordedWrite = true;

    expect(await run(['rollback', '--id', id, '--yes'])).toBe(1);

    // The write failed once the registry named the restored release, and nothing went back to the one it left.
    expect(failing.recordedWrite).toBe(false);
    expect(err.join('\n')).toContain(
      `Assistant ${id} runs dogfood ${host.first.slice(0, 12)}: its rollback was committed before that failed, so it stands, and gws-ea rollback --id ${id} finishes recording it.`,
    );
    expect(releaseOf(await getInstanceReservation(host.paths, id))).toEqual(release(host, host.first));
    expect(commitOf(live)).toBe(host.first);
    expect(await receiptCommit(instanceMarkerFile(live))).toBe(host.first);
    expect(await receiptCommit(host.paths.releasePreflightFile(id))).toBe(host.first);
    expect(state.tags.get(`${imageBase(runtime)}:latest`)).toBe(images.first);
    expect(state.running).toBe(true);
    expect((await readOperationRecord(host.paths, id))?.phase).toBe('verified');
    const checks = state.healthWaits.length;

    expect(await run(['rollback', '--id', id, '--yes'])).toBe(0);

    // The rerun settled the record through its gate and ran the follow-ups, without verifying again.
    expect(state.healthWaits).toHaveLength(checks);
    await expectRolledBack(host, runtime, next, state, images.first);
    expect(messages(live)).toEqual(['m1', 'm2']);
    expect(out).toContain(`Assistant ${id} runs dogfood ${host.first.slice(0, 12)}; its rollback is finished.`);
  });

  it.each([
    ['receives a message, and carries it', false],
    ['also adds a session column, and restores the snapshot the schema now calls for', true],
  ] as const)('re-stops a host the OS started at stopped that %s', async (_label, addsColumn) => {
    const { host, runtime, next, state, images } = await updatedAssistant();
    const id = runtime.instance_id;
    const live = runtime.checkout_realpath;
    state.hangAt = 'stamp';
    await killDuringRollback(host, runtime, state, next);
    expect((await readOperationRecord(host.paths, id))?.phase).toBe('stopped');
    // The OS starts the release being left again (RunAtLoad), and it receives a message.
    state.running = true;
    await converse(runtime, 'm2');
    if (addsColumn) addSessionColumn(live);
    delete state.hangAt;
    const stops = state.serviceCalls.filter((call) => call.startsWith('stop')).length;
    const asked: RollbackPreview[] = [];
    const { run } = cli(host, state, next, runtime, {
      confirmRollback: async (preview) => {
        asked.push(preview);
        return true;
      },
    });

    expect(await run(['rollback', '--id', id])).toBe(0);

    expect(state.serviceCalls.filter((call) => call.startsWith('stop')).length).toBeGreaterThan(stops);
    await expectRolledBack(host, runtime, next, state, images.first);
    // The mode is decided from the schema as the second stop found it, not as the first recorded it (KTD5).
    if (addsColumn) {
      expect(asked.map((preview) => preview.reason)).toEqual(['session_schema']);
      expect(messages(live)).toEqual(['m1']);
      const columns = rows(path.join(live, SESSION, 'inbound.db'), 'messages_in');
      expect(Object.keys(columns[0] as object)).not.toContain('routed_by');
    } else {
      expect(asked).toEqual([]);
      expect(messages(live)).toEqual(['m1', 'm2']);
    }
  });

  it('carries again what a host the OS started records once killed at the first rename, before the live checkout moved', async () => {
    const { host, runtime, next, state, images } = await updatedAssistant();
    const id = runtime.instance_id;
    await converse(runtime, 'm2');
    state.renameKill = 1;
    await killDuringRollback(host, runtime, state, next);
    expect(await readOperationRecord(host.paths, id)).toMatchObject({ phase: 'swapping', mode: 'code_only' });
    // The OS starts the release being left again from the live path, which the swap had not moved; it receives a message.
    state.running = true;
    await converse(runtime, 'm3');
    delete state.renameKill;

    expect(await cli(host, state, next, runtime).run(['rollback', '--id', id, '--yes'])).toBe(0);

    await expectRolledBack(host, runtime, next, state, images.first);
    expect(messages(runtime.checkout_realpath)).toEqual(['m1', 'm2', 'm3']);
  });

  it('decides and asks again once killed at the first rename, counting what a host the OS started recorded since', async () => {
    const { host, runtime, next, state, images } = await migratedAssistant();
    const id = runtime.instance_id;
    state.renameKill = 1;
    await killDuringRollback(host, runtime, state, next);
    expect(await readOperationRecord(host.paths, id)).toMatchObject({ phase: 'swapping', mode: 'snapshot' });
    state.running = true;
    await converse(runtime, 'm3');
    delete state.renameKill;
    const asked: RollbackPreview[] = [];
    const { run } = cli(host, state, next, runtime, {
      confirmRollback: async (preview) => {
        asked.push(preview);
        return true;
      },
    });

    expect(await run(['rollback', '--id', id])).toBe(0);

    expect(asked.map((preview) => preview.discarded.inbound)).toEqual([{ count: 2, ids: ['m2', 'm3'] }]);
    await expectRolledBack(host, runtime, next, state, images.first);
    expect(messages(runtime.checkout_realpath)).toEqual(['m1']);
    expect(messages(host.paths.releaseCheckoutRoot(id, 'outgoing'))).toEqual(['m1', 'm2', 'm3']);
  });

  it('refuses the snapshot it decides again once killed at the first rename when nobody can confirm it', async () => {
    const { host, runtime, next, state } = await migratedAssistant();
    const id = runtime.instance_id;
    const previous = host.paths.releaseCheckoutRoot(id, 'previous');
    const kept = await contents(previous);
    state.renameKill = 1;
    await killDuringRollback(host, runtime, state, next);
    state.running = true;
    await converse(runtime, 'm3');
    delete state.renameKill;
    const { run, out, err } = cli(host, state, next, runtime);

    expect(await run(['rollback', '--id', id])).toBe(1);

    expect(out.join('\n')).toContain('Inbound messages lost: 2 (m2, m3)');
    expect(err.join('\n')).toContain('pass --yes');
    // Given up as before its swap: the release it would leave runs on, and the kept release is as its update left it.
    expect(await readOperationRecord(host.paths, id)).toBeUndefined();
    expect(commitOf(runtime.checkout_realpath)).toBe(next.commit);
    expect(messages(runtime.checkout_realpath)).toEqual(['m1', 'm2', 'm3']);
    expect(await contents(previous)).toEqual(kept);
    expect(state.running).toBe(true);
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
    // The image the second update displaced from `:previous` is held, under a tag of the assistant's own, until its
    // record's cleanup releases it.
    expect(state.tags.get(heldImageTag(base, oldest))).toBe(oldest);
    expect([...state.tags.keys()].filter(isHold)).toEqual([heldImageTag(base, oldest)]);
    expect(record?.follow_ups).toContainEqual({ kind: 'delete_image', image_id: oldest });
    // Its cleanup never ran, so the release it set aside at its swap is still kept beside the previous one.
    expect(await exists(host.paths.releaseRoot(runtime.instance_id, 'superseded'))).toBe(true);
    expect(record?.follow_ups).toContainEqual({ kind: 'delete_release', release: 'superseded_previous' });
    state.rebuildFails = false;
    return { host, runtime, first, second, state, oldest };
  }

  it('takes the update over, carrying every image deletion it planned, and leaves no image or set-aside release behind', async () => {
    const { host, runtime, first, second, state } = await pendingUpdate();
    const id = runtime.instance_id;

    expect(await cli(host, state, second, runtime).run(['rollback', '--id', id, '--yes'])).toBe(0);

    expect(commitOf(runtime.checkout_realpath)).toBe(first.commit);
    expect(await readOperationRecord(host.paths, id)).toBeUndefined();
    expect(repositoryImages(state, imageBase(runtime)).untagged).toEqual([]);
    expect([...state.tags.keys()].filter(isHold)).toEqual([]);
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
    expect([...state.tags.keys()].filter(isHold)).toEqual([]);
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
    state.tags.set(`${imageBase(b)}:previous`, bLatest);
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
    expect(state.tags.get(`${imageBase(b)}:previous`)).toBe(bLatest);
  });

  it('keeps the agent image another assistant runs when one of two sharing it rolls back', async () => {
    const host = await machine();
    const b = await assistant(host, 37_101);
    const { runtime: a, next, state, images } = await updatedAssistant({}, 37_001, host);
    for (const tag of [`${imageBase(b)}:latest`, `${imageBase(b)}:ag-research`]) {
      const id = imageId();
      state.tags.set(tag, id);
      state.ids.add(id);
    }
    // B, updated to the same release, runs the image A's update built, under its own tags.
    expect(await cli(host, state, next, b).run(['update', '--id', b.instance_id, '--yes'])).toBe(0);
    expect(state.tags.get(`${imageBase(b)}:latest`)).toBe(images.next);

    expect(await cli(host, state, next, a).run(['rollback', '--id', a.instance_id, '--yes'])).toBe(0);

    // A runs its first image again and keeps no tag on the shared one, which B still runs, whole.
    expect(state.tags.get(`${imageBase(a)}:latest`)).toBe(images.first);
    expect([...state.tags].filter(([, id]) => id === images.next).map(([tag]) => tag)).toEqual([
      `${imageBase(b)}:latest`,
    ]);
    expect(state.ids.has(images.next)).toBe(true);
    expect(state.labels.get(images.next)).toBe(releaseAgentImageKey(next));
    expect(repositoryImages(state, imageBase(a)).untagged).toEqual([]);
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

  it('shows the files an agent named with their control characters escaped, the summary keeping each name exactly', async () => {
    const root = await temporaryRoot('gws-ea-discard-');
    const [snapshotRoot, currentRoot] = [path.join(root, 'snapshot'), path.join(root, 'current')];
    for (const checkout of [snapshotRoot, currentRoot]) {
      mkdirSync(path.join(checkout, 'data'), { recursive: true });
      mkdirSync(path.join(checkout, 'groups', 'main'), { recursive: true });
      const central = new Database(path.join(checkout, 'data', 'v2.db'));
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
        keptAt: path.join(root, 'outgoing'),
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
