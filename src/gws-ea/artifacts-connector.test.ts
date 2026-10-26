import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { claimInstanceArtifacts, getInstanceReservation, releaseInstanceArtifacts } from './registry.js';
import { deriveGcpClaims } from './gcp-identity.js';
import { reserveInstance, withInstanceOperation } from './journal.js';
import { resolveControlPlanePaths, type ControlPlanePaths } from './paths.js';
import { GwsEaError } from './types.js';
import { persistTestRuntime } from './testing/runtime-fixture.js';
import {
  installArtifactsConnector,
  provisionAssistantArtifacts,
  artifactsReleaseCompatibility,
  type ArtifactsCapabilityOptions,
  type ArtifactsCapabilityDependencies,
  inspectArtifactsCapability,
  instanceArtifactsPolicyFile,
} from './artifacts-connector.js';
import {
  artifactsOperatorFiles,
  readArtifactsOperatorConfig,
  reconcileArtifactsAccessEmails,
  writeArtifactsOperatorConfig,
  type ArtifactsOperatorConfig,
} from './artifacts-cloudflare.js';
import { isRecord } from './validation.js';
import { readArtifactsPolicy } from '../modules/gws-ea-artifacts/policy.js';
import { uninstallArtifactsConnector, withArtifactsHostLock } from './artifacts-uninstall.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'artifacts-capability-')));
  roots.push(root);
  const paths = resolveControlPlanePaths({
    configRoot: path.join(root, 'config'),
    stateRoot: path.join(root, 'state'),
  });
  async function assistant(email: string, port: number) {
    const instanceId = randomUUID();
    const reservation = await reserveInstance(paths, {
      instance_id: instanceId,
      release_track: 'dogfood',
      source_remote: 'https://example.test/repo.git',
      deployed_commit: 'a'.repeat(40),
      allocated_ports: { onecli_app: port, onecli_gateway: port + 1 },
      exclusive_resource_claims: {
        ...deriveGcpClaims(instanceId),
        gcp_account: 'operator@example.test',
        workspace_email: email,
        onecli_project: `gws-ea-${instanceId.replaceAll('-', '')}`,
      },
    });
    const runtime = await persistTestRuntime(paths, reservation);
    const marker = path.join(runtime.checkout_root, 'src/gws-ea/artifacts-compatibility.json');
    await mkdir(path.dirname(marker), { recursive: true });
    await writeFile(marker, JSON.stringify({ schemaVersion: 1, contract: 'gws-ea-artifacts-1' }));
    return { instanceId, runtime };
  }
  return { root, paths, assistant };
}

async function provisionForAssistant(
  paths: ControlPlanePaths,
  instanceId: string,
  options: ArtifactsCapabilityOptions = {},
  dependencies: ArtifactsCapabilityDependencies = {},
) {
  const installed = await installArtifactsConnector(paths, options, dependencies);
  const assistant = installed.assistants.find((entry) => entry.instance_id === instanceId);
  if (assistant?.outcome !== 'ready')
    throw new GwsEaError(assistant?.reason ?? 'artifacts_not_ready', assistant?.message ?? 'Artifacts are not ready.');
  const observed = await inspectArtifactsCapability(paths, instanceId);
  return { ...assistant, enabled: true, hostname: observed.hostname, path_prefix: observed.path_prefix };
}

function cloudflareFixture() {
  const requests: { method: string; resource: string; body: Record<string, unknown> | undefined }[] = [];
  const idps: Record<string, unknown>[] = [];
  const apps: Record<string, unknown>[] = [];
  const policies = new Map<string, Record<string, unknown>[]>();
  const dns: Record<string, unknown>[] = [];
  let ingress: Record<string, unknown>[] = [
    { hostname: 'unrelated.example.test', service: 'http://127.0.0.1:9876' },
    { service: 'http_status:404' },
  ];
  let lost: 'application' | 'dns' | 'put' | undefined;
  let rejected: number | undefined;
  let serial = 0;
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const resource = url.pathname.slice('/client/v4'.length);
    const method = init?.method ?? 'GET';
    const parsed: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const body = isRecord(parsed) ? parsed : undefined;
    requests.push({ method, resource, body });
    const reply = (result: unknown, status = 200) =>
      new Response(JSON.stringify({ success: status === 200, result, result_info: { total_pages: 1 } }), { status });
    if (rejected) return reply({ message: 'secret-management-fixture' }, rejected);
    if (resource === '/zones/zone' || resource === '/zones/dedicated-zone')
      return reply({
        id: resource.endsWith('/zone') ? 'zone' : 'dedicated-zone',
        name: resource.endsWith('/zone') ? 'example.test' : 'other.test',
        status: 'active',
        account: { id: 'account' },
      });
    if (resource === '/zones')
      return reply([{ id: 'dedicated-zone', name: 'other.test', status: 'active', account: { id: 'account' } }]);
    if (resource === '/accounts/account/access/organizations')
      return reply({ auth_domain: 'team.cloudflareaccess.com' });
    if (resource === '/accounts/account/access/identity_providers') {
      if (method === 'POST') {
        const item = { ...body, id: `pin-${++serial}` };
        idps.push(item);
        return reply(item);
      }
      return reply(idps);
    }
    if (resource.startsWith('/accounts/account/access/identity_providers/'))
      return reply(idps.find((item) => item.id === resource.split('/').at(-1)));
    if (resource === '/accounts/account/access/apps') {
      if (method === 'POST') {
        const item = { ...body, id: `app-${++serial}`, aud: `aud-${serial}` };
        apps.push(item);
        if (lost === 'application') {
          lost = undefined;
          throw new Error('response lost secret-management-fixture');
        }
        return reply(item);
      }
      return reply(apps);
    }
    const policy = /^\/accounts\/account\/access\/apps\/([^/]+)\/policies(?:\/([^/]+))?$/u.exec(resource);
    if (policy) {
      const records = policies.get(policy[1]) ?? [];
      if (method === 'POST') {
        const item = { ...body, id: `policy-${++serial}` };
        records.push(item);
        policies.set(policy[1], records);
        return reply(item);
      }
      if (method === 'PUT') {
        const index = records.findIndex((item) => item.id === policy[2]);
        const item = { ...body, id: policy[2] };
        records[index] = item;
        return reply(item);
      }
      return reply(policy[2] ? records.find((item) => item.id === policy[2]) : records);
    }
    if (resource.endsWith('/revoke_tokens')) return reply(null);
    if (/^\/accounts\/account\/access\/apps\/[^/]+$/u.test(resource))
      return reply(apps.find((item) => item.id === resource.split('/').at(-1)));
    if (resource === '/accounts/account/cfd_tunnel' && method === 'POST') return reply({ id: 'tunnel' });
    if (resource === '/accounts/account/cfd_tunnel/tunnel')
      return reply({ id: 'tunnel', config_src: 'cloudflare', deleted_at: null });
    if (resource === '/accounts/account/cfd_tunnel/tunnel/token') return reply('secret-run-fixture');
    if (resource === '/accounts/account/cfd_tunnel/tunnel/connections')
      return reply([{ id: 'connection', is_pending_reconnect: false }]);
    if (resource === '/accounts/account/cfd_tunnel/tunnel/configurations') {
      if (method === 'PUT' && body && isRecord(body.config) && Array.isArray(body.config.ingress)) {
        ingress = body.config.ingress as Record<string, unknown>[];
        if (lost === 'put') {
          lost = undefined;
          throw new Error('PUT response lost');
        }
      }
      return reply({ config: { ingress } });
    }
    const record = /^\/zones\/([^/]+)\/dns_records(?:\/([^/]+))?$/u.exec(resource);
    if (record) {
      if (method === 'POST') {
        const item = { ...body, id: `dns-${++serial}` };
        dns.push(item);
        if (lost === 'dns') {
          lost = undefined;
          throw new Error('DNS response lost');
        }
        return reply(item);
      }
      return reply(
        record[2]
          ? dns.find((item) => item.id === record[2])
          : dns.filter((item) => item.name === url.searchParams.get('name')),
      );
    }
    throw new Error(`Unexpected test API request: ${method} ${resource}`);
  };
  return {
    transport,
    requests,
    apps,
    idps,
    policies,
    dns,
    ingress: () => ingress,
    lose: (effect: typeof lost) => {
      lost = effect;
    },
    reject: (status: number | undefined) => {
      rejected = status;
    },
  };
}

async function provisionFixture() {
  const f = await fixture();
  const a = await f.assistant('a@example.test', 31000);
  const claim = { hostname: 'views.example.test', path_prefix: '/avery', listen_port: 41000 };
  await claimInstanceArtifacts(f.paths, a.instanceId, claim);
  const files = artifactsOperatorFiles(f.paths);
  await mkdir(files.root, { recursive: true, mode: 0o700 });
  const config: ArtifactsOperatorConfig = {
    schemaVersion: 1,
    accountId: 'account',
    zoneId: 'zone',
    teamName: 'team',
    hostname: 'views.example.test',
    credentialFile: path.join(files.root, 'management-token'),
    cloudflaredPath: '/usr/local/bin/cloudflared',
    dns: {},
    assistants: {},
  };
  await writeFile(config.credentialFile, 'secret-management-fixture', { mode: 0o600 });
  await writeArtifactsOperatorConfig(files.configFile, config);
  const api = cloudflareFixture();
  let emails = ['principal@example.test', 'second@example.test'];
  const commands: string[][] = [];
  const restarts: string[][] = [];
  const dependencies = {
    fetch: api.transport,
    sleep: async () => {},
    ncl: async (runtime: typeof a.runtime, args: readonly string[]): Promise<unknown> => {
      if (args[0] === 'gws-ea-profile-get')
        return { assistant_first_name: 'Avery', principal_emails: ['principal@example.test', 'second@example.test'] };
      if (args[0] === 'gws-ea-artifacts-admission-emails') return { emails };
      if (args[0] === 'gws-ea-artifacts-author-groups') return { group_ids: ['canonical', 'selected-author'] };
      if (args[0] === 'groups' && args[1] === 'restart') {
        restarts.push([...args]);
        return { restarted: 0 };
      }
      if (args[0] === 'gws-ea-artifacts-health') {
        const policy = await readArtifactsPolicy(instanceArtifactsPolicyFile(runtime));
        return {
          policyVersions: [1],
          enabled: policy.enabled,
          availability: policy.enabled ? 'available' : 'disabled',
          listener: {
            state: policy.enabled ? 'listening' : 'stopped',
            port: policy.status === 'unavailable' ? undefined : policy.config?.listenPort,
          },
        };
      }
      throw new Error('Unexpected native host command');
    },
    runCommand: async (command: { readonly args: readonly string[] }) => {
      commands.push([...command.args]);
      return {
        stdout: command.args[0] === '--version' ? 'cloudflared version 2026.10.0 (fixture)' : '',
        stderr: '',
        exitCode: command.args[0] === 'print' ? 1 : 0,
      };
    },
  };
  return {
    ...f,
    a,
    api,
    files,
    dependencies,
    commands,
    restarts,
    emails: (next: string[]) => {
      emails = next;
    },
  };
}

describe('artifacts operator capability', () => {
  it('reuses an explicitly typed operator PIN without claiming ownership', async () => {
    const f = await provisionFixture();
    f.api.idps.push({ id: 'operator-pin', type: 'onetimepin' });
    await provisionForAssistant(f.paths, f.a.instanceId, {}, f.dependencies);
    expect((await readArtifactsOperatorConfig(f.files.configFile))?.pin).toEqual({ id: 'operator-pin', owned: false });
    expect(
      f.api.requests.some((request) => request.method === 'POST' && request.resource.endsWith('/identity_providers')),
    ).toBe(false);
  });

  it('observes local artifact state without remote requests or repair', async () => {
    const f = await provisionFixture();
    const result = await inspectArtifactsCapability(f.paths, f.a.instanceId, f.dependencies);
    expect(result).toMatchObject({
      activation: 'disabled',
      ready: false,
      operator: { status: 'configured', hostname: 'views.example.test' },
    });
    expect(f.api.requests).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('secret-');
  });
  it('serializes two assistants against one tunnel without losing either route', async () => {
    const f = await provisionFixture();
    const b = await f.assistant('b@example.test', 31002);
    await claimInstanceArtifacts(f.paths, b.instanceId, {
      hostname: 'views.example.test',
      path_prefix: '/milo',
      listen_port: 41001,
    });
    const installed = await installArtifactsConnector(f.paths, {}, f.dependencies);
    expect(installed.assistants.every((entry) => entry.outcome === 'ready')).toBe(true);
    const routes = f.api.ingress();
    expect(routes).toContainEqual({
      hostname: 'views.example.test',
      path: '^/avery(/|$)',
      service: 'http://127.0.0.1:41000',
    });
    expect(routes).toContainEqual({
      hostname: 'views.example.test',
      path: '^/milo(/|$)',
      service: 'http://127.0.0.1:41001',
    });
    expect(routes).toContainEqual({ hostname: 'unrelated.example.test', service: 'http://127.0.0.1:9876' });
    expect(routes.at(-1)).toEqual({ service: 'http_status:404' });
    expect(f.api.apps).toHaveLength(2);
    expect(
      f.api.requests.filter((request) => request.method === 'POST' && request.resource.endsWith('/cfd_tunnel')),
    ).toHaveLength(1);
    expect(f.api.dns).toHaveLength(1);
    expect(f.api.ingress().some((route) => route.path === '^/milo(/|$)')).toBe(true);
  });

  it('uses a dedicated hostname root in another active zone of the same account', async () => {
    const f = await provisionFixture();
    const b = await f.assistant('b@example.test', 31002);
    await claimInstanceArtifacts(f.paths, b.instanceId, {
      hostname: 'avery.other.test',
      path_prefix: '',
      listen_port: 41001,
    });
    const result = await provisionForAssistant(f.paths, b.instanceId, {}, f.dependencies);
    expect(result).toMatchObject({ hostname: 'avery.other.test', path_prefix: '', enabled: true });
    const applicationId = (await readArtifactsOperatorConfig(f.files.configFile))?.assistants[b.instanceId]
      ?.applicationId;
    expect(f.api.apps.find((app) => app.id === applicationId)?.destinations).toEqual([
      { type: 'public', uri: 'avery.other.test', overrides: [{ behavior: 'public', path_pattern: '/public/*' }] },
    ]);
    expect(f.api.ingress()).toContainEqual({ hostname: 'avery.other.test', service: 'http://127.0.0.1:41001' });
    expect((await readArtifactsOperatorConfig(f.files.configFile))?.dns['avery.other.test'].zoneId).toBe(
      'dedicated-zone',
    );
  });

  it('refreshes eligible authors only during first activation and verifies a ready assistant without restarting', async () => {
    const f = await provisionFixture();
    await provisionForAssistant(f.paths, f.a.instanceId, {}, f.dependencies);
    expect(f.restarts).toEqual([
      ['groups', 'restart', '--id', 'canonical'],
      ['groups', 'restart', '--id', 'selected-author'],
    ]);
    const before = await readFile(instanceArtifactsPolicyFile(f.a.runtime), 'utf8');
    const repeated = await provisionForAssistant(f.paths, f.a.instanceId, {}, f.dependencies);
    expect(repeated.changed).toBe(false);
    expect(f.restarts).toHaveLength(2);
    expect(await readFile(instanceArtifactsPolicyFile(f.a.runtime), 'utf8')).toBe(before);
  });

  it('waits for delayed local listener readiness before exposing ingress', async () => {
    const f = await provisionFixture();
    let observations = 0;
    const waits: number[] = [];
    const dependencies = {
      ...f.dependencies,
      sleep: async (milliseconds: number) => {
        waits.push(milliseconds);
      },
      ncl: async (runtime: typeof f.a.runtime, args: readonly string[]) => {
        const policy = await readArtifactsPolicy(instanceArtifactsPolicyFile(runtime));
        if (args[0] === 'gws-ea-artifacts-health' && policy.enabled) {
          expect(
            (await readArtifactsOperatorConfig(f.files.configFile))?.assistants[f.a.instanceId]?.publicationReady,
          ).not.toBe(true);
          observations++;
          if (observations <= 4)
            expect(f.api.ingress().some((route) => route.hostname === 'views.example.test')).toBe(false);
          if (observations <= 3)
            return { policyVersions: [1], enabled: true, availability: 'unavailable', listener: { state: 'stopped' } };
        }
        return f.dependencies.ncl(runtime, args);
      },
    };
    expect(await provisionForAssistant(f.paths, f.a.instanceId, {}, dependencies)).toMatchObject({ enabled: true });
    expect(observations).toBeGreaterThanOrEqual(4);
    expect(waits).toEqual([500, 500, 500]);
    expect((await readArtifactsOperatorConfig(f.files.configFile))?.assistants[f.a.instanceId]?.publicationReady).toBe(
      true,
    );
  });

  it('never admits publication when ingress opens but final connector verification fails', async () => {
    const f = await provisionFixture();
    const dependencies = {
      ...f.dependencies,
      fetch: (async (input, init) => {
        if (String(input).endsWith('/connections')) {
          expect(f.api.ingress().some((route) => route.hostname === 'views.example.test')).toBe(true);
          expect(
            (await readArtifactsOperatorConfig(f.files.configFile))?.assistants[f.a.instanceId]?.publicationReady,
          ).not.toBe(true);
          throw new Error('Fixture connector verification failed');
        }
        return f.api.transport(input, init);
      }) satisfies typeof fetch,
    };
    await expect(provisionForAssistant(f.paths, f.a.instanceId, {}, dependencies)).rejects.toMatchObject({
      code: 'artifacts_not_ready',
    });
    expect((await readArtifactsPolicy(instanceArtifactsPolicyFile(f.a.runtime))).enabled).toBe(false);
    expect((await readArtifactsOperatorConfig(f.files.configFile))?.assistants[f.a.instanceId]).toMatchObject({
      enabled: false,
      publicationReady: false,
    });
    expect(f.api.ingress().some((route) => route.hostname === 'views.example.test')).toBe(false);
  });

  it('keeps ingress closed when the running host cannot verify its listener', async () => {
    const f = await provisionFixture();
    const started = Date.now();
    let now = started;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const dependencies = {
      ...f.dependencies,
      sleep: async (milliseconds: number) => {
        now += milliseconds;
      },
      ncl: async (runtime: typeof f.a.runtime, args: readonly string[]) =>
        args[0] === 'gws-ea-artifacts-health'
          ? { policyVersions: [1], enabled: false, availability: 'unavailable', listener: { state: 'stopped' } }
          : f.dependencies.ncl(runtime, args),
    };
    await expect(provisionForAssistant(f.paths, f.a.instanceId, {}, dependencies)).rejects.toMatchObject({
      code: 'artifacts_listener_unavailable',
    });
    expect((await readArtifactsPolicy(instanceArtifactsPolicyFile(f.a.runtime))).enabled).toBe(false);
    expect(f.api.ingress().some((route) => route.hostname === 'views.example.test')).toBe(false);
    expect(f.commands.some((args) => args[0] === 'bootstrap')).toBe(false);
    expect(now - started).toBe(30_000);
  });

  it('retains a lost DNS create and never adopts a matching unrecorded DNS record', async () => {
    const f = await provisionFixture();
    f.api.lose('dns');
    await expect(provisionForAssistant(f.paths, f.a.instanceId, {}, f.dependencies)).rejects.toMatchObject({
      code: 'artifacts_cloudflare_unavailable',
    });
    expect((await readArtifactsOperatorConfig(f.files.configFile))?.pending).toMatchObject({
      kind: 'dns',
      target: 'views.example.test',
    });
    await expect(provisionForAssistant(f.paths, f.a.instanceId, {}, f.dependencies)).rejects.toMatchObject({
      code: 'artifacts_create_unproven',
    });
    expect(f.api.dns).toHaveLength(1);
    const pending = (await readArtifactsOperatorConfig(f.files.configFile))?.pending;
    await expect(
      provisionForAssistant(f.paths, f.a.instanceId, { discardUnproven: pending?.key }, f.dependencies),
    ).rejects.toMatchObject({ code: 'artifacts_dns_conflict' });
    expect(f.api.dns).toHaveLength(1);
  });

  it('reports a missing operator account and never provisions with incomplete domain configuration', async () => {
    const f = await provisionFixture();
    await rm(f.files.configFile);
    await expect(provisionForAssistant(f.paths, f.a.instanceId, {}, f.dependencies)).rejects.toMatchObject({
      code: 'artifacts_operator_required',
    });
    expect(f.api.requests).toEqual([]);
  });

  it('refuses account permission failures and application limits without reporting enabled', async () => {
    const f = await provisionFixture();
    f.api.reject(403);
    await expect(provisionForAssistant(f.paths, f.a.instanceId, {}, f.dependencies)).rejects.toMatchObject({
      code: 'artifacts_cloudflare_forbidden',
    });
    expect((await readArtifactsPolicy(instanceArtifactsPolicyFile(f.a.runtime))).enabled).toBe(false);
    f.api.reject(undefined);
    for (let index = 0; index < 500; index++)
      f.api.apps.push({
        id: `foreign-${index}`,
        type: 'self_hosted',
        destinations: [{ type: 'public', uri: `foreign-${index}.example.test` }],
      });
    await expect(provisionForAssistant(f.paths, f.a.instanceId, {}, f.dependencies)).rejects.toMatchObject({
      code: 'artifacts_cloudflare_capacity',
    });
    expect(f.api.apps).toHaveLength(500);
  });

  it('refuses overlapping Access destinations without overwriting or adopting them', async () => {
    const f = await provisionFixture();
    f.api.apps.push({
      id: 'foreign',
      type: 'self_hosted',
      destinations: [{ type: 'public', uri: 'views.example.test' }],
    });
    await expect(provisionForAssistant(f.paths, f.a.instanceId, {}, f.dependencies)).rejects.toMatchObject({
      code: 'artifacts_access_conflict',
    });
    expect(f.api.apps).toEqual([
      { id: 'foreign', type: 'self_hosted', destinations: [{ type: 'public', uri: 'views.example.test' }] },
    ]);
    expect(f.api.requests.some((request) => request.method === 'PUT')).toBe(false);
  });
  it('provisions current Access/PIN contracts before ingress and keeps tokens host-only', async () => {
    const f = await provisionFixture();
    const result = await provisionForAssistant(f.paths, f.a.instanceId, {}, f.dependencies);
    expect(result.enabled).toBe(true);
    expect(f.api.idps[0]).toMatchObject({ type: 'onetimepin', config: {} });
    const app = f.api.apps[0];
    expect(app).toMatchObject({
      type: 'self_hosted',
      destinations: [
        {
          type: 'public',
          uri: 'views.example.test/avery',
          overrides: [{ behavior: 'public', path_pattern: '/avery/public/*' }],
        },
      ],
      allowed_idps: [f.api.idps[0].id],
      auto_redirect_to_identity: true,
    });
    expect(app).not.toHaveProperty('self_hosted_domains');
    expect(f.api.policies.get(String(app.id))?.[0].include).toEqual([
      { email: { email: 'principal@example.test' } },
      { email: { email: 'second@example.test' } },
    ]);
    expect(f.api.ingress()).toEqual([
      { hostname: 'unrelated.example.test', service: 'http://127.0.0.1:9876' },
      { hostname: 'views.example.test', path: '^/avery(/|$)', service: 'http://127.0.0.1:41000' },
      { service: 'http_status:404' },
    ]);
    const policy = await readArtifactsPolicy(instanceArtifactsPolicyFile(f.a.runtime));
    expect(policy).toMatchObject({ enabled: true, config: { accessAud: app.aud } });
    const owned = await readArtifactsOperatorConfig(f.files.configFile);
    expect(owned).toMatchObject({
      pin: { owned: true },
      tunnelId: 'tunnel',
      assistants: { [f.a.instanceId]: { applicationId: app.id, policyId: expect.any(String), enabled: true } },
    });
    expect((await stat(f.files.tokenFile)).mode & 0o777).toBe(0o600);
    expect(await readFile(f.files.tokenFile, 'utf8')).toBe('secret-run-fixture');
    expect(JSON.stringify(f.commands)).not.toContain('secret-run-fixture');
    expect(
      JSON.stringify(await inspectArtifactsCapability(f.paths, f.a.instanceId, { ...f.dependencies, check: true })),
    ).not.toContain('secret-');
    const appCreate = f.api.requests.findIndex(
      (request) => request.method === 'POST' && request.resource.endsWith('/apps'),
    );
    const ingressPut = f.api.requests.findIndex(
      (request) => request.method === 'PUT' && request.resource.endsWith('/configurations'),
    );
    expect(appCreate).toBeLessThan(ingressPut);
    expect(f.api.requests.some((request) => request.resource.endsWith('/connections'))).toBe(true);
  });

  it('retains an ambiguous create and only resumes after exact operator acknowledgment', async () => {
    const f = await provisionFixture();
    f.api.lose('application');
    await expect(provisionForAssistant(f.paths, f.a.instanceId, {}, f.dependencies)).rejects.toMatchObject({
      code: 'artifacts_cloudflare_unavailable',
    });
    const pending = (await readArtifactsOperatorConfig(f.files.configFile))?.pending;
    expect(pending?.kind).toBe('application');
    await expect(provisionForAssistant(f.paths, f.a.instanceId, {}, f.dependencies)).rejects.toMatchObject({
      code: 'artifacts_create_unproven',
    });
    expect(f.api.apps).toHaveLength(1);
    await expect(
      provisionForAssistant(f.paths, f.a.instanceId, { discardUnproven: 'wrong' }, f.dependencies),
    ).rejects.toMatchObject({ code: 'artifacts_attempt_mismatch' });
    f.api.apps.splice(0); // The operator removed the unproven application before acknowledging it.
    await provisionForAssistant(f.paths, f.a.instanceId, { discardUnproven: pending?.key }, f.dependencies);
    expect(f.api.apps).toHaveLength(1);
    expect((await readArtifactsOperatorConfig(f.files.configFile))?.resolvedAttempts).toEqual([
      expect.objectContaining({ kind: 'application', resolution: 'operator_removed', key: pending?.key }),
    ]);
  });

  it('recovers a lost full-config PUT by reading the exact current config without duplicate creates', async () => {
    const f = await provisionFixture();
    f.api.lose('put');
    await expect(provisionForAssistant(f.paths, f.a.instanceId, {}, f.dependencies)).rejects.toMatchObject({
      code: 'artifacts_cloudflare_unavailable',
    });
    expect((await readArtifactsPolicy(instanceArtifactsPolicyFile(f.a.runtime))).enabled).toBe(false);
    await provisionForAssistant(f.paths, f.a.instanceId, {}, f.dependencies);
    expect(f.api.apps).toHaveLength(1);
    expect(f.api.dns).toHaveLength(1);
    expect(f.api.ingress().filter((route) => route.hostname === 'views.example.test')).toHaveLength(1);
  });

  it('keeps read-only checks from repairing missing PIN or exposing provider response secrets', async () => {
    const f = await provisionFixture();
    await provisionForAssistant(f.paths, f.a.instanceId, {}, f.dependencies);
    const before = await readFile(f.files.configFile, 'utf8');
    f.api.idps.splice(0);
    const start = f.api.requests.length;
    expect(await inspectArtifactsCapability(f.paths, f.a.instanceId, { ...f.dependencies, check: true })).toMatchObject(
      { ready: false, remote: 'mismatch' },
    );
    expect(f.api.requests.slice(start).every((request) => request.method === 'GET')).toBe(true);
    expect(await readFile(f.files.configFile, 'utf8')).toBe(before);
    f.api.reject(403);
    const shown = await inspectArtifactsCapability(f.paths, f.a.instanceId, { ...f.dependencies, check: true });
    expect(JSON.stringify(shown)).not.toContain('secret-management-fixture');
    expect(shown.reason).toContain('permissions');
  });

  it('read-verifies exact email changes, reuses existing admission and revokes sessions after reduction', async () => {
    const f = await provisionFixture();
    await provisionForAssistant(f.paths, f.a.instanceId, {}, f.dependencies);
    const config = await readArtifactsOperatorConfig(f.files.configFile);
    const applicationId = config!.assistants[f.a.instanceId].applicationId!;
    const input = {
      operatorConfigFile: f.files.configFile,
      accountId: 'account',
      applicationId,
      emails: async () => ['principal@example.test', 'guest@example.test'],
    };
    const first = await reconcileArtifactsAccessEmails(input, f.dependencies);
    expect(first).toEqual({ verified: true, changed: true, emails: ['guest@example.test', 'principal@example.test'] });
    expect(
      f.api.requests.some((request) => request.method === 'POST' && request.resource.endsWith('/revoke_tokens')),
    ).toBe(true);
    const start = f.api.requests.length;
    expect(await reconcileArtifactsAccessEmails(input, f.dependencies)).toMatchObject({ changed: false });
    expect(f.api.requests.slice(start).every((request) => request.method === 'GET')).toBe(true);
  });
  it('serializes first-name claims and preserves the winner across rename', async () => {
    const f = await fixture();
    const a = await f.assistant('a@example.test', 31000);
    const b = await f.assistant('b@example.test', 31002);
    const results = await Promise.allSettled([
      claimInstanceArtifacts(f.paths, a.instanceId, {
        hostname: 'views.example.test',
        path_prefix: '/avery',
        listen_port: 41000,
      }),
      claimInstanceArtifacts(f.paths, b.instanceId, {
        hostname: 'views.example.test',
        path_prefix: '/avery',
        listen_port: 41001,
      }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const winner = results[0].status === 'fulfilled' ? a : b;
    await expect(
      claimInstanceArtifacts(f.paths, winner.instanceId, {
        hostname: 'views.example.test',
        path_prefix: '/renamed',
        listen_port: 41000,
      }),
    ).rejects.toMatchObject({ code: 'claim_conflict' });
    expect(
      (await getInstanceReservation(f.paths, winner.instanceId)).exclusive_resource_claims.artifacts?.path_prefix,
    ).toBe('/avery');
  });

  it('shows a stopped origin policy without changing its owner-only file', async () => {
    const f = await fixture();
    const a = await f.assistant('a@example.test', 31000);
    const policyFile = instanceArtifactsPolicyFile(a.runtime);
    await mkdir(path.dirname(policyFile), { recursive: true, mode: 0o700 });
    await writeFile(
      policyFile,
      JSON.stringify({
        schemaVersion: 1,
        enabled: true,
        hostname: 'views.example.test',
        pathPrefix: '/avery',
        listenPort: 41000,
        accessIssuer: 'https://example.cloudflareaccess.com',
        accessAud: 'aud',
        cloudflare: {
          accountId: 'account',
          applicationId: 'app',
          operatorConfigFile: path.join(f.paths.configRoot, 'artifacts', 'config.json'),
        },
      }),
      { mode: 0o600 },
    );
    const policy = await readArtifactsPolicy(policyFile);
    if (policy.status === 'unavailable' || !policy.config) throw new Error('Missing fixture policy');
    await writeFile(policyFile, JSON.stringify({ ...policy.config, enabled: false }), { mode: 0o600 });
    expect((await readArtifactsPolicy(policyFile)).enabled).toBe(false);
    const before = await readFile(policyFile, 'utf8');
    const shown = await inspectArtifactsCapability(f.paths, a.instanceId);
    expect(shown.activation).toBe('disabled');
    expect(await readFile(policyFile, 'utf8')).toBe(before);
    expect((await stat(policyFile)).mode & 0o777).toBe(0o600);
  });
});

it('installs for every compatible reachable assistant and reports stopped assistants pending', async () => {
  const f = await provisionFixture();
  const stopped = await f.assistant('stopped@example.test', 31002);
  const installed = await installArtifactsConnector(
    f.paths,
    {},
    {
      ...f.dependencies,
      ncl: async (runtime, args) => {
        if (runtime.instance_id === stopped.instanceId) throw new Error('socket unavailable');
        return f.dependencies.ncl(runtime, args);
      },
    },
  );
  expect(installed.assistants).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ instance_id: f.a.instanceId, outcome: 'ready' }),
      expect.objectContaining({
        instance_id: stopped.instanceId,
        outcome: 'pending',
        reason: 'artifacts_host_unavailable',
      }),
    ]),
  );
  expect((await readArtifactsOperatorConfig(f.files.configFile))?.assistants[stopped.instanceId]).toBeUndefined();
});

it('provisions a previously stopped assistant through its existing instance operation', async () => {
  const f = await provisionFixture();
  const result = await withInstanceOperation(f.paths, f.a.instanceId, (operation) =>
    provisionAssistantArtifacts(operation, f.dependencies),
  );
  expect(result).toMatchObject({ instance_id: f.a.instanceId, outcome: 'ready', changed: true });
  const again = await withInstanceOperation(f.paths, f.a.instanceId, (operation) =>
    provisionAssistantArtifacts(operation, f.dependencies),
  );
  expect(again).toMatchObject({ outcome: 'ready', changed: false });
  expect(f.restarts).toHaveLength(2);
});

it('waits for an already activated listener without reprovisioning or restarting authors', async () => {
  const f = await provisionFixture();
  await withInstanceOperation(f.paths, f.a.instanceId, (operation) =>
    provisionAssistantArtifacts(operation, f.dependencies),
  );
  const mutations = f.api.requests.filter((request) => request.method !== 'GET').length;
  const providerReads = f.api.requests.filter((request) => request.resource === '/zones/zone').length;
  const restarts = f.restarts.length;
  let probes = 0;
  let waits = 0;
  const dependencies = {
    ...f.dependencies,
    sleep: async () => {
      waits += 1;
    },
    ncl: async (runtime: typeof f.a.runtime, args: readonly string[]) => {
      if (args[0] === 'gws-ea-artifacts-health' && ++probes <= 3)
        return { policyVersions: [1], enabled: true, listener: { state: 'starting' } };
      return f.dependencies.ncl(runtime, args);
    },
  };
  const result = await withInstanceOperation(f.paths, f.a.instanceId, (operation) =>
    provisionAssistantArtifacts(operation, dependencies),
  );
  expect(result).toMatchObject({ outcome: 'ready', changed: false });
  expect(waits).toBeGreaterThan(0);
  expect(f.api.requests.filter((request) => request.resource === '/zones/zone')).toHaveLength(providerReads + 1);
  expect(f.api.requests.filter((request) => request.method !== 'GET')).toHaveLength(mutations);
  expect(f.restarts).toHaveLength(restarts);
});

it('keeps an activated configuration intact when its listener does not recover within the bound', async () => {
  const f = await provisionFixture();
  await withInstanceOperation(f.paths, f.a.instanceId, (operation) =>
    provisionAssistantArtifacts(operation, f.dependencies),
  );
  const before = await readArtifactsOperatorConfig(f.files.configFile);
  const policy = await readFile(instanceArtifactsPolicyFile(f.a.runtime), 'utf8');
  const mutations = f.api.requests.filter((request) => request.method !== 'GET').length;
  const restarts = f.restarts.length;
  let clock = Date.now();
  const started = clock;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  const result = await withInstanceOperation(f.paths, f.a.instanceId, (operation) =>
    provisionAssistantArtifacts(operation, {
      ...f.dependencies,
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
      ncl: async (runtime, args) =>
        args[0] === 'gws-ea-artifacts-health'
          ? { policyVersions: [1], enabled: true, listener: { state: 'starting' } }
          : f.dependencies.ncl(runtime, args),
    }),
  );
  expect(result).toMatchObject({ outcome: 'pending', reason: 'artifacts_listener_unavailable', changed: false });
  expect(clock - started).toBe(30_000);
  expect(await readArtifactsOperatorConfig(f.files.configFile)).toEqual(before);
  expect(await readFile(instanceArtifactsPolicyFile(f.a.runtime), 'utf8')).toBe(policy);
  expect(f.api.requests.filter((request) => request.method !== 'GET')).toHaveLength(mutations);
  expect(f.restarts).toHaveLength(restarts);
});

it('keeps an incomplete profile pending without creating provider resources', async () => {
  const f = await provisionFixture();
  const result = await installArtifactsConnector(
    f.paths,
    {},
    {
      ...f.dependencies,
      ncl: async (runtime, args) =>
        args[0] === 'gws-ea-profile-get'
          ? { assistant_first_name: 'Avery', principal_emails: [] }
          : f.dependencies.ncl(runtime, args),
    },
  );
  expect(result.assistants).toContainEqual(
    expect.objectContaining({
      instance_id: f.a.instanceId,
      outcome: 'pending',
      reason: 'artifacts_profile_unavailable',
    }),
  );
  expect(f.api.requests).toEqual([]);
});

it('reports unsupported and malformed release markers independently from profile readiness', async () => {
  const f = await provisionFixture();
  const marker = path.join(f.a.runtime.checkout_root, 'src/gws-ea/artifacts-compatibility.json');
  await rm(marker);
  expect(await artifactsReleaseCompatibility(f.a.runtime.checkout_root)).toBe('unsupported');
  const unsupported = await installArtifactsConnector(f.paths, {}, f.dependencies);
  expect(unsupported.assistants).toContainEqual(
    expect.objectContaining({ outcome: 'unsupported', reason: 'release_unsupported' }),
  );
  await writeFile(marker, '{');
  expect(await artifactsReleaseCompatibility(f.a.runtime.checkout_root)).toBe('unknown');
  const unknown = await installArtifactsConnector(f.paths, {}, f.dependencies);
  expect(unknown.assistants).toContainEqual(expect.objectContaining({ outcome: 'pending', reason: 'release_unknown' }));
  expect(f.api.requests).toEqual([]);
});

it('rotates only the stored management token when reinstalling with a credential file', async () => {
  const f = await provisionFixture();
  await installArtifactsConnector(f.paths, {}, f.dependencies);
  const before = await readArtifactsOperatorConfig(f.files.configFile);
  const credentialFile = path.join(f.paths.configRoot, 'replacement-token');
  await writeFile(credentialFile, 'replacement-management-fixture', { mode: 0o600 });
  const repeated = await installArtifactsConnector(f.paths, { credentialFile }, f.dependencies);
  expect(repeated.changed).toBe(true);
  expect(await readFile(before!.credentialFile, 'utf8')).toBe('replacement-management-fixture');
  expect((await readArtifactsOperatorConfig(f.files.configFile))?.assistants).toEqual(before?.assistants);
  expect(f.restarts).toHaveLength(2);
});

it('reports a single unproven provider creation pending for every assistant without further effects', async () => {
  const f = await provisionFixture();
  await f.assistant('second@example.test', 31002);
  f.api.lose('application');
  const initial = await installArtifactsConnector(f.paths, {}, f.dependencies);
  expect(initial.assistants).toHaveLength(2);
  const before = f.api.requests.length;
  const repeated = await installArtifactsConnector(f.paths, {}, f.dependencies);
  expect(
    repeated.assistants.every(
      (assistant) => assistant.outcome === 'pending' && assistant.reason === 'artifacts_create_unproven',
    ),
  ).toBe(true);
  expect(f.api.requests).toHaveLength(before);
  expect(f.api.apps).toHaveLength(1);
});

it('returns a pending operation hook immediately while the host connector lock is held', async () => {
  const f = await provisionFixture();
  await withArtifactsHostLock(f.paths, async () => {
    const result = await withInstanceOperation(f.paths, f.a.instanceId, (operation) =>
      provisionAssistantArtifacts(operation, f.dependencies),
    );
    expect(result).toMatchObject({ outcome: 'pending', reason: 'artifacts_busy', changed: false });
  });
  expect(f.api.requests).toEqual([]);
});

it.each([503, 429, 'network', 'reconnecting'] as const)(
  'keeps a published assistant intact when verification is unavailable (%s)',
  async (failure) => {
    const f = await provisionFixture();
    await withInstanceOperation(f.paths, f.a.instanceId, (operation) =>
      provisionAssistantArtifacts(operation, f.dependencies),
    );
    const config = await readFile(f.files.configFile, 'utf8');
    const policy = await readFile(instanceArtifactsPolicyFile(f.a.runtime), 'utf8');
    const restarts = f.restarts.length;
    const mutations = f.api.requests.filter((request) => request.method !== 'GET').length;
    const send: typeof fetch = async (input, init) => {
      if (failure === 'network') throw new Error('An observed transport outage');
      if (typeof failure === 'number') return Response.json({ success: false }, { status: failure });
      if (String(input).endsWith('/connections'))
        return Response.json({ success: true, result: [{ is_pending_reconnect: true }] });
      return f.api.transport(input, init);
    };
    const result = await withInstanceOperation(f.paths, f.a.instanceId, (operation) =>
      provisionAssistantArtifacts(operation, { ...f.dependencies, fetch: send }),
    );
    expect(result).toMatchObject({ outcome: 'pending', changed: false });
    expect(await readFile(f.files.configFile, 'utf8')).toBe(config);
    expect(await readFile(instanceArtifactsPolicyFile(f.a.runtime), 'utf8')).toBe(policy);
    expect(f.api.requests.filter((request) => request.method !== 'GET')).toHaveLength(mutations);
    expect(f.restarts).toHaveLength(restarts);
  },
);

it('releases a newly claimed namespace after provisioning fails before any assistant resource is recorded', async () => {
  const f = await provisionFixture();
  const oldClaim = (await getInstanceReservation(f.paths, f.a.instanceId)).exclusive_resource_claims.artifacts;
  if (!oldClaim) throw new Error('Fixture namespace is missing');
  await releaseInstanceArtifacts(f.paths, f.a.instanceId, oldClaim);
  const config = (await readArtifactsOperatorConfig(f.files.configFile))!;
  await writeArtifactsOperatorConfig(f.files.configFile, { ...config, teamName: 'wrong-team' });
  const failed = await installArtifactsConnector(f.paths, {}, f.dependencies);
  expect(failed.assistants).toEqual([
    expect.objectContaining({ instance_id: f.a.instanceId, outcome: 'pending', reason: 'artifacts_team_invalid' }),
  ]);
  expect((await getInstanceReservation(f.paths, f.a.instanceId)).exclusive_resource_claims.artifacts).toBeUndefined();
  expect((await readArtifactsOperatorConfig(f.files.configFile))?.assistants).toEqual({});
  expect(await uninstallArtifactsConnector(f.paths, f.dependencies)).toMatchObject({ outcome: 'removed' });
  const source = path.join(f.paths.configRoot, 'corrected-management-credential');
  await writeFile(source, 'secret-corrected-management-fixture', { mode: 0o600 });
  const corrected = await installArtifactsConnector(
    f.paths,
    {
      accountId: 'account',
      teamName: 'team',
      zoneId: 'zone',
      hostname: 'views.example.test',
      credentialFile: source,
      cloudflaredPath: '/usr/bin/true',
    },
    f.dependencies,
  );
  expect(corrected.assistants).toEqual([expect.objectContaining({ instance_id: f.a.instanceId, outcome: 'ready' })]);
});

it('repairs a positively observed Access admission mismatch on a published assistant', async () => {
  const f = await provisionFixture();
  await withInstanceOperation(f.paths, f.a.instanceId, (operation) =>
    provisionAssistantArtifacts(operation, f.dependencies),
  );
  const config = (await readArtifactsOperatorConfig(f.files.configFile))!;
  const assistant = config.assistants[f.a.instanceId];
  const policies = f.api.policies.get(assistant.applicationId!);
  if (!policies?.[0]) throw new Error('Fixture policy missing');
  policies[0].include = [{ email: { email: 'outdated@example.test' } }];
  expect(await inspectArtifactsCapability(f.paths, f.a.instanceId, { ...f.dependencies, check: true })).toMatchObject({
    remote: 'mismatch',
  });
  const result = await withInstanceOperation(f.paths, f.a.instanceId, (operation) =>
    provisionAssistantArtifacts(operation, f.dependencies),
  );
  expect(result).toMatchObject({ outcome: 'ready', changed: true });
  expect(await inspectArtifactsCapability(f.paths, f.a.instanceId, { ...f.dependencies, check: true })).toMatchObject({
    ready: true,
  });
});

it('retains an unproven fresh application create until its durable uninstall receipt fences cleanup', async () => {
  const f = await provisionFixture();
  const existingClaim = (await getInstanceReservation(f.paths, f.a.instanceId)).exclusive_resource_claims.artifacts;
  if (!existingClaim) throw new Error('Fixture namespace is missing');
  await releaseInstanceArtifacts(f.paths, f.a.instanceId, existingClaim);
  f.api.lose('application');
  const result = await installArtifactsConnector(f.paths, {}, f.dependencies);
  expect(result.assistants).toEqual([
    expect.objectContaining({
      instance_id: f.a.instanceId,
      outcome: 'pending',
      reason: 'artifacts_cloudflare_unavailable',
    }),
  ]);
  const pending = (await readArtifactsOperatorConfig(f.files.configFile))?.pending;
  expect(pending).toMatchObject({ kind: 'application', target: f.a.instanceId });
  expect((await getInstanceReservation(f.paths, f.a.instanceId)).exclusive_resource_claims.artifacts).toBeDefined();
  expect(await uninstallArtifactsConnector(f.paths, f.dependencies)).toMatchObject({ outcome: 'pending' });
  expect((await getInstanceReservation(f.paths, f.a.instanceId)).exclusive_resource_claims.artifacts).toBeUndefined();
  expect((await readArtifactsOperatorConfig(f.files.configFile))?.pending).toEqual(pending);
  await expect(installArtifactsConnector(f.paths, {}, f.dependencies)).rejects.toMatchObject({
    code: 'artifacts_uninstall_incomplete',
  });
});
