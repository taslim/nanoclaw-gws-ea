import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, getDb, initTestDb, runMigrations } from '../../db/index.js';
import {
  getSchedulingPreferences,
  getSchedulingPreferenceValues,
  MAIN_ONLY_PREFERENCE_FIELDS,
  removeSchedulingPreference,
  setSchedulingPreference,
  type SetPreferenceInput,
} from './db.js';
import './index.js';

const NOW = '2026-09-30T16:00:00.000Z';
const LATER = '2026-10-01T09:30:00.000Z';

const EMPTY = {
  working_hours: [],
  protected_windows: [],
  meeting_lengths: [],
  buffers: [],
  preferred_times: [],
};

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  await runMigrations(await initTestDb());
});

afterEach(async () => {
  vi.useRealTimers();
  await closeDb();
});

function mondayHours(source: 'principal' | 'learned', start: string, end: string, basis: string): SetPreferenceInput {
  return { kind: 'working-hours', weekday: 'mon', hours: { start, end }, source, basis };
}

/** Every object key anywhere inside `value`. */
function keysDeep(value: unknown): Set<string> {
  const keys = new Set<string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
    } else if (node !== null && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) {
        keys.add(key);
        visit(child);
      }
    }
  };
  visit(value);
  return keys;
}

describe('GWS-EA scheduling preferences store', () => {
  it('stores working hours the principal sets for Monday with source principal', async () => {
    const stored = await setSchedulingPreference(
      mondayHours('principal', '09:00', '17:00', 'Said Mondays are 9 to 5.'),
    );

    const expected = {
      weekday: 'mon',
      off: false,
      start: '09:00',
      end: '17:00',
      source: 'principal',
      basis: 'Said Mondays are 9 to 5.',
      updated_at: NOW,
    };
    expect(stored).toEqual(expected);
    expect(await getSchedulingPreferences()).toEqual({ ...EMPTY, working_hours: [expected] });
  });

  it('rejects a learned value over a principal-set one and stores a learned value for an unset field with its basis', async () => {
    await setSchedulingPreference(mondayHours('principal', '09:00', '17:00', 'Said Mondays are 9 to 5.'));
    await setSchedulingPreference({
      kind: 'meeting-length',
      meetingKind: 'one-on-one',
      minutes: 30,
      source: 'principal',
      basis: 'Asked for 30-minute one-on-ones.',
    });

    await expect(
      setSchedulingPreference(mondayHours('learned', '08:30', '18:00', 'First and last meetings over eight weeks.')),
    ).rejects.toThrow(/set by the principal/i);
    await expect(
      setSchedulingPreference({
        kind: 'meeting-length',
        meetingKind: 'one-on-one',
        minutes: 45,
        source: 'learned',
        basis: 'Most common one-on-one length.',
      }),
    ).rejects.toThrow(/set by the principal/i);

    vi.setSystemTime(new Date(LATER));
    const learned = await setSchedulingPreference({
      kind: 'working-hours',
      weekday: 'tue',
      hours: { start: '10:00', end: '16:00' },
      source: 'learned',
      basis: 'Usual first and last meeting on Tuesdays over eight weeks.',
    });

    expect(learned).toEqual({
      weekday: 'tue',
      off: false,
      start: '10:00',
      end: '16:00',
      source: 'learned',
      basis: 'Usual first and last meeting on Tuesdays over eight weeks.',
      updated_at: LATER,
    });
    const preferences = await getSchedulingPreferences();
    expect(preferences.working_hours).toEqual([
      {
        weekday: 'mon',
        off: false,
        start: '09:00',
        end: '17:00',
        source: 'principal',
        basis: 'Said Mondays are 9 to 5.',
        updated_at: NOW,
      },
      learned,
    ]);
    expect(preferences.meeting_lengths).toEqual([
      {
        meeting_kind: 'one-on-one',
        minutes: 30,
        source: 'principal',
        basis: 'Asked for 30-minute one-on-ones.',
        updated_at: NOW,
      },
    ]);
  });

  it('lets the principal replace a learned value and learning refresh its own', async () => {
    await setSchedulingPreference({
      kind: 'buffer',
      meetingKind: 'default',
      minutes: 5,
      source: 'learned',
      basis: 'Median gap between meetings.',
    });
    await setSchedulingPreference({
      kind: 'buffer',
      meetingKind: 'default',
      minutes: 10,
      source: 'learned',
      basis: 'Median gap between meetings, refreshed.',
    });
    expect((await getSchedulingPreferences()).buffers).toEqual([
      {
        meeting_kind: 'default',
        minutes: 10,
        source: 'learned',
        basis: 'Median gap between meetings, refreshed.',
        updated_at: NOW,
      },
    ]);

    await setSchedulingPreference({
      kind: 'buffer',
      meetingKind: 'default',
      minutes: 15,
      source: 'principal',
      basis: 'Wants 15 minutes between meetings.',
    });
    expect((await getSchedulingPreferences()).buffers).toEqual([
      {
        meeting_kind: 'default',
        minutes: 15,
        source: 'principal',
        basis: 'Wants 15 minutes between meetings.',
        updated_at: NOW,
      },
    ]);
  });

  it('rejects an end time before or equal to its start time for every kind with a time range', async () => {
    const attempts: SetPreferenceInput[] = [
      mondayHours('principal', '17:00', '09:00', 'Backwards hours.'),
      {
        kind: 'protected-window',
        weekdays: ['wed'],
        start: '13:00',
        end: '12:00',
        source: 'principal',
        basis: 'Backwards window.',
      },
      {
        kind: 'preferred-time',
        meetingKind: 'external',
        start: '11:00',
        end: '11:00',
        source: 'learned',
        basis: 'Empty range.',
      },
    ];
    for (const attempt of attempts) {
      await expect(setSchedulingPreference(attempt), attempt.kind).rejects.toThrow(/end time must be after/i);
    }
    expect(await getSchedulingPreferences()).toEqual(EMPTY);
  });

  it.each<[string, SetPreferenceInput, RegExp]>([
    [
      'an unknown weekday',
      {
        kind: 'working-hours',
        weekday: 'funday',
        hours: { start: '09:00', end: '17:00' },
        source: 'principal',
        basis: 'b',
      },
      /weekday/i,
    ],
    ['an hour past 23', mondayHours('principal', '25:00', '26:00', 'b'), /time/i],
    ['a clock without minutes', mondayHours('principal', '9am', '17:00', 'b'), /time/i],
    ['minutes past 59', mondayHours('principal', '12:60', '17:00', 'b'), /time/i],
    ['a start at the end of the day', mondayHours('principal', '24:00', '24:00', 'b'), /time/i],
    [
      'a zero meeting length',
      { kind: 'meeting-length', meetingKind: 'one-on-one', minutes: 0, source: 'principal', basis: 'b' },
      /minutes/i,
    ],
    [
      'a negative meeting length',
      { kind: 'meeting-length', meetingKind: 'one-on-one', minutes: -15, source: 'principal', basis: 'b' },
      /minutes/i,
    ],
    [
      'a fractional meeting length',
      { kind: 'meeting-length', meetingKind: 'one-on-one', minutes: 12.5, source: 'principal', basis: 'b' },
      /minutes/i,
    ],
    [
      'a meeting length longer than a day',
      { kind: 'meeting-length', meetingKind: 'one-on-one', minutes: 1441, source: 'principal', basis: 'b' },
      /minutes/i,
    ],
    [
      'a negative buffer',
      { kind: 'buffer', meetingKind: 'default', minutes: -5, source: 'principal', basis: 'b' },
      /minutes/i,
    ],
    [
      'a meeting kind that is not a short name',
      { kind: 'meeting-length', meetingKind: 'One on One!', minutes: 30, source: 'principal', basis: 'b' },
      /meeting kind/i,
    ],
    [
      'an empty weekday list',
      { kind: 'protected-window', weekdays: [], start: '12:00', end: '13:00', source: 'principal', basis: 'b' },
      /weekday/i,
    ],
    [
      'an unknown weekday in a list',
      {
        kind: 'preferred-time',
        meetingKind: 'external',
        weekdays: ['tue', 'someday'],
        start: '10:00',
        end: '12:00',
        source: 'learned',
        basis: 'b',
      },
      /weekday/i,
    ],
    ['an unknown source', { ...mondayHours('principal', '09:00', '17:00', 'b'), source: 'guessed' }, /source/i],
    ['an empty basis', mondayHours('principal', '09:00', '17:00', '   '), /basis/i],
    ['a multi-line basis', mondayHours('principal', '09:00', '17:00', 'line one\nline two'), /basis/i],
    ['an overlong basis', mondayHours('principal', '09:00', '17:00', 'x'.repeat(281)), /basis/i],
    [
      'a reason with control characters',
      {
        kind: 'protected-window',
        start: '12:00',
        end: '13:00',
        reason: 'Lunch\u001b[2J',
        source: 'principal',
        basis: 'b',
      },
      /reason/i,
    ],
  ])('rejects %s', async (_label, input, message) => {
    await expect(setSchedulingPreference(input)).rejects.toThrow(message);
    expect(await getSchedulingPreferences()).toEqual(EMPTY);
  });

  it('accepts the edges of each shape and stores them normalized', async () => {
    await setSchedulingPreference({
      kind: 'working-hours',
      weekday: 'Friday',
      hours: { start: '9:05', end: '24:00' },
      source: 'principal',
      basis: 'Works late on Fridays.',
    });
    await setSchedulingPreference({
      kind: 'buffer',
      meetingKind: 'Internal',
      minutes: 0,
      source: 'principal',
      basis: 'Back-to-back internal meetings are fine.',
    });
    await setSchedulingPreference({
      kind: 'preferred-time',
      meetingKind: 'external',
      weekdays: ['thu', 'TUE', 'thu'],
      start: '10:00',
      end: '12:00',
      source: 'learned',
      basis: 'External meetings cluster on Tuesday and Thursday mornings.',
    });

    const preferences = await getSchedulingPreferences();
    expect(preferences.working_hours).toMatchObject([{ weekday: 'fri', off: false, start: '09:05', end: '24:00' }]);
    expect(preferences.buffers).toMatchObject([{ meeting_kind: 'internal', minutes: 0 }]);
    expect(preferences.preferred_times).toMatchObject([
      { meeting_kind: 'external', weekdays: ['tue', 'thu'], start: '10:00', end: '12:00' },
    ]);
  });

  it('records a weekday the principal does not work, distinct from an unset one', async () => {
    const stored = await setSchedulingPreference({
      kind: 'working-hours',
      weekday: 'sat',
      hours: 'off',
      source: 'principal',
      basis: 'Does not work weekends.',
    });

    expect(stored).toEqual({
      weekday: 'sat',
      off: true,
      source: 'principal',
      basis: 'Does not work weekends.',
      updated_at: NOW,
    });
    expect((await getSchedulingPreferences()).working_hours).toEqual([stored]);
  });

  it('returns a removed preference to unset', async () => {
    await setSchedulingPreference(mondayHours('principal', '09:00', '17:00', 'Said so.'));
    await setSchedulingPreference({
      kind: 'meeting-length',
      meetingKind: 'one-on-one',
      minutes: 30,
      source: 'learned',
      basis: 'Most common length.',
    });
    const window = await setSchedulingPreference({
      kind: 'protected-window',
      weekdays: ['fri'],
      start: '14:00',
      end: '17:00',
      reason: 'Writing time.',
      source: 'principal',
      basis: 'Asked to keep Friday afternoons free.',
    });

    await removeSchedulingPreference({ kind: 'working-hours', weekday: 'monday', source: 'principal' });
    await removeSchedulingPreference({ kind: 'meeting-length', meetingKind: 'one-on-one', source: 'learned' });
    await removeSchedulingPreference({ kind: 'protected-window', id: window.id, source: 'principal' });

    expect(await getSchedulingPreferences()).toEqual(EMPTY);
    await expect(
      removeSchedulingPreference({ kind: 'working-hours', weekday: 'mon', source: 'principal' }),
    ).rejects.toThrow(/no working hours/i);
    await expect(
      removeSchedulingPreference({ kind: 'protected-window', id: window.id, source: 'principal' }),
    ).rejects.toThrow(/no protected window/i);
    await expect(
      removeSchedulingPreference({ kind: 'buffer', meetingKind: 'default', source: 'principal' }),
    ).rejects.toThrow(/no buffer/i);

    // An unset field accepts a learned value again once the principal's is forgotten.
    await expect(
      setSchedulingPreference(mondayHours('learned', '08:30', '18:00', 'Usual first and last meeting.')),
    ).resolves.toMatchObject({ source: 'learned' });
  });

  it('never lets a learned removal erase a value the principal set; the principal can remove it', async () => {
    const principalSet = await setSchedulingPreference(mondayHours('principal', '09:00', '17:00', 'Said so.'));

    await expect(
      removeSchedulingPreference({ kind: 'working-hours', weekday: 'mon', source: 'learned' }),
    ).rejects.toThrow('Working hours for Monday: set by the principal, so a learned value cannot remove it');
    expect((await getSchedulingPreferences()).working_hours).toEqual([principalSet]);

    await expect(
      removeSchedulingPreference({ kind: 'working-hours', weekday: 'mon', source: 'principal' }),
    ).resolves.toEqual({ kind: 'working-hours', weekday: 'mon' });
    expect((await getSchedulingPreferences()).working_hours).toEqual([]);
  });

  it('identifies a protected window by its days and hours, so stating it again updates the same window', async () => {
    const lunch = await setSchedulingPreference({
      kind: 'protected-window',
      weekdays: ['mon', 'tue', 'wed', 'thu', 'fri'],
      start: '12:00',
      end: '13:00',
      reason: 'Lunch with family.',
      source: 'principal',
      basis: 'Said lunch is sacred.',
    });
    expect(lunch).toMatchObject({ id: expect.stringMatching(/^w-[0-9a-f]{8}$/), reason: 'Lunch with family.' });

    const focus = await setSchedulingPreference({
      kind: 'protected-window',
      weekdays: ['fri'],
      start: '14:00',
      end: '17:00',
      source: 'principal',
      basis: 'Asked to keep Friday afternoons for focus.',
    });
    const restated = await setSchedulingPreference({
      kind: 'protected-window',
      weekdays: ['fri'],
      start: '14:00',
      end: '17:00',
      source: 'principal',
      basis: 'Said Friday afternoons stay free.',
    });
    expect(restated.id).toBe(focus.id);
    expect(focus.reason).toBeNull();

    const moved = await setSchedulingPreference({
      kind: 'protected-window',
      id: lunch.id,
      weekdays: ['mon', 'tue', 'wed', 'thu', 'fri'],
      start: '12:30',
      end: '13:30',
      reason: 'Lunch with family.',
      source: 'principal',
      basis: 'Moved lunch half an hour later.',
    });
    expect(moved).toMatchObject({ id: lunch.id, start: '12:30', end: '13:30' });

    const everyDay = await setSchedulingPreference({
      kind: 'protected-window',
      start: '06:00',
      end: '07:00',
      source: 'principal',
      basis: 'Morning run.',
    });
    expect(everyDay).toMatchObject({ weekdays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] });

    await expect(
      setSchedulingPreference({
        kind: 'protected-window',
        id: focus.id,
        weekdays: ['mon', 'tue', 'wed', 'thu', 'fri'],
        start: '12:30',
        end: '13:30',
        source: 'principal',
        basis: 'Duplicate of lunch.',
      }),
    ).rejects.toThrow(/already protects/i);
    await expect(
      setSchedulingPreference({
        kind: 'protected-window',
        id: 'w-00000000',
        start: '15:00',
        end: '16:00',
        source: 'principal',
        basis: 'Unknown window.',
      }),
    ).rejects.toThrow(/no protected window/i);

    expect((await getSchedulingPreferences()).protected_windows.map((window) => window.id).sort()).toEqual(
      [lunch.id, focus.id, everyDay.id].sort(),
    );
  });

  it('never learns protected time: learning neither adds, changes, nor removes a window', async () => {
    const window = { kind: 'protected-window', weekdays: ['fri'], start: '14:00', end: '17:00' } as const;
    await expect(
      setSchedulingPreference({ ...window, source: 'learned', basis: 'Recurring focus block on Fridays.' }),
    ).rejects.toThrow("Protected time is set and removed only on the principal's word: ask the principal.");
    expect((await getSchedulingPreferences()).protected_windows).toEqual([]);

    const focus = await setSchedulingPreference({ ...window, source: 'principal', basis: 'Asked for focus time.' });
    await expect(
      setSchedulingPreference({ ...window, id: focus.id, start: '15:00', source: 'learned', basis: 'Starts later.' }),
    ).rejects.toThrow(/only on the principal's word/);
    await expect(
      removeSchedulingPreference({ kind: 'protected-window', id: focus.id, source: 'learned' }),
    ).rejects.toThrow(/only on the principal's word/);
    expect((await getSchedulingPreferences()).protected_windows).toEqual([focus]);
  });

  it('reads the preference values without the basis and reason fields, which are marked main-only', async () => {
    expect(MAIN_ONLY_PREFERENCE_FIELDS).toEqual(['basis', 'reason']);
    await setSchedulingPreference(mondayHours('principal', '09:00', '17:00', 'Quoted from "Board prep" invites.'));
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
      kind: 'meeting-length',
      meetingKind: 'external',
      minutes: 45,
      source: 'learned',
      basis: 'Most common length of calls with Acme.',
    });
    await setSchedulingPreference({
      kind: 'buffer',
      meetingKind: 'default',
      minutes: 10,
      source: 'learned',
      basis: 'Median gap between meetings.',
    });
    await setSchedulingPreference({
      kind: 'preferred-time',
      meetingKind: 'one-on-one',
      weekdays: ['wed'],
      start: '14:00',
      end: '16:00',
      source: 'principal',
      basis: 'Prefers one-on-ones on Wednesday afternoons.',
    });

    const values = await getSchedulingPreferenceValues();

    expect(values).toEqual({
      working_hours: [
        { weekday: 'mon', off: false, start: '09:00', end: '17:00', source: 'principal', updated_at: NOW },
      ],
      protected_windows: [
        {
          id: expect.stringMatching(/^w-/),
          weekdays: ['thu'],
          start: '16:00',
          end: '17:00',
          source: 'principal',
          updated_at: NOW,
        },
      ],
      meeting_lengths: [{ meeting_kind: 'external', minutes: 45, source: 'learned', updated_at: NOW }],
      buffers: [{ meeting_kind: 'default', minutes: 10, source: 'learned', updated_at: NOW }],
      preferred_times: [
        {
          meeting_kind: 'one-on-one',
          weekdays: ['wed'],
          start: '14:00',
          end: '16:00',
          source: 'principal',
          updated_at: NOW,
        },
      ],
    });
    for (const field of MAIN_ONLY_PREFERENCE_FIELDS) expect(keysDeep(values).has(field), field).toBe(false);
    expect(JSON.stringify(values)).not.toMatch(/Board prep|Therapy|Acme|Median gap|Prefers/);

    const full = await getSchedulingPreferences();
    expect(full.protected_windows[0]).toMatchObject({ reason: 'Therapy appointment.' });
    expect(full.meeting_lengths[0]).toMatchObject({ basis: 'Most common length of calls with Acme.' });
  });

  it('records the migration and enforces each kind of value in the schema itself', async () => {
    const db = getDb();
    expect(
      await db.get('SELECT name FROM schema_version WHERE name = ?', 'module:gws-ea-preferences:create-preferences'),
    ).toEqual({ name: 'module:gws-ea-preferences:create-preferences' });

    const provenance = ['principal', 'basis', NOW] as const;
    await expect(
      db.run(
        `INSERT INTO gws_ea_pref_working_hours (weekday, start_minute, end_minute, source, basis, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        'mon',
        600,
        540,
        ...provenance,
      ),
    ).rejects.toThrow();
    await expect(
      db.run(
        `INSERT INTO gws_ea_pref_working_hours (weekday, start_minute, end_minute, source, basis, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        'mon',
        540,
        null,
        ...provenance,
      ),
    ).rejects.toThrow();
    await expect(
      db.run(
        `INSERT INTO gws_ea_pref_working_hours (weekday, start_minute, end_minute, source, basis, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        'someday',
        540,
        600,
        ...provenance,
      ),
    ).rejects.toThrow();
    await expect(
      db.run(
        `INSERT INTO gws_ea_pref_meeting_lengths (meeting_kind, minutes, source, basis, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        'one-on-one',
        0,
        ...provenance,
      ),
    ).rejects.toThrow();
    await expect(
      db.run(
        `INSERT INTO gws_ea_pref_buffers (meeting_kind, minutes, source, basis, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        'default',
        10,
        'guessed',
        'basis',
        NOW,
      ),
    ).rejects.toThrow();
    await expect(
      db.run(
        `INSERT INTO gws_ea_pref_preferred_times (meeting_kind, weekdays, start_minute, end_minute, source, basis, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        'external',
        'tue',
        600,
        1441,
        ...provenance,
      ),
    ).rejects.toThrow();
    expect(await getSchedulingPreferences()).toEqual(EMPTY);
  });
});
