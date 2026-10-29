/**
 * The host's Calendar client: each call is one request with the token in
 * its header, asks for no event text back, and reads Google's answers the
 * way the scheduling tools rely on (a duplicate id, a deleted event, a busy
 * block listed without an id).
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
  attendees: [{ email: 'pat@principal.example', responseStatus: 'accepted' as const }, { email: 'sam@acme.example' }],
  tags: { gwsEaThread: 'mail-1', gwsEaRole: 'booking' },
  reminders: 'default' as const,
};

describe('the Calendar client', () => {
  it('reads every page of locations on the host without requesting or retaining titles, descriptions or names', async () => {
    const { api, requests } = stubGoogle((request) => ({
      status: 200,
      body: {
        items: [
          {
            id: request.url.searchParams.has('pageToken') ? 'second' : 'first',
            location: 'Remy’s office',
            summary: 'Private title',
            description: 'Private notes',
            attendees: [{ email: 'juno.hale@outside.example', displayName: 'Private record name' }],
            start: { dateTime: '2026-11-12T18:00:00Z' },
            end: { dateTime: '2026-11-12T19:00:00Z' },
          },
        ],
        ...(request.url.searchParams.has('pageToken') ? {} : { nextPageToken: 'next' }),
      },
    }));
    const listed = await api.listLocatedEvents(
      'morgan@principal.example',
      '2026-11-12T00:00:00Z',
      '2026-11-13T00:00:00Z',
    );
    expect(listed.map((event) => ({ id: event.id, location: event.location }))).toEqual([
      { id: 'first', location: 'Remy’s office' },
      { id: 'second', location: 'Remy’s office' },
    ]);
    expect(JSON.stringify(listed)).not.toMatch(/Private title|Private notes|Private record name/u);
    for (const request of requests) {
      const fields = request.url.searchParams.get('fields');
      expect(fields).toContain('location');
      expect(fields).not.toMatch(/summary|description|displayName/u);
    }
  });

  it('creates an event with its own id, its tags, and its guests with the answers given, asking for nothing back but the id', async () => {
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
      attendees: [{ email: 'pat@principal.example', responseStatus: 'accepted' }, { email: 'sam@acme.example' }],
      reminders: { useDefault: true },
      extendedProperties: { private: { gwsEaThread: 'mail-1', gwsEaRole: 'booking' } },
    });
  });

  it('asks Google for a Meet link under its request id, with conference support, and writes a place as given', async () => {
    const { api, requests } = stubGoogle(() => ({ status: 200, body: { id: 'abc123' } }));
    await api.insertEvent(
      'pat@principal.example',
      'abc123',
      { ...WRITE, location: 'Acme HQ, 1 Main Street', conference: { requestId: 'meet-mail-1' } },
      'all',
    );
    await api.patchEvent('pat@principal.example', 'abc123', { location: 'Their office' }, 'all');
    const [insert, patch] = requests;
    expect(insert.url.searchParams.get('conferenceDataVersion')).toBe('1');
    expect(insert.body).toMatchObject({
      location: 'Acme HQ, 1 Main Street',
      conferenceData: { createRequest: { requestId: 'meet-mail-1', conferenceSolutionKey: { type: 'hangoutsMeet' } } },
    });
    // A write that asks for no link leaves the event's conference as it is.
    expect(patch.url.searchParams.has('conferenceDataVersion')).toBe(false);
    expect(patch.body).toEqual({ location: 'Their office' });
  });

  it("reads an event's Meet link as Google reports it, and a calendar's name and allowed conference types", async () => {
    const { api, requests } = stubGoogle((request) =>
      request.url.pathname.includes('/calendarList/')
        ? {
            status: 200,
            body: {
              id: 'pat@principal.example',
              accessRole: 'owner',
              summary: 'Pat – family',
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
    // The privacy check reads the name invitees see on the invitation.
    expect(entry?.summary).toBe('Pat – family');
    expect(allowsMeet({ id: 'family@group.calendar.google.com' })).toBe(false);
  });

  it('reads an id Google already holds as an event that exists', async () => {
    const { api } = stubGoogle(() => ({
      status: 409,
      body: { error: { message: 'The requested identifier already exists.' } },
    }));
    expect(await api.insertEvent('pat@principal.example', 'abc123', WRITE, 'none')).toBe('exists');
  });

  it('writes an event private, busy and silent when asked', async () => {
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

  it('reads the event version and sends it with changes so a newer event is not overwritten', async () => {
    const { api, requests } = stubGoogle((request) =>
      request.method === 'GET'
        ? { status: 200, body: { id: 'evt-1', etag: '"version-1"' } }
        : { status: 412, body: { error: { message: 'Event changed' } } },
    );
    const event = await api.getEvent('pat@principal.example', 'evt-1');
    expect(event?.etag).toBe('"version-1"');
    expect(requests[0].url.searchParams.get('fields')?.split(',')).toContain('etag');
    await expect(
      api.patchEvent('pat@principal.example', 'evt-1', { summary: 'Updated' }, 'all', event?.etag),
    ).rejects.toMatchObject({ status: 412 });
    expect(requests[1].headers['if-match']).toBe('"version-1"');
  });

  it('conditions cancellation on the version read so a newer event is not deleted', async () => {
    const { api, requests } = stubGoogle(() => ({
      status: 412,
      body: { error: { message: 'Event changed' } },
    }));
    await expect(api.deleteEvent('pat@principal.example', 'evt-1', 'all', '"version-1"')).rejects.toMatchObject({
      status: 412,
    });
    expect(requests[0].headers['if-match']).toBe('"version-1"');
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

  it("reads every page of main's detailed listing, titles and names included, and fails rather than come back short", async () => {
    const page = (token: string | undefined, id: string) => ({
      items: [
        {
          id,
          summary: 'Quarterly review',
          organizer: { email: 'Pat@Principal.example', self: true },
          attendees: [
            { email: 'pat@principal.example', self: true, responseStatus: 'accepted' },
            { email: 'remy@friends.example', displayName: 'Remy Vance', responseStatus: 'needsAction' },
          ],
          recurringEventId: 'series1',
          originalStartTime: { dateTime: '2026-10-07T09:00:00Z' },
          start: { dateTime: '2026-10-07T09:00:00Z' },
          end: { dateTime: '2026-10-07T10:00:00Z' },
        },
      ],
      ...(token === undefined ? {} : { nextPageToken: token }),
    });
    const { api, requests } = stubGoogle((request) =>
      request.url.searchParams.get('pageToken') === 'p2'
        ? { status: 200, body: page(undefined, 'e2') }
        : { status: 200, body: page('p2', 'e1') },
    );
    const events = await api.listEventDetails('pat@principal.example', '2026-10-07T00:00:00Z', '2026-10-08T00:00:00Z');
    expect(events.map((event) => event.id)).toEqual(['e1', 'e2']);
    expect(events[0]).toEqual({
      id: 'e1',
      summary: 'Quarterly review',
      recurringEventId: 'series1',
      organizer: { email: 'pat@principal.example', self: true },
      attendees: [
        { email: 'pat@principal.example', self: true, responseStatus: 'accepted' },
        { email: 'remy@friends.example', displayName: 'Remy Vance', responseStatus: 'needsAction' },
      ],
      originalStartTime: { dateTime: '2026-10-07T09:00:00Z' },
      start: { dateTime: '2026-10-07T09:00:00Z' },
      end: { dateTime: '2026-10-07T10:00:00Z' },
    });
    expect(requests[0].url.searchParams.get('singleEvents')).toBe('true');
    expect(requests[0].url.searchParams.get('fields')).toContain('summary');

    const endless = stubGoogle(() => ({ status: 200, body: page('more', 'e') }));
    await expect(
      endless.api.listEventDetails('pat@principal.example', '2026-01-01T00:00:00Z', '2026-12-31T00:00:00Z'),
    ).rejects.toThrow(/too long to read/u);
  });

  it("reads an event's own tags, but never its title, description or location", async () => {
    const { api, requests } = stubGoogle(() => ({
      status: 200,
      body: {
        id: 'h1',
        status: 'confirmed',
        start: { dateTime: '2026-10-07T09:00:00Z' },
        end: { dateTime: '2026-10-07T09:30:00Z' },
        extendedProperties: { private: { gwsEaThread: 'mail-1', gwsEaRole: 'booking' } },
      },
    }));
    const event = await api.getEvent('pat@principal.example', 'h1');
    expect(event?.tags).toEqual({ gwsEaThread: 'mail-1', gwsEaRole: 'booking' });
    const fields = requests[0].url.searchParams.get('fields') ?? '';
    expect(fields).toContain('extendedProperties');
    for (const hidden of ['summary', 'description', 'location']) expect(fields).not.toContain(hidden);
  });

  it('writes an all-day event as dates, and its repetition as given', async () => {
    const { api, requests } = stubGoogle(() => ({ status: 200, body: { id: 'off1' } }));
    await api.insertEvent(
      'pat@principal.example',
      'off1',
      {
        summary: 'Offsite',
        start: '2026-10-12',
        end: '2026-10-14',
        allDay: true,
        recurrence: ['RRULE:FREQ=YEARLY'],
        attendees: [{ email: 'pat@principal.example', responseStatus: 'accepted' }],
      },
      'none',
    );
    expect(requests[0].body).toMatchObject({
      start: { date: '2026-10-12' },
      end: { date: '2026-10-14' },
      recurrence: ['RRULE:FREQ=YEARLY'],
    });
  });

  it("reads an event's guests whole with its organizer, version and words, and writes a guest list back as given over that version", async () => {
    const guests = [
      { email: 'pat@principal.example', responseStatus: 'accepted', organizer: true, self: true },
      { email: 'sam@acme.example', responseStatus: 'accepted', comment: 'Running late', optional: true },
    ];
    const { api, requests } = stubGoogle((request) =>
      request.method === 'GET'
        ? {
            status: 200,
            body: {
              etag: '"3462538740420000"',
              status: 'confirmed',
              organizer: { email: 'Pat@Principal.example' },
              attendees: guests,
              summary: 'Quarterly review',
              description: 'The numbers, then the plan.',
              location: 'Boardroom',
            },
          }
        : { status: 200, body: { id: 'evt-1' } },
    );
    expect(await api.getGuests('pat@principal.example', 'evt-1')).toEqual({
      etag: '"3462538740420000"',
      status: 'confirmed',
      organizer: 'pat@principal.example',
      guests,
      summary: 'Quarterly review',
      description: 'The numbers, then the plan.',
      location: 'Boardroom',
    });
    expect(requests[0].url.searchParams.get('fields')).toBe(
      'etag,status,organizer(email),attendees,attendeesOmitted,recurringEventId,recurrence,summary,description,location',
    );

    expect(
      await api.setGuests(
        'pat@principal.example',
        'evt-1',
        [...guests, { email: 'kim@acme.example' }],
        'none',
        '"3462538740420000"',
      ),
    ).toBe('set');
    expect(requests[1]).toMatchObject({
      method: 'PATCH',
      body: { attendees: [...guests, { email: 'kim@acme.example' }] },
    });
    expect(requests[1].headers['if-match']).toBe('"3462538740420000"');
    expect(requests[1].url.pathname).toBe('/calendar/v3/calendars/pat%40principal.example/events/evt-1');
    expect(Object.fromEntries(requests[1].url.searchParams)).toEqual({ sendUpdates: 'none', fields: 'id' });
  });

  it('reads a guest-list write Google refuses because the event changed since its version as changed, and throws any other refusal', async () => {
    const statuses = [412, 403];
    const { api, requests } = stubGoogle(() => ({
      status: statuses.shift() ?? 500,
      body: { error: { message: 'Precondition Failed' } },
    }));
    const guests = [{ email: 'pat@principal.example', responseStatus: 'accepted' }];
    expect(await api.setGuests('pat@principal.example', 'evt-1', guests, 'none', '"1"')).toBe('changed');
    await expect(api.setGuests('pat@principal.example', 'evt-1', guests, 'none', '"1"')).rejects.toMatchObject({
      status: 403,
    });
    // A write given no version asks for none.
    await expect(api.setGuests('pat@principal.example', 'evt-1', guests, 'none')).rejects.toMatchObject({
      status: 500,
    });
    expect(requests[2].headers).not.toHaveProperty('if-match');
  });

  it('reads whether Google left guests out, and the series an occurrence belongs to or the series itself', async () => {
    const replies = [
      {
        attendeesOmitted: true,
        recurringEventId: 'series-1',
        attendees: [{ email: 'pat@principal.example', self: true }],
      },
      { recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'] },
    ];
    const { api } = stubGoogle(() => ({ status: 200, body: { etag: '"1"', ...replies.shift() } }));
    expect(await api.getGuests('pat@principal.example', 'series-1_20261012T090000Z')).toEqual({
      etag: '"1"',
      guests: [{ email: 'pat@principal.example', self: true }],
      attendeesOmitted: true,
      recurringEventId: 'series-1',
    });
    expect(await api.getGuests('pat@principal.example', 'series-1')).toEqual({
      etag: '"1"',
      guests: [],
      recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
    });
  });

  it("writes only the calendar's own guest entry, telling Google the rest of the list is left out, over the version read", async () => {
    const { api, requests } = stubGoogle(() => ({ status: 200, body: { id: 'evt-1' } }));
    const own = { email: 'pat.alias@principal.example', self: true, responseStatus: 'declined' };
    expect(await api.setOwnEntry('pat@principal.example', 'evt-1', own, 'all', '"7"')).toBe('set');
    const [request] = requests;
    expect(request.method).toBe('PATCH');
    expect(request.url.pathname).toBe('/calendar/v3/calendars/pat%40principal.example/events/evt-1');
    expect(Object.fromEntries(request.url.searchParams)).toEqual({ sendUpdates: 'all', fields: 'id' });
    expect(request.headers['if-match']).toBe('"7"');
    expect(request.body).toEqual({ attendeesOmitted: true, attendees: [own] });
  });

  it('reads a self-only write as changed when the event moved on since its version, either guest write as gone when the event is, and throws any other refusal', async () => {
    const statuses = [412, 404, 410, 403, 404, 410];
    const { api } = stubGoogle(() => ({ status: statuses.shift() ?? 500, body: { error: { message: 'No' } } }));
    const own = { email: 'pat@principal.example', self: true, responseStatus: 'accepted' };
    expect(await api.setOwnEntry('pat@principal.example', 'evt-1', own, 'none', '"1"')).toBe('changed');
    expect(await api.setOwnEntry('pat@principal.example', 'evt-1', own, 'none', '"1"')).toBe('gone');
    expect(await api.setOwnEntry('pat@principal.example', 'evt-1', own, 'none', '"1"')).toBe('gone');
    await expect(api.setOwnEntry('pat@principal.example', 'evt-1', own, 'none', '"1"')).rejects.toMatchObject({
      status: 403,
    });
    expect(await api.setGuests('pat@principal.example', 'evt-1', [own], 'none', '"1"')).toBe('gone');
    expect(await api.setGuests('pat@principal.example', 'evt-1', [own], 'none', '"1"')).toBe('gone');
  });

  it('reads an event that is not there, or no longer is, as undefined when its guests are asked for', async () => {
    const statuses = [404, 410];
    const { api } = stubGoogle(() => ({ status: statuses.shift() ?? 500, body: { error: { message: 'Not Found' } } }));
    expect(await api.getGuests('pat@principal.example', 'missing')).toBeUndefined();
    expect(await api.getGuests('pat@principal.example', 'deleted')).toBeUndefined();
  });
});

it('reads planning detail fields only on the main detail route', async () => {
  const raw = {
    id: 'e',
    etag: 'v1',
    summary: 'Lunch',
    description: 'Menu',
    location: 'Mission restaurant',
    creator: { email: 'Juno@Hale.example', displayName: 'Juno Hale' },
    start: { dateTime: '2026-10-06T09:00:00+02:00', timeZone: 'Europe/Brussels' },
    end: { dateTime: '2026-10-06T10:00:00+02:00', timeZone: 'Europe/Brussels' },
    eventType: 'default',
    extendedProperties: { private: { gws_ea_parent_event: 'p' } },
    conferenceData: { entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/abc' }] },
  };
  const { api, requests } = stubGoogle(() => ({ status: 200, body: { items: [raw] } }));
  expect((await api.listEventDetails('c', '2026-10-06T00:00Z', '2026-10-07T00:00Z'))[0]).toMatchObject({
    etag: 'v1',
    description: 'Menu',
    location: 'Mission restaurant',
    creator: { email: 'juno@hale.example', displayName: 'Juno Hale' },
    start: { timeZone: 'Europe/Brussels' },
    end: { timeZone: 'Europe/Brussels' },
    eventType: 'default',
    tags: { gws_ea_parent_event: 'p' },
    conference: { uri: 'https://meet.google.com/abc' },
  });
  const outside = (await api.listEvents('c', '2026-10-06T00:00Z', '2026-10-07T00:00Z'))[0];
  expect(outside).not.toHaveProperty('summary');
  expect(outside).not.toHaveProperty('location');
  expect(requests[1].url.searchParams.get('fields')).not.toContain('description');
});

it('keeps telephone conference entry points on the detail route', async () => {
  const { api } = stubGoogle(() => ({
    status: 200,
    body: {
      items: [
        {
          id: 'e',
          conferenceData: {
            conferenceId: 'call',
            entryPoints: [{ entryPointType: 'phone', uri: 'tel:+14155550100', label: 'US dial-in' }],
          },
        },
      ],
    },
  }));
  expect((await api.listEventDetails('c', '2026-10-06T00:00Z', '2026-10-07T00:00Z'))[0]).toMatchObject({
    conference: {
      status: 'success',
      conferenceId: 'call',
      entryPoints: [{ entryPointType: 'phone', uri: 'tel:+14155550100', label: 'US dial-in' }],
    },
  });
});

it('reads one main-only detail with its creator and recurrence, keeping the outward getter title-free', async () => {
  const { api, requests } = stubGoogle(() => ({
    status: 200,
    body: {
      id: 'abc123',
      summary: 'Call with Remy',
      creator: { email: 'juno@ellery.example', displayName: 'Juno Hale' },
      recurrence: ['RRULE:FREQ=WEEKLY;COUNT=10'],
      start: { dateTime: '2026-10-05T16:00:00Z' },
      end: { dateTime: '2026-10-05T16:30:00Z' },
    },
  }));
  expect(await api.getEventDetail('morgan@ellery.example', 'abc123')).toMatchObject({
    summary: 'Call with Remy',
    creator: { displayName: 'Juno Hale' },
    recurrence: ['RRULE:FREQ=WEEKLY;COUNT=10'],
  });
  expect(await api.getEvent('morgan@ellery.example', 'abc123')).not.toHaveProperty('summary');
  expect(requests[0].url.searchParams.get('fields')).toContain('creator');
  expect(requests[1].url.searchParams.get('fields')).not.toContain('summary');
});

it('reads colleague busy windows and fails an incomplete freebusy answer rather than reporting free time', async () => {
  const { api, requests } = stubGoogle(() => ({
    status: 200,
    body: {
      calendars: {
        'remy@ellery.example': { busy: [{ start: '2026-10-05T16:00:00Z', end: '2026-10-05T17:00:00Z' }] },
      },
    },
  }));
  expect(await api.freeBusy(['remy@ellery.example'], '2026-10-05T00:00:00Z', '2026-10-06T00:00:00Z')).toEqual({
    'remy@ellery.example': [{ start: '2026-10-05T16:00:00Z', end: '2026-10-05T17:00:00Z' }],
  });
  expect(requests[0]).toMatchObject({ method: 'POST', body: { items: [{ id: 'remy@ellery.example' }] } });
  await expect(
    api.freeBusy(['unknown@ellery.example'], '2026-10-05T00:00:00Z', '2026-10-06T00:00:00Z'),
  ).rejects.toThrow(/busy/i);
});

it('does not report availability when Google gives a busy interval with an unreadable end', async () => {
  const { api } = stubGoogle(() => ({
    status: 200,
    body: { calendars: { 'remy@ellery.example': { busy: [{ start: '2026-10-05T16:00:00Z', end: 'not-a-time' }] } } },
  }));
  await expect(api.freeBusy(['remy@ellery.example'], '2026-10-05T00:00:00Z', '2026-10-06T00:00:00Z')).rejects.toThrow(
    /unreadable busy-time window/,
  );
});
