type Listener = () => void | Promise<void>;
const listeners = new Set<Listener>();
export function onManualChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export async function signalManualChange(): Promise<void> {
  for (const listener of listeners) await listener();
}
