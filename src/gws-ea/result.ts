import type { CapabilityList, VoiceCapabilityObservation } from './capabilities.js';
import type { BrowserCapabilityObservation, BrowserOperationData } from './browser-capability.js';
import {
  COMMAND_DEFINITIONS,
  findCommand,
  optionsFor,
  type CommandDefinition,
  type ResultSchema,
} from './command-definitions.js';
import type { StartOutcome, StopOutcome, RestartOutcome } from './service-control.js';
/** Managed invocation facts, shared by the terminal and machine boundaries. */
import type { ProvisionHumanPause } from './phases.js';
import { redact, safeErrorCode, safeErrorMessage } from './redact.js';
import { ERROR_CODE_SCHEMA, PROVISION_PHASE_SCHEMA, RESUME_FLAGS_SCHEMA } from './result-schema.js';
import type { RemovalOutcome, RemovalPreview } from './remove.js';
import type { RollbackOutcome, RollbackPreview } from './rollback.js';
import type { AssistantListing, AssistantStatus } from './status.js';
import type { UpdatePreview } from './update.js';
import type { AssistantUpdate, UpdateAllPlan, UpdateTargetResult } from './update-all.js';
import { PROVISION_STEPS } from './types.js';
import { isRecord } from './validation.js';

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
  readonly staging?: { readonly retained: true; readonly release: import('./types.js').ReleaseCoordinates };
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
  readonly name: 'voice';
  readonly scope: 'host';
  readonly compatible_assistant_ids?: readonly string[];
  readonly unsupported_assistant_ids?: readonly string[];
  readonly unknown_assistant_ids?: readonly string[];
  readonly future_compatible_assistants?: true;
  readonly enabled?: boolean;
  readonly installation_dir?: string;
}
export type CommandData =
  | OperationData
  | VoiceOperationData
  | CapabilityList
  | VoiceCapabilityObservation
  | BrowserCapabilityObservation
  | BrowserOperationData
  | AssistantListing
  | AssistantStatus;
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
/** Only declared literals at their own schema locations are protocol text; all other data stays redacted. */
function schemaVariants(schema: unknown): readonly ResultSchema[] {
  if (!isRecord(schema)) return [];
  return [
    schema,
    ...[schema.oneOf, schema.anyOf].flatMap((branches) =>
      Array.isArray(branches) ? branches.flatMap(schemaVariants) : [],
    ),
  ];
}

function propertySchemas(schemas: readonly ResultSchema[], key: string): readonly ResultSchema[] {
  return schemas.flatMap((schema) => (isRecord(schema.properties) ? schemaVariants(schema.properties[key]) : []));
}

function redactArguments(argv: readonly string[], command: CommandDefinition, placeholders = false): readonly string[] {
  const redacted = argv.map(redact);
  const options = optionsFor(command);
  let positional = 0;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') {
      redacted[index] = token;
      break;
    }
    const equals = token.indexOf('=');
    const name = equals < 0 ? token : token.slice(0, equals);
    const option = options.find(
      (candidate) =>
        name === `--${candidate.name}` ||
        (candidate.type === 'boolean' && candidate.short !== undefined && name === `-${candidate.short}`),
    );
    if (option) {
      redacted[index] = equals < 0 ? name : `${name}=${redact(token.slice(equals + 1))}`;
      if (option.type === 'string' && equals < 0) {
        // A value that happens to equal a known flag is still a value.
        index += 1;
        if (placeholders && argv[index] === `<${option.valueName}>`) redacted[index] = argv[index];
      }
    } else {
      if (token.startsWith('-')) break;
      const argument = command.arguments?.[positional];
      if (argument?.choices?.includes(token)) redacted[index] = token;
      positional += 1;
    }
  }
  return redacted;
}

function redactCommandArgv(argv: readonly string[]): readonly string[] {
  const command =
    argv[0] === 'gws-ea'
      ? COMMAND_DEFINITIONS.filter((definition) =>
          definition.path.every((part, index) => argv[index + 1] === part),
        ).sort((left, right) => right.path.length - left.path.length)[0]
      : undefined;
  if (!command) return argv.map(redact);
  const offset = command.path.length + 1;
  return [...argv.slice(0, offset), ...redactArguments(argv.slice(offset), command)];
}

function redactValues(value: unknown, schemas: readonly ResultSchema[] = []): unknown {
  if (typeof value === 'string') {
    if (
      schemas.includes(ERROR_CODE_SCHEMA) ||
      (schemas.includes(PROVISION_PHASE_SCHEMA) && PROVISION_STEPS.some((phase) => phase === value)) ||
      schemas.some((schema) => schema.const === value || (Array.isArray(schema.enum) && schema.enum.includes(value)))
    )
      return value;
    if (schemas.includes(RESUME_FLAGS_SCHEMA)) {
      const resume = findCommand(['resume']);
      if (resume) {
        const tokens = redactArguments(value.match(/\S+/gu) ?? [], resume, true);
        let index = 0;
        return value.replace(/\S+/gu, () => tokens[index++]);
      }
    }
    return redact(value);
  }
  if (Array.isArray(value)) {
    const items = schemas.flatMap((schema) => schemaVariants(schema.items));
    return value.map((entry) => redactValues(entry, items));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactValues(entry, propertySchemas(schemas, key))]),
    );
  }
  return value;
}
export function resultJson(result: ManagedResult<unknown>): string {
  const command = COMMAND_DEFINITIONS.find((definition) => definition.path.join(' ') === result.command);
  return JSON.stringify(
    {
      ...result,
      command: command ? result.command : redact(result.command),
      data: redactValues(result.data, propertySchemas(schemaVariants(command?.resultSchema), 'data')),
      error: result.error ? { ...result.error, message: redact(result.error.message) } : null,
      next_actions: result.next_actions.map((action) =>
        action.kind === 'command'
          ? { ...action, argv: redactCommandArgv(action.argv) }
          : {
              ...action,
              instruction: redact(action.instruction),
              ...(action.url !== undefined ? { url: redact(action.url) } : {}),
            },
      ),
      diagnostics: redactValues(result.diagnostics),
    },
    null,
    2,
  );
}
/** Positive evidence survives later uncertainty; log creation never enters this accumulator. */
export function combineEffects(current: Changed, observed: Changed): Changed {
  return current === true || observed === true ? true : current === null || observed === null ? null : false;
}
