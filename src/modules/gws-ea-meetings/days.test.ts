import { describe, expect, it } from 'vitest';
import { buildWeek } from './week/model.js';
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
    expect(text).toContain('named but not on the invite');
    expect(text).toContain('principal created');
    expect(text).toContain('organizes');
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
