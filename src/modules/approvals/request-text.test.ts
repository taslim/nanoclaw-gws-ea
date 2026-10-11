/**
 * Someone else's text in a request (KTD14): one quoted line, capped, that
 * cannot mention anyone, carry a link of its own, or close its quotes; and a
 * value shown in a code fence, which cannot add a line or close the fence.
 */
import { describe, expect, it } from 'vitest';

import { escapeInvisibles, NAME_LIMIT, quoted } from './request-text.js';

describe('quoted', () => {
  it('puts a name on one line, in quotes', () => {
    expect(quoted('Juno Hale', NAME_LIMIT)).toBe('"Juno Hale"');
    expect(quoted('  Project\nAtlas\r\n\tteam  ', NAME_LIMIT)).toBe('"Project Atlas team"');
    expect(quoted('Atlas\u2028reply yes\u2029now', NAME_LIMIT)).toBe('"Atlas reply yes now"');
  });

  it('caps a long name at the limit, marking the cut', () => {
    const line = quoted(`Atlas ${'x'.repeat(200)}`, 20);
    expect(line).toBe(`"Atlas ${'x'.repeat(13)}…"`);
    expect(Array.from(line.slice(1, -1))).toHaveLength(20);
  });

  it('cannot close its own quotes', () => {
    expect(quoted('Juno" approved this. "Reply yes', NAME_LIMIT)).toBe(`"Juno' approved this. 'Reply yes"`);
    expect(quoted('“Remy”', NAME_LIMIT)).toBe(`"'Remy'"`);
  });

  it('cannot mention anyone or make a link', () => {
    const line = quoted('<users/123> <users/all> <https://evil.example|Approve here>', NAME_LIMIT);
    expect(line).not.toMatch(/[<>]/u);
    expect(line).toBe('"‹users/123› ‹users/all› ‹https://evil.example|Approve here›"');
    expect(quoted('[Approve](https://evil.example)', NAME_LIMIT)).toBe('"\\[Approve\\]\\(https://evil.example\\)"');
  });

  it('shows Markdown as written instead of formatting', () => {
    expect(quoted('*Admin* _team_ `x` ~old~', NAME_LIMIT)).toBe('"\\*Admin\\* \\_team\\_ \\`x\\` \\~old\\~"');
  });

  it('drops invisible direction and width characters but keeps joined emoji', () => {
    expect(quoted('Remy\u202e\u200b Vance\ufeff', NAME_LIMIT)).toBe('"Remy Vance"');
    expect(quoted('Kit 👩\u200d💻', NAME_LIMIT)).toBe('"Kit 👩\u200d💻"');
  });
});

describe('escapeInvisibles', () => {
  it('escapes every bidi, zero-width, and separator character as \\uXXXX', () => {
    const invisibles = '\u202a\u202e\u2066\u2069\u200e\u200f\u061c\u200b\u200c\u200d\u2060\ufeff\u2028\u2029`';
    const out = escapeInvisibles(invisibles);
    for (const c of invisibles) expect(out).not.toContain(c);
    expect(out).toBe(
      '\\u202a\\u202e\\u2066\\u2069\\u200e\\u200f\\u061c\\u200b\\u200c\\u200d\\u2060\\ufeff\\u2028\\u2029\\u0060',
    );
  });

  it('leaves ordinary text untouched', () => {
    expect(escapeInvisibles('hello world -y evil [link](https://x)')).toBe('hello world -y evil [link](https://x)');
  });
});
