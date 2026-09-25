import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli, type CliRuntime } from './cli.js';
import { runStep } from './events.js';
import { acquireInstanceOperation, readProvisionJournal, recordStepCompleted, recordStepStarted } from './journal.js';
import {
  allocateInstanceId,
  assertRegistryMarkerAgreement,
  readRegistry,
  reserveInstance,
  writeInstanceMarker,
} from './registry.js';
import { isLocalFilesystemType, resolveControlPlanePaths, type ControlPlanePaths } from './paths.js';
import type { Prerequisites } from './prerequisites.js';
import { GwsEaError, type InstanceReservationInput } from './types.js';

const roots: string[] = [];
const providerCapabilityDigest = 'd'.repeat(64);

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
      ingress: {
        mode: 'existing',
        endpoint_url: 'https://assistant.example.test/webhook/gchat',
      },
      gcp_project_id: 'assistant-project',
      gcp_account: 'operator@example.test',
      gchat_service_account: 'gws-ea-chat@assistant-project.iam.gserviceaccount.com',
      workspace_email: 'assistant@example.test',
      onecli_project: `gws-ea-${instanceId.replaceAll('-', '')}`,
    },
  };
}

function managedReservation(paths: ControlPlanePaths, instanceId = allocateInstanceId()): InstanceReservationInput {
  const input = reservation(paths, instanceId);
  return {
    ...input,
    exclusive_resource_claims: {
      ...input.exclusive_resource_claims,
      ingress: {
        mode: 'managed-cloudflare',
        account_id: 'a'.repeat(32),
        zone_id: 'b'.repeat(32),
        zone_name: 'example.com',
        hostname: 'assistant.example.com',
        callback_url: 'https://assistant.example.com/webhook/gchat',
        dns_record_id: null,
      },
    },
  };
}

function createArgs(): string[] {
  return [
    'create',
    '--track',
    'dogfood',
    '--source-remote',
    'https://example.test/nanoclaw.git',
    '--endpoint',
    'https://assistant.example.test/webhook/gchat',
    '--workspace-email',
    'assistant@example.test',
  ];
}

function createSetupInput() {
  return {
    sourceRemote: 'https://example.test/nanoclaw.git',
    ingress: { mode: 'existing', endpointUrl: 'https://assistant.example.test/webhook/gchat' },
    assistantWorkspaceEmail: 'assistant@example.test',
    bootstrapManifest: {
      schema_version: 1,
      onecli_cli_path: '/usr/local/bin/onecli',
      node_path: process.execPath,
      home_directory: '/Users/operator',
      platform: process.platform === 'darwin' ? 'macos' : 'linux',
      running_as_root: false,
      provider_capability_digest: providerCapabilityDigest,
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
      },
      selected_messaging_group_id: null,
    },
  } as const;
}

const PREREQUISITES: Prerequisites = {
  platform: process.platform === 'darwin' ? 'macos' : 'linux',
  homeDirectory: '/Users/operator',
  runningAsRoot: false,
  nodePath: process.execPath,
  onecliCliPath: '/usr/local/bin/onecli',
  dockerEndpoint: 'unix:///var/run/docker.sock',
  account: 'operator@example.test',
};

function productionRuntime() {
  return {
    collectCreateInputs: async () => createSetupInput(),
    checkPrerequisites: async () => PREREQUISITES,
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

  it('records one non-secret shared Cloudflare owner for managed reservations', async () => {
    const paths = await testPaths();
    const tokenCanary = 'cloudflare-account-token-canary';
    const input = managedReservation(paths);
    await reserveInstance(paths, input);

    const registry = await readRegistry(paths);
    expect(registry.instances[input.instance_id]).toEqual(input);
    expect(registry.shared_infrastructure_metadata.cloudflare).toMatchObject({
      account_id: 'a'.repeat(32),
      tunnel_id: null,
    });
    expect(registry.shared_infrastructure_metadata.cloudflare?.ownership_id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(await readFile(paths.registryFile, 'utf8')).not.toContain(tokenCanary);
  });

  it('rejects a second managed account and duplicate managed identity before publishing it', async () => {
    const paths = await testPaths();
    const first = managedReservation(paths);
    await reserveInstance(paths, first);

    const duplicate = managedReservation(paths);
    duplicate.allocated_ports.nanoclaw_webhook += 100;
    duplicate.allocated_ports.onecli_app += 100;
    duplicate.allocated_ports.onecli_gateway += 100;
    duplicate.exclusive_resource_claims.gcp_project_id = 'second-project';
    duplicate.exclusive_resource_claims.gchat_service_account = 'gws-ea-chat@second-project.iam.gserviceaccount.com';
    duplicate.exclusive_resource_claims.workspace_email = 'second@example.test';
    await expect(reserveInstance(paths, duplicate)).rejects.toMatchObject({ code: 'claim_conflict' });

    const crossAccount = managedReservation(paths);
    crossAccount.allocated_ports.nanoclaw_webhook += 200;
    crossAccount.allocated_ports.onecli_app += 200;
    crossAccount.allocated_ports.onecli_gateway += 200;
    crossAccount.exclusive_resource_claims.gcp_project_id = 'third-project';
    crossAccount.exclusive_resource_claims.gchat_service_account = 'gws-ea-chat@third-project.iam.gserviceaccount.com';
    crossAccount.exclusive_resource_claims.workspace_email = 'third@example.test';
    if (crossAccount.exclusive_resource_claims.ingress.mode !== 'managed-cloudflare') {
      throw new Error('managed reservation fixture is invalid');
    }
    crossAccount.exclusive_resource_claims.ingress = {
      ...crossAccount.exclusive_resource_claims.ingress,
      account_id: 'c'.repeat(32),
      zone_id: 'd'.repeat(32),
      zone_name: 'example.net',
      hostname: 'third.example.net',
      callback_url: 'https://third.example.net/webhook/gchat',
    };
    await expect(reserveInstance(paths, crossAccount)).rejects.toMatchObject({ code: 'cloudflare_account_conflict' });
    expect(Object.keys((await readRegistry(paths)).instances)).toEqual([first.instance_id]);
  });

  it('rejects inconsistent managed callbacks and secret-shaped shared metadata', async () => {
    const paths = await testPaths();
    const invalid = managedReservation(paths);
    if (invalid.exclusive_resource_claims.ingress.mode !== 'managed-cloudflare') {
      throw new Error('managed reservation fixture is invalid');
    }
    invalid.exclusive_resource_claims.ingress = {
      ...invalid.exclusive_resource_claims.ingress,
      callback_url: 'https://other.example.com/webhook/gchat',
    };
    await expect(reserveInstance(paths, invalid)).rejects.toMatchObject({ code: 'invalid_claim' });

    const nestedHostname = managedReservation(paths);
    if (nestedHostname.exclusive_resource_claims.ingress.mode !== 'managed-cloudflare') {
      throw new Error('managed reservation fixture is invalid');
    }
    nestedHostname.exclusive_resource_claims.ingress = {
      ...nestedHostname.exclusive_resource_claims.ingress,
      hostname: 'nested.assistant.example.com',
      callback_url: 'https://nested.assistant.example.com/webhook/gchat',
    };
    await expect(reserveInstance(paths, nestedHostname)).rejects.toMatchObject({ code: 'invalid_claim' });

    await mkdir(paths.configRoot, { recursive: true, mode: 0o700 });
    await writeFile(
      paths.registryFile,
      JSON.stringify({
        schema_version: 2,
        instances: {},
        shared_infrastructure_metadata: {
          cloudflare: {
            ownership_id: allocateInstanceId(),
            account_id: 'a'.repeat(32),
            tunnel_name: 'gws-ea-owner',
            tunnel_id: null,
            token: 'must-not-be-accepted',
          },
        },
      }),
      { mode: 0o600 },
    );
    await expect(readRegistry(paths)).rejects.toThrow(/unknown or missing fields/i);
  });

  it.each([
    ['corrupt JSON', '{not-json'],
    ['an unknown schema', JSON.stringify({ schema_version: 99, instances: {} })],
    [
      'an unvalidated field',
      JSON.stringify({
        schema_version: 2,
        instances: {},
        shared_infrastructure_metadata: { cloudflare: null },
        surprise: true,
      }),
    ],
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
  it('checks the reserved Google account before a GCP resume advances', async () => {
    const paths = await testPaths();
    const input = reservation(paths);
    await reserveInstance(paths, input);
    const preflight = vi.fn(async () => ({ ...PREREQUISITES, account: input.exclusive_resource_claims.gcp_account }));
    const advanceProvision = vi.fn(async () => ({
      status: 'paused' as const,
      pause: {
        kind: 'human-action' as const,
        phase: 'configure_channel' as const,
        code: 'chat_configuration_required',
        message: 'Configure Google Chat.',
      },
    }));

    expect(
      await runCli(['resume', '--id', input.instance_id], {
        paths,
        stdout: () => undefined,
        stderr: () => undefined,
        checkPrerequisites: preflight,
        advanceProvision,
      }),
    ).toBe(10);
    expect(preflight).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ command: 'resume', account: input.exclusive_resource_claims.gcp_account }),
      expect.anything(),
    );
    expect(advanceProvision).toHaveBeenCalledOnce();
  });

  it('checks Google sign-in on every resume, even after GCP setup is complete', async () => {
    const paths = await testPaths();
    const input = reservation(paths);
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
    const input = reservation(paths);
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

  it('clears run-scoped Cloudflare authority when create exits', async () => {
    const paths = await testPaths();
    const clearAccountToken = vi.fn();
    const discoverZones = vi.fn();

    expect(
      await runCli(createArgs(), {
        paths,
        stdout: () => undefined,
        stderr: () => undefined,
        ...productionRuntime(),
        advanceProvision: async () => ({
          status: 'paused',
          pause: {
            kind: 'human-action',
            phase: 'configure_channel',
            code: 'chat_configuration_required',
            message: 'Configure Google Chat.',
          },
        }),
        managedIngressSetup: {
          discoverZones,
          retainAccountToken: vi.fn(),
          requireAccountToken: vi.fn(),
          clearAccountToken,
        },
      }),
    ).toBe(10);
    expect(discoverZones).not.toHaveBeenCalled();
    expect(clearAccountToken).toHaveBeenCalledOnce();
  });

  it('clears run-scoped Cloudflare authority when resume exits', async () => {
    const paths = await testPaths();
    const input = await reserveInstance(paths, managedReservation(paths));
    const clearAccountToken = vi.fn();

    expect(
      await runCli(['resume', '--id', input.instance_id], {
        paths,
        stdout: () => undefined,
        stderr: () => undefined,
        checkPrerequisites: async () => PREREQUISITES,
        advanceProvision: async () => ({
          status: 'paused',
          pause: {
            kind: 'human-action',
            phase: 'configure_channel',
            code: 'chat_configuration_required',
            message: 'Configure Google Chat.',
          },
        }),
        managedIngressSetup: {
          discoverZones: vi.fn(),
          retainAccountToken: vi.fn(),
          requireAccountToken: vi.fn(),
          clearAccountToken,
        },
      }),
    ).toBe(10);
    expect(clearAccountToken).toHaveBeenCalledOnce();
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
    const advanceProvision: NonNullable<CliRuntime['advanceProvision']> = async (operation, { portLease, runtime }) => {
      if (advanced.length === 0) {
        expect(portLease).toBeDefined();
        expect(portsReleased).toBe(false);
      }
      await runStep(runtime, { id: 'provision_gcp', label: 'Configuring Google Cloud…' }, async () => {
        runtime.emit?.({ type: 'step-waiting', step: 'provision_gcp', reason: 'Waiting for the service account…' });
        runtime.emit?.({ type: 'step-waiting', step: 'provision_gcp', reason: 'Waiting for the service account…' });
      });
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
    expect(
      await runCli(createArgs(), {
        paths,
        stdout: (line) => output.push(line),
        stderr: () => undefined,
        checkPrerequisites: async () => PREREQUISITES,
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
        collectCreateInputs: async () => createSetupInput(),
      }),
    ).toBe(10);
    const instanceId = output[0]!.slice('instance_id: '.length);
    expect(resolveCalls).toEqual([['https://example.test/nanoclaw.git', 'refs/heads/dogfood']]);
    expect(portsReleased).toBe(true);
    expect(output.slice(1, 6)).toEqual([
      'Resolving the release…',
      'Reserving the assistant…',
      'Configuring Google Cloud…',
      'Waiting for the service account…',
      'Paused at bind_principal: Send the direct message.',
    ]);
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
        checkPrerequisites: async () => PREREQUISITES,
        advanceProvision,
      }),
    ).toBe(10);
    expect(advanced).toEqual([instanceId, instanceId]);
  });

  it('prints durable, deduplicated progress while a non-interactive resume advances', async () => {
    const paths = await testPaths();
    const input = reservation(paths);
    await reserveInstance(paths, input);
    const output: string[] = [];
    const advanceProvision: NonNullable<CliRuntime['advanceProvision']> = async (_operation, { runtime }) =>
      runStep(
        runtime,
        { id: 'provision_gcp', label: 'Configuring Google Cloud…' },
        async () => {
          runtime.emit?.({ type: 'step-waiting', step: 'provision_gcp', reason: 'Waiting for the service account…' });
          runtime.emit?.({ type: 'step-waiting', step: 'provision_gcp', reason: 'Waiting for the service account…' });
          return {
            status: 'paused' as const,
            pause: {
              kind: 'human-action' as const,
              phase: 'configure_channel' as const,
              code: 'chat_configuration_required',
              message: 'Configure Google Chat.',
            },
          };
        },
        (result) => result.pause,
      );

    expect(
      await runCli(['resume', '--id', input.instance_id], {
        paths,
        stdout: (line) => output.push(line),
        stderr: () => undefined,
        checkPrerequisites: async () => PREREQUISITES,
        advanceProvision,
      }),
    ).toBe(10);

    expect(output).toEqual([
      'Configuring Google Cloud…',
      'Waiting for the service account…',
      'Paused at configure_channel: Configure Google Chat.',
      `Continue with: gws-ea resume --id ${input.instance_id}`,
      expect.stringMatching(/^Log: \S+progress\.log$/u),
    ]);
  });

  it('provisions from the documented create command and prints exact principal-selection commands', async () => {
    const paths = await testPaths();
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
      return createSetupInput();
    };

    expect(
      await runCli(['create', '--track', 'dogfood', '--source-remote', 'https://example.test/nanoclaw.git'], {
        paths,
        stdout: (line) => output.push(line),
        stderr: () => undefined,
        ...productionRuntime(),
        collectCreateInputs,
        advanceProvision: async () => pause,
      }),
    ).toBe(10);
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
        checkPrerequisites: async () => PREREQUISITES,
        advanceProvision: async () => pause,
      }),
    ).toBe(10);
    expect(resumeOutput).toContain(
      `  "Primary DM": gws-ea resume --id ${instanceId} --messaging-group-id 'gchat:spaces/AAA'`,
    );
  });

  it('leaves no instance state and gives a rerun command when validation fails before reservation', async () => {
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

    expect(exitCode).toBe(1);
    expect(stdout[0]).toMatch(/^instance_id: [0-9a-f-]{36}$/u);
    expect(stderr.join('\n')).toContain('gws-ea create --track dogfood');
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
      resolveRelease: async (sourceRemote, releaseRef) => ({ sourceRemote, releaseRef, commit: 'b'.repeat(40) }),
      holdLoopbackPorts: async () => {
        throw new Error('ports must not be allocated for invalid setup input');
      },
    });

    expect(exitCode).toBe(1);
    expect(stdout[0]).toMatch(/^instance_id: [0-9a-f-]{36}$/u);
    expect(stderr.join('\n')).toContain('Bootstrap manifest schema is unsupported');
    expect((await readRegistry(paths)).instances).toEqual({});
  });

  it('stages bootstrap input before reservation and removes it when reservation fails', async () => {
    const paths = await testPaths();
    const stdout: string[] = [];
    let stagedBeforeReservation = false;

    expect(
      await runCli(createArgs(), {
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
    expect(stdout[0]).toMatch(/^instance_id: [0-9a-f-]{36}$/);
    const instanceId = stdout[0]!.slice('instance_id: '.length);
    expect(Object.keys((await readRegistry(paths)).instances)).toEqual([instanceId]);
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
              phase: 'bind_principal',
              code: 'principal_dm_required',
              message: 'Send the direct message.',
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

    const instanceId = stdout[0]!.slice('instance_id: '.length);
    expect(Object.keys((await readRegistry(paths)).instances)).toEqual([instanceId]);
    await expect(readFile(paths.bootstrapFile(instanceId), 'utf8')).resolves.toContain('"schema_version": 1');
    expect(stderr.join('\n')).toContain(`gws-ea resume --id ${instanceId}`);
    expect(stderr.join('\n')).not.toContain('gws-ea create --track');
  });
});
