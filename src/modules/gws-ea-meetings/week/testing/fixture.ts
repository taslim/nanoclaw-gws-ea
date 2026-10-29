import { principalRecognizer } from '../../../gws-ea-profile/db.js';
import type { Timeline } from '../../../gws-ea-whereabouts/timeline.js';
import type { DetailedEvent } from '../../calendar-api.js';
import type { WeekInput, EventCopy } from '../model.js';

const stamp = '2026-10-01T00:00:00.000Z';
export const principal = principalRecognizer(['morgan@ellery.example']);
export const timeline: Timeline = {
  version: 'fixed',
  homeZone: 'America/Los_Angeles',
  base: { home_place_id: 'sf', trip_source: 'none', rhythm_known: 1, updated_at: stamp },
  places: [
    {
      id: 'sf',
      label: 'Home',
      locality: 'San Francisco',
      zone: 'America/Los_Angeles',
      private_value_id: 'home-address',
      updated_at: stamp,
    },
    {
      id: 'mv',
      label: 'Office',
      locality: 'Mountain View',
      zone: 'America/Los_Angeles',
      private_value_id: null,
      updated_at: stamp,
    },
    {
      id: 'mission',
      label: 'Mission restaurant',
      locality: 'San Francisco',
      zone: 'America/Los_Angeles',
      private_value_id: null,
      updated_at: stamp,
    },
  ],
  rhythm: [],
  pairs: [],
  travel: [],
  stays: [],
  legs: [],
  dismissedEvents: [],
};
export function event(id: string, start: string, end: string, detail: Partial<DetailedEvent> = {}): EventCopy {
  return {
    calendarId: 'morgan@ellery.example',
    owner: 'principal',
    event: { id, summary: id, start: { dateTime: start }, end: { dateTime: end }, ...detail },
  };
}
export function input(events: readonly EventCopy[] = [], overrides: Partial<WeekInput> = {}): WeekInput {
  return {
    now: Date.parse('2026-10-05T07:00:00Z'),
    timeline,
    principal,
    principalNames: ['Morgan', 'Morgan Ellery'],
    events,
    preferences: {
      working_hours: [],
      protected_windows: [],
      meeting_lengths: [],
      buffers: [],
      preferred_times: [],
      meal_windows: [],
      back_to_back: [],
      ignored_events: [],
    },
    matters: [],
    people: [],
    ...overrides,
  };
}
