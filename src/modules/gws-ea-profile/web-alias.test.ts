import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { ensureContainerConfig } from '../../db/container-configs.js';
import {
  getAliasSetup,
  getAssistantAlias,
  proposeAliasCandidate,
  recordAliasProbe,
  recordVerifiedAlias,
  reconcileGwsEaProfile,
} from './db.js';
import './index.js';

const PROBE = '<alias-check.0123456789abcdef0123456789abcdef@example.test>';
const LATER_PROBE = '<alias-check.fedcba9876543210fedcba9876543210@example.test>';

beforeEach(async () => {
  await runMigrations(await initTestDb());
  await createAgentGroup({
    id: 'ag-main',
    name: 'main',
    folder: 'main',
    agent_provider: null,
    created_at: '2026-10-17T00:00:00.000Z',
  });
  await ensureContainerConfig('ag-main');
  await reconcileGwsEaProfile({
    assistantDisplayName: 'Juno',
    assistantWorkspaceEmail: 'juno@example.test',
    principalDisplayName: 'Morgan Ellery',
    principalTimezone: 'America/New_York',
    mainAgentGroupId: 'ag-main',
    principalEmails: ['morgan@example.test'],
  });
});

afterEach(async () => {
  await closeDb();
});

describe("the assistant's web alias in its profile (KTD13)", () => {
  it('holds nothing until a candidate is proposed, and no alias until a probe proves it', async () => {
    await expect(getAliasSetup()).resolves.toEqual({ alias: null, candidate: null, probe_message_id: null });
    await expect(getAssistantAlias()).resolves.toBeNull();

    await expect(proposeAliasCandidate('ONUJ@example.test')).resolves.toEqual({
      alias: null,
      candidate: 'onuj@example.test',
      probe_message_id: null,
    });
    await expect(recordAliasProbe('onuj@example.test', PROBE)).resolves.toBe(true);
    await expect(getAssistantAlias()).resolves.toBeNull();

    await expect(recordVerifiedAlias('onuj@example.test', PROBE)).resolves.toBe(true);
    await expect(getAliasSetup()).resolves.toEqual({
      alias: 'onuj@example.test',
      candidate: null,
      probe_message_id: null,
    });
    await expect(getAssistantAlias()).resolves.toBe('onuj@example.test');
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
    await expect(getAssistantAlias()).resolves.toBe('onuj2@example.test');
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

  it('adds only nullable columns, so a profile from before reads as having no alias', async () => {
    const columns = await getDb().all<{ name: string; notnull: number }>("PRAGMA table_info('gws_ea_profile')");
    expect(
      columns.filter((column) =>
        ['assistant_alias', 'alias_candidate', 'alias_probe_message_id'].includes(column.name),
      ),
    ).toEqual([
      expect.objectContaining({ name: 'assistant_alias', notnull: 0 }),
      expect.objectContaining({ name: 'alias_candidate', notnull: 0 }),
      expect.objectContaining({ name: 'alias_probe_message_id', notnull: 0 }),
    ]);
  });
});
