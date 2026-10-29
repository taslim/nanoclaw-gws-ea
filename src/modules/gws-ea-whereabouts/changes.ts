export type WhereaboutsChangeKind = 'base' | 'rhythm' | 'place' | 'pair' | 'travel' | 'stay' | 'dismissal' | 'derived';
export interface WhereaboutsChange {
  readonly kind: WhereaboutsChangeKind;
  readonly changedAt: string;
}
type Listener = (change: WhereaboutsChange) => void | Promise<void>;
const listeners = new Set<Listener>();

export function onWhereaboutsChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Store writers call this after commit, so a reader can load the new snapshot. */
export async function signalWhereaboutsChange(kind: WhereaboutsChangeKind): Promise<void> {
  const change = Object.freeze({ kind, changedAt: new Date().toISOString() });
  for (const listener of listeners) await listener(change);
}

export interface PendingClockItem {
  readonly task: string;
  readonly at: string;
  readonly zone: string;
}
/** Instants; a null end is open. */
export interface ClockSpan {
  readonly start: number;
  readonly end: number | null;
}
type PendingClockReader = (span: ClockSpan) => Promise<readonly PendingClockItem[]>;
let pendingClockReader: PendingClockReader | undefined;

export function registerPendingClockReader(reader: PendingClockReader): void {
  pendingClockReader = reader;
}

export function pendingClockItems(span: ClockSpan): Promise<readonly PendingClockItem[]> {
  return pendingClockReader?.(span) ?? Promise.resolve([]);
}
