import { describe, expect, it } from 'vitest';

import {
  artifactsIngress,
  artifactsPathPrefix,
  createArtifactsCloudflareApi,
  parseArtifactsOperatorConfig,
} from './artifacts-cloudflare.js';

const instanceId = '00000000-0000-4000-8000-000000000001';
const attemptKey = '00000000-0000-4000-8000-000000000002';
const operatorConfig = () => ({
  schemaVersion: 1,
  accountId: 'account',
  zoneId: 'zone',
  teamName: 'team',
  hostname: 'views.example.test',
  credentialFile: '/operator/artifacts/management-token',
  cloudflaredPath: '/usr/local/bin/cloudflared',
  dns: {},
  assistants: {},
});

describe('artifacts Cloudflare boundary', () => {
  it('constructs only validated owned fields, including nested recovery and service records', () => {
    const raw = {
      ...operatorConfig(),
      unrecognized: 'discard',
      dns: { 'views.example.test': { id: 'dns', zoneId: 'zone', unrecognized: 'discard' } },
      assistants: {
        [instanceId]: {
          enabled: false,
          claim: { hostname: 'views.example.test', path_prefix: '/robin', listen_port: 41000, unrecognized: 'discard' },
          unrecognized: 'discard',
        },
      },
      pin: { id: 'pin', owned: false, unrecognized: 'discard' },
      connector: {
        manager: 'systemd-user',
        definitionFile: '/home/operator/.config/systemd/user/com.gws-ea.artifacts.0000000000000000.service',
        homeDirectory: '/home/operator',
        label: 'com.gws-ea.artifacts.0000000000000000',
        unrecognized: 'discard',
      },
      pending: {
        kind: 'tunnel',
        key: attemptKey,
        target: 'operator',
        startedAt: '2026-10-23T00:00:00.000Z',
        resource: '/accounts/account/cfd_tunnel',
        fingerprint: 'a'.repeat(64),
        name: 'Owned attempt',
        unrecognized: 'discard',
      },
      resolvedAttempts: [
        {
          kind: 'pin',
          key: instanceId,
          target: 'operator',
          startedAt: '2026-10-22T00:00:00.000Z',
          resource: '/accounts/account/access/identity_providers',
          fingerprint: 'b'.repeat(64),
          resolvedAt: '2026-10-23T00:00:00.000Z',
          resolution: 'operator_removed',
          unrecognized: 'discard',
        },
      ],
    };
    const parsed = parseArtifactsOperatorConfig(raw);
    expect(JSON.stringify(parsed)).not.toContain('unrecognized');
    expect(parsed.dns).toEqual({ 'views.example.test': { id: 'dns', zoneId: 'zone' } });
    expect(parsed.assistants[instanceId]).toEqual({
      enabled: false,
      claim: { hostname: 'views.example.test', path_prefix: '/robin', listen_port: 41000 },
    });
    expect(parsed.pending).toEqual({
      kind: 'tunnel',
      key: attemptKey,
      target: 'operator',
      startedAt: '2026-10-23T00:00:00.000Z',
      resource: '/accounts/account/cfd_tunnel',
      fingerprint: 'a'.repeat(64),
      name: 'Owned attempt',
    });
    expect(parsed.resolvedAttempts?.[0]).toMatchObject({
      kind: 'pin',
      resolution: 'operator_removed',
      resolvedAt: '2026-10-23T00:00:00.000Z',
    });
    expect(parseArtifactsOperatorConfig(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it.each([
    { label: 'DNS ID', patch: { dns: { 'views.example.test': { id: 7, zoneId: 'zone' } } } },
    {
      label: 'assistant reference',
      patch: {
        assistants: {
          [instanceId]: {
            enabled: false,
            applicationId: 7,
            claim: { hostname: 'views.example.test', path_prefix: '/robin', listen_port: 41000 },
          },
        },
      },
    },
    {
      label: 'ambiguous namespace',
      patch: {
        assistants: {
          [instanceId]: {
            enabled: false,
            claim: { hostname: 'views.example.test', path_prefix: '/a%2Fb', listen_port: 41000 },
          },
        },
      },
    },
    {
      label: 'incomplete enabled resources',
      patch: {
        assistants: {
          [instanceId]: {
            enabled: true,
            claim: { hostname: 'views.example.test', path_prefix: '/robin', listen_port: 41000 },
          },
        },
      },
    },
    {
      label: 'connector path',
      patch: {
        connector: {
          manager: 'systemd-user',
          definitionFile: '/unrelated.service',
          homeDirectory: '/home/operator',
          label: 'com.gws-ea.artifacts.0000000000000000',
        },
      },
    },
    {
      label: 'unproven request fingerprint',
      patch: {
        pending: {
          kind: 'tunnel',
          key: attemptKey,
          target: 'operator',
          startedAt: '2026-10-23T00:00:00.000Z',
          resource: '/accounts/account/cfd_tunnel',
        },
      },
    },
    {
      label: 'recovery acknowledgment',
      patch: {
        resolvedAttempts: [
          {
            kind: 'tunnel',
            key: attemptKey,
            target: 'operator',
            startedAt: '2026-10-23T00:00:00.000Z',
            resource: '/accounts/account/cfd_tunnel',
            fingerprint: 'a'.repeat(64),
            resolution: 'adopted',
            resolvedAt: '2026-10-23T00:00:00.000Z',
          },
        ],
      },
    },
  ])('refuses malformed nested $label', ({ patch }) => {
    expect(() => parseArtifactsOperatorConfig({ ...operatorConfig(), ...patch })).toThrow(
      expect.objectContaining({ code: 'artifacts_operator_invalid' }),
    );
  });
  it('claims a canonical first-name segment and matches the decoded Go URL path', () => {
    const pathPrefix = artifactsPathPrefix('  María del Mar  ');
    expect(pathPrefix).toBe('/mar%C3%ADa-del-mar');
    expect(artifactsIngress({ hostname: 'views.example.test', path_prefix: pathPrefix, listen_port: 41234 })).toEqual({
      hostname: 'views.example.test',
      path: '^/maría-del-mar(/|$)',
      service: 'http://127.0.0.1:41234',
    });
    expect(artifactsIngress({ hostname: 'views.example.test', path_prefix: '/a.b', listen_port: 41234 }).path).toBe(
      '^/a\\.b(/|$)',
    );
  });

  it.each(['', '.', '..', 'public', 'a/b', 'a\\b', 'a%2fb', 'a\u0000b'])(
    'refuses ambiguous or reserved first name %j',
    (name) => {
      expect(() => artifactsPathPrefix(name)).toThrow();
    },
  );

  it('bounds rate-limit retries and never exposes Cloudflare response material', async () => {
    let requests = 0;
    const delays: number[] = [];
    const api = createArtifactsCloudflareApi('private-token-fixture', {
      fetch: async () => {
        requests++;
        return new Response(JSON.stringify({ success: false, errors: [{ message: 'private-token-fixture' }] }), {
          status: 429,
          headers: { 'Retry-After': '1' },
        });
      },
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    await expect(api.request('GET', '/accounts/account/access/apps')).rejects.toMatchObject({
      code: 'artifacts_cloudflare_rate_limited',
      message: 'Cloudflare rate limited this operation. Retry after the reported delay.',
    });
    expect(requests).toBe(2);
    expect(delays).toEqual([1000]);
  });
});
