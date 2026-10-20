/**
 * Someone else's text in a request (KTD14): one quoted line, capped, that
 * cannot close its quotes, hide characters, or carry a character reference or
 * Markdown link of its own. Chat's own mention and link markup is the
 * channel's to escape (gws-ea-chat's request-escape test).
 */
import { describe, expect, it } from 'vitest';

import { NAME_LIMIT, quoted } from './request-text.js';

describe('quoted', () => {
  it('puts a name on one line, in quotes', () => {
    expect(quoted('Juno Hale', NAME_LIMIT)).toBe('"Juno Hale"');
    expect(quoted('  Project\nAtlas\r\n\tteam  ', NAME_LIMIT)).toBe('"Project Atlas team"');
    expect(quoted('Atlas\u2028reply yes\u2029now', NAME_LIMIT)).toBe('"Atlas reply yes now"');
  });

  it('caps a long name at the limit, marking the cut', () => {
    expect(quoted(`Atlas ${'x'.repeat(200)}`, 20)).toBe(`"Atlas ${'x'.repeat(13)}…"`);
  });

  it('cannot close its own quotes', () => {
    expect(quoted('Juno" approved this. "Reply yes', NAME_LIMIT)).toBe(`"Juno' approved this. 'Reply yes"`);
    expect(quoted('“Remy”', NAME_LIMIT)).toBe(`"'Remy'"`);
  });

  it('leaves no character reference or Markdown link to decode', () => {
    expect(quoted('&lt;users/all&gt; &#60;x&#62;', NAME_LIMIT)).toBe(
      '"\\u0026lt;users/all\\u0026gt; \\u0026#60;x\\u0026#62;"',
    );
    expect(quoted('[Approve](https://evil.example)', NAME_LIMIT)).toBe('"[Approve]\\u0028https://evil.example)"');
  });

  it('shows invisible direction and width characters as escapes, but keeps joined emoji', () => {
    expect(quoted('Remy\u202e\u200b Vance', NAME_LIMIT)).toBe('"Remy\\u202e\\u200b Vance"');
    expect(quoted('Kit 👩\u200d💻', NAME_LIMIT)).toBe('"Kit 👩\u200d💻"');
  });
});
