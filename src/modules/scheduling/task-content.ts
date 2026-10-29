import type { TaskClock } from '../../mailbox/types.js';
import { isValidTimezone } from '../../timezone.js';

export interface TaskContent {
  clock?: TaskClock;
  prompt: string;
  script: string | null;
  originSessionId: string | null;
}

/** Decode the storage-neutral task content envelope. */
export function parseTaskContent(raw: string): TaskContent {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const clock = parsed.clock;
    const savedClock =
      typeof clock === 'object' &&
      clock !== null &&
      'instant' in clock &&
      'zone' in clock &&
      typeof clock.instant === 'string' &&
      Number.isFinite(Date.parse(clock.instant)) &&
      typeof clock.zone === 'string' &&
      isValidTimezone(clock.zone)
        ? { instant: clock.instant, zone: clock.zone }
        : undefined;
    return {
      ...(savedClock === undefined ? {} : { clock: savedClock }),
      prompt: typeof parsed.prompt === 'string' ? parsed.prompt : '',
      script: typeof parsed.script === 'string' ? parsed.script : null,
      originSessionId: typeof parsed.originSessionId === 'string' ? parsed.originSessionId : null,
    };
    // eslint-disable-next-line no-catch-all/no-catch-all -- LEGACY-COMPAT(v1-tasks): plain-string content predating the JSON envelope
  } catch {
    return { prompt: raw, script: null, originSessionId: null };
  }
}
