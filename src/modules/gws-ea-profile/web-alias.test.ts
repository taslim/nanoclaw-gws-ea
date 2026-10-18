import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { publishAliasTestProfile } from '../gws-ea-inbox/testing/alias-mailbox.js';
import { getAliasSetup, proposeAliasCandidate, recordAliasProbe, recordVerifiedAlias } from './db.js';
import './index.js';

const PROBE = '<alias-check.0123456789abcdef0123456789abcdef@example.test>';
const LATER_PROBE = '<alias-check.fedcba9876543210fedcba9876543210@example.test>';

beforeEach(async () => {
  await runMigrations(await initTestDb());
  await publishAliasTestProfile();
});

afterEach(async () => {
  await closeDb();
});

describe("the assistant's web alias in its profile (KTD13)", () => {
  it('holds nothing until a candidate is proposed, and no alias until a probe proves it', async () => {
    await expect(getAliasSetup()).resolves.toEqual({ alias: null, candidate: null, probe_message_id: null });

    await expect(proposeAliasCandidate('ONUJ@example.test')).resolves.toEqual({
      alias: null,
      candidate: 'onuj@example.test',
      probe_message_id: null,
    });
    await expect(recordAliasProbe('onuj@example.test', PROBE)).resolves.toBe(true);
    await expect(getAliasSetup()).resolves.toEqual({
      alias: null,
      candidate: 'onuj@example.test',
      probe_message_id: PROBE,
    });

    await expect(recordVerifiedAlias('onuj@example.test', PROBE)).resolves.toBe(true);
    await expect(getAliasSetup()).resolves.toEqual({
      alias: 'onuj@example.test',
      candidate: null,
      probe_message_id: null,
    });
  });

  it('keeps a probe while the same candidate is proposed again, and forgets it for a new one', async () => {
    await proposeAliasCandidate('onuj@example.test');
    await recordAliasProbe('onuj@example.test', PROBE);

    await proposeAliasCandidate('onuj@example.test');
    await expect(getAliasSetup()).resolves.toMatchObject({ probe_message_id: PROBE });

    await proposeAliasCandidate('onuj2@example.test');
    await expect(getAliasSetup()).resolves.toEqual({
      alias: null,
      candidate: 'onuj2@example.test',
      probe_message_id: null,
    });
    await proposeAliasCandidate(null);
    await expect(getAliasSetup()).resolves.toEqual({ alias: null, candidate: null, probe_message_id: null });
  });

  it('never records a candidate the operator has moved on from, nor one a later probe replaced', async () => {
    await proposeAliasCandidate('onuj@example.test');
    await recordAliasProbe('onuj@example.test', PROBE);
    // The operator found it taken and moved to the next candidate before the probe was read back.
    await proposeAliasCandidate('onuj2@example.test');

    await expect(recordAliasProbe('onuj@example.test', LATER_PROBE)).resolves.toBe(false);
    await expect(recordVerifiedAlias('onuj@example.test', PROBE)).resolves.toBe(false);
    await expect(getAliasSetup()).resolves.toEqual({
      alias: null,
      candidate: 'onuj2@example.test',
      probe_message_id: null,
    });

    await recordAliasProbe('onuj2@example.test', PROBE);
    await recordAliasProbe('onuj2@example.test', LATER_PROBE);
    await expect(recordVerifiedAlias('onuj2@example.test', PROBE)).resolves.toBe(false);
    await expect(recordVerifiedAlias('onuj2@example.test', LATER_PROBE)).resolves.toBe(true);
    await expect(getAliasSetup()).resolves.toMatchObject({ alias: 'onuj2@example.test' });
  });

  it("refuses a candidate that is the assistant's own address, the principal's, malformed, or after one is verified", async () => {
    await expect(proposeAliasCandidate('Juno@example.test')).rejects.toThrow(/assistant's own address/u);
    await expect(proposeAliasCandidate('morgan@example.test')).rejects.toThrow(/principal's address/u);
    await expect(proposeAliasCandidate('onuj')).rejects.toThrow(/not an email address/u);

    await proposeAliasCandidate('onuj@example.test');
    await recordAliasProbe('onuj@example.test', PROBE);
    await recordVerifiedAlias('onuj@example.test', PROBE);
    await expect(proposeAliasCandidate('onuj2@example.test')).rejects.toThrow(/already onuj@example.test/u);
    await expect(recordAliasProbe('onuj@example.test', LATER_PROBE)).resolves.toBe(false);
    await expect(getAliasSetup()).resolves.toMatchObject({ alias: 'onuj@example.test', candidate: null });
  });
});
