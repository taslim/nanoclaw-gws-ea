/**
 * Terminal guidance for gws-ea's prerequisites: the Google Cloud sign-in and
 * account prompts behind the `Interaction` port, and a guided Google Cloud CLI
 * installation that continues the same run.
 */
import * as p from '@clack/prompts';
import os from 'node:os';
import path from 'node:path';

import type { Interaction } from '../src/gws-ea/events.js';
import { GCLOUD_INSTALL_URL } from '../src/gws-ea/gcloud.js';
import { checkPrerequisites, type PrerequisiteRequest, type Prerequisites } from '../src/gws-ea/prerequisites.js';
import { missingExecutable, resolveExecutable } from '../src/gws-ea/process.js';
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
  readonly resolveExecutable?: (searchPath: string) => Promise<string>;
  readonly prompts?: PromptAdapter;
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

/** The engine's prerequisite checks, with a guided Google Cloud CLI install that continues the same run. */
export async function ensurePrerequisites(
  request: PrerequisiteRequest,
  interaction: GuidedInteraction,
  dependencies: GuidedPrerequisiteDependencies = {},
): Promise<Prerequisites> {
  const check = dependencies.check ?? checkPrerequisites;
  const ready = await check(request, interaction).catch((error: unknown) => {
    if (error instanceof GwsEaError && error.code === 'gcloud_required') return undefined;
    throw error;
  });
  if (ready) return ready;
  const prompts = dependencies.prompts ?? defaultPrompts;
  await interaction.withTerminal(async () => {
    prompts.note(
      `Install the Google Cloud CLI, then return to this terminal.\n${GCLOUD_INSTALL_URL}`,
      'Google Cloud CLI',
    );
    await confirm(prompts, 'Continue after installing the Google Cloud CLI?');
  });
  await locateGcloud(dependencies.resolveExecutable ?? defaultResolveExecutable);
  return check(request, interaction);
}
