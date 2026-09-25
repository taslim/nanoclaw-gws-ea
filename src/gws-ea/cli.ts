import path from 'node:path';

import { resolveReleaseCommit, type ResolvedRelease } from './checkout.js';
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
  type InteractivePrompts,
  type RunEvent,
  type StepReporter,
} from './events.js';
import { deriveGchatServiceAccountEmail, deriveGcpProjectId } from './gcloud.js';
import { acquireInstanceOperation, readProvisionJournal, type InstanceOperation } from './journal.js';
import { resolveControlPlanePaths, type ControlPlanePaths } from './paths.js';
import type { ProvisionHumanPause, ProvisionResult, ProvisionRuntime } from './phases.js';
import { holdLoopbackPorts, type HeldLoopbackPorts } from './ports.js';
import { checkPrerequisites, type PrerequisiteRequest, type Prerequisites } from './prerequisites.js';
import {
  installProductionBootstrapManifest,
  recordedDockerEndpoint,
  removeProductionBootstrapManifest,
  runProductionProvision,
  validateProductionBootstrapManifest,
} from './provision.js';
import { redact } from './redact.js';
import {
  allocateInstanceId,
  assertInstanceId,
  getInstanceReservation,
  reserveInstance,
  validateReservation,
} from './registry.js';
import { resolveReleaseSource } from './release-tracks.js';
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
import type { HostStatusHelpers, UpsertEnvVars } from './service.js';
import { GwsEaError, type AllocatedPorts, type GwsEaErrorDetails, type InstanceReservationInput } from './types.js';

/** Unlabeled, so a scripted create's first line stays its `instance_id`. */
const PREREQUISITES_STEP = { id: 'prerequisites' } as const;

/** `0` ready, `10` paused for a person, `1` failed, `75` busy (KTD11). */
export const EXIT_CODES = { ready: 0, paused: 10, failed: 1, busy: 75 } as const;

type LineWriter = (line: string) => void;
type Command = 'create' | 'resume' | 'remove';

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
  resolveRelease?: (sourceRemote: string, releaseRef: string) => Promise<ResolvedRelease>;
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
}

const COMMON_OPTIONS = ['secrets-file'] as const;
const COMMON_SWITCHES = ['capture-fixtures'] as const;
const COMMAND_OPTIONS: Readonly<Record<Command, { values: readonly string[]; switches: readonly string[] }>> = {
  create: {
    values: ['track', 'source-remote', 'google-account', ...CREATE_INPUT_FLAGS, ...COMMON_OPTIONS],
    switches: COMMON_SWITCHES,
  },
  resume: {
    values: ['id', 'messaging-group-id', ...COMMON_OPTIONS],
    switches: ['chat-configured', ...COMMON_SWITCHES],
  },
  remove: { values: ['id', 'abandon', ...COMMON_OPTIONS], switches: ['yes', ...COMMON_SWITCHES] },
};

type Options = Readonly<Record<string, string>>;

function parseOptions(args: readonly string[], command: Command): Options {
  const { values, switches } = COMMAND_OPTIONS[command];
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

function requireOption(options: Options, name: string): string {
  const value = options[name];
  if (!value) throw new GwsEaError('invalid_arguments', `Missing required option --${name}`);
  return value;
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

function safeMessage(error: unknown): string {
  return error instanceof GwsEaError ? redact(error.message) : 'Unexpected control-plane failure.';
}

function isBusy(error: unknown): boolean {
  return error instanceof GwsEaError && error.code === 'instance_busy';
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
  readonly options: Options;
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

  constructor(runtime: CliRuntime, presenter: Presenter, managedIngressSetup: RetainedManagedIngressSetupSession) {
    this.#paths = runtime.paths ?? resolveControlPlanePaths();
    this.#presenter = presenter;
    this.#runtime = runtime;
    this.#managedIngressSetup = managedIngressSetup;
  }

  /** Validate arguments up front; the returned attempt reports every later failure itself. */
  prepare(command: Command, args: readonly string[]): () => Promise<Attempt> {
    const options = parseOptions(args, command);
    if (command === 'create') {
      const track = requireOption(options, 'track');
      return () =>
        this.#attempt({
          command,
          args,
          options,
          meta: { track },
          work: (session) => this.#createWork(session, options, track),
        });
    }
    const instanceId = requireOption(options, 'id');
    assertInstanceId(instanceId);
    if (command === 'remove') {
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

  /** The command that continues from where an attempt stopped; `extra` carries a pause's decision flag. */
  #continueCommand(plan: AttemptPlan, state: AttemptState, extra?: string): string {
    const secretsFile = plan.options['secrets-file'];
    const common = secretsFile ? `--secrets-file ${shellQuote(secretsFile)}` : undefined;
    const join = (...parts: Array<string | undefined>): string => parts.filter(Boolean).join(' ');
    if (plan.command === 'remove') {
      const abandon = [...new Set([...(plan.options.abandon?.split(',') ?? []), ...(extra ? [extra] : [])])];
      return join(
        `gws-ea remove --id ${state.instanceId}`,
        plan.options.yes ? '--yes' : undefined,
        abandon.length > 0 ? `--abandon ${abandon.join(',')}` : undefined,
        common,
      );
    }
    if (state.reserved && state.instanceId) return join(`gws-ea resume --id ${state.instanceId}`, extra, common);
    const track = plan.options.track ?? '';
    return `gws-ea create --track ${/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(track) ? track : '<track>'} (with the same options)`;
  }

  #nextAction(plan: AttemptPlan, state: AttemptState): string {
    const verb = plan.command !== 'remove' && state.reserved ? 'Resume' : 'Retry';
    return `${verb} with: ${this.#continueCommand(plan, state)}`;
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
    options: Options,
    track: string,
  ): Promise<Outcome> {
    const paths = this.#paths;
    const run = reporter.run;
    const sourceRemote = await runStep(reporter, { id: 'release_source' }, () =>
      resolveReleaseSource({ track, sourceRemote: options['source-remote'], configRoot: paths.configRoot }),
    );
    run.userInput('release_source', sourceRemote);
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
        sourceRemote,
        provided,
        secrets,
        prerequisites,
        managedIngressSetup: this.#managedIngressSetup,
      }),
    );
    run.userInput('ingress', setup.ingress.mode);
    run.userInput('provider', setup.bootstrapManifest.provider.id);

    const resolved = await runStep(reporter, { id: 'resolve_release', label: 'Resolving the release…' }, () =>
      (this.#runtime.resolveRelease ?? resolveReleaseCommit)(sourceRemote, `refs/heads/${track}`),
    );
    await runStep(reporter, { id: 'reserve', label: 'Reserving the assistant…' }, async () => {
      await this.#reserve(state, track, sourceRemote, setup, resolved.commit, prerequisites.account);
      await run.assignInstance(instanceId);
    });

    const operation = await acquireInstanceOperation(paths, instanceId);
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

  async #provision(reporter: StepReporter, operation: InstanceOperation, interaction: Interaction): Promise<Outcome> {
    const result = await runStep(reporter, { id: 'provision' }, () =>
      this.#advance(operation, { interaction, runtime: reporter }),
    );
    return result.status === 'paused'
      ? result
      : { status: 'ready', message: `Instance ${operation.instanceId} is ready.` };
  }

  async #resumeWork({ reporter, interaction }: Session, instanceId: string): Promise<Outcome> {
    const operation = await acquireInstanceOperation(this.#paths, instanceId);
    if (!operation) throw busy();
    try {
      await runStep(reporter, PREREQUISITES_STEP, async () => {
        // An instance this launcher cannot continue is refused before sign-in is asked for.
        await readProvisionJournal(this.#paths, instanceId);
        const reservation = await getInstanceReservation(this.#paths, instanceId);
        const account = reservation.exclusive_resource_claims.gcp_account;
        const dockerEndpoint = await recordedDockerEndpoint(this.#paths, reservation);
        await this.#checkPrerequisites(
          { command: 'resume', paths: this.#paths, account, ...(dockerEndpoint ? { dockerEndpoint } : {}) },
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
    options: Options,
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
      remove(this.#paths, instanceId, { interaction, abandon, reporter }),
    );
    return {
      status: 'ready',
      message: `Assistant ${instanceId} was removed.`,
      details: removalSummary(preview, removed),
    };
  }

  #secrets(options: Options): Promise<SecretSource> {
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
        run.pause(outcome.pause.code);
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
          headline: `Paused at ${step}: ${safeMessage(error)}`,
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
        presenter.report({ outcome: 'busy', headline: safeMessage(error), details: log });
        return { status: 'done', exitCode: EXIT_CODES.busy };
      }
      const nextAction = this.#nextAction(plan, state);
      if (!run || (error instanceof GwsEaError && error.code === 'cancelled')) {
        presenter.report({
          outcome: 'failed',
          headline: `Stopped at ${step}: ${safeMessage(error)}`,
          details: [nextAction, ...log],
        });
        return { status: 'done', exitCode: EXIT_CODES.failed };
      }
      const report = failureReport(plan.command, nextAction, state, run, error, failures[0], labels);
      presenter.report(failureStop(report, error));
      return { status: 'failed', report, retry: this.#retry(plan, state) };
    }
    /* eslint-enable no-catch-all/no-catch-all */
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
    code: error instanceof GwsEaError ? error.code : 'unexpected',
    cause: safeMessage(error),
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
  const names: Readonly<Record<AbandonableResource, string>> = { 'gcp-project': project };
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
  output('Usage: gws-ea <create|resume|remove> [options]');
  output('  create --track <track> [--source-remote <remote>] [--google-account <email>]');
  output('         [--assistant-first-name <name> --assistant-last-name <name>]');
  output('         [--principal-first-name <name> --principal-last-name <name> --principal-timezone <iana>]');
  output('         [--workspace-email <email>] [--provider <id>]');
  output('         [--ingress existing --endpoint <https-url>]');
  output('         [--ingress managed-cloudflare --cloudflare-zone <zone> --hostname-label <label>]');
  output('  resume --id <instance_id> [--chat-configured] [--messaging-group-id <exact-id>]');
  output('  remove --id <instance_id> [--yes] [--abandon gcp-project]');
  output('  Every command: [--secrets-file <owner-only file under the config root>] [--capture-fixtures]');
  output('  Secrets: GWS_EA_PROVIDER_CREDENTIAL, GWS_EA_CLOUDFLARE_API_TOKEN (environment or --secrets-file).');
  output('  Exit codes: 0 ready, 10 paused for a person, 1 failed, 75 busy.');
}

export async function runCli(args: readonly string[], runtime: CliRuntime = {}): Promise<number> {
  const output = runtime.stdout ?? ((line) => process.stdout.write(`${line}\n`));
  const errorOutput = runtime.stderr ?? ((line) => process.stderr.write(`${line}\n`));
  if (args.length === 0 || args[0] === 'help' || args.includes('--help') || args.includes('-h')) {
    printHelp(output);
    return EXIT_CODES.ready;
  }
  const command = args[0];
  if (command !== 'create' && command !== 'resume' && command !== 'remove') {
    errorOutput('Unknown command.');
    printHelp(errorOutput);
    return EXIT_CODES.failed;
  }
  const presenter = runtime.presenter ?? createLinePresenter(output, errorOutput);
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
