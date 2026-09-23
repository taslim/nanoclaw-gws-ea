import * as prompts from '@clack/prompts';
import { resolveReleaseCommit, type ResolvedRelease } from './checkout.js';
import { CREATE_SETUP_FIELDS, type CreatePromptContext, type CreateSetupAnswers } from './create-input.js';
import type { RetainedManagedIngressSetupSession } from './cloudflare-api.js';
import {
  acquireInstanceOperation,
  ensureProvisionJournal,
  firstIncompletePhase,
  type InstanceOperation,
} from './journal.js';
import { resolveControlPlanePaths, type ControlPlanePaths } from './paths.js';
import {
  allocateInstanceId,
  assertInstanceId,
  getInstanceReservation,
  reserveInstance,
  validateReservation,
} from './registry.js';
import { GwsEaError, type AllocatedPorts, type InstanceReservationInput, type ProvisionPhase } from './types.js';
import { deriveGchatServiceAccountEmail, deriveGcpProjectId, preflightGcloud } from './gcloud.js';
import { confirmChatConfiguration } from './chat-configuration.js';
import { describeRemoval, removeAssistant, type RemovalPreview } from './remove.js';
import {
  installProductionBootstrapManifest,
  removeProductionBootstrapManifest,
  runProductionProvision,
  validateProductionBootstrapManifest,
  type ProductionBootstrapManifest,
  type ProvisionProgressEvent,
  type ProvisionResult,
  type ProvisionRuntime,
} from './provision.js';
import { holdLoopbackPorts, type HeldLoopbackPorts } from './ports.js';
import type { ProviderCredential } from '../provider-credential.js';

type LineWriter = (line: string) => void;
type TextWriter = (text: string) => void;
type RemoveAssistantRunner = (paths: ControlPlanePaths, instanceId: string) => Promise<void>;
type AdvanceProvision = (
  operation: InstanceOperation,
  selectedMessagingGroupId?: string,
  heldPorts?: HeldLoopbackPorts,
  runtime?: ProvisionRuntime,
) => Promise<ProvisionResult>;

interface ProvisionProgressDisplay {
  show(message: string): void;
  clear(): void;
}

export interface CliRuntime {
  paths?: ControlPlanePaths;
  stdout?: LineWriter;
  stderr?: LineWriter;
  initializeJournal?: (operation: InstanceOperation) => Promise<void>;
  advanceProvision?: AdvanceProvision;
  resolveRelease?: (sourceRemote: string, releaseRef: string) => Promise<ResolvedRelease>;
  holdLoopbackPorts?: () => Promise<HeldLoopbackPorts>;
  collectCreateInputs?: (context: CreatePromptContext) => Promise<CreateSetupAnswers>;
  authenticateProvider?: (provider: string) => Promise<ProviderCredential>;
  reserveInstance?: typeof reserveInstance;
  preflightGcloud?: (account?: string) => Promise<{ readonly account: string }>;
  confirmChatConfiguration?: typeof confirmChatConfiguration;
  describeRemoval?: typeof describeRemoval;
  removeAssistant?: RemoveAssistantRunner;
  confirmRemoval?: (preview: RemovalPreview) => Promise<boolean>;
  managedIngressSetup?: RetainedManagedIngressSetupSession;
  requestCloudflareAccountToken?: (
    accountId: string,
    observation: string,
    onPromptComplete?: () => void,
  ) => Promise<string>;
}

const CREATE_OPTIONS = ['track', ...CREATE_SETUP_FIELDS] as const;

const PHASE_PROGRESS: Readonly<Record<ProvisionPhase, string>> = {
  materialize_checkout: 'Preparing assistant files…',
  provision_gcp: 'Configuring Google Cloud…',
  start_onecli: 'Starting the credential vault…',
  configure_provider: 'Connecting the AI provider…',
  start_nanoclaw: 'Starting the assistant…',
  establish_transport: 'Publishing the secure callback…',
  configure_channel: 'Checking Google Chat configuration…',
  bind_principal: 'Connecting the principal conversation…',
  verify_conversation: 'Verifying the conversation…',
  ready: 'Finishing setup…',
};

const GCP_PROGRESS: Readonly<Record<NonNullable<ProvisionProgressEvent['detail']>, string>> = {
  project: 'Waiting for the Google Cloud project…',
  apis: 'Waiting for the Google Chat APIs…',
  'service-account': 'Waiting for the Google Chat service account…',
  'credential-policy': 'Updating the dedicated project’s Google Chat credential policy…',
  'service-account-keys': 'Waiting for Google Cloud IAM…',
  'credential-key': 'Waiting for the Google Chat credential…',
};

function progressMessage(event: ProvisionProgressEvent): string {
  return event.detail ? GCP_PROGRESS[event.detail] : PHASE_PROGRESS[event.phase];
}

export function createProgressDisplay(
  output: LineWriter,
  interactive: boolean,
  terminalOutput: TextWriter = (text) => {
    process.stdout.write(text);
  },
): ProvisionProgressDisplay {
  let active = false;
  let lastMessage: string | undefined;
  return {
    show(message) {
      if (message === lastMessage) return;
      lastMessage = message;
      if (!interactive) {
        output(message);
        return;
      }
      terminalOutput(`\r\u001B[2K${message}`);
      active = true;
    },
    clear() {
      if (!interactive) return;
      if (active) terminalOutput('\r\u001B[2K');
      active = false;
      lastMessage = undefined;
    },
  };
}

function parseOptions(
  args: readonly string[],
  allowed: readonly string[],
  booleanOptions: readonly string[] = [],
): Record<string, string> {
  const options: Record<string, string> = {};
  for (let index = 0; index < args.length; ) {
    const flag = args[index];
    if (!flag?.startsWith('--')) throw new GwsEaError('invalid_arguments', 'Expected an option flag');
    const name = flag.slice(2);
    if (!allowed.includes(name) && !booleanOptions.includes(name)) {
      throw new GwsEaError('invalid_arguments', `Unknown option --${name}`);
    }
    if (options[name] !== undefined) throw new GwsEaError('invalid_arguments', `Option --${name} was provided twice`);
    if (booleanOptions.includes(name)) {
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

function requireOption(options: Readonly<Record<string, string>>, name: string): string {
  const value = options[name];
  if (!value) throw new GwsEaError('invalid_arguments', `Missing required option --${name}`);
  return value;
}

function createReservation(
  paths: ControlPlanePaths,
  track: string,
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
    source_remote: setup.sourceRemote,
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

function safeErrorMessage(error: unknown): string {
  return error instanceof GwsEaError ? error.message : 'Unexpected control-plane failure.';
}

function createRetryCommand(track: string | undefined): string {
  const safeTrack = track && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(track) ? track : '<track>';
  return `gws-ea create --track ${safeTrack}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function printPause(
  output: LineWriter,
  instanceId: string,
  result: Extract<ProvisionResult, { status: 'paused' }>,
): void {
  output(`Provisioning paused: ${result.pause.message}`);
  if (result.pause.choices?.length) {
    output('Eligible principal conversations:');
    for (const choice of result.pause.choices) {
      output(
        `  ${JSON.stringify(choice.label)}: gws-ea resume --id ${instanceId} --messaging-group-id ${shellQuote(choice.id)}`,
      );
    }
    return;
  }
  for (const detail of result.pause.details ?? []) output(`  ${detail}`);
  if (result.pause.actionUrl) output(`Open: ${result.pause.actionUrl}`);
  output(
    `Continue with: gws-ea resume --id ${instanceId}${result.pause.resumeFlag ? ` ${result.pause.resumeFlag}` : ''}`,
  );
}

async function createAssistant(
  commandArgs: readonly string[],
  paths: ControlPlanePaths,
  output: LineWriter,
  errorOutput: LineWriter,
  initializeJournal: (operation: InstanceOperation) => Promise<void>,
  advanceProvision: AdvanceProvision,
  resolveRelease: (sourceRemote: string, releaseRef: string) => Promise<ResolvedRelease>,
  allocatePorts: () => Promise<HeldLoopbackPorts>,
  collectInputs: (context: CreatePromptContext) => Promise<CreateSetupAnswers>,
  persistReservation: typeof reserveInstance,
  checkGcloud: () => Promise<{ readonly account: string }>,
  progress: ProvisionProgressDisplay,
  managedIngressSetup?: RetainedManagedIngressSetupSession,
): Promise<number> {
  let track: string | undefined;
  let instanceId: string | undefined;
  let reserved = false;
  /* eslint-disable no-catch-all/no-catch-all -- The CLI boundary redacts unexpected failures while preserving recovery instructions. */
  try {
    const parsed = parseOptions(commandArgs, CREATE_OPTIONS);
    track = requireOption(parsed, 'track');
    const gcloud = await checkGcloud();
    instanceId = allocateInstanceId();
    output(`instance_id: ${instanceId}`);
    const setup = await collectInputs({ instanceId, track, provided: parsed, managedIngressSetup });
    progress.show('Preparing assistant…');
    const resolved = await resolveRelease(setup.sourceRemote, `refs/heads/${track}`);
    const bootstrapManifest: ProductionBootstrapManifest = validateProductionBootstrapManifest(setup.bootstrapManifest);
    const held = await allocatePorts();
    try {
      const input = createReservation(paths, track, setup, {
        instanceId,
        commit: resolved.commit,
        ports: held.ports,
        gcpAccount: gcloud.account,
      });
      await installProductionBootstrapManifest(paths, instanceId, bootstrapManifest);
      try {
        await persistReservation(paths, input);
        reserved = true;
      } catch (error) {
        try {
          await getInstanceReservation(paths, instanceId);
          reserved = true;
        } catch (observationError) {
          if (observationError instanceof GwsEaError && observationError.code === 'unknown_instance') {
            await removeProductionBootstrapManifest(paths, instanceId);
          } else {
            reserved = true;
          }
        }
        throw error;
      }
    } catch (error) {
      await held.release();
      throw error;
    }

    let provisionResult: ProvisionResult | undefined;
    let operation: InstanceOperation | null;
    try {
      operation = await acquireInstanceOperation(paths, instanceId);
    } catch (error) {
      await held.release();
      throw error;
    }
    if (!operation) {
      await held.release();
      throw new GwsEaError('instance_busy', 'Instance operation is already in progress');
    }
    try {
      await initializeJournal(operation);
      provisionResult = await advanceProvision(operation, undefined, held, {
        onProgress: (event) => progress.show(progressMessage(event)),
      });
    } finally {
      await held.release();
      operation.release();
    }
    progress.clear();
    if (provisionResult.status === 'paused') {
      printPause(output, instanceId, provisionResult);
    } else {
      output(`Instance ${instanceId} is ready.`);
    }
    return 0;
  } catch (error) {
    progress.clear();
    errorOutput(safeErrorMessage(error));
    if (reserved && instanceId) {
      errorOutput(`Resume with: gws-ea resume --id ${instanceId}`);
    } else {
      errorOutput(`Retry with: ${createRetryCommand(track)}`);
    }
    return 1;
  }
  /* eslint-enable no-catch-all/no-catch-all */
}

async function resumeAssistant(
  commandArgs: readonly string[],
  paths: ControlPlanePaths,
  output: LineWriter,
  errorOutput: LineWriter,
  initializeJournal: (operation: InstanceOperation) => Promise<void>,
  advanceProvision: AdvanceProvision,
  confirmConfigured: typeof confirmChatConfiguration,
  checkGcloud: (account?: string) => Promise<{ readonly account: string }>,
  progress: ProvisionProgressDisplay,
): Promise<number> {
  let instanceId: string | undefined;
  /* eslint-disable no-catch-all/no-catch-all -- The CLI boundary redacts unexpected failures while preserving recovery instructions. */
  try {
    const options = parseOptions(commandArgs, ['id', 'messaging-group-id'], ['chat-configured']);
    instanceId = requireOption(options, 'id');
    assertInstanceId(instanceId);
    const operation = await acquireInstanceOperation(paths, instanceId);
    if (!operation) {
      errorOutput('Instance operation is already in progress; no action was taken.');
      return 2;
    }
    try {
      progress.show('Resuming assistant…');
      if (options['chat-configured']) await confirmConfigured(paths, instanceId);
      await initializeJournal(operation);
      const reservation = await getInstanceReservation(paths, instanceId);
      const account = reservation.exclusive_resource_claims.gcp_account;
      progress.clear();
      const ready = await checkGcloud(account);
      if (ready.account !== account) {
        throw new GwsEaError('gcloud_account_mismatch', 'Google Cloud is signed in with the wrong account');
      }
      progress.show('Resuming assistant…');
      const result = await advanceProvision(operation, options['messaging-group-id'], undefined, {
        onProgress: (event) => progress.show(progressMessage(event)),
      });
      progress.clear();
      if (result.status === 'paused') {
        printPause(output, instanceId, result);
        return 0;
      }
      const journal = await ensureProvisionJournal(operation);
      const phase = firstIncompletePhase(journal);
      output(phase ? `Resuming instance ${instanceId} at phase ${phase}.` : `Instance ${instanceId} is ready.`);
      return 0;
    } finally {
      operation.release();
    }
  } catch (error) {
    progress.clear();
    errorOutput(safeErrorMessage(error));
    if (instanceId) errorOutput(`Resume with: gws-ea resume --id ${instanceId}`);
    return 1;
  }
  /* eslint-enable no-catch-all/no-catch-all */
}

async function defaultConfirmRemoval(preview: RemovalPreview): Promise<boolean> {
  const answer = await prompts.confirm({
    message: `Permanently remove assistant ${preview.instanceId} and request deletion of GCP project ${preview.gcpProject}?`,
    initialValue: false,
  });
  return answer === true;
}

async function removeAssistantCommand(
  commandArgs: readonly string[],
  paths: ControlPlanePaths,
  output: LineWriter,
  errorOutput: LineWriter,
  inspect: typeof describeRemoval,
  remove: RemoveAssistantRunner,
  confirm: (preview: RemovalPreview) => Promise<boolean>,
): Promise<number> {
  let instanceId: string | undefined;
  /* eslint-disable no-catch-all/no-catch-all -- The CLI boundary redacts unexpected failures. */
  try {
    const options = parseOptions(commandArgs, ['id'], ['yes']);
    instanceId = requireOption(options, 'id');
    assertInstanceId(instanceId);
    const preview = await inspect(paths, instanceId);
    output(`Assistant: ${preview.instanceId}`);
    output(`NanoClaw: ${preview.checkout}`);
    output(`OneCLI: ${preview.onecliProject}`);
    output(`Google Cloud project: ${preview.gcpProject} (${preview.gcpAccount})`);
    if (preview.ingress.mode === 'existing') {
      output(`External endpoint: ${preview.ingress.endpoint} (operator-managed; disconnect separately)`);
    } else {
      output(`Managed hostname: ${preview.ingress.hostname}`);
      output(`Managed callback: ${preview.ingress.callback}`);
      output(`Owned DNS record: ${preview.ingress.dnsRecordId ?? 'not created'}`);
      output(`Owned tunnel route: ${preview.ingress.route}`);
      output(
        preview.ingress.sharedIngress === 'retained-for-peers'
          ? 'Shared Cloudflare ingress: retained for other assistants'
          : 'Shared Cloudflare ingress: retired after this final managed callback',
      );
    }
    if (!options.yes && !(await confirm(preview))) {
      output('Removal cancelled. Nothing was changed.');
      return 0;
    }
    await remove(paths, instanceId);
    output(`Assistant ${instanceId} was removed. Google Cloud project deletion was requested.`);
    return 0;
  } catch (error) {
    errorOutput(safeErrorMessage(error));
    if (instanceId) errorOutput(`Retry with: gws-ea remove --id ${instanceId}`);
    return 1;
  }
  /* eslint-enable no-catch-all/no-catch-all */
}

function printHelp(output: LineWriter): void {
  output('Usage: gws-ea <create|resume|remove> [options]');
  output('  create --track <track>');
  output('         [--source-remote <remote> --endpoint <https-url>]');
  output('         [--workspace-email <email>]');
  output('  resume --id <instance_id> [--chat-configured] [--messaging-group-id <exact-id>]');
  output('  remove --id <instance_id> [--yes]');
}

export async function runCli(args: readonly string[], runtime: CliRuntime = {}): Promise<number> {
  const output = runtime.stdout ?? ((line) => process.stdout.write(`${line}\n`));
  const errorOutput = runtime.stderr ?? ((line) => process.stderr.write(`${line}\n`));
  const progress = createProgressDisplay(output, runtime.stdout === undefined && process.stdout.isTTY === true);
  const configuredAuthenticateProvider = runtime.authenticateProvider;
  const authenticateProvider = configuredAuthenticateProvider
    ? async (provider: string): Promise<ProviderCredential> => {
        progress.clear();
        const credential = await configuredAuthenticateProvider(provider);
        progress.show(PHASE_PROGRESS.configure_provider);
        return credential;
      }
    : undefined;
  const configuredRequestCloudflareAccountToken = runtime.requestCloudflareAccountToken;
  const requestCloudflareAccountToken = configuredRequestCloudflareAccountToken
    ? async (accountId: string, observation: string): Promise<string> => {
        progress.clear();
        const token = await configuredRequestCloudflareAccountToken(accountId, observation, () =>
          progress.show(PHASE_PROGRESS.establish_transport),
        );
        progress.show(PHASE_PROGRESS.establish_transport);
        return token;
      }
    : undefined;
  const paths = runtime.paths ?? resolveControlPlanePaths();
  const initializeJournal =
    runtime.initializeJournal ?? (async (operation) => void (await ensureProvisionJournal(operation)));
  const advanceProvision =
    runtime.advanceProvision ??
    ((operation, selectedMessagingGroupId, heldPorts, provisionRuntime) =>
      runProductionProvision(operation, {
        selectedMessagingGroupId,
        portLease: heldPorts,
        authenticateProvider,
        managedIngress: {
          ...(runtime.managedIngressSetup ? { setupSession: runtime.managedIngressSetup } : {}),
          ...(requestCloudflareAccountToken ? { requestAccountToken: requestCloudflareAccountToken } : {}),
        },
        runtime: provisionRuntime,
      }));
  const resolveRelease = runtime.resolveRelease ?? resolveReleaseCommit;
  const allocatePorts = runtime.holdLoopbackPorts ?? holdLoopbackPorts;
  const collectInputs =
    runtime.collectCreateInputs ??
    (async (): Promise<CreateSetupAnswers> => {
      throw new GwsEaError('interactive_setup_unavailable', 'Run this command through the gws-ea launcher');
    });
  const persistReservation = runtime.reserveInstance ?? reserveInstance;
  const checkGcloud =
    runtime.preflightGcloud ??
    ((account?: string) => preflightGcloud({ cwd: process.cwd(), ...(account ? { account } : {}) }));
  const confirmConfigured = runtime.confirmChatConfiguration ?? confirmChatConfiguration;
  const inspectRemoval = runtime.describeRemoval ?? describeRemoval;
  const remove: RemoveAssistantRunner =
    runtime.removeAssistant ??
    ((targetPaths, instanceId) =>
      removeAssistant(targetPaths, instanceId, {
        ...(runtime.requestCloudflareAccountToken
          ? { requestCloudflareAccountToken: runtime.requestCloudflareAccountToken }
          : {}),
      }));
  const confirm = runtime.confirmRemoval ?? defaultConfirmRemoval;

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printHelp(output);
    return 0;
  }
  if (args[0] === 'create') {
    try {
      return await createAssistant(
        args.slice(1),
        paths,
        output,
        errorOutput,
        initializeJournal,
        advanceProvision,
        resolveRelease,
        allocatePorts,
        collectInputs,
        persistReservation,
        checkGcloud,
        progress,
        runtime.managedIngressSetup,
      );
    } finally {
      runtime.managedIngressSetup?.clearAccountToken();
    }
  }
  if (args[0] === 'resume') {
    try {
      return await resumeAssistant(
        args.slice(1),
        paths,
        output,
        errorOutput,
        initializeJournal,
        advanceProvision,
        confirmConfigured,
        checkGcloud,
        progress,
      );
    } finally {
      runtime.managedIngressSetup?.clearAccountToken();
    }
  }
  if (args[0] === 'remove') {
    try {
      return await removeAssistantCommand(args.slice(1), paths, output, errorOutput, inspectRemoval, remove, confirm);
    } finally {
      runtime.managedIngressSetup?.clearAccountToken();
    }
  }
  errorOutput('Unknown command.');
  printHelp(errorOutput);
  return 1;
}
