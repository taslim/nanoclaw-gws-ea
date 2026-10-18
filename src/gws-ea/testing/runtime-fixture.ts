/**
 * An assistant's runtime record as gws-ea persists it, for a test whose
 * commands load it from its reservation: the OneCLI layout the reservation
 * claims, this process's Node, and the directory above the test's config
 * root as its home.
 */
import path from 'node:path';

import { createOnecliRuntimeLayout } from '../onecli-compose.js';
import type { ControlPlanePaths } from '../paths.js';
import { createInstanceRuntimeConfig, persistInstanceRuntime, type InstanceRuntimeConfig } from '../service.js';
import type { InstanceReservation } from '../types.js';

export async function persistTestRuntime(
  paths: ControlPlanePaths,
  reservation: InstanceReservation,
): Promise<InstanceRuntimeConfig> {
  const onecli = createOnecliRuntimeLayout({
    instanceId: reservation.instance_id,
    instanceRoot: paths.instanceRoot(reservation.instance_id),
    project: reservation.exclusive_resource_claims.onecli_project,
    appPort: reservation.allocated_ports.onecli_app,
    gatewayPort: reservation.allocated_ports.onecli_gateway,
    dockerEndpoint: 'unix:///var/run/docker.sock',
  });
  const runtime = createInstanceRuntimeConfig(paths, reservation, onecli, {
    nodePath: process.execPath,
    homeDirectory: path.dirname(paths.configRoot),
    selectedProvider: 'claude',
    dockerEndpoint: 'unix:///var/run/docker.sock',
  });
  await persistInstanceRuntime(runtime, () => undefined);
  return runtime;
}
