import { GwsEaError } from './types.js';

const CALLBACK_PATH = '/webhook/gchat';
const MANAGED_WRONG_PATH = '/__gws_ea_wrong_path__';
const WEBHOOK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface ExistingGchatEndpointInput {
  readonly endpointUrl: string;
  readonly audienceUrl: string;
}

export interface VerifiedGchatEndpoint {
  readonly endpointUrl: string;
  readonly audienceUrl: string;
}

export interface ExistingGchatRouteInput {
  readonly endpointUrl: string;
}

export interface ManagedGchatRouteInput {
  readonly endpointUrl: string;
  readonly localEndpointUrl: string;
}

export interface VerifiedManagedGchatRoute {
  readonly endpointUrl: string;
  readonly listenerId: string;
}

export interface EndpointVerificationDependencies {
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

export function validateExistingGchatEndpoint(value: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new GwsEaError('invalid_endpoint', 'Google Chat endpoint is not a valid URL');
  }
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.username !== '' ||
    endpoint.password !== '' ||
    endpoint.search !== '' ||
    endpoint.hash !== '' ||
    endpoint.pathname !== CALLBACK_PATH
  ) {
    throw new GwsEaError(
      'invalid_endpoint',
      'Google Chat endpoint must be HTTPS with the exact /webhook/gchat path and no credentials, query, or fragment',
    );
  }
  return endpoint.href;
}

async function expectUnauthorized(
  fetchImplementation: typeof globalThis.fetch,
  endpointUrl: string,
  authorization: string | undefined,
  timeoutMs: number,
): Promise<Response> {
  let response: Response;
  try {
    const headers = new Headers({ 'content-type': 'application/json' });
    if (authorization !== undefined) headers.set('authorization', authorization);
    response = await fetchImplementation(endpointUrl, {
      method: 'POST',
      redirect: 'manual',
      headers,
      body: '{}',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new GwsEaError('endpoint_unreachable', 'Google Chat endpoint is unreachable');
  }
  if (response.status >= 300 && response.status < 400) {
    throw new GwsEaError('endpoint_redirect', 'Google Chat endpoint must not redirect');
  }
  if (response.redirected || (response.url !== '' && response.url !== endpointUrl)) {
    throw new GwsEaError('endpoint_redirect', 'Google Chat endpoint resolved to a different URL');
  }
  if (response.status !== 401) {
    throw new GwsEaError('endpoint_auth_bypass', 'Google Chat endpoint must return 401 for unauthenticated traffic');
  }
  return response;
}

function validateLocalGchatEndpoint(value: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new GwsEaError('invalid_local_endpoint', 'Local Google Chat endpoint is not a valid URL');
  }
  if (
    endpoint.protocol !== 'http:' ||
    endpoint.hostname !== '127.0.0.1' ||
    endpoint.port === '' ||
    endpoint.username !== '' ||
    endpoint.password !== '' ||
    endpoint.search !== '' ||
    endpoint.hash !== '' ||
    endpoint.pathname !== CALLBACK_PATH
  ) {
    throw new GwsEaError(
      'invalid_local_endpoint',
      'Local Google Chat endpoint must use the exact loopback listener and callback path',
    );
  }
  return endpoint.href;
}

function requireWebhookId(response: Response, location: 'local' | 'public'): string {
  const id = response.headers.get('x-nanoclaw-webhook-id')?.toLowerCase();
  if (!id || !WEBHOOK_ID_PATTERN.test(id)) {
    throw new GwsEaError(
      'managed_listener_id_missing',
      `The ${location} Google Chat callback did not identify its NanoClaw listener`,
    );
  }
  return id;
}

async function expectManagedCatchAll(
  fetchImplementation: typeof globalThis.fetch,
  endpointUrl: string,
  timeoutMs: number,
): Promise<void> {
  const wrongPathUrl = new URL(MANAGED_WRONG_PATH, endpointUrl).href;
  let response: Response;
  try {
    response = await fetchImplementation(wrongPathUrl, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new GwsEaError('managed_catch_all_unreachable', 'Managed Cloudflare catch-all is unreachable');
  }
  if (
    (response.status >= 300 && response.status < 400) ||
    response.redirected ||
    (response.url !== '' && response.url !== wrongPathUrl)
  ) {
    throw new GwsEaError('endpoint_redirect', 'Managed Cloudflare catch-all must not redirect');
  }
  if (response.status !== 404) {
    throw new GwsEaError('managed_catch_all_mismatch', 'Managed Cloudflare catch-all must return 404');
  }
}

/**
 * Verify the operator-owned route without following redirects. A real signed
 * Google Chat event is the authentication proof; a fabricated JWT cannot
 * distinguish signature rejection from audience rejection.
 */
export async function verifyExistingGchatEndpoint(
  input: ExistingGchatEndpointInput,
  dependencies: EndpointVerificationDependencies = {},
): Promise<VerifiedGchatEndpoint> {
  const endpointUrl = validateExistingGchatEndpoint(input.endpointUrl);
  const audienceUrl = validateExistingGchatEndpoint(input.audienceUrl);
  if (endpointUrl !== audienceUrl) {
    throw new GwsEaError('audience_mismatch', 'Google Chat authentication audience must equal the claimed endpoint');
  }
  const fetchImplementation = dependencies.fetch ?? globalThis.fetch;
  const timeoutMs = dependencies.timeoutMs ?? 10_000;
  await expectUnauthorized(fetchImplementation, endpointUrl, undefined, timeoutMs);
  return { endpointUrl, audienceUrl };
}

/** Prove that the operator-owned callback route exists and fails closed. */
export async function verifyExistingGchatRoute(
  input: ExistingGchatRouteInput,
  dependencies: EndpointVerificationDependencies = {},
): Promise<string> {
  const endpointUrl = validateExistingGchatEndpoint(input.endpointUrl);
  await expectUnauthorized(
    dependencies.fetch ?? globalThis.fetch,
    endpointUrl,
    undefined,
    dependencies.timeoutMs ?? 10_000,
  );
  return endpointUrl;
}

/**
 * Prove that Cloudflare forwards this callback to this instance's loopback
 * listener, preserves NanoClaw authentication, and owns the wrong-path 404.
 */
export async function verifyManagedGchatRoute(
  input: ManagedGchatRouteInput,
  dependencies: EndpointVerificationDependencies = {},
): Promise<VerifiedManagedGchatRoute> {
  const endpointUrl = validateExistingGchatEndpoint(input.endpointUrl);
  const localEndpointUrl = validateLocalGchatEndpoint(input.localEndpointUrl);
  const fetchImplementation = dependencies.fetch ?? globalThis.fetch;
  const timeoutMs = dependencies.timeoutMs ?? 10_000;
  const local = await expectUnauthorized(fetchImplementation, localEndpointUrl, undefined, timeoutMs);
  const localListenerId = requireWebhookId(local, 'local');
  const remote = await expectUnauthorized(fetchImplementation, endpointUrl, undefined, timeoutMs);
  const publicListenerId = requireWebhookId(remote, 'public');
  if (localListenerId !== publicListenerId) {
    throw new GwsEaError(
      'managed_listener_mismatch',
      'The public Google Chat callback is routed to a different NanoClaw listener',
    );
  }
  await expectManagedCatchAll(fetchImplementation, endpointUrl, timeoutMs);
  return { endpointUrl, listenerId: localListenerId };
}
