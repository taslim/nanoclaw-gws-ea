import type { ElementHandle, Frame } from 'playwright-core';
import { httpsOrigin, type BrowserSecretField } from './onepassword.js';

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
  const authenticationSignature = await element.evaluate((node) => {
    const e = node as unknown as {
      tagName: string;
      type?: string;
      disabled?: boolean;
      form?: {
        action: string;
        method: string;
        target: string;
        elements: ArrayLike<{ name?: string; type?: string; getAttribute(name: string): string | null }>;
      };
    };
    const form = e.form;
    return form
      ? {
          action: form.action,
          method: form.method,
          submit:
            !e.disabled &&
            (e.tagName === 'BUTTON' ? !e.type || e.type === 'submit' : e.tagName === 'INPUT' && e.type === 'submit') &&
            (!form.target || form.target === '_self'),
          fields: Array.from(form.elements).map((field) => ({
            name: field.name ?? '',
            type: field.type ?? '',
            autocomplete: field.getAttribute('autocomplete') ?? '',
          })),
        }
      : null;
  });
  if (
    !authenticationSignature ||
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
  return { origin: origin.origin, action: action.href, frame, element };
}

/** Recheck the exact signature and invoke the browser's native submit, bypassing arbitrary onsubmit JS. */
export async function submitAuthenticationForm(
  signature: AuthenticationFormSignature,
  assertActive?: () => Promise<void>,
): Promise<boolean> {
  if (httpsOrigin(signature.frame.url())?.origin !== signature.origin) return false;
  const current = await inspectAuthenticationControl(signature.element);
  if (
    !current ||
    current.frame !== signature.frame ||
    current.origin !== signature.origin ||
    current.action !== signature.action
  )
    return false;
  await assertActive?.();
  if (httpsOrigin(signature.frame.url())?.origin !== signature.origin) return false;
  return signature.element.evaluate(
    (node, expected) => {
      const e = node as unknown as {
        form?: { action: string; method: string; target: string };
        ownerDocument: {
          location: { origin: string };
          defaultView: { HTMLFormElement: { prototype: { submit: { call(form: unknown): void } } } };
        };
      };
      const form = e.form;
      if (
        !form ||
        form.action !== expected.action ||
        form.method.toLowerCase() !== 'post' ||
        e.ownerDocument.location.origin !== expected.origin ||
        (form.target && form.target !== '_self')
      )
        return false;
      const nativeSubmit = e.ownerDocument.defaultView.HTMLFormElement.prototype.submit;
      nativeSubmit.call(form);
      return true;
    },
    { origin: signature.origin, action: signature.action },
  );
}
