import { GwsEaError } from './types.js';

const CALLBACK_PATH = '/webhook/gchat';
const WRONG_AUDIENCE = 'https://wrong-audience.invalid/webhook/gchat';

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

function wrongAudienceToken(): string {
  const encode = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ aud: WRONG_AUDIENCE })}.invalid-signature`;
}

async function expectUnauthorized(
  fetchImplementation: typeof globalThis.fetch,
  endpointUrl: string,
  authorization: string | undefined,
  timeoutMs: number,
): Promise<void> {
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
}

/**
 * Verify the operator-owned route without following redirects. The second
 * request carries an intentionally invalid token naming another audience;
 * the live U8 receipt supplies the signed wrong-audience proof.
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
  await expectUnauthorized(fetchImplementation, endpointUrl, `Bearer ${wrongAudienceToken()}`, timeoutMs);
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
