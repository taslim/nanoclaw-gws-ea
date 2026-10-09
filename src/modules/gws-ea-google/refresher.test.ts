import { describe, expect, it, vi } from 'vitest';

import type {
  GatewayCredentialTarget,
  GatewayRuntimeCredentialConnection,
} from '../../gateway-providers/credential-connection.js';
import { AGENT_GOOGLE_SERVICES, GOOGLE_SIGN_IN_SCOPES, type GoogleGrant } from './grant.js';
import { createGoogleTokenRefresher, RENEW_BEFORE_EXPIRY_MS } from './refresher.js';
import { GOOGLE_TOKEN_ENDPOINT } from './tokens.js';

const GRANT: GoogleGrant = {
  schema_version: 1,
  account: 'juno@example.test',
  client_id: 'client.apps.googleusercontent.com',
  client_secret: 'GOCSPX-client-secret',
  refresh_token: '1//refresh-token',
  scopes: [...GOOGLE_SIGN_IN_SCOPES],
  granted_at: '2026-09-30T10:00:00.000Z',
};

const MODIFY = 'https://www.googleapis.com/auth/gmail.modify';
const AGENT_SECRETS = ['google-calendar', 'google-gmail-read', 'google-directory'];

interface Stored {
  readonly host: string;
  readonly value: string;
  readonly target: GatewayCredentialTarget;
}

/** Google's token endpoint, and the selected gateway's credential connection, in memory. */
function world(google: { error?: string; scope?: (asked: string) => string } = {}) {
  const minted: URLSearchParams[] = [];
  const vault = new Map<string, Stored>();
  const writes: string[] = [];
  let tokens = 0;
  const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status });
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    expect(String(input)).toBe(GOOGLE_TOKEN_ENDPOINT);
    const form = new URLSearchParams(String(init?.body));
    minted.push(form);
    if (google.error) return json(400, { error: google.error });
    tokens += 1;
    const asked = form.get('scope') ?? '';
    return json(200, {
      access_token: `ya29.token-${tokens}`,
      expires_in: 3599,
      scope: google.scope ? google.scope(asked) : asked,
    });
  }) as unknown as typeof globalThis.fetch;

  /** The contract: `find` first, then `save`, `keep`, or `remove` act on what it observed. */
  const connection = vi.fn((target: GatewayCredentialTarget): GatewayRuntimeCredentialConnection => {
    let observed: boolean | undefined;
    const require = (): boolean => {
      if (observed === undefined) throw new Error('find first');
      return observed;
    };
    return {
      async find() {
        observed = vault.has(target.name);
        return observed ? { reusable: true } : null;
      },
      async save(value) {
        const existed = require();
        if (typeof value !== 'string') throw new Error('api-key only');
        vault.set(target.name, { host: target.host, value, target });
        writes.push(`${existed ? 'update' : 'create'} ${target.name}`);
        observed = true;
      },
      async keep() {
        require();
      },
      async remove() {
        if (!require()) return;
        vault.delete(target.name);
        writes.push(`remove ${target.name}`);
        observed = false;
      },
    };
  });
  return {
    fetch,
    minted,
    vault,
    writes,
    connection,
  };
}

function refresher(w: ReturnType<typeof world>, grant: () => GoogleGrant | undefined, clock: { now: number }) {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    log,
    refresher: createGoogleTokenRefresher({
      readGrant: async () => grant(),
      connection: w.connection,
      fetch: w.fetch,
      now: () => clock.now,
      log,
    }),
  };
}

describe('the Google token refresher', () => {
  it("publishes each agent-facing service's token through the gateway's connection on the first tick", async () => {
    const w = world();
    await refresher(w, () => GRANT, { now: Date.parse('2026-09-30T12:00:00.000Z') }).refresher.tick();

    expect(w.minted.map((form) => form.get('scope'))).toEqual([
      AGENT_GOOGLE_SERVICES.calendar.scopes.join(' '),
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/directory.readonly',
    ]);
    expect(w.minted.map((form) => form.get('scope')).join(' ')).not.toContain(MODIFY);
    expect(w.minted[0]?.get('grant_type')).toBe('refresh_token');
    expect([...w.vault.keys()]).toEqual(AGENT_SECRETS);
    expect(w.vault.get('google-gmail-read')).toEqual({
      host: 'gmail.googleapis.com',
      value: 'ya29.token-2',
      target: {
        kind: 'api-key',
        name: 'google-gmail-read',
        host: 'gmail.googleapis.com',
        proxyValue: 'gateway-managed',
        injection: { headerName: 'Authorization', valueFormat: 'Bearer {value}' },
      },
    });
    expect(w.vault.get('google-directory')?.host).toBe('people.googleapis.com');
  });

  it('renews only when a token is close to expiring, as after the machine wakes', async () => {
    const w = world();
    const clock = { now: Date.parse('2026-09-30T12:00:00.000Z') };
    const { refresher: r } = refresher(w, () => GRANT, clock);

    await r.tick();
    clock.now += 30 * 60_000;
    await r.tick();
    expect(w.writes).toEqual(AGENT_SECRETS.map((name) => `create ${name}`));

    clock.now += 3_599_000 - 30 * 60_000 - RENEW_BEFORE_EXPIRY_MS + 1;
    await r.tick();
    expect(w.writes.slice(3)).toEqual(AGENT_SECRETS.map((name) => `update ${name}`));
    expect(w.vault.get('google-calendar')?.value).toBe('ya29.token-4');

    // Asleep for hours: the first tick after waking renews.
    clock.now += 5 * 3_600_000;
    await r.tick();
    expect(w.vault.get('google-calendar')?.value).toBe('ya29.token-7');
  });

  it('waits quietly while there is no sign-in yet', async () => {
    const w = world();
    const { refresher: r, log } = refresher(w, () => undefined, { now: 0 });

    await r.tick();

    expect(w.minted).toEqual([]);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('stops asking Google after a revoked sign-in until a new one is written', async () => {
    const w = world({ error: 'invalid_grant' });
    let grant = GRANT;
    const { refresher: r, log } = refresher(w, () => grant, { now: 0 });

    await r.tick();
    await r.tick();
    expect(w.minted).toHaveLength(1);
    expect(log.error).toHaveBeenCalledTimes(1);

    grant = { ...GRANT, refresh_token: '1//new-refresh-token', granted_at: '2026-09-30T13:00:00.000Z' };
    await r.tick();
    expect(w.minted).toHaveLength(2);
  });

  it('never publishes a token Google did not limit to its service', async () => {
    const w = world({
      scope: (asked) => (asked.includes('gmail.readonly') ? `${asked} ${MODIFY}` : asked),
    });
    const { refresher: r, log } = refresher(w, () => GRANT, { now: 0 });

    await r.tick();

    expect(w.vault.has('google-gmail-read')).toBe(false);
    expect([...w.vault.keys()]).toEqual(['google-calendar', 'google-directory']);
    expect(log.warn).toHaveBeenCalledWith(
      'Could not renew Google access for agents; retrying',
      expect.objectContaining({ service: 'gmail-read' }),
    );
  });

  it("holds the host's Gmail token in memory only, renewing it near expiry", async () => {
    const w = world();
    const clock = { now: 0 };
    const { refresher: r } = refresher(w, () => GRANT, clock);

    const first = await r.hostAccessToken('gmail');
    expect(await r.hostAccessToken('gmail')).toBe(first);
    expect(w.minted.map((form) => form.get('scope'))).toEqual([MODIFY]);
    expect(w.connection).not.toHaveBeenCalled();

    clock.now += 3_599_000 - RENEW_BEFORE_EXPIRY_MS + 1;
    expect(await r.hostAccessToken('gmail')).not.toBe(first);
    await r.tick();
    expect([...w.vault.values()].map((stored) => stored.value)).not.toContain(first);
    expect(w.writes.some((write) => write.includes('gmail.modify') || write.endsWith(' google-gmail'))).toBe(false);
  });

  it('mints one host token for callers that ask at once, and refuses before the assistant signs in', async () => {
    const w = world();
    const { refresher: r } = refresher(w, () => GRANT, { now: 0 });
    const [a, b] = await Promise.all([r.hostAccessToken('gmail'), r.hostAccessToken('gmail')]);
    expect(a).toBe(b);
    expect(w.minted).toHaveLength(1);

    const unsigned = refresher(world(), () => undefined, { now: 0 }).refresher;
    await expect(unsigned.hostAccessToken('gmail')).rejects.toThrow(/not signed in/);
  });

  it('never writes a token, the refresh token, or the client secret into a log line', async () => {
    // Every line the refresher logs: a renewal, a token Google did not narrow, and a revoked sign-in.
    const renewed = refresher(world(), () => GRANT, { now: 0 });
    const unnarrowed = refresher(world({ scope: () => MODIFY }), () => GRANT, { now: 0 });
    const revoked = refresher(world({ error: 'invalid_grant' }), () => GRANT, { now: 0 });
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
