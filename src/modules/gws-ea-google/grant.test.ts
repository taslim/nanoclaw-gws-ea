import { describe, expect, it, vi } from 'vitest';

import {
  EXPOSED_GOOGLE_SERVICES,
  GOOGLE_SERVICES,
  GOOGLE_SIGN_IN_SCOPES,
  missingGoogleScopes,
  parseGoogleGrant,
} from './grant.js';
import { findInjectedSecrets, upsertBearerSecret } from './onecli-secrets.js';

const VALID = {
  schema_version: 1,
  account: 'Robin@Example.test',
  client_id: 'client.apps.googleusercontent.com',
  client_secret: 'GOCSPX-client-secret',
  refresh_token: '1//refresh-token',
  scopes: ['openid', 'https://www.googleapis.com/auth/userinfo.email'],
  granted_at: '2026-09-30T10:00:00.000Z',
};

describe("the assistant's Google grant", () => {
  it('reads a grant, lowercasing the account', () => {
    expect(parseGoogleGrant(VALID)).toEqual({ ...VALID, account: 'robin@example.test' });
  });

  it.each([
    ['another schema', { ...VALID, schema_version: 2 }],
    ['no refresh token', { ...VALID, refresh_token: '' }],
    ['a control character', { ...VALID, client_id: 'client\nid' }],
    ['no scopes', { ...VALID, scopes: [] }],
    ['a time that is not canonical', { ...VALID, granted_at: '2026-09-30 10:00' }],
  ])('refuses a grant with %s', (_label, value) => {
    expect(() => parseGoogleGrant(value)).toThrow(/Google grant/);
  });

  it('asks for identity, Calendar, and Gmail in one sign-in, and exposes only Calendar', () => {
    expect(GOOGLE_SIGN_IN_SCOPES).toEqual([
      'openid',
      'email',
      ...GOOGLE_SERVICES.calendar.scopes,
      ...GOOGLE_SERVICES.gmail.scopes,
    ]);
    expect(EXPOSED_GOOGLE_SERVICES).toEqual(['calendar']);
  });

  it("names each required scope a grant lacks, accepting Google's long form of email", () => {
    const granted = ['openid', 'https://www.googleapis.com/auth/userinfo.email', ...GOOGLE_SERVICES.calendar.scopes];
    expect(missingGoogleScopes(granted)).toEqual([...GOOGLE_SERVICES.gmail.scopes]);
    expect(missingGoogleScopes([...GOOGLE_SIGN_IN_SCOPES])).toEqual([]);
  });
});

describe("OneCLI's injected secrets", () => {
  function api(entries: unknown, onWrite = vi.fn()) {
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'GET') return new Response(JSON.stringify(entries), { status: 200 });
      onWrite(init?.method, String(_input), init?.body);
      return new Response('{}', { status: init?.method === 'POST' ? 201 : 200 });
    }) as unknown as typeof globalThis.fetch;
    return { url: 'http://127.0.0.1:31002', apiKey: 'oc_key', fetch };
  }

  it('keeps one of two secrets a creation race left with the same name, updating it and deleting the other', async () => {
    const onWrite = vi.fn();
    const entries = [
      { id: 'a', name: 'google-calendar', hostPattern: 'www.googleapis.com' },
      { id: 'other', name: 'github', hostPattern: 'api.github.com' },
      { id: 'b', name: 'google-calendar', hostPattern: 'www.googleapis.com' },
    ];

    const result = await upsertBearerSecret(api(entries, onWrite), {
      name: 'google-calendar',
      hostPattern: 'www.googleapis.com',
      value: 'ya29.secret',
    });

    expect(result).toBe('updated');
    expect(onWrite.mock.calls.map(([method, url]) => `${String(method)} ${String(url)}`)).toEqual([
      'PATCH http://127.0.0.1:31002/v1/secrets/a',
      'DELETE http://127.0.0.1:31002/v1/secrets/b',
    ]);
  });

  it('updates the existing secret by ID, with the token only in the body', async () => {
    const onWrite = vi.fn();
    const result = await upsertBearerSecret(
      api([{ id: 'sec/1', name: 'google-calendar', hostPattern: 'www.googleapis.com' }], onWrite),
      { name: 'google-calendar', hostPattern: 'www.googleapis.com', value: 'ya29.secret' },
    );

    expect(result).toBe('updated');
    const [method, url, body] = onWrite.mock.calls[0] as [string, string, string];
    expect(method).toBe('PATCH');
    expect(url).toBe('http://127.0.0.1:31002/v1/secrets/sec%2F1');
    expect(url).not.toContain('ya29');
    expect(JSON.parse(body)).toMatchObject({ value: 'ya29.secret', hostPattern: 'www.googleapis.com' });
  });

  it('reports a refused request by status, without the key', async () => {
    const fetch = vi.fn(async () => new Response('{}', { status: 401 })) as unknown as typeof globalThis.fetch;
    const error = await findInjectedSecrets({ url: 'http://127.0.0.1:31002', apiKey: 'oc_key', fetch }, 'x').catch(
      (caught: unknown) => caught,
    );
    expect(String(error)).toMatch(/HTTP 401/);
    expect(String(error)).not.toContain('oc_key');
  });
});
