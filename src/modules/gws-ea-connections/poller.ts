/**
 * A check that repeats while work is pending: now, then on every interval until a run reports nothing left, and
 * never two at once. A request made while a run is in flight runs once more after it, since that run may have read
 * the state before the request existed.
 */
export interface PendingPollerOptions<T> {
  readonly intervalMs: number;
  /** Returns whether work is still pending. */
  readonly run: (context: T) => Promise<boolean>;
  /** A failed run leaves the work pending for the next one. */
  readonly onError: (error: unknown) => void;
}

export interface PendingPoller<T> {
  /** Runs from now on with this context, until the signal aborts or the poller stops. */
  arm(context: T, signal: AbortSignal): void;
  /** The armed context while its signal is live. */
  current(): T | undefined;
  /** Checks now and on every interval while work is pending; does nothing until armed. */
  soon(): void;
  /** Stops new runs and waits for one in flight, so work it began is not left half done. */
  stop(): Promise<void>;
}

export function createPendingPoller<T>(options: PendingPollerOptions<T>): PendingPoller<T> {
  let armed: { readonly context: T; readonly signal: AbortSignal } | undefined;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> | undefined;
  let recheck = false;

  function stopTimer(): void {
    if (timer) clearInterval(timer);
    timer = undefined;
  }

  function live(): { readonly context: T; readonly signal: AbortSignal } | undefined {
    return armed && !armed.signal.aborted ? armed : undefined;
  }

  function tick(): void {
    const current = live();
    if (!current) return;
    if (inFlight) {
      recheck = true;
      return;
    }
    inFlight = options
      .run(current.context)
      .catch((error: unknown) => {
        options.onError(error);
        return true;
      })
      .then((pending) => {
        inFlight = undefined;
        if (recheck) {
          recheck = false;
          soon();
        } else if (!pending) stopTimer();
      });
  }

  function soon(): void {
    if (!live()) return;
    if (!timer) {
      timer = setInterval(tick, options.intervalMs);
      timer.unref();
    }
    tick();
  }

  return {
    arm(context, signal) {
      if (signal.aborted) return;
      armed = { context, signal };
      signal.addEventListener('abort', stopTimer, { once: true });
    },
    current: () => live()?.context,
    soon,
    async stop() {
      armed = undefined;
      recheck = false;
      stopTimer();
      await inFlight;
    },
  };
}
