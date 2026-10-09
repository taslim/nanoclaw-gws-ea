import os from 'node:os';
import path from 'node:path';

import { formatLocalTime } from '../timezone.js';
import {
  READ_ONLY_COMMANDS,
  requireOption,
  targetInstance,
  type CommandEnd,
  type CommandOptions,
  type OptionSpec,
} from './cli-read-only.js';
import { createManagedIngressSetupSession, type RetainedManagedIngressSetupSession } from './cloudflare-api.js';
import {
  CREATE_INPUT_FLAGS,
  loadSecretSource,
  parsePrincipalEmailFlags,
  PRINCIPAL_EMAIL_FLAG,
  type CreateInputFlag,
  type CreatePromptContext,
  type CreateSetupAnswers,
  type SecretSource,
} from './create-input.js';
import { finishFollowUps, type CutoverDependencies } from './cutover.js';
import {
  createInteraction,
  pendingActionOf,
  PauseRequired,
  runStep,
  type HumanDecisions,
  type Interaction,
  type PauseResponse,
  type InteractivePrompts,
  type RunEvent,
  type StepReporter,
} from './events.js';
import { deriveGchatServiceAccountEmail, deriveGcpProjectId } from './gcloud.js';
import {
  acquireInstanceOperation,
  loadCreatedRuntime,
  readProvisionJournal,
  reserveInstance,
  type InstanceOperation,
} from './journal.js';
import { readOperationRecord } from './operation.js';
import { resolveControlPlanePaths, type ControlPlanePaths } from './paths.js';
import { googleConnectionResources } from './google-connection.js';
import {
  runStepOutsideJournal,
  type ProvisionHumanPause,
  type ProvisionResult,
  type ProvisionRuntime,
} from './phases.js';
import { holdLoopbackPorts, type HeldLoopbackPorts } from './ports.js';
import { checkPrerequisites, type PrerequisiteRequest, type Prerequisites } from './prerequisites.js';
import { replaceProcessWithCommand } from './process.js';
import {
  installProductionBootstrapManifest,
  recordedHost,
  removeProductionBootstrapManifest,
  runProductionProvision,
  validateProductionBootstrapManifest,
} from './provision.js';
import { redact, safeErrorCode, safeErrorMessage } from './redact.js';
import { allocateInstanceId, getInstanceReservation, validateReservation } from './registry.js';
import {
  resolveReleaseTarget,
  type CreateTargetRequest,
  type ReleaseTarget,
  type ToolProviderSetup,
} from './release-target.js';
import { resolveReleaseSource, type ReleaseSource } from './release-tracks.js';
import {
  ABANDONABLE_RESOURCES,
  describeRemoval,
  removeAssistant,
  RemovalPause,
  type AbandonableResource,
  type RemovalOptions,
  type RemovalOutcome,
  type RemovalPreview,
} from './remove.js';
import {
  localTimezone,
  rollBack,
  rollbackPreviewLines,
  type RollbackOutcome,
  type RollbackPreview,
  type RollbackRequest,
} from './rollback.js';
import { startRunLog, type RunLog } from './run-log.js';
import { buildInstanceCliCommand, type HostStatusHelpers, type UpsertEnvVars } from './service.js';
import {
  createServiceControl,
  runtimeServiceTarget,
  type InstanceServiceControl,
  type NanoclawServiceHelpers,
} from './service-control.js';
import {
  detectStrayInstall,
  FULL_CHECK_MS,
  removeStrayInstall,
  strayParts,
  type StrayInstall,
  type StrayLauncher,
  type ToolCheckout,
} from './stray-install.js';
import {
  confirmStagedUpdate,
  continueUpdate,
  prepareUpdate,
  resolveUpdateIntent,
  updatePreviewLines,
  type UpdatedAssistant,
  type UpdateDependencies,
  type UpdatePreview,
  type UpdateRequest,
  type UpdateSeams,
} from './update.js';
import {
  planUpdateAll,
  runUpdateAll,
  type AssistantUpdate,
  type UpdateAllPlan,
  type UpdateTurn,
} from './update-all.js';
import {
  GwsEaError,
  releaseLine,
  sameRelease,
  type AllocatedPorts,
  type GwsEaErrorDetails,
  type InstanceReservationInput,
  type ReleaseCoordinates,
} from './types.js';

/** Unlabeled, so a scripted create's first line stays its `instance_id`. */
const PREREQUISITES_STEP = { id: 'prerequisites' } as const;

/** Signals that end a run, recorded in its log first. */
const INTERRUPT_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

/** `0` ready, `10` paused for a person, `1` failed, `75` busy. */
export const EXIT_CODES = { ready: 0, paused: 10, failed: 1, busy: 75 } as const;

type LineWriter = (line: string) => void;
/** Commands that run as attempts: each with its own run log, stop summary, and failure loop. */
const COMMANDS = [
  'create',
  'resume',
  'remove',
  'start',
  'stop',
  'restart',
  'update',
  'rollback',
  'cleanup',
  'connect-google',
] as const;
type Command = (typeof COMMANDS)[number];
/** The attempts that act on an assistant's host service alone. */
type ServiceCommand = Extract<Command, 'start' | 'stop' | 'restart'>;

function isCommand(value: string | undefined): value is Command {
  return COMMANDS.some((command) => command === value);
}

/** A stop summary. The line presenter prints it; the terminal presenter draws it with clack. */
export interface StopReport {
  readonly outcome: 'ready' | 'paused' | 'failed' | 'busy';
  readonly headline: string;
  readonly details: readonly string[];
  /** The failed command's redacted stderr tail. */
  readonly tail?: string;
}

/** Level-1 output (docs/setup-flow.md): progress while steps run, then one stop summary. */
export interface Presenter {
  event(event: RunEvent): void;
  /** Release the terminal to a prompt or interactive child; `resume` redraws running progress. */
  suspend(): void;
  resume(): void;
  line(text: string): void;
  report(report: StopReport): void;
}

/** Everything the failure summary names, and what diagnosis and retry need. */
export interface FailureReport {
  readonly command: Command;
  readonly step: string;
  readonly stepLabel?: string;
  readonly code: string;
  readonly cause: string;
  readonly nextAction: string;
  readonly pendingAction?: string;
  readonly progressLog: string;
  readonly rawLog?: string;
  readonly runDirectory: string;
  readonly tail?: string;
  readonly instanceId?: string;
}

export interface AdvanceOptions {
  readonly interaction: Interaction;
  readonly runtime: ProvisionRuntime;
}

export type AdvanceProvision = (operation: InstanceOperation, options: AdvanceOptions) => Promise<ProvisionResult>;
type RemoveAssistantRunner = (
  paths: ControlPlanePaths,
  instanceId: string,
  options: RemovalOptions,
) => Promise<RemovalOutcome | undefined>;

export interface CliRuntime {
  paths?: ControlPlanePaths;
  stdout?: LineWriter;
  stderr?: LineWriter;
  /** Where secret environment variables are read. */
  environment?: NodeJS.ProcessEnv;
  /** Terminal rendering; durable lines on stdout and stderr when absent. */
  presenter?: Presenter;
  /** Terminal prompts. Absent means no person can be asked. */
  prompts?: InteractivePrompts;
  /** Interactive failure loop: diagnosis, then whether to retry. */
  onFailure?: (report: FailureReport) => Promise<'retry' | 'stop'>;
  advanceProvision?: AdvanceProvision;
  /** Resolves the release create reserves: this tool's own commit on the track. */
  resolveReleaseTarget?: (request: CreateTargetRequest) => Promise<ReleaseTarget>;
  holdLoopbackPorts?: () => Promise<HeldLoopbackPorts>;
  collectCreateInputs?: (context: CreatePromptContext) => Promise<CreateSetupAnswers>;
  reserveInstance?: typeof reserveInstance;
  /** Checks what create and resume need; the terminal driver adds guided installation. */
  checkPrerequisites?: (request: PrerequisiteRequest, interaction: Interaction) => Promise<Prerequisites>;
  describeRemoval?: typeof describeRemoval;
  removeAssistant?: RemoveAssistantRunner;
  /** Absent means removal requires `--yes`. */
  confirmRemoval?: (preview: RemovalPreview) => Promise<boolean>;
  managedIngressSetup?: RetainedManagedIngressSetupSession;
  /** Upstream's `.env` upsert (`setup/set-env.ts`), which the driver supplies. */
  upsertEnvVars?: UpsertEnvVars;
  /** Upstream's host readiness helpers (`setup/lib/host-status.mjs`), which the driver supplies. */
  hostStatus?: HostStatusHelpers;
  /** Upstream's service helpers (`scripts/update/service.ts`), which the driver supplies; they control each host. */
  serviceHelpers?: NanoclawServiceHelpers;
  /** Replaces this process with the tool `ncl` and `logs` hand it to; tests substitute it. */
  execve?: NonNullable<NodeJS.Process['execve']>;
  /** This tool's provider setup, which the driver reads from `setup/providers` when an update needs it. */
  toolProviderSetup?: () => Promise<ToolProviderSetup>;
  /** Absent means an update requires `--yes`. */
  confirmUpdate?: (preview: UpdatePreview) => Promise<boolean>;
  /** Asks once, after `update --all` shows its plan and before anything is staged; absent means it requires `--yes`. */
  confirmUpdateAll?: (plan: UpdateAllPlan) => Promise<boolean>;
  /** The central migrations this tool's release applies, which `update --all`'s plan names; its registry when absent. */
  releaseMigrations?: () => Promise<readonly string[]>;
  /** Asks before a rollback restores the pre-update snapshot; absent means that restore requires `--yes`. */
  confirmRollback?: (preview: RollbackPreview) => Promise<boolean>;
  /** An update's boundary seams; each defaults to the real one. */
  update?: UpdateSeams;
  /** The checkout this tool runs from, which only the launcher names: a stray NanoClaw install there is removed. */
  toolCheckout?: ToolCheckout;
}

/** The launcher's helpers an update runs with. */
type UpdateLauncher = Required<
  Pick<CliRuntime, 'serviceHelpers' | 'toolProviderSetup' | 'upsertEnvVars' | 'hostStatus'>
>;

const COMMON_OPTIONS = ['secrets-file'] as const;
/** The host service commands name the assistant and nothing else: they read no secrets. */
const SERVICE_OPTIONS: OptionSpec = { values: ['id'], switches: [] };

/** A command's flags, with the options it takes once per value. */
interface CommandOptionSpec extends OptionSpec {
  /** Options given once per value, such as create's `--principal-email`; their values keep the order given. */
  readonly repeatable?: readonly string[];
}

interface ParsedOptions {
  /** Each option given once, and `'true'` for each switch. */
  readonly options: CommandOptions;
  /** Each repeatable option's values, in the order given. */
  readonly repeated: Readonly<Record<string, readonly string[]>>;
}

const COMMAND_OPTIONS: Readonly<Record<Command, CommandOptionSpec>> = {
  create: {
    values: ['track', 'source-remote', 'google-account', ...CREATE_INPUT_FLAGS, ...COMMON_OPTIONS],
    switches: [],
    repeatable: [PRINCIPAL_EMAIL_FLAG],
  },
  resume: {
    values: ['id', 'messaging-group-id', 'google-client-file', ...COMMON_OPTIONS],
    switches: ['chat-configured'],
  },
  remove: { values: ['id', 'abandon', ...COMMON_OPTIONS], switches: ['yes'] },
  'connect-google': { values: ['id', 'google-client-file', ...COMMON_OPTIONS], switches: [] },
  start: SERVICE_OPTIONS,
  stop: SERVICE_OPTIONS,
  restart: SERVICE_OPTIONS,
  update: { values: ['id', 'track', 'source-remote'], switches: ['yes', 'all'] },
  rollback: { values: ['id'], switches: ['snapshot', 'yes'] },
  cleanup: { values: [], switches: [] },
};

function parseOptions(
  args: readonly string[],
  { values, switches, repeatable = [] }: CommandOptionSpec,
): ParsedOptions {
  const options: Record<string, string> = {};
  const repeated: Record<string, string[]> = {};
  for (let index = 0; index < args.length; ) {
    const flag = args[index];
    if (!flag?.startsWith('--')) throw new GwsEaError('invalid_arguments', 'Expected an option flag');
    const name = flag.slice(2);
    const repeats = repeatable.includes(name);
    if (!repeats && !values.includes(name) && !switches.includes(name)) {
      throw new GwsEaError('invalid_arguments', `Unknown option --${name}`);
    }
    if (options[name] !== undefined) throw new GwsEaError('invalid_arguments', `Option --${name} was provided twice`);
    if (switches.includes(name)) {
      options[name] = 'true';
      index += 1;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new GwsEaError('invalid_arguments', `Option --${name} requires a value`);
    }
    if (repeats) (repeated[name] ??= []).push(value);
    else options[name] = value;
    index += 2;
  }
  return { options, repeated };
}

/**
 * `update --all` moves every assistant on its own track and repository, so it
 * names no assistant, and moving one elsewhere stays a decision made for it
 * alone, with `update --id`.
 */
function assertUpdatesEveryAssistant(options: CommandOptions): void {
  if (options.id !== undefined) throw new GwsEaError('invalid_arguments', 'Pass either --id or --all, not both.');
  if (options.track !== undefined || options['source-remote'] !== undefined) {
    throw new GwsEaError(
      'invalid_arguments',
      '--all keeps each assistant on its own track and repository; move one elsewhere with gws-ea update --id <instance_id> --track <track>.',
    );
  }
}

/** `--abandon a,b`: resources removal may leave behind when it cannot observe them. */
function parseAbandon(value: string | undefined): ReadonlySet<AbandonableResource> {
  const abandonable: readonly string[] = ABANDONABLE_RESOURCES;
  const resources = value === undefined ? [] : value.split(',');
  const unknown = resources.find((resource) => !abandonable.includes(resource));
  if (unknown !== undefined) {
    throw new GwsEaError(
      'invalid_arguments',
      `--abandon: ${JSON.stringify(unknown)} cannot be abandoned; choose from ${ABANDONABLE_RESOURCES.join(', ')}`,
      { details: { flag: '--abandon' } },
    );
  }
  return new Set(resources.filter((resource): resource is AbandonableResource => abandonable.includes(resource)));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function isBusy(error: unknown): boolean {
  return error instanceof GwsEaError && error.code === 'instance_busy';
}

/**
 * The assistant's state refused the command: an unfinished update or
 * rollback, a removal under way, a create not yet finished, no host service
 * installed to start, a stopped assistant an update cannot prove its release
 * on, a release that is not newer than the one it runs, no release of its own
 * kept to roll back to, or a rollback that went back to the release it left;
 * or, in a turn of `update --all`, the tool's checkout moved off the release
 * the run set out with. Its message names the command that moves the
 * assistant on; rerunning this one cannot.
 */
const STATE_REFUSALS: ReadonlySet<string> = new Set([
  'operation_in_progress',
  'removal_in_progress',
  'instance_not_created',
  'service_not_installed',
  'host_not_running',
  'release_not_newer',
  'rollback_unavailable',
  'kept_release_mismatch',
  'rollback_failed',
  'tool_checkout_moved',
]);

function isStateRefusal(error: unknown): boolean {
  return error instanceof GwsEaError && STATE_REFUSALS.has(error.code);
}

function busy(): GwsEaError {
  return new GwsEaError('instance_busy', 'Instance operation is already in progress; no action was taken.');
}

function createLinePresenter(output: LineWriter, errorOutput: LineWriter): Presenter {
  let last: string | undefined;
  const progress = (text: string): void => {
    if (text === last) return;
    last = text;
    output(text);
  };
  return {
    event(event) {
      if (event.type === 'step-started' && event.label) progress(event.label);
      else if (event.type === 'step-waiting') progress(event.reason);
    },
    suspend: () => undefined,
    resume: () => undefined,
    line: output,
    report(report) {
      const write = report.outcome === 'ready' || report.outcome === 'paused' ? output : errorOutput;
      write(report.headline);
      for (const detail of report.details) write(detail);
      for (const line of report.tail ? report.tail.split('\n') : []) write(`  ${line}`);
    },
  };
}

function exitFact(details: GwsEaErrorDetails | undefined): string | undefined {
  if (typeof details?.timeoutMs === 'number') return `timed out after ${(details.timeoutMs / 1000).toFixed(1)}s`;
  if (typeof details?.signal === 'string') return `signal ${details.signal}`;
  if (typeof details?.exitCode === 'number') return `code ${details.exitCode}`;
  if (typeof details?.errno === 'string') return `errno ${details.errno}`;
  return undefined;
}

function pauseReport(pause: ProvisionHumanPause, resume: (extra?: string) => string, log: string): StopReport {
  const headline = `Paused at ${pause.phase}: ${pause.message}`;
  if (pause.choices?.length) {
    return {
      outcome: 'paused',
      headline,
      details: [
        'Eligible principal conversations:',
        ...pause.choices.map(
          (choice) => `  ${JSON.stringify(choice.label)}: ${resume(`--messaging-group-id ${shellQuote(choice.id)}`)}`,
        ),
        `Log: ${log}`,
      ],
    };
  }
  return {
    outcome: 'paused',
    headline,
    details: [
      ...(pause.details ?? []).map((detail) => `  ${detail}`),
      ...(pause.actionUrl ? [`Open: ${pause.actionUrl}`] : []),
      `Continue with: ${resume(pause.resumeFlag)}`,
      `Log: ${log}`,
    ],
  };
}

type Outcome =
  | { readonly status: 'ready'; readonly message: string; readonly details?: readonly string[] }
  | { readonly status: 'paused'; readonly pause: ProvisionHumanPause };

type Attempt =
  | { readonly status: 'done'; readonly exitCode: number }
  | { readonly status: 'failed'; readonly report: FailureReport; readonly retry: () => Promise<Attempt> };

/** What one attempt knows about its instance as it runs. */
interface AttemptState {
  instanceId?: string;
  reserved: boolean;
}

interface Session {
  readonly reporter: StepReporter & { readonly run: RunLog };
  readonly interaction: Interaction;
  readonly secrets: SecretSource;
  readonly state: AttemptState;
}

interface AttemptPlan {
  readonly command: Command;
  readonly args: readonly string[];
  readonly options: CommandOptions;
  readonly instanceId?: string;
  readonly meta?: Readonly<Record<string, string>>;
  readonly decisions?: HumanDecisions;
  readonly work: (session: Session) => Promise<Outcome>;
}

class Cli {
  readonly #paths: ControlPlanePaths;
  readonly #presenter: Presenter;
  readonly #runtime: CliRuntime;
  readonly #managedIngressSetup: RetainedManagedIngressSetupSession;
  /** Set while a terminal waits on a pause: a signal then stops the wait, not the run. */
  #waiting: AbortController | undefined;

  constructor(runtime: CliRuntime, presenter: Presenter, managedIngressSetup: RetainedManagedIngressSetupSession) {
    this.#paths = runtime.paths ?? resolveControlPlanePaths();
    this.#presenter = presenter;
    this.#runtime = runtime;
    this.#managedIngressSetup = managedIngressSetup;
  }

  /**
   * Validate arguments up front; the returned attempt reports every later
   * failure itself. Each command has its own branch, so none falls through
   * to another command's work.
   */
  prepare(command: Command, args: readonly string[]): () => Promise<Attempt> {
    const { options, repeated } = parseOptions(args, COMMAND_OPTIONS[command]);
    switch (command) {
      case 'create': {
        const track = requireOption(options, 'track');
        const source = resolveReleaseSource(track, options['source-remote']);
        const principalEmails = parsePrincipalEmailFlags(repeated[PRINCIPAL_EMAIL_FLAG] ?? []);
        return () =>
          this.#attempt({
            command,
            args,
            options,
            meta: { track },
            work: (session) => this.#createWork(session, options, track, source, principalEmails),
          });
      }
      case 'resume': {
        const instanceId = targetInstance(options);
        return () =>
          this.#attempt({
            command,
            args,
            options,
            instanceId,
            decisions: {
              chatConfigured: options['chat-configured'] === 'true',
              ...(options['messaging-group-id'] ? { messagingGroupId: options['messaging-group-id'] } : {}),
              ...(options['google-client-file']
                ? { googleClientFile: path.resolve(options['google-client-file']) }
                : {}),
            },
            work: (session) => this.#resumeWork(session, instanceId),
          });
      }
      case 'remove': {
        const instanceId = targetInstance(options);
        const abandon = parseAbandon(options.abandon);
        return () =>
          this.#attempt({
            command,
            args,
            options,
            instanceId,
            work: (session) => this.#removeWork(session, options, instanceId, abandon),
          });
      }
      case 'start':
      case 'stop':
      case 'restart': {
        const instanceId = targetInstance(options);
        return () =>
          this.#attempt({
            command,
            args,
            options,
            instanceId,
            work: (session) => this.#serviceWork(session, command, instanceId),
          });
      }
      case 'update': {
        if (options.all === 'true') {
          assertUpdatesEveryAssistant(options);
          return () => this.#updateAll(options.yes === 'true');
        }
        const request: UpdateRequest = {
          instanceId: targetInstance(options),
          ...(options.track === undefined ? {} : { track: options.track }),
          ...(options['source-remote'] === undefined ? {} : { sourceRemote: options['source-remote'] }),
        };
        return () =>
          this.#attempt({
            command,
            args,
            options,
            instanceId: request.instanceId,
            work: (session) => this.#updateWork(session, request, options.yes === 'true'),
          });
      }
      case 'rollback': {
        const instanceId = targetInstance(options);
        return () =>
          this.#attempt({
            command,
            args,
            options,
            instanceId,
            work: (session) => this.#rollbackWork(session, instanceId, options),
          });
      }
      case 'cleanup':
        return () => this.#attempt({ command, args, options, work: (session) => this.#cleanupWork(session) });
      case 'connect-google': {
        const instanceId = targetInstance(options);
        return () =>
          this.#attempt({
            command,
            args,
            options,
            instanceId,
            decisions: {
              chatConfigured: false,
              ...(options['google-client-file']
                ? { googleClientFile: path.resolve(options['google-client-file']) }
                : {}),
            },
            work: (session) => this.#connectGoogleWork(session, instanceId),
          });
      }
      default: {
        const unhandled: never = command;
        throw new GwsEaError('invalid_arguments', `Unknown command ${String(unhandled)}`);
      }
    }
  }

  /** The command that continues from where an attempt stopped; `extra` carries a pause's decision flag. */
  #continueCommand(plan: AttemptPlan, state: AttemptState, extra?: string): string {
    const secretsFile = plan.options['secrets-file'];
    const common = secretsFile ? `--secrets-file ${shellQuote(secretsFile)}` : undefined;
    const join = (...parts: Array<string | undefined>): string => parts.filter(Boolean).join(' ');
    switch (plan.command) {
      case 'remove': {
        const abandon = [...new Set([...(plan.options.abandon?.split(',') ?? []), ...(extra ? [extra] : [])])];
        return join(
          `gws-ea remove --id ${state.instanceId}`,
          plan.options.yes ? '--yes' : undefined,
          abandon.length > 0 ? `--abandon ${abandon.join(',')}` : undefined,
          common,
        );
      }
      case 'start':
      case 'stop':
      case 'restart':
        return `gws-ea ${plan.command} --id ${state.instanceId}`;
      case 'update': {
        const { track, yes } = plan.options;
        const remote = plan.options['source-remote'];
        return join(
          `gws-ea update --id ${state.instanceId}`,
          track === undefined ? undefined : `--track ${shellQuote(track)}`,
          remote === undefined ? undefined : `--source-remote ${shellQuote(remote)}`,
          yes ? '--yes' : undefined,
        );
      }
      case 'rollback':
        return join(
          `gws-ea rollback --id ${state.instanceId}`,
          plan.options.snapshot ? '--snapshot' : undefined,
          plan.options.yes ? '--yes' : undefined,
        );
      case 'cleanup':
        return 'gws-ea cleanup';
      case 'connect-google':
        return join(`gws-ea connect-google --id ${state.instanceId}`, extra, common);
      case 'create':
      case 'resume': {
        if (state.reserved && state.instanceId) return join(`gws-ea resume --id ${state.instanceId}`, extra, common);
        const track = plan.options.track ?? '';
        return `gws-ea create --track ${/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(track) ? track : '<track>'} (with the same options)`;
      }
    }
  }

  /** Create and resume continue by resuming once the assistant is reserved; every other attempt is retried as given. */
  #nextAction(plan: AttemptPlan, state: AttemptState): string {
    const resumes = (plan.command === 'create' || plan.command === 'resume') && state.reserved;
    return `${resumes ? 'Resume' : 'Retry'} with: ${this.#continueCommand(plan, state)}`;
  }

  /** Retrying a reserved create resumes it; every other attempt reruns as given. */
  #retry(plan: AttemptPlan, state: AttemptState): () => Promise<Attempt> {
    if (plan.command !== 'create' || !state.reserved || !state.instanceId) {
      return () => this.prepare(plan.command, plan.args)();
    }
    const resumeArgs = [
      '--id',
      state.instanceId,
      ...(plan.options['secrets-file'] ? ['--secrets-file', plan.options['secrets-file']] : []),
    ];
    return () => this.prepare('resume', resumeArgs)();
  }

  #checkPrerequisites(request: PrerequisiteRequest, interaction: Interaction): Promise<Prerequisites> {
    return (this.#runtime.checkPrerequisites ?? checkPrerequisites)(request, interaction);
  }

  #advance(operation: InstanceOperation, options: AdvanceOptions): Promise<ProvisionResult> {
    if (this.#runtime.advanceProvision) return this.#runtime.advanceProvision(operation, options);
    const { upsertEnvVars, hostStatus, serviceHelpers } = this.#runtime;
    if (!upsertEnvVars || !hostStatus || !serviceHelpers) {
      throw new GwsEaError('interactive_setup_unavailable', 'Run this command through the gws-ea launcher');
    }
    return runProductionProvision(operation, {
      upsertEnvVars,
      hostStatus,
      serviceHelpers,
      interaction: options.interaction,
      runtime: options.runtime,
      managedIngress: { setupSession: this.#managedIngressSetup },
    });
  }

  async #createWork(
    { reporter, interaction, secrets, state }: Session,
    options: CommandOptions,
    track: string,
    source: ReleaseSource,
    principalEmails: readonly string[],
  ): Promise<Outcome> {
    const paths = this.#paths;
    const run = reporter.run;
    run.userInput('release_source', `${source.remote} ${source.ref}`);
    const googleAccount = options['google-account'];
    const prerequisites = await runStep(reporter, PREREQUISITES_STEP, () =>
      this.#checkPrerequisites(
        { command: 'create', paths, ...(googleAccount ? { account: googleAccount } : {}) },
        interaction,
      ),
    );
    const instanceId = await allocateInstanceId(paths);
    state.instanceId = instanceId;
    this.#presenter.line(`instance_id: ${instanceId}`);
    // After the ID, which scripts read as the first line.
    await this.#cleanStrayInstall(reporter);

    const provided: Partial<Record<CreateInputFlag, string>> = {};
    for (const flag of CREATE_INPUT_FLAGS) if (options[flag] !== undefined) provided[flag] = options[flag];
    const collect =
      this.#runtime.collectCreateInputs ??
      (async (): Promise<CreateSetupAnswers> => {
        throw new GwsEaError('interactive_setup_unavailable', 'Run this command through the gws-ea launcher');
      });
    const setup = await runStep(reporter, { id: 'inputs' }, () =>
      collect({
        instanceId,
        track,
        sourceRemote: source.remote,
        provided,
        providedPrincipalEmails: principalEmails,
        secrets,
        prerequisites,
        managedIngressSetup: this.#managedIngressSetup,
      }),
    );
    run.userInput('ingress', setup.ingress.mode);
    run.userInput('provider', setup.bootstrapManifest.provider.id);

    const { release } = await runStep(reporter, { id: 'resolve_release', label: 'Resolving the release…' }, () =>
      (this.#runtime.resolveReleaseTarget ?? resolveReleaseTarget)({ track, source }),
    );
    await runStep(reporter, { id: 'reserve', label: 'Reserving the assistant…' }, async () => {
      await this.#reserve(state, track, source.remote, setup, release.deployed_commit, prerequisites.account);
      await run.assignInstance(instanceId);
    });

    const operation = await acquireInstanceOperation(paths, instanceId, { command: 'create' });
    if (!operation) throw busy();
    try {
      return await this.#provision(reporter, operation, interaction);
    } finally {
      operation.release();
    }
  }

  /**
   * Allocate the instance's ports and reserve it. The ports are held only
   * until the reservation claims them; each runtime binds its own on start.
   */
  async #reserve(
    state: AttemptState,
    track: string,
    sourceRemote: string,
    setup: CreateSetupAnswers,
    commit: string,
    gcpAccount: string,
  ): Promise<void> {
    const paths = this.#paths;
    const instanceId = state.instanceId!;
    const bootstrapManifest = validateProductionBootstrapManifest(setup.bootstrapManifest);
    const held = await (this.#runtime.holdLoopbackPorts ?? holdLoopbackPorts)();
    try {
      const input = createReservation(track, sourceRemote, setup, {
        instanceId,
        commit,
        ports: held.ports,
        gcpAccount,
      });
      await installProductionBootstrapManifest(paths, instanceId, bootstrapManifest);
      try {
        await (this.#runtime.reserveInstance ?? reserveInstance)(paths, input);
        state.reserved = true;
      } catch (error) {
        try {
          await getInstanceReservation(paths, instanceId);
          state.reserved = true;
          // eslint-disable-next-line no-catch-all/no-catch-all -- An unobservable reservation counts as reserved: resuming is safe, discarding it is not. The original error is rethrown below.
        } catch (observationError) {
          if (observationError instanceof GwsEaError && observationError.code === 'unknown_instance') {
            await removeProductionBootstrapManifest(paths, instanceId);
          } else {
            state.reserved = true;
          }
        }
        throw error;
      }
    } finally {
      await held.release();
    }
  }

  /**
   * Provision until ready or paused. A terminal attends each pause, asking
   * or waiting for what it needs, and provisioning runs on in the same
   * process; without one, or when the person stops, the pause is reported.
   */
  async #provision(reporter: StepReporter, operation: InstanceOperation, interaction: Interaction): Promise<Outcome> {
    let current = interaction;
    for (;;) {
      const result = await runStep(reporter, { id: 'provision' }, () =>
        this.#advance(operation, { interaction: current, runtime: reporter }),
      );
      if (result.status !== 'paused') return { status: 'ready', message: `Instance ${operation.instanceId} is ready.` };
      const response = await this.#attend(current, result.pause);
      if (response.kind === 'stop') return result;
      if (response.decisions) current = current.withDecisions(response.decisions);
    }
  }

  async #attend(interaction: Interaction, pause: ProvisionHumanPause): Promise<PauseResponse> {
    const waiting = new AbortController();
    this.#waiting = waiting;
    try {
      return await interaction.attendPause(pause, waiting.signal);
    } finally {
      this.#waiting = undefined;
    }
  }

  async #resumeWork({ reporter, interaction }: Session, instanceId: string): Promise<Outcome> {
    const operation = await acquireInstanceOperation(this.#paths, instanceId, { command: 'resume' });
    if (!operation) throw busy();
    try {
      await runStep(reporter, PREREQUISITES_STEP, async () => {
        // An instance this launcher cannot continue is refused before sign-in is asked for.
        await readProvisionJournal(this.#paths, instanceId);
        const reservation = await getInstanceReservation(this.#paths, instanceId);
        const account = reservation.exclusive_resource_claims.gcp_account;
        const host = await recordedHost(this.#paths, reservation);
        await this.#checkPrerequisites({ command: 'resume', paths: this.#paths, account, ...host }, interaction);
      });
      return await this.#provision(reporter, operation, interaction);
    } finally {
      operation.release();
    }
  }

  async #removeWork(
    { reporter, interaction }: Session,
    options: CommandOptions,
    instanceId: string,
    abandon: ReadonlySet<AbandonableResource>,
  ): Promise<Outcome> {
    const preview = await runStep(reporter, { id: 'inspect' }, () =>
      (this.#runtime.describeRemoval ?? describeRemoval)(this.#paths, instanceId),
    );
    for (const line of removalPreviewLines(preview)) this.#presenter.line(line);
    if (!options.yes) {
      const confirm = this.#runtime.confirmRemoval;
      if (!confirm) {
        throw new GwsEaError(
          'input_required',
          'Removal needs confirmation: pass --yes, or run gws-ea remove in a terminal to be asked.',
        );
      }
      if (!(await confirm(preview))) return { status: 'ready', message: 'Removal cancelled. Nothing was changed.' };
    }
    const remove: RemoveAssistantRunner = this.#runtime.removeAssistant ?? removeAssistant;
    const removed = await runStep(reporter, { id: 'remove', label: 'Removing the assistant…' }, () =>
      remove(this.#paths, instanceId, { interaction, abandon, reporter, serviceHelpers: this.#runtime.serviceHelpers }),
    );
    return {
      status: 'ready',
      message: `Assistant ${instanceId} was removed.`,
      details: removalSummary(preview, removed),
    };
  }

  /**
   * `start`, `stop`, and `restart` act on the assistant's host service alone,
   * through NanoClaw's own helpers and with its semantics (KTD3): agent
   * containers are left for the next start to adopt, and a stop lasts until
   * the next start, login, or reboot. A start or restart ends only once the
   * host answers on its CLI socket.
   */
  /**
   * Connect a created assistant's own Google account (KTD5): the same
   * resources as create's `connect_google` step, outside the provision
   * journal, so a lost or outdated sign-in is repaired without recreating
   * the assistant.
   */
  async #connectGoogleWork({ reporter, interaction }: Session, instanceId: string): Promise<Outcome> {
    const operation = await acquireInstanceOperation(this.#paths, instanceId, { command: 'connect-google' });
    if (!operation) throw busy();
    try {
      const runtime = await loadCreatedRuntime(this.#paths, instanceId);
      const reservation = await getInstanceReservation(this.#paths, instanceId);
      const claims = reservation.exclusive_resource_claims;
      await runStep(reporter, PREREQUISITES_STEP, async () => {
        const host = await recordedHost(this.#paths, reservation);
        await this.#checkPrerequisites(
          { command: 'resume', paths: this.#paths, account: claims.gcp_account, ...host },
          interaction,
        );
      });
      const result = await runStepOutsideJournal(
        'connect_google',
        { label: "Connecting the assistant's Google account…", resources: googleConnectionResources() },
        {
          input: {
            gcp: {
              instanceId,
              projectId: claims.gcp_project_id,
              account: claims.gcp_account,
              serviceAccountEmail: claims.gchat_service_account,
              credentialFile: runtime.secret_files.gchat_credentials,
              cwd: runtime.instance_root,
            },
            google: {
              runtime,
              assistantWorkspaceEmail: claims.workspace_email,
              ...(interaction.decisions.googleClientFile ? { clientFile: interaction.decisions.googleClientFile } : {}),
              signIn: (request) => interaction.signInAssistantToGoogle(request),
              resumeCommand: `gws-ea connect-google --id ${instanceId}`,
            },
          },
        },
        { ...reporter, signIn: () => interaction.signInToGoogleCloud(claims.gcp_account) },
      );
      if (result.status === 'paused') return result;
      return {
        status: 'ready',
        message: `Assistant ${instanceId} is connected to Google as ${claims.workspace_email}.`,
        details: ['Its host keeps the Calendar access agents use fresh while it runs.'],
      };
    } finally {
      operation.release();
    }
  }

  async #serviceWork({ reporter }: Session, command: ServiceCommand, instanceId: string): Promise<Outcome> {
    const operation = await acquireInstanceOperation(this.#paths, instanceId, { command });
    if (!operation) throw busy();
    try {
      const record = await loadCreatedRuntime(this.#paths, instanceId);
      const helpers = this.#runtime.serviceHelpers;
      if (!helpers) {
        throw new GwsEaError('interactive_setup_unavailable', 'Run this command through the gws-ea launcher');
      }
      const service = createServiceControl(helpers, runtimeServiceTarget(record));
      switch (command) {
        case 'start': {
          const started = await runStep(reporter, { id: 'start', label: 'Starting the assistant…' }, () =>
            service.start(),
          );
          await verifyServing(reporter, service, instanceId);
          return {
            status: 'ready',
            message:
              started === 'started'
                ? `Assistant ${instanceId} started.`
                : `Assistant ${instanceId} is already running.`,
          };
        }
        case 'stop': {
          const stopped = await runStep(reporter, { id: 'stop', label: 'Stopping the assistant…' }, () =>
            service.stop(),
          );
          return stopped === 'stopped'
            ? {
                status: 'ready',
                message: `Assistant ${instanceId} stopped.`,
                details: [
                  'Its agent containers keep running for the next start to adopt.',
                  'It stays stopped until the next gws-ea start, login, or reboot.',
                ],
              }
            : { status: 'ready', message: `Assistant ${instanceId} is already stopped.` };
        }
        case 'restart': {
          const restarted = await runStep(reporter, { id: 'restart', label: 'Restarting the assistant…' }, () =>
            service.restart(),
          );
          await verifyServing(reporter, service, instanceId);
          return {
            status: 'ready',
            message:
              restarted === 'restarted'
                ? `Assistant ${instanceId} restarted.`
                : `Assistant ${instanceId} was not running; it is now started.`,
          };
        }
      }
    } finally {
      operation.release();
    }
  }

  #updateLauncher(): UpdateLauncher {
    const { serviceHelpers, toolProviderSetup, upsertEnvVars, hostStatus } = this.#runtime;
    if (!serviceHelpers || !toolProviderSetup || !upsertEnvVars || !hostStatus) {
      throw new GwsEaError('interactive_setup_unavailable', 'Run this command through the gws-ea launcher');
    }
    return { serviceHelpers, toolProviderSetup, upsertEnvVars, hostStatus };
  }

  /** `update --id`: one assistant's update, reported as its stop summary. */
  async #updateWork({ reporter }: Session, request: UpdateRequest, yes: boolean): Promise<Outcome> {
    const confirm = updateConfirmation(yes, this.#runtime.confirmUpdate);
    await this.#cleanStrayInstall(reporter);
    const update = await this.#updateAssistant(reporter, request, confirm, this.#updateLauncher());
    return updateOutcome(request.instanceId, update);
  }

  /**
   * One assistant's update, which `update --id` and each turn of `update
   * --all` run: stage this tool's release beside the running assistant, show
   * what the update changes, and once confirmed carry it through its switch
   * to the committed release (R1, R2). An update already under way to this
   * release is continued, not staged again; one with no release to return to
   * is superseded by an update to another (KTD9); and a committed one's
   * follow-ups are finished before anything else (KTD2), even when this
   * release is the one already committed. Undefined when its preview was
   * declined, which left the staging for the next update.
   */
  async #updateAssistant(
    reporter: Session['reporter'],
    request: UpdateRequest,
    confirm: (preview: UpdatePreview) => Promise<boolean>,
    launcher: UpdateLauncher,
  ): Promise<AssistantUpdate | undefined> {
    const seams = this.#runtime.update ?? {};
    const intent = await runStep(reporter, { id: 'resolve_release', label: 'Resolving the release…' }, () =>
      resolveUpdateIntent(this.#paths, request, seams),
    );
    const operation = await acquireInstanceOperation(this.#paths, request.instanceId, {
      command: 'update',
      target: intent.target,
    });
    if (!operation) throw busy();
    try {
      const dependencies: UpdateDependencies = {
        ...seams,
        serviceHelpers: launcher.serviceHelpers,
        providerSetup: await launcher.toolProviderSetup(),
        upsertEnvVars: launcher.upsertEnvVars,
        hostStatus: launcher.hostStatus,
        reporter,
      };
      const unfinished = await readOperationRecord(this.#paths, request.instanceId);
      if (unfinished?.phase === 'committed') {
        await finishFollowUps(operation, dependencies);
        if (sameRelease(unfinished.to, intent.target)) return { kind: 'completed', release: unfinished.to };
      }
      // The gate admitted this update: it continues an open update to this release, or supersedes one with no release
      // to return to (KTD9), which is staged anew.
      const continuing =
        unfinished?.phase !== 'committed' &&
        unfinished?.kind === 'update' &&
        unfinished.closed === undefined &&
        sameRelease(unfinished.to, intent.target);
      if (!continuing) {
        const staged = await prepareUpdate(operation, intent, dependencies);
        for (const line of updatePreviewLines(staged.preview)) this.#presenter.line(line);
        if (!(await confirmStagedUpdate(operation, staged, confirm))) return undefined;
      }
      return { kind: 'updated', updated: await continueUpdate(operation, dependencies) };
    } finally {
      operation.release();
    }
  }

  /**
   * `update --all`: every assistant that can move to this tool's release, one
   * at a time in `list` order, each through `update --id`'s own attempt, with
   * its run log, progress, preview, and stop summary; the rest are skipped
   * and named (see `update-all.ts`). The plan is confirmed once, at a
   * terminal or by `--yes`; how, and the launcher, are settled before any
   * assistant is read.
   */
  async #updateAll(yes: boolean): Promise<Attempt> {
    /* eslint-disable no-catch-all/no-catch-all -- The CLI boundary turns every failure before the first turn into a redacted summary and exit code. */
    try {
      const confirm = updateConfirmation(yes, this.#runtime.confirmUpdateAll);
      const launcher = this.#updateLauncher();
      const reporter: StepReporter = { emit: (event) => this.#presenter.event(event) };
      // Once for the run, not per assistant: every turn shares the tool checkout.
      await this.#cleanStrayInstall(reporter);
      const { releaseMigrations } = this.#runtime;
      const plan = await runStep(
        reporter,
        { id: 'check_assistants', label: 'Checking which assistants can be updated…' },
        async () =>
          planUpdateAll({
            paths: this.#paths,
            serviceHelpers: launcher.serviceHelpers,
            providerSetup: await launcher.toolProviderSetup(),
            seams: this.#runtime.update ?? {},
            ...(releaseMigrations ? { releaseMigrations } : {}),
          }),
      );
      const summary = await runUpdateAll(
        plan,
        confirm,
        (instanceId, toolCommit) => this.#updateTurn(instanceId, toolCommit, yes, launcher),
        (line) => this.#presenter.line(line),
      );
      this.#presenter.report(summary);
      return { status: 'done', exitCode: EXIT_CODES[summary.outcome] };
    } catch (error) {
      return { status: 'done', exitCode: reportStop(this.#presenter, error) };
    }
    /* eslint-enable no-catch-all/no-catch-all */
  }

  /**
   * One assistant's turn in `update --all`: the attempt `update --id <id>`
   * runs, pinned to the run's release, which reports its own end and recovery
   * guidance. Its preview is shown, not asked about: the plan's confirmation
   * covers it. A failure ends the turn without the interactive retry loop:
   * the run stops there.
   */
  async #updateTurn(
    instanceId: string,
    toolCommit: string,
    yes: boolean,
    launcher: UpdateLauncher,
  ): Promise<UpdateTurn> {
    const request: UpdateRequest = { instanceId, expectedToolCommit: toolCommit };
    const turn: { ended?: AssistantUpdate } = {};
    const attempt = await this.#attempt({
      command: 'update',
      args: ['--id', instanceId, ...(yes ? ['--yes'] : [])],
      options: { id: instanceId, ...(yes ? { yes: 'true' } : {}) },
      instanceId,
      work: async ({ reporter }) => {
        turn.ended = await this.#updateAssistant(reporter, request, confirmWithoutAsking, launcher);
        return updateOutcome(instanceId, turn.ended);
      },
    });
    if (attempt.status === 'done' && attempt.exitCode === EXIT_CODES.ready && turn.ended) return turn.ended;
    return { kind: attempt.status === 'done' && attempt.exitCode === EXIT_CODES.busy ? 'busy' : 'failed' };
  }

  /**
   * `rollback`: return the assistant to its rollback point, or settle what
   * its record says is unfinished (R3). A restore of the pre-update snapshot
   * is shown first and needs confirmation: `--yes`, or a terminal to be asked
   * on; a code-only rollback loses nothing and is not asked about. A
   * committed rollback's follow-ups run last.
   */
  async #rollbackWork({ reporter }: Session, instanceId: string, options: CommandOptions): Promise<Outcome> {
    const { serviceHelpers, upsertEnvVars, hostStatus, confirmRollback } = this.#runtime;
    if (!serviceHelpers || !upsertEnvVars || !hostStatus) {
      throw new GwsEaError('interactive_setup_unavailable', 'Run this command through the gws-ea launcher');
    }
    const timezone = localTimezone();
    const confirm =
      options.yes === 'true' ? async (): Promise<boolean> => true : confirmRollback ? confirmRollback : undefined;
    const request: RollbackRequest = {
      ...(options.snapshot === 'true' ? { snapshot: true } : {}),
      present: (preview) => {
        for (const line of rollbackPreviewLines(preview, timezone)) this.#presenter.line(line);
      },
      ...(confirm ? { confirm } : {}),
    };
    const operation = await acquireInstanceOperation(this.#paths, instanceId, { command: 'rollback' });
    if (!operation) throw busy();
    try {
      const dependencies: CutoverDependencies = {
        ...(this.#runtime.update ?? {}),
        serviceHelpers,
        upsertEnvVars,
        hostStatus,
        reporter,
      };
      const outcome = await rollBack(operation, dependencies, request);
      if (outcome.kind === 'rolled_back' || outcome.kind === 'follow_ups_finished') {
        await finishFollowUps(operation, dependencies);
      }
      return rollbackOutcome(instanceId, outcome, timezone);
    } finally {
      operation.release();
    }
  }

  /** What stray handling needs, which only the launcher supplies. */
  #strayHandling(): (StrayLauncher & { readonly checkout: ToolCheckout }) | undefined {
    const { toolCheckout, hostStatus, serviceHelpers } = this.#runtime;
    return toolCheckout && hostStatus && serviceHelpers
      ? { checkout: toolCheckout, hostStatus, serviceHelpers }
      : undefined;
  }

  /**
   * What `create` and `update` start with (R3–R5): a stray NanoClaw install in
   * the tool checkout is removed without asking, since gws-ea is the only way
   * NanoClaw runs there. With none, nothing is printed; a failure is one
   * warning, and the command goes on.
   */
  async #cleanStrayInstall(reporter: StepReporter): Promise<void> {
    const stray = this.#strayHandling();
    if (!stray) return;
    const { checkout } = stray;
    const line = await runStep(reporter, { id: 'clean_stray' }, async () => {
      let found: StrayInstall | undefined;
      try {
        found = await detectStrayInstall(checkout, this.#paths);
        if (strayParts(found).length === 0) return undefined;
        const removed = await removeStrayInstall(checkout, found, stray);
        return `Removed a stray NanoClaw install from ${checkout.root}: ${removed.join(', ')}.`;
        // eslint-disable-next-line no-catch-all/no-catch-all -- A stray install never stops a create or update; its failure is a warning.
      } catch (error) {
        const what = found
          ? `remove the stray NanoClaw install in ${checkout.root} (${strayParts(found).join(', ')})`
          : `check ${checkout.root} for a stray NanoClaw install`;
        return `Warning: could not ${what}; retry with gws-ea cleanup. ${safeErrorMessage(error)}`;
      }
    });
    if (line) this.#presenter.line(line);
  }

  /** `cleanup`: what `create` and `update` start with, asked for, so Docker that cannot be checked is a failure (KTD7). */
  async #cleanupWork({ reporter }: Session): Promise<Outcome> {
    const stray = this.#strayHandling();
    if (!stray) throw new GwsEaError('interactive_setup_unavailable', 'Run this command through the gws-ea launcher');
    const { checkout } = stray;
    const found = await runStep(
      reporter,
      { id: 'check_stray', label: 'Checking the tool checkout for a stray NanoClaw install…' },
      async () => {
        const detected = await detectStrayInstall(checkout, this.#paths, FULL_CHECK_MS);
        if (strayParts(detected).length === 0 && detected.unchecked) {
          throw new GwsEaError(
            'docker_unavailable',
            `Docker did not answer, so its containers and images could not be checked: ${detected.unchecked}`,
          );
        }
        return detected;
      },
    );
    if (strayParts(found).length === 0) {
      return { status: 'ready', message: `No stray NanoClaw install in ${checkout.root}.` };
    }
    const removed = await runStep(reporter, { id: 'remove_stray', label: 'Removing the stray NanoClaw install…' }, () =>
      removeStrayInstall(checkout, found, stray),
    );
    return { status: 'ready', message: `Removed the stray NanoClaw install from ${checkout.root}.`, details: removed };
  }

  #secrets(options: CommandOptions): Promise<SecretSource> {
    return loadSecretSource({
      environment: this.#runtime.environment ?? process.env,
      ...(options['secrets-file'] ? { file: options['secrets-file'] } : {}),
      configRoot: this.#paths.configRoot,
    });
  }

  /** Run one attempt with its own run log, and turn its end into a stop summary and exit code. */
  async #attempt(plan: AttemptPlan): Promise<Attempt> {
    const paths = this.#paths;
    const presenter = this.#presenter;
    const failures: Array<Extract<RunEvent, { type: 'step-failed' }>> = [];
    let pausedForInput: string | undefined;
    const labels = new Map<string, string>();
    const state: AttemptState = {
      ...(plan.instanceId ? { instanceId: plan.instanceId } : {}),
      reserved: plan.instanceId !== undefined,
    };
    const continueWith = (extra?: string): string => this.#continueCommand(plan, state, extra);
    let run: RunLog | undefined;
    // A signal while waiting on a pause stops the wait. Otherwise, or when the wait was already told to stop
    // and has not (it may be stuck in a probe that cannot be aborted), the run ends, and its log says where.
    const interrupted = (signal: NodeJS.Signals): void => {
      const waiting = this.#waiting;
      if (waiting && !waiting.signal.aborted) {
        waiting.abort();
        return;
      }
      run?.interrupt(signal);
      process.exit(128 + os.constants.signals[signal]);
    };
    for (const signal of INTERRUPT_SIGNALS) process.on(signal, interrupted);
    /* eslint-disable no-catch-all/no-catch-all -- The CLI boundary turns every failure into a redacted summary and exit code. */
    try {
      run = await startRunLog({
        paths,
        command: plan.command,
        ...(plan.instanceId ? { instanceId: plan.instanceId } : {}),
        ...(plan.meta ? { meta: plan.meta } : {}),
        secretDirectories: [
          path.join(paths.cloudflareRoot, 'secrets'),
          ...(plan.instanceId
            ? [
                path.join(paths.instanceRoot(plan.instanceId), 'secrets'),
                path.join(paths.instanceRoot(plan.instanceId), 'onecli', 'secrets'),
              ]
            : []),
        ],
      });
      const emit = (event: RunEvent): void => {
        if (event.type === 'step-started' && event.label) labels.set(event.step, event.label);
        if (event.type === 'step-failed') failures.push(event);
        if (event.type === 'step-paused' && !event.pause) pausedForInput ??= event.step;
        presenter.event(event);
      };
      const reporter = { emit, run };
      const secrets = await runStep(reporter, { id: 'secrets' }, () => this.#secrets(plan.options));
      const interaction = createInteraction({
        decisions: plan.decisions ?? { chatConfigured: false },
        secrets,
        ...(this.#runtime.prompts ? { prompts: this.#runtime.prompts } : {}),
        terminal: presenter,
        managedIngressSetup: this.#managedIngressSetup,
      });
      const outcome = await plan.work({ reporter, interaction, secrets, state });
      if (outcome.status === 'paused') {
        run.pause(outcome.pause.code, outcome.pause.phase);
        presenter.report(pauseReport(outcome.pause, continueWith, run.progressLog));
        return { status: 'done', exitCode: EXIT_CODES.paused };
      }
      run.complete();
      presenter.report({ outcome: 'ready', headline: outcome.message, details: outcome.details ?? [] });
      return { status: 'done', exitCode: EXIT_CODES.ready };
    } catch (error) {
      const step = (error instanceof PauseRequired ? pausedForInput : failures[0]?.step) ?? plan.command;
      const log = run ? [`Log: ${run.progressLog}`] : [];
      if (error instanceof PauseRequired) {
        run?.pause(error.code);
        presenter.report({
          outcome: 'paused',
          headline: `Paused at ${step}: ${safeErrorMessage(error)}`,
          details: [
            ...error.instructions,
            `Continue with: ${continueWith()}`,
            ...(error instanceof RemovalPause ? [`Or leave it behind: ${continueWith(error.resource)}`] : []),
            ...log,
          ],
        });
        return { status: 'done', exitCode: EXIT_CODES.paused };
      }
      run?.abort(error);
      if (isBusy(error)) {
        presenter.report({ outcome: 'busy', headline: safeErrorMessage(error), details: log });
        return { status: 'done', exitCode: EXIT_CODES.busy };
      }
      // Retrying cannot help, and this command's own rerun is not the way on.
      if (isStateRefusal(error)) {
        presenter.report({ outcome: 'failed', headline: safeErrorMessage(error), details: log });
        return { status: 'done', exitCode: EXIT_CODES.failed };
      }
      const nextAction = this.#nextAction(plan, state);
      if (!run || (error instanceof GwsEaError && error.code === 'cancelled')) {
        presenter.report({
          outcome: 'failed',
          headline: `Stopped at ${step}: ${safeErrorMessage(error)}`,
          details: [nextAction, ...log],
        });
        return { status: 'done', exitCode: EXIT_CODES.failed };
      }
      const report = failureReport(plan.command, nextAction, state, run, error, failures[0], labels);
      presenter.report(failureStop(report, error));
      return { status: 'failed', report, retry: this.#retry(plan, state) };
    } finally {
      for (const signal of INTERRUPT_SIGNALS) process.off(signal, interrupted);
    }
    /* eslint-enable no-catch-all/no-catch-all */
  }
}

/** Where an update leaves the assistant: on its release, the one it ran kept to roll back to when it has one. */
function updatedOutcome(instanceId: string, updated: UpdatedAssistant): Outcome {
  return {
    status: 'ready',
    message: `Assistant ${instanceId} was updated to ${releaseLine(updated.to)}.`,
    details: updated.rollbackTarget
      ? [`Its previous release, ${releaseLine(updated.from)}, is kept to roll back to.`]
      : ['It has no previous release to roll back to.'],
  };
}

/** Where a rollback left the assistant. */
function rollbackOutcome(instanceId: string, outcome: RollbackOutcome, timezone: string): Outcome {
  switch (outcome.kind) {
    case 'rolled_back':
      return {
        status: 'ready',
        message: `Assistant ${instanceId} was rolled back to ${releaseLine(outcome.to)}.`,
        details:
          outcome.mode === 'code_only'
            ? ['Only its code went back: every conversation, memory, and setting since the update was kept.']
            : [
                `Its snapshot from ${formatLocalTime(outcome.snapshotAt, timezone)} was restored.`,
                `What it recorded since on ${releaseLine(outcome.from)} is kept in ${outcome.keptAt} until another snapshot restore replaces it, or the assistant is removed.`,
              ],
      };
    case 'update_discarded':
      return {
        status: 'ready',
        message: `The update of assistant ${instanceId} to ${releaseLine(outcome.discarded)} was discarded; it runs ${releaseLine(outcome.release)} again.`,
      };
    case 'follow_ups_finished':
      return {
        status: 'ready',
        message: `Assistant ${instanceId} runs ${releaseLine(outcome.release)}; its rollback is finished.`,
      };
    case 'declined':
      return {
        status: 'ready',
        message: `Rollback cancelled. Assistant ${instanceId} stays on ${releaseLine(outcome.release)} as before.`,
      };
  }
}

/** An update run that only finished the follow-ups of the release it would deploy. */
function finishedOutcome(instanceId: string, release: ReleaseCoordinates): Outcome {
  return {
    status: 'ready',
    message: `Assistant ${instanceId} runs ${releaseLine(release)}; its update is finished.`,
  };
}

/** The stop summary of one assistant's update; undefined when its preview was declined. */
function updateOutcome(instanceId: string, update: AssistantUpdate | undefined): Outcome {
  if (!update) return { status: 'ready', message: 'Update cancelled. The assistant is unchanged.' };
  switch (update.kind) {
    case 'updated':
      return updatedOutcome(instanceId, update.updated);
    case 'completed':
      return finishedOutcome(instanceId, update.release);
  }
}

/** Confirmed without asking: `--yes`, or a turn of an `update --all` whose plan was confirmed. */
async function confirmWithoutAsking(): Promise<boolean> {
  return true;
}

/**
 * How an update is confirmed: `--yes`, or a terminal to ask on. Settled
 * first, so a run that could never be confirmed stops before anything is
 * read or staged.
 */
function updateConfirmation<Preview>(
  yes: boolean,
  prompt: ((preview: Preview) => Promise<boolean>) | undefined,
): (preview: Preview) => Promise<boolean> {
  const confirm = yes ? confirmWithoutAsking : prompt;
  if (!confirm) {
    throw new GwsEaError(
      'input_required',
      'An update needs confirmation: pass --yes, or run gws-ea update in a terminal to be asked.',
    );
  }
  return confirm;
}

/** Wait, as NanoClaw's own update does, until the host answers on its CLI socket. */
async function verifyServing(
  reporter: StepReporter,
  service: InstanceServiceControl,
  instanceId: string,
): Promise<void> {
  await runStep(reporter, { id: 'verify_host', label: 'Waiting for the assistant to answer…' }, async () => {
    if (await service.verifyHealth()) return;
    throw new GwsEaError(
      'host_not_serving',
      `Assistant ${instanceId}'s host never answered on its CLI socket; ` +
        `see its errors with gws-ea logs --id ${instanceId} --errors.`,
    );
  });
}

/** A command's own arguments, before any `--`, and everything after it, untouched. */
function splitPassThrough(args: readonly string[]): {
  readonly own: readonly string[];
  readonly passThrough: readonly string[];
} {
  const separator = args.indexOf('--');
  return separator === -1
    ? { own: args, passThrough: [] }
    : { own: args.slice(0, separator), passThrough: args.slice(separator + 1) };
}

const NCL_OPTIONS: OptionSpec = { values: ['id'], switches: [] };

/**
 * `ncl`: hand the process to the assistant's own `bin/ncl` with everything
 * after `--` untouched (KTD13), in the environment `buildInstanceCliCommand`
 * gives it. The gate is passed under the instance lock, which is released
 * just before the handover: `ncl` talks to the running host over its socket,
 * and a lock it held would outlive it.
 */
async function prepareNcl(
  paths: ControlPlanePaths,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<CommandEnd> {
  const { own, passThrough } = splitPassThrough(args);
  const instanceId = targetInstance(parseOptions(own, NCL_OPTIONS).options);
  const operation = await acquireInstanceOperation(paths, instanceId, { command: 'ncl' });
  if (!operation) throw busy();
  try {
    const runtime = await loadCreatedRuntime(paths, instanceId);
    return { replaceWith: buildInstanceCliCommand(runtime, passThrough, environment) };
  } finally {
    operation.release();
  }
}

/** The stop summary and exit code of a command that failed outside the attempt loop. */
function reportStop(presenter: Presenter, error: unknown): number {
  if (isBusy(error)) {
    presenter.report({ outcome: 'busy', headline: safeErrorMessage(error), details: [] });
    return EXIT_CODES.busy;
  }
  const usage =
    error instanceof GwsEaError && error.code === 'invalid_arguments' ? ['Run gws-ea --help for usage.'] : [];
  presenter.report({ outcome: 'failed', headline: safeErrorMessage(error), details: usage });
  return EXIT_CODES.failed;
}

/**
 * Run a command outside the attempt loop: `ncl` and the read-only commands.
 * A failure becomes a stop summary and exit code; a command that asks for it
 * has the process handed to its tool, which then owns the exit code.
 */
async function runOutsideAttempts(
  presenter: Presenter,
  execve: CliRuntime['execve'],
  run: () => Promise<CommandEnd>,
): Promise<number> {
  let end: CommandEnd;
  /* eslint-disable no-catch-all/no-catch-all -- The CLI boundary turns every failure into a redacted summary and exit code. */
  try {
    end = await run();
  } catch (error) {
    return reportStop(presenter, error);
  }
  /* eslint-enable no-catch-all/no-catch-all */
  if ('exitCode' in end) return end.exitCode;
  try {
    return await replaceProcessWithCommand(end.replaceWith, execve);
  } catch (error) {
    // A tool that cannot be started is reported; the replacement itself failing is not a stop summary.
    if (!(error instanceof GwsEaError)) throw error;
    return reportStop(presenter, error);
  }
}

function failureReport(
  command: Command,
  nextAction: string,
  state: AttemptState,
  run: RunLog,
  error: unknown,
  failed: Extract<RunEvent, { type: 'step-failed' }> | undefined,
  labels: ReadonlyMap<string, string>,
): FailureReport {
  const step = failed?.step ?? command;
  const label = labels.get(step);
  const pending = pendingActionOf(error);
  const tail = error instanceof GwsEaError ? error.details?.stderrTail : undefined;
  return {
    command,
    step,
    ...(label ? { stepLabel: label } : {}),
    code: safeErrorCode(error),
    cause: safeErrorMessage(error),
    nextAction,
    ...(pending ? { pendingAction: pending.message } : {}),
    progressLog: run.progressLog,
    ...(failed?.rawLog ? { rawLog: failed.rawLog } : {}),
    runDirectory: run.directory,
    ...(typeof tail === 'string' && tail ? { tail: redact(tail) } : {}),
    ...(state.instanceId ? { instanceId: state.instanceId } : {}),
  };
}

function failureStop(report: FailureReport, error: unknown): StopReport {
  const details = error instanceof GwsEaError ? error.details : undefined;
  const exit = exitFact(details);
  const searched = Array.isArray(details?.searched) ? details.searched.join(path.delimiter) : undefined;
  const step = report.stepLabel ? `${report.stepLabel.replace(/…$/u, '')} (${report.step})` : report.step;
  return {
    outcome: 'failed',
    headline: `Stopped at ${step}: ${report.cause}`,
    details: [
      ...(exit ? [`Exit: ${exit}`] : []),
      ...(searched ? [`Searched: ${searched}`] : []),
      ...(report.pendingAction ? [`Pending human action: ${report.pendingAction}`] : []),
      report.nextAction,
      `Log: ${report.progressLog}`,
      ...(report.rawLog ? [`Step log: ${report.rawLog}`] : []),
    ],
    ...(report.tail ? { tail: report.tail } : {}),
  };
}

function createReservation(
  track: string,
  sourceRemote: string,
  setup: CreateSetupAnswers,
  production: {
    readonly instanceId: string;
    readonly commit: string;
    readonly ports: AllocatedPorts;
    readonly gcpAccount: string;
  },
): InstanceReservationInput {
  const instanceId = production.instanceId;
  const gcpProjectId = deriveGcpProjectId(instanceId);
  const input: InstanceReservationInput = {
    instance_id: instanceId,
    release_track: track,
    source_remote: sourceRemote,
    deployed_commit: production.commit,
    allocated_ports: production.ports,
    exclusive_resource_claims: {
      ingress:
        setup.ingress.mode === 'existing'
          ? { mode: 'existing', endpoint_url: setup.ingress.endpointUrl }
          : {
              mode: 'managed-cloudflare',
              account_id: setup.ingress.accountId,
              zone_id: setup.ingress.zoneId,
              zone_name: setup.ingress.zoneName,
              hostname: setup.ingress.hostname,
              callback_url: setup.ingress.callbackUrl,
              dns_record_id: null,
            },
      gcp_project_id: gcpProjectId,
      gcp_account: production.gcpAccount,
      gchat_service_account: deriveGchatServiceAccountEmail(gcpProjectId),
      workspace_email: setup.assistantWorkspaceEmail,
      onecli_project: `gws-ea-${instanceId.replaceAll('-', '')}`,
    },
  };
  return validateReservation(input);
}

function removalPreviewLines(preview: RemovalPreview): string[] {
  const lines = [
    `Assistant: ${preview.instanceId}`,
    `NanoClaw: ${preview.checkout}`,
    `OneCLI: ${preview.onecliProject}`,
    `Google Cloud project: ${preview.gcpProject} (${preview.gcpAccount})`,
  ];
  if (preview.ingress.mode === 'existing') {
    lines.push(`External endpoint: ${preview.ingress.endpoint} (operator-managed; disconnect separately)`);
    return lines;
  }
  lines.push(
    `Managed hostname: ${preview.ingress.hostname}`,
    `Managed callback: ${preview.ingress.callback}`,
    `Owned DNS record: ${preview.ingress.dnsRecordId ?? 'not created'}`,
    `Owned tunnel route: ${preview.ingress.route}`,
    preview.ingress.sharedIngress === 'retained-for-peers'
      ? 'Shared Cloudflare ingress: retained for other assistants'
      : 'Shared Cloudflare ingress: retired after this final managed callback',
  );
  return lines;
}

/** What the operator must know after removal: the project deletion, and anything left behind. */
function removalSummary(preview: RemovalPreview, outcome: RemovalOutcome | undefined): string[] {
  const project = `Google Cloud project ${preview.gcpProject}`;
  const names: Readonly<Record<AbandonableResource, string>> = {
    'gcp-project': project,
    'cloudflare-dns':
      preview.ingress.mode === 'managed-cloudflare' ? `DNS record ${preview.ingress.hostname}` : 'DNS record',
  };
  return [
    ...(outcome?.removed.includes('gcp-project')
      ? [`${project}: deletion requested; it stays recoverable for 30 days, then Google Cloud deletes it.`]
      : []),
    ...(outcome?.abandoned.map(
      ({ resource }) =>
        `Left behind: ${names[resource]}, which removal could not observe; delete it yourself if it still exists.`,
    ) ?? []),
    ...(outcome?.keyPolicyUnrestored
      ? [
          `The Google Chat key-creation policy lifted on ${project} was not restored: ${outcome.keyPolicyUnrestored.split('\n')[0]}`,
        ]
      : []),
  ];
}

function printHelp(output: LineWriter): void {
  output('Usage: gws-ea <command> [options]');
  output('  create --track <dogfood|prod> [--source-remote <remote>] [--google-account <email>]');
  output('         [--assistant-first-name <name> --assistant-last-name <name>]');
  output('         [--principal-first-name <name> --principal-last-name <name> --principal-timezone <iana>]');
  output('         [--principal-email <email>]...  (once per address the principal uses)');
  output('         [--workspace-email <email>] [--provider <id>]');
  output('         [--ingress existing --endpoint <https-url>]');
  output('         [--ingress managed-cloudflare --cloudflare-zone <zone> --hostname-label <label>]');
  output("         Deploys this gws-ea's own release, which must be committed, clean, and on the track.");
  output('  resume --id <instance_id> [--chat-configured] [--messaging-group-id <exact-id>]');
  output(
    "         [--google-client-file <file>]  (the Desktop OAuth client downloaded for the assistant's Google sign-in)",
  );
  output('  connect-google --id <instance_id> [--google-client-file <file>]');
  output('         Signs the assistant in to Google as its own account, or repairs that sign-in; safe to rerun.');
  output('  start --id <instance_id>');
  output('  stop --id <instance_id>');
  output('         Agent containers keep running; the assistant stays stopped until the next start, login, or reboot.');
  output('  restart --id <instance_id>');
  output('  update --id <instance_id> [--track <track>] [--source-remote <remote>] [--yes]');
  output(
    "         Stages this gws-ea's release beside the running assistant and shows what changes before anything does,",
  );
  output(
    '         then switches to it during a brief stop, verifies it, and keeps the previous release to roll back to.',
  );
  output('         --track and --source-remote move it to another track or repository that holds the release.');
  output('         Rerun it to continue an update that was cut short, or to retry the follow-ups one left.');
  output('  update --all [--yes]');
  output(
    '         Shows the plan, asks once, then updates every assistant that can take this release, one at a time; --yes skips the question.',
  );
  output('  rollback --id <instance_id> [--snapshot] [--yes]');
  output(
    '         Returns to the kept previous release, keeping every message since the update unless it changed a schema;',
  );
  output('         then, or with --snapshot, it restores the pre-update snapshot after showing what that discards.');
  output('         Rerun it to continue a rollback that was cut short, or to revert an update that is unfinished.');
  for (const command of READ_ONLY_COMMANDS.values()) for (const line of command.usage) output(`  ${line}`);
  output('  ncl --id <instance_id> -- <ncl arguments>');
  output("         Runs the assistant's own ncl, passing everything after -- unchanged.");
  output('  remove --id <instance_id> [--yes] [--abandon gcp-project,cloudflare-dns]');
  output('  cleanup');
  output(
    '         Removes a NanoClaw install set up or started in the checkout gws-ea runs from; create and update do this first.',
  );
  output('  create, resume, remove: [--secrets-file <owner-only file under the config root>]');
  output('  Secrets: GWS_EA_PROVIDER_CREDENTIAL, GWS_EA_CLOUDFLARE_API_TOKEN (environment or --secrets-file).');
  output('  Exit codes: 0 ready, 10 paused for a person, 1 failed, 75 busy; ncl and logs exit as their tool does.');
}

export async function runCli(args: readonly string[], runtime: CliRuntime = {}): Promise<number> {
  const output = runtime.stdout ?? ((line) => process.stdout.write(`${line}\n`));
  const errorOutput = runtime.stderr ?? ((line) => process.stderr.write(`${line}\n`));
  // gws-ea's own help is asked for only before `--`; what follows belongs to the tool it runs.
  const { own } = splitPassThrough(args);
  if (own.length === 0 || own[0] === 'help' || own.includes('--help') || own.includes('-h')) {
    printHelp(output);
    return EXIT_CODES.ready;
  }
  const command = args[0];
  const presenter = runtime.presenter ?? createLinePresenter(output, errorOutput);
  const environment = runtime.environment ?? process.env;
  const readOnly = READ_ONLY_COMMANDS.get(command);
  if (readOnly) {
    return runOutsideAttempts(presenter, runtime.execve, async () =>
      readOnly.run(
        {
          paths: runtime.paths ?? resolveControlPlanePaths(),
          output,
          errorOutput,
          environment,
          serviceHelpers: runtime.serviceHelpers,
          hostStatus: runtime.hostStatus,
          toolCheckout: runtime.toolCheckout,
        },
        parseOptions(args.slice(1), readOnly.options).options,
      ),
    );
  }
  if (command === 'ncl') {
    return runOutsideAttempts(presenter, runtime.execve, async () =>
      prepareNcl(runtime.paths ?? resolveControlPlanePaths(), args.slice(1), environment),
    );
  }
  if (!isCommand(command)) {
    errorOutput('Unknown command.');
    printHelp(errorOutput);
    return EXIT_CODES.failed;
  }
  const managedIngressSetup = runtime.managedIngressSetup ?? createManagedIngressSetupSession();
  const cli = new Cli(runtime, presenter, managedIngressSetup);
  try {
    let next: () => Promise<Attempt>;
    try {
      next = cli.prepare(command, args.slice(1));
    } catch (error) {
      if (!(error instanceof GwsEaError)) throw error;
      presenter.report({ outcome: 'failed', headline: error.message, details: ['Run gws-ea --help for usage.'] });
      return EXIT_CODES.failed;
    }
    for (;;) {
      const attempt = await next();
      if (attempt.status === 'done') return attempt.exitCode;
      if (!runtime.onFailure) return EXIT_CODES.failed;
      if ((await runtime.onFailure(attempt.report)) !== 'retry') return EXIT_CODES.failed;
      next = attempt.retry;
    }
  } finally {
    managedIngressSetup.clearAccountToken();
  }
}
