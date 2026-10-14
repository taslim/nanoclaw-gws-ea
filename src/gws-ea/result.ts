import type { StartOutcome, StopOutcome, RestartOutcome } from './service-control.js';
/** Managed invocation facts, shared by the terminal and machine boundaries. */
import type { ProvisionHumanPause } from './phases.js';
import { redact, safeErrorCode, safeErrorMessage } from './redact.js';
import type { RemovalOutcome, RemovalPreview } from './remove.js';
import type { RollbackOutcome, RollbackPreview } from './rollback.js';
import type { AssistantListing, AssistantStatus } from './status.js';
import type { UpdatePreview } from './update.js';
import type { AssistantUpdate, UpdateAllPlan, UpdateTargetResult } from './update-all.js';

export type Changed = boolean | null;
export type ManagedOutcome = 'succeeded' | 'paused' | 'failed' | 'busy' | 'cancelled';
export type NextAction =
  | { readonly kind: 'command'; readonly argv: readonly string[] }
  | { readonly kind: 'external'; readonly instruction: string; readonly url?: string };
export interface OperationData {
  readonly instance_id?: string;
  readonly preparation?: { readonly bootstrap_manifest: 'retained' | 'unknown'; readonly reservation: 'unknown' };
  readonly pause?: Pick<
    ProvisionHumanPause,
    'phase' | 'code' | 'message' | 'details' | 'actionUrl' | 'resumeFlag' | 'choices'
  >;
  readonly preview?: RemovalPreview | UpdatePreview | RollbackPreview;
  readonly update?: AssistantUpdate;
  readonly rollback?: RollbackOutcome;
  readonly removal?: RemovalOutcome;
  readonly service?:
    | { readonly action: 'start'; readonly result: StartOutcome }
    | { readonly action: 'stop'; readonly result: StopOutcome }
    | { readonly action: 'restart'; readonly result: RestartOutcome };
  readonly cleanup?: {
    readonly checkout: string;
    readonly removed: readonly string[];
    readonly incomplete?: boolean;
    readonly error?: { readonly code: string; readonly message: string };
  };
  readonly plan?: UpdateAllPlan;
  readonly targets?: readonly UpdateTargetResult[];
}
export interface VoiceOperationData {
  readonly scope: 'host';
  readonly enabled?: boolean;
  readonly installation_dir?: string;
}
export type CommandData = OperationData | VoiceOperationData | AssistantListing | AssistantStatus;
export interface ManagedResult<T = CommandData> {
  readonly schema_version: 1;
  readonly command: string;
  readonly outcome: ManagedOutcome;
  readonly changed: Changed;
  readonly data: T | null;
  readonly error: { readonly code: string; readonly message: string } | null;
  readonly next_actions: readonly NextAction[];
  readonly diagnostics: { readonly run_log?: string; readonly step_log?: string };
}
export function managedResult<T>(
  command: string,
  facts: {
    readonly outcome: ManagedOutcome;
    readonly changed?: Changed;
    readonly data?: T | null;
    readonly error?: unknown;
    readonly next_actions?: readonly NextAction[];
    readonly diagnostics?: ManagedResult['diagnostics'];
  },
): ManagedResult<T> {
  return {
    schema_version: 1,
    command,
    outcome: facts.outcome,
    changed: facts.changed === undefined ? false : facts.changed,
    data: facts.data ?? null,
    error:
      facts.error === undefined ? null : { code: safeErrorCode(facts.error), message: safeErrorMessage(facts.error) },
    next_actions: facts.next_actions ?? [],
    diagnostics: facts.diagnostics ?? {},
  };
}
/** Redact string values recursively before serialization; schema keys never enter the text redactor. */
function redactValues(value: unknown): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(redactValues);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactValues(entry)]));
  }
  return value;
}
export function resultJson(result: ManagedResult<unknown>): string {
  return JSON.stringify(redactValues(result), null, 2);
}
/** Positive evidence survives later uncertainty; log creation never enters this accumulator. */
export function combineEffects(current: Changed, observed: Changed): Changed {
  return current === true || observed === true ? true : current === null || observed === null ? null : false;
}
