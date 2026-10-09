/**
 * `update --all` shows its plan, asks once, then updates, one at a time and
 * in the order `list` shows them, every assistant on the machine that can
 * move to the tool's release, and skips and reports the rest. Each assistant
 * is built by the cutover fixture as create leaves it; they share one Docker
 * and one release repository, and each one's host answers for its own
 * checkout. Git, SQLite, and the files are real; the service manager, Docker,
 * the release's scripts and migration registry, the hosts, OneCLI, and `ncl`
 * are faked at their boundaries.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { writePrivate } from '../community-portal/private-file.js';
import { migrations as builtInMigrations } from '../db/migrations/index.js';
import { gwsEaProfileMigration } from '../modules/gws-ea-profile/migration.js';
import {
  ADDED_MIGRATION,
  applying,
  assistant,
  cli,
  exists,
  git,
  hostStatus,
  imageBase,
  imageId,
  layoutOf,
  LIVE_MIGRATIONS,
  machine,
  NEW_IMAGE,
  nextRelease,
  release,
  releaseAgentImageKey,
  releaseTag,
  removeTemporaryRoots,
  services,
  snapshot,
  world,
  type Machine,
  type Release,
  type World,
} from './testing/cutover-fixture.js';
import type { CliRuntime } from './cli.js';
import { removeToolCheckouts, toolCheckoutWorld } from './testing/stray-fixture.js';
import { acquireInstanceOperation, reserveInstance } from './journal.js';
import { advanceOperation, beginOperation, readOperationRecord } from './operation.js';
import { getInstanceReservation, swapInstanceRelease } from './registry.js';
import type { HostStatusHelpers, InstanceRuntimeConfig } from './service.js';
import type { NanoclawServiceHelpers } from './service-control.js';
import { releaseOf, type ReleaseCoordinates } from './types.js';
import type { UpdatePreview } from './update.js';
import { registeredReleaseMigrations, type UpdateAllPlan } from './update-all.js';
import { releaseName } from './release-layout.js';

afterEach(async () => {
  await removeTemporaryRoots();
  await removeToolCheckouts();
});

/** Each case clones, fetches, and stages real Git repositories, which a loaded machine slows. */
const GIT_HEAVY = { timeout: 60_000 } as const;

function short(commit: string): string {
  return commit.slice(0, 12);
}

/**
 * Assistants on one machine and one Docker, each served by its own host.
 * The first one's world holds every assistant's images; the others' agent
 * images are added beside its own.
 */
interface Fleet {
  readonly host: Machine;
  readonly next: Release;
  readonly state: World;
  readonly assistants: readonly InstanceRuntimeConfig[];
  /** The install IDs whose service is stopped. */
  readonly stopped: Set<string>;
}

async function fleet(host: Machine, next: Release, assistants: readonly InstanceRuntimeConfig[]): Promise<Fleet> {
  const [first, ...others] = assistants;
  if (!first) throw new Error('A fleet needs an assistant');
  const state = world(first);
  for (const runtime of others) {
    for (const tag of [releaseTag(runtime, host.first), `${imageBase(runtime)}:ag-research`]) {
      const id = imageId();
      state.tags.set(tag, id);
      state.ids.add(id);
    }
  }
  return { host, next, state, assistants, stopped: new Set() };
}

/** NanoClaw's service helpers for the fleet: the fixture's, with each stopped assistant's service detected inactive. */
function fleetServices({ state, stopped }: Fleet): NanoclawServiceHelpers {
  const base = services(state);
  return {
    ...base,
    detectService: (root, env) => {
      const handle = base.detectService(root, env);
      return stopped.has(env.installSlug) ? { ...handle, active: false } : handle;
    },
  };
}

/** Each assistant's host answers for its own checkout, on its own webhook port. */
function fleetHosts({ host, state, assistants }: Fleet): HostStatusHelpers {
  const of = (root: string): HostStatusHelpers => {
    const runtime = assistants.find((candidate) =>
      root.startsWith(`${host.paths.instanceRoot(candidate.instance_id)}${path.sep}`),
    );
    if (!runtime) throw new Error(`No assistant of the fleet runs from ${root}`);
    return hostStatus(state, runtime);
  };
  return {
    queryHost: (root, timeoutMs) => of(root).queryHost(root, timeoutMs),
    waitForHost: (root, options) => of(root).waitForHost(root, options),
  };
}

/**
 * `gws-ea` on the fleet's machine, with the tool at its next release, whose
 * migrations are those every assistant has applied unless a test adds one.
 */
function fleetCli(fleet: Fleet, overrides: Partial<CliRuntime> = {}) {
  const [first] = fleet.assistants;
  return cli(fleet.host, fleet.state, fleet.next, first!, {
    serviceHelpers: fleetServices(fleet),
    hostStatus: fleetHosts(fleet),
    releaseMigrations: async () => LIVE_MIGRATIONS,
    ...overrides,
  });
}

/** Leave an update of `runtime` to `to` unfinished at `fenced`, as one killed there leaves it. */
async function openUpdate(host: Machine, runtime: InstanceRuntimeConfig, to: ReleaseCoordinates): Promise<void> {
  const operation = await acquireInstanceOperation(host.paths, runtime.instance_id, { command: 'update', target: to });
  if (!operation) throw new Error('The test instance operation was busy');
  try {
    await beginOperation(operation, { kind: 'update', from: release(host, host.first), to });
    await advanceOperation(operation, 'fenced', { stop: { at: '2026-09-28T10:00:00.000Z', graceful: true } });
  } finally {
    operation.release();
  }
}

/** Everything an update could change of one assistant: its files, run logs, registry entry, and images. */
async function footprint(fleet: Fleet, runtime: InstanceRuntimeConfig) {
  const { paths } = fleet.host;
  const logs = paths.instanceLogsRoot(runtime.instance_id);
  const base = `${imageBase(runtime)}:`;
  return {
    files: await snapshot(paths.instanceRoot(runtime.instance_id)),
    logs: (await exists(logs)) ? await readdir(logs) : [],
    registered: await getInstanceReservation(paths, runtime.instance_id),
    images: [...fleet.state.tags].filter(([tag]) => tag.startsWith(base)),
  };
}

/** The service calls that reached an assistant: only observing it leaves `detect`. */
function serviceCallsOf(state: World, runtime: InstanceRuntimeConfig): string[] {
  return state.serviceCalls.filter((call) => call.endsWith(` ${runtime.install_id}`));
}

async function expectOnRelease(host: Machine, runtime: InstanceRuntimeConfig, commit: string): Promise<void> {
  expect(releaseOf(await getInstanceReservation(host.paths, runtime.instance_id))).toEqual(release(host, commit));
  expect(git(runtime.checkout_root, 'rev-parse', 'HEAD')).toBe(commit);
  expect(await readOperationRecord(host.paths, runtime.instance_id)).toBeUndefined();
}

describe('gws-ea update --all', GIT_HEAVY, () => {
  it('updates only the assistants that can move, in list order, and skips and reports the rest, untouched', async () => {
    const host = await machine();
    // A mirror whose track never receives the next release: the assistant installed from it is not on its track.
    const mirror = path.join(host.root, 'mirror.git');
    git(host.root, 'clone', '--quiet', '--bare', host.remote, mirror);
    git(mirror, 'config', 'uploadpack.allowFilter', 'true');
    // Created in another order than `list` shows them, which is by hostname.
    const later = await assistant(host, { port: 37_301 });
    const current = await assistant(host, { port: 37_001 });
    const earlier = await assistant(host, { port: 37_101 });
    const stopped = await assistant(host, { port: 37_201 });
    const unfinished = await assistant(host, { port: 37_401 });
    const offTrack = await assistant(host, { port: 37_501 });
    await swapInstanceRelease(host.paths, offTrack.instance_id, release(host, host.first), {
      ...release(host, host.first),
      source_remote: mirror,
    });
    const next = await nextRelease(host);
    await openUpdate(host, unfinished, release(host, 'e'.repeat(40)));
    const machineFleet = await fleet(host, next, [later, current, earlier, stopped, unfinished, offTrack]);
    machineFleet.stopped.add(stopped.install_id);
    expect(await fleetCli(machineFleet).run(['update', '--id', current.instance_id, '--yes'])).toBe(0);
    const skipped = [current, stopped, unfinished, offTrack];
    const before = await Promise.all(skipped.map((runtime) => footprint(machineFleet, runtime)));
    const confirmUpdate = vi.fn(async (_preview: UpdatePreview) => false);
    const confirmUpdateAll = vi.fn(async (_plan: UpdateAllPlan) => false);
    const { run, out, err } = fleetCli(machineFleet, { confirmUpdate, confirmUpdateAll });

    expect(await run(['update', '--all', '--yes'])).toBe(0);

    // --yes answers the plan's question, and no assistant is asked about on its own.
    expect(confirmUpdateAll).not.toHaveBeenCalled();
    expect(confirmUpdate).not.toHaveBeenCalled();
    expect(err).toEqual([]);
    // Only the two that could move were updated, in list order, each with its own preview and summary.
    expect(out.filter((line) => line.startsWith('Assistant: '))).toEqual([
      `Assistant: ${earlier.instance_id}`,
      `Assistant: ${later.instance_id}`,
    ]);
    expect(out.filter((line) => line.includes(' was updated to '))).toEqual([
      `Assistant ${earlier.instance_id} was updated to dogfood ${short(next.commit)}.`,
      `Assistant ${later.instance_id} was updated to dogfood ${short(next.commit)}.`,
    ]);
    await expectOnRelease(host, earlier, next.commit);
    await expectOnRelease(host, later, next.commit);
    // The plan names, before anything is updated, each one that moves, from and to, with the migrations it adds,
    // then the ones that cannot move, with why and what moves them.
    const from = `dogfood ${short(host.first)}`;
    const to = `dogfood ${short(next.commit)}`;
    const reasons = [
      `Skipped ${current.instance_id}: It already runs dogfood ${short(next.commit)}, this tool's release.`,
      `Skipped ${stopped.instance_id}: It is stopped, and an update proves its new release on a running assistant; start it with gws-ea start --id ${stopped.instance_id}, then update it.`,
      `Skipped ${unfinished.instance_id}: Its update to dogfood ${'e'.repeat(12)} is unfinished (fenced); continue it with gws-ea update --id ${unfinished.instance_id}, or revert it with gws-ea rollback --id ${unfinished.instance_id}.`,
      expect.stringMatching(
        new RegExp(
          `^Skipped ${offTrack.instance_id}: gws-ea is at ${short(next.commit)}, which is not on release track dogfood`,
          'u',
        ),
      ),
    ];
    const firstTurn = out.indexOf(`Updating assistant ${earlier.instance_id} (1 of 2)…`);
    expect(out.slice(0, firstTurn)).toEqual([
      'Checking which assistants can be updated…',
      `Plan: update 2 assistants to this tool's release ${short(next.commit)}, one at a time:`,
      `Update ${earlier.instance_id}: ${from} → ${to}; database migrations to add: none`,
      `Update ${later.instance_id}: ${from} → ${to}; database migrations to add: none`,
      ...reasons,
    ]);
    // Then summarized: what was updated, from and to, and what was skipped, and why.
    expect(out.slice(-7)).toEqual([
      'update --all finished: 2 updated, 4 skipped.',
      `Updated ${earlier.instance_id}: ${from} → ${to}`,
      `Updated ${later.instance_id}: ${from} → ${to}`,
      ...reasons,
    ]);
    // Nothing of the skipped ones changed: files, run logs, registry entry, and images.
    expect(await Promise.all(skipped.map((runtime) => footprint(machineFleet, runtime)))).toEqual(before);
  });

  it('skips an assistant on the legacy layout with the command that converts it', async () => {
    const host = await machine();
    const legacy = await assistant(host, { port: 37_001 });
    const next = await nextRelease(host);
    // The one field only a registry entry from before release folders carries.
    const registry = JSON.parse(await readFile(host.paths.registryFile, 'utf8')) as {
      instances: Record<string, Record<string, unknown>>;
    };
    registry.instances[legacy.instance_id]!.checkout_realpath = path.join(
      host.paths.stateRoot,
      'instances',
      legacy.instance_id,
      'nanoclaw',
    );
    await writePrivate(host.paths.registryFile, registry);
    const { run, out } = fleetCli(await fleet(host, next, [legacy]));

    expect(await run(['update', '--all', '--yes'])).toBe(0);

    expect(out).toContain(
      `Skipped ${legacy.instance_id}: Assistant ${legacy.instance_id} is on the legacy layout: run gws-ea update --id ${legacy.instance_id} to convert it.`,
    );
  });

  it('stops at the first assistant whose update fails, leaving the next one unattempted and untouched', async () => {
    const host = await machine();
    const first = await assistant(host, { port: 37_001 });
    const second = await assistant(host, { port: 37_101 });
    const next = await nextRelease(host, NEW_IMAGE);
    const machineFleet = await fleet(host, next, [first, second]);
    machineFleet.state.buildFails = true;
    const untouched = await footprint(machineFleet, second);
    const { run, out, err } = fleetCli(machineFleet);

    expect(await run(['update', '--all', '--yes'])).toBe(1);

    // The failed assistant's own stop summary, with its own recovery guidance.
    const summary = err.join('\n');
    expect(summary).toContain(
      'Stopped at Preparing the new release beside the running assistant (stage_release): bash exited with code 1',
    );
    expect(summary).toContain(`Retry with: gws-ea update --id ${first.instance_id} --yes`);
    expect(await exists(layoutOf(host, first).receipt(releaseName(next.commit)))).toBe(false);
    await expectOnRelease(host, first, host.first);
    // Then where the run stopped, and what it never reached.
    expect(err.slice(-3)).toEqual([
      `update --all stopped at assistant ${first.instance_id}; 1 not attempted.`,
      `Stopped at ${first.instance_id}; its summary above says why and what to run.`,
      `Not attempted: ${second.instance_id}`,
    ]);
    expect(out).not.toContain(`Updating assistant ${second.instance_id} (2 of 2)…`);
    // The next one was only observed, never updated.
    expect(await footprint(machineFleet, second)).toEqual(untouched);
    expect(new Set(serviceCallsOf(machineFleet.state, second))).toEqual(new Set([`detect ${second.install_id}`]));
  });

  it("stops at the turn that finds the tool's checkout moved off the release the run set out with, updating it to neither", async () => {
    const host = await machine();
    const first = await assistant(host, { port: 37_001 });
    const second = await assistant(host, { port: 37_101 });
    const next = await nextRelease(host);
    const machineFleet = await fleet(host, next, [first, second]);
    // A later release on the track, which the tool's checkout, still clean, is moved to once the first turn ends.
    const later = await nextRelease(host);
    const { logs: _logs, ...untouched } = await footprint(machineFleet, second);
    const out: string[] = [];
    const { run, err } = fleetCli(machineFleet, {
      stdout: (line) => {
        out.push(line);
        if (line !== `Updating assistant ${second.instance_id} (2 of 2)…`) return;
        git(next.tool, 'fetch', '--quiet', 'origin');
        git(next.tool, 'checkout', '--quiet', '--detach', later.commit);
      },
    });

    expect(await run(['update', '--all', '--yes'])).toBe(1);

    // The first went to the release the run announced; the second was refused before anything was staged.
    expect(out).toContain(`Plan: update 2 assistants to this tool's release ${short(next.commit)}, one at a time:`);
    await expectOnRelease(host, first, next.commit);
    await expectOnRelease(host, second, host.first);
    expect(await exists(layoutOf(host, second).release(releaseName(next.commit)))).toBe(false);
    const { logs: _after, ...left } = await footprint(machineFleet, second);
    expect(left).toEqual(untouched);
    expect(new Set(serviceCallsOf(machineFleet.state, second))).toEqual(new Set([`detect ${second.install_id}`]));
    expect(err).toContain(
      `gws-ea's checkout ${next.tool} moved from ${short(next.commit)} to ${short(later.commit)} while update --all ran, ` +
        `so assistant ${second.instance_id} was not updated: one run deploys only the release it started with, ${short(next.commit)}. ` +
        `Run gws-ea update --all again to update to ${short(later.commit)}.`,
    );
    expect(err.slice(-3)).toEqual([
      `update --all stopped at assistant ${second.instance_id}.`,
      `Updated ${first.instance_id}: dogfood ${short(host.first)} → dogfood ${short(next.commit)}`,
      `Stopped at ${second.instance_id}; its summary above says why and what to run.`,
    ]);
  });

  it('never offers to retry a failed turn when run interactively: it stops there as it does with --yes', async () => {
    const host = await machine();
    const first = await assistant(host, { port: 37_001 });
    const second = await assistant(host, { port: 37_101 });
    const next = await nextRelease(host, NEW_IMAGE);
    const machineFleet = await fleet(host, next, [first, second]);
    machineFleet.state.buildFails = true;
    const untouched = await footprint(machineFleet, second);
    // Asked, it would retry once, then stop.
    const onFailure = vi
      .fn<NonNullable<CliRuntime['onFailure']>>()
      .mockResolvedValueOnce('retry')
      .mockResolvedValue('stop');
    const confirmUpdate = vi.fn(async (_preview: UpdatePreview) => true);
    const confirmUpdateAll = vi.fn(async (_plan: UpdateAllPlan) => true);
    const { run, out, err } = fleetCli(machineFleet, { onFailure, confirmUpdate, confirmUpdateAll });

    expect(await run(['update', '--all'])).toBe(1);

    expect(onFailure).not.toHaveBeenCalled();
    // Only the plan was asked about, once.
    expect(confirmUpdateAll).toHaveBeenCalledOnce();
    expect(confirmUpdate).not.toHaveBeenCalled();
    const summary = err.join('\n');
    expect(summary).toContain(
      'Stopped at Preparing the new release beside the running assistant (stage_release): bash exited with code 1',
    );
    expect(summary).toContain(`Retry with: gws-ea update --id ${first.instance_id}`);
    expect(summary.match(/Stopped at Preparing the new release/gu)).toHaveLength(1);
    await expectOnRelease(host, first, host.first);
    expect(err.slice(-3)).toEqual([
      `update --all stopped at assistant ${first.instance_id}; 1 not attempted.`,
      `Stopped at ${first.instance_id}; its summary above says why and what to run.`,
      `Not attempted: ${second.instance_id}`,
    ]);
    expect(out).not.toContain(`Updating assistant ${second.instance_id} (2 of 2)…`);
    expect(await footprint(machineFleet, second)).toEqual(untouched);
  });

  it('skips one whose service is not installed, runs outside it, or cannot be observed, or whose record is unreadable', async () => {
    const host = await machine();
    const notInstalled = await assistant(host, { port: 37_001 });
    const unmanaged = await assistant(host, { port: 37_101 });
    const unobserved = await assistant(host, { port: 37_201 });
    const unreadable = await assistant(host, { port: 37_301 });
    const next = await nextRelease(host);
    const machineFleet = await fleet(host, next, [notInstalled, unmanaged, unobserved, unreadable]);
    await writeFile(host.paths.operationFile(unreadable.instance_id), '{ not a record\n', { mode: 0o600 });
    const base = fleetServices(machineFleet);
    const serviceHelpers: NanoclawServiceHelpers = {
      ...base,
      detectService: (root, env) => {
        switch (env.installSlug) {
          case notInstalled.install_id:
            return { mode: 'none', active: false };
          case unmanaged.install_id:
            return { mode: 'unmanaged', active: true, pid: 4343 };
          case unobserved.install_id:
            throw Object.assign(new Error('launchctl print failed'), { code: 'EPERM' });
          default:
            return base.detectService(root, env);
        }
      },
    };
    const before = await Promise.all(machineFleet.assistants.map((runtime) => footprint(machineFleet, runtime)));
    const { run, out } = fleetCli(machineFleet, { serviceHelpers });

    expect(await run(['update', '--all', '--yes'])).toBe(0);

    expect(out).toEqual([
      'Checking which assistants can be updated…',
      `Nothing to update: no assistant here can move to this tool's release ${short(next.commit)}.`,
      `Skipped ${notInstalled.instance_id}: No NanoClaw service is installed for it; gws-ea resume --id ${notInstalled.instance_id} installs it.`,
      `Skipped ${unmanaged.instance_id}: A NanoClaw host runs from its checkout outside its service (PID 4343). Stop that process and start it with gws-ea start --id ${unmanaged.instance_id}, then update it.`,
      `Skipped ${unobserved.instance_id}: Its service could not be observed: launchctl print failed`,
      `Skipped ${unreadable.instance_id}: Its update or rollback record cannot be read: Operation record is not valid JSON`,
    ]);
    expect(await Promise.all(machineFleet.assistants.map((runtime) => footprint(machineFleet, runtime)))).toEqual(
      before,
    );
  });

  it('shows the whole plan and asks once, before anything is staged; a no changes nothing (exit 0)', async () => {
    const host = await machine();
    const first = await assistant(host, { port: 37_001 });
    const unreadable = await assistant(host, { port: 37_101 });
    const next = await nextRelease(host);
    const machineFleet = await fleet(host, next, [first, unreadable]);
    // A database the plan cannot read is named, not a reason to stop.
    await writeFile(path.join(unreadable.checkout_root, 'data', 'v2.db'), 'not a database\n');
    const before = await Promise.all(machineFleet.assistants.map((runtime) => footprint(machineFleet, runtime)));
    const asked: Array<{ readonly toolCommit: string; readonly shown: readonly string[]; readonly staged: boolean }> =
      [];
    const confirmUpdate = vi.fn(async (_preview: UpdatePreview) => true);
    const { run, out, err } = fleetCli(machineFleet, {
      releaseMigrations: async () => [...LIVE_MIGRATIONS, ADDED_MIGRATION],
      confirmUpdate,
      confirmUpdateAll: async (plan) => {
        const staging = machineFleet.assistants.map((runtime) =>
          exists(layoutOf(host, runtime).release(releaseName(next.commit))),
        );
        asked.push({
          toolCommit: plan.toolCommit,
          shown: [...out],
          staged: (await Promise.all(staging)).some(Boolean),
        });
        return false;
      },
    });

    expect(await run(['update', '--all'])).toBe(0);

    const from = `dogfood ${short(host.first)}`;
    const to = `dogfood ${short(next.commit)}`;
    const plan = [
      'Checking which assistants can be updated…',
      `Plan: update 2 assistants to this tool's release ${short(next.commit)}, one at a time:`,
      `Update ${first.instance_id}: ${from} → ${to}; database migrations to add: ${ADDED_MIGRATION}`,
      `Update ${unreadable.instance_id}: ${from} → ${to}; database migrations to add: unknown (its database could not be read)`,
    ];
    // Asked once, about the whole plan, with nothing yet staged; no assistant is asked about on its own.
    expect(asked).toEqual([{ toolCommit: next.commit, shown: plan, staged: false }]);
    expect(confirmUpdate).not.toHaveBeenCalled();
    expect(out).toEqual([...plan, 'Update cancelled. No assistant was changed.']);
    expect(err).toEqual([]);
    // Nothing of either changed: files, run logs, registry entry, and images; each was only observed.
    expect(await Promise.all(machineFleet.assistants.map((runtime) => footprint(machineFleet, runtime)))).toEqual(
      before,
    );
    for (const runtime of machineFleet.assistants) {
      expect(new Set(serviceCallsOf(machineFleet.state, runtime))).toEqual(new Set([`detect ${runtime.install_id}`]));
    }
  });

  it('updates every assistant in its plan once that is confirmed, never asking about one on its own', async () => {
    const host = await machine();
    const first = await assistant(host, { port: 37_001 });
    const second = await assistant(host, { port: 37_101 });
    const next = await nextRelease(host);
    const machineFleet = await fleet(host, next, [first, second]);
    machineFleet.state.migrate = applying(ADDED_MIGRATION);
    // Asked, each assistant would be declined.
    const confirmUpdate = vi.fn(async (_preview: UpdatePreview) => false);
    const confirmUpdateAll = vi.fn(async (_plan: UpdateAllPlan) => true);
    const tool = await toolCheckoutWorld();
    const { run, out, err } = fleetCli(machineFleet, {
      releaseMigrations: async () => [...LIVE_MIGRATIONS, ADDED_MIGRATION],
      confirmUpdate,
      confirmUpdateAll,
      toolCheckout: tool.checkout,
    });

    expect(await run(['update', '--all'])).toBe(0);

    // The tool checkout was checked for a stray NanoClaw install once for the run, not once per assistant.
    expect(tool.calls).toEqual([
      `docker ps -aq --filter label=nanoclaw-install=${tool.slug}`,
      `docker image ls --format {{.Repository}}:{{.Tag}} ${tool.names.containerImageBase}`,
    ]);
    expect(confirmUpdateAll).toHaveBeenCalledOnce();
    expect(confirmUpdate).not.toHaveBeenCalled();
    expect(err).toEqual([]);
    await expectOnRelease(host, first, next.commit);
    await expectOnRelease(host, second, next.commit);
    // What the plan said each adds is what each one's dry run on a copy of its database added.
    const from = `dogfood ${short(host.first)}`;
    const to = `dogfood ${short(next.commit)}`;
    expect(out).toContain(
      `Update ${first.instance_id}: ${from} → ${to}; database migrations to add: ${ADDED_MIGRATION}`,
    );
    expect(out).toContain(
      `Update ${second.instance_id}: ${from} → ${to}; database migrations to add: ${ADDED_MIGRATION}`,
    );
    expect(out.filter((line) => line.startsWith('Database migrations to add: '))).toEqual([
      `Database migrations to add: ${ADDED_MIGRATION}`,
      `Database migrations to add: ${ADDED_MIGRATION}`,
    ]);
    expect(out.slice(-3)).toEqual([
      'update --all finished: 2 updated.',
      `Updated ${first.instance_id}: ${from} → ${to}`,
      `Updated ${second.instance_id}: ${from} → ${to}`,
    ]);
  });

  it("builds the release's agent image once for all the assistants it updates, each running that one image", async () => {
    const host = await machine();
    const first = await assistant(host, { port: 37_001 });
    const second = await assistant(host, { port: 37_101 });
    const next = await nextRelease(host, NEW_IMAGE);
    const machineFleet = await fleet(host, next, [first, second]);
    const { state } = machineFleet;

    expect(await fleetCli(machineFleet).run(['update', '--all', '--yes'])).toBe(0);

    await expectOnRelease(host, first, next.commit);
    await expectOnRelease(host, second, next.commit);
    expect(state.commands.filter((command) => command.command === 'bash')).toHaveLength(1);
    const [image, other] = [first, second].map((runtime) => state.tags.get(releaseTag(runtime, next.commit)));
    expect(other).toBe(image);
    expect(state.labels.get(image!)).toBe(releaseAgentImageKey(next));
  });

  it('stops with exit 75 when another command holds an assistant, leaving the next one untouched', async () => {
    const host = await machine();
    const first = await assistant(host, { port: 37_001 });
    const second = await assistant(host, { port: 37_101 });
    const next = await nextRelease(host);
    const machineFleet = await fleet(host, next, [first, second]);
    const untouched = await footprint(machineFleet, second);
    const held = await acquireInstanceOperation(host.paths, first.instance_id, { command: 'start' });
    const { run, err } = fleetCli(machineFleet);
    try {
      expect(await run(['update', '--all', '--yes'])).toBe(75);
    } finally {
      held?.release();
    }

    expect(err).toContain('Instance operation is already in progress; no action was taken.');
    expect(err.slice(-3)).toEqual([
      `update --all stopped: another command holds assistant ${first.instance_id}; 1 not attempted.`,
      `Stopped at ${first.instance_id}; its summary above says why and what to run.`,
      `Not attempted: ${second.instance_id}`,
    ]);
    await expectOnRelease(host, first, host.first);
    expect(await footprint(machineFleet, second)).toEqual(untouched);
  });

  it('exits 0 with nothing to update when no assistant can move, staging nothing and asking nothing', async () => {
    const host = await machine();
    const current = await assistant(host, { port: 37_001 });
    const stopped = await assistant(host, { port: 37_101 });
    const next = await nextRelease(host);
    const machineFleet = await fleet(host, next, [current, stopped]);
    expect(await fleetCli(machineFleet).run(['update', '--id', current.instance_id, '--yes'])).toBe(0);
    machineFleet.stopped.add(stopped.install_id);
    const confirmUpdateAll = vi.fn(async (_plan: UpdateAllPlan) => true);
    const { run, out } = fleetCli(machineFleet, { confirmUpdateAll });

    expect(await run(['update', '--all'])).toBe(0);

    expect(confirmUpdateAll).not.toHaveBeenCalled();
    expect(out).toEqual([
      'Checking which assistants can be updated…',
      `Nothing to update: no assistant here can move to this tool's release ${short(next.commit)}.`,
      `Skipped ${current.instance_id}: It already runs dogfood ${short(next.commit)}, this tool's release.`,
      `Skipped ${stopped.instance_id}: It is stopped, and an update proves its new release on a running assistant; start it with gws-ea start --id ${stopped.instance_id}, then update it.`,
    ]);
    expect(await exists(layoutOf(host, stopped).release(releaseName(next.commit)))).toBe(false);
    await expectOnRelease(host, stopped, host.first);
  });

  it('names a removal under way and an unfinished create, each with the command that finishes it', async () => {
    const host = await machine();
    const removing = await assistant(host, { port: 37_001 });
    const next = await nextRelease(host);
    const machineFleet = await fleet(host, next, [removing]);
    await mkdir(path.dirname(host.paths.removalFile(removing.instance_id)), { recursive: true, mode: 0o700 });
    await writeFile(host.paths.removalFile(removing.instance_id), '{}\n', { mode: 0o600 });
    // Reserved as create reserves it, with no step of its provisioning finished.
    const creating = randomUUID();
    await reserveInstance(host.paths, {
      instance_id: creating,
      source_remote: host.remote,
      release_track: 'dogfood',
      deployed_commit: host.first,
      allocated_ports: { nanoclaw_webhook: 37_101, onecli_app: 37_102, onecli_gateway: 37_103 },
      exclusive_resource_claims: {
        ingress: { mode: 'existing', endpoint_url: 'https://a37101.example.test/webhook/gchat' },
        gcp_project_id: 'update-37101',
        gcp_account: 'operator@example.test',
        gchat_service_account: 'gws-ea-chat@update-37101.iam.gserviceaccount.com',
        workspace_email: 'a37101@example.test',
        onecli_project: `gws-ea-${creating.replaceAll('-', '')}`,
      },
    });
    const { run, out } = fleetCli(machineFleet);

    expect(await run(['update', '--all', '--yes'])).toBe(0);

    expect(out.slice(-2)).toEqual([
      `Skipped ${removing.instance_id}: Its removal is in progress; finish it with gws-ea remove --id ${removing.instance_id}.`,
      `Skipped ${creating}: Assistant ${creating} is not fully created; finish creating it with gws-ea resume --id ${creating}.`,
    ]);
    await expectOnRelease(host, removing, host.first);
  });

  it('updates nothing when it cannot tell whether an assistant can be updated, naming that assistant', async () => {
    const host = await machine();
    const unreadable = await assistant(host, { port: 37_001 });
    const eligible = await assistant(host, { port: 37_101 });
    const next = await nextRelease(host);
    const machineFleet = await fleet(host, next, [unreadable, eligible]);
    await rm(layoutOf(host, unreadable).receipt(releaseName(host.first)));
    const { run, out, err } = fleetCli(machineFleet);

    expect(await run(['update', '--all', '--yes'])).toBe(1);

    expect(err).toEqual([
      `Could not tell whether assistant ${unreadable.instance_id} can be updated (ENOENT); gws-ea status --id ${unreadable.instance_id} shows its state. Nothing was updated.`,
    ]);
    expect(out).toEqual(['Checking which assistants can be updated…']);
    await expectOnRelease(host, eligible, host.first);
  });

  it("stops before checking any assistant when the tool's own checkout cannot be deployed", async () => {
    const host = await machine();
    const runtime = await assistant(host, { port: 37_001 });
    const next = await nextRelease(host);
    const machineFleet = await fleet(host, next, [runtime]);
    await writeFile(path.join(next.tool, 'release.txt'), 'edited\n');
    const { run, out, err } = fleetCli(machineFleet);

    expect(await run(['update', '--all', '--yes'])).toBe(1);

    expect(err.join('\n')).toContain("gws-ea's checkout has tracked changes, so it is not the release it would deploy");
    expect(out.join('\n')).not.toContain('Skipped');
    expect(machineFleet.state.serviceCalls).toEqual([]);
    await expectOnRelease(host, runtime, host.first);
  });

  it("finishes the follow-ups an update to the tool's release left, as update --id does, and skips one with none left", async () => {
    const host = await machine();
    const pending = await assistant(host, { port: 37_001 });
    const done = await assistant(host, { port: 37_101 });
    const next = await nextRelease(host);
    const machineFleet = await fleet(host, next, [pending, done]);
    expect(await fleetCli(machineFleet).run(['update', '--id', done.instance_id, '--yes'])).toBe(0);
    machineFleet.state.rebuildFails = true;
    expect(await fleetCli(machineFleet).run(['update', '--id', pending.instance_id, '--yes'])).toBe(1);
    expect((await readOperationRecord(host.paths, pending.instance_id))?.phase).toBe('committed');
    machineFleet.state.rebuildFails = false;
    const rebuilds = machineFleet.state.rebuilds.length;
    const { run, out } = fleetCli(machineFleet);

    expect(await run(['update', '--all', '--yes'])).toBe(0);

    expect(machineFleet.state.rebuilds.length).toBe(rebuilds + 1);
    await expectOnRelease(host, pending, next.commit);
    expect(out).toContain(
      `Assistant ${pending.instance_id} runs dogfood ${short(next.commit)}; its update is finished.`,
    );
    expect(out.slice(-3)).toEqual([
      'update --all finished: 1 completed, 1 skipped.',
      `Completed ${pending.instance_id}'s update to dogfood ${short(next.commit)}: its follow-ups are done`,
      `Skipped ${done.instance_id}: It already runs dogfood ${short(next.commit)}, this tool's release.`,
    ]);
  });

  it("skips a stopped assistant whose update to the tool's release left follow-ups, which need its host, and goes on", async () => {
    const host = await machine();
    const pending = await assistant(host, { port: 37_001 });
    const other = await assistant(host, { port: 37_101 });
    const next = await nextRelease(host);
    const machineFleet = await fleet(host, next, [pending, other]);
    machineFleet.state.rebuildFails = true;
    expect(await fleetCli(machineFleet).run(['update', '--id', pending.instance_id, '--yes'])).toBe(1);
    machineFleet.state.rebuildFails = false;
    machineFleet.stopped.add(pending.install_id);
    const record = await readOperationRecord(host.paths, pending.instance_id);
    expect(record?.phase).toBe('committed');
    expect(record?.follow_ups).toContainEqual(expect.objectContaining({ kind: 'rebuild_group_image' }));
    const rebuilds = machineFleet.state.rebuilds.length;
    const { run, out } = fleetCli(machineFleet);

    expect(await run(['update', '--all', '--yes'])).toBe(0);

    // Skipped as any stopped assistant is, its follow-ups left for its host; only the other one's rebuild ran.
    expect(await readOperationRecord(host.paths, pending.instance_id)).toEqual(record);
    expect(machineFleet.state.rebuilds.length).toBe(rebuilds + 1);
    await expectOnRelease(host, other, next.commit);
    expect(out.slice(-3)).toEqual([
      'update --all finished: 1 updated, 1 skipped.',
      `Updated ${other.instance_id}: dogfood ${short(host.first)} → dogfood ${short(next.commit)}`,
      `Skipped ${pending.instance_id}: It is stopped, and an update proves its new release on a running assistant; start it with gws-ea start --id ${pending.instance_id}, then update it.`,
    ]);
  });
});

describe("the release's migrations, as update --all plans with them", () => {
  it("are NanoClaw's registry as its migration script registers it: its own migrations in order, then its modules'", async () => {
    const names = await registeredReleaseMigrations();

    expect(names.slice(0, builtInMigrations.length)).toEqual(builtInMigrations.map((migration) => migration.name));
    expect(names.slice(builtInMigrations.length)).toContain(gwsEaProfileMigration.name);
  });
});
