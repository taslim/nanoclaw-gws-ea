import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GOOGLE_SIGN_IN_SCOPES, parseGoogleGrant } from '../modules/gws-ea-google/grant.js';
import { GOOGLE_TOKEN_ENDPOINT } from '../modules/gws-ea-google/tokens.js';
import {
  GOOGLE_USERINFO_ENDPOINT,
  readGoogleOAuthClientFile,
  readStoredGoogleOAuthClient,
  signInAsAssistant,
  storeGoogleOAuthClient,
  writeGoogleGrant,
  type GoogleOAuthClient,
} from './google-oauth.js';
import { redact } from './redact.js';

const ROOT = '/tmp/nanoclaw-gws-ea-google-oauth-test';
const CLIENT: GoogleOAuthClient = {
  client_id: '123-abc.apps.googleusercontent.com',
  client_secret: 'GOCSPX-desktop-secret',
};

function writeClientFile(name: string, value: unknown, mode = 0o600): string {
  const file = path.join(ROOT, name);
  fs.writeFileSync(file, JSON.stringify(value), { mode });
  fs.chmodSync(file, mode);
  return file;
}

beforeEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(path.join(ROOT, 'secrets'), { recursive: true, mode: 0o700 });
});

afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe('the downloaded OAuth client', () => {
  it('reads a Desktop client and registers its secret for redaction', async () => {
    const file = writeClientFile('client.json', {
      installed: { ...CLIENT, project_id: 'gws-ea-x', redirect_uris: ['http://localhost'] },
    });

    await expect(readGoogleOAuthClientFile(file)).resolves.toEqual(CLIENT);
    expect(redact(`secret ${CLIENT.client_secret}`)).not.toContain(CLIENT.client_secret);
  });

  it('refuses a Web client, naming the type to create instead', async () => {
    const file = writeClientFile('web.json', { web: CLIENT });
    await expect(readGoogleOAuthClientFile(file)).rejects.toMatchObject({
      code: 'invalid_google_client',
      message: expect.stringMatching(/Desktop app/) as unknown,
    });
  });

  it('reads the download as the browser saved it, readable by others', async () => {
    const file = writeClientFile('open.json', { installed: CLIENT }, 0o644);
    await expect(readGoogleOAuthClientFile(file)).resolves.toEqual(CLIENT);
  });

  it('refuses a client file reached through a link, or too large to be a client download', async () => {
    const real = writeClientFile('real.json', { installed: CLIENT });
    const link = path.join(ROOT, 'link.json');
    fs.symlinkSync(real, link);
    await expect(readGoogleOAuthClientFile(link)).rejects.toMatchObject({ code: 'invalid_google_client' });

    const large = path.join(ROOT, 'large.json');
    fs.writeFileSync(large, JSON.stringify({ installed: CLIENT, padding: 'x'.repeat(70_000) }));
    await expect(readGoogleOAuthClientFile(large)).rejects.toMatchObject({ code: 'invalid_google_client' });
  });

  it('refuses a client ID that is not a Google OAuth client', async () => {
    const file = writeClientFile('odd.json', { installed: { ...CLIENT, client_id: 'not-a-client' } });
    await expect(readGoogleOAuthClientFile(file)).rejects.toMatchObject({ code: 'invalid_google_client' });
  });

  it('keeps the client in the instance secrets until the grant replaces it', async () => {
    const stored = path.join(ROOT, 'secrets', 'google-oauth-client.json');
    await storeGoogleOAuthClient(stored, CLIENT);

    expect(fs.statSync(stored).mode & 0o777).toBe(0o600);
    await expect(readStoredGoogleOAuthClient(stored)).resolves.toEqual(CLIENT);
    await expect(readStoredGoogleOAuthClient(path.join(ROOT, 'secrets', 'none.json'))).resolves.toBeUndefined();
  });
});

interface GoogleFake {
  readonly fetch: typeof globalThis.fetch;
  readonly exchanges: URLSearchParams[];
}

function google(answer: { email?: string; verified?: boolean; scope?: string; refresh?: boolean } = {}): GoogleFake {
  const exchanges: URLSearchParams[] = [];
  const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === GOOGLE_TOKEN_ENDPOINT) {
      exchanges.push(new URLSearchParams(String(init?.body)));
      return json({
        access_token: 'ya29.sign-in',
        expires_in: 3599,
        scope:
          answer.scope ??
          GOOGLE_SIGN_IN_SCOPES.map((s) => (s === 'email' ? 'https://www.googleapis.com/auth/userinfo.email' : s)).join(
            ' ',
          ),
        ...(answer.refresh === false ? {} : { refresh_token: '1//refresh' }),
        token_type: 'Bearer',
      });
    }
    if (url === GOOGLE_USERINFO_ENDPOINT) {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ya29.sign-in');
      return json({ email: answer.email ?? 'Juno@Example.test', email_verified: answer.verified ?? true });
    }
    return json({}, 404);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, exchanges };
}

/** Plays the browser: follows the consent URL back to the loopback redirect, as Google would. */
function browser(reply: (authUrl: URL) => Record<string, string>) {
  const seen: URL[] = [];
  const present = vi.fn(async (url: string) => {
    const authUrl = new URL(url);
    seen.push(authUrl);
    const redirect = new URL(authUrl.searchParams.get('redirect_uri') ?? '');
    for (const [key, value] of Object.entries(reply(authUrl))) redirect.searchParams.set(key, value);
    void fetch(redirect).catch(() => undefined);
  });
  return { present, seen };
}

describe('signing in as the assistant', () => {
  it('signs in with PKCE on a loopback redirect and returns a grant for the declared account', async () => {
    const g = google();
    const b = browser((url) => ({ code: 'auth-code', state: url.searchParams.get('state') ?? '' }));

    const grant = await signInAsAssistant({
      client: CLIENT,
      account: 'juno@example.test',
      present: b.present,
      fetch: g.fetch,
      now: () => Date.parse('2026-09-30T12:00:00.000Z'),
    });

    const auth = b.seen[0]!;
    expect(auth.origin + auth.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(auth.searchParams.get('client_id')).toBe(CLIENT.client_id);
    expect(auth.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(auth.searchParams.get('scope')).toBe(GOOGLE_SIGN_IN_SCOPES.join(' '));
    expect(auth.searchParams.get('access_type')).toBe('offline');
    expect(auth.searchParams.get('prompt')).toBe('consent');
    expect(auth.searchParams.get('login_hint')).toBe('juno@example.test');
    expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
    expect(auth.toString()).not.toContain(CLIENT.client_secret);

    const exchange = g.exchanges[0]!;
    expect(exchange.get('grant_type')).toBe('authorization_code');
    expect(exchange.get('code')).toBe('auth-code');
    expect(exchange.get('client_secret')).toBe(CLIENT.client_secret);
    expect(exchange.get('redirect_uri')).toBe(auth.searchParams.get('redirect_uri'));
    const challenge = createHash('sha256')
      .update(exchange.get('code_verifier') ?? '')
      .digest('base64url');
    expect(challenge).toBe(auth.searchParams.get('code_challenge'));

    expect(parseGoogleGrant(grant)).toEqual({
      schema_version: 1,
      account: 'juno@example.test',
      client_id: CLIENT.client_id,
      client_secret: CLIENT.client_secret,
      refresh_token: '1//refresh',
      scopes: expect.arrayContaining(['openid', 'https://www.googleapis.com/auth/gmail.modify']) as unknown,
      granted_at: '2026-09-30T12:00:00.000Z',
    });
    expect(redact('token 1//refresh')).not.toContain('1//refresh');
  });

  it('refuses another account, naming both, and keeps nothing', async () => {
    const g = google({ email: 'morgan@example.test' });
    const b = browser((url) => ({ code: 'auth-code', state: url.searchParams.get('state') ?? '' }));

    await expect(
      signInAsAssistant({ client: CLIENT, account: 'juno@example.test', present: b.present, fetch: g.fetch }),
    ).rejects.toMatchObject({
      code: 'google_account_mismatch',
      message: expect.stringMatching(/morgan@example\.test.*juno@example\.test/) as unknown,
    });
  });

  it('refuses an unverified address', async () => {
    const g = google({ verified: false });
    const b = browser((url) => ({ code: 'auth-code', state: url.searchParams.get('state') ?? '' }));
    await expect(
      signInAsAssistant({ client: CLIENT, account: 'juno@example.test', present: b.present, fetch: g.fetch }),
    ).rejects.toMatchObject({ code: 'google_account_mismatch' });
  });

  it('refuses a grant missing a scope, naming it', async () => {
    const g = google({ scope: 'openid https://www.googleapis.com/auth/userinfo.email' });
    const b = browser((url) => ({ code: 'auth-code', state: url.searchParams.get('state') ?? '' }));
    await expect(
      signInAsAssistant({ client: CLIENT, account: 'juno@example.test', present: b.present, fetch: g.fetch }),
    ).rejects.toMatchObject({
      code: 'google_scope_missing',
      message: expect.stringContaining('calendar.events') as unknown,
    });
  });

  it('asks for the Workspace scopes, and refuses a sign-in that leaves them unticked', async () => {
    const workspace = /\/auth\/(drive|documents|spreadsheets|presentations|forms\.)/u;
    const withoutWorkspace = GOOGLE_SIGN_IN_SCOPES.filter((scope) => !workspace.test(scope)).map((scope) =>
      scope === 'email' ? 'https://www.googleapis.com/auth/userinfo.email' : scope,
    );
    const g = google({ scope: withoutWorkspace.join(' ') });
    const b = browser((url) => ({ code: 'auth-code', state: url.searchParams.get('state') ?? '' }));

    const error = await signInAsAssistant({
      client: CLIENT,
      account: 'juno@example.test',
      present: b.present,
      fetch: g.fetch,
    }).catch((caught: unknown) => caught);

    expect(b.seen[0]!.searchParams.get('scope')?.split(' ')).toEqual(
      expect.arrayContaining([
        'https://www.googleapis.com/auth/drive',
        'https://www.googleapis.com/auth/documents',
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/presentations',
        'https://www.googleapis.com/auth/forms.body',
        'https://www.googleapis.com/auth/forms.responses.readonly',
      ]),
    );
    expect(error).toMatchObject({ code: 'google_scope_missing' });
    expect(String(error)).toContain(
      'https://www.googleapis.com/auth/drive, https://www.googleapis.com/auth/documents, ' +
        'https://www.googleapis.com/auth/spreadsheets, https://www.googleapis.com/auth/presentations, ' +
        'https://www.googleapis.com/auth/forms.body, https://www.googleapis.com/auth/forms.responses.readonly',
    );
  });

  it('refuses a sign-in that returns no refresh token', async () => {
    const g = google({ refresh: false });
    const b = browser((url) => ({ code: 'auth-code', state: url.searchParams.get('state') ?? '' }));
    await expect(
      signInAsAssistant({ client: CLIENT, account: 'juno@example.test', present: b.present, fetch: g.fetch }),
    ).rejects.toMatchObject({ code: 'google_sign_in_failed' });
  });

  it('refuses a request with another state and keeps waiting for the real redirect', async () => {
    const g = google();
    const refused: number[] = [];
    const present = vi.fn(async (url: string) => {
      const authUrl = new URL(url);
      const redirect = (query: Record<string, string>): URL => {
        const target = new URL(authUrl.searchParams.get('redirect_uri') ?? '');
        for (const [key, value] of Object.entries(query)) target.searchParams.set(key, value);
        return target;
      };
      refused.push((await fetch(redirect({ code: 'forged-code', state: 'not-the-state' }))).status);
      void fetch(redirect({ code: 'auth-code', state: authUrl.searchParams.get('state') ?? '' })).catch(
        () => undefined,
      );
    });

    const grant = await signInAsAssistant({ client: CLIENT, account: 'juno@example.test', present, fetch: g.fetch });

    expect(refused).toEqual([400]);
    expect(g.exchanges.map((exchange) => exchange.get('code'))).toEqual(['auth-code']);
    expect(grant.account).toBe('juno@example.test');
  });

  it('never exchanges a code that arrives with another state', async () => {
    const g = google();
    const b = browser(() => ({ code: 'forged-code', state: 'not-the-state' }));
    await expect(
      signInAsAssistant({
        client: CLIENT,
        account: 'juno@example.test',
        present: b.present,
        fetch: g.fetch,
        timeoutMs: 300,
      }),
    ).rejects.toMatchObject({ code: 'google_sign_in_timeout' });
    expect(g.exchanges).toEqual([]);
  });

  it('reports a declined consent plainly', async () => {
    const g = google();
    const b = browser((url) => ({ error: 'access_denied', state: url.searchParams.get('state') ?? '' }));
    await expect(
      signInAsAssistant({ client: CLIENT, account: 'juno@example.test', present: b.present, fetch: g.fetch }),
    ).rejects.toMatchObject({ code: 'google_sign_in_failed', message: expect.stringMatching(/declined/) as unknown });
  });

  it('stops waiting when the URL cannot be shown, leaving nothing pending', async () => {
    const g = google();
    await expect(
      signInAsAssistant({
        client: CLIENT,
        account: 'juno@example.test',
        present: async () => {
          throw new Error('no browser');
        },
        fetch: g.fetch,
        timeoutMs: 20,
      }),
    ).rejects.toThrow('no browser');
    await new Promise((resolve) => setTimeout(resolve, 40));
  });

  it('starts the sign-in wait only once the operator is ready, however long that takes', async () => {
    const g = google();
    let authUrl: URL | undefined;
    const grant = signInAsAssistant({
      client: CLIENT,
      account: 'juno@example.test',
      present: async (url) => {
        authUrl = new URL(url);
        // The operator takes longer to get ready than the whole wait allows.
        await new Promise((resolve) => setTimeout(resolve, 80));
      },
      fetch: g.fetch,
      timeoutMs: 40,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const redirect = new URL(authUrl?.searchParams.get('redirect_uri') ?? '');
    redirect.searchParams.set('code', 'auth-code');
    redirect.searchParams.set('state', authUrl?.searchParams.get('state') ?? '');
    void fetch(redirect).catch(() => undefined);

    await expect(grant).resolves.toMatchObject({ account: 'juno@example.test' });
  });

  it('gives up when nobody finishes signing in', async () => {
    const g = google();
    await expect(
      signInAsAssistant({
        client: CLIENT,
        account: 'juno@example.test',
        present: async () => undefined,
        fetch: g.fetch,
        timeoutMs: 50,
      }),
    ).rejects.toMatchObject({ code: 'google_sign_in_timeout' });
  });
});

describe('the grant file', () => {
  it('is written owner-only and atomically', async () => {
    const file = path.join(ROOT, 'secrets', 'google-grant.json');
    const grant = parseGoogleGrant({
      schema_version: 1,
      account: 'juno@example.test',
      ...CLIENT,
      refresh_token: '1//refresh',
      scopes: ['openid'],
      granted_at: '2026-09-30T12:00:00.000Z',
    });

    await writeGoogleGrant(file, grant);

    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(parseGoogleGrant(JSON.parse(fs.readFileSync(file, 'utf8')))).toEqual(grant);
  });
});
