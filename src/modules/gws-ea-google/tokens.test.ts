import { describe, expect, it, vi } from 'vitest';

import {
  AGENT_GOOGLE_CREDENTIALS,
  AGENT_GOOGLE_SERVICES,
  GOOGLE_SIGN_IN_SCOPES,
  googleCredentialFor,
  type GoogleGrant,
} from './grant.js';
import {
  createHostTokenSource,
  GOOGLE_TOKEN_ENDPOINT,
  GoogleGrantRevokedError,
  GoogleScopeNotGrantedError,
  GoogleTokenError,
  mintCredentialToken,
  mintServiceToken,
  RENEW_BEFORE_EXPIRY_MS,
} from './tokens.js';

const GRANT: GoogleGrant = {
  schema_version: 2,
  account: 'juno@example.test',
  sub: '104857395723948572901',
  client_id: 'client.apps.googleusercontent.com',
  client_secret: 'GOCSPX-client-secret',
  refresh_token: '1//refresh-token',
  scopes: [...GOOGLE_SIGN_IN_SCOPES],
  granted_at: '2026-09-30T10:00:00.000Z',
};

const READONLY = 'https://www.googleapis.com/auth/gmail.readonly';
const MODIFY = 'https://www.googleapis.com/auth/gmail.modify';
const DRIVE = 'https://www.googleapis.com/auth/drive';
const CALENDAR = AGENT_GOOGLE_SERVICES.calendar.scopes.join(' ');
const CHAT = [
  'https://www.googleapis.com/auth/chat.messages',
  'https://www.googleapis.com/auth/chat.spaces.readonly',
  'https://www.googleapis.com/auth/chat.spaces.create',
  'https://www.googleapis.com/auth/chat.memberships.readonly',
];

/** A grant from before Drive, Docs, Sheets, Slides and Forms joined the sign-in. */
const OLD_GRANT: GoogleGrant = {
  ...GRANT,
  scopes: GRANT.scopes.filter((scope) => !/\/(drive|documents|spreadsheets|presentations|forms\.)/u.test(scope)),
};

/** How Google's token endpoint answers one request: an error with its status, or the scopes it granted. */
interface Answer {
  readonly status?: number;
  readonly error?: string;
  readonly scope?: string;
}

/** Google's token endpoint, answering whatever is asked with `answer(asked)`: by default exactly what was asked. */
function google(answer: (asked: string) => Answer = () => ({})) {
  const asked: string[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    expect(String(input)).toBe(GOOGLE_TOKEN_ENDPOINT);
    const scope = new URLSearchParams(String(init?.body)).get('scope') ?? '';
    asked.push(scope);
    const reply = answer(scope);
    if (reply.status !== undefined && reply.status >= 400) {
      return new Response(JSON.stringify(reply.error ? { error: reply.error } : {}), { status: reply.status });
    }
    return new Response(
      JSON.stringify({ access_token: 'ya29.minted', expires_in: 3599, scope: reply.scope ?? scope }),
      {
        status: 200,
      },
    );
  }) as unknown as typeof globalThis.fetch;
  return { fetch, asked };
}

/** Google refusing any request that asks for Drive with `refusal`, and granting everything else as asked. */
const refusingDrive =
  (refusal: Answer) =>
  (asked: string): Answer =>
    asked.includes(DRIVE) ? refusal : {};

describe("minting a service's token from the grant", () => {
  it('asks for a gmail-read token limited to gmail.readonly, and gets exactly that', async () => {
    const world = google();
    const token = await mintServiceToken(GRANT, 'gmail-read', { fetch: world.fetch, now: () => 1_000 });

    expect(world.asked).toEqual([READONLY]);
    expect(token).toEqual({ accessToken: 'ya29.minted', expiresAt: 1_000 + 3_599_000, scopes: [READONLY] });
  });

  it('refuses a gmail-read token Google made broader than read-only', async () => {
    const world = google(() => ({ scope: `${READONLY} ${MODIFY}` }));
    await expect(mintServiceToken(GRANT, 'gmail-read', { fetch: world.fetch })).rejects.toThrow(GoogleTokenError);
  });

  it('refuses a token that does not carry every scope it was minted for, as a final answer', async () => {
    const world = google(() => ({ scope: 'https://www.googleapis.com/auth/calendar.events' }));
    const error = await mintServiceToken(GRANT, 'calendar', { fetch: world.fetch }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GoogleTokenError);
    expect(error).toMatchObject({ refused: true });
    expect(String(error)).toMatch(/did not limit the calendar token to exactly its scopes/);
  });

  it("mints the host's Gmail token with the modify scope alone", async () => {
    const world = google();
    await expect(mintServiceToken(GRANT, 'gmail', { fetch: world.fetch })).resolves.toMatchObject({
      scopes: [MODIFY],
    });
    expect(world.asked).toEqual([MODIFY]);
  });

  it("refuses the host's Drive token on a grant without Drive, without asking Google", async () => {
    const world = google();
    const error = await mintServiceToken(OLD_GRANT, 'drive-host', { fetch: world.fetch }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(GoogleScopeNotGrantedError);
    expect(error).toMatchObject({ code: 'google_scope_not_granted', service: 'drive-host' });
    expect(world.fetch).not.toHaveBeenCalled();
    await expect(mintServiceToken(GRANT, 'drive-host', { fetch: world.fetch })).resolves.toMatchObject({
      scopes: [DRIVE],
    });
  });

  it('reports a revoked sign-in as its own error, without the refresh token', async () => {
    const world = google(() => ({ status: 400, error: 'invalid_grant' }));
    const error = await mintServiceToken(GRANT, 'directory', { fetch: world.fetch }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GoogleGrantRevokedError);
    expect(String(error)).not.toContain(GRANT.refresh_token);
  });

  it.each([
    ['an OAuth error other than a revoked grant', { status: 400, error: 'invalid_scope' }, true],
    ['an unauthorized client', { status: 401, error: 'unauthorized_client' }, true],
    ['a 4xx naming no OAuth error', { status: 400 }, false],
    ['too many requests', { status: 429, error: 'rate_limit_exceeded' }, false],
    ['a server error', { status: 503, error: 'backend_error' }, false],
  ])('tells %s apart as final or worth retrying', async (_label, answer, refused) => {
    const world = google(() => answer);
    const error = await mintServiceToken(GRANT, 'directory', { fetch: world.fetch }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GoogleTokenError);
    expect(error).toMatchObject({ refused });
  });
});

describe("minting an agent credential's token", () => {
  const www = googleCredentialFor('calendar');

  it("asks for Calendar's and Drive's scopes together on a grant holding both", async () => {
    const world = google();
    const token = await mintCredentialToken(GRANT, www, { fetch: world.fetch });

    expect(world.asked).toEqual([`${CALENDAR} ${DRIVE}`]);
    expect(token).toMatchObject({
      accessToken: 'ya29.minted',
      scopes: [...AGENT_GOOGLE_SERVICES.calendar.scopes, DRIVE],
    });
    expect(token).not.toHaveProperty('fallback');
  });

  it("asks for exactly each credential's own scopes on a grant holding the whole ceiling, never a broader one", async () => {
    const grant: GoogleGrant = {
      ...GRANT,
      scopes: [
        'openid',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/calendar.events',
        'https://www.googleapis.com/auth/calendar.calendarlist',
        'https://www.googleapis.com/auth/calendar.freebusy',
        READONLY,
        'https://www.googleapis.com/auth/directory.readonly',
        DRIVE,
        'https://www.googleapis.com/auth/documents',
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/presentations',
        'https://www.googleapis.com/auth/forms.body',
        'https://www.googleapis.com/auth/forms.responses.readonly',
        MODIFY,
        // The rest of the ceiling: every other scope of each product an agent could be handed.
        'https://www.googleapis.com/auth/calendar',
        'https://www.googleapis.com/auth/calendar.readonly',
        'https://www.googleapis.com/auth/calendar.events.readonly',
        'https://www.googleapis.com/auth/calendar.events.owned',
        'https://www.googleapis.com/auth/calendar.events.owned.readonly',
        'https://www.googleapis.com/auth/calendar.events.freebusy',
        'https://www.googleapis.com/auth/calendar.events.public.readonly',
        'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
        'https://www.googleapis.com/auth/calendar.calendars',
        'https://www.googleapis.com/auth/calendar.calendars.readonly',
        'https://www.googleapis.com/auth/calendar.acls',
        'https://www.googleapis.com/auth/calendar.acls.readonly',
        'https://www.googleapis.com/auth/calendar.settings.readonly',
        'https://mail.google.com/',
        'https://www.googleapis.com/auth/gmail.metadata',
        'https://www.googleapis.com/auth/gmail.compose',
        'https://www.googleapis.com/auth/gmail.send',
        'https://www.googleapis.com/auth/gmail.insert',
        'https://www.googleapis.com/auth/gmail.labels',
        'https://www.googleapis.com/auth/gmail.settings.basic',
        'https://www.googleapis.com/auth/gmail.settings.sharing',
        'https://www.googleapis.com/auth/drive.readonly',
        'https://www.googleapis.com/auth/drive.metadata',
        'https://www.googleapis.com/auth/drive.metadata.readonly',
        'https://www.googleapis.com/auth/drive.activity',
        'https://www.googleapis.com/auth/drive.activity.readonly',
        'https://www.googleapis.com/auth/drive.labels',
        'https://www.googleapis.com/auth/drive.labels.readonly',
        'https://www.googleapis.com/auth/drive.meet.readonly',
        'https://www.googleapis.com/auth/documents.readonly',
        'https://www.googleapis.com/auth/spreadsheets.readonly',
        'https://www.googleapis.com/auth/presentations.readonly',
        'https://www.googleapis.com/auth/forms.body.readonly',
      ],
    };
    const asked: Record<string, string[]> = {};
    for (const credential of AGENT_GOOGLE_CREDENTIALS) {
      const world = google();
      await mintCredentialToken(grant, credential, { fetch: world.fetch });
      asked[credential.host] = world.asked;
    }

    expect(asked).toEqual({
      'www.googleapis.com': [
        [
          'https://www.googleapis.com/auth/calendar.events',
          'https://www.googleapis.com/auth/calendar.calendarlist',
          'https://www.googleapis.com/auth/calendar.freebusy',
          DRIVE,
        ].join(' '),
      ],
      'gmail.googleapis.com': [READONLY],
      'people.googleapis.com': ['https://www.googleapis.com/auth/directory.readonly'],
      'docs.googleapis.com': ['https://www.googleapis.com/auth/documents'],
      'sheets.googleapis.com': ['https://www.googleapis.com/auth/spreadsheets'],
      'slides.googleapis.com': ['https://www.googleapis.com/auth/presentations'],
      'forms.googleapis.com': [
        'https://www.googleapis.com/auth/forms.body https://www.googleapis.com/auth/forms.responses.readonly',
      ],
    });
  });

  it("asks for Calendar's scopes alone on a grant from before Drive, and nothing for a host it holds none for", async () => {
    const world = google();

    await expect(mintCredentialToken(OLD_GRANT, www, { fetch: world.fetch })).resolves.toMatchObject({
      scopes: AGENT_GOOGLE_SERVICES.calendar.scopes,
    });
    await expect(mintCredentialToken(OLD_GRANT, googleCredentialFor('docs'), { fetch: world.fetch })).resolves.toBe(
      undefined,
    );
    expect(world.asked).toEqual([CALENDAR]);
  });

  it.each([
    ['refuses Drive outright', refusingDrive({ status: 400, error: 'invalid_scope' }), 'invalid_scope'],
    ['leaves Drive out of the token', refusingDrive({ scope: CALENDAR }), 'the token carried other scopes'],
  ])('keeps Calendar alone when Google %s while the grant lists it', async (_label, answer, reason) => {
    const world = google(answer);
    const token = await mintCredentialToken(GRANT, www, { fetch: world.fetch });

    expect(world.asked).toEqual([`${CALENDAR} ${DRIVE}`, CALENDAR]);
    expect(token).toMatchObject({
      scopes: AGENT_GOOGLE_SERVICES.calendar.scopes,
      fallback: { refused: [DRIVE], reason },
    });
  });

  it.each([
    ['a revoked grant', { status: 400, error: 'invalid_grant' }, GoogleGrantRevokedError],
    ['a server error', { status: 503, error: 'backend_error' }, GoogleTokenError],
    ['too many requests', { status: 429 }, GoogleTokenError],
  ])('falls back on nothing for %s, asking once', async (_label, answer, thrown) => {
    const world = google(() => answer);
    await expect(mintCredentialToken(GRANT, www, { fetch: world.fetch })).rejects.toThrow(thrown);
    expect(world.asked).toEqual([`${CALENDAR} ${DRIVE}`]);
  });

  it('falls back on nothing when the network fails', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof globalThis.fetch;
    await expect(mintCredentialToken(GRANT, www, { fetch })).rejects.toThrow('fetch failed');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("throws a final refusal of a single service's credential, and of the full set when asked not to fall back", async () => {
    const world = google(() => ({ status: 400, error: 'invalid_scope' }));
    await expect(
      mintCredentialToken(GRANT, googleCredentialFor('sheets'), { fetch: world.fetch }),
    ).rejects.toMatchObject({ refused: true });
    // Sheets is its credential's only service, so there is nothing narrower to ask for.
    expect(world.asked).toEqual(['https://www.googleapis.com/auth/spreadsheets']);

    const drive = google(refusingDrive({ status: 400, error: 'invalid_scope' }));
    await expect(mintCredentialToken(GRANT, www, { fetch: drive.fetch, fallBack: false })).rejects.toMatchObject({
      refused: true,
    });
    expect(drive.asked).toEqual([`${CALENDAR} ${DRIVE}`]);
  });
});

describe("the host's token source", () => {
  /** Google's token endpoint, numbering the tokens it mints and answering each request with `answer(asked)`. */
  function numbered(answer: (asked: string) => Answer = () => ({})) {
    const world = google(answer);
    let minted = 0;
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const response = await world.fetch(input, init);
      if (!response.ok) return response;
      minted += 1;
      const body = (await response.json()) as Record<string, unknown>;
      return new Response(JSON.stringify({ ...body, access_token: `ya29.host-${minted}` }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    return { fetch, asked: world.asked };
  }

  function source(world: ReturnType<typeof numbered>, grant: () => GoogleGrant | undefined, clock = { now: 0 }) {
    return createHostTokenSource({ readGrant: async () => grant(), fetch: world.fetch, now: () => clock.now });
  }

  /** Past the point where a token minted at `minted` is renewed. */
  const renewalAfter = (minted: number): number => minted + 3_599_000 - RENEW_BEFORE_EXPIRY_MS + 1;

  it('holds each token in memory, renewing it only near expiry', async () => {
    const world = numbered();
    const clock = { now: 0 };
    const tokens = source(world, () => GRANT, clock);

    const first = await tokens.accessToken('gmail');
    clock.now += 30 * 60_000;
    expect(await tokens.accessToken('gmail')).toBe(first);
    expect(world.asked).toEqual([MODIFY]);

    clock.now = renewalAfter(0);
    expect(await tokens.accessToken('gmail')).not.toBe(first);
    expect(world.asked).toEqual([MODIFY, MODIFY]);
  });

  it('keeps one token per service', async () => {
    const world = numbered();
    const tokens = source(world, () => GRANT);

    const chat = await tokens.accessToken('chat');
    const directory = await tokens.accessToken('directory-host');

    expect(chat).not.toBe(directory);
    expect(world.asked).toEqual([CHAT.join(' '), 'https://www.googleapis.com/auth/directory.readonly']);
    expect(await tokens.accessToken('chat')).toBe(chat);
  });

  it('mints one token for callers that ask at once', async () => {
    const world = numbered();
    const tokens = source(world, () => GRANT);

    const [a, b] = await Promise.all([tokens.accessToken('chat'), tokens.accessToken('chat')]);

    expect(a).toBe(b);
    expect(world.asked).toHaveLength(1);
  });

  it('mints afresh from a new sign-in, even while the old token is fresh', async () => {
    const world = numbered();
    let grant = GRANT;
    const tokens = source(world, () => grant);
    const first = await tokens.accessToken('chat');

    grant = { ...GRANT, refresh_token: '1//new-refresh-token', granted_at: '2026-10-10T18:00:00.000Z' };

    expect(await tokens.accessToken('chat')).not.toBe(first);
    expect(world.asked).toHaveLength(2);
  });

  it('refuses before the assistant signs in, without asking Google', async () => {
    const world = numbered();
    await expect(source(world, () => undefined).accessToken('chat')).rejects.toThrow(/not signed in/);
    expect(world.fetch).not.toHaveBeenCalled();
  });

  it('refuses a service whose scopes the grant does not hold, without asking Google', async () => {
    const world = numbered();
    let grant = OLD_GRANT;
    const tokens = source(world, () => grant);

    await expect(tokens.accessToken('drive-host')).rejects.toBeInstanceOf(GoogleScopeNotGrantedError);
    await expect(
      source(world, () => ({ ...GRANT, scopes: GRANT.scopes.filter((scope) => !CHAT.includes(scope)) })).accessToken(
        'chat',
      ),
    ).rejects.toMatchObject({ code: 'google_scope_not_granted', service: 'chat' });
    expect(world.fetch).not.toHaveBeenCalled();

    grant = { ...GRANT, granted_at: '2026-10-09T18:00:00.000Z' };
    await expect(tokens.accessToken('drive-host')).resolves.toBe('ya29.host-1');
    expect(world.asked).toEqual([DRIVE]);
  });

  it('stops asking Google after a revoked sign-in, until a new one is written', async () => {
    const world = numbered(() => ({ status: 400, error: 'invalid_grant' }));
    let grant = GRANT;
    const tokens = source(world, () => grant);

    await expect(tokens.accessToken('chat')).rejects.toBeInstanceOf(GoogleGrantRevokedError);
    await expect(tokens.accessToken('gmail')).rejects.toThrow(/no longer accepts/);
    expect(world.asked).toHaveLength(1);

    grant = { ...GRANT, refresh_token: '1//new-refresh-token', granted_at: '2026-10-10T18:00:00.000Z' };
    await expect(tokens.accessToken('chat')).rejects.toBeInstanceOf(GoogleGrantRevokedError);
    expect(world.asked).toHaveLength(2);
  });

  it('asks again on the next call after a failure worth retrying', async () => {
    let failing = true;
    const world = numbered(() => (failing ? { status: 503, error: 'backend_error' } : {}));
    const tokens = source(world, () => GRANT);

    await expect(tokens.accessToken('chat')).rejects.toBeInstanceOf(GoogleTokenError);
    failing = false;
    await expect(tokens.accessToken('chat')).resolves.toBe('ya29.host-1');
    expect(world.asked).toHaveLength(2);
  });
});
