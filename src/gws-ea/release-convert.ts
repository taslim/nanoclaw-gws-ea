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

import type { ControlPlanePaths } from './paths.js';
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
