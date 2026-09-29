/**
 * `update` stages the tool's release beside an assistant built as create
 * leaves it: a registry reservation and completed journal, a Git checkout
 * detached at its release with its marker, runtime, and `.env`, the release
 * receipt, the OneCLI Compose file, and a central database the host left
 * closed. It then stops the assistant, carries its state across, swaps the
 * checkouts, starts and verifies the release, and records it. Git, SQLite,
 * and the files are real; the service manager, Docker, `ps`, `lsof`, the
 * release's install, build, migration, and tripwire scripts, the host's
 * status and listener, OneCLI, and `ncl` are faked at their boundaries.
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { lstat, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ADDED_MIGRATION,
  applying,
  assistant,
  cli,
  converse,
  CREDENTIAL,
  DEPLOYED_GATEWAY,
  dependencies,
  DOCKER,
  exists,
  FAILING_MIGRATION,
  git,
  IMAGE_BYTES,
  imageBase,
  imageId,
  killDuringCutover,
  LIVE_MIGRATIONS,
  liveState,
  LOCKFILE,
  machine,
  MAIN_BASELINE,
  MAIN_FOLDER,
  mainTemplate,
  MEMORY,
  messages,
  nextRelease,
  ONECLI_CLI,
  PERSONA,
  PROCEDURE,
  PROVIDER_SETUP,
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
  temporaryRoot,
  world,
  write,
  type Machine,
  type Release,
  type World,
} from './cutover-fixture.js';
import { readKeptReleaseManifest } from './cutover.js';
import { acquireInstanceOperation } from './journal.js';
import {
  advanceOperation,
  beginOperation,
  inspectOperation,
  readOperationRecord,
  type OperationPhase,
} from './operation.js';
import { instanceMarkerFile } from './paths.js';
import type { SanitizedCommandRunner } from './process.js';
import { getInstanceReservation, swapInstanceRelease } from './registry.js';
import type { InstanceRuntimeConfig } from './service.js';
import { GwsEaError, PROVISION_STEPS, releaseOf, type ReleaseCoordinates } from './types.js';
import {
  dryRunReleaseMigrations,
  prepareUpdate,
  resolveUpdateIntent,
  updatePreviewLines,
  type StagedUpdate,
  type UpdateDependencies,
} from './update.js';
import { readCentralMigrations } from './verify.js';

afterEach(removeTemporaryRoots);

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

/**
 * Start staging and abandon it at `state.hangAt`, as if the process were
 * killed there: nothing after that point runs, cleanup included, and the
 * instance lock goes with the process.
 */
async function killDuringStaging(host: Machine, runtime: InstanceRuntimeConfig, state: World, release: Release) {
  const deps = dependencies(state, release, runtime);
  const intent = await resolveUpdateIntent(host.paths, { instanceId: runtime.instance_id }, deps);
  const operation = await acquireInstanceOperation(host.paths, runtime.instance_id, {
    command: 'update',
    target: intent.target,
  });
  if (!operation) throw new Error('The test instance operation was busy');
  const reached = new Promise<void>((resolve) => (state.reached = resolve));
  const abandoned = prepareUpdate(operation, intent, deps);
  await Promise.race([reached, abandoned]);
  operation.release();
}

/** Each case clones, fetches, and stages real Git repositories, which a loaded machine slows. */
const GIT_HEAVY = { timeout: 60_000 } as const;

describe('staging an update while the assistant serves', GIT_HEAVY, () => {
  it("stages the tool's release beside the running assistant and previews what the update changes", async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host);
    const state = world(runtime, applying(ADDED_MIGRATION));
    const before = await liveState(host, runtime);

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
      mainTemplate: { kind: 'unchanged' },
    });
    // It served throughout: the service was only looked at.
    expect(state.running).toBe(true);
    expect(state.serviceCalls).toEqual([`detect ${runtime.install_id}`]);
    expect(await liveState(host, runtime)).toEqual(before);

    // The release is staged in next/, preflighted there, with its receipt beside it.
    const checkout = host.paths.releaseCheckoutRoot(id, 'next');
    expect(staged.checkoutRoot).toBe(checkout);
    expect(git(checkout, 'rev-parse', 'HEAD')).toBe(next.commit);
    expect(state.preflights).toEqual([
      {
        checkoutRoot: checkout,
        provider: 'claude',
        providerCapabilityDigest: PROVIDER_SETUP.capabilityDigest,
        providerCredential: CREDENTIAL,
        onecliCliPath: ONECLI_CLI,
      },
    ]);
    expect(JSON.parse(await readFile(host.paths.releasePreflightFile(id, 'next'), 'utf8'))).toMatchObject({
      instance_id: id,
      deployed_commit: next.commit,
      provider: 'claude',
    });
    // The agent image was built from the staged checkout as :next, with the instance's own .env and identity.
    expect(await readFile(path.join(checkout, '.env'), 'utf8')).toBe(
      await readFile(path.join(runtime.checkout_realpath, '.env'), 'utf8'),
    );
    const build = state.commands.find((command) => command.command === 'bash')!;
    expect(build).toMatchObject({ args: [path.join(checkout, 'container', 'build.sh'), 'next'], cwd: checkout });
    expect(build.env).toMatchObject({
      NANOCLAW_INSTALL_ID: runtime.install_id,
      DOCKER_HOST: DOCKER,
      HOME: runtime.home_directory,
    });
    expect(new Set(state.tags.keys())).toEqual(
      new Set([
        `${imageBase(runtime)}:latest`,
        `${imageBase(runtime)}:ag-research`,
        `${imageBase(runtime)}:next`,
        DEPLOYED_GATEWAY,
        RELEASE_GATEWAY,
      ]),
    );
    // Nothing is recorded until the operator confirms.
    expect(await readOperationRecord(host.paths, id)).toBeUndefined();
    expect(staged.manifest).toEqual({ central_migrations: [...LIVE_MIGRATIONS], session_tables: {} });

    const preview = updatePreviewLines(staged.preview).join('\n');
    expect(preview).toContain(`dogfood ${host.first.slice(0, 12)}`);
    expect(preview).toContain(`dogfood ${next.commit.slice(0, 12)}`);
    expect(preview).toContain(ADDED_MIGRATION);
    expect(preview).toContain(`${DEPLOYED_GATEWAY} → ${RELEASE_GATEWAY}`);
    expect(preview).toContain('research (ag-research)');
    expect(preview).toContain("Main's template: unchanged in this release");
    expect(preview).toMatch(/failure after the swap may restore the pre-update snapshot/u);
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
    const state = world(runtime);

    const staged = await stage(host, runtime, dependencies(state, next, runtime));

    expect(staged.preview).toMatchObject({ ...expected, migrations: [] });
    const preview = updatePreviewLines(staged.preview).join('\n');
    const snapshotWarning = /failure after the swap may restore the pre-update snapshot/u;
    const staleWarning = /research .*previous agent-runner dependencies/u;
    if (expected.sessionSchemaChanged) expect(preview).toMatch(snapshotWarning);
    else expect(preview).not.toMatch(snapshotWarning);
    if (expected.agentRunnerLockChanged) expect(preview).toMatch(staleWarning);
    else expect(preview).not.toMatch(staleWarning);
  });

  it('removes the staging and changes nothing live when the agent image build fails', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host);
    const state = world(runtime);
    state.buildFails = true;
    const before = await liveState(host, runtime);
    const tags = new Map(state.tags);

    await expect(stage(host, runtime, dependencies(state, next, runtime))).rejects.toMatchObject({
      code: 'command_failed',
    });

    expect(await exists(host.paths.releaseRoot(runtime.instance_id, 'next'))).toBe(false);
    expect(state.tags).toEqual(tags);
    expect(await liveState(host, runtime)).toEqual(before);
    expect(state.running).toBe(true);
    expect(await readOperationRecord(host.paths, runtime.instance_id)).toBeUndefined();
  });

  it('refuses a release whose migrations fail on a copy of the database, before building anything, and names them', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host);
    const state = world(runtime, (file) => {
      applying(ADDED_MIGRATION)(file);
      throw new GwsEaError('command_failed', 'pnpm exited with code 1', {
        details: { exitCode: 1, stderrTail: `Error: migration ${FAILING_MIGRATION} left FK violations` },
      });
    });
    const before = await liveState(host, runtime);

    const refusal = stage(host, runtime, dependencies(state, next, runtime));

    await expect(refusal).rejects.toMatchObject({
      code: 'migration_dry_run_failed',
      message: expect.stringContaining(ADDED_MIGRATION),
      details: { stderrTail: expect.stringContaining(FAILING_MIGRATION), applied: [ADDED_MIGRATION] },
    });
    expect(state.commands.some((command) => command.command === 'bash')).toBe(false);
    expect(await exists(host.paths.releaseRoot(runtime.instance_id, 'next'))).toBe(false);
    expect(await liveState(host, runtime)).toEqual(before);
  });

  it('refuses a deployment checkout with tracked edits, naming them, and stages nothing', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host);
    await write(runtime.checkout_realpath, 'release.txt', 'patched in place\n');
    const state = world(runtime);

    await expect(stage(host, runtime, dependencies(state, next, runtime))).rejects.toMatchObject({
      code: 'deployment_checkout_modified',
      message: expect.stringContaining('release.txt'),
    });

    expect(await exists(host.paths.releaseRoot(runtime.instance_id, 'next'))).toBe(false);
    expect(state.preflights).toEqual([]);
  });

  it('refuses before staging when the disk cannot hold the staged release, a copy of its state, and a new image', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host);
    const state = world(runtime);
    state.freeBytes = IMAGE_BYTES;

    const refusal = stage(host, runtime, dependencies(state, next, runtime));

    await expect(refusal).rejects.toMatchObject({ code: 'insufficient_disk' });
    await expect(refusal).rejects.toSatisfy(
      (error: GwsEaError) => typeof error.details?.needed === 'number' && error.details.needed > IMAGE_BYTES,
    );
    expect(await exists(host.paths.releaseRoot(runtime.instance_id, 'next'))).toBe(false);
    expect(state.preflights).toEqual([]);
  });

  it('refuses a stopped assistant, naming gws-ea start, and stages nothing', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host);
    const state = world(runtime);
    state.running = false;

    await expect(stage(host, runtime, dependencies(state, next, runtime))).rejects.toMatchObject({
      code: 'host_not_running',
      message: expect.stringContaining(`gws-ea start --id ${runtime.instance_id}`),
    });

    expect(await exists(host.paths.releaseRoot(runtime.instance_id, 'next'))).toBe(false);
  });

  it.each(['build', 'migrate'] as const)(
    'leaves staging killed during the %s behind for status to report, and the next update removes it and stages cleanly',
    async (step) => {
      const host = await machine();
      const runtime = await assistant(host);
      const next = await nextRelease(host);
      const killed = world(runtime, applying(ADDED_MIGRATION));
      killed.hangAt = step;

      await killDuringStaging(host, runtime, killed, next);

      const reservation = await getInstanceReservation(host.paths, runtime.instance_id);
      expect(await inspectOperation(host.paths, reservation)).toEqual({ state: 'none', abandonedStaging: true });
      const leftover = path.join(host.paths.releaseRoot(runtime.instance_id, 'next'), 'left-by-the-killed-run');
      await writeFile(leftover, '');

      const state = world(runtime, applying(ADDED_MIGRATION));
      for (const [name, id] of killed.tags) {
        state.tags.set(name, id);
        state.ids.add(id);
      }
      const staged = await stage(host, runtime, dependencies(state, next, runtime));

      // The :next image a killed build left is removed with next/, before anything is fetched again.
      const nextImage = `${imageBase(runtime)}:next`;
      const docker = (args: string) =>
        state.commands.findIndex((command) => command.command === 'docker' && command.args.join(' ') === args);
      const fetch = state.commands.findIndex((command) => command.command === 'git' && command.args[0] === 'fetch');
      expect(killed.tags.has(nextImage)).toBe(step === 'build');
      expect(docker(`image ls --quiet ${nextImage}`)).toBeGreaterThanOrEqual(0);
      expect(docker(`image ls --quiet ${nextImage}`)).toBeLessThan(fetch);
      if (step === 'build') expect(docker(`image rm ${nextImage}`)).toBeLessThan(fetch);
      expect(docker(`image rm ${nextImage}`) >= 0).toBe(step === 'build');
      expect(await exists(leftover)).toBe(false);
      expect(staged.preview.migrations).toEqual([ADDED_MIGRATION]);
      expect(git(staged.checkoutRoot, 'rev-parse', 'HEAD')).toBe(next.commit);
      expect(await inspectOperation(host.paths, reservation)).toEqual({ state: 'none', abandonedStaging: true });
    },
  );

  it('refuses an assistant whose create has not finished, naming resume', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host);
    // A journal missing its last step: create never finished.
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

describe("the dry run of a release's migrations", () => {
  /** A live checkout with the host's closed database, and a staged checkout beside it. */
  async function checkouts() {
    const root = await temporaryRoot('gws-ea-dry-run-');
    const live = path.join(root, 'nanoclaw');
    const staged = path.join(root, 'next', 'nanoclaw');
    await mkdir(path.join(live, 'data'), { recursive: true });
    await mkdir(path.join(staged, 'data'), { recursive: true, mode: 0o700 });
    const database = new Database(path.join(live, 'data', 'v2.db'));
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
    return { root, live, staged };
  }

  /** The release's migration script, standing in: it records where it ran and what the database held, then migrates it. */
  function migrationScript(seen: Array<{ cwd: string; migrations: readonly string[] }>): SanitizedCommandRunner {
    return async (spec) => {
      if (spec.command !== 'pnpm' || spec.args.join(' ') !== 'run migrate') throw new Error('unexpected command');
      const database = path.join(spec.cwd, 'data', 'v2.db');
      seen.push({ cwd: spec.cwd, migrations: readCentralMigrations(spec.cwd) });
      applying(ADDED_MIGRATION)(database);
      return { stdout: '', stderr: '' };
    };
  }

  it('runs on a copy in the staged data alone, writing nothing else and leaving the live migrations as they were', async () => {
    const { root, live, staged } = await checkouts();
    const before = await snapshot(root, [path.join(staged, 'data')]);
    const seen: Array<{ cwd: string; migrations: readonly string[] }> = [];

    await expect(
      dryRunReleaseMigrations(
        { liveCheckout: live, liveMigrations: LIVE_MIGRATIONS, stagedCheckout: staged },
        migrationScript(seen),
        {},
      ),
    ).resolves.toEqual([ADDED_MIGRATION]);

    // The script ran from the staged checkout, on a copy holding everything the live database records.
    expect(seen).toEqual([{ cwd: staged, migrations: [...LIVE_MIGRATIONS] }]);
    expect(readCentralMigrations(staged)).toEqual([...LIVE_MIGRATIONS, ADDED_MIGRATION]);
    expect(readCentralMigrations(live)).toEqual([...LIVE_MIGRATIONS]);
    expect(await snapshot(root, [path.join(staged, 'data')])).toEqual(before);
    expect((await lstat(path.join(staged, 'data', 'v2.db'))).mode & 0o777).toBe(0o600);
  });

  it.each([
    ["the staged checkout's data is a link to the live data", 'data'],
    ['the staged checkout is a link to the live checkout', 'checkout'],
    ['the staged checkout is a link to a directory elsewhere', 'elsewhere'],
  ] as const)('refuses before running or writing anything when %s', async (_label, linked) => {
    const { root, live, staged } = await checkouts();
    const elsewhere = path.join(root, 'elsewhere');
    await mkdir(elsewhere);
    if (linked === 'data') {
      await rm(path.join(staged, 'data'), { recursive: true });
      await symlink(path.join(live, 'data'), path.join(staged, 'data'));
    } else {
      await rm(staged, { recursive: true });
      await symlink(linked === 'checkout' ? live : elsewhere, staged);
    }
    const resolved = path.join(linked === 'elsewhere' ? elsewhere : live, 'data', 'v2.db');
    const before = await snapshot(root);
    const seen: Array<{ cwd: string; migrations: readonly string[] }> = [];

    await expect(
      dryRunReleaseMigrations(
        { liveCheckout: live, liveMigrations: LIVE_MIGRATIONS, stagedCheckout: staged },
        migrationScript(seen),
        {},
      ),
    ).rejects.toMatchObject({
      code: 'unsafe_dry_run',
      message: expect.stringContaining(
        `would run against ${resolved}, outside the staged checkout's ${path.join(staged, 'data')}`,
      ),
    });

    expect(seen).toEqual([]);
    expect(await snapshot(root)).toEqual(before);
  });

  it('refuses before running when the staged checkout already holds a database where the copy goes', async () => {
    const { live, staged } = await checkouts();
    await writeFile(path.join(staged, 'data', 'v2.db'), 'a database the release shipped\n');
    const seen: Array<{ cwd: string; migrations: readonly string[] }> = [];

    await expect(
      dryRunReleaseMigrations(
        { liveCheckout: live, liveMigrations: LIVE_MIGRATIONS, stagedCheckout: staged },
        migrationScript(seen),
        {},
      ),
    ).rejects.toMatchObject({ code: 'unsafe_dry_run', message: expect.stringContaining('already holds a database') });

    expect(seen).toEqual([]);
    expect(await readFile(path.join(staged, 'data', 'v2.db'), 'utf8')).toBe('a database the release shipped\n');
  });

  it('refuses when the live migrations changed while the dry run ran', async () => {
    const { live, staged } = await checkouts();
    const runLive: SanitizedCommandRunner = async () => {
      applying(ADDED_MIGRATION)(path.join(live, 'data', 'v2.db'));
      return { stdout: '', stderr: '' };
    };

    await expect(
      dryRunReleaseMigrations(
        { liveCheckout: live, liveMigrations: LIVE_MIGRATIONS, stagedCheckout: staged },
        runLive,
        {},
      ),
    ).rejects.toMatchObject({ code: 'live_schema_changed' });
  });
});

/** Leave an update to `to` open, as a cutover interrupted after its stop would. */
async function openUpdate(host: Machine, runtime: InstanceRuntimeConfig, to: ReleaseCoordinates): Promise<void> {
  const operation = await acquireInstanceOperation(host.paths, runtime.instance_id, { command: 'update', target: to });
  if (!operation) throw new Error('The test instance operation was busy');
  try {
    await beginOperation(operation, { kind: 'update', from: release(host, host.first), to });
    await advanceOperation(operation, 'stopped', { stop: { at: '2026-09-28T10:00:00.000Z', graceful: true } });
  } finally {
    operation.release();
  }
}

/**
 * The assistant once an update from the machine's first release to `to` is
 * recorded and finished: every record names `to`, the previous release is
 * kept whole, `:latest` is the image the update built and `:previous` the
 * one it ran, and nothing of the update is left open.
 */
async function expectUpdated(host: Machine, runtime: InstanceRuntimeConfig, to: Release, state: World, ran: string) {
  const id = runtime.instance_id;
  const live = runtime.checkout_realpath;
  const previous = host.paths.releaseCheckoutRoot(id, 'previous');
  expect(releaseOf(await getInstanceReservation(host.paths, id))).toEqual(release(host, to.commit));
  expect(git(live, 'rev-parse', 'HEAD')).toBe(to.commit);
  expect(git(live, 'status', '--porcelain', '--untracked-files=all')).toBe('');
  expect(await receiptCommit(instanceMarkerFile(live))).toBe(to.commit);
  expect(await runtimeCommit(live)).toBe(to.commit);
  expect(await receiptCommit(host.paths.releasePreflightFile(id))).toBe(to.commit);
  // The tripwire was stamped by the release's own script, in its checkout, for its own commit.
  expect(JSON.parse(await readFile(path.join(live, 'data', 'upgrade-state.json'), 'utf8'))).toEqual({
    commit: to.commit,
    via: 'gws-ea',
  });
  expect(git(previous, 'rev-parse', 'HEAD')).toBe(host.first);
  expect(await receiptCommit(instanceMarkerFile(previous))).toBe(host.first);
  expect(await runtimeCommit(previous)).toBe(host.first);
  expect(await receiptCommit(host.paths.releasePreflightFile(id, 'previous'))).toBe(host.first);
  expect(await readOperationRecord(host.paths, id)).toBeUndefined();
  expect(await exists(host.paths.releaseRoot(id, 'next'))).toBe(false);
  const base = imageBase(runtime);
  expect(state.tags.get(`${base}:previous`)).toBe(ran);
  expect(state.tags.get(`${base}:latest`)).not.toBe(ran);
  expect(state.tags.has(`${base}:next`)).toBe(false);
  expect(repositoryImages(state, base).untagged).toEqual([]);
}

/** Where each kill leaves the update's record. */
const KILLS: ReadonlyArray<readonly [string, (state: World) => void, OperationPhase]> = [
  ['while stopping the host', (state) => (state.hangAt = 'stop'), 'staged'],
  ['after the stop, while carrying its state', (state) => (state.hangAt = 'stamp'), 'stopped'],
  ["at the swap's first rename", (state) => (state.renameKill = 1), 'swapping'],
  ['once the kept files moved into previous/', (state) => (state.renameKill = 2), 'swapping'],
  ['between the two checkout renames', (state) => (state.renameKill = 3), 'swapping'],
  ["before the new release's receipt is promoted", (state) => (state.renameKill = 4), 'swapping'],
  ['after the swap, while retagging images', (state) => (state.hangAt = 'retag'), 'swapped'],
  ['between the two image tags', (state) => (state.hangAt = 'second-tag'), 'swapped'],
  ['after the start, while verifying', (state) => (state.hangAt = 'verify'), 'started'],
  ['once recorded, while rebuilding group images', (state) => (state.hangAt = 'rebuild'), 'recorded'],
];

describe('an update killed during its cutover', GIT_HEAVY, () => {
  it.each(KILLS)(
    'killed %s, is reported by status, refuses conflicting commands, and is finished by update',
    async (_label, kill, phase) => {
      const host = await machine();
      const runtime = await assistant(host);
      await converse(runtime, 'm1', 'm2');
      const next = await nextRelease(host);
      const state = world(runtime);
      const ran = state.tags.get(`${imageBase(runtime)}:latest`)!;
      kill(state);

      await killDuringCutover(host, runtime, state, next);

      const id = runtime.instance_id;
      expect((await readOperationRecord(host.paths, id))?.phase).toBe(phase);
      const observed = await status(host, state, next, runtime);
      // Whichever release is live, its own receipt and Compose file say what OneCLI must run (KTD6, KTD17).
      if (phase !== 'swapping') expect(observed.probes.onecli).toEqual({ status: 'ok', reason: null });
      expect(observed.operation).toMatchObject(
        phase === 'recorded'
          ? {
              state: 'recorded',
              follow_ups: expect.arrayContaining([{ kind: 'rebuild_group_image', agent_group_id: 'ag-research' }]),
            }
          : {
              state: 'open',
              phase,
              continue_with: `gws-ea update --id ${id}`,
              revert_with: `gws-ea rollback --id ${id}`,
            },
      );

      delete state.hangAt;
      delete state.renameKill;
      const { run, err, out } = cli(host, state, next, runtime);
      if (phase === 'recorded') {
        // The release is recorded, so the gate is released: the assistant runs as usual.
        expect(await run(['start', '--id', id])).toBe(0);
      } else {
        expect(await run(['start', '--id', id])).toBe(1);
        expect(err.join('\n')).toContain(`Continue it with gws-ea update --id ${id}`);
        expect(err.join('\n')).toContain(`revert it with gws-ea rollback --id ${id}`);
      }

      expect(await run(['update', '--id', id, '--yes'])).toBe(0);

      // It went on from its record: nothing was staged twice.
      expect(state.preflights).toHaveLength(1);
      await expectUpdated(host, runtime, next, state, ran);
      expect(messages(runtime.checkout_realpath)).toEqual(['m1', 'm2']);
      expect(await readFile(path.join(runtime.checkout_realpath, MEMORY), 'utf8')).toContain('mornings');
      expect(state.running).toBe(true);
      const target = `dogfood ${next.commit.slice(0, 12)}`;
      expect(out).toContain(
        phase === 'recorded'
          ? `Assistant ${id} runs ${target}; its update is finished.`
          : `Assistant ${id} was updated to ${target}.`,
      );
    },
  );

  it.each(['verified', 'committed to the registry'] as const)(
    'killed once %s, is recorded and finished by update without verifying again',
    async (point) => {
      const host = await machine();
      const runtime = await assistant(host);
      const next = await nextRelease(host);
      const state = world(runtime);
      const ran = state.tags.get(`${imageBase(runtime)}:latest`)!;
      state.hangAt = 'verify';
      await killDuringCutover(host, runtime, state, next);
      // The process got past verification and recorded it, then (for the second case) moved the registry too.
      const id = runtime.instance_id;
      const operation = await acquireInstanceOperation(host.paths, id, {
        command: 'update',
        target: release(host, next.commit),
      });
      if (!operation) throw new Error('The test instance operation was busy');
      try {
        await advanceOperation(operation, 'verified');
      } finally {
        operation.release();
      }
      if (point === 'committed to the registry') {
        await swapInstanceRelease(host.paths, id, release(host, host.first), release(host, next.commit));
      }
      delete state.hangAt;
      const checks = state.healthWaits.length;

      expect(await cli(host, state, next, runtime).run(['update', '--id', id, '--yes'])).toBe(0);

      expect(state.healthWaits).toHaveLength(checks);
      await expectUpdated(host, runtime, next, state, ran);
    },
  );

  it('re-stops a host the OS started at stopped, and carries the state it wrote since', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    await converse(runtime, 'm1');
    const next = await nextRelease(host);
    const state = world(runtime);
    const ran = state.tags.get(`${imageBase(runtime)}:latest`)!;
    state.hangAt = 'stamp';
    await killDuringCutover(host, runtime, state, next);
    expect((await readOperationRecord(host.paths, runtime.instance_id))?.phase).toBe('stopped');

    // The OS starts the old host again (RunAtLoad at login), and it serves another message.
    state.running = true;
    await converse(runtime, 'm2');
    delete state.hangAt;
    const stops = state.serviceCalls.filter((call) => call.startsWith('stop')).length;
    const { run } = cli(host, state, next, runtime);

    expect(await run(['update', '--id', runtime.instance_id, '--yes'])).toBe(0);

    expect(state.serviceCalls.filter((call) => call.startsWith('stop')).length).toBe(stops + 1);
    await expectUpdated(host, runtime, next, state, ran);
    expect(messages(runtime.checkout_realpath)).toEqual(['m1', 'm2']);
    // The release kept for rollback is the state as the old host last left it.
    expect(messages(host.paths.releaseCheckoutRoot(runtime.instance_id, 'previous'))).toEqual(['m1', 'm2']);
  });

  it('stops a host the OS started at swapped before it moves any image, then starts the release again', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host);
    const state = world(runtime);
    const ran = state.tags.get(`${imageBase(runtime)}:latest`)!;
    state.hangAt = 'retag';
    await killDuringCutover(host, runtime, state, next);
    expect((await readOperationRecord(host.paths, runtime.instance_id))?.phase).toBe('swapped');

    // The OS starts the host, now from the new release's checkout, still on the old agent image.
    state.running = true;
    delete state.hangAt;
    state.events.length = 0;

    expect(await cli(host, state, next, runtime).run(['update', '--id', runtime.instance_id, '--yes'])).toBe(0);

    expect(state.events).toEqual(['stop running', 'tag', 'tag', 'start']);
    await expectUpdated(host, runtime, next, state, ran);
  });
});

describe('the cutover refuses to go on', GIT_HEAVY, () => {
  it("when the live database's migrations changed since staging, before recording the stop", async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host);
    const state = world(runtime, applying(ADDED_MIGRATION));
    state.hangAt = 'stop';
    await killDuringCutover(host, runtime, state, next);
    // Something migrated the live database while the update waited to stop it.
    applying(FAILING_MIGRATION)(path.join(runtime.checkout_realpath, 'data', 'v2.db'));
    delete state.hangAt;
    const { run, err } = cli(host, state, next, runtime);

    expect(await run(['update', '--id', runtime.instance_id, '--yes'])).toBe(1);

    expect(err.join('\n')).toContain(FAILING_MIGRATION);
    expect(err.join('\n')).toContain(`gws-ea rollback --id ${runtime.instance_id}`);
    expect((await readOperationRecord(host.paths, runtime.instance_id))?.phase).toBe('staged');
    expect(await exists(path.join(host.paths.releaseCheckoutRoot(runtime.instance_id, 'next'), SESSION))).toBe(false);
  });

  it('when anything still holds its data open, before copying or moving anything', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    await converse(runtime, 'm1');
    const next = await nextRelease(host);
    const state = world(runtime);
    const live = runtime.checkout_realpath;
    const before = await snapshot(live);
    // A leftover opener, idle: an operator's sqlite3 shell on a session database.
    state.openFiles = `p4242\ncsqlite3\nf5\nn${path.join(live, SESSION, 'inbound.db')}\n`;
    const { run, err } = cli(host, state, next, runtime);

    expect(await run(['update', '--id', runtime.instance_id, '--yes'])).toBe(1);

    const summary = err.join('\n');
    expect(summary).toContain(`sqlite3 (PID 4242) holds ${path.join(live, SESSION, 'inbound.db')}`);
    expect(summary).toContain(`gws-ea rollback --id ${runtime.instance_id}`);
    expect((await readOperationRecord(host.paths, runtime.instance_id))?.phase).toBe('staged');
    // Nothing was copied, settled, or moved.
    expect(await snapshot(live)).toEqual(before);
    const staged = host.paths.releaseCheckoutRoot(runtime.instance_id, 'next');
    expect(await exists(path.join(staged, SESSION))).toBe(false);
    expect(await exists(path.join(host.paths.releaseRoot(runtime.instance_id, 'next'), 'carrying'))).toBe(false);
    expect(await exists(host.paths.releaseRoot(runtime.instance_id, 'previous'))).toBe(false);
    expect(releaseOf(await getInstanceReservation(host.paths, runtime.instance_id))).toEqual(release(host, host.first));
  });

  it('when something opens its data after the carry, just before the first rename, moving nothing', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    await converse(runtime, 'm1');
    const next = await nextRelease(host);
    const state = world(runtime);
    const ran = state.tags.get(`${imageBase(runtime)}:latest`)!;
    const live = runtime.checkout_realpath;
    state.onStamp = () => {
      state.openFiles = `p5150\ncnode\nf9\nn${path.join(live, 'data', 'v2.db')}\n`;
    };
    const { run, err } = cli(host, state, next, runtime);

    expect(await run(['update', '--id', runtime.instance_id, '--yes'])).toBe(1);

    expect(err.join('\n')).toContain(`node (PID 5150) holds ${path.join(live, 'data', 'v2.db')}`);
    const id = runtime.instance_id;
    expect((await readOperationRecord(host.paths, id))?.phase).toBe('swapping');
    expect(git(live, 'rev-parse', 'HEAD')).toBe(host.first);
    expect(git(host.paths.releaseCheckoutRoot(id, 'next'), 'rev-parse', 'HEAD')).toBe(next.commit);
    expect(await exists(host.paths.releaseRoot(id, 'previous'))).toBe(false);

    // Once it lets go, the update goes on from its record.
    state.openFiles = '';
    delete state.onStamp;
    expect(await run(['update', '--id', id, '--yes'])).toBe(0);
    await expectUpdated(host, runtime, next, state, ran);
    expect(messages(live)).toEqual(['m1']);
  });

  it('when the host answers while the live checkout is not at the target, recording nothing and rolling back', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host);
    const state = world(runtime);
    // Something moved the live checkout off the release before the new host came up; the host still answers.
    let moved = false;
    state.onStart = (checkout) => {
      if (moved) return;
      moved = true;
      git(
        checkout,
        '-c',
        'user.name=T',
        '-c',
        'user.email=t@example.test',
        'commit',
        '--quiet',
        '--allow-empty',
        '-m',
        'x',
      );
    };
    const { run, err } = cli(host, state, next, runtime);

    expect(await run(['update', '--id', runtime.instance_id, '--yes'])).toBe(1);

    // The release was never recorded; the update was rolled back, only its code, since no schema moved.
    const summary = err.join('\n');
    expect(summary).toContain(`The update to dogfood ${next.commit.slice(0, 12)} stopped at started`);
    expect(summary).toContain('so it was rolled back');
    expect(await readOperationRecord(host.paths, runtime.instance_id)).toBeUndefined();
    expect(releaseOf(await getInstanceReservation(host.paths, runtime.instance_id))).toEqual(release(host, host.first));
    expect(git(runtime.checkout_realpath, 'rev-parse', 'HEAD')).toBe(host.first);
    expect(state.running).toBe(true);
  });
});

describe('gws-ea update', GIT_HEAVY, () => {
  it("switches the assistant to the tool's release, keeping every conversation, memory, and setting", async () => {
    const host = await machine();
    const runtime = await assistant(host);
    await converse(runtime, 'm1');
    const live = runtime.checkout_realpath;
    await write(live, 'data/circuit-breaker.json', '{"crashes":4}');
    const next = await nextRelease(host);
    const state = world(runtime, applying(ADDED_MIGRATION));
    const base = imageBase(runtime);
    const ran = state.tags.get(`${base}:latest`)!;
    const research = state.tags.get(`${base}:ag-research`)!;
    const before = await snapshot(live, [path.join(live, 'data', 'v2.db-shm'), path.join(live, 'data', 'v2.db-wal')]);
    const { run, out } = cli(host, state, next, runtime);

    expect(await run(['update', '--id', runtime.instance_id, '--yes'])).toBe(0);

    const id = runtime.instance_id;
    await expectUpdated(host, runtime, next, state, ran);
    const printed = out.join('\n');
    expect(printed).toContain(ADDED_MIGRATION);
    expect(out.at(-1)).toContain(`dogfood ${host.first.slice(0, 12)}`);
    expect(printed).toContain(`Assistant ${id} was updated to dogfood ${next.commit.slice(0, 12)}.`);
    // Conversations, memory, and settings came across; the old release's own records and crash count did not.
    expect(messages(live)).toEqual(['m1']);
    expect(await readFile(path.join(live, MEMORY), 'utf8')).toContain('mornings');
    expect(await readFile(path.join(live, '.env'), 'utf8')).toContain('INSTALL_CJK_FONTS=true');
    expect(await exists(path.join(live, 'data', 'circuit-breaker.json'))).toBe(false);
    // The previous release is the snapshot the stop left, untouched by the update.
    const previous = host.paths.releaseCheckoutRoot(id, 'previous');
    expect(
      await snapshot(previous, [path.join(previous, 'data', 'v2.db-shm'), path.join(previous, 'data', 'v2.db-wal')]),
    ).toEqual(before);
    // It keeps the files that release ran with: its Compose file and gws-ea's .env keys.
    const kept = path.join(host.paths.releaseRoot(id, 'previous'));
    expect(await readFile(path.join(kept, 'onecli-compose.yaml'), 'utf8')).toContain(DEPLOYED_GATEWAY);
    expect(JSON.parse(await readFile(path.join(kept, 'host-environment.json'), 'utf8'))).toMatchObject({
      WEBHOOK_PORT: String(runtime.allocated_ports.nanoclaw_webhook),
    });
    // The service definition is the release's own, written while the host was stopped.
    const definition = path.join(host.root, 'Library', 'LaunchAgents', `com.nanoclaw-v2-${runtime.install_id}.plist`);
    expect(await readFile(definition, 'utf8')).toContain(path.join(live, 'dist', 'gws-ea', 'process.js'));
    // The release changed the gateway: it was recreated, then checked with the isolation probe.
    expect(state.onecli).toEqual([`apply ${runtime.onecli_project}`, `verify ${runtime.onecli_project}`]);
    // Its listener answers for the new host, and the route reaches it.
    expect(state.fetched).toEqual(
      expect.arrayContaining([
        `POST http://127.0.0.1:${runtime.allocated_ports.nanoclaw_webhook}/webhook/gchat`,
        `POST ${runtime.endpoint_url}`,
      ]),
    );
    // The per-group image was rebuilt on the new base, with the host's own build bound, and its old image deleted.
    expect(state.rebuilds).toEqual([
      { args: ['groups', 'restart', '--id', 'ag-research', '--rebuild'], timeoutMs: expect.any(Number) },
    ]);
    expect(state.rebuilds[0]!.timeoutMs).toBeGreaterThanOrEqual(15 * 60_000);
    expect(state.ids.has(research)).toBe(false);
    expect(state.healthWaits).toEqual([60_000]);
    // The release stamps what main was stamped with, so main is not restamped.
    expect(state.restamps).toEqual([]);
    expect(await readFile(path.join(live, PERSONA), 'utf8')).toBe(stampedPersona('1'));
  });

  it("allows a killed host's claim lease when the stop was not graceful", async () => {
    const host = await machine();
    const runtime = await assistant(host);
    // The host was killed: its lease row was never marked stopped, and has not expired.
    const database = new Database(path.join(runtime.checkout_realpath, 'data', 'v2.db'));
    try {
      database.exec(`CREATE TABLE host_instances (
        instance_id TEXT PRIMARY KEY, install_id TEXT, hostname TEXT, pid INTEGER,
        started_at TEXT NOT NULL, lease_expires_at TEXT NOT NULL, stopped_at TEXT)`);
      database
        .prepare('INSERT INTO host_instances VALUES (?, ?, NULL, 1, ?, ?, NULL)')
        .run('killed-host', runtime.install_id, '2026-09-28T09:00:00.000Z', '2999-01-01T00:00:00.000Z');
    } finally {
      database.close();
    }
    const next = await nextRelease(host);
    const state = world(runtime);
    const { run } = cli(host, state, next, runtime);

    expect(await run(['update', '--id', runtime.instance_id, '--yes'])).toBe(0);

    expect(state.healthWaits.at(-1)).toBe(60_000 + 90_000);
  });

  it('keeps a failed image rebuild as a follow-up that leaves the release in place, and retries it next time', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host);
    const state = world(runtime);
    const ran = state.tags.get(`${imageBase(runtime)}:latest`)!;
    state.rebuildFails = true;
    const { run, err, out } = cli(host, state, next, runtime);
    const id = runtime.instance_id;

    expect(await run(['update', '--id', id, '--yes'])).toBe(1);

    expect(err.join('\n')).toContain('ag-research');
    expect(err.join('\n')).toContain(`gws-ea update --id ${id}`);
    expect(releaseOf(await getInstanceReservation(host.paths, id))).toEqual(release(host, next.commit));
    expect(await readOperationRecord(host.paths, id)).toMatchObject({
      phase: 'recorded',
      follow_ups: expect.arrayContaining([{ kind: 'rebuild_group_image', agent_group_id: 'ag-research' }]),
    });
    expect((await status(host, state, next, runtime)).operation).toMatchObject({ state: 'recorded' });
    // The gate is released: the assistant starts and its ncl is admitted.
    expect(await run(['start', '--id', id])).toBe(0);
    const ncl = await acquireInstanceOperation(host.paths, id, { command: 'ncl' });
    expect(ncl).not.toBeNull();
    ncl?.release();

    state.rebuildFails = false;
    expect(await run(['update', '--id', id, '--yes'])).toBe(0);

    expect(out.at(-1)).toBe(`Assistant ${id} runs dogfood ${next.commit.slice(0, 12)}; its update is finished.`);
    await expectUpdated(host, runtime, next, state, ran);
  });

  it('after two updates keeps one previous release and leaves no untagged agent image', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const first = await nextRelease(host);
    const state = world(runtime);
    expect(await cli(host, state, first, runtime).run(['update', '--id', runtime.instance_id, '--yes'])).toBe(0);
    const second = await nextRelease(host);
    const base = imageBase(runtime);
    const ran = state.tags.get(`${base}:latest`)!;

    expect(await cli(host, state, second, runtime).run(['update', '--id', runtime.instance_id, '--yes'])).toBe(0);

    const id = runtime.instance_id;
    expect(git(runtime.checkout_realpath, 'rev-parse', 'HEAD')).toBe(second.commit);
    expect(git(host.paths.releaseCheckoutRoot(id, 'previous'), 'rev-parse', 'HEAD')).toBe(first.commit);
    expect(await exists(host.paths.releaseRoot(id, 'superseded'))).toBe(false);
    expect(state.tags.get(`${base}:previous`)).toBe(ran);
    expect(repositoryImages(state, base).untagged).toEqual([]);
    expect([...state.tags.keys()].filter((name) => name.startsWith(`${base}:`)).sort()).toEqual(
      [`${base}:ag-research`, `${base}:latest`, `${base}:previous`].sort(),
    );
  });

  it("updates one assistant without touching another's checkout, state, service, images, OneCLI, or connector", async () => {
    const host = await machine();
    const a = await assistant(host, 37_001);
    const b = await assistant(host, 37_101);
    const next = await nextRelease(host);
    const state = world(a);
    const bLatest = imageId();
    state.tags.set(`${imageBase(b)}:latest`, bLatest);
    state.ids.add(bLatest);
    const bRegistered = await getInstanceReservation(host.paths, b.instance_id);
    const bFiles = await snapshot(host.paths.instanceRoot(b.instance_id));

    expect(await cli(host, state, next, a).run(['update', '--id', a.instance_id, '--yes'])).toBe(0);

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

  it('asks on a terminal with the preview, and a decline leaves no record and removes the staging', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host);
    const state = world(runtime);
    const asked: unknown[] = [];
    const { run, out } = cli(host, state, next, runtime, {
      confirmUpdate: async (preview) => {
        asked.push(preview);
        return false;
      },
    });

    expect(await run(['update', '--id', runtime.instance_id])).toBe(0);

    expect(asked).toEqual([expect.objectContaining({ to: release(host, next.commit) })]);
    expect(out).toContain('Update cancelled. Nothing was changed.');
    expect(await readOperationRecord(host.paths, runtime.instance_id)).toBeUndefined();
    expect(await exists(host.paths.releaseRoot(runtime.instance_id, 'next'))).toBe(false);
    expect(state.tags.has(`${imageBase(runtime)}:next`)).toBe(false);
    expect(state.running).toBe(true);
  });

  it('fails with input_required without a terminal or --yes, before anything is read or run', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host);
    const state = world(runtime);
    const { run, err } = cli(host, state, next, runtime);

    expect(await run(['update', '--id', runtime.instance_id])).toBe(1);

    expect(err.join('\n')).toContain('pass --yes');
    expect(state.commands).toEqual([]);
    expect(state.serviceCalls).toEqual([]);
    expect(await exists(host.paths.releaseRoot(runtime.instance_id, 'next'))).toBe(false);
  });

  it('refuses a stopped assistant naming gws-ea start, without offering to retry the update', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host);
    const state = world(runtime);
    state.running = false;
    const { run, err } = cli(host, state, next, runtime);

    expect(await run(['update', '--id', runtime.instance_id, '--yes'])).toBe(1);

    const summary = err.join('\n');
    expect(summary).toContain(`gws-ea start --id ${runtime.instance_id}`);
    expect(summary).not.toContain('Retry with');
  });

  it('refuses to start another update while one to a different release is unfinished, naming what continues it', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host);
    await openUpdate(host, runtime, release(host, 'e'.repeat(40)));
    const state = world(runtime);
    const { run, err } = cli(host, state, next, runtime);

    expect(await run(['update', '--id', runtime.instance_id, '--yes'])).toBe(1);

    const summary = err.join('\n');
    expect(summary).toContain('is unfinished (stopped)');
    expect(summary).toContain(`gws-ea rollback --id ${runtime.instance_id}`);
    expect(state.preflights).toEqual([]);
    expect(await exists(host.paths.releaseRoot(runtime.instance_id, 'next'))).toBe(false);
  });
});

describe("main's template across an update (R11, KTD12)", GIT_HEAVY, () => {
  const MAIN_ID = 'ag-main';
  const PLAN = ['groups', 'create', '--template', 'gws-ea/main', '--id', MAIN_ID];
  const TEMPLATE_INSTRUCTIONS = path.join('ai.nanoco.nanoclaw', 'context', 'instructions.md');

  function digest(contents: string): string {
    return `sha256:${createHash('sha256').update(contents).digest('hex')}`;
  }

  /** The restamp of main the update recorded with the release it kept. */
  async function keptRestamp(host: Machine, runtime: InstanceRuntimeConfig) {
    const id = runtime.instance_id;
    return (await readKeptReleaseManifest(host.paths.releaseRoot(id, 'previous'), id)).template_restamp;
  }

  async function mainFiles(checkout: string): Promise<{ persona: string; procedure: string; baseline: string }> {
    return {
      persona: await readFile(path.join(checkout, PERSONA), 'utf8'),
      procedure: await readFile(path.join(checkout, PROCEDURE), 'utf8'),
      baseline: await readFile(path.join(checkout, MAIN_BASELINE, TEMPLATE_INSTRUCTIONS), 'utf8'),
    };
  }

  const FIRST = {
    persona: stampedPersona('1'),
    procedure: 'Operating procedure 1.\n',
    baseline: mainTemplate('1')[path.join('templates', 'gws-ea', 'main', TEMPLATE_INSTRUCTIONS)],
  };
  const SECOND = {
    persona: stampedPersona('2'),
    procedure: 'Operating procedure 2.\n',
    baseline: mainTemplate('2')[path.join('templates', 'gws-ea', 'main', TEMPLATE_INSTRUCTIONS)],
  };

  it("refreshes an uncustomized main from the release's template once the update is recorded", async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host, mainTemplate('2'));
    const state = world(runtime);
    const { run, out } = cli(host, state, next, runtime);
    const id = runtime.instance_id;

    expect(await run(['update', '--id', id, '--yes'])).toBe(0);

    expect(await mainFiles(runtime.checkout_realpath)).toEqual(SECOND);
    // NanoClaw's own restamp on the new host did it: planned, then applied, with main named.
    expect(state.restamps).toEqual([
      { instanceId: id, args: PLAN },
      { instanceId: id, args: [...PLAN, '--yes'] },
    ]);
    const printed = out.join('\n');
    expect(printed).toContain("Main's template: refreshed from this release once the update is recorded");
    expect(printed).toContain("Main's template was refreshed from this release.");
    // What it changed is kept with the release it replaced, for a rollback to reverse; that release keeps main as it was.
    const restamp = await keptRestamp(host, runtime);
    expect(restamp).toMatchObject({
      agent_group_id: MAIN_ID,
      settled: { mcp_servers: expect.stringMatching(/^sha256:/u), tasks: expect.stringMatching(/^sha256:/u) },
    });
    expect(restamp?.files_before['instructions.prepend.md']).toBe(digest(stampedPersona('1')));
    expect(restamp?.files_after['instructions.prepend.md']).toBe(digest(stampedPersona('2')));
    expect(await mainFiles(host.paths.releaseCheckoutRoot(id, 'previous'))).toEqual(FIRST);
    expect(await readOperationRecord(host.paths, id)).toBeUndefined();
  });

  it('keeps an edited persona, names it in the preview and in status, and restamps nothing', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    await writeFile(path.join(runtime.checkout_realpath, PERSONA), 'My own instructions.\n');
    const next = await nextRelease(host, mainTemplate('2'));
    const state = world(runtime);
    const { run, out } = cli(host, state, next, runtime);

    expect(await run(['update', '--id', runtime.instance_id, '--yes'])).toBe(0);

    expect(await mainFiles(runtime.checkout_realpath)).toEqual({ ...FIRST, persona: 'My own instructions.\n' });
    expect(state.restamps).toEqual([]);
    expect(out.join('\n')).toContain(
      "Main's template: kept as it is, because these are customized: instructions.prepend.md (changed)",
    );
    expect(await keptRestamp(host, runtime)).toBeUndefined();
    const observed = await status(host, state, next, runtime);
    expect(observed.templates).toEqual({
      customized: [{ surface: 'persona', name: 'instructions.prepend.md', change: 'changed' }],
      reason: expect.stringContaining('Only its files were compared'),
    });
  });

  it.each([
    [
      'a file added where the stamp has none',
      (checkout: string) => write(checkout, path.join(MAIN_FOLDER, 'additional_context', 'notes.md'), 'Notes.\n'),
      { surface: 'context', name: 'additional_context/notes.md', change: 'added' },
    ],
    [
      'a stamped file deleted',
      (checkout: string) => rm(path.join(checkout, PROCEDURE)),
      { surface: 'context', name: 'additional_context/operating-procedure.md', change: 'deleted' },
    ],
  ] as const)('counts %s as customized, and restamps nothing', async (_label, customize, customized) => {
    const host = await machine();
    const runtime = await assistant(host);
    await customize(runtime.checkout_realpath);
    const next = await nextRelease(host, mainTemplate('2'));
    const state = world(runtime);

    const staged = await stage(host, runtime, dependencies(state, next, runtime));
    expect(staged.preview.mainTemplate).toEqual({ kind: 'customized', customized: [customized] });
    // The update removes the staging this left, and stages again.
    expect(await cli(host, state, next, runtime).run(['update', '--id', runtime.instance_id, '--yes'])).toBe(0);

    expect(state.restamps).toEqual([]);
    expect(await readFile(path.join(runtime.checkout_realpath, PERSONA), 'utf8')).toBe(FIRST.persona);
    expect((await status(host, state, next, runtime)).templates.customized).toEqual([customized]);
  });

  it('decides again before restamping, keeping a file edited after the preview promised a refresh', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host, mainTemplate('2'));
    const state = world(runtime);
    // The agent edits its persona once the new release serves, before the refresh runs.
    state.onStart = (checkout) => writeFileSync(path.join(checkout, PERSONA), 'Edited while updating.\n');
    const { run, out } = cli(host, state, next, runtime);

    expect(await run(['update', '--id', runtime.instance_id, '--yes'])).toBe(0);

    const printed = out.join('\n');
    expect(printed).toContain("Main's template: refreshed from this release once the update is recorded");
    expect(printed).toContain(
      "Main's template was kept as it is, because these are customized: instructions.prepend.md (changed).",
    );
    expect(state.restamps).toEqual([]);
    expect(await mainFiles(runtime.checkout_realpath)).toEqual({ ...FIRST, persona: 'Edited while updating.\n' });
    expect(await keptRestamp(host, runtime)).toBeUndefined();
  });

  it('decides once more after NanoClaw plans the restamp, keeping a file edited while it planned', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host, mainTemplate('2'));
    const state = world(runtime);
    state.onRestamp = (checkout, args) => {
      if (!args.includes('--yes')) writeFileSync(path.join(checkout, PROCEDURE), 'Edited while planning.\n');
    };
    const { run, out } = cli(host, state, next, runtime);

    expect(await run(['update', '--id', runtime.instance_id, '--yes'])).toBe(0);

    expect(state.restamps).toEqual([{ instanceId: runtime.instance_id, args: PLAN }]);
    expect(out.join('\n')).toContain(
      "Main's template was kept as it is, because these are customized: additional_context/operating-procedure.md (changed).",
    );
    expect(await mainFiles(runtime.checkout_realpath)).toEqual({ ...FIRST, procedure: 'Edited while planning.\n' });
    expect(await keptRestamp(host, runtime)).toBeUndefined();
  });

  it("keeps main's template when NanoClaw's plan flags a customized task, only planning the restamp", async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host, mainTemplate('2'));
    const state = world(runtime);
    state.restampPlan = [{ surface: 'task', name: 'Weekly review', action: 'update', customized: true }];
    const { run, out } = cli(host, state, next, runtime);

    expect(await run(['update', '--id', runtime.instance_id, '--yes'])).toBe(0);

    expect(state.restamps).toEqual([{ instanceId: runtime.instance_id, args: PLAN }]);
    expect(out.join('\n')).toContain(
      "Main's template was kept as it is, because these are customized: task Weekly review (changed).",
    );
    expect(await mainFiles(runtime.checkout_realpath)).toEqual(FIRST);
  });

  it('keeps a failed restamp as a follow-up that leaves start and ncl usable, and retries it next time', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host, mainTemplate('2'));
    const state = world(runtime);
    state.restampFails = true;
    const { run, err, out } = cli(host, state, next, runtime);
    const id = runtime.instance_id;

    expect(await run(['update', '--id', id, '--yes'])).toBe(1);

    expect(err.join('\n')).toContain("refreshing main's template");
    expect(releaseOf(await getInstanceReservation(host.paths, id))).toEqual(release(host, next.commit));
    expect(await readOperationRecord(host.paths, id)).toMatchObject({
      phase: 'recorded',
      follow_ups: expect.arrayContaining([{ kind: 'refresh_template' }]),
    });
    expect((await status(host, state, next, runtime)).operation).toMatchObject({
      state: 'recorded',
      follow_ups: expect.arrayContaining([{ kind: 'refresh_template' }]),
    });
    expect(await mainFiles(runtime.checkout_realpath)).toEqual(FIRST);
    // The gate is released: the assistant starts and its ncl is admitted.
    expect(await run(['start', '--id', id])).toBe(0);
    const ncl = await acquireInstanceOperation(host.paths, id, { command: 'ncl' });
    expect(ncl).not.toBeNull();
    ncl?.release();

    state.restampFails = false;
    expect(await run(['update', '--id', id, '--yes'])).toBe(0);

    expect(await mainFiles(runtime.checkout_realpath)).toEqual(SECOND);
    expect(out.slice(-2)).toEqual([
      `Assistant ${id} runs dogfood ${next.commit.slice(0, 12)}; its update is finished.`,
      "Main's template was refreshed from this release.",
    ]);
    expect(await readOperationRecord(host.paths, id)).toBeUndefined();
  });

  it.each(['restamp', 'restamp-partway'] as const)(
    'finishes a refresh killed at %s when the update is run again',
    async (point) => {
      const host = await machine();
      const runtime = await assistant(host);
      const next = await nextRelease(host, mainTemplate('2'));
      const state = world(runtime);
      state.hangAt = point;
      const id = runtime.instance_id;

      await killDuringCutover(host, runtime, state, next);

      // The restamp was recorded before it ran, and never settled.
      const pending = await keptRestamp(host, runtime);
      expect(pending).toMatchObject({ agent_group_id: MAIN_ID });
      expect(pending?.settled).toBeUndefined();
      expect(await readOperationRecord(host.paths, id)).toMatchObject({
        phase: 'recorded',
        follow_ups: expect.arrayContaining([{ kind: 'refresh_template' }]),
      });
      const cut = await mainFiles(runtime.checkout_realpath);
      expect(cut.baseline).toBe(SECOND.baseline);
      expect(cut.persona).toBe(point === 'restamp' ? SECOND.persona : FIRST.persona);
      delete state.hangAt;
      state.restamps.length = 0;
      const { run, out } = cli(host, state, next, runtime);

      expect(await run(['update', '--id', id, '--yes'])).toBe(0);

      // Finished, not decided again: its own half-done restamp is not taken for a customization.
      expect(await mainFiles(runtime.checkout_realpath)).toEqual(SECOND);
      expect(state.restamps).toEqual([{ instanceId: id, args: [...PLAN, '--yes'] }]);
      expect(out.join('\n')).toContain("Main's template was refreshed from this release.");
      expect((await keptRestamp(host, runtime))?.settled).toBeDefined();
      expect(await readOperationRecord(host.paths, id)).toBeUndefined();
    },
  );

  it("refreshes one assistant's main without touching another's", async () => {
    const host = await machine();
    const a = await assistant(host, 37_001);
    const b = await assistant(host, 37_101);
    const next = await nextRelease(host, mainTemplate('2'));
    const state = world(a);
    const bFiles = await snapshot(host.paths.instanceRoot(b.instance_id));

    expect(await cli(host, state, next, a).run(['update', '--id', a.instance_id, '--yes'])).toBe(0);

    expect(await mainFiles(a.checkout_realpath)).toEqual(SECOND);
    expect(state.restamps.map((call) => call.instanceId)).toEqual([a.instance_id, a.instance_id]);
    expect(await snapshot(host.paths.instanceRoot(b.instance_id))).toEqual(bFiles);
    expect(await mainFiles(b.checkout_realpath)).toEqual(FIRST);
  });
});
