import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli, type CliRuntime } from './cli.js';
import { runStep } from './events.js';
import {
  acquireInstanceOperation,
  readProvisionJournal,
  recordStepCompleted,
  recordStepStarted,
  reserveInstance,
} from './journal.js';
import {
  allocateInstanceId,
  assertRegistryMarkerAgreement,
  assertStateConsistent,
  claimInstanceAlias,
  getInstanceReservation,
  readRegistry,
  swapInstanceRelease,
  writeInstanceMarker,
} from './registry.js';
import { deriveGcpClaims } from './gcp-identity.js';
import { resolveControlPlanePaths, type ControlPlanePaths } from './paths.js';
import type { Prerequisites } from './prerequisites.js';
import type { CreateTargetRequest } from './release-target.js';
import { GwsEaError, releaseOf, type InstanceReservationInput } from './types.js';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function testPaths(): Promise<ControlPlanePaths> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gws-ea-registry-'));
  roots.push(root);
  return resolveControlPlanePaths({
    configRoot: path.join(root, 'config'),
    stateRoot: path.join(root, 'state'),
  });
}

function reservation(instanceId: string = randomUUID()): InstanceReservationInput {
  return {
    instance_id: instanceId,
    release_track: 'dogfood',
    source_remote: 'https://example.test/nanoclaw.git',
    deployed_commit: 'a'.repeat(40),
    allocated_ports: { onecli_app: 31_002, onecli_gateway: 31_003 },
    exclusive_resource_claims: {
      ...deriveGcpClaims(instanceId),
      gcp_account: 'operator@example.test',
      workspace_email: 'assistant@example.test',
      onecli_project: `gws-ea-${instanceId.replaceAll('-', '')}`,
    },
  };
}

/** A second assistant: its own ID, and so its own project and Chat delivery, ports, and Workspace account. */
function distinctReservation(instanceId: string = randomUUID()): InstanceReservationInput {
  const input = reservation(instanceId);
  return {
    ...input,
    allocated_ports: { onecli_app: 32_002, onecli_gateway: 32_003 },
    exclusive_resource_claims: { ...input.exclusive_resource_claims, workspace_email: 'second@example.test' },
  };
}

function createArgs(): string[] {
  return [
    'create',
    '--track',
    'dogfood',
    '--source-remote',
    'https://example.test/nanoclaw.git',
    '--assistant-workspace-email',
    'assistant@example.test',
  ];
}

function createSetupInput() {
  return {
    sourceRemote: 'https://example.test/nanoclaw.git',
    assistantWorkspaceEmail: 'assistant@example.test',
    bootstrapManifest: {
      schema_version: 1,
      node_path: process.execPath,
      home_directory: '/Users/operator',
      platform: process.platform === 'darwin' ? 'macos' : 'linux',
      running_as_root: false,
      docker_endpoint: 'unix:///var/run/docker.sock',
      provider: {
        id: 'claude',
        name: 'Claude provider',
        type: 'api_key',
        host_pattern: 'api.anthropic.com',
        header_name: 'x-api-key',
        value_format: null,
        path_pattern: null,
        param_name: null,
        param_format: null,
      },
      identity: {
        assistant_display_name: 'Aya',
        principal_display_name: 'Principal',
        principal_timezone: 'America/Los_Angeles',
        principal_emails: ['principal@example.test'],
        principal_chat_email: 'principal@example.test',
      },
    },
  } as const;
}

const PREREQUISITES: Prerequisites = {
  platform: process.platform === 'darwin' ? 'macos' : 'linux',
  homeDirectory: '/Users/operator',
  runningAsRoot: false,
  nodePath: process.execPath,
  dockerEndpoint: 'unix:///var/run/docker.sock',
  account: 'operator@example.test',
};

function productionRuntime() {
  return {
    collectCreateInputs: async () => createSetupInput(),
    checkPrerequisites: async () => PREREQUISITES,
    resolveReleaseTarget: async ({ track, source }: CreateTargetRequest) => ({
      release: { source_remote: source.remote, release_track: track, deployed_commit: 'b'.repeat(40) },
    }),
    holdLoopbackPorts: async () => ({
      ports: { onecli_app: 34_102, onecli_gateway: 34_103 },
      release: async () => undefined,
    }),
  };
}

function waitForExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
}

async function waitForFiles(files: string[]): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const present = await Promise.all(
      files.map(async (file) => {
        try {
          await stat(file);
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          return false;
        }
      }),
    );
    if (present.every(Boolean)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${files.join(', ')}`);
}

describe('machine registry', () => {
  it('allows exactly one of two separate processes to commit the same exclusive claims', async () => {
    const paths = await testPaths();
    const barrier = path.join(path.dirname(paths.configRoot), 'go');
    const childScript = `
      import { writeFile, stat } from 'node:fs/promises';
      import { resolveControlPlanePaths } from './src/gws-ea/paths.ts';
      import { reserveInstance } from './src/gws-ea/journal.ts';
      const input = JSON.parse(process.env.TEST_INPUT);
      const paths = resolveControlPlanePaths(JSON.parse(process.env.TEST_PATHS));
      await writeFile(process.env.TEST_READY, 'ready');
      while (true) {
        try { await stat(process.env.TEST_BARRIER); break; } catch { await new Promise((r) => setTimeout(r, 5)); }
      }
      try {
        await reserveInstance(paths, input);
        process.exitCode = 0;
      } catch {
        process.exitCode = 2;
      }
    `;
    const first = reservation();
    const second = { ...reservation(), allocated_ports: { ...first.allocated_ports } };
    const readyFiles = [path.join(path.dirname(barrier), 'ready-1'), path.join(path.dirname(barrier), 'ready-2')];
    const children = [first, second].map((input, index) =>
      spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', childScript], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          TEST_INPUT: JSON.stringify(input),
          TEST_PATHS: JSON.stringify({ configRoot: paths.configRoot, stateRoot: paths.stateRoot }),
          TEST_READY: readyFiles[index],
          TEST_BARRIER: barrier,
        },
        stdio: 'ignore',
      }),
    );

    await waitForFiles(readyFiles);
    await writeFile(barrier, 'go');
    const exits = await Promise.all(children.map(waitForExit));
    expect(exits.sort()).toEqual([0, 2]);

    const stored = await readRegistry(paths);
    expect(Object.keys(stored.instances)).toHaveLength(1);
    expect(Object.values(stored.instances)[0]?.allocated_ports).toEqual(first.allocated_ports);
    expect((await stat(paths.registryFile)).mode & 0o777).toBe(0o600);
    expect((await stat(paths.configRoot)).mode & 0o777).toBe(0o700);
  }, 20_000);

  it('survives reopen without changing immutable coordinates or claims', async () => {
    const paths = await testPaths();
    const input = reservation();
    await reserveInstance(paths, input);

    const reopened = await readRegistry(
      resolveControlPlanePaths({
        configRoot: paths.configRoot,
        stateRoot: paths.stateRoot,
      }),
    );
    expect(reopened.instances[input.instance_id]).toEqual(input);
    await expect(reserveInstance(paths, input)).rejects.toThrow(/already exists/i);
    expect((await readRegistry(paths)).instances[input.instance_id]).toEqual(input);
  });

  it.each([
    [
      'OneCLI app port',
      (first: InstanceReservationInput, second: InstanceReservationInput) => {
        second.allocated_ports.onecli_app = first.allocated_ports.onecli_app;
      },
    ],
    [
      'OneCLI gateway port',
      (first: InstanceReservationInput, second: InstanceReservationInput) => {
        second.allocated_ports.onecli_gateway = first.allocated_ports.onecli_gateway;
      },
    ],
    [
      'Workspace email',
      (first: InstanceReservationInput, second: InstanceReservationInput) => {
        second.exclusive_resource_claims.workspace_email = first.exclusive_resource_claims.workspace_email;
      },
    ],
    [
      'OneCLI project',
      (first: InstanceReservationInput, second: InstanceReservationInput) => {
        second.exclusive_resource_claims.onecli_project = first.exclusive_resource_claims.onecli_project;
      },
    ],
  ] as const)('refuses a competing %s claim without changing its owner', async (_claim, collide) => {
    const paths = await testPaths();
    const first = reservation();
    const second = distinctReservation();
    collide(first, second);
    await reserveInstance(paths, first);
    const before = await readFile(paths.registryFile);

    await expect(reserveInstance(paths, second)).rejects.toMatchObject({ code: 'claim_conflict' });
    expect(await readFile(paths.registryFile)).toEqual(before);
    expect((await readRegistry(paths)).instances).toEqual({ [first.instance_id]: first });
    await expect(stat(paths.instanceRoot(second.instance_id))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['gcp_project_id', 'gchat_events_topic', 'gchat_events_subscription', 'gchat_subscriber_account'] as const)(
    "refuses a reservation whose %s is another assistant's, before publishing it",
    async (claim) => {
      const paths = await testPaths();
      const first = reservation();
      await reserveInstance(paths, first);
      const before = await readFile(paths.registryFile, 'utf8');
      const borrowing = distinctReservation();
      borrowing.exclusive_resource_claims[claim] = first.exclusive_resource_claims[claim];

      await expect(reserveInstance(paths, borrowing)).rejects.toMatchObject({
        code: 'invalid_claim',
        message: `${claim} is not this assistant's`,
      });
      expect(await readFile(paths.registryFile, 'utf8')).toBe(before);
    },
  );

  it('refuses a registry an earlier release wrote, telling the operator to remove its assistants and delete it', async () => {
    const paths = await testPaths();
    await mkdir(paths.configRoot, { recursive: true, mode: 0o700 });
    const earlier = JSON.stringify({ schema_version: 2, instances: {} });
    await writeFile(paths.registryFile, earlier, { mode: 0o600 });
    const refusal = {
      code: 'unsupported_registry',
      message:
        `The machine registry ${paths.registryFile} is from an earlier gws-ea release. Remove each assistant in it ` +
        `with that release (gws-ea remove --id <instance_id>), then delete ${paths.registryFile} and retry.`,
    };

    await expect(readRegistry(paths)).rejects.toMatchObject(refusal);
    await expect(reserveInstance(paths, reservation())).rejects.toMatchObject(refusal);
    expect(await readFile(paths.registryFile, 'utf8')).toBe(earlier);
  });

  it('loads a registry record with unknown fields and keeps its claims exact', async () => {
    const paths = await testPaths();
    const input = reservation();
    await reserveInstance(paths, input);
    const stored = JSON.parse(await readFile(paths.registryFile, 'utf8')) as {
      instances: Record<string, Record<string, unknown> & { exclusive_resource_claims: Record<string, unknown> }>;
    } & Record<string, unknown>;
    const instance = stored.instances[input.instance_id]!;
    await writeFile(
      paths.registryFile,
      JSON.stringify({
        ...stored,
        written_by: 'a newer launcher',
        instances: {
          [input.instance_id]: {
            ...instance,
            added_later: { any: 'shape' },
            exclusive_resource_claims: { ...instance.exclusive_resource_claims, note: 'extra' },
          },
        },
      }),
      { mode: 0o600 },
    );

    expect((await readRegistry(paths)).instances[input.instance_id]).toEqual(input);
    await expect(
      reserveInstance(paths, { ...reservation(), allocated_ports: input.allocated_ports }),
    ).rejects.toMatchObject({
      code: 'claim_conflict',
    });
  });

  it.each([
    ['corrupt JSON', '{not-json'],
    ['an unknown schema', JSON.stringify({ schema_version: 99, instances: {} })],
  ])('stops mutation for %s', async (_label, contents) => {
    const paths = await testPaths();
    await mkdir(paths.configRoot, { recursive: true, mode: 0o700 });
    await writeFile(paths.registryFile, contents, { mode: 0o600 });

    await expect(reserveInstance(paths, reservation())).rejects.toThrow();
    expect(await readFile(paths.registryFile, 'utf8')).toBe(contents);
  });

  it('rejects a symlinked managed root before publishing state', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gws-ea-symlink-'));
    roots.push(root);
    const target = path.join(root, 'target');
    const linked = path.join(root, 'linked');
    await mkdir(target, { mode: 0o700 });
    await symlink(target, linked);

    expect(() => resolveControlPlanePaths({ configRoot: linked, stateRoot: path.join(root, 'state') })).toThrow(
      /symlink/i,
    );
    await expect(readFile(path.join(target, 'instances.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.runIf(typeof process.getuid === 'function' && process.getuid() !== 0)(
    'rejects a managed root not owned by the current user',
    async () => {
      const paths = resolveControlPlanePaths({ configRoot: path.parse(process.cwd()).root, stateRoot: process.cwd() });
      await expect(readRegistry(paths)).rejects.toThrow(/owned/i);
    },
  );

  it('fails closed when an immutable marker disagrees with the registry', async () => {
    const paths = await testPaths();
    const input = reservation();
    await reserveInstance(paths, input);
    await mkdir(path.dirname(paths.markerFile(input.instance_id)), { recursive: true, mode: 0o700 });
    await writeFile(
      paths.markerFile(input.instance_id),
      JSON.stringify({ schema_version: 1, instance_id: randomUUID() }),
      {
        mode: 0o600,
      },
    );

    await expect(assertRegistryMarkerAgreement(paths, input.instance_id)).rejects.toThrow(/marker.*mismatch/i);
  });

  it("writes a minimal marker into the assistant's own physical state, naming no release", async () => {
    const paths = await testPaths();
    const input = reservation();
    await reserveInstance(paths, input);
    await writeInstanceMarker(paths, input.instance_id);

    await expect(assertRegistryMarkerAgreement(paths, input.instance_id)).resolves.toEqual(input);
    const state = paths.instanceLayout(input.instance_id).state;
    expect(paths.markerFile(input.instance_id)).toBe(path.join(state, 'data', 'gws-ea', 'instance.json'));
    expect(JSON.parse(await readFile(paths.markerFile(input.instance_id), 'utf8'))).toEqual({
      schema_version: 1,
      instance_id: input.instance_id,
    });
    expect((await stat(paths.markerFile(input.instance_id))).mode & 0o777).toBe(0o600);
    expect((await stat(state)).mode & 0o777).toBe(0o700);
  });

  it('reads a marker the layout before releases wrote, whose release it no longer trusts', async () => {
    const paths = await testPaths();
    const input = reservation();
    await reserveInstance(paths, input);
    await mkdir(path.dirname(paths.markerFile(input.instance_id)), { recursive: true, mode: 0o700 });
    await writeFile(
      paths.markerFile(input.instance_id),
      JSON.stringify({ schema_version: 1, instance_id: input.instance_id, deployed_commit: 'b'.repeat(40) }),
      { mode: 0o600 },
    );

    await expect(assertRegistryMarkerAgreement(paths, input.instance_id)).resolves.toEqual(input);
  });

  it('refuses a marker reached through a link, as it does a state root that is one', async () => {
    const paths = await testPaths();
    const input = reservation();
    await reserveInstance(paths, input);
    const elsewhere = path.join(path.dirname(paths.stateRoot), 'elsewhere');
    await mkdir(path.join(elsewhere, 'data', 'gws-ea'), { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(elsewhere, 'data', 'gws-ea', 'instance.json'),
      JSON.stringify({ schema_version: 1, instance_id: input.instance_id }),
      { mode: 0o600 },
    );
    await mkdir(paths.instanceRoot(input.instance_id), { recursive: true, mode: 0o700 });
    const state = paths.instanceLayout(input.instance_id).state;
    await symlink(elsewhere, state);

    await expect(assertRegistryMarkerAgreement(paths, input.instance_id)).rejects.toMatchObject({
      code: 'unsafe_path',
    });
    await rm(state);
    await mkdir(path.join(state, 'data'), { recursive: true, mode: 0o700 });
    await symlink(path.join(elsewhere, 'data', 'gws-ea'), path.join(state, 'data', 'gws-ea'));
    await expect(assertRegistryMarkerAgreement(paths, input.instance_id)).rejects.toMatchObject({
      code: 'unsafe_path',
    });
  });
});

describe('instance roots', () => {
  it("refuses an assistant whose ID begins with another's first eight hex digits, as it would share its root", async () => {
    const paths = await testPaths();
    const first = reservation();
    await reserveInstance(paths, first);
    const id = `${first.instance_id.slice(0, 8)}${randomUUID().slice(8)}`;
    const sharingRoot = distinctReservation(id);

    await expect(reserveInstance(paths, sharingRoot)).rejects.toMatchObject({ code: 'claim_conflict' });
    // With any other ID, and the claims it derives, the rest are free.
    await expect(reserveInstance(paths, distinctReservation())).resolves.toBeDefined();
  });

  it("draws the ID again while its first eight hex digits name a registered assistant's root, or anything there", async () => {
    const paths = await testPaths();
    const registered = reservation();
    await reserveInstance(paths, registered);
    const occupied = randomUUID();
    await mkdir(paths.instanceRoot(occupied), { recursive: true, mode: 0o700 });
    const clash = (id: string): string => `${id.slice(0, 8)}${randomUUID().slice(8)}`;
    const free = randomUUID();
    const drawn = [clash(registered.instance_id), clash(occupied), free];
    const generate = vi.fn(() => drawn.shift()!);

    await expect(allocateInstanceId(paths, generate)).resolves.toBe(free);
    expect(generate).toHaveBeenCalledTimes(3);
  });
});

describe('web alias claims (KTD13)', () => {
  it("claims, moves and drops one assistant's alias, changing nothing else", async () => {
    const paths = await testPaths();
    const input = reservation();
    const peer = distinctReservation();
    await reserveInstance(paths, input);
    await reserveInstance(paths, peer);
    const before = await readRegistry(paths);

    const claimed = await claimInstanceAlias(paths, input.instance_id, 'ONUJ@example.test');
    expect(claimed).toEqual({
      ...input,
      exclusive_resource_claims: { ...input.exclusive_resource_claims, alias_email: 'onuj@example.test' },
    });
    await claimInstanceAlias(paths, input.instance_id, 'onuj2@example.test');
    expect((await getInstanceReservation(paths, input.instance_id)).exclusive_resource_claims.alias_email).toBe(
      'onuj2@example.test',
    );
    // Claiming what it already holds writes nothing.
    const held = await readFile(paths.registryFile, 'utf8');
    await claimInstanceAlias(paths, input.instance_id, 'onuj2@example.test');
    expect(await readFile(paths.registryFile, 'utf8')).toBe(held);

    await claimInstanceAlias(paths, input.instance_id, undefined);
    const after = await readRegistry(paths);
    expect(after.instances[input.instance_id]).toEqual(input);
    expect(after.instances[peer.instance_id]).toEqual(before.instances[peer.instance_id]);
  });

  it('refuses an alias another assistant holds as its alias or its workspace email, or that is its own email', async () => {
    const paths = await testPaths();
    const input = reservation();
    const peer = distinctReservation();
    await reserveInstance(paths, input);
    await reserveInstance(paths, peer);
    await claimInstanceAlias(paths, peer.instance_id, 'onuj@example.test');
    const before = await readFile(paths.registryFile, 'utf8');

    await expect(claimInstanceAlias(paths, input.instance_id, 'onuj@example.test')).rejects.toMatchObject({
      code: 'claim_conflict',
    });
    await expect(claimInstanceAlias(paths, input.instance_id, 'second@example.test')).rejects.toMatchObject({
      code: 'claim_conflict',
    });
    await expect(claimInstanceAlias(paths, input.instance_id, 'assistant@example.test')).rejects.toMatchObject({
      code: 'invalid_claim',
    });
    await expect(claimInstanceAlias(paths, input.instance_id, 'not an address')).rejects.toMatchObject({
      code: 'invalid_claim',
    });
    expect(await readFile(paths.registryFile, 'utf8')).toBe(before);
  });

  it("refuses a new assistant whose workspace email is another's alias", async () => {
    const paths = await testPaths();
    const owner = reservation();
    await reserveInstance(paths, owner);
    await claimInstanceAlias(paths, owner.instance_id, 'second@example.test');

    await expect(reserveInstance(paths, distinctReservation())).rejects.toMatchObject({ code: 'claim_conflict' });
    expect(Object.keys((await readRegistry(paths)).instances)).toEqual([owner.instance_id]);
  });

  it('gives exactly one of two assistants claiming the same alias at once', async () => {
    const paths = await testPaths();
    const first = reservation();
    const second = distinctReservation();
    await reserveInstance(paths, first);
    await reserveInstance(paths, second);

    const results = await Promise.allSettled([
      claimInstanceAlias(paths, first.instance_id, 'onuj@example.test'),
      claimInstanceAlias(paths, second.instance_id, 'onuj@example.test'),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: expect.objectContaining({ code: 'claim_conflict' }),
    });
  });
});

describe('release compare-and-swap and live checkout agreement', () => {
  const target = {
    source_remote: 'https://example.test/prod.git',
    release_track: 'prod',
    deployed_commit: 'b'.repeat(40),
  };

  it('moves only the release fields, from the release it expects, leaving every claim and peer as it was', async () => {
    const paths = await testPaths();
    const input = reservation();
    const peer = distinctReservation();
    await reserveInstance(paths, input);
    await reserveInstance(paths, peer);
    // The web alias claim is one of them.
    const claimed = await claimInstanceAlias(paths, input.instance_id, 'onuj@example.test');
    const before = await readRegistry(paths);

    const moved = await swapInstanceRelease(paths, input.instance_id, releaseOf(input), target);

    expect(moved).toEqual({ ...claimed, ...target });
    const after = await readRegistry(paths);
    expect(after.instances[input.instance_id]).toEqual(moved);
    expect(after.instances[peer.instance_id]).toEqual(before.instances[peer.instance_id]);
    expect((await stat(paths.registryFile)).mode & 0o777).toBe(0o600);
  });

  it('refuses when the recorded release is not the one expected, or the instance is unknown', async () => {
    const paths = await testPaths();
    const input = reservation();
    await reserveInstance(paths, input);
    const before = await readFile(paths.registryFile, 'utf8');

    await expect(swapInstanceRelease(paths, input.instance_id, target, releaseOf(input))).rejects.toMatchObject({
      code: 'reservation_mismatch',
    });
    await expect(
      swapInstanceRelease(paths, input.instance_id, releaseOf(input), { ...target, release_track: 'Not A Track' }),
    ).rejects.toMatchObject({ code: 'invalid_state' });
    await expect(swapInstanceRelease(paths, randomUUID(), releaseOf(input), target)).rejects.toMatchObject({
      code: 'unknown_instance',
    });
    expect(await readFile(paths.registryFile, 'utf8')).toBe(before);
  });

  it.each([
    ['commit', { deployed_commit: 'c'.repeat(40) }],
    ['track', { release_track: 'prod' }],
    ['source', { source_remote: 'https://example.test/fork.git' }],
  ])('refuses a swap from a release that differs from the recorded one only in its %s', async (_field, change) => {
    const paths = await testPaths();
    const input = reservation();
    await reserveInstance(paths, input);
    const before = await readFile(paths.registryFile, 'utf8');

    await expect(
      swapInstanceRelease(paths, input.instance_id, { ...releaseOf(input), ...change }, target),
    ).rejects.toMatchObject({ code: 'reservation_mismatch' });
    expect(await readFile(paths.registryFile, 'utf8')).toBe(before);
  });

  it("commits two assistants' concurrent swaps, neither overwriting the other's", async () => {
    const paths = await testPaths();
    const first = reservation();
    const second = distinctReservation();
    await reserveInstance(paths, first);
    await reserveInstance(paths, second);

    await Promise.all([
      swapInstanceRelease(paths, first.instance_id, releaseOf(first), target),
      swapInstanceRelease(paths, second.instance_id, releaseOf(second), target),
    ]);

    const after = await readRegistry(paths);
    expect(after.instances[first.instance_id]).toEqual({ ...first, ...target });
    expect(after.instances[second.instance_id]).toEqual({ ...second, ...target });
  });

  it('finds a missing state consistent, and a present one only with its own marker', async () => {
    const paths = await testPaths();
    const input = reservation();
    await reserveInstance(paths, input);
    const reserved = await getInstanceReservation(paths, input.instance_id);

    await expect(assertStateConsistent(paths, reserved)).resolves.toBeUndefined();
    await writeInstanceMarker(paths, input.instance_id);
    await expect(assertStateConsistent(paths, reserved)).resolves.toBeUndefined();
    await writeFile(
      paths.markerFile(input.instance_id),
      JSON.stringify({ schema_version: 1, instance_id: randomUUID() }),
      {
        mode: 0o600,
      },
    );
    await expect(assertStateConsistent(paths, reserved)).rejects.toMatchObject({ code: 'marker_mismatch' });
  });
});

describe('create recovery contract', () => {
  it('checks Google sign-in on every resume, even after GCP setup is complete', async () => {
    const paths = await testPaths();
    const input = reservation();
    await reserveInstance(paths, input);
    const operation = await acquireInstanceOperation(paths, input.instance_id);
    if (!operation) throw new Error('Test instance operation could not be acquired');
    try {
      for (const step of ['materialize_checkout', 'provision_gcp'] as const) {
        await recordStepStarted(operation, step);
        await recordStepCompleted(operation, step);
      }
    } finally {
      operation.release();
    }
    const preflight = vi.fn(async () => ({ ...PREREQUISITES, account: input.exclusive_resource_claims.gcp_account }));
    const advanceProvision = vi.fn(async () => ({ status: 'ready' as const }));

    expect(
      await runCli(['resume', '--id', input.instance_id], {
        paths,
        stdout: () => undefined,
        stderr: () => undefined,
        checkPrerequisites: preflight,
        advanceProvision,
      }),
    ).toBe(0);
    expect(preflight).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ command: 'resume', account: input.exclusive_resource_claims.gcp_account }),
      expect.anything(),
    );
    expect(advanceProvision).toHaveBeenCalledOnce();
  });

  it('does not advance a GCP resume when the reserved Google account needs sign-in', async () => {
    const paths = await testPaths();
    const input = reservation();
    await reserveInstance(paths, input);
    const errors: string[] = [];
    const advanceProvision = vi.fn();

    expect(
      await runCli(['resume', '--id', input.instance_id], {
        paths,
        stdout: () => undefined,
        stderr: (line) => errors.push(line),
        checkPrerequisites: async () => {
          throw new GwsEaError('gcloud_auth_required', 'Google Cloud sign-in is required');
        },
        advanceProvision,
      }),
    ).toBe(1);
    expect(advanceProvision).not.toHaveBeenCalled();
    expect(errors.join('\n')).toContain('Google Cloud sign-in is required');
  });

  it('checks gcloud before allocating or printing an instance ID', async () => {
    const paths = await testPaths();
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runCli(
      ['create', '--track', 'dogfood', '--source-remote', 'https://example.test/nanoclaw.git'],
      {
        paths,
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
        checkPrerequisites: async () => {
          throw new GwsEaError('gcloud_required', 'Install gcloud, then retry.');
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join('\n')).toContain('Install gcloud, then retry.');
    expect((await readRegistry(paths)).instances).toEqual({});
  });

  it('connects the owner-only setup surface to create and fresh-process resume', async () => {
    const paths = await testPaths();
    const advanced: string[] = [];
    let portsReleased = false;
    const advanceProvision: NonNullable<CliRuntime['advanceProvision']> = async (operation, { runtime }) => {
      // The reservation claims the ports; each runtime binds its own when it starts.
      expect(portsReleased).toBe(true);
      await runStep(runtime, { id: 'provision_gcp', label: 'Configuring Google Cloud…' }, async () => {
        runtime.emit?.({ type: 'step-waiting', step: 'provision_gcp', reason: 'Waiting for the service account…' });
        runtime.emit?.({ type: 'step-waiting', step: 'provision_gcp', reason: 'Waiting for the service account…' });
      });
      advanced.push(operation.instanceId);
      return {
        status: 'paused' as const,
        pause: {
          kind: 'human-action' as const,
          phase: 'verify_conversation' as const,
          code: 'later_principal_message_missing',
          message: "Ask the principal to reply to the assistant's welcome.",
        },
      };
    };
    const output: string[] = [];
    const progress: string[] = [];
    const resolveCalls: Array<[string, string]> = [];
    expect(
      await runCli(createArgs(), {
        paths,
        stdout: (line) => output.push(line),
        stderr: (line) => progress.push(line),
        checkPrerequisites: async () => PREREQUISITES,
        advanceProvision,
        resolveReleaseTarget: async ({ track, source }) => {
          resolveCalls.push([source.remote, source.ref]);
          return { release: { source_remote: source.remote, release_track: track, deployed_commit: 'b'.repeat(40) } };
        },
        holdLoopbackPorts: async () => ({
          ports: { onecli_app: 34_102, onecli_gateway: 34_103 },
          release: async () => {
            portsReleased = true;
          },
        }),
        collectCreateInputs: async () => createSetupInput(),
      }),
    ).toBe(10);
    const instanceIds = Object.keys((await readRegistry(paths)).instances);
    expect(instanceIds).toHaveLength(1);
    const instanceId = instanceIds[0]!;
    expect(resolveCalls).toEqual([['https://example.test/nanoclaw.git', 'refs/heads/rebuild-v2']]);
    expect(portsReleased).toBe(true);
    expect(progress).toEqual([
      'Resolving the release…',
      'Reserving the assistant…',
      `instance_id: ${instanceId}`,
      'Configuring Google Cloud…',
      'Waiting for the service account…',
    ]);
    expect(output[0]).toBe("Paused at verify_conversation: Ask the principal to reply to the assistant's welcome.");
    expect((await readRegistry(paths)).instances[instanceId]).toMatchObject({
      deployed_commit: 'b'.repeat(40),
      allocated_ports: { onecli_app: 34_102, onecli_gateway: 34_103 },
    });
    const persistedBootstrap = await readFile(paths.bootstrapFile(instanceId), 'utf8');
    expect(persistedBootstrap).not.toContain('provider-secret');
    expect(persistedBootstrap).not.toContain('gchat-secret');

    expect(
      await runCli(['resume', '--id', instanceId], {
        paths,
        stdout: () => undefined,
        stderr: () => undefined,
        checkPrerequisites: async () => PREREQUISITES,
        advanceProvision,
      }),
    ).toBe(10);
    expect(advanced).toEqual([instanceId, instanceId]);
  });

  it('provisions from the documented create command and prints the exact command for each choice a pause offers', async () => {
    const paths = await testPaths();
    const output: string[] = [];
    const progress: string[] = [];
    let idWasPrintedBeforeCollection = false;
    const pause = {
      status: 'paused' as const,
      pause: {
        kind: 'human-action' as const,
        phase: 'provision_gcp' as const,
        code: 'gcp_billing_account_choice_required',
        message: 'Choose the billing account that pays for Google Cloud project gws-ea-juno.',
        choices: [
          { id: '01A2B3-C4D5E6-F7A8B9', label: 'Northwind (01A2B3-C4D5E6-F7A8B9)' },
          { id: "O'Brien-account", label: "O'Brien (shared)" },
        ],
        resumeFlag: '--billing-account',
      },
    };
    const collectCreateInputs = async () => {
      idWasPrintedBeforeCollection = [...output, ...progress].some((line) =>
        /^instance_id: [0-9a-f-]{36}$/u.test(line),
      );
      return createSetupInput();
    };

    expect(
      await runCli(['create', '--track', 'dogfood', '--source-remote', 'https://example.test/nanoclaw.git'], {
        paths,
        stdout: (line) => output.push(line),
        stderr: (line) => progress.push(line),
        ...productionRuntime(),
        collectCreateInputs,
        advanceProvision: async () => pause,
      }),
    ).toBe(10);
    expect(idWasPrintedBeforeCollection).toBe(false);
    const instanceIds = Object.keys((await readRegistry(paths)).instances);
    expect(instanceIds).toHaveLength(1);
    const instanceId = instanceIds[0]!;
    expect(progress).toContain(`instance_id: ${instanceId}`);
    expect(output).toContain(
      `  "Northwind (01A2B3-C4D5E6-F7A8B9)": gws-ea resume --id ${instanceId} --billing-account '01A2B3-C4D5E6-F7A8B9'`,
    );
    expect(output).toContain(
      `  "O'Brien (shared)": gws-ea resume --id ${instanceId} --billing-account 'O'\\''Brien-account'`,
    );

    const resumeOutput: string[] = [];
    expect(
      await runCli(['resume', '--id', instanceId], {
        paths,
        stdout: (line) => resumeOutput.push(line),
        stderr: () => undefined,
        checkPrerequisites: async () => PREREQUISITES,
        advanceProvision: async () => pause,
      }),
    ).toBe(10);
    expect(resumeOutput).toContain(
      `  "Northwind (01A2B3-C4D5E6-F7A8B9)": gws-ea resume --id ${instanceId} --billing-account '01A2B3-C4D5E6-F7A8B9'`,
    );
  });

  it('reports cancellation without publishing an ID or leaving instance state before reservation', async () => {
    const paths = await testPaths();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runCli(
      ['create', '--track', 'dogfood', '--source-remote', 'https://example.test/nanoclaw.git'],
      {
        paths,
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
        collectCreateInputs: async () => {
          throw new GwsEaError('cancelled', 'Assistant creation was cancelled');
        },
        checkPrerequisites: async () => PREREQUISITES,
      },
    );

    expect(exitCode).toBe(0);
    expect(stdout[0]).toBe('Assistant creation was cancelled');
    expect([...stdout, ...stderr].join('\n')).not.toContain('instance_id:');
    expect([...stdout, ...stderr].join('\n')).not.toContain('gws-ea resume');
    expect((await readRegistry(paths)).instances).toEqual({});
  });

  it('leaves no registry state when production track resolution fails before reservation', async () => {
    const paths = await testPaths();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runCli(createArgs(), {
      paths,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      collectCreateInputs: async () => createSetupInput(),
      checkPrerequisites: async () => PREREQUISITES,
      resolveReleaseTarget: async () => {
        throw new GwsEaError('release_resolution_failed', 'Release track could not be resolved');
      },
      holdLoopbackPorts: async () => {
        throw new Error('ports must not be allocated after failed release resolution');
      },
    });

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join('\n')).not.toContain('instance_id:');
    expect(stderr.join('\n')).toContain('gws-ea create --track dogfood');
    expect((await readRegistry(paths)).instances).toEqual({});
  });

  it('leaves no registry state when generated bootstrap input is invalid', async () => {
    const paths = await testPaths();
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runCli(createArgs(), {
      paths,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      collectCreateInputs: async () => ({
        ...createSetupInput(),
        bootstrapManifest: { ...createSetupInput().bootstrapManifest, schema_version: 99 as 1 },
      }),
      checkPrerequisites: async () => PREREQUISITES,
      resolveReleaseTarget: async ({ track, source }) => ({
        release: { source_remote: source.remote, release_track: track, deployed_commit: 'b'.repeat(40) },
      }),
      holdLoopbackPorts: async () => {
        throw new Error('ports must not be allocated for invalid setup input');
      },
    });

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join('\n')).not.toContain('instance_id:');
    expect(stderr.join('\n')).toContain('Bootstrap manifest schema is unsupported');
    expect((await readRegistry(paths)).instances).toEqual({});
  });

  it('stages bootstrap input before reservation and removes it when reservation fails', async () => {
    const paths = await testPaths();
    const stdout: string[] = [];
    let stagedBeforeReservation = false;
    let candidateId = '';

    expect(
      await runCli(createArgs(), {
        paths,
        stdout: (line) => stdout.push(line),
        stderr: () => undefined,
        reserveInstance: async (_paths, input) => {
          candidateId = input.instance_id;
          stagedBeforeReservation = (await readFile(paths.bootstrapFile(input.instance_id), 'utf8')).includes(
            '"schema_version": 1',
          );
          throw new GwsEaError('claim_conflict', 'An exclusive operational resource is already claimed');
        },
        ...productionRuntime(),
      }),
    ).toBe(1);

    expect(stdout).toEqual([]);
    expect(candidateId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(stagedBeforeReservation).toBe(true);
    await expect(stat(paths.bootstrapFile(candidateId))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(paths.instanceRoot(candidateId))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readRegistry(paths)).instances).toEqual({});
  });

  it('stops a real create claim conflict before provisioning the second assistant', async () => {
    const paths = await testPaths();
    const owner = reservation();
    await reserveInstance(paths, owner);
    const before = await readFile(paths.registryFile);
    const advanceProvision = vi.fn();
    const stderr: string[] = [];

    expect(
      await runCli(createArgs(), {
        paths,
        stdout: () => undefined,
        stderr: (line) => stderr.push(line),
        ...productionRuntime(),
        advanceProvision,
      }),
    ).toBe(1);

    expect(stderr.join('\n')).toMatch(/exclusive operational resource is already claimed/u);
    expect(advanceProvision).not.toHaveBeenCalled();
    expect(await readFile(paths.registryFile)).toEqual(before);
    expect((await readRegistry(paths)).instances).toEqual({ [owner.instance_id]: owner });
  });

  it('reports the confirmed ID and exact safe resume command after a post-reservation failure', async () => {
    const paths = await testPaths();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const secretCanary = 'secret-canary-must-not-print';
    const exitCode = await runCli(createArgs(), {
      paths,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      ...productionRuntime(),
      advanceProvision: async () => {
        throw new Error(secretCanary);
      },
    });

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    const instanceIds = Object.keys((await readRegistry(paths)).instances);
    expect(instanceIds).toHaveLength(1);
    const instanceId = instanceIds[0]!;
    expect(stderr).toContain(`instance_id: ${instanceId}`);
    await expect(readFile(paths.bootstrapFile(instanceId), 'utf8')).resolves.toContain('"schema_version": 1');
    expect(stderr.join('\n')).toContain(`gws-ea resume --id ${instanceId}`);
    expect(`${stdout.join('\n')}\n${stderr.join('\n')}`).not.toContain(secretCanary);
    expect((await readProvisionJournal(paths, instanceId)).steps).toEqual({});

    const resumed: string[] = [];
    expect(
      await runCli(['resume', '--id', instanceId], {
        paths,
        stdout: () => undefined,
        stderr: () => undefined,
        checkPrerequisites: async () => PREREQUISITES,
        advanceProvision: async (operation) => {
          resumed.push(operation.instanceId);
          return {
            status: 'paused',
            pause: {
              kind: 'human-action',
              phase: 'verify_conversation',
              code: 'later_principal_message_missing',
              message: "Ask the principal to reply to the assistant's welcome.",
            },
          };
        },
      }),
    ).toBe(10);
    expect(resumed).toEqual([instanceId]);
  });

  it('preserves resumable state when reservation publishes before reporting failure', async () => {
    const paths = await testPaths();
    const stdout: string[] = [];
    const stderr: string[] = [];

    expect(
      await runCli(createArgs(), {
        paths,
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
        reserveInstance: async (reservationPaths, input) => {
          await reserveInstance(reservationPaths, input);
          throw new Error('simulated lock-release failure');
        },
        ...productionRuntime(),
      }),
    ).toBe(1);

    expect(stdout).toEqual([]);
    const instanceIds = Object.keys((await readRegistry(paths)).instances);
    expect(instanceIds).toHaveLength(1);
    const instanceId = instanceIds[0]!;
    await expect(readFile(paths.bootstrapFile(instanceId), 'utf8')).resolves.toContain('"schema_version": 1');
    expect(stderr.join('\n')).toContain(`gws-ea resume --id ${instanceId}`);
    expect(stderr.join('\n')).not.toContain('gws-ea create --track');
  });
});
