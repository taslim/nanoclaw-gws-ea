import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import {
  authenticationEndpoint,
  authenticationFieldKind,
  browserDiagnosticsUnsafe,
  httpsOrigin,
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
