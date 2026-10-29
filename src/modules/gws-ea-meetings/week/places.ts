import type { Timeline } from '../../gws-ea-whereabouts/timeline.js';

export interface ResolvedPlace {
  readonly kind: 'known' | 'unknown' | 'remote' | 'none';
  readonly id: string | null;
  readonly label: string;
  readonly locality: string | null;
  readonly home: boolean;
}
const normalize = (value: string): string => value.trim().replace(/\s+/gu, ' ').toLowerCase();

/** Private home values are used only for matching; the resolved fact retains its public label. */
export function resolvePlace(
  location: string | undefined,
  timeline: Timeline,
  privateValues: Readonly<Record<string, string>> = {},
): ResolvedPlace {
  const text = location?.trim() ?? '';
  const empty = { id: null, label: text, locality: null, home: false };
  if (!text) return { kind: 'none', ...empty };
  if (
    /https?:\/\/|\btel:|\b(?:zoom|meet|teams)\.[\w.]+/iu.test(text) ||
    /^\+?[\d\s().-]{7,}(?:\s*(?:ext\.?|x)\s*\d+)?$/iu.test(text)
  )
    return { kind: 'remote', ...empty };
  const key = normalize(text);
  const place = timeline.places.find((p) =>
    [p.id, p.label, p.private_value_id ? privateValues[p.private_value_id] : undefined].some(
      (value) => value !== undefined && normalize(value) === key,
    ),
  );
  return place
    ? {
        kind: 'known',
        id: place.id,
        label: place.label,
        locality: place.locality,
        home: place.id === timeline.base.home_place_id,
      }
    : { kind: 'unknown', ...empty };
}
export interface TravelFact {
  readonly minutes: number | null;
  readonly mode: string | null;
  readonly source: 'learned' | 'estimated' | null;
}
export function travelBetween(from: ResolvedPlace, to: ResolvedPlace, eventId: string, timeline: Timeline): TravelFact {
  if (from.id !== null && from.id === to.id) return { minutes: 0, mode: null, source: null };
  const pair = timeline.pairs.find((p) => p.from_place_id === from.id && p.to_place_id === to.id);
  const fact = pair ?? timeline.travel.find((t) => t.event_id === eventId);
  return fact
    ? { minutes: fact.minutes, mode: fact.mode, source: fact.source }
    : { minutes: null, mode: null, source: null };
}
