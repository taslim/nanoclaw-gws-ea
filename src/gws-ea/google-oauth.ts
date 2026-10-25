/**
 * The assistant's one Google sign-in, run by the control plane through
 * Google's loopback flow with PKCE. The result is accepted only for the
 * declared Workspace account with every required scope. The client secret and
 * every token stay out of process arguments and are registered for redaction
 * on sight.
 */
import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';

import { isErrno } from '../community-portal/errors.js';
import { writePrivate } from '../community-portal/private-file.js';
import {
  GOOGLE_GRANT_SCHEMA_VERSION,
  GOOGLE_SIGN_IN_CONSENTS,
  isGoogleAccountId,
  missingGoogleScopes,
  scopesOfGrant,
  type GoogleConsent,
  type GoogleGrant,
} from '../modules/gws-ea-google/grant.js';
import { GOOGLE_TOKEN_ENDPOINT } from '../modules/gws-ea-google/tokens.js';
import { registerSecret } from './redact.js';
import { readOwnerOnlyJson } from './secrets.js';
import { GwsEaError } from './types.js';
import { isRecord, parseJson } from './validation.js';

export const GOOGLE_AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';

const SIGN_IN_TIMEOUT_MS = 10 * 60_000;

export interface GoogleOAuthClient {
  readonly client_id: string;
  readonly client_secret: string;
}

function invalidClient(message: string): GwsEaError {
  return new GwsEaError('invalid_google_client', message);
}

function clientFrom(value: unknown, label: string): GoogleOAuthClient {
  if (!isRecord(value)) throw invalidClient(`${label} is not a Google OAuth client`);
  const { client_id: id, client_secret: secret } = value;
  if (typeof id !== 'string' || !/^[\w.-]+\.apps\.googleusercontent\.com$/u.test(id)) {
    throw invalidClient(`${label} has no Google OAuth client ID`);
  }
  if (typeof secret !== 'string' || secret.length < 8 || /\s/u.test(secret)) {
    throw invalidClient(`${label} has no client secret`);
  }
  registerSecret(secret);
  return { client_id: id, client_secret: secret };
}

/** Larger than any client download Google produces. */
const MAX_CLIENT_FILE_BYTES = 64 * 1024;

/** The download's permissions do not matter, since setup keeps its own owner-only copy. */
async function readDownloadedJson(file: string): Promise<unknown> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (isErrno(error, 'ELOOP'))
      throw invalidClient('The Google OAuth client file is a link; give the downloaded file');
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw invalidClient('The Google OAuth client file is not a regular file');
    if (info.size > MAX_CLIENT_FILE_BYTES) throw invalidClient('The Google OAuth client file is too large to be one');
    return parseJson(await handle.readFile('utf8'), 'Google OAuth client file', 'invalid_google_client');
  } finally {
    await handle.close();
  }
}

/** Only a Desktop app client: its loopback redirect needs no registration. */
export async function readGoogleOAuthClientFile(file: string): Promise<GoogleOAuthClient> {
  const value = await readDownloadedJson(file);
  if (!isRecord(value)) throw invalidClient('The Google OAuth client file is not a client download');
  if (value.installed === undefined) {
    throw invalidClient(
      value.web === undefined
        ? 'The Google OAuth client file is not a client download'
        : 'The Google OAuth client is a Web application; create a Desktop app client instead',
    );
  }
  return clientFrom(value.installed, 'The Google OAuth client file');
}

/** Kept only until a sign-in turns it into a grant. */
export async function storeGoogleOAuthClient(file: string, client: GoogleOAuthClient): Promise<void> {
  await writePrivate(file, { client_id: client.client_id, client_secret: client.client_secret });
}

/** Undefined before the operator supplies one, and after a sign-in moves it into the grant. */
export async function readStoredGoogleOAuthClient(file: string): Promise<GoogleOAuthClient | undefined> {
  try {
    return clientFrom(
      await readOwnerOnlyJson(file, 'Stored Google OAuth client', 'invalid_google_client'),
      'The stored Google OAuth client',
    );
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
  }
}

export async function writeGoogleGrant(file: string, grant: GoogleGrant): Promise<void> {
  registerSecret(grant.client_secret);
  for (const consent of grant.consents) registerSecret(consent.refresh_token);
  await writePrivate(file, grant);
}

export interface AssistantSignInInput {
  readonly client: GoogleOAuthClient;
  /** The declared Workspace address; any other account is refused. */
  readonly account: string;
  /** Show the operator the sign-in link and open it once they are ready; the time limit starts after. */
  readonly present: (url: string) => Promise<void>;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly timeoutMs?: number;
}

function signInFailed(message: string): GwsEaError {
  return new GwsEaError('google_sign_in_failed', message);
}

const CALLBACK_PAGE = (heading: string): string =>
  `<!doctype html><meta charset="utf-8"><title>${heading}</title><p>${heading} You can close this tab.</p>`;

interface ConsentRequest {
  readonly verifier: string;
  readonly state: string;
  readonly url: string;
}

function consentRequest(
  client: GoogleOAuthClient,
  redirectUri: string,
  account: string,
  scopes: readonly string[],
): ConsentRequest {
  const verifier = randomBytes(48).toString('base64url');
  const state = randomBytes(24).toString('base64url');
  const authorization = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
  authorization.search = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    state,
    access_type: 'offline',
    prompt: 'consent',
    login_hint: account,
  }).toString();
  return { verifier, state, url: authorization.href };
}

/**
 * The sign-in link the operator opens, on a path only this sign-in knows,
 * sends the browser to the first consent; each consent's redirect but the
 * last sends it on to the next. It listens at once, so no redirect is missed,
 * but the time limit for the whole sign-in starts only at `arm`, once the
 * operator is ready. Only a redirect carrying a consent's `state` counts: any
 * other request to the port is refused, so another local process can neither
 * learn a consent's `state` nor cut the operator's sign-in short.
 */
function awaitRedirects(
  server: Server,
  consents: readonly ConsentRequest[],
  timeoutMs: number,
): {
  readonly signInPath: string;
  readonly redirects: readonly Promise<URLSearchParams>[];
  arm(): void;
  cancel(): void;
} {
  const signInPath = `/sign-in/${randomBytes(24).toString('base64url')}`;
  let timer: NodeJS.Timeout | undefined;
  const waits = consents.map(() => {
    let arrive: (query: URLSearchParams) => void = () => undefined;
    let expire: (error: GwsEaError) => void = () => undefined;
    const redirect = new Promise<URLSearchParams>((resolve, reject) => {
      arrive = resolve;
      expire = reject;
    });
    // A consent never reached, once an earlier one fails, leaves no unhandled rejection.
    redirect.catch(() => undefined);
    return { redirect, arrive, expire };
  });
  server.on('request', (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const first = consents.at(0);
    if (url.pathname === signInPath && first) {
      response.writeHead(302, { location: first.url }).end();
      return;
    }
    if (url.pathname !== '/' || (!url.searchParams.has('code') && !url.searchParams.has('error'))) {
      response.writeHead(404).end();
      return;
    }
    const index = consents.findIndex((consent) => consent.state === url.searchParams.get('state'));
    if (index < 0) {
      response
        .writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
        .end(CALLBACK_PAGE('This is not the sign-in gws-ea is waiting for.'));
      return;
    }
    const next = url.searchParams.has('code') ? consents.at(index + 1) : undefined;
    if (next) {
      response.writeHead(302, { location: next.url }).end();
    } else {
      response
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end(CALLBACK_PAGE(url.searchParams.has('code') ? 'Signed in.' : 'Sign-in stopped.'));
    }
    waits[index]?.arrive(url.searchParams);
  });
  return {
    signInPath,
    redirects: waits.map((wait) => wait.redirect),
    arm: () => {
      timer = setTimeout(() => {
        const late = new GwsEaError('google_sign_in_timeout', 'Google sign-in was not finished in time; run it again');
        for (const wait of waits) wait.expire(late);
      }, timeoutMs);
    },
    cancel: () => clearTimeout(timer),
  };
}

async function listenOnLoopback(): Promise<{ server: Server; redirectUri: string }> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw signInFailed('Could not open a local port for the Google sign-in');
  }
  return { server, redirectUri: `http://127.0.0.1:${address.port}` };
}

export async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => undefined);
}

/** Accepted only from the declared account, which every consent proves by asking for the account's identity. */
async function completeConsent(
  input: AssistantSignInInput,
  account: string,
  redirectUri: string,
  consent: ConsentRequest,
  query: URLSearchParams,
): Promise<{ readonly consent: GoogleConsent; readonly sub: string }> {
  const fetchImpl = input.fetch ?? globalThis.fetch;
  const refusal = query.get('error');
  if (refusal !== null) {
    throw signInFailed(
      refusal === 'access_denied' ? 'The Google sign-in was declined' : `Google stopped the sign-in (${refusal})`,
    );
  }
  const code = query.get('code');
  if (!code) throw signInFailed('Google returned no sign-in code');

  const exchanged = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: consent.verifier,
      client_id: input.client.client_id,
      client_secret: input.client.client_secret,
      redirect_uri: redirectUri,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const tokens = await readJson(exchanged);
  if (!exchanged.ok || !isRecord(tokens) || typeof tokens.access_token !== 'string') {
    const reason = isRecord(tokens) && typeof tokens.error === 'string' ? tokens.error : `HTTP ${exchanged.status}`;
    throw signInFailed(`Google did not complete the sign-in (${reason})`);
  }
  registerSecret(tokens.access_token);
  if (typeof tokens.refresh_token !== 'string' || tokens.refresh_token.length === 0) {
    throw signInFailed(
      'Google returned no refresh token; remove the app under the account’s third-party access and sign in again',
    );
  }
  registerSecret(tokens.refresh_token);
  const scopes = typeof tokens.scope === 'string' ? tokens.scope.split(' ').filter(Boolean) : [];

  const userinfo = await fetchImpl(GOOGLE_USERINFO_ENDPOINT, {
    headers: { authorization: `Bearer ${tokens.access_token}` },
    signal: AbortSignal.timeout(30_000),
  });
  const profile = await readJson(userinfo);
  const signedIn = isRecord(profile) && typeof profile.email === 'string' ? profile.email.toLowerCase() : undefined;
  // The account's Google ID, by which Chat knows the assistant (`users/{sub}`).
  const sub = isRecord(profile) && isGoogleAccountId(profile.sub) ? profile.sub : undefined;
  if (!userinfo.ok || signedIn === undefined || sub === undefined) {
    throw signInFailed('Google did not say which account signed in');
  }
  if (signedIn !== account || !isRecord(profile) || profile.email_verified !== true) {
    throw new GwsEaError(
      'google_account_mismatch',
      `Google signed in ${signedIn}, not the assistant's account ${account}; sign in as ${account}`,
    );
  }
  return { consent: { refresh_token: tokens.refresh_token, scopes }, sub };
}

/**
 * Each consent is forced so Google returns a refresh token; one short link
 * walks the operator through them all. The caller keeps the returned grant.
 */
export async function signInAsAssistant(input: AssistantSignInInput): Promise<GoogleGrant> {
  const now = input.now ?? Date.now;
  const account = input.account.trim().toLowerCase();
  const { server, redirectUri } = await listenOnLoopback();
  const consents = GOOGLE_SIGN_IN_CONSENTS.map((scopes) => consentRequest(input.client, redirectUri, account, scopes));
  const granted: GoogleConsent[] = [];
  let sub: string | undefined;
  let waiting: ReturnType<typeof awaitRedirects> | undefined;
  try {
    waiting = awaitRedirects(server, consents, input.timeoutMs ?? SIGN_IN_TIMEOUT_MS);
    await input.present(`${redirectUri}${waiting.signInPath}`);
    waiting.arm();
    for (const [index, consent] of consents.entries()) {
      const completed = await completeConsent(input, account, redirectUri, consent, await waiting.redirects[index]);
      granted.push(completed.consent);
      sub ??= completed.sub;
    }
  } finally {
    waiting?.cancel();
    server.close();
  }
  if (sub === undefined) throw signInFailed('Google did not say which account signed in');

  const grant: GoogleGrant = {
    schema_version: GOOGLE_GRANT_SCHEMA_VERSION,
    account,
    sub,
    client_id: input.client.client_id,
    client_secret: input.client.client_secret,
    consents: granted,
    granted_at: new Date(now()).toISOString(),
  };
  const missing = missingGoogleScopes(scopesOfGrant(grant));
  if (missing.length > 0) {
    throw new GwsEaError(
      'google_scope_missing',
      `The Google sign-in did not grant ${missing.join(', ')}; sign in again and allow every permission`,
    );
  }
  return grant;
}
