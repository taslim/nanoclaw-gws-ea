import type { Timeline } from './timeline.js';

export interface WhereaboutsGap {
  readonly kind: 'home' | 'rhythm' | 'trip-source' | 'return';
  readonly message: string;
  readonly sourceEventId?: string;
}

export function gaps(timeline: Timeline): WhereaboutsGap[] {
  const result: WhereaboutsGap[] = [];
  if (!timeline.base.home_place_id) result.push({ kind: 'home', message: 'home base not set' });
  if (!timeline.base.rhythm_known)
    result.push({ kind: 'rhythm', message: 'commute days not set (record none if there are none)' });
  if (timeline.base.trip_source === null)
    result.push({ kind: 'trip-source', message: 'trip source not set (record none if there is none)' });
  for (const leg of timeline.legs)
    if (leg.returnUnknown)
      result.push({
        kind: 'return',
        sourceEventId: leg.sourceEventId,
        message: `return from ${leg.destinationZone ?? 'an unknown zone'} unknown`,
      });
  return result;
}
