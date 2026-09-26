/**
 * Attending a gws-ea pause at the terminal, so a run can go on in the same
 * process: the Google Chat configuration is confirmed in place, a principal
 * conversation is chosen from a list, and what the person was asked to do is
 * waited for. Anything else stops, and the CLI reports how to resume.
 */
import * as p from '@clack/prompts';
import { setTimeout as delay } from 'node:timers/promises';

import type { PauseResponse } from '../src/gws-ea/events.js';
import type { ProvisionHumanPause } from '../src/gws-ea/phases.js';
import { pollUntil } from '../src/gws-ea/poll.js';

const WATCH_INTERVAL_MS = 3_000;
const WATCH_LIMIT_MS = 30 * 60_000;
const STOP: PauseResponse = { kind: 'stop' };

/** Each question is cancelled when `signal` aborts, as a Ctrl-C or a stop signal does. */
interface PausePrompts {
  note(message: string, title?: string): void;
  info(message: string): void;
  confirm(options: {
    readonly message: string;
    readonly initialValue: boolean;
    readonly signal: AbortSignal;
  }): Promise<unknown>;
  select(options: {
    readonly message: string;
    readonly options: { value: string; label: string }[];
    readonly signal: AbortSignal;
  }): Promise<unknown>;
  isCancel(value: unknown): boolean;
}

export interface PauseDependencies {
  readonly prompts?: PausePrompts;
  /** Waits between checks; resolves early when `signal` aborts. */
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

const defaultPrompts: PausePrompts = {
  note: (message, title) => p.note(message, title),
  info: (message) => p.log.info(message),
  confirm: (options) => p.confirm(options),
  select: (options) => p.select(options),
  isCancel: (value) => p.isCancel(value),
};

async function sleepUnlessAborted(milliseconds: number, signal?: AbortSignal): Promise<void> {
  await delay(milliseconds, undefined, { signal }).catch((error: unknown) => {
    if (!signal?.aborted) throw error;
  });
}

export async function attendPause(
  pause: ProvisionHumanPause,
  signal: AbortSignal,
  dependencies: PauseDependencies = {},
): Promise<PauseResponse> {
  const prompts = dependencies.prompts ?? defaultPrompts;
  const sleep = dependencies.sleep ?? sleepUnlessAborted;
  const shown = [
    pause.message,
    ...(pause.details ?? []),
    ...(pause.actionUrl ? [`Open: ${pause.actionUrl}`] : []),
  ].join('\n');

  if (pause.choices?.length) {
    prompts.note(shown, 'Principal conversation');
    const selected = await prompts.select({
      message: "Which conversation is the principal's?",
      options: pause.choices.map((choice) => ({ value: choice.id, label: choice.label })),
      signal,
    });
    if (prompts.isCancel(selected) || typeof selected !== 'string') return STOP;
    return { kind: 'continue', decisions: { messagingGroupId: selected } };
  }

  if (pause.resumeFlag === '--chat-configured') {
    prompts.note(shown, 'Google Chat app');
    const answer = await prompts.confirm({
      message: 'Have you saved this configuration?',
      initialValue: true,
      signal,
    });
    return answer === true ? { kind: 'continue', decisions: { chatConfigured: true } } : STOP;
  }

  const { settled } = pause;
  if (settled) {
    prompts.note(shown, 'Waiting for you');
    prompts.info('Waiting: setup continues on its own once that happens. Press Ctrl-C to stop and resume later.');
    // A check that cannot finish, as when Ctrl-C stops it, ends the wait; resuming checks again.
    const answer = await pollUntil(
      () => settled().catch(() => undefined),
      (now) => now !== false,
      { intervalMs: WATCH_INTERVAL_MS, limitMs: WATCH_LIMIT_MS, sleep, signal },
    );
    if (answer === true && !signal.aborted) return { kind: 'continue' };
  }
  return STOP;
}
