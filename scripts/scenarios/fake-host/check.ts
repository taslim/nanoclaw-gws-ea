import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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
console.log('The synthetic host is up and holds the case facts; no model calls.');
