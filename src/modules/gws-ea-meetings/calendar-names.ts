/** Calendar names shared by the host's conflict and event answers. */
import { EMAIL_PATTERN, identityMatchKey } from '../../gws-ea/validation.js';
import { untrustedLine } from '../gws-ea-inbox/untrusted.js';
import type { PrincipalRecognizer } from '../gws-ea-profile/db.js';
import type { CalendarEntry } from './calendar-api.js';

export interface CalendarName {
  readonly text: string;
  readonly external: boolean;
}

export function calendarName(name: CalendarName): string {
  return name.external ? untrustedLine(name.text, 64, 'google_calendar') : name.text;
}

/** Address-named calendars use spoken account names, keeping ambiguous names distinct. */
export function calendarNames(
  entries: readonly CalendarEntry[],
  addresses: PrincipalRecognizer,
): Map<string, CalendarName> {
  const heard = (name: string): string => {
    if (entries.length === 1) return "the principal's calendar";
    if (!addresses.has(name)) return "one of the principal's calendars";
    const key = identityMatchKey(`email:${name}`);
    const domain = key.slice(key.lastIndexOf('@') + 1);
    return domain === 'gmail.com' ? "the principal's Gmail calendar" : `the principal's calendar at ${domain}`;
  };
  const named = entries.map((entry) => {
    const name = entry.summary?.replace(/\s+/gu, ' ').trim() || entry.id;
    const address = EMAIL_PATTERN.test(name);
    return { id: entry.id, name, spoken: { text: address ? heard(name) : name, external: !address } };
  });
  const uses = new Map<string, number>();
  for (const { spoken } of named) uses.set(spoken.text, (uses.get(spoken.text) ?? 0) + 1);
  return new Map(
    named.map(
      ({ id, name, spoken }) => [id, uses.get(spoken.text) === 1 ? spoken : { text: name, external: true }] as const,
    ),
  );
}
