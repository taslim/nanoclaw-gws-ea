/**
 * Who a message is from, decided only from Gmail's own authentication
 * results (KTD4, R21, R22), why a message is not verified, as a fixed code
 * (KTD3), and whether Google signed it (KTD12). These are pure checks on a
 * message's headers.
 */
import { describe, expect, it } from 'vitest';

import { principalRecognizer } from '../gws-ea-profile/db.js';
import {
  authenticateSender,
  dkimAlignedToSite,
  refusedPrincipalAddress,
  signedByGoogle,
  type AuthContext,
  type UnauthenticatedReason,
} from './authentication.js';
import type { MailHeader } from './mime.js';

const PRINCIPAL = 'pat@principal.example';
const CONTEXT: AuthContext = {
  principalAddresses: principalRecognizer([
    PRINCIPAL,
    'pat@home.example',
    'pat.principal@gmail.com',
    'pat@outlook.com',
  ]),
};

describe('browser sign-in mail authentication', () => {
  it('requires Gmail-verified DKIM for the claimed registrable domain, including private domains', () => {
    expect(
      dkimAlignedToSite(
        message({ from: 'login@mail.shop.example', results: results('shop.example', 's1') }),
        'shop.example',
      ),
    ).toBe(true);
    expect(
      dkimAlignedToSite(
        message({ from: 'login@shop.example', results: results('elsewhere.example', 's1') }),
        'shop.example',
      ),
    ).toBe(false);
    expect(
      dkimAlignedToSite(
        message({ from: 'login@shop.example', results: results('shop.example', 's1', 'pass', 'fail') }),
        'shop.example',
      ),
    ).toBe(false);
    expect(
      dkimAlignedToSite(
        message({ from: 'login@lookalike-shop.example', results: results('lookalike-shop.example', 's1') }),
        'shop.example',
      ),
    ).toBe(false);
    expect(
      dkimAlignedToSite(
        message({ from: 'login@other.github.io', results: results('other.github.io', 's1') }),
        'mine.github.io',
      ),
    ).toBe(false);
    expect(
      dkimAlignedToSite(
        message({
          from: 'login@shop.example',
          senderHeaders: [
            { name: 'From', value: 'login@shop.example' },
            { name: 'Authentication-Results', value: results('shop.example', 's1') },
          ],
          withoutGmailResults: true,
        }),
        'shop.example',
      ),
    ).toBe(false);
  });
});

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
    { name: 'Delivered-To', value: 'juno@assistant.example' },
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
    { name: 'To', value: 'Juno <juno@assistant.example>' },
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

  it.each([
    ['dots, a +tag and capitals at Gmail', 'Pat.Principal+news@gmail.com', 'gmail.com'],
    ['the googlemail spelling, signed by googlemail.com', 'PatPrincipal@googlemail.com', 'googlemail.com'],
    ['capitals at another domain', 'Pat@Principal.Example', 'principal.example'],
  ])('is recognized from %s, and named by the address as they listed it (AE1)', (_label, from, domain) => {
    expect(
      authenticateSender(message({ from: `Pat <${from}>`, results: results(domain, '20230601') }), CONTEXT),
    ).toEqual({
      kind: 'principal',
      address: domain === 'principal.example' ? PRINCIPAL : 'pat.principal@gmail.com',
      displayName: 'Pat',
    });
  });

  it('checks the signature for the domain the From is written with', () => {
    // A googlemail From is Gmail's, but only a googlemail.com signature aligns with it.
    expect(
      authenticateSender(
        message({ from: 'Pat <patprincipal@googlemail.com>', results: results('gmail.com', '20230601') }),
        CONTEXT,
      ),
    ).toMatchObject({ kind: 'unauthenticated', address: 'patprincipal@googlemail.com', reason: 'no-own-dkim' });
  });

  it.each([
    ['a +tag at another domain', 'pat+x@principal.example', 'principal.example'],
    ['a subdomain of gmail.com', 'pat.principal@mail.gmail.com', 'mail.gmail.com'],
    ['a domain that only begins with gmail.com', 'pat.principal@gmail.com.evil.example', 'gmail.com.evil.example'],
  ])('takes %s, signed by its own domain, for an ordinary sender (R1)', (_label, address, domain) => {
    expect(
      authenticateSender(message({ from: `Pat <${address}>`, results: results(domain, 'google') }), CONTEXT),
    ).toMatchObject({ kind: 'authenticated', address });
  });

  it('accepts a Sender equal to From', () => {
    expect(authenticateSender(message({ extra: [{ name: 'Sender', value: `<${PRINCIPAL}>` }] }), CONTEXT).kind).toBe(
      'principal',
    );
  });

  it.each<[string, MessageOptions, UnauthenticatedReason]>([
    [
      'a forged result lower in the message, with no result of Gmail above it',
      {
        withoutGmailResults: true,
        extra: [{ name: 'Authentication-Results', value: results('principal.example', 'google') }],
      },
      'no-gmail-results',
    ],
    [
      "a forged result written above the sender's headers when Gmail's own says fail",
      {
        results: results('principal.example', 'google', 'fail', 'fail'),
        senderHeaders: [{ name: 'Authentication-Results', value: results('principal.example', 'google') }],
      },
      'no-own-dkim',
    ],
    [
      'a result from another server',
      { results: results('principal.example', 'google').replace('mx.google.com', 'mx.evil.example') },
      'no-gmail-results',
    ],
    ['dmarc=bestguesspass', { results: results('principal.example', 'google', 'bestguesspass') }, 'no-dmarc'],
    ['dmarc=fail', { results: results('principal.example', 'google', 'fail') }, 'no-dmarc'],
    ['a failed DKIM signature', { results: results('principal.example', 'google', 'pass', 'fail') }, 'no-own-dkim'],
    [
      'a DMARC pass whose only DKIM pass is another domain’s',
      {
        results: results('principal.example', 'google').replace(
          'header.i=@principal.example',
          'header.i=@mailer.example',
        ),
      },
      'no-own-dkim',
    ],
    [
      'a DMARC pass whose only DKIM pass is a subdomain’s',
      {
        results: results('principal.example', 'google').replace(
          'header.i=@principal.example',
          'header.i=@news.principal.example',
        ),
      },
      'no-own-dkim',
    ],
    [
      "Google's signature alone, as Google Calendar sends mail in their name",
      {
        results: results('principal.example', 'google', 'fail').replace(
          'header.i=@principal.example',
          'header.i=@google.com',
        ),
      },
      'no-own-dkim',
    ],
    ['a differing Sender', { extra: [{ name: 'Sender', value: 'Bulk <bulk@principal.example>' }] }, 'sender-differs'],
    ['a List-Id', { extra: [{ name: 'List-Id', value: '<team.principal.example>' }] }, 'mailing-list'],
    ['two From mailboxes', { from: `${PRINCIPAL}, other@principal.example` }, 'not-one-mailbox'],
  ])('is unauthenticated, never an ordinary sender, with %s', (_label, options, reason) => {
    expect(authenticateSender(message(options), CONTEXT)).toMatchObject({ kind: 'unauthenticated', reason });
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

  it('names a refused address as they listed it, whatever spelling the From wrote, and no one else’s', () => {
    const unverified = (from: string) => {
      const verdict = authenticateSender(
        message({ from, results: results('example.invalid', 's1', 'none', 'none') }),
        CONTEXT,
      );
      if (verdict.kind !== 'unauthenticated') throw new Error(`Expected no verified sender, got ${verdict.kind}`);
      return verdict;
    };
    expect(refusedPrincipalAddress(unverified('Pat <Pat.Principal+news@gmail.com>'), CONTEXT)).toEqual({
      address: 'pat.principal@gmail.com',
      reason: 'no-own-dkim',
    });
    expect(refusedPrincipalAddress(unverified('Sam <sam@acme.example>'), CONTEXT)).toBeUndefined();
    expect(refusedPrincipalAddress(unverified(`${PRINCIPAL}, other@principal.example`), CONTEXT)).toBeUndefined();
  });

  it('is unauthenticated when a non-Gmail header sits above the topmost result', () => {
    const headers = message();
    headers.unshift({ name: 'X-Injected', value: 'yes' });
    expect(authenticateSender(headers, CONTEXT)).toMatchObject({
      kind: 'unauthenticated',
      address: PRINCIPAL,
      reason: 'no-gmail-results',
    });
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
    expect(authenticateSender(notification(options), CONTEXT)).toMatchObject({
      kind: 'unauthenticated',
      reason: 'unsigned-calendar-notification',
    });
  });
});

describe('Google Docs and Drive notifications', () => {
  /** Gmail's results for Google's activity mail, sent through doclist.bounces.google.com and signed by `signer`. */
  function google(input: { readonly signer: string; readonly from: string; readonly dmarc?: string }): string {
    return (
      `mx.google.com;\r\n       dkim=pass header.i=@${input.signer} header.s=20230601 header.b=Qm9vT2x;\r\n` +
      '       spf=pass (google.com: domain of 3qhUHaQ8KBtcXbHf.UVCNOLYa@doclist.bounces.google.com designates 209.85.220.69 as permitted sender) smtp.mailfrom=3qhUHaQ8KBtcXbHf.UVCNOLYa@doclist.bounces.google.com;\r\n' +
      `       dmarc=${input.dmarc ?? 'pass'} (p=REJECT sp=REJECT dis=NONE) header.from=${input.from}`
    );
  }
  const COMMENTS = 'comments-noreply@docs.google.com';
  const SHARES = 'drive-shares-dm-noreply@google.com';
  const actor = { name: 'Reply-To', value: 'Morgan Ellery <morgan.fixture@gmail.com>' };
  const comment = (options: MessageOptions = {}) =>
    message({
      from: `"Morgan Ellery (Google Docs)" <${COMMENTS}>`,
      results: google({ signer: 'docs.google.com', from: 'docs.google.com' }),
      ...options,
      extra: [actor, ...(options.extra ?? [])],
    });
  const share = (options: MessageOptions = {}) =>
    message({
      from: `"Morgan Ellery (via Google Docs)" <${SHARES}>`,
      results: google({ signer: 'google.com', from: 'google.com' }),
      ...options,
      extra: [actor, ...(options.extra ?? [])],
    });

  it.each([
    ['a comment, signed by docs.google.com', comment(), COMMENTS],
    [
      'a comment, signed by google.com',
      comment({ results: google({ signer: 'google.com', from: 'docs.google.com' }) }),
      COMMENTS,
    ],
    ['a share, signed by google.com', share(), SHARES],
    [
      'a share, signed by docs.google.com',
      share({ results: google({ signer: 'docs.google.com', from: 'google.com' }) }),
      SHARES,
    ],
    [
      "a share from Drive's older sender",
      share({ from: '"Morgan Ellery (via Google Drive)" <drive-shares-noreply@google.com>' }),
      'drive-shares-noreply@google.com',
    ],
  ])('are recognized for %s, with a DMARC pass for the sender’s own domain', (_label, headers, address) => {
    expect(authenticateSender(headers, CONTEXT)).toEqual({ kind: 'workspace-notification', address });
  });

  it.each<[string, MailHeader[]]>([
    [
      'a comment without a DMARC pass',
      comment({ results: google({ signer: 'docs.google.com', from: 'docs.google.com', dmarc: 'fail' }) }),
    ],
    [
      'a comment whose DMARC pass is for google.com, not docs.google.com',
      comment({ results: google({ signer: 'google.com', from: 'google.com' }) }),
    ],
    [
      'a comment whose only DKIM pass is a Google subdomain’s',
      comment({ results: google({ signer: 'doclist.bounces.google.com', from: 'docs.google.com' }) }),
    ],
    ['a share signed by another domain', share({ results: google({ signer: 'evil.example', from: 'google.com' }) })],
    ['a share with a differing Sender', share({ extra: [{ name: 'Sender', value: 'drive@google.com' }] })],
    ['a share through a mailing list', share({ extra: [{ name: 'List-Id', value: '<team.google.com>' }] })],
  ])('are unauthenticated, never an ordinary sender, for %s', (_label, headers) => {
    expect(authenticateSender(headers, CONTEXT)).toMatchObject({
      kind: 'unauthenticated',
      reason: 'unsigned-workspace-notification',
    });
  });

  it('are unauthenticated, as any message is, with no results of Gmail’s own', () => {
    expect(authenticateSender(share({ withoutGmailResults: true }), CONTEXT)).toMatchObject({
      kind: 'unauthenticated',
      reason: 'no-gmail-results',
    });
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
    expect(authenticateSender(message(options), CONTEXT)).toMatchObject({
      kind: 'unauthenticated',
      reason: 'no-aligned-pass',
    });
  });
});

describe("Google's signature (KTD12)", () => {
  /**
   * Gmail's results for mail Google Calendar sends in someone's name: signed
   * by google.com, from Google's own servers, so DMARC fails for the From
   * domain. No Sender header is assumed.
   */
  function inTheirName(fromDomain: string, dkim = 'pass'): string {
    return (
      `mx.google.com;\r\n       dkim=${dkim} header.i=@google.com header.s=20230601 header.b=Q2FsZW5k;\r\n` +
      '       spf=pass (google.com: domain of 3remy@calendar-server.bounces.google.com designates 209.85.220.73 as permitted sender) smtp.mailfrom=3remy@calendar-server.bounces.google.com;\r\n' +
      `       dmarc=fail (p=QUARANTINE sp=QUARANTINE dis=NONE) header.from=${fromDomain}`
    );
  }
  const guest = (options: MessageOptions = {}) =>
    message({ from: 'Remy Vance <remy@partner.example>', results: inTheirName('partner.example'), ...options });

  it.each<[string, MailHeader[]]>([
    ["a guest's answer, from their own address", guest()],
    ["the principal's own answer", message({ results: inTheirName('principal.example') })],
    [
      'a Sender naming Google Calendar',
      guest({ extra: [{ name: 'Sender', value: 'Google Calendar <calendar-notification@google.com>' }] }),
    ],
    [
      "Google Calendar's own notification",
      message({ from: 'calendar-notification@google.com', results: results('google.com', 'x') }),
    ],
  ])("is found on %s, signed by google.com in Gmail's own results", (_label, headers) => {
    expect(signedByGoogle(headers)).toBe(true);
  });

  it.each<[string, MailHeader[]]>([
    ['a failed signature', guest({ results: inTheirName('partner.example', 'fail') })],
    ["only the sender's own domain's signature", guest({ results: results('partner.example', 's1') })],
    [
      'a signature from a Google subdomain',
      guest({ results: inTheirName('partner.example').replace('@google.com', '@calendar.google.com') }),
    ],
    ['a mailing list', guest({ extra: [{ name: 'List-Id', value: '<team.partner.example>' }] })],
    [
      "no results of Gmail's own",
      guest({
        withoutGmailResults: true,
        extra: [{ name: 'Authentication-Results', value: inTheirName('partner.example') }],
      }),
    ],
    [
      'a result from another server',
      guest({ results: inTheirName('partner.example').replace('mx.google.com', 'mx.evil.example') }),
    ],
    [
      'a Sender naming Google Calendar, unsigned',
      guest({
        results: results('partner.example', 's1', 'fail', 'fail'),
        extra: [{ name: 'Sender', value: 'calendar-notification@google.com' }],
      }),
    ],
  ])('is not found with %s', (_label, headers) => {
    expect(signedByGoogle(headers)).toBe(false);
  });

  it("is not found when Google's result sits below a header that is not Gmail's", () => {
    const headers = guest();
    headers.unshift({ name: 'X-Injected', value: 'yes' });
    expect(signedByGoogle(headers)).toBe(false);
  });
});
