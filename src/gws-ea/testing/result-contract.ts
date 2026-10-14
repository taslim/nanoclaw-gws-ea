import Ajv from 'ajv';
import { expect } from 'vitest';

import { findCommand } from '../command-definitions.js';

const ajv = new Ajv({ allErrors: true });

/** Validate a captured native result against the schema published for its invoked command. */
export function expectResultContract(command: string, result: unknown): void {
  const definition = findCommand(command.split(' '));
  if (!definition) throw new Error(`No command schema for ${command}`);
  const validate = ajv.compile(definition.resultSchema);
  expect(validate(result), ajv.errorsText(validate.errors)).toBe(true);
}
