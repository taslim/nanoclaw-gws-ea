import { createHash } from 'node:crypto';

/** The refresher supplies structural fields only. Event ids identify a source across later revisions. */
export interface TravelEvent {
  readonly id: string;
  readonly status?: string;
  readonly etag?: string;
  readonly location?: string;
  readonly principalDeclined?: boolean;
  readonly attendees?: readonly {
    readonly self?: boolean;
    readonly responseStatus?: string;
    readonly email?: string;
  }[];
  readonly start?: { readonly dateTime?: string; readonly timeZone?: string };
  readonly end?: { readonly dateTime?: string; readonly timeZone?: string };
}
export interface DerivedLeg {
  readonly sourceEventId: string;
  readonly sourceVersion: string;
  readonly departure: number;
  readonly arrival: number;
  readonly departureZone: string;
  readonly destinationZone: string;
  readonly locality: string;
  /** Destination is held until the next departure; the final leg stays open. */
  readonly end: number | null;
}

/** Pure derivation; guest answers and etags are deliberately absent from the digest. */
export function deriveLegs(events: readonly TravelEvent[]): DerivedLeg[] {
  const legs: DerivedLeg[] = [];
  for (const event of events) {
    if (
      event.status === 'cancelled' ||
      event.principalDeclined ||
      event.attendees?.some((a) => a.self && a.responseStatus === 'declined')
    )
      continue;
    const departureZone = event.start?.timeZone;
    const destinationZone = event.end?.timeZone;
    const departure = Date.parse(event.start?.dateTime ?? '');
    const arrival = Date.parse(event.end?.dateTime ?? '');
    if (
      !departureZone ||
      !destinationZone ||
      departureZone === destinationZone ||
      !Number.isFinite(departure) ||
      !Number.isFinite(arrival) ||
      arrival <= departure
    )
      continue;
    const locality = event.location?.trim() || destinationZone;
    const sourceVersion = createHash('sha256')
      .update(
        JSON.stringify([
          event.start?.dateTime,
          event.end?.dateTime,
          departureZone,
          destinationZone,
          event.location ?? null,
        ]),
      )
      .digest('hex');
    legs.push({
      sourceEventId: event.id,
      sourceVersion,
      departure,
      arrival,
      departureZone,
      destinationZone,
      locality,
      end: null,
    });
  }
  legs.sort((a, b) => a.departure - b.departure || a.sourceEventId.localeCompare(b.sourceEventId));
  return legs.map((leg, index) => ({ ...leg, end: legs[index + 1]?.departure ?? null }));
}
