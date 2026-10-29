import { describe, expect, it } from 'vitest';
import { buildWeek } from './model.js';
import { checkWeek, presentFinding } from './checker.js';
import { event, input, timeline } from './testing/fixture.js';
import type { Matter } from '../../gws-ea-matters/db.js';

const kinds = (args: Parameters<typeof input>[0], overrides: Parameters<typeof input>[1] = {}) =>
  checkWeek(buildWeek(input(args, overrides))).map((f) => f.kind);
const at = (hour: string) => `2026-10-05T${hour}:00-07:00`;
const meeting = (id: string, start: string, end: string, extra: Parameters<typeof event>[3] = {}) =>
  event(id, at(start), at(end), extra);

describe('factual week findings', () => {
  it.each([
    [
      'overlap',
      [meeting('a', '09:00', '10:00'), meeting('b', '09:30', '10:30')],
      [meeting('a', '09:00', '10:00'), meeting('b', '10:00', '10:30')],
    ],
    ['meal', [meeting('a', '11:30', '14:00')], [meeting('a', '11:30', '12:30')]],
    [
      'back-to-back',
      [meeting('a', '09:00', '11:00'), meeting('b', '11:00', '13:00')],
      [meeting('a', '09:00', '10:00'), meeting('b', '10:30', '11:30')],
    ],
    ['working-hours', [meeting('a', '06:00', '07:00')], [meeting('a', '09:00', '10:00')]],
    [
      'missing-prep',
      [meeting('a', '09:00', '10:00', { attendees: [{ email: 'remy@vance.example' }] })],
      [
        meeting('a', '09:00', '10:00', {
          attendees: [{ email: 'remy@vance.example' }],
          description: 'Review the attached account.',
        }),
      ],
    ],
    [
      'attendance-missing',
      [meeting('a', '09:00', '10:00', { summary: 'Lunch with Remy', attendees: [{ email: 'remy@vance.example' }] })],
      [
        meeting('a', '09:00', '10:00', {
          summary: 'Lunch with Remy',
          attendees: [{ email: 'remy@vance.example' }],
          location: 'Mission restaurant',
        }),
      ],
    ],
  ] as const)('%s has a positive and negative case', (kind, positive, negative) => {
    expect(kinds(positive)).toContain(kind);
    expect(kinds(negative)).not.toContain(kind);
  });
  it('a clean day has no findings and an unknown home emits one gap without per-event travel findings', () => {
    expect(kinds([meeting('a', '09:00', '10:00')])).toEqual([]);
    const unknown = { ...timeline, base: { ...timeline.base, home_place_id: null } };
    expect(kinds([meeting('a', '09:00', '10:00', { location: 'Unknown venue' })], { timeline: unknown })).toEqual([
      'whereabouts-gap',
    ]);
  });
  it('measures every errand leg from the current base and known directional pairs', () => {
    const pairs = [
      ['sf', 'mv', 40],
      ['mv', 'mission', 50],
      ['mission', 'sf', 15],
    ].map(([from, to, minutes]) => ({
      from_place_id: String(from),
      to_place_id: String(to),
      minutes: Number(minutes),
      mode: 'car',
      source: 'learned' as const,
      updated_at: 'fixed',
    }));
    const model = buildWeek(
      input(
        [
          meeting('a', '09:00', '10:00', { location: 'Office' }),
          meeting('b', '10:30', '11:00', { location: 'Mission restaurant' }),
          meeting('c', '14:00', '15:00', { location: 'Home' }),
        ],
        { timeline: { ...timeline, pairs } },
      ),
    );
    expect(model.days[0].moves.map((m) => [m.from.id, m.to.id, m.minutes])).toEqual([
      ['sf', 'mv', 40],
      ['mv', 'mission', 50],
      ['mission', 'sf', 15],
    ]);
    expect(
      checkWeek(model)
        .filter((f) => f.kind === 'travel')
        .map((f) => f.facts.available_minutes),
    ).toEqual([null, 30, 180]);
  });
  it.each(['travel'] as const)(
    '%s clears when a linked block covers the measured move; an estimate clears unknown travel',
    (kind) => {
      const dinner = meeting('dinner', '18:30', '19:30', { location: 'Mission restaurant' });
      const office = meeting('office', '16:00', '17:30', { location: 'Office' });
      const away = {
        ...timeline,
        pairs: [
          {
            from_place_id: 'mv',
            to_place_id: 'mission',
            mode: 'car',
            minutes: 50,
            source: 'learned' as const,
            updated_at: 'fixed',
          },
        ],
      };
      expect(kinds([office, dinner], { timeline: away })).toContain(kind);
      const travel = meeting('travel', '17:35', '18:30', {
        tags: { gws_ea_parent_event: 'dinner', gws_ea_block_kind: 'travel' },
      });
      expect(kinds([office, travel, dinner], { timeline: away })).not.toContain(kind);
      expect(kinds([meeting('e', '09:00', '10:00', { location: 'New venue' })])).toContain('travel-unknown');
      expect(
        kinds([meeting('e', '09:00', '10:00', { location: 'New venue' })], {
          timeline: {
            ...timeline,
            travel: [{ event_id: 'e', mode: 'car', minutes: 20, source: 'estimated', updated_at: 'fixed' }],
          },
        }),
      ).not.toContain('travel-unknown');
    },
  );
  it.each(['flight-chain', 'connection'] as const)('%s has a positive and a negative measured case', (kind) => {
    const flight = meeting('flight', '08:15', '11:00', {
      tags: { gws_ea_flight: 'true', gws_ea_connection_minutes: '60', gws_ea_previous_flight: 'previous' },
    });
    const previous = meeting('previous', '04:00', '07:30', { tags: { gws_ea_flight: 'true' } });
    const travel = meeting('travel', '05:45', '06:30', {
      tags: { gws_ea_parent_event: 'flight', gws_ea_block_kind: 'travel' },
    });
    const prep = meeting('prep', '07:00', '07:45', {
      tags: { gws_ea_parent_event: 'flight', gws_ea_block_kind: 'preflight' },
    });
    expect(kinds([flight, previous, travel, prep])).toContain(kind);
    expect(
      kinds([
        { ...flight, event: { ...flight.event, start: { dateTime: at('08:45') } } },
        previous,
        { ...travel, event: { ...travel.event, end: { dateTime: at('07:00') } } },
        prep,
      ]),
    ).not.toContain(kind);
  });
  it.each(['protected-time', 'preference'] as const)(
    '%s has a positive and a negative recorded-window case',
    (kind) => {
      const provenance = { source: 'principal' as const, updated_at: 'fixed' };
      const preferences = {
        ...input().preferences,
        protected_windows: [{ id: 'p', weekdays: ['mon' as const], start: '09:00', end: '10:00', ...provenance }],
        preferred_times: [
          { meeting_kind: 'default', weekdays: ['mon' as const], start: '14:00', end: '16:00', ...provenance },
        ],
      };
      expect(kinds([meeting('e', '09:00', '10:00')], { preferences })).toContain(kind);
      expect(kinds([meeting('e', '14:00', '15:00')], { preferences })).not.toContain(kind);
    },
  );
  it('acknowledges only the measured event version, unaffected by a guest response', () => {
    const original = meeting('e', '11:30', '14:00', {
      attendees: [{ email: 'remy@vance.example', responseStatus: 'needsAction' }],
    });
    const model = buildWeek(input([original]));
    const finding = checkWeek(model).find((f) => f.kind === 'meal')!;
    expect(checkWeek(model, [finding]).map((f) => f.kind)).not.toContain('meal');
    const guestReply = {
      ...original,
      event: {
        ...original.event,
        etag: 'new',
        attendees: [{ email: 'remy@vance.example', responseStatus: 'accepted' }],
      },
    };
    expect(checkWeek(buildWeek(input([guestReply])), [finding]).map((f) => f.kind)).not.toContain('meal');
    const moved = { ...original, event: { ...original.event, end: { dateTime: at('14:15') } } };
    expect(checkWeek(buildWeek(input([moved])), [finding]).map((f) => f.kind)).toContain('meal');
  });
  it('a recorded late lunch window clears the default-window finding', () => {
    const preferences = {
      ...input().preferences,
      meal_windows: [
        {
          meal: 'lunch' as const,
          weekdays: ['mon' as const],
          start: '14:00',
          end: '15:00',
          minutes: 30,
          source: 'principal' as const,
          updated_at: 'fixed',
        },
      ],
    };
    expect(kinds([meeting('e', '11:30', '14:00')], { preferences })).not.toContain('meal');
  });
  it('distinguishes copy disagreement, assistant craft defects and orphaned blocks', () => {
    const original = meeting('e', '09:00', '10:00', { iCalUID: 'same' });
    const copy = { ...original, calendarId: 'copy', event: { ...original.event, location: 'Office' } };
    expect(kinds([original, copy])).toContain('copy-disagreement');
    expect(kinds([original, { ...copy, event: original.event }])).not.toContain('copy-disagreement');
    const allDay = event('task', '', '', { start: { date: '2026-10-05' }, end: { date: '2026-10-06' } });
    expect(kinds([{ ...allDay, assistantWritten: true }])).toContain('all-day-task');
    expect(kinds([allDay])).not.toContain('all-day-task');
    const address = meeting('address', '09:00', '10:00', { summary: 'Pick up at 42 Cedar Lane' });
    expect(kinds([{ ...address, assistantWritten: true }])).toContain('address-in-title');
    expect(kinds([address])).not.toContain('address-in-title');
    const block = meeting('b', '08:00', '09:00', {
      tags: { gws_ea_parent_event: 'e', gws_ea_block_kind: 'travel', gws_ea_parent_start: at('09:00') },
    });
    expect(kinds([block, original])).not.toContain('orphaned-block');
    expect(
      kinds([
        block,
        { ...original, event: { ...original.event, start: { dateTime: at('10:00') }, end: { dateTime: at('11:00') } } },
      ]),
    ).toContain('orphaned-block');
  });
  it('finds home events while away and uses home working hours on a Lagos stay', () => {
    const away = {
      ...timeline,
      stays: [
        {
          ids: ['s'],
          sourceEventIds: [],
          placeId: null,
          locality: 'Lagos',
          zone: 'Africa/Lagos',
          start: Date.parse('2026-10-04T00:00Z'),
          end: Date.parse('2026-10-10T00:00Z'),
          certainty: 'certain' as const,
          workingHours: 'home' as const,
          derived: false,
        },
      ],
    };
    expect(kinds([meeting('school', '09:00', '10:00', { location: 'Home' })], { timeline: away })).toContain(
      'home-while-away',
    );
    expect(
      kinds([meeting('remote', '09:00', '10:00', { location: 'https://meet.google.com/abc' })], { timeline: away }),
    ).not.toContain('working-hours');
    expect(kinds([event('remote', '2026-10-05T09:00+01:00', '2026-10-05T10:00+01:00')], { timeline: away })).toContain(
      'working-hours',
    );
  });
  it('carries due, undated and deferred matters and clears due time with a linked block', () => {
    const matter: Matter = {
      id: 'm-1',
      title: 'Call the tailor',
      open_loop: 'Arrange pickup',
      parent_id: null,
      open: true,
      outcome: null,
      look_task_id: null,
      due_at: '2026-10-09',
      needs_minutes: 15,
      place: null,
      deferrals: 3,
      links: [],
      strands: [],
      created_at: 'fixed',
      updated_at: 'fixed',
      closed_at: null,
    };
    const matters = [{ matter, checkInAt: '2026-10-10T16:00Z' }];
    expect(kinds([], { matters })).toEqual(
      expect.arrayContaining(['matter-unscheduled', 'matter-overdue-check-in', 'matter-deferred']),
    );
    const block = meeting('block', '09:00', '09:15', { tags: { gws_ea_matter_id: 'm-1' } });
    expect(kinds([block], { matters })).not.toContain('matter-unscheduled');
    const undated = { matter: { ...matter, due_at: null, deferrals: 0 }, checkInAt: null };
    expect(buildWeek(input([], { matters: [undated] })).undatedMatters.map((m) => m.id)).toEqual(['m-1']);
    expect(kinds([], { matters: [undated] })).toEqual([]);
  });
  it('mentions a deleted linked block and wraps unknown venue names in findings', () => {
    const e = meeting('e', '09:00', '10:00', { location: 'New venue', tags: { gws_ea_deleted_block: 'travel' } });
    const model = buildWeek(
      input([e], { deletedBlocks: [{ parentEventId: 'e', kind: 'travel', actor: 'principal' }] }),
    );
    const finding = checkWeek(model).find((f) => f.kind === 'travel-unknown')!;
    expect(presentFinding(finding, model)).toContain('Source: google_calendar');
    expect(presentFinding(finding, model)).toContain('principal deleted');
  });
});

it('uses the last recorded weekday place as an evening origin without inventing a commute on Friday', () => {
  const rhythm = [
    { weekday: 'thu' as const, place_id: 'mv', start_minute: 540, end_minute: 1050, updated_at: 'fixed' },
  ];
  const pair = {
    from_place_id: 'mv',
    to_place_id: 'mission',
    mode: 'car',
    minutes: 50,
    source: 'learned' as const,
    updated_at: 'fixed',
  };
  const dinner = event('dinner', '2026-10-08T18:30:00-07:00', '2026-10-08T19:30:00-07:00', {
    location: 'Mission restaurant',
  });
  const model = buildWeek(input([dinner], { timeline: { ...timeline, rhythm, pairs: [pair] } }));
  const move = model.days.find((day) => day.date === '2026-10-08')?.moves[0];
  expect(move).toMatchObject({ from: { id: 'mv' }, to: { id: 'mission' }, minutes: 50, availableMinutes: 60 });
  expect(checkWeek(model).find((f) => f.kind === 'travel')?.message).toContain(
    '50 minutes needed; 60 minutes available',
  );
  const friday = buildWeek(
    input(
      [event('errand', '2026-10-09T15:00:00-07:00', '2026-10-09T16:00:00-07:00', { location: 'Mission restaurant' })],
      { timeline: { ...timeline, rhythm, pairs: [pair] } },
    ),
  );
  expect(friday.days.find((day) => day.date === '2026-10-09')?.moves[0].from.id).toBe('sf');
});

it('keeps known venue-to-venue travel visible while home is unknown', () => {
  const unknown = {
    ...timeline,
    base: { ...timeline.base, home_place_id: null },
    pairs: [
      {
        from_place_id: 'mv',
        to_place_id: 'mission',
        mode: 'car',
        minutes: 50,
        source: 'learned' as const,
        updated_at: 'fixed',
      },
    ],
  };
  const model = buildWeek(
    input(
      [
        meeting('office', '09:00', '10:00', { location: 'Office' }),
        meeting('dinner', '10:30', '11:30', { location: 'Mission restaurant' }),
      ],
      { timeline: unknown },
    ),
  );
  expect(
    checkWeek(model)
      .filter((f) => ['travel', 'travel-unknown', 'whereabouts-gap'].includes(f.kind))
      .map((f) => f.kind),
  ).toEqual(['whereabouts-gap', 'travel']);
});

it('uses deletion evidence without inventing who deleted a linked block', () => {
  const dinner = meeting('dinner', '18:30', '19:30', { location: 'Mission restaurant' });
  for (const actor of ['principal', 'unknown'] as const) {
    const model = buildWeek(input([dinner], { deletedBlocks: [{ parentEventId: 'dinner', kind: 'travel', actor }] }));
    const finding = checkWeek(model).find((f) => f.kind === 'travel-unknown')!;
    expect(presentFinding(finding, model)).toContain(
      actor === 'principal'
        ? 'The principal deleted a linked travel block.'
        : 'Linked travel block deleted; actor unavailable.',
    );
  }
});

it('keeps a meal acknowledgement cleared when unrelated event words change', () => {
  const original = meeting('e', '11:30', '14:00', { summary: 'Work' });
  const finding = checkWeek(buildWeek(input([original]))).find((f) => f.kind === 'meal')!;
  const renamed = { ...original, event: { ...original.event, summary: 'Revised work', description: 'New notes' } };
  expect(checkWeek(buildWeek(input([renamed])), [finding]).some((f) => f.kind === 'meal')).toBe(false);
});

it('reports the calendar days remaining to a date deadline, independently of its end-of-day boundary', () => {
  const matter: Matter = {
    id: 'm-date',
    title: 'Arrange pickup',
    open_loop: 'Call the tailor',
    parent_id: null,
    open: true,
    outcome: null,
    look_task_id: null,
    due_at: '2026-10-09',
    needs_minutes: 15,
    place: null,
    deferrals: 0,
    links: [],
    strands: [],
    created_at: 'fixed',
    updated_at: 'fixed',
    closed_at: null,
  };
  const finding = checkWeek(buildWeek(input([], { matters: [{ matter, checkInAt: null }] }))).find(
    (f) => f.kind === 'matter-unscheduled',
  );
  expect(finding?.facts.days).toBe(4);
});
