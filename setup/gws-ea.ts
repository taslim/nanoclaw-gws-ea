/**
 * The gws-ea driver: terminal rendering, prompts, Google Cloud guidance, and the interactive failure loop
 * around the control-plane CLI. Without a TTY, in CI, or with `--json` or `--no-input`, it adds none of them, so
 * every input comes from flags, the environment, or the secrets file, and every stop is a durable line.
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import * as p from '@clack/prompts';
import k from 'kleur';

import {
  createCommandRunner,
  detectService,
  drainContainers,
  startService,
  stopService,
  verifyServiceHealth,
} from '../scripts/update/service.js';
import { parseInvocation } from '../src/gws-ea/command-parser.js';
import { runCli, type CliRuntime, type FailureReport, type Presenter } from '../src/gws-ea/cli.js';
import type { InteractivePrompts } from '../src/gws-ea/events.js';
import { removalQuestion } from '../src/gws-ea/remove.js';
import { onePasswordUninstallPreviewLines } from '../src/gws-ea/onepassword-uninstall.js';
import type { OnePasswordAccount } from '../src/modules/gws-ea-browser/onepassword-cli.js';
import { CONTROL_PLANE_ROOT } from '../src/gws-ea/paths.js';
import type { ToolProviderSetup } from '../src/gws-ea/release-target.js';
import type { HostStatusHelpers } from '../src/gws-ea/service.js';
import type { NanoclawServiceHelpers } from '../src/gws-ea/service-control.js';
import type { ToolCheckout } from '../src/gws-ea/stray-install.js';
import { GwsEaError } from '../src/gws-ea/types.js';
import { offerDiagnosis } from './gws-ea-assist.js';
import { authenticateGwsEaProvider, collectGwsEaCreateInput } from './gws-ea-input.js';
import { attendPause } from './gws-ea-pause.js';
import { confirmGoogleAccount, ensurePrerequisites, signInToGoogleCloud } from './gws-ea-prerequisites.js';
import { confirmThenOpen, formatNoteLink } from './lib/browser.js';
import { fitToWidth, fmtDuration } from './lib/theme.js';
import { listSetupProviders, type SetupProviderEntry } from './providers/registry.js';
import { upsertEnvVars } from './set-env.js';
import { backupEnv } from './uninstall/remove.js';
import './providers/index.js';

interface RunningStep {
  readonly step: string;
  readonly label: string;
  readonly started: number;
  reason?: string;
}

/**
 * Upstream `startSpinner` cannot change its message while running, so a step's waiting reason needs the
 * spinner driven here with upstream's theme helpers.
 */
export function createTerminalPresenter(): Presenter {
  let running: RunningStep | undefined;
  const color = Boolean(process.stderr.isTTY) && !process.env.NO_COLOR;
  let spinner: ReturnType<typeof p.spinner> | undefined;
  let tick: NodeJS.Timeout | undefined;

  const elapsed = (step: RunningStep): string => ` (${fmtDuration(Date.now() - step.started)})`;
  const text = (step: RunningStep): string => {
    const suffix = elapsed(step);
    return `${fitToWidth(step.reason ?? step.label, suffix)}${color ? k.dim(suffix) : suffix}`;
  };
  const draw = (): void => {
    if (running && spinner) spinner.message(text(running));
  };
  const start = (): void => {
    if (!running || spinner) return;
    spinner = p.spinner({ output: process.stderr });
    spinner.start(text(running));
    tick = setInterval(draw, 1000);
  };
  const halt = (): ReturnType<typeof p.spinner> | undefined => {
    clearInterval(tick);
    tick = undefined;
    const stopped = spinner;
    spinner = undefined;
    return stopped;
  };

  return {
    event(event) {
      if (event.type === 'domain-effect') return;
      if (event.type === 'step-started') {
        if (!event.label) return;
        halt()?.clear();
        running = { step: event.step, label: event.label, started: Date.now() };
        start();
        return;
      }
      if (running?.step !== event.step) return;
      if (event.type === 'step-waiting') {
        running.reason = event.reason;
        draw();
        return;
      }
      const finished = running;
      running = undefined;
      const stopped = halt();
      if (!stopped) return;
      const label = finished.label.replace(/…$/u, '');
      const suffix = color ? k.dim(elapsed(finished)) : elapsed(finished);
      if (event.type === 'step-failed') stopped.error(`${label} failed${suffix}`);
      else if (event.type === 'step-paused') stopped.stop(`${label}: waiting for you${suffix}`);
      else stopped.stop(`${color ? k.bold(label) : label}${suffix}`);
    },
    suspend() {
      halt()?.clear();
    },
    resume() {
      start();
    },
    line(line) {
      const wasRunning = spinner !== undefined;
      halt()?.clear();
      p.log.info(line, { output: process.stderr });
      if (wasRunning) start();
    },
    report(report) {
      halt()?.clear();
      running = undefined;
      const details = report.details.join('\n');
      switch (report.outcome) {
        case 'ready':
        case 'paused':
          // Result identities and continuation commands stay intact even on a narrow terminal.
          process.stdout.write(`${[report.headline, ...report.details].join('\n')}\n`);
          return;
        case 'diagnostic':
        case 'busy':
          p.log.warn(report.headline, { output: process.stderr });
          if (details) p.log.message(details, { output: process.stderr });
          return;
        case 'failed':
          p.log.error(report.headline, { output: process.stderr });
          if (details) p.log.message(details, { output: process.stderr });
          if (report.tail) p.log.message(report.tail, { output: process.stderr });
          return;
      }
    },
  };
}

function terminalPrompts(providers: readonly SetupProviderEntry[]): InteractivePrompts {
  return {
    providerCredential: (providerId) => authenticateGwsEaProvider(providerId, providers),
    googleCloudSignIn: (account) => signInToGoogleCloud(account),
    googleAccount: (account) => confirmGoogleAccount(account),
    async googleWorkspaceSignIn(url, account) {
      p.note(
        [
          `Next, sign in to Google as ${account}, the assistant's own account, and allow every permission on each screen Google shows.`,
          'Use a browser window where you can sign in as the assistant, such as a private window or a browser profile for it.',
          formatNoteLink(url),
        ]
          .filter((line) => line !== null)
          .join('\n'),
        "The assistant's Google sign-in",
        { output: process.stderr },
      );
      await confirmThenOpen(url, `Ready to sign in as ${account}? Press Enter to open your browser`, {
        output: process.stderr,
        onDecline: () => {
          throw new GwsEaError('cancelled', 'Google sign-in was cancelled; resume the assistant to continue.');
        },
      });
    },
    attendPause: (pause, signal) => attendPause(pause, signal),
  };
}

/** Undefined when cancelled; enable then reports the choice it needs. */
export async function chooseOnePasswordAccount(accounts: readonly OnePasswordAccount[]): Promise<string | undefined> {
  const chosen = await p.select({
    message: 'Which 1Password account should assistants keep their vaults in?',
    options: accounts.map((account) => ({
      value: account.accountId,
      label: `${account.email} on ${account.url}`,
      hint: account.accountId,
    })),
    output: process.stderr,
  });
  return p.isCancel(chosen) || typeof chosen !== 'string' ? undefined : chosen;
}

/**
 * Upstream ships these as untyped ESM (`setup/lib/host-status.mjs`), so they are loaded by URL and checked
 * here rather than given a declaration file inside upstream's tree.
 */
async function loadHostStatus(): Promise<HostStatusHelpers> {
  const helpers = (await import(new URL('./lib/host-status.mjs', import.meta.url).href)) as Record<string, unknown>;
  const { queryHost, waitForHost } = helpers;
  if (typeof queryHost !== 'function' || typeof waitForHost !== 'function') {
    throw new GwsEaError(
      'launcher_incomplete',
      'setup/lib/host-status.mjs no longer provides queryHost and waitForHost',
    );
  }
  return {
    queryHost: queryHost as HostStatusHelpers['queryHost'],
    waitForHost: waitForHost as HostStatusHelpers['waitForHost'],
  };
}

const serviceHelpers: NanoclawServiceHelpers = {
  createCommandRunner,
  detectService,
  stopService,
  startService,
  drainContainers,
  verifyServiceHealth,
};

/** Where gws-ea removes a NanoClaw install it does not manage, keeping its `.env` aside with NanoClaw's backup. */
function toolCheckout(): ToolCheckout {
  return { root: realpathSync(CONTROL_PLANE_ROOT), backupEnv };
}

function retryOffer(command: FailureReport['command']): string {
  return command === 'start' ||
    command === 'stop' ||
    command === 'restart' ||
    command === 'update' ||
    command === 'rollback' ||
    command === 'cleanup'
    ? `Retry now? gws-ea runs ${command} again.`
    : 'Retry now? gws-ea re-checks prerequisites, then continues from where it stopped.';
}

/** What an update holds the assistant's provider setup to, read without ambient configuration as create reads it. */
function toolProviderSetup(providers: readonly SetupProviderEntry[]): () => Promise<ToolProviderSetup> {
  return async () => ({
    credentialMetadata: (id) =>
      providers
        .find((provider) => provider.value === id)
        ?.provisioning?.credentialMetadata({ allowAmbientConfiguration: false }),
  });
}

async function handleFailure(report: FailureReport): Promise<'retry' | 'stop'> {
  await offerDiagnosis(report);
  const answer = await p.confirm({ message: retryOffer(report.command), initialValue: true, output: process.stderr });
  return answer === true ? 'retry' : 'stop';
}

export async function main(argv: readonly string[], options: { readonly interactive?: boolean } = {}): Promise<number> {
  let invocation;
  try {
    invocation = parseInvocation(argv);
  } catch (error) {
    if (!(error instanceof GwsEaError)) throw error;
    return runCli(argv);
  }
  if (invocation.help || invocation.definition.handler.kind === 'discovery') return runCli(argv);
  const interactive =
    invocation.options.json !== 'true' &&
    invocation.options['no-input'] !== 'true' &&
    (options.interactive ?? Boolean(!process.env.CI && process.stdin.isTTY && process.stderr.isTTY));
  const providers = listSetupProviders();
  const collectCreateInputs: CliRuntime['collectCreateInputs'] = (context) =>
    collectGwsEaCreateInput(context, { providers, interactive });
  const hostStatus = await loadHostStatus();
  const providerSetup = toolProviderSetup(providers);
  const checkout = toolCheckout();
  if (!interactive) {
    return runCli(argv, {
      collectCreateInputs,
      upsertEnvVars,
      hostStatus,
      serviceHelpers,
      toolProviderSetup: providerSetup,
      toolCheckout: checkout,
    });
  }
  return runCli(argv, {
    upsertEnvVars,
    hostStatus,
    serviceHelpers,
    toolProviderSetup: providerSetup,
    toolCheckout: checkout,
    presenter: createTerminalPresenter(),
    prompts: terminalPrompts(providers),
    chooseOnePasswordAccount,
    readWebManagementToken: async () => {
      const token = await p.password({
        message: 'Cloudflare management API token',
        validate: (value) => (!value.trim() || /\s/u.test(value.trim()) ? 'Paste the API token only.' : undefined),
        output: process.stderr,
      });
      if (p.isCancel(token)) throw new GwsEaError('cancelled', 'Web installation cancelled.');
      return token;
    },
    collectCreateInputs,
    checkPrerequisites: (request, interaction) => ensurePrerequisites(request, interaction),
    confirmOnePasswordUninstall: async (preview) => {
      p.note(onePasswordUninstallPreviewLines(preview).join('\n'), '1Password vault deletion', {
        output: process.stderr,
      });
      return (
        (await p.confirm({
          message: 'Delete every owned assistant vault and its saved passwords?',
          initialValue: false,
          output: process.stderr,
        })) === true
      );
    },
    confirmRemoval: async (preview) =>
      (await p.confirm({ message: removalQuestion(preview), initialValue: false, output: process.stderr })) === true,
    confirmUpdate: async (preview) =>
      (await p.confirm({
        message: `Update assistant ${preview.instanceId} to ${preview.to.release_track} ${preview.to.deployed_commit.slice(0, 12)}?`,
        initialValue: false,
        output: process.stderr,
      })) === true,
    confirmUpdateAll: async (plan) => {
      const count = plan.candidates.filter((candidate) => candidate.eligible).length;
      return (
        (await p.confirm({
          message: `Update ${count} ${count === 1 ? 'assistant' : 'assistants'} to this tool's release ${plan.toolCommit.slice(0, 12)}, as planned above?`,
          initialValue: false,
          output: process.stderr,
        })) === true
      );
    },
    confirmRollback: async (preview) =>
      (await p.confirm({
        message: `Restore assistant ${preview.instanceId}'s pre-update snapshot on ${preview.to.release_track} ${preview.to.deployed_commit.slice(0, 12)}, discarding what it recorded since?`,
        initialValue: false,
        output: process.stderr,
      })) === true,
    onFailure: handleFailure,
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (invokedPath === import.meta.url) process.exitCode = await main(process.argv.slice(2));
