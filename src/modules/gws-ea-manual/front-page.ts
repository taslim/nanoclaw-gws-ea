import { getDb } from '../../db/connection.js';
import { TIMEZONE } from '../../config.js';
import { formatLocalTime } from '../../timezone.js';
import { listPeople, type PersonSummary } from '../gws-ea-people/db.js';
import { getSchedulingPreferenceValues, type SchedulingPreferenceValues } from '../gws-ea-preferences/db.js';
import { getGwsEaProfile, type GwsEaProfile } from '../gws-ea-profile/db.js';
import { gaps } from '../gws-ea-whereabouts/gaps.js';
import { getWhereabouts, WEEKDAYS, type Place, type Whereabouts } from '../gws-ea-whereabouts/records.js';
import { loadTimeline, type Timeline } from '../gws-ea-whereabouts/timeline.js';
import {
  getManualSections,
  getWithheldVersions,
  isWithheld,
  MANUAL_KEYS,
  MANUAL_LABELS,
  MANUAL_SECTION_BUDGET_CHARS,
  type ManualSection,
  type WithheldVersion,
} from './db.js';

export { MANUAL_SECTION_BUDGET_CHARS } from './db.js';
export const MANUAL_FRONT_PAGE_BUDGET_CHARS = 8_000;

/** A host snapshot of native stores. No agent-controlled memory file enters composition. */
export interface ManualSnapshot {
  readonly profile: GwsEaProfile;
  readonly whereabouts: Whereabouts;
  readonly timeline: Timeline;
  readonly preferences: SchedulingPreferenceValues;
  readonly innerCircle: readonly PersonSummary[];
  readonly sections: readonly ManualSection[];
  readonly withheld: readonly WithheldVersion[];
}

export function loadManualSnapshot(): Promise<ManualSnapshot> {
  return getDb().transaction(async () => {
    const [profile, whereabouts, timeline, preferences, innerCircle, sections, withheld] = await Promise.all([
      getGwsEaProfile(),
      getWhereabouts(),
      loadTimeline(),
      getSchedulingPreferenceValues(),
      listPeople('inner-circle'),
      getManualSections(),
      getWithheldVersions(),
    ]);
    return { profile, whereabouts, timeline, preferences, innerCircle, sections, withheld };
  });
}

function clock(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

function block(title: string, lines: readonly string[], budget: number, pointer: string): string {
  const full = `${title}\n${lines.join('\n')}`;
  return full.length <= budget ? full : `${title}: read \`${pointer}\` for the complete section.`;
}

function preferenceLines(values: SchedulingPreferenceValues): string[] {
  const source = (value: { readonly source: string }) => ` (${value.source})`;
  return [
    ...values.working_hours.map(
      (value) => `${value.weekday}: ${value.off ? 'not working' : `${value.start}-${value.end}`}${source(value)}`,
    ),
    ...values.protected_windows.map(
      (value) => `Protected ${value.weekdays.join(',')} ${value.start}-${value.end}${source(value)}`,
    ),
    ...values.meeting_lengths.map(
      (value) => `${value.meeting_kind} meetings: ${value.minutes} minutes${source(value)}`,
    ),
    ...values.buffers.map((value) => `${value.meeting_kind} buffer: ${value.minutes} minutes${source(value)}`),
    ...values.preferred_times.map(
      (value) =>
        `${value.meeting_kind}: prefer ${value.weekdays.join(',')} ${value.start}-${value.end}${source(value)}`,
    ),
    ...(values.meal_windows ?? []).map(
      (value) =>
        `${value.meal}: ${value.weekdays.join(',')} ${value.start}-${value.end}; ${value.minutes} minutes free${source(value)}`,
    ),
    ...(values.back_to_back ?? []).map(
      (value) =>
        `Back-to-back: ${value.minutes} minutes, breaks at least ${value.break_minutes} minutes${source(value)}`,
    ),
    ...(values.ignored_events ?? []).map(
      (value) => `Ignore calendar copies with ID prefix ${value.prefix}${source(value)}`,
    ),
  ];
}

/**
 * Pure renderer also used by live views after a Manual edit or compaction.
 * to: main
 */
export function renderManualFrontPage(snapshot: ManualSnapshot): string {
  const { profile, whereabouts, sections, withheld } = snapshot;
  const hiddenPlaces = new Set(
    whereabouts.places.filter((place) => isWithheld(withheld, 'place', place.id, place)).map((place) => place.id),
  );
  const hiddenStays = new Set(
    whereabouts.stays
      .filter(
        (stay) =>
          isWithheld(withheld, 'stay', stay.id, stay) || (stay.place_id !== null && hiddenPlaces.has(stay.place_id)),
      )
      .map((stay) => stay.id),
  );
  const hiddenEvents = new Set(
    whereabouts.stays
      .filter((stay) => hiddenStays.has(stay.id))
      .flatMap((stay) => (stay.source_event_id === null ? [] : [stay.source_event_id])),
  );
  const places = whereabouts.places.filter((place) => !hiddenPlaces.has(place.id));
  const placeById = (id: string): Place | undefined => places.find((place) => place.id === id);
  const home = whereabouts.base.home_place_id === null ? undefined : placeById(whereabouts.base.home_place_id);
  const selected = new Set([whereabouts.base.home_place_id, ...whereabouts.rhythm.map((entry) => entry.place_id)]);
  const rhythm = WEEKDAYS.flatMap((day) => whereabouts.rhythm.filter((entry) => entry.weekday === day));
  const placeLabel = (id: string): string => placeById(id)?.label ?? 'place awaiting rewrite';
  const namedPlace = (place: Place): string =>
    `${place.label}: ${place.locality} (${place.is_home ? (profile.principal_timezone ?? 'zone unknown') : (place.zone ?? 'zone unknown')})`;
  const nativePreferences = preferenceLines(snapshot.preferences);
  const safeTimeline: Timeline = {
    ...snapshot.timeline,
    legs: snapshot.timeline.legs.filter((leg) => !hiddenEvents.has(leg.sourceEventId)),
  };
  const manualTripSource = sections.some(
    (section) =>
      section.key === 'travel-sources' &&
      section.text.trim() !== '' &&
      !isWithheld(withheld, 'section', section.key, section.text),
  );
  const missing = gaps(safeTimeline).filter((gap) => gap.kind !== 'trip-source' || !manualTripSource);
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
        ...(home === undefined && whereabouts.base.home_place_id !== null
          ? ['Home base: awaiting rewrite; read `ncl whereabouts get`.']
          : []),
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
        ...places.filter((place) => selected.has(place.id)).map(namedPlace),
        `${places.filter((place) => !selected.has(place.id)).length} other saved places; read \`ncl whereabouts get\`.`,
        ...(whereabouts.pairs.length === 0
          ? []
          : [
              block(
                `${whereabouts.pairs.length} saved travel pair${whereabouts.pairs.length === 1 ? '' : 's'}`,
                whereabouts.pairs
                  .filter((pair) => !hiddenPlaces.has(pair.from_place_id) && !hiddenPlaces.has(pair.to_place_id))
                  .map(
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
      nativePreferences.length === 0
        ? ['None recorded. Read `ncl preferences get` before scheduling; it is the live store.']
        : [
            "Times are local to the principal's whereabouts; read `ncl preferences get` before scheduling.",
            ...nativePreferences,
          ],
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
      if (section.text.length > MANUAL_SECTION_BUDGET_CHARS || isWithheld(withheld, 'section', key, section.text))
        return `${label}: read \`ncl manual get --section ${key}\` (full section${isWithheld(withheld, 'section', key, section.text) ? '; awaiting rewrite after a forget' : ''}).`;
      return `${label} (${formatLocalTime(section.updated_at, TIMEZONE)})\n${section.text}`;
    }),
    ...(gapLine === undefined ? [] : [gapLine]),
  ].join('\n\n');
}

export async function loadManualFrontPage(): Promise<string> {
  return renderManualFrontPage(await loadManualSnapshot());
}
