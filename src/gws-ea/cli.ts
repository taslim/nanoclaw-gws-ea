import { pathToFileURL } from 'node:url';
import {
  acquireInstanceOperation,
  ensureProvisionJournal,
  firstIncompletePhase,
  type InstanceOperation,
} from './journal.js';
import { resolveControlPlanePaths, type ControlPlanePaths } from './paths.js';
import { allocateInstanceId, assertInstanceId, reserveInstance, validateReservation } from './registry.js';
import { GwsEaError, type InstanceReservationInput } from './types.js';

type LineWriter = (line: string) => void;

export interface CliRuntime {
  paths?: ControlPlanePaths;
  stdout?: LineWriter;
  stderr?: LineWriter;
  initializeJournal?: (operation: InstanceOperation) => Promise<void>;
}

const CREATE_OPTIONS = [
  'track',
  'source-remote',
  'deployed-commit',
  'webhook-port',
  'onecli-app-port',
  'onecli-gateway-port',
  'endpoint',
  'gcp-project',
  'chat-app',
  'chat-credential-id',
  'workspace-email',
] as const;

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

function parsePort(options: Readonly<Record<string, string>>, name: string): number {
  const raw = requireOption(options, name);
  if (!/^\d{1,5}$/.test(raw)) throw new GwsEaError('invalid_arguments', `Option --${name} must be a valid port`);
  return Number(raw);
}

function createReservation(
  paths: ControlPlanePaths,
  options: Readonly<Record<string, string>>,
): InstanceReservationInput {
  const instanceId = allocateInstanceId();
  const input: InstanceReservationInput = {
    instance_id: instanceId,
    checkout_realpath: paths.checkoutRoot(instanceId),
    release_track: requireOption(options, 'track'),
    source_remote: requireOption(options, 'source-remote'),
    deployed_commit: requireOption(options, 'deployed-commit'),
    allocated_ports: {
      nanoclaw_webhook: parsePort(options, 'webhook-port'),
      onecli_app: parsePort(options, 'onecli-app-port'),
      onecli_gateway: parsePort(options, 'onecli-gateway-port'),
    },
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

function safeErrorMessage(error: unknown): string {
  return error instanceof GwsEaError ? error.message : 'Unexpected control-plane failure.';
}

function createRetryCommand(track: string | undefined): string {
  const safeTrack = track && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(track) ? track : '<track>';
  return `gws-ea assistants create --track ${safeTrack}`;
}

async function createAssistant(
  commandArgs: readonly string[],
  paths: ControlPlanePaths,
  output: LineWriter,
  errorOutput: LineWriter,
  initializeJournal: (operation: InstanceOperation) => Promise<void>,
): Promise<number> {
  let track: string | undefined;
  let instanceId: string | undefined;
  let reserved = false;
  /* eslint-disable no-catch-all/no-catch-all -- The CLI boundary redacts unexpected failures while preserving recovery instructions. */
  try {
    const options = parseOptions(commandArgs, CREATE_OPTIONS);
    track = options.track;
    const input = createReservation(paths, options);
    instanceId = input.instance_id;
    output(`instance_id: ${instanceId}`);
    await reserveInstance(paths, input);
    reserved = true;

    const operation = await acquireInstanceOperation(paths, instanceId);
    if (!operation) throw new GwsEaError('instance_busy', 'Instance operation is already in progress');
    try {
      await initializeJournal(operation);
    } finally {
      operation.release();
    }
    output(`Reserved instance ${instanceId}.`);
    output(`Continue with: gws-ea assistants resume --id ${instanceId}`);
    return 0;
  } catch (error) {
    errorOutput(safeErrorMessage(error));
    if (reserved && instanceId) {
      errorOutput(`Resume with: gws-ea assistants resume --id ${instanceId}`);
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
): Promise<number> {
  let instanceId: string | undefined;
  /* eslint-disable no-catch-all/no-catch-all -- The CLI boundary redacts unexpected failures while preserving recovery instructions. */
  try {
    const options = parseOptions(commandArgs, ['id']);
    instanceId = requireOption(options, 'id');
    assertInstanceId(instanceId);
    const operation = await acquireInstanceOperation(paths, instanceId);
    if (!operation) {
      errorOutput('Instance operation is already in progress; no action was taken.');
      return 2;
    }
    try {
      await initializeJournal(operation);
      const journal = await ensureProvisionJournal(operation);
      const phase = firstIncompletePhase(journal);
      output(phase ? `Resuming instance ${instanceId} at phase ${phase}.` : `Instance ${instanceId} is ready.`);
      return 0;
    } finally {
      operation.release();
    }
  } catch (error) {
    errorOutput(safeErrorMessage(error));
    if (instanceId) errorOutput(`Resume with: gws-ea assistants resume --id ${instanceId}`);
    return 1;
  }
  /* eslint-enable no-catch-all/no-catch-all */
}

function printHelp(output: LineWriter): void {
  output('Usage: gws-ea assistants <create|resume> [options]');
  output('  create --track <track> --source-remote <remote> --deployed-commit <sha>');
  output('         --webhook-port <port> --onecli-app-port <port> --onecli-gateway-port <port>');
  output('         --endpoint <https-url> --gcp-project <id> --chat-app <id>');
  output('         --chat-credential-id <id> --workspace-email <email>');
  output('  resume --id <instance_id>');
}

export async function runCli(args: readonly string[], runtime: CliRuntime = {}): Promise<number> {
  const output = runtime.stdout ?? ((line) => process.stdout.write(`${line}\n`));
  const errorOutput = runtime.stderr ?? ((line) => process.stderr.write(`${line}\n`));
  const paths = runtime.paths ?? resolveControlPlanePaths();
  const initializeJournal =
    runtime.initializeJournal ?? (async (operation) => void (await ensureProvisionJournal(operation)));

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printHelp(output);
    return 0;
  }
  if (args[0] !== 'assistants') {
    errorOutput('Unknown command.');
    printHelp(errorOutput);
    return 1;
  }
  if (args[1] === 'create') return createAssistant(args.slice(2), paths, output, errorOutput, initializeJournal);
  if (args[1] === 'resume') return resumeAssistant(args.slice(2), paths, output, errorOutput, initializeJournal);
  errorOutput('Unknown assistants command.');
  printHelp(errorOutput);
  return 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (invokedPath === import.meta.url) process.exitCode = await runCli(process.argv.slice(2));
