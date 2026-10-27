import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { claimInstanceWeb, getInstanceReservation, releaseInstanceWeb } from './registry.js';
import { deriveGcpClaims } from './gcp-identity.js';
import { reserveInstance, withInstanceOperation } from './journal.js';
import { resolveControlPlanePaths, type ControlPlanePaths } from './paths.js';
import { inspectConnector } from './connector-inspection.js';
import { managedResult } from './result.js';
import { expectResultContract } from './testing/result-contract.js';
import { GwsEaError } from './types.js';
import { persistTestRuntime } from './testing/runtime-fixture.js';
import {
  installWebConnector,
  provisionAssistantWeb,
  webReleaseCompatibility,
  type WebCapabilityOptions,
  type WebCapabilityDependencies,
  inspectWebCapability,
  instanceWebPolicyFile,
} from './web-connector.js';
import {
  webOperatorFiles,
  readWebOperatorConfig,
  reconcileWebAccessEmails,
  writeWebOperatorConfig,
  type WebOperatorConfig,
} from './web-cloudflare.js';
import { isRecord } from './validation.js';
import { readWebPolicy } from '../modules/gws-ea-web/policy.js';
import { uninstallWebConnector, withWebHostLock } from './web-uninstall.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'web-capability-')));
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
    const marker = path.join(runtime.checkout_root, 'src/gws-ea/web-compatibility.json');
    await mkdir(path.dirname(marker), { recursive: true });
    await writeFile(marker, JSON.stringify({ schemaVersion: 1, contract: 'gws-ea-web-1' }));
    return { instanceId, runtime };
  }
  return { root, paths, assistant };
}

async function provisionForAssistant(
  paths: ControlPlanePaths,
  instanceId: string,
  options: WebCapabilityOptions = {},
  dependencies: WebCapabilityDependencies = {},
) {
  const installed = await installWebConnector(paths, options, dependencies);
  const assistant = installed.assistants.find((entry) => entry.instance_id === instanceId);
  if (assistant?.outcome !== 'ready')
    throw new GwsEaError(assistant?.reason ?? 'web_not_ready', assistant?.message ?? 'Web are not ready.');
  const observed = await inspectWebCapability(paths, instanceId);
  return { ...assistant, enabled: true, hostname: observed.hostname };
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
  const claim = { hostname: 'views.example.test', listen_port: 41000 };
  await claimInstanceWeb(f.paths, a.instanceId, claim);
  const files = webOperatorFiles(f.paths);
  await mkdir(files.root, { recursive: true, mode: 0o700 });
  const config: WebOperatorConfig = {
    schemaVersion: 1,
    accountId: 'account',
    zoneId: 'zone',
    teamName: 'team',
    zoneApex: 'example.test',
    credentialFile: path.join(files.root, 'management-token'),
    cloudflaredPath: '/usr/local/bin/cloudflared',
    dns: {},
    assistants: {},
  };
  await writeFile(config.credentialFile, 'secret-management-fixture', { mode: 0o600 });
  await writeWebOperatorConfig(files.configFile, config);
  const api = cloudflareFixture();
  let emails = ['principal@example.test', 'second@example.test'];
  let firstName = 'Avery';
  const commands: string[][] = [];
  const restarts: string[][] = [];
  const dependencies = {
    fetch: api.transport,
    sleep: async () => {},
    ncl: async (runtime: typeof a.runtime, args: readonly string[]): Promise<unknown> => {
      if (args[0] === 'gws-ea-profile-get')
        return { assistant_first_name: firstName, principal_emails: ['principal@example.test', 'second@example.test'] };
      if (args[0] === 'gws-ea-web-admission-emails') return { emails };
      if (args[0] === 'gws-ea-artifacts-author-groups') return { group_ids: ['canonical', 'selected-author'] };
      if (args[0] === 'groups' && args[1] === 'restart') {
        restarts.push([...args]);
        return { restarted: 0 };
      }
      if (args[0] === 'gws-ea-web-health') {
        const policy = await readWebPolicy(instanceWebPolicyFile(runtime));
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
    firstName: (name: string) => {
      firstName = name;
    },
    emails: (next: string[]) => {
      emails = next;
    },
  };
}

describe('web operator capability', () => {
  it('reuses an explicitly typed operator PIN without claiming ownership', async () => {
    const f = await provisionFixture();
    f.api.idps.push({ id: 'operator-pin', type: 'onetimepin' });
    await provisionForAssistant(f.paths, f.a.instanceId, {}, f.dependencies);
    expect((await readWebOperatorConfig(f.files.configFile))?.pin).toEqual({ id: 'operator-pin', owned: false });
    expect(
      f.api.requests.some((request) => request.method === 'POST' && request.resource.endsWith('/identity_providers')),
    ).toBe(false);
  });

  it('observes local artifact state without remote requests or repair', async () => {
    const f = await provisionFixture();
    const result = await inspectWebCapability(f.paths, f.a.instanceId, f.dependencies);
    expect(result).toMatchObject({
      activation: 'disabled',
      ready: false,
      operator: { status: 'configured', zone_apex: 'example.test' },
    });
    expect(f.api.requests).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('secret-');
  });
  it('serializes two assistants against one tunnel without losing either route', async () => {
    const f = await provisionFixture();
    const b = await f.assistant('b@example.test', 31002);
    await claimInstanceWeb(f.paths, b.instanceId, {
      hostname: 'milo.example.test',
      listen_port: 41001,
    });
    const installed = await installWebConnector(f.paths, {}, f.dependencies);
    expect(installed.assistants.every((entry) => entry.outcome === 'ready')).toBe(true);
    const routes = f.api.ingress();
    expect(routes).toContainEqual({
      hostname: 'views.example.test',
      path: '^/artifacts(/|$)',
      service: 'http://127.0.0.1:41000',
    });
    expect(routes).toContainEqual({
      hostname: 'milo.example.test',
      path: '^/artifacts(/|$)',
      service: 'http://127.0.0.1:41001',
    });
    expect(routes).toContainEqual({ hostname: 'unrelated.example.test', service: 'http://127.0.0.1:9876' });
    expect(routes.at(-1)).toEqual({ service: 'http_status:404' });
    expect(f.api.apps).toHaveLength(2);
    expect(
      f.api.requests.filter((request) => request.method === 'POST' && request.resource.endsWith('/cfd_tunnel')),
    ).toHaveLength(1);
    expect(f.api.dns).toHaveLength(2);
    expect(f.api.ingress().some((route) => route.hostname === 'milo.example.test')).toBe(true);
  });

  it('refreshes eligible authors only during first activation and verifies a ready assistant without restarting', async () => {
    const f = await provisionFixture();
    await provisionForAssistant(f.paths, f.a.instanceId, {}, f.dependencies);
    expect(f.restarts).toEqual([
      ['groups', 'restart', '--id', 'canonical'],
      ['groups', 'restart', '--id', 'selected-author'],
    ]);
    const before = await readFile(instanceWebPolicyFile(f.a.runtime), 'utf8');
    const repeated = await provisionForAssistant(f.paths, f.a.instanceId, {}, f.dependencies);
    expect(repeated.changed).toBe(false);
    expect(f.restarts).toHaveLength(2);
    expect(await readFile(instanceWebPolicyFile(f.a.runtime), 'utf8')).toBe(before);
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
        const policy = await readWebPolicy(instanceWebPolicyFile(runtime));
        if (args[0] === 'gws-ea-web-health' && policy.enabled) {
          expect(
            (await readWebOperatorConfig(f.files.configFile))?.assistants[f.a.instanceId]?.publicationReady,
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
    expect((await readWebOperatorConfig(f.files.configFile))?.assistants[f.a.instanceId]?.publicationReady).toBe(true);
  });

  it('never admits publication when ingress opens but final connector verification fails', async () => {
    const f = await provisionFixture();
    const dependencies = {
      ...f.dependencies,
      fetch: (async (input, init) => {
        if (String(input).endsWith('/connections')) {
          expect(f.api.ingress().some((route) => route.hostname === 'views.example.test')).toBe(true);
          expect(
            (await readWebOperatorConfig(f.files.configFile))?.assistants[f.a.instanceId]?.publicationReady,
          ).not.toBe(true);
          throw new Error('Fixture connector verification failed');
        }
        return f.api.transport(input, init);
      }) satisfies typeof fetch,
    };
    await expect(provisionForAssistant(f.paths, f.a.instanceId, {}, dependencies)).rejects.toMatchObject({
      code: 'web_not_ready',
    });
    expect((await readWebPolicy(instanceWebPolicyFile(f.a.runtime))).enabled).toBe(false);
    expect((await readWebOperatorConfig(f.files.configFile))?.assistants[f.a.instanceId]).toMatchObject({
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
        args[0] === 'gws-ea-web-health'
          ? { policyVersions: [1], enabled: false, availability: 'unavailable', listener: { state: 'stopped' } }
          : f.dependencies.ncl(runtime, args),
    };
    await expect(provisionForAssistant(f.paths, f.a.instanceId, {}, dependencies)).rejects.toMatchObject({
      code: 'web_listener_unavailable',
    });
    expect((await readWebPolicy(instanceWebPolicyFile(f.a.runtime))).enabled).toBe(false);
    expect(f.api.ingress().some((route) => route.hostname === 'views.example.test')).toBe(false);
    expect(f.commands.some((args) => args[0] === 'bootstrap')).toBe(false);
    expect(now - started).toBe(30_000);
  });

  it('retains a lost DNS create and never adopts a matching unrecorded DNS record', async () => {
    const f = await provisionFixture();
    f.api.lose('dns');
    await expect(provisionForAssistant(f.paths, f.a.instanceId, {}, f.dependencies)).rejects.toMatchObject({
      code: 'web_cloudflare_unavailable',
    });
    expect((await readWebOperatorConfig(f.files.configFile))?.pending).toMatchObject({
      kind: 'dns',
      target: 'views.example.test',
    });
    await expect(provisionForAssistant(f.paths, f.a.instanceId, {}, f.dependencies)).rejects.toMatchObject({
      code: 'web_create_unproven',
    });
    expect(f.api.dns).toHaveLength(1);
    const pending = (await readWebOperatorConfig(f.files.configFile))?.pending;
    await expect(
      provisionForAssistant(f.paths, f.a.instanceId, { discardUnproven: pending?.key }, f.dependencies),
    ).rejects.toMatchObject({ code: 'web_dns_conflict' });
    expect(f.api.dns).toHaveLength(1);
  });

  it('reports a missing operator account and never provisions with incomplete domain configuration', async () => {
    const f = await provisionFixture();
    await rm(f.files.configFile);
    await expect(provisionForAssistant(f.paths, f.a.instanceId, {}, f.dependencies)).rejects.toMatchObject({
      code: 'web_operator_required',
    });
    expect(f.api.requests).toEqual([]);
  });

  it('refuses account permission failures and application limits without reporting enabled', async () => {
    const f = await provisionFixture();
    f.api.reject(403);
    await expect(provisionForAssistant(f.paths, f.a.instanceId, {}, f.dependencies)).rejects.toMatchObject({
      code: 'web_cloudflare_forbidden',
    });
    expect((await readWebPolicy(instanceWebPolicyFile(f.a.runtime))).enabled).toBe(false);
    f.api.reject(undefined);
    for (let index = 0; index < 500; index++)
      f.api.apps.push({
        id: `foreign-${index}`,
        type: 'self_hosted',
        destinations: [{ type: 'public', uri: `foreign-${index}.example.test` }],
      });
    await expect(provisionForAssistant(f.paths, f.a.instanceId, {}, f.dependencies)).rejects.toMatchObject({
      code: 'web_cloudflare_capacity',
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
      code: 'web_hostname_foreign',
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
          uri: 'views.example.test/artifacts',
          overrides: [{ behavior: 'public', path_pattern: '/artifacts/public/*' }],
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
      { hostname: 'views.example.test', path: '^/artifacts(/|$)', service: 'http://127.0.0.1:41000' },
      { service: 'http_status:404' },
    ]);
    const policy = await readWebPolicy(instanceWebPolicyFile(f.a.runtime));
    expect(policy).toMatchObject({ enabled: true, config: { accessAud: app.aud } });
    const owned = await readWebOperatorConfig(f.files.configFile);
    expect(owned).toMatchObject({
      pin: { owned: true },
      tunnelId: 'tunnel',
      assistants: { [f.a.instanceId]: { applicationId: app.id, policyId: expect.any(String), enabled: true } },
    });
    expect((await stat(f.files.tokenFile)).mode & 0o777).toBe(0o600);
    expect(await readFile(f.files.tokenFile, 'utf8')).toBe('secret-run-fixture');
    expect(JSON.stringify(f.commands)).not.toContain('secret-run-fixture');
    expect(
      JSON.stringify(await inspectWebCapability(f.paths, f.a.instanceId, { ...f.dependencies, check: true })),
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
    const claim = (await getInstanceReservation(f.paths, f.a.instanceId)).exclusive_resource_claims.web;
    if (!claim) throw new Error('Fixture namespace is missing');
    await releaseInstanceWeb(f.paths, f.a.instanceId, claim);
    f.api.lose('application');
    await expect(provisionForAssistant(f.paths, f.a.instanceId, {}, f.dependencies)).rejects.toMatchObject({
      code: 'web_cloudflare_unavailable',
    });
    const pending = (await readWebOperatorConfig(f.files.configFile))?.pending;
    expect(pending?.kind).toBe('application');
    expect((await getInstanceReservation(f.paths, f.a.instanceId)).exclusive_resource_claims.web).toBeDefined();
    await expect(provisionForAssistant(f.paths, f.a.instanceId, {}, f.dependencies)).rejects.toMatchObject({
      code: 'web_create_unproven',
    });
    expect(f.api.apps).toHaveLength(1);
    await expect(
      provisionForAssistant(f.paths, f.a.instanceId, { discardUnproven: 'wrong' }, f.dependencies),
    ).rejects.toMatchObject({ code: 'web_attempt_mismatch' });
    f.api.apps.splice(0); // The operator removed the unproven application before acknowledging it.
    await provisionForAssistant(f.paths, f.a.instanceId, { discardUnproven: pending?.key }, f.dependencies);
    expect(f.api.apps).toHaveLength(1);
    expect((await readWebOperatorConfig(f.files.configFile))?.resolvedAttempts).toEqual([
      expect.objectContaining({ kind: 'application', resolution: 'operator_removed', key: pending?.key }),
    ]);
  });

  it('recovers a lost full-config PUT by reading the exact current config without duplicate creates', async () => {
    const f = await provisionFixture();
    f.api.lose('put');
    await expect(provisionForAssistant(f.paths, f.a.instanceId, {}, f.dependencies)).rejects.toMatchObject({
      code: 'web_cloudflare_unavailable',
    });
    expect((await readWebPolicy(instanceWebPolicyFile(f.a.runtime))).enabled).toBe(false);
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
    expect(await inspectWebCapability(f.paths, f.a.instanceId, { ...f.dependencies, check: true })).toMatchObject({
      ready: false,
      remote: 'mismatch',
    });
    expect(f.api.requests.slice(start).every((request) => request.method === 'GET')).toBe(true);
    expect(await readFile(f.files.configFile, 'utf8')).toBe(before);
    f.api.reject(403);
    const shown = await inspectWebCapability(f.paths, f.a.instanceId, { ...f.dependencies, check: true });
    expect(JSON.stringify(shown)).not.toContain('secret-management-fixture');
    expect(shown.reason).toContain('permissions');
  });

  it('read-verifies exact email changes, reuses existing admission and revokes sessions after reduction', async () => {
    const f = await provisionFixture();
    await provisionForAssistant(f.paths, f.a.instanceId, {}, f.dependencies);
    const config = await readWebOperatorConfig(f.files.configFile);
    const applicationId = config!.assistants[f.a.instanceId].applicationId!;
    const input = {
      operatorConfigFile: f.files.configFile,
      accountId: 'account',
      applicationId,
      emails: async () => ['principal@example.test', 'guest@example.test'],
    };
    const first = await reconcileWebAccessEmails(input, f.dependencies);
    expect(first).toEqual({ verified: true, changed: true, emails: ['guest@example.test', 'principal@example.test'] });
    expect(
      f.api.requests.some((request) => request.method === 'POST' && request.resource.endsWith('/revoke_tokens')),
    ).toBe(true);
    const start = f.api.requests.length;
    expect(await reconcileWebAccessEmails(input, f.dependencies)).toMatchObject({ changed: false });
    expect(f.api.requests.slice(start).every((request) => request.method === 'GET')).toBe(true);
  });
  it('serializes first-name claims and preserves the winner across rename', async () => {
    const f = await fixture();
    const a = await f.assistant('a@example.test', 31000);
    const b = await f.assistant('b@example.test', 31002);
    const results = await Promise.allSettled([
      claimInstanceWeb(f.paths, a.instanceId, {
        hostname: 'views.example.test',
        listen_port: 41000,
      }),
      claimInstanceWeb(f.paths, b.instanceId, {
        hostname: 'views.example.test',
        listen_port: 41001,
      }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const winner = results[0].status === 'fulfilled' ? a : b;
    await expect(
      claimInstanceWeb(f.paths, winner.instanceId, {
        hostname: 'renamed.example.test',
        listen_port: 41000,
      }),
    ).rejects.toMatchObject({ code: 'claim_conflict' });
    expect((await getInstanceReservation(f.paths, winner.instanceId)).exclusive_resource_claims.web?.hostname).toBe(
      'views.example.test',
    );
  });

  it('shows a stopped origin policy without changing its owner-only file', async () => {
    const f = await fixture();
    const a = await f.assistant('a@example.test', 31000);
    const policyFile = instanceWebPolicyFile(a.runtime);
    await mkdir(path.dirname(policyFile), { recursive: true, mode: 0o700 });
    await writeFile(
      policyFile,
      JSON.stringify({
        schemaVersion: 1,
        enabled: true,
        hostname: 'views.example.test',
        listenPort: 41000,
        accessIssuer: 'https://example.cloudflareaccess.com',
        accessAud: 'aud',
        cloudflare: {
          accountId: 'account',
          applicationId: 'app',
          operatorConfigFile: path.join(f.paths.configRoot, 'web', 'config.json'),
        },
      }),
      { mode: 0o600 },
    );
    const policy = await readWebPolicy(policyFile);
    if (policy.status === 'unavailable' || !policy.config) throw new Error('Missing fixture policy');
    await writeFile(policyFile, JSON.stringify({ ...policy.config, enabled: false }), { mode: 0o600 });
    expect((await readWebPolicy(policyFile)).enabled).toBe(false);
    const before = await readFile(policyFile, 'utf8');
    const shown = await inspectWebCapability(f.paths, a.instanceId);
    expect(shown.activation).toBe('disabled');
    expect(await readFile(policyFile, 'utf8')).toBe(before);
    expect((await stat(policyFile)).mode & 0o777).toBe(0o600);
  });
});

it('installs for every compatible reachable assistant and reports stopped assistants pending', async () => {
  const f = await provisionFixture();
  const stopped = await f.assistant('stopped@example.test', 31002);
  const installed = await installWebConnector(
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
        reason: 'web_host_unavailable',
      }),
    ]),
  );
  expect((await readWebOperatorConfig(f.files.configFile))?.assistants[stopped.instanceId]).toBeUndefined();
});

it('provisions a previously stopped assistant through its existing instance operation', async () => {
  const f = await provisionFixture();
  const result = await withInstanceOperation(f.paths, f.a.instanceId, (operation) =>
    provisionAssistantWeb(operation, f.dependencies),
  );
  expect(result).toMatchObject({ instance_id: f.a.instanceId, outcome: 'ready', changed: true });
  const again = await withInstanceOperation(f.paths, f.a.instanceId, (operation) =>
    provisionAssistantWeb(operation, f.dependencies),
  );
  expect(again).toMatchObject({ outcome: 'ready', changed: false });
  expect(f.restarts).toHaveLength(2);
});

it('waits for an already activated listener without reprovisioning or restarting authors', async () => {
  const f = await provisionFixture();
  await withInstanceOperation(f.paths, f.a.instanceId, (operation) => provisionAssistantWeb(operation, f.dependencies));
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
      if (args[0] === 'gws-ea-web-health' && ++probes <= 3)
        return { policyVersions: [1], enabled: true, listener: { state: 'starting' } };
      return f.dependencies.ncl(runtime, args);
    },
  };
  const result = await withInstanceOperation(f.paths, f.a.instanceId, (operation) =>
    provisionAssistantWeb(operation, dependencies),
  );
  expect(result).toMatchObject({ outcome: 'ready', changed: false });
  expect(waits).toBeGreaterThan(0);
  expect(f.api.requests.filter((request) => request.resource === '/zones/zone')).toHaveLength(providerReads + 1);
  expect(f.api.requests.filter((request) => request.method !== 'GET')).toHaveLength(mutations);
  expect(f.restarts).toHaveLength(restarts);
});

it('keeps an activated configuration intact when its listener does not recover within the bound', async () => {
  const f = await provisionFixture();
  await withInstanceOperation(f.paths, f.a.instanceId, (operation) => provisionAssistantWeb(operation, f.dependencies));
  const before = await readWebOperatorConfig(f.files.configFile);
  const policy = await readFile(instanceWebPolicyFile(f.a.runtime), 'utf8');
  const mutations = f.api.requests.filter((request) => request.method !== 'GET').length;
  const restarts = f.restarts.length;
  let clock = Date.now();
  const started = clock;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  const result = await withInstanceOperation(f.paths, f.a.instanceId, (operation) =>
    provisionAssistantWeb(operation, {
      ...f.dependencies,
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
      ncl: async (runtime, args) =>
        args[0] === 'gws-ea-web-health'
          ? { policyVersions: [1], enabled: true, listener: { state: 'starting' } }
          : f.dependencies.ncl(runtime, args),
    }),
  );
  expect(result).toMatchObject({ outcome: 'pending', reason: 'web_listener_unavailable', changed: false });
  expect(clock - started).toBe(30_000);
  expect(await readWebOperatorConfig(f.files.configFile)).toEqual(before);
  expect(await readFile(instanceWebPolicyFile(f.a.runtime), 'utf8')).toBe(policy);
  expect(f.api.requests.filter((request) => request.method !== 'GET')).toHaveLength(mutations);
  expect(f.restarts).toHaveLength(restarts);
});

it('keeps an incomplete profile pending without creating provider resources', async () => {
  const f = await provisionFixture();
  const result = await installWebConnector(
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
      reason: 'web_profile_unavailable',
    }),
  );
  expect(f.api.requests).toEqual([]);
});

it('reports unsupported and malformed release markers independently from profile readiness', async () => {
  const f = await provisionFixture();
  const marker = path.join(f.a.runtime.checkout_root, 'src/gws-ea/web-compatibility.json');
  await rm(marker);
  expect(await webReleaseCompatibility(f.a.runtime.checkout_root)).toBe('unsupported');
  const unsupported = await installWebConnector(f.paths, {}, f.dependencies);
  expect(unsupported.assistants).toContainEqual(
    expect.objectContaining({ outcome: 'unsupported', reason: 'release_unsupported' }),
  );
  await writeFile(marker, '{');
  expect(await webReleaseCompatibility(f.a.runtime.checkout_root)).toBe('unknown');
  const unknown = await installWebConnector(f.paths, {}, f.dependencies);
  expect(unknown.assistants).toContainEqual(expect.objectContaining({ outcome: 'pending', reason: 'release_unknown' }));
  expect(f.api.requests).toEqual([]);
});

it('rotates only the stored management token when reinstalling with a credential file', async () => {
  const f = await provisionFixture();
  await installWebConnector(f.paths, {}, f.dependencies);
  const before = await readWebOperatorConfig(f.files.configFile);
  const credentialFile = path.join(f.paths.configRoot, 'replacement-token');
  await writeFile(credentialFile, 'replacement-management-fixture', { mode: 0o600 });
  const repeated = await installWebConnector(f.paths, { credentialFile }, f.dependencies);
  expect(repeated.changed).toBe(true);
  expect(await readFile(before!.credentialFile, 'utf8')).toBe('replacement-management-fixture');
  expect((await readWebOperatorConfig(f.files.configFile))?.assistants).toEqual(before?.assistants);
  expect(f.restarts).toHaveLength(2);
});

it('reports a single unproven provider creation pending for every assistant without further effects', async () => {
  const f = await provisionFixture();
  await f.assistant('second@example.test', 31002);
  f.api.lose('application');
  const initial = await installWebConnector(f.paths, {}, f.dependencies);
  expect(initial.assistants).toHaveLength(2);
  const before = f.api.requests.length;
  const repeated = await installWebConnector(f.paths, {}, f.dependencies);
  expect(
    repeated.assistants.every(
      (assistant) => assistant.outcome === 'pending' && assistant.reason === 'web_create_unproven',
    ),
  ).toBe(true);
  expect(f.api.requests).toHaveLength(before);
  expect(f.api.apps).toHaveLength(1);
});

it('returns a pending operation hook immediately while the host connector lock is held', async () => {
  const f = await provisionFixture();
  await withWebHostLock(f.paths, async () => {
    const result = await withInstanceOperation(f.paths, f.a.instanceId, (operation) =>
      provisionAssistantWeb(operation, f.dependencies),
    );
    expect(result).toMatchObject({ outcome: 'pending', reason: 'web_busy', changed: false });
  });
  expect(f.api.requests).toEqual([]);
});

it.each([
  503,
  429,
  'network',
  'reconnecting',
  'malformed DNS',
  'malformed DNS empty',
  'malformed DNS missing content',
  'malformed Access',
  'malformed tunnel',
] as const)('keeps a published assistant intact when verification is unavailable (%s)', async (failure) => {
  const f = await provisionFixture();
  await withInstanceOperation(f.paths, f.a.instanceId, (operation) => provisionAssistantWeb(operation, f.dependencies));
  const config = await readFile(f.files.configFile, 'utf8');
  const policy = await readFile(instanceWebPolicyFile(f.a.runtime), 'utf8');
  const restarts = f.restarts.length;
  const mutations = f.api.requests.filter((request) => request.method !== 'GET').length;
  const send: typeof fetch = async (input, init) => {
    if (failure === 'network') throw new Error('An observed transport outage');
    if (typeof failure === 'string' && failure.startsWith('malformed DNS') && /\/dns_records\//u.test(String(input))) {
      const { content: _content, ...incomplete } = f.api.dns[0];
      return Response.json({
        success: true,
        result: failure === 'malformed DNS' ? null : failure === 'malformed DNS empty' ? {} : incomplete,
      });
    }
    if (failure === 'malformed Access' && /\/access\/apps\/[^/]+$/u.test(String(input)))
      return Response.json({ success: true, result: {} });
    if (failure === 'malformed tunnel' && /\/cfd_tunnel\/tunnel$/u.test(String(input)))
      return Response.json({ success: true, result: {} });
    if (typeof failure === 'number') return Response.json({ success: false }, { status: failure });
    if (String(input).endsWith('/connections'))
      return Response.json({ success: true, result: [{ is_pending_reconnect: true }] });
    return f.api.transport(input, init);
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await withInstanceOperation(f.paths, f.a.instanceId, (operation) =>
      provisionAssistantWeb(operation, { ...f.dependencies, fetch: send }),
    );
    expect(result).toMatchObject({ outcome: 'pending', changed: false });
  }
  expect(await readFile(f.files.configFile, 'utf8')).toBe(config);
  expect(await readFile(instanceWebPolicyFile(f.a.runtime), 'utf8')).toBe(policy);
  expect(f.api.requests.filter((request) => request.method !== 'GET')).toHaveLength(mutations);
  expect(f.restarts).toHaveLength(restarts);
});

it.each([false, true])(
  'releases a newly claimed namespace after early provisioning failure (stale disabled policy: %s)',
  async (stalePolicy) => {
    const f = await provisionFixture();
    const oldClaim = (await getInstanceReservation(f.paths, f.a.instanceId)).exclusive_resource_claims.web;
    if (!oldClaim) throw new Error('Fixture namespace is missing');
    await releaseInstanceWeb(f.paths, f.a.instanceId, oldClaim);
    if (stalePolicy) {
      const policyFile = instanceWebPolicyFile(f.a.runtime);
      await mkdir(path.dirname(policyFile), { recursive: true, mode: 0o700 });
      await writeFile(
        policyFile,
        JSON.stringify({
          schemaVersion: 1,
          enabled: false,
          hostname: oldClaim.hostname,
          listenPort: oldClaim.listen_port,
          accessIssuer: 'https://team.cloudflareaccess.com',
          accessAud: 'retired-aud',
          cloudflare: {
            accountId: 'account',
            applicationId: 'retired-app',
            operatorConfigFile: f.files.configFile,
          },
        }),
        { mode: 0o600 },
      );
    }
    const config = (await readWebOperatorConfig(f.files.configFile))!;
    await writeWebOperatorConfig(f.files.configFile, { ...config, teamName: 'wrong-team' });
    const failed = await installWebConnector(f.paths, {}, f.dependencies);
    expect(failed.assistants).toEqual([
      expect.objectContaining({ instance_id: f.a.instanceId, outcome: 'pending', reason: 'web_team_invalid' }),
    ]);
    expect((await getInstanceReservation(f.paths, f.a.instanceId)).exclusive_resource_claims.web).toBeUndefined();
    expect((await readWebOperatorConfig(f.files.configFile))?.assistants).toEqual({});
    expect(await uninstallWebConnector(f.paths, f.dependencies)).toMatchObject({ outcome: 'removed' });
    const source = path.join(f.paths.configRoot, 'corrected-management-credential');
    await writeFile(source, 'secret-corrected-management-fixture', { mode: 0o600 });
    const corrected = await installWebConnector(
      f.paths,
      {
        accountId: 'account',
        teamName: 'team',
        zoneId: 'zone',
        credentialFile: source,
        cloudflaredPath: '/usr/bin/true',
      },
      f.dependencies,
    );
    expect(corrected.assistants).toEqual([expect.objectContaining({ instance_id: f.a.instanceId, outcome: 'ready' })]);
  },
);

it('repairs a positively observed Access admission mismatch on a published assistant', async () => {
  const f = await provisionFixture();
  await withInstanceOperation(f.paths, f.a.instanceId, (operation) => provisionAssistantWeb(operation, f.dependencies));
  const config = (await readWebOperatorConfig(f.files.configFile))!;
  const assistant = config.assistants[f.a.instanceId];
  const policies = f.api.policies.get(assistant.applicationId!);
  if (!policies?.[0]) throw new Error('Fixture policy missing');
  policies[0].include = [{ email: { email: 'outdated@example.test' } }];
  expect(await inspectWebCapability(f.paths, f.a.instanceId, { ...f.dependencies, check: true })).toMatchObject({
    remote: 'mismatch',
  });
  const beforePolicy = await readFile(instanceWebPolicyFile(f.a.runtime), 'utf8');
  const restarts = f.restarts.length;
  const result = await withInstanceOperation(f.paths, f.a.instanceId, (operation) =>
    provisionAssistantWeb(operation, f.dependencies),
  );
  expect(await readFile(instanceWebPolicyFile(f.a.runtime), 'utf8')).toBe(beforePolicy);
  expect(f.restarts).toHaveLength(restarts);
  expect(result).toMatchObject({ outcome: 'ready', changed: true });
  expect(await inspectWebCapability(f.paths, f.a.instanceId, { ...f.dependencies, check: true })).toMatchObject({
    ready: true,
  });
});

it('retains an unproven application creation and its recorded-DNS claim through uninstall', async () => {
  const f = await provisionFixture();
  const existingClaim = (await getInstanceReservation(f.paths, f.a.instanceId)).exclusive_resource_claims.web;
  if (!existingClaim) throw new Error('Fixture namespace is missing');
  await releaseInstanceWeb(f.paths, f.a.instanceId, existingClaim);
  f.api.lose('application');
  const result = await installWebConnector(f.paths, {}, f.dependencies);
  expect(result.assistants).toEqual([
    expect.objectContaining({
      instance_id: f.a.instanceId,
      outcome: 'pending',
      reason: 'web_cloudflare_unavailable',
    }),
  ]);
  const pending = (await readWebOperatorConfig(f.files.configFile))?.pending;
  expect(pending).toMatchObject({ kind: 'application', target: f.a.instanceId });
  const retainedClaim = (await getInstanceReservation(f.paths, f.a.instanceId)).exclusive_resource_claims.web;
  expect(retainedClaim).toBeDefined();
  expect(await uninstallWebConnector(f.paths, f.dependencies)).toMatchObject({ outcome: 'pending' });
  expect((await getInstanceReservation(f.paths, f.a.instanceId)).exclusive_resource_claims.web).toEqual(retainedClaim);
  expect((await readWebOperatorConfig(f.files.configFile))?.pending).toEqual(pending);
  await expect(installWebConnector(f.paths, {}, f.dependencies)).rejects.toMatchObject({
    code: 'web_uninstall_incomplete',
  });
});

async function releaseFixtureClaim(f: Awaited<ReturnType<typeof provisionFixture>>): Promise<void> {
  const claim = (await getInstanceReservation(f.paths, f.a.instanceId)).exclusive_resource_claims.web;
  if (!claim) throw new Error('Fixture claim is missing');
  await releaseInstanceWeb(f.paths, f.a.instanceId, claim);
}

it.each([
  ['Aya', 'aya'],
  ['Mary Jane', 'maryjane'],
  ['Zoë', 'zoe'],
  ['Søren', 'soren'],
  ['Łukasz', 'lukasz'],
  ['Weiß', 'weiss'],
  ['Ægir Œ Đ Ð Þ', 'aegiroeddth'],
  ['A'.repeat(70), 'a'.repeat(63)],
])('claims the ASCII first-name hostname for %s', async (name, label) => {
  const f = await provisionFixture();
  await releaseFixtureClaim(f);
  f.firstName(name);
  const result = await provisionForAssistant(f.paths, f.a.instanceId, {}, f.dependencies);
  expect(result.hostname).toBe(`${label}.example.test`);
  const claim = (await getInstanceReservation(f.paths, f.a.instanceId)).exclusive_resource_claims.web;
  expect(claim).toEqual({ hostname: `${label}.example.test`, listen_port: expect.any(Number) });
  expect(f.api.apps[0].destinations).toEqual([
    {
      type: 'public',
      uri: `${label}.example.test/artifacts`,
      overrides: [{ behavior: 'public', path_pattern: '/artifacts/public/*' }],
    },
  ]);
  f.firstName('李娜');
  expect((await provisionForAssistant(f.paths, f.a.instanceId, {}, f.dependencies)).hostname).toBe(
    `${label}.example.test`,
  );
});

it('reports an unusable first name without storing a claim or creating resources', async () => {
  const f = await provisionFixture();
  await releaseFixtureClaim(f);
  f.firstName('李娜');
  const result = await installWebConnector(f.paths, {}, f.dependencies);
  expect(result.assistants).toContainEqual(
    expect.objectContaining({ outcome: 'pending', reason: 'web_name_unusable' }),
  );
  expect((await getInstanceReservation(f.paths, f.a.instanceId)).exclusive_resource_claims.web).toBeUndefined();
  expect(f.api.requests.filter((request) => request.method !== 'GET')).toEqual([]);
});

it('names the existing hostname holder without claiming or creating for a second assistant', async () => {
  const f = await provisionFixture();
  await releaseFixtureClaim(f);
  f.firstName('Aya');
  await provisionForAssistant(f.paths, f.a.instanceId, {}, f.dependencies);
  const second = await f.assistant('second@example.test', 31002);
  const mutations = f.api.requests.filter((request) => request.method !== 'GET').length;
  const result = await installWebConnector(f.paths, {}, f.dependencies);
  expect(result.assistants).toContainEqual(
    expect.objectContaining({
      instance_id: second.instanceId,
      outcome: 'pending',
      reason: 'web_hostname_claimed',
      message: expect.stringContaining(f.a.instanceId),
    }),
  );
  expect((await getInstanceReservation(f.paths, second.instanceId)).exclusive_resource_claims.web).toBeUndefined();
  expect(f.api.requests.filter((request) => request.method !== 'GET')).toHaveLength(mutations);
});

it.each(['exact DNS', 'wildcard DNS', 'wildcard Access', 'own tunnel'] as const)(
  'preflights foreign %s before storing a claim or creating resources',
  async (kind) => {
    const f = await provisionFixture();
    await releaseFixtureClaim(f);
    f.firstName('Aya');
    if (kind.endsWith('DNS'))
      f.api.dns.push({ id: 'foreign-dns', name: kind === 'exact DNS' ? 'aya.example.test' : '*.example.test' });
    if (kind === 'wildcard Access')
      f.api.apps.push({ id: 'foreign-app', destinations: [{ type: 'public', uri: '*.example.test/artifacts' }] });
    if (kind === 'own tunnel') {
      const config = (await readWebOperatorConfig(f.files.configFile))!;
      await writeWebOperatorConfig(f.files.configFile, { ...config, tunnelId: 'tunnel' });
      f.api.ingress().unshift({ hostname: 'aya.example.test', service: 'http://127.0.0.1:9999' });
    }
    const result = await installWebConnector(f.paths, {}, f.dependencies);
    expect(result.assistants).toContainEqual(
      expect.objectContaining({
        outcome: 'pending',
        reason: 'web_hostname_foreign',
        message: expect.stringContaining('aya.example.test'),
      }),
    );
    expect((await getInstanceReservation(f.paths, f.a.instanceId)).exclusive_resource_claims.web).toBeUndefined();
    expect(f.api.requests.filter((request) => request.method !== 'GET')).toEqual([]);
  },
);

it('releases a resource-free claim when DNS creation loses a name race, without creating Access', async () => {
  const f = await provisionFixture();
  await releaseFixtureClaim(f);
  const result = await installWebConnector(
    f.paths,
    {},
    {
      ...f.dependencies,
      fetch: async (input, init) =>
        String(input).endsWith('/dns_records') && init?.method === 'POST'
          ? Response.json({ success: false }, { status: 409 })
          : f.api.transport(input, init),
    },
  );
  expect(result.assistants).toContainEqual(
    expect.objectContaining({ outcome: 'pending', reason: 'web_cloudflare_rejected' }),
  );
  expect((await getInstanceReservation(f.paths, f.a.instanceId)).exclusive_resource_claims.web).toBeUndefined();
  expect(f.api.apps).toEqual([]);
  expect(f.api.policies.size).toBe(0);
  expect(f.api.ingress().filter((route) => route.hostname === 'avery.example.test')).toEqual([]);
});

it.each(['recorded', 'pending'] as const)('retains a fresh claim when its first DNS create is %s', async (state) => {
  const f = await provisionFixture();
  await releaseFixtureClaim(f);
  if (state === 'pending') f.api.lose('dns');
  const result = await installWebConnector(
    f.paths,
    {},
    {
      ...f.dependencies,
      fetch: async (input, init) =>
        state === 'recorded' && String(input).endsWith('/access/apps') && init?.method === 'POST'
          ? Response.json({ success: false }, { status: 409 })
          : f.api.transport(input, init),
    },
  );
  expect(result.assistants).toContainEqual(expect.objectContaining({ outcome: 'pending' }));
  expect((await getInstanceReservation(f.paths, f.a.instanceId)).exclusive_resource_claims.web?.hostname).toBe(
    'avery.example.test',
  );
  const config = (await readWebOperatorConfig(f.files.configFile))!;
  if (state === 'recorded')
    expect(config.dns['avery.example.test']).toEqual({ id: expect.any(String), zoneId: 'zone' });
  else expect(config.pending).toMatchObject({ kind: 'dns', target: 'avery.example.test' });
  expect(f.api.apps).toEqual([]);
});

it.each(['wrong team', 'outside account', 'inactive zone'] as const)(
  'rejects %s before writing first operator configuration',
  async (failure) => {
    const f = await fixture();
    await mkdir(f.paths.configRoot, { recursive: true, mode: 0o700 });
    const credentialFile = path.join(f.paths.configRoot, 'source-token');
    await writeFile(credentialFile, 'secret-management-fixture', { mode: 0o600 });
    const api = cloudflareFixture();
    await expect(
      installWebConnector(
        f.paths,
        {
          accountId: 'account',
          teamName: failure === 'wrong team' ? 'wrong' : 'team',
          zoneId: 'zone',
          credentialFile,
          cloudflaredPath: '/usr/bin/true',
        },
        {
          fetch: async (input, init) => {
            if (String(input).endsWith('/zones/zone') && failure !== 'wrong team')
              return Response.json({
                success: true,
                result: {
                  id: 'zone',
                  name: 'example.test',
                  status: failure === 'inactive zone' ? 'pending' : 'active',
                  account: { id: failure === 'outside account' ? 'foreign' : 'account' },
                },
              });
            return api.transport(input, init);
          },
        },
      ),
    ).rejects.toMatchObject({ code: failure === 'wrong team' ? 'web_team_invalid' : 'web_zone_invalid' });
    expect(await readWebOperatorConfig(webOperatorFiles(f.paths).configFile)).toBeUndefined();
    await expect(readFile(path.join(webOperatorFiles(f.paths).root, 'management-token'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  },
);

it('publishes the Web failure code through the connector result contract', async () => {
  const f = await provisionFixture();
  await provisionForAssistant(f.paths, f.a.instanceId, {}, f.dependencies);
  f.api.reject(503);
  const observation = await inspectConnector(f.paths, 'web', {
    instanceId: f.a.instanceId,
    check: true,
    web: f.dependencies,
  });
  expect(observation.details).toEqual([
    expect.objectContaining({ reason_code: 'web_cloudflare_rejected', activation: 'enabled' }),
  ]);
  expect(observation.assistants[0]).toMatchObject({ setup: 'installed', readiness: { status: 'not_ready' } });
  expectResultContract(
    'connectors check web',
    managedResult('connectors check web', { outcome: 'failed', data: observation }),
  );
});

it.each(['DNS', 'Access'] as const)(
  'closes tools after Cloudflare confirms the owned %s resource points elsewhere',
  async (resource) => {
    const f = await provisionFixture();
    await provisionForAssistant(f.paths, f.a.instanceId, {}, f.dependencies);
    if (resource === 'DNS') f.api.dns[0].content = 'foreign.cfargotunnel.com';
    else f.api.apps[0].destinations = [{ type: 'public', uri: 'foreign.example.test/artifacts' }];
    const result = await installWebConnector(f.paths, {}, f.dependencies);
    expect(result.assistants).toContainEqual(
      expect.objectContaining({
        outcome: 'pending',
        reason: resource === 'DNS' ? 'web_dns_mismatch' : 'web_application_mismatch',
      }),
    );
    expect((await readWebPolicy(instanceWebPolicyFile(f.a.runtime))).enabled).toBe(false);
    expect((await readWebOperatorConfig(f.files.configFile))?.assistants[f.a.instanceId].enabled).toBe(false);
    if (resource === 'DNS') expect(f.api.dns[0].content).toBe('foreign.cfargotunnel.com');
    else expect(f.api.apps[0].destinations).toEqual([{ type: 'public', uri: 'foreign.example.test/artifacts' }]);
  },
);

it('repairs a missing owned ingress route without closing tools or recreating resources', async () => {
  const f = await provisionFixture();
  await provisionForAssistant(f.paths, f.a.instanceId, {}, f.dependencies);
  const policy = await readFile(instanceWebPolicyFile(f.a.runtime), 'utf8');
  const config = await readWebOperatorConfig(f.files.configFile);
  const restarts = f.restarts.length;
  const creates = f.api.requests.filter((request) => request.method === 'POST').length;
  const index = f.api.ingress().findIndex((route) => route.hostname === 'views.example.test');
  f.api.ingress().splice(index, 1);
  expect(await inspectWebCapability(f.paths, f.a.instanceId, { ...f.dependencies, check: true })).toMatchObject({
    remote: 'mismatch',
    reason_code: 'web_tunnel_unverified',
  });
  const result = await provisionForAssistant(f.paths, f.a.instanceId, {}, f.dependencies);
  expect(result).toMatchObject({ outcome: 'ready', changed: true });
  expect(await readFile(instanceWebPolicyFile(f.a.runtime), 'utf8')).toBe(policy);
  expect((await readWebOperatorConfig(f.files.configFile))?.assistants).toEqual(config?.assistants);
  expect(f.restarts).toHaveLength(restarts);
  expect(f.api.requests.filter((request) => request.method === 'POST')).toHaveLength(creates);
});
