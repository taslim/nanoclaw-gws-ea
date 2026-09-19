import { createServer, type Server } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveReleaseCommit, type ResolvedRelease } from './checkout.js';
import {
  collectCreateSetup,
  CREATE_SETUP_FIELDS,
  type CreatePromptContext,
  type CreateSetupAnswers,
} from './create-input.js';
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
import { GwsEaError, type AllocatedPorts, type InstanceReservationInput } from './types.js';
import {
  installProductionBootstrapManifest,
  loadProductionBootstrapManifest,
  removeProductionBootstrapManifest,
  runProductionProvision,
  type ProductionBootstrapManifest,
  type ProvisionResult,
} from './provision.js';

type LineWriter = (line: string) => void;

export interface CliRuntime {
  paths?: ControlPlanePaths;
  stdout?: LineWriter;
  stderr?: LineWriter;
  initializeJournal?: (operation: InstanceOperation) => Promise<void>;
  advanceProvision?: (operation: InstanceOperation, selectedMessagingGroupId?: string) => Promise<ProvisionResult>;
  resolveRelease?: (sourceRemote: string, releaseRef: string) => Promise<ResolvedRelease>;
  holdLoopbackPorts?: () => Promise<HeldLoopbackPorts>;
  collectCreateInputs?: (context: CreatePromptContext) => Promise<CreateSetupAnswers>;
  reserveInstance?: typeof reserveInstance;
}

export interface HeldLoopbackPorts {
  readonly ports: AllocatedPorts;
  release(): Promise<void>;
}

const CREATE_OPTIONS = ['track', ...CREATE_SETUP_FIELDS] as const;

function parseOptions(args: readonly string[], allowed: readonly string[]): Record<string, string> {
  const options: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new GwsEaError('invalid_arguments', 'Every option must have a value');
    }
    const name = flag.slice(2);
    if (!allowed.includes(name)) throw new GwsEaError('invalid_arguments', `Unknown option --${name}`);
    if (options[name] !== undefined) throw new GwsEaError('invalid_arguments', `Option --${name} was provided twice`);
    options[name] = value;
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
  options: Readonly<Record<string, string>>,
  production: { readonly instanceId: string; readonly commit: string; readonly ports: AllocatedPorts },
): InstanceReservationInput {
  const instanceId = production.instanceId;
  const input: InstanceReservationInput = {
    instance_id: instanceId,
    checkout_realpath: paths.checkoutRoot(instanceId),
    release_track: requireOption(options, 'track'),
    source_remote: requireOption(options, 'source-remote'),
    deployed_commit: production.commit,
    allocated_ports: production.ports,
    exclusive_resource_claims: {
      endpoint_url: requireOption(options, 'endpoint'),
      gcp_project_id: requireOption(options, 'gcp-project'),
      chat_app_id: requireOption(options, 'chat-app'),
      chat_credential_id: requireOption(options, 'chat-credential-id'),
      workspace_email: requireOption(options, 'workspace-email'),
      onecli_project: `gws-ea-${instanceId.replaceAll('-', '')}`,
    },
  };
  return validateReservation(input, paths);
}

async function listenLoopback(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new GwsEaError('port_allocation_failed', 'Could not allocate a loopback port');
  }
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function holdLoopbackPorts(): Promise<HeldLoopbackPorts> {
  const servers = [createServer(), createServer(), createServer()];
  try {
    const [nanoclawWebhook, onecliApp, onecliGateway] = await Promise.all(servers.map(listenLoopback));
    return {
      ports: {
        nanoclaw_webhook: nanoclawWebhook,
        onecli_app: onecliApp,
        onecli_gateway: onecliGateway,
      },
      release: async () => void (await Promise.all(servers.map(closeServer))),
    };
  } catch (error) {
    await Promise.all(servers.map(closeServer));
    throw error;
  }
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
  output(`Continue with: gws-ea resume --id ${instanceId}`);
}

async function completeCreateOptions(
  options: Readonly<Record<string, string>>,
  instanceId: string,
  track: string,
  collectInputs: (context: CreatePromptContext) => Promise<CreateSetupAnswers>,
): Promise<Record<string, string>> {
  if (CREATE_SETUP_FIELDS.every((field) => options[field])) return { ...options };
  const collected = await collectInputs({ instanceId, track, provided: options });
  return { ...options, ...collected };
}

async function createAssistant(
  commandArgs: readonly string[],
  paths: ControlPlanePaths,
  output: LineWriter,
  errorOutput: LineWriter,
  initializeJournal: (operation: InstanceOperation) => Promise<void>,
  advanceProvision: (operation: InstanceOperation, selectedMessagingGroupId?: string) => Promise<ProvisionResult>,
  resolveRelease: (sourceRemote: string, releaseRef: string) => Promise<ResolvedRelease>,
  allocatePorts: () => Promise<HeldLoopbackPorts>,
  collectInputs: (context: CreatePromptContext) => Promise<CreateSetupAnswers>,
  persistReservation: typeof reserveInstance,
): Promise<number> {
  let track: string | undefined;
  let instanceId: string | undefined;
  let reserved = false;
  /* eslint-disable no-catch-all/no-catch-all -- The CLI boundary redacts unexpected failures while preserving recovery instructions. */
  try {
    const parsed = parseOptions(commandArgs, CREATE_OPTIONS);
    track = requireOption(parsed, 'track');
    instanceId = allocateInstanceId();
    output(`instance_id: ${instanceId}`);
    const options = await completeCreateOptions(parsed, instanceId, track, collectInputs);
    const sourceRemote = requireOption(options, 'source-remote');
    const resolved = await resolveRelease(sourceRemote, `refs/heads/${track}`);
    const bootstrapManifest: ProductionBootstrapManifest = await loadProductionBootstrapManifest(
      path.resolve(requireOption(options, 'setup-file')),
    );
    const held = await allocatePorts();
    try {
      const input = createReservation(paths, options, {
        instanceId,
        commit: resolved.commit,
        ports: held.ports,
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
    } finally {
      await held.release();
    }

    let provisionResult: ProvisionResult | undefined;
    const operation = await acquireInstanceOperation(paths, instanceId);
    if (!operation) throw new GwsEaError('instance_busy', 'Instance operation is already in progress');
    try {
      await initializeJournal(operation);
      provisionResult = await advanceProvision(operation);
    } finally {
      operation.release();
    }
    if (provisionResult.status === 'paused') {
      printPause(output, instanceId, provisionResult);
    } else {
      output(`Instance ${instanceId} is ready.`);
    }
    return 0;
  } catch (error) {
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
  advanceProvision: (operation: InstanceOperation, selectedMessagingGroupId?: string) => Promise<ProvisionResult>,
): Promise<number> {
  let instanceId: string | undefined;
  /* eslint-disable no-catch-all/no-catch-all -- The CLI boundary redacts unexpected failures while preserving recovery instructions. */
  try {
    const options = parseOptions(commandArgs, ['id', 'messaging-group-id']);
    instanceId = requireOption(options, 'id');
    assertInstanceId(instanceId);
    const operation = await acquireInstanceOperation(paths, instanceId);
    if (!operation) {
      errorOutput('Instance operation is already in progress; no action was taken.');
      return 2;
    }
    try {
      await initializeJournal(operation);
      const result = await advanceProvision(operation, options['messaging-group-id']);
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
    errorOutput(safeErrorMessage(error));
    if (instanceId) errorOutput(`Resume with: gws-ea resume --id ${instanceId}`);
    return 1;
  }
  /* eslint-enable no-catch-all/no-catch-all */
}

function printHelp(output: LineWriter): void {
  output('Usage: gws-ea <create|resume> [options]');
  output('  create --track <track>');
  output('         [--source-remote <remote> --endpoint <https-url> --gcp-project <id>]');
  output('         [--chat-app <id> --chat-credential-id <private_key_id>]');
  output('         [--workspace-email <email> --setup-file <owner-only-input.json>]');
  output('  resume --id <instance_id> [--messaging-group-id <exact-id>]');
}

export async function runCli(args: readonly string[], runtime: CliRuntime = {}): Promise<number> {
  const output = runtime.stdout ?? ((line) => process.stdout.write(`${line}\n`));
  const errorOutput = runtime.stderr ?? ((line) => process.stderr.write(`${line}\n`));
  const paths = runtime.paths ?? resolveControlPlanePaths();
  const initializeJournal =
    runtime.initializeJournal ?? (async (operation) => void (await ensureProvisionJournal(operation)));
  const advanceProvision = runtime.advanceProvision ?? runProductionProvision;
  const resolveRelease = runtime.resolveRelease ?? resolveReleaseCommit;
  const allocatePorts = runtime.holdLoopbackPorts ?? holdLoopbackPorts;
  const collectInputs = runtime.collectCreateInputs ?? collectCreateSetup;
  const persistReservation = runtime.reserveInstance ?? reserveInstance;

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printHelp(output);
    return 0;
  }
  if (args[0] === 'create') {
    return createAssistant(
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
    );
  }
  if (args[0] === 'resume') {
    return resumeAssistant(args.slice(1), paths, output, errorOutput, initializeJournal, advanceProvision);
  }
  errorOutput('Unknown command.');
  printHelp(errorOutput);
  return 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (invokedPath === import.meta.url) process.exitCode = await runCli(process.argv.slice(2));
