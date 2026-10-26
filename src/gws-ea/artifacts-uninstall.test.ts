import { randomBytes, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { processLock } from '../community-portal/process-lock.js';
import { readArtifactsPolicy } from '../modules/gws-ea-artifacts/policy.js';
import {
  artifactsIngress,
  artifactsOperatorFiles,
  readArtifactsOperatorConfig,
  writeArtifactsOperatorConfig,
  type ArtifactsOperatorConfig,
} from './artifacts-cloudflare.js';
import {
  artifactsConnectorInstalled,
  installArtifactsConnector,
  type ArtifactsCapabilityDependencies,
} from './artifacts-connector.js';
import { deriveGcpClaims } from './gcp-identity.js';
import { reserveInstance } from './journal.js';
import { resolveControlPlanePaths } from './paths.js';
import { claimInstanceArtifacts, readRegistry } from './registry.js';
import { writePrivateTextFile } from './secrets.js';
import {
  artifactsUninstallFile,
  inspectArtifactsUninstall,
  uninstallArtifactsConnector,
} from './artifacts-uninstall.js';
import type { InstanceReservationInput } from './types.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const exists = (file: string): Promise<boolean> =>
  access(file).then(
    () => true,
    () => false,
  );

async function fixture(assistantCount = 2, ownedPin = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'artifacts-uninstall-'));
  roots.push(root);
  const paths = resolveControlPlanePaths({
    configRoot: path.join(root, 'config'),
    stateRoot: path.join(root, 'state'),
  });
  const files = artifactsOperatorFiles(paths);
  await mkdir(files.root, { recursive: true, mode: 0o700 });
  const assistants: Record<string, ArtifactsOperatorConfig['assistants'][string]> = {};
  const policyFiles: string[] = [];
  const contentFiles: string[] = [];
  for (let i = 0; i < assistantCount; i++) {
    const id = randomUUID();
    const input: InstanceReservationInput = {
      instance_id: id,
      release_track: 'dogfood',
      source_remote: 'https://example.test/repo.git',
      deployed_commit: 'a'.repeat(40),
      allocated_ports: { onecli_app: 34000 + i * 10, onecli_gateway: 34001 + i * 10 },
      exclusive_resource_claims: {
        ...deriveGcpClaims(id),
        gcp_account: 'operator@example.test',
        workspace_email: `assistant${i}@example.test`,
        onecli_project: `gws-ea-${id.replaceAll('-', '')}`,
      },
    };
    await reserveInstance(paths, input);
    const reservation = await claimInstanceArtifacts(paths, id, {
      hostname: 'views.example.com',
      path_prefix: `/assistant${i}`,
      listen_port: 34002 + i * 10,
    });
    const claim = reservation.exclusive_resource_claims.artifacts;
    if (!claim) throw new Error('Missing fixture namespace');
    assistants[id] = {
      claim,
      applicationId: `app${i}`,
      policyId: `policy${i}`,
      aud: `aud${i}`,
      enabled: true,
      publicationReady: true,
    };
    const policyFile = path.join(paths.instanceRoot(id), 'artifacts/policy.json');
    const contentFile = path.join(paths.instanceRoot(id), 'artifacts/content.html');
    policyFiles.push(policyFile);
    contentFiles.push(contentFile);
    await mkdir(path.dirname(policyFile), { recursive: true, mode: 0o700 });
    await writePrivateTextFile(
      policyFile,
      JSON.stringify({
        schemaVersion: 1,
        enabled: true,
        hostname: claim.hostname,
        pathPrefix: claim.path_prefix,
        listenPort: claim.listen_port,
        accessIssuer: 'https://team.cloudflareaccess.com',
        accessAud: `aud${i}`,
        cloudflare: { accountId: 'account', applicationId: `app${i}`, operatorConfigFile: files.configFile },
      }),
    );
    await writePrivateTextFile(contentFile, `saved artifact ${i}`);
  }
  const config: ArtifactsOperatorConfig = {
    schemaVersion: 1,
    accountId: 'account',
    teamName: 'team',
    zoneId: 'zone',
    hostname: 'views.example.com',
    credentialFile: path.join(files.root, 'management-token'),
    cloudflaredPath: '/usr/local/bin/cloudflared',
    tunnelId: 'tunnel',
    pin: { id: 'pin', owned: ownedPin },
    dns: { 'views.example.com': { id: 'dns', zoneId: 'zone' } },
    assistants,
  };
  await writeArtifactsOperatorConfig(files.configFile, config);
  await writePrivateTextFile(config.credentialFile, randomBytes(32).toString('hex'));
  await writePrivateTextFile(files.tokenFile, randomBytes(32).toString('hex'));
  const resources = new Map<string, unknown>([
    ...Object.values(assistants).map((assistant): [string, unknown] => [
      `/accounts/account/access/apps/${assistant.applicationId}`,
      { id: assistant.applicationId },
    ]),
    ['/accounts/account/cfd_tunnel/tunnel', { id: 'tunnel', config_src: 'cloudflare' }],
    ['/zones/zone/dns_records/dns', { id: 'dns' }],
    ['/accounts/account/access/identity_providers/pin', { id: 'pin', type: 'onetimepin' }],
  ]);
  let ingress: { config: { ingress: readonly unknown[] } } = {
    config: {
      ingress: [
        ...Object.values(assistants).map(({ claim }) => artifactsIngress(claim)),
        { service: 'http_status:404' },
      ],
    },
  };
  let failDelete: string | undefined;
  const mutations: string[] = [];
  const send: typeof fetch = async (url, options) => {
    const resource = new URL(String(url)).pathname.replace('/client/v4', '');
    const method = options?.method ?? 'GET';
    if (method !== 'GET') {
      // Provider effects must be fenced by durable ownership and every origin being closed.
      expect((await inspectArtifactsUninstall(paths))?.stopped).toBe(true);
      for (const policyFile of policyFiles) expect((await readArtifactsPolicy(policyFile)).enabled).toBe(false);
      mutations.push(`${method} ${resource}`);
    }
    if (resource.endsWith('/configurations')) {
      if (method === 'PUT') ingress = JSON.parse(String(options?.body)) as typeof ingress;
      return Response.json({ success: true, result: ingress });
    }
    if (method === 'DELETE') {
      if (resource === failDelete) return Response.json({ success: false }, { status: 403 });
      resources.delete(resource);
      return Response.json({ success: true, result: {} });
    }
    const found = resources.get(resource);
    return found ? Response.json({ success: true, result: found }) : Response.json({ success: false }, { status: 404 });
  };
  const dependencies: ArtifactsCapabilityDependencies = {
    fetch: send,
    runCommand: async () => {
      throw new Error('Unexpected service manager');
    },
  };
  return {
    paths,
    files,
    config,
    policyFiles,
    contentFiles,
    resources,
    mutations,
    dependencies,
    fail: (resource?: string) => {
      failDelete = resource;
    },
    unrelatedIngress: () => {
      ingress = {
        config: {
          ingress: [...ingress.config.ingress, { hostname: 'unrelated.example.com', service: 'http://127.0.0.1:5555' }],
        },
      };
    },
  };
}

it('closes every assistant before remote effects, settles claims and removes shared resources last while retaining content', async () => {
  const f = await fixture();
  const result = await uninstallArtifactsConnector(f.paths, f.dependencies);
  expect(result).toMatchObject({ outcome: 'removed', installed: false, changed: true, receipt_file: null });
  expect(f.resources.size).toBe(0);
  const lastApp = Math.max(...f.mutations.map((entry, i) => (entry.includes('/access/apps/') ? i : -1)));
  const tunnel = f.mutations.indexOf('DELETE /accounts/account/cfd_tunnel/tunnel');
  expect(tunnel).toBeGreaterThan(lastApp);
  expect(await readArtifactsOperatorConfig(f.files.configFile)).toBeUndefined();
  expect(await inspectArtifactsUninstall(f.paths)).toBeUndefined();
  expect(await exists(f.config.credentialFile)).toBe(false);
  expect(await exists(f.files.tokenFile)).toBe(false);
  for (const content of f.contentFiles) expect(await readFile(content, 'utf8')).toMatch(/^saved artifact \d$/u);
  for (const reservation of Object.values((await readRegistry(f.paths)).instances))
    expect(reservation.exclusive_resource_claims.artifacts).toBeUndefined();
  expect(await uninstallArtifactsConnector(f.paths, f.dependencies)).toMatchObject({
    outcome: 'removed',
    changed: false,
  });
  const id = Object.keys(f.config.assistants)[0];
  const next = await claimInstanceArtifacts(f.paths, id, {
    hostname: 'new.example.com',
    path_prefix: '/renamed',
    listen_port: 45000,
  });
  expect(next.exclusive_resource_claims.artifacts?.hostname).toBe('new.example.com');
});

it('journals interruption and resumes only unsettled resources while fencing all provisioning', async () => {
  const f = await fixture();
  const ids = Object.keys(f.config.assistants).sort();
  const lastApp = f.config.assistants[ids[1]].applicationId;
  f.fail(`/accounts/account/access/apps/${lastApp}`);
  expect(await uninstallArtifactsConnector(f.paths, f.dependencies)).toMatchObject({
    outcome: 'pending',
    installed: false,
    changed: true,
  });
  const receipt = await inspectArtifactsUninstall(f.paths);
  expect(receipt?.completed_assistant_ids).toEqual([ids[0]]);
  expect(receipt?.reason).toContain('Cloudflare');
  expect(await artifactsConnectorInstalled(f.paths)).toBe(false);
  expect(await exists(f.config.credentialFile)).toBe(true);
  const before = [...f.mutations];
  await expect(installArtifactsConnector(f.paths, {}, f.dependencies)).rejects.toMatchObject({
    code: 'artifacts_uninstall_incomplete',
  });
  expect(f.mutations).toEqual(before);
  f.fail();
  expect(await uninstallArtifactsConnector(f.paths, f.dependencies)).toMatchObject({ outcome: 'removed' });
  const firstApp = f.config.assistants[ids[0]].applicationId;
  expect(f.mutations.filter((entry) => entry === `DELETE /accounts/account/access/apps/${firstApp}`)).toHaveLength(1);
  expect(await inspectArtifactsUninstall(f.paths)).toBeUndefined();
});

it('retains an external PIN while removing only recorded owned resources', async () => {
  const f = await fixture(1, false);
  expect(await uninstallArtifactsConnector(f.paths, f.dependencies)).toMatchObject({ outcome: 'removed' });
  expect([...f.resources.keys()]).toEqual(['/accounts/account/access/identity_providers/pin']);
  expect(f.mutations).not.toContain('DELETE /accounts/account/access/identity_providers/pin');
});

it('retains an owned tunnel with unrelated routes and keeps local credentials for an exact retry', async () => {
  const f = await fixture(1);
  f.unrelatedIngress();
  expect(await uninstallArtifactsConnector(f.paths, f.dependencies)).toMatchObject({ outcome: 'pending' });
  expect((await inspectArtifactsUninstall(f.paths))?.reason).toContain('unrelated service');
  expect(await exists(f.files.tokenFile)).toBe(true);
  expect(await exists(f.config.credentialFile)).toBe(true);
  expect(f.mutations).not.toContain('DELETE /accounts/account/cfd_tunnel/tunnel');
});

it('refuses a busy assistant without opening an uninstall receipt or changing any policy', async () => {
  const f = await fixture(1);
  const id = Object.keys(f.config.assistants)[0];
  const release = await processLock(f.paths.instanceLock(id));
  if (!release) throw new Error('Could not acquire fixture instance lock');
  try {
    await expect(uninstallArtifactsConnector(f.paths, f.dependencies)).rejects.toMatchObject({ code: 'instance_busy' });
    expect(await inspectArtifactsUninstall(f.paths)).toBeUndefined();
    expect((await readArtifactsPolicy(f.policyFiles[0])).enabled).toBe(true);
    expect(f.mutations).toEqual([]);
  } finally {
    release();
  }
});

it('fails closed on unreadable ownership and malformed receipts instead of reporting removed', async () => {
  const f = await fixture(1);
  await rm(f.files.configFile);
  await expect(uninstallArtifactsConnector(f.paths, f.dependencies)).rejects.toMatchObject({
    code: 'artifacts_owner_missing',
  });
  const receiptFile = artifactsUninstallFile(f.paths);
  await writePrivateTextFile(receiptFile, JSON.stringify({ schemaVersion: 1 }));
  await expect(inspectArtifactsUninstall(f.paths)).rejects.toMatchObject({ code: 'artifacts_uninstall_invalid' });
  expect(f.mutations).toEqual([]);
});

async function claimWithoutResources(f: Awaited<ReturnType<typeof fixture>>) {
  const id = randomUUID();
  await reserveInstance(f.paths, {
    instance_id: id,
    release_track: 'dogfood',
    source_remote: 'https://example.test/repo.git',
    deployed_commit: 'a'.repeat(40),
    allocated_ports: { onecli_app: 48000, onecli_gateway: 48001 },
    exclusive_resource_claims: {
      ...deriveGcpClaims(id),
      gcp_account: 'operator@example.test',
      workspace_email: 'unprovisioned@example.test',
      onecli_project: `gws-ea-${id.replaceAll('-', '')}`,
    },
  });
  await claimInstanceArtifacts(f.paths, id, {
    hostname: 'views.example.com',
    path_prefix: '/unprovisioned',
    listen_port: 48002,
  });
  return id;
}

it('uninstalls a host with a namespace claim but no assistant remote resource record', async () => {
  const f = await fixture(0);
  const id = await claimWithoutResources(f);
  const result = await uninstallArtifactsConnector(f.paths, f.dependencies);
  expect(result).toMatchObject({ outcome: 'removed', changed: true });
  expect((await readRegistry(f.paths)).instances[id].exclusive_resource_claims.artifacts).toBeUndefined();
  expect(f.resources.size).toBe(0);
  expect(await readArtifactsOperatorConfig(f.files.configFile)).toBeUndefined();
  expect(await inspectArtifactsUninstall(f.paths)).toBeUndefined();
});

it('releases a claim with no configuration or local resource policy without contacting Cloudflare', async () => {
  const f = await fixture(0);
  const id = await claimWithoutResources(f);
  await rm(f.files.configFile);
  const result = await uninstallArtifactsConnector(f.paths, {
    fetch: async () => {
      throw new Error('A claim alone owns no remote resources');
    },
  });
  expect(result).toMatchObject({ outcome: 'removed', changed: true });
  expect((await readRegistry(f.paths)).instances[id].exclusive_resource_claims.artifacts).toBeUndefined();
});

it('releases a new bare claim beside the disabled policy retained by a completed uninstall', async () => {
  const f = await fixture(1);
  const id = Object.keys(f.config.assistants)[0];
  const claim = f.config.assistants[id].claim;
  expect(await uninstallArtifactsConnector(f.paths, f.dependencies)).toMatchObject({ outcome: 'removed' });
  const stalePolicy = await readFile(f.policyFiles[0], 'utf8');
  expect((await readArtifactsPolicy(f.policyFiles[0])).enabled).toBe(false);
  await claimInstanceArtifacts(f.paths, id, claim);
  const result = await uninstallArtifactsConnector(f.paths, {
    fetch: async () => {
      throw new Error('The completed uninstall already deleted its remote resources');
    },
  });
  expect(result).toMatchObject({ outcome: 'removed', changed: true });
  expect((await readRegistry(f.paths)).instances[id].exclusive_resource_claims.artifacts).toBeUndefined();
  expect(await readFile(f.policyFiles[0], 'utf8')).toBe(stalePolicy);
  expect(await inspectArtifactsUninstall(f.paths)).toBeUndefined();
});

it('keeps an unproven application creation fenced after releasing its resource-free namespace claim', async () => {
  const f = await fixture(0);
  const id = await claimWithoutResources(f);
  const pending = {
    kind: 'application' as const,
    key: randomUUID(),
    target: id,
    startedAt: new Date().toISOString(),
    resource: '/accounts/account/access/apps',
    fingerprint: 'b'.repeat(64),
  };
  await writeArtifactsOperatorConfig(f.files.configFile, { ...f.config, pending });
  expect(await uninstallArtifactsConnector(f.paths, f.dependencies)).toMatchObject({ outcome: 'pending' });
  expect((await readRegistry(f.paths)).instances[id].exclusive_resource_claims.artifacts).toBeUndefined();
  expect((await inspectArtifactsUninstall(f.paths))?.shared.ownership.pending).toEqual(pending);
  expect(await exists(f.config.credentialFile)).toBe(true);
  await expect(installArtifactsConnector(f.paths, {}, f.dependencies)).rejects.toMatchObject({
    code: 'artifacts_uninstall_incomplete',
  });
});

it('returns operator token revocation and original credential-file cleanup after uninstall completes', async () => {
  const f = await fixture(1);
  const result = await uninstallArtifactsConnector(f.paths, f.dependencies);
  expect(result).toMatchObject({ outcome: 'removed', operator_actions: [expect.stringContaining('Revoke')] });
  expect(result.operator_actions.join(' ')).toContain('Cloudflare');
  expect(result.operator_actions.join(' ')).toContain('--credential-file');
  expect(result.operator_actions.join(' ')).toContain('delete');
  expect(await exists(f.config.credentialFile)).toBe(false);
});
