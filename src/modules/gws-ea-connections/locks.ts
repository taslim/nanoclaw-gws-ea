/**
 * Serializes work per key in this host. One app's credential work takes its app's key: a renewal, a connect, a
 * disconnect and a delete run one step at a time, so a renewal finishing after a disconnect can never publish the
 * token again.
 */
const tails = new Map<string, Promise<unknown>>();

export async function withAppLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  const run = previous.then(work, work);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  tails.set(key, tail);
  try {
    return await run;
  } finally {
    if (tails.get(key) === tail) tails.delete(key);
  }
}
