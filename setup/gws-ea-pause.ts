/**
 * Attending a gws-ea pause at the terminal, so a run can go on in the same
 * process: a choice the pause offers, such as the billing account to link, is
 * made from its list; the Google Chat API configuration is confirmed in place;
 * the assistant's downloaded Google client is located; and what the person was
 * asked to do is waited for. Anything else stops, and the CLI reports how to
 * resume.
 */
import * as p from '@clack/prompts';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { decisionForChoice, type PauseResponse } from '../src/gws-ea/events.js';
import { GOOGLE_CLIENT_FILE_FLAG } from '../src/gws-ea/google-connection.js';
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
  text(options: {
    readonly message: string;
    readonly placeholder: string;
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
  note: (message, title) => p.note(message, title, { output: process.stderr }),
  info: (message) => p.log.info(message, { output: process.stderr }),
  confirm: (options) => p.confirm({ ...options, output: process.stderr }),
  select: (options) => p.select({ ...options, output: process.stderr }),
  text: (options) => p.text({ ...options, output: process.stderr }),
  isCancel: (value) => p.isCancel(value),
};

/** A path as the operator types it: `~` is their home, and a relative path is from here. */
function typedPath(value: string): string {
  return path.resolve(value === '~' || value.startsWith('~/') ? path.join(os.homedir(), value.slice(1)) : value);
}

/**
 * Where the operator saved the assistant's downloaded client: its path, an
 * empty string when they left it blank, or undefined when they cancelled.
 */
async function askClientFile(prompts: PausePrompts, signal: AbortSignal): Promise<string | undefined> {
  const answer = await prompts.text({
    message: 'Where is the downloaded client JSON?',
    placeholder: '~/Downloads/client_secret.json',
    signal,
  });
  if (prompts.isCancel(answer) || typeof answer !== 'string') return undefined;
  return answer.trim() ? typedPath(answer.trim()) : '';
}

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
    // A choice is attended only when its resume flag records one; the CLI reports any other.
    const { choices, resumeFlag } = pause;
    if (choices.some((choice) => decisionForChoice(resumeFlag, choice.id) === undefined)) return STOP;
    const context = [...(pause.details ?? []), ...(pause.actionUrl ? [`Open: ${pause.actionUrl}`] : [])];
    if (context.length > 0) prompts.note(context.join('\n'), 'Choose one');
    const selected = await prompts.select({
      message: pause.message,
      options: choices.map((choice) => ({ value: choice.id, label: choice.label })),
      signal,
    });
    if (prompts.isCancel(selected) || typeof selected !== 'string') return STOP;
    const decisions = decisionForChoice(resumeFlag, selected);
    return decisions ? { kind: 'continue', decisions } : STOP;
  }

  if (pause.code === 'chat_configuration_required') {
    // The same console visit may also create the assistant's sign-in client, when the pause asks for its file.
    const withClient = pause.resumeFlag?.includes(GOOGLE_CLIENT_FILE_FLAG) === true;
    prompts.note(shown, withClient ? 'Google Cloud console' : 'Google Chat API');
    const answer = await prompts.confirm({
      message: 'Have you saved the Google Chat configuration?',
      initialValue: true,
      signal,
    });
    if (answer !== true) return STOP;
    // Left blank, the run goes on and the sign-in asks for the file again; cancelled, the run stops.
    const clientFile = withClient ? await askClientFile(prompts, signal) : '';
    if (clientFile === undefined) return STOP;
    return {
      kind: 'continue',
      decisions: { chatConfigured: true, ...(clientFile ? { googleClientFile: clientFile } : {}) },
    };
  }

  if (pause.code === 'google_client_required') {
    prompts.note(shown, "The assistant's Google sign-in client");
    const clientFile = await askClientFile(prompts, signal);
    return clientFile ? { kind: 'continue', decisions: { googleClientFile: clientFile } } : STOP;
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
