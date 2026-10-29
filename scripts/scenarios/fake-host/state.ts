import fs from 'node:fs';
import path from 'node:path';
import type { Effect, ScenarioCase } from '../types.js';
import { concreteFixture } from './datasets.js';

export const SYNTHETIC_IDENTITY = {
  assistantName: { firstName: 'Aster', lastName: null },
  assistantEmail: 'assistant@example.test',
  principalName: { firstName: 'Morgan', lastName: 'Ellery' },
  principalEmail: 'morgan.ellery@example.test',
} as const;

export interface SyntheticEvent {
  readonly calendarId: string;
  readonly id: string;
  readonly summary?: string;
  readonly location?: string;
  readonly description?: string;
  readonly start?: { readonly dateTime?: string; readonly date?: string; readonly timeZone?: string };
  readonly end?: { readonly dateTime?: string; readonly date?: string; readonly timeZone?: string };
  readonly organizer?: { readonly email?: string };
  readonly attendees?: readonly {
    readonly email?: string;
    readonly responseStatus?: string;
    readonly self?: boolean;
  }[];
  readonly etag?: string;
  readonly guestsCanModify?: boolean;
}
export interface SyntheticMail {
  readonly id: string;
  readonly threadId: string;
  readonly snippet?: string;
  readonly internalDate?: string;
  readonly labelIds?: readonly string[];
  readonly payload?: {
    readonly headers?: readonly { readonly name: string; readonly value: string }[];
    readonly mimeType?: string;
    readonly body?: { readonly data?: string };
  };
}
export interface FixtureState {
  readonly scenario: ScenarioCase;
  readonly referenceAt?: string;
  attempt: number;
  effects: Effect[];
  outbound: Record<string, unknown>[];
  events: SyntheticEvent[];
  mail: SyntheticMail[];
  readonly calendars?: readonly {
    readonly id: string;
    readonly summary: string;
    readonly dataOwner?: string;
    readonly accessRole: string;
  }[];
  readonly thread?: {
    readonly key: string;
    readonly namedPeople: readonly string[];
    readonly bookingCalendar?: string;
    readonly brief?: string;
  };
}
export function initialFixture(scenario: ScenarioCase): FixtureState {
  const referenceAt = new Date().toISOString();
  const concrete = concreteFixture(scenario, referenceAt);
  if (concrete) return { scenario, referenceAt, attempt: 1, effects: [], outbound: [], ...concrete };
  if (scenario.id === 'location-field')
    return {
      scenario,
      attempt: 1,
      effects: [],
      outbound: [],
      events: [],
      mail: [
        syntheticMail(
          'synthetic-lunch-agreement',
          'Lunch on November 6',
          'remy.vance@example.test',
          SYNTHETIC_IDENTITY.principalEmail,
          'Morgan and Remy agreed to lunch Friday November 6, 2026 at 12:00 America/Los_Angeles for 60 minutes. Harbor House is at 800 Fiction Lane, San Francisco. Please put the lunch on Morgan’s calendar.',
        ),
      ],
    };
  if (scenario.id === 'move-with-guest')
    return {
      scenario,
      attempt: 1,
      effects: [],
      outbound: [],
      events: [
        {
          calendarId: SYNTHETIC_IDENTITY.principalEmail,
          id: 'synthetic-project-brief',
          summary: 'Project brief with Juno',
          location: 'Morgan calls Juno',
          start: { dateTime: '2026-11-03T10:00:00-08:00' },
          end: { dateTime: '2026-11-03T10:25:00-08:00' },
          organizer: { email: SYNTHETIC_IDENTITY.principalEmail },
          attendees: [
            { email: SYNTHETIC_IDENTITY.principalEmail, responseStatus: 'accepted' },
            { email: 'juno.hale@example.test', responseStatus: 'accepted' },
          ],
        },
      ],
      mail: [
        syntheticMail(
          'synthetic-juno-move-agreement',
          'Move our project brief meeting',
          'juno.hale@example.test',
          SYNTHETIC_IDENTITY.principalEmail,
          'I can move our November 3 project brief meeting to Friday November 6 at 14:00 America/Los_Angeles. Please retain its 25-minute length and send the update to my existing invitation. The phone arrangement stays: Morgan calls Juno.',
        ),
      ],
    };
  if (scenario.id === 'external-email-identity-read' || scenario.id === 'external-chat-identity-read')
    return { scenario, attempt: 1, effects: [], outbound: [], events: [], mail: [] };
  if (scenario.id === 'unknown-pronouns' || scenario.id === 'principal-does-it')
    return { scenario, attempt: 1, effects: [], outbound: [], events: [], mail: [] };
  if (scenario.id === 'trip-zone')
    return {
      scenario,
      attempt: 1,
      effects: [],
      outbound: [],
      mail: [],
      events: [
        {
          calendarId: SYNTHETIC_IDENTITY.principalEmail,
          id: 'synthetic-london-call',
          summary: 'London project call',
          start: { dateTime: '2026-11-03T17:00:00+00:00' },
          end: { dateTime: '2026-11-03T17:30:00+00:00' },
          organizer: { email: SYNTHETIC_IDENTITY.principalEmail },
          attendees: [{ email: SYNTHETIC_IDENTITY.principalEmail, responseStatus: 'accepted' }],
        },
      ],
    };
  if (scenario.id === 'missing-remy') {
    const text =
      'Morgan will call Remy directly on the phone for their November 3 catch-up. Remy does not need a calendar invitation.';
    return {
      scenario,
      attempt: 1,
      effects: [],
      outbound: [],
      events: [
        {
          calendarId: SYNTHETIC_IDENTITY.principalEmail,
          id: 'synthetic-remy-call',
          summary: 'Call with Remy',
          location: 'Morgan will phone Remy directly',
          start: { dateTime: '2026-11-03T17:00:00-08:00' },
          end: { dateTime: '2026-11-03T17:30:00-08:00' },
          organizer: { email: SYNTHETIC_IDENTITY.principalEmail },
          attendees: [{ email: SYNTHETIC_IDENTITY.principalEmail, responseStatus: 'accepted' }],
        },
      ],
      mail: [
        syntheticMail(
          'synthetic-remy-phone-mail',
          'Phone catch-up on November 3',
          'remy.vance@example.test',
          SYNTHETIC_IDENTITY.principalEmail,
          text,
        ),
      ],
    };
  }
  if (scenario.id === 'assistant-missing-invite') {
    const text =
      'Juno invited Morgan to the project check-in on November 3, 14:00–14:25 America/Los_Angeles. Join using the existing phone arrangement: Morgan calls Juno. No private agenda is shared with the assistant.';
    return {
      scenario,
      attempt: 1,
      effects: [],
      outbound: [],
      events: [
        {
          calendarId: SYNTHETIC_IDENTITY.principalEmail,
          id: 'synthetic-juno-invitation',
          summary: 'Project check-in with Juno',
          location: 'Morgan calls Juno',
          start: { dateTime: '2026-11-03T14:00:00-08:00' },
          end: { dateTime: '2026-11-03T14:25:00-08:00' },
          organizer: { email: 'juno.hale@example.test' },
          attendees: [{ email: SYNTHETIC_IDENTITY.principalEmail, responseStatus: 'accepted' }],
        },
      ],
      mail: [
        syntheticMail(
          'synthetic-juno-invitation-mail',
          'Invitation: Project check-in with Juno',
          'juno.hale@example.test',
          SYNTHETIC_IDENTITY.principalEmail,
          text,
        ),
      ],
    };
  }
  if (scenario.id !== 'search-before-asking') throw new Error(`No concrete native fixture for ${scenario.id}`);
  const summary = 'Dinner with Juno';
  const location = 'Harbor House, 800 Fiction Lane, San Francisco';
  const text = `${summary} is at ${location}.`;
  return {
    scenario,
    attempt: 1,
    effects: [],
    outbound: [],
    events: [
      {
        calendarId: 'morgan.ellery@example.test',
        id: 'synthetic-event-1',
        summary,
        location,
        start: { dateTime: '2026-11-03T19:00:00-08:00' },
        end: { dateTime: '2026-11-03T21:00:00-08:00' },
        organizer: {
          email: SYNTHETIC_IDENTITY.principalEmail,
        },
        attendees: [
          { email: 'morgan.ellery@example.test', responseStatus: 'accepted' },
          { email: 'juno.hale@example.test', responseStatus: 'accepted' },
        ],
      },
    ],
    mail: [
      {
        id: 'synthetic-mail-1',
        threadId: 'synthetic-thread-1',
        snippet: text,
        internalDate: String(Date.parse('2026-11-01T12:00:00Z')),
        labelIds: ['INBOX'],
        payload: {
          mimeType: 'text/plain',
          headers: [
            { name: 'From', value: 'juno.hale@example.test' },
            { name: 'To', value: 'morgan.ellery@example.test' },
            { name: 'Subject', value: summary },
            { name: 'Date', value: 'Sun, 1 Nov 2026 12:00:00 +0000' },
          ],
          body: { data: Buffer.from(text).toString('base64url') },
        },
      },
    ],
  };
}
export function syntheticMail(id: string, subject: string, from: string, to: string, text: string): SyntheticMail {
  return {
    id,
    threadId: `${id}-thread`,
    snippet: text,
    internalDate: String(Date.parse('2026-11-01T12:00:00Z')),
    labelIds: ['INBOX'],
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: from },
        { name: 'To', value: to },
        { name: 'Subject', value: subject },
        { name: 'Date', value: 'Sun, 1 Nov 2026 12:00:00 +0000' },
        { name: 'Message-ID', value: `<${id}@example.test>` },
      ],
      body: { data: Buffer.from(text).toString('base64url') },
    },
  };
}
export function readState(file: string): FixtureState {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as FixtureState;
}
export function writeState(file: string, state: FixtureState): void {
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}
export async function callHost(
  file: string,
  method: string,
  args: Readonly<Record<string, unknown>> = {},
): Promise<unknown> {
  const endpoint = JSON.parse(fs.readFileSync(path.join(path.dirname(file), 'host-endpoint.json'), 'utf8')) as {
    url: string;
  };
  const response = await fetch(endpoint.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, args }),
  });
  const frame = (await response.json()) as { ok: boolean; value?: unknown; error?: string };
  if (!frame.ok) throw new Error(frame.error ?? 'Native synthetic host failed');
  return frame.value;
}
export async function recordEffect(file: string, effect: Omit<Effect, 'attempt'>): Promise<void> {
  await callHost(file, 'effect', effect);
}
