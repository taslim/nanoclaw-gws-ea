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

/** What the managed callback route answered, as seen from outside. */
export type ManagedRouteObservation =
  | { readonly status: 'routed'; readonly listenerId: string }
  /**
   * Nothing to change: the callback or the local listener did not answer, or
   * Cloudflare's edge answered 5xx/53x because the tunnel or the assistant is
   * down. The answer may change without any help (propagation, restarts).
   */
  | { readonly status: 'down'; readonly observed: string; readonly evidence: string }
  /** The hostname does not resolve, or Cloudflare answered without this assistant's listener: the route or DNS needs repair. */
  | { readonly status: 'misrouted'; readonly observed: string; readonly evidence: string };

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

/** Unsigned traffic must be refused with 401, without a redirect. */
async function expectUnauthorized(
  fetchImplementation: typeof globalThis.fetch,
  endpointUrl: string,
  timeoutMs: number,
): Promise<void> {
  let response: Response;
  try {
    response = await fetchImplementation(endpointUrl, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/json' },
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
    throw new GwsEaError(
      'endpoint_auth_bypass',
      `Google Chat endpoint must return 401 for unauthenticated traffic; it answered ${response.status}`,
    );
  }
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
  await expectUnauthorized(fetchImplementation, endpointUrl, timeoutMs);
  return { endpointUrl, audienceUrl };
}

/** Prove that the operator-owned callback route exists and fails closed. */
export async function verifyExistingGchatRoute(
  input: ExistingGchatRouteInput,
  dependencies: EndpointVerificationDependencies = {},
): Promise<string> {
  const endpointUrl = validateExistingGchatEndpoint(input.endpointUrl);
  await expectUnauthorized(dependencies.fetch ?? globalThis.fetch, endpointUrl, dependencies.timeoutMs ?? 10_000);
  return endpointUrl;
}

type Probe = { readonly response: Response } | { readonly failure: string };

function webhookId(response: Response): string | undefined {
  const id = response.headers.get('x-nanoclaw-webhook-id')?.toLowerCase();
  return id && WEBHOOK_ID_PATTERN.test(id) ? id : undefined;
}

function isRedirect(response: Response, url: string): boolean {
  return (
    (response.status >= 300 && response.status < 400) ||
    response.redirected ||
    (response.url !== '' && response.url !== url)
  );
}

function failureCode(error: unknown): string {
  const cause = error instanceof Error ? error.cause : undefined;
  const code = cause instanceof Error ? (cause as NodeJS.ErrnoException).code : undefined;
  if (typeof code === 'string' && code) return code;
  return error instanceof Error && error.name === 'TimeoutError' ? 'timed out' : 'no answer';
}

/**
 * Observe the managed callback from outside, reporting what it answered:
 * this instance's local listener must answer 401 with its listener ID, the
 * public callback must reach that same listener without a redirect, and a
 * path outside the route must get Cloudflare's own 404. Edge 5xx/53x are
 * reported apart from other mismatches: they mean the tunnel or the
 * assistant is down, which no route change repairs.
 */
export async function observeManagedGchatRoute(
  input: ManagedGchatRouteInput,
  dependencies: EndpointVerificationDependencies = {},
): Promise<ManagedRouteObservation> {
  const endpointUrl = validateExistingGchatEndpoint(input.endpointUrl);
  const localEndpointUrl = validateLocalGchatEndpoint(input.localEndpointUrl);
  const fetchImplementation = dependencies.fetch ?? globalThis.fetch;
  const timeoutMs = dependencies.timeoutMs ?? 10_000;
  const probe = async (url: string, method: 'GET' | 'POST'): Promise<Probe> => {
    try {
      const response = await fetchImplementation(url, {
        method,
        redirect: 'manual',
        ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
      return { response };
      /* eslint-disable-next-line no-catch-all/no-catch-all -- Not answering is itself the observation. */
    } catch (error) {
      return { failure: failureCode(error) };
    }
  };
  const down = (observed: string, evidence: string): ManagedRouteObservation => ({
    status: 'down',
    observed,
    evidence,
  });
  const misrouted = (observed: string, evidence: string): ManagedRouteObservation => ({
    status: 'misrouted',
    observed,
    evidence,
  });
  const evidenceOf = (method: string, url: string, seen: Probe): string =>
    `${method} ${url}: ${'response' in seen ? `HTTP ${seen.response.status}` : seen.failure}`;

  const local = await probe(localEndpointUrl, 'POST');
  const listenerId = 'response' in local && local.response.status === 401 ? webhookId(local.response) : undefined;
  if (!listenerId) {
    const answer = 'response' in local ? `answered ${local.response.status}` : `did not answer (${local.failure})`;
    return down(`the assistant's local listener ${answer}`, evidenceOf('POST', localEndpointUrl, local));
  }

  const remote = await probe(endpointUrl, 'POST');
  const remoteEvidence = evidenceOf('POST', endpointUrl, remote);
  if (!('response' in remote)) {
    // A hostname that does not resolve has no DNS record (yet); anything else is the network.
    return remote.failure === 'ENOTFOUND'
      ? misrouted("the public callback's hostname does not resolve (ENOTFOUND)", remoteEvidence)
      : down(`the public callback did not answer (${remote.failure})`, remoteEvidence);
  }
  const { status } = remote.response;
  if (status >= 500) {
    return down(
      `the public callback answered ${status}, so the Cloudflare tunnel or the assistant is down`,
      remoteEvidence,
    );
  }
  if (isRedirect(remote.response, endpointUrl))
    return misrouted(`the public callback answered ${status}, a redirect`, remoteEvidence);
  const publicId = webhookId(remote.response);
  if (!publicId) return misrouted(`the public callback answered ${status} without a NanoClaw listener`, remoteEvidence);
  if (publicId !== listenerId)
    return misrouted('the public callback reached a different NanoClaw listener', remoteEvidence);
  if (status !== 401)
    return misrouted(`the public callback answered ${status} instead of refusing unsigned traffic`, remoteEvidence);

  const wrongPathUrl = new URL(MANAGED_WRONG_PATH, endpointUrl).href;
  const wrong = await probe(wrongPathUrl, 'GET');
  const wrongEvidence = evidenceOf('GET', wrongPathUrl, wrong);
  if (!('response' in wrong)) return down(`a path outside the route did not answer (${wrong.failure})`, wrongEvidence);
  if (wrong.response.status >= 500) {
    return down(
      `a path outside the route answered ${wrong.response.status}, so the Cloudflare tunnel is down`,
      wrongEvidence,
    );
  }
  if (webhookId(wrong.response)) {
    return misrouted("a path outside the route reached NanoClaw instead of Cloudflare's 404", wrongEvidence);
  }
  if (wrong.response.status !== 404 || isRedirect(wrong.response, wrongPathUrl)) {
    return misrouted(
      `a path outside the route answered ${wrong.response.status} instead of Cloudflare's 404`,
      wrongEvidence,
    );
  }
  return { status: 'routed', listenerId };
}
