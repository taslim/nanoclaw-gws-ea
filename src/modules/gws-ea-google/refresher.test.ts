import { describe, expect, it, vi } from 'vitest';

import type {
  GatewayCredentialTarget,
  GatewayRuntimeCredentialConnection,
} from '../../gateway-providers/credential-connection.js';
import { AGENT_GOOGLE_SERVICES, GOOGLE_SIGN_IN_SCOPES, type GoogleGrant } from './grant.js';
import { createGoogleTokenRefresher, RENEW_BEFORE_EXPIRY_MS } from './refresher.js';
import { GOOGLE_TOKEN_ENDPOINT, GoogleScopeNotGrantedError } from './tokens.js';

const GRANT: GoogleGrant = {
  schema_version: 1,
  account: 'juno@example.test',
  client_id: 'client.apps.googleusercontent.com',
  client_secret: 'GOCSPX-client-secret',
  refresh_token: '1//refresh-token',
  scopes: [...GOOGLE_SIGN_IN_SCOPES],
  granted_at: '2026-09-30T10:00:00.000Z',
};

/** A grant from before Drive, Docs, Sheets, Slides and Forms joined the sign-in. */
const OLD_GRANT: GoogleGrant = {
  ...GRANT,
  scopes: GRANT.scopes.filter((scope) => !/\/(drive|documents|spreadsheets|presentations|forms\.)/u.test(scope)),
};

const MODIFY = 'https://www.googleapis.com/auth/gmail.modify';
const DRIVE = 'https://www.googleapis.com/auth/drive';
const CALENDAR = AGENT_GOOGLE_SERVICES.calendar.scopes.join(' ');
/** The credentials agents get, in the order the host publishes them. */
const AGENT_SECRETS = [
  'google-calendar',
  'google-gmail-read',
  'google-directory',
  'google-docs',
  'google-sheets',
  'google-slides',
  'google-forms',
];
/** What each credential asks Google for on a grant holding every scope. */
const FULL_SCOPES = [
  `${CALENDAR} ${DRIVE}`,
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/directory.readonly',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/presentations',
  'https://www.googleapis.com/auth/forms.body https://www.googleapis.com/auth/forms.responses.readonly',
];

interface Stored {
  readonly host: string;
  readonly value: string;
  readonly target: GatewayCredentialTarget;
}

/** How Google's token endpoint answers one request: an error with its status, or the scopes it granted. */
interface Answer {
  readonly status?: number;
  readonly error?: string;
  readonly scope?: string;
}

/** Google's token endpoint, answering with `answer(asked)`, and the selected gateway's credential connection, in memory. */
function world(answer: (asked: string) => Answer = () => ({})) {
  const minted: URLSearchParams[] = [];
  const vault = new Map<string, Stored>();
  const writes: string[] = [];
  let tokens = 0;
  const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status });
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    expect(String(input)).toBe(GOOGLE_TOKEN_ENDPOINT);
    const form = new URLSearchParams(String(init?.body));
    minted.push(form);
    const asked = form.get('scope') ?? '';
    const reply = answer(asked);
    if (reply.status !== undefined && reply.status >= 400) {
      return json(reply.status, reply.error ? { error: reply.error } : {});
    }
    tokens += 1;
    return json(200, { access_token: `ya29.token-${tokens}`, expires_in: 3599, scope: reply.scope ?? asked });
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
    /** The scopes each request asked for, in order. */
    asked: () => minted.map((form) => form.get('scope')),
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

/** Google refusing any request that asks for Drive with `refusal`, while `refusing()` holds, and granting the rest. */
function refusingDrive(refusal: Answer, refusing: () => boolean = () => true) {
  return (asked: string): Answer => (refusing() && asked.includes(DRIVE) ? refusal : {});
}

/** Past the point where a token minted at `minted` is renewed. */
const renewalAfter = (minted: number): number => minted + 3_599_000 - RENEW_BEFORE_EXPIRY_MS + 1;

describe('the Google token refresher', () => {
  it("publishes each agent credential's token on its own host on the first tick", async () => {
    const w = world();
    await refresher(w, () => GRANT, { now: Date.parse('2026-09-30T12:00:00.000Z') }).refresher.tick();

    expect(w.asked()).toEqual(FULL_SCOPES);
    expect(w.asked().join(' ')).not.toContain(MODIFY);
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
    expect(Object.fromEntries([...w.vault].map(([name, stored]) => [name, stored.host]))).toEqual({
      'google-calendar': 'www.googleapis.com',
      'google-gmail-read': 'gmail.googleapis.com',
      'google-directory': 'people.googleapis.com',
      'google-docs': 'docs.googleapis.com',
      'google-sheets': 'sheets.googleapis.com',
      'google-slides': 'slides.googleapis.com',
      'google-forms': 'forms.googleapis.com',
    });
  });

  it('renews only when a token is close to expiring, as after the machine wakes', async () => {
    const w = world();
    const clock = { now: Date.parse('2026-09-30T12:00:00.000Z') };
    const { refresher: r } = refresher(w, () => GRANT, clock);

    await r.tick();
    clock.now += 30 * 60_000;
    await r.tick();
    expect(w.writes).toEqual(AGENT_SECRETS.map((name) => `create ${name}`));

    clock.now = renewalAfter(clock.now - 30 * 60_000);
    await r.tick();
    expect(w.writes.slice(AGENT_SECRETS.length)).toEqual(AGENT_SECRETS.map((name) => `update ${name}`));
    expect(w.vault.get('google-calendar')?.value).toBe('ya29.token-8');

    // Asleep for hours: the first tick after waking renews.
    clock.now += 5 * 3_600_000;
    await r.tick();
    expect(w.vault.get('google-calendar')?.value).toBe('ya29.token-15');
  });

  it("keeps Calendar renewing on a grant from before Workspace, and publishes nothing for Workspace's own hosts", async () => {
    const w = world();
    const clock = { now: 0 };
    const { refresher: r, log } = refresher(w, () => OLD_GRANT, clock);

    await r.tick();
    expect(w.asked()).toEqual([
      CALENDAR,
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/directory.readonly',
    ]);
    expect([...w.vault.keys()]).toEqual(['google-calendar', 'google-gmail-read', 'google-directory']);

    clock.now = renewalAfter(0);
    await r.tick();
    expect(w.asked().slice(3)).toEqual(w.asked().slice(0, 3));
    expect(w.writes.slice(3)).toEqual([
      'update google-calendar',
      'update google-gmail-read',
      'update google-directory',
    ]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('mints the full set on every host on the first tick after the grant gains the Workspace scopes', async () => {
    const w = world();
    let grant = OLD_GRANT;
    const { refresher: r } = refresher(w, () => grant, { now: 0 });
    await r.tick();

    grant = { ...GRANT, refresh_token: '1//new-refresh-token', granted_at: '2026-10-09T18:00:00.000Z' };
    await r.tick();

    expect(w.asked().slice(3)).toEqual(FULL_SCOPES);
    expect([...w.vault.keys()]).toEqual(AGENT_SECRETS);
  });

  it('keeps Calendar renewing when Google refuses Drive, retrying the full set each tick until it succeeds', async () => {
    let refusing = true;
    const w = world(refusingDrive({ status: 400, error: 'invalid_scope' }, () => refusing));
    const clock = { now: 0 };
    const { refresher: r, log } = refresher(w, () => GRANT, clock);

    await r.tick();
    expect(w.asked().slice(0, 2)).toEqual([`${CALENDAR} ${DRIVE}`, CALENDAR]);
    const calendarOnly = w.vault.get('google-calendar')?.value;
    expect(calendarOnly).toBeDefined();
    expect(log.warn).toHaveBeenCalledWith(
      "Google refused part of agents' access; publishing the rest",
      expect.objectContaining({ host: 'www.googleapis.com', refused: [DRIVE], reason: 'invalid_scope' }),
    );

    // While Calendar's token is fresh, each tick asks only for the full set, and keeps what works.
    const minted = w.minted.length;
    clock.now += 60_000;
    await r.tick();
    expect(w.asked().slice(minted)).toEqual([`${CALENDAR} ${DRIVE}`]);
    expect(w.vault.get('google-calendar')?.value).toBe(calendarOnly);

    // Calendar's token near expiry is renewed alone while Google still refuses Drive.
    clock.now = renewalAfter(0);
    const before = w.minted.length;
    await r.tick();
    expect(w.asked().slice(before, before + 2)).toEqual([`${CALENDAR} ${DRIVE}`, CALENDAR]);
    const renewedAlone = w.vault.get('google-calendar')?.value;
    expect(renewedAlone).not.toBe(calendarOnly);

    // Google stops refusing: the next tick replaces the token with the full set.
    refusing = false;
    clock.now += 60_000;
    const recovered = w.minted.length;
    await r.tick();
    expect(w.asked().slice(recovered)).toEqual([`${CALENDAR} ${DRIVE}`]);
    // The only token minted this tick, the full set, is what agents now get.
    expect(w.vault.get('google-calendar')?.value).not.toBe(renewedAlone);
    expect(log.info).toHaveBeenLastCalledWith(
      'Renewed Google access for agents',
      expect.objectContaining({ host: 'www.googleapis.com' }),
    );

    // Once whole again, it renews only near expiry.
    clock.now += 60_000;
    const settled = w.minted.length;
    await r.tick();
    expect(w.minted).toHaveLength(settled);
  });

  it('keeps Calendar when Google leaves Drive out of the token it mints', async () => {
    const w = world(refusingDrive({ scope: CALENDAR }));
    await refresher(w, () => GRANT, { now: 0 }).refresher.tick();

    expect(w.asked().slice(0, 2)).toEqual([`${CALENDAR} ${DRIVE}`, CALENDAR]);
    expect(w.vault.has('google-calendar')).toBe(true);
  });

  it('never falls back on a brief outage: the next tick retries the full set', async () => {
    let failing = true;
    const w = world((asked) => (failing && asked.includes(DRIVE) ? { status: 503, error: 'backend_error' } : {}));
    const clock = { now: 0 };
    const { refresher: r, log } = refresher(w, () => GRANT, clock);

    await r.tick();
    expect(w.asked()).not.toContain(CALENDAR);
    expect(w.vault.has('google-calendar')).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(
      'Could not renew Google access for agents; retrying',
      expect.objectContaining({ host: 'www.googleapis.com' }),
    );

    failing = false;
    clock.now += 60_000;
    await r.tick();
    expect(w.vault.has('google-calendar')).toBe(true);
    expect(w.asked().at(-1)).toBe(`${CALENDAR} ${DRIVE}`);
  });

  it('waits quietly while there is no sign-in yet', async () => {
    const w = world();
    const { refresher: r, log } = refresher(w, () => undefined, { now: 0 });

    await r.tick();

    expect(w.minted).toEqual([]);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('stops asking Google after a revoked sign-in, falling back on nothing, until a new one is written', async () => {
    const w = world(() => ({ status: 400, error: 'invalid_grant' }));
    let grant = GRANT;
    const { refresher: r, log } = refresher(w, () => grant, { now: 0 });

    await r.tick();
    await r.tick();
    expect(w.asked()).toEqual([`${CALENDAR} ${DRIVE}`]);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
    await expect(r.hostAccessToken('drive-host')).rejects.toThrow(/no longer accepts/);
    expect(w.minted).toHaveLength(1);

    grant = { ...GRANT, refresh_token: '1//new-refresh-token', granted_at: '2026-09-30T13:00:00.000Z' };
    await r.tick();
    expect(w.minted).toHaveLength(2);
  });

  it('never publishes a token Google did not limit to its credential', async () => {
    const w = world((asked) => (asked.includes('gmail.readonly') ? { scope: `${asked} ${MODIFY}` } : {}));
    const { refresher: r, log } = refresher(w, () => GRANT, { now: 0 });

    await r.tick();

    expect(w.vault.has('google-gmail-read')).toBe(false);
    expect([...w.vault.keys()]).toEqual(AGENT_SECRETS.filter((name) => name !== 'google-gmail-read'));
    expect(log.warn).toHaveBeenCalledWith(
      'Could not renew Google access for agents; retrying',
      expect.objectContaining({ host: 'gmail.googleapis.com' }),
    );
  });

  it("holds the host's Gmail token in memory only, renewing it near expiry", async () => {
    const w = world();
    const clock = { now: 0 };
    const { refresher: r } = refresher(w, () => GRANT, clock);

    const first = await r.hostAccessToken('gmail');
    expect(await r.hostAccessToken('gmail')).toBe(first);
    expect(w.asked()).toEqual([MODIFY]);
    expect(w.connection).not.toHaveBeenCalled();

    clock.now = renewalAfter(0);
    expect(await r.hostAccessToken('gmail')).not.toBe(first);
    await r.tick();
    expect([...w.vault.values()].map((stored) => stored.value)).not.toContain(first);
    expect(w.writes.some((write) => write.includes('gmail.modify') || write.endsWith(' google-gmail'))).toBe(false);
  });

  it("holds the host's own Drive token in memory, and refuses it without asking Google on a grant without Drive", async () => {
    const w = world();
    let grant = OLD_GRANT;
    const { refresher: r } = refresher(w, () => grant, { now: 0 });

    await expect(r.hostAccessToken('drive-host')).rejects.toBeInstanceOf(GoogleScopeNotGrantedError);
    expect(w.fetch).not.toHaveBeenCalled();

    grant = { ...GRANT, granted_at: '2026-10-09T18:00:00.000Z' };
    await expect(r.hostAccessToken('drive-host')).resolves.toBe('ya29.token-1');
    expect(w.asked()).toEqual([DRIVE]);
    expect(w.connection).not.toHaveBeenCalled();
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
    // Every line the refresher logs: a renewal, a Drive refusal, a token Google did not narrow, and a revoked sign-in.
    const renewed = refresher(world(), () => GRANT, { now: 0 });
    const fellBack = refresher(world(refusingDrive({ status: 400, error: 'invalid_scope' })), () => GRANT, { now: 0 });
    const unnarrowed = refresher(
      world(() => ({ scope: MODIFY })),
      () => GRANT,
      { now: 0 },
    );
    const revoked = refresher(
      world(() => ({ status: 400, error: 'invalid_grant' })),
      () => GRANT,
      { now: 0 },
    );
    const runs = [renewed, fellBack, unnarrowed, revoked];
    for (const run of runs) await run.refresher.tick();

    expect(renewed.log.info).toHaveBeenCalledWith('Renewed Google access for agents', expect.anything());
    expect(fellBack.log.warn).toHaveBeenCalled();
    expect(unnarrowed.log.warn).toHaveBeenCalled();
    expect(revoked.log.error).toHaveBeenCalled();
    const logged = JSON.stringify(
      runs.map(({ log }) => [log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls]),
    );
    expect(logged).not.toContain('ya29.');
    expect(logged).not.toContain(GRANT.refresh_token);
    expect(logged).not.toContain(GRANT.client_secret);
  });
});
