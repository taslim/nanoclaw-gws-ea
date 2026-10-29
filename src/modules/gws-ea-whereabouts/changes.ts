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
