/**
 * Who a message is from, by Gmail's own authentication results (KTD4, R21,
 * R22). Nothing in a message's From line, display name, or body can make it
 * the principal's or give its sender an identity; only the results Gmail
 * wrote when it received the message can.
 *
 * Gmail's results are the topmost `Authentication-Results` header, inside the
 * block of trace headers Gmail prepends on delivery. A sender can write an
 * `Authentication-Results` header of their own, but only below Gmail's, so a
 * header with anything but Gmail's trace headers above it is never trusted.
 *
 * - The principal: one of their addresses as the single From mailbox, a
 *   `dkim=pass` from exactly that address's domain, `dmarc=pass` (never
 *   `bestguesspass`), no differing Sender, and no List-Id: Gmail verified
 *   that the address's own domain sent it, whichever provider that is. A
 *   principal address that fails this is unauthenticated, never an ordinary
 *   sender, so it can neither instruct nor be mistaken for a counterpart.
 *   Anything the domain lets sign for it counts, a sending service included
 *   (accepted 2026-10-03 over per-domain selector pins the operator kept).
 * - Google Calendar's notifications: the same rule for `google.com`.
 * - Anyone else: `dmarc=pass` for the From domain, or a `dkim=pass` whose
 *   domain is aligned to it.
 */
import { domainOf, headerValues, parseAddressList, type MailHeader, type Mailbox } from './mime.js';

export interface AuthContext {
  /** The principal's addresses, lowercased. */
  readonly principalAddresses: ReadonlySet<string>;
}

export type SenderVerdict =
  | { readonly kind: 'principal'; readonly address: string; readonly displayName?: string }
  | { readonly kind: 'calendar-notification' }
  | { readonly kind: 'authenticated'; readonly address: string; readonly displayName?: string }
  | {
      readonly kind: 'unauthenticated';
      /** The From address as written, unverified; undefined when From is not one mailbox. */
      readonly address: string | undefined;
      readonly displayName?: string;
      readonly reason: string;
    };

export const CALENDAR_NOTIFICATION_SENDER = 'calendar-notification@google.com';
const GOOGLE_DOMAIN = 'google.com';
const GMAIL_AUTHSERV_ID = 'mx.google.com';

/**
 * Headers Gmail adds on delivery, above its own results. Anything else above
 * the topmost `Authentication-Results` means it is not Gmail's.
 */
const GMAIL_TRACE_HEADERS: ReadonlySet<string> = new Set([
  'delivered-to',
  'received',
  'x-received',
  'arc-seal',
  'arc-message-signature',
  'arc-authentication-results',
  'return-path',
  'received-spf',
  'x-forwarded-to',
  'x-forwarded-for',
]);

interface AuthResult {
  readonly method: string;
  readonly result: string;
  readonly properties: ReadonlyMap<string, string>;
}

/** Comments removed and folded lines joined, honoring quoted strings. */
function clean(value: string): string {
  let out = '';
  let depth = 0;
  let quoted = false;
  const unfolded = value.replace(/\r?\n[ \t]+/gu, ' ');
  for (let index = 0; index < unfolded.length; index += 1) {
    const character = unfolded[index];
    if (character === '\\') {
      if (depth === 0) out += character + (unfolded[index + 1] ?? '');
      index += 1;
      continue;
    }
    if (depth === 0 && character === '"') quoted = !quoted;
    if (!quoted && character === '(') {
      depth += 1;
      continue;
    }
    if (!quoted && character === ')' && depth > 0) {
      depth -= 1;
      continue;
    }
    if (depth === 0) out += character;
  }
  return out;
}

/** RFC 8601 `Authentication-Results`: its authserv-id and each method's result. */
export function parseAuthenticationResults(
  value: string,
): { readonly authservId: string; readonly results: readonly AuthResult[] } | undefined {
  const [head, ...resinfos] = clean(value).split(';');
  const authservId = head?.trim().split(/\s+/u)[0]?.toLowerCase();
  if (!authservId) return undefined;
  const results: AuthResult[] = [];
  for (const resinfo of resinfos) {
    const tokens = resinfo.trim().split(/\s+/u).filter(Boolean);
    const [methodToken, ...rest] = tokens;
    if (methodToken === undefined || methodToken.toLowerCase() === 'none') continue;
    const equals = methodToken.indexOf('=');
    if (equals <= 0) continue;
    const method = methodToken.slice(0, equals).split('/')[0]?.toLowerCase() ?? '';
    const result = methodToken.slice(equals + 1).toLowerCase();
    const properties = new Map<string, string>();
    for (const token of rest) {
      const at = token.indexOf('=');
      if (at <= 0) continue;
      properties.set(token.slice(0, at).toLowerCase(), token.slice(at + 1).replace(/^"|"$/gu, ''));
    }
    results.push({ method, result, properties });
  }
  return { authservId, results };
}

/** Gmail's own results, or undefined when the topmost results are not Gmail's or sit below a non-Gmail header. */
function gmailResults(headers: readonly MailHeader[]): readonly AuthResult[] | undefined {
  for (const header of headers) {
    const name = header.name.toLowerCase();
    if (name === 'authentication-results') {
      const parsed = parseAuthenticationResults(header.value);
      return parsed?.authservId === GMAIL_AUTHSERV_ID ? parsed.results : undefined;
    }
    if (!GMAIL_TRACE_HEADERS.has(name)) return undefined;
  }
  return undefined;
}

/** The one mailbox a header names; 'absent' or 'invalid' otherwise. */
function singleMailbox(headers: readonly MailHeader[], name: string): Mailbox | 'absent' | 'invalid' {
  const values = headerValues(headers, name);
  if (values.length === 0) return 'absent';
  if (values.length > 1) return 'invalid';
  const list = parseAddressList(values[0] ?? '');
  return list?.length === 1 && list[0] !== undefined ? list[0] : 'invalid';
}

function dkimDomain(result: AuthResult): string | undefined {
  const domain = result.properties.get('header.d');
  if (domain) return domain.toLowerCase();
  const identity = result.properties.get('header.i');
  return identity?.includes('@') ? domainOf(identity).toLowerCase() : undefined;
}

function passed(results: readonly AuthResult[], method: string, accept: (result: AuthResult) => boolean): boolean {
  return results.some((result) => result.method === method && result.result === 'pass' && accept(result));
}

function named(mailbox: Mailbox): { readonly displayName?: string } {
  return mailbox.displayName === undefined ? {} : { displayName: mailbox.displayName };
}

/** Decide who sent a message, from its headers alone. */
export function authenticateSender(headers: readonly MailHeader[], context: AuthContext): SenderVerdict {
  const from = singleMailbox(headers, 'From');
  if (from === 'absent' || from === 'invalid') {
    return { kind: 'unauthenticated', address: undefined, reason: 'From is not one mailbox' };
  }
  const unauthenticated = (reason: string): SenderVerdict => ({
    kind: 'unauthenticated',
    address: from.address,
    ...named(from),
    reason,
  });
  const results = gmailResults(headers);
  if (results === undefined) return unauthenticated("no authentication results of Gmail's own");

  const domain = domainOf(from.address);
  const sender = singleMailbox(headers, 'Sender');
  const soleSender = sender === 'absent' || (sender !== 'invalid' && sender.address === from.address);
  const hasListId = headerValues(headers, 'List-Id').length > 0;
  const dmarcPass = passed(
    results,
    'dmarc',
    (result) => result.properties.get('header.from')?.toLowerCase() === domain,
  );
  const ownDkimPass = (forDomain: string) => passed(results, 'dkim', (result) => dkimDomain(result) === forDomain);

  if (context.principalAddresses.has(from.address)) {
    if (!soleSender) return unauthenticated('a Sender differs from From');
    if (hasListId) return unauthenticated('sent through a mailing list');
    if (!ownDkimPass(domain)) return unauthenticated('no DKIM pass from its own domain');
    if (!dmarcPass) return unauthenticated('no DMARC pass');
    return { kind: 'principal', address: from.address, ...named(from) };
  }

  if (from.address === CALENDAR_NOTIFICATION_SENDER) {
    if (soleSender && !hasListId && ownDkimPass(GOOGLE_DOMAIN) && dmarcPass) {
      return { kind: 'calendar-notification' };
    }
    return unauthenticated('a calendar notification Google did not sign');
  }

  const alignedDkimPass = passed(results, 'dkim', (result) => {
    const signer = dkimDomain(result);
    return signer !== undefined && signer.includes('.') && (domain === signer || domain.endsWith(`.${signer}`));
  });
  return dmarcPass || alignedDkimPass
    ? { kind: 'authenticated', address: from.address, ...named(from) }
    : unauthenticated('no DMARC pass and no aligned DKIM pass');
}
