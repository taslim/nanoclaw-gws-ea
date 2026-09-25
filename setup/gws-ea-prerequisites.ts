import * as p from '@clack/prompts';
import os from 'node:os';
import path from 'node:path';

import { GCLOUD_INSTALL_URL, preflightGcloud } from '../src/gws-ea/gcloud.js';
import { resolveExecutable } from '../src/gws-ea/process.js';
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

export interface GcloudPrerequisiteDependencies extends GoogleCloudSignInDependencies {
  readonly account?: string;
  readonly check?: () => Promise<{ readonly account: string }>;
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

function isPrerequisiteError(error: unknown, code: string): error is GwsEaError {
  return error instanceof GwsEaError && error.code === code;
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
  let executable: string;
  try {
    executable = await resolve(gcloudSearchPath());
  } catch {
    throw new GwsEaError(
      'gcloud_required',
      `Google Cloud CLI is still unavailable. Finish installation from ${GCLOUD_INSTALL_URL}, then retry.`,
    );
  }
  activateExecutable(executable);
  return executable;
}

async function signIn(
  account: string | undefined,
  prompts: PromptAdapter,
  locate: () => Promise<string>,
  runLogin: (executable: string, args: readonly string[]) => Promise<number>,
): Promise<void> {
  prompts.note(
    account
      ? `Sign back in as ${account} to continue this assistant’s setup. GWS-EA does not store the login credential.`
      : 'Sign in with the Google account that should own this assistant’s dedicated project. GWS-EA does not store the login credential.',
    'Google Cloud',
  );
  await confirm(prompts, 'Sign in to Google Cloud now?');
  const exitCode = await runLogin(await locate(), ['auth', 'login', ...(account ? [account] : [])]);
  if (exitCode !== 0) {
    throw new GwsEaError('gcloud_auth_failed', 'Google Cloud sign-in did not complete.');
  }
}

/** Interactive `gcloud auth login`: the operator confirms, then gcloud owns the terminal and browser flow. */
export async function signInToGoogleCloud(
  account?: string,
  dependencies: GoogleCloudSignInDependencies = {},
): Promise<void> {
  const resolve = dependencies.resolveExecutable ?? defaultResolveExecutable;
  await signIn(
    account,
    dependencies.prompts ?? defaultPrompts,
    () => locateGcloud(resolve),
    dependencies.runLogin ?? defaultRunLogin,
  );
}

export async function ensureGcloudReady(
  cwd: string,
  dependencies: GcloudPrerequisiteDependencies = {},
): Promise<{ readonly account: string }> {
  const prompts = dependencies.prompts ?? defaultPrompts;
  const check =
    dependencies.check ??
    (() => preflightGcloud({ cwd, ...(dependencies.account ? { account: dependencies.account } : {}) }));
  const resolveGcloudExecutable = dependencies.resolveExecutable ?? defaultResolveExecutable;
  const runLogin = dependencies.runLogin ?? defaultRunLogin;
  let installAttempted = false;
  let loginAttempted = false;
  let executable: string | undefined;

  const resolveGcloud = async (): Promise<string> => {
    executable ??= await locateGcloud(resolveGcloudExecutable);
    activateExecutable(executable);
    return executable;
  };

  for (;;) {
    try {
      return await check();
    } catch (error) {
      if (isPrerequisiteError(error, 'gcloud_required')) {
        if (installAttempted) {
          throw new GwsEaError(
            'gcloud_required',
            `Google Cloud CLI is still unavailable. Finish installation from ${GCLOUD_INSTALL_URL}, then retry.`,
          );
        }
        prompts.note(
          `Install the Google Cloud CLI, then return to this terminal.\n${GCLOUD_INSTALL_URL}`,
          'Google Cloud CLI',
        );
        await confirm(prompts, 'Continue after installing the Google Cloud CLI?');
        await resolveGcloud();
        installAttempted = true;
        continue;
      }
      if (isPrerequisiteError(error, 'gcloud_auth_required')) {
        if (loginAttempted) {
          throw new GwsEaError(
            'gcloud_auth_required',
            'Google Cloud sign-in did not become available. Complete gcloud authentication, then retry.',
          );
        }
        await signIn(dependencies.account, prompts, resolveGcloud, runLogin);
        loginAttempted = true;
        continue;
      }
      throw error;
    }
  }
}
