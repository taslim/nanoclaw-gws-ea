import { describe, expect, it, vi } from 'vitest';

import type { GoogleGrant } from './grant.js';
import { GOOGLE_TOKEN_ENDPOINT, GoogleGrantRevokedError, GoogleTokenError, mintServiceToken } from './tokens.js';

const GRANT: GoogleGrant = {
  schema_version: 1,
  account: 'robin@example.test',
  client_id: 'client.apps.googleusercontent.com',
  client_secret: 'GOCSPX-client-secret',
  refresh_token: '1//refresh-token',
  scopes: ['openid'],
  granted_at: '2026-09-30T10:00:00.000Z',
};

const READONLY = 'https://www.googleapis.com/auth/gmail.readonly';
const MODIFY = 'https://www.googleapis.com/auth/gmail.modify';

/** Google's token endpoint, answering with `scope` (or an error) for whatever is asked. */
function google(answer: { scope?: (asked: string) => string; error?: string }) {
  const asked: string[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    expect(String(input)).toBe(GOOGLE_TOKEN_ENDPOINT);
    const scope = new URLSearchParams(String(init?.body)).get('scope') ?? '';
    asked.push(scope);
    if (answer.error) return new Response(JSON.stringify({ error: answer.error }), { status: 400 });
    return new Response(
      JSON.stringify({ access_token: 'ya29.minted', expires_in: 3599, scope: answer.scope?.(scope) ?? scope }),
      { status: 200 },
    );
  }) as unknown as typeof globalThis.fetch;
  return { fetch, asked };
}

describe("minting a service's token from the grant", () => {
  it('asks for a gmail-read token limited to gmail.readonly, and gets exactly that', async () => {
    const world = google({});
    const token = await mintServiceToken(GRANT, 'gmail-read', { fetch: world.fetch, now: () => 1_000 });

    expect(world.asked).toEqual([READONLY]);
    expect(token).toEqual({ accessToken: 'ya29.minted', expiresAt: 1_000 + 3_599_000, scopes: [READONLY] });
  });

  it('refuses a gmail-read token Google made broader than read-only', async () => {
    const world = google({ scope: () => `${READONLY} ${MODIFY}` });
    await expect(mintServiceToken(GRANT, 'gmail-read', { fetch: world.fetch })).rejects.toThrow(GoogleTokenError);
  });

  it('refuses a token that does not carry every scope it was minted for', async () => {
    const world = google({ scope: () => 'https://www.googleapis.com/auth/calendar.events' });
    await expect(mintServiceToken(GRANT, 'calendar', { fetch: world.fetch })).rejects.toThrow(
      /did not limit the calendar token to exactly its scopes/,
    );
  });

  it("mints the host's Gmail token with the modify scope alone", async () => {
    const world = google({});
    await expect(mintServiceToken(GRANT, 'gmail', { fetch: world.fetch })).resolves.toMatchObject({
      scopes: [MODIFY],
    });
    expect(world.asked).toEqual([MODIFY]);
  });

  it('reports a revoked sign-in as its own error, without the refresh token', async () => {
    const world = google({ error: 'invalid_grant' });
    const error = await mintServiceToken(GRANT, 'directory', { fetch: world.fetch }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GoogleGrantRevokedError);
    expect(String(error)).not.toContain(GRANT.refresh_token);
  });
});
