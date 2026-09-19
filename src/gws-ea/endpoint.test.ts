import { describe, expect, it, vi } from 'vitest';

import { verifyExistingGchatEndpoint, verifyExistingGchatRoute } from './endpoint.js';

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

  it('uses no-follow probes and requires both unsigned and wrong-audience traffic to return 401', async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(null, { status: 401 });
    });

    await expect(
      verifyExistingGchatEndpoint({ endpointUrl: ENDPOINT, audienceUrl: ENDPOINT }, { fetch }),
    ).resolves.toEqual({ endpointUrl: ENDPOINT, audienceUrl: ENDPOINT });

    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.url).toBe(ENDPOINT);
      expect(request.init).toMatchObject({ method: 'POST', redirect: 'manual' });
    }
    expect(new Headers(requests[0]!.init?.headers).has('authorization')).toBe(false);
    const authorization = new Headers(requests[1]!.init?.headers).get('authorization');
    expect(authorization).toMatch(/^Bearer /u);
    const payload = authorization!.slice('Bearer '.length).split('.')[1]!;
    expect(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))).toMatchObject({
      aud: 'https://wrong-audience.invalid/webhook/gchat',
    });
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
