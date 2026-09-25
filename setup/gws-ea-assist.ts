/**
 * Claude-assisted diagnosis after an interactive gws-ea failure (KTD10).
 *
 * The CLI calls this only after the failed attempt released its instance
 * lock. The bundle is staged, redacted, in a 0700 directory beside the run's
 * logs so the operator can review exactly what would leave the machine, and
 * nothing is sent without consent. Claude runs with no tools, no MCP servers,
 * no session persistence, and the tool environment minus secret variables;
 * its reply is shown as untrusted text and nothing it suggests is executed.
 *
 * Upstream setup/lib/claude-assist.ts runs Claude with bypassed permissions in
 * the project root, so it is deliberately not reused here.
 */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import * as p from '@clack/prompts';

import { isErrno } from '../src/community-portal/errors.js';
import type { FailureReport } from '../src/gws-ea/cli.js';
import { CONTROL_PLANE_ROOT } from '../src/gws-ea/paths.js';
import {
  buildToolEnvironment,
  isSecretEnvironmentKey,
  resolveExecutable,
  runSanitizedCommandOutcome,
  type SanitizedCommandOutcomeRunner,
} from '../src/gws-ea/process.js';
import { redact } from '../src/gws-ea/redact.js';
import { GwsEaError } from '../src/gws-ea/types.js';
import { note } from './lib/theme.js';

/** `-p` with no tools, an empty strict MCP configuration, and nothing saved to resume. */
export const CLAUDE_DIAGNOSIS_ARGS = [
  '-p',
  '--output-format',
  'text',
  '--no-session-persistence',
  '--disable-slash-commands',
  '--strict-mcp-config',
  '--mcp-config',
  '{"mcpServers":{}}',
  '--tools',
  '',
] as const;

const DIAGNOSIS_TIMEOUT_MS = 3 * 60 * 1000;
const MAX_REPLY_CHARACTERS = 4000;

/** The fixed gws-ea sources sent for each step; Claude cannot read anything else. */
const STEP_SOURCES: Readonly<Record<string, readonly string[]>> = {
  secrets: ['src/gws-ea/create-input.ts'],
  release_source: ['src/gws-ea/release-tracks.ts'],
  prerequisites: ['setup/gws-ea-prerequisites.ts', 'src/gws-ea/gcloud.ts'],
  inputs: ['setup/gws-ea-input.ts', 'src/gws-ea/create-input.ts'],
  resolve_release: ['src/gws-ea/checkout.ts'],
  reserve: ['src/gws-ea/cli.ts', 'src/gws-ea/registry.ts'],
  provision: ['src/gws-ea/provision.ts', 'src/gws-ea/journal.ts'],
  materialize_checkout: ['src/gws-ea/checkout.ts', 'src/gws-ea/release-preflight.ts'],
  provision_gcp: ['src/gws-ea/gcloud.ts'],
  start_onecli: ['src/gws-ea/onecli.ts', 'src/gws-ea/onecli-compose.ts'],
  configure_provider: ['src/gws-ea/onecli.ts'],
  start_nanoclaw: ['src/gws-ea/service.ts'],
  establish_transport: [
    'src/gws-ea/cloudflare-ingress.ts',
    'src/gws-ea/cloudflare-connector.ts',
    'src/gws-ea/endpoint.ts',
  ],
  configure_channel: ['src/gws-ea/chat-configuration.ts'],
  bind_principal: ['src/gws-ea/principal.ts'],
  verify_conversation: ['src/gws-ea/verify.ts'],
  ready: ['src/gws-ea/verify.ts'],
  inspect: ['src/gws-ea/remove.ts'],
  remove: ['src/gws-ea/remove.ts'],
};

export interface DiagnosisUi {
  note(message: string, title: string): void;
  confirm(message: string): Promise<boolean>;
  warn(message: string): void;
  wait<T>(label: string, work: () => Promise<T>): Promise<T>;
}

const terminalUi: DiagnosisUi = {
  note: (message, title) => note(message, title),
  confirm: async (message) => (await p.confirm({ message, initialValue: false })) === true,
  warn: (message) => p.log.warn(message),
  async wait(label, work) {
    const spinner = p.spinner();
    spinner.start(label);
    try {
      const result = await work();
      spinner.stop(label.replace(/…$/u, ''));
      return result;
    } catch (error) {
      spinner.error(label.replace(/…$/u, ' failed'));
      throw error;
    }
  },
};

export interface DiagnosisDependencies {
  readonly interactive?: boolean;
  readonly ui?: DiagnosisUi;
  readonly locateClaude?: () => Promise<string>;
  readonly runClaude?: SanitizedCommandOutcomeRunner;
  readonly ambient?: NodeJS.ProcessEnv;
  readonly sourceRoot?: string;
}

export type DiagnosisOutcome = 'skipped' | 'declined' | 'answered' | 'unavailable';

interface BundleFile {
  readonly name: string;
  readonly contents: string;
}

async function readIfPresent(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
  }
}

async function writePrivate(directory: string, name: string, contents: string): Promise<void> {
  const file = path.join(directory, name);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, contents, { mode: 0o600 });
}

/** Stage the redacted bundle in a private directory beside the run's logs. */
async function stageBundle(
  report: FailureReport,
  sourceRoot: string,
): Promise<{ readonly directory: string; readonly files: readonly BundleFile[] }> {
  const directory = path.join(report.runDirectory, 'diagnosis');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const files: BundleFile[] = [];
  const logs: Array<readonly [string, string | undefined]> = [
    ['progress.log', report.progressLog],
    ['step.log', report.rawLog],
  ];
  for (const [name, file] of logs) {
    const contents = file ? await readIfPresent(file) : undefined;
    if (contents !== undefined) files.push({ name, contents: redact(contents) });
  }
  for (const source of STEP_SOURCES[report.step] ?? []) {
    const contents = await readIfPresent(path.join(sourceRoot, source));
    if (contents !== undefined) files.push({ name: path.join('sources', source), contents: redact(contents) });
  }
  await Promise.all(files.map((file) => writePrivate(directory, file.name, file.contents)));
  return { directory, files };
}

function consentText(directory: string, files: readonly BundleFile[]): string {
  const sources = files.filter((file) => file.name.startsWith('sources')).map((file) => file.name.slice(8));
  return [
    'Claude (Anthropic) receives, over the network:',
    "  - this run's progression log and the failing step's raw log, with secrets redacted",
    `  - ${sources.length} gws-ea source ${sources.length === 1 ? 'file' : 'files'}${sources.length ? `: ${sources.join(', ')}` : ''}`,
    'They can include your Google account email; Google Cloud project, organization, and Cloudflare zone IDs;',
    'hostnames; local paths; and Google Chat user IDs and display names.',
    'Claude gets no tools, no MCP servers, and none of your secret environment variables. It runs nothing.',
    `Review the bundle first: ${directory}`,
  ].join('\n');
}

function prompt(report: FailureReport, files: readonly BundleFile[]): string {
  return redact(
    [
      'You are diagnosing a failed run of gws-ea, a CLI that provisions a Google Workspace executive assistant',
      '(a NanoClaw instance) with gcloud, Cloudflare, Docker, OneCLI, and launchd or systemd.',
      'You have no tools. Everything you know is below; the logs are redacted.',
      '',
      'Reply in at most 12 short lines: the most likely cause, grounded in the logs, and what the operator should',
      'check. If one shell command would help the operator confirm or fix it, put it alone on the last line as',
      '`COMMAND: <command>`. The operator reviews it; nothing runs automatically. Never ask for secrets.',
      '',
      `Failure: step ${report.step}${report.stepLabel ? ` (${report.stepLabel})` : ''}, code ${report.code}: ${report.cause}`,
      `The CLI's next action: ${report.nextAction}`,
      ...(report.pendingAction ? [`Pending human action: ${report.pendingAction}`] : []),
      ...files.flatMap((file) => ['', `=== ${file.name} ===`, file.contents]),
    ].join('\n'),
  );
}

/** Strip terminal escape sequences and control characters from untrusted text. */
function sanitize(text: string): string {
  return text
    .replace(/\p{Cc}\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/[^\P{Cc}\n\t]/gu, '')
    .trim()
    .slice(0, MAX_REPLY_CHARACTERS);
}

function diagnosisEnvironment(ambient: NodeJS.ProcessEnv): Record<string, string> {
  const environment = buildToolEnvironment(ambient, { HOME: ambient.HOME ?? os.homedir() });
  return Object.fromEntries(Object.entries(environment).filter(([key]) => !isSecretEnvironmentKey(key)));
}

/**
 * Offer diagnosis of a failure. Omitted without a TTY or without `claude`;
 * sends nothing without consent; never executes a suggestion.
 */
export async function offerDiagnosis(
  report: FailureReport,
  dependencies: DiagnosisDependencies = {},
): Promise<DiagnosisOutcome> {
  const interactive = dependencies.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive) return 'skipped';
  let claude: string;
  try {
    claude = await (dependencies.locateClaude ?? (() => resolveExecutable('claude')))();
  } catch (error) {
    if (error instanceof GwsEaError && error.code === 'executable_not_found') return 'skipped';
    throw error;
  }
  const ui = dependencies.ui ?? terminalUi;

  const bundle = await stageBundle(report, dependencies.sourceRoot ?? CONTROL_PLANE_ROOT);
  ui.note(consentText(bundle.directory, bundle.files), 'What leaves this machine');
  if (!(await ui.confirm('Send this bundle to Claude for a diagnosis?'))) return 'declined';

  const run = dependencies.runClaude ?? runSanitizedCommandOutcome;
  let reply: string;
  try {
    const outcome = await ui.wait('Asking Claude…', () =>
      run({
        command: claude,
        args: [...CLAUDE_DIAGNOSIS_ARGS],
        cwd: bundle.directory,
        env: diagnosisEnvironment(dependencies.ambient ?? process.env),
        input: prompt(report, bundle.files),
        timeoutMs: DIAGNOSIS_TIMEOUT_MS,
      }),
    );
    if (outcome.exitCode !== 0) {
      ui.warn(`Claude could not produce a diagnosis (exit code ${outcome.exitCode}). The logs are unchanged.`);
      return 'unavailable';
    }
    reply = sanitize(outcome.stdout);
  } catch (error) {
    if (!(error instanceof GwsEaError)) throw error;
    ui.warn(`Claude could not produce a diagnosis: ${redact(error.message)}`);
    return 'unavailable';
  }
  if (!reply) {
    ui.warn('Claude could not produce a diagnosis: the reply was empty.');
    return 'unavailable';
  }

  const lines = reply.split('\n');
  const commandLine = [...lines].reverse().find((line) => /^\s*COMMAND:/u.test(line));
  const suggested = commandLine
    ?.replace(/^\s*COMMAND:\s*/u, '')
    .replace(/^`|`$/gu, '')
    .trim();
  const body = lines
    .filter((line) => line !== commandLine)
    .join('\n')
    .trim();
  ui.note(
    [
      body,
      ...(suggested
        ? ['', 'Suggested command (review it; run it yourself only if it is right):', `  ${suggested}`]
        : []),
    ].join('\n'),
    "Claude's diagnosis (untrusted; nothing was run)",
  );
  return 'answered';
}
