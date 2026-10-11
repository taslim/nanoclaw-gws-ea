import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GOOGLE_SIGN_IN_CONSENTS, parseGoogleGrant } from '../modules/gws-ea-google/grant.js';
import { GOOGLE_TOKEN_ENDPOINT } from '../modules/gws-ea-google/tokens.js';
import {
  GOOGLE_AUTHORIZATION_ENDPOINT,
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

/** The assistant's Google account ID, which userinfo reports as `sub`. */
const SUB = '104857395723948572901';

/** Google's long form of `email`, as it reports the scope granted. */
const longForm = (scope: string): string =>
  scope === 'email' ? 'https://www.googleapis.com/auth/userinfo.email' : scope;

/**
 * Google's token and userinfo endpoints. A code `auth-code-<n>` is the n-th
 * consent's: it is exchanged for that consent's scopes `keep` accepts, its own
 * refresh token, and an access token userinfo answers for as `email(n)`.
 */
function google(
  answer: {
    email?: (consent: number) => string;
    verified?: boolean;
    sub?: unknown;
    keep?: (scope: string) => boolean;
    refresh?: boolean;
  } = {},
): GoogleFake {
  const exchanges: URLSearchParams[] = [];
  const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === GOOGLE_TOKEN_ENDPOINT) {
      const form = new URLSearchParams(String(init?.body));
      exchanges.push(form);
      const consent = Number(/^auth-code-(\d+)$/u.exec(form.get('code') ?? '')?.[1]);
      const scopes = (GOOGLE_SIGN_IN_CONSENTS[consent - 1] ?? []).filter(answer.keep ?? (() => true));
      return json({
        access_token: `ya29.sign-in-${consent}`,
        expires_in: 3599,
        scope: scopes.map(longForm).join(' '),
        ...(answer.refresh === false ? {} : { refresh_token: `1//refresh-${consent}` }),
        token_type: 'Bearer',
      });
    }
    if (url === GOOGLE_USERINFO_ENDPOINT) {
      const bearer = new Headers(init?.headers).get('authorization') ?? '';
      const consent = Number(/^Bearer ya29\.sign-in-(\d+)$/u.exec(bearer)?.[1]);
      expect(consent).toBeGreaterThan(0);
      return json({
        sub: 'sub' in answer ? answer.sub : SUB,
        email: answer.email?.(consent) ?? 'Juno@Example.test',
        email_verified: answer.verified ?? true,
      });
    }
    return json({}, 404);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, exchanges };
}

/** Allows each consent, as Google redirects back with the n-th consent's code. */
const allow = (consent: URL, index: number): Record<string, string> => ({
  code: `auth-code-${index + 1}`,
  state: consent.searchParams.get('state') ?? '',
});

/**
 * Plays the browser: opens the sign-in link, then answers each consent Google
 * shows as `reply` says, following the loopback's redirects as a browser would.
 * A consent `reply` answers with undefined is left open, as an operator who
 * never clicks Allow leaves it.
 */
function browser(reply: (consent: URL, index: number) => Record<string, string> | undefined = allow) {
  const seen: URL[] = [];
  const presented: string[] = [];
  async function walk(signInLink: string): Promise<void> {
    let next = (await fetch(signInLink, { redirect: 'manual' })).headers.get('location');
    while (next?.startsWith(GOOGLE_AUTHORIZATION_ENDPOINT)) {
      const consent = new URL(next);
      seen.push(consent);
      const answer = reply(consent, seen.length - 1);
      if (answer === undefined) return;
      const redirect = new URL(consent.searchParams.get('redirect_uri') ?? '');
      for (const [key, value] of Object.entries(answer)) redirect.searchParams.set(key, value);
      next = (await fetch(redirect, { redirect: 'manual' })).headers.get('location');
    }
  }
  const present = vi.fn(async (url: string) => {
    presented.push(url);
    void walk(url).catch(() => undefined);
  });
  return { present, presented, seen, walk };
}

describe('signing in as the assistant', () => {
  it('signs in through each consent with PKCE on a loopback redirect, from one short link', async () => {
    const g = google();
    const b = browser();

    const grant = await signInAsAssistant({
      client: CLIENT,
      account: 'juno@example.test',
      present: b.present,
      fetch: g.fetch,
      now: () => Date.parse('2026-09-30T12:00:00.000Z'),
    });

    expect(b.presented).toEqual([expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/sign-in\/[\w-]{32}$/)]);
    expect(b.seen.map((consent) => consent.searchParams.get('scope'))).toEqual(
      GOOGLE_SIGN_IN_CONSENTS.map((scopes) => scopes.join(' ')),
    );
    for (const [index, consent] of b.seen.entries()) {
      expect(consent.origin + consent.pathname).toBe(GOOGLE_AUTHORIZATION_ENDPOINT);
      expect(consent.searchParams.get('client_id')).toBe(CLIENT.client_id);
      expect(b.presented[0]).toContain(`${consent.searchParams.get('redirect_uri')}/sign-in/`);
      expect(consent.searchParams.get('access_type')).toBe('offline');
      expect(consent.searchParams.get('prompt')).toBe('consent');
      expect(consent.searchParams.get('login_hint')).toBe('juno@example.test');
      expect(consent.searchParams.get('code_challenge_method')).toBe('S256');
      expect(consent.toString()).not.toContain(CLIENT.client_secret);

      const exchange = g.exchanges[index]!;
      expect(exchange.get('grant_type')).toBe('authorization_code');
      expect(exchange.get('code')).toBe(`auth-code-${index + 1}`);
      expect(exchange.get('client_secret')).toBe(CLIENT.client_secret);
      expect(exchange.get('redirect_uri')).toBe(consent.searchParams.get('redirect_uri'));
      const challenge = createHash('sha256')
        .update(exchange.get('code_verifier') ?? '')
        .digest('base64url');
      expect(challenge).toBe(consent.searchParams.get('code_challenge'));
    }
    expect(new Set(b.seen.map((consent) => consent.searchParams.get('state'))).size).toBe(b.seen.length);

    expect(parseGoogleGrant(grant)).toEqual({
      schema_version: 3,
      account: 'juno@example.test',
      sub: SUB,
      client_id: CLIENT.client_id,
      client_secret: CLIENT.client_secret,
      consents: GOOGLE_SIGN_IN_CONSENTS.map((scopes, index) => ({
        refresh_token: `1//refresh-${index + 1}`,
        scopes: scopes.map(longForm),
      })),
      granted_at: '2026-09-30T12:00:00.000Z',
    });
    for (const consent of grant.consents) {
      expect(redact(`token ${consent.refresh_token}`)).not.toContain(consent.refresh_token);
    }
  });

  it('refuses another account, naming both, and keeps nothing', async () => {
    const g = google({ email: () => 'morgan@example.test' });
    const b = browser();

    await expect(
      signInAsAssistant({ client: CLIENT, account: 'juno@example.test', present: b.present, fetch: g.fetch }),
    ).rejects.toMatchObject({
      code: 'google_account_mismatch',
      message: expect.stringMatching(/morgan@example\.test.*juno@example\.test/) as unknown,
    });
  });

  it('refuses a sign-in that switches to another account between consents', async () => {
    const g = google({ email: (consent) => (consent === 1 ? 'juno@example.test' : 'morgan@example.test') });
    const b = browser();

    await expect(
      signInAsAssistant({ client: CLIENT, account: 'juno@example.test', present: b.present, fetch: g.fetch }),
    ).rejects.toMatchObject({ code: 'google_account_mismatch' });
    expect(g.exchanges).toHaveLength(GOOGLE_SIGN_IN_CONSENTS.length);
  });

  it.each([
    ['no account ID', undefined],
    ["an account ID that is not Google's numeric one", 'users/104857395723948572901'],
  ])('refuses a sign-in for which Google reports %s, and keeps nothing', async (_label, sub) => {
    const g = google({ sub });
    const b = browser();
    await expect(
      signInAsAssistant({ client: CLIENT, account: 'juno@example.test', present: b.present, fetch: g.fetch }),
    ).rejects.toMatchObject({
      code: 'google_sign_in_failed',
      message: 'Google did not say which account signed in',
    });
  });

  it('refuses an unverified address', async () => {
    const g = google({ verified: false });
    const b = browser();
    await expect(
      signInAsAssistant({ client: CLIENT, account: 'juno@example.test', present: b.present, fetch: g.fetch }),
    ).rejects.toMatchObject({ code: 'google_account_mismatch' });
  });

  it('refuses a grant missing a scope, naming it', async () => {
    const g = google({ keep: (scope) => scope === 'openid' || scope === 'email' });
    const b = browser();
    await expect(
      signInAsAssistant({ client: CLIENT, account: 'juno@example.test', present: b.present, fetch: g.fetch }),
    ).rejects.toMatchObject({
      code: 'google_scope_missing',
      message: expect.stringContaining('calendar.events') as unknown,
    });
  });

  it.each([
    [
      'Workspace',
      /\/auth\/(drive|documents|spreadsheets|presentations|forms\.)/u,
      // Drive's scopes in the first consent, then Docs', Sheets', Slides' and Forms' in the second.
      [
        'https://www.googleapis.com/auth/drive',
        'https://www.googleapis.com/auth/drive.readonly',
        'https://www.googleapis.com/auth/drive.metadata',
        'https://www.googleapis.com/auth/drive.metadata.readonly',
        'https://www.googleapis.com/auth/drive.activity',
        'https://www.googleapis.com/auth/drive.activity.readonly',
        'https://www.googleapis.com/auth/drive.labels',
        'https://www.googleapis.com/auth/drive.labels.readonly',
        'https://www.googleapis.com/auth/drive.meet.readonly',
        'https://www.googleapis.com/auth/documents',
        'https://www.googleapis.com/auth/documents.readonly',
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/spreadsheets.readonly',
        'https://www.googleapis.com/auth/presentations',
        'https://www.googleapis.com/auth/presentations.readonly',
        'https://www.googleapis.com/auth/forms.body',
        'https://www.googleapis.com/auth/forms.body.readonly',
        'https://www.googleapis.com/auth/forms.responses.readonly',
      ],
    ],
    [
      'Chat',
      /\/auth\/chat\.(messages|spaces\.readonly|spaces\.create|memberships\.readonly)$/u,
      // The host's Chat token's scopes, in the order the consent asks for them.
      [
        'https://www.googleapis.com/auth/chat.spaces.readonly',
        'https://www.googleapis.com/auth/chat.spaces.create',
        'https://www.googleapis.com/auth/chat.memberships.readonly',
        'https://www.googleapis.com/auth/chat.messages',
      ],
    ],
  ] as const)(
    'asks for the %s scopes, and refuses a sign-in that leaves them unticked, naming them',
    async (_product, unticked, scopes) => {
      const g = google({ keep: (scope) => !unticked.test(scope) });
      const b = browser();

      const error = await signInAsAssistant({
        client: CLIENT,
        account: 'juno@example.test',
        present: b.present,
        fetch: g.fetch,
      }).catch((caught: unknown) => caught);

      const asked = b.seen.flatMap((consent) => consent.searchParams.get('scope')?.split(' ') ?? []);
      expect(asked).toEqual(expect.arrayContaining([...scopes]));
      expect(error).toMatchObject({ code: 'google_scope_missing' });
      expect(String(error)).toContain(`did not grant ${scopes.join(', ')};`);
    },
  );

  it('refuses a sign-in that returns no refresh token', async () => {
    const g = google({ refresh: false });
    const b = browser();
    await expect(
      signInAsAssistant({ client: CLIENT, account: 'juno@example.test', present: b.present, fetch: g.fetch }),
    ).rejects.toMatchObject({ code: 'google_sign_in_failed' });
  });

  it('refuses a request with another state and keeps waiting for the real redirect', async () => {
    const g = google();
    const b = browser();
    const refused: number[] = [];
    const present = vi.fn(async (url: string) => {
      const consent = new URL((await fetch(url, { redirect: 'manual' })).headers.get('location') ?? '');
      const forged = new URL(consent.searchParams.get('redirect_uri') ?? '');
      forged.searchParams.set('code', 'forged-code');
      forged.searchParams.set('state', 'not-the-state');
      refused.push((await fetch(forged)).status);
      void b.walk(url).catch(() => undefined);
    });

    const grant = await signInAsAssistant({ client: CLIENT, account: 'juno@example.test', present, fetch: g.fetch });

    expect(refused).toEqual([400]);
    expect(g.exchanges.map((exchange) => exchange.get('code'))).toEqual(['auth-code-1', 'auth-code-2']);
    expect(grant.account).toBe('juno@example.test');
  });

  it("sends the browser on to Google only from this sign-in's own link, so no other local process learns a consent's state", async () => {
    const g = google();
    const b = browser();
    const guessed: number[] = [];
    const present = vi.fn(async (url: string) => {
      guessed.push((await fetch(new URL('/sign-in', url), { redirect: 'manual' })).status);
      void b.walk(url).catch(() => undefined);
    });

    await expect(
      signInAsAssistant({ client: CLIENT, account: 'juno@example.test', present, fetch: g.fetch }),
    ).resolves.toMatchObject({ account: 'juno@example.test' });
    expect(guessed).toEqual([404]);
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
    const b = browser((consent) => ({ error: 'access_denied', state: consent.searchParams.get('state') ?? '' }));
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
    const b = browser();
    let link = '';
    const grant = signInAsAssistant({
      client: CLIENT,
      account: 'juno@example.test',
      present: async (url) => {
        link = url;
        // The operator takes longer to get ready than the whole wait allows.
        await new Promise((resolve) => setTimeout(resolve, 80));
      },
      fetch: g.fetch,
      timeoutMs: 40,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    void b.walk(link).catch(() => undefined);

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

  it('gives up when a later consent is not finished in time, one limit covering the whole sign-in', async () => {
    const g = google();
    const b = browser((consent, index) => (index === 0 ? allow(consent, index) : undefined));

    await expect(
      signInAsAssistant({
        client: CLIENT,
        account: 'juno@example.test',
        present: b.present,
        fetch: g.fetch,
        timeoutMs: 300,
      }),
    ).rejects.toMatchObject({ code: 'google_sign_in_timeout' });
    expect(b.seen).toHaveLength(2);
    expect(g.exchanges.map((exchange) => exchange.get('code'))).toEqual(['auth-code-1']);
  });
});

describe('the grant file', () => {
  it('is written owner-only and atomically', async () => {
    const file = path.join(ROOT, 'secrets', 'google-grant.json');
    const grant = parseGoogleGrant({
      schema_version: 3,
      account: 'juno@example.test',
      sub: SUB,
      ...CLIENT,
      consents: [{ refresh_token: '1//refresh', scopes: ['openid'] }],
      granted_at: '2026-09-30T12:00:00.000Z',
    });

    await writeGoogleGrant(file, grant);

    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(parseGoogleGrant(JSON.parse(fs.readFileSync(file, 'utf8')))).toEqual(grant);
  });
});
