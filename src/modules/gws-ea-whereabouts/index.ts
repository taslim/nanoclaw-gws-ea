import { registerResource, type ColumnDef } from '../../cli/crud.js';
import { getDb } from '../../db/connection.js';
import { registerMigration } from '../../db/migrations/index.js';
import { pendingClockItems } from './changes.js';
import { untrusted } from '../gws-ea-inbox/untrusted.js';
import { assertMainCaller } from '../gws-ea-profile/db.js';
import {
  addPlace,
  addStay,
  dismissStay,
  getWhereabouts,
  getWhereaboutsHistory,
  setBase,
  setEventTravel,
  setPlacePair,
  setRhythm,
} from './db.js';
import { gaps } from './gaps.js';
import { gwsEaWhereaboutsMigration } from './migration.js';
import { loadTimeline } from './timeline.js';

registerMigration(gwsEaWhereaboutsMigration);

function optional(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`--${key.replace(/_/gu, '-')} must be text`);
  return value;
}
function required(args: Record<string, unknown>, key: string): string {
  const value = optional(args, key);
  if (value === undefined) throw new Error(`--${key.replace(/_/gu, '-')} is required`);
  return value;
}
function minutes(args: Record<string, unknown>): number {
  if (typeof args.minutes !== 'number') throw new Error('--minutes is required');
  return args.minutes;
}
const arg = (name: string, description: string, type: ColumnDef['type'] = 'string'): ColumnDef => ({
  name,
  type,
  description,
});
const placeArg = arg('place', 'Saved place id. A saved place supplies its locality and zone.');
const sourceArg = arg('source', 'Stay: calendar, mail, or said. Travel: learned or estimated.');
const modeArg = arg('mode', 'Usual travel mode, such as walk, rail, or drive.');
const minutesArg = arg('minutes', 'Whole travel minutes.', 'number');
const eventArg = arg('event', 'Stable source event id, including its calendar identity when needed.');
const startArg = arg('start', 'Stay: date YYYY-MM-DD or instant with offset. Rhythm: local HH:MM.');
const endArg = arg(
  'end',
  'Stay: inclusive last date or exclusive instant; omitted ends today. Rhythm: local HH:MM, including 24:00.',
);

registerResource({
  name: 'whereabouts',
  plural: 'whereabouts',
  table: 'gws_ea_whereabouts_base',
  idColumn: 'singleton',
  description:
    'Main-only home, weekly rhythm, saved places, travel times and dated stays. Home uses the live principal profile zone. A one-off stay never changes home or the rhythm.',
  columns: [],
  operations: {},
  customOperations: {
    get: {
      access: 'open',
      description: 'Read stored whereabouts, one timeline snapshot and missing durable facts.',
      args: [],
      formatHuman: (value) => {
        return JSON.stringify(value, function (this: Record<string, unknown>, key: string, field: unknown): unknown {
          const calendar =
            this.source === 'calendar' ||
            this.derived === true ||
            this.derived === 1 ||
            typeof this.sourceEventId === 'string' ||
            (Array.isArray(this.sourceEventIds) && this.sourceEventIds.length > 0);
          return key === 'locality' && typeof field === 'string' && calendar
            ? untrusted(field, field.length, 'calendar locality')
            : field;
        });
      },
      handler: async (_args, ctx) => {
        await assertMainCaller(ctx, 'whereabouts');
        return getDb().transaction(async () => {
          const data = await getWhereabouts();
          const timeline = await loadTimeline();
          return { ...data, timeline, gaps: gaps(timeline) };
        });
      },
    },
    'base set': {
      access: 'open',
      description:
        'Set the home place or trip source, keeping the previous value in history. Use --trip-source none when no trip source is available. Home locality is a saved place; its address links to a private value and its zone always comes from the profile.',
      args: [placeArg, arg('trip_source', 'How trips become visible; none records that there is no source.')],
      handler: async (args, ctx) => {
        await assertMainCaller(ctx, 'whereabouts');
        return setBase({ placeId: optional(args, 'place'), tripSource: optional(args, 'trip_source') });
      },
    },
    'rhythm set': {
      access: 'open',
      description:
        'Set commute weekdays with place and local start/end, retaining previous values. Other weekdays keep their rhythm. --weekdays none records no commute and clears the rhythm.',
      args: [arg('weekdays', 'Comma-separated mon,tue,wed,thu,fri,sat,sun, or none.'), placeArg, startArg, endArg],
      handler: async (args, ctx) => {
        await assertMainCaller(ctx, 'whereabouts');
        const weekdays = required(args, 'weekdays');
        return setRhythm({
          weekdays: weekdays === 'none' ? [] : weekdays.split(',').map((day) => day.trim()),
          placeId: optional(args, 'place'),
          start: optional(args, 'start'),
          end: optional(args, 'end'),
        });
      },
    },
    'place add': {
      access: 'open',
      description:
        'Add or update a saved place with locality and IANA zone. --id updates the place and all its stays use its current zone. --private-value links home to an existing private address; the address itself stays in the privacy store. --home records home locality even before its address is known.',
      args: [
        arg('id', 'Saved place id; omitted creates one.'),
        arg('label', 'What the principal calls this place.'),
        arg('locality', 'City or locality.'),
        arg('zone', 'IANA zone; unknown leaves it unknown. Home never stores a zone.'),
        arg('private_value', 'Home address handle from the privacy store.'),
        arg('home', 'This is a home place.', 'boolean'),
      ],
      handler: async (args, ctx) => {
        await assertMainCaller(ctx, 'whereabouts');
        return addPlace({
          id: optional(args, 'id'),
          label: required(args, 'label'),
          locality: required(args, 'locality'),
          zone: optional(args, 'zone'),
          privateValueId: optional(args, 'private_value'),
          home: args.home === true,
        });
      },
    },
    'pair set': {
      access: 'open',
      description:
        'Record a usual directional travel time and mode between two saved places, from a learned value or a stated estimate.',
      args: [
        arg('from', 'Origin saved place id.'),
        arg('to', 'Destination saved place id.'),
        modeArg,
        minutesArg,
        sourceArg,
      ],
      handler: async (args, ctx) => {
        await assertMainCaller(ctx, 'whereabouts');
        return setPlacePair({
          fromPlaceId: required(args, 'from'),
          toPlaceId: required(args, 'to'),
          mode: required(args, 'mode'),
          minutes: minutes(args),
          source: required(args, 'source'),
        });
      },
    },
    'travel set': {
      access: 'open',
      description: 'Record a travel estimate for one event. Repeat places belong in pair set.',
      args: [eventArg, modeArg, minutesArg, sourceArg],
      handler: async (args, ctx) => {
        await assertMainCaller(ctx, 'whereabouts');
        return setEventTravel({
          eventId: required(args, 'event'),
          mode: required(args, 'mode'),
          minutes: minutes(args),
          source: required(args, 'source'),
        });
      },
    },
    'stay add': {
      access: 'open',
      description:
        'Record or update a dated stay from calendar, mail or speech. A saved place supplies the zone; somewhere new takes --locality and --zone. A booking or forwarded confirmation is certain; a mention is tentative. Without --end the stay ends today. --working-hours home keeps home working hours. Recording a source event undoes its dismissal.',
      args: [
        arg('id', 'Stay id to update.'),
        placeArg,
        arg('locality', 'Locality for a place not saved.'),
        arg('zone', 'IANA zone for a place not saved; unknown is explicit.'),
        startArg,
        endArg,
        sourceArg,
        arg('certainty', 'certain or tentative.'),
        arg('working_hours', 'local (default) or home.'),
        eventArg,
        arg('source_version', 'Digest of the structural source fields, when known.'),
      ],
      handler: async (args, ctx) => {
        await assertMainCaller(ctx, 'whereabouts');
        const stay = await addStay({
          id: optional(args, 'id'),
          placeId: optional(args, 'place'),
          locality: optional(args, 'locality'),
          zone: optional(args, 'zone'),
          start: required(args, 'start'),
          end: optional(args, 'end'),
          source: required(args, 'source'),
          certainty: required(args, 'certainty'),
          workingHours: optional(args, 'working_hours'),
          sourceEventId: optional(args, 'event'),
          sourceVersion: optional(args, 'source_version'),
        });
        return { ...stay, pending_local_items: await pendingClockItems(await loadTimeline()) };
      },
    },
    'stay dismiss': {
      access: 'open',
      description:
        'Dismiss a stay or a source event with why. A source-event dismissal persists through airline changes until stay add records that event again.',
      args: [arg('id', 'Stay id.'), eventArg, arg('reason', 'Why this stay or flight is not the principal’s.')],
      handler: async (args, ctx) => {
        await assertMainCaller(ctx, 'whereabouts');
        return dismissStay({
          id: optional(args, 'id'),
          sourceEventId: optional(args, 'event'),
          reason: required(args, 'reason'),
        });
      },
    },
    history: {
      access: 'open',
      description: 'Read previous and current values of base and rhythm edits.',
      args: [],
      handler: async (_args, ctx) => {
        await assertMainCaller(ctx, 'whereabouts');
        return getWhereaboutsHistory();
      },
    },
  },
});
