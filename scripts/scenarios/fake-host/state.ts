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
  readonly referenceAt: string;
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
  return { scenario, referenceAt, attempt: 1, effects: [], outbound: [], ...concreteFixture(scenario, referenceAt) };
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
