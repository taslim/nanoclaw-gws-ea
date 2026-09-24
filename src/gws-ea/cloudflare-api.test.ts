import { describe, expect, it, vi } from 'vitest';

import {
  CloudflareAmbiguousMutationError,
  createCloudflareApi,
  createManagedIngressSetupSession,
} from './cloudflare-api.js';

const TOKEN = 'cf-account-token-canary';
const ACCOUNT_ID = 'a'.repeat(32);
const ZONE_ID = 'b'.repeat(32);
const TUNNEL_ID = '11111111-1111-4111-8111-111111111111';

function envelope(result: unknown, resultInfo?: Record<string, unknown>): Response {
  return Response.json({
    success: true,
    errors: [],
    messages: [],
    result,
    ...(resultInfo ? { result_info: resultInfo } : {}),
  });
}

describe('Cloudflare REST boundary', () => {
  it('uses only bearer auth and the current token, zone, tunnel, configuration, connection, and DNS paths', async () => {
    const seen: Array<{ url: URL; init: RequestInit }> = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init = {}) => {
      const url = new URL(String(input));
      seen.push({ url, init });
      if (url.pathname === '/client/v4/user/tokens/verify') return envelope({ id: 'token-id', status: 'active' });
      if (url.pathname === '/client/v4/zones') {
        return envelope(
          [
            {
              id: ZONE_ID,
              name: 'example.com',
              status: 'active',
              account: { id: ACCOUNT_ID, name: 'Example account' },
            },
          ],
          { page: 1, per_page: 50, count: 1, total_count: 1, total_pages: 1 },
        );
      }
      if (url.pathname === `/client/v4/accounts/${ACCOUNT_ID}/cfd_tunnel`) {
        return envelope(
          [
            {
              id: TUNNEL_ID,
              name: 'gws-ea-owned',
              config_src: 'cloudflare',
              status: 'healthy',
              connections: [],
            },
          ],
          { page: 1, per_page: 50, count: 1, total_count: 1 },
        );
      }
      if (url.pathname === `/client/v4/accounts/${ACCOUNT_ID}/cfd_tunnel/${TUNNEL_ID}`) return envelope({});
      if (url.pathname.endsWith('/configurations')) {
        if (init.method === 'PUT') return envelope({ config: JSON.parse(String(init.body)).config, version: 8 });
        return envelope({ config: { ingress: [{ service: 'http_status:404' }] }, version: 7 });
      }
      if (url.pathname.endsWith('/connections')) {
        return envelope([{ id: 'connection-id', config_version: 8 }]);
      }
      if (url.pathname.endsWith('/token')) return envelope('connector-token');
      if (url.pathname === `/client/v4/zones/${ZONE_ID}/dns_records`) {
        return envelope([], { page: 1, per_page: 50, count: 0, total_count: 0, total_pages: 1 });
      }
      if (url.pathname === `/client/v4/zones/${ZONE_ID}/dns_records/${ZONE_ID}`) return envelope({});
      throw new Error(`unexpected path ${url.pathname}`);
    });
    const api = createCloudflareApi({ accountToken: TOKEN, fetch, baseUrl: 'https://api.test/client/v4' });

    await expect(api.verifyToken()).resolves.toBeUndefined();
    await expect(api.listActiveZones()).resolves.toHaveLength(1);
    await expect(api.listTunnels(ACCOUNT_ID, 'gws-ea-owned')).resolves.toHaveLength(1);
    await expect(api.getTunnelConfiguration(ACCOUNT_ID, TUNNEL_ID)).resolves.toMatchObject({ version: 7 });
    await expect(
      api.replaceTunnelConfiguration(ACCOUNT_ID, TUNNEL_ID, { ingress: [{ service: 'http_status:404' }] }),
    ).resolves.toMatchObject({ version: 8 });
    await expect(api.listTunnelConnections(ACCOUNT_ID, TUNNEL_ID)).resolves.toEqual([
      { id: 'connection-id', configVersion: 8 },
    ]);
    await expect(api.getTunnelToken(ACCOUNT_ID, TUNNEL_ID)).resolves.toBe('connector-token');
    await expect(api.listDnsRecords(ZONE_ID, 'assistant.example.com')).resolves.toEqual([]);
    await expect(api.deleteDnsRecord(ZONE_ID, ZONE_ID)).resolves.toBeUndefined();
    await expect(api.deleteTunnel(ACCOUNT_ID, TUNNEL_ID)).resolves.toBeUndefined();

    expect(seen.every(({ init }) => new Headers(init.headers).get('authorization') === `Bearer ${TOKEN}`)).toBe(true);
    expect(seen.every(({ init }) => !new Headers(init.headers).has('x-auth-email'))).toBe(true);
    expect(seen.every(({ init }) => !new Headers(init.headers).has('x-auth-key'))).toBe(true);
    expect(seen.some(({ url }) => /\/cfd_tunnel\/.+\/connections$/u.test(url.pathname))).toBe(true);
    expect(
      seen.some(
        ({ url, init }) =>
          init.method === 'DELETE' && url.pathname === `/client/v4/zones/${ZONE_ID}/dns_records/${ZONE_ID}`,
      ),
    ).toBe(true);
    expect(
      seen.some(
        ({ url, init }) =>
          init.method === 'DELETE' && url.pathname === `/client/v4/accounts/${ACCOUNT_ID}/cfd_tunnel/${TUNNEL_ID}`,
      ),
    ).toBe(true);
    expect(seen.every(({ url }) => !url.pathname.includes('/tunnels/'))).toBe(true);
    expect(
      JSON.stringify(seen.map(({ url, init }) => ({ url: url.toString(), method: init.method, body: init.body }))),
    ).not.toContain(TOKEN);
  });

  it('accepts connections when Cloudflare omits optional connection metadata', async () => {
    const api = createCloudflareApi({
      accountToken: TOKEN,
      baseUrl: 'https://api.test/client/v4',
      fetch: vi.fn<typeof globalThis.fetch>(async () =>
        envelope([{ id: 'connection-id' }, { config_version: 0 }, { id: null, config_version: null }]),
      ),
    });

    await expect(api.listTunnelConnections(ACCOUNT_ID, TUNNEL_ID)).resolves.toEqual([
      { id: 'connection-id' },
      { configVersion: 0 },
      {},
    ]);
  });

  it('paginates active zones and validates token state through the setup session without retaining rejected tokens', async () => {
    const pages: number[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/user/tokens/verify')) return envelope({ id: 'token-id', status: 'active' });
      const page = Number(url.searchParams.get('page'));
      pages.push(page);
      return envelope(
        [
          {
            id: page === 1 ? ZONE_ID : 'c'.repeat(32),
            name: page === 1 ? 'example.com' : 'example.net',
            status: 'active',
            account: { id: ACCOUNT_ID, name: 'Example account' },
          },
        ],
        { page, per_page: 1, count: 1, total_count: 2, total_pages: 2 },
      );
    });
    const session = createManagedIngressSetupSession({
      clientFactory: (accountToken) =>
        createCloudflareApi({ accountToken, fetch, baseUrl: 'https://api.test/client/v4' }),
    });

    await expect(session.discoverZones(TOKEN)).resolves.toHaveLength(2);
    expect(pages).toEqual([1, 2]);
    session.retainAccountToken(TOKEN);
    expect(session.requireAccountToken(ACCOUNT_ID)).toBe(TOKEN);
    session.clearAccountToken();
    expect(() => session.requireAccountToken(ACCOUNT_ID)).toThrow(/fresh Cloudflare API token/i);
  });

  it('honors Retry-After and retries bounded read failures without retrying ambiguous writes', async () => {
    const sleeps: number[] = [];
    let reads = 0;
    let writes = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init = {}) => {
      if (init.method === 'POST') {
        writes += 1;
        throw new TypeError('network failure with token cf-account-token-canary');
      }
      reads += 1;
      if (reads === 1) return new Response(null, { status: 429, headers: { 'retry-after': '2' } });
      return envelope({ id: 'token-id', status: 'active' });
    });
    const api = createCloudflareApi({
      accountToken: TOKEN,
      fetch,
      baseUrl: 'https://api.test/client/v4',
      sleep: async (delayMs) => void sleeps.push(delayMs),
      maxReadAttempts: 2,
    });

    await expect(api.verifyToken()).resolves.toBeUndefined();
    expect(sleeps).toEqual([2_000]);
    await expect(api.createTunnel(ACCOUNT_ID, 'gws-ea-owned')).rejects.toBeInstanceOf(CloudflareAmbiguousMutationError);
    expect(writes).toBe(1);
    await expect(api.createTunnel(ACCOUNT_ID, TOKEN)).rejects.not.toThrow(TOKEN);
  });

  it('uses exact current mutation bodies', async () => {
    const requests: Array<{ path: string; method: string; body: unknown }> = [];
    const record = {
      type: 'CNAME' as const,
      name: 'assistant.example.com',
      content: `${TUNNEL_ID}.cfargotunnel.com`,
      proxied: true as const,
      comment: 'gws-ea managed ingress 11111111-1111-4111-8111-111111111111',
    };
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init = {}) => {
      const path = new URL(String(input)).pathname;
      requests.push({ path, method: String(init.method), body: init.body ? JSON.parse(String(init.body)) : null });
      if (path.endsWith('/cfd_tunnel')) {
        return envelope({ id: TUNNEL_ID, name: 'gws-ea-owned', config_src: 'cloudflare', status: 'inactive' });
      }
      if (path.endsWith('/dns_records')) {
        return envelope({ id: 'c'.repeat(32), ...record });
      }
      return envelope({ id: TUNNEL_ID });
    });
    const api = createCloudflareApi({ accountToken: TOKEN, fetch, baseUrl: 'https://api.test/client/v4' });

    await api.createTunnel(ACCOUNT_ID, 'gws-ea-owned');
    await api.createDnsRecord(ZONE_ID, record);

    expect(requests).toEqual([
      {
        path: `/client/v4/accounts/${ACCOUNT_ID}/cfd_tunnel`,
        method: 'POST',
        body: { name: 'gws-ea-owned', config_src: 'cloudflare' },
      },
      { path: `/client/v4/zones/${ZONE_ID}/dns_records`, method: 'POST', body: record },
    ]);
  });

  it('retries network and 5xx read failures only within the configured bound', async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const api = createCloudflareApi({
      accountToken: TOKEN,
      baseUrl: 'https://api.test/client/v4',
      maxReadAttempts: 3,
      sleep: async (delayMs) => void sleeps.push(delayMs),
      fetch: vi.fn<typeof globalThis.fetch>(async () => {
        attempts += 1;
        if (attempts === 1) throw new TypeError('network unavailable');
        if (attempts === 2) return new Response(null, { status: 503 });
        return envelope({ id: 'token-id', status: 'active' });
      }),
    });

    await expect(api.verifyToken()).resolves.toBeUndefined();
    expect(attempts).toBe(3);
    expect(sleeps).toEqual([100, 200]);
  });

  it('returns sanitized capability failures and accepts the documented tunnel-list response shape', async () => {
    const denied = createCloudflareApi({
      accountToken: TOKEN,
      baseUrl: 'https://api.test/client/v4',
      fetch: vi.fn<typeof globalThis.fetch>(async () =>
        Response.json(
          { success: false, errors: [{ code: 10000, message: `bad ${TOKEN}` }], messages: [], result: null },
          { status: 403 },
        ),
      ),
    });
    await expect(denied.listActiveZones()).rejects.toMatchObject({ code: 'cloudflare_capability_missing' });
    await expect(denied.listActiveZones()).rejects.not.toThrow(TOKEN);

    const documented = createCloudflareApi({
      accountToken: TOKEN,
      baseUrl: 'https://api.test/client/v4',
      fetch: vi.fn<typeof globalThis.fetch>(async () =>
        envelope(
          [
            {
              id: TUNNEL_ID,
              name: 'gws-ea-owned',
              config_src: 'cloudflare',
              status: 'healthy',
              connections: [],
            },
          ],
          { page: 1, per_page: 50, count: 1, total_count: 1 },
        ),
      ),
    });
    await expect(documented.listTunnels(ACCOUNT_ID, 'gws-ea-owned')).resolves.toEqual([
      { id: TUNNEL_ID, name: 'gws-ea-owned', configSource: 'cloudflare', status: 'healthy' },
    ]);
  });

  it.each([
    { label: 'missing config and version', fields: {} },
    { label: 'version zero without config', fields: { version: 0 } },
    { label: 'null config at version zero', fields: { config: null, version: 0 } },
    { label: 'empty config without version', fields: { config: {} } },
  ])('accepts $label as an uninitialized tunnel without inventing routes', async ({ fields }) => {
    const api = createCloudflareApi({
      accountToken: TOKEN,
      baseUrl: 'https://api.test/client/v4',
      fetch: vi.fn<typeof globalThis.fetch>(async () =>
        envelope({
          account_id: ACCOUNT_ID,
          tunnel_id: TUNNEL_ID,
          source: 'cloudflare',
          ...fields,
        }),
      ),
    });

    await expect(api.getTunnelConfiguration(ACCOUNT_ID, TUNNEL_ID)).resolves.toEqual({
      config: {},
      initialized: false,
      version: 0,
    });
  });

  it.each([
    { label: 'null result', result: null, shape: 'result=null' },
    { label: 'nonzero version without config', result: { version: 1 }, shape: 'config=missing, version=number' },
    {
      label: 'configured route without version',
      result: { config: { ingress: [{ service: 'http_status:404' }] } },
      shape: 'config=object, version=missing',
    },
    {
      label: 'non-object config',
      result: { config: 'private-canary', version: 0 },
      shape: 'config=string, version=number',
    },
  ])('rejects $label with value-free shape diagnostics', async ({ result, shape }) => {
    const api = createCloudflareApi({
      accountToken: TOKEN,
      baseUrl: 'https://api.test/client/v4',
      fetch: vi.fn<typeof globalThis.fetch>(async () => envelope(result)),
    });

    await expect(api.getTunnelConfiguration(ACCOUNT_ID, TUNNEL_ID)).rejects.toMatchObject({
      code: 'invalid_cloudflare_response',
      message: `Cloudflare returned an invalid tunnel configuration (${shape})`,
    });
  });

  it('rejects an incomplete configuration write instead of treating it as uninitialized', async () => {
    const api = createCloudflareApi({
      accountToken: TOKEN,
      baseUrl: 'https://api.test/client/v4',
      fetch: vi.fn<typeof globalThis.fetch>(async () => envelope({ version: 0 })),
    });

    await expect(api.replaceTunnelConfiguration(ACCOUNT_ID, TUNNEL_ID, {})).rejects.toMatchObject({
      code: 'invalid_cloudflare_response',
      message: 'Cloudflare returned an invalid tunnel configuration (config=missing, version=number)',
    });
  });

  it.each([
    {
      label: 'zone',
      call: (api: ReturnType<typeof createCloudflareApi>) => api.listActiveZones(),
      result: [
        {
          id: TUNNEL_ID,
          name: 'example.com',
          status: 'active',
          account: { id: ACCOUNT_ID, name: 'Example account' },
        },
      ],
    },
    {
      label: 'account',
      call: (api: ReturnType<typeof createCloudflareApi>) => api.listActiveZones(),
      result: [
        {
          id: ZONE_ID,
          name: 'example.com',
          status: 'active',
          account: { id: TUNNEL_ID, name: 'Example account' },
        },
      ],
    },
    {
      label: 'tunnel',
      call: (api: ReturnType<typeof createCloudflareApi>) => api.listTunnels(ACCOUNT_ID, 'gws-ea-owned'),
      result: [{ id: ACCOUNT_ID, name: 'gws-ea-owned', config_src: 'cloudflare', status: 'inactive' }],
    },
    {
      label: 'DNS record',
      call: (api: ReturnType<typeof createCloudflareApi>) => api.listDnsRecords(ZONE_ID, 'assistant.example.com'),
      result: [
        {
          id: TUNNEL_ID,
          type: 'CNAME',
          name: 'assistant.example.com',
          content: `${TUNNEL_ID}.cfargotunnel.com`,
          proxied: true,
          comment: 'owned',
        },
      ],
    },
  ])('rejects a wrong identifier shape for $label', async ({ call, result }) => {
    const api = createCloudflareApi({
      accountToken: TOKEN,
      baseUrl: 'https://api.test/client/v4',
      fetch: vi.fn<typeof globalThis.fetch>(async () =>
        envelope(result, { page: 1, per_page: 50, count: 1, total_count: 1, total_pages: 1 }),
      ),
    });

    await expect(call(api)).rejects.toMatchObject({ code: 'invalid_cloudflare_response' });
  });
});
