/**
 * Probe until `done` holds for the answer, checking every `intervalMs` for at
 * most `limitMs` (each sleep counts one interval), or until `signal` aborts.
 * It returns the last answer, so the caller decides what an unfinished wait
 * means; a probe that throws ends the wait with its error.
 */
export async function pollUntil<T>(
  probe: () => Promise<T>,
  done: (answer: T) => boolean,
  options: {
    readonly intervalMs: number;
    readonly limitMs: number;
    /** Resolves after `milliseconds`, or early once `signal` aborts. */
    readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
    readonly signal?: AbortSignal;
  },
): Promise<T> {
  const { intervalMs, limitMs, sleep, signal } = options;
  let answer = await probe();
  for (let waited = 0; !done(answer) && waited < limitMs && !signal?.aborted; waited += intervalMs) {
    await sleep(intervalMs, signal);
    if (signal?.aborted) break;
    answer = await probe();
  }
  return answer;
}
