import fs from 'node:fs';
import path from 'node:path';
import type { Effect, ScenarioCase } from '../types.js';

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
  readonly start?: { readonly dateTime?: string; readonly date?: string };
  readonly end?: { readonly dateTime?: string; readonly date?: string };
  readonly organizer?: { readonly email?: string };
  readonly attendees?: readonly { readonly email?: string; readonly responseStatus?: string }[];
  readonly etag?: string;
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
  attempt: number;
  effects: Effect[];
  tasks: Record<string, unknown>[];
  outbound: Record<string, unknown>[];
  events: SyntheticEvent[];
  mail: SyntheticMail[];
}
export function initialFixture(scenario: ScenarioCase): FixtureState {
  if (scenario.id !== 'search-before-asking') throw new Error(`No concrete native fixture for ${scenario.id}`);
  const summary = 'Dinner with Juno';
  const location = 'Harbor House, 800 Fiction Lane, San Francisco';
  const text = `${summary} is at ${location}.`;
  return {
    scenario,
    attempt: 1,
    effects: [],
    tasks: [],
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
