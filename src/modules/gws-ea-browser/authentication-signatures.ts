import type { ElementHandle, Frame } from 'playwright-core';
import {
  inspectNativeAuthenticationControl,
  submitNativeAuthenticationForm,
  type NativeAuthenticationBinding,
} from './authentication-submit.js';

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
export interface AuthenticationFormSignature {
  origin: string;
  action: string;
  frame: Frame;
  element: ElementHandle;
  native: NativeAuthenticationBinding;
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

/**
 * What marks a field's value as a credential, code or payment secret. Both
 * survive a show-password toggle, which only turns a password field's type to
 * text. The page-side scan in observe.ts builds its filter from these sources.
 */
export const SECRET_AUTOCOMPLETE = /(?:current-password|new-password|one-time-code|cc-)/iu;
export const SECRET_DESCRIPTION =
  /(?:pass(?:word|wd|phrase|code)|pwd|one-time-code|(?:^|\s)cc-|credit.?card|card.?number|cvc|cvv|otp|one.?time|verification.?code|security.?code)/iu;

export interface SensitiveFieldFacts {
  type: string;
  autocomplete: string;
  name: string;
  id?: string;
  label?: string;
  placeholder?: string;
}

/** Ordinary text input refuses these; only the host's bound fills may write them. */
export function isSensitiveField(facts: SensitiveFieldFacts): boolean {
  if (facts.type === 'password' || SECRET_AUTOCOMPLETE.test(facts.autocomplete)) return true;
  return SECRET_DESCRIPTION.test(
    [facts.autocomplete, facts.name, facts.id ?? '', facts.label ?? '', facts.placeholder ?? ''].join(' '),
  );
}

/** The fields an authorized signup or password change fills, each with the value the host chose for it. */
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

/** Endpoint signatures are host source, never model or site-authored prose. */
export function authenticationEndpoint(url: URL): boolean {
  if (!httpsOrigin(url.href)) return false;
  for (const [name, value] of url.searchParams) {
    if (
      /^(?:action|operation|intent|command|do)$/iu.test(name) &&
      !/^(?:login|signin|sign-in|authenticate|verify|otp|send-code|send-link)$/iu.test(value)
    )
      return false;
    if (/(?:purchase|checkout|subscribe|placeorder|oneclick|payment)/iu.test(name)) return false;
  }
  if (
    /^\/(?:(?:account|accounts|auth|authentication|api\/auth)\/)?(?:login|signin|sign-in|session|sessions|otp|verify|verify-code|send-code|send-link)(?:\/(?:email|password|otp|code|verify|send))?\/?$/iu.test(
      url.pathname,
    )
  )
    return true;
  const host = url.hostname;
  if (/^(?:www\.)?amazon\.(?:com|co\.uk|ca|de|fr|co\.jp|com\.au)$/u.test(host))
    return /^\/ap\/(?:signin|mfa|cvf)\/?$/u.test(url.pathname);
  if (host === 'resy.com' || host === 'widgets.resy.com' || host === 'api.resy.com')
    return /^\/(?:3\/)?auth\/(?:password|otp|verify|login)\/?$/u.test(url.pathname);
  if (host === 'www.exploretock.com' || host === 'exploretock.com')
    return /^\/(?:api\/)?(?:login|signin|auth\/login|auth\/verify)\/?$/u.test(url.pathname);
  if (host === 'www.opentable.com' || host === 'opentable.com')
    return /^\/(?:profile\/)?(?:signin|login|authentication\/verify)\/?$/u.test(url.pathname);
  return false;
}

/** Positive POST endpoint plus actual field structure; a sign-in label alone has no authority. */
export async function inspectAuthenticationControl(
  element: ElementHandle,
): Promise<AuthenticationFormSignature | undefined> {
  const frame = await element.ownerFrame();
  const origin = frame && httpsOrigin(frame.url());
  if (!frame || !origin) return undefined;
  const native = await inspectNativeAuthenticationControl(element, frame);
  if (!native) return undefined;
  const authenticationSignature = native.facts;
  if (
    authenticationSignature.origin !== origin.origin ||
    !authenticationSignature.submit ||
    authenticationSignature.method.toLowerCase() !== 'post'
  )
    return undefined;
  const action = httpsOrigin(authenticationSignature.action);
  if (!action || action.origin !== origin.origin || !authenticationEndpoint(action)) return undefined;
  const fields = authenticationSignature.fields;
  if (!fields.some((field) => authenticationFieldKind(field))) return undefined;
  if (
    fields.some(
      (field) =>
        /(?:cc-|credit.?card|payment|checkout|order|new-password|security.?question)/iu.test(
          `${field.name} ${field.autocomplete}`,
        ) || ['file', 'image'].includes(field.type),
    )
  )
    return undefined;
  return { origin: origin.origin, action: action.href, frame, element, native };
}

/** Recheck the exact signature and invoke the browser's native submit, bypassing arbitrary onsubmit JS. */
export async function submitAuthenticationForm(
  signature: AuthenticationFormSignature,
  assertActive?: () => Promise<void>,
): Promise<boolean> {
  if (httpsOrigin(signature.frame.url())?.origin !== signature.origin) return false;
  if ((await signature.element.ownerFrame()) !== signature.frame) return false;
  return submitNativeAuthenticationForm(signature.frame, signature.native, assertActive);
}
