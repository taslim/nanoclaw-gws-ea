import { commandExitError, runSanitizedCommandOutcome } from './process.js';
import { redact } from './redact.js';
import { buildInstanceCliCommand, type InstanceRuntimeConfig } from './service.js';
import { GwsEaError } from './types.js';
import { isRecord } from './validation.js';

function parseFrame(stdout: string): Record<string, unknown> | undefined {
  try {
    const frame: unknown = JSON.parse(stdout);
    return isRecord(frame) ? frame : undefined;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

/**
 * Run `ncl <args> --json` and return the frame's data. `ncl` writes its
 * response frame and then exits 1 when the frame is not ok, so the frame is
 * read whatever the exit code and NanoClaw's own error message surfaces.
 */
export async function runInstanceNclJson(config: InstanceRuntimeConfig, args: readonly string[]): Promise<unknown> {
  const command = { ...buildInstanceCliCommand(config, [...args, '--json']), timeoutMs: 30_000 };
  const outcome = await runSanitizedCommandOutcome(command);
  const frame = parseFrame(outcome.stdout);
  if (frame?.ok === true && 'data' in frame && outcome.exitCode === 0) return frame.data;
  if (frame?.ok === false && isRecord(frame.error) && typeof frame.error.message === 'string') {
    const nclCode = typeof frame.error.code === 'string' ? frame.error.code : 'unknown';
    const nclMessage = redact(frame.error.message);
    throw new GwsEaError('ncl_failed', `ncl ${args.map(redact).join(' ')} failed: ${nclMessage}`, {
      details: { nclCode, nclMessage, exitCode: outcome.exitCode },
    });
  }
  if (outcome.exitCode !== 0) throw commandExitError(command, outcome);
  throw new GwsEaError('invalid_child_output', 'ncl returned output that is not a response frame');
}
