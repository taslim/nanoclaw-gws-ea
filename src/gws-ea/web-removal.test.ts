import { randomBytes, randomUUID } from 'node:crypto';
import { access, chmod, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import {
  webIngress,
  webOperatorFiles,
  readWebOperatorConfig,
  writeWebOperatorConfig,
  type WebOperatorConfig,
} from './web-cloudflare.js';
import { deriveGcpClaims } from './gcp-identity.js';
import { recordStepStarted, reserveInstance, withInstanceOperation } from './journal.js';
import { resolveControlPlanePaths, type ControlPlanePaths } from './paths.js';
import { claimInstanceWeb, readRegistry, writeInstanceMarker } from './registry.js';
import { removeAssistant, type RemovalDependencies } from './remove.js';
import { writePrivateTextFile } from './secrets.js';
import { renderLaunchdService, renderSystemdService } from './service-definition.js';
import type { InstanceReservationInput } from './types.js';
import { inspectWebUninstall, uninstallWebConnector } from './web-uninstall.js';
import { webConnectorInstalled } from './web-connector.js';
import { runCli } from './cli.js';
import { expectResultContract } from './testing/result-contract.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function exists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  );
}
async function reserve(paths: ControlPlanePaths, name: string, port: number) {
  const id = randomUUID();
  const input: InstanceReservationInput = {
    instance_id: id,
    release_track: 'dogfood',
    source_remote: 'https://example.test/repo.git',
    deployed_commit: 'a'.repeat(40),
    allocated_ports: { onecli_app: port, onecli_gateway: port + 1 },
    exclusive_resource_claims: {
      ...deriveGcpClaims(id),
      gcp_account: 'operator@example.test',
      workspace_email: `${name}@example.test`,
      onecli_project: `gws-ea-${id.replaceAll('-', '')}`,
    },
  };
  await reserveInstance(paths, input);
  await writeInstanceMarker(paths, id);
  await withInstanceOperation(paths, id, async (operation) => recordStepStarted(operation, 'start_nanoclaw'));
  return claimInstanceWeb(paths, id, {
    hostname: `${name}.example.com`,
    listen_port: port + 2,
  });
}
async function fixture(peer = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'web-remove-'));
  roots.push(root);
  const paths = resolveControlPlanePaths({
    configRoot: path.join(root, 'config'),
    stateRoot: path.join(root, 'state'),
  });
  const own = await reserve(paths, 'aya', 34000);
  const other = peer ? await reserve(paths, 'avery', 35000) : undefined;
  const files = webOperatorFiles(paths);
  await mkdir(files.root, { recursive: true, mode: 0o700 });
  const config: WebOperatorConfig = {
    schemaVersion: 1,
    accountId: 'account',
    teamName: 'team',
    zoneId: 'zone',
    zoneApex: 'example.com',
    credentialFile: path.join(files.root, 'management-token'),
    cloudflaredPath: '/usr/local/bin/cloudflared',
    tunnelId: 'tunnel',
    pin: { id: 'pin', owned: true },
    dns: {
      'aya.example.com': { id: 'dns', zoneId: 'zone' },
      ...(other ? { 'avery.example.com': { id: 'peer-dns', zoneId: 'zone' } } : {}),
    },
    assistants: {
      [own.instance_id]: {
        claim: own.exclusive_resource_claims.web!,
        applicationId: 'own-app',
        policyId: 'own-policy',
        aud: 'own-aud',
        enabled: true,
      },
      ...(other
        ? {
            [other.instance_id]: {
              claim: other.exclusive_resource_claims.web!,
              applicationId: 'peer-app',
              policyId: 'peer-policy',
              aud: 'peer-aud',
              enabled: false,
            },
          }
        : {}),
    },
  };
  await writeWebOperatorConfig(files.configFile, config);
  await writePrivateTextFile(config.credentialFile, randomBytes(32).toString('hex'));
  await writePrivateTextFile(files.tokenFile, randomBytes(32).toString('hex'));
  const resources = new Map<string, unknown>([
    ['/accounts/account/access/apps/own-app', { id: 'own-app' }],
    ['/accounts/account/access/apps/peer-app', { id: 'peer-app' }],
    ['/accounts/account/cfd_tunnel/tunnel', { id: 'tunnel', config_src: 'cloudflare' }],
    ['/zones/zone/dns_records/dns', { id: 'dns' }],
    ['/zones/zone/dns_records/peer-dns', { id: 'peer-dns' }],
    ['/accounts/account/access/identity_providers/pin', { id: 'pin', type: 'onetimepin' }],
  ]);
  let ingress = {
    config: {
      ingress: [
        ...Object.values(config.assistants).map(({ claim }) => webIngress(claim)),
        { service: 'http_status:404' },
      ],
    },
  };
  const effects: string[] = [];
  let failDelete: string | undefined;
  const send: typeof fetch = async (url, options) => {
    const resource = new URL(String(url)).pathname.replace('/client/v4', '');
    const method = options?.method ?? 'GET';
    if (method !== 'GET') {
      // The actual native removal receipt must precede every external mutation.
      if (await exists(paths.removalFile(own.instance_id))) {
        const receipt = JSON.parse(await readFile(paths.removalFile(own.instance_id), 'utf8')) as { web?: unknown };
        expect(receipt.web).toBeDefined();
      } else expect((await inspectWebUninstall(paths))?.stopped).toBe(true);
      effects.push(`${method} ${resource}`);
    }
    if (resource.endsWith('/configurations')) {
      if (method === 'PUT') ingress = JSON.parse(String(options?.body)) as typeof ingress;
      return Response.json({ success: true, result: ingress });
    }
    if (method === 'DELETE') {
      if (failDelete === resource) return Response.json({ success: false }, { status: 403 });
      resources.delete(resource);
      return Response.json({ success: true, result: {} });
    }
    const value = resources.get(resource);
    return value ? Response.json({ success: true, result: value }) : Response.json({ success: false }, { status: 404 });
  };
  const dependencies: RemovalDependencies = {
    interaction: {
      signInToGoogleCloud: async () => {
        throw new Error('Unexpected Google sign-in');
      },
    },
    resolveDocker: async () => 'unix:///var/run/docker.sock',
    uninstallNanoclaw: async () => {
      effects.push('host-stopped');
    },
    fetch: send,
    runCommand: async () => {
      throw new Error('Unexpected service manager');
    },
  };
  return {
    root,
    paths,
    own,
    other,
    files,
    config,
    resources,
    effects,
    dependencies,
    ingress: () => ingress,
    fail: (value?: string) => {
      failDelete = value;
    },
  };
}

it('removes only the assistant app and ingress while disabled peer intent keeps shared resources and credentials', async () => {
  const f = await fixture(true);
  const beforePeer = (await readRegistry(f.paths)).instances[f.other!.instance_id];
  const outcome = await removeAssistant(f.paths, f.own.instance_id, f.dependencies);
  expect(outcome.removed).toContain('web');
  expect(f.effects[0]).toBe('host-stopped');
  expect(f.resources.has('/accounts/account/access/apps/own-app')).toBe(false);
  expect(f.resources.has('/accounts/account/access/apps/peer-app')).toBe(true);
  expect(f.effects.filter((effect) => effect.startsWith('DELETE'))).toEqual([
    'DELETE /accounts/account/access/apps/own-app',
    'DELETE /zones/zone/dns_records/dns',
  ]);
  expect(f.ingress().config.ingress).toEqual([
    webIngress(f.config.assistants[f.other!.instance_id].claim),
    { service: 'http_status:404' },
  ]);
  expect(await exists(f.config.credentialFile)).toBe(true);
  expect(await exists(f.files.tokenFile)).toBe(true);
  expect((await readWebOperatorConfig(f.files.configFile))?.assistants).toEqual({
    [f.other!.instance_id]: f.config.assistants[f.other!.instance_id],
  });
  expect((await readRegistry(f.paths)).instances[f.other!.instance_id]).toEqual(beforePeer);
});

it('removes the last assistant while keeping the installed connector, tunnel, PIN and credentials for the next assistant', async () => {
  const { f, definitionFile } = await launchdFixture();
  const before = await readWebOperatorConfig(f.files.configFile);
  await removeAssistant(f.paths, f.own.instance_id, f.dependencies);
  expect(await exists(definitionFile)).toBe(true);
  expect(f.effects.filter((effect) => effect.startsWith('DELETE'))).toEqual([
    'DELETE /accounts/account/access/apps/own-app',
    'DELETE /zones/zone/dns_records/dns',
  ]);
  expect(f.resources.has('/accounts/account/cfd_tunnel/tunnel')).toBe(true);
  expect(f.resources.has('/accounts/account/access/identity_providers/pin')).toBe(true);
  expect(await exists(f.config.credentialFile)).toBe(true);
  expect(await exists(f.files.tokenFile)).toBe(true);
  expect(await readWebOperatorConfig(f.files.configFile)).toEqual({ ...before, assistants: {}, dns: {} });
  expect(await exists(f.paths.removalFile(f.own.instance_id))).toBe(false);
  expect((await readRegistry(f.paths)).instances[f.own.instance_id]).toBeUndefined();
  expect(await webConnectorInstalled(f.paths)).toBe(true);
  const next = await reserve(f.paths, 'juno', 34000);
  expect(next.exclusive_resource_claims.web?.hostname).toBe('juno.example.com');
  expect((await readWebOperatorConfig(f.files.configFile))?.tunnelId).toBe('tunnel');
});

it('keeps an unrelated recorded DNS name when the last assistant is removed', async () => {
  const f = await fixture();
  await writeWebOperatorConfig(f.files.configFile, {
    ...f.config,
    dns: {
      ...f.config.dns,
      'other.example.com': { id: 'peer-dns', zoneId: 'zone' },
    },
  });
  await removeAssistant(f.paths, f.own.instance_id, f.dependencies);
  expect(f.resources.has('/zones/zone/dns_records/dns')).toBe(false);
  expect(f.resources.has('/zones/zone/dns_records/peer-dns')).toBe(true);
  expect((await readWebOperatorConfig(f.files.configFile))?.dns).toEqual({
    'other.example.com': { id: 'peer-dns', zoneId: 'zone' },
  });
});

it('retains exact cleanup evidence and the claim across remote failure, then resumes without recreating resources', async () => {
  const f = await fixture();
  f.fail('/zones/zone/dns_records/dns');
  await expect(removeAssistant(f.paths, f.own.instance_id, f.dependencies)).rejects.toMatchObject({
    resource: 'web',
  });
  const receipt = await readFile(f.paths.removalFile(f.own.instance_id), 'utf8');
  expect(receipt).toContain('own-app');
  expect(receipt).toContain('tunnel');
  expect(await exists(f.config.credentialFile)).toBe(true);
  expect((await readRegistry(f.paths)).instances[f.own.instance_id]?.exclusive_resource_claims.web).toBeDefined();
  f.fail();
  await removeAssistant(f.paths, f.own.instance_id, f.dependencies);
  expect(f.effects.filter((effect) => effect === 'DELETE /accounts/account/access/apps/own-app')).toHaveLength(1);
  expect(await exists(f.files.configFile)).toBe(true);
});

it('resumes interrupted assistant removal after web uninstall deletes the shared ownership record', async () => {
  const f = await fixture();
  await expect(
    removeAssistant(f.paths, f.own.instance_id, {
      ...f.dependencies,
      reporter: {
        emit: (event) => {
          if (event.type === 'step-completed' && event.step === 'remove_web')
            throw new Error('Removal interrupted before recording web completion');
        },
      },
    }),
  ).rejects.toThrow('Removal interrupted before recording web completion');
  const receipt = JSON.parse(await readFile(f.paths.removalFile(f.own.instance_id), 'utf8')) as unknown;
  expect(receipt).toHaveProperty('web.completed', expect.arrayContaining(['remote']));
  expect(receipt).not.toHaveProperty('completed.web');
  expect(await uninstallWebConnector(f.paths, f.dependencies)).toMatchObject({ outcome: 'removed' });
  expect(await exists(f.files.configFile)).toBe(false);
  const effects = [...f.effects];

  const outcome = await removeAssistant(f.paths, f.own.instance_id, {
    ...f.dependencies,
    fetch: async () => {
      throw new Error('Completed remote cleanup must not be repeated');
    },
  });
  expect(outcome.removed).toContain('web');
  expect(f.effects).toEqual(effects);
  expect(await exists(f.paths.removalFile(f.own.instance_id))).toBe(false);
  expect(await exists(f.paths.instanceRoot(f.own.instance_id))).toBe(false);
  expect((await readRegistry(f.paths)).instances[f.own.instance_id]).toBeUndefined();
});

it('preserves an incomplete cleanup receipt and claim when the shared ownership record is missing', async () => {
  const f = await fixture();
  f.fail('/zones/zone/dns_records/dns');
  await expect(removeAssistant(f.paths, f.own.instance_id, f.dependencies)).rejects.toMatchObject({ resource: 'web' });
  const receipt = JSON.parse(await readFile(f.paths.removalFile(f.own.instance_id), 'utf8')) as unknown;
  expect(receipt).toHaveProperty('web.completed', expect.not.arrayContaining(['remote']));
  await rm(f.files.configFile);
  const effects = [...f.effects];

  await expect(
    removeAssistant(f.paths, f.own.instance_id, {
      ...f.dependencies,
      fetch: async () => {
        throw new Error('Missing ownership must block before any provider request');
      },
    }),
  ).rejects.toMatchObject({ resource: 'web' });
  expect(f.effects).toEqual(effects);
  expect(await exists(f.paths.removalFile(f.own.instance_id))).toBe(true);
  expect((await readRegistry(f.paths)).instances[f.own.instance_id]?.exclusive_resource_claims.web).toEqual(
    f.own.exclusive_resource_claims.web,
  );
  expect(f.resources.has('/zones/zone/dns_records/dns')).toBe(true);
  expect(await exists(f.config.credentialFile)).toBe(true);
});

it('retains an uninstall receipt through credential deletion failure and retries local cleanup without another API credential', async () => {
  const f = await fixture();
  let spoiled = false;
  const send: typeof fetch = async (url, options) => {
    const response = await f.dependencies.fetch!(url, options);
    if (String(url).endsWith('/identity_providers/pin') && response.status === 404 && !spoiled) {
      spoiled = true;
      await chmod(f.config.credentialFile, 0o644);
    }
    return response;
  };
  expect(await uninstallWebConnector(f.paths, { ...f.dependencies, fetch: send })).toMatchObject({
    outcome: 'pending',
  });
  const receipt = await inspectWebUninstall(f.paths);
  expect(receipt?.shared.completed).toContain('remote');
  expect(receipt?.shared.ownership.tunnelId).toBe('tunnel');
  expect(await exists(f.files.tokenFile)).toBe(false);
  expect(await exists(f.files.configFile)).toBe(true);
  expect(await exists(f.config.credentialFile)).toBe(true);
  await chmod(f.config.credentialFile, 0o600);
  expect(
    await uninstallWebConnector(f.paths, {
      ...f.dependencies,
      fetch: async () => {
        throw new Error('Remote cleanup already settled');
      },
    }),
  ).toMatchObject({ outcome: 'removed' });
  expect(await exists(f.config.credentialFile)).toBe(false);
  expect(await exists(f.files.configFile)).toBe(false);
});

it('records an unproven creation and preserves its exact evidence after explicit artifact abandonment', async () => {
  const f = await fixture();
  const pending = {
    kind: 'dns' as const,
    key: randomUUID(),
    target: f.own.exclusive_resource_claims.web!.hostname,
    startedAt: new Date().toISOString(),
    resource: '/zones/zone/dns_records',
    fingerprint: 'b'.repeat(64),
    name: 'unproven-exact-host',
  };
  await writeWebOperatorConfig(f.files.configFile, { ...f.config, pending });
  const outcome = await removeAssistant(f.paths, f.own.instance_id, {
    ...f.dependencies,
    abandon: new Set(['web']),
  });
  expect(outcome.abandoned).toContainEqual({ resource: 'web', evidence: expect.stringContaining(pending.key) });
  const receipt = await readFile(f.paths.removalFile(f.own.instance_id), 'utf8');
  expect(receipt).toContain(pending.fingerprint);
  expect(receipt).toContain(pending.resource);
  expect(receipt).toContain('own-app');
  expect((await readRegistry(f.paths)).instances[f.own.instance_id]).toBeUndefined();
  expect(await exists(f.paths.instanceRoot(f.own.instance_id))).toBe(false);
  expect(await exists(f.files.configFile)).toBe(true);
  expect(await exists(f.config.credentialFile)).toBe(true);
  expect(f.effects.some((effect) => /DELETE.*(?:dns_records|cfd_tunnel)/u.test(effect))).toBe(false);
});

it('continues removal after the operator explicitly resolves the exact unproven creation in the native ownership record', async () => {
  const f = await fixture();
  const pending = {
    kind: 'dns' as const,
    key: randomUUID(),
    target: f.own.exclusive_resource_claims.web!.hostname,
    startedAt: new Date().toISOString(),
    resource: '/zones/zone/dns_records',
    fingerprint: 'b'.repeat(64),
  };
  await writeWebOperatorConfig(f.files.configFile, { ...f.config, pending });
  await expect(removeAssistant(f.paths, f.own.instance_id, f.dependencies)).rejects.toMatchObject({
    resource: 'web',
  });
  await writeWebOperatorConfig(f.files.configFile, {
    ...f.config,
    resolvedAttempts: [{ ...pending, resolution: 'operator_removed', resolvedAt: new Date().toISOString() }],
  });
  await removeAssistant(f.paths, f.own.instance_id, f.dependencies);
  expect(await exists(f.files.configFile)).toBe(true);
  expect((await readRegistry(f.paths)).instances[f.own.instance_id]).toBeUndefined();
});

it('keeps a pre-existing PIN and unrelated tunnel service when removing the last assistant', async () => {
  const f = await fixture();
  await writeWebOperatorConfig(f.files.configFile, { ...f.config, pin: { id: 'pin', owned: false } });
  f.ingress().config.ingress.unshift({ hostname: 'foreign.example.test', service: 'http://127.0.0.1:9191' });
  await removeAssistant(f.paths, f.own.instance_id, f.dependencies);
  expect(f.resources.has('/accounts/account/cfd_tunnel/tunnel')).toBe(true);
  expect(f.resources.has('/accounts/account/access/identity_providers/pin')).toBe(true);
  expect(f.ingress().config.ingress).toEqual([
    { hostname: 'foreign.example.test', service: 'http://127.0.0.1:9191' },
    { service: 'http_status:404' },
  ]);
  expect(await exists(f.config.credentialFile)).toBe(true);
  expect(f.effects.filter((effect) => effect.startsWith('DELETE'))).toEqual([
    'DELETE /accounts/account/access/apps/own-app',
    'DELETE /zones/zone/dns_records/dns',
  ]);
});

it('keeps a stopped connector receipt through a service failure and removes only its exact verified definition', async () => {
  const f = await fixture();
  const label = 'com.gws-ea.web.0123456789abcdef';
  const definitionFile = path.join(f.root, '.config/systemd/user', `${label}.service`);
  const connector = { manager: 'systemd-user' as const, label, definitionFile, homeDirectory: f.root };
  await writeWebOperatorConfig(f.files.configFile, { ...f.config, connector });
  await mkdir(path.dirname(definitionFile), { recursive: true, mode: 0o700 });
  await writePrivateTextFile(
    definitionFile,
    renderSystemdService({
      programArguments: [
        f.config.cloudflaredPath,
        'tunnel',
        '--no-autoupdate',
        'run',
        '--token-file',
        f.files.tokenFile,
      ],
      workingDirectory: f.files.root,
      environment: { HOME: f.root, PATH: '/usr/local/bin:/usr/bin:/bin' },
      standardOutputPath: path.join(f.files.root, 'connector.log'),
      standardErrorPath: path.join(f.files.root, 'connector.error.log'),
      wantedBy: 'default.target',
    }),
  );
  let fail = true;
  const observed: string[][] = [];
  const runCommand: NonNullable<RemovalDependencies['runCommand']> = async (command) => {
    observed.push([...command.args]);
    expect((await inspectWebUninstall(f.paths))?.shared.ownership.connector?.label).toBe(label);
    return {
      stdout: command.args.includes('show') ? `LoadState=loaded\nActiveState=${fail ? 'active' : 'inactive'}\n` : '',
      stderr: '',
      exitCode: command.args.includes('disable') && fail ? 1 : 0,
    };
  };
  expect(await uninstallWebConnector(f.paths, { ...f.dependencies, runCommand })).toMatchObject({ outcome: 'pending' });
  expect(await exists(definitionFile)).toBe(true);
  expect(f.resources.has('/accounts/account/cfd_tunnel/tunnel')).toBe(true);
  fail = false;
  expect(await uninstallWebConnector(f.paths, { ...f.dependencies, runCommand })).toMatchObject({ outcome: 'removed' });
  expect(await exists(definitionFile)).toBe(false);
  expect(observed).toContainEqual(['--user', 'disable', '--now', `${label}.service`]);
  expect(observed.at(-1)).toEqual(['--user', 'daemon-reload']);
});

it('fails honestly on unreadable operator ownership without releasing the namespace or erasing its state', async () => {
  const f = await fixture();
  await writePrivateTextFile(f.files.configFile, '{broken');
  await expect(removeAssistant(f.paths, f.own.instance_id, f.dependencies)).rejects.toMatchObject({
    resource: 'web',
  });
  expect((await readRegistry(f.paths)).instances[f.own.instance_id]?.exclusive_resource_claims.web).toBeDefined();
  expect(await readFile(f.files.configFile, 'utf8')).toBe('{broken');
  expect(await exists(f.paths.instanceRoot(f.own.instance_id))).toBe(true);
  expect(f.effects).toEqual(['host-stopped']);
});

it('removes an assistant with no artifact intent despite an unreadable optional operator config, preserving other owners', async () => {
  const f = await fixture();
  const id = randomUUID();
  await reserveInstance(f.paths, {
    instance_id: id,
    release_track: 'dogfood',
    source_remote: 'https://example.test/repo.git',
    deployed_commit: 'a'.repeat(40),
    allocated_ports: { onecli_app: 36000, onecli_gateway: 36001 },
    exclusive_resource_claims: {
      ...deriveGcpClaims(id),
      gcp_account: 'operator@example.test',
      workspace_email: 'unclaimed@example.test',
      onecli_project: `gws-ea-${id.replaceAll('-', '')}`,
    },
  });
  await writeInstanceMarker(f.paths, id);
  await writePrivateTextFile(f.files.configFile, '{broken');
  await removeAssistant(f.paths, id, f.dependencies);
  expect((await readRegistry(f.paths)).instances[f.own.instance_id]).toBeDefined();
  expect((await readRegistry(f.paths)).instances[id]).toBeUndefined();
  expect(await readFile(f.files.configFile, 'utf8')).toBe('{broken');
  expect(f.effects).toEqual([]);
});

async function launchdFixture() {
  const f = await fixture();
  const label = 'com.gws-ea.web.0123456789abcdef';
  const definitionFile = path.join(f.root, 'Library/LaunchAgents', `${label}.plist`);
  const connector = { manager: 'launchd' as const, label, definitionFile, homeDirectory: f.root };
  await writeWebOperatorConfig(f.files.configFile, { ...f.config, connector });
  await mkdir(path.dirname(definitionFile), { recursive: true, mode: 0o700 });
  await writePrivateTextFile(
    definitionFile,
    renderLaunchdService({
      label,
      programArguments: [
        f.config.cloudflaredPath,
        'tunnel',
        '--no-autoupdate',
        'run',
        '--token-file',
        f.files.tokenFile,
      ],
      workingDirectory: f.files.root,
      environment: { HOME: f.root, PATH: '/usr/local/bin:/usr/bin:/bin' },
      standardOutputPath: path.join(f.files.root, 'connector.log'),
      standardErrorPath: path.join(f.files.root, 'connector.error.log'),
    }),
  );
  return { f, label, definitionFile };
}

it.each([true, false])(
  'uninstalls the exact owned launchd connector and credentials (initially running: %s)',
  async (initiallyRunning) => {
    const { f, label, definitionFile } = await launchdFixture();
    let running = initiallyRunning;
    const commands: string[][] = [];
    expect(
      await uninstallWebConnector(f.paths, {
        ...f.dependencies,
        runCommand: async (command) => {
          commands.push([...command.args]);
          if (command.args[0] === 'bootout') running = false;
          return {
            stdout: '',
            stderr: '',
            exitCode: command.args[0] === 'print' && !running ? 113 : 0,
          };
        },
      }),
    ).toMatchObject({ outcome: 'removed' });
    const exact = `gui/${process.getuid?.()}/${label}`;
    expect(commands).toEqual(
      initiallyRunning
        ? [
            ['print', exact],
            ['bootout', exact],
            ['print', exact],
          ]
        : [['print', exact]],
    );
    expect(await exists(definitionFile)).toBe(false);
    expect(await exists(f.config.credentialFile)).toBe(false);
  },
);

it('preserves an unknown receipt schema containing exact artifact IDs instead of overwriting its evidence', async () => {
  const f = await fixture();
  f.fail('/zones/zone/dns_records/dns');
  await expect(removeAssistant(f.paths, f.own.instance_id, f.dependencies)).rejects.toMatchObject({
    resource: 'web',
  });
  const file = f.paths.removalFile(f.own.instance_id);
  const receipt = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  await writePrivateTextFile(file, JSON.stringify({ ...receipt, schema_version: 999 }));
  const before = await readFile(file);
  const count = f.effects.length;
  await expect(removeAssistant(f.paths, f.own.instance_id, f.dependencies)).rejects.toMatchObject({
    code: 'removal_receipt_unreadable',
  });
  expect(await readFile(file)).toEqual(before);
  expect(f.effects).toHaveLength(count);
});

it('publishes artifact abandonment and its exact durable receipt through the native JSON removal contract', async () => {
  const f = await fixture();
  f.fail('/zones/zone/dns_records/dns');
  const output: string[] = [];
  expect(
    await runCli(['remove', '--id', f.own.instance_id, '--yes', '--abandon', 'web', '--json'], {
      paths: f.paths,
      stdout: (line) => output.push(line),
      stderr: () => undefined,
      removeAssistant: (paths, id, options) => removeAssistant(paths, id, { ...f.dependencies, ...options }),
    }),
  ).toBe(0);
  const result: unknown = JSON.parse(output.join('\n'));
  expectResultContract('remove', result);
  expect(result).toHaveProperty('data.removal.abandoned', [
    {
      resource: 'web',
      evidence: expect.stringContaining(`Removal receipt: ${f.paths.removalFile(f.own.instance_id)}`),
    },
  ]);
  expect(await exists(f.paths.removalFile(f.own.instance_id))).toBe(true);
});

it.each([112, 5])(
  'keeps connector files when launchd print fails with exit %s despite absent-job wording',
  async (exitCode) => {
    const { f, definitionFile } = await launchdFixture();
    expect(
      await uninstallWebConnector(f.paths, {
        ...f.dependencies,
        runCommand: async () => ({ stdout: '', stderr: 'Could not find service', exitCode }),
      }),
    ).toMatchObject({ outcome: 'pending' });
    expect(await exists(definitionFile)).toBe(true);
    expect(await exists(f.config.credentialFile)).toBe(true);
    expect(await exists(f.files.tokenFile)).toBe(true);
  },
);
