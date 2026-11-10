export type BrowserSecretField = 'username' | 'password' | 'otp';

export function httpsOrigin(raw: string): URL | undefined {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password ? url : undefined;
  } catch (_error) {
    return undefined;
  }
}

/** Playwright protocol logging can contain cookies, field reads and native keyboard payloads. */
export function browserDiagnosticsUnsafe(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (environment.PWDEBUG && environment.PWDEBUG !== '0') return true;
  return (environment.DEBUG ?? '').split(/[\s,]+/u).some((pattern) => {
    if (!pattern || pattern.startsWith('-')) return false;
    const wildcard = pattern.indexOf('*');
    if (wildcard === -1) return pattern === 'pw' || pattern.startsWith('pw:');
    const prefix = pattern.slice(0, wildcard);
    return 'pw:'.startsWith(prefix) || prefix.startsWith('pw:');
  });
}

export interface AuthenticationFieldFacts {
  name: string;
  type: string;
  autocomplete: string;
}
export function authenticationFieldKind(facts: AuthenticationFieldFacts): BrowserSecretField | undefined {
  const autocomplete = facts.autocomplete.toLowerCase().split(/\s+/u);
  const evidence = `${facts.name} ${facts.autocomplete}`;
  if (/(?:cc-|credit.?card|card.?number|cvv|cvc|new-password)/iu.test(evidence)) return undefined;
  if (autocomplete.includes('one-time-code') && ['text', 'tel', 'number', 'password', ''].includes(facts.type))
    return 'otp';
  if (
    facts.type === 'password' &&
    (autocomplete.includes('current-password') || /^(?:password|passwd|pass)$/iu.test(facts.name))
  )
    return 'password';
  if (
    ['email', 'text', 'tel', ''].includes(facts.type) &&
    (autocomplete.includes('username') ||
      facts.type === 'email' ||
      /^(?:username|user|email|login|loginfmt)$/iu.test(facts.name))
  )
    return 'username';
  return undefined;
}

/** Marks a field only the host fills: a site's own credential field, whatever its type shows now. */
export const CREDENTIAL_AUTOCOMPLETE = /(?:^|\s)(?:new|current)-password(?:\s|$)/iu;
/** A one-time code: up to ten letters and digits, no spaces. A password a model chooses is longer or has symbols. */
export const CODE_SHAPED = /^[a-z\d]{0,10}$/iu;

/** What the host reads of a field before the agent enters anything into it. */
export interface EntryFieldFacts {
  /** A field for payment details. */
  readonly card: boolean;
  /** Marked `new-password` or `current-password`. */
  readonly credential: boolean;
  /** A masked input: `type=password` when read. */
  readonly masked: boolean;
}

/**
 * Whether the agent may enter `value` into a field; `undefined` for a key, which types no text. A code reaches any
 * field, a masked PIN box included, while a password the agent chose never reaches a credential or masked field, so
 * accounts are created only through the host's own credential fills.
 */
export function entryRefusal(field: EntryFieldFacts, value?: string): 'card_field' | 'secret_field' | undefined {
  if (field.card) return 'card_field';
  if (field.credential) return 'secret_field';
  if (field.masked && value !== undefined && !CODE_SHAPED.test(value)) return 'secret_field';
  return undefined;
}

export type CredentialFormField = 'username' | 'current_password' | 'new_password' | 'confirmation';
export type CredentialKind = 'signup' | 'rotation';
export interface CredentialFieldFacts {
  name: string;
  id: string;
  type: string;
  autocomplete: string;
}

const CURRENT_HINT = /(?:current|old|existing).?pass/iu;
const NEW_HINT = /new.?pass|pass(?:word)?.?new/iu;
const CONFIRM_HINT =
  /(?:confirm|repeat|retype|re-?enter|verify|again).?pass|pass(?:word)?.?(?:confirm|repeat|again|verify|2)/iu;
const NOT_CREDENTIAL = /(?:cc-|credit.?card|card.?number|cvc|cvv|security.?question|one-time-code)/iu;
const USERNAME_HINT = /(?:^|[^a-z])(?:user.?name|user|e-?mail|login)(?:[^a-z]|$)/iu;

/**
 * Whether a field's structure supports a credential role. The current and the
 * new password are never interchangeable: putting the old password into a new
 * field would leave the website and the vault disagreeing. A change form's
 * unmarked password field is new only beside a bound current-password field.
 */
export function credentialFieldFits(
  role: CredentialFormField,
  facts: CredentialFieldFacts,
  kind: CredentialKind,
  currentBound: boolean,
): boolean {
  const autocomplete = facts.autocomplete.toLowerCase().split(/\s+/u);
  const description = `${facts.name} ${facts.id}`;
  if (NOT_CREDENTIAL.test(`${description} ${facts.autocomplete}`)) return false;
  if (role === 'username')
    return (
      ['email', 'text', ''].includes(facts.type) &&
      (autocomplete.includes('username') ||
        autocomplete.includes('email') ||
        facts.type === 'email' ||
        USERNAME_HINT.test(description))
    );
  const evidenced =
    autocomplete.includes('new-password') ||
    autocomplete.includes('current-password') ||
    /pass(?:word|wd)|pwd/iu.test(description);
  // A show-password toggle leaves a text field that still says what it holds.
  if (facts.type !== 'password' && !(facts.type === 'text' && evidenced)) return false;
  const current = autocomplete.includes('current-password') || CURRENT_HINT.test(description);
  const fresh = autocomplete.includes('new-password') || NEW_HINT.test(description) || CONFIRM_HINT.test(description);
  if (role === 'current_password') return kind === 'rotation' && current && !fresh;
  return !current && (fresh || kind === 'signup' || currentBound);
}

const VERIFICATION_CODE =
  /(?:^|[^a-z])(?:otp|one.?time|verif[a-z]*|confirm[a-z]*|activation|e-?mail.?code)(?:[^a-z]|$)|^(?:code|pin|token)$/iu;
const NOT_VERIFICATION_CODE =
  /(?:cc-|card|cvc|cvv|zip|postal|promo|coupon|discount|gift|referral|invite|voucher|security.?code|pass(?:word|wd))/iu;

/** A field for the code a new account's verification email carries. */
export function verificationCodeFits(facts: CredentialFieldFacts): boolean {
  const description = `${facts.name} ${facts.id}`;
  return (
    ['text', 'tel', 'number', ''].includes(facts.type) &&
    !NOT_VERIFICATION_CODE.test(`${description} ${facts.autocomplete}`) &&
    (facts.autocomplete.toLowerCase().split(/\s+/u).includes('one-time-code') ||
      VERIFICATION_CODE.test(facts.name) ||
      VERIFICATION_CODE.test(facts.id))
  );
}
