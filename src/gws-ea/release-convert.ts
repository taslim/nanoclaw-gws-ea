/**
 * The one-time move of an assistant from the layout before releases, where it
 * lived at `<state root>/instances/<id>/` with one checkout holding its state,
 * to its short root (KTD11, KTD13). Temporary: it is deleted, with every
 * caller of the locator, once each assistant is converted.
 *
 * A registry entry is unconverted exactly while it still carries the
 * `checkout_realpath` the layout before releases recorded; nothing writes that
 * field any more, and the conversion's registry rewrite drops it.
 */
import path from 'node:path';

import { isRegularFile, type ControlPlanePaths } from './paths.js';
import { GwsEaError, type InstanceReservation } from './types.js';

/** Where an unconverted assistant still lives, or undefined once it is converted. */
export function legacyInstanceRoot(
  paths: Pick<ControlPlanePaths, 'stateRoot'>,
  reservation: InstanceReservation,
): string | undefined {
  if (reservation.checkout_realpath === undefined) return undefined;
  return path.join(paths.stateRoot, 'instances', reservation.instance_id);
}

/** Refuse an unconverted assistant: only `update` converts it, and only `list`, `status`, `logs`, and `remove` read it. */
export function assertConverted(paths: Pick<ControlPlanePaths, 'stateRoot'>, reservation: InstanceReservation): void {
  if (legacyInstanceRoot(paths, reservation) === undefined) return;
  const id = reservation.instance_id;
  throw new GwsEaError(
    'legacy_layout',
    `Assistant ${id} is on the legacy layout: run gws-ea update --id ${id} to convert it.`,
    { details: { instanceId: id } },
  );
}

/**
 * Where the layout before releases kept an assistant, whether or not it is
 * still there: its root, `<state root>/instances/<id>`, and the live checkout
 * under it that held its state and its host's logs. `remove` deletes the root
 * of every assistant, converted or not, while the converter exists.
 */
export function legacyLocation(
  paths: Pick<ControlPlanePaths, 'stateRoot'>,
  instanceId: string,
): { readonly root: string; readonly checkout: string } {
  const root = path.join(paths.stateRoot, 'instances', instanceId);
  return { root, checkout: path.join(root, 'nanoclaw') };
}

/** The conversion's progress record in the assistant's short root: there from its first rename until it commits. */
export function conversionRecordFile(paths: Pick<ControlPlanePaths, 'instanceRoot'>, instanceId: string): string {
  return path.join(paths.instanceRoot(instanceId), 'conversion.json');
}

/** Whether the assistant's conversion is under way: its progress record is there. */
export function isConverting(paths: Pick<ControlPlanePaths, 'instanceRoot'>, instanceId: string): Promise<boolean> {
  return isRegularFile(conversionRecordFile(paths, instanceId));
}
