/**
 * The OneCLI secrets that inject the assistant's Google tokens (KTD2), written
 * through OneCLI's `/v1/secrets` API so a token travels only in a request
 * body, never in a process argument. OneCLI sets the header on every matching
 * request, replacing the placeholder a tool sends.
 */
export interface OnecliApi {
  /** OneCLI's app URL, e.g. `http://127.0.0.1:31002`. */
  readonly url: string;
  readonly apiKey: string;
  readonly fetch?: typeof globalThis.fetch;
}

export interface InjectedSecret {
  readonly id: string;
  readonly name: string;
  readonly hostPattern: string;
}

const BEARER_INJECTION = { headerName: 'Authorization', valueFormat: 'Bearer {value}' } as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function call(api: OnecliApi, method: string, route: string, body?: unknown): Promise<Response> {
  const fetchImpl = api.fetch ?? globalThis.fetch;
  const response = await fetchImpl(new URL(route, api.url), {
    method,
    headers: {
      Authorization: `Bearer ${api.apiKey}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`OneCLI ${method} ${route} failed with HTTP ${response.status}`);
  return response;
}

/** Every secret OneCLI holds for this instance, by name and host; values never come back. */
export async function listInjectedSecrets(api: OnecliApi): Promise<InjectedSecret[]> {
  const payload: unknown = await (await call(api, 'GET', '/v1/secrets')).json();
  if (!Array.isArray(payload)) throw new Error('OneCLI returned an unreadable secret list');
  return payload.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.id !== 'string' ||
      typeof entry.name !== 'string' ||
      typeof entry.hostPattern !== 'string'
    ) {
      throw new Error('OneCLI returned an unreadable secret');
    }
    return { id: entry.id, name: entry.name, hostPattern: entry.hostPattern };
  });
}

/** The one secret named `name`, or none; two by that name are refused rather than guessed between. */
export async function findInjectedSecret(api: OnecliApi, name: string): Promise<InjectedSecret | undefined> {
  const matching = (await listInjectedSecrets(api)).filter((secret) => secret.name === name);
  if (matching.length > 1) throw new Error(`OneCLI holds more than one secret named ${name}`);
  return matching[0];
}

/** Create or update the bearer-token secret `name` on `hostPattern`, with `value` only in the request body. */
export async function upsertBearerSecret(
  api: OnecliApi,
  secret: { readonly name: string; readonly hostPattern: string; readonly value: string },
): Promise<'created' | 'updated'> {
  const existing = await findInjectedSecret(api, secret.name);
  if (existing) {
    await call(api, 'PATCH', `/v1/secrets/${encodeURIComponent(existing.id)}`, {
      value: secret.value,
      hostPattern: secret.hostPattern,
      pathPattern: null,
      injectionConfig: BEARER_INJECTION,
    });
    return 'updated';
  }
  await call(api, 'POST', '/v1/secrets', {
    name: secret.name,
    type: 'generic',
    value: secret.value,
    hostPattern: secret.hostPattern,
    injectionConfig: BEARER_INJECTION,
  });
  return 'created';
}
