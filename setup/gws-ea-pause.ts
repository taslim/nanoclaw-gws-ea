/**
 * Attends a gws-ea pause at the terminal so a run can go on in the same process. A pause it cannot attend
 * stops, and the CLI reports how to resume.
 */
import * as p from '@clack/prompts';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { parseAliasName } from '../src/gws-ea/alias.js';
import { decisionForChoice, type PauseResponse } from '../src/gws-ea/events.js';
import { GOOGLE_CLIENT_FILE_FLAG } from '../src/gws-ea/google-connection.js';
import type { ProvisionHumanPause } from '../src/gws-ea/phases.js';
import { pollUntil } from '../src/gws-ea/poll.js';
import { GwsEaError } from '../src/gws-ea/types.js';

const WATCH_INTERVAL_MS = 3_000;
const WATCH_LIMIT_MS = 30 * 60_000;
const STOP: PauseResponse = { kind: 'stop' };

/** Each question must cancel when `signal` aborts, as Ctrl-C or a stop signal does. */
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
  /** Resolves, not rejects, early when `signal` aborts. */
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

function typedPath(value: string): string {
  return path.resolve(value === '~' || value.startsWith('~/') ? path.join(os.homedir(), value.slice(1)) : value);
}

/** An empty string when the operator left it blank; undefined when they cancelled. */
async function askClientFile(prompts: PausePrompts, signal: AbortSignal): Promise<string | undefined> {
  const answer = await prompts.text({
    message: 'Where is the downloaded client JSON?',
    placeholder: '~/Downloads/client_secret.json',
    signal,
  });
  if (prompts.isCancel(answer) || typeof answer !== 'string') return undefined;
  return answer.trim() ? typedPath(answer.trim()) : '';
}

const ALIAS_ANSWERS = ['added', 'taken', 'named'] as const;
type AliasAnswer = (typeof ALIAS_ANSWERS)[number];
const ALIAS_LABELS: Readonly<Record<AliasAnswer, string>> = {
  added: 'I have added this alias to the assistant’s account',
  taken: 'The Admin console says it is already in use',
  named: 'Use a name of my own',
};

async function askAliasName(prompts: PausePrompts, signal: AbortSignal): Promise<string | undefined> {
  for (;;) {
    const answer = await prompts.text({ message: "The assistant's web alias", placeholder: 'onuj', signal });
    if (prompts.isCancel(answer) || typeof answer !== 'string') return undefined;
    const name = answer.trim();
    try {
      parseAliasName(name);
      return name;
    } catch (error) {
      if (!(error instanceof GwsEaError)) throw error;
      prompts.info(error.message);
    }
  }
}

/**
 * Each answer records the decision `--alias-added`, `--alias-taken` or `--alias <name>` would, tied to the
 * candidate shown so an answer to a since-changed candidate is dropped.
 */
async function attendAliasPause(
  pause: ProvisionHumanPause,
  shown: string,
  prompts: PausePrompts,
  signal: AbortSignal,
): Promise<PauseResponse> {
  const expected = pause.aliasCandidate === undefined ? {} : { expectedCandidate: pause.aliasCandidate };
  const named = async (): Promise<PauseResponse> => {
    const name = await askAliasName(prompts, signal);
    return name === undefined ? STOP : { kind: 'continue', decisions: { alias: { kind: 'named', name, ...expected } } };
  };
  if (pause.code === 'alias_name_required') {
    prompts.note(shown, "The assistant's web alias");
    return named();
  }
  if (pause.code !== 'alias_required') return STOP;
  const context = pause.details ?? [];
  if (context.length > 0) prompts.note(context.join('\n'), "The assistant's web alias");
  const selected = await prompts.select({
    message: pause.message,
    options: ALIAS_ANSWERS.map((answer) => ({ value: answer, label: ALIAS_LABELS[answer] })),
    signal,
  });
  switch (selected) {
    case 'added':
      return { kind: 'continue', decisions: { alias: { kind: 'added', ...expected } } };
    case 'taken':
      return { kind: 'continue', decisions: { alias: { kind: 'taken', ...expected } } };
    case 'named':
      return named();
    default:
      return STOP;
  }
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

  if (pause.phase === 'provision_alias') {
    const setNow = pause.optional
      ? await prompts.confirm({ message: 'Set up the optional web alias now?', initialValue: false, signal })
      : true;
    if (setNow === false) return { kind: 'continue', decisions: { skipAlias: true } };
    if (setNow !== true) return STOP;
    return attendAliasPause(pause, shown, prompts, signal);
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
