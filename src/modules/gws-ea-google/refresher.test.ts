import { describe, expect, it, vi } from 'vitest';

import { GOOGLE_SERVICES, type GoogleGrant } from './grant.js';
import { createGoogleTokenRefresher, RENEW_BEFORE_EXPIRY_MS } from './refresher.js';
import { GOOGLE_TOKEN_ENDPOINT } from './tokens.js';

const GRANT: GoogleGrant = {
  schema_version: 1,
  account: 'robin@example.test',
  client_id: 'client.apps.googleusercontent.com',
  client_secret: 'GOCSPX-client-secret',
  refresh_token: '1//refresh-token',
  scopes: ['openid', ...GOOGLE_SERVICES.calendar.scopes, ...GOOGLE_SERVICES.gmail.scopes],
  granted_at: '2026-09-30T10:00:00.000Z',
};

interface Fake {
  readonly fetch: typeof globalThis.fetch;
  readonly minted: URLSearchParams[];
  readonly secrets: Map<string, { id: string; hostPattern: string; value: string; injectionConfig: unknown }>;
  readonly writes: string[];
}

/** Google's token endpoint and OneCLI's secret API, in memory. */
function fake(google: { error?: string; scope?: (asked: string) => string } = {}): Fake {
  const minted: URLSearchParams[] = [];
  const secrets: Fake['secrets'] = new Map();
  const writes: string[] = [];
  let tokens = 0;
  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === GOOGLE_TOKEN_ENDPOINT) {
      const form = new URLSearchParams(String(init?.body));
      minted.push(form);
      if (google.error) return json(400, { error: google.error });
      tokens += 1;
      const asked = form.get('scope') ?? '';
      return json(200, {
        access_token: `ya29.token-${tokens}`,
        expires_in: 3599,
        scope: google.scope ? google.scope(asked) : asked,
        token_type: 'Bearer',
      });
    }
    const route = new URL(url).pathname;
    const headers = new Headers(init?.headers);
    if (headers.get('authorization') !== 'Bearer oc_instance_key') return json(401, { error: 'unauthorized' });
    if (init?.method === 'GET' && route === '/v1/secrets') {
      return json(
        200,
        [...secrets].map(([name, secret]) => ({
          id: secret.id,
          name,
          hostPattern: secret.hostPattern,
          type: 'generic',
        })),
      );
    }
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    if (init?.method === 'POST' && route === '/v1/secrets') {
      secrets.set(String(body.name), {
        id: `sec-${secrets.size + 1}`,
        hostPattern: String(body.hostPattern),
        value: String(body.value),
        injectionConfig: body.injectionConfig,
      });
      writes.push(`create ${String(body.name)}`);
      return json(201, {});
    }
    if (init?.method === 'PATCH' && route.startsWith('/v1/secrets/')) {
      const id = decodeURIComponent(route.slice('/v1/secrets/'.length));
      const entry = [...secrets].find(([, secret]) => secret.id === id);
      if (!entry) return json(404, {});
      secrets.set(entry[0], { ...entry[1], value: String(body.value), hostPattern: String(body.hostPattern) });
      writes.push(`update ${entry[0]}`);
      return json(200, { success: true });
    }
    return json(404, {});
  }) as unknown as typeof globalThis.fetch;
  return { fetch, minted, secrets, writes };
}

function refresher(f: Fake, grant: () => GoogleGrant | undefined, clock: { now: number }) {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    log,
    refresher: createGoogleTokenRefresher({
      readGrant: async () => grant(),
      onecli: { url: 'http://127.0.0.1:31002', apiKey: 'oc_instance_key', fetch: f.fetch },
      fetch: f.fetch,
      now: () => clock.now,
      log,
    }),
  };
}

describe('the Google token refresher', () => {
  it('puts a Calendar-only token into OneCLI as a bearer secret on the first tick', async () => {
    const f = fake();
    const clock = { now: Date.parse('2026-09-30T12:00:00.000Z') };
    await refresher(f, () => GRANT, clock).refresher.tick();

    expect(f.minted.map((form) => form.get('scope'))).toEqual([GOOGLE_SERVICES.calendar.scopes.join(' ')]);
    expect(f.minted[0]?.get('grant_type')).toBe('refresh_token');
    expect(f.secrets.get('google-calendar')).toEqual({
      id: 'sec-1',
      hostPattern: 'www.googleapis.com',
      value: 'ya29.token-1',
      injectionConfig: { headerName: 'Authorization', valueFormat: 'Bearer {value}' },
    });
    expect(f.secrets.has('google-gmail')).toBe(false);
  });

  it('renews only when the token is close to expiring, as after the machine wakes', async () => {
    const f = fake();
    const clock = { now: Date.parse('2026-09-30T12:00:00.000Z') };
    const { refresher: r } = refresher(f, () => GRANT, clock);

    await r.tick();
    clock.now += 30 * 60_000;
    await r.tick();
    expect(f.writes).toEqual(['create google-calendar']);

    clock.now += 3_599_000 - 30 * 60_000 - RENEW_BEFORE_EXPIRY_MS + 1;
    await r.tick();
    expect(f.writes).toEqual(['create google-calendar', 'update google-calendar']);
    expect(f.secrets.get('google-calendar')?.value).toBe('ya29.token-2');

    // Asleep for hours: the first tick after waking renews.
    clock.now += 5 * 3_600_000;
    await r.tick();
    expect(f.secrets.get('google-calendar')?.value).toBe('ya29.token-3');
  });

  it('waits quietly while there is no sign-in yet', async () => {
    const f = fake();
    const { refresher: r, log } = refresher(f, () => undefined, { now: 0 });

    await r.tick();

    expect(f.minted).toEqual([]);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('stops asking Google after a revoked sign-in until a new one is written', async () => {
    const f = fake({ error: 'invalid_grant' });
    let grant = GRANT;
    const { refresher: r, log } = refresher(f, () => grant, { now: 0 });

    await r.tick();
    await r.tick();
    expect(f.minted).toHaveLength(1);
    expect(log.error).toHaveBeenCalledTimes(1);

    grant = { ...GRANT, refresh_token: '1//new-refresh-token', granted_at: '2026-09-30T13:00:00.000Z' };
    await r.tick();
    expect(f.minted).toHaveLength(2);
  });

  it('never injects a token Google did not limit to Calendar', async () => {
    const f = fake({ scope: () => [...GOOGLE_SERVICES.calendar.scopes, ...GOOGLE_SERVICES.gmail.scopes].join(' ') });
    const { refresher: r, log } = refresher(f, () => GRANT, { now: 0 });

    await r.tick();

    expect(f.secrets.size).toBe(0);
    expect(log.warn).toHaveBeenCalled();
  });

  it('never writes a token, the refresh token, or the client secret into a log line', async () => {
    // Every line the refresher logs: a renewal, a token Google did not narrow, and a revoked sign-in.
    const renewed = refresher(fake(), () => GRANT, { now: 0 });
    const unnarrowed = refresher(fake({ scope: () => 'https://www.googleapis.com/auth/gmail.modify' }), () => GRANT, {
      now: 0,
    });
    const revoked = refresher(fake({ error: 'invalid_grant' }), () => GRANT, { now: 0 });
    for (const run of [renewed, unnarrowed, revoked]) await run.refresher.tick();

    expect(renewed.log.info).toHaveBeenCalledWith('Renewed Google access for agents', expect.anything());
    expect(unnarrowed.log.warn).toHaveBeenCalled();
    expect(revoked.log.error).toHaveBeenCalled();
    const logged = JSON.stringify(
      [renewed, unnarrowed, revoked].map(({ log }) => [log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls]),
    );
    expect(logged).not.toContain('ya29.');
    expect(logged).not.toContain(GRANT.refresh_token);
    expect(logged).not.toContain(GRANT.client_secret);
  });
});
