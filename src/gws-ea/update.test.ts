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
import { execFileSync, spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { lstat, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
  installLabel,
  isHold,
  killDuringCutover,
  LIVE_MIGRATIONS,
  liveState,
  LOCKFILE,
  machine,
  MAIN_FOLDER,
  mainTemplate,
  MEMORY,
  messages,
  nextRelease,
  ONECLI_CLI,
  PROVIDER_SETUP,
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
  write,
  type Machine,
  type Release,
  type World,
} from './testing/cutover-fixture.js';
import { heldImageTag } from './agent-image.js';
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
  confirmStagedUpdate,
  continueUpdate,
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
  const reached = new Promise<'killed'>((resolve) => (state.reached = () => resolve('killed')));
  const abandoned = prepareUpdate(operation, intent, deps).then(() => 'finished' as const);
  expect(await Promise.race([reached, abandoned])).toBe('killed');
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
    // No image carried the release's key, so NanoClaw's build made one from the staged checkout, with the
    // instance's own .env and identity, and gws-ea labeled it with the key as :next, adding no layer.
    expect(await readFile(path.join(checkout, '.env'), 'utf8')).toBe(
      await readFile(path.join(runtime.checkout_realpath, '.env'), 'utf8'),
    );
    const build = state.commands.find((command) => command.command === 'bash')!;
    expect(build).toMatchObject({ args: [path.join(checkout, 'container', 'build.sh'), 'building'], cwd: checkout });
    expect(build.env).toMatchObject({
      NANOCLAW_INSTALL_ID: runtime.install_id,
      DOCKER_HOST: DOCKER,
      HOME: runtime.home_directory,
      INSTALL_CJK_FONTS: 'true',
    });
    const key = releaseAgentImageKey(next);
    const label = state.commands.find((command) => command.command === 'docker' && command.args[0] === 'build')!;
    expect(label).toMatchObject({
      args: ['build', '--label', `dev.gws-ea.agent-key=${key}`, '--tag', `${imageBase(runtime)}:next`, '-'],
      input: `FROM ${imageBase(runtime)}:building\n`,
    });
    expect(state.labels.get(state.tags.get(`${imageBase(runtime)}:next`)!)).toBe(key);
    expect(repositoryImages(state, imageBase(runtime)).untagged).toEqual([]);
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

  it("refuses to build an agent image from a staged container/ that is not the release's, labeling nothing", async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host);
    const state = world(runtime);
    const tags = new Map(state.tags);
    const deps = dependencies(state, next, runtime);
    // Something the release's own install ran rewrote a file the image build copies.
    const preflight = deps.runReleasePreflight!;
    const changed: UpdateDependencies = {
      ...deps,
      runReleasePreflight: async (input, runtimeSeams) => {
        await writeFile(path.join(input.checkoutRoot, LOCKFILE), 'lock rewritten\n');
        return preflight(input, runtimeSeams);
      },
    };

    await expect(stage(host, runtime, changed)).rejects.toMatchObject({
      code: 'checkout_drift',
      message: expect.stringContaining('container/agent-runner/bun.lock'),
    });

    expect(state.commands.some((command) => command.command === 'bash')).toBe(false);
    expect(state.tags).toEqual(tags);
    expect(state.labels.size).toBe(0);
    expect(await exists(host.paths.releaseRoot(runtime.instance_id, 'next'))).toBe(false);
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

      // The image a killed build left, still under its :building tag, is removed with next/, as :next would be,
      // before anything is fetched again.
      const building = `${imageBase(runtime)}:building`;
      const docker = (args: string) =>
        state.commands.findIndex((command) => command.command === 'docker' && command.args.join(' ') === args);
      const fetch = state.commands.findIndex((command) => command.command === 'git' && command.args[0] === 'fetch');
      expect(killed.tags.has(building)).toBe(step === 'build');
      for (const image of [`${imageBase(runtime)}:next`, building]) {
        expect(docker(`image ls --quiet ${image}`)).toBeGreaterThanOrEqual(0);
        expect(docker(`image ls --quiet ${image}`)).toBeLessThan(fetch);
      }
      // The staging that follows untags :building once it labels its own build, after the fetch.
      const removed = docker(`image rm ${building}`);
      expect(removed >= 0 && removed < fetch).toBe(step === 'build');
      expect(await exists(leftover)).toBe(false);
      expect(staged.preview.migrations).toEqual([ADDED_MIGRATION]);
      expect(git(staged.checkoutRoot, 'rev-parse', 'HEAD')).toBe(next.commit);
      expect(await inspectOperation(host.paths, reservation)).toEqual({ state: 'none', abandonedStaging: true });
    },
  );

  it.each([
    ['after its build, before it is labeled', 'label'],
    ['once labeled, before its unlabeled build is untagged', 'untag-build'],
  ] as const)(
    'converges without leaking an image when killed %s, the next update staging it cleanly',
    async (_label, point) => {
      const host = await machine();
      const runtime = await assistant(host);
      const next = await nextRelease(host);
      const state = world(runtime);
      const base = imageBase(runtime);
      state.hangAt = point;

      await killDuringStaging(host, runtime, state, next);

      // Every image the killed run made is still named by one of the assistant's own tags.
      expect(state.tags.has(`${base}:building`)).toBe(true);
      expect(state.tags.has(`${base}:next`)).toBe(point === 'untag-build');
      expect(repositoryImages(state, base).untagged).toEqual([]);
      delete state.hangAt;

      const staged = await stage(host, runtime, dependencies(state, next, runtime));

      expect(git(staged.checkoutRoot, 'rev-parse', 'HEAD')).toBe(next.commit);
      expect(state.tags.has(`${base}:building`)).toBe(false);
      expect(state.labels.get(state.tags.get(`${base}:next`)!)).toBe(releaseAgentImageKey(next));
      // Nothing either run built is left without a tag: the discard took the killed run's images by their tags.
      expect(repositoryImages(state, base).untagged).toEqual([]);
      expect(new Set(state.tags.values())).toEqual(state.ids);
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

describe('the update preview', () => {
  it('shows the group and file names an agent chose with their control characters escaped', () => {
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
  // Nothing is held once the update's cleanup released the image it displaced.
  expect([...state.tags.keys()].filter(isHold)).toEqual([]);
}

/** Where each kill leaves the update's record. */
const KILLS: ReadonlyArray<readonly [string, (state: World) => void, OperationPhase]> = [
  ['while stopping the host', (state) => (state.hangAt = 'stop'), 'staged'],
  ['after the stop, while carrying its state', (state) => (state.hangAt = 'stamp'), 'stopped'],
  ["at the swap's first rename", (state) => (state.renameKill = 1), 'swapping'],
  ['once the kept files moved into previous/', (state) => (state.renameKill = 2), 'swapping'],
  ['between the two checkout renames', (state) => (state.renameKill = 3), 'swapping'],
  ["before the new release's receipt is promoted", (state) => (state.renameKill = 4), 'swapping'],
  ['after the swap, while holding the images it moves', (state) => (state.hangAt = 'hold'), 'swapped'],
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

  it('stands by a release the registry committed when the record write after it fails, and update settles it', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    await converse(runtime, 'm1');
    const next = await nextRelease(host);
    const state = world(runtime);
    const ran = state.tags.get(`${imageBase(runtime)}:latest`)!;
    const id = runtime.instance_id;
    const live = runtime.checkout_realpath;
    const { run, err, out } = cli(host, state, next, runtime);
    failing.recordedWrite = true;

    expect(await run(['update', '--id', id, '--yes'])).toBe(1);

    // The write failed once the registry named the release, and nothing was reverted: it runs as recorded there.
    expect(failing.recordedWrite).toBe(false);
    const summary = err.join('\n');
    expect(summary).toContain(
      `Assistant ${id} runs dogfood ${next.commit.slice(0, 12)}: its update was committed before that failed, so it stands, and gws-ea update --id ${id} finishes recording it.`,
    );
    expect(summary).not.toContain('rollback');
    expect(releaseOf(await getInstanceReservation(host.paths, id))).toEqual(release(host, next.commit));
    expect(git(live, 'rev-parse', 'HEAD')).toBe(next.commit);
    expect(await receiptCommit(instanceMarkerFile(live))).toBe(next.commit);
    expect(await receiptCommit(host.paths.releasePreflightFile(id))).toBe(next.commit);
    expect(state.tags.get(`${imageBase(runtime)}:previous`)).toBe(ran);
    expect(state.running).toBe(true);
    expect((await readOperationRecord(host.paths, id))?.phase).toBe('verified');
    const checks = state.healthWaits.length;

    expect(await run(['update', '--id', id, '--yes'])).toBe(0);

    // The rerun settled the record through its gate and ran the follow-ups, without verifying again.
    expect(state.healthWaits).toHaveLength(checks);
    await expectUpdated(host, runtime, next, state, ran);
    expect(messages(live)).toEqual(['m1']);
    expect(out).toContain(`Assistant ${id} runs dogfood ${next.commit.slice(0, 12)}; its update is finished.`);
  });

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

  it.each([
    ["at the swap's first rename", 1],
    ['once the kept files moved into previous/', 2],
  ] as const)(
    'carries again what a host the OS started records once killed %s, before the live checkout moved',
    async (_label, at) => {
      const host = await machine();
      const runtime = await assistant(host);
      await converse(runtime, 'm1');
      const next = await nextRelease(host);
      const state = world(runtime);
      const ran = state.tags.get(`${imageBase(runtime)}:latest`)!;
      state.renameKill = at;
      await killDuringCutover(host, runtime, state, next);
      expect((await readOperationRecord(host.paths, runtime.instance_id))?.phase).toBe('swapping');

      // The OS starts the old host again from the live path, which the swap had not moved, and it serves a message.
      state.running = true;
      await converse(runtime, 'm2');
      delete state.renameKill;

      expect(await cli(host, state, next, runtime).run(['update', '--id', runtime.instance_id, '--yes'])).toBe(0);

      await expectUpdated(host, runtime, next, state, ran);
      expect(messages(runtime.checkout_realpath)).toEqual(['m1', 'm2']);
      expect(messages(host.paths.releaseCheckoutRoot(runtime.instance_id, 'previous'))).toEqual(['m1', 'm2']);
    },
  );

  it('carries again what a host the OS started records once killed after setting an older previous release aside', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    await converse(runtime, 'm1');
    const first = await nextRelease(host);
    const state = world(runtime);
    expect(await cli(host, state, first, runtime).run(['update', '--id', runtime.instance_id, '--yes'])).toBe(0);
    const second = await nextRelease(host);
    // The swap's first rename sets the kept release aside; it is killed at its second.
    state.renameKill = 2;
    await killDuringCutover(host, runtime, state, second);
    const id = runtime.instance_id;
    expect(await exists(host.paths.releaseRoot(id, 'superseded'))).toBe(true);
    state.running = true;
    await converse(runtime, 'm2');
    delete state.renameKill;

    expect(await cli(host, state, second, runtime).run(['update', '--id', id, '--yes'])).toBe(0);

    expect(releaseOf(await getInstanceReservation(host.paths, id))).toEqual(release(host, second.commit));
    expect(git(runtime.checkout_realpath, 'rev-parse', 'HEAD')).toBe(second.commit);
    expect(messages(runtime.checkout_realpath)).toEqual(['m1', 'm2']);
    const previous = host.paths.releaseCheckoutRoot(id, 'previous');
    expect(git(previous, 'rev-parse', 'HEAD')).toBe(first.commit);
    expect(messages(previous)).toEqual(['m1', 'm2']);
    expect(await exists(host.paths.releaseRoot(id, 'superseded'))).toBe(false);
    expect(await readOperationRecord(host.paths, id)).toBeUndefined();
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

/** The central database's side files, which a stop's checkpoint folds away and SQLite recreates on every open. */
function centralSideFiles(checkout: string): string[] {
  return ['-wal', '-shm'].map((suffix) => path.join(checkout, 'data', `v2.db${suffix}`));
}

describe('the cutover refuses to go on', GIT_HEAVY, () => {
  it("when the live database's migrations changed since staging, before recording the stop, serving the old release again", async () => {
    const host = await machine();
    const runtime = await assistant(host);
    await converse(runtime, 'm1');
    const next = await nextRelease(host);
    const state = world(runtime, applying(ADDED_MIGRATION));
    const ran = state.tags.get(`${imageBase(runtime)}:latest`)!;
    state.hangAt = 'stop';
    await killDuringCutover(host, runtime, state, next);
    // Something migrated the live database while the update waited to stop it.
    applying(FAILING_MIGRATION)(path.join(runtime.checkout_realpath, 'data', 'v2.db'));
    delete state.hangAt;
    const id = runtime.instance_id;
    const live = runtime.checkout_realpath;
    const staging = host.paths.releaseRoot(id, 'next');
    const liveBefore = await snapshot(live, centralSideFiles(live));
    const stagingBefore = await snapshot(staging);
    const { run, err } = cli(host, state, next, runtime);

    expect(await run(['update', '--id', id, '--yes'])).toBe(1);

    const summary = err.join('\n');
    expect(summary).toContain(FAILING_MIGRATION);
    expect(summary).toContain(`gws-ea update --id ${id}`);
    expect(summary).toContain(`gws-ea rollback --id ${id}`);
    // The old release serves again at once; the staging waits with its record, and the live state is as it was.
    expect(state.running).toBe(true);
    expect((await readOperationRecord(host.paths, id))?.phase).toBe('staged');
    expect(await snapshot(staging)).toEqual(stagingBefore);
    expect(await snapshot(live, centralSideFiles(live))).toEqual(liveBefore);

    // Its dry run no longer speaks for the live database: rollback discards the staging, and a new update stages again.
    expect(await run(['rollback', '--id', id, '--yes'])).toBe(0);
    expect(await exists(staging)).toBe(false);
    expect(state.running).toBe(true);
    expect(await run(['update', '--id', id, '--yes'])).toBe(0);
    await expectUpdated(host, runtime, next, state, ran);
    expect(messages(live)).toEqual(['m1']);
  });

  it('when anything still holds its data open, before copying or moving anything, serving the old release again', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    await converse(runtime, 'm1');
    const next = await nextRelease(host);
    const state = world(runtime);
    const ran = state.tags.get(`${imageBase(runtime)}:latest`)!;
    const live = runtime.checkout_realpath;
    const before = await snapshot(live);
    // A leftover opener, idle: an operator's sqlite3 shell on a session database.
    state.openFiles = `p4242\ncsqlite3\nf5\nn${path.join(live, SESSION, 'inbound.db')}\n`;
    const { run, err } = cli(host, state, next, runtime);
    const id = runtime.instance_id;

    expect(await run(['update', '--id', id, '--yes'])).toBe(1);

    const summary = err.join('\n');
    expect(summary).toContain(`sqlite3 (PID 4242) holds ${path.join(live, SESSION, 'inbound.db')}`);
    expect(summary).toContain(`gws-ea update --id ${id}`);
    expect(summary).toContain(`gws-ea rollback --id ${id}`);
    expect(state.running).toBe(true);
    expect((await readOperationRecord(host.paths, id))?.phase).toBe('staged');
    // Nothing was copied, settled, or moved; the staging waits as it was built.
    expect(await snapshot(live)).toEqual(before);
    const staged = host.paths.releaseCheckoutRoot(id, 'next');
    expect(git(staged, 'rev-parse', 'HEAD')).toBe(next.commit);
    expect(await exists(path.join(staged, SESSION))).toBe(false);
    expect(await exists(path.join(host.paths.releaseRoot(id, 'next'), 'carrying'))).toBe(false);
    expect(await exists(host.paths.releaseRoot(id, 'previous'))).toBe(false);
    expect(releaseOf(await getInstanceReservation(host.paths, id))).toEqual(release(host, host.first));

    // Once it lets go, the update goes on from its record, staging nothing again.
    state.openFiles = '';
    expect(await run(['update', '--id', id, '--yes'])).toBe(0);
    expect(state.preflights).toHaveLength(1);
    await expectUpdated(host, runtime, next, state, ran);
    expect(messages(live)).toEqual(['m1']);
  });

  it('when a container of its install outlives the drain, before copying anything, serving the old release again', async () => {
    const host = await machine();
    const a = await assistant(host, 37_001);
    const b = await assistant(host, 37_101);
    await converse(a, 'm1');
    const next = await nextRelease(host);
    const state = world(a);
    const ran = state.tags.get(`${imageBase(a)}:latest`)!;
    // Another assistant's agents run on, which is no concern of A's; one of A's own stays after the drain.
    state.containers.set(installLabel(b), ['b0b0b0b0b0b0']);
    state.containers.set(installLabel(a), ['a0a0a0a0a0a0']);
    const live = a.checkout_realpath;
    const before = await snapshot(live);
    const { run, err } = cli(host, state, next, a);
    const id = a.instance_id;

    expect(await run(['update', '--id', id, '--yes'])).toBe(1);

    expect(err.join('\n')).toContain("containers a0a0a0a0a0a0 still carry its install's label");
    expect(state.running).toBe(true);
    expect((await readOperationRecord(host.paths, id))?.phase).toBe('staged');
    expect(await snapshot(live)).toEqual(before);
    expect(await exists(path.join(host.paths.releaseCheckoutRoot(id, 'next'), SESSION))).toBe(false);

    // Once it is gone, the update goes on.
    state.containers.delete(installLabel(a));
    expect(await run(['update', '--id', id, '--yes'])).toBe(0);
    await expectUpdated(host, a, next, state, ran);
  });

  it('says the assistant is stopped, naming what brings it back, when starting the old release again fails too', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host);
    const state = world(runtime);
    const live = runtime.checkout_realpath;
    state.openFiles = `p4242\ncsqlite3\nf5\nn${path.join(live, 'data', 'v2.db')}\n`;
    state.startFails = true;
    const { run, err } = cli(host, state, next, runtime);
    const id = runtime.instance_id;

    expect(await run(['update', '--id', id, '--yes'])).toBe(1);

    const summary = err.join('\n');
    expect(summary).toContain(`sqlite3 (PID 4242) holds ${path.join(live, 'data', 'v2.db')}`);
    expect(summary).toContain('Bootstrap failed: 5: Input/output error');
    expect(summary).toContain(`Assistant ${id} is stopped`);
    expect(summary).toContain(`gws-ea update --id ${id}`);
    expect(summary).toContain(`gws-ea rollback --id ${id}`);
    expect(state.running).toBe(false);
    expect((await readOperationRecord(host.paths, id))?.phase).toBe('staged');
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
    // The swap never moved the live checkout, so the old release serves again and the update goes back to its stop.
    expect(state.running).toBe(true);
    expect((await readOperationRecord(host.paths, id))?.phase).toBe('stopped');
    expect(git(live, 'rev-parse', 'HEAD')).toBe(host.first);
    expect(git(host.paths.releaseCheckoutRoot(id, 'next'), 'rev-parse', 'HEAD')).toBe(next.commit);
    expect(await exists(host.paths.releaseRoot(id, 'previous'))).toBe(false);

    // Once it lets go, the update stops the old release again and carries what it recorded meanwhile.
    state.openFiles = '';
    delete state.onStamp;
    await converse(runtime, 'm2');
    expect(await run(['update', '--id', id, '--yes'])).toBe(0);
    await expectUpdated(host, runtime, next, state, ran);
    expect(messages(live)).toEqual(['m1', 'm2']);
  });

  it.each([
    [
      'its listener answers with another listener ID',
      DEPLOYED_GATEWAY,
      (state: World, failing: boolean): void => {
        state.listenerAnswer = failing ? '22222222-2222-4222-8222-222222222222' : undefined;
      },
    ],
    [
      'OneCLI is not present, its gateway unchanged',
      RELEASE_GATEWAY,
      (state: World, failing: boolean): void => {
        state.onecliObservation = failing ? { status: 'absent', reason: 'the gateway is not running' } : undefined;
      },
    ],
    [
      'OneCLI fails its checks on the gateway it changed',
      DEPLOYED_GATEWAY,
      (state: World, failing: boolean): void => {
        state.onecliVerifyFails = failing;
      },
    ],
    [
      'its host answers without its webhook port',
      DEPLOYED_GATEWAY,
      (state: World, failing: boolean): void => {
        state.webhookPort = failing ? 38_999 : undefined;
      },
    ],
    [
      'its route is down',
      DEPLOYED_GATEWAY,
      (state: World, failing: boolean): void => {
        state.routeDown = failing;
      },
    ],
  ] as const)(
    'when the new release serves but %s, recording nothing and rolling back',
    async (_label, gateway, fail) => {
      const host = await machine();
      const runtime = await assistant(host, 37_001, gateway);
      const next = await nextRelease(host);
      const state = world(runtime);
      // Only the new release fails; the one the rollback restores serves.
      state.onStart = (checkout) => fail(state, git(checkout, 'rev-parse', 'HEAD') === next.commit);
      const { run, err } = cli(host, state, next, runtime);

      expect(await run(['update', '--id', runtime.instance_id, '--yes'])).toBe(1);

      expect(err.join('\n')).toContain(`The update to dogfood ${next.commit.slice(0, 12)} stopped at started`);
      expect(err.join('\n')).toContain('so it was rolled back');
      expect(await readOperationRecord(host.paths, runtime.instance_id)).toBeUndefined();
      expect(releaseOf(await getInstanceReservation(host.paths, runtime.instance_id))).toEqual(
        release(host, host.first),
      );
      expect(git(runtime.checkout_realpath, 'rev-parse', 'HEAD')).toBe(host.first);
      expect(state.running).toBe(true);
    },
  );

  it('names rollback when rolling the failed release back fails too, and rollback then finishes it', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    await converse(runtime, 'm1');
    const next = await nextRelease(host);
    const state = world(runtime);
    const ran = state.tags.get(`${imageBase(runtime)}:latest`)!;
    const id = runtime.instance_id;
    // The new release's route is down, and once it started the filesystem refuses renames, so no swap back runs.
    state.onStart = (checkout) => {
      const failing = git(checkout, 'rev-parse', 'HEAD') === next.commit;
      state.routeDown = failing;
      if (failing) state.renameFails = true;
    };
    const deps = dependencies(state, next, runtime);
    const intent = await resolveUpdateIntent(host.paths, { instanceId: id }, deps);
    const operation = await acquireInstanceOperation(host.paths, id, { command: 'update', target: intent.target });
    if (!operation) throw new Error('The test instance operation was busy');
    try {
      const staged = await prepareUpdate(operation, intent, deps);
      await confirmStagedUpdate(operation, staged, deps, async () => true);

      await expect(continueUpdate(operation, deps)).rejects.toMatchObject({
        code: 'update_recovery_failed',
        message: expect.stringMatching(
          new RegExp(
            `The update to dogfood ${next.commit.slice(0, 12)} stopped at started, and rolling it back did not finish: .+ ` +
              `Continue the rollback with gws-ea rollback --id ${id}\\.$`,
            'u',
          ),
        ),
        details: expect.objectContaining({ continueWith: `gws-ea rollback --id ${id}` }),
      });
    } finally {
      operation.release();
    }
    expect(await readOperationRecord(host.paths, id)).toBeDefined();
    expect(releaseOf(await getInstanceReservation(host.paths, id))).toEqual(release(host, host.first));

    state.renameFails = false;
    const { run, out } = cli(host, state, next, runtime);
    expect(await run(['rollback', '--id', id, '--yes'])).toBe(0);

    expect(out).toContain(`Assistant ${id} was rolled back to dogfood ${host.first.slice(0, 12)}.`);
    expect(await readOperationRecord(host.paths, id)).toBeUndefined();
    expect(releaseOf(await getInstanceReservation(host.paths, id))).toEqual(release(host, host.first));
    expect(git(runtime.checkout_realpath, 'rev-parse', 'HEAD')).toBe(host.first);
    expect(await receiptCommit(host.paths.releasePreflightFile(id))).toBe(host.first);
    expect(state.tags.get(`${imageBase(runtime)}:latest`)).toBe(ran);
    expect(messages(runtime.checkout_realpath)).toEqual(['m1']);
    expect(state.running).toBe(true);
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
  });

  it('reports its stop once, and names the checks before the swap and the start that it is still stopped', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host);
    const state = world(runtime);
    const started: Array<readonly [string, string | undefined]> = [];
    const deps: UpdateDependencies = {
      ...dependencies(state, next, runtime),
      reporter: {
        emit: (event) => {
          if (event.type === 'step-started') started.push([event.step, event.label]);
        },
      },
    };
    const intent = await resolveUpdateIntent(host.paths, { instanceId: runtime.instance_id }, deps);
    const operation = await acquireInstanceOperation(host.paths, runtime.instance_id, {
      command: 'update',
      target: intent.target,
    });
    if (!operation) throw new Error('The test instance operation was busy');
    try {
      await confirmStagedUpdate(operation, await prepareUpdate(operation, intent, deps), deps, async () => true);
      await continueUpdate(operation, deps);
    } finally {
      operation.release();
    }

    // One stop step throughout; the checks that no host started since read as what they are.
    expect(started.filter(([step]) => ['stop_host', 'swap_releases', 'move_images'].includes(step))).toEqual([
      ['stop_host', 'Stopping the assistant for the switch…'],
      ['stop_host', 'Making sure the assistant is still stopped…'],
      ['swap_releases', 'Switching to the new release…'],
      ['stop_host', 'Making sure the assistant is still stopped…'],
      ['move_images', "Moving the assistant's images to the new release…"],
    ]);
  });

  it('never opens a file an agent planted beside a -journal or -wal, header or not, and carries it as it is', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    await converse(runtime, 'm1');
    const session = path.join(runtime.checkout_realpath, SESSION);
    // Named as databases are, with side files beside them, but no SQLite database: opened, they would fail the
    // cutover. The last two even begin with SQLite's header, and SQLite deletes such a file's side file as it
    // refuses it.
    const planted = {
      'notes.db': 'Notes an agent keeps.\n',
      'notes.db-journal': 'Not a journal.\n',
      'scratch.db': '',
      'scratch.db-wal': 'Not a log.\n',
      'evil.db': SQLITE_HEADER,
      'evil.db-journal': 'Not a journal.\n',
      'forged.db': `${SQLITE_HEADER}${'junk'.repeat(256)}`,
      'forged.db-wal': 'Not a log.\n',
    };
    for (const [file, contents] of Object.entries(planted)) await writeFile(path.join(session, file), contents);
    const next = await nextRelease(host);
    const state = world(runtime);
    const ran = state.tags.get(`${imageBase(runtime)}:latest`)!;

    expect(await cli(host, state, next, runtime).run(['update', '--id', runtime.instance_id, '--yes'])).toBe(0);

    await expectUpdated(host, runtime, next, state, ran);
    for (const [file, contents] of Object.entries(planted)) {
      expect(await readFile(path.join(session, file), 'utf8'), file).toBe(contents);
    }
    expect(messages(runtime.checkout_realpath)).toEqual(['m1']);
  });

  it('refuses the cutover when a session mailbox it owns cannot be settled, naming it, and serves the old release again', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    await converse(runtime, 'm1');
    const next = await nextRelease(host);
    const state = world(runtime);
    const live = runtime.checkout_realpath;
    const inbound = path.join(live, SESSION, 'inbound.db');
    const forged = `${SQLITE_HEADER}${'junk'.repeat(256)}`;
    const id = runtime.instance_id;
    // Corrupted once the release is staged, as the preview waits: only the settle after the stop meets it.
    const { run, err } = cli(host, state, next, runtime, {
      confirmUpdate: async () => {
        writeFileSync(inbound, forged);
        writeFileSync(`${inbound}-journal`, 'Not a journal.\n');
        return true;
      },
    });

    expect(await run(['update', '--id', id])).toBe(1);

    const summary = err.join('\n');
    expect(summary).toContain(`${inbound} is not a database SQLite can open (SQLITE_NOTADB: file is not a database)`);
    expect(summary).toContain(`gws-ea update --id ${id}`);
    expect(state.running).toBe(true);
    expect((await readOperationRecord(host.paths, id))?.phase).toBe('staged');
    expect(releaseOf(await getInstanceReservation(host.paths, id))).toEqual(release(host, host.first));
    expect(git(live, 'rev-parse', 'HEAD')).toBe(host.first);
    expect(await exists(host.paths.releaseRoot(id, 'previous'))).toBe(false);
  });

  it("never opens a pipe planted at a mailbox's name beside a -journal, which would wait for a writer forever", async () => {
    const host = await machine();
    const runtime = await assistant(host);
    await converse(runtime, 'm1');
    const pipe = path.join(runtime.checkout_realpath, SESSION, 'outbound.db');
    execFileSync('mkfifo', [pipe]);
    await writeFile(`${pipe}-journal`, 'Not a journal.\n');
    // A writer waiting on the pipe: whatever opens it to read is let go at once instead of hanging the test, and
    // the writer, done, exits.
    const writer = spawn('sh', ['-c', 'printf x > "$0"', pipe], { stdio: 'ignore' });
    const exited = new Promise<'exited'>((resolve) => writer.once('exit', () => resolve('exited')));
    try {
      const next = await nextRelease(host);
      const state = world(runtime);
      const ran = state.tags.get(`${imageBase(runtime)}:latest`)!;

      expect(await cli(host, state, next, runtime).run(['update', '--id', runtime.instance_id, '--yes'])).toBe(0);

      await expectUpdated(host, runtime, next, state, ran);
      expect(messages(runtime.checkout_realpath)).toEqual(['m1']);
      // Nothing opened the pipe: its writer still waits.
      expect(await Promise.race([exited, delay(250).then(() => 'waiting' as const)])).toBe('waiting');
    } finally {
      writer.kill();
    }
  });

  it('moves the assistant to another track and repository that holds the release, and rollback moves it back (AE1)', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    await converse(runtime, 'm1');
    const id = runtime.instance_id;
    const live = runtime.checkout_realpath;
    // A mirror of the release repository, whose own track carries a release the original does not.
    const mirror = path.join(host.root, 'mirror.git');
    git(host.root, 'clone', '--quiet', '--bare', host.remote, mirror);
    git(mirror, 'config', 'uploadpack.allowFilter', 'true');
    const next = await nextRelease(host, {}, { remote: mirror, branch: 'canary' });
    const state = world(runtime);
    const registered = await getInstanceReservation(host.paths, id);
    const agentGroups = (): unknown[] => {
      const database = new Database(path.join(live, 'data', 'v2.db'), { readonly: true });
      try {
        return database.prepare('SELECT * FROM agent_groups ORDER BY id').all();
      } finally {
        database.close();
      }
    };
    const groups = agentGroups();
    const memory = await readFile(path.join(live, MEMORY), 'utf8');
    const { run } = cli(host, state, next, runtime);

    expect(await run(['update', '--id', id, '--track', 'canary', '--source-remote', mirror, '--yes'])).toBe(0);

    // Only the release moved: the instance, its ports and claims, and everything it recorded are as they were.
    const moved = { source_remote: mirror, release_track: 'canary', deployed_commit: next.commit };
    expect(await getInstanceReservation(host.paths, id)).toEqual({ ...registered, ...moved });
    expect(git(live, 'rev-parse', 'HEAD')).toBe(next.commit);
    expect(messages(live)).toEqual(['m1']);
    expect(await readFile(path.join(live, MEMORY), 'utf8')).toBe(memory);
    expect(agentGroups()).toEqual(groups);

    expect(await run(['rollback', '--id', id, '--yes'])).toBe(0);

    expect(await getInstanceReservation(host.paths, id)).toEqual(registered);
    expect(git(live, 'rev-parse', 'HEAD')).toBe(host.first);
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

  it.each([
    ['is recorded', false],
    ['fails its checks and is rolled back', true],
  ] as const)(
    'deletes no image a tag still names when an update that reuses the images the assistant runs %s',
    async (_label, fails) => {
      const host = await machine();
      const runtime = await assistant(host);
      const id = runtime.instance_id;
      const first = await nextRelease(host);
      const state = world(runtime);
      expect(await cli(host, state, first, runtime).run(['update', '--id', id, '--yes'])).toBe(0);
      const base = imageBase(runtime);
      const tagged = () =>
        Object.fromEntries(['latest', 'previous', 'ag-research'].map((tag) => [tag, state.tags.get(`${base}:${tag}`)]));
      const before = tagged();
      // Nothing the agent images are built from changed: the release's key names the image the first update
      // built and labeled, which the assistant runs, and Docker hands back the group image it already has.
      state.cachedRebuild = true;
      const second = await nextRelease(host);
      expect(state.labels.get(before.latest!)).toBe(releaseAgentImageKey(second));
      if (fails) {
        state.onStart = (checkout) => {
          if (git(checkout, 'rev-parse', 'HEAD') === second.commit) state.running = false;
        };
      }

      expect(await cli(host, state, second, runtime).run(['update', '--id', id, '--yes'])).toBe(fails ? 1 : 0);

      expect(git(runtime.checkout_realpath, 'rev-parse', 'HEAD')).toBe(fails ? first.commit : second.commit);
      expect(await readOperationRecord(host.paths, id)).toBeUndefined();
      const after = tagged();
      expect(after).toEqual(fails ? before : { ...before, previous: before.latest });
      for (const image of Object.values(after)) expect(state.ids.has(image!)).toBe(true);
    },
  );

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
    const gateway = state.tags.get(DEPLOYED_GATEWAY)!;

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
    // The gateway image A moved off stays, as built: B, or a rollback, may run it.
    expect(state.tags.get(DEPLOYED_GATEWAY)).toBe(gateway);
    expect(state.ids.has(gateway)).toBe(true);
  });

  /**
   * Two assistants created at the machine's first release on one Docker, A's
   * world holding B's agent images beside its own, and the next release.
   */
  async function pair(): Promise<{
    host: Machine;
    a: InstanceRuntimeConfig;
    b: InstanceRuntimeConfig;
    next: Release;
    state: World;
  }> {
    const host = await machine();
    const a = await assistant(host, 37_001);
    const b = await assistant(host, 37_101);
    const next = await nextRelease(host);
    const state = world(a);
    for (const tag of [`${imageBase(b)}:latest`, `${imageBase(b)}:ag-research`]) {
      const id = imageId();
      state.tags.set(tag, id);
      state.ids.add(id);
    }
    return { host, a, b, next, state };
  }

  /** NanoClaw's image builds, and gws-ea's label builds, among the commands run. */
  function agentImageBuilds(state: World): string[] {
    return state.commands
      .filter(
        (command) =>
          command.command === 'bash' ||
          (command.command === 'docker' && command.args[0] === 'build' && command.args.at(-1) === '-'),
      )
      .map((command) => [command.command, ...command.args].join(' '));
  }

  it('gives a second assistant updated to the same release the image the first built: no build, no new image', async () => {
    const { host, a, b, next, state } = await pair();
    expect(await cli(host, state, next, a).run(['update', '--id', a.instance_id, '--yes'])).toBe(0);
    const shared = state.tags.get(`${imageBase(a)}:latest`)!;
    expect(state.labels.get(shared)).toBe(releaseAgentImageKey(next));
    const bRan = state.tags.get(`${imageBase(b)}:latest`)!;
    const before = new Set(state.ids);
    state.commands.length = 0;

    expect(await cli(host, state, next, b).run(['update', '--id', b.instance_id, '--yes'])).toBe(0);

    // B runs the very image A runs, under its own tags, and keeps the one it ran for its rollback.
    expect(state.tags.get(`${imageBase(b)}:latest`)).toBe(shared);
    expect(state.tags.get(`${imageBase(a)}:latest`)).toBe(shared);
    expect(state.tags.get(`${imageBase(b)}:previous`)).toBe(bRan);
    expect(state.tags.has(`${imageBase(b)}:next`)).toBe(false);
    // Nothing was built for B, and the only image its update made is its own group's, rebuilt on the shared base.
    expect(agentImageBuilds(state)).toEqual([]);
    expect([...state.ids].filter((id) => !before.has(id))).toEqual([state.tags.get(`${imageBase(b)}:ag-research`)]);
    // Each group's own image, rebuilt on the shared one, inherits its label; no other image carries the key.
    const groupImages = new Set([a, b].map((runtime) => state.tags.get(`${imageBase(runtime)}:ag-research`)));
    const keyed = [...state.labels].filter(([id, key]) => key === releaseAgentImageKey(next) && !groupImages.has(id));
    expect(keyed.map(([id]) => id)).toEqual([shared]);
    expect(repositoryImages(state, imageBase(b)).untagged).toEqual([]);
  });

  it('builds a separate image for an assistant whose .env asks for other build flags', async () => {
    const { host, a, b, next, state } = await pair();
    const environment = path.join(b.checkout_realpath, '.env');
    await writeFile(
      environment,
      (await readFile(environment, 'utf8')).replace('INSTALL_CJK_FONTS=true', 'INSTALL_CJK_FONTS=false'),
    );
    expect(await cli(host, state, next, a).run(['update', '--id', a.instance_id, '--yes'])).toBe(0);

    expect(await cli(host, state, next, b).run(['update', '--id', b.instance_id, '--yes'])).toBe(0);

    const [aImage, bImage] = [a, b].map((runtime) => state.tags.get(`${imageBase(runtime)}:latest`)!);
    expect(aImage).not.toBe(bImage);
    expect(state.labels.get(aImage)).toBe(releaseAgentImageKey(next));
    expect(state.labels.get(bImage)).toBe(releaseAgentImageKey(next, { installCjkFonts: false }));
    expect(releaseAgentImageKey(next, { installCjkFonts: false })).not.toBe(releaseAgentImageKey(next));
    const builds = state.commands.filter((command) => command.command === 'bash');
    expect(builds.map((build) => build.env?.INSTALL_CJK_FONTS)).toEqual(['true', 'false']);
  });

  it("needs no room for an agent image when the release's is already shared, and still does when it is not", async () => {
    const { host, a, b, next, state } = await pair();
    // Room for a staged release and a copy of its state, not for another agent image.
    state.freeBytes = 512 * 1024 ** 2;
    const refused = cli(host, state, next, b);

    expect(await refused.run(['update', '--id', b.instance_id, '--yes'])).toBe(1);
    expect(refused.err.join('\n')).toContain('a copy of its state, and a new agent image');
    expect(await exists(host.paths.releaseRoot(b.instance_id, 'next'))).toBe(false);

    state.freeBytes = 1e15;
    expect(await cli(host, state, next, a).run(['update', '--id', a.instance_id, '--yes'])).toBe(0);
    state.freeBytes = 512 * 1024 ** 2;
    state.commands.length = 0;

    expect(await cli(host, state, next, b).run(['update', '--id', b.instance_id, '--yes'])).toBe(0);

    expect(state.tags.get(`${imageBase(b)}:latest`)).toBe(state.tags.get(`${imageBase(a)}:latest`));
    // It never asked how large B's image is: the shared one is already on disk.
    expect(state.commands.some((command) => command.args.includes('{{.Size}}'))).toBe(false);
  });

  it("leaves a peer's image alone when an update tagged onto it is declined", async () => {
    const { host, a, b, next, state } = await pair();
    expect(await cli(host, state, next, a).run(['update', '--id', a.instance_id, '--yes'])).toBe(0);
    const shared = state.tags.get(`${imageBase(a)}:latest`)!;
    const bRan = state.tags.get(`${imageBase(b)}:latest`)!;
    let staged: string | undefined;
    const declined = cli(host, state, next, b, {
      confirmUpdate: async () => {
        staged = state.tags.get(`${imageBase(b)}:next`);
        return false;
      },
    });

    expect(await declined.run(['update', '--id', b.instance_id])).toBe(0);

    // B's staging took up A's image as its :next, and its discard removed only that tag.
    expect(staged).toBe(shared);
    expect(state.tags.has(`${imageBase(b)}:next`)).toBe(false);
    expect(state.tags.get(`${imageBase(a)}:latest`)).toBe(shared);
    expect(state.tags.get(`${imageBase(b)}:latest`)).toBe(bRan);
    expect(state.labels.get(shared)).toBe(releaseAgentImageKey(next));
    expect([...state.tags.keys()].filter(isHold)).toEqual([]);
  });

  it("rolls back an update cut short after its retag, though a peer's update since released the image it displaced", async () => {
    const { host, a, b, next, state } = await pair();
    // Both assistants keep the same image as :previous, as two assistants that moved from one release do.
    const kept = imageId();
    state.ids.add(kept);
    for (const runtime of [a, b]) state.tags.set(`${imageBase(runtime)}:previous`, kept);
    const aRan = state.tags.get(`${imageBase(a)}:latest`)!;
    state.hangAt = 'verify';
    await killDuringCutover(host, a, state, next);
    delete state.hangAt;
    // A's retag took its :previous off that image, and A holds it while its update may yet be reverted.
    expect(state.tags.get(`${imageBase(a)}:previous`)).toBe(aRan);
    expect(state.tags.get(heldImageTag(imageBase(a), kept))).toBe(kept);

    // B's update moves its own :previous off the same image and releases it: A's hold keeps it.
    expect(await cli(host, state, next, b).run(['update', '--id', b.instance_id, '--yes'])).toBe(0);
    expect(state.ids.has(kept)).toBe(true);

    expect(await cli(host, state, next, a).run(['rollback', '--id', a.instance_id, '--yes'])).toBe(0);

    expect(state.tags.get(`${imageBase(a)}:latest`)).toBe(aRan);
    expect(state.tags.get(`${imageBase(a)}:previous`)).toBe(kept);
    // The image A's update built stays for B, which runs it; nothing is held any more.
    expect(state.ids.has(state.tags.get(`${imageBase(b)}:latest`)!)).toBe(true);
    expect([...state.tags.keys()].filter(isHold)).toEqual([]);
  });

  it("keeps the image the assistant runs when NanoClaw's build hands it back from the cache, labeling a copy", async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host);
    const state = world(runtime);
    const base = imageBase(runtime);
    const ran = state.tags.get(`${base}:latest`)!;
    // Nothing the image is built from changed since it was built, unlabeled, so Docker's cache hands it back.
    state.cachedBuild = true;

    await stage(host, runtime, dependencies(state, next, runtime));

    expect(state.tags.get(`${base}:latest`)).toBe(ran);
    expect(state.ids.has(ran)).toBe(true);
    const built = state.tags.get(`${base}:next`)!;
    expect(built).not.toBe(ran);
    expect(state.labels.get(built)).toBe(releaseAgentImageKey(next));
    expect(state.tags.has(`${base}:building`)).toBe(false);
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
    expect(out).toContain('Update cancelled. The assistant is unchanged.');
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

  it('refuses a stopped assistant naming gws-ea start, staging nothing, and without offering to retry the update', async () => {
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
    expect(await exists(host.paths.releaseRoot(runtime.instance_id, 'next'))).toBe(false);
    expect(state.running).toBe(false);
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

describe("main's template across an update (R11)", GIT_HEAVY, () => {
  it("an update to a release with a changed template leaves main's folder byte-identical", async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host, mainTemplate('2'));
    const state = world(runtime);
    // Each entry by type, mode, and content: the carry keeps modification times only to the millisecond.
    const main = async () =>
      new Map(
        [...(await snapshot(path.join(runtime.checkout_realpath, MAIN_FOLDER)))].map(([entry, facts]) => [
          entry,
          facts.replace(/^file (\d+) \S+ /u, 'file $1 '),
        ]),
      );
    const before = await main();

    expect(await cli(host, state, next, runtime).run(['update', '--id', runtime.instance_id, '--yes'])).toBe(0);

    expect(await main()).toEqual(before);
  });
});
