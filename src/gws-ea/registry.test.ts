import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from './cli.js';
import type { InstanceOperation } from './journal.js';
import {
  allocateInstanceId,
  assertRegistryMarkerAgreement,
  readRegistry,
  reserveInstance,
  writeInstanceMarker,
} from './registry.js';
import { isLocalFilesystemType, resolveControlPlanePaths, type ControlPlanePaths } from './paths.js';
import { GwsEaError, type InstanceReservationInput } from './types.js';

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

function createArgs(setupFile?: string): string[] {
  const args = [
    'create',
    '--track',
    'dogfood',
    '--source-remote',
    'https://example.test/nanoclaw.git',
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
  if (setupFile) args.push('--setup-file', setupFile);
  return args;
}

async function createSetupFile(paths: ControlPlanePaths): Promise<string> {
  const inputRoot = path.join(path.dirname(paths.configRoot), 'bootstrap-input');
  await mkdir(inputRoot, { recursive: true, mode: 0o700 });
  const providerFile = path.join(inputRoot, 'provider-key');
  const gchatFile = path.join(inputRoot, 'gchat-key.json');
  const setupFile = path.join(inputRoot, 'setup.json');
  await writeFile(providerFile, 'provider-secret', { mode: 0o600 });
  await writeFile(
    gchatFile,
    JSON.stringify({
      type: 'service_account',
      project_id: 'assistant-project',
      private_key_id: 'assistant-chat-key',
      private_key: '-----BEGIN PRIVATE KEY-----\ntest-key-material\n-----END PRIVATE KEY-----\n',
      client_email: 'assistant@assistant-project.iam.gserviceaccount.com',
      client_id: '1234567890',
      auth_uri: 'https://accounts.google.com/o/oauth2/auth',
      token_uri: 'https://oauth2.googleapis.com/token',
      auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
      client_x509_cert_url: 'https://www.googleapis.com/robot/v1/metadata/x509/assistant',
      universe_domain: 'googleapis.com',
    }),
    { mode: 0o600 },
  );
  await writeFile(
    setupFile,
    JSON.stringify({
      schema_version: 1,
      onecli_cli_path: '/usr/local/bin/onecli',
      node_path: process.execPath,
      home_directory: path.dirname(paths.stateRoot),
      platform: process.platform === 'darwin' ? 'macos' : 'linux',
      running_as_root: false,
      provider: {
        id: 'claude',
        name: 'Claude provider',
        type: 'api_key',
        host_pattern: 'api.anthropic.com',
        credential_file: providerFile,
        header_name: 'x-api-key',
      },
      identity: {
        assistant_display_name: 'Aya',
        principal_display_name: 'Principal',
        principal_timezone: 'America/Los_Angeles',
      },
      gchat: { bot_user_id: 'users/assistant-bot', credential_file: gchatFile },
      selected_messaging_group_id: null,
    }),
    { mode: 0o600 },
  );
  return setupFile;
}

function productionRuntime() {
  return {
    resolveRelease: async (sourceRemote: string, releaseRef: string) => ({
      sourceRemote,
      releaseRef,
      commit: 'b'.repeat(40),
    }),
    holdLoopbackPorts: async () => ({
      ports: { nanoclaw_webhook: 34_101, onecli_app: 34_102, onecli_gateway: 34_103 },
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
      JSON.stringify({ schema_version: 1, instance_id: allocateInstanceId(), deployed_commit: input.deployed_commit }),
      { mode: 0o600 },
    );

    await expect(assertRegistryMarkerAgreement(paths, input.instance_id)).rejects.toThrow(/marker.*mismatch/i);
  });

  it('writes and verifies a minimal immutable marker', async () => {
    const paths = await testPaths();
    const input = reservation(paths);
    await reserveInstance(paths, input);
    await mkdir(path.dirname(paths.markerFile(input.instance_id)), { recursive: true, mode: 0o700 });
    await writeInstanceMarker(paths, input.instance_id);

    await expect(assertRegistryMarkerAgreement(paths, input.instance_id)).resolves.toEqual(input);
    expect(JSON.parse(await readFile(paths.markerFile(input.instance_id), 'utf8'))).toEqual({
      schema_version: 1,
      instance_id: input.instance_id,
      deployed_commit: input.deployed_commit,
    });
    expect((await stat(paths.markerFile(input.instance_id))).mode & 0o777).toBe(0o600);
  });

  it('fails closed when the marker commit disagrees with the registry', async () => {
    const paths = await testPaths();
    const input = reservation(paths);
    await reserveInstance(paths, input);
    await mkdir(path.dirname(paths.markerFile(input.instance_id)), { recursive: true, mode: 0o700 });
    await writeFile(
      paths.markerFile(input.instance_id),
      JSON.stringify({
        schema_version: 1,
        instance_id: input.instance_id,
        deployed_commit: 'b'.repeat(40),
      }),
      { mode: 0o600 },
    );

    await expect(assertRegistryMarkerAgreement(paths, input.instance_id)).rejects.toThrow(/marker.*mismatch/i);
  });
});

describe('create recovery contract', () => {
  it('connects the owner-only setup surface to create and fresh-process resume', async () => {
    const paths = await testPaths();
    const setupFile = await createSetupFile(paths);
    const advanced: string[] = [];
    const advanceProvision = async (operation: InstanceOperation) => {
      advanced.push(operation.instanceId);
      return {
        status: 'paused' as const,
        pause: {
          kind: 'human-action' as const,
          phase: 'bind_principal' as const,
          code: 'principal_dm_required',
          message: 'Send the direct message.',
        },
      };
    };
    const output: string[] = [];
    const resolveCalls: Array<[string, string]> = [];
    let portsReleased = false;
    expect(
      await runCli(createArgs(setupFile), {
        paths,
        stdout: (line) => output.push(line),
        stderr: () => undefined,
        advanceProvision,
        resolveRelease: async (sourceRemote, releaseRef) => {
          resolveCalls.push([sourceRemote, releaseRef]);
          return { sourceRemote, releaseRef, commit: 'b'.repeat(40) };
        },
        holdLoopbackPorts: async () => ({
          ports: { nanoclaw_webhook: 34_101, onecli_app: 34_102, onecli_gateway: 34_103 },
          release: async () => {
            portsReleased = true;
          },
        }),
      }),
    ).toBe(0);
    const instanceId = output[0]!.slice('instance_id: '.length);
    expect(resolveCalls).toEqual([['https://example.test/nanoclaw.git', 'refs/heads/dogfood']]);
    expect(portsReleased).toBe(true);
    expect((await readRegistry(paths)).instances[instanceId]).toMatchObject({
      deployed_commit: 'b'.repeat(40),
      allocated_ports: { nanoclaw_webhook: 34_101, onecli_app: 34_102, onecli_gateway: 34_103 },
    });
    const persistedBootstrap = await readFile(paths.bootstrapFile(instanceId), 'utf8');
    expect(persistedBootstrap).not.toContain('provider-secret');
    expect(persistedBootstrap).not.toContain('gchat-secret');

    expect(
      await runCli(['resume', '--id', instanceId], {
        paths,
        stdout: () => undefined,
        stderr: () => undefined,
        advanceProvision,
      }),
    ).toBe(0);
    expect(advanced).toEqual([instanceId, instanceId]);
  });

  it('provisions from the documented create command and prints exact principal-selection commands', async () => {
    const paths = await testPaths();
    const setupFile = await createSetupFile(paths);
    const output: string[] = [];
    let idWasPrintedBeforeCollection = false;
    const pause = {
      status: 'paused' as const,
      pause: {
        kind: 'human-action' as const,
        phase: 'bind_principal' as const,
        code: 'principal_selection_required',
        message: 'Choose the verified principal conversation.',
        choices: [
          { id: 'gchat:spaces/AAA', label: 'Primary DM' },
          { id: "gchat:spaces/O'Brien", label: 'Second DM' },
        ],
      },
    };
    const collectCreateInputs = async () => {
      idWasPrintedBeforeCollection = /^instance_id: [0-9a-f-]{36}$/u.test(output[0] ?? '');
      return {
        'source-remote': 'https://example.test/nanoclaw.git',
        endpoint: 'https://assistant.example.test/webhook/gchat',
        'gcp-project': 'assistant-project',
        'chat-app': 'assistant-chat-app',
        'chat-credential-id': 'assistant-chat-key',
        'workspace-email': 'assistant@example.test',
        'setup-file': setupFile,
      };
    };

    expect(
      await runCli(['create', '--track', 'dogfood'], {
        paths,
        stdout: (line) => output.push(line),
        stderr: () => undefined,
        collectCreateInputs,
        advanceProvision: async () => pause,
        ...productionRuntime(),
      }),
    ).toBe(0);
    expect(idWasPrintedBeforeCollection).toBe(true);
    const instanceId = output[0]!.slice('instance_id: '.length);
    expect(output).toContain(
      `  "Primary DM": gws-ea resume --id ${instanceId} --messaging-group-id 'gchat:spaces/AAA'`,
    );
    expect(output).toContain(
      `  "Second DM": gws-ea resume --id ${instanceId} --messaging-group-id 'gchat:spaces/O'\\''Brien'`,
    );

    const resumeOutput: string[] = [];
    expect(
      await runCli(['resume', '--id', instanceId], {
        paths,
        stdout: (line) => resumeOutput.push(line),
        stderr: () => undefined,
        advanceProvision: async () => pause,
      }),
    ).toBe(0);
    expect(resumeOutput).toContain(
      `  "Primary DM": gws-ea resume --id ${instanceId} --messaging-group-id 'gchat:spaces/AAA'`,
    );
  });

  it('leaves no instance state and gives a rerun command when validation fails before reservation', async () => {
    const paths = await testPaths();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runCli(['create', '--track', 'dogfood'], {
      paths,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      collectCreateInputs: async () => {
        throw new GwsEaError('cancelled', 'Assistant creation was cancelled');
      },
    });

    expect(exitCode).toBe(1);
    expect(stdout[0]).toMatch(/^instance_id: [0-9a-f-]{36}$/u);
    expect(stderr.join('\n')).toContain('gws-ea create --track dogfood');
    expect((await readRegistry(paths)).instances).toEqual({});
  });

  it('leaves no registry state when production track resolution fails before reservation', async () => {
    const paths = await testPaths();
    const setupFile = await createSetupFile(paths);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runCli(createArgs(setupFile), {
      paths,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      resolveRelease: async () => {
        throw new GwsEaError('release_resolution_failed', 'Release track could not be resolved');
      },
      holdLoopbackPorts: async () => {
        throw new Error('ports must not be allocated after failed release resolution');
      },
    });

    expect(exitCode).toBe(1);
    expect(stdout[0]).toMatch(/^instance_id: [0-9a-f-]{36}$/u);
    expect(stderr.join('\n')).toContain('gws-ea create --track dogfood');
    expect((await readRegistry(paths)).instances).toEqual({});
  });

  it('leaves no registry state when production setup input is invalid', async () => {
    const paths = await testPaths();
    const setupFile = path.join(path.dirname(paths.configRoot), 'invalid-setup.json');
    await writeFile(setupFile, '{invalid-json', { mode: 0o600 });
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runCli(createArgs(setupFile), {
      paths,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      resolveRelease: async (sourceRemote, releaseRef) => ({ sourceRemote, releaseRef, commit: 'b'.repeat(40) }),
      holdLoopbackPorts: async () => {
        throw new Error('ports must not be allocated for invalid setup input');
      },
    });

    expect(exitCode).toBe(1);
    expect(stdout[0]).toMatch(/^instance_id: [0-9a-f-]{36}$/u);
    expect(stderr.join('\n')).toContain('Bootstrap manifest is not valid JSON');
    expect((await readRegistry(paths)).instances).toEqual({});
  });

  it('stages bootstrap input before reservation and removes it when reservation fails', async () => {
    const paths = await testPaths();
    const setupFile = await createSetupFile(paths);
    const stdout: string[] = [];
    let stagedBeforeReservation = false;

    expect(
      await runCli(createArgs(setupFile), {
        paths,
        stdout: (line) => stdout.push(line),
        stderr: () => undefined,
        reserveInstance: async (_paths, input) => {
          stagedBeforeReservation = (await readFile(paths.bootstrapFile(input.instance_id), 'utf8')).includes(
            '"schema_version": 1',
          );
          throw new GwsEaError('claim_conflict', 'An exclusive operational resource is already claimed');
        },
        ...productionRuntime(),
      }),
    ).toBe(1);

    const instanceId = stdout[0]!.slice('instance_id: '.length);
    expect(stagedBeforeReservation).toBe(true);
    await expect(stat(paths.bootstrapFile(instanceId))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(paths.instanceRoot(instanceId))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readRegistry(paths)).instances).toEqual({});
  });

  it('prints the id before reservation and only the exact safe resume command after a post-reservation failure', async () => {
    const paths = await testPaths();
    const setupFile = await createSetupFile(paths);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const secretCanary = 'secret-canary-must-not-print';
    const exitCode = await runCli(createArgs(setupFile), {
      paths,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      initializeJournal: async () => {
        throw new Error(secretCanary);
      },
      ...productionRuntime(),
    });

    expect(exitCode).toBe(1);
    expect(stdout[0]).toMatch(/^instance_id: [0-9a-f-]{36}$/);
    const instanceId = stdout[0]!.slice('instance_id: '.length);
    expect(Object.keys((await readRegistry(paths)).instances)).toEqual([instanceId]);
    await expect(readFile(paths.bootstrapFile(instanceId), 'utf8')).resolves.toContain('"schema_version": 1');
    expect(stderr.join('\n')).toContain(`gws-ea resume --id ${instanceId}`);
    expect(`${stdout.join('\n')}\n${stderr.join('\n')}`).not.toContain(secretCanary);

    const resumed: string[] = [];
    expect(
      await runCli(['resume', '--id', instanceId], {
        paths,
        stdout: () => undefined,
        stderr: () => undefined,
        advanceProvision: async (operation) => {
          resumed.push(operation.instanceId);
          return {
            status: 'paused',
            pause: {
              kind: 'human-action',
              phase: 'bind_principal',
              code: 'principal_dm_required',
              message: 'Send the direct message.',
            },
          };
        },
      }),
    ).toBe(0);
    expect(resumed).toEqual([instanceId]);
  });

  it('preserves resumable state when reservation publishes before reporting failure', async () => {
    const paths = await testPaths();
    const setupFile = await createSetupFile(paths);
    const stdout: string[] = [];
    const stderr: string[] = [];

    expect(
      await runCli(createArgs(setupFile), {
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

    const instanceId = stdout[0]!.slice('instance_id: '.length);
    expect(Object.keys((await readRegistry(paths)).instances)).toEqual([instanceId]);
    await expect(readFile(paths.bootstrapFile(instanceId), 'utf8')).resolves.toContain('"schema_version": 1');
    expect(stderr.join('\n')).toContain(`gws-ea resume --id ${instanceId}`);
    expect(stderr.join('\n')).not.toContain('gws-ea create --track');
  });
});
