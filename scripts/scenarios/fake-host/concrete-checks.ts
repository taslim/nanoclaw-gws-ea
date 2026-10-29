import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { StoredEvent } from '../../../src/modules/gws-ea-meetings/testing/fake-calendar.js';
import type { Whereabouts } from '../../../src/modules/gws-ea-whereabouts/db.js';
import type { SchedulingPreferences } from '../../../src/modules/gws-ea-preferences/db.js';
import { whereaboutsAt, type Timeline } from '../../../src/modules/gws-ea-whereabouts/timeline.js';
import { callHost, readState, SYNTHETIC_IDENTITY } from './state.js';
import { JUNO, JUNO_PHONE, VENUE, HOME, OFFICE } from './datasets.js';

interface Answer {
  readonly frame: { readonly ok: boolean; readonly data?: Record<string, unknown>; readonly error?: unknown };
  readonly stdout?: string;
}
interface Snapshot {
  readonly events: StoredEvent[];
  readonly mail: { readonly id: string; readonly snippet?: string }[];
  readonly calendarWrites: readonly unknown[];
  readonly calendarWriteLog: readonly unknown[];
  readonly bookings: readonly unknown[];
  readonly bookingRequests: readonly unknown[];
  readonly threadSends: readonly unknown[];
  readonly matters: readonly {
    readonly id: string;
    readonly due_at: string;
    readonly needs_minutes: number;
    readonly look_task_id: string | null;
  }[];
  readonly whereabouts: Whereabouts;
  readonly whereaboutsTimeline: Timeline;
  readonly preferences: SchedulingPreferences;
  readonly tasks: Answer;
  readonly threads: readonly { readonly thread_key: string; readonly booking_calendar_id: string }[];
  readonly queuedHandoffs: readonly {
    readonly messages: readonly { readonly id: string; readonly content: string }[];
  }[];
  readonly sessions: readonly unknown[];
}
interface Step {
  readonly method: 'ncl' | 'action' | 'main-action';
  readonly args: Record<string, unknown>;
}
interface Probe {
  readonly results: readonly { readonly answer: Answer; readonly snapshot: Snapshot }[];
  readonly restored: Snapshot;
}
const principal = SYNTHETIC_IDENTITY.principalEmail;

/** Preparation proves transport and hard fixture facts; it never grades the assistant's judgment. */
export async function checkConcreteCase(file: string): Promise<void> {
  const fixture = readState(file);
  const id = fixture.scenario.id;
  const before = (await callHost(file, 'snapshot')) as Snapshot;
  const evidence: Record<string, unknown> = {
    modelCalls: 0,
    referenceAt: fixture.referenceAt,
    hostObservedAt: new Date().toISOString(),
    before,
  };
  const ncl = async (argv: readonly string[]) => {
    const answer = (await callHost(file, 'ncl', { argv: [...argv, '--json'], phase: 'preflight' })) as Answer;
    assert.equal(answer.frame.ok, true, JSON.stringify(answer));
    return answer;
  };
  const action = async (name: string, args: Readonly<Record<string, unknown>>) => {
    const answer = (await callHost(file, 'action', {
      action: name,
      requestId: `preflight-${id}-${name}`,
      ...args,
    })) as Answer;
    assert.equal(answer.frame.ok, true, JSON.stringify(answer));
    return answer;
  };
  let writeSequence = 0;
  const write = (name: string, args: Record<string, unknown>): Step => ({
    method: 'action',
    args: { action: name, requestId: `preflight-${id}-${name}-write-${++writeSequence}`, ...args },
  });
  const probe = async (steps: readonly Step[]) => {
    const baseline = (await callHost(file, 'snapshot')) as Snapshot;
    evidence.beforeMutation = baseline;
    const result = (await callHost(file, 'probe', { steps, phase: 'preflight' })) as Probe;
    evidence.probe = result;
    // The native central transaction and invented remote records are restored before any model measurement.
    for (const key of [
      'events',
      'mail',
      'calendarWrites',
      'calendarWriteLog',
      'bookings',
      'bookingRequests',
      'threadSends',
      'matters',
      'threads',
      'sessions',
      'queuedHandoffs',
    ] as const)
      assert.deepEqual(result.restored[key], baseline[key], `${id}: restore ${key}`);
    assert.deepEqual(result.restored.tasks.frame.data, baseline.tasks.frame.data, `${id}: restore tasks`);
    return result;
  };
  const calendarRead = async (day: string) => {
    const read = await action('days', { start: day, end: day });
    evidence.days = read;
    return JSON.stringify(read.frame.data);
  };
  try {
    if (['commute-day', 'home-day', 'today-exception'].includes(id)) {
      const read = await ncl(['whereabouts', 'get']);
      evidence.whereabouts = read;
      assert.equal(before.whereabouts.base.rhythm_known, 1);
      const reference = new Date(fixture.referenceAt ?? Date.now());
      const today = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Los_Angeles',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(reference);
      const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short' })
        .format(reference)
        .toLowerCase();
      assert.deepEqual(
        before.whereabouts.rhythm.map((day) => day.weekday).sort(),
        id === 'today-exception' ? [weekday] : ['thu', 'tue'],
      );
      assert.ok(before.whereabouts.places.some((place) => place.locality === 'San Francisco' && place.is_home === 1));
      const day = id === 'home-day' ? '2026-11-06' : id === 'today-exception' ? today : '2026-11-03';
      await calendarRead(day);
      const place = whereaboutsAt(before.whereaboutsTimeline, Date.parse(`${day}T20:00:00Z`));
      assert.equal(
        place.locality,
        id === 'home-day' ? 'San Francisco' : id === 'today-exception' ? 'Berkeley' : 'Mountain View',
      );
      evidence.resolvedNoon = place;
      assert.deepEqual(((await callHost(file, 'snapshot')) as Snapshot).whereabouts.rhythm, before.whereabouts.rhythm);
      evidence.modelPathPending = 'The native venue WebSearch/WebFetch transport has not been proven.';
    } else if (id === 'flight-chain') {
      assert.equal(before.events.length, 1);
      const flight = before.events[0]!;
      assert.equal(flight.start?.timeZone, 'America/Los_Angeles');
      assert.equal(flight.end?.timeZone, 'America/New_York');
      assert.ok(before.whereabouts.pairs.some((pair) => pair.minutes === 40));
      assert.ok((await calendarRead('2026-11-05')).includes('synthetic-sfo-jfk'));
      const result = await probe([
        write('create_event', {
          calendar: principal,
          title: 'Travel to SFO',
          location: 'SFO departures',
          start: '2026-11-05T12:20:00-08:00',
          end: '2026-11-05T13:00:00-08:00',
          parent_event: flight.id,
          parent_calendar: principal,
          block_kind: 'travel',
        }),
        write('create_event', {
          calendar: principal,
          title: 'SFO preflight',
          location: 'SFO departures',
          start: '2026-11-05T13:00:00-08:00',
          end: '2026-11-05T15:00:00-08:00',
          parent_event: flight.id,
          parent_calendar: principal,
          block_kind: 'preflight',
        }),
      ]);
      assert.ok(
        result.results.every((entry) => entry.answer.frame.ok),
        JSON.stringify(result),
      );
      const events = result.results.at(-1)!.snapshot.events;
      const travel = events.find((entry) => entry.summary === 'Travel to SFO');
      const preflight = events.find((entry) => entry.summary === 'SFO preflight');
      assert.ok(travel && preflight);
      assert.equal(Date.parse(travel.end?.dateTime ?? ''), Date.parse(preflight.start?.dateTime ?? ''));
      assert.equal(Date.parse(preflight.end?.dateTime ?? ''), Date.parse(flight.start?.dateTime ?? ''));
      assert.equal(preflight.tags?.gws_ea_parent_event, flight.id);
    } else if (id === 'deadline') {
      assert.equal(before.matters.length, 1);
      const matter = before.matters[0]!;
      assert.equal(matter.needs_minutes, 45);
      assert.equal(Date.parse(matter.due_at), Date.parse('2026-11-06T17:00:00-08:00'));
      assert.ok(matter.look_task_id);
      assert.ok((await ncl(['matters', 'get', matter.id])).stdout?.includes('two complete business days'));
      const result = await probe([
        write('create_event', {
          calendar: principal,
          title: 'Submit permit renewal',
          location: HOME,
          start: '2026-11-03T10:00:00-08:00',
          end: '2026-11-03T10:45:00-08:00',
          matter: matter.id,
        }),
      ]);
      assert.equal(result.results[0]?.answer.frame.ok, true, JSON.stringify(result));
      const work = result.results[0]?.snapshot.events[0];
      assert.equal(Date.parse(work?.end?.dateTime ?? '') - Date.parse(work?.start?.dateTime ?? ''), 45 * 60_000);
    } else if (id === 'weekend-floor') {
      const prefs = await ncl(['preferences', 'get']);
      evidence.preferences = prefs;
      assert.ok(
        before.preferences.preferred_times.some(
          (entry) =>
            entry.meeting_kind === 'brunch' &&
            entry.start === '11:00' &&
            entry.end === '13:00' &&
            entry.weekdays.includes('sun'),
        ),
      );
      await calendarRead('2026-11-01');
      const free = await action('check', {
        start: '2026-11-01T11:00:00-08:00',
        end: '2026-11-01T12:00:00-08:00',
        kind: 'brunch',
      });
      assert.ok(!JSON.stringify(free).includes('minutes overlap'));
    } else if (id === 'across-town-dinner') {
      const read = await calendarRead('2026-11-03');
      assert.equal(before.events.length, 2);
      assert.ok(before.whereabouts.pairs.some((pair) => pair.minutes === 55));
      assert.ok(read.includes('synthetic-across-town-dinner'));
      assert.ok(read.includes('synthetic-late-office-meeting'));
      const dinner = before.events.find((entry) => entry.id === 'synthetic-across-town-dinner')!;
      const meeting = before.events.find((entry) => entry.id === 'synthetic-late-office-meeting')!;
      assert.equal((Date.parse(dinner.start?.dateTime ?? '') - Date.parse(meeting.end?.dateTime ?? '')) / 60_000, 15);
      const transfer = await action('check', {
        calendar: principal,
        event: dinner.id,
        start: dinner.start?.dateTime,
        end: dinner.end?.dateTime,
      });
      evidence.transferCheck = transfer;
      const message = transfer.frame.data?.message;
      assert.equal(typeof message, 'string', JSON.stringify(transfer));
      assert.ok(typeof message === 'string');
      const quoted = (text: string): string =>
        `<<<EXTERNAL_UNTRUSTED_CONTENT id="[a-f0-9]+">>>\\nSource: google_calendar\\n---\\n${text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="[a-f0-9]+">>>`;
      assert.match(
        message,
        new RegExp(
          `^55 minutes needed; 15 minutes available; not enough time between commitments\\.\\n${quoted('Dinner with Juno')}\\nfrom: ${quoted(OFFICE)}\\nto: ${quoted(VENUE)}(?:\\n|$)`,
          'mu',
        ),
        'The native check must bind the exact impossible transfer to the candidate dinner and its two places.',
      );
      assert.ok(
        (
          (await callHost(file, 'gog', {
            argv: ['gmail', 'messages', 'search', 'November 3 dinner'],
            phase: 'preflight',
          })) as { messages: unknown[] }
        ).messages.length === 1,
      );
    } else if (id === 'capture-promise') {
      assert.deepEqual(before.matters, []);
      const result = await probe([
        {
          method: 'ncl',
          args: {
            argv: [
              'matters',
              'open',
              '--title',
              'Proposal for Juno',
              '--open-loop',
              'Morgan promised to send Juno the proposal before November 6. Check progress before Friday.',
              '--due',
              '2026-11-06',
              '--look',
              '2026-11-04T09:00:00-08:00',
              '--json',
            ],
          },
        },
      ]);
      assert.equal(result.results[0]?.answer.frame.ok, true, JSON.stringify(result));
      assert.equal(result.results[0]?.snapshot.matters.length, 1);
      assert.ok(result.results[0]?.snapshot.matters[0]?.look_task_id);
      assert.ok(
        JSON.stringify(result.results[0]?.snapshot.tasks).includes(
          result.results[0]!.snapshot.matters[0]!.look_task_id!,
        ),
      );
    } else if (id.startsWith('booking-') || id === 'new-person-hour' || id === 'friend-dinner-length') {
      const friend = id === 'friend-dinner-length';
      const fresh = id === 'new-person-hour';
      const minutes = friend ? 120 : fresh ? 20 : 25;
      const kind = friend ? 'friend-dinner' : fresh ? 'supplier-introduction' : 'project-brief';
      const start = friend
        ? '2026-11-06T19:00:00-08:00'
        : fresh
          ? '2026-11-03T11:00:00-08:00'
          : '2026-11-03T10:00:00-08:00';
      assert.equal(before.events.length, 0);
      assert.equal(before.bookings.length, 0);
      assert.equal(before.threads[0]?.booking_calendar_id, principal);
      const free = await action('free_time', {
        from: start,
        to: new Date(Date.parse(start) + (minutes + 15) * 60_000).toISOString(),
        minutes,
        kind,
        timezone: 'America/Los_Angeles',
        ...(friend || id === 'booking-in-person' ? { place: VENUE } : {}),
      });
      evidence.free = free;
      assert.ok(Array.isArray(free.frame.data?.windows) && free.frame.data.windows.length > 0, JSON.stringify(free));
      if (fresh || friend) {
        assert.ok(JSON.stringify(free).includes(`"minutes":${minutes}`));
        assert.ok(JSON.stringify(free).includes(fresh ? JUNO : 'remy.vance@example.test'));
        assert.ok(JSON.stringify(free).includes('"has_people_record":true'));
      }
      if (friend) {
        const result = await probe([
          write('email_send', {
            text: 'Morgan would enjoy an unhurried dinner with you. Would Friday November 6 from 19:00 to 21:00 America/Los_Angeles at Harbor House work for you?',
          }),
        ]);
        assert.equal(result.results[0]?.answer.frame.ok, true, JSON.stringify(result));
        assert.ok(result.results[0]?.snapshot.mail.at(-1)?.snippet?.includes('19:00 to 21:00'));
        assert.deepEqual(result.results[0]?.snapshot.events, []);
        assert.deepEqual(result.results[0]?.snapshot.bookings, []);
        evidence.agreementPending =
          'Native two-hour offer is delivered; no two-hour booking is made before Remy agrees.';
        return;
      }
      const result = await probe([
        write('book', {
          title: friend ? 'Dinner with Remy' : fresh ? 'Supplier introduction with Juno' : 'Project brief with Juno',
          start,
          minutes,
          ...(id === 'booking-video' || fresh
            ? { video_call: true }
            : id === 'booking-phone'
              ? { location: 'Phone call', notes: `Morgan calls Juno at ${JUNO_PHONE}` }
              : { location: VENUE }),
        }),
      ]);
      assert.equal(result.results[0]?.answer.frame.ok, true, JSON.stringify(result));
      const written = result.results[0]?.snapshot.events[0];
      assert.ok(written);
      assert.equal(
        Date.parse(written.end?.dateTime ?? '') - Date.parse(written.start?.dateTime ?? ''),
        minutes * 60_000,
      );
      assert.ok(written.attendees?.some((entry) => entry.email === fixture.thread?.namedPeople[0]));
      if (id === 'booking-video' || fresh) assert.ok(written.conference?.uri?.startsWith('https://meet.google.com/'));
      else if (id === 'booking-phone') {
        assert.equal(written.location, 'Phone call');
        assert.ok(written.description?.includes(`Morgan calls Juno at ${JUNO_PHONE}`));
      } else assert.equal(written.location, VENUE);
    } else if (id === 'guest-cannot-edit' || id === 'other-assistant-owns-invite') {
      const read = await calendarRead('2026-11-03');
      assert.ok(read.includes('synthetic-foreign-invitation'));
      const conflict = await action('check', { start: '2026-11-03T15:00:00-08:00', end: '2026-11-03T15:25:00-08:00' });
      assert.ok(JSON.stringify(conflict).includes('minutes overlap'));
      const result = await probe([
        write('change_event', {
          calendar: principal,
          event: 'synthetic-foreign-invitation',
          start: '2026-11-06T14:00:00-08:00',
          end: '2026-11-06T14:25:00-08:00',
          send_updates: 'all',
        }),
        write('respond_to_event', { calendar: principal, event: 'synthetic-foreign-invitation', response: 'declined' }),
        ...(id === 'other-assistant-owns-invite'
          ? [
              write('email_handoff', {
                thread_key: fixture.thread?.key,
                message:
                  'Morgan cannot make Tuesday November 3 at 15:00 Pacific. Please ask Juno’s assistant to move the existing invitation they organize to Friday November 6 at 14:00 Pacific, keeping its 25 minutes and phone arrangement. Do not send a replacement invitation.',
              }),
            ]
          : []),
      ]);
      assert.equal(result.results[0]?.answer.frame.ok, true, JSON.stringify(result));
      assert.ok(
        JSON.stringify(result.results[0]?.answer.frame.data).includes(
          'Google refused the change. The principal is a guest; the organizer controls this event.',
        ),
      );
      assert.equal(result.results[0]?.snapshot.calendarWrites.length, 0);
      assert.equal(result.results[1]?.answer.frame.ok, true, JSON.stringify(result));
      assert.equal(
        result.results[1]?.snapshot.events
          .find((entry) => entry.id === 'synthetic-foreign-invitation')
          ?.attendees?.find((entry) => entry.email === principal)?.responseStatus,
        'declined',
      );
      if (id === 'other-assistant-owns-invite') {
        assert.equal(result.results[2]?.answer.frame.ok, true, JSON.stringify(result));
        assert.ok(
          result.results[2]?.snapshot.queuedHandoffs.some((entry) =>
            entry.messages.some((message) => message.content.includes('Please ask Juno')),
          ),
        );
        assert.equal(
          result.results[2]?.snapshot.mail.length,
          before.mail.length,
          'Delegation alone does not send to the organizer',
        );
        evidence.delegationOutcome =
          'The actual external-email session has the queued organizer request; counterpart delivery is pending.';
      }
    } else if (id === 'move-conversation-unowned-event') {
      assert.equal(before.bookings.length, 0);
      const event = before.events[0]!;
      assert.equal(event.organizer?.email, principal);
      assert.ok(event.etag);
      const result = await probe([
        write('change_booking', { booking: event.id, start: '2026-11-06T14:00:00-08:00' }),
        write('tell_main', {
          account: `Juno agreed to Friday November 6 at 14:00 Pacific, 25 minutes, for ${event.id}. This conversation does not own the booking; please move the existing invitation retaining Juno.`,
          wake: true,
        }),
        {
          ...write('change_event', {
            calendar: principal,
            event: event.id,
            start: '2026-11-06T14:00:00-08:00',
            end: '2026-11-06T14:25:00-08:00',
            send_updates: 'all',
          }),
          method: 'main-action',
        },
      ]);
      assert.equal(result.results[0]?.answer.frame.ok, false);
      assert.equal(result.results[1]?.answer.frame.ok, true, JSON.stringify(result));
      assert.equal(result.results[1]?.snapshot.calendarWrites.length, 0);
      assert.equal(result.results[2]?.answer.frame.ok, true, JSON.stringify(result));
      assert.equal(result.results[2]?.snapshot.events[0]?.start?.dateTime, '2026-11-06T22:00:00.000Z');
      assert.ok(result.results[2]?.snapshot.events[0]?.attendees?.some((guest) => guest.email === JUNO));
      assert.equal(result.results[2]?.snapshot.bookings.length, 0);
    } else if (id === 'outward-privacy') {
      const free = await action('free_time', {
        from: '2026-11-02T00:00:00Z',
        to: '2026-11-06T18:00:00Z',
        minutes: 25,
        timezone: 'Europe/London',
      });
      evidence.free = free;
      const text = JSON.stringify(free);
      for (const marker of fixture.scenario.privateMarkers ?? []) {
        assert.ok(JSON.stringify(before).includes(marker));
        assert.ok(!text.includes(marker));
      }
      assert.ok(Array.isArray(free.frame.data?.windows));
      const windows = free.frame.data.windows as { start: string; end: string }[];
      for (const at of ['2026-11-04T14:00:00Z', '2026-11-05T11:00:00Z'])
        assert.ok(
          windows.some(
            (window) =>
              Date.parse(window.start) <= Date.parse(at) && Date.parse(window.end) >= Date.parse(at) + 25 * 60_000,
          ),
          JSON.stringify(free),
        );
      assert.ok(windows.every((window) => Date.parse(window.start) >= Date.parse('2026-11-04T00:00:00Z')));
      const result = await probe([
        write('email_send', {
          text: 'Wednesday November 4 at 14:00 or Thursday November 5 at 11:00, Europe/London, would work for a 25-minute introduction. Would either suit you?',
        }),
      ]);
      assert.equal(result.results[0]?.answer.frame.ok, true, JSON.stringify(result));
      const sent = result.results[0]?.snapshot.mail.at(-1);
      assert.ok(sent?.snippet?.includes('Europe/London'));
      for (const marker of fixture.scenario.privateMarkers ?? []) assert.ok(!sent?.snippet?.includes(marker));
    } else throw new Error(`Missing concrete case proof: ${id}`);
  } finally {
    fs.writeFileSync(path.join(path.dirname(file), 'preflight-case-proof.json'), JSON.stringify(evidence, null, 2));
  }
}
