import { provisionInstalledConnectors } from './connector-provisioning.js';
import { CONNECTOR_CATALOG, connectorDefinition, type ConnectorLifecycleContext } from './connectors.js';
import { connectorLines } from './connector-inspection.js';
import { voiceCapabilityRecovery } from './voice-inspection.js';
import { type WebCapabilityDependencies } from './web-connector.js';
import { aliasDecision, runAliasStep, aliasNextActions, type AliasDecision } from './alias.js';
import { withAssistantLock } from './assistant-lock.js';
import { loadInstanceRuntimeConfig } from './service.js';
import {
  onePasswordInstallNextActions,
  onePasswordErrorPauses,
  onePasswordRecovery,
  type OnePasswordCliSeams,
  type OnePasswordDependencies,
} from './onepassword.js';
import {
  onePasswordUninstallPreviewLines,
  previewOnePasswordUninstall,
  type OnePasswordUninstallPreview,
} from './onepassword-uninstall.js';
import os from 'node:os';
import {
  combineEffects,
  managedResult,
  resultJson,
  type Changed,
  type CommandData,
  type ManagedResult,
  type NextAction,
  type OperationData,
} from './result.js';
import path from 'node:path';

import { formatLocalTime } from '../timezone.js';
import { errorCode } from '../community-portal/errors.js';
import { READ_ONLY_COMMANDS, requireOption, targetInstance, type CommandEnd } from './cli-read-only.js';
import type { AttemptCommand as Command } from './command-definitions.js';
import { completionScript, helpLines, schemaDocument, toolVersion } from './command-discovery.js';
import {
  discoveryTarget,
  parseInvocation,
  requestedCommandPath,
  type CommandOptions,
  type ParsedInvocation,
} from './command-parser.js';
import {
  CREATE_INPUT_FLAGS,
  SECRET_INPUTS,
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
  BILLING_ACCOUNT_FLAG,
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
import { isRecord } from './validation.js';
import type { WhatsAppCommandData } from './types.js';
import { runInstanceNclJson } from './ncl.js';
import { deriveGcpClaims, GCP_BILLING_ACCOUNT_PATTERN } from './gcp-identity.js';
import {
  acquireInstanceOperation,
  loadCreatedRuntime,
  readProvisionJournal,
  recordAliasSkipped,
  reserveInstance,
  type InstanceOperation,
} from './journal.js';
import { type OperationIntent, readOperationRecord } from './operation.js';
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
import { redact, registerSecret, safeErrorCode, safeErrorMessage } from './redact.js';
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
  onePasswordOperatorActions,
  type OnePasswordRemovalOutcome,
  type OnePasswordRemovalPreview,
  type OnePasswordUnprovenCreation,
} from './onepassword-removal.js';
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
  initialUpdateTarget,
  planUpdateAll,
  runUpdateAll,
  type AssistantUpdate,
  type UpdateAllPlan,
  type UpdateTurn,
  type UpdateTargetResult,
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

/** Unlabeled prerequisite checks stay out of terminal progress. */
const PREREQUISITES_STEP = { id: 'prerequisites' } as const;

const INTERRUPT_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

/** Managed exits; native ncl and logs retain the delegated tool's exit contract. */
export const EXIT_CODES = { ready: 0, paused: 10, failed: 1, usage: 2, busy: 75 } as const;

type LineWriter = (line: string) => void;
type ServiceCommand = Extract<Command, 'start' | 'stop' | 'restart'>;

export interface StopReport {
  readonly outcome: 'ready' | 'paused' | 'failed' | 'busy' | 'diagnostic';
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
  whatsappNcl?: typeof runInstanceNclJson;
  aliasNcl?: import('./alias.js').AliasStepOptions['ncl'];
  browserInspection?: import('./browser-isolation.js').BrowserIsolationInspection;
  web?: WebCapabilityDependencies;
  onePassword?: OnePasswordCliSeams;
  /** Picks among the operator's 1Password accounts; absent, enable needs --account until one is recorded. */
  chooseOnePasswordAccount?: OnePasswordDependencies['chooseAccount'];
  paths?: ControlPlanePaths;
  stdout?: LineWriter;
  stderr?: LineWriter;
  environment?: NodeJS.ProcessEnv;
  /** Absent: plain lines on stdout and stderr. */
  presenter?: Presenter;
  /** Absent means no person can be asked. */
  prompts?: InteractivePrompts;
  onFailure?: (report: FailureReport) => Promise<'retry' | 'stop'>;
  advanceProvision?: AdvanceProvision;
  resolveReleaseTarget?: (request: CreateTargetRequest) => Promise<ReleaseTarget>;
  holdLoopbackPorts?: () => Promise<HeldLoopbackPorts>;
  collectCreateInputs?: (context: CreatePromptContext) => Promise<CreateSetupAnswers>;
  reserveInstance?: typeof reserveInstance;
  /** The terminal driver adds guided installation. */
  checkPrerequisites?: (request: PrerequisiteRequest, interaction: Interaction) => Promise<Prerequisites>;
  describeRemoval?: typeof describeRemoval;
  removeAssistant?: RemoveAssistantRunner;
  /** Absent means removal requires `--yes`. */
  confirmRemoval?: (preview: RemovalPreview) => Promise<boolean>;
  confirmOnePasswordUninstall?: (preview: OnePasswordUninstallPreview) => Promise<boolean>;
  upsertEnvVars?: UpsertEnvVars;
  hostStatus?: HostStatusHelpers;
  serviceHelpers?: NanoclawServiceHelpers;
  execve?: NonNullable<NodeJS.Process['execve']>;
  toolProviderSetup?: () => Promise<ToolProviderSetup>;
  /** Absent means an update requires `--yes`. */
  confirmUpdate?: (preview: UpdatePreview) => Promise<boolean>;
  /** Asks once, after `update --all` shows its plan and before anything is staged; absent means it requires `--yes`. */
  confirmUpdateAll?: (plan: UpdateAllPlan) => Promise<boolean>;
  /** The central migrations `update --all`'s plan names; absent, this tool's registered migrations. */
  releaseMigrations?: () => Promise<readonly string[]>;
  /** Asks before a rollback restores the pre-update snapshot; absent means that restore requires `--yes`. */
  confirmRollback?: (preview: RollbackPreview) => Promise<boolean>;
  update?: UpdateSeams;
  /** The checkout this tool runs from, which only the launcher names: a stray NanoClaw install there is removed. */
  toolCheckout?: ToolCheckout;
}

type UpdateLauncher = Required<
  Pick<CliRuntime, 'serviceHelpers' | 'toolProviderSetup' | 'upsertEnvVars' | 'hostStatus'>
>;

function assertUpdatesEveryAssistant(options: CommandOptions): void {
  if (options.id !== undefined) throw new GwsEaError('invalid_arguments', 'Pass either --id or --all, not both.');
  if (options.track !== undefined || options['source-remote'] !== undefined) {
    throw new GwsEaError(
      'invalid_arguments',
      '--all keeps each assistant on its own track and repository; move one elsewhere with gws-ea update --id <instance_id> --track <track>.',
    );
  }
}

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

function nextActionLines(actions: readonly NextAction[]): string[] {
  return actions.map((action) =>
    action.kind === 'external'
      ? action.instruction
      : `Next: ${action.argv.map((value) => (/^[a-zA-Z0-9_-]+$/u.test(value) ? value : shellQuote(value))).join(' ')}`,
  );
}

async function attendAliasPause(
  pause: NonNullable<OperationData['pause']>,
  prompts: InteractivePrompts,
  presenter: Presenter,
): Promise<AliasDecision | undefined> {
  const waiting = new AbortController();
  const interrupt = (): void => waiting.abort();
  for (const signal of INTERRUPT_SIGNALS) process.on(signal, interrupt);
  presenter.suspend();
  try {
    const response = await prompts.attendPause({ ...pause, kind: 'human-action' }, waiting.signal);
    const answer = response.kind === 'continue' && !waiting.signal.aborted ? response.decisions?.alias : undefined;
    return answer && pause.aliasCandidate !== undefined
      ? { ...answer, expectedCandidate: pause.aliasCandidate }
      : answer;
  } finally {
    presenter.resume();
    for (const signal of INTERRUPT_SIGNALS) process.off(signal, interrupt);
  }
}

function aliasDecisionOf(options: CommandOptions): AliasDecision | undefined {
  return aliasDecision({
    added: options['alias-added'] === 'true',
    taken: options['alias-taken'] === 'true',
    name: options.alias,
  });
}

function parseBillingAccount(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!GCP_BILLING_ACCOUNT_PATTERN.test(value)) {
    throw new GwsEaError(
      'invalid_arguments',
      `${BILLING_ACCOUNT_FLAG}: ${JSON.stringify(value)} is not a billing account ID such as 01A2B3-C4D5E6-F7A8B9`,
      { details: { flag: BILLING_ACCOUNT_FLAG } },
    );
  }
  return value;
}

function isBusy(error: unknown): boolean {
  return (
    error instanceof GwsEaError &&
    (error.code === 'instance_busy' ||
      error.code === 'voice_busy' ||
      error.code === 'registry_busy' ||
      error.code === 'onepassword_busy')
  );
}

/** Refusals by the assistant's state, which rerunning the same command cannot change, so no retry is offered. */
const STATE_REFUSALS: ReadonlySet<string> = new Set([
  'operation_in_progress',
  'removal_in_progress',
  'instance_not_created',
  'service_not_installed',
  'host_not_running',
  'release_not_newer',
  'rollback_unavailable',
  'rollback_failed',
  'tool_checkout_moved',
]);

function isStateRefusal(error: unknown): boolean {
  return error instanceof GwsEaError && STATE_REFUSALS.has(error.code);
}

function busy(): GwsEaError {
  return new GwsEaError('instance_busy', 'Instance operation is already in progress; no action was taken.');
}

/** For refusals from `prepare`, which validates input before an attempt loads prerequisites or makes changes. */
function initialInvocationExit(error: GwsEaError): number {
  return error.code === 'invalid_arguments' ||
    error.code === 'invalid_release_track' ||
    error.code === 'release_source_required'
    ? EXIT_CODES.usage
    : EXIT_CODES.failed;
}

function createLinePresenter(output: LineWriter, errorOutput: LineWriter): Presenter {
  let last: string | undefined;
  const progress = (text: string): void => {
    if (text === last) return;
    last = text;
    errorOutput(text);
  };
  return {
    event(event) {
      if (event.type === 'step-started' && event.label) progress(event.label);
      else if (event.type === 'step-waiting') progress(event.reason);
    },
    suspend: () => undefined,
    resume: () => undefined,
    line: errorOutput,
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
  const { choices, resumeFlag } = pause;
  return {
    outcome: 'paused',
    headline: `Paused at ${pause.phase}: ${pause.message}`,
    details: [
      ...(pause.details ?? []).map((detail) => `  ${detail}`),
      ...(pause.actionUrl ? [`Open: ${pause.actionUrl}`] : []),
      ...(choices?.length && resumeFlag
        ? [
            'Choose one:',
            ...choices.map(
              (choice) => `  ${JSON.stringify(choice.label)}: ${resume(`${resumeFlag} ${shellQuote(choice.id)}`)}`,
            ),
          ]
        : [`Continue with: ${resume(resumeFlag)}`]),
      `Log: ${log}`,
    ],
  };
}

type Outcome =
  | {
      readonly status: 'ready';
      readonly message: string;
      readonly details?: readonly string[];
      readonly cancelled?: boolean;
      /** What remains for a person once the attempt succeeded. */
      readonly actions?: readonly NextAction[];
    }
  | { readonly status: 'paused'; readonly pause: ProvisionHumanPause };

type Attempt =
  | { readonly status: 'done'; readonly exitCode: number }
  | { readonly status: 'failed'; readonly report: FailureReport; readonly retry: () => Promise<Attempt> };

interface AttemptState {
  instanceId?: string;
  reserved: boolean;
  changed: Changed;
  data: OperationData;
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
  readonly #interruptedResult: (result: ManagedResult) => void;
  /** Set while a terminal waits on a pause: a signal then stops the wait, not the run. */
  #waiting: AbortController | undefined;
  #attemptActive = false;
  result: ManagedResult | undefined;
  #rolloutChanged: Changed = false;
  #rolloutLogs: string[] = [];
  #rolloutStopped: ManagedResult | undefined;
  #rolloutPlan: UpdateAllPlan | undefined;
  #rolloutTargets = new Map<string, UpdateTargetResult>();
  #rolloutCleanup: OperationData['cleanup'];
  #connectorNextActions: readonly NextAction[] = [];
  readonly #connectorRateLimit = { limited: false };

  constructor(runtime: CliRuntime, presenter: Presenter, interruptedResult: (result: ManagedResult) => void) {
    this.#paths = runtime.paths ?? resolveControlPlanePaths();
    this.#presenter = presenter;
    this.#runtime = runtime;
    this.#interruptedResult = interruptedResult;
  }

  /** Validates arguments up front; the returned attempt reports every later failure itself. */
  prepare(command: Command, invocation: ParsedInvocation): () => Promise<Attempt> {
    const { options, repeated, commandArgs: args } = invocation;
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
            decisions: {
              chatConfigured: false,
              skipAlias: options['skip-alias'] === 'true',
              ...(aliasDecisionOf(options) ? { alias: aliasDecisionOf(options) } : {}),
            },
            work: (session) => this.#createWork(session, options, track, source, principalEmails),
          });
      }
      case 'resume': {
        const instanceId = targetInstance(options);
        const billingAccount = parseBillingAccount(options['billing-account']);
        const alias = aliasDecisionOf(options);
        return () =>
          this.#attempt({
            command,
            args,
            options,
            instanceId,
            decisions: {
              chatConfigured: options['chat-configured'] === 'true',
              skipAlias: options['skip-alias'] === 'true',
              ...(billingAccount ? { billingAccount } : {}),
              ...(alias ? { alias } : {}),
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

  /** `extra` is a pause's decision flag, or for `remove` a resource to add to `--abandon`. */
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
          plan.options['delete-vault'] ? '--delete-vault' : undefined,
          abandon.length > 0 ? `--abandon ${abandon.join(',')}` : undefined,
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

  #data(state: AttemptState): OperationData | null {
    const { instance_id: _id, ...facts } = state.data;
    const data = { ...facts, ...(state.reserved && state.instanceId ? { instance_id: state.instanceId } : {}) };
    return Object.keys(data).length > 0 ? data : null;
  }

  #actions(plan: AttemptPlan, state: AttemptState, pause?: ProvisionHumanPause, error?: unknown): NextAction[] {
    if (isBusy(error))
      return state.reserved && state.instanceId
        ? [{ kind: 'command', argv: ['gws-ea', 'status', '--id', state.instanceId] }]
        : [];
    if (!state.reserved && plan.command === 'create')
      return [
        ...(error instanceof PauseRequired
          ? error.instructions.map((instruction) => ({ kind: 'external' as const, instruction }))
          : []),
        {
          kind: 'external',
          instruction: 'Inspect the failure and supplied creation inputs before starting a new creation.',
        },
      ];
    if (isStateRefusal(error))
      return state.instanceId ? [{ kind: 'command', argv: ['gws-ea', 'status', '--id', state.instanceId] }] : [];
    const command = plan.command === 'create' ? 'resume' : plan.command;
    const base = ['gws-ea', command, ...(state.instanceId ? ['--id', state.instanceId] : [])];
    const retained =
      command === 'resume' || command === 'connect-google'
        ? ['secrets-file']
        : command === 'update'
          ? ['track', 'source-remote']
          : command === 'remove'
            ? ['abandon']
            : [];
    for (const flag of retained) if (plan.options[flag]) base.push(`--${flag}`, plan.options[flag]);
    if (command === 'rollback' && plan.options.snapshot === 'true') base.push('--snapshot');
    if (command === 'remove' && plan.options['delete-vault'] === 'true') base.push('--delete-vault');
    if (plan.options.yes === 'true') base.push('--yes');
    const actions: NextAction[] = [];
    if (pause?.actionUrl) actions.push({ kind: 'external', instruction: pause.message, url: pause.actionUrl });
    if (pause?.choices?.length && pause.resumeFlag)
      return [
        ...actions,
        ...pause.choices.map((choice) => ({ kind: 'command' as const, argv: [...base, pause.resumeFlag!, choice.id] })),
      ];
    if (pause?.resumeFlag?.includes('<'))
      actions.push({ kind: 'external', instruction: `Supply the input requested by ${pause.resumeFlag}.` });
    else if (pause?.resumeFlag) base.push(pause.resumeFlag);
    if (error instanceof PauseRequired)
      actions.push(...error.instructions.map((instruction) => ({ kind: 'external' as const, instruction })));
    if (error instanceof GwsEaError && error.code === 'input_required')
      actions.push({ kind: 'external', instruction: safeErrorMessage(error) });
    if (
      error instanceof GwsEaError &&
      (error.code === 'confirmation_required' ||
        (error.code === 'input_required' && command === 'rollback' && state.data.preview !== undefined))
    )
      base.push('--yes');
    actions.push({ kind: 'command', argv: base });
    if (error instanceof RemovalPause)
      actions.push({
        kind: 'command',
        argv: [
          'gws-ea',
          'remove',
          '--id',
          state.instanceId!,
          '--yes',
          ...(plan.options['delete-vault'] === 'true' ? ['--delete-vault'] : []),
          '--abandon',
          [...new Set([...(plan.options.abandon?.split(',') ?? []), error.resource])].join(','),
        ],
      });
    return actions;
  }

  #nextAction(plan: AttemptPlan, state: AttemptState): string {
    const resumes = (plan.command === 'create' || plan.command === 'resume') && state.reserved;
    return `${resumes ? 'Resume' : 'Retry'} with: ${this.#continueCommand(plan, state)}`;
  }

  #retry(plan: AttemptPlan, state: AttemptState): () => Promise<Attempt> {
    if (plan.command !== 'create' || !state.reserved || !state.instanceId) {
      return () => this.prepare(plan.command, parseInvocation([plan.command, ...plan.args]))();
    }
    const resumeArgs = [
      '--id',
      state.instanceId,
      ...(plan.options['secrets-file'] ? ['--secrets-file', plan.options['secrets-file']] : []),
    ];
    return () => this.prepare('resume', parseInvocation(['resume', ...resumeArgs]))();
  }

  #acquire(reporter: StepReporter, instanceId: string, intent: OperationIntent): Promise<InstanceOperation | null> {
    return acquireInstanceOperation(this.#paths, instanceId, intent, (changed) =>
      reporter.emit?.({ type: 'domain-effect', step: intent.command, changed }),
    );
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
      onePassword: {
        cli: onePasswordSeams(this.#runtime.environment ?? process.env, this.#runtime.onePassword),
        operatorTerminal: Boolean(this.#runtime.prompts),
        rateLimitState: this.#connectorRateLimit,
      },
      web: this.#runtime.web,
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
    await this.#cleanStrayInstall(reporter, state);

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
      }),
    );
    run.userInput('provider', setup.bootstrapManifest.provider.id);

    const { release } = await runStep(reporter, { id: 'resolve_release', label: 'Resolving the release…' }, () =>
      (this.#runtime.resolveReleaseTarget ?? resolveReleaseTarget)({ track, source }),
    );
    await runStep(reporter, { id: 'reserve', label: 'Reserving the assistant…' }, async () => {
      await this.#reserve(state, track, source.remote, setup, release.deployed_commit, prerequisites.account);
      state.changed = combineEffects(state.changed, true);
      state.data = { ...state.data, instance_id: instanceId };
      this.#presenter.line(`instance_id: ${instanceId}`);
      await run.assignInstance(instanceId);
    });

    const operation = await this.#acquire(reporter, instanceId, { command: 'create' });
    if (!operation) throw busy();
    try {
      return await this.#provision(reporter, operation, interaction, state);
    } finally {
      operation.release();
    }
  }

  /** The ports are held only until the reservation claims them; each runtime binds its own on start. */
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
      const beforePreparation = state.changed;
      state.changed = combineEffects(state.changed, null);
      await installProductionBootstrapManifest(paths, instanceId, bootstrapManifest);
      state.changed = combineEffects(beforePreparation, true);
      try {
        await (this.#runtime.reserveInstance ?? reserveInstance)(paths, input);
        state.reserved = true;
        state.changed = combineEffects(state.changed, true);
      } catch (error) {
        try {
          await getInstanceReservation(paths, instanceId);
          state.reserved = true;
          state.changed = combineEffects(state.changed, true);
          // eslint-disable-next-line no-catch-all/no-catch-all -- Preserve uncertainty without publishing an unconfirmed assistant identity.
        } catch (observationError) {
          if (observationError instanceof GwsEaError && observationError.code === 'unknown_instance') {
            await removeProductionBootstrapManifest(paths, instanceId);
            state.changed = beforePreparation;
          } else {
            state.changed = combineEffects(state.changed, null);
            state.data = { ...state.data, preparation: { bootstrap_manifest: 'retained', reservation: 'unknown' } };
          }
        }
        throw error;
      }
    } finally {
      await held.release();
    }
  }

  /**
   * A terminal attends each pause and provisioning runs on in the same process; without one, or when the person
   * stops, the pause is reported.
   */
  async #provision(
    reporter: StepReporter,
    operation: InstanceOperation,
    interaction: Interaction,
    state: AttemptState,
  ): Promise<Outcome> {
    let current = interaction;
    for (;;) {
      if (current.decisions.skipAlias) await recordAliasSkipped(operation);
      const result = await runStep(reporter, { id: 'provision' }, () =>
        this.#advance(operation, { interaction: current, runtime: reporter }),
      );
      if (result.status !== 'paused') {
        if (result.pendingConnectors?.length)
          state.data = { ...state.data, connector_pending: result.pendingConnectors };
        return {
          status: 'ready',
          message: [
            `Instance ${operation.instanceId} is ready.`,
            ...(result.pendingConnectors ?? []).map((connector) => `${connector.name}: ${connector.message}`),
          ].join(' '),
          actions: result.nextActions,
        };
      }
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

  async #resumeWork({ reporter, interaction, state }: Session, instanceId: string): Promise<Outcome> {
    const operation = await this.#acquire(reporter, instanceId, { command: 'resume' });
    if (!operation) throw busy();
    try {
      if (interaction.decisions.skipAlias) await recordAliasSkipped(operation);
      await runStep(reporter, PREREQUISITES_STEP, async () => {
        // An instance this launcher cannot continue is refused before sign-in is asked for.
        await readProvisionJournal(this.#paths, instanceId);
        const reservation = await getInstanceReservation(this.#paths, instanceId);
        const account = reservation.exclusive_resource_claims.gcp_account;
        const host = await recordedHost(this.#paths, reservation);
        await this.#checkPrerequisites({ command: 'resume', paths: this.#paths, account, ...host }, interaction);
      });
      return await this.#provision(reporter, operation, interaction, state);
    } finally {
      operation.release();
    }
  }

  async #removeWork(
    { reporter, interaction, state }: Session,
    options: CommandOptions,
    instanceId: string,
    abandon: ReadonlySet<AbandonableResource>,
  ): Promise<Outcome> {
    const environment = this.#runtime.environment ?? process.env;
    const onePassword = onePasswordSeams(environment, this.#runtime.onePassword);
    const deleteVault = options['delete-vault'] === 'true';
    const preview = await runStep(reporter, { id: 'inspect' }, () =>
      (this.#runtime.describeRemoval ?? describeRemoval)(this.#paths, instanceId, { deleteVault, onePassword }),
    );
    state.data = { ...state.data, preview };
    this.#presenter.report(previewReport(removalPreviewLines(preview)));
    if (!options.yes) {
      const confirm = this.#runtime.confirmRemoval;
      if (!confirm) {
        throw new PauseRequired(
          'confirmation_required',
          'Removal needs confirmation: pass --yes, or run gws-ea remove in a terminal to be asked.',
          [],
        );
      }
      if (!(await confirm(preview)))
        return { status: 'ready', cancelled: true, message: 'Removal cancelled. Nothing was changed.' };
    }
    const remove: RemoveAssistantRunner = this.#runtime.removeAssistant ?? removeAssistant;
    const removed = await runStep(reporter, { id: 'remove', label: 'Removing the assistant…' }, () =>
      remove(this.#paths, instanceId, {
        interaction,
        abandon,
        reporter,
        serviceHelpers: this.#runtime.serviceHelpers,
        deleteVault,
        onePassword,
      }),
    );
    state.changed = combineEffects(
      state.changed,
      removed ? removed.removed.length > 0 || removed.abandoned.length > 0 : null,
    );
    state.data = { ...state.data, ...(removed ? { removal: removed } : {}) };
    // Revoking a service account, or settling a creation never proven, is the operator's, on 1Password.com; then
    // they close the receipt that names it.
    const left = removed?.onepassword;
    const owed = left?.receipt_file
      ? onePasswordOperatorActions(instanceId, left.revoke_service_account_ids, left.unproven)
      : [];
    return {
      status: 'ready',
      message: `Assistant ${instanceId} was removed.`,
      details: removalSummary(preview, removed),
      actions: owed.length
        ? [
            ...owed,
            { kind: 'command', argv: ['gws-ea', 'remove', '--id', instanceId, '--yes', '--abandon', 'onepassword'] },
          ]
        : [],
    };
  }

  /**
   * Create's `sign_in_google` and `connect_google` resources, outside the provision journal, so a lost or outdated
   * sign-in is repaired without recreating the assistant.
   */
  async #connectGoogleWork({ reporter, interaction }: Session, instanceId: string): Promise<Outcome> {
    const operation = await this.#acquire(reporter, instanceId, { command: 'connect-google' });
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
              serviceAccountEmail: claims.gchat_subscriber_account,
              credentialFile: runtime.secret_files.gchat_subscriber_key,
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
        details: [
          "While it runs, its host keeps the agents' Google access fresh and keeps the home folder in its Drive shared with the principal.",
        ],
      };
    } finally {
      operation.release();
    }
  }

  async #serviceWork({ reporter, state }: Session, command: ServiceCommand, instanceId: string): Promise<Outcome> {
    const operation = await this.#acquire(reporter, instanceId, { command });
    if (!operation) throw busy();
    try {
      const record = await loadCreatedRuntime(this.#paths, instanceId);
      const helpers = this.#runtime.serviceHelpers;
      if (!helpers) {
        throw new GwsEaError('interactive_setup_unavailable', 'Run this command through the gws-ea launcher');
      }
      const service = createServiceControl(helpers, runtimeServiceTarget(record), {
        recordEffect: (changed) => {
          state.changed = combineEffects(state.changed, changed);
        },
      });
      switch (command) {
        case 'start': {
          const started = await runStep(reporter, { id: 'start', label: 'Starting the assistant…' }, () =>
            service.start(),
          );
          state.changed = combineEffects(state.changed, started === 'started');
          state.data = { ...state.data, service: { action: command, result: started } };
          await verifyServing(reporter, service, instanceId);
          const connectorActions = await this.#provisionConnectors(operation, reporter);
          return {
            status: 'ready',
            message:
              started === 'started'
                ? `Assistant ${instanceId} started.`
                : `Assistant ${instanceId} is already running.`,
            actions: connectorActions,
          };
        }
        case 'stop': {
          const stopped = await runStep(reporter, { id: 'stop', label: 'Stopping the assistant…' }, () =>
            service.stop(),
          );
          state.changed = combineEffects(state.changed, stopped === 'stopped');
          state.data = { ...state.data, service: { action: command, result: stopped } };
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
          state.changed = combineEffects(state.changed, restarted === 'restarted' || restarted === 'started');
          state.data = { ...state.data, service: { action: command, result: restarted } };
          await verifyServing(reporter, service, instanceId);
          const connectorActions = await this.#provisionConnectors(operation, reporter);
          return {
            status: 'ready',
            message:
              restarted === 'restarted'
                ? `Assistant ${instanceId} restarted.`
                : `Assistant ${instanceId} was not running; it is now started.`,
            actions: connectorActions,
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

  async #updateWork({ reporter, state }: Session, request: UpdateRequest, yes: boolean): Promise<Outcome> {
    const confirm = updateConfirmation(yes, this.#runtime.confirmUpdate);
    await this.#cleanStrayInstall(reporter, state);
    const update = await this.#updateAssistant(reporter, request, confirm, this.#updateLauncher(), state);
    if (update) state.data = { ...state.data, update };
    const outcome = updateOutcome(request.instanceId, update);
    return outcome.status === 'ready' ? { ...outcome, actions: state.data.connector_next_actions } : outcome;
  }

  /**
   * An update already under way to this release is continued, not staged again; one with no release to return to is
   * superseded by an update to another; a committed one's follow-ups are finished first, even when this release is
   * the one already committed. Undefined when the preview was declined, which leaves the staging for the next update.
   */
  async #updateAssistant(
    reporter: Session['reporter'],
    request: UpdateRequest,
    confirm: (preview: UpdatePreview) => Promise<boolean>,
    launcher: UpdateLauncher,
    state: AttemptState,
  ): Promise<AssistantUpdate | undefined> {
    const seams = this.#runtime.update ?? {};
    const intent = await runStep(reporter, { id: 'resolve_release', label: 'Resolving the release…' }, () =>
      resolveUpdateIntent(this.#paths, request, seams),
    );
    const operation = await this.#acquire(reporter, request.instanceId, {
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
        if (sameRelease(unfinished.to, intent.target)) {
          const nextActions = await this.#provisionConnectors(operation, reporter);
          state.data = { ...state.data, connector_next_actions: nextActions };
          return { kind: 'completed', release: unfinished.to };
        }
      }
      // The gate admitted this update: it continues an open update to this release, or supersedes one with no release
      // to return to, which is staged anew.
      const continuing =
        unfinished?.phase !== 'committed' &&
        unfinished?.kind === 'update' &&
        unfinished.closed === undefined &&
        sameRelease(unfinished.to, intent.target);
      if (!continuing) {
        const staged = await prepareUpdate(operation, intent, dependencies);
        state.data = { ...state.data, preview: staged.preview };
        this.#presenter.report(previewReport(updatePreviewLines(staged.preview)));
        state.data = { ...state.data, staging: { retained: true, release: staged.to } };
        if (!(await confirmStagedUpdate(operation, staged, confirm))) return undefined;
        const { staging: _staging, ...accepted } = state.data;
        state.data = accepted;
      }
      const updated = await continueUpdate(operation, dependencies);
      const nextActions = await this.#provisionConnectors(operation, reporter);
      state.data = { ...state.data, connector_next_actions: nextActions };
      return { kind: 'updated', updated };
    } finally {
      operation.release();
    }
  }

  async #provisionConnectors(operation: InstanceOperation, reporter: StepReporter): Promise<readonly NextAction[]> {
    const result = await provisionInstalledConnectors(operation, reporter, {
      onePassword: {
        cli: onePasswordSeams(this.#runtime.environment ?? process.env, this.#runtime.onePassword),
        upsertEnvVars: this.#runtime.upsertEnvVars,
        operatorTerminal: Boolean(this.#runtime.prompts),
        rateLimitState: this.#connectorRateLimit,
      },
      web: this.#runtime.web,
    });
    for (const pending of result.pending) this.#presenter.line(`${pending.name}: ${pending.message}`);
    const actions = [...this.#connectorNextActions, ...result.next_actions];
    this.#connectorNextActions = actions.filter(
      (entry, index) => actions.findIndex((other) => JSON.stringify(other) === JSON.stringify(entry)) === index,
    );
    return result.next_actions;
  }

  #rolloutStop(): ManagedResult | undefined {
    return this.#rolloutStopped;
  }

  /**
   * Each assistant that can move runs `update --id`'s own attempt, one at a time in `list` order; the rest are skipped
   * and named (`update-all.ts`). How the plan is confirmed, and the launcher, are settled before any assistant is read.
   */
  async #updateAll(yes: boolean): Promise<Attempt> {
    /* eslint-disable no-catch-all/no-catch-all -- The CLI boundary turns every failure before the first turn into a redacted summary and exit code. */
    let plan: UpdateAllPlan | undefined;
    this.#rolloutChanged = false;
    this.#connectorNextActions = [];
    this.#rolloutLogs = [];
    this.#rolloutStopped = undefined;
    this.#rolloutPlan = undefined;
    this.#rolloutTargets.clear();
    this.#rolloutCleanup = undefined;
    const interrupted = (signal: NodeJS.Signals): void => {
      if (this.#attemptActive) return;
      this.result = managedResult('update', {
        outcome: 'failed',
        changed: this.#rolloutChanged,
        data:
          this.#rolloutPlan || this.#rolloutCleanup
            ? {
                ...(this.#rolloutPlan ? { plan: this.#rolloutPlan, targets: [...this.#rolloutTargets.values()] } : {}),
                ...(this.#rolloutCleanup ? { cleanup: this.#rolloutCleanup } : {}),
              }
            : null,
        error: new GwsEaError('interrupted', `Interrupted by ${signal}.`),
        next_actions: [{ kind: 'command', argv: ['gws-ea', 'update', '--all', ...(yes ? ['--yes'] : [])] }],
        diagnostics: this.#rolloutLogs[0] ? { run_log: this.#rolloutLogs[0] } : {},
      });
      this.#interruptedResult(this.result);
      process.exit(128 + os.constants.signals[signal]);
    };
    for (const signal of INTERRUPT_SIGNALS) process.on(signal, interrupted);
    try {
      const confirm = updateConfirmation(yes, this.#runtime.confirmUpdateAll);
      const launcher = this.#updateLauncher();
      const reporter: StepReporter = {
        emit: (event) => {
          if (event.type === 'domain-effect')
            this.#rolloutChanged = combineEffects(this.#rolloutChanged, event.changed);
          this.#presenter.event(event);
        },
      };
      // Once for the run, not per assistant: every turn shares the tool checkout.
      await this.#cleanStrayInstall(reporter);
      const { releaseMigrations } = this.#runtime;
      plan = await runStep(
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
      this.#rolloutPlan = plan;
      for (const candidate of plan.candidates)
        this.#rolloutTargets.set(candidate.instanceId, initialUpdateTarget(candidate));
      const summary = await runUpdateAll(
        plan,
        confirm,
        (instanceId, toolCommit) => this.#updateTurn(instanceId, toolCommit, yes, launcher),
        {
          preview: (headline, details) => this.#presenter.report({ outcome: 'ready', headline, details }),
          progress: (line) => this.#presenter.line(line),
        },
      );
      this.#presenter.report(summary);
      const stopped = this.#rolloutStop();
      this.result = managedResult('update', {
        outcome: summary.cancelled ? 'cancelled' : summary.outcome === 'ready' ? 'succeeded' : summary.outcome,
        changed: this.#rolloutChanged,
        data: { plan, targets: summary.targets, ...(this.#rolloutCleanup ? { cleanup: this.#rolloutCleanup } : {}) },
        ...(stopped?.error ? { error: new GwsEaError(stopped.error.code, stopped.error.message) } : {}),
        next_actions: [...this.#connectorNextActions, ...(stopped?.next_actions ?? [])],
        diagnostics: stopped?.diagnostics ?? (this.#rolloutLogs[0] ? { run_log: this.#rolloutLogs[0] } : {}),
      });
      return { status: 'done', exitCode: summary.exitCode ?? EXIT_CODES[summary.outcome] };
    } catch (error) {
      this.result = managedResult('update', {
        outcome: error instanceof PauseRequired ? 'paused' : isBusy(error) ? 'busy' : 'failed',
        changed: this.#rolloutChanged,
        data: plan
          ? {
              plan,
              ...(this.#rolloutCleanup ? { cleanup: this.#rolloutCleanup } : {}),
              targets: plan.candidates.map(initialUpdateTarget),
            }
          : null,
        error,
        next_actions:
          error instanceof PauseRequired ? [{ kind: 'command', argv: ['gws-ea', 'update', '--all', '--yes'] }] : [],
        diagnostics: this.#rolloutLogs[0] ? { run_log: this.#rolloutLogs[0] } : {},
      });
      if (error instanceof PauseRequired) {
        this.#presenter.report({
          outcome: 'paused',
          headline: safeErrorMessage(error),
          details: ['Continue with: gws-ea update --all --yes'],
        });
        return { status: 'done', exitCode: EXIT_CODES.paused };
      }
      return { status: 'done', exitCode: reportStop(this.#presenter, error) };
    } finally {
      for (const signal of INTERRUPT_SIGNALS) process.off(signal, interrupted);
    }
    /* eslint-enable no-catch-all/no-catch-all */
  }

  /**
   * Pinned to the run's release. Its preview is shown, not asked about, since the plan's confirmation covers it; a
   * failure skips the interactive retry loop, and the run stops there.
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
      work: async ({ reporter, state }) => {
        turn.ended = await this.#updateAssistant(reporter, request, confirmWithoutAsking, launcher, state);
        if (turn.ended) state.data = { ...state.data, update: turn.ended };
        const outcome = updateOutcome(instanceId, turn.ended);
        return outcome.status === 'ready' ? { ...outcome, actions: state.data.connector_next_actions } : outcome;
      },
    });
    if (this.result) {
      this.#rolloutChanged = combineEffects(this.#rolloutChanged, this.result.changed);
      if (this.result.diagnostics.run_log) this.#rolloutLogs.push(this.result.diagnostics.run_log);
    }
    if (attempt.status === 'done' && attempt.exitCode === EXIT_CODES.ready && turn.ended) {
      this.#rolloutTargets.set(instanceId, { instance_id: instanceId, outcome: 'completed', update: turn.ended });
      return turn.ended;
    }
    this.#rolloutStopped = this.result;
    this.#rolloutTargets.set(instanceId, {
      instance_id: instanceId,
      outcome: attempt.status === 'done' && attempt.exitCode === EXIT_CODES.busy ? 'busy' : 'failed',
    });
    return attempt.status === 'done' && attempt.exitCode === EXIT_CODES.busy
      ? { kind: 'busy' }
      : { kind: 'failed', exitCode: attempt.status === 'done' ? attempt.exitCode : EXIT_CODES.failed };
  }

  /**
   * Also settles what the record says is unfinished. A restore of the pre-update snapshot is shown first and needs
   * `--yes` or a terminal's confirmation; a code-only rollback loses nothing and is not asked about.
   */
  async #rollbackWork({ reporter, state }: Session, instanceId: string, options: CommandOptions): Promise<Outcome> {
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
        state.data = { ...state.data, preview };
        this.#presenter.report(previewReport(rollbackPreviewLines(preview, timezone)));
      },
      ...(confirm ? { confirm } : {}),
    };
    const operation = await this.#acquire(reporter, instanceId, { command: 'rollback' });
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
      state.data = { ...state.data, rollback: outcome };
      return rollbackOutcome(instanceId, outcome, timezone);
    } finally {
      operation.release();
    }
  }

  #strayHandling(): (StrayLauncher & { readonly checkout: ToolCheckout }) | undefined {
    const { toolCheckout, hostStatus, serviceHelpers } = this.#runtime;
    return toolCheckout && hostStatus && serviceHelpers
      ? { checkout: toolCheckout, hostStatus, serviceHelpers }
      : undefined;
  }

  /**
   * A stray install is removed without asking, since gws-ea is the only way NanoClaw runs in the tool checkout; a
   * failure is one warning, and the command goes on.
   */
  async #cleanStrayInstall(reporter: StepReporter, state?: AttemptState): Promise<void> {
    const stray = this.#strayHandling();
    if (!stray) return;
    const { checkout } = stray;
    const line = await runStep(reporter, { id: 'clean_stray' }, async () => {
      let found: StrayInstall | undefined;
      try {
        found = await detectStrayInstall(checkout, this.#paths);
        if (strayParts(found).length === 0) return undefined;
        this.#presenter.report({
          outcome: 'diagnostic',
          headline: `Cleanup scope: authoring checkout ${checkout.root}.`,
          details: [
            `Automatically removing its stray NanoClaw install: ${strayParts(found).join(', ')}; managed assistants are outside this scope.`,
          ],
        });
        const parts: string[] = [];
        const removed = await removeStrayInstall(checkout, found, {
          ...stray,
          recordEffect: (changed) => {
            if (state) state.changed = combineEffects(state.changed, changed);
            else this.#rolloutChanged = combineEffects(this.#rolloutChanged, changed);
          },
          recordRemoved: (part) => {
            parts.push(part);
            if (state) {
              state.changed = combineEffects(state.changed, true);
              state.data = { ...state.data, cleanup: { checkout: checkout.root, removed: [...parts] } };
            } else {
              this.#rolloutChanged = combineEffects(this.#rolloutChanged, true);
              this.#rolloutCleanup = { checkout: checkout.root, removed: [...parts] };
            }
          },
        });
        if (state) {
          state.changed = combineEffects(state.changed, removed.length > 0);
          state.data = { ...state.data, cleanup: { checkout: checkout.root, removed } };
        } else {
          this.#rolloutChanged = combineEffects(this.#rolloutChanged, removed.length > 0);
          this.#rolloutCleanup = { checkout: checkout.root, removed };
        }
        return {
          kind: 'removed' as const,
          text: `Removed a stray NanoClaw install from ${checkout.root}: ${removed.join(', ')}.`,
        };
        // eslint-disable-next-line no-catch-all/no-catch-all -- A stray install never stops a create or update; its failure is a warning.
      } catch (error) {
        if (found && strayParts(found).length > 0) {
          if (state) {
            state.changed = combineEffects(state.changed, null);
            state.data = {
              ...state.data,
              cleanup: {
                checkout: checkout.root,
                removed: state.data.cleanup?.removed ?? [],
                incomplete: true,
                error: { code: safeErrorCode(error), message: safeErrorMessage(error) },
              },
            };
          } else {
            this.#rolloutChanged = combineEffects(this.#rolloutChanged, null);
            this.#rolloutCleanup = {
              checkout: checkout.root,
              removed: this.#rolloutCleanup?.removed ?? [],
              incomplete: true,
              error: { code: safeErrorCode(error), message: safeErrorMessage(error) },
            };
          }
        }
        if (!found) {
          const cleanup = {
            checkout: checkout.root,
            removed: [],
            incomplete: true,
            error: { code: safeErrorCode(error), message: safeErrorMessage(error) },
          };
          if (state) state.data = { ...state.data, cleanup };
          else this.#rolloutCleanup = cleanup;
        }
        const what = found
          ? `remove the stray NanoClaw install in ${checkout.root} (${strayParts(found).join(', ')})`
          : `check ${checkout.root} for a stray NanoClaw install`;
        return {
          kind: 'warning' as const,
          text: `Warning: could not ${what}; retry with gws-ea cleanup. ${safeErrorMessage(error)}`,
        };
      }
    });
    if (line?.kind === 'warning') this.#presenter.report({ outcome: 'failed', headline: line.text, details: [] });
    else if (line) this.#presenter.report({ outcome: 'diagnostic', headline: line.text, details: [] });
  }

  /** Unlike the cleanup create and update start with, Docker that cannot be checked is a failure here. */
  async #cleanupWork({ reporter, state }: Session): Promise<Outcome> {
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
    state.data = { cleanup: { checkout: checkout.root, removed: [] } };
    if (strayParts(found).length === 0) {
      return { status: 'ready', message: `No stray NanoClaw install in ${checkout.root}.` };
    }
    state.changed = combineEffects(state.changed, null);
    const removed = await runStep(reporter, { id: 'remove_stray', label: 'Removing the stray NanoClaw install…' }, () =>
      removeStrayInstall(checkout, found, {
        ...stray,
        recordEffect: (changed) => {
          state.changed = combineEffects(state.changed, changed);
        },
        recordRemoved: (part) => {
          state.changed = combineEffects(state.changed, true);
          state.data = {
            cleanup: { checkout: checkout.root, removed: [...(state.data.cleanup?.removed ?? []), part] },
          };
        },
      }),
    );
    state.changed = removed.length > 0;
    state.data = { cleanup: { checkout: checkout.root, removed } };
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
      changed: false,
      data: plan.instanceId ? { instance_id: plan.instanceId } : {},
    };
    const continueWith = (extra?: string): string => this.#continueCommand(plan, state, extra);
    let run: RunLog | undefined;
    // A signal while waiting on a pause stops the wait. Otherwise, or when the wait was already told to stop
    // and has not (it may be stuck in a check that cannot be aborted), the run ends, and its log says where.
    const interrupted = (signal: NodeJS.Signals): void => {
      const waiting = this.#waiting;
      if (waiting && !waiting.signal.aborted) {
        waiting.abort();
        return;
      }
      run?.interrupt(signal);
      this.result = managedResult(plan.command, {
        outcome: 'failed',
        changed: state.changed,
        data: this.#data(state),
        error: new GwsEaError('interrupted', `Interrupted by ${signal}.`),
        next_actions: this.#actions(plan, state),
        diagnostics: run ? { run_log: run.progressLog } : {},
      });
      if (this.#rolloutPlan && state.instanceId) {
        this.#rolloutTargets.set(state.instanceId, { instance_id: state.instanceId, outcome: 'failed' });
        this.result = {
          ...this.result,
          changed: combineEffects(this.#rolloutChanged, state.changed),
          data: {
            plan: this.#rolloutPlan,
            targets: [...this.#rolloutTargets.values()],
            ...(this.#rolloutCleanup ? { cleanup: this.#rolloutCleanup } : {}),
          },
        };
      }
      this.#interruptedResult(this.result);
      process.exit(128 + os.constants.signals[signal]);
    };
    this.#attemptActive = true;
    for (const signal of INTERRUPT_SIGNALS) process.on(signal, interrupted);
    /* eslint-disable no-catch-all/no-catch-all -- The CLI boundary turns every failure into a redacted summary and exit code. */
    try {
      run = await startRunLog({
        paths,
        command: plan.command,
        ...(plan.instanceId ? { instanceId: plan.instanceId } : {}),
        ...(plan.meta ? { meta: plan.meta } : {}),
        secretDirectories: plan.instanceId
          ? [
              path.join(paths.instanceRoot(plan.instanceId), 'secrets'),
              path.join(paths.instanceRoot(plan.instanceId), 'onecli', 'secrets'),
            ]
          : [],
      });
      const emit = (event: RunEvent): void => {
        if (event.type === 'step-started' && event.label) labels.set(event.step, event.label);
        if (event.type === 'step-failed') failures.push(event);
        if (event.type === 'step-paused' && !event.pause) pausedForInput ??= event.step;
        if (event.type === 'domain-effect') state.changed = combineEffects(state.changed, event.changed);
        presenter.event(event);
      };
      const reporter = { emit, run };
      const secrets = await runStep(reporter, { id: 'secrets' }, () => this.#secrets(plan.options));
      const interaction = createInteraction({
        decisions: plan.decisions ?? { chatConfigured: false },
        secrets,
        ...(this.#runtime.prompts ? { prompts: this.#runtime.prompts } : {}),
        terminal: presenter,
      });
      const outcome = await plan.work({ reporter, interaction, secrets, state });
      if (outcome.status === 'paused') state.data = { ...state.data, pause: pauseFacts(outcome.pause) };
      this.result = managedResult(plan.command, {
        outcome: outcome.status === 'paused' ? 'paused' : outcome.cancelled ? 'cancelled' : 'succeeded',
        changed: state.changed,
        data: this.#data(state),
        next_actions: [
          ...(outcome.status === 'paused' ? this.#actions(plan, state, outcome.pause) : []),
          ...(outcome.status === 'ready' && outcome.cancelled && state.instanceId
            ? [{ kind: 'command' as const, argv: ['gws-ea', 'status', '--id', state.instanceId] }]
            : []),
          ...(outcome.status === 'ready' ? (outcome.actions ?? []) : []),
          ...(state.data.cleanup?.incomplete ? [{ kind: 'command' as const, argv: ['gws-ea', 'cleanup'] }] : []),
        ],
        diagnostics: { run_log: run.progressLog },
      });
      if (outcome.status === 'paused') {
        run.pause(outcome.pause.code, outcome.pause.phase);
        const report = pauseReport(outcome.pause, continueWith, run.progressLog);
        presenter.report({ ...report, details: [...report.details, ...retainedEffectLines(state.data)] });
        return { status: 'done', exitCode: EXIT_CODES.paused };
      }
      run.complete();
      presenter.report({
        outcome: 'ready',
        headline: outcome.message,
        details: [
          ...(outcome.details ?? []),
          ...(outcome.cancelled && state.instanceId ? [`Assistant: ${state.instanceId}`] : []),
          ...(plan.command === 'cleanup' ? [] : retainedEffectLines(state.data)),
          ...(state.reserved && state.instanceId
            ? [
                plan.command === 'remove' && !outcome.cancelled
                  ? 'Next: gws-ea list'
                  : `Next: gws-ea status --id ${state.instanceId}`,
              ]
            : []),
        ],
      });
      return { status: 'done', exitCode: EXIT_CODES.ready };
    } catch (error) {
      if (plan.command === 'cleanup' && state.data.cleanup)
        state.data = {
          ...state.data,
          cleanup: {
            ...state.data.cleanup,
            incomplete: true,
            error: { code: safeErrorCode(error), message: safeErrorMessage(error) },
          },
        };
      const missingInitial =
        plan.command === 'create' && !state.reserved && error instanceof GwsEaError && error.code === 'input_required';
      this.result = managedResult(plan.command, {
        outcome: isBusy(error)
          ? 'busy'
          : error instanceof PauseRequired ||
              (!missingInitial && error instanceof GwsEaError && error.code === 'input_required')
            ? 'paused'
            : error instanceof GwsEaError && error.code === 'cancelled'
              ? 'cancelled'
              : 'failed',
        changed: state.changed,
        data: this.#data(state),
        error,
        next_actions: this.#actions(plan, state, undefined, error),
        diagnostics: {
          ...(run ? { run_log: run.progressLog } : {}),
          ...(failures[0]?.rawLog ? { step_log: failures[0].rawLog } : {}),
        },
      });
      if (missingInitial) {
        run?.abort(error);
        presenter.report({
          outcome: 'failed',
          headline: safeErrorMessage(error),
          details: ['Supply the required creation inputs.'],
        });
        return { status: 'done', exitCode: EXIT_CODES.usage };
      }
      const step = (error instanceof PauseRequired ? pausedForInput : failures[0]?.step) ?? plan.command;
      const log = run ? [`Log: ${run.progressLog}`] : [];
      if (error instanceof PauseRequired || (error instanceof GwsEaError && error.code === 'input_required')) {
        run?.pause(error.code);
        presenter.report({
          outcome: 'paused',
          headline: `Paused at ${step}: ${safeErrorMessage(error)}`,
          details: [
            ...(error instanceof PauseRequired ? error.instructions : []),
            `Continue with: ${continueWith()}`,
            ...(error instanceof RemovalPause ? [`Or leave it behind: ${continueWith(error.resource)}`] : []),
            ...log,
          ],
        });
        return { status: 'done', exitCode: EXIT_CODES.paused };
      }
      run?.abort(error);
      if (isBusy(error)) {
        presenter.report({
          outcome: 'busy',
          headline: safeErrorMessage(error),
          details: [
            ...(state.instanceId
              ? [
                  `Assistant: ${state.instanceId}; blocked command: ${plan.command}`,
                  `Inspect with: gws-ea status --id ${state.instanceId}`,
                ]
              : []),
            ...log,
          ],
        });
        return { status: 'done', exitCode: EXIT_CODES.busy };
      }
      // Retrying cannot help, and this command's own rerun is not the way on.
      if (isStateRefusal(error)) {
        presenter.report({ outcome: 'failed', headline: safeErrorMessage(error), details: log });
        return { status: 'done', exitCode: EXIT_CODES.failed };
      }
      const nextAction = this.#nextAction(plan, state);
      if (error instanceof GwsEaError && error.code === 'cancelled') {
        presenter.report({
          outcome: 'ready',
          headline: safeErrorMessage(error),
          details: [...retainedEffectLines(state.data), ...log],
        });
        return { status: 'done', exitCode: EXIT_CODES.ready };
      }
      if (!run) {
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
      this.#attemptActive = false;
    }
    /* eslint-enable no-catch-all/no-catch-all */
  }
}

function pauseFacts(pause: ProvisionHumanPause): NonNullable<OperationData['pause']> {
  const { settled: _settled, kind: _kind, ...facts } = pause;
  return facts;
}

function retainedEffectLines(data: OperationData): string[] {
  return [
    ...(data.preparation
      ? [
          'Bootstrap preparation remains; reservation could not be confirmed. Inspect the cause before starting a new creation.',
        ]
      : []),
    ...(data.cleanup
      ? [
          `Authoring checkout ${data.cleanup.checkout}: removed ${data.cleanup.removed.join(', ') || 'no confirmed resources'}${data.cleanup.incomplete ? '; cleanup remains incomplete; run gws-ea cleanup' : ''}.`,
        ]
      : []),
  ];
}

function signInDetails(signInNeeded: string | null): string[] {
  return signInNeeded ? [`${signInNeeded}.`] : [];
}

function updatedOutcome(instanceId: string, updated: UpdatedAssistant): Outcome {
  return {
    status: 'ready',
    message: `Assistant ${instanceId} was updated to ${releaseLine(updated.to)}.`,
    details: [
      updated.rollbackTarget
        ? `Its previous release, ${releaseLine(updated.from)}, is kept to roll back to.`
        : 'It has no previous release to roll back to.',
      ...signInDetails(updated.signInNeeded),
    ],
  };
}

function rollbackOutcome(instanceId: string, outcome: RollbackOutcome, timezone: string): Outcome {
  switch (outcome.kind) {
    case 'rolled_back':
      return {
        status: 'ready',
        message: `Assistant ${instanceId} was rolled back to ${releaseLine(outcome.to)}.`,
        details: [
          ...(outcome.mode === 'code_only'
            ? ['Only its code went back: every conversation, memory, and setting since the update was kept.']
            : [
                `Its snapshot from ${formatLocalTime(outcome.snapshotAt, timezone)} was restored.`,
                `What it recorded since on ${releaseLine(outcome.from)} is kept in ${outcome.keptAt} until another snapshot restore replaces it, or the assistant is removed.`,
              ]),
          ...signInDetails(outcome.signInNeeded),
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
        cancelled: true,
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

function updateOutcome(instanceId: string, update: AssistantUpdate | undefined): Outcome {
  if (!update)
    return {
      status: 'ready',
      cancelled: true,
      message: 'Update cancelled. The serving release is unchanged; staged assets are retained.',
    };
  switch (update.kind) {
    case 'updated':
      return updatedOutcome(instanceId, update.updated);
    case 'completed':
      return finishedOutcome(instanceId, update.release);
  }
}

async function confirmWithoutAsking(): Promise<boolean> {
  return true;
}

/** Without `--yes` or a terminal, the run pauses only once the domain has produced the preview to confirm. */
function updateConfirmation<Preview>(
  yes: boolean,
  prompt: ((preview: Preview) => Promise<boolean>) | undefined,
): (preview: Preview) => Promise<boolean> {
  return yes
    ? confirmWithoutAsking
    : (prompt ??
        (async () => {
          throw new PauseRequired(
            'confirmation_required',
            'An update needs confirmation: pass --yes, or run gws-ea update in a terminal to be asked.',
            [],
          );
        }));
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

function parseWhatsAppCommandData(value: unknown): WhatsAppCommandData {
  const invalid = () => new GwsEaError('invalid_child_output', 'The host returned an invalid WhatsApp link state.');
  if (!isRecord(value)) throw invalid();
  const state = (['unlinked', 'linking', 'connected', 'needs-relink'] as const).find(
    (candidate) => candidate === value.state,
  );
  if (
    !state ||
    Object.keys(value).some((key) => !['state', 'number', 'principal', 'bindingPending', 'pairingCode'].includes(key))
  )
    throw invalid();
  const { number, bindingPending, pairingCode, principal } = value;
  if (number !== undefined && (typeof number !== 'string' || !/^\+[1-9]\d{6,14}$/u.test(number))) throw invalid();
  if (bindingPending !== undefined && typeof bindingPending !== 'boolean') throw invalid();
  if (pairingCode !== undefined && (typeof pairingCode !== 'string' || !/^[A-Z0-9-]{4,32}$/u.test(pairingCode)))
    throw invalid();
  let bound: WhatsAppCommandData['principal'];
  if (principal !== undefined) {
    if (
      !isRecord(principal) ||
      typeof principal.lid !== 'string' ||
      !/^\d+$/u.test(principal.lid) ||
      (principal.phoneJid !== undefined &&
        (typeof principal.phoneJid !== 'string' || !/^\d+@s\.whatsapp\.net$/u.test(principal.phoneJid)))
    )
      throw invalid();
    bound = { lid: principal.lid, ...(principal.phoneJid === undefined ? {} : { phoneJid: principal.phoneJid }) };
  }
  return {
    state,
    ...(number === undefined ? {} : { number }),
    ...(bindingPending === undefined ? {} : { bindingPending }),
    ...(pairingCode === undefined ? {} : { pairingCode }),
    ...(bound === undefined ? {} : { principal: bound }),
  };
}

/**
 * Admitted under the instance lock, which is released before the process is handed to `bin/ncl`: `ncl` talks to the
 * running host over its socket, and a lock it held would outlive it.
 */
async function prepareNcl(
  paths: ControlPlanePaths,
  invocation: ParsedInvocation,
  environment: NodeJS.ProcessEnv,
): Promise<CommandEnd> {
  const { options, passThrough } = invocation;
  const instanceId = targetInstance(options);
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
function reportStop(presenter: Presenter, error: unknown, details: readonly string[] = [], tail?: string): number {
  if (isBusy(error)) {
    presenter.report({ outcome: 'busy', headline: safeErrorMessage(error), details });
    return EXIT_CODES.busy;
  }
  const usage =
    error instanceof GwsEaError && error.code === 'invalid_arguments' ? ['Run gws-ea --help for usage.'] : [];
  presenter.report({
    outcome: 'failed',
    headline: safeErrorMessage(error),
    details: [...usage, ...details],
    ...(tail ? { tail } : {}),
  });
  return usage.length ? EXIT_CODES.usage : EXIT_CODES.failed;
}

/** A command that ends with `replaceWith` has the process handed to that tool, which then owns the exit code. */
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
    ...(state.reserved && state.instanceId ? { instanceId: state.instanceId } : {}),
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
  const input: InstanceReservationInput = {
    instance_id: instanceId,
    release_track: track,
    source_remote: sourceRemote,
    deployed_commit: production.commit,
    allocated_ports: production.ports,
    exclusive_resource_claims: {
      ...deriveGcpClaims(instanceId),
      gcp_account: production.gcpAccount,
      workspace_email: setup.assistantWorkspaceEmail,
      onecli_project: `gws-ea-${instanceId.replaceAll('-', '')}`,
    },
  };
  return validateReservation(input);
}

function previewReport(lines: readonly string[]): StopReport {
  return { outcome: 'ready', headline: lines[0] ?? 'Preview', details: lines.slice(1) };
}

function itemCount(count: number): string {
  return `${count} item${count === 1 ? '' : 's'}`;
}

function serviceAccountLine(ids: readonly string[], prefix: string): string[] {
  if (!ids.length) return [];
  const one = ids.length === 1;
  return [
    `${prefix}service account${one ? '' : 's'} ${ids.join(', ')} still work${one ? 's' : ''} until you revoke ${one ? 'it' : 'them'} on 1Password.com (Developer > Directory); removal cannot revoke service accounts.`,
  ];
}

/** An unproven creation has no recorded ID, so removal cannot find it; only the operator can settle it. */
function unprovenLines(unproven: readonly OnePasswordUnprovenCreation[], prefix: string): string[] {
  return unproven.map(({ kind, name }) =>
    kind === 'vault'
      ? `${prefix}vault "${name}" may exist; removal cannot find it, so delete it yourself on 1Password.com if it is listed.`
      : `${prefix}runtime service account "${name}" may exist; removal cannot find it, so revoke it yourself on 1Password.com (Developer > Directory) if it is listed.`,
  );
}

function onePasswordPreviewLines(preview: OnePasswordRemovalPreview): string[] {
  const count = preview.item_count;
  const effect = ((): string => {
    switch (preview.vault) {
      case 'delete':
        return `Deleted with this removal${count === 0 ? '; it holds no items' : count === null ? '; its item count is unknown' : `, with its ${itemCount(count)}`}. ${preview.reason}`;
      case 'retain':
        return `Kept in 1Password${count === null ? '' : ` with its ${itemCount(count)}`}: ${preview.reason}${preview.owned ? ' Pass --delete-vault to delete it with everything it holds.' : ''}`;
      case 'deleted':
        return `Already deleted: ${preview.reason}`;
      case 'retained':
        return `Already kept: ${preview.reason}`;
      case 'gone':
        return `Already gone: ${preview.reason}`;
      case 'unrecorded':
        return preview.reason;
    }
  })();
  return [
    preview.vault_id === null
      ? `1Password account ${preview.account_id}`
      : `1Password vault ${preview.vault_id} in account ${preview.account_id}`,
    `  ${effect}`,
    '  Runtime token: deleted from this host with the assistant.',
    ...serviceAccountLine(preview.runtime_service_account_ids, '  Not revoked by removal: '),
    ...unprovenLines(preview.unproven, '  Never proven: '),
  ];
}

function removalPreviewLines(preview: RemovalPreview): string[] {
  return [
    `Assistant: ${preview.instanceId}`,
    `NanoClaw: ${preview.checkout}`,
    `OneCLI: ${preview.onecliProject}`,
    `Google Cloud project: ${preview.gcpProject} (${preview.gcpAccount})`,
    ...(preview.onepassword ? onePasswordPreviewLines(preview.onepassword) : []),
    'Permanently tears down this assistant’s recorded local resources and requests project deletion; its subscription and credentials are removed within their existing ownership rules.',
  ];
}

function onePasswordOutcomeLines(instanceId: string, outcome: OnePasswordRemovalOutcome): string[] {
  const count = outcome.item_count;
  const vault = ((): string => {
    switch (outcome.vault) {
      case 'deleted':
        return `deleted from account ${outcome.account_id}${count === 0 ? '; it held no items' : count === null ? '' : `, with its ${itemCount(count)}`}.`;
      case 'retained':
        return `kept in account ${outcome.account_id}${count === null ? '' : ` with its ${itemCount(count)}`}. ${outcome.reason}`;
      case 'gone':
        return `already gone from account ${outcome.account_id}.`;
      case 'left_behind':
        return `left behind in account ${outcome.account_id}, unsettled; delete it yourself on 1Password.com if you no longer need it.`;
      case 'unrecorded':
        return `none recorded in account ${outcome.account_id}.`;
    }
  })();
  return [
    `1Password vault${outcome.vault_id === null ? '' : ` ${outcome.vault_id}`}: ${vault}`,
    outcome.runtime_token === 'deleted'
      ? 'Runtime token: deleted from this host.'
      : 'Runtime token: none was on this host.',
    ...serviceAccountLine(outcome.revoke_service_account_ids, 'Not revoked: '),
    ...unprovenLines(outcome.unproven, 'Never proven: '),
    ...(outcome.receipt_file
      ? [
          `They stay named in ${outcome.receipt_file} until you close it, after revoking or deleting them: gws-ea remove --id ${instanceId} --yes --abandon onepassword.`,
        ]
      : []),
  ];
}

function onePasswordSeams(
  environment: NodeJS.ProcessEnv,
  overrides: OnePasswordCliSeams | undefined,
): OnePasswordCliSeams {
  return {
    ...(environment.PATH ? { searchPath: environment.PATH } : {}),
    ambient: environment,
    ...overrides,
  };
}

function removalSummary(preview: RemovalPreview, outcome: RemovalOutcome | undefined): string[] {
  const project = `Google Cloud project ${preview.gcpProject}`;
  const unobserved = (name: string): string =>
    `Left behind: ${name}, which removal could not observe; delete it yourself if it still exists.`;
  const leftBehind: Readonly<Record<AbandonableResource, string>> = {
    'gcp-project': unobserved(project),
    'chat-subscription':
      "Left behind: the assistant's Google Chat subscription, which removal could not delete without a working " +
      'sign-in; with the project deleted it delivers nowhere, and Google deletes it within 7 days.',
    onepassword:
      "No longer tracked: the assistant's 1Password resources named below; settle any that remain yourself on 1Password.com.",
    web: 'Left behind: the exact artifact resources named below. Their ownership record, credentials and removal receipt remain for manual cleanup.',
  };
  return [
    ...(outcome?.removed.includes('gcp-project')
      ? [`${project}: deletion requested; it stays recoverable for 30 days, then Google Cloud deletes it.`]
      : []),
    ...(outcome?.onepassword ? onePasswordOutcomeLines(preview.instanceId, outcome.onepassword) : []),
    ...(outcome?.abandoned.flatMap(({ resource, evidence }) =>
      resource === 'onepassword' || resource === 'web'
        ? [leftBehind[resource], ...evidence.split('\n').map((line) => `  ${line}`)]
        : [leftBehind[resource]],
    ) ?? []),
    ...(outcome?.keyPolicyUnrestored
      ? [
          `The service-account key-creation policy lifted on ${project} was not restored: ${outcome.keyPolicyUnrestored.split('\n')[0]}`,
        ]
      : []),
    ...(outcome?.memberPolicyUnrestored
      ? [
          `The member-domain policy relaxed on ${project} was not restored: ${outcome.memberPolicyUnrestored.split('\n')[0]}`,
        ]
      : []),
  ];
}

export async function runCli(args: readonly string[], runtime: CliRuntime = {}): Promise<number> {
  const registerErrorSecrets = (): void => {
    for (const key of Object.values(SECRET_INPUTS)) {
      const value = (runtime.environment ?? process.env)[key];
      if (value) registerSecret(value);
    }
  };
  const resultOutput = runtime.stdout ?? ((line) => process.stdout.write(`${line}\n`));
  const rawErrorOutput = runtime.stderr ?? ((line) => process.stderr.write(`${line}\n`));
  const errorOutput: LineWriter = (line) => rawErrorOutput(redact(line));
  const delimiter = args.indexOf('--');
  const outer = delimiter < 0 ? args : args.slice(0, delimiter);
  const json = outer.includes('--json');
  let resultWritten = false;
  const output: LineWriter = (line) => {
    if (json) resultWritten = true;
    resultOutput(line);
  };
  const requestedCommand = requestedCommandPath(outer);
  const emitResult = (result: ManagedResult): void => {
    if (json && !resultWritten) output(resultJson(result));
  };
  /** Outside the attempt loop, an interrupted `--json` run still reports the facts observed before exit. */
  const observeInterruption = (facts: () => Pick<ManagedResult, 'changed' | 'data'>): (() => void) => {
    if (!json) return () => undefined;
    const interrupted = (signal: NodeJS.Signals): void => {
      emitResult(
        managedResult(invocation.definition.path.join(' '), {
          outcome: 'failed',
          ...facts(),
          error: new GwsEaError('interrupted', `Interrupted by ${signal}.`),
        }),
      );
      process.exit(128 + os.constants.signals[signal]);
    };
    for (const signal of INTERRUPT_SIGNALS) process.on(signal, interrupted);
    return () => {
      for (const signal of INTERRUPT_SIGNALS) process.off(signal, interrupted);
    };
  };
  if (json || outer.includes('--no-input')) {
    const {
      prompts: _prompts,
      onFailure: _failure,
      confirmRemoval: _remove,
      confirmOnePasswordUninstall: _vaults,
      confirmUpdate: _update,
      confirmUpdateAll: _all,
      confirmRollback: _rollback,
      chooseOnePasswordAccount: _account,
      presenter: _presenter,
      ...safe
    } = runtime;
    runtime = safe;
  }
  let invocation: ParsedInvocation;
  try {
    invocation = parseInvocation(args);
    const { definition, options } = invocation;
    if (invocation.help) {
      const target =
        definition.handler.kind === 'discovery' && definition.handler.command === 'help'
          ? discoveryTarget(invocation.arguments)
          : definition;
      for (const line of helpLines(target)) output(line);
      return EXIT_CODES.ready;
    }
    if (definition.handler.kind === 'discovery') {
      switch (definition.handler.command) {
        case 'help':
          for (const line of helpLines(discoveryTarget(invocation.arguments))) output(line);
          break;
        case 'schema':
          output(JSON.stringify(schemaDocument(discoveryTarget(invocation.arguments)), null, 2));
          break;
        case 'completion':
          output(completionScript(invocation.arguments[0]));
          break;
        case 'version': {
          const version = await toolVersion();
          output(
            options.json === 'true'
              ? JSON.stringify(version)
              : `gws-ea ${version.version}${version.revision ? ` (${version.revision})` : ''}`,
          );
          break;
        }
      }
      return EXIT_CODES.ready;
    }
  } catch (error) {
    if (!(error instanceof GwsEaError)) throw error;
    registerErrorSecrets();
    emitResult(managedResult(requestedCommand, { outcome: 'failed', error }));
    errorOutput(error.message);
    errorOutput('Run gws-ea --help for usage.');
    return error.code === 'invalid_arguments' ? EXIT_CODES.usage : EXIT_CODES.failed;
  }
  const { handler } = invocation.definition;
  const { options } = invocation;
  const basePresenter = runtime.presenter ?? createLinePresenter(output, errorOutput);
  const quiet = options.quiet === 'true';
  const presenter: Presenter = {
    event: (event) => {
      if (!quiet) basePresenter.event(event);
    },
    suspend: () => basePresenter.suspend(),
    resume: () => basePresenter.resume(),
    line: (line) => {
      if (!quiet) basePresenter.line(redact(line));
    },
    report: (report) => {
      if (!json)
        basePresenter.report({
          ...report,
          headline: redact(report.headline),
          details: report.details.map(redact),
          ...(report.tail ? { tail: redact(report.tail) } : {}),
        });
    },
  };
  const environment = runtime.environment ?? process.env;
  if (invocation.definition.outputModes.includes('json')) {
    // Initialize managed paths before dispatch, while no domain effects have occurred.
    try {
      runtime = { ...runtime, paths: runtime.paths ?? resolveControlPlanePaths() };
      // eslint-disable-next-line no-catch-all/no-catch-all -- This boundary serializes initialization failures without exposing raw filesystem errors.
    } catch (error) {
      registerErrorSecrets();
      const instruction = 'Inspect and correct GWS_EA_CONFIG_ROOT and GWS_EA_STATE_ROOT before continuing.';
      emitResult(
        managedResult(invocation.definition.path.join(' '), {
          outcome: 'failed',
          error,
          next_actions: [{ kind: 'external', instruction }],
        }),
      );
      presenter.report({ outcome: 'failed', headline: safeErrorMessage(error), details: [instruction] });
      return EXIT_CODES.failed;
    }
  }
  switch (handler.kind) {
    case 'whatsapp': {
      let changed: Changed = false;
      try {
        const paths = runtime.paths ?? resolveControlPlanePaths();
        const instanceId = targetInstance(options);
        const operation = await acquireInstanceOperation(paths, instanceId, { command: 'ncl' });
        if (!operation) throw busy();
        let data: WhatsAppCommandData;
        try {
          const config = await loadCreatedRuntime(paths, instanceId);
          const args = ['gws-ea-whatsapp', handler.command];
          if (handler.command === 'link')
            for (const key of ['number', 'principal-number'] as const)
              if (options[key] !== undefined) args.push(`--${key}`, options[key]);
          // An interrupted host call may already have started or removed the link.
          if (handler.command !== 'status') changed = null;
          data = parseWhatsAppCommandData(await (runtime.whatsappNcl ?? runInstanceNclJson)(config, args));
        } finally {
          operation.release();
        }
        if (handler.command !== 'status') changed = true;
        emitResult(managedResult(invocation.definition.path.join(' '), { outcome: 'succeeded', changed, data }));
        if (!json) {
          output(`WhatsApp: ${data.state}${typeof data.number === 'string' ? ` (${data.number})` : ''}`);
          if (typeof data.pairingCode === 'string') output(`Pairing code: ${data.pairingCode}`);
        }
        return EXIT_CODES.ready;
        // eslint-disable-next-line no-catch-all/no-catch-all -- the CLI boundary reports every host or transport failure as a redacted managed result
      } catch (error) {
        emitResult(
          managedResult(invocation.definition.path.join(' '), {
            outcome: isBusy(error) ? 'busy' : 'failed',
            changed,
            error,
          }),
        );
        return reportStop(presenter, error);
      }
    }
    case 'alias': {
      const paths = runtime.paths ?? resolveControlPlanePaths();
      const instanceId = targetInstance(options);
      let changed: Changed = false;
      let data: OperationData = { instance_id: instanceId };
      const stop = observeInterruption(() => ({ changed, data }));
      try {
        let decision = aliasDecisionOf(options);
        for (;;) {
          const result = await withAssistantLock(paths, instanceId, async () =>
            runAliasStep(
              paths,
              instanceId,
              await loadInstanceRuntimeConfig(paths.runtimeFile(instanceId)),
              {
                emit: (event) => {
                  if (event.type === 'domain-effect') changed = combineEffects(changed, event.changed);
                  presenter.event(event);
                },
              },
              { decision, ncl: runtime.aliasNcl },
            ),
          );
          data = {
            instance_id: instanceId,
            ...(result.status === 'paused' ? { pause: pauseFacts(result.pause) } : {}),
          };
          if (result.status === 'paused' && runtime.prompts) {
            const answer = await attendAliasPause(result.pause, runtime.prompts, presenter);
            if (answer !== undefined) {
              decision = answer;
              continue;
            }
          }
          const paused = result.status === 'paused';
          const actions = paused ? aliasNextActions(instanceId, result.pause) : [];
          presenter.report({
            outcome: paused ? 'paused' : 'ready',
            headline: paused ? result.pause.message : `Web alias configured for assistant ${instanceId}.`,
            details: [
              ...(result.status === 'paused'
                ? [
                    ...(result.pause.details ?? []).map((detail) => `  ${detail}`),
                    'Use --alias-taken for another suggestion, or --alias <name> for your own address.',
                  ]
                : []),
              ...nextActionLines(actions),
            ],
          });
          emitResult(
            managedResult('alias', { outcome: paused ? 'paused' : 'succeeded', changed, data, next_actions: actions }),
          );
          return paused ? EXIT_CODES.paused : EXIT_CODES.ready;
        }
      } catch (cause) {
        const error =
          cause instanceof GwsEaError
            ? cause
            : new GwsEaError(
                'alias_operation_failed',
                'Web alias setup failed. Inspect this assistant’s identity and host state.',
                { cause },
              );
        emitResult(managedResult('alias', { outcome: isBusy(error) ? 'busy' : 'failed', changed, data, error }));
        return reportStop(presenter, error);
      } finally {
        stop();
      }
    }
    case 'connector': {
      const commandPath = invocation.definition.path.join(' ');
      const paths = runtime.paths ?? resolveControlPlanePaths();
      let changed: Changed = false;
      let data: CommandData | null = null;
      let run: RunLog | undefined;
      let stepLog: string | undefined;
      let actions: readonly NextAction[] = [];
      let previewLines: readonly string[] = [];
      const stop = observeInterruption(() => ({ changed, data }));
      const recordEffect = (effect: true | null): void => {
        changed = combineEffects(changed, effect);
      };
      try {
        registerErrorSecrets();
        if (handler.command === 'list' || handler.command === 'show' || handler.command === 'check') {
          const checked = handler.command === 'check';
          const inspection = {
            check: checked,
            instanceId: options.id,
            onePassword: onePasswordSeams(environment, runtime.onePassword),
            web: runtime.web,
            serviceHelpers: runtime.serviceHelpers,
            hostStatus: runtime.hostStatus,
          };
          const observations =
            handler.command === 'list'
              ? await Promise.all(CONNECTOR_CATALOG.map((connector) => connector.inspect(paths, inspection)))
              : [await connectorDefinition(handler.name).inspect(paths, inspection)];
          data = handler.command === 'list' ? { connectors: observations } : observations[0];
          actions = observations.flatMap((observation) => observation.next_actions);
          const failed = checked && observations.some((observation) => observation.readiness.status !== 'ready');
          if (!json)
            for (const observation of observations)
              for (const line of connectorLines(observation, handler.command !== 'list')) output(line);
          if (!json) for (const line of nextActionLines(actions)) output(line);
          emitResult(
            managedResult(commandPath, {
              outcome: failed ? 'failed' : 'succeeded',
              changed: false,
              data,
              next_actions: actions,
              ...(failed
                ? {
                    error: new GwsEaError(
                      `${observations[0].name}_not_ready`,
                      'Connector readiness was not established. Inspect the structured reasons and next actions.',
                    ),
                  }
                : {}),
            }),
          );
          return failed ? EXIT_CODES.failed : EXIT_CODES.ready;
        }
        const name = handler.name;
        let paused = false;
        const lifecycleContext: ConnectorLifecycleContext = {
          paths,
          options,
          voice: {
            environment,
            upsertEnvVars: runtime.upsertEnvVars,
            serviceHelpers: runtime.serviceHelpers,
            progress: (line) => presenter.line(line),
            recordEffect,
          },
          onePassword: {
            cli: onePasswordSeams(environment, runtime.onePassword),
            upsertEnvVars: runtime.upsertEnvVars,
            chooseAccount: runtime.chooseOnePasswordAccount,
            operatorTerminal: Boolean(runtime.prompts),
            progress: (line) => presenter.line(line),
            recordEffect,
            rateLimitState: { limited: false },
          },
          web: { ...runtime.web, recordEffect },
        };
        if (name === 'onepassword' && handler.command === 'uninstall') {
          const dependencies = lifecycleContext.onePassword;
          let confirmed = options['delete-vaults'] === 'true';
          let confirmedPreview: OnePasswordUninstallPreview | undefined;
          if (!confirmed && options.abandon !== 'true' && runtime.confirmOnePasswordUninstall) {
            const preview = await previewOnePasswordUninstall(paths, dependencies);
            confirmed = await runtime.confirmOnePasswordUninstall(preview);
            if (confirmed) confirmedPreview = preview;
          }
          const result = await connectorDefinition('onepassword').uninstall({
            ...lifecycleContext,
            deleteVaults: confirmed,
            confirmedPreview,
          });
          data = result;
          paused = result.outcome === 'paused';
          if (paused) previewLines = onePasswordUninstallPreviewLines(result.preview);
          actions = [
            ...(paused
              ? [
                  {
                    kind: 'command' as const,
                    argv: ['gws-ea', 'connectors', 'uninstall', name, ...(confirmedPreview ? [] : ['--delete-vaults'])],
                  },
                ]
              : []),
            ...(result.revoke_service_account_ids.length
              ? [
                  {
                    kind: 'external' as const,
                    instruction: `Revoke these service accounts on 1Password.com: ${result.revoke_service_account_ids.join(', ')}. Then close the receipt with gws-ea connectors uninstall onepassword --abandon.`,
                  },
                ]
              : []),
          ];
        } else {
          const lifecycle = handler.command;
          run = await startRunLog({ paths, command: commandPath });
          const result = await run.step(`${handler.command} ${name}`, async (step) => {
            stepLog = step.rawLog;
            return connectorDefinition(name)[lifecycle](lifecycleContext);
          });
          data = result;
          if (result.name === 'onepassword' && 'enabled' in result) {
            paused = result.assistants.some((assistant) => assistant.outcome === 'pending');
            actions = onePasswordInstallNextActions(result);
          } else if (result.name === 'web') {
            paused =
              'assistants' in result
                ? result.assistants.some((assistant) => assistant.outcome === 'pending')
                : result.outcome === 'pending';
            const namingOnly =
              'assistants' in result &&
              paused &&
              result.assistants
                .filter((assistant) => assistant.outcome === 'pending')
                .every((assistant) => ['web_name_unusable', 'web_hostname_claimed'].includes(assistant.reason ?? ''));
            actions = [
              ...(namingOnly
                ? []
                : [
                    {
                      kind: 'command' as const,
                      argv: ['gws-ea', 'connectors', paused ? handler.command : 'show', name],
                    },
                  ]),
              ...('operator_actions' in result
                ? result.operator_actions.map((instruction) => ({ kind: 'external' as const, instruction }))
                : []),
            ];
          } else
            actions =
              handler.command === 'install' ? [{ kind: 'command', argv: ['gws-ea', 'connectors', 'check', name] }] : [];
          run.complete();
        }
        presenter.report({
          outcome: paused ? 'paused' : 'ready',
          headline: `${name}: ${handler.command}${paused ? ' has pending work' : ' completed'}.`,
          details: [
            ...previewLines,
            ...(data && 'assistants' in data && Array.isArray(data.assistants)
              ? data.assistants.flatMap((assistant: unknown) =>
                  isRecord(assistant) && typeof assistant.message === 'string'
                    ? [`Assistant ${String(assistant.instance_id)}: ${assistant.message}`]
                    : [],
                )
              : []),
            ...(data && 'reason' in data && typeof data.reason === 'string' ? [data.reason] : []),
            ...nextActionLines(actions),
          ],
        });
        emitResult(
          managedResult(commandPath, {
            outcome: paused ? 'paused' : 'succeeded',
            changed,
            data,
            next_actions: actions,
            diagnostics: { ...(run ? { run_log: run.progressLog } : {}), ...(stepLog ? { step_log: stepLog } : {}) },
          }),
        );
        return paused ? EXIT_CODES.paused : EXIT_CODES.ready;
      } catch (cause) {
        const name = handler.command === 'list' ? undefined : handler.name;
        let error =
          cause instanceof GwsEaError
            ? cause
            : new GwsEaError(
                'connector_operation_failed',
                'Connector operation failed. Inspect the recorded configuration and diagnostics before retrying.',
                { cause },
              );
        let logFailure = run?.loggingError;
        try {
          run?.abort(cause);
        } catch (logError) {
          logFailure = errorCode(logError);
        }
        if (logFailure)
          error = new GwsEaError(
            error.code,
            `${error.message} Diagnostic log incomplete (${logFailure}); check available disk space and permissions before retrying.`,
            { cause: error, details: { ...error.details, logFailure } },
          );
        const paused = name === 'onepassword' && onePasswordErrorPauses(error);
        actions =
          name === 'voice'
            ? voiceCapabilityRecovery(error, {
                action: handler.command === 'list' ? undefined : handler.command,
                model: options.model,
                cmake: options.cmake,
              })
            : name === 'onepassword'
              ? onePasswordRecovery(error, handler.command === 'uninstall' ? 'uninstall' : 'install')
              : name
                ? [{ kind: 'command', argv: ['gws-ea', 'connectors', 'show', name] }]
                : [];
        emitResult(
          managedResult(commandPath, {
            outcome: paused ? 'paused' : isBusy(error) ? 'busy' : 'failed',
            changed,
            data,
            error,
            next_actions: actions,
            diagnostics: { ...(run ? { run_log: run.progressLog } : {}), ...(stepLog ? { step_log: stepLog } : {}) },
          }),
        );
        if (paused) {
          presenter.report({ outcome: 'paused', headline: error.message, details: nextActionLines(actions) });
          return EXIT_CODES.paused;
        }
        return reportStop(
          presenter,
          error,
          [
            ...nextActionLines(actions),
            ...(run ? [`Log: ${run.progressLog}`] : []),
            ...(stepLog ? [`Step log: ${stepLog}`] : []),
          ],
          typeof error.details?.stderrTail === 'string' ? error.details.stderrTail : undefined,
        );
      } finally {
        stop();
      }
    }
    case 'observation': {
      const readOnly = READ_ONLY_COMMANDS.get(handler.command);
      if (!readOnly) throw new Error(`Missing observation handler for ${handler.command}`);
      const stopObservingInterruption = observeInterruption(() => ({ changed: false, data: null }));
      try {
        return await runOutsideAttempts(presenter, runtime.execve, () =>
          readOnly.run(
            {
              paths: runtime.paths ?? resolveControlPlanePaths(),
              output,
              errorOutput,
              environment,
              serviceHelpers: runtime.serviceHelpers,
              hostStatus: runtime.hostStatus,
              toolCheckout: runtime.toolCheckout,
              browserInspection: runtime.browserInspection,
              connectorInspection: {
                onePassword: onePasswordSeams(environment, runtime.onePassword),
                web: runtime.web,
              },
            },
            options,
          ),
        );
      } finally {
        stopObservingInterruption();
      }
    }
    case 'native':
      return runOutsideAttempts(presenter, runtime.execve, () =>
        prepareNcl(runtime.paths ?? resolveControlPlanePaths(), invocation, environment),
      );
    case 'discovery':
      throw new Error('Discovery must finish before runtime dispatch.');
    case 'attempt': {
      const cli = new Cli(runtime, presenter, emitResult);
      let next: () => Promise<Attempt>;
      try {
        next = cli.prepare(handler.command, invocation);
      } catch (error) {
        if (!(error instanceof GwsEaError)) throw error;
        registerErrorSecrets();
        presenter.report({ outcome: 'failed', headline: error.message, details: ['Run gws-ea --help for usage.'] });
        emitResult(managedResult(invocation.definition.path.join(' '), { outcome: 'failed', error }));
        return initialInvocationExit(error);
      }
      for (;;) {
        const attempt = await next();
        if (attempt.status === 'done') {
          if (cli.result) emitResult(cli.result);
          return attempt.exitCode;
        }
        if (!runtime.onFailure || (await runtime.onFailure(attempt.report)) !== 'retry') {
          if (cli.result) emitResult(cli.result);
          return EXIT_CODES.failed;
        }
        next = attempt.retry;
      }
    }
  }
}
