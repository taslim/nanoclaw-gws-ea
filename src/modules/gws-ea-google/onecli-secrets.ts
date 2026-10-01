/**
 * The OneCLI secrets that inject the assistant's Google tokens (KTD2), written
 * through OneCLI's `/v1/secrets` API so a token travels only in a request
 * body, never in a process argument. OneCLI sets the header on every matching
 * request, replacing the placeholder a tool sends.
 */
import { isRecord } from '../../gws-ea/validation.js';

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

/**
 * Every secret named `name`. One is the healthy state; two arise only when the
 * host's refresher and a `connect-google` run create the secret at the same
 * moment, and the next `upsertBearerSecret` keeps one and removes the rest.
 */
export async function findInjectedSecrets(api: OnecliApi, name: string): Promise<InjectedSecret[]> {
  return (await listInjectedSecrets(api)).filter((secret) => secret.name === name);
}

/**
 * Create or update the bearer-token secret `name` on `hostPattern`, with
 * `value` only in the request body. When more than one secret holds the name,
 * the first is updated and the others are deleted, so a creation race heals on
 * the next write instead of leaving two tokens on the same host.
 */
export async function upsertBearerSecret(
  api: OnecliApi,
  secret: { readonly name: string; readonly hostPattern: string; readonly value: string },
): Promise<'created' | 'updated'> {
  const [existing, ...duplicates] = await findInjectedSecrets(api, secret.name);
  if (!existing) {
    await call(api, 'POST', '/v1/secrets', {
      name: secret.name,
      type: 'generic',
      value: secret.value,
      hostPattern: secret.hostPattern,
      injectionConfig: BEARER_INJECTION,
    });
    return 'created';
  }
  await call(api, 'PATCH', `/v1/secrets/${encodeURIComponent(existing.id)}`, {
    value: secret.value,
    hostPattern: secret.hostPattern,
    pathPattern: null,
    injectionConfig: BEARER_INJECTION,
  });
  for (const duplicate of duplicates) await call(api, 'DELETE', `/v1/secrets/${encodeURIComponent(duplicate.id)}`);
  return 'updated';
}
