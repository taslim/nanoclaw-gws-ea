/**
 * The fields an agent's calendar request carries, read the one way every
 * calendar tool reads them: a refusal names the field and says what it
 * takes, so the agent can correct the call.
 */
import { invalidArgs } from '../../cli/delivery-action.js';
import { hasControlCharacters } from '../../gws-ea/validation.js';
import { isValidTimezone } from '../../timezone.js';
import { normalizeAddress } from '../gws-ea-inbox/mime.js';

const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/iu;

/** A date and time with its UTC offset, as an instant. */
export function instantOf(value: unknown, label: string): number {
  if (typeof value !== 'string' || !DATE_TIME.test(value)) {
    throw invalidArgs(`${label} must be a date and time with its UTC offset, such as 2026-10-07T09:00:00-04:00`);
  }
  const at = Date.parse(value);
  if (!Number.isFinite(at)) throw invalidArgs(`${label} is not a real date and time: ${value}`);
  return at;
}

export function timezoneOf(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !isValidTimezone(value)) {
    throw invalidArgs('timezone must be an IANA time zone, such as America/New_York');
  }
  return value;
}

/** One line of text, its whitespace collapsed; undefined when absent and not required. */
export function lineOf(value: unknown, label: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  const line = typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
  if (line === '' || line.length > max || hasControlCharacters(line)) {
    throw invalidArgs(`${label} must be text of 1 to ${max} characters`);
  }
  return line;
}

/** Notes as written: line breaks kept, nothing else unprintable. */
export function notesOf(value: unknown, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  const notes = typeof value === 'string' ? value.replace(/\r\n?/gu, '\n').trim() : '';
  if (notes === '' || notes.length > max || hasControlCharacters(notes.replace(/[\n\t]/gu, ' '))) {
    throw invalidArgs(`notes must be text of 1 to ${max} characters`);
  }
  return notes;
}

/** true or false; false when absent. */
export function flagOf(value: unknown, label: string): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') throw invalidArgs(`${label} must be true or false`);
  return value;
}

/** The addresses given, each normalized and listed once; undefined when absent. */
export function addressesOf(value: unknown, label: string, max: number): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > max) {
    throw invalidArgs(`${label} must list 1 to ${max} email addresses`);
  }
  return [
    ...new Set(
      value.map((entry: unknown) => {
        const address = typeof entry === 'string' ? normalizeAddress(entry) : undefined;
        if (address === undefined) {
          throw invalidArgs(`${label} must list email addresses; ${JSON.stringify(entry)} is not one`);
        }
        return address;
      }),
    ),
  ];
}
