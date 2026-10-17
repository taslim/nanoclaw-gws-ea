import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import {
  authenticationEndpoint,
  authenticationFieldKind,
  browserDiagnosticsUnsafe,
  credentialFieldFits,
  httpsOrigin,
  isSensitiveField,
} from './authentication-signatures.js';

it('recognizes credential fields without granting card, new-password or security fields authority', () => {
  expect(authenticationFieldKind({ name: 'username', type: 'text', autocomplete: 'username' })).toBe('username');
  expect(authenticationFieldKind({ name: 'password', type: 'password', autocomplete: 'current-password' })).toBe(
    'password',
  );
  expect(authenticationFieldKind({ name: 'code', type: 'text', autocomplete: 'one-time-code' })).toBe('otp');
  for (const autocomplete of ['cc-number', 'cc-csc', 'new-password'])
    expect(authenticationFieldKind({ name: 'password', type: 'password', autocomplete })).toBeUndefined();
  expect(authenticationFieldKind({ name: 'security_question', type: 'text', autocomplete: '' })).toBeUndefined();
});

it('uses positive native endpoints and refuses arbitrary JS-only, financial and insecure flows', () => {
  for (const url of [
    'https://shop.example/login',
    'https://shop.example/auth/login',
    'https://www.amazon.com/ap/signin',
    'https://api.resy.com/3/auth/password',
    'https://www.exploretock.com/auth/verify',
    'https://www.opentable.com/profile/signin',
  ])
    expect(authenticationEndpoint(new URL(url))).toBe(true);
  for (const url of [
    'http://shop.example/login',
    'https://shop.example/checkout',
    'https://shop.example/update-password',
    'https://shop.example/signin?operation=buy',
    'https://shop.example/unreviewed-action',
  ])
    expect(authenticationEndpoint(new URL(url))).toBe(false);
});

it('keeps exact-node handoff in a fixed isolated selector and submission in public CDP', async () => {
  const source = await readFile(new URL('./authentication-submit.ts', import.meta.url), 'utf8');
  expect(source).toContain('selectors.register(name, selectorSource, { contentScript: true })');
  expect(source).toContain("session.send('DOM.resolveNode'");
  expect(source).toContain("session.send('Runtime.callFunctionOn'");
  expect(source).not.toMatch(/\._(?:objectId|channel|connection|sessions)\b|\bFetch\./u);
  expect(source).not.toMatch(/\belement\.evaluate\s*\(|\belement\.dispatchEvent\s*\(/u);
});

it('accepts only credential-free HTTPS origins', () => {
  expect(httpsOrigin('https://shop.example/login')?.origin).toBe('https://shop.example');
  for (const raw of ['http://shop.example/login', 'https://user:pass@shop.example/', 'not a url', 'data:text/html,x'])
    expect(httpsOrigin(raw)).toBeUndefined();
});

it('treats Playwright protocol logging as unsafe for sign-in', () => {
  expect(browserDiagnosticsUnsafe({})).toBe(false);
  expect(browserDiagnosticsUnsafe({ PWDEBUG: '0', DEBUG: 'app:*,-pw:api' })).toBe(false);
  for (const environment of [{ PWDEBUG: '1' }, { DEBUG: 'pw:protocol' }, { DEBUG: 'app pw:*' }, { DEBUG: '*' }])
    expect(browserDiagnosticsUnsafe(environment)).toBe(true);
});

it('treats every password-bearing field as secret, including a show-password toggle that made it text', () => {
  const field = (facts: Partial<Parameters<typeof isSensitiveField>[0]>) => ({
    type: 'text',
    autocomplete: '',
    name: '',
    ...facts,
  });
  for (const facts of [
    field({ type: 'password' }),
    field({ autocomplete: 'new-password' }),
    field({ autocomplete: 'current-password' }),
    field({ name: 'confirm_password' }),
    field({ name: 'passwordConfirmation' }),
    field({ id: 'new-pwd' }),
    field({ label: 'Repeat passphrase' }),
    field({ autocomplete: 'one-time-code' }),
    field({ autocomplete: 'cc-number' }),
    field({ name: 'cvv' }),
  ])
    expect(isSensitiveField(facts)).toBe(true);
  for (const facts of [
    field({ name: 'email', type: 'email', autocomplete: 'email' }),
    field({ name: 'passenger_name' }),
    field({ name: 'compass_heading' }),
    field({ name: 'first_name', autocomplete: 'given-name' }),
  ])
    expect(isSensitiveField(facts)).toBe(false);
});

it('fits credential roles only to fields whose structure supports them, never current and new interchangeably', () => {
  const facts = (name: string, type = 'password', autocomplete = '', id = '') => ({ name, type, autocomplete, id });
  expect(credentialFieldFits('username', facts('email', 'email', 'email'), 'signup', false)).toBe(true);
  expect(credentialFieldFits('username', facts('user[email]', 'text'), 'signup', false)).toBe(true);
  expect(credentialFieldFits('username', facts('first_name', 'text', 'given-name'), 'signup', false)).toBe(false);
  // A signup's single unmarked password field is the new password; a toggled one stays a password field.
  expect(credentialFieldFits('new_password', facts('password'), 'signup', false)).toBe(true);
  expect(credentialFieldFits('new_password', facts('password', 'text', 'new-password'), 'signup', false)).toBe(true);
  expect(credentialFieldFits('confirmation', facts('password_confirmation'), 'signup', false)).toBe(true);
  expect(credentialFieldFits('new_password', facts('nickname', 'text'), 'signup', false)).toBe(false);
  // A change binds the current password only to a current field, and the new one only to a new or confirming field.
  expect(credentialFieldFits('current_password', facts('old_password'), 'rotation', false)).toBe(true);
  expect(credentialFieldFits('current_password', facts('pw', 'password', 'current-password'), 'rotation', false)).toBe(
    true,
  );
  expect(credentialFieldFits('new_password', facts('new_password1'), 'rotation', true)).toBe(true);
  expect(credentialFieldFits('confirmation', facts('new_password2'), 'rotation', true)).toBe(true);
  expect(credentialFieldFits('new_password', facts('current_password'), 'rotation', true)).toBe(false);
  expect(credentialFieldFits('current_password', facts('new_password'), 'rotation', false)).toBe(false);
  expect(credentialFieldFits('current_password', facts('old_password'), 'signup', false)).toBe(false);
  // An unmarked field in a change form is new only beside a bound current field.
  expect(credentialFieldFits('new_password', facts('password'), 'rotation', false)).toBe(false);
  expect(credentialFieldFits('new_password', facts('password'), 'rotation', true)).toBe(true);
  for (const role of ['new_password', 'confirmation', 'current_password'] as const) {
    expect(credentialFieldFits(role, facts('password', 'password', 'cc-number'), 'rotation', true)).toBe(false);
    expect(credentialFieldFits(role, facts('code', 'text', 'one-time-code'), 'rotation', true)).toBe(false);
    expect(credentialFieldFits(role, facts('security_question_answer'), 'rotation', true)).toBe(false);
  }
});
