import { describe, expect, it, vi } from 'vitest';

import { observeManagedGchatRoute, verifyExistingGchatEndpoint, verifyExistingGchatRoute } from './endpoint.js';

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
    ).rejects.toThrow(new RegExp(`401.*answered ${status}`, 'u'));
  });
});

describe('managed Google Chat route observation', () => {
  const listenerId = '11111111-1111-4111-8111-111111111111';
  const localEndpoint = 'http://127.0.0.1:31001/webhook/gchat';
  const wrongPath = 'https://assistant.example.com/__gws_ea_wrong_path__';
  const nanoclaw = (id = listenerId) => new Response(null, { status: 401, headers: { 'x-nanoclaw-webhook-id': id } });
  const cloudflareError = (status: number) =>
    new Response(`<!DOCTYPE html><title>assistant.example.com | ${status}</title>`, {
      status,
      headers: { 'content-type': 'text/html; charset=UTF-8' },
    });
  const observe = (answer: (url: string) => Response | Promise<Response>) =>
    observeManagedGchatRoute(
      { endpointUrl: ENDPOINT, localEndpointUrl: localEndpoint },
      { fetch: vi.fn<typeof globalThis.fetch>(async (url) => answer(String(url))) },
    );

  it('correlates the public callback with the local listener and proves the catch-all', async () => {
    const requests: string[] = [];
    await expect(
      observe((url) => {
        requests.push(url);
        return url === wrongPath ? new Response(null, { status: 404 }) : nanoclaw();
      }),
    ).resolves.toEqual({ status: 'routed', listenerId });
    expect(requests).toEqual([localEndpoint, ENDPOINT, wrongPath]);
  });

  it.each([502, 521, 530])('reports an edge %s as the tunnel or the assistant being down', async (status) => {
    await expect(observe((url) => (url === localEndpoint ? nanoclaw() : cloudflareError(status)))).resolves.toEqual({
      status: 'down',
      observed: `the public callback answered ${status}, so the Cloudflare tunnel or the assistant is down`,
      evidence: `POST ${ENDPOINT}: HTTP ${status}`,
    });
  });

  it('cannot conclude anything when the callback or the local listener does not answer', async () => {
    const timedOut = new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect ETIMEDOUT 198.51.100.7:443'), { code: 'ETIMEDOUT' }),
    });
    await expect(
      observe((url) => {
        if (url === localEndpoint) return nanoclaw();
        throw timedOut;
      }),
    ).resolves.toMatchObject({ status: 'down', observed: 'the public callback did not answer (ETIMEDOUT)' });
    await expect(
      observe(() => {
        throw new TypeError('fetch failed', { cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) });
      }),
    ).resolves.toMatchObject({
      status: 'down',
      observed: "the assistant's local listener did not answer (ECONNREFUSED)",
    });
  });

  it.each([
    {
      label: 'a hostname that does not resolve',
      answer: (url: string) => {
        if (url === localEndpoint) return nanoclaw();
        throw new TypeError('fetch failed', {
          cause: Object.assign(new Error('getaddrinfo ENOTFOUND assistant.example.com'), { code: 'ENOTFOUND' }),
        });
      },
      observed: "the public callback's hostname does not resolve (ENOTFOUND)",
    },
    {
      label: "Cloudflare's catch-all instead of the route",
      answer: (url: string) => (url === localEndpoint ? nanoclaw() : new Response(null, { status: 404 })),
      observed: 'the public callback answered 404 without a NanoClaw listener',
    },
    {
      label: 'another NanoClaw listener',
      answer: (url: string) => (url === localEndpoint ? nanoclaw() : nanoclaw('22222222-2222-4222-8222-222222222222')),
      observed: 'the public callback reached a different NanoClaw listener',
    },
    {
      label: 'a redirect',
      answer: (url: string) =>
        url === localEndpoint
          ? nanoclaw()
          : new Response(null, { status: 302, headers: { location: 'https://elsewhere.invalid/' } }),
      observed: 'the public callback answered 302, a redirect',
    },
    {
      label: 'a wrong path that is not a 404',
      answer: (url: string) => (url === wrongPath ? new Response(null, { status: 200 }) : nanoclaw()),
      observed: "a path outside the route answered 200 instead of Cloudflare's 404",
    },
    {
      label: 'a wrong path answered by NanoClaw',
      answer: (url: string) =>
        url === wrongPath
          ? new Response(null, { status: 404, headers: { 'x-nanoclaw-webhook-id': listenerId } })
          : nanoclaw(),
      observed: "a path outside the route reached NanoClaw instead of Cloudflare's 404",
    },
  ])('reports $label as misrouted with the observed answer', async ({ answer, observed }) => {
    await expect(observe(answer)).resolves.toMatchObject({ status: 'misrouted', observed });
  });
});
