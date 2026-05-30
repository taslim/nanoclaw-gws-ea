import { describe, it, expect } from 'vitest';

import {
  classifyEmailRoute,
  extractAllParticipants,
  extractEmailAddress,
  isRelevantEmail,
  type ParsedEmail,
} from './classify.js';

const PRINCIPAL = new Set(['principal@example.com', 'principal-work@example.com']);
const ASSISTANT = 'assistant@example.com';
const PRINCIPAL_NAME = 'Pat Principal';

function email(overrides: Partial<ParsedEmail> = {}): ParsedEmail {
  return {
    from: 'principal@example.com',
    to: 'assistant@example.com',
    cc: '',
    subject: 'hello',
    body: 'body',
    ...overrides,
  };
}

describe('extractEmailAddress', () => {
  it('extracts from "Name <addr>" format', () => {
    expect(extractEmailAddress('Pat <principal@example.com>')).toBe('principal@example.com');
  });

  it('returns input when there are no angle brackets', () => {
    expect(extractEmailAddress('principal@example.com')).toBe('principal@example.com');
  });
});

describe('extractAllParticipants', () => {
  it('lowercases and dedupes from/to/cc', () => {
    const result = extractAllParticipants(
      email({
        from: 'Pat <Principal@example.com>',
        to: 'Bot <assistant@example.com>',
        cc: 'principal@example.com',
      }),
    );
    expect(result.sort()).toEqual(['assistant@example.com', 'principal@example.com']);
  });

  it('parses comma-separated addresses', () => {
    const result = extractAllParticipants(email({ to: 'a@x.com, b@x.com', cc: 'c@x.com' }));
    expect(result).toContain('a@x.com');
    expect(result).toContain('b@x.com');
    expect(result).toContain('c@x.com');
  });
});

describe('classifyEmailRoute', () => {
  it('routes principal → assistant only as principal', () => {
    expect(classifyEmailRoute(email({ from: 'principal@example.com' }), PRINCIPAL, ASSISTANT)).toBe('principal');
  });

  it('routes principal-sent mail with externals on cc as external', () => {
    // Principal IS the sender, but a third party shares the thread —
    // shouldn't see principal-trust replies.
    expect(
      classifyEmailRoute(
        email({
          from: 'principal@example.com',
          to: 'assistant@example.com',
          cc: 'other@external.com',
        }),
        PRINCIPAL,
        ASSISTANT,
      ),
    ).toBe('external');
  });

  it('routes externally-sent mail as external', () => {
    expect(
      classifyEmailRoute(email({ from: 'someone@external.com', cc: 'principal@example.com' }), PRINCIPAL, ASSISTANT),
    ).toBe('external');
  });

  it('handles "Name <addr>" headers', () => {
    expect(
      classifyEmailRoute(
        email({ from: 'Pat P <principal@example.com>', to: 'Bot <assistant@example.com>' }),
        PRINCIPAL,
        ASSISTANT,
      ),
    ).toBe('principal');
  });

  it('treats principal-to-principal (multiple addresses) as principal', () => {
    expect(
      classifyEmailRoute(
        email({
          from: 'principal@example.com',
          to: 'principal-work@example.com',
          cc: 'assistant@example.com',
        }),
        PRINCIPAL,
        ASSISTANT,
      ),
    ).toBe('principal');
  });
});

describe('isRelevantEmail', () => {
  it('keeps principal-sent mail', () => {
    expect(isRelevantEmail(email(), PRINCIPAL, PRINCIPAL_NAME)).toBe(true);
  });

  it('keeps mail addressed to principal', () => {
    expect(
      isRelevantEmail(
        email({ from: 'sender@x.com', to: 'principal@example.com', subject: 'random', body: '' }),
        PRINCIPAL,
        PRINCIPAL_NAME,
      ),
    ).toBe(true);
  });

  it('keeps mail mentioning principal name', () => {
    expect(
      isRelevantEmail(
        email({ from: 'sender@x.com', to: 'someone@x.com', subject: 'about Pat' }),
        PRINCIPAL,
        PRINCIPAL_NAME,
      ),
    ).toBe(true);
  });

  it('drops obvious newsletters', () => {
    expect(
      isRelevantEmail(
        email({ from: 'noreply@brand.com', subject: 'weekly newsletter', body: 'unsubscribe' }),
        PRINCIPAL,
        PRINCIPAL_NAME,
      ),
    ).toBe(false);
  });

  it('drops shipping notifications even when principal is in to', () => {
    // Principal-in-recipients overrides noise filter — known false positive,
    // matches v1 behavior. Locked in by test so future tightening is explicit.
    expect(
      isRelevantEmail(
        email({
          from: 'noreply@store.com',
          to: 'principal@example.com',
          subject: 'shipping notification',
        }),
        PRINCIPAL,
        PRINCIPAL_NAME,
      ),
    ).toBe(true);
  });

  it('drops mail from no-reply with no principal connection', () => {
    expect(
      isRelevantEmail(
        email({ from: 'no-reply@x.com', to: 'someone@y.com', subject: 'ad', body: 'buy stuff' }),
        PRINCIPAL,
        PRINCIPAL_NAME,
      ),
    ).toBe(false);
  });
});
