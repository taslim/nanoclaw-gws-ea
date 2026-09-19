import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildComposeInvocation,
  buildComposeEnvironment,
  buildOnecliCliEnvironment,
  cleanupOnecliDockerOrphans,
  importProviderCredential,
  onecliSecretMatchesCredentialMetadata,
  persistOnecliApiKeyFiles,
  prepareOnecliRuntime,
  removeOnecliRuntime,
  runOnecliCompatibilityCanary,
  validateObservedOnecliRuntime,
  type OnecliCommandRunner,
  type OnecliSdkClient,
} from './onecli.js';
import { createOnecliRuntimeLayout } from './onecli-compose.js';

const INSTANCE_ID = '12345678-1234-4123-8123-123456789abc';
const ONECLI_API_KEY = `oc_${'a'.repeat(64)}`;
const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function layoutFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gws-ea-onecli-'));
  roots.push(root);
  return createOnecliRuntimeLayout({
    instanceId: INSTANCE_ID,
    instanceRoot: root,
    project: 'gws-ea-12345678123441238123123456789abc',
    appPort: 31_002,
    gatewayPort: 31_003,
    cliExecutable: '/opt/onecli/bin/onecli',
  });
}

describe('OneCLI child boundaries', () => {
  it('compares the complete non-secret provider contract for an existing secret ID', () => {
    const expected = {
      name: 'Anthropic',
      type: 'generic',
      hostPattern: 'api.example.test',
      headerName: 'Authorization',
      valueFormat: 'Bearer {value}',
    };
    const observed = {
      id: 'same-secret-id',
      name: 'Anthropic',
      type: 'generic',
      hostPattern: 'api.example.test',
      pathPattern: null,
      injectionConfig: { headerName: 'Authorization', valueFormat: 'Bearer {value}' },
    };

    expect(onecliSecretMatchesCredentialMetadata(observed, expected)).toBe(true);
    expect(onecliSecretMatchesCredentialMetadata({ ...observed, hostPattern: 'drifted.example.test' }, expected)).toBe(
      false,
    );
  });

  it('uses explicit Compose coordinates and drops hostile ambient targeting variables', async () => {
    const layout = await layoutFixture();
    const env = buildOnecliCliEnvironment(
      layout,
      {
        PATH: '/safe/bin',
        HOME: '/host/home',
        LANG: 'en_US.UTF-8',
        COMPOSE_PROJECT_NAME: 'victim',
        COMPOSE_FILE: '/tmp/attacker.yml',
        ONECLI_API_HOST: 'https://attacker.invalid',
        ONECLI_API_KEY: 'ambient-secret',
        POSTGRES_PASSWORD: 'ambient-postgres',
        NANOCLAW_INSTALL_ID: 'victim',
        GCHAT_CREDENTIALS: 'channel-secret',
      },
      undefined,
    );
    const invocation = buildComposeInvocation(layout, ['config']);
    const composeEnv = buildComposeEnvironment({
      PATH: '/safe/bin',
      HOME: '/host/home',
      COMPOSE_PROJECT_NAME: 'victim',
      COMPOSE_FILE: '/tmp/attacker.yml',
      ONECLI_API_HOST: 'https://attacker.invalid',
      POSTGRES_PASSWORD: 'ambient-postgres',
      NANOCLAW_INSTALL_ID: 'victim',
      GCHAT_CREDENTIALS: 'channel-secret',
    });

    expect(invocation).toEqual({
      command: 'docker',
      args: [
        'compose',
        '--project-name',
        layout.project,
        '--file',
        layout.composeFile,
        '--project-directory',
        layout.rootDirectory,
        '--env-file',
        layout.envFile,
        'config',
      ],
      cwd: layout.rootDirectory,
    });
    expect(env).toMatchObject({
      PATH: '/safe/bin',
      HOME: layout.cliHome,
      LANG: 'en_US.UTF-8',
      ONECLI_API_HOST: layout.appUrl,
    });
    expect(env).not.toHaveProperty('COMPOSE_PROJECT_NAME');
    expect(env).not.toHaveProperty('COMPOSE_FILE');
    expect(env).not.toHaveProperty('ONECLI_API_KEY');
    expect(env).not.toHaveProperty('POSTGRES_PASSWORD');
    expect(env).not.toHaveProperty('NANOCLAW_INSTALL_ID');
    expect(env).not.toHaveProperty('GCHAT_CREDENTIALS');
    expect(composeEnv).toEqual({ PATH: '/safe/bin', HOME: '/host/home' });
  });
});

describe('OneCLI runtime material', () => {
  it('creates owner-only runtime files without embedding secrets in Compose or its env file', async () => {
    const layout = await layoutFixture();
    await prepareOnecliRuntime(layout);

    for (const file of [
      layout.composeFile,
      layout.envFile,
      layout.postgresPasswordFile,
      layout.encryptionKeyFile,
      layout.gatewayInternalSecretFile,
    ]) {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    }
    expect((await stat(layout.rootDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(layout.secretsDirectory)).mode & 0o777).toBe(0o700);
    const compose = await readFile(layout.composeFile, 'utf8');
    const envFile = await readFile(layout.envFile, 'utf8');
    for (const secretFile of [
      layout.postgresPasswordFile,
      layout.encryptionKeyFile,
      layout.gatewayInternalSecretFile,
    ]) {
      const secret = (await readFile(secretFile, 'utf8')).trim();
      expect(secret.length).toBeGreaterThan(30);
      expect(compose).not.toContain(secret);
      expect(envFile).not.toContain(secret);
    }
    expect((await readFile(layout.encryptionKeyFile, 'utf8')).trim()).toMatch(/^[A-Za-z0-9+/]+={0,2}$/u);
  });
});

describe('OneCLI runtime verification', () => {
  it('accepts only the exact labels, health, ports, volumes, and network topology', async () => {
    const layout = await layoutFixture();
    expect(
      validateObservedOnecliRuntime(layout, {
        containers: [
          {
            service: 'postgres',
            image: 'postgres:18-alpine',
            instanceId: INSTANCE_ID,
            project: layout.project,
            running: true,
            healthy: true,
            publishedPorts: {},
            networks: [layout.backendNetwork],
            volumes: [{ name: layout.postgresVolume, destination: '/var/lib/postgresql' }],
          },
          {
            service: 'app',
            image: 'ghcr.io/onecli/onecli:1.42.0',
            instanceId: INSTANCE_ID,
            project: layout.project,
            running: true,
            healthy: true,
            publishedPorts: { '10254/tcp': [{ hostIp: '127.0.0.1', hostPort: '31002' }] },
            networks: [layout.backendNetwork],
            volumes: [{ name: layout.appVolume, destination: '/app/data' }],
          },
          {
            service: 'gateway',
            image: 'ghcr.io/onecli/onecli:1.42.0',
            instanceId: INSTANCE_ID,
            project: layout.project,
            running: true,
            healthy: true,
            publishedPorts: { '10255/tcp': [{ hostIp: '127.0.0.1', hostPort: '31003' }] },
            networks: [layout.agentEgressNetwork, layout.backendNetwork],
            volumes: [{ name: layout.appVolume, destination: '/app/data' }],
          },
        ],
        networks: [
          { name: layout.backendNetwork, instanceId: INSTANCE_ID, role: 'backend', internal: false },
          { name: layout.agentEgressNetwork, instanceId: INSTANCE_ID, role: 'agent-egress', internal: true },
        ],
        volumes: [
          { name: layout.postgresVolume, instanceId: INSTANCE_ID, role: 'postgres-data' },
          { name: layout.appVolume, instanceId: INSTANCE_ID, role: 'app-data' },
        ],
      }),
    ).toBeUndefined();
  });

  it('rejects a gateway that is not the only dual-homed service', async () => {
    const layout = await layoutFixture();
    expect(() =>
      validateObservedOnecliRuntime(layout, {
        containers: [
          {
            service: 'postgres',
            image: 'postgres:18-alpine',
            instanceId: INSTANCE_ID,
            project: layout.project,
            running: true,
            healthy: true,
            publishedPorts: {},
            networks: [layout.backendNetwork, layout.agentEgressNetwork],
            volumes: [{ name: layout.postgresVolume, destination: '/var/lib/postgresql' }],
          },
        ],
        networks: [],
        volumes: [],
      }),
    ).toThrow(/topology/i);
  });

  it('removes only correctly owned orphan containers before reconciliation', async () => {
    const layout = await layoutFixture();
    const calls: string[][] = [];
    const runner: OnecliCommandRunner = async (command) => {
      calls.push([...command.args]);
      if (command.args[0] === 'container' && command.args[1] === 'ls') {
        return { stdout: 'orphan-id\n', stderr: '' };
      }
      if (command.args[0] === 'container' && command.args[1] === 'inspect') {
        return {
          stdout: JSON.stringify([
            {
              Id: 'orphan-id',
              Config: {
                Image: 'irrelevant',
                Labels: {
                  'com.docker.compose.project': layout.project,
                  'com.docker.compose.service': 'retired-service',
                  'dev.gws-ea.instance-id': INSTANCE_ID,
                },
              },
              State: { Running: false },
              NetworkSettings: { Ports: {}, Networks: {} },
              Mounts: [],
            },
          ]),
          stderr: '',
        };
      }
      if (command.args[0] === 'container' && command.args[1] === 'rm') {
        return { stdout: 'orphan-id', stderr: '' };
      }
      throw new Error(`unexpected command: ${command.args.join(' ')}`);
    };

    await cleanupOnecliDockerOrphans(layout, runner, { PATH: '/safe/bin' });
    expect(calls).toContainEqual(['container', 'rm', '--force', 'orphan-id']);
  });

  it('removes and verifies only the exact owned OneCLI networks and volumes', async () => {
    const layout = await layoutFixture();
    let resourcesPresent = true;
    let downCalls = 0;
    const runner: OnecliCommandRunner = async (command) => {
      if (command.args[0] === 'container' && command.args[1] === 'ls') {
        return { stdout: '', stderr: '' };
      }
      if ((command.args[0] === 'network' || command.args[0] === 'volume') && command.args[1] === 'ls') {
        if (!resourcesPresent) return { stdout: '', stderr: '' };
        const filter = command.args[command.args.indexOf('--filter') + 1] ?? '';
        const name = filter.replace(/^name=\^/u, '').replace(/\$$/u, '');
        return { stdout: `${name}\n`, stderr: '' };
      }
      if (command.args[0] === 'compose' && command.args.includes('down')) {
        downCalls += 1;
        resourcesPresent = false;
        return { stdout: '', stderr: '' };
      }
      throw new Error(`unexpected command: ${command.args.join(' ')}`);
    };

    await removeOnecliRuntime(layout, { dockerCommandRunner: runner, ambientEnv: { PATH: '/safe/bin' } });

    expect(downCalls).toBe(1);
  });

  it('treats a not-yet-created OneCLI runtime as already removed', async () => {
    const layout = await layoutFixture();
    const calls: string[][] = [];
    const runner: OnecliCommandRunner = async (command) => {
      expect(command.cwd).toBe(path.dirname(layout.rootDirectory));
      calls.push([...command.args]);
      return { stdout: '', stderr: '' };
    };

    await removeOnecliRuntime(layout, { dockerCommandRunner: runner });

    expect(calls.some((args) => args[0] === 'compose')).toBe(false);
  });

  it('refuses to remove an exact-name OneCLI resource without this instance ownership label', async () => {
    const layout = await layoutFixture();
    let downCalls = 0;
    const runner: OnecliCommandRunner = async (command) => {
      if (command.args[0] === 'container' && command.args[1] === 'ls') {
        return { stdout: '', stderr: '' };
      }
      if ((command.args[0] === 'network' || command.args[0] === 'volume') && command.args[1] === 'ls') {
        const filters = command.args.filter((value) => value.startsWith('label='));
        if (filters.length > 0) return { stdout: '', stderr: '' };
        const filter = command.args[command.args.indexOf('--filter') + 1] ?? '';
        const name = filter.replace(/^name=\^/u, '').replace(/\$$/u, '');
        return { stdout: `${name}\n`, stderr: '' };
      }
      if (command.args[0] === 'compose' && command.args.includes('down')) {
        downCalls += 1;
        return { stdout: '', stderr: '' };
      }
      throw new Error(`unexpected command: ${command.args.join(' ')}`);
    };

    await expect(removeOnecliRuntime(layout, { dockerCommandRunner: runner })).rejects.toMatchObject({
      code: 'unsafe_onecli_owner',
    });
    expect(downCalls).toBe(0);
  });
});

describe('OneCLI compatibility and provider import', () => {
  it('proves CLI and SDK paths with disposable resources before accepting a provider credential', async () => {
    const layout = await layoutFixture();
    await prepareOnecliRuntime(layout);
    const calls: string[][] = [];
    let secrets: Array<Record<string, unknown>> = [];
    let agents: Array<Record<string, unknown>> = [];
    let assignedSecretIds: string[] = [];
    const runner: OnecliCommandRunner = async (command) => {
      calls.push([command.command, ...command.args]);
      const args = command.args;
      if (args[0] === 'auth' && args[1] === 'api-key') {
        expect(command.env).not.toHaveProperty('ONECLI_API_KEY');
        return { stdout: JSON.stringify({ apiKey: ONECLI_API_KEY }), stderr: '' };
      }
      expect(command.env?.ONECLI_API_KEY).toBe(ONECLI_API_KEY);
      if (args[0] === 'version') {
        return { stdout: JSON.stringify({ version: '2.2.5', server_version: '1.42.0' }), stderr: '' };
      }
      if (args[0] === 'secrets' && args[1] === 'list') {
        return { stdout: JSON.stringify(secrets), stderr: '' };
      }
      if (args[0] === 'secrets' && args[1] === 'create') {
        const name = args[args.indexOf('--name') + 1];
        const secret = {
          id: name === 'GWS-EA compatibility canary' ? 'secret-canary' : 'secret-provider',
          name,
          type: args[args.indexOf('--type') + 1],
          hostPattern: args[args.indexOf('--host-pattern') + 1],
          pathPattern: null,
          injectionConfig: null,
        };
        secrets = [...secrets, secret];
        return { stdout: JSON.stringify(secret), stderr: '' };
      }
      if (args[0] === 'secrets' && args[1] === 'delete') {
        secrets = secrets.filter((secret) => secret.id !== args[args.indexOf('--id') + 1]);
        return { stdout: '{}', stderr: '' };
      }
      if (args[0] === 'agents' && args[1] === 'list') {
        return { stdout: JSON.stringify(agents), stderr: '' };
      }
      if (args[0] === 'agents' && args[1] === 'set-secrets') {
        assignedSecretIds = [args[args.indexOf('--secret-ids') + 1]];
        agents = agents.map((agent) => ({ ...agent, secretMode: 'selective' }));
        return { stdout: '{}', stderr: '' };
      }
      if (args[0] === 'agents' && args[1] === 'secrets') {
        return { stdout: JSON.stringify(assignedSecretIds), stderr: '' };
      }
      if (args[0] === 'agents' && args[1] === 'delete') {
        agents = [];
        return { stdout: '{}', stderr: '' };
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    };
    const sdk: OnecliSdkClient = {
      ensureAgent: vi.fn(async (input) => {
        agents = [
          {
            id: 'agent-canary',
            name: input.name,
            identifier: input.identifier,
            secretMode: 'all',
          },
        ];
        return { name: input.name, identifier: input.identifier, created: true };
      }),
      getContainerConfig: vi.fn(async () => ({
        env: { HTTPS_PROXY: 'http://x:token@host.docker.internal:10255' },
        caCertificate: 'certificate',
        caCertificateContainerPath: '/tmp/onecli-gateway-ca.pem',
      })),
    };

    const receipt = await runOnecliCompatibilityCanary(layout, {
      runCommand: runner,
      createSdkClient: () => sdk,
      fetch: vi.fn(async () => new Response('{}', { status: 200 })),
    });
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.keys(receipt)).toEqual([]);
    const runtimeKeyFile = path.join(layout.secretsDirectory, 'runtime-api-key');
    const adminKeyFile = path.join(layout.secretsDirectory, 'admin-api-key');
    await persistOnecliApiKeyFiles(receipt, { runtime: runtimeKeyFile, admin: adminKeyFile });
    const imported = await importProviderCredential(
      receipt,
      {
        name: 'Anthropic',
        type: 'anthropic',
        value: 'provider-real-secret',
        hostPattern: 'api.anthropic.com',
      },
      { runCommand: runner },
    );

    expect(imported).toEqual({ id: 'secret-provider', created: true });
    expect(await readFile(runtimeKeyFile, 'utf8')).toBe(ONECLI_API_KEY);
    expect(await readFile(adminKeyFile, 'utf8')).toBe(ONECLI_API_KEY);
    expect((await stat(runtimeKeyFile)).mode & 0o777).toBe(0o600);
    expect((await stat(adminKeyFile)).mode & 0o777).toBe(0o600);
    expect(calls.every((call) => call[0] === layout.cliExecutable)).toBe(true);
    const providerCreate = calls.find(
      (call) => call[1] === 'secrets' && call[2] === 'create' && call.includes('Anthropic'),
    );
    expect(providerCreate).toContain('--file');
    expect(providerCreate).not.toContain('provider-real-secret');
    expect(await stat(layout.providerStagingFile).catch(() => null)).toBeNull();
    expect(secrets).toEqual([expect.objectContaining({ id: 'secret-provider' })]);
    expect(agents).toEqual([]);
  });

  it('removes an orphaned plaintext staging file before listing or importing secrets', async () => {
    const layout = await layoutFixture();
    await prepareOnecliRuntime(layout);
    await mkdir(path.dirname(layout.providerStagingFile), { recursive: true });
    await writeFile(layout.providerStagingFile, 'orphaned-provider-secret', { mode: 0o600 });
    const observations: boolean[] = [];
    const runner: OnecliCommandRunner = async (command) => {
      if (command.args[0] === 'auth' && command.args[1] === 'api-key') {
        return { stdout: JSON.stringify({ apiKey: ONECLI_API_KEY }), stderr: '' };
      }
      if (command.args[0] === 'version') {
        return { stdout: JSON.stringify({ version: '2.2.5', server_version: '1.42.0' }), stderr: '' };
      }
      observations.push(
        await stat(layout.providerStagingFile)
          .then(() => true)
          .catch(() => false),
      );
      if (command.args[0] === 'secrets' && command.args[1] === 'list') {
        return { stdout: '[]', stderr: '' };
      }
      throw new Error('stop after orphan-cleanup proof');
    };
    const sdk: OnecliSdkClient = {
      ensureAgent: vi.fn(async () => {
        throw new Error('stop after orphan-cleanup proof');
      }),
      getContainerConfig: vi.fn(async () => {
        throw new Error('unused');
      }),
    };

    await expect(
      runOnecliCompatibilityCanary(layout, {
        runCommand: runner,
        createSdkClient: () => sdk,
        fetch: vi.fn(async () => new Response('{}', { status: 200 })),
      }),
    ).rejects.toThrow();
    expect(observations.length).toBeGreaterThan(0);
    expect(observations).not.toContain(true);
  });
});
