import * as p from '@clack/prompts';
import os from 'node:os';
import path from 'node:path';

import { GCLOUD_INSTALL_URL, preflightGcloud } from '../src/gws-ea/gcloud.js';
import { resolveTrustedExecutable } from '../src/gws-ea/process.js';
import { GwsEaError } from '../src/gws-ea/types.js';
import { buildInteractiveEnvironment, runInheritScript } from './lib/inherit-script.js';

interface PromptAdapter {
  note(message: string, title?: string): void;
  confirm(options: { readonly message: string; readonly initialValue: boolean }): Promise<unknown>;
  isCancel(value: unknown): boolean;
}

export interface GcloudPrerequisiteDependencies {
  readonly check?: () => Promise<{ readonly account: string }>;
  readonly resolveExecutable?: (searchPath: string) => Promise<string>;
  readonly runLogin?: (executable: string, args: readonly string[]) => Promise<number>;
  readonly prompts?: PromptAdapter;
}

const defaultPrompts: PromptAdapter = {
  note: p.note,
  confirm: p.confirm,
  isCancel: p.isCancel,
};

function cancelled(): never {
  throw new GwsEaError('cancelled', 'Assistant creation was cancelled');
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

export async function ensureGcloudReady(
  cwd: string,
  dependencies: GcloudPrerequisiteDependencies = {},
): Promise<{ readonly account: string }> {
  const prompts = dependencies.prompts ?? defaultPrompts;
  const check = dependencies.check ?? (() => preflightGcloud({ cwd }));
  const resolveExecutable =
    dependencies.resolveExecutable ?? ((searchPath: string) => resolveTrustedExecutable('gcloud', searchPath));
  const runLogin =
    dependencies.runLogin ??
    ((executable: string, args: readonly string[]) =>
      runInheritScript(executable, [...args], { env: buildInteractiveEnvironment() }));
  let installAttempted = false;
  let loginAttempted = false;
  let executable: string | undefined;

  const resolveGcloud = async (): Promise<string> => {
    try {
      executable ??= await resolveExecutable(gcloudSearchPath());
      activateExecutable(executable);
      return executable;
    } catch {
      throw new GwsEaError(
        'gcloud_required',
        `Google Cloud CLI is still unavailable. Finish installation from ${GCLOUD_INSTALL_URL}, then retry.`,
      );
    }
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
        prompts.note(
          'Sign in with the Google account that should own this assistant’s dedicated project. GWS-EA does not store the login credential.',
          'Google Cloud',
        );
        await confirm(prompts, 'Sign in to Google Cloud now?');
        const exitCode = await runLogin(await resolveGcloud(), ['auth', 'login']);
        if (exitCode !== 0) {
          throw new GwsEaError(
            'gcloud_auth_failed',
            'Google Cloud sign-in did not complete; no resources were created.',
          );
        }
        loginAttempted = true;
        continue;
      }
      throw error;
    }
  }
}
