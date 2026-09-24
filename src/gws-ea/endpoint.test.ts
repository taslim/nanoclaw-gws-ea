import { describe, expect, it, vi } from 'vitest';

import { verifyExistingGchatEndpoint, verifyExistingGchatRoute, verifyManagedGchatRoute } from './endpoint.js';

const ENDPOINT = 'https://assistant.example.com/webhook/gchat';

describe('existing Google Chat endpoint verification', () => {
  it('proves the claimed route separately from the audience configuration', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 401 }));

    await expect(verifyExistingGchatRoute({ endpointUrl: ENDPOINT }, { fetch })).resolves.toBe(ENDPOINT);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', redirect: 'manual' });
  });

  it('requires the claimed endpoint and authentication audience to be exactly equal', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();

    await expect(
      verifyExistingGchatEndpoint(
        { endpointUrl: ENDPOINT, audienceUrl: 'https://other.example.com/webhook/gchat' },
        { fetch },
      ),
    ).rejects.toThrow(/audience/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    'http://assistant.example.com/webhook/gchat',
    'https://user@assistant.example.com/webhook/gchat',
    'https://assistant.example.com/webhook/gchat?source=test',
    'https://assistant.example.com/webhook/gchat#fragment',
    'https://assistant.example.com/webhook/gchat/',
    'https://assistant.example.com/other',
  ])('rejects an unsafe or inexact callback URL: %s', async (endpointUrl) => {
    await expect(
      verifyExistingGchatEndpoint(
        { endpointUrl, audienceUrl: endpointUrl },
        { fetch: vi.fn<typeof globalThis.fetch>() },
      ),
    ).rejects.toThrow(/endpoint/i);
  });

  it('uses a no-follow probe and requires unsigned traffic to return 401', async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(null, { status: 401 });
    });

    await expect(
      verifyExistingGchatEndpoint({ endpointUrl: ENDPOINT, audienceUrl: ENDPOINT }, { fetch }),
    ).resolves.toEqual({ endpointUrl: ENDPOINT, audienceUrl: ENDPOINT });

    expect(requests).toHaveLength(1);
    for (const request of requests) {
      expect(request.url).toBe(ENDPOINT);
      expect(request.init).toMatchObject({ method: 'POST', redirect: 'manual' });
    }
    expect(new Headers(requests[0]!.init?.headers).has('authorization')).toBe(false);
  });

  it.each([301, 302, 307, 308])('rejects redirects instead of following status %s', async (status) => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response(null, { status, headers: { location: 'https://elsewhere.invalid/webhook/gchat' } }),
    );

    await expect(
      verifyExistingGchatEndpoint({ endpointUrl: ENDPOINT, audienceUrl: ENDPOINT }, { fetch }),
    ).rejects.toThrow(/redirect/i);
  });

  it.each([200, 404, 500])('does not accept a missing, bypassed, or unhealthy route (status %s)', async (status) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status }));

    await expect(
      verifyExistingGchatEndpoint({ endpointUrl: ENDPOINT, audienceUrl: ENDPOINT }, { fetch }),
    ).rejects.toThrow(/401/u);
  });
});

describe('managed Google Chat route verification', () => {
  const listenerId = '11111111-1111-4111-8111-111111111111';
  const localEndpoint = 'http://127.0.0.1:31001/webhook/gchat';

  it('correlates the public callback with the local listener and proves the catch-all', async () => {
    const requests: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
      const value = String(url);
      requests.push(value);
      if (value === 'https://assistant.example.com/__gws_ea_wrong_path__') {
        return new Response(null, { status: 404 });
      }
      return new Response(null, {
        status: 401,
        headers: { 'x-nanoclaw-webhook-id': listenerId },
      });
    });

    await expect(
      verifyManagedGchatRoute({ endpointUrl: ENDPOINT, localEndpointUrl: localEndpoint }, { fetch }),
    ).resolves.toEqual({ endpointUrl: ENDPOINT, listenerId });
    expect(requests).toEqual([localEndpoint, ENDPOINT, 'https://assistant.example.com/__gws_ea_wrong_path__']);
  });

  it('rejects a healthy public callback routed to another NanoClaw listener', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async (url) =>
        new Response(null, {
          status: 401,
          headers: {
            'x-nanoclaw-webhook-id': String(url).startsWith('http://127.0.0.1')
              ? listenerId
              : '22222222-2222-4222-8222-222222222222',
          },
        }),
    );

    await expect(
      verifyManagedGchatRoute({ endpointUrl: ENDPOINT, localEndpointUrl: localEndpoint }, { fetch }),
    ).rejects.toMatchObject({ code: 'managed_listener_mismatch' });
  });

  it('requires the public wrong path to return an exact non-redirecting 404', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
      if (String(url).endsWith('__gws_ea_wrong_path__')) {
        return new Response(null, { status: 200 });
      }
      return new Response(null, {
        status: 401,
        headers: { 'x-nanoclaw-webhook-id': listenerId },
      });
    });

    await expect(
      verifyManagedGchatRoute({ endpointUrl: ENDPOINT, localEndpointUrl: localEndpoint }, { fetch }),
    ).rejects.toMatchObject({ code: 'managed_catch_all_mismatch' });
  });

  it('rejects a wrong-path 404 served by NanoClaw instead of Cloudflare', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async (url) =>
        new Response(null, {
          status: String(url).endsWith('__gws_ea_wrong_path__') ? 404 : 401,
          headers: { 'x-nanoclaw-webhook-id': listenerId },
        }),
    );

    await expect(
      verifyManagedGchatRoute({ endpointUrl: ENDPOINT, localEndpointUrl: localEndpoint }, { fetch }),
    ).rejects.toMatchObject({ code: 'managed_catch_all_mismatch' });
  });

  it('rejects a redirect from the public wrong path', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
      if (String(url).endsWith('__gws_ea_wrong_path__')) {
        return new Response(null, { status: 302, headers: { location: 'https://elsewhere.invalid/' } });
      }
      return new Response(null, {
        status: 401,
        headers: { 'x-nanoclaw-webhook-id': listenerId },
      });
    });

    await expect(
      verifyManagedGchatRoute({ endpointUrl: ENDPOINT, localEndpointUrl: localEndpoint }, { fetch }),
    ).rejects.toMatchObject({ code: 'endpoint_redirect' });
  });
});
