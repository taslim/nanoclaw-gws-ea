/**
 * The gws-ea driver (KTD8): terminal rendering, prompts, Google Cloud
 * guidance, and the interactive failure loop around the control-plane CLI.
 * Without a TTY it adds none of them, so every input comes from flags, the
 * environment, or the secrets file, and every stop is a durable line.
 */
import { pathToFileURL } from 'node:url';

import * as p from '@clack/prompts';
import k from 'kleur';

import { runCli, type CliRuntime, type FailureReport, type Presenter } from '../src/gws-ea/cli.js';
import type { InteractivePrompts } from '../src/gws-ea/events.js';
import { GwsEaError } from '../src/gws-ea/types.js';
import { offerDiagnosis } from './gws-ea-assist.js';
import { authenticateGwsEaProvider, CLOUDFLARE_API_TOKEN_GUIDANCE, collectGwsEaCreateInput } from './gws-ea-input.js';
import { confirmGoogleAccount, ensurePrerequisites, signInToGoogleCloud } from './gws-ea-prerequisites.js';
import { dumpTranscriptOnFailure } from './lib/runner.js';
import { fitToWidth, fmtDuration } from './lib/theme.js';
import { listSetupProviders, type SetupProviderEntry } from './providers/registry.js';
import './providers/index.js';

interface RunningStep {
  readonly step: string;
  readonly label: string;
  readonly started: number;
  reason?: string;
}

/**
 * Clack rendering: one spinner per labeled step, showing its waiting reason
 * and elapsed time. Upstream `startSpinner` cannot change its message while
 * running and stops failures with a success glyph under clack 1.2, so the
 * spinner is driven here with upstream's theme helpers.
 */
export function createTerminalPresenter(): Presenter {
  let running: RunningStep | undefined;
  let spinner: ReturnType<typeof p.spinner> | undefined;
  let tick: NodeJS.Timeout | undefined;

  const elapsed = (step: RunningStep): string => ` (${fmtDuration(Date.now() - step.started)})`;
  const text = (step: RunningStep): string => {
    const suffix = elapsed(step);
    return `${fitToWidth(step.reason ?? step.label, suffix)}${k.dim(suffix)}`;
  };
  const draw = (): void => {
    if (running && spinner) spinner.message(text(running));
  };
  const start = (): void => {
    if (!running || spinner) return;
    spinner = p.spinner();
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
      const suffix = k.dim(elapsed(finished));
      if (event.type === 'step-failed') stopped.error(`${label} failed${suffix}`);
      else if (event.type === 'step-paused') stopped.stop(`${label}: waiting for you${suffix}`);
      else stopped.stop(`${k.bold(label)}${suffix}`);
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
      p.log.info(line);
      if (wasRunning) start();
    },
    report(report) {
      halt()?.clear();
      running = undefined;
      const details = report.details.join('\n');
      switch (report.outcome) {
        case 'ready':
          p.log.success(report.headline);
          if (details) p.log.message(details);
          return;
        case 'paused':
          p.log.warn(report.headline);
          if (details) p.note(details, 'Next step');
          return;
        case 'busy':
          p.log.warn(report.headline);
          return;
        case 'failed':
          p.log.error(report.headline);
          if (details) p.log.message(details);
          if (report.tail) dumpTranscriptOnFailure(report.tail);
          return;
      }
    },
  };
}

function terminalPrompts(providers: readonly SetupProviderEntry[]): InteractivePrompts {
  return {
    providerCredential: (providerId) => authenticateGwsEaProvider(providerId, providers),
    async cloudflareAccountToken({ reason }) {
      p.log.warn(reason);
      p.note(CLOUDFLARE_API_TOKEN_GUIDANCE, 'Cloudflare access');
      const answer = await p.password({
        message: 'Cloudflare API token for managed ingress',
        validate: (value) => (value?.trim() ? undefined : 'Required'),
      });
      if (p.isCancel(answer) || typeof answer !== 'string' || !answer.trim()) {
        throw new GwsEaError('cancelled', 'Managed ingress repair was cancelled');
      }
      return answer.trim();
    },
    googleCloudSignIn: (account) => signInToGoogleCloud(account),
    googleAccount: (account) => confirmGoogleAccount(account),
  };
}

/** Diagnosis first, then the retry offer; a retry re-runs prerequisites and resumes. */
async function handleFailure(report: FailureReport): Promise<'retry' | 'stop'> {
  await offerDiagnosis(report);
  const answer = await p.confirm({
    message: 'Retry now? gws-ea re-checks prerequisites, then continues from where it stopped.',
    initialValue: true,
  });
  return answer === true ? 'retry' : 'stop';
}

export async function main(argv: readonly string[], options: { readonly interactive?: boolean } = {}): Promise<number> {
  const interactive = options.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const providers = listSetupProviders();
  const collectCreateInputs: CliRuntime['collectCreateInputs'] = (context) =>
    collectGwsEaCreateInput(context, { providers, interactive });
  if (!interactive) return runCli(argv, { collectCreateInputs });
  return runCli(argv, {
    presenter: createTerminalPresenter(),
    prompts: terminalPrompts(providers),
    collectCreateInputs,
    checkPrerequisites: (request, interaction) => ensurePrerequisites(request, interaction),
    confirmRemoval: async (preview) =>
      (await p.confirm({
        message: `Permanently remove assistant ${preview.instanceId} and request deletion of GCP project ${preview.gcpProject}?`,
        initialValue: false,
      })) === true,
    onFailure: handleFailure,
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (invokedPath === import.meta.url) process.exitCode = await main(process.argv.slice(2));
