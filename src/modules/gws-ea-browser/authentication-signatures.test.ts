import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import {
  browserDiagnosticsUnsafe,
  codeFieldFits,
  credentialFieldFits,
  httpsOrigin,
  entryRefusal,
} from './authentication-signatures.js';

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

it('fits each credential role to its input type: passwords only to masked fields, never current and new crossed', () => {
  const facts = (type: string, autocomplete = '') => ({ type, autocomplete });
  for (const type of ['email', 'text', 'tel'])
    expect(credentialFieldFits('username', facts(type), 'signup')).toBe(true);
  expect(credentialFieldFits('username', facts('password'), 'signup')).toBe(false);
  for (const role of ['new_password', 'confirmation'] as const) {
    expect(credentialFieldFits(role, facts('password'), 'signup')).toBe(true);
    expect(credentialFieldFits(role, facts('password', 'new-password'), 'rotation')).toBe(true);
    // A show-password toggle or an unmasked field would put the generated password on screen.
    expect(credentialFieldFits(role, facts('text', 'new-password'), 'signup')).toBe(false);
    expect(credentialFieldFits(role, facts('password', 'current-password'), 'rotation')).toBe(false);
  }
  expect(credentialFieldFits('current_password', facts('password'), 'rotation')).toBe(true);
  expect(credentialFieldFits('current_password', facts('password', 'current-password'), 'rotation')).toBe(true);
  expect(credentialFieldFits('current_password', facts('text', 'current-password'), 'rotation')).toBe(false);
  expect(credentialFieldFits('current_password', facts('password', 'new-password'), 'rotation')).toBe(false);
  expect(credentialFieldFits('current_password', facts('password'), 'signup')).toBe(false);
  for (const role of ['username', 'new_password', 'confirmation', 'current_password'] as const)
    expect(credentialFieldFits(role, facts(role === 'username' ? 'text' : 'password', 'cc-csc'), 'rotation')).toBe(
      false,
    );
});

it('lets the host enter an emailed code into any text field, never a card or credential field', () => {
  const facts = (type: string, autocomplete = '') => ({ type, autocomplete });
  for (const type of ['text', 'tel', 'number', 'password', 'email', 'search'])
    expect(codeFieldFits(facts(type))).toBe(true);
  expect(codeFieldFits(facts('text', 'one-time-code'))).toBe(true);
  for (const type of ['hidden', 'checkbox', 'file', 'submit']) expect(codeFieldFits(facts(type))).toBe(false);
  for (const autocomplete of ['cc-number', 'new-password', 'current-password'])
    expect(codeFieldFits(facts('text', autocomplete))).toBe(false);
});
