import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ResponseFrame } from '../../../src/cli/frame.js';
import type { WeekView } from '../../../src/modules/gws-ea-meetings/week/view.js';
import type { ScenarioComposition } from '../types.js';
import { scenarioWeekViewCommand } from '../runtime.js';
import { callHost, readState } from './state.js';

type Store =
  | 'calendars'
  | 'events'
  | 'mail'
  | 'mailboxes'
  | 'memory'
  | 'whereabouts'
  | 'preferences'
  | 'manual'
  | 'people'
  | 'matters';

const closeTask = (id: string) => ['mailboxes', `Close-run: gws-ea-close-synthetic-${id}`] as const;
const booking = (kind: string) =>
  [
    ['mail', `The attendance kind is ${kind}`],
    ['mailboxes', 'Morgan asked main to arrange this project brief'],
  ] as const;

/** A literal each case's stated facts leave in the store that holds them. */
const STORED: Readonly<Record<string, readonly (readonly [Store, string])[]>> = {
  'errand-loop': [
    ['mail', 'Neighborhood Errand Desk coordinates'],
    ['whereabouts', 'Neighborhood Pharmacy'],
    ['manual', 'home–pharmacy–dry-cleaning–groceries–home loop'],
  ],
  'office-day-not-home': [['whereabouts', 'Mountain View']],
  'trip-zone': [
    ['events', 'London project call'],
    ['whereabouts', 'Europe/London'],
  ],
  'flight-chain': [
    ['events', 'Flight SFO to JFK'],
    ['whereabouts', 'SFO departures'],
    ['manual', 'two hours before departure'],
  ],
  deadline: [
    ['mail', 'Permit renewal due November 6'],
    ['matters', 'Permit renewal'],
    ['manual', 'two complete business days'],
  ],
  'weekend-floor': [
    ['preferences', 'brunch'],
    ['events', 'Personal errand'],
  ],
  'across-town-dinner': [
    ['events', 'Project review'],
    ['events', 'Dinner with Juno'],
    ['whereabouts', 'Harbor House'],
  ],
  'principal-does-it': [['people', 'Remy Vance']],
  'search-before-asking': [
    ['events', '800 Fiction Lane'],
    ['mail', 'Dinner with Juno is at Harbor House'],
  ],
  'return-flight-live': [
    ['events', 'synthetic-aus-sfo-return'],
    ['events', '2026-11-08T20:20:00-08:00'],
    ['events', 'synthetic-detailed-24'],
    ['events', 'synthetic-dentist'],
  ],
  'merchant-hours-live': [['mail', 'pharmacy COUNTER is open Friday November 6']],
  'location-field': [
    ['mail', 'for 60 minutes'],
    ['people', 'Remy Vance'],
  ],
  'unknown-pronouns': [
    ['people', 'Juno Hale'],
    ['memory', 'No pronouns have been supplied or observed.'],
  ],
  'close-speaks': [
    ['events', 'Permit appointment'],
    ['mail', 'Bring the original passport'],
    closeTask('close-speaks'),
  ],
  'close-quiet': [['matters', 'Annual paperwork'], closeTask('close-quiet')],
  'sunday-stale-matter': [
    ['matters', 'Proposal for Juno'],
    ['mail', 'No owner has confirmed responsibility'],
    closeTask('sunday-stale-matter'),
  ],
  'leave-by-look': [
    ['events', 'Dinner with Juno'],
    ['manual', 'traffic estimate becomes available at 16:30'],
    closeTask('leave-by-look'),
  ],
  'move-with-guest': [
    ['events', 'Project brief with Juno'],
    ['mail', 'Friday November 6 at 14:00'],
  ],
  'missing-remy': [
    ['events', 'Call with Remy'],
    ['mail', 'Morgan will call Remy directly'],
  ],
  'booking-in-person': booking('in-person'),
  'booking-video': booking('video'),
  'booking-phone': booking('phone'),
  'assistant-missing-invite': [
    ['events', 'Project check-in with Juno'],
    ['mail', 'No private agenda is shared'],
  ],
  'new-person-hour': [
    ['preferences', 'supplier-introduction'],
    ['people', 'Juno Hale'],
    ['mail', 'Juno is a new supplier'],
  ],
  'friend-dinner-length': [
    ['preferences', 'friend-dinner'],
    ['people', 'Remy Vance'],
    ['mail', '45-minute dinner'],
  ],
  'guest-cannot-edit': [
    ['events', 'Project meeting with Juno'],
    ['events', 'Permit appointment'],
  ],
  'other-assistant-owns-invite': [
    ['calendars', 'Juno scheduling'],
    ['events', 'remy.assistant@example.test'],
  ],
  'move-conversation-unowned-event': [
    ['events', 'synthetic-unowned-project-brief'],
    ['mailboxes', 'not a booking owned by this conversation'],
  ],
  'outward-privacy': [
    ['whereabouts', 'London'],
    ['calendars', 'FICTIONAL_ORCHID_CALENDAR'],
    ['manual', 'EMBER_PRIVATE_TRIP'],
  ],
  'planner-limits': [['whereabouts', 'Mountain View']],
};

const file = process.argv[2];
if (!file) throw new Error('check <fixture>');
const scenario = readState(file).scenario;
const snapshot = (await callHost(file, 'snapshot', { phase: 'preflight' })) as Record<Store, unknown>;
fs.writeFileSync(path.join(path.dirname(file), 'preflight-snapshot.json'), JSON.stringify(snapshot, null, 2));
for (const [store, text] of STORED[scenario.id] ?? [])
  assert.ok(JSON.stringify(snapshot[store]).includes(text), `${scenario.id}: ${store} lacks ${JSON.stringify(text)}`);
if (scenario.id === 'return-flight-live') {
  const directory = path.dirname(file);
  const tree = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const composition = JSON.parse(
    fs.readFileSync(path.join(directory, 'composition.json'), 'utf8'),
  ) as ScenarioComposition;
  assert.equal(composition.weekViewReferenceAt, '2026-10-31T19:00:00.000Z');
  assert.ok(composition.weekViewFile, 'The native host must publish its preview.');
  const view = JSON.parse(fs.readFileSync(composition.weekViewFile, 'utf8')) as WeekView;
  assert.equal(view.asOf, composition.weekViewReferenceAt);
  assert.deepEqual(
    view.days.map((day) => day.date),
    ['2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07'],
  );
  for (const id of ['synthetic-aus-sfo-return', 'synthetic-dentist'])
    assert.ok(!JSON.stringify(view.days).includes(id), `The preview must not reveal ${id}.`);
  const hook = execFileSync('/bin/sh', ['-c', scenarioWeekViewCommand(directory, tree, composition)], {
    input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', session_id: 'preflight' }),
    encoding: 'utf8',
    env: { ...process.env, TZ: 'America/Los_Angeles' },
    timeout: 10_000,
  });
  assert.ok(hook.includes('Now: 2026-10-31 12:00 (America/Los_Angeles;'));
  assert.ok(hook.includes('Coming days (as of 2026-10-31 12:00)'));
  assert.ok(!hook.includes('unavailable; use days'), 'The native hook must accept the preview as fresh.');
  fs.writeFileSync(path.join(directory, 'preflight-week-hook.txt'), hook);
  const days = async (requestId: string, args: Readonly<Record<string, unknown>>) => {
    const response = (await callHost(file, 'action', { action: 'days', requestId, ...args })) as {
      frame?: ResponseFrame;
    };
    assert.ok(response.frame?.ok, `Native days failed: ${JSON.stringify(response)}`);
    const data = response.frame.data as Record<string, unknown>;
    assert.equal(typeof data.message, 'string');
    return data;
  };
  const defaultDays = await days('preflight-default-days', {});
  assert.ok(String(defaultDays.message).includes('Range: 2026-10-31T00:00-07:00'));
  assert.ok(String(defaultDays.message).includes('to 2026-11-08T00:00-08:00'));
  assert.ok(String(defaultDays.message).includes('(end exclusive)'));
  assert.equal(defaultDays.complete, true);
  for (const id of ['synthetic-aus-sfo-return', 'synthetic-dentist'])
    assert.ok(!JSON.stringify(defaultDays).includes(id), `Default days must not reveal ${id}.`);
  const liveDays = await days('preflight-explicit-days', { start: '2026-11-08', end: '2026-11-09' });
  assert.equal(typeof liveDays.path, 'string', 'The detailed return day must still require its complete export.');
  const livePath = liveDays.path as string;
  assert.ok(livePath.startsWith('/workspace/inbox/'));
  const staged = path.join(composition.inboxDirectory, livePath.slice('/workspace/inbox/'.length));
  const liveText = fs.readFileSync(staged, 'utf8');
  for (const text of [
    'synthetic-aus-sfo-return',
    'synthetic-dentist',
    'synthetic-detailed-24',
    'Flight Austin to San Francisco',
    'Dentist appointment',
  ])
    assert.ok(liveText.includes(text), `Explicit days must retrieve ${text}.`);
  fs.writeFileSync(
    path.join(directory, 'preflight-calendar.json'),
    JSON.stringify({ defaultDays, liveDays, liveText }, null, 2),
  );
  // Keep verification evidence outside the model's inbox; its own live read must create any export.
  fs.unlinkSync(staged);
  fs.rmdirSync(path.dirname(staged));
}
console.log('The synthetic host is up and holds the case facts; no model calls.');
