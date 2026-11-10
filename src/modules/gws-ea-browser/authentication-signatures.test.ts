import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import {
  authenticationFieldKind,
  browserDiagnosticsUnsafe,
  credentialFieldFits,
  httpsOrigin,
  entryRefusal,
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

it('keeps unsupported Playwright internals and page-world submission out of authentication', async () => {
  const source = await readFile(new URL('./authentication-submit.ts', import.meta.url), 'utf8');
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

it('lets the agent type a code into any field, never card details, credentials or a password into a masked one', () => {
  const field = (facts: Partial<Parameters<typeof entryRefusal>[0]>) => ({
    card: false,
    credential: false,
    masked: false,
    ...facts,
  });
  for (const code of ['552913', '5', 'A7KX29', 'abcdefghij'])
    for (const facts of [field({}), field({ masked: true })]) expect(entryRefusal(facts, code)).toBeUndefined();
  expect(entryRefusal(field({}), 'Tr0ub4dor&3 is long')).toBeUndefined();
  for (const value of ['Tr0ub4dor&3', 'abcdefghijk', '5529 13', 'pass-word'])
    expect(entryRefusal(field({ masked: true }), value)).toBe('secret_field');
  // A key types no text: Enter and Backspace act on a masked field, never on a credential or card field.
  expect(entryRefusal(field({ masked: true }))).toBeUndefined();
  expect(entryRefusal(field({ credential: true }))).toBe('secret_field');
  expect(entryRefusal(field({ credential: true }), '552913')).toBe('secret_field');
  expect(entryRefusal(field({ card: true, masked: true }), '4242')).toBe('card_field');
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
