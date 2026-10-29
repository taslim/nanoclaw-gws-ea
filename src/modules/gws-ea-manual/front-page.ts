import { getDb } from '../../db/connection.js';
import { TIMEZONE } from '../../config.js';
import { formatLocalTime } from '../../timezone.js';
import { listPeople, type PersonSummary } from '../gws-ea-people/db.js';
import { getSchedulingPreferenceValues, type SchedulingPreferenceValues } from '../gws-ea-preferences/db.js';
import { summarizeSchedulingPreferences } from '../gws-ea-preferences/index.js';
import { getGwsEaProfile, type GwsEaProfile } from '../gws-ea-profile/db.js';
import { gaps } from '../gws-ea-whereabouts/gaps.js';
import { getWhereabouts, WEEKDAYS, type Place, type Whereabouts } from '../gws-ea-whereabouts/records.js';
import { loadTimeline, type Timeline } from '../gws-ea-whereabouts/timeline.js';
import {
  getManualSections,
  MANUAL_KEYS,
  MANUAL_LABELS,
  MANUAL_SECTION_BUDGET_CHARS,
  type ManualSection,
} from './db.js';

export { MANUAL_SECTION_BUDGET_CHARS } from './db.js';
export const MANUAL_FRONT_PAGE_BUDGET_CHARS = 8_000;

/** A host snapshot of native stores. No agent-controlled memory file enters composition. */
interface ManualSnapshot {
  readonly profile: GwsEaProfile;
  readonly whereabouts: Whereabouts;
  readonly timeline: Timeline;
  readonly preferences: SchedulingPreferenceValues;
  readonly innerCircle: readonly PersonSummary[];
  readonly sections: readonly ManualSection[];
}

function loadManualSnapshot(timelineSnapshot?: Timeline): Promise<ManualSnapshot> {
  return getDb().transaction(async () => {
    const [profile, whereabouts, timeline, preferences, innerCircle, sections] = await Promise.all([
      getGwsEaProfile(),
      getWhereabouts(),
      timelineSnapshot ?? loadTimeline(),
      getSchedulingPreferenceValues(),
      listPeople('inner-circle'),
      getManualSections(),
    ]);
    return { profile, whereabouts, timeline, preferences, innerCircle, sections };
  });
}

function clock(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

function block(title: string, lines: readonly string[], budget: number, pointer: string): string {
  const full = `${title}\n${lines.join('\n')}`;
  return full.length <= budget ? full : `${title}: read \`${pointer}\` for the complete section.`;
}

/** to: main */
function renderManualSections(snapshot: ManualSnapshot): string[] {
  const { profile, whereabouts, sections } = snapshot;
  const places = new Map(whereabouts.places.map((place) => [place.id, place]));
  const home = whereabouts.base.home_place_id === null ? undefined : places.get(whereabouts.base.home_place_id);
  const selected = new Set([whereabouts.base.home_place_id, ...whereabouts.rhythm.map((entry) => entry.place_id)]);
  const rhythm = WEEKDAYS.flatMap((day) => whereabouts.rhythm.filter((entry) => entry.weekday === day));
  const placeLabel = (id: string): string => places.get(id)?.label ?? id;
  const namedPlace = (place: Place): string =>
    `${place.label}: ${place.locality} (${place.id === whereabouts.base.home_place_id ? (profile.principal_timezone ?? 'zone unknown') : (place.zone ?? 'zone unknown')})`;
  const preferences = summarizeSchedulingPreferences(snapshot.preferences);
  const missing = gaps(snapshot.timeline);
  const message = (gap: (typeof missing)[number]) =>
    gap.kind === 'trip-source' ? 'Trips: no source yet' : gap.message;
  let gapLine = missing.length === 0 ? undefined : `Whereabouts gaps: ${missing.map(message).join('; ')}.`;
  if (gapLine !== undefined && gapLine.length > 200) {
    const durable = missing
      .filter((gap) => gap.kind !== 'return')
      .map((gap) => (gap.kind === 'rhythm' ? 'commute days not set' : message(gap)));
    const returns = missing.filter((gap) => gap.kind === 'return').length;
    gapLine = `Whereabouts gaps: ${[...durable, ...(returns === 0 ? [] : [`${returns} return dates unknown; read \`ncl whereabouts get\``])].join('; ')}.`;
  }

  return [
    block(
      'Profile',
      [
        profile.principal_display_name ?? 'Principal name not set',
        `Home time zone: ${profile.principal_timezone ?? 'zone unknown'}`,
      ],
      350,
      'ncl principal-profile get',
    ),
    block(
      'Base and weekly rhythm',
      [
        ...(home === undefined ? [] : [`Home base: ${namedPlace(home)}`]),
        ...(whereabouts.base.trip_source === null ? [] : [`Trips: ${whereabouts.base.trip_source}`]),
        ...(whereabouts.base.rhythm_known
          ? rhythm.length === 0
            ? ['Commute days: none']
            : rhythm.map(
                (entry) =>
                  `${entry.weekday} ${clock(entry.start_minute)}-${clock(entry.end_minute)}: ${placeLabel(entry.place_id)}`,
              )
          : []),
      ],
      1_400,
      'ncl whereabouts get',
    ),
    block(
      'Places and travel',
      [
        ...whereabouts.places.filter((place) => selected.has(place.id)).map(namedPlace),
        `${whereabouts.places.filter((place) => !selected.has(place.id)).length} other saved places; read \`ncl whereabouts get\`.`,
        ...(whereabouts.pairs.length === 0
          ? []
          : [
              block(
                `${whereabouts.pairs.length} saved travel pair${whereabouts.pairs.length === 1 ? '' : 's'}`,
                whereabouts.pairs.map(
                  (pair) =>
                    `${placeLabel(pair.from_place_id)} to ${placeLabel(pair.to_place_id)}: ${pair.minutes} minutes by ${pair.mode} (${pair.source})`,
                ),
                200,
                'ncl whereabouts get',
              ),
            ]),
      ],
      600,
      'ncl whereabouts get',
    ),
    block(
      'Scheduling preferences',
      preferences === undefined
        ? ['None recorded. Read `ncl preferences get` before scheduling; it is the live store.']
        : ['Read `ncl preferences get` before scheduling; it is the live store.', preferences],
      750,
      'ncl preferences get',
    ),
    block(
      'Inner circle',
      snapshot.innerCircle.length === 0 ? ['None recorded.'] : snapshot.innerCircle.map((person) => `- ${person.name}`),
      500,
      'ncl people list --level inner-circle',
    ),
    ...MANUAL_KEYS.map((key) => {
      const section = sections.find((candidate) => candidate.key === key);
      const label = MANUAL_LABELS[key];
      if (section === undefined || section.text.trim() === '') return `${label}: not recorded.`;
      if (section.text.length > MANUAL_SECTION_BUDGET_CHARS)
        return `${label}: read \`ncl manual get --section ${key}\` (full section).`;
      return `${label} (${formatLocalTime(section.updated_at, TIMEZONE)})\n${section.text}`;
    }),
    ...(gapLine === undefined ? [] : [gapLine]),
  ];
}

export async function loadManualSections(timeline?: Timeline): Promise<string[]> {
  return renderManualSections(await loadManualSnapshot(timeline));
}

export async function loadManualFrontPage(timeline?: Timeline): Promise<string> {
  return (await loadManualSections(timeline)).join('\n\n');
}
