import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dispatch } from '../../cli/dispatch.js';
import type { CallerContext } from '../../cli/frame.js';
import { ensureContainerConfig, updateContainerConfigScalars } from '../../db/container-configs.js';
import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { GOOGLE_GRANT_FILE_ENV } from '../gws-ea-google/grant.js';
import { addPerson, forgetPerson } from '../gws-ea-people/db.js';
import '../gws-ea-profile/index.js';
import '../gws-ea-preferences/index.js';
import '../gws-ea-people/index.js';
import '../gws-ea-privacy/index.js';
import '../gws-ea-whereabouts/index.js';
import { addPlace, addStay, getWhereaboutsHistory, setBase } from '../gws-ea-whereabouts/db.js';
import { getManualHistory, getManualSections, setManualSection } from './db.js';
import { loadManualFrontPage, MANUAL_SECTION_BUDGET_CHARS } from './front-page.js';
import './index.js';

const main: CallerContext = {
  caller: 'agent',
  sessionId: 's-main',
  agentGroupId: 'ag-main',
  messagingGroupId: 'mg-main',
};
const other: CallerContext = { ...main, agentGroupId: 'ag-other' };
const run = (verb: string, args: Record<string, unknown> = {}, ctx: CallerContext = main) =>
  dispatch({ id: verb, command: `manual-${verb}`, args }, ctx);
let secrets: string;

beforeEach(async () => {
  secrets = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-secrets-'));
  fs.chmodSync(secrets, 0o700);
  vi.stubEnv(GOOGLE_GRANT_FILE_ENV, path.join(secrets, 'google.json'));
  await runMigrations(await initTestDb());
  for (const id of ['ag-main', 'ag-other']) {
    await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: '2026-10-28T00:00:00Z' });
    await ensureContainerConfig(id);
    await updateContainerConfigScalars(id, { cli_scope: 'global' });
  }
  await getDb().run(
    "UPDATE gws_ea_profile SET assistant_first_name='Juno', principal_first_name='Morgan', main_agent_group_id='ag-main', principal_timezone='America/Los_Angeles' WHERE singleton=1",
  );
});
afterEach(async () => {
  await closeDb();
  vi.unstubAllEnvs();
  fs.rmSync(secrets, { recursive: true, force: true });
});

describe('Manual commands', () => {
  it('stores edits in full, reports sizes, and keeps the dated previous value', async () => {
    expect(await run('set', { section: 'priorities', text: 'Protect the launch.' })).toMatchObject({
      ok: true,
      data: {
        section: { key: 'priorities', text: 'Protect the launch.' },
        characters: 19,
        front_page_budget_characters: MANUAL_SECTION_BUDGET_CHARS,
      },
    });
    const first = (await getManualSections())[0];
    const text = 'Keep the family evening clear. '.repeat(200);
    expect(await run('set', { section: 'priorities', text })).toMatchObject({
      ok: true,
      data: { characters: text.length, over_front_page_budget: true },
    });
    expect(await run('get', { section: 'priorities' })).toMatchObject({ ok: true, data: { key: 'priorities', text } });
    expect(await getManualHistory('priorities')).toEqual([
      { key: 'priorities', text: first.text, updated_at: first.updated_at },
    ]);
    expect(await loadManualFrontPage()).toContain('Priorities: read `ncl manual get --section priorities`');
    expect(await loadManualFrontPage()).not.toContain('Keep the family');
  });

  it('clears a section through the same edit path and keeps its previous value', async () => {
    await run('set', { section: 'narrative', text: 'Morgan builds products.' });
    expect(await run('set', { section: 'narrative', text: '' })).toMatchObject({
      ok: true,
      data: { section: { text: '' }, characters: 0, words: 0 },
    });
    expect(await loadManualFrontPage()).toContain('Who the principal is: not recorded.');
    expect(await getManualHistory('narrative')).toEqual([expect.objectContaining({ text: 'Morgan builds products.' })]);
  });

  it('authorizes only main or the host for get, set and history', async () => {
    for (const verb of ['get', 'set', 'history']) {
      expect(
        await run(verb, { ...(verb === 'set' ? { section: 'principles', text: 'Leave room to think.' } : {}) }, other),
      ).toMatchObject({ ok: false, error: { message: expect.stringContaining('only to main') } });
    }
    expect(await run('get', {}, { caller: 'host' })).toMatchObject({ ok: true });
    expect(await getManualSections()).toEqual([]);
  });

  it('answers get without --section with the Manual sections alone, not the other stores', async () => {
    await setManualSection('priorities', 'Protect the launch.');
    await addPlace({ id: 'office', label: 'Office', locality: 'Oakland', zone: 'America/Los_Angeles' });
    const response = await run('get');
    expect(response).toMatchObject({ ok: true, data: await getManualSections() });
    expect(JSON.stringify(response)).not.toContain('Oakland');
  });

  it('keeps the real previous value when the same text is saved again', async () => {
    await run('set', { section: 'priorities', text: 'Protect the launch.' });
    await run('set', { section: 'priorities', text: 'Finish the launch.' });
    expect(await run('set', { section: 'priorities', text: 'Finish the launch.' })).toMatchObject({ ok: true });
    expect(await getManualHistory('priorities')).toEqual([expect.objectContaining({ text: 'Protect the launch.' })]);
  });

  it('keeps the trip source only in whereabouts, which the front page renders', async () => {
    expect(await run('set', { section: 'travel-sources', text: 'Forwarded confirmations.' })).toMatchObject({
      ok: false,
    });
    await setBase({ tripSource: 'Forwarded confirmations.' });
    const page = await loadManualFrontPage();
    expect(page).toContain('Trips: Forwarded confirmations.');
    expect(page).not.toContain('Trips: no source yet');
  });

  it('puts what may name a forgotten person to main and clears the kept previous values that name them', async () => {
    const person = await addPerson({
      name: 'Remy Vance',
      level: 'inner-circle',
      source: 'principal',
      basis: 'Family.',
      identity: 'email:remy@example.test',
    });
    await setManualSection('principles', 'Make room for Remy Vance.');
    await setManualSection('principles', 'Keep evenings clear.');
    await setManualSection('priorities', 'Call Remy Vance.');
    await setManualSection('narrative', 'Morgan builds products.');
    await setManualSection('narrative', 'Morgan builds tools.');
    await setBase({ tripSource: 'Forwarded confirmations.' });
    await setBase({ tripSource: 'Remy forwards their own tickets.' });
    await addPlace({ id: 'studio', label: 'Remy studio', locality: 'Berkeley', zone: 'America/Los_Angeles' });
    const stay = await addStay({
      locality: 'Remy Vance house',
      zone: 'America/Los_Angeles',
      start: '2026-11-02',
      end: '2026-11-03',
      source: 'said',
      certainty: 'certain',
    });

    const answer = await forgetPerson({ id: person.id });

    expect([...answer.rewrite].sort()).toEqual(
      [
        'Manual priorities',
        'whereabouts trip source',
        'whereabouts place studio',
        `whereabouts stay ${stay.id}`,
      ].sort(),
    );
    expect(await getManualHistory()).toEqual([
      expect.objectContaining({ key: 'narrative', text: 'Morgan builds products.' }),
    ]);
    expect(await getWhereaboutsHistory()).toEqual([
      expect.objectContaining({
        kind: 'base',
        value: expect.objectContaining({ trip_source: 'Forwarded confirmations.' }),
      }),
    ]);
  });

  it('leaves a section that only shares a word with a forgotten name on the front page', async () => {
    const person = await addPerson({ name: 'Juno Park', level: 'close', source: 'principal', basis: 'Neighbor.' });
    await setManualSection('preferences', 'Sunday walks in Park Slope.');

    expect((await forgetPerson({ id: person.id })).rewrite).toContain('Manual preferences');

    expect(await loadManualFrontPage()).toContain('Sunday walks in Park Slope.');
  });
});
