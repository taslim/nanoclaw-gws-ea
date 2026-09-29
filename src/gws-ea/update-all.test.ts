/**
 * `update --all` updates, one at a time and in the order `list` shows them,
 * every assistant on the machine that can move to the tool's release, and
 * skips and reports the rest. Each assistant is built by the cutover fixture
 * as create leaves it; they share one Docker and one release repository, and
 * each one's host answers for its own checkout. Git, SQLite, and the files are
 * real; the service manager, Docker, the release's scripts, the hosts,
 * OneCLI, and `ncl` are faked at their boundaries.
 */
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assistant,
  cli,
  exists,
  git,
  hostStatus,
  imageBase,
  imageId,
  machine,
  nextRelease,
  release,
  removeTemporaryRoots,
  services,
  snapshot,
  world,
  type Machine,
  type Release,
  type World,
} from './testing/cutover-fixture.js';
import type { CliRuntime } from './cli.js';
import { acquireInstanceOperation, reserveInstance } from './journal.js';
import { advanceOperation, beginOperation, readOperationRecord } from './operation.js';
import { allocateInstanceId, getInstanceReservation, swapInstanceRelease } from './registry.js';
import type { HostStatusHelpers, InstanceRuntimeConfig } from './service.js';
import type { NanoclawServiceHelpers } from './service-control.js';
import { GwsEaError, releaseOf, type ReleaseCoordinates } from './types.js';
import type { UpdatePreview } from './update.js';

afterEach(removeTemporaryRoots);

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
    for (const tag of [`${imageBase(runtime)}:latest`, `${imageBase(runtime)}:ag-research`]) {
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

/** `gws-ea` on the fleet's machine, with the tool at its next release. */
function fleetCli(fleet: Fleet, overrides: Partial<CliRuntime> = {}) {
  const [first] = fleet.assistants;
  return cli(fleet.host, fleet.state, fleet.next, first!, {
    serviceHelpers: fleetServices(fleet),
    hostStatus: fleetHosts(fleet),
    ...overrides,
  });
}

/** Leave an update of `runtime` to `to` unfinished at `stopped`, as one killed there leaves it. */
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

/** What the terminal's prompt throws when the operator presses Ctrl-C or Esc at an update's preview. */
function cancel(preview: UpdatePreview): GwsEaError {
  return new GwsEaError('cancelled', `The update of assistant ${preview.instanceId} was cancelled`);
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
  expect(git(runtime.checkout_realpath, 'rev-parse', 'HEAD')).toBe(commit);
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
    const later = await assistant(host, 37_301);
    const current = await assistant(host, 37_001);
    const earlier = await assistant(host, 37_101);
    const stopped = await assistant(host, 37_201);
    const unfinished = await assistant(host, 37_401);
    const offTrack = await assistant(host, 37_501);
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
    const { run, out, err } = fleetCli(machineFleet, { confirmUpdate });

    expect(await run(['update', '--all', '--yes'])).toBe(0);

    // --yes answers every preview: nothing is asked.
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
    // The ones that cannot move are named up front, with why and what moves them, before anything is updated.
    const reasons = [
      `Skipped ${current.instance_id}: It already runs dogfood ${short(next.commit)}, this tool's release.`,
      `Skipped ${stopped.instance_id}: It is stopped, and an update proves its new release on a running assistant; start it with gws-ea start --id ${stopped.instance_id}, then update it.`,
      `Skipped ${unfinished.instance_id}: Its update to dogfood ${'e'.repeat(12)} is unfinished (stopped); continue it with gws-ea update --id ${unfinished.instance_id}, or revert it with gws-ea rollback --id ${unfinished.instance_id}.`,
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
      `Updating 2 assistants to this tool's release ${short(next.commit)}, one at a time: ${earlier.instance_id}, ${later.instance_id}.`,
      ...reasons,
    ]);
    // Then summarized: what was updated, from and to, and what was skipped, and why.
    const from = `dogfood ${short(host.first)}`;
    const to = `dogfood ${short(next.commit)}`;
    expect(out.slice(-7)).toEqual([
      'update --all finished: 2 updated, 4 skipped.',
      `Updated ${earlier.instance_id}: ${from} → ${to}`,
      `Updated ${later.instance_id}: ${from} → ${to}`,
      ...reasons,
    ]);
    // Nothing of the skipped ones changed: files, run logs, registry entry, and images.
    expect(await Promise.all(skipped.map((runtime) => footprint(machineFleet, runtime)))).toEqual(before);
  });

  it('stops at the first assistant whose update fails, leaving the next one unattempted and untouched', async () => {
    const host = await machine();
    const first = await assistant(host, 37_001);
    const second = await assistant(host, 37_101);
    const next = await nextRelease(host);
    const machineFleet = await fleet(host, next, [first, second]);
    machineFleet.state.buildFails = true;
    const untouched = await footprint(machineFleet, second);
    const { run, out, err } = fleetCli(machineFleet);

    expect(await run(['update', '--all', '--yes'])).toBe(1);

    // The failed assistant's own stop summary, with its own recovery guidance.
    const summary = err.join('\n');
    expect(summary).toContain('Stopped at Building the new agent image (build_agent_image): bash exited with code 1');
    expect(summary).toContain(`Retry with: gws-ea update --id ${first.instance_id} --yes`);
    expect(await exists(host.paths.releaseRoot(first.instance_id, 'next'))).toBe(false);
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

  it('skips an assistant whose preview is declined, changing nothing of it, and updates the next', async () => {
    const host = await machine();
    const first = await assistant(host, 37_001);
    const second = await assistant(host, 37_101);
    const next = await nextRelease(host);
    const machineFleet = await fleet(host, next, [first, second]);
    const asked: string[] = [];
    const { run, out } = fleetCli(machineFleet, {
      confirmUpdate: async (preview) => {
        asked.push(preview.instanceId);
        return preview.instanceId === second.instance_id;
      },
    });

    expect(await run(['update', '--all'])).toBe(0);

    expect(asked).toEqual([first.instance_id, second.instance_id]);
    await expectOnRelease(host, first, host.first);
    expect(await exists(host.paths.releaseRoot(first.instance_id, 'next'))).toBe(false);
    expect(machineFleet.state.tags.has(`${imageBase(first)}:next`)).toBe(false);
    await expectOnRelease(host, second, next.commit);
    expect(out.slice(-3)).toEqual([
      'update --all finished: 1 updated, 1 declined.',
      `Updated ${second.instance_id}: dogfood ${short(host.first)} → dogfood ${short(next.commit)}`,
      `Declined ${first.instance_id}: nothing was changed`,
    ]);
  });

  it('stops the whole run when the operator cancels at a preview, changing neither assistant (exit 0)', async () => {
    const host = await machine();
    const first = await assistant(host, 37_001);
    const second = await assistant(host, 37_101);
    const next = await nextRelease(host);
    const machineFleet = await fleet(host, next, [first, second]);
    const { logs: _logs, ...cancelled } = await footprint(machineFleet, first);
    const untouched = await footprint(machineFleet, second);
    const asked: string[] = [];
    const { run, out, err } = fleetCli(machineFleet, {
      confirmUpdate: async (preview) => {
        asked.push(preview.instanceId);
        throw cancel(preview);
      },
    });

    expect(await run(['update', '--all'])).toBe(0);

    expect(asked).toEqual([first.instance_id]);
    expect(err).toEqual([]);
    // The cancelled assistant is left as a decline leaves it: its staging removed, nothing recorded or moved.
    expect(out).toContain('Removing the staged release…');
    expect(out).toContain('Update cancelled. Nothing was changed.');
    const { logs: _after, ...left } = await footprint(machineFleet, first);
    expect(left).toEqual(cancelled);
    await expectOnRelease(host, first, host.first);
    expect(await exists(host.paths.releaseRoot(first.instance_id, 'next'))).toBe(false);
    expect(machineFleet.state.tags.has(`${imageBase(first)}:next`)).toBe(false);
    expect(out.slice(-3)).toEqual([
      `update --all was stopped by the operator at assistant ${first.instance_id}; 1 not attempted.`,
      `Stopped at ${first.instance_id} by the operator; nothing of it was changed.`,
      `Not attempted: ${second.instance_id}`,
    ]);
    // The next one was only observed, never staged or asked about.
    expect(await footprint(machineFleet, second)).toEqual(untouched);
    expect(new Set(serviceCallsOf(machineFleet.state, second))).toEqual(new Set([`detect ${second.install_id}`]));
  });

  it('keeps update --id cancelling at its preview exactly as a decline: the same output, exit 0', async () => {
    const host = await machine();
    const declined = await assistant(host, 37_001);
    const cancelled = await assistant(host, 37_101);
    const next = await nextRelease(host);
    const machineFleet = await fleet(host, next, [declined, cancelled]);
    const no = fleetCli(machineFleet, { confirmUpdate: async () => false });
    const stop = fleetCli(machineFleet, {
      confirmUpdate: async (preview) => {
        throw cancel(preview);
      },
    });

    expect(await no.run(['update', '--id', declined.instance_id])).toBe(0);
    expect(await stop.run(['update', '--id', cancelled.instance_id])).toBe(0);

    const anonymous = (lines: readonly string[], runtime: InstanceRuntimeConfig): string[] =>
      lines.map((line) => line.replaceAll(runtime.instance_id, '<id>'));
    expect(anonymous(stop.out, cancelled)).toEqual(anonymous(no.out, declined));
    expect(stop.out.at(-1)).toBe('Update cancelled. Nothing was changed.');
    expect(stop.err).toEqual([]);
    await expectOnRelease(host, cancelled, host.first);
    expect(await exists(host.paths.releaseRoot(cancelled.instance_id, 'next'))).toBe(false);
    expect(machineFleet.state.tags.has(`${imageBase(cancelled)}:next`)).toBe(false);
  });

  it('stops with exit 75 when another command holds an assistant, leaving the next one untouched', async () => {
    const host = await machine();
    const first = await assistant(host, 37_001);
    const second = await assistant(host, 37_101);
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

  it('exits 0 with nothing to update when no assistant can move, staging nothing', async () => {
    const host = await machine();
    const current = await assistant(host, 37_001);
    const stopped = await assistant(host, 37_101);
    const next = await nextRelease(host);
    const machineFleet = await fleet(host, next, [current, stopped]);
    expect(await fleetCli(machineFleet).run(['update', '--id', current.instance_id, '--yes'])).toBe(0);
    machineFleet.stopped.add(stopped.install_id);
    const { run, out } = fleetCli(machineFleet);

    expect(await run(['update', '--all', '--yes'])).toBe(0);

    expect(out).toEqual([
      'Checking which assistants can be updated…',
      `Nothing to update: no assistant here can move to this tool's release ${short(next.commit)}.`,
      `Skipped ${current.instance_id}: It already runs dogfood ${short(next.commit)}, this tool's release.`,
      `Skipped ${stopped.instance_id}: It is stopped, and an update proves its new release on a running assistant; start it with gws-ea start --id ${stopped.instance_id}, then update it.`,
    ]);
    expect(await exists(host.paths.releaseRoot(stopped.instance_id, 'next'))).toBe(false);
    await expectOnRelease(host, stopped, host.first);
  });

  it('names a removal under way and an unfinished create, each with the command that finishes it', async () => {
    const host = await machine();
    const removing = await assistant(host, 37_001);
    const next = await nextRelease(host);
    const machineFleet = await fleet(host, next, [removing]);
    await mkdir(path.dirname(host.paths.removalFile(removing.instance_id)), { recursive: true, mode: 0o700 });
    await writeFile(host.paths.removalFile(removing.instance_id), '{}\n', { mode: 0o600 });
    // Reserved as create reserves it, with no step of its provisioning finished.
    const creating = allocateInstanceId();
    await reserveInstance(host.paths, {
      instance_id: creating,
      checkout_realpath: host.paths.checkoutRoot(creating),
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
    const unreadable = await assistant(host, 37_001);
    const eligible = await assistant(host, 37_101);
    const next = await nextRelease(host);
    const machineFleet = await fleet(host, next, [unreadable, eligible]);
    await rm(host.paths.releasePreflightFile(unreadable.instance_id));
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
    const runtime = await assistant(host, 37_001);
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
    const pending = await assistant(host, 37_001);
    const done = await assistant(host, 37_101);
    const next = await nextRelease(host);
    const machineFleet = await fleet(host, next, [pending, done]);
    expect(await fleetCli(machineFleet).run(['update', '--id', done.instance_id, '--yes'])).toBe(0);
    machineFleet.state.rebuildFails = true;
    expect(await fleetCli(machineFleet).run(['update', '--id', pending.instance_id, '--yes'])).toBe(1);
    expect((await readOperationRecord(host.paths, pending.instance_id))?.phase).toBe('recorded');
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
});
