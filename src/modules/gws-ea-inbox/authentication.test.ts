/**
 * Who a message is from, decided only from Gmail's own authentication
 * results (KTD4, R21, R22). These are pure checks on a message's headers.
 */
import { describe, expect, it } from 'vitest';

import { authenticateSender, type AuthContext } from './authentication.js';
import type { MailHeader } from './mime.js';

const PRINCIPAL = 'pat@principal.example';
const CONTEXT: AuthContext = {
  principalAddresses: new Set([PRINCIPAL, 'pat@home.example', 'pat.principal@gmail.com', 'pat@outlook.com']),
};

interface MessageOptions {
  readonly from?: string;
  readonly results?: string;
  readonly extra?: readonly MailHeader[];
  /** Headers the sender wrote above the From line, under Gmail's block. */
  readonly senderHeaders?: readonly MailHeader[];
  /** Leave Gmail's own Authentication-Results out. */
  readonly withoutGmailResults?: boolean;
}

function results(domain: string, selector: string, dmarc = 'pass', dkim = 'pass'): string {
  return (
    `mx.google.com;\r\n       dkim=${dkim} header.i=@${domain} header.s=${selector} header.b=AbCdEf;\r\n` +
    `       spf=pass (google.com: domain of x@${domain} designates 192.0.2.1 as permitted sender) smtp.mailfrom=x@${domain};\r\n` +
    `       dmarc=${dmarc} (p=REJECT sp=REJECT dis=NONE) header.from=${domain}`
  );
}

function message(options: MessageOptions = {}): MailHeader[] {
  const gmail: MailHeader[] = [
    { name: 'Delivered-To', value: 'robin@assistant.example' },
    { name: 'Received', value: 'by 2002:a05:6a10:1234 with SMTP id abc; Wed, 7 Oct 2026 10:00:00 -0700' },
    { name: 'X-Received', value: 'by 2002:a17:90a:1 with SMTP id def; Wed, 7 Oct 2026 10:00:00 -0700' },
    { name: 'ARC-Seal', value: 'i=1; a=rsa-sha256; t=1; cv=none; d=google.com; s=arc-20240605; b=xyz' },
    { name: 'Return-Path', value: '<pat@principal.example>' },
    {
      name: 'Received',
      value: 'from mail-sor-f41.google.com (mail-sor-f41.google.com. [209.85.220.41]) by mx.google.com with SMTPS id x',
    },
    { name: 'Received-SPF', value: 'pass (google.com: domain of pat@principal.example designates 209.85.220.41)' },
  ];
  if (!options.withoutGmailResults) {
    gmail.push({ name: 'Authentication-Results', value: options.results ?? results('principal.example', 'google') });
  }
  return [
    ...gmail,
    ...(options.senderHeaders ?? []),
    { name: 'DKIM-Signature', value: 'v=1; a=rsa-sha256; d=principal.example; s=google; b=abc' },
    { name: 'From', value: options.from ?? `Pat Principal <${PRINCIPAL}>` },
    { name: 'To', value: 'Robin <robin@assistant.example>' },
    { name: 'Subject', value: 'Hello' },
    { name: 'Message-ID', value: '<one@principal.example>' },
    ...(options.extra ?? []),
  ];
}

describe('the principal', () => {
  it("is recognized from Gmail's topmost result with a DKIM pass from their address's own domain and a DMARC pass", () => {
    expect(authenticateSender(message(), CONTEXT)).toEqual({
      kind: 'principal',
      address: PRINCIPAL,
      displayName: 'Pat Principal',
    });
  });

  it.each([
    ['a Google Workspace domain', 'pat@home.example', 'google'],
    ['Gmail', 'pat.principal@gmail.com', '20230601'],
    ['Outlook', 'pat@outlook.com', 'selector1'],
    ['Microsoft 365 on its own domain', 'pat@home.example', 'selector2'],
  ])('is recognized on %s, whatever selector the domain signs with', (_label, address, selector) => {
    const domain = address.slice(address.indexOf('@') + 1);
    expect(
      authenticateSender(message({ from: `Pat <${address}>`, results: results(domain, selector) }), CONTEXT),
    ).toMatchObject({ kind: 'principal', address });
  });

  it('accepts a Sender equal to From', () => {
    expect(authenticateSender(message({ extra: [{ name: 'Sender', value: `<${PRINCIPAL}>` }] }), CONTEXT).kind).toBe(
      'principal',
    );
  });

  it.each<[string, MessageOptions]>([
    [
      'a forged result lower in the message, with no result of Gmail above it',
      {
        withoutGmailResults: true,
        extra: [{ name: 'Authentication-Results', value: results('principal.example', 'google') }],
      },
    ],
    [
      "a forged result written above the sender's headers when Gmail's own says fail",
      {
        results: results('principal.example', 'google', 'fail', 'fail'),
        senderHeaders: [{ name: 'Authentication-Results', value: results('principal.example', 'google') }],
      },
    ],
    [
      'a result from another server',
      { results: results('principal.example', 'google').replace('mx.google.com', 'mx.evil.example') },
    ],
    ['dmarc=bestguesspass', { results: results('principal.example', 'google', 'bestguesspass') }],
    ['dmarc=fail', { results: results('principal.example', 'google', 'fail') }],
    ['a failed DKIM signature', { results: results('principal.example', 'google', 'pass', 'fail') }],
    [
      'a DMARC pass whose only DKIM pass is another domain’s',
      {
        results: results('principal.example', 'google').replace(
          'header.i=@principal.example',
          'header.i=@mailer.example',
        ),
      },
    ],
    [
      'a DMARC pass whose only DKIM pass is a subdomain’s',
      {
        results: results('principal.example', 'google').replace(
          'header.i=@principal.example',
          'header.i=@news.principal.example',
        ),
      },
    ],
    ['a differing Sender', { extra: [{ name: 'Sender', value: 'Bulk <bulk@principal.example>' }] }],
    ['a List-Id', { extra: [{ name: 'List-Id', value: '<team.principal.example>' }] }],
    ['two From mailboxes', { from: `${PRINCIPAL}, other@principal.example` }],
  ])('is unauthenticated, never an ordinary sender, with %s', (_label, options) => {
    expect(authenticateSender(message(options), CONTEXT).kind).toBe('unauthenticated');
  });

  it.each([
    ['a display-name spoof', `"${PRINCIPAL}" <pat@evil.example>`, 'pat@evil.example'],
    ['a lookalike domain', 'Pat <pat@principa1.example>', 'pat@principa1.example'],
    ['a lookalike in another script', 'Pat <pat@prіncipal.example>', 'pat@prіncipal.example'],
  ])('takes %s, signed by its own domain, for its own address and never the principal', (_label, from, address) => {
    const signed = results(address.slice(address.indexOf('@') + 1), 'google');
    expect(authenticateSender(message({ from, results: signed }), CONTEXT)).toMatchObject({
      kind: 'authenticated',
      address,
    });
  });

  it('is unauthenticated when a non-Gmail header sits above the topmost result', () => {
    const headers = message();
    headers.unshift({ name: 'X-Injected', value: 'yes' });
    expect(authenticateSender(headers, CONTEXT).kind).toBe('unauthenticated');
  });
});

describe('Google Calendar notifications', () => {
  const notification = (options: MessageOptions = {}) =>
    message({
      from: 'Google Calendar <calendar-notification@google.com>',
      results: results('google.com', '20230601'),
      ...options,
    });

  it('are recognized with a DKIM and DMARC pass for google.com', () => {
    expect(authenticateSender(notification(), CONTEXT)).toEqual({ kind: 'calendar-notification' });
  });

  it.each<[string, MessageOptions]>([
    ['no DMARC pass', { results: results('google.com', '20230601', 'fail') }],
    ['a pass for another domain', { results: results('evil.example', 's1') }],
    [
      'a DMARC pass whose only DKIM pass is another domain’s',
      { results: results('google.com', '20230601').replace('header.i=@google.com', 'header.i=@mailer.example') },
    ],
    ['a differing Sender', { extra: [{ name: 'Sender', value: 'someone@google.com' }] }],
  ])('are unauthenticated, never an ordinary sender, with %s', (_label, options) => {
    expect(authenticateSender(notification(options), CONTEXT).kind).toBe('unauthenticated');
  });
});

describe('anyone else', () => {
  it('is authenticated by a DMARC pass for its From domain', () => {
    expect(
      authenticateSender(message({ from: 'Sam <sam@acme.example>', results: results('acme.example', 's1') }), CONTEXT),
    ).toEqual({ kind: 'authenticated', address: 'sam@acme.example', displayName: 'Sam' });
  });

  it('is authenticated by an aligned DKIM pass when the domain publishes no DMARC policy', () => {
    const verdict = authenticateSender(
      message({ from: 'sam@mail.acme.example', results: results('acme.example', 's1', 'bestguesspass') }),
      CONTEXT,
    );
    expect(verdict).toMatchObject({ kind: 'authenticated', address: 'sam@mail.acme.example' });
  });

  it.each<[string, MessageOptions]>([
    [
      'a spoofed From on a domain without DMARC enforcement',
      {
        from: 'Boss <boss@lax.example>',
        results:
          'mx.google.com; spf=softfail (google.com: domain of transitioning boss@lax.example does not designate 198.51.100.7) smtp.mailfrom=boss@lax.example; dmarc=bestguesspass header.from=lax.example',
      },
    ],
    [
      'a DKIM pass for an unaligned domain',
      { from: 'sam@acme.example', results: results('mailer.example', 's1', 'none') },
    ],
    [
      'dmarc=bestguesspass alone',
      { from: 'sam@acme.example', results: results('acme.example', 's1', 'bestguesspass', 'none') },
    ],
  ])('is not authenticated with %s', (_label, options) => {
    expect(authenticateSender(message(options), CONTEXT).kind).toBe('unauthenticated');
  });
});
