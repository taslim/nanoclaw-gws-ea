/**
 * Probe until `done` holds for the answer, sleeping `intervalMs` between
 * probes for at most `limitMs` (each sleep counts its own length), or until
 * `signal` aborts. With `maxIntervalMs` the interval doubles up to it, as
 * vendors' retry guidance asks. It returns the last answer, so the caller
 * decides what an unfinished wait means; a probe that throws ends the wait
 * with its error.
 */
export async function pollUntil<T>(
  probe: () => Promise<T>,
  done: (answer: T) => boolean,
  options: {
    readonly intervalMs: number;
    readonly maxIntervalMs?: number;
    readonly limitMs: number;
    /** Resolves after `milliseconds`, or early once `signal` aborts. */
    readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
    readonly signal?: AbortSignal;
  },
): Promise<T> {
  const { intervalMs, maxIntervalMs = intervalMs, limitMs, sleep, signal } = options;
  let answer = await probe();
  for (let waited = 0, next = intervalMs; !done(answer) && waited < limitMs && !signal?.aborted; ) {
    await sleep(next, signal);
    if (signal?.aborted) break;
    waited += next;
    next = Math.min(next * 2, maxIntervalMs);
    answer = await probe();
  }
  return answer;
}
