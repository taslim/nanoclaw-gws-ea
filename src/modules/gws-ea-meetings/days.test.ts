import { describe, expect, it } from 'vitest';
import type { Matter } from '../gws-ea-matters/db.js';
import { checkWeek } from './week/checker.js';
import { buildWeek } from './week/model.js';
import { renderWeekView } from './week/view.js';
import { event, input, timeline } from './week/testing/fixture.js';
import { renderDays, affectedPeople, boundedCalendarMessage } from './days.js';

describe('calendar answers', () => {
  it('shows days on the local clock, inclusive all-day ends, creators and every attendee response in framed text', () => {
    const week = buildWeek(
      input(
        [
          event('call', '2026-10-05T13:00:00-04:00', '2026-10-05T13:30:00-04:00', {
            summary: 'Call with Remy',
            creator: { email: 'juno@ellery.example', displayName: 'Juno Hale' },
            attendees: [
              { email: 'remy@ellery.example', responseStatus: 'tentative' },
              { email: 'juno@ellery.example', self: true, responseStatus: 'accepted' },
            ],
          }),
          {
            calendarId: 'morgan@ellery.example',
            owner: 'principal',
            event: { id: 'trip', summary: 'Trip', start: { date: '2026-10-05' }, end: { date: '2026-10-08' } },
          },
        ],
        {
          timeline: {
            ...timeline,
            stays: [
              {
                ids: ['ny'],
                sourceEventIds: [],
                placeId: null,
                locality: 'New York',
                zone: 'America/New_York',
                start: Date.parse('2026-10-04T00:00:00Z'),
                end: Date.parse('2026-10-10T00:00:00Z'),
                certainty: 'certain',
                workingHours: 'local',
                derived: false,
              },
            ],
          },
        },
      ),
    );
    const text = renderDays(week);
    expect(text).toContain('13:00');
    expect(text).toContain('America/New_York');
    expect(text).toContain('2026-10-05 to 2026-10-07, all day');
    expect(text).toMatch(/Source: google_calendar\n---\nJuno Hale/);
    expect(text).toContain('tentative');
    expect(text).toContain('accepted');
    expect(text).toContain('<<<EXTERNAL_UNTRUSTED_CONTENT');
  });
  it('reports people named without an invitation and distinguishes a principal-created event', () => {
    const week = buildWeek(
      input(
        [
          event('call', '2026-10-05T09:00:00-07:00', '2026-10-05T09:30:00-07:00', {
            summary: 'Call with Remy',
            creator: { email: 'morgan@ellery.example' },
            organizer: { email: 'morgan@ellery.example' },
          }),
        ],
        {
          people: [
            {
              id: 'p-remy',
              name: 'Remy Vance',
              level: 'known',
              identities: ['email:remy@ellery.example', 'name:Remy'],
            },
          ],
        },
      ),
    );
    const text = affectedPeople(week.events[0], week);
    expect(text).toMatch(
      /Names <<<EXTERNAL[^\n]*\nSource: google_calendar\n---\nRemy Vance\n<<<END[^\n]*; not on the invite of an event the principal created;/u,
    );
    expect(text).toContain('organizes');
  });
  it('heads the answer only after counting matter people, and states a matter link as a fact', () => {
    const solo = event('pickup', '2026-10-05T09:00:00-07:00', '2026-10-05T09:30:00-07:00', { summary: 'Pickup' });
    const matter = (links: Matter['links']): Matter => ({
      id: 'm-1',
      title: 'Kitchen renovation',
      open_loop: 'Confirm the cabinet order',
      parent_id: null,
      open: true,
      outcome: null,
      look_task_id: null,
      due_at: '2026-10-05',
      needs_minutes: null,
      place: null,
      deferrals: 0,
      links,
      strands: [],
      created_at: 'fixed',
      updated_at: 'fixed',
      closed_at: null,
    });
    const juno = { id: 'p-juno', name: 'Juno Hale', level: 'active' as const, identities: ['email:juno@hale.example'] };
    const eventLink = {
      kind: 'event' as const,
      reference: 'morgan@ellery.example/pickup',
      handler: null,
      linked_at: 'fixed',
    };
    const withJuno = buildWeek(
      input([solo], {
        people: [juno],
        matters: [
          {
            matter: matter([eventLink, { kind: 'person', reference: 'p-juno', handler: null, linked_at: 'fixed' }]),
            checkInAt: null,
          },
        ],
      }),
    );
    const text = affectedPeople(withJuno.events[0], withJuno);
    expect(text).toMatch(/^People this affects:/u);
    expect(text).toMatch(/Juno Hale\n<<<END[^\n]*: linked to matter Kitchen renovation; people record: yes/u);
    const alone = buildWeek(input([solo], { matters: [{ matter: matter([eventLink]), checkInAt: null }] }));
    const quiet = affectedPeople(alone.events[0], alone);
    expect(quiet).toMatch(/^No one else is affected/u);
    expect(quiet).toContain('Linked to matter Kitchen renovation.');
  });
  it('raises attendance-missing for guests only, not for people the title names', () => {
    const remy = {
      id: 'p-remy',
      name: 'Remy Vance',
      level: 'known' as const,
      identities: ['email:remy@vance.example'],
    };
    const named = event('call', '2026-10-05T09:00:00-07:00', '2026-10-05T09:30:00-07:00', {
      summary: 'Call Remy Vance',
    });
    const invited = {
      ...named,
      event: { ...named.event, summary: 'Call', attendees: [{ email: 'remy@vance.example' }] },
    };
    expect(checkWeek(buildWeek(input([named], { people: [remy] }))).map((f) => f.kind)).not.toContain(
      'attendance-missing',
    );
    expect(checkWeek(buildWeek(input([invited], { people: [remy] }))).map((f) => f.kind)).toContain(
      'attendance-missing',
    );
  });
  it('shows a red-eye already in the air at the range start once, on the first day', () => {
    const week = buildWeek(
      input(
        [
          event('redeye', '2026-10-04T22:00:00-07:00', '2026-10-05T06:00:00-07:00', { summary: 'Red-eye to Boston' }),
          event('call', '2026-10-05T09:00:00-07:00', '2026-10-05T09:30:00-07:00', { summary: 'Call' }),
        ],
        { now: Date.parse('2026-10-05T00:00:00-07:00'), dayCount: 2 },
      ),
    );
    const text = renderDays(week);
    expect(text).toMatch(/^2 events across 2 local days\./u);
    expect(text.match(/Red-eye to Boston/gu)).toHaveLength(1);
    expect(text.indexOf('Red-eye to Boston')).toBeLessThan(text.indexOf('Call'));
    const view = renderWeekView(week, '2026-10-05T07:00:00.000Z', []);
    const events = (day: number) => view.days[day].entries.filter((entry) => entry.id.startsWith('event:'));
    expect(events(0).map((entry) => entry.id)).toEqual([
      'event:morgan@ellery.example/redeye',
      'event:morgan@ellery.example/call',
    ]);
    expect(events(1)).toEqual([]);
  });
  it('names each copy of an event on another principal calendar', () => {
    const meeting = event('review', '2026-10-05T16:00:00Z', '2026-10-05T17:00:00Z', { iCalUID: 'review-uid' });
    const team = { ...meeting, calendarId: 'team@ellery.example', event: { ...meeting.event, id: 'review-copy' } };
    const text = renderDays(buildWeek(input([meeting, team])));
    expect(text).toMatch(/^1 events across/u);
    expect(text).toContain(
      'event review on calendar morgan@ellery.example\nCopy: event review-copy on calendar team@ellery.example',
    );
  });
  it('bounds complete framed entries and says how many remain', () => {
    const text = boundedCalendarMessage(
      'Calendar',
      Array.from({ length: 300 }, (_, n) => `${n} ${'x'.repeat(200)}`),
    );
    expect(text.length).toBeLessThanOrEqual(12000);
    expect(text).toMatch(/\d+ more\.$/);
  });
});
