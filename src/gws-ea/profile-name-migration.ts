import { normalizePersonName, type PersonName } from './person-name.js';
import { hasControlCharacters, isRecord } from './validation.js';

export const PROFILE_NAME_INPUT_TABLE = 'gws_ea_profile_name_input';
export const PROFILE_NAME_MIGRATION = 'module:gws-ea-profile:structured-names';

export interface LegacyProfileNames {
  readonly assistant_display_name: string | null;
  readonly principal_display_name: string | null;
}

export interface ProfileNameMigrationInput {
  readonly schema_version: 1;
  readonly instance_id: string;
  readonly previous: LegacyProfileNames;
  readonly assistant: PersonName;
  readonly principal: PersonName;
}

function parseName(value: unknown, owner: 'assistant' | 'principal'): PersonName {
  if (
    !isRecord(value) ||
    typeof value.firstName !== 'string' ||
    !(value.lastName === null || typeof value.lastName === 'string')
  ) {
    throw new Error(`Structured-name migration needs explicit ${owner} first and last name components`);
  }
  return normalizePersonName({ firstName: value.firstName, lastName: value.lastName }, owner);
}

/** The durable conversion input is data, never executable migration instructions. */
export function parseProfileNameMigrationInput(value: unknown): ProfileNameMigrationInput {
  if (
    !isRecord(value) ||
    value.schema_version !== 1 ||
    typeof value.instance_id !== 'string' ||
    !value.instance_id ||
    value.instance_id.length > 256 ||
    /\s/u.test(value.instance_id) ||
    hasControlCharacters(value.instance_id) ||
    !isRecord(value.previous) ||
    !(value.previous.assistant_display_name === null || typeof value.previous.assistant_display_name === 'string') ||
    !(value.previous.principal_display_name === null || typeof value.previous.principal_display_name === 'string')
  ) {
    throw new Error('Invalid structured-name migration input');
  }
  return {
    schema_version: 1,
    instance_id: value.instance_id,
    previous: {
      assistant_display_name: value.previous.assistant_display_name,
      principal_display_name: value.previous.principal_display_name,
    },
    assistant: parseName(value.assistant, 'assistant'),
    principal: parseName(value.principal, 'principal'),
  };
}

/** Compare the exact observed values: no guessed boundaries or stale profile overwrite. */
export function assertProfileNameMigrationSource(input: ProfileNameMigrationInput, legacy: LegacyProfileNames): void {
  if (
    input.previous.assistant_display_name !== legacy.assistant_display_name ||
    input.previous.principal_display_name !== legacy.principal_display_name
  ) {
    throw new Error('Structured-name migration input is stale: prepare names again for the current profile');
  }
}
