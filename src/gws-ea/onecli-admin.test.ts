import { afterEach, describe, expect, it, vi } from 'vitest';

import { createOnecliAdmin, fetchOnecliApiKey, onecliInjection } from './onecli-admin.js';
import { registerSecret } from './redact.js';

vi.mock('./redact.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./redact.js')>();
  return { ...actual, registerSecret: vi.fn(actual.registerSecret) };
});

const APP_URL = 'http://127.0.0.1:31002';
const API_KEY = `oc_${'k'.repeat(64)}`;
/** What a OneCLI answer may carry that must never reach an error: a secret preview and an agent's token. */
const BODY_SECRET = 'sk-ant-preview-leak-canary';
const ACCESS_TOKEN = `aoc_${'t'.repeat(40)}`;

interface Recorded {
  readonly method: string;
  readonly route: string;
  readonly headers: Headers;
  readonly body: unknown;
  readonly init: RequestInit | undefined;
}

/** OneCLI's app behind `fetch`: every request is recorded, and `answer` replies to it. */
function oneCli(answer: (request: Recorded) => Response | Promise<Response>) {
  const requests: Recorded[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const request: Recorded = {
      method: init?.method ?? 'GET',
      route: `${url.origin}${url.pathname}`,
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      init,
    };
    requests.push(request);
    return answer(request);
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, requests };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

afterEach(() => vi.mocked(registerSecret).mockClear());

describe('the OneCLI API key', () => {
  it('is read keylessly from the given app URL, without following a redirect, and registered for redaction', async () => {
    const { fetch, requests } = oneCli(() => json({ apiKey: API_KEY }));

    await expect(fetchOnecliApiKey(APP_URL, { fetch })).resolves.toBe(API_KEY);

    expect(requests.map(({ method, route }) => `${method} ${route}`)).toEqual([`GET ${APP_URL}/v1/user/api-key`]);
    expect(requests[0]!.headers.has('authorization')).toBe(false);
    expect(requests[0]!.init).toMatchObject({ redirect: 'error', signal: expect.any(AbortSignal) });
    expect(registerSecret).toHaveBeenCalledWith(API_KEY);
  });

  it('is only ever read, so a second read returns the key the first one did', async () => {
    const { fetch, requests } = oneCli(() => json({ apiKey: API_KEY }));

    const first = await fetchOnecliApiKey(APP_URL, { fetch });
    const second = await fetchOnecliApiKey(APP_URL, { fetch });

    expect(second).toBe(first);
    expect(requests.map(({ method, route }) => `${method} ${route}`)).toEqual([
      `GET ${APP_URL}/v1/user/api-key`,
      `GET ${APP_URL}/v1/user/api-key`,
    ]);
  });

  it('refuses an answer that is not a local OneCLI key', async () => {
    const { fetch } = oneCli(() => json({ apiKey: 'not-a-key' }));

    await expect(fetchOnecliApiKey(APP_URL, { fetch })).rejects.toMatchObject({ code: 'incompatible_onecli' });
    expect(registerSecret).not.toHaveBeenCalled();
  });
});

describe('OneCLI administration', () => {
  it('sends every call to the given app URL with the given key, and registers the key for redaction', async () => {
    const { fetch, requests } = oneCli(() => json([]));
    const admin = createOnecliAdmin(APP_URL, API_KEY, { fetch });

    await admin.listSecrets();
    await admin.listAgents();

    expect(registerSecret).toHaveBeenCalledWith(API_KEY);
    expect(requests.map(({ method, route }) => `${method} ${route}`)).toEqual([
      `GET ${APP_URL}/v1/secrets`,
      `GET ${APP_URL}/v1/agents`,
    ]);
    for (const request of requests) {
      expect(request.headers.get('authorization')).toBe(`Bearer ${API_KEY}`);
      expect(request.init).toMatchObject({ redirect: 'error', signal: expect.any(AbortSignal) });
    }
  });

  it('creates a secret with its value only in the request body, and reads back its ID alone', async () => {
    const { fetch, requests } = oneCli(() => json({ id: 'secret-1', preview: BODY_SECRET }, 201));
    const value = 'sk-ant-api03-real-provider-value';

    const id = await createOnecliAdmin(APP_URL, API_KEY, { fetch }).createSecret({
      name: 'Anthropic',
      type: 'anthropic',
      value,
      hostPattern: 'api.anthropic.com',
    });

    expect(id).toBe('secret-1');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: 'POST',
      route: `${APP_URL}/v1/secrets`,
      body: { name: 'Anthropic', type: 'anthropic', value, hostPattern: 'api.anthropic.com' },
    });
    expect(requests[0]!.route).not.toContain(value);
    expect(requests[0]!.headers.get('content-type')).toBe('application/json');
    expect(registerSecret).toHaveBeenCalledWith(value);
  });

  it("stores a header or parameter format OneCLI's way, so a secret saved without one is found again", async () => {
    const { fetch, requests } = oneCli(() => json({ id: 'secret-2' }, 201));

    await createOnecliAdmin(APP_URL, API_KEY, { fetch }).createSecret({
      name: 'Search',
      type: 'generic',
      value: 'search-provider-value',
      hostPattern: 'api.search.example.test',
      pathPattern: '/v2/*',
      headerName: 'x-api-key',
    });

    expect(requests[0]!.body).toEqual({
      name: 'Search',
      type: 'generic',
      value: 'search-provider-value',
      hostPattern: 'api.search.example.test',
      pathPattern: '/v2/*',
      injectionConfig: { headerName: 'x-api-key', valueFormat: '{value}' },
    });
    expect(onecliInjection({ name: 'q', type: 'generic', hostPattern: 'h', paramName: 'key' })).toEqual({
      paramName: 'key',
      paramFormat: '{value}',
    });
    expect(
      onecliInjection({
        name: 'b',
        type: 'generic',
        hostPattern: 'h',
        headerName: 'Authorization',
        valueFormat: 'Bearer {value}',
      }),
    ).toEqual({ headerName: 'Authorization', valueFormat: 'Bearer {value}' });
    expect(onecliInjection({ name: 'Anthropic', type: 'anthropic', hostPattern: 'api.anthropic.com' })).toBeNull();
  });

  it("lists agents without their access tokens, reading a missing secret mode as OneCLI's default, all", async () => {
    const { fetch } = oneCli(() =>
      json([
        { id: 'oc-main', identifier: 'ag-main', name: 'main', secretMode: 'selective', accessToken: ACCESS_TOKEN },
        { id: 'oc-other', identifier: 'ag-other', name: 'other', accessToken: ACCESS_TOKEN },
      ]),
    );

    await expect(createOnecliAdmin(APP_URL, API_KEY, { fetch }).listAgents()).resolves.toEqual([
      { id: 'oc-main', identifier: 'ag-main', name: 'main', secretMode: 'selective' },
      { id: 'oc-other', identifier: 'ag-other', name: 'other', secretMode: 'all' },
    ]);
  });

  it('takes an agent create that answers 409 as an agent that already exists, for the list to name', async () => {
    let created = false;
    const { fetch, requests } = oneCli((request) => {
      if (request.method === 'GET')
        return json(created ? [{ id: 'oc-main', identifier: 'ag-main', name: 'main' }] : []);
      created = true;
      return json({ error: 'An agent with this identifier already exists' }, 409);
    });
    const admin = createOnecliAdmin(APP_URL, API_KEY, { fetch });

    await expect(admin.createAgent({ name: 'main', identifier: 'ag-main' })).resolves.toBeUndefined();
    await expect(admin.listAgents()).resolves.toEqual([
      { id: 'oc-main', identifier: 'ag-main', name: 'main', secretMode: 'all' },
    ]);
    expect(requests[0]).toMatchObject({
      method: 'POST',
      route: `${APP_URL}/v1/agents`,
      body: { name: 'main', identifier: 'ag-main' },
    });
  });

  it('refuses an agent create OneCLI rejects for any other reason', async () => {
    const { fetch } = oneCli(() => json({ error: 'Identifier must be 1-50 characters' }, 400));

    await expect(
      createOnecliAdmin(APP_URL, API_KEY, { fetch }).createAgent({ name: 'main', identifier: 'ag-main' }),
    ).rejects.toMatchObject({ code: 'onecli_request_failed', message: expect.stringContaining('HTTP 400') });
  });

  it("sets an agent's secret mode on that agent alone", async () => {
    const { fetch, requests } = oneCli(() => json({ success: true }));

    await createOnecliAdmin(APP_URL, API_KEY, { fetch }).setSecretMode('oc/main', 'all');

    expect(requests).toEqual([
      expect.objectContaining({
        method: 'PATCH',
        route: `${APP_URL}/v1/agents/oc%2Fmain/secret-mode`,
        body: { mode: 'all' },
      }),
    ]);
  });
});

describe('a OneCLI failure', () => {
  const leakyBody = JSON.stringify({ error: `bad request ${BODY_SECRET}`, accessToken: ACCESS_TOKEN });

  function expectNoBody(error: unknown): void {
    expect(error).toMatchObject({ name: 'GwsEaError' });
    const reported = `${String(error)} ${JSON.stringify(error)} ${String((error as Error).stack)}`;
    expect(reported).not.toContain(BODY_SECRET);
    expect(reported).not.toContain(ACCESS_TOKEN);
    expect((error as Error).cause).toBeUndefined();
  }

  it.each([
    ['a refusal', () => new Response(leakyBody, { status: 500 }), 'onecli_request_failed'],
    ['an unreadable answer', () => new Response(`${leakyBody} trailing`, { status: 200 }), 'invalid_onecli_output'],
    ['an answer of the wrong shape', () => json({ items: [BODY_SECRET, ACCESS_TOKEN] }), 'invalid_onecli_output'],
    [
      'a transport error that quotes the request',
      () => Promise.reject(new TypeError(`fetch failed: ${BODY_SECRET} ${ACCESS_TOKEN}`)),
      'onecli_request_failed',
    ],
  ] as const)('reports %s by its status alone, never its body', async (_case, answer, code) => {
    const { fetch } = oneCli(answer);
    const admin = createOnecliAdmin(APP_URL, API_KEY, { fetch });
    const error = await admin.listAgents().then(
      () => undefined,
      (failure: unknown) => failure,
    );

    expect(error).toMatchObject({ code });
    expectNoBody(error);
  });

  it('reports a refused key request by its status alone', async () => {
    const { fetch } = oneCli(() => new Response(leakyBody, { status: 401 }));
    const error = await fetchOnecliApiKey(APP_URL, { fetch }).then(
      () => undefined,
      (failure: unknown) => failure,
    );

    expect(error).toMatchObject({ code: 'onecli_request_failed', message: expect.stringContaining('HTTP 401') });
    expectNoBody(error);
  });
});
