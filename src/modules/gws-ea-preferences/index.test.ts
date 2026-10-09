import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { dispatch } from '../../cli/dispatch.js';
import type { CallerContext } from '../../cli/frame.js';
import { commandGuard, lookup } from '../../cli/registry.js';
import { ensureContainerConfig, updateContainerConfigScalars } from '../../db/container-configs.js';
import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { composeGroupProjectDoc } from '../../project-doc-compose.js';
import { getRequiredProjectDocSections } from '../../project-doc-sections.js';
import type { AgentGroup } from '../../types.js';
import '../gws-ea-profile/index.js';
import { getSchedulingPreferences, setSchedulingPreference } from './db.js';
import { MAIN_PREFERENCES_POINTER } from './index.js';

const TEST_ROOT = '/tmp/nanoclaw-gws-ea-preferences-test';

function group(id: string, name: string): AgentGroup {
  return { id, name, folder: id, agent_provider: null, created_at: '2026-09-30T00:00:00.000Z' };
}

const main = group('ag-main', 'main');
const other = group('ag-other', 'research');

function agent(agentGroupId: string): CallerContext {
  return { caller: 'agent', sessionId: `sess-${agentGroupId}`, agentGroupId, messagingGroupId: 'mg-dm' };
}

const HOST: CallerContext = { caller: 'host' };

function run(command: string, args: Record<string, unknown>, ctx: CallerContext = HOST) {
  return dispatch({ id: command, command, args }, ctx);
}

beforeEach(async () => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  await runMigrations(await initTestDb());
  for (const candidate of [main, other]) {
    await createAgentGroup(candidate);
    await ensureContainerConfig(candidate.id);
    await updateContainerConfigScalars(candidate.id, { cli_scope: 'global' });
  }
  // The canonical main, as the profile module's reconcile records it.
  await getDb().run('UPDATE gws_ea_profile SET main_agent_group_id = ? WHERE singleton = 1', main.id);
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('GWS-EA preferences ncl resource', () => {
  it('registers get, set, and remove as open, guarded preferences commands', () => {
    for (const verb of ['get', 'set', 'remove']) {
      const command = lookup(`preferences-${verb}`);
      expect(command, verb).toMatchObject({ access: 'open', resource: 'preferences', action: `preferences.${verb}` });
      expect(command?.hostOnly, verb).toBeFalsy();
      expect(commandGuard(`preferences-${verb}`).action).toBe(`preferences.${verb}`);
    }
  });

  it('lets main set, read, and forget preferences, including their main-only basis and reason', async () => {
    const caller = agent(main.id);

    const hours = await run(
      'preferences-set',
      {
        kind: 'working-hours',
        weekday: 'mon',
        start: '09:00',
        end: '17:00',
        source: 'principal',
        basis: 'Said Mondays are 9 to 5.',
      },
      caller,
    );
    expect(hours).toMatchObject({
      ok: true,
      data: { weekday: 'mon', off: false, start: '09:00', end: '17:00', source: 'principal' },
    });

    const window = await run(
      'preferences-set',
      {
        kind: 'protected-window',
        weekdays: 'mon,wed,fri',
        start: '12:00',
        end: '13:00',
        reason: 'Lunch with family.',
        source: 'principal',
        basis: 'Asked to keep lunch free.',
      },
      caller,
    );
    expect(window).toMatchObject({
      ok: true,
      data: { weekdays: ['mon', 'wed', 'fri'], reason: 'Lunch with family.', basis: 'Asked to keep lunch free.' },
    });
    const windowId = window.ok ? (window.data as { id: string }).id : '';

    for (const args of [
      { kind: 'working-hours', weekday: 'sat', off: true, source: 'principal', basis: 'No weekends.' },
      { kind: 'meeting-length', 'meeting-kind': 'one-on-one', minutes: '30', source: 'learned', basis: 'Usual.' },
      { kind: 'buffer', 'meeting-kind': 'default', minutes: '10', source: 'learned', basis: 'Median gap.' },
      {
        kind: 'preferred-time',
        'meeting-kind': 'external',
        weekdays: 'tue,thu',
        start: '10:00',
        end: '12:00',
        source: 'learned',
        basis: 'External calls cluster there.',
      },
    ]) {
      expect(await run('preferences-set', args, caller), args.kind).toMatchObject({ ok: true });
    }

    const read = await run('preferences-get', {}, caller);
    expect(read).toEqual({ id: 'preferences-get', ok: true, data: await getSchedulingPreferences() });
    expect(read.ok && read.data).toMatchObject({
      working_hours: [{ weekday: 'mon' }, { weekday: 'sat', off: true }],
      protected_windows: [{ id: windowId, reason: 'Lunch with family.' }],
      meeting_lengths: [{ meeting_kind: 'one-on-one', minutes: 30, basis: 'Usual.' }],
      buffers: [{ meeting_kind: 'default', minutes: 10 }],
      preferred_times: [{ meeting_kind: 'external', weekdays: ['tue', 'thu'] }],
    });

    expect(
      await run('preferences-remove', { kind: 'protected-window', id: windowId, source: 'principal' }, caller),
    ).toEqual({
      id: 'preferences-remove',
      ok: true,
      data: { removed: { kind: 'protected-window', id: windowId } },
    });
    // `ncl preferences remove <id>` arrives as a dash-joined command with the ID as its tail.
    await run('preferences-set', {
      kind: 'protected-window',
      start: '06:00',
      end: '07:00',
      source: 'principal',
      basis: 'Run.',
    });
    const [{ id: runId }] = (await getSchedulingPreferences()).protected_windows;
    expect(
      await run(`preferences-remove-${runId}`, { kind: 'protected-window', source: 'principal' }, caller),
    ).toMatchObject({
      ok: true,
    });
    expect(
      await run(
        'preferences-remove',
        { kind: 'meeting-length', 'meeting-kind': 'one-on-one', source: 'learned' },
        caller,
      ),
    ).toMatchObject({ ok: true, data: { removed: { kind: 'meeting-length', meeting_kind: 'one-on-one' } } });
    expect(await run('preferences-remove', { kind: 'buffer', 'meeting-kind': 'default' }, caller)).toMatchObject({
      ok: false,
    });
    expect(await getSchedulingPreferences()).toMatchObject({ protected_windows: [], meeting_lengths: [] });
  });

  it('rejects a learned write over a principal value and values outside the kind shape', async () => {
    await setSchedulingPreference({
      kind: 'working-hours',
      weekday: 'mon',
      hours: { start: '09:00', end: '17:00' },
      source: 'principal',
      basis: 'Said so.',
    });

    expect(
      await run('preferences-set', {
        kind: 'working-hours',
        weekday: 'mon',
        start: '08:00',
        end: '18:00',
        source: 'learned',
        basis: 'Usual first and last meeting.',
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'handler-error', message: expect.stringMatching(/set by the principal/i) },
    });
    expect(
      await run('preferences-set', {
        kind: 'working-hours',
        weekday: 'tue',
        start: '17:00',
        end: '09:00',
        source: 'principal',
        basis: 'Backwards.',
      }),
    ).toMatchObject({ ok: false, error: { message: expect.stringMatching(/end time must be after/i) } });
    expect(
      await run('preferences-set', {
        kind: 'meeting-length',
        'meeting-kind': 'x',
        minutes: '0',
        source: 'principal',
        basis: 'b',
      }),
    ).toMatchObject({ ok: false, error: { message: expect.stringMatching(/minutes/i) } });
  });

  it.each<[string, Record<string, unknown>, RegExp]>([
    [
      'a flag that belongs to another kind',
      {
        kind: 'working-hours',
        weekday: 'mon',
        start: '09:00',
        end: '17:00',
        reason: 'x',
        source: 'principal',
        basis: 'b',
      },
      /--reason does not apply to working-hours/,
    ],
    [
      'a missing required flag',
      { kind: 'meeting-length', minutes: '30', source: 'principal', basis: 'b' },
      /--meeting-kind is required for meeting-length/,
    ],
    [
      'hours and a day off together',
      {
        kind: 'working-hours',
        weekday: 'sat',
        off: true,
        start: '09:00',
        end: '12:00',
        source: 'principal',
        basis: 'b',
      },
      /either --off or --start and --end/,
    ],
    ['an unknown kind', { kind: 'lunch', source: 'principal', basis: 'b' }, /--kind must be one of/],
    [
      'an unknown flag',
      { kind: 'buffer', 'meeting-kind': 'default', minutes: '5', colour: 'red', source: 'principal', basis: 'b' },
      /unknown flag --colour/,
    ],
    [
      'a missing source',
      { kind: 'buffer', 'meeting-kind': 'default', minutes: '5', basis: 'b' },
      /--source is required/,
    ],
  ])('rejects %s when setting', async (_label, args, message) => {
    const response = await run('preferences-set', args);
    expect(response).toMatchObject({ ok: false, error: { message: expect.stringMatching(message) } });
    expect(await getSchedulingPreferences()).toMatchObject({ working_hours: [], meeting_lengths: [], buffers: [] });
  });

  it('rejects a remove that names the wrong field for its kind', async () => {
    expect(
      await run('preferences-remove', { kind: 'working-hours', 'meeting-kind': 'default', source: 'principal' }),
    ).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/--meeting-kind does not apply to working-hours/) },
    });
    expect(await run('preferences-remove', { kind: 'buffer', source: 'principal' })).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/--meeting-kind is required for buffer/) },
    });
  });

  it('refuses every agent but main, even one with global CLI scope, and group-scoped agents at the guard', async () => {
    for (const [command, args] of [
      ['preferences-get', {}],
      ['preferences-set', { kind: 'buffer', 'meeting-kind': 'default', minutes: '5', source: 'learned', basis: 'b' }],
      ['preferences-remove', { kind: 'buffer', 'meeting-kind': 'default', source: 'principal' }],
    ] as const) {
      expect(await run(command, args, agent(other.id)), command).toMatchObject({
        ok: false,
        error: { message: expect.stringMatching(/only to main/i) },
      });
    }

    await updateContainerConfigScalars(other.id, { cli_scope: 'group' });
    expect(await run('preferences-get', {}, agent(other.id))).toMatchObject({
      ok: false,
      error: { code: 'forbidden' },
    });
    expect(await getSchedulingPreferences()).toMatchObject({ buffers: [] });
  });
});

describe('GWS-EA preferences project-doc section', () => {
  it("gives external-email no preference value: it learns the principal's time only from the host", async () => {
    const externalEmail = group('ag-external-email', 'external-email');
    await createAgentGroup(externalEmail);
    await ensureContainerConfig(externalEmail.id);
    await getDb().run(
      'UPDATE gws_ea_profile SET external_email_agent_group_id = ? WHERE singleton = 1',
      externalEmail.id,
    );
    await setSchedulingPreference({
      kind: 'working-hours',
      weekday: 'mon',
      hours: { start: '09:00', end: '17:00' },
      source: 'principal',
      basis: 'Works nine to five.',
    });

    expect((await getRequiredProjectDocSections(externalEmail)).map((section) => section.name)).not.toContain(
      'Scheduling Preferences',
    );
    expect((await getRequiredProjectDocSections(other)).map((section) => section.name)).toContain(
      'Scheduling Preferences',
    );
  });

  it('adds no section to another group until a preference is stored', async () => {
    expect((await getRequiredProjectDocSections(other)).map((section) => section.name)).not.toContain(
      'Scheduling Preferences',
    );
  });

  it('points main at the live store, whatever it holds, and never copies a value it could change', async () => {
    const pointer = { name: 'Scheduling Preferences', body: MAIN_PREFERENCES_POINTER };
    expect(await getRequiredProjectDocSections(main)).toContainEqual(pointer);
    expect(MAIN_PREFERENCES_POINTER).toContain('`ncl preferences get`');

    await setSchedulingPreference({
      kind: 'protected-window',
      start: '00:00',
      end: '10:00',
      source: 'principal',
      basis: 'Said no meetings before 10.',
    });
    expect(await getRequiredProjectDocSections(main)).toContainEqual(pointer);
    const groupDir = path.join(TEST_ROOT, main.folder);
    await composeGroupProjectDoc(main, groupDir, { fileName: 'CLAUDE.md' });
    expect(fs.readFileSync(path.join(groupDir, 'CLAUDE.md'), 'utf8')).not.toContain('00:00-10:00');
  });

  it('summarizes the stored values with their source for the next session and omits reasons and bases', async () => {
    await setSchedulingPreference({
      kind: 'working-hours',
      weekday: 'tue',
      hours: { start: '10:00', end: '16:00' },
      source: 'learned',
      basis: 'Quoted from "Board prep" invites.',
    });
    await setSchedulingPreference({
      kind: 'working-hours',
      weekday: 'mon',
      hours: { start: '09:00', end: '17:00' },
      source: 'principal',
      basis: 'Said Mondays are 9 to 5.',
    });
    await setSchedulingPreference({
      kind: 'working-hours',
      weekday: 'sat',
      hours: 'off',
      source: 'principal',
      basis: 'No weekends.',
    });
    await setSchedulingPreference({
      kind: 'protected-window',
      weekdays: ['thu'],
      start: '16:00',
      end: '17:00',
      reason: 'Therapy appointment.',
      source: 'principal',
      basis: 'Asked to keep Thursday at four free.',
    });
    await setSchedulingPreference({
      kind: 'protected-window',
      start: '06:00',
      end: '07:00',
      source: 'principal',
      basis: 'Morning run.',
    });
    await setSchedulingPreference({
      kind: 'meeting-length',
      meetingKind: 'one-on-one',
      minutes: 30,
      source: 'learned',
      basis: 'Most common one-on-one length with Acme.',
    });
    await setSchedulingPreference({
      kind: 'buffer',
      meetingKind: 'default',
      minutes: 10,
      source: 'principal',
      basis: 'Wants ten minutes between meetings.',
    });
    await setSchedulingPreference({
      kind: 'preferred-time',
      meetingKind: 'external',
      weekdays: ['tue', 'thu'],
      start: '10:00',
      end: '12:00',
      source: 'learned',
      basis: 'External calls cluster on Tuesday and Thursday mornings.',
    });

    const section = (await getRequiredProjectDocSections(other)).find(
      (candidate) => candidate.name === 'Scheduling Preferences',
    );
    expect(section?.body).toBe(
      [
        "Times are the principal's local time. A value the principal set outranks a learned one.",
        '',
        'Working hours:',
        '- Monday: 09:00-17:00 (set by the principal)',
        '- Tuesday: 10:00-16:00 (learned)',
        '- Saturday: not working (set by the principal)',
        '',
        'Protected times:',
        '- Every day 06:00-07:00 (set by the principal)',
        '- Thursday 16:00-17:00 (set by the principal)',
        '',
        'Default meeting lengths:',
        '- one-on-one: 30 minutes (learned)',
        '',
        'Buffers around meetings:',
        '- default: 10 minutes (set by the principal)',
        '',
        'Preferred times:',
        '- external: Tuesday, Thursday 10:00-12:00 (learned)',
      ].join('\n'),
    );
    expect(section?.body).not.toMatch(/Therapy|Board prep|Acme|Wants ten|Morning run|cluster/);

    const groupDir = path.join(TEST_ROOT, other.folder);
    await composeGroupProjectDoc(other, groupDir, { fileName: 'CLAUDE.md' });
    const document = fs.readFileSync(path.join(groupDir, 'CLAUDE.md'), 'utf8');
    expect(document).toContain('# Scheduling Preferences');
    expect(document).toContain('- Monday: 09:00-17:00 (set by the principal)');
    expect(document).not.toContain('Therapy');
  });
});
