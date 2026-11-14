/**
 * A OneCLI at the pinned gateway version, as far as host-owned identities use it: the admin routes, and which
 * secrets the gateway would inject into an identity's request. An identity in `all` mode gets every secret for the
 * host; a `selective` one only those assigned to it. Callers unstub envs and globals after each test.
 */
import { vi } from 'vitest';

export interface FakeGatewaySecret {
  readonly id: string;
  readonly hostPattern: string;
}

export interface FakeGatewayAgent {
  readonly id: string;
  readonly identifier: string;
  readonly name: string;
  secretMode: string;
  secrets: string[];
}

export interface FakeGateway {
  /** Keyed by identifier, the agent group's ID. */
  readonly agents: Map<string, FakeGatewayAgent>;
  /** What the gateway's own create at a spawn leaves: an identity in its default all-secrets mode. */
  createDefault(identifier: string, name: string): FakeGatewayAgent;
  /** The secret IDs the gateway would inject into a request `identifier` sends to `host`. */
  injected(identifier: string, host: string): string[];
}

export const GATEWAY_URL = 'http://onecli.example.test';
export const MODEL_SECRET: FakeGatewaySecret = { id: 'model', hostPattern: 'api.anthropic.com' };
export const APP_SECRET: FakeGatewaySecret = { id: 'homeboard', hostPattern: 'homeboard.nownow.ai' };

export function useFakeGateway(secrets: readonly FakeGatewaySecret[] = [MODEL_SECRET, APP_SECRET]): FakeGateway {
  const agents = new Map<string, FakeGatewayAgent>();
  const createDefault = (identifier: string, name: string): FakeGatewayAgent => {
    const existing = agents.get(identifier);
    if (existing) return existing;
    const agent = { id: `oc-agent-${agents.size + 1}`, identifier, name, secretMode: 'all', secrets: [] };
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
      const match = /^\/v1\/agents\/([^/]+)\/(secret-mode|secrets)$/u.exec(url.pathname);
      const agent = [...agents.values()].find((entry) => entry.id === match?.[1]);
      if (!match || !agent) return Response.json({ error: 'not found' }, { status: 404 });
      if (match[2] === 'secret-mode') agent.secretMode = (body as { mode: string }).mode;
      else if (init?.method === 'PUT') agent.secrets = [...(body as { secretIds: string[] }).secretIds];
      else return Response.json(agent.secrets);
      return Response.json({ success: true });
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
