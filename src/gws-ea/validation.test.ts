import { describe, expect, it } from 'vitest';

import { GwsEaError } from './types.js';
import {
  canonicalTimestamp,
  EMAIL_PATTERN,
  hasControlCharacters,
  principalAddressConflict,
  principalAddressesConflict,
  principalMatchKey,
  requireCanonicalTimestamp,
  requireDockerEndpoint,
  requirePath,
  requireString,
  resolvePrincipalAddress,
  unixSocketPath,
} from './validation.js';

/** Every reader raises the code its caller names. */
const CODE = 'invalid_test_input';

describe('GWS-EA shared validation', () => {
  describe('canonical timestamps', () => {
    const written = '2026-09-25T10:00:00.000Z';

    it('accepts a timestamp exactly as Date#toISOString writes it', () => {
      expect(new Date(written).toISOString()).toBe(written);
      expect(canonicalTimestamp(written)).toBe(written);
      expect(requireCanonicalTimestamp(written, CODE, 'Stamp is invalid')).toBe(written);
    });

    it.each([
      ['without milliseconds', '2026-09-25T10:00:00Z'],
      ['with a zero offset', '2026-09-25T10:00:00.000+00:00'],
      ['with an offset naming the same instant', '2026-09-25T12:00:00.000+02:00'],
      ['with a lowercase zone', '2026-09-25T10:00:00.000z'],
      ['with a space for its separator', '2026-09-25 10:00:00.000Z'],
      ['as a date only', '2026-09-25'],
      ['on a day its month does not have', '2026-02-30T10:00:00.000Z'],
      ['that is not a date', 'not a date'],
    ])('rejects a timestamp %s', (_form, value) => {
      expect(canonicalTimestamp(value)).toBeUndefined();
      expect(() => requireCanonicalTimestamp(value, CODE, 'Stamp is invalid')).toThrow(
        new GwsEaError(CODE, 'Stamp is invalid'),
      );
    });

    it('rejects a value that is not a string, even a Date', () => {
      for (const value of [undefined, null, Date.parse(written), new Date(written)]) {
        expect(canonicalTimestamp(value)).toBeUndefined();
      }
    });
  });

  describe('requireString', () => {
    const invalid = new GwsEaError(CODE, 'Name is invalid');

    it('accepts a string up to its limit: 2048 characters unless the caller sets one', () => {
      expect(requireString('x'.repeat(2_048), 'Name', CODE)).toHaveLength(2_048);
      expect(requireString('abc', 'Name', CODE, 3)).toBe('abc');
    });

    it('rejects an empty, overlong, control-character, or non-string value', () => {
      expect(() => requireString('', 'Name', CODE)).toThrow(invalid);
      expect(() => requireString('x'.repeat(2_049), 'Name', CODE)).toThrow(invalid);
      expect(() => requireString('abcd', 'Name', CODE, 3)).toThrow(invalid);
      expect(() => requireString('Aya\tPrincipal', 'Name', CODE)).toThrow(invalid);
      expect(() => requireString(42, 'Name', CODE)).toThrow(invalid);
      expect(() => requireString(null, 'Name', CODE)).toThrow(invalid);
    });
  });

  describe('requirePath', () => {
    it('accepts an absolute, normalized path', () => {
      expect(requirePath('/var/lib/nanoclaw', 'Data path', CODE)).toBe('/var/lib/nanoclaw');
      expect(requirePath('/', 'Data path', CODE)).toBe('/');
    });

    it.each([
      ['a relative path', 'var/lib/nanoclaw'],
      ['a dot-relative path', './nanoclaw'],
      ['a parent segment', '/var/lib/../nanoclaw'],
      ['a current-directory segment', '/var/./lib'],
      ['a doubled separator', '/var//lib'],
      ['a trailing separator', '/var/lib/'],
    ])('rejects %s', (_form, value) => {
      expect(() => requirePath(value, 'Data path', CODE)).toThrow(
        new GwsEaError(CODE, 'Data path must be an absolute normalized path'),
      );
    });

    it('rejects an empty path, or one with a control character, as an invalid string', () => {
      const invalid = new GwsEaError(CODE, 'Data path is invalid');
      expect(() => requirePath('', 'Data path', CODE)).toThrow(invalid);
      expect(() => requirePath('/var/lib\n/nanoclaw', 'Data path', CODE)).toThrow(invalid);
    });
  });

  describe('Docker endpoints', () => {
    const local = 'unix:///var/run/docker.sock';

    it('reads the socket path of a local unix:// endpoint and records the endpoint as given', () => {
      expect(unixSocketPath(local)).toBe('/var/run/docker.sock');
      expect(requireDockerEndpoint(local, 'Docker endpoint', CODE)).toBe(local);
    });

    it.each([
      ['a tcp:// daemon', 'tcp://127.0.0.1:2375'],
      ['an ssh:// daemon', 'ssh://operator@build-host'],
      ['a Windows named pipe', 'npipe:////./pipe/docker_engine'],
      ['a bare socket path', '/var/run/docker.sock'],
      ['a relative socket', 'unix://docker.sock'],
      ['a unix:// scheme with no socket', 'unix://'],
      ['an uppercase scheme', 'UNIX:///var/run/docker.sock'],
    ])('refuses %s', (_form, endpoint) => {
      expect(unixSocketPath(endpoint)).toBeUndefined();
      expect(() => requireDockerEndpoint(endpoint, 'Docker endpoint', CODE)).toThrow(
        new GwsEaError(CODE, 'Docker endpoint must be a local unix:// socket'),
      );
    });

    it('refuses a socket path with a control character', () => {
      const endpoint = 'unix:///var/run/docker\n.sock';
      expect(unixSocketPath(endpoint)).toBeUndefined();
      expect(() => requireDockerEndpoint(endpoint, 'Docker endpoint', CODE)).toThrow(
        new GwsEaError(CODE, 'Docker endpoint is invalid'),
      );
    });
  });

  describe('hasControlCharacters', () => {
    it.each([
      ['NUL', '\0'],
      ['a tab', '\t'],
      ['a newline', '\n'],
      ['a carriage return', '\r'],
      ['a terminal escape', '\u001b[31m'],
      ['the last C0 control', '\u001f'],
      ['DEL', '\u007f'],
      ['a C1 control sequence introducer', '\u009b31m'],
      ['the last C1 control', '\u009f'],
    ])('flags %s', (_character, value) => {
      expect(hasControlCharacters(`Aya${value}`)).toBe(true);
    });

    it('passes empty, printable ASCII, and non-ASCII text', () => {
      expect(hasControlCharacters('')).toBe(false);
      expect(hasControlCharacters(' ~ Principal <principal@example.com>')).toBe(false);
      expect(hasControlCharacters('Ünïcødé 名前 😀')).toBe(false);
    });
  });

  describe('EMAIL_PATTERN', () => {
    it.each(['assistant@example.com', 'first.last+tag@mail.example.co.uk'])('matches %s', (email) => {
      expect(EMAIL_PATTERN.test(email)).toBe(true);
    });

    it.each([
      ['no local part', '@example.com'],
      ['no dot in its domain', 'assistant@example'],
      ['nothing between the @ and the dot', 'assistant@.com'],
      ['nothing after the last dot', 'assistant@example.'],
      ['two @ signs', 'assistant@team@example.com'],
      ['inner whitespace', 'assistant example@example.com'],
      ['a trailing newline', 'assistant@example.com\n'],
    ])('rejects an address with %s', (_form, email) => {
      expect(EMAIL_PATTERN.test(email)).toBe(false);
    });
  });

  describe("the principal's addresses (R1)", () => {
    const LISTED = ['firstlast@gmail.com', 'pat@corp.example'];

    it.each([
      ['a Gmail address with dots, a +tag and capitals', 'First.Last+news@gmail.com', 'firstlast@gmail.com'],
      ['the googlemail spelling', 'first.last@googlemail.com', 'firstlast@gmail.com'],
      ['another domain in other capitals', 'Pat@Corp.Example', 'pat@corp.example'],
      ['the listed spelling itself', 'pat@corp.example', 'pat@corp.example'],
    ])('resolves %s to the spelling the principal listed', (_case, address, listed) => {
      expect(resolvePrincipalAddress(address, LISTED)).toBe(listed);
    });

    it.each([
      ['a +tag at another domain', 'pat+x@corp.example'],
      ['dots at another domain', 'p.at@corp.example'],
      ['a subdomain of gmail.com', 'firstlast@sub.gmail.com'],
      ['a domain that only starts with gmail.com', 'firstlast@gmail.com.evil.example'],
      ['a lookalike with a Cyrillic letter', 'firstlаst@gmail.com'],
      ['padding', ' pat@corp.example'],
    ])('resolves %s to none of them', (_case, address) => {
      expect(resolvePrincipalAddress(address, LISTED)).toBeUndefined();
    });

    it('folds only ASCII: a non-ASCII address matches exactly or not at all', () => {
      expect(principalMatchKey('Kate@corp.example')).toBe('Kate@corp.example');
      expect(resolvePrincipalAddress('Kate@corp.example', ['kate@corp.example'])).toBeUndefined();
      expect(resolvePrincipalAddress('ünal@corp.example', ['ünal@corp.example'])).toBe('ünal@corp.example');
      expect(resolvePrincipalAddress('Ünal@corp.example', ['ünal@corp.example'])).toBeUndefined();
    });

    it('keeps a +tag or dots that are all a Gmail handle has, as identityMatchKey does', () => {
      expect(principalMatchKey('+news@gmail.com')).toBe('+news@gmail.com');
      expect(principalMatchKey('...@googlemail.com')).toBe('...@gmail.com');
    });

    it('prefers the spelling written exactly when two listed spellings match', () => {
      expect(resolvePrincipalAddress('first.last@gmail.com', ['firstlast@gmail.com', 'first.last@gmail.com'])).toBe(
        'first.last@gmail.com',
      );
    });

    it("refuses the assistant's own address in any spelling that reaches its mailbox (R3)", () => {
      expect(principalAddressConflict('ea+x@corp.example', [], 'ea@corp.example')).toBe(
        "ea+x@corp.example is the assistant's own address, not one of the principal's",
      );
      expect(principalAddressConflict('e.a@gmail.com', [], 'ea@gmail.com')).toMatch(/assistant's own/u);
      expect(principalAddressConflict('pat@corp.example', [], null)).toBeUndefined();
    });

    it('refuses another spelling of a listed address, naming it, but not the same spelling again (R3)', () => {
      expect(principalAddressConflict('first.last@gmail.com', LISTED, 'ea@corp.example')).toBe(
        "first.last@gmail.com is another spelling of firstlast@gmail.com, already one of the principal's addresses",
      );
      expect(principalAddressConflict('firstlast@gmail.com', LISTED, 'ea@corp.example')).toBeUndefined();
      expect(principalAddressConflict('pat+x@corp.example', LISTED, 'ea@corp.example')).toBeUndefined();
    });

    it('judges each address of a list against those before it', () => {
      expect(principalAddressesConflict(['pat@corp.example', 'pat@corp.example'], 'ea@corp.example')).toBeUndefined();
      expect(principalAddressesConflict(['firstlast@gmail.com', 'first.last@gmail.com'], null)).toBe(
        "first.last@gmail.com is another spelling of firstlast@gmail.com, already one of the principal's addresses",
      );
      expect(principalAddressesConflict(['pat@corp.example', 'EA@corp.example'], 'ea@corp.example')).toMatch(
        /assistant's own/u,
      );
    });
  });
});
