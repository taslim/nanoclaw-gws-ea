/**
 * Terminal guidance for gws-ea's prerequisites: the Google Cloud sign-in and
 * account prompts behind the `Interaction` port, and guided fixes for missing
 * or stopped tools that continue the same run.
 */
import * as p from '@clack/prompts';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type { Interaction } from '../src/gws-ea/events.js';
import { GCLOUD_INSTALL_URL } from '../src/gws-ea/gcloud.js';
import { CONTROL_PLANE_ROOT } from '../src/gws-ea/paths.js';
import { pollUntil } from '../src/gws-ea/poll.js';
import {
  checkPrerequisites,
  dockerAnswers,
  type PrerequisiteRequest,
  type Prerequisites,
} from '../src/gws-ea/prerequisites.js';
import {
  buildToolEnvironment,
  missingExecutable,
  resolveExecutable,
  runSanitizedCommandOutcome,
  type SanitizedCommandOutcomeRunner,
} from '../src/gws-ea/process.js';
import { safeErrorMessage } from '../src/gws-ea/redact.js';
import { GwsEaError } from '../src/gws-ea/types.js';
import { buildInteractiveEnvironment, runInheritScript } from './lib/inherit-script.js';

interface PromptAdapter {
  note(message: string, title?: string): void;
  confirm(options: { readonly message: string; readonly initialValue: boolean }): Promise<unknown>;
  isCancel(value: unknown): boolean;
}

export interface GoogleCloudSignInDependencies {
  readonly resolveExecutable?: (searchPath: string) => Promise<string>;
  readonly runLogin?: (executable: string, args: readonly string[]) => Promise<number>;
  readonly prompts?: PromptAdapter;
}

type GuidedInteraction = Pick<Interaction, 'signInToGoogleCloud' | 'confirmGoogleAccount' | 'withTerminal'>;

export interface GuidedPrerequisiteDependencies {
  readonly check?: (request: PrerequisiteRequest, interaction: GuidedInteraction) => Promise<Prerequisites>;
  readonly resolveExecutable?: (command: string, searchPath: string) => Promise<string>;
  readonly prompts?: PromptAdapter;
  readonly platform?: NodeJS.Platform;
  /** Runs `open -a Docker`. */
  readonly runCommand?: SanitizedCommandOutcomeRunner;
  readonly dockerAnswers?: (endpoint: string) => Promise<boolean>;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

const defaultPrompts: PromptAdapter = {
  note: p.note,
  confirm: p.confirm,
  isCancel: p.isCancel,
};

function cancelled(): never {
  throw new GwsEaError('cancelled', 'Google Cloud setup was cancelled');
}

async function confirm(prompts: PromptAdapter, message: string): Promise<void> {
  const answer = await prompts.confirm({ message, initialValue: true });
  if (prompts.isCancel(answer) || answer !== true) cancelled();
}

function gcloudSearchPath(): string {
  return [process.env.PATH, path.join(os.homedir(), 'google-cloud-sdk', 'bin')]
    .filter((entry): entry is string => Boolean(entry))
    .join(path.delimiter);
}

function activateExecutable(executable: string): void {
  const directory = path.dirname(executable);
  const current = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  if (!current.includes(directory)) process.env.PATH = [directory, ...current].join(path.delimiter);
}

function defaultResolveExecutable(searchPath: string): Promise<string> {
  return resolveExecutable('gcloud', searchPath);
}

function defaultRunLogin(executable: string, args: readonly string[]): Promise<number> {
  return runInheritScript(executable, [...args], { env: buildInteractiveEnvironment() });
}

/** Locate gcloud (including the installer's default directory) and put it on PATH for later children. */
async function locateGcloud(resolve: (searchPath: string) => Promise<string>): Promise<string> {
  const executable = await resolve(gcloudSearchPath()).catch((error: unknown) =>
    missingExecutable(
      error,
      'gcloud_required',
      `Google Cloud CLI is still unavailable. Finish installation from ${GCLOUD_INSTALL_URL}, then retry.`,
    ),
  );
  activateExecutable(executable);
  return executable;
}

/**
 * Interactive `gcloud auth login <account> --force`: the operator confirms,
 * then gcloud owns the terminal and the browser flow. Without an account the
 * operator picks one in the browser.
 */
export async function signInToGoogleCloud(
  account?: string,
  dependencies: GoogleCloudSignInDependencies = {},
): Promise<void> {
  const prompts = dependencies.prompts ?? defaultPrompts;
  prompts.note(
    account
      ? `Sign in as ${account} to continue this assistant’s setup. GWS-EA does not store the login credential.`
      : 'Sign in with the Google Workspace account that should own this assistant’s Google Cloud project. GWS-EA does not store the login credential.',
    'Google Cloud',
  );
  await confirm(prompts, 'Sign in to Google Cloud now?');
  const executable = await locateGcloud(dependencies.resolveExecutable ?? defaultResolveExecutable);
  const exitCode = await (dependencies.runLogin ?? defaultRunLogin)(executable, [
    'auth',
    'login',
    ...(account ? [account] : []),
    '--force',
  ]);
  if (exitCode !== 0) {
    throw new GwsEaError('gcloud_auth_failed', 'Google Cloud sign-in did not complete.');
  }
}

/** Whether the signed-in account should own the new assistant's Google Cloud project. */
export async function confirmGoogleAccount(
  account: string,
  dependencies: Pick<GoogleCloudSignInDependencies, 'prompts'> = {},
): Promise<boolean> {
  const prompts = dependencies.prompts ?? defaultPrompts;
  const answer = await prompts.confirm({
    message: `Create this assistant's Google Cloud project as ${account}? (No signs in with another account.)`,
    initialValue: true,
  });
  if (prompts.isCancel(answer)) cancelled();
  return answer === true;
}

/** Rounds of guidance for one prerequisite before its failure stands. */
const GUIDED_ROUNDS = 3;
const DOCKER_START_WAIT_MS = 90_000;
const DOCKER_POLL_MS = 2_000;

/** A prerequisite the operator can fix while this run waits, then the run continues. */
interface Fix {
  readonly title: string;
  /** What to do on this platform, ending in "return to this terminal". */
  readonly steps: string;
  /** What gws-ea can do itself with the operator's yes; it reports whether that worked. */
  readonly offer?: { readonly question: string; readonly run: () => Promise<boolean> };
  /** Once the operator is done: put an installer's default location on PATH, or wait for a daemon. */
  readonly settle?: (prompts: PromptAdapter) => Promise<void>;
}

function homeBin(...segments: string[]): string {
  return path.join(os.homedir(), ...segments);
}

/** Put a newly installed program first on PATH when only its installer's default location has it. */
async function activateInstall(
  command: string,
  directory: string,
  resolve: (command: string, searchPath: string) => Promise<string>,
): Promise<void> {
  const searchPath = [process.env.PATH, directory].filter(Boolean).join(path.delimiter);
  const executable = await resolve(command, searchPath).then(
    (found) => found,
    (error: unknown) => {
      if (error instanceof GwsEaError && error.code === 'executable_not_found') return undefined;
      throw error;
    },
  );
  if (executable) activateExecutable(executable);
}

async function waitForDocker(
  endpoint: string,
  prompts: PromptAdapter,
  answers: (endpoint: string) => Promise<boolean>,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<void> {
  if (await answers(endpoint)) return;
  prompts.note(`Waiting up to ${DOCKER_START_WAIT_MS / 1000} seconds for Docker to start…`, 'Docker');
  await pollUntil(
    () => answers(endpoint),
    (up) => up,
    { intervalMs: DOCKER_POLL_MS, limitMs: DOCKER_START_WAIT_MS, sleep },
  );
}

function fixFor(error: GwsEaError, dependencies: GuidedPrerequisiteDependencies): Fix | undefined {
  const macos = (dependencies.platform ?? process.platform) === 'darwin';
  const resolve = dependencies.resolveExecutable ?? resolveExecutable;
  switch (error.code) {
    case 'gcloud_required':
      return {
        title: 'Google Cloud CLI',
        steps: `Install the Google Cloud CLI, then return to this terminal.\n${GCLOUD_INSTALL_URL}`,
        settle: () => activateInstall('gcloud', homeBin('google-cloud-sdk', 'bin'), resolve),
      };
    case 'docker_required':
      return {
        title: 'Docker',
        steps: macos
          ? 'Install Docker Desktop and start it, then return to this terminal.\nhttps://docs.docker.com/desktop/setup/install/mac-install/'
          : 'Install Docker Engine and start it, then return to this terminal.\nhttps://docs.docker.com/engine/install/',
        // Docker Desktop installs its command-line tools here when it has no administrator rights.
        settle: () => activateInstall('docker', homeBin('.docker', 'bin'), resolve),
      };
    case 'docker_stopped': {
      const endpoint = error.details?.endpoint;
      const settle =
        typeof endpoint === 'string'
          ? (prompts: PromptAdapter) =>
              waitForDocker(endpoint, prompts, dependencies.dockerAnswers ?? dockerAnswers, dependencies.sleep ?? delay)
          : undefined;
      if (!macos) {
        return {
          title: 'Docker',
          steps:
            'Start Docker (sudo systemctl start docker, or systemctl --user start docker for rootless Docker), then return to this terminal.',
          ...(settle ? { settle } : {}),
        };
      }
      return {
        title: 'Docker',
        steps: 'Start Docker Desktop, then return to this terminal.',
        offer: {
          question: 'Start Docker Desktop now?',
          run: async () =>
            (
              await (dependencies.runCommand ?? runSanitizedCommandOutcome)({
                command: 'open',
                args: ['-a', 'Docker'],
                cwd: CONTROL_PLANE_ROOT,
                env: buildToolEnvironment(process.env, { HOME: os.homedir() }),
                timeoutMs: 30_000,
              })
            ).exitCode === 0,
        },
        ...(settle ? { settle } : {}),
      };
    }
    case 'pnpm_required':
      return {
        title: 'pnpm',
        steps:
          'Enable pnpm with Node.js’s Corepack (corepack enable pnpm), then return to this terminal.\nhttps://pnpm.io/installation',
      };
    case 'git_required':
      return {
        title: 'Git',
        steps: macos
          ? 'Install the Xcode Command Line Tools (xcode-select --install), then return to this terminal.'
          : 'Install Git with your package manager (for example, sudo apt install git), then return to this terminal.',
      };
    default:
      return undefined;
  }
}

/** Offer gws-ea's own fix, or show the steps and wait for the operator; either way the run continues. */
async function applyFix(fix: Fix, prompts: PromptAdapter, again: boolean): Promise<void> {
  if (fix.offer && !again) {
    const answer = await prompts.confirm({ message: fix.offer.question, initialValue: true });
    if (prompts.isCancel(answer)) cancelled();
    if (answer === true) {
      // A fix that fails says why, and the operator can still make it by hand.
      const done = await fix.offer.run().then(
        (worked) => worked,
        (error: unknown) => {
          if (!(error instanceof GwsEaError)) throw error;
          prompts.note(safeErrorMessage(error), fix.title);
          return false;
        },
      );
      if (done) return;
    }
  }
  prompts.note(again ? `Still not ready. ${fix.steps}` : fix.steps, fix.title);
  await confirm(prompts, `Continue after fixing ${fix.title}?`);
}

/**
 * The engine's prerequisite checks, guiding each missing or stopped tool: a
 * fix gws-ea can make itself is offered, anything else is shown with its
 * steps, and the same run continues once it is done.
 */
export async function ensurePrerequisites(
  request: PrerequisiteRequest,
  interaction: GuidedInteraction,
  dependencies: GuidedPrerequisiteDependencies = {},
): Promise<Prerequisites> {
  const check = dependencies.check ?? checkPrerequisites;
  const prompts = dependencies.prompts ?? defaultPrompts;
  const rounds = new Map<string, number>();
  for (;;) {
    const outcome = await check(request, interaction).then(
      (ready) => ({ ready }),
      (error: unknown) => ({ error }),
    );
    if ('ready' in outcome) return outcome.ready;
    const { error } = outcome;
    if (!(error instanceof GwsEaError)) throw error;
    const fix = fixFor(error, dependencies);
    const round = rounds.get(error.code) ?? 0;
    if (!fix || round >= GUIDED_ROUNDS) throw error;
    rounds.set(error.code, round + 1);
    await interaction.withTerminal(async () => {
      await applyFix(fix, prompts, round > 0);
      await fix.settle?.(prompts);
    });
  }
}
