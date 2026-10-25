/**
 * The read-only commands, which `cli.ts` dispatches outside its attempt loop.
 * This module sits below `cli.ts` and imports nothing from it; their grammar
 * lives in `command-definitions.ts`.
 */
import { lstat } from 'node:fs/promises';
import path from 'node:path';

import { isErrno } from '../community-portal/errors.js';
import { failedOutcome, inspectOperation, revertClause, type OperationInspection } from './operation.js';
import type { ControlPlanePaths } from './paths.js';
import { buildToolEnvironment, type SanitizedCommand } from './process.js';
import { assertInstanceId, getInstanceReservation } from './registry.js';
import type { HostStatusHelpers } from './service.js';
import { hostLogFiles, type NanoclawServiceHelpers } from './service-control.js';
import { runListCommand, runStatusCommand, type ReadOnlyCommandRuntime } from './status.js';
import type { CommandOptions } from './command-parser.js';
import { detectStrayInstall, strayNote, type ToolCheckout } from './stray-install.js';
import { GwsEaError } from './types.js';

type LineWriter = (line: string) => void;

export function requireOption(options: CommandOptions, name: string): string {
  const value = options[name];
  if (!value) throw new GwsEaError('invalid_arguments', `Missing required option --${name}`);
  return value;
}

export function targetInstance(options: CommandOptions): string {
  const instanceId = requireOption(options, 'id');
  assertInstanceId(instanceId);
  return instanceId;
}

/** `replaceWith` hands the process over to a tool instead of exiting. */
export type CommandEnd = { readonly exitCode: number } | { readonly replaceWith: SanitizedCommand };

/**
 * A read-only command loads no secrets, starts no run log, takes no lock, and
 * repairs nothing, so it works in any state, mid-update and mid-removal
 * included.
 */
export interface ReadOnlyContext {
  readonly paths: ControlPlanePaths;
  /** The command's result; scripts read it. */
  readonly output: LineWriter;
  /** Notes beside the result, such as an unfinished update, so the result stays alone on stdout. */
  readonly errorOutput: LineWriter;
  /** For the tools a command hands its process to: only the tool allowlist is read from it, never a secret. */
  readonly environment: NodeJS.ProcessEnv;
  /** For observing an assistant's service, never controlling it. */
  readonly serviceHelpers?: NanoclawServiceHelpers;
  readonly hostStatus?: HostStatusHelpers;
  /** Named only by the launcher; `list` and `status` note a stray install there. */
  readonly toolCheckout?: ToolCheckout;
}

export interface ReadOnlyCommand {
  run(context: ReadOnlyContext, options: CommandOptions): Promise<CommandEnd>;
}

function observationRuntime(context: ReadOnlyContext): ReadOnlyCommandRuntime {
  return {
    paths: context.paths,
    stdout: context.output,
    stderr: context.errorOutput,
    serviceHelpers: context.serviceHelpers,
    hostStatus: context.hostStatus,
  };
}

/** Checked alongside the command, so it adds no wait; a check that fails adds no note. */
async function strayInstallNote(context: ReadOnlyContext): Promise<string | undefined> {
  if (!context.toolCheckout) return undefined;
  try {
    return strayNote(await detectStrayInstall(context.toolCheckout, context.paths));
    // eslint-disable-next-line no-catch-all/no-catch-all -- The note is an observation beside the result; like a failed status probe, it never fails the command.
  } catch {
    return undefined;
  }
}

async function withStrayInstallNote(context: ReadOnlyContext, command: () => Promise<number>): Promise<CommandEnd> {
  const note = strayInstallNote(context);
  const exitCode = await command();
  const text = await note;
  if (text) context.errorOutput(text);
  return { exitCode };
}

/** Keyed by each observation handler's `command` in `command-definitions.ts`. */
export const READ_ONLY_COMMANDS: ReadonlyMap<string, ReadOnlyCommand> = new Map([
  [
    'list',
    {
      run: (context, options) =>
        withStrayInstallNote(context, () =>
          runListCommand(observationRuntime(context), { json: options.json === 'true' }),
        ),
    },
  ],
  [
    'status',
    {
      run: (context, options) => {
        const instanceId = targetInstance(options);
        return withStrayInstallNote(context, () =>
          runStatusCommand(observationRuntime(context), {
            instanceId,
            json: options.json === 'true',
            details: options.details === 'true',
          }),
        );
      },
    },
  ],
  [
    'logs',
    {
      run: showHostLog,
    },
  ],
]);

/** A note only: an unfinished update or rollback never stops `logs`. */
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
      return `${subject} of this assistant failed${failedOutcome(record)} (${record.phase}); fix it forward with ${next.continueWith} to a newer release.`;
    }
    case 'unreadable':
      return `This assistant's update or rollback record cannot be read: ${inspection.message}`;
  }
}

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

/** Hands the process to `cat` or `tail -f`, so the log streams exactly as the file holds it. */
async function showHostLog(context: ReadOnlyContext, options: CommandOptions): Promise<CommandEnd> {
  const instanceId = targetInstance(options);
  const reservation = await getInstanceReservation(context.paths, instanceId);
  const note = operationNote(await inspectOperation(context.paths, reservation));
  if (note) context.errorOutput(note);
  const logs = hostLogFiles(context.paths.instanceRoot(instanceId));
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
