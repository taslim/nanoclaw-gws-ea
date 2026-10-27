import { randomBytes, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { processLock } from '../community-portal/process-lock.js';
import { readWebPolicy } from '../modules/gws-ea-web/policy.js';
import {
  webIngress,
  webOperatorFiles,
  readWebOperatorConfig,
  writeWebOperatorConfig,
  type WebOperatorConfig,
} from './web-cloudflare.js';
import { webConnectorInstalled, installWebConnector, type WebCapabilityDependencies } from './web-connector.js';
import { deriveGcpClaims } from './gcp-identity.js';
import { reserveInstance } from './journal.js';
import { resolveControlPlanePaths } from './paths.js';
import { claimInstanceWeb, readRegistry } from './registry.js';
import { writePrivateTextFile } from './secrets.js';
import { webUninstallFile, inspectWebUninstall, uninstallWebConnector } from './web-uninstall.js';
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
  const root = await mkdtemp(path.join(os.tmpdir(), 'web-uninstall-'));
  roots.push(root);
  const paths = resolveControlPlanePaths({
    configRoot: path.join(root, 'config'),
    stateRoot: path.join(root, 'state'),
  });
  const files = webOperatorFiles(paths);
  await mkdir(files.root, { recursive: true, mode: 0o700 });
  const assistants: Record<string, WebOperatorConfig['assistants'][string]> = {};
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
    const reservation = await claimInstanceWeb(paths, id, {
      hostname: `assistant${i}.example.com`,
      listen_port: 34002 + i * 10,
    });
    const claim = reservation.exclusive_resource_claims.web;
    if (!claim) throw new Error('Missing fixture namespace');
    assistants[id] = {
      claim,
      applicationId: `app${i}`,
      policyId: `policy${i}`,
      aud: `aud${i}`,
      enabled: true,
      publicationReady: true,
    };
    const policyFile = path.join(paths.instanceRoot(id), 'web/policy.json');
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
        listenPort: claim.listen_port,
        accessIssuer: 'https://team.cloudflareaccess.com',
        accessAud: `aud${i}`,
        cloudflare: { accountId: 'account', applicationId: `app${i}`, operatorConfigFile: files.configFile },
      }),
    );
    await mkdir(path.dirname(contentFile), { recursive: true, mode: 0o700 });
    await writePrivateTextFile(contentFile, `saved artifact ${i}`);
  }
  const config: WebOperatorConfig = {
    schemaVersion: 1,
    accountId: 'account',
    teamName: 'team',
    zoneId: 'zone',
    zoneApex: 'example.com',
    credentialFile: path.join(files.root, 'management-token'),
    cloudflaredPath: '/usr/local/bin/cloudflared',
    tunnelId: 'tunnel',
    pin: { id: 'pin', owned: ownedPin },
    dns: assistantCount
      ? Object.fromEntries(
          Object.values(assistants).map(({ claim }, i) => [claim.hostname, { id: `dns${i}`, zoneId: 'zone' }]),
        )
      : { 'views.example.com': { id: 'dns', zoneId: 'zone' } },
    assistants,
  };
  await writeWebOperatorConfig(files.configFile, config);
  await writePrivateTextFile(config.credentialFile, randomBytes(32).toString('hex'));
  await writePrivateTextFile(files.tokenFile, randomBytes(32).toString('hex'));
  const resources = new Map<string, unknown>([
    ...Object.values(assistants).map((assistant): [string, unknown] => [
      `/accounts/account/access/apps/${assistant.applicationId}`,
      { id: assistant.applicationId },
    ]),
    ['/accounts/account/cfd_tunnel/tunnel', { id: 'tunnel', config_src: 'cloudflare' }],
    ...Object.values(config.dns).map((dns): [string, unknown] => [`/zones/zone/dns_records/${dns.id}`, { id: dns.id }]),
    ['/accounts/account/access/identity_providers/pin', { id: 'pin', type: 'onetimepin' }],
  ]);
  let ingress: { config: { ingress: readonly unknown[] } } = {
    config: {
      ingress: [...Object.values(assistants).map(({ claim }) => webIngress(claim)), { service: 'http_status:404' }],
    },
  };
  let failDelete: string | undefined;
  const mutations: string[] = [];
  const send: typeof fetch = async (url, options) => {
    const resource = new URL(String(url)).pathname.replace('/client/v4', '');
    const method = options?.method ?? 'GET';
    if (method !== 'GET') {
      // Provider effects must be fenced by durable ownership and every origin being closed.
      expect((await inspectWebUninstall(paths))?.stopped).toBe(true);
      for (const policyFile of policyFiles) expect((await readWebPolicy(policyFile)).enabled).toBe(false);
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
  const dependencies: WebCapabilityDependencies = {
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
  const result = await uninstallWebConnector(f.paths, f.dependencies);
  expect(result).toMatchObject({ outcome: 'removed', installed: false, changed: true, receipt_file: null });
  expect(f.resources.size).toBe(0);
  const lastApp = Math.max(...f.mutations.map((entry, i) => (entry.includes('/access/apps/') ? i : -1)));
  const tunnel = f.mutations.indexOf('DELETE /accounts/account/cfd_tunnel/tunnel');
  expect(tunnel).toBeGreaterThan(lastApp);
  expect(await readWebOperatorConfig(f.files.configFile)).toBeUndefined();
  expect(await inspectWebUninstall(f.paths)).toBeUndefined();
  expect(await exists(f.config.credentialFile)).toBe(false);
  expect(await exists(f.files.tokenFile)).toBe(false);
  for (const content of f.contentFiles) expect(await readFile(content, 'utf8')).toMatch(/^saved artifact \d$/u);
  for (const reservation of Object.values((await readRegistry(f.paths)).instances))
    expect(reservation.exclusive_resource_claims.web).toBeUndefined();
  expect(await uninstallWebConnector(f.paths, f.dependencies)).toMatchObject({
    outcome: 'removed',
    changed: false,
  });
  const id = Object.keys(f.config.assistants)[0];
  const next = await claimInstanceWeb(f.paths, id, {
    hostname: 'new.example.com',
    listen_port: 45000,
  });
  expect(next.exclusive_resource_claims.web?.hostname).toBe('new.example.com');
});

it('journals interruption and resumes only unsettled resources while fencing all provisioning', async () => {
  const f = await fixture();
  const ids = Object.keys(f.config.assistants).sort();
  const lastApp = f.config.assistants[ids[1]].applicationId;
  f.fail(`/accounts/account/access/apps/${lastApp}`);
  expect(await uninstallWebConnector(f.paths, f.dependencies)).toMatchObject({
    outcome: 'pending',
    installed: false,
    changed: true,
  });
  const receipt = await inspectWebUninstall(f.paths);
  expect(receipt?.completed_assistant_ids).toEqual([ids[0]]);
  expect(receipt?.reason).toContain('Cloudflare');
  expect(await webConnectorInstalled(f.paths)).toBe(false);
  expect(await exists(f.config.credentialFile)).toBe(true);
  const before = [...f.mutations];
  await expect(installWebConnector(f.paths, {}, f.dependencies)).rejects.toMatchObject({
    code: 'web_uninstall_incomplete',
  });
  expect(f.mutations).toEqual(before);
  f.fail();
  expect(await uninstallWebConnector(f.paths, f.dependencies)).toMatchObject({ outcome: 'removed' });
  const firstApp = f.config.assistants[ids[0]].applicationId;
  expect(f.mutations.filter((entry) => entry === `DELETE /accounts/account/access/apps/${firstApp}`)).toHaveLength(1);
  expect(await inspectWebUninstall(f.paths)).toBeUndefined();
});

it('retains an external PIN while removing only recorded owned resources', async () => {
  const f = await fixture(1, false);
  expect(await uninstallWebConnector(f.paths, f.dependencies)).toMatchObject({ outcome: 'removed' });
  expect([...f.resources.keys()]).toEqual(['/accounts/account/access/identity_providers/pin']);
  expect(f.mutations).not.toContain('DELETE /accounts/account/access/identity_providers/pin');
});

it('retains an owned tunnel with unrelated routes and keeps local credentials for an exact retry', async () => {
  const f = await fixture(1);
  f.unrelatedIngress();
  expect(await uninstallWebConnector(f.paths, f.dependencies)).toMatchObject({ outcome: 'pending' });
  expect((await inspectWebUninstall(f.paths))?.reason).toContain('unrelated service');
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
    await expect(uninstallWebConnector(f.paths, f.dependencies)).rejects.toMatchObject({ code: 'instance_busy' });
    expect(await inspectWebUninstall(f.paths)).toBeUndefined();
    expect((await readWebPolicy(f.policyFiles[0])).enabled).toBe(true);
    expect(f.mutations).toEqual([]);
  } finally {
    release();
  }
});

it('fails closed on unreadable ownership and malformed receipts instead of reporting removed', async () => {
  const f = await fixture(1);
  await rm(f.files.configFile);
  await expect(uninstallWebConnector(f.paths, f.dependencies)).rejects.toMatchObject({
    code: 'web_owner_missing',
  });
  const receiptFile = webUninstallFile(f.paths);
  await writePrivateTextFile(receiptFile, JSON.stringify({ schemaVersion: 1 }));
  await expect(inspectWebUninstall(f.paths)).rejects.toMatchObject({ code: 'web_uninstall_invalid' });
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
  await claimInstanceWeb(f.paths, id, {
    hostname: 'views.example.com',
    listen_port: 48002,
  });
  return id;
}

it('uninstalls a host with a namespace claim but no assistant remote resource record', async () => {
  const f = await fixture(0);
  const id = await claimWithoutResources(f);
  const result = await uninstallWebConnector(f.paths, f.dependencies);
  expect(result).toMatchObject({ outcome: 'removed', changed: true });
  expect((await readRegistry(f.paths)).instances[id].exclusive_resource_claims.web).toBeUndefined();
  expect(f.resources.size).toBe(0);
  expect(await readWebOperatorConfig(f.files.configFile)).toBeUndefined();
  expect(await inspectWebUninstall(f.paths)).toBeUndefined();
});

it('retains a partial assistant claim until its recorded DNS cleanup settles', async () => {
  const f = await fixture(0);
  const id = await claimWithoutResources(f);
  f.fail('/zones/zone/dns_records/dns');
  expect(await uninstallWebConnector(f.paths, f.dependencies)).toMatchObject({ outcome: 'pending' });
  expect((await readRegistry(f.paths)).instances[id].exclusive_resource_claims.web).toEqual({
    hostname: 'views.example.com',
    listen_port: 48002,
  });
  const receipt = await inspectWebUninstall(f.paths);
  expect(receipt?.completed_assistant_ids).toEqual([]);
  expect(receipt?.assistants[id].ownership.assistants[id]).toEqual({
    claim: { hostname: 'views.example.com', listen_port: 48002 },
    enabled: false,
  });
  expect(f.mutations).not.toContain('DELETE /accounts/account/cfd_tunnel/tunnel');
  f.fail();
  expect(await uninstallWebConnector(f.paths, f.dependencies)).toMatchObject({ outcome: 'removed' });
  expect((await readRegistry(f.paths)).instances[id].exclusive_resource_claims.web).toBeUndefined();
  expect(f.resources.size).toBe(0);
  expect(await inspectWebUninstall(f.paths)).toBeUndefined();
});

it('retains a partial assistant claim and exact pending DNS attempt until the operator resolves it', async () => {
  const f = await fixture(0);
  const id = await claimWithoutResources(f);
  const pending = {
    kind: 'dns' as const,
    key: randomUUID(),
    target: 'views.example.com',
    startedAt: new Date().toISOString(),
    resource: '/zones/zone/dns_records',
    fingerprint: 'b'.repeat(64),
  };
  await writeWebOperatorConfig(f.files.configFile, { ...f.config, dns: {}, pending });
  expect(await uninstallWebConnector(f.paths, f.dependencies)).toMatchObject({ outcome: 'pending' });
  expect((await readRegistry(f.paths)).instances[id].exclusive_resource_claims.web?.hostname).toBe('views.example.com');
  const receipt = await inspectWebUninstall(f.paths);
  expect(receipt?.assistants[id].ownership.pending).toEqual(pending);
  expect(receipt?.assistants[id].ownership.assistants[id]).toEqual({
    claim: { hostname: 'views.example.com', listen_port: 48002 },
    enabled: false,
  });
  expect(f.mutations.some((effect) => effect.startsWith('DELETE'))).toBe(false);
  // The operator removes the possible remote creation before acknowledging its exact journal entry.
  f.resources.delete('/zones/zone/dns_records/dns');
  await writeWebOperatorConfig(f.files.configFile, {
    ...f.config,
    dns: {},
    resolvedAttempts: [
      {
        ...pending,
        resolution: 'operator_removed',
        resolvedAt: new Date().toISOString(),
      },
    ],
  });
  expect(await uninstallWebConnector(f.paths, f.dependencies)).toMatchObject({ outcome: 'removed' });
  expect((await readRegistry(f.paths)).instances[id].exclusive_resource_claims.web).toBeUndefined();
  expect(f.resources.size).toBe(0);
  expect(await inspectWebUninstall(f.paths)).toBeUndefined();
});

it('releases a claim with no configuration or local resource policy without contacting Cloudflare', async () => {
  const f = await fixture(0);
  const id = await claimWithoutResources(f);
  await rm(f.files.configFile);
  const result = await uninstallWebConnector(f.paths, {
    fetch: async () => {
      throw new Error('A claim alone owns no remote resources');
    },
  });
  expect(result).toMatchObject({ outcome: 'removed', changed: true });
  expect((await readRegistry(f.paths)).instances[id].exclusive_resource_claims.web).toBeUndefined();
});

it('releases a new bare claim beside the disabled policy retained by a completed uninstall', async () => {
  const f = await fixture(1);
  const id = Object.keys(f.config.assistants)[0];
  const claim = f.config.assistants[id].claim;
  expect(await uninstallWebConnector(f.paths, f.dependencies)).toMatchObject({ outcome: 'removed' });
  const stalePolicy = await readFile(f.policyFiles[0], 'utf8');
  expect((await readWebPolicy(f.policyFiles[0])).enabled).toBe(false);
  await claimInstanceWeb(f.paths, id, claim);
  const result = await uninstallWebConnector(f.paths, {
    fetch: async () => {
      throw new Error('The completed uninstall already deleted its remote resources');
    },
  });
  expect(result).toMatchObject({ outcome: 'removed', changed: true });
  expect((await readRegistry(f.paths)).instances[id].exclusive_resource_claims.web).toBeUndefined();
  expect(await readFile(f.policyFiles[0], 'utf8')).toBe(stalePolicy);
  expect(await inspectWebUninstall(f.paths)).toBeUndefined();
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
  await writeWebOperatorConfig(f.files.configFile, { ...f.config, dns: {}, pending });
  expect(await uninstallWebConnector(f.paths, f.dependencies)).toMatchObject({ outcome: 'pending' });
  expect((await readRegistry(f.paths)).instances[id].exclusive_resource_claims.web).toBeUndefined();
  expect((await inspectWebUninstall(f.paths))?.shared.ownership.pending).toEqual(pending);
  expect(await exists(f.config.credentialFile)).toBe(true);
  await expect(installWebConnector(f.paths, {}, f.dependencies)).rejects.toMatchObject({
    code: 'web_uninstall_incomplete',
  });
});

it('returns operator token revocation and original credential-file cleanup after uninstall completes', async () => {
  const f = await fixture(1);
  const result = await uninstallWebConnector(f.paths, f.dependencies);
  expect(result).toMatchObject({ outcome: 'removed', operator_actions: [expect.stringContaining('Revoke')] });
  expect(result.operator_actions.join(' ')).toContain('Cloudflare');
  expect(result.operator_actions.join(' ')).toContain('--credential-file');
  expect(result.operator_actions.join(' ')).toContain('delete');
  expect(await exists(f.config.credentialFile)).toBe(false);
});

it('installs a different verified zone after uninstall removes the previous connector ownership', async () => {
  const f = await fixture(0);
  expect(await uninstallWebConnector(f.paths, f.dependencies)).toMatchObject({ outcome: 'removed' });
  const credentialFile = path.join(f.paths.configRoot, 'new-zone-credential');
  await writePrivateTextFile(credentialFile, randomBytes(32).toString('hex'));
  const requests: string[] = [];
  expect(
    await installWebConnector(
      f.paths,
      {
        accountId: 'new-account',
        teamName: 'new-team',
        zoneId: 'new-zone',
        credentialFile,
        cloudflaredPath: '/usr/bin/true',
      },
      {
        fetch: async (input, init) => {
          const resource = new URL(String(input)).pathname;
          requests.push(`${init?.method} ${resource}`);
          const result = resource.endsWith('/zones/new-zone')
            ? { id: 'new-zone', status: 'active', name: 'another.example', account: { id: 'new-account' } }
            : { auth_domain: 'new-team.cloudflareaccess.com' };
          return Response.json({ success: true, result });
        },
      },
    ),
  ).toMatchObject({ installed: true, assistants: [] });
  expect(await readWebOperatorConfig(f.files.configFile)).toMatchObject({
    accountId: 'new-account',
    teamName: 'new-team',
    zoneId: 'new-zone',
    zoneApex: 'another.example',
    assistants: {},
    dns: {},
  });
  expect(requests).toEqual([
    'GET /client/v4/zones/new-zone',
    'GET /client/v4/accounts/new-account/access/organizations',
  ]);
});
