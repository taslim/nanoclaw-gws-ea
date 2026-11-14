/**
 * One app's credential work runs one step at a time in this host: a renewal,
 * a connect, a disconnect and a delete all take the same lock, so a renewal
 * finishing after a disconnect can never publish the token again.
 */
const tails = new Map<string, Promise<unknown>>();

export async function withAppLock<T>(appId: string, work: () => Promise<T>): Promise<T> {
  const previous = tails.get(appId) ?? Promise.resolve();
  const run = previous.then(work, work);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  tails.set(appId, tail);
  try {
    return await run;
  } finally {
    if (tails.get(appId) === tail) tails.delete(appId);
  }
}
