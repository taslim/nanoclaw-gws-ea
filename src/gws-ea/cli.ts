import { lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { isErrno } from '../community-portal/errors.js';
import { createManagedIngressSetupSession, type RetainedManagedIngressSetupSession } from './cloudflare-api.js';
import {
  CREATE_INPUT_FLAGS,
  loadSecretSource,
  type CreateInputFlag,
  type CreatePromptContext,
  type CreateSetupAnswers,
  type SecretSource,
} from './create-input.js';
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
import { inspectOperation, readOperationRecord, type OperationInspection } from './operation.js';
import { resolveControlPlanePaths, type ControlPlanePaths } from './paths.js';
import type { ProvisionHumanPause, ProvisionResult, ProvisionRuntime } from './phases.js';
import { holdLoopbackPorts, type HeldLoopbackPorts } from './ports.js';
import { checkPrerequisites, type PrerequisiteRequest, type Prerequisites } from './prerequisites.js';
import { buildToolEnvironment, replaceProcessWithCommand, type SanitizedCommand } from './process.js';
import {
  installProductionBootstrapManifest,
  recordedHost,
  removeProductionBootstrapManifest,
  runProductionProvision,
  validateProductionBootstrapManifest,
} from './provision.js';
import { redact, safeErrorCode, safeErrorMessage } from './redact.js';
import { allocateInstanceId, assertInstanceId, getInstanceReservation, validateReservation } from './registry.js';
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
import { FIXTURE_STAGING_DIRECTORY, startRunLog, type RunLog } from './run-log.js';
import { buildInstanceCliCommand, type HostStatusHelpers, type UpsertEnvVars } from './service.js';
import {
  createServiceControl,
  hostLogFiles,
  runtimeServiceTarget,
  type InstanceServiceControl,
  type NanoclawServiceHelpers,
} from './service-control.js';
import { LIST_USAGE, runListCommand, runStatusCommand, STATUS_USAGE, type ReadOnlyCommandRuntime } from './status.js';
import {
  confirmStagedUpdate,
  continueUpdate,
  finishFollowUps,
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
  GwsEaError,
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
const COMMANDS = ['create', 'resume', 'remove', 'start', 'stop', 'restart', 'update'] as const;
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
  /** An update's boundary seams; each defaults to the real one. */
  update?: UpdateSeams;
}

/** The flags a command takes: options with a value, and switches without. */
export interface OptionSpec {
  readonly values: readonly string[];
  readonly switches: readonly string[];
}

/** Parsed flags: each option's value, and `'true'` for each switch given. */
export type CommandOptions = Readonly<Record<string, string>>;

const COMMON_OPTIONS = ['secrets-file'] as const;
const COMMON_SWITCHES = ['capture-fixtures'] as const;
/** The host service commands name the assistant and nothing else: they read no secrets and capture nothing. */
const SERVICE_OPTIONS: OptionSpec = { values: ['id'], switches: [] };
const COMMAND_OPTIONS: Readonly<Record<Command, OptionSpec>> = {
  create: {
    values: ['track', 'source-remote', 'google-account', ...CREATE_INPUT_FLAGS, ...COMMON_OPTIONS],
    switches: COMMON_SWITCHES,
  },
  resume: {
    values: ['id', 'messaging-group-id', ...COMMON_OPTIONS],
    switches: ['chat-configured', ...COMMON_SWITCHES],
  },
  remove: { values: ['id', 'abandon', ...COMMON_OPTIONS], switches: ['yes', ...COMMON_SWITCHES] },
  start: SERVICE_OPTIONS,
  stop: SERVICE_OPTIONS,
  restart: SERVICE_OPTIONS,
  update: { values: ['id', 'track', 'source-remote'], switches: ['yes'] },
};

function parseOptions(args: readonly string[], { values, switches }: OptionSpec): CommandOptions {
  const options: Record<string, string> = {};
  for (let index = 0; index < args.length; ) {
    const flag = args[index];
    if (!flag?.startsWith('--')) throw new GwsEaError('invalid_arguments', 'Expected an option flag');
    const name = flag.slice(2);
    if (!values.includes(name) && !switches.includes(name)) {
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
    options[name] = value;
    index += 2;
  }
  return options;
}

function requireOption(options: CommandOptions, name: string): string {
  const value = options[name];
  if (!value) throw new GwsEaError('invalid_arguments', `Missing required option --${name}`);
  return value;
}

/** `--id`: the exact assistant a command acts on. */
function targetInstance(options: CommandOptions): string {
  const instanceId = requireOption(options, 'id');
  assertInstanceId(instanceId);
  return instanceId;
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
 * rollback, a removal under way, a create not yet finished, a stopped
 * assistant an update cannot prove its release on, or a release that is not
 * newer than the one it runs. Its message names the command that moves the
 * assistant on; rerunning this one cannot.
 */
const STATE_REFUSALS: ReadonlySet<string> = new Set([
  'operation_in_progress',
  'removal_in_progress',
  'instance_not_created',
  'host_not_running',
  'release_not_newer',
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
    const options = parseOptions(args, COMMAND_OPTIONS[command]);
    switch (command) {
      case 'create': {
        const track = requireOption(options, 'track');
        const source = resolveReleaseSource(track, options['source-remote']);
        return () =>
          this.#attempt({
            command,
            args,
            options,
            meta: { track },
            work: (session) => this.#createWork(session, options, track, source),
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
      ...(plan.options['capture-fixtures'] ? ['--capture-fixtures'] : []),
    ];
    return () => this.prepare('resume', resumeArgs)();
  }

  #checkPrerequisites(request: PrerequisiteRequest, interaction: Interaction): Promise<Prerequisites> {
    return (this.#runtime.checkPrerequisites ?? checkPrerequisites)(request, interaction);
  }

  #advance(operation: InstanceOperation, options: AdvanceOptions): Promise<ProvisionResult> {
    if (this.#runtime.advanceProvision) return this.#runtime.advanceProvision(operation, options);
    const { upsertEnvVars, hostStatus } = this.#runtime;
    if (!upsertEnvVars || !hostStatus) {
      throw new GwsEaError('interactive_setup_unavailable', 'Run this command through the gws-ea launcher');
    }
    return runProductionProvision(operation, {
      upsertEnvVars,
      hostStatus,
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
    const instanceId = allocateInstanceId();
    state.instanceId = instanceId;
    this.#presenter.line(`instance_id: ${instanceId}`);

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
      const input = createReservation(paths, track, sourceRemote, setup, {
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
        await this.#checkPrerequisites(
          { command: 'resume', paths: this.#paths, account, checkoutRoot: reservation.checkout_realpath, ...host },
          interaction,
        );
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

  /**
   * `update`: stage this tool's release beside the running assistant, show
   * what the update changes, and once confirmed carry it through its cutover
   * to the recorded release (R7, R8, R10, R12). Confirmation is settled first,
   * so a run that could never be confirmed stops before anything is read or
   * staged. An update already under way to this release is continued, not
   * staged again, and a recorded one's follow-ups are finished before anything
   * else (KTD2), even when this release is the one already recorded.
   */
  async #updateWork({ reporter }: Session, request: UpdateRequest, yes: boolean): Promise<Outcome> {
    const confirm = yes ? async (): Promise<boolean> => true : this.#runtime.confirmUpdate;
    if (!confirm) {
      throw new GwsEaError(
        'input_required',
        'An update needs confirmation: pass --yes, or run gws-ea update in a terminal to be asked.',
      );
    }
    const { serviceHelpers, toolProviderSetup, upsertEnvVars, hostStatus } = this.#runtime;
    if (!serviceHelpers || !toolProviderSetup || !upsertEnvVars || !hostStatus) {
      throw new GwsEaError('interactive_setup_unavailable', 'Run this command through the gws-ea launcher');
    }
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
        serviceHelpers,
        providerSetup: await toolProviderSetup(),
        upsertEnvVars,
        hostStatus,
        reporter,
      };
      const unfinished = await readOperationRecord(this.#paths, request.instanceId);
      if (unfinished?.phase === 'recorded') {
        await finishFollowUps(operation, dependencies);
        if (sameRelease(unfinished.to, intent.target)) return finishedOutcome(request.instanceId, unfinished.to);
      }
      if (!unfinished || unfinished.phase === 'recorded') {
        const staged = await prepareUpdate(operation, intent, dependencies);
        for (const line of updatePreviewLines(staged.preview)) this.#presenter.line(line);
        const record = await confirmStagedUpdate(operation, staged, dependencies, confirm);
        if (!record) return { status: 'ready', message: 'Update cancelled. Nothing was changed.' };
      }
      return updatedOutcome(request.instanceId, await continueUpdate(operation, dependencies));
    } finally {
      operation.release();
    }
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
    // A signal while waiting on a pause stops the wait; otherwise the run ends, and its log says where.
    const interrupted = (signal: NodeJS.Signals): void => {
      if (this.#waiting) {
        this.#waiting.abort();
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
        ...(plan.options['capture-fixtures'] ? { captureFixturesTo: FIXTURE_STAGING_DIRECTORY } : {}),
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

function releaseName(release: ReleaseCoordinates): string {
  return `${release.release_track} ${release.deployed_commit.slice(0, 12)}`;
}

/** Where an update leaves the assistant: on its release, the one it ran kept to roll back to. */
function updatedOutcome(instanceId: string, updated: UpdatedAssistant): Outcome {
  return {
    status: 'ready',
    message: `Assistant ${instanceId} was updated to ${releaseName(updated.to)}.`,
    details: [`Its previous release, ${releaseName(updated.from)}, is kept to roll back to.`],
  };
}

/** An update run that only finished the follow-ups of the release it would deploy. */
function finishedOutcome(instanceId: string, release: ReleaseCoordinates): Outcome {
  return { status: 'ready', message: `Assistant ${instanceId} runs ${releaseName(release)}; its update is finished.` };
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

/** How a command run outside the attempt loop ends: with an exit code, or by handing its process to a tool. */
export type CommandEnd = { readonly exitCode: number } | { readonly replaceWith: SanitizedCommand };

/**
 * What a read-only command may use (KTD10). It loads no secrets, starts no
 * run log, takes no lock, and repairs nothing, so it works in any state,
 * mid-update and mid-removal included.
 */
export interface ReadOnlyContext {
  readonly paths: ControlPlanePaths;
  /** The command's result; scripts read it. */
  readonly output: LineWriter;
  /** Notes beside the result, such as an unfinished update, so the result stays alone on stdout. */
  readonly errorOutput: LineWriter;
  /** For the tools a command hands its process to: only the tool allowlist is read from it, never a secret. */
  readonly environment: NodeJS.ProcessEnv;
  /** Upstream's service helpers, for observing (never controlling) an assistant's service. */
  readonly serviceHelpers?: NanoclawServiceHelpers;
  /** Upstream's host readiness helpers, for asking a host its status. */
  readonly hostStatus?: HostStatusHelpers;
}

/** A read-only command: its lines in `gws-ea --help`, its flags, and what it does. */
export interface ReadOnlyCommand {
  readonly usage: readonly string[];
  readonly options: OptionSpec;
  run(context: ReadOnlyContext, options: CommandOptions): Promise<CommandEnd>;
}

/**
 * The read-only commands, by name. `runCli` dispatches them without the
 * attempt loop, parsing each one's flags from its `options`, and `--help`
 * prints each one's `usage` in this order.
 */
/** The observation runtime `list` and `status` read through; everything it holds is read-only. */
function observationRuntime(context: ReadOnlyContext): ReadOnlyCommandRuntime {
  return {
    paths: context.paths,
    stdout: context.output,
    stderr: context.errorOutput,
    serviceHelpers: context.serviceHelpers,
    hostStatus: context.hostStatus,
  };
}

const READ_ONLY_COMMANDS: ReadonlyMap<string, ReadOnlyCommand> = new Map([
  [
    'list',
    {
      usage: LIST_USAGE,
      options: { values: [], switches: ['json'] },
      run: async (context, options) => ({
        exitCode: await runListCommand(observationRuntime(context), { json: options.json === 'true' }),
      }),
    },
  ],
  [
    'status',
    {
      usage: STATUS_USAGE,
      options: { values: ['id'], switches: ['json'] },
      run: async (context, options) => ({
        exitCode: await runStatusCommand(observationRuntime(context), {
          instanceId: targetInstance(options),
          json: options.json === 'true',
        }),
      }),
    },
  ],
  [
    'logs',
    {
      usage: ['logs --id <instance_id> [--errors] [--follow]'],
      options: { values: ['id'], switches: ['errors', 'follow'] },
      run: showHostLog,
    },
  ],
]);

/** What `logs` notes about an unfinished update or rollback (KTD2), which never stops it. */
function operationNote(inspection: OperationInspection): string | undefined {
  switch (inspection.state) {
    case 'none':
    case 'recorded':
      return undefined;
    case 'open': {
      const { record, next } = inspection;
      const revert = next.revertWith ? `, or revert it with ${next.revertWith}` : '';
      const subject = record.kind === 'update' ? 'An update' : 'A rollback';
      return `${subject} of this assistant is unfinished (${record.phase}); continue it with ${next.continueWith}${revert}.`;
    }
    case 'unreadable':
      return `This assistant's update or rollback record cannot be read: ${inspection.message}`;
  }
}

/** Refuse a log file that is missing, or that is not a regular file, before any tool opens it. */
async function assertLogFile(file: string, name: string): Promise<void> {
  let isFile: boolean;
  try {
    isFile = (await lstat(file)).isFile();
  } catch (error) {
    if (!isErrno(error, 'ENOENT') && !isErrno(error, 'ENOTDIR')) throw error;
    throw new GwsEaError('log_missing', `The ${name} ${file} does not exist yet.`);
  }
  if (!isFile) throw new GwsEaError('unsafe_log', `The ${name} ${file} is not a regular file.`);
}

/**
 * `logs`: the assistant's host log, or its error log with `--errors`, at the
 * paths its service definition sends them to. The process is handed to
 * `cat`, or to `tail -f` with `--follow`, so the log streams as the file
 * holds it. An unfinished update or rollback is named first, on stderr.
 */
async function showHostLog(context: ReadOnlyContext, options: CommandOptions): Promise<CommandEnd> {
  const instanceId = targetInstance(options);
  const reservation = await getInstanceReservation(context.paths, instanceId);
  const note = operationNote(await inspectOperation(context.paths, reservation));
  if (note) context.errorOutput(note);
  const logs = hostLogFiles(reservation.checkout_realpath);
  const file = options.errors ? logs.errors : logs.output;
  await assertLogFile(file, options.errors ? 'host error log' : 'host log');
  return {
    replaceWith: {
      command: options.follow ? 'tail' : 'cat',
      args: options.follow ? ['-f', file] : [file],
      cwd: path.dirname(file),
      env: buildToolEnvironment(context.environment),
    },
  };
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
  const instanceId = targetInstance(parseOptions(own, NCL_OPTIONS));
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
  paths: ControlPlanePaths,
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
    checkout_realpath: paths.checkoutRoot(instanceId),
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
  return validateReservation(input, paths);
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
  output('         [--workspace-email <email>] [--provider <id>]');
  output('         [--ingress existing --endpoint <https-url>]');
  output('         [--ingress managed-cloudflare --cloudflare-zone <zone> --hostname-label <label>]');
  output('  resume --id <instance_id> [--chat-configured] [--messaging-group-id <exact-id>]');
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
  output('         Rerun it to continue an update that was cut short, or to retry the follow-ups one left.');
  for (const command of READ_ONLY_COMMANDS.values()) for (const line of command.usage) output(`  ${line}`);
  output('  ncl --id <instance_id> -- <ncl arguments>');
  output('  remove --id <instance_id> [--yes] [--abandon gcp-project,cloudflare-dns]');
  output('  create, resume, remove: [--secrets-file <owner-only file under the config root>] [--capture-fixtures]');
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
        },
        parseOptions(args.slice(1), readOnly.options),
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
