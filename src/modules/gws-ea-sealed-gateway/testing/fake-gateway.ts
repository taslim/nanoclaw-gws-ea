/**
 * A OneCLI at the pinned gateway version (1.45+), as far as host-owned identities use it: the agent-grants admin
 * routes, and which secrets the gateway would inject into an identity's request. New identities start with zero
 * grants; legacy `/secret-mode` and `/secrets` routes answer `410 Gone`. Callers unstub envs and globals after each
 * test.
 */
import { vi } from 'vitest';

export interface FakeGatewaySecret {
  readonly id: string;
  readonly hostPattern: string;
  readonly name?: string;
}

export interface FakeGatewayAgent {
  readonly id: string;
  readonly identifier: string;
  readonly name: string;
  secretMode?: string;
  secrets: string[];
}

export interface FakeGateway {
  /** Keyed by identifier, the agent group's ID. */
  readonly agents: Map<string, FakeGatewayAgent>;
  /** What the gateway's own create at a spawn leaves: an identity with zero secret grants. */
  createDefault(identifier: string, name: string): FakeGatewayAgent;
  /** The secret IDs the gateway would inject into a request `identifier` sends to `host`. */
  injected(identifier: string, host: string): string[];
}

export const GATEWAY_URL = 'http://onecli.example.test';
export const MODEL_SECRET: FakeGatewaySecret = { id: 'model', name: 'Anthropic', hostPattern: 'api.anthropic.com' };
export const APP_SECRET: FakeGatewaySecret = {
  id: 'ledgerly',
  name: 'Ledgerly',
  hostPattern: 'app.ledgerly.example.test',
};

export function useFakeGateway(secrets: readonly FakeGatewaySecret[] = [MODEL_SECRET, APP_SECRET]): FakeGateway {
  const agents = new Map<string, FakeGatewayAgent>();
  const createDefault = (identifier: string, name: string): FakeGatewayAgent => {
    const existing = agents.get(identifier);
    if (existing) return existing;
    const agent: FakeGatewayAgent = {
      id: `oc-agent-${agents.size + 1}`,
      identifier,
      name,
      secretMode: 'selective',
      secrets: [],
    };
    agents.set(identifier, agent);
    return agent;
  };
  const passThrough = globalThis.fetch;
  vi.stubEnv('ONECLI_URL', GATEWAY_URL);
  vi.stubEnv('ONECLI_API_KEY', `oc_${'k'.repeat(32)}`);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin !== GATEWAY_URL) return passThrough(input, init);
      const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      if (url.pathname === '/v1/secrets') return Response.json(secrets);
      if (url.pathname === '/v1/agents' && init?.method === 'POST') {
        const { identifier, name } = body as { identifier: string; name: string };
        if (agents.has(identifier)) return Response.json({ error: 'exists' }, { status: 409 });
        createDefault(identifier, name);
        return Response.json({}, { status: 201 });
      }
      if (url.pathname === '/v1/agents') return Response.json([...agents.values()]);
      if (/^\/v1\/agents\/[^/]+\/(?:secret-mode|secrets)$/u.test(url.pathname)) {
        return Response.json({ error: 'gone' }, { status: 410 });
      }
      const grantsMatch = /^\/v1\/agents\/([^/]+)\/grants$/u.exec(url.pathname);
      if (grantsMatch && (init?.method ?? 'GET') === 'GET') {
        const agent = [...agents.values()].find((entry) => entry.id === decodeURIComponent(grantsMatch[1]!));
        if (!agent) return Response.json({ error: 'not found' }, { status: 404 });
        return Response.json({ secrets: agent.secrets.map((secretId) => ({ secretId })) });
      }
      const secretGrantMatch = /^\/v1\/agents\/([^/]+)\/grants\/secrets\/([^/]+)$/u.exec(url.pathname);
      if (secretGrantMatch) {
        const agentId = decodeURIComponent(secretGrantMatch[1]!);
        const secretId = decodeURIComponent(secretGrantMatch[2]!);
        const agent = [...agents.values()].find((entry) => entry.id === agentId);
        if (!agent) return Response.json({ error: 'not found' }, { status: 404 });
        if (init?.method === 'PUT') {
          if (!agent.secrets.includes(secretId)) agent.secrets.push(secretId);
          return Response.json({ success: true });
        }
        if (init?.method === 'DELETE') {
          agent.secrets = agent.secrets.filter((id) => id !== secretId);
          return Response.json({ success: true });
        }
      }
      return Response.json({ error: 'not found' }, { status: 404 });
    }),
  );
  return {
    agents,
    createDefault,
    injected(identifier, host) {
      const agent = agents.get(identifier);
      if (!agent) return [];
      return secrets
        .filter((secret) => secret.hostPattern === host)
        .filter((secret) => agent.secretMode === 'all' || agent.secrets.includes(secret.id))
        .map((secret) => secret.id);
    },
  };
}
