/**
 * The assistant's one Google sign-in (KTD2), run by the control plane. The
 * operator downloads a Desktop OAuth client from the Cloud console; gws-ea
 * signs the assistant in through Google's loopback flow with PKCE, accepts
 * the result only for the declared Workspace account with every required
 * scope, and keeps the grant in the instance's owner-only `secrets/`
 * directory, where the host refreshes it. The client secret and every token
 * stay out of process arguments and are registered for redaction on sight.
 */
import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';

import { isErrno } from '../community-portal/errors.js';
import { writePrivate } from '../community-portal/private-file.js';
import {
  GOOGLE_GRANT_SCHEMA_VERSION,
  GOOGLE_SIGN_IN_SCOPES,
  missingGoogleScopes,
  type GoogleGrant,
} from '../modules/gws-ea-google/grant.js';
import { GOOGLE_TOKEN_ENDPOINT } from '../modules/gws-ea-google/tokens.js';
import { registerSecret } from './redact.js';
import { readOwnerOnlyJson } from './secrets.js';
import { GwsEaError } from './types.js';
import { isRecord, parseJson } from './validation.js';

export const GOOGLE_AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';

/** How long the operator has to finish signing in once the browser opens. */
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

/**
 * The downloaded file, read as the browser saved it: setup keeps its own
 * owner-only copy, so the download's permissions do not matter. It must be
 * the file itself, not a link, and small enough to be a client download.
 */
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

/**
 * Read the client JSON the operator downloaded. It must be a Desktop app
 * client, whose loopback redirect needs no registration.
 */
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

/** Keep the client in the instance's secrets until a sign-in turns it into a grant. */
export async function storeGoogleOAuthClient(file: string, client: GoogleOAuthClient): Promise<void> {
  await writePrivate(file, { client_id: client.client_id, client_secret: client.client_secret });
}

/** The stored client, or undefined before the operator has supplied one. */
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

/** Write the grant owner-only and atomically, registering its secrets first. */
export async function writeGoogleGrant(file: string, grant: GoogleGrant): Promise<void> {
  registerSecret(grant.client_secret);
  registerSecret(grant.refresh_token);
  await writePrivate(file, grant);
}

export interface AssistantSignInInput {
  readonly client: GoogleOAuthClient;
  /** The declared Workspace address; any other account is refused. */
  readonly account: string;
  /** Show the operator the consent URL and open it once they are ready; the time limit starts after. */
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

/**
 * Google's redirect to the loopback server, resolving with its query. It
 * listens at once, so no redirect is missed, but the time limit starts only
 * at `arm`, once the operator is ready to sign in; `cancel` stops the wait.
 */
function awaitRedirect(
  server: Server,
  timeoutMs: number,
): { readonly done: Promise<URLSearchParams>; arm(): void; cancel(): void } {
  let timer: NodeJS.Timeout | undefined;
  let expire: (() => void) | undefined;
  const done = new Promise<URLSearchParams>((resolve, reject) => {
    expire = () =>
      reject(new GwsEaError('google_sign_in_timeout', 'Google sign-in was not finished in time; run it again'));
    server.on('request', (request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/' || (!url.searchParams.has('code') && !url.searchParams.has('error'))) {
        response.writeHead(404).end();
        return;
      }
      response
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end(CALLBACK_PAGE(url.searchParams.has('code') ? 'Signed in.' : 'Sign-in stopped.'));
      clearTimeout(timer);
      resolve(url.searchParams);
    });
  });
  return {
    done,
    arm: () => {
      timer = setTimeout(() => expire?.(), timeoutMs);
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

/**
 * Sign the assistant in to Google: PKCE on a loopback redirect, offline
 * access, the release's scopes, and a forced consent so Google returns a
 * refresh token. Returns the grant for the caller to keep.
 */
export async function signInAsAssistant(input: AssistantSignInInput): Promise<GoogleGrant> {
  const fetchImpl = input.fetch ?? globalThis.fetch;
  const now = input.now ?? Date.now;
  const account = input.account.trim().toLowerCase();
  const verifier = randomBytes(48).toString('base64url');
  const state = randomBytes(24).toString('base64url');
  const { server, redirectUri } = await listenOnLoopback();
  let query: URLSearchParams;
  let redirect: ReturnType<typeof awaitRedirect> | undefined;
  try {
    redirect = awaitRedirect(server, input.timeoutMs ?? SIGN_IN_TIMEOUT_MS);
    const authorization = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
    authorization.search = new URLSearchParams({
      client_id: input.client.client_id,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: GOOGLE_SIGN_IN_SCOPES.join(' '),
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      state,
      access_type: 'offline',
      prompt: 'consent',
      login_hint: account,
    }).toString();
    await input.present(authorization.href);
    redirect.arm();
    query = await redirect.done;
  } finally {
    redirect?.cancel();
    server.close();
  }

  if (query.get('state') !== state)
    throw signInFailed('The Google sign-in returned to the wrong request; run it again');
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
      code_verifier: verifier,
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
  if (!userinfo.ok || signedIn === undefined) throw signInFailed('Google did not say which account signed in');
  if (signedIn !== account || !isRecord(profile) || profile.email_verified !== true) {
    throw new GwsEaError(
      'google_account_mismatch',
      `Google signed in ${signedIn}, not the assistant's account ${account}; sign in as ${account}`,
    );
  }

  const missing = missingGoogleScopes(scopes);
  if (missing.length > 0) {
    throw new GwsEaError(
      'google_scope_missing',
      `The Google sign-in did not grant ${missing.join(', ')}; sign in again and allow every permission`,
    );
  }

  return {
    schema_version: GOOGLE_GRANT_SCHEMA_VERSION,
    account,
    client_id: input.client.client_id,
    client_secret: input.client.client_secret,
    refresh_token: tokens.refresh_token,
    scopes,
    granted_at: new Date(now()).toISOString(),
  };
}
