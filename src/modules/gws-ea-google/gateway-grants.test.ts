import { describe, expect, it, vi } from 'vitest';

import { createOnecliAdmin, type OnecliAdmin } from '../../gws-ea/onecli-admin.js';
import {
  entitledGoogleSecretNames,
  publishedGoogleSecretIds,
  reconcileAllGoogleGrants,
  reconcileGroupGoogleGrants,
} from './gateway-grants.js';
import { AGENT_GOOGLE_CREDENTIALS } from './grant.js';

interface FakeVault {
  readonly secrets: Array<{ id: string; name: string; hostPattern: string }>;
  readonly agents: Map<string, { id: string; identifier: string; name: string; secretMode: string; grants: string[] }>;
  readonly admin: OnecliAdmin;
}

function fakeVault(
  extraSecrets: Array<{ id: string; name: string; hostPattern: string }> = [
    { id: 'sec-model', name: 'Anthropic', hostPattern: 'api.anthropic.com' },
    { id: 'sec-operator', name: 'Linear MCP', hostPattern: 'mcp.linear.example.test' },
  ],
): FakeVault {
  const secrets = [
    ...extraSecrets,
    ...AGENT_GOOGLE_CREDENTIALS.map((credential) => ({
      id: `sec-${credential.secretName}`,
      name: credential.secretName,
      hostPattern: credential.host,
    })),
  ];
  const agents = new Map<
    string,
    { id: string; identifier: string; name: string; secretMode: string; grants: string[] }
  >();
  let seq = 0;
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    if (url.pathname === '/v1/secrets' && method === 'GET') return Response.json(secrets);
    if (url.pathname === '/v1/agents' && method === 'GET') {
      return Response.json(
        [...agents.values()].map(({ id, identifier, name, secretMode }) => ({ id, identifier, name, secretMode })),
      );
    }
    if (url.pathname === '/v1/agents' && method === 'POST') {
      const identifier = String(body?.identifier);
      const name = String(body?.name);
      if (agents.has(identifier)) return Response.json({ error: 'exists' }, { status: 409 });
      agents.set(identifier, { id: `oc-${++seq}`, identifier, name, secretMode: 'selective', grants: [] });
      return Response.json({}, { status: 201 });
    }
    const grantsMatch = /^\/v1\/agents\/([^/]+)\/grants$/u.exec(url.pathname);
    if (grantsMatch && method === 'GET') {
      const agent = [...agents.values()].find((entry) => entry.id === decodeURIComponent(grantsMatch[1]!));
      if (!agent) return Response.json({ error: 'not found' }, { status: 404 });
      return Response.json({ secrets: agent.grants.map((secretId) => ({ secretId })) });
    }
    const secretGrantMatch = /^\/v1\/agents\/([^/]+)\/grants\/secrets\/([^/]+)$/u.exec(url.pathname);
    if (secretGrantMatch) {
      const agent = [...agents.values()].find((entry) => entry.id === decodeURIComponent(secretGrantMatch[1]!));
      const secretId = decodeURIComponent(secretGrantMatch[2]!);
      if (!agent) return Response.json({ error: 'not found' }, { status: 404 });
      if (method === 'PUT') {
        if (!agent.grants.includes(secretId)) agent.grants.push(secretId);
        return Response.json({ success: true });
      }
      if (method === 'DELETE') {
        agent.grants = agent.grants.filter((id) => id !== secretId);
        return Response.json({ success: true });
      }
    }
    return Response.json({ error: 'not found' }, { status: 404 });
  });
  return {
    secrets,
    agents,
    admin: createOnecliAdmin('http://127.0.0.1:31002', `oc_${'k'.repeat(32)}`, {
      fetch: fetch as unknown as typeof globalThis.fetch,
    }),
  };
}

describe('entitledGoogleSecretNames', () => {
  const allGoogleCaps = new Set(['google-calendar', 'google-mail-read', 'google-directory', 'google-workspace']);

  it('grants all 7 Google host credentials to main when it holds all Google capabilities', () => {
    expect([...entitledGoogleSecretNames(allGoogleCaps, true)].sort()).toEqual(
      AGENT_GOOGLE_CREDENTIALS.map((credential) => credential.secretName).sort(),
    );
  });

  it('withholds main-only google-workspace credentials from non-main groups even when they hold all capabilities', () => {
    expect([...entitledGoogleSecretNames(allGoogleCaps, false)].sort()).toEqual([
      'google-calendar',
      'google-directory',
      'google-gmail-read',
    ]);
  });

  it('maps individual capabilities to exact Google host secrets and returns empty for sealed groups', () => {
    expect([...entitledGoogleSecretNames(new Set(['google-mail-read']), false)]).toEqual(['google-gmail-read']);
    expect([...entitledGoogleSecretNames(new Set(['reply', 'browser', 'time']), false)]).toEqual([]);
  });
});

describe('reconcileGroupGoogleGrants', () => {
  it('attaches all 7 Google grants to main while preserving model and operator MCP grants', async () => {
    const vault = fakeVault();
    vault.agents.set('ag-main', {
      id: 'oc-main',
      identifier: 'ag-main',
      name: 'main',
      secretMode: 'selective',
      grants: ['sec-model', 'sec-operator'],
    });

    await reconcileGroupGoogleGrants('ag-main', {
      admin: vault.admin,
      capabilities: new Set(['google-calendar', 'google-mail-read', 'google-directory', 'google-workspace']),
      isMain: true,
    });

    expect(vault.agents.get('ag-main')!.grants.slice().sort()).toEqual(
      ['sec-model', 'sec-operator', ...AGENT_GOOGLE_CREDENTIALS.map((c) => `sec-${c.secretName}`)].sort(),
    );
  });

  it('attaches capability-exact grants to non-main groups and detaches revoked Google grants without touching model or operator grants', async () => {
    const vault = fakeVault();
    vault.agents.set('ag-custom', {
      id: 'oc-custom',
      identifier: 'ag-custom',
      name: 'research',
      secretMode: 'selective',
      grants: ['sec-model', 'sec-operator', 'sec-google-docs', 'sec-google-gmail-read'],
    });

    await reconcileGroupGoogleGrants('ag-custom', {
      admin: vault.admin,
      capabilities: new Set(['google-calendar']),
      isMain: false,
    });

    expect(vault.agents.get('ag-custom')!.grants.slice().sort()).toEqual([
      'sec-google-calendar',
      'sec-model',
      'sec-operator',
    ]);
  });

  it('creates a missing OneCLI identity on spawn only when the group is entitled to Google access', async () => {
    const vault = fakeVault();

    await reconcileGroupGoogleGrants('ag-no-google', {
      admin: vault.admin,
      capabilities: new Set(['reply']),
      isMain: false,
      groupName: 'no-google',
      createMissingAgent: true,
    });
    expect(vault.agents.has('ag-no-google')).toBe(false);

    await reconcileGroupGoogleGrants('ag-cal', {
      admin: vault.admin,
      capabilities: new Set(['google-calendar']),
      isMain: false,
      groupName: 'calendar-helper',
      createMissingAgent: true,
    });
    expect(vault.agents.get('ag-cal')?.grants).toEqual(['sec-google-calendar']);
  });
});

describe('reconcileAllGoogleGrants', () => {
  it('reconciles non-protected groups and skips host-owned sealed groups completely', async () => {
    const vault = fakeVault();
    vault.agents.set('ag-main', {
      id: 'oc-main',
      identifier: 'ag-main',
      name: 'main',
      secretMode: 'selective',
      grants: ['sec-model'],
    });
    vault.agents.set('ag-browser', {
      id: 'oc-browser',
      identifier: 'ag-browser',
      name: 'browser',
      secretMode: 'selective',
      grants: ['sec-model', 'sec-google-calendar'],
    });
    vault.agents.set('ag-custom', {
      id: 'oc-custom',
      identifier: 'ag-custom',
      name: 'custom',
      secretMode: 'selective',
      grants: ['sec-model'],
    });

    await reconcileAllGoogleGrants(vault.admin, {
      listGroups: async () => [
        { id: 'ag-main', name: 'main' },
        { id: 'ag-browser', name: 'browser' },
        { id: 'ag-custom', name: 'custom' },
      ],
      mainGroupId: () => 'ag-main',
      isProtected: async (id) => id === 'ag-browser',
      getCapabilities: async (id) => {
        if (id === 'ag-main')
          return new Set(['google-calendar', 'google-mail-read', 'google-directory', 'google-workspace']);
        if (id === 'ag-custom') return new Set(['google-calendar', 'google-workspace']);
        return new Set(['browser']);
      },
    });

    expect(vault.agents.get('ag-main')!.grants).toHaveLength(1 + AGENT_GOOGLE_CREDENTIALS.length);
    // Non-main custom group gets google-calendar only (google-workspace stays main-only).
    expect(vault.agents.get('ag-custom')!.grants.slice().sort()).toEqual(['sec-google-calendar', 'sec-model']);
    // Protected sealed browser group is untouched so sealed-gateway admission catches any drift.
    expect(vault.agents.get('ag-browser')!.grants).toEqual(['sec-model', 'sec-google-calendar']);
    expect(publishedGoogleSecretIds(vault.secrets).size).toBe(AGENT_GOOGLE_CREDENTIALS.length);
  });
});
