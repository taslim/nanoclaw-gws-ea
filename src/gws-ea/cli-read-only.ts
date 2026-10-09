/**
 * The read-only commands `list`, `status`, and `logs`, which `cli.ts`
 * dispatches outside its attempt loop (KTD10).
 *
 * This module sits below `cli.ts` and imports nothing from it, so the command
 * vocabulary both use lives here: a command's flags, the `--id` it targets,
 * and how a command run outside the attempt loop ends.
 */
import { lstat } from 'node:fs/promises';
import path from 'node:path';

import { isErrno } from '../community-portal/errors.js';
import { inspectOperation, revertClause, type OperationInspection } from './operation.js';
import type { ControlPlanePaths } from './paths.js';
import { buildToolEnvironment, type SanitizedCommand } from './process.js';
import { assertInstanceId, getInstanceReservation } from './registry.js';
import { legacyInstanceRoot, legacyLocation } from './release-convert.js';
import type { HostStatusHelpers } from './service.js';
import { hostLogFiles, type HostLogFiles, type NanoclawServiceHelpers } from './service-control.js';
import type { InstanceReservation } from './types.js';
import { LIST_USAGE, runListCommand, runStatusCommand, STATUS_USAGE, type ReadOnlyCommandRuntime } from './status.js';
import { detectStrayInstall, strayNote, type ToolCheckout } from './stray-install.js';
import { GwsEaError } from './types.js';

type LineWriter = (line: string) => void;

/** The flags a command takes: options with a value, and switches without. */
export interface OptionSpec {
  readonly values: readonly string[];
  readonly switches: readonly string[];
}

/** Parsed flags: each option's value, and `'true'` for each switch given. */
export type CommandOptions = Readonly<Record<string, string>>;

export function requireOption(options: CommandOptions, name: string): string {
  const value = options[name];
  if (!value) throw new GwsEaError('invalid_arguments', `Missing required option --${name}`);
  return value;
}

/** `--id`: the exact assistant a command acts on. */
export function targetInstance(options: CommandOptions): string {
  const instanceId = requireOption(options, 'id');
  assertInstanceId(instanceId);
  return instanceId;
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
  /** The checkout this tool runs from, which only the launcher names; `list` and `status` note a stray install there. */
  readonly toolCheckout?: ToolCheckout;
}

/** A read-only command: its lines in `gws-ea --help`, its flags, and what it does. */
export interface ReadOnlyCommand {
  readonly usage: readonly string[];
  readonly options: OptionSpec;
  run(context: ReadOnlyContext, options: CommandOptions): Promise<CommandEnd>;
}

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

/**
 * The note `list` and `status` add on stderr when the tool checkout holds a
 * stray NanoClaw install (R6). It is checked beside the command, so it adds
 * no wait, and a check that fails adds no note.
 */
async function strayInstallNote(context: ReadOnlyContext): Promise<string | undefined> {
  if (!context.toolCheckout) return undefined;
  try {
    return strayNote(await detectStrayInstall(context.toolCheckout, context.paths));
    // eslint-disable-next-line no-catch-all/no-catch-all -- The note is an observation beside the result; like a failed status probe, it never fails the command.
  } catch {
    return undefined;
  }
}

/** Run `list` or `status`, then add the stray install note beside its result. */
async function withStrayInstallNote(context: ReadOnlyContext, command: () => Promise<number>): Promise<CommandEnd> {
  const note = strayInstallNote(context);
  const exitCode = await command();
  const text = await note;
  if (text) context.errorOutput(text);
  return { exitCode };
}

/**
 * The read-only commands, by name. `runCli` dispatches them without the
 * attempt loop, parsing each one's flags from its `options`, and `--help`
 * prints each one's `usage` in this order.
 */
export const READ_ONLY_COMMANDS: ReadonlyMap<string, ReadOnlyCommand> = new Map([
  [
    'list',
    {
      usage: LIST_USAGE,
      options: { values: [], switches: ['json'] },
      run: (context, options) =>
        withStrayInstallNote(context, () =>
          runListCommand(observationRuntime(context), { json: options.json === 'true' }),
        ),
    },
  ],
  [
    'status',
    {
      usage: STATUS_USAGE,
      options: { values: ['id'], switches: ['json'] },
      run: (context, options) => {
        const instanceId = targetInstance(options);
        return withStrayInstallNote(context, () =>
          runStatusCommand(observationRuntime(context), { instanceId, json: options.json === 'true' }),
        );
      },
    },
  ],
  [
    'logs',
    {
      usage: [
        'logs --id <instance_id> [--errors] [--follow]',
        "       Prints the assistant's host log, or its error log with --errors; --follow keeps printing.",
      ],
      options: { values: ['id'], switches: ['errors', 'follow'] },
      run: showHostLog,
    },
  ],
]);

/** What `logs` notes about an unfinished update or rollback (KTD2), which never stops it. */
function operationNote(inspection: OperationInspection): string | undefined {
  switch (inspection.state) {
    case 'none':
    case 'committed':
      return undefined;
    case 'open': {
      const { record, next } = inspection;
      const subject = record.kind === 'update' ? 'An update' : 'A rollback';
      return `${subject} of this assistant is unfinished (${record.phase}); continue it with ${next.continueWith}${revertClause(next)}.`;
    }
    case 'failed': {
      const { record, next } = inspection;
      const subject = record.kind === 'update' ? 'An update' : 'A rollback';
      return `${subject} of this assistant failed and left no release to return to (${record.phase}); fix it forward with ${next.continueWith} to a newer release.`;
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
 * Where the assistant's host writes its logs: the instance root's physical
 * `logs/`, there whether or not a release is live; or, on the layout before
 * releases until its conversion moves them, its legacy checkout's `logs/`,
 * which held them as an instance root's holds them now (KTD11).
 */
async function hostLogs(paths: ControlPlanePaths, reservation: InstanceReservation): Promise<HostLogFiles> {
  const id = reservation.instance_id;
  if (legacyInstanceRoot(paths, reservation) === undefined) return hostLogFiles(paths.instanceRoot(id));
  const moved = await lstat(paths.instanceLayout(id).logs).then(
    () => true,
    (error: unknown) => {
      if (isErrno(error, 'ENOENT')) return false;
      throw error;
    },
  );
  return hostLogFiles(moved ? paths.instanceRoot(id) : legacyLocation(paths, id).checkout);
}

/**
 * `logs`: the assistant's host log, or its error log with `--errors`, at the
 * paths its service definition sends them to, read physically, in any phase.
 * The process is handed to `cat`, or to `tail -f` with `--follow`, so the
 * log streams as the file holds it. An unfinished update or rollback is
 * named first, on stderr.
 */
async function showHostLog(context: ReadOnlyContext, options: CommandOptions): Promise<CommandEnd> {
  const instanceId = targetInstance(options);
  const reservation = await getInstanceReservation(context.paths, instanceId);
  const note = operationNote(await inspectOperation(context.paths, reservation));
  if (note) context.errorOutput(note);
  const logs = await hostLogs(context.paths, reservation);
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
