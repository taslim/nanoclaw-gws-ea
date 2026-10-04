/**
 * The host's Calendar client: each call is one request with the token in
 * its header, asks for no event text back, and reads Google's answers the
 * way the calendar actions rely on (a duplicate id, a deleted event, a
 * calendar whose free/busy is hidden).
 */
import { describe, expect, it } from 'vitest';

import { allowsMeet, createMeetingsCalendarApi } from './calendar-api.js';

interface Recorded {
  readonly method: string;
  readonly url: URL;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

function stubGoogle(reply: (request: Recorded) => { status: number; body?: unknown }) {
  const requests: Recorded[] = [];
  const fetch = (async (input: string | URL, init?: RequestInit) => {
    const request: Recorded = {
      method: init?.method ?? 'GET',
      url: new URL(String(input)),
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    requests.push(request);
    const { status, body } = reply(request);
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  }) as typeof globalThis.fetch;
  const api = createMeetingsCalendarApi({ token: async () => 'host-token', fetch });
  return { api, requests };
}

const WRITE = {
  summary: 'Partnership intro',
  description: 'We will walk through the pilot plan.',
  start: '2026-10-07T09:00:00.000Z',
  end: '2026-10-07T09:30:00.000Z',
  timeZone: 'Europe/London',
  attendees: ['sam@acme.example'],
  tags: { gwsEaMeeting: 'mtg-1', gwsEaRole: 'booking' },
  reminders: 'default' as const,
};

describe('the Calendar client', () => {
  it('creates an event with its own id, its tags, and the invitations asked for, asking for nothing back but the id', async () => {
    const { api, requests } = stubGoogle(() => ({ status: 200, body: { id: 'abc123' } }));
    expect(await api.insertEvent('pat@principal.example', 'abc123', WRITE, 'all')).toBe('created');
    const [request] = requests;
    expect(request.method).toBe('POST');
    expect(request.url.pathname).toBe('/calendar/v3/calendars/pat%40principal.example/events');
    expect(request.url.searchParams.get('sendUpdates')).toBe('all');
    expect(request.url.searchParams.get('fields')).toBe('id');
    expect(request.headers.authorization).toBe('Bearer host-token');
    expect(request.body).toEqual({
      id: 'abc123',
      summary: 'Partnership intro',
      description: 'We will walk through the pilot plan.',
      start: { dateTime: '2026-10-07T09:00:00.000Z', timeZone: 'Europe/London' },
      end: { dateTime: '2026-10-07T09:30:00.000Z', timeZone: 'Europe/London' },
      attendees: [{ email: 'sam@acme.example' }],
      reminders: { useDefault: true },
      extendedProperties: { private: { gwsEaMeeting: 'mtg-1', gwsEaRole: 'booking' } },
    });
  });

  it('asks Google for a Meet link under its request id, with conference support, and writes a place as given', async () => {
    const { api, requests } = stubGoogle(() => ({ status: 200, body: { id: 'abc123' } }));
    await api.insertEvent(
      'pat@principal.example',
      'abc123',
      { ...WRITE, location: 'Acme HQ, 1 Main Street', conference: { requestId: 'meet-mtg-1' } },
      'all',
    );
    await api.patchEvent('pat@principal.example', 'abc123', { location: 'Their office' }, 'all');
    const [insert, patch] = requests;
    expect(insert.url.searchParams.get('conferenceDataVersion')).toBe('1');
    expect(insert.body).toMatchObject({
      location: 'Acme HQ, 1 Main Street',
      conferenceData: { createRequest: { requestId: 'meet-mtg-1', conferenceSolutionKey: { type: 'hangoutsMeet' } } },
    });
    // A write that asks for no link leaves the event's conference as it is.
    expect(patch.url.searchParams.has('conferenceDataVersion')).toBe(false);
    expect(patch.body).toEqual({ location: 'Their office' });
  });

  it("reads an event's Meet link as Google reports it, and a calendar's allowed conference types", async () => {
    const { api, requests } = stubGoogle((request) =>
      request.url.pathname.includes('/calendarList/')
        ? {
            status: 200,
            body: {
              id: 'pat@principal.example',
              accessRole: 'owner',
              conferenceProperties: { allowedConferenceSolutionTypes: ['hangoutsMeet'] },
            },
          }
        : {
            status: 200,
            body: {
              id: request.url.pathname.endsWith('/pending') ? 'pending' : 'ready',
              conferenceData: request.url.pathname.endsWith('/pending')
                ? { createRequest: { status: { statusCode: 'pending' } } }
                : {
                    createRequest: { status: { statusCode: 'success' } },
                    entryPoints: [
                      { entryPointType: 'phone', uri: 'tel:+44-20-0000-0000' },
                      { entryPointType: 'video', uri: 'https://meet.google.com/abc-defg-hij' },
                    ],
                  },
            },
          },
    );
    expect((await api.getEvent('pat@principal.example', 'ready'))?.conference).toEqual({
      status: 'success',
      uri: 'https://meet.google.com/abc-defg-hij',
    });
    expect((await api.getEvent('pat@principal.example', 'pending'))?.conference).toEqual({ status: 'pending' });
    // Google returns only the fields asked for: the link and its status among them.
    expect(requests[0].url.searchParams.get('fields')).toContain(
      'conferenceData(createRequest(status(statusCode)),entryPoints(entryPointType,uri))',
    );
    const entry = await api.getCalendar('pat@principal.example');
    expect(entry && allowsMeet(entry)).toBe(true);
    expect(allowsMeet({ id: 'family@group.calendar.google.com' })).toBe(false);
  });

  it('reads an id Google already holds as an event that exists', async () => {
    const { api } = stubGoogle(() => ({
      status: 409,
      body: { error: { message: 'The requested identifier already exists.' } },
    }));
    expect(await api.insertEvent('pat@principal.example', 'abc123', WRITE, 'none')).toBe('exists');
  });

  it('marks a hold private, busy and silent', async () => {
    const { api, requests } = stubGoogle(() => ({ status: 200, body: { id: 'h1' } }));
    await api.insertEvent(
      'pat@principal.example',
      'h1',
      { ...WRITE, attendees: [], visibility: 'private', transparency: 'opaque', reminders: 'none' },
      'none',
    );
    expect(requests[0].body).toMatchObject({
      visibility: 'private',
      transparency: 'opaque',
      reminders: { useDefault: false, overrides: [] },
      attendees: [],
    });
  });

  it('moves an event with a patch of its times alone', async () => {
    const { api, requests } = stubGoogle(() => ({ status: 200, body: { id: 'evt-1' } }));
    await api.patchEvent(
      'pat@principal.example',
      'evt-1',
      { start: '2026-10-08T14:00:00.000Z', end: '2026-10-08T15:00:00.000Z' },
      'all',
    );
    expect(requests[0].method).toBe('PATCH');
    expect(requests[0].url.pathname).toBe('/calendar/v3/calendars/pat%40principal.example/events/evt-1');
    expect(requests[0].url.searchParams.get('sendUpdates')).toBe('all');
    expect(requests[0].body).toEqual({
      start: { dateTime: '2026-10-08T14:00:00.000Z' },
      end: { dateTime: '2026-10-08T15:00:00.000Z' },
    });
  });

  it('deletes an event, and reads one already gone as gone', async () => {
    const statuses = [204, 404, 410];
    const { api, requests } = stubGoogle(() => {
      const status = statuses.shift() ?? 500;
      return status === 204 ? { status } : { status, body: { error: { message: 'gone' } } };
    });
    expect(await api.deleteEvent('pat@principal.example', 'h1', 'none')).toBe('deleted');
    expect(await api.deleteEvent('pat@principal.example', 'h1', 'none')).toBe('gone');
    expect(await api.deleteEvent('pat@principal.example', 'h1', 'all')).toBe('gone');
    expect(requests.map((r) => [r.method, r.url.searchParams.get('sendUpdates')])).toEqual([
      ['DELETE', 'none'],
      ['DELETE', 'none'],
      ['DELETE', 'all'],
    ]);
  });

  it('reads free/busy per calendar, and a calendar Google hides as not visible', async () => {
    const { api, requests } = stubGoogle(() => ({
      status: 200,
      body: {
        calendars: {
          'kim@principal.example': { busy: [{ start: '2026-10-07T09:00:00Z', end: '2026-10-07T10:00:00Z' }] },
          'lee@principal.example': { busy: [], errors: [{ domain: 'global', reason: 'notFound' }] },
        },
      },
    }));
    const result = await api.freeBusy(
      ['Kim@principal.example', 'lee@principal.example', 'max@principal.example'],
      '2026-10-05T00:00:00.000Z',
      '2026-10-10T00:00:00.000Z',
    );
    expect(requests[0].method).toBe('POST');
    expect(requests[0].url.pathname).toBe('/calendar/v3/freeBusy');
    expect(requests[0].body).toEqual({
      timeMin: '2026-10-05T00:00:00.000Z',
      timeMax: '2026-10-10T00:00:00.000Z',
      items: [{ id: 'Kim@principal.example' }, { id: 'lee@principal.example' }, { id: 'max@principal.example' }],
    });
    expect(result.get('kim@principal.example')).toEqual({
      visible: true,
      busy: [{ start: '2026-10-07T09:00:00Z', end: '2026-10-07T10:00:00Z' }],
    });
    expect(result.get('lee@principal.example')).toEqual({ visible: false, busy: [] });
    expect(result.get('max@principal.example')).toEqual({ visible: false, busy: [] });
  });

  it('lists a busy block a free/busy-only calendar gives without an id, so it still counts', async () => {
    const { api } = stubGoogle(() => ({
      status: 200,
      body: {
        items: [
          {
            status: 'confirmed',
            start: { dateTime: '2026-10-07T09:00:00Z' },
            end: { dateTime: '2026-10-07T10:00:00Z' },
          },
        ],
      },
    }));
    expect(await api.listEvents('kim@principal.example', '2026-10-07T00:00:00Z', '2026-10-08T00:00:00Z')).toEqual([
      { status: 'confirmed', start: { dateTime: '2026-10-07T09:00:00Z' }, end: { dateTime: '2026-10-07T10:00:00Z' } },
    ]);
  });

  it("reads an event's own tags, but never its title, description or location", async () => {
    const { api, requests } = stubGoogle(() => ({
      status: 200,
      body: {
        id: 'h1',
        status: 'confirmed',
        start: { dateTime: '2026-10-07T09:00:00Z' },
        end: { dateTime: '2026-10-07T09:30:00Z' },
        extendedProperties: { private: { gwsEaMeeting: 'mtg-1', gwsEaRole: 'hold' } },
      },
    }));
    const event = await api.getEvent('pat@principal.example', 'h1');
    expect(event?.tags).toEqual({ gwsEaMeeting: 'mtg-1', gwsEaRole: 'hold' });
    const fields = requests[0].url.searchParams.get('fields') ?? '';
    expect(fields).toContain('extendedProperties');
    for (const hidden of ['summary', 'description', 'location']) expect(fields).not.toContain(hidden);
  });
});
