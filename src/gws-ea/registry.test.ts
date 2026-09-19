import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from './cli.js';
import {
  allocateInstanceId,
  assertRegistryMarkerAgreement,
  readRegistry,
  reserveInstance,
  writeInstanceMarker,
} from './registry.js';
import { isLocalFilesystemType, resolveControlPlanePaths, type ControlPlanePaths } from './paths.js';
import type { InstanceReservationInput } from './types.js';

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

function reservation(paths: ControlPlanePaths, instanceId = allocateInstanceId()): InstanceReservationInput {
  return {
    instance_id: instanceId,
    checkout_realpath: paths.checkoutRoot(instanceId),
    release_track: 'dogfood',
    source_remote: 'https://example.test/nanoclaw.git',
    deployed_commit: 'a'.repeat(40),
    allocated_ports: {
      nanoclaw_webhook: 31_001,
      onecli_app: 31_002,
      onecli_gateway: 31_003,
    },
    exclusive_resource_claims: {
      endpoint_url: 'https://assistant.example.test/webhook/gchat',
      gcp_project_id: 'assistant-project',
      chat_app_id: 'assistant-chat-app',
      chat_credential_id: 'assistant-chat-key',
      workspace_email: 'assistant@example.test',
      onecli_project: `gws-ea-${instanceId.replaceAll('-', '')}`,
    },
  };
}

function createArgs(): string[] {
  return [
    'assistants',
    'create',
    '--track',
    'dogfood',
    '--source-remote',
    'https://example.test/nanoclaw.git',
    '--deployed-commit',
    'a'.repeat(40),
    '--webhook-port',
    '31001',
    '--onecli-app-port',
    '31002',
    '--onecli-gateway-port',
    '31003',
    '--endpoint',
    'https://assistant.example.test/webhook/gchat',
    '--gcp-project',
    'assistant-project',
    '--chat-app',
    'assistant-chat-app',
    '--chat-credential-id',
    'assistant-chat-key',
    '--workspace-email',
    'assistant@example.test',
  ];
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
      import { reserveInstance } from './src/gws-ea/registry.ts';
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
    const first = reservation(paths);
    const second = { ...reservation(paths), allocated_ports: { ...first.allocated_ports } };
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
    const input = reservation(paths);
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
    ['corrupt JSON', '{not-json'],
    ['an unknown schema', JSON.stringify({ schema_version: 99, instances: {} })],
    ['an unvalidated field', JSON.stringify({ schema_version: 1, instances: {}, surprise: true })],
  ])('stops mutation for %s', async (_label, contents) => {
    const paths = await testPaths();
    await mkdir(paths.configRoot, { recursive: true, mode: 0o700 });
    await writeFile(paths.registryFile, contents, { mode: 0o600 });

    await expect(reserveInstance(paths, reservation(paths))).rejects.toThrow();
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

  it('classifies known remote filesystem types as unsafe', () => {
    expect(isLocalFilesystemType(0x6969)).toBe(false); // NFS
    expect(isLocalFilesystemType(0xff534d42)).toBe(false); // CIFS
    expect(isLocalFilesystemType(0x65735546)).toBe(false); // FUSE (may be remote)
    expect(isLocalFilesystemType(0xef53)).toBe(true); // ext family
  });

  it('fails closed when an immutable marker disagrees with the registry', async () => {
    const paths = await testPaths();
    const input = reservation(paths);
    await reserveInstance(paths, input);
    await mkdir(path.dirname(paths.markerFile(input.instance_id)), { recursive: true, mode: 0o700 });
    await writeFile(
      paths.markerFile(input.instance_id),
      JSON.stringify({ schema_version: 1, instance_id: allocateInstanceId() }),
      { mode: 0o600 },
    );

    await expect(assertRegistryMarkerAgreement(paths, input.instance_id)).rejects.toThrow(/marker.*mismatch/i);
  });

  it('writes and verifies a minimal immutable marker', async () => {
    const paths = await testPaths();
    const input = reservation(paths);
    await reserveInstance(paths, input);
    await mkdir(paths.checkoutRoot(input.instance_id), { recursive: true, mode: 0o700 });
    await writeInstanceMarker(paths, input.instance_id);

    await expect(assertRegistryMarkerAgreement(paths, input.instance_id)).resolves.toEqual(input);
    expect(JSON.parse(await readFile(paths.markerFile(input.instance_id), 'utf8'))).toEqual({
      schema_version: 1,
      instance_id: input.instance_id,
    });
    expect((await stat(paths.markerFile(input.instance_id))).mode & 0o777).toBe(0o600);
  });
});

describe('create recovery contract', () => {
  it('creates durable state and resumes the first incomplete phase without changing claims', async () => {
    const paths = await testPaths();
    const createOutput: string[] = [];
    expect(
      await runCli(createArgs(), {
        paths,
        stdout: (line) => createOutput.push(line),
        stderr: () => undefined,
      }),
    ).toBe(0);
    const instanceId = createOutput[0]!.slice('instance_id: '.length);
    const beforeResume = (await readRegistry(paths)).instances[instanceId];

    const resumeOutput: string[] = [];
    expect(
      await runCli(['assistants', 'resume', '--id', instanceId], {
        paths,
        stdout: (line) => resumeOutput.push(line),
        stderr: () => undefined,
      }),
    ).toBe(0);
    expect(resumeOutput).toEqual([`Resuming instance ${instanceId} at phase materialize_checkout.`]);
    expect((await readRegistry(paths)).instances[instanceId]).toEqual(beforeResume);
  });

  it('leaves no instance state and gives a rerun command when validation fails before reservation', async () => {
    const paths = await testPaths();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runCli(['assistants', 'create', '--track', 'dogfood'], {
      paths,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join('\n')).toContain('gws-ea assistants create --track dogfood');
    expect((await readRegistry(paths)).instances).toEqual({});
  });

  it('prints the id before reservation and only the exact safe resume command after a post-reservation failure', async () => {
    const paths = await testPaths();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const secretCanary = 'secret-canary-must-not-print';
    const exitCode = await runCli(createArgs(), {
      paths,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      initializeJournal: async () => {
        throw new Error(secretCanary);
      },
    });

    expect(exitCode).toBe(1);
    expect(stdout[0]).toMatch(/^instance_id: [0-9a-f-]{36}$/);
    const instanceId = stdout[0]!.slice('instance_id: '.length);
    expect(Object.keys((await readRegistry(paths)).instances)).toEqual([instanceId]);
    expect(stderr.join('\n')).toContain(`gws-ea assistants resume --id ${instanceId}`);
    expect(`${stdout.join('\n')}\n${stderr.join('\n')}`).not.toContain(secretCanary);
  });
});
