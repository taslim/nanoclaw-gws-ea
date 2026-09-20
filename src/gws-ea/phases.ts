import { PROVISION_PHASES, GwsEaError, type ProvisionPhase } from './types.js';

export interface ProvisionHumanPause {
  readonly kind: 'human-action';
  readonly phase: ProvisionPhase;
  readonly code: string;
  readonly message: string;
  readonly details?: readonly string[];
  readonly actionUrl?: string;
  readonly resumeFlag?: string;
  readonly choices?: readonly { readonly id: string; readonly label: string }[];
}

export type PhaseProbeResult =
  | { readonly status: 'matched' }
  | { readonly status: 'absent' }
  | { readonly status: 'paused'; readonly pause: ProvisionHumanPause };

export type PhaseEffectResult =
  | { readonly status: 'completed' }
  | { readonly status: 'paused'; readonly pause: ProvisionHumanPause };

/**
 * One durable phase contract. `probe` is deliberately part of the phase,
 * rather than the runner, so the code that knows the external postcondition
 * also owns reconciliation after an ambiguous interruption.
 */
export interface ProvisionPhaseDefinition<Context> {
  readonly resourceKey: (context: Context) => string;
  readonly probe: (context: Context) => Promise<PhaseProbeResult>;
  readonly apply: (context: Context) => Promise<PhaseEffectResult>;
  /**
   * Optional, narrowly scoped migration for a completed phase whose accepted
   * postcondition changed. The callback must reject unrelated drift; the
   * runner always re-probes before accepting the repaired postcondition.
   */
  readonly reconcileCompletedPostcondition?: (context: Context) => Promise<void>;
}

export type ProvisionPhaseRegistry<Context> = Readonly<{
  [Phase in ProvisionPhase]: ProvisionPhaseDefinition<Context>;
}>;

/** Build an exhaustive registry and reject extra/missing runtime keys. */
export function defineProvisionPhaseRegistry<Context>(definitions: {
  [Phase in ProvisionPhase]: ProvisionPhaseDefinition<Context>;
}): ProvisionPhaseRegistry<Context> {
  const actual = Object.keys(definitions).sort();
  const expected = [...PROVISION_PHASES].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new GwsEaError('invalid_phase_registry', 'Provision phase registry is incomplete or contains unknown phases');
  }
  return Object.freeze({ ...definitions });
}
