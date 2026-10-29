import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StoredEvent, CalendarWriteRecord } from '../../../src/modules/gws-ea-meetings/testing/fake-calendar.js';
import type { GmailMessage } from '../../../src/modules/gws-ea-inbox/gmail-api.js';
import { parseGmailMessage } from '../../../src/modules/gws-ea-inbox/mime.js';
import { callHost, SYNTHETIC_IDENTITY, writeState } from './state.js';
import type { SyntheticEvent } from './state.js';
import type { ScenarioCase } from '../types.js';

const tree = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const output = process.argv[2];
if (!output || !path.isAbsolute(output) || fs.existsSync(output))
  throw new Error('transport-check <new absolute evidence directory>');
fs.mkdirSync(output, { recursive: true });
const principal = SYNTHETIC_IDENTITY.principalEmail;
const juno = 'juno.hale@example.test';
interface Snapshot {
  readonly events: StoredEvent[];
  readonly calendarWrites: CalendarWriteRecord[];
  readonly calendarWriteLog: Record<string, unknown>[];
  readonly mail: GmailMessage[];
  readonly bookings: Record<string, unknown>[];
  readonly bookingRequests: Record<string, unknown>[];
  readonly threadSends: { state: string }[];
}
async function host(
  audience: 'main' | 'external-email',
  check: (file: string) => Promise<void>,
  name: string = audience,
  events: SyntheticEvent[] = [],
): Promise<void> {
  const root = path.join(output!, name);
  fs.mkdirSync(root);
  const scenario: ScenarioCase = {
    id: 'synthetic-google-write-check',
    available: false,
    requirement: 'R33',
    unit: 'U13',
    audience,
    input: 'Synthetic transport proof only.',
    facts: [],
    validOutcomes: [],
    unacceptable: [],
  };
  const file = path.join(root, 'fixture.json');
  writeState(file, {
    scenario,
    attempt: 1,
    effects: [],
    outbound: [],
    events,
    mail: [],
    ...(audience === 'external-email'
      ? { thread: { key: 'mail-synthetic-transport', namedPeople: [juno], bookingCalendar: principal } }
      : {}),
  });
  const fd = fs.openSync(path.join(root, 'host.log'), 'a');
  const child = spawn(
    process.execPath,
    [
      '--import',
      path.join(tree, 'node_modules/tsx/dist/loader.mjs'),
      path.join(tree, 'scripts/scenarios/fake-host/prepare.ts'),
      tree,
      root,
      audience,
    ],
    { cwd: tree, stdio: ['ignore', fd, fd] },
  );
  let ended = false;
  const completion = new Promise<void>((resolve) =>
    child.once('exit', () => {
      ended = true;
      fs.closeSync(fd);
      resolve();
    }),
  );
  try {
    for (let tick = 0; tick < 400 && !ended && !fs.existsSync(path.join(root, 'host-endpoint.json')); tick++)
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    assert.ok(fs.existsSync(path.join(root, 'host-endpoint.json')), `Host failed: ${root}/host.log`);
    await check(file);
    fs.writeFileSync(
      path.join(root, 'canonical-snapshot.json'),
      JSON.stringify(await callHost(file, 'snapshot'), null, 2),
    );
  } finally {
    if (!ended && fs.existsSync(path.join(root, 'host-endpoint.json'))) await callHost(file, 'stop');
    else if (!ended) child.kill();
    await completion;
  }
}
async function action(
  file: string,
  name: string,
  requestId: string,
  args: Readonly<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const result = await callHost(file, 'action', { action: name, requestId, ...args });
  const answer = result as { frame?: { ok: boolean; data?: Record<string, unknown>; error?: unknown } };
  assert.equal(answer.frame?.ok, true, JSON.stringify(result));
  return answer.frame?.data ?? {};
}
const snapshot = async (file: string): Promise<Snapshot> => (await callHost(file, 'snapshot')) as Snapshot;
const productProofs: { action: string; passed: boolean; evidence: string }[] = [];
await host('main', async (file) => {
  const create = {
    calendar: principal,
    title: 'Lunch with Juno',
    location: 'Harbor House, 800 Fiction Lane, San Francisco',
    start: '2026-11-06T12:00:00-08:00',
    end: '2026-11-06T13:00:00-08:00',
    guests: [juno],
  };
  const created = await action(file, 'create_event', 'native-create', create);
  const id = String(created.event);
  assert.notEqual(id, 'undefined');
  await action(file, 'create_event', 'native-create', create);
  let state = await snapshot(file);
  assert.equal(state.events.length, 1);
  assert.equal(state.calendarWrites.filter((write) => write.op === 'insert').length, 1);
  assert.equal(state.events[0]?.location, create.location);
  assert.ok(state.events[0]?.attendees?.some((entry) => entry.email === juno));
  await action(file, 'change_event', 'native-move', {
    calendar: principal,
    event: id,
    send_updates: 'all',
    start: '2026-11-06T14:00:00-08:00',
    end: '2026-11-06T15:00:00-08:00',
  });
  await action(file, 'change_event', 'native-move', {
    calendar: principal,
    event: id,
    send_updates: 'all',
    start: '2026-11-06T14:00:00-08:00',
    end: '2026-11-06T15:00:00-08:00',
  });
  state = await snapshot(file);
  assert.equal(state.events[0]?.start?.dateTime, '2026-11-06T22:00:00.000Z');
  assert.ok(state.events[0]?.attendees?.some((entry) => entry.email === juno));
  assert.equal(state.calendarWrites.filter((write) => write.op === 'patch').length, 1);
  assert.equal(state.calendarWrites.find((write) => write.op === 'patch')?.sendUpdates, 'all');
  await action(file, 'cancel_event', 'native-cancel', { calendar: principal, event: id, send_updates: 'all' });
  await action(file, 'cancel_event', 'native-cancel', { calendar: principal, event: id, send_updates: 'all' });
  assert.equal((await snapshot(file)).events[0]?.status, 'cancelled');
  await callHost(file, 'transport-fault', { op: 'insert-after-write' });
  const uncertain = await callHost(file, 'action', {
    action: 'create_event',
    requestId: 'native-lost-create',
    ...create,
    start: '2026-11-09T12:00:00-08:00',
    end: '2026-11-09T13:00:00-08:00',
  });
  fs.writeFileSync(path.join(path.dirname(file), 'lost-create-first-answer.json'), JSON.stringify(uncertain, null, 2));
  const replay = await callHost(file, 'action', {
    action: 'create_event',
    requestId: 'native-lost-create',
    ...create,
    start: '2026-11-09T12:00:00-08:00',
    end: '2026-11-09T13:00:00-08:00',
  });
  state = await snapshot(file);
  assert.equal(state.events.length, 2);
  assert.equal(state.calendarWrites.filter((write) => write.op === 'insert').length, 2);
  const passed = (replay as { frame?: { ok: boolean } }).frame?.ok === true;
  const evidence = 'main/principal-create-recovery-product-proof.json';
  productProofs.push({ action: 'create_event', passed, evidence });
  fs.writeFileSync(
    path.join(output!, evidence),
    JSON.stringify(
      {
        passed,
        expected: 'A stored insert is reconciled to its real event after response loss.',
        firstAnswer: uncertain,
        replayAnswer: replay,
        confirmedEvent: state.events.find((event) => event.status !== 'cancelled'),
        nativeWrites: state.calendarWrites.filter((write) => write.op === 'insert'),
        calendarWriteLog: state.calendarWriteLog,
        ...(passed
          ? {}
          : {
              productGap:
                'The first terminal failure answer prevents create_event recovery; this is not an accepted outcome.',
            }),
      },
      null,
      2,
    ),
  );
});
for (const probe of [
  {
    action: 'change_event',
    op: 'patch',
    fields: { start: '2026-11-06T14:00:00-08:00', end: '2026-11-06T14:25:00-08:00', send_updates: 'all' },
  },
  { action: 'cancel_event', op: 'delete', fields: { send_updates: 'all' } },
  { action: 'change_guests', op: 'guests', fields: { add: ['remy.vance@example.test'], send_updates: 'all' } },
  { action: 'respond_to_event', op: 'own', fields: { response: 'declined' } },
] as const) {
  const own = probe.action !== 'respond_to_event';
  const event: SyntheticEvent = {
    calendarId: principal,
    id: 'synthetic-recovery-event',
    summary: 'Project brief with Juno',
    location: 'Morgan calls Juno',
    organizer: { email: own ? principal : juno },
    attendees: [
      { email: principal, responseStatus: 'accepted', self: true },
      { email: juno, responseStatus: 'accepted' },
    ],
    start: { dateTime: '2026-11-03T10:00:00-08:00' },
    end: { dateTime: '2026-11-03T10:25:00-08:00' },
  };
  const name = `main-lost-${probe.action}`;
  await host(
    'main',
    async (file) => {
      await callHost(file, 'transport-fault', { op: 'calendar-after-write', write: probe.op });
      const content = {
        action: probe.action,
        requestId: `native-lost-${probe.action}`,
        calendar: principal,
        event: event.id,
        ...probe.fields,
      };
      const first = await callHost(file, 'action', content);
      const replay = await callHost(file, 'action', content);
      const state = await snapshot(file);
      assert.equal(state.calendarWrites.length, 1, 'No repeated invitation or calendar write');
      const current = state.events[0];
      assert.ok(current);
      if (probe.action === 'change_event') assert.equal(current.start?.dateTime, '2026-11-06T22:00:00.000Z');
      else if (probe.action === 'cancel_event') assert.equal(current.status, 'cancelled');
      else if (probe.action === 'change_guests')
        assert.ok(current.attendees?.some((guest) => guest.email === 'remy.vance@example.test'));
      else assert.equal(current.attendees?.find((guest) => guest.email === principal)?.responseStatus, 'declined');
      const passed = (replay as { frame?: { ok: boolean } }).frame?.ok === true;
      const evidence = `${name}/product-recovery-proof.json`;
      productProofs.push({ action: probe.action, passed, evidence });
      fs.writeFileSync(
        path.join(output!, evidence),
        JSON.stringify(
          {
            passed,
            expected: 'A committed write is reconciled to its actual outcome.',
            content,
            firstAnswer: first,
            replayAnswer: replay,
            confirmedEvent: current,
            calendarWriteLog: state.calendarWriteLog,
            ...(passed
              ? {}
              : {
                  productGap:
                    'The first terminal failure answer prevents native recovery; this is not an accepted outcome.',
                }),
          },
          null,
          2,
        ),
      );
    },
    name,
    [event],
  );
}
await host('external-email', async (file) => {
  await callHost(file, 'transport-fault', { op: 'mail-after-send' });
  await action(file, 'email_send', 'native-first-send', {
    subject: 'Project brief',
    text: 'Juno, Tuesday at 9am works.',
  });
  await action(file, 'email_send', 'native-first-send', {
    subject: 'Project brief',
    text: 'Juno, Tuesday at 9am works.',
  });
  let state = await snapshot(file);
  assert.equal(state.mail.length, 1);
  const first = parseGmailMessage(state.mail[0]!);
  assert.deepEqual(
    first.to.map((entry) => entry.address),
    [juno],
  );
  assert.deepEqual(first.cc, []);
  assert.ok(first.rfcMessageId);
  await callHost(file, 'transport-fault', { op: 'mail-after-send' });
  await action(file, 'email_send', 'native-reply-send', { text: 'The project brief is agreed. Thank you, Juno.' });
  await action(file, 'email_send', 'native-reply-send', { text: 'The project brief is agreed. Thank you, Juno.' });
  state = await snapshot(file);
  assert.equal(state.mail.length, 2);
  const reply = parseGmailMessage(state.mail[1]!);
  assert.equal(reply.threadId, first.threadId);
  assert.equal(reply.subject, 'Re: Project brief');
  assert.ok(reply.inReplyTo.includes(first.rfcMessageId!));
  assert.ok(reply.references.includes(first.rfcMessageId!));
  assert.deepEqual(
    reply.to.map((entry) => entry.address),
    [juno],
  );
  assert.equal(state.threadSends.length, 2);
  assert.ok(state.threadSends.every((send) => send.state === 'sent'));
  const finalContent = { text: 'I will send the one-page brief before the meeting.' };
  const delivered = (await callHost(file, 'deliver', {
    content: finalContent,
    messageId: 'native-final-delivery',
  })) as { receipt: { status: string } };
  assert.equal(delivered.receipt.status, 'delivered');
  await callHost(file, 'deliver', { content: finalContent, messageId: 'native-final-delivery' });
  state = await snapshot(file);
  assert.equal(state.mail.length, 3);
  assert.deepEqual(
    parseGmailMessage(state.mail[2]!).to.map((entry) => entry.address),
    [juno],
  );
  assert.equal(state.mail[2]?.threadId, first.threadId);
  for (const [index, kind] of ['in-person', 'video', 'phone'].entries()) {
    const content = {
      title: `Project brief: ${kind}`,
      start: `2026-11-0${3 + index}T17:00:00Z`,
      minutes: 25,
      ...(kind === 'video'
        ? { video_call: true }
        : {
            location:
              kind === 'phone' ? 'Morgan will phone Juno directly' : 'Harbor House, 800 Fiction Lane, San Francisco',
          }),
    };
    if (kind === 'in-person') {
      await callHost(file, 'transport-fault', { op: 'insert-after-write' });
      const firstAnswer = await callHost(file, 'action', {
        action: 'book',
        requestId: `native-book-${kind}`,
        ...content,
      });
      fs.writeFileSync(
        path.join(path.dirname(file), 'lost-book-first-answer.json'),
        JSON.stringify(firstAnswer, null, 2),
      );
    }
    const booked = await action(file, 'book', `native-book-${kind}`, content);
    await action(file, 'book', `native-book-${kind}`, content);
    const event = (await snapshot(file)).events.find((entry) => entry.id === booked.booking);
    assert.ok(event, JSON.stringify(booked));
    assert.ok(event.attendees?.some((entry) => entry.email === juno));
    assert.ok(kind === 'video' ? event.conference?.uri : 'location' in content && event.location === content.location);
  }
  state = await snapshot(file);
  assert.equal(state.events.length, 3);
  assert.equal(state.bookings.length, 3);
  assert.equal(state.calendarWrites.filter((write) => write.op === 'insert').length, 3);
  const booking = state.events[0]!.id;
  await action(file, 'change_booking', 'native-change-booking', { booking, start: '2026-11-06T18:00:00Z' });
  await action(file, 'change_booking', 'native-change-booking', { booking, start: '2026-11-06T18:00:00Z' });
  state = await snapshot(file);
  assert.equal(state.events[0]?.start?.dateTime, '2026-11-06T18:00:00.000Z');
  assert.ok(state.events[0]?.attendees?.some((entry) => entry.email === juno));
  assert.equal(state.calendarWrites.filter((write) => write.op === 'patch').length, 1);
  await action(file, 'cancel_booking', 'native-cancel-booking', { booking });
  await action(file, 'cancel_booking', 'native-cancel-booking', { booking });
  state = await snapshot(file);
  assert.equal(state.events[0]?.status, 'cancelled');
  assert.equal(state.calendarWrites.filter((write) => write.op === 'delete').length, 1);
});
fs.writeFileSync(
  path.join(output, 'result.json'),
  JSON.stringify(
    {
      transportChecksPassed: true,
      modelCalls: 0,
      nativeActions: [
        'create_event',
        'change_event',
        'cancel_event',
        'change_guests',
        'respond_to_event',
        'email_send',
        'book',
        'change_booking',
        'cancel_booking',
      ],
      storedResponseLossRecovery: ['booking insert', 'Gmail first send', 'Gmail reply'],
      productChecksPassed: productProofs.every((proof) => proof.passed),
      productProofs,
      retryDuplicates: 0,
    },
    null,
    2,
  ),
);
console.log(`Native Google transport checks passed: ${output}`);
if (productProofs.some((proof) => !proof.passed)) {
  console.error(
    'Native Calendar recovery product proofs failed; inspect result.json. Transport and booking/Gmail checks completed independently.',
  );
  process.exitCode = 1;
}
