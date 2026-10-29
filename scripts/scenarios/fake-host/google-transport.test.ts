import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createMeetingsCalendarApi } from '../../../src/modules/gws-ea-meetings/calendar-api.js';
import { createGmailApi, GoogleApiError } from '../../../src/modules/gws-ea-inbox/gmail-api.js';
import { installSyntheticGoogle } from './native.js';
import { SYNTHETIC_IDENTITY } from './state.js';
import { readState, writeState } from './state.js';
import { selectCases } from '../cases/index.js';
import { mechanicalScore } from '../score.js';

const principal = SYNTHETIC_IDENTITY.principalEmail;
const originalFetch = globalThis.fetch;
const originalGrant = process.env.GWS_EA_GOOGLE_GRANT_FILE;
let root: string;
let store: Awaited<ReturnType<typeof installSyntheticGoogle>>;
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-google-transport-'));
  fs.writeFileSync(path.join(root, 'fixture.json'), JSON.stringify({ events: [], mail: [] }));
  store = await installSyntheticGoogle(root);
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalGrant === undefined) delete process.env.GWS_EA_GOOGLE_GRANT_FILE;
  else process.env.GWS_EA_GOOGLE_GRANT_FILE = originalGrant;
  fs.rmSync(root, { recursive: true, force: true });
});

it('returns pending and failed Meet status without claiming a usable link', async () => {
  const api = createMeetingsCalendarApi({ token });
  for (const status of ['pending', 'failure'] as const) {
    store.calendar.meetCreation = status;
    await api.insertEvent(
      principal,
      `meet${status}`,
      {
        summary: 'Project brief',
        start: '2026-11-03T17:00:00Z',
        end: '2026-11-03T17:25:00Z',
        conference: { requestId: `request${status}` },
      },
      'all',
    );
    expect((await api.getEvent(principal, `meet${status}`))?.conference).toEqual({ status });
    expect((await api.getEventDetail(principal, `meet${status}`))?.conference?.entryPoints).toEqual([]);
  }
});
const token = async (): Promise<string> => 'synthetic-only';

it('round-trips native Calendar writes, versions, retry IDs, guests, Meet and cancellation in one store', async () => {
  const api = createMeetingsCalendarApi({ token });
  const event = {
    summary: 'Project brief with Juno',
    start: '2026-11-03T17:00:00Z',
    end: '2026-11-03T17:25:00Z',
    location: 'Harbor House, 800 Fiction Lane, San Francisco',
    attendees: [{ email: principal, responseStatus: 'accepted' }, { email: 'juno.hale@example.test' }],
    conference: { requestId: 'syntheticmeet001' },
    tags: { synthetic: 'transport-proof' },
  };
  expect(await api.insertEvent(principal, 'transport001', event, 'all')).toBe('created');
  expect(await api.insertEvent(principal, 'transport001', event, 'all')).toBe('exists');
  const first = await api.getEventDetail(principal, 'transport001');
  expect(first).toMatchObject({
    id: 'transport001',
    summary: event.summary,
    location: event.location,
    iCalUID: 'transport001@google.com',
    tags: event.tags,
    conference: { status: 'success', uri: 'https://meet.google.com/syntheticm' },
  });
  expect(first?.etag).toBeTruthy();
  expect(first?.attendees).toContainEqual({ email: 'juno.hale@example.test', responseStatus: 'needsAction' });
  await api.patchEvent(principal, 'transport001', { location: 'Juno’s office' }, 'all', first?.etag);
  const changed = await api.getEventDetail(principal, 'transport001');
  expect(changed?.location).toBe('Juno’s office');
  expect(changed?.etag).not.toBe(first?.etag);
  await expect(
    api.patchEvent(principal, 'transport001', { location: 'Stale overwrite' }, 'all', first?.etag),
  ).rejects.toMatchObject({ status: 412 });
  expect((await api.getEventDetail(principal, 'transport001'))?.location).toBe('Juno’s office');
  expect(
    await api.setGuests(
      principal,
      'transport001',
      [{ email: principal, responseStatus: 'accepted' }],
      'all',
      first?.etag,
    ),
  ).toBe('changed');
  expect(await api.deleteEvent(principal, 'transport001', 'all', changed?.etag)).toBe('deleted');
  expect((await api.getEvent(principal, 'transport001'))?.status).toBe('cancelled');
  expect(await api.deleteEvent(principal, 'transport001', 'all')).toBe('gone');
  expect(store.calendar.events).toHaveLength(1);
  expect(store.calendar.writes.map((write) => write.op)).toEqual(['insert', 'patch', 'delete']);
});

it('stores real Gmail send wire data with recipients, reply threading and reconciliation reads', async () => {
  const gmail = createGmailApi({ token });
  const firstRaw = [
    'From: Aster <assistant@example.test>',
    'To: juno.hale@example.test',
    'Cc: remy.vance@example.test',
    'Subject: Project brief',
    'Message-ID: <transport-first@example.test>',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Tuesday at 9am works.',
  ].join('\r\n');
  const first = await gmail.send({ raw: Buffer.from(firstRaw).toString('base64url') });
  const second = await gmail.send({
    threadId: first.threadId,
    raw: Buffer.from(
      firstRaw
        .replace('transport-first', 'transport-second')
        .replace(
          '\r\nContent-Type:',
          '\r\nIn-Reply-To: <transport-first@example.test>\r\nReferences: <transport-first@example.test>\r\nContent-Type:',
        ),
    ).toString('base64url'),
  });
  expect(second.id).not.toBe(first.id);
  expect(second.threadId).toBe(first.threadId);
  const copy = await gmail.getMessage(second.id);
  expect(copy?.labelIds).toContain('SENT');
  expect(copy?.payload?.headers).toContainEqual({ name: 'To', value: 'juno.hale@example.test' });
  expect(copy?.payload?.headers).toContainEqual({ name: 'Cc', value: 'remy.vance@example.test' });
  expect(copy?.payload?.headers).toContainEqual({ name: 'In-Reply-To', value: '<transport-first@example.test>' });
  expect(Buffer.from(copy?.payload?.body?.data ?? '', 'base64url').toString('utf8')).toBe('Tuesday at 9am works.');
  expect((await gmail.getThread(first.threadId))?.map((message) => message.id)).toEqual([first.id, second.id]);
  expect(await gmail.listMessages({ q: 'rfc822msgid:transport-second@example.test', maxResults: 5 })).toEqual([
    expect.objectContaining({ id: second.id, threadId: first.threadId }),
  ]);
  expect(await gmail.listMessages({ q: 'rfc822msgid:absent@example.test', maxResults: 5 })).toEqual([]);
  expect(store.mail).toHaveLength(2);
  await expect(
    gmail.send({ raw: Buffer.from(firstRaw).toString('base64url'), threadId: 'missing-thread' }),
  ).rejects.toBeInstanceOf(GoogleApiError);
});

it('lets the existing retry scorer detect duplicate native event creation with different Google IDs', async () => {
  const scenario = { ...selectCases(['location-field'])[0]!, retry: true };
  const file = path.join(root, 'fixture.json');
  writeState(file, { scenario, attempt: 1, events: [], mail: [], outbound: [], effects: [] });
  const api = createMeetingsCalendarApi({ token });
  const fields = { summary: 'Project brief with Juno', start: '2026-11-03T17:00:00Z', end: '2026-11-03T17:25:00Z' };
  await api.insertEvent(principal, 'duplicate001', { ...fields, conference: { requestId: 'meetrequest001' } }, 'all');
  const state = readState(file);
  state.attempt = 2;
  writeState(file, state);
  await api.insertEvent(principal, 'duplicate002', { ...fields, conference: { requestId: 'meetrequest002' } }, 'all');
  expect(store.calendar.events).toHaveLength(2);
  expect(mechanicalScore(scenario, readState(file).effects).violations).toContain(
    `duplicate event across retry: ${principal}`,
  );
});
