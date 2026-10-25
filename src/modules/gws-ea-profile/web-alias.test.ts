import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { dispatch } from '../../cli/dispatch.js';
import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { ALIAS, publishAliasTestProfile } from './testing/alias-profile.js';
import { addPrincipalAddress, confirmAliasCandidate, getAliasSetup, proposeAliasCandidate } from './db.js';
import './index.js';

beforeEach(async () => {
  await runMigrations(await initTestDb());
  await publishAliasTestProfile();
});

afterEach(async () => closeDb());

describe("the assistant's operator-confirmed web alias", () => {
  it('keeps a proposal pending until the operator confirms it, then records it idempotently', async () => {
    expect(await getAliasSetup()).toEqual({ alias: null, candidate: null });
    expect(await proposeAliasCandidate('ONUJ@example.test')).toEqual({ alias: null, candidate: ALIAS });
    expect(await confirmAliasCandidate(ALIAS)).toBe(true);
    expect(await getAliasSetup()).toEqual({ alias: ALIAS, candidate: null });
    expect(await confirmAliasCandidate(ALIAS)).toBe(true);
  });

  it('refuses a stale confirmation after a candidate changes or is withdrawn', async () => {
    await proposeAliasCandidate(ALIAS);
    await proposeAliasCandidate('onuj2@example.test');
    expect(await confirmAliasCandidate(ALIAS)).toBe(false);
    expect(await getAliasSetup()).toEqual({ alias: null, candidate: 'onuj2@example.test' });
    await proposeAliasCandidate(null);
    expect(await confirmAliasCandidate('onuj2@example.test')).toBe(false);
    expect(await getAliasSetup()).toEqual({ alias: null, candidate: null });
  });

  it('rechecks principal-address conflicts at confirmation', async () => {
    await proposeAliasCandidate(ALIAS);
    await addPrincipalAddress(ALIAS);
    await expect(confirmAliasCandidate(ALIAS)).rejects.toThrow(/principal's address/u);
    expect((await getAliasSetup()).alias).toBeNull();
  });

  it('refuses invalid and conflicting proposals, and keeps a recorded alias fixed', async () => {
    await expect(proposeAliasCandidate('Juno+web@example.test')).rejects.toThrow(/assistant's own address/u);
    await expect(proposeAliasCandidate('Morgan@example.test')).rejects.toThrow(/principal's address/u);
    await expect(proposeAliasCandidate('onuj')).rejects.toThrow(/not an email address/u);
    await proposeAliasCandidate(ALIAS);
    await confirmAliasCandidate(ALIAS);
    await expect(proposeAliasCandidate('onuj2@example.test')).rejects.toThrow(/already/u);
    expect(await confirmAliasCandidate('onuj2@example.test')).toBe(false);
    expect((await getAliasSetup()).alias).toBe(ALIAS);
  });
});

describe('the profile-owned alias commands', () => {
  const run = (command: string, args: Record<string, unknown> = {}) =>
    dispatch({ id: command, command, args }, { caller: 'host' });

  it('records operator confirmation without a running inbox and rejects a changed candidate', async () => {
    await run('gws-ea-alias-propose', { address: ALIAS });
    expect(await run('gws-ea-alias-confirm', { address: 'onuj2@example.test' })).toMatchObject({ ok: false });
    expect(await run('gws-ea-alias-confirm', { address: ALIAS })).toMatchObject({
      ok: true,
      data: { alias: ALIAS, candidate: null },
    });
    expect(await run('gws-ea-alias-get')).toMatchObject({ ok: true, data: { alias: ALIAS, candidate: null } });
  });

  it('withdraws a candidate and refuses missing or unknown fields', async () => {
    await run('gws-ea-alias-propose', { address: ALIAS });
    expect(await run('gws-ea-alias-propose', { none: true })).toMatchObject({ ok: true, data: { candidate: null } });
    for (const [command, args] of [
      ['gws-ea-alias-propose', {}],
      ['gws-ea-alias-propose', { address: ALIAS, none: true }],
      ['gws-ea-alias-confirm', {}],
      ['gws-ea-alias-confirm', { address: ALIAS, send: true }],
      ['gws-ea-alias-get', { address: ALIAS }],
    ] as const)
      expect(await run(command, args)).toMatchObject({ ok: false });
  });

  it('keeps every alias command operator-only', async () => {
    for (const [command, args] of [
      ['gws-ea-alias-get', {}],
      ['gws-ea-alias-propose', { address: ALIAS }],
      ['gws-ea-alias-confirm', { address: ALIAS }],
    ] as const) {
      expect(
        await dispatch(
          { id: command, command, args },
          {
            caller: 'agent',
            sessionId: 'session-main',
            agentGroupId: 'ag-main',
            messagingGroupId: 'mg-dm',
          },
        ),
      ).toMatchObject({ ok: false, error: { message: expect.stringMatching(/operator-only/u) } });
    }
    expect(await getAliasSetup()).toEqual({ alias: null, candidate: null });
  });
});
