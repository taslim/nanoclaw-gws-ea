import { hasControlCharacters } from './validation.js';

export interface PersonName {
  readonly firstName: string;
  readonly lastName: string | null;
}

export interface PersonNameInput {
  readonly firstName: string;
  readonly lastName?: string | null;
}

export type NameOwner = 'assistant' | 'principal';

/** Presentation only: the supplied components remain the canonical identity. */
export function displayPersonName(name: PersonName): string {
  return name.lastName === null ? name.firstName : `${name.firstName} ${name.lastName}`;
}

/** The same identity rules apply at setup, conversion and later profile edits. */
export function normalizePersonName(input: PersonNameInput, owner: NameOwner): PersonName {
  const firstName = input.firstName.trim();
  const lastName = input.lastName?.trim() || null;
  const name = { firstName, lastName };
  const display = displayPersonName(name);
  const maximum = owner === 'principal' ? 80 : 120;
  let problem: string | undefined;
  if (!firstName) problem = 'the first name is empty';
  else if (display.length > maximum) problem = `it is longer than ${maximum} characters`;
  else if (hasControlCharacters(display)) problem = 'it holds a control character';
  else if (/@|:\/\/|www\.|\//iu.test(display)) problem = 'it holds an address or a link';
  else if (/[<>`]/u.test(display)) problem = 'it holds markup';
  else if (/\.\p{L}{2}/u.test(display)) problem = 'it holds a domain name, which mail turns into a link';
  if (problem !== undefined) throw new Error(`${owner} name cannot be a person's name: ${problem}`);
  return name;
}
