/** Synthetic metadata transport for the native chat group's gateway reconciliation. */
export function syntheticGateway(): (url: URL, init?: RequestInit) => Response {
  process.env.ONECLI_URL = 'https://synthetic-onecli.invalid';
  process.env.ONECLI_API_KEY = 'synthetic-only';
  const agents = new Map<string, { id: string; identifier: string; name: string; secretMode: string }>();
  const assignments = new Map<string, string[]>();
  const json = (value: unknown): Response =>
    new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  return (url, init) => {
    const method = init?.method ?? 'GET';
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    if (url.pathname === '/v1/secrets' && method === 'GET')
      return json([{ id: 'synthetic-model-secret', hostPattern: 'api.anthropic.com' }]);
    if (url.pathname === '/v1/agents') {
      if (method === 'GET') return json([...agents.values()]);
      if (method === 'POST' && typeof body.identifier === 'string' && typeof body.name === 'string') {
        const id = `synthetic-gateway-${agents.size + 1}`;
        agents.set(id, { id, identifier: body.identifier, name: body.name, secretMode: 'all' });
        return json({ id });
      }
    }
    const [, version, resource, id, field] = url.pathname.split('/');
    const agent = id ? agents.get(id) : undefined;
    if (version === 'v1' && resource === 'agents' && agent) {
      if (field === 'secret-mode' && method === 'PATCH' && body.mode === 'selective') {
        agent.secretMode = body.mode;
        return json({});
      }
      if (field === 'secrets') {
        if (method === 'GET') return json(assignments.get(agent.id) ?? []);
        if (
          method === 'PUT' &&
          Array.isArray(body.secretIds) &&
          body.secretIds.every((value): value is string => value === 'synthetic-model-secret')
        ) {
          assignments.set(agent.id, body.secretIds);
          return json({});
        }
      }
    }
    throw new Error(`Unsupported synthetic gateway operation: ${method} ${url.pathname}`);
  };
}
