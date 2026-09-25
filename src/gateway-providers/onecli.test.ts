import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GatewayApprovalRequest, GatewaySessionInput } from './gateway-provider-registry.js';

const sdk = vi.hoisted(() => ({
  ensureAgent: vi.fn(async () => ({ created: false })),
  getContainerConfig: vi.fn(async () => ({
    env: { HTTPS_PROXY: 'http://host.docker.internal:15001' },
    caCertificate: 'fixture-ca',
    caCertificateContainerPath: '/tmp/onecli-ca.pem',
  })),
}));

vi.mock('@onecli-sh/sdk', () => ({
  OneCLI: class {
    ensureAgent = sdk.ensureAgent;
    getContainerConfig = sdk.getContainerConfig;
  },
}));
vi.mock('../config.js', async (original) => ({
  ...(await original<typeof import('../config.js')>()),
  DATA_DIR: '/tmp/nanoclaw-onecli-adapter-review',
}));

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));
vi.mock('../env.js', () => ({
  readEnvFile: () => ({
    ONECLI_URL: 'http://localhost:1',
    ONECLI_API_KEY: 'unused',
    ANTHROPIC_BASE_URL: 'https://anthropic.example.com',
  }),
}));

import { contributionFromConfig, withProviderEnv } from './onecli.js';
import { getGatewayProviderRegistration } from './gateway-provider-registry.js';

const provider = getGatewayProviderRegistration('onecli')!;
const scope = { ownsAgentGroup: vi.fn(async (id: string) => id === 'g1') };
const subscribe = (decide: Parameters<typeof provider.approvals.subscribe>[0], signal: AbortSignal) =>
  provider.approvals.subscribe(decide, signal, undefined, scope);
const input = (sessionId: string): GatewaySessionInput => ({
  key: { installSlug: 'install', agentGroupId: 'g1', sessionId },
  runtimeIdentity: `install/g1/${sessionId}`,
  groupName: 'Group One',
  containerName: 'fixture-agent',
  capabilities: {} as never,
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync('/tmp/nanoclaw-onecli-adapter-review', { recursive: true, force: true });
});

function mockApprovalPoll(requests: Record<string, unknown>[]) {
  const decisions: Array<{ id: string; decision: string }> = [];
  let polled = false;
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
    const endpoint = new URL(String(url));
    if (endpoint.pathname === '/v1/gateway-url') return Response.json({ url: 'http://gateway.test' });
    if (endpoint.pathname.endsWith('/decision')) {
      decisions.push({ id: endpoint.pathname.split('/')[3], ...JSON.parse(String(options?.body)) });
      return new Response('{}');
    }
    if (!polled) {
      polled = true;
      return Response.json({ requests, timeoutSeconds: 30 });
    }
    return new Promise<Response>((_resolve, reject) => {
      options!.signal!.addEventListener('abort', () => reject(new Error('stopped')), { once: true });
    });
  });
  return { decisions, fetchMock };
}

describe('OneCLI gateway package', () => {
  it.each(['copy-a', 'copy-b'])('leaves foreign requests untouched by the native poller: %s', async (owned) => {
    const controller = new AbortController();
    const requests = ['copy-a', 'copy-b'].flatMap((group) =>
      [false, true].map((stale) => ({
        id: `${group}-${stale ? 'stale' : 'fresh'}`,
        createdAt: new Date(stale ? 0 : Date.now() + 1000).toISOString(),
        expiresAt: new Date(Date.now() + 30000).toISOString(),
        method: 'POST',
        host: 'api.example.test',
        path: '/resource',
        agent: { name: group, externalId: group },
      })),
    );
    const { decisions, fetchMock } = mockApprovalPoll(requests);
    const decide = vi.fn(async () => 'approve' as const);
    const running = provider.approvals.subscribe(decide, controller.signal, undefined, {
      ownsAgentGroup: async (id: string) => id === owned,
    });
    try {
      await vi.waitFor(() => expect(decisions.length).toBeGreaterThanOrEqual(2));
      expect(decisions.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
        { id: `${owned}-fresh`, decision: 'approve' },
        { id: `${owned}-stale`, decision: 'deny' },
      ]);
      expect(decide).toHaveBeenCalledTimes(1);
    } finally {
      controller.abort();
      await running;
      fetchMock.mockRestore();
    }
  });

  it('submits no decision if installation ownership cannot be read', async () => {
    const controller = new AbortController();
    const decide = vi.fn(async () => 'approve' as const);
    const { decisions } = mockApprovalPoll([
      {
        id: 'foreign',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
        method: 'POST',
        host: 'api.example.test',
        path: '/resource',
        agent: { name: 'other', externalId: 'other' },
      },
    ]);
    const running = provider.approvals.subscribe(decide, controller.signal, undefined, {
      ownsAgentGroup: async () => {
        throw new Error('ownership unavailable');
      },
    });
    try {
      await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(3));
      expect(decisions).toEqual([]);
      expect(decide).not.toHaveBeenCalled();
    } finally {
      controller.abort();
      await running;
    }
  });

  it('keeps same-basename stubs separate across destinations and agents on the real filesystem', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onecli-stubs-'));
    try {
      const config = {
        env: {},
        caCertificate: 'CA',
        caCertificateContainerPath: '/tmp/ca.pem',
        credentialStubs: [
          { containerPath: '/first/config.json', content: 'first-stub' },
          { containerPath: '/second/config.json', content: 'second-stub' },
        ],
      };
      const first = contributionFromConfig(config, 'g1', root);
      const second = contributionFromConfig(
        { ...config, credentialStubs: [{ containerPath: '/first/config.json', content: 'other-agent' }] },
        'g2',
        root,
      );
      const a = first.mounts!.find((m) => m.containerPath === '/first/config.json')!;
      const b = first.mounts!.find((m) => m.containerPath === '/second/config.json')!;
      expect(a.hostPath).not.toBe(b.hostPath);
      expect(fs.readFileSync(a.hostPath, 'utf8')).toBe('first-stub');
      expect(fs.readFileSync(b.hostPath, 'utf8')).toBe('second-stub');
      expect(second.mounts!.find((m) => m.containerPath === '/first/config.json')!.hostPath).not.toBe(a.hostPath);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('exposes gateway discovery rejection through the provider subscription', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 503 }));
    try {
      await expect(subscribe(async () => 'deny', new AbortController().signal)).rejects.toThrow(
        'Failed to resolve gateway URL',
      );
      expect(fetchMock).toHaveBeenCalledWith(
        expect.objectContaining({ pathname: '/v1/gateway-url' }),
        expect.anything(),
      );
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('rejects the subscription when polling returns 503', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (url) =>
        new URL(String(url)).pathname === '/v1/gateway-url'
          ? Response.json({ url: 'http://gateway.test' })
          : new Response('', { status: 503 }),
      );
    await expect(
      provider.approvals.subscribe(async () => 'deny', new AbortController().signal, undefined, scope),
    ).rejects.toThrow('approval poll failed (503)');
    fetchMock.mockRestore();
  });

  it('ends the subscription if a later approval poll fails', async () => {
    let polls = 0;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (new URL(String(url)).pathname === '/v1/gateway-url') return Response.json({ url: 'http://gateway.test' });
      polls++;
      return polls === 1 ? Response.json({ requests: [] }) : new Response('', { status: 503 });
    });
    await expect(
      provider.approvals.subscribe(async () => 'deny', new AbortController().signal, undefined, scope),
    ).rejects.toThrow('approval poll failed (503)');
    fetchMock.mockRestore();
  });

  it('leaves an approval pending when core cannot reach a human', async () => {
    const controller = new AbortController();
    const { decisions, fetchMock } = mockApprovalPoll([
      {
        id: 'pending',
        createdAt: new Date(Date.now() + 1000).toISOString(),
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
        method: 'POST',
        host: 'api.example.test',
        path: '/resource',
        agent: { name: 'Group One', externalId: 'g1' },
      },
    ]);
    const decide = vi.fn(async () => 'unavailable' as const);
    const running = subscribe(decide, controller.signal);
    await vi.waitFor(() => expect(decide).toHaveBeenCalledOnce());
    expect(decisions).toEqual([]);
    controller.abort();
    await running;
    fetchMock.mockRestore();
  });

  it('owns endpoint configuration and returns a typed session contribution', async () => {
    const controller = new AbortController();
    const lease = await provider.sessions.ensure(input('s1'), controller.signal);

    expect(sdk.ensureAgent).toHaveBeenCalledWith({ name: 'Group One', identifier: 'g1' });
    expect(sdk.getContainerConfig).toHaveBeenCalledWith({ agent: 'g1' });
    expect(lease.contribution).toMatchObject({
      env: {
        HTTPS_PROXY: 'http://host.docker.internal:15001',
        ANTHROPIC_BASE_URL: 'https://anthropic.example.com',
        ANTHROPIC_AUTH_TOKEN: 'gateway-managed',
      },
      networkAccess: {
        endpoint: 'host.docker.internal',
        target: { kind: 'runtime', identity: 'onecli' },
      },
    });
    expect(withProviderEnv({}, '')).toEqual({});
    controller.abort();
  });

  it('adopts only an existing OneCLI agent and never recreates a deleted identity', async () => {
    sdk.getContainerConfig.mockRejectedValueOnce(new Error('agent not found'));
    await expect(
      provider.sessions.ensure({ ...input('survivor'), disposition: 'adopt' }, new AbortController().signal),
    ).rejects.toThrow('agent not found');
    expect(sdk.ensureAgent).not.toHaveBeenCalled();
    expect(sdk.getContainerConfig).toHaveBeenCalledWith({ agent: 'g1' });
  });

  it('shares one health monitor across live leases and reports failure to each session', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = await provider.sessions.ensure(input('s1'), firstController.signal);
    const second = await provider.sessions.ensure(input('s2'), secondController.signal);
    const unavailable = vi.fn();
    first.onUnavailable?.(unavailable);
    second.onUnavailable?.(unavailable);

    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(unavailable).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);

    firstController.abort();
    secondController.abort();
    fetchMock.mockRestore();
  });

  it('translates native approvals once and stops the subscription on cancellation', async () => {
    const decide = vi.fn(async (_request: GatewayApprovalRequest) => 'approve' as const);
    const controller = new AbortController();
    const createdAt = new Date(Date.now() + 1_000).toISOString();
    const { decisions } = mockApprovalPoll([
      {
        id: 'native-1',
        createdAt,
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
        method: 'POST',
        host: 'api.example.test',
        path: '/resource?token=secret#fragment',
        bodyPreview: '{"safe":"preview","mention":"<@U123>"}',
        agent: { name: 'Group <@U123>', externalId: 'g1' },
      },
      {
        id: 'stale',
        createdAt: new Date(0).toISOString(),
        method: 'GET',
        host: 'api.example.test',
        path: '/',
        agent: { name: 'Group One', externalId: 'g1' },
      },
    ]);
    const subscription = subscribe(decide, controller.signal);
    await vi.waitFor(() => expect(decisions).toHaveLength(2));
    expect(decide).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'native-1',
        trigger: 'policy',
        destination: { host: 'api.example.test', method: 'POST' },
        agentGroupId: 'g1',
        createdAt,
        title: 'Credentials Request',
        audit: { method: 'POST', host: 'api.example.test', path: '/resource' },
      }),
    );
    expect(decide.mock.calls[0][0].question).not.toContain('<@U123>');
    expect(JSON.stringify(decide.mock.calls[0][0])).not.toContain('secret');

    expect(decisions).toEqual(
      expect.arrayContaining([
        { id: 'native-1', decision: 'approve' },
        { id: 'stale', decision: 'deny' },
      ]),
    );
    expect(decide).toHaveBeenCalledTimes(1);

    controller.abort();
    await subscription;
  });
});

const compatibilityFixtures = JSON.parse(fs.readFileSync('gateway-compat/onecli-summary/fixtures.json', 'utf8')) as {
  name: string;
  request: { host: string; method: string; path: string };
  summary: { action: string; details: { label: string; value: string }[] };
}[];

it.each(compatibilityFixtures)('preserves native OneCLI approval content: $name', async (fixture) => {
  const decide = vi.fn(async (_request: GatewayApprovalRequest) => 'deny' as const);
  const controller = new AbortController();
  const { decisions } = mockApprovalPoll([
    {
      id: 'native-fixture',
      createdAt: new Date(Date.now() + 1000).toISOString(),
      expiresAt: new Date(Date.now() + 30000).toISOString(),
      ...fixture.request,
      summary: fixture.summary,
      agent: { name: 'Nano', externalId: 'g1' },
    },
  ]);
  const subscription = subscribe(decide, controller.signal);
  await vi.waitFor(() => expect(decisions).toHaveLength(1));
  expect(decide.mock.calls[0][0].summary).toEqual({
    agent: 'Nano',
    action: fixture.summary.action,
    details: fixture.summary.details,
    resource: `${fixture.request.method} ${fixture.request.host}${fixture.request.path}`,
    reason: 'The gateway policy requires human approval for this request.',
  });
  controller.abort();
  await subscription;
});
