import { runSanitizedCommand } from './process.js';
import { buildInstanceCliCommand, type InstanceRuntimeConfig } from './service.js';
import { GwsEaError } from './types.js';
import { isRecord } from './validation.js';

export async function runInstanceNclJson(config: InstanceRuntimeConfig, args: readonly string[]): Promise<unknown> {
  const command = buildInstanceCliCommand(config, [...args, '--json']);
  const result = await runSanitizedCommand({ ...command, timeoutMs: 30_000 });
  let frame: unknown;
  try {
    frame = JSON.parse(result.stdout) as unknown;
  } catch {
    throw new GwsEaError('invalid_child_output', 'ncl returned invalid JSON');
  }
  if (!isRecord(frame) || frame.ok !== true || !('data' in frame)) {
    throw new GwsEaError('ncl_failed', 'The selected NanoClaw command did not succeed');
  }
  return frame.data;
}
