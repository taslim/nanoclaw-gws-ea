import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CloudflareAmbiguousMutationError,
  createCloudflareApi,
  createManagedIngressSetupSession,
  type CloudflareApi,
} from './cloudflare-api.js';
import { resolveControlPlanePaths } from './paths.js';
import { redact, REDACTED } from './redact.js';
import { startRunLog } from './run-log.js';

const TOKEN = 'cf-account-token-canary';
const ACCOUNT_ID = '699d98642c564d2e855e9661899b7252';
const ZONE_ID = '023e105f4ecef8ad9ca31a8372d0c353';
const TUNNEL_ID = 'f70ff985-a4ef-4643-bbbc-4a0ed4fc8415';
const RECORD_ID = '372e67954025e0ba6aaa6d586b9e0b59';
const CLIENT_ID = '1bedc50d-42b3-473c-b108-ff3d10c0d925';
const BASE_URL = 'https://api.cloudflare.test/client/v4';
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/**
 * Response shapes follow the documented Cloudflare API v4 schemas
 * (developers.cloudflare.com/api), including fields gws-ea never reads.
 */
function envelope(result: unknown, resultInfo?: Record<string, unknown>, init?: ResponseInit): Response {
  return Response.json(
    { success: true, errors: [], messages: [], result, ...(resultInfo ? { result_info: resultInfo } : {}) },
    init,
  );
}

function failure(status: number, errors: readonly { code: number; message: string }[], headers = {}): Response {
  return Response.json({ success: false, errors, messages: [], result: null }, { status, headers });
}

const zone = {
  id: ZONE_ID,
  name: 'example.com',
  status: 'active',
  paused: false,
  type: 'full',
  development_mode: 0,
  name_servers: ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'],
  original_name_servers: null,
  original_registrar: null,
  original_dnshost: null,
  created_on: '2026-01-02T00:00:00.000000Z',
  modified_on: '2026-01-02T00:00:00.000000Z',
  activated_on: '2026-01-02T00:01:00.000000Z',
  meta: { step: 4, custom_certificate_quota: 0, page_rule_quota: 3, phishing_detected: false },
  owner: { id: null, type: 'user', email: null },
  account: { id: ACCOUNT_ID, name: 'Example account' },
  tenant: { id: null, name: null },
  tenant_unit: { id: null },
  permissions: ['#dns_records:edit', '#zone:read'],
  plan: { id: '0feeeeeeeeeeeeeeeeeeeeeeeeeeeeee', name: 'Free Website', price: 0, currency: 'USD', legacy_id: 'free' },
};

const tunnel = {
  id: TUNNEL_ID,
  account_tag: ACCOUNT_ID,
  created_at: '2026-09-20T10:00:00.000000Z',
  deleted_at: null,
  name: 'gws-ea-owned',
  // Deprecated and removed by Cloudflare on 2026-10-05; nothing may read it.
  connections: 'removed',
  conns_active_at: '2026-09-20T10:05:00.000000Z',
  conns_inactive_at: null,
  metadata: {},
  remote_config: true,
  config_src: 'cloudflare',
  status: 'healthy',
  tun_type: 'cfd_tunnel',
};

const dnsRecord = {
  id: RECORD_ID,
  name: 'assistant.example.com',
  type: 'CNAME',
  content: `${TUNNEL_ID}.cfargotunnel.com`,
  proxiable: true,
  proxied: true,
  ttl: 1,
  settings: { flatten_cname: false },
  meta: {},
  comment: 'gws-ea managed ingress 0d8f6f7e-3c2b-4a1d-9e8f-7a6b5c4d3e2f',
  tags: [],
  created_on: '2026-09-20T10:00:00.000000Z',
  modified_on: '2026-09-20T10:00:00.000000Z',
  comment_modified_on: '2026-09-20T10:00:00.000000Z',
};

const connectorClient = {
  id: CLIENT_ID,
  arch: 'linux_arm64',
  version: '2026.9.1',
  run_at: '2026-09-20T10:05:00.000000Z',
  features: ['ha-origin', 'serialized_headers'],
  conns: [
    {
      id: '5c9b7fd7-9cbf-4f42-8f8b-8a0e1b6bb7e3',
      uuid: '5c9b7fd7-9cbf-4f42-8f8b-8a0e1b6bb7e3',
      client_id: CLIENT_ID,
      client_version: '2026.9.1',
      colo_name: 'LHR',
      is_pending_reconnect: false,
      opened_at: '2026-09-20T10:05:01.000000Z',
      origin_ip: '198.51.100.7',
    },
  ],
};

function api(fetch: typeof globalThis.fetch, sleep = vi.fn(async () => undefined)): CloudflareApi {
  return createCloudflareApi({ accountToken: TOKEN, fetch, baseUrl: BASE_URL, sleep });
}

describe('Cloudflare REST readers', () => {
  it('reads the documented shapes through bearer auth only, never reading a tunnel connections field', async () => {
    const seen: Array<{ url: URL; init: RequestInit }> = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init = {}) => {
      const url = new URL(String(input));
      seen.push({ url, init });
      const route = url.pathname.replace('/client/v4', '');
      if (route === '/zones') {
        return envelope([zone], { page: 1, per_page: 50, count: 1, total_count: 1, total_pages: 1 });
      }
      if (route === `/accounts/${ACCOUNT_ID}/cfd_tunnel`) {
        return envelope([tunnel], { page: 1, per_page: 50, count: 1, total_count: 1 });
      }
      if (route === `/accounts/${ACCOUNT_ID}/cfd_tunnel/${TUNNEL_ID}/connections`) return envelope([connectorClient]);
      if (route === `/accounts/${ACCOUNT_ID}/cfd_tunnel/${TUNNEL_ID}/token`) return envelope('eyJhIjoiY29ubmVjdG9yIn0');
      if (route === `/zones/${ZONE_ID}/dns_records`) {
        return envelope([dnsRecord], { page: 1, per_page: 50, count: 1, total_count: 1, total_pages: 1 });
      }
      throw new Error(`unexpected ${route}`);
    });
    const client = api(fetch);

    await expect(client.listActiveZones()).resolves.toEqual([
      { zoneId: ZONE_ID, name: 'example.com', status: 'active', accountId: ACCOUNT_ID, accountName: 'Example account' },
    ]);
    await expect(client.listTunnels(ACCOUNT_ID, 'gws-ea-owned')).resolves.toEqual([
      { id: TUNNEL_ID, name: 'gws-ea-owned' },
    ]);
    await expect(client.listTunnelConnections(ACCOUNT_ID, TUNNEL_ID)).resolves.toEqual([{ id: CLIENT_ID }]);
    await expect(client.getTunnelToken(ACCOUNT_ID, TUNNEL_ID)).resolves.toBe('eyJhIjoiY29ubmVjdG9yIn0');
    await expect(client.listDnsRecords(ZONE_ID, 'assistant.example.com')).resolves.toEqual([
      {
        id: RECORD_ID,
        type: 'CNAME',
        name: 'assistant.example.com',
        content: `${TUNNEL_ID}.cfargotunnel.com`,
        proxied: true,
        comment: dnsRecord.comment,
      },
    ]);

    for (const { init } of seen) {
      const headers = new Headers(init.headers);
      expect(headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
      expect(headers.has('x-auth-email')).toBe(false);
      expect(headers.has('x-auth-key')).toBe(false);
    }
    expect(seen.every(({ url }) => !url.pathname.includes('/tunnels/'))).toBe(true);
    expect(JSON.stringify(seen.map(({ url, init }) => ({ url: String(url), body: init.body })))).not.toContain(TOKEN);
  });

  it('accepts a tunnel marked remote-managed by either documented field and refuses a locally managed one', async () => {
    const withoutSource = { ...tunnel, config_src: undefined };
    const local = { ...tunnel, config_src: 'local', remote_config: false };
    const reply = (value: unknown) =>
      api(vi.fn<typeof globalThis.fetch>(async () => envelope([value], { page: 1, per_page: 50, total_pages: 1 })));

    await expect(reply(withoutSource).listTunnels(ACCOUNT_ID, 'gws-ea-owned')).resolves.toHaveLength(1);
    await expect(reply(local).listTunnels(ACCOUNT_ID, 'gws-ea-owned')).rejects.toMatchObject({
      code: 'foreign_cloudflare_tunnel',
    });
  });

  it.each([
    { label: 'a fresh tunnel without config or version', result: { tunnel_id: TUNNEL_ID, source: 'cloudflare' } },
    { label: 'a missing result', result: undefined },
    { label: 'a null result', result: null },
    { label: 'a null config at version zero', result: { tunnel_id: TUNNEL_ID, config: null, version: 0 } },
  ])('treats $label as an empty configuration', async ({ result }) => {
    const body = result === undefined ? { success: true, errors: [], messages: [] } : undefined;
    const client = api(vi.fn<typeof globalThis.fetch>(async () => (body ? Response.json(body) : envelope(result))));

    await expect(client.getTunnelConfiguration(ACCOUNT_ID, TUNNEL_ID)).resolves.toEqual({ config: {}, version: 0 });
  });

  it('keeps a configured readback with per-rule origin settings, null ingress, and extra fields', async () => {
    const config = {
      ingress: [
        {
          hostname: 'assistant.example.com',
          path: '^/webhook/gchat$',
          service: 'http://127.0.0.1:3101',
          originRequest: {},
        },
        { service: 'http_status:404', originRequest: {} },
      ],
      'warp-routing': { enabled: false },
    };
    const readback = {
      account_id: ACCOUNT_ID,
      tunnel_id: TUNNEL_ID,
      version: 4,
      source: 'cloudflare',
      created_at: '2026-09-20T10:00:00.000000Z',
      config,
      future_field: { anything: true },
    };
    const client = api(vi.fn<typeof globalThis.fetch>(async () => envelope(readback)));
    await expect(client.getTunnelConfiguration(ACCOUNT_ID, TUNNEL_ID)).resolves.toEqual({ config, version: 4 });

    const nullIngress = api(
      vi.fn<typeof globalThis.fetch>(async () => envelope({ ...readback, config: { ingress: null }, version: 1 })),
    );
    await expect(nullIngress.getTunnelConfiguration(ACCOUNT_ID, TUNNEL_ID)).resolves.toEqual({
      config: { ingress: null },
      version: 1,
    });
  });

  it('refuses a configuration that is not remotely managed or not an object', async () => {
    const local = api(vi.fn<typeof globalThis.fetch>(async () => envelope({ source: 'local', config: {} })));
    await expect(local.getTunnelConfiguration(ACCOUNT_ID, TUNNEL_ID)).rejects.toMatchObject({
      code: 'foreign_cloudflare_tunnel',
    });
    const wrong = api(vi.fn<typeof globalThis.fetch>(async () => envelope({ config: 'private-canary', version: 0 })));
    await expect(wrong.getTunnelConfiguration(ACCOUNT_ID, TUNNEL_ID)).rejects.toMatchObject({
      code: 'invalid_cloudflare_response',
      message: 'Cloudflare returned an invalid tunnel configuration (config=string, version=number)',
    });
  });

  it('reads connector clients without config_version, and with one', async () => {
    const withVersion = { ...connectorClient, config_version: 5 };
    const client = api(
      vi.fn<typeof globalThis.fetch>(async () => envelope([connectorClient, withVersion, { conns: [] }])),
    );

    await expect(client.listTunnelConnections(ACCOUNT_ID, TUNNEL_ID)).resolves.toEqual([
      { id: CLIENT_ID },
      { id: CLIENT_ID, configVersion: 5 },
      {},
    ]);
  });

  it('ends pagination on total_pages 0, on the reported last page, and on a short page without totals', async () => {
    const pages: number[] = [];
    const empty = api(
      vi.fn<typeof globalThis.fetch>(async (input) => {
        pages.push(Number(new URL(String(input)).searchParams.get('page')));
        return envelope([], { page: 1, per_page: 50, count: 0, total_count: 0, total_pages: 0 });
      }),
    );
    await expect(empty.listDnsRecords(ZONE_ID, 'assistant.example.com')).resolves.toEqual([]);
    expect(pages).toEqual([1]);

    pages.length = 0;
    const twoPages = api(
      vi.fn<typeof globalThis.fetch>(async (input) => {
        const page = Number(new URL(String(input)).searchParams.get('page'));
        pages.push(page);
        return envelope([{ ...zone, id: page === 1 ? ZONE_ID : 'c'.repeat(32), name: `example${page}.com` }], {
          page,
          per_page: 1,
          count: 1,
          total_count: 2,
        });
      }),
    );
    await expect(twoPages.listActiveZones()).resolves.toHaveLength(2);
    expect(pages).toEqual([1, 2]);

    pages.length = 0;
    const noTotals = api(
      vi.fn<typeof globalThis.fetch>(async (input) => {
        pages.push(Number(new URL(String(input)).searchParams.get('page')));
        return envelope([tunnel]);
      }),
    );
    await expect(noTotals.listTunnels(ACCOUNT_ID, 'gws-ea-owned')).resolves.toHaveLength(1);
    expect(pages).toEqual([1]);
  });

  it.each([
    {
      label: 'zone',
      call: (client: CloudflareApi) => client.listActiveZones(),
      result: [{ ...zone, id: TUNNEL_ID }],
    },
    {
      label: 'account',
      call: (client: CloudflareApi) => client.listActiveZones(),
      result: [{ ...zone, account: { id: TUNNEL_ID, name: 'Example account' } }],
    },
    {
      label: 'tunnel',
      call: (client: CloudflareApi) => client.listTunnels(ACCOUNT_ID, 'gws-ea-owned'),
      result: [{ ...tunnel, id: ACCOUNT_ID }],
    },
    {
      label: 'DNS record',
      call: (client: CloudflareApi) => client.listDnsRecords(ZONE_ID, 'assistant.example.com'),
      result: [{ ...dnsRecord, id: TUNNEL_ID }],
    },
  ])('rejects a wrong identifier shape for a $label', async ({ call, result }) => {
    const client = api(
      vi.fn<typeof globalThis.fetch>(async () =>
        envelope(result, { page: 1, per_page: 50, count: 1, total_count: 1, total_pages: 1 }),
      ),
    );

    await expect(call(client)).rejects.toMatchObject({ code: 'invalid_cloudflare_response' });
  });
});

describe('Cloudflare token authority', () => {
  it('proves an account-owned token by listing zones, with no verify call', async () => {
    const paths: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      // The user-token verify endpoint rejects account-owned tokens.
      if (url.pathname.endsWith('/tokens/verify')) return failure(401, [{ code: 1000, message: 'Invalid API Token' }]);
      return envelope([zone], { page: 1, per_page: 50, count: 1, total_count: 1, total_pages: 1 });
    });
    const session = createManagedIngressSetupSession({
      clientFactory: (accountToken) => createCloudflareApi({ accountToken, fetch, baseUrl: BASE_URL }),
    });

    await expect(session.discoverZones(TOKEN)).resolves.toHaveLength(1);
    expect(paths).toEqual(['/client/v4/zones']);
    session.retainAccountToken(TOKEN);
    expect(session.requireAccountToken(ACCOUNT_ID)).toBe(TOKEN);
    session.clearAccountToken();
    expect(() => session.requireAccountToken(ACCOUNT_ID)).toThrow(/fresh Cloudflare API token/i);
  });

  it('carries the operation, HTTP status, Cloudflare code, and the redacted message', async () => {
    const client = api(
      vi.fn<typeof globalThis.fetch>(async () =>
        failure(403, [{ code: 10000, message: `Authentication error for ${TOKEN}` }]),
      ),
    );

    const error = await client.listActiveZones().catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: 'cloudflare_capability_missing',
      details: { operation: 'read active zones', http_status: 403, cloudflare_code: 10000 },
    });
    expect(String((error as Error).message)).toMatch(/read active zones.*HTTP 403.*code 10000.*Authentication error/u);
    expect(
      JSON.stringify({ message: (error as Error).message, details: (error as { details: unknown }).details }),
    ).not.toContain(TOKEN);
  });
});

describe('Cloudflare retries and failures', () => {
  it('waits for Retry-After on a rate-limited read, then reads again', async () => {
    const sleep = vi.fn(async () => undefined);
    let reads = 0;
    const client = api(
      vi.fn<typeof globalThis.fetch>(async () => {
        reads += 1;
        if (reads === 1) {
          return failure(429, [{ code: 971, message: 'Please wait and consider throttling your request speed' }], {
            'retry-after': '7',
          });
        }
        return envelope([zone], { page: 1, per_page: 50, count: 1, total_count: 1, total_pages: 1 });
      }),
      sleep,
    );

    await expect(client.listActiveZones()).resolves.toHaveLength(1);
    expect(sleep.mock.calls).toEqual([[7_000]]);
  });

  it('waits for Retry-After on a rate-limited change, then reports it unconfirmed without sending it again', async () => {
    const sleep = vi.fn(async () => undefined);
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      failure(429, [{ code: 971, message: 'Please wait and consider throttling your request speed' }], {
        'retry-after': '3',
      }),
    );
    const client = api(fetch, sleep);

    const error = await client
      .replaceTunnelConfiguration(ACCOUNT_ID, TUNNEL_ID, { ingress: [{ service: 'http_status:404' }] })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CloudflareAmbiguousMutationError);
    expect(error).toMatchObject({
      code: 'cloudflare_rate_limited',
      details: { operation: 'replace the tunnel configuration', http_status: 429 },
    });
    expect(sleep.mock.calls).toEqual([[3_000]]);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('names the operation and status when a 5xx answers with an HTML page', async () => {
    const html = () =>
      new Response('<!DOCTYPE html><html><head><title>api.cloudflare.test | 502: Bad gateway</title></head></html>', {
        status: 502,
        headers: { 'content-type': 'text/html; charset=UTF-8' },
      });
    const sleep = vi.fn(async () => undefined);
    const read = api(
      vi.fn<typeof globalThis.fetch>(async () => html()),
      sleep,
    );

    await expect(read.getTunnelConfiguration(ACCOUNT_ID, TUNNEL_ID)).rejects.toMatchObject({
      code: 'cloudflare_unavailable',
      message: expect.stringMatching(/read the tunnel configuration.*HTTP 502/u),
      details: { operation: 'read the tunnel configuration', http_status: 502 },
    });
    expect(sleep).toHaveBeenCalledTimes(2);

    const write = api(vi.fn<typeof globalThis.fetch>(async () => html()));
    await expect(write.createTunnel(ACCOUNT_ID, 'gws-ea-owned')).rejects.toMatchObject({
      code: 'cloudflare_mutation_ambiguous',
      message: expect.stringMatching(/create the managed tunnel.*HTTP 502/u),
    });
  });

  it('retries a read that got no answer only within its bound, and never retries a change itself', async () => {
    const sleep = vi.fn(async () => undefined);
    let reads = 0;
    let writes = 0;
    const client = api(
      vi.fn<typeof globalThis.fetch>(async (_input, init = {}) => {
        if (init.method === 'POST') {
          writes += 1;
          throw new TypeError(`network failure with token ${TOKEN}`);
        }
        reads += 1;
        if (reads === 1) throw new TypeError('network unavailable');
        if (reads === 2) return new Response(null, { status: 503 });
        return envelope([zone], { page: 1, per_page: 50, count: 1, total_count: 1, total_pages: 1 });
      }),
      sleep,
    );

    await expect(client.listActiveZones()).resolves.toHaveLength(1);
    expect(reads).toBe(3);
    expect(sleep.mock.calls).toEqual([[100], [200]]);
    const error = await client.createTunnel(ACCOUNT_ID, 'gws-ea-owned').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CloudflareAmbiguousMutationError);
    expect(writes).toBe(1);
    expect(String((error as Error).message)).not.toContain(TOKEN);
  });

  it('sends the exact documented mutation bodies', async () => {
    const requests: Array<{ path: string; method: string; body: unknown }> = [];
    const record = {
      type: 'CNAME' as const,
      name: 'assistant.example.com',
      content: `${TUNNEL_ID}.cfargotunnel.com`,
      proxied: true as const,
      comment: dnsRecord.comment,
    };
    const client = api(
      vi.fn<typeof globalThis.fetch>(async (input, init = {}) => {
        const route = new URL(String(input)).pathname.replace('/client/v4', '');
        requests.push({
          path: route,
          method: String(init.method),
          body: init.body ? JSON.parse(String(init.body)) : null,
        });
        if (route.endsWith('/cfd_tunnel')) return envelope({ ...tunnel, status: 'inactive' });
        if (route.endsWith('/dns_records')) return envelope(dnsRecord);
        return envelope({ tunnel_id: TUNNEL_ID, version: 2, config: { ingress: [] } });
      }),
    );

    await client.createTunnel(ACCOUNT_ID, 'gws-ea-owned');
    await client.replaceTunnelConfiguration(ACCOUNT_ID, TUNNEL_ID, { ingress: [{ service: 'http_status:404' }] });
    await client.createDnsRecord(ZONE_ID, record);

    expect(requests).toEqual([
      {
        path: `/accounts/${ACCOUNT_ID}/cfd_tunnel`,
        method: 'POST',
        body: { name: 'gws-ea-owned', config_src: 'cloudflare' },
      },
      {
        path: `/accounts/${ACCOUNT_ID}/cfd_tunnel/${TUNNEL_ID}/configurations`,
        method: 'PUT',
        body: { config: { ingress: [{ service: 'http_status:404' }] } },
      },
      { path: `/zones/${ZONE_ID}/dns_records`, method: 'POST', body: record },
    ]);
  });
});

describe('Cloudflare request logging', () => {
  it('logs request status only, captures non-token reads, and keeps the tunnel-token response out of both', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gws-ea-cloudflare-log-'));
    roots.push(root);
    const paths = resolveControlPlanePaths({
      configRoot: path.join(root, 'config'),
      stateRoot: path.join(root, 'state'),
    });
    const staging = path.join(root, 'fixture-staging');
    // Real tunnel tokens are base64 JSON; this canary matches no redaction pattern, so only
    // not writing the body at all keeps it out of the logs.
    const connectorToken = 'tunnel-token-canary-5f0c1b7e9d';
    const client = api(
      vi.fn<typeof globalThis.fetch>(async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/token')) return envelope(connectorToken);
        return envelope([tunnel], { page: 1, per_page: 50, count: 1, total_count: 1, total_pages: 1 });
      }),
    );

    const run = await startRunLog({ paths, command: 'create', captureFixturesTo: staging });
    await run.step('establish_transport', async () => {
      await client.listTunnels(ACCOUNT_ID, 'gws-ea-owned');
      await expect(client.getTunnelToken(ACCOUNT_ID, TUNNEL_ID)).resolves.toBe(connectorToken);
    });
    run.complete();

    const logs = await Promise.all(
      [
        path.join(run.directory, 'progress.log'),
        ...(await readdir(path.join(run.directory, 'steps'))).map((name) => path.join(run.directory, 'steps', name)),
      ].map((file) => readFile(file, 'utf8')),
    );
    const staged = await Promise.all(
      (await readdir(staging)).map((name) => readFile(path.join(staging, name), 'utf8')),
    );
    const raw = logs.join('\n');
    expect(raw).toMatch(/GET \/client\/v4\/accounts\/[0-9a-f]+\/cfd_tunnel\/[0-9a-f-]+\/token: HTTP 200/u);
    expect(raw).not.toContain(connectorToken);
    expect(raw).not.toContain(REDACTED);
    expect(staged).toHaveLength(1);
    expect(staged[0]).toContain('gws-ea-owned');
    expect(staged.join('\n')).not.toContain(connectorToken);
    expect(redact(`token ${connectorToken}`)).toBe(`token ${REDACTED}`);
  });
});
