import path from 'node:path';
import { processLock } from '../community-portal/process-lock.js';
import { preparePrivateDirectory, type ControlPlanePaths } from './paths.js';
import { getInstanceReservation } from './registry.js';
import { GwsEaError } from './types.js';

/** Shares lifecycle operations' instance lock; never waits or permits policy publication after teardown. */
export async function withAssistantLock<T>(
  paths: ControlPlanePaths,
  instanceId: string,
  work: () => Promise<T>,
): Promise<T> {
  await getInstanceReservation(paths, instanceId);
  await preparePrivateDirectory(path.dirname(paths.instanceLock(instanceId)));
  const release = await processLock(paths.instanceLock(instanceId));
  if (!release) throw new GwsEaError('instance_busy', 'Instance operation is already in progress');
  try {
    return await work();
  } finally {
    release();
  }
}
