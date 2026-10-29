import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { composeGroupProjectDoc } from '../../project-doc-compose.js';
import { getRequiredProjectDocSections } from '../../project-doc-sections.js';
import type { AgentGroup } from '../../types.js';
import '../gws-ea-profile/index.js';
import '../gws-ea-preferences/index.js';
import '../gws-ea-people/index.js';
import '../gws-ea-privacy/index.js';
import '../gws-ea-whereabouts/index.js';
import { addPerson } from '../gws-ea-people/db.js';
import { setSchedulingPreference } from '../gws-ea-preferences/db.js';
import { addPlace, setBase, setRhythm, setPlacePair } from '../gws-ea-whereabouts/db.js';
import { MANUAL_KEYS, MANUAL_SECTION_BUDGET_CHARS, setManualSection } from './db.js';
import { loadManualFrontPage, MANUAL_FRONT_PAGE_BUDGET_CHARS } from './front-page.js';
import './index.js';

const group = (id: string): AgentGroup => ({
  id,
  name: id,
  folder: id,
  agent_provider: null,
  created_at: '2026-10-28T00:00:00Z',
});
const main = group('ag-main');
let base: string;
beforeEach(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-doc-'));
  await runMigrations(await initTestDb());
  for (const id of ['ag-main', 'ag-other', 'ag-email', 'ag-browser', 'ag-chat']) await createAgentGroup(group(id));
  await getDb().run(
    "UPDATE gws_ea_profile SET assistant_first_name='Juno', principal_first_name='Morgan', principal_last_name='Ellery', main_agent_group_id='ag-main', external_email_agent_group_id='ag-email', browser_agent_group_id='ag-browser', external_chat_agent_group_id='ag-chat', principal_timezone='America/Los_Angeles' WHERE singleton=1",
  );
});
afterEach(async () => {
  await closeDb();
  fs.rmSync(base, { recursive: true, force: true });
});

describe('Manual front page', () => {
  it('renders only for main, after the character, on every fresh composition without reading agent memory', async () => {
    await setManualSection('priorities', 'Protect a family evening.');
    const reads = vi.spyOn(fs, 'readFileSync');
    try {
      for (let spawn = 0; spawn < 2; spawn += 1) {
        const target = path.join(base, String(spawn));
        await composeGroupProjectDoc(main, target, { fileName: 'CLAUDE.md' });
        const document = fs.readFileSync(path.join(target, 'CLAUDE.md'), 'utf8');
        expect(document).toContain('Protect a family evening.');
        expect(document.indexOf('# Assistant Character')).toBeLessThan(document.indexOf('# Principal Manual'));
      }
      expect(reads.mock.calls.some(([file]) => String(file).includes('/memory/'))).toBe(false);
    } finally {
      reads.mockRestore();
    }
    for (const id of ['ag-other', 'ag-email', 'ag-browser', 'ag-chat'])
      expect((await getRequiredProjectDocSections(group(id))).map((section) => section.name)).not.toContain(
        'Principal Manual',
      );
  });

  it('shows one durable gap line until home, commute days and trip source have recorded answers', async () => {
    const empty = await loadManualFrontPage();
    expect(empty.match(/^Whereabouts gaps:/gmu)).toHaveLength(1);
    expect(empty).toContain('home base not set');
    expect(empty).toContain('commute days not set');
    expect(empty).toContain('Trips: no source yet');
    await addPlace({ id: 'home', label: 'Home', locality: 'Berkeley', home: true });
    await setBase({ placeId: 'home', tripSource: 'none' });
    await setRhythm({ weekdays: [] });
    expect(await loadManualFrontPage()).not.toContain('Whereabouts gaps:');
    expect(await loadManualFrontPage()).toContain('Commute days: none');
  });

  it('clears the trip-source gap when the Manual records a source, including none', async () => {
    for (const text of ['Forward confirmations to the assistant.', 'none']) {
      await setManualSection('travel-sources', text);
      const rendered = await loadManualFrontPage();
      expect(rendered).not.toContain('Trips: no source yet');
      expect(rendered).toContain(text);
      expect(rendered).toContain('home base not set');
    }
  });

  it('reads each fact from its native store and bounds the result with 100 saved places', async () => {
    await addPlace({ id: 'home', label: 'Home', locality: 'Berkeley', home: true });
    await addPlace({ id: 'office', label: 'Office', locality: 'Oakland', zone: 'America/Los_Angeles' });
    await setBase({ placeId: 'home', tripSource: 'forwarded confirmations' });
    await setRhythm({ weekdays: ['mon', 'wed'], placeId: 'office', start: '09:00', end: '17:00' });
    await setPlacePair({ fromPlaceId: 'home', toPlaceId: 'office', mode: 'rail', minutes: 25, source: 'learned' });
    for (let id = 0; id < 98; id += 1)
      await addPlace({ id: `saved-${id}`, label: `Saved ${id}`, locality: 'Berkeley', zone: 'America/Los_Angeles' });
    await setSchedulingPreference({
      kind: 'buffer',
      meetingKind: 'default',
      minutes: 15,
      source: 'principal',
      basis: 'Room to think.',
    });
    await addPerson({ name: 'Remy Vance', level: 'inner-circle', source: 'principal', basis: 'Sibling.' });
    await setManualSection('narrative', 'Morgan builds products.');
    let rendered = await loadManualFrontPage();
    for (const fact of [
      'Morgan Ellery',
      'Berkeley',
      'Office',
      'mon',
      'wed',
      '25 minutes',
      '15 minutes',
      'Remy Vance',
      'Morgan builds products.',
      '98 other saved places',
    ])
      expect(rendered, fact).toContain(fact);
    expect(rendered.length).toBeLessThanOrEqual(MANUAL_FRONT_PAGE_BUDGET_CHARS);
    await getDb().run("UPDATE gws_ea_profile SET principal_timezone='Europe/London' WHERE singleton=1");
    rendered = await loadManualFrontPage();
    expect(rendered).toContain('Home time zone: Europe/London');
    expect(rendered).not.toContain('Home time zone: America/Los_Angeles');
    for (const key of MANUAL_KEYS) await setManualSection(key, 'x'.repeat(MANUAL_SECTION_BUDGET_CHARS));
    expect((await loadManualFrontPage()).length).toBeLessThanOrEqual(MANUAL_FRONT_PAGE_BUDGET_CHARS);
    await setManualSection('narrative', 'A complete life account. '.repeat(1000));
    expect((await loadManualFrontPage()).length).toBeLessThanOrEqual(MANUAL_FRONT_PAGE_BUDGET_CHARS);
  });
});
