import { describe, expect, it } from 'vitest';

import { collapseRedundantGchatTokens } from './gchat.js';

describe('collapseRedundantGchatTokens', () => {
  it('collapses bare mailto tokens to the display text', () => {
    const input = 'invite sent to <mailto:someone@example.com|someone@example.com>';
    expect(collapseRedundantGchatTokens(input)).toBe('invite sent to someone@example.com');
  });

  it('collapses bare tel tokens', () => {
    expect(collapseRedundantGchatTokens('<tel:+15551234567|+15551234567>')).toBe('+15551234567');
  });

  it('collapses bare https/http tokens', () => {
    expect(collapseRedundantGchatTokens('<https://example.com|https://example.com>')).toBe('https://example.com');
    expect(collapseRedundantGchatTokens('<http://example.com|http://example.com>')).toBe('http://example.com');
  });

  it('preserves tokens where the display text is intentionally different', () => {
    const link = '<mailto:hi.alfaruq@gmail.com|Faruq>';
    expect(collapseRedundantGchatTokens(link)).toBe(link);
    const url = '<https://example.com|Docs>';
    expect(collapseRedundantGchatTokens(url)).toBe(url);
  });

  it('handles multiple tokens in one string and preserves surrounding text', () => {
    const input =
      'invites sent to <mailto:a@x.com|a@x.com> and <mailto:b@x.com|b@x.com> — see <https://meet.google.com/abc|https://meet.google.com/abc>';
    expect(collapseRedundantGchatTokens(input)).toBe(
      'invites sent to a@x.com and b@x.com — see https://meet.google.com/abc',
    );
  });

  it('is a no-op on plain text', () => {
    const plain = 'invite sent to someone@example.com at https://example.com';
    expect(collapseRedundantGchatTokens(plain)).toBe(plain);
  });

  it('is idempotent — re-applying does not further change a cleaned string', () => {
    const input = 'a <mailto:x@y.com|x@y.com> b <mailto:p@q.com|Custom> c';
    const once = collapseRedundantGchatTokens(input);
    expect(collapseRedundantGchatTokens(once)).toBe(once);
  });

  it('does not touch GChat tokens we do not own (user mentions, bold, etc.)', () => {
    const input = '<users/all> *Sweep 9:00am* _italic_ ~strike~';
    expect(collapseRedundantGchatTokens(input)).toBe(input);
  });
});
