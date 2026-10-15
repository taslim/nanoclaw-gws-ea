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
 * - The principal: one of their addresses, in any spelling the one rule
 *   recognizes (R1), as the single From mailbox, a `dkim=pass` from exactly
 *   the domain the From is written with, `dmarc=pass` (never
 *   `bestguesspass`), no differing Sender, and no List-Id: Gmail verified
 *   that the address's own domain sent it, whichever provider that is. The
 *   verdict names the address as the principal listed it (R2). A principal
 *   address that fails this is unauthenticated, never an ordinary sender, so
 *   it can neither instruct nor be mistaken for a counterpart.
 *   Anything the domain lets sign for it counts, a sending service included
 *   (accepted 2026-10-03 over per-domain selector pins the operator kept).
 * - Google Calendar's notifications: the same rule for `google.com`.
 * - Google Docs' comment mail and Drive's share and access-request mail
 *   (KTD6): the same rule, with a DMARC pass for the sender's exact domain
 *   and a DKIM pass from `google.com` or `docs.google.com`, whichever Google
 *   signs that mail with.
 * - Anyone else: `dmarc=pass` for the From domain, or a `dkim=pass` whose
 *   domain is aligned to it.
 *
 * Why a message is not verified is one of a fixed set of codes (KTD3); the
 * principal hears, once, of each code their own address fails with.
 *
 * Separately, `signedByGoogle` says whether Google itself signed a message
 * (KTD12): Google Calendar sends invitations and answers in the person's own
 * name, signed by google.com, so the route tells that mail apart before the
 * rule for its From applies.
 */
import { getDomain } from 'tldts';
import type { PrincipalRecognizer } from '../gws-ea-profile/db.js';
import { domainOf, headerValues, parseAddressList, type MailHeader, type Mailbox } from './mime.js';

export interface AuthContext {
  /** The principal's addresses, by the one rule that recognizes them (R1). */
  readonly principalAddresses: PrincipalRecognizer;
}

const PRINCIPAL_REFUSALS = ['no-gmail-results', 'sender-differs', 'mailing-list', 'no-own-dkim', 'no-dmarc'] as const;

/**
 * Why the rule refuses mail from one of the principal's addresses (R4): no
 * results of Gmail's own at the top of the message, a differing Sender, a
 * mailing list, no DKIM pass from the From's own domain, or no DMARC pass.
 */
export type PrincipalRefusal = (typeof PRINCIPAL_REFUSALS)[number];

/**
 * Why Gmail's results verify no one: a refusal of a principal address, or a
 * From that is not one mailbox, mail claiming one of Google's senders that
 * Google did not sign, or anyone else's mail with neither a DMARC pass nor an
 * aligned DKIM pass.
 */
export type UnauthenticatedReason =
  | PrincipalRefusal
  | 'not-one-mailbox'
  | 'unsigned-calendar-notification'
  | 'unsigned-workspace-notification'
  | 'no-aligned-pass';

export type SenderVerdict =
  | {
      readonly kind: 'principal';
      /**
       * The principal's address as they listed it, which the From reached
       * (R2): the sender's identity. The From as written stays on the
       * message, which is answered at it.
       */
      readonly address: string;
      readonly displayName?: string;
    }
  | { readonly kind: 'calendar-notification' }
  | { readonly kind: 'workspace-notification'; readonly address: string }
  | { readonly kind: 'authenticated'; readonly address: string; readonly displayName?: string }
  | {
      readonly kind: 'unauthenticated';
      /** The From address as written, unverified; undefined when From is not one mailbox. */
      readonly address: string | undefined;
      readonly displayName?: string;
      readonly reason: UnauthenticatedReason;
    };

export const CALENDAR_NOTIFICATION_SENDER = 'calendar-notification@google.com';
/** Google Docs' mail about comments: new ones, replies, mentions, and assignments. */
export const DOCS_COMMENTS_SENDER = 'comments-noreply@docs.google.com';
/** Google's senders of Docs and Drive activity mail; Drive's shares and access requests come from the other two. */
export const WORKSPACE_NOTIFICATION_SENDERS: ReadonlySet<string> = new Set([
  DOCS_COMMENTS_SENDER,
  'drive-shares-dm-noreply@google.com',
  'drive-shares-noreply@google.com',
]);
const GOOGLE_DOMAIN = 'google.com';
/** The domains Google signs Docs and Drive activity mail with. */
const WORKSPACE_SIGNING_DOMAINS: ReadonlySet<string> = new Set([GOOGLE_DOMAIN, 'docs.google.com']);
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

/** Browser mail needs an aligned DKIM pass in Gmail's trace block; a DMARC pass alone never claims mail. */
export function dkimAlignedToSite(headers: readonly MailHeader[], site: string): boolean {
  const from = singleMailbox(headers, 'From');
  const results = gmailResults(headers);
  if (from === 'absent' || from === 'invalid' || !results) return false;
  const sender = singleMailbox(headers, 'Sender');
  if (sender !== 'absent' && (sender === 'invalid' || sender.address !== from.address)) return false;
  const domain = domainOf(from.address);
  if (getDomain(domain, { allowPrivateDomains: true }) !== site) return false;
  return passed(results, 'dkim', (result) => {
    const signer = dkimDomain(result);
    return signer !== undefined && getDomain(signer, { allowPrivateDomains: true }) === site;
  });
}

function named(mailbox: Mailbox): { readonly displayName?: string } {
  return mailbox.displayName === undefined ? {} : { displayName: mailbox.displayName };
}

/** Decide who sent a message, from its headers alone. */
export function authenticateSender(headers: readonly MailHeader[], context: AuthContext): SenderVerdict {
  const from = singleMailbox(headers, 'From');
  if (from === 'absent' || from === 'invalid') {
    return { kind: 'unauthenticated', address: undefined, reason: 'not-one-mailbox' };
  }
  const unauthenticated = (reason: UnauthenticatedReason): SenderVerdict => ({
    kind: 'unauthenticated',
    address: from.address,
    ...named(from),
    reason,
  });
  const results = gmailResults(headers);
  if (results === undefined) return unauthenticated('no-gmail-results');

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

  const listed = context.principalAddresses.resolve(from.address);
  if (listed !== undefined) {
    if (!soleSender) return unauthenticated('sender-differs');
    if (hasListId) return unauthenticated('mailing-list');
    if (!ownDkimPass(domain)) return unauthenticated('no-own-dkim');
    if (!dmarcPass) return unauthenticated('no-dmarc');
    return { kind: 'principal', address: listed, ...named(from) };
  }

  if (from.address === CALENDAR_NOTIFICATION_SENDER) {
    if (soleSender && !hasListId && ownDkimPass(GOOGLE_DOMAIN) && dmarcPass) {
      return { kind: 'calendar-notification' };
    }
    return unauthenticated('unsigned-calendar-notification');
  }

  if (WORKSPACE_NOTIFICATION_SENDERS.has(from.address)) {
    if (soleSender && !hasListId && [...WORKSPACE_SIGNING_DOMAINS].some(ownDkimPass) && dmarcPass) {
      return { kind: 'workspace-notification', address: from.address };
    }
    return unauthenticated('unsigned-workspace-notification');
  }

  const alignedDkimPass = passed(results, 'dkim', (result) => {
    const signer = dkimDomain(result);
    return signer !== undefined && signer.includes('.') && (domain === signer || domain.endsWith(`.${signer}`));
  });
  return dmarcPass || alignedDkimPass
    ? { kind: 'authenticated', address: from.address, ...named(from) }
    : unauthenticated('no-aligned-pass');
}

/** One of the principal's addresses that an unverified message shows as its From, as they listed it, and why the rule refused it. */
export interface RefusedPrincipalAddress {
  readonly address: string;
  readonly reason: PrincipalRefusal;
}

function isPrincipalRefusal(reason: UnauthenticatedReason): reason is PrincipalRefusal {
  return PRINCIPAL_REFUSALS.some((refusal) => refusal === reason);
}

/** The principal's address an unverified message's From reaches, and why it was refused; undefined for anyone else's. */
export function refusedPrincipalAddress(
  verdict: Extract<SenderVerdict, { kind: 'unauthenticated' }>,
  context: AuthContext,
): RefusedPrincipalAddress | undefined {
  const address = context.principalAddresses.resolve(verdict.address);
  return address !== undefined && isPrincipalRefusal(verdict.reason) ? { address, reason: verdict.reason } : undefined;
}

/**
 * Whether Google itself signed the message, by Gmail's own results: a DKIM
 * pass from google.com, with no List-Id (KTD12). Google Calendar sends
 * invitations and guests' answers this way, in the person's own name, so
 * neither a DMARC pass for the From's domain nor any Sender is asked for:
 * Google's signature is what no one else can make. Only with an event link to
 * a calendar the route knows is such a message calendar mail.
 */
export function signedByGoogle(headers: readonly MailHeader[]): boolean {
  const results = gmailResults(headers);
  return (
    results !== undefined &&
    headerValues(headers, 'List-Id').length === 0 &&
    passed(results, 'dkim', (result) => dkimDomain(result) === GOOGLE_DOMAIN)
  );
}
