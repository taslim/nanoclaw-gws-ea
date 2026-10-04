/**
 * Reading Gmail's messages and writing plain-text replies (KTD4).
 */
import { describe, expect, it } from 'vitest';

import { buildOutboundMime, parseAddressList, parseGmailMessage, splitQuoted } from './mime.js';

function data(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

describe('addresses', () => {
  it('reads display names, quoted names, comments, and bare addresses, lowercased', () => {
    expect(
      parseAddressList('"Sam, Acme" <Sam@Acme.example>, pat@principal.example (Pat), Lee <lee@x.example>'),
    ).toEqual([
      { address: 'sam@acme.example', displayName: 'Sam, Acme' },
      { address: 'pat@principal.example' },
      { address: 'lee@x.example', displayName: 'Lee' },
    ]);
  });

  it('decodes encoded display names', () => {
    expect(parseAddressList('=?UTF-8?B?Q2Fmw6k=?= <cafe@x.example>')).toEqual([
      { address: 'cafe@x.example', displayName: 'Café' },
    ]);
  });

  it('refuses group syntax and text that is no address', () => {
    expect(parseAddressList('Team: a@x.example, b@x.example;')).toBeUndefined();
    expect(parseAddressList('not an address')).toBeUndefined();
  });
});

describe('quoted text', () => {
  it("separates the writer's own words from a reply quote", () => {
    expect(
      splitQuoted(
        'Adding my assistant to find time.\n\nOn Wed, Oct 7, 2026 Sam <sam@acme.example> wrote:\n> Can we meet?',
      ),
    ).toEqual({
      own: 'Adding my assistant to find time.',
      quoted: 'On Wed, Oct 7, 2026 Sam <sam@acme.example> wrote:\n> Can we meet?',
    });
  });

  it('treats a forwarded message as quoted', () => {
    const split = splitQuoted('FYI\n---------- Forwarded message ---------\nFrom: x');
    expect(split.own).toBe('FYI');
    expect(split.quoted).toContain('Forwarded message');
  });
});

describe('a Gmail message', () => {
  it('reads its headers, addresses, and plain text, and leaves attachments out', () => {
    const mail = parseGmailMessage({
      id: 'm1',
      threadId: 't1',
      labelIds: ['INBOX'],
      payload: {
        mimeType: 'multipart/mixed',
        headers: [
          { name: 'From', value: 'Sam <sam@acme.example>' },
          { name: 'To', value: 'robin@assistant.example' },
          { name: 'Cc', value: 'Pat <pat@principal.example>' },
          { name: 'Subject', value: 'Meeting' },
          { name: 'Message-ID', value: '<a@acme.example>' },
          { name: 'In-Reply-To', value: '<b@assistant.example>' },
          { name: 'References', value: '<c@acme.example> <b@assistant.example>' },
        ],
        parts: [
          {
            mimeType: 'multipart/alternative',
            parts: [
              {
                mimeType: 'text/plain',
                headers: [{ name: 'Content-Type', value: 'text/plain; charset=UTF-8' }],
                body: { data: data('Tuesday works.') },
              },
              { mimeType: 'text/html', body: { data: data('<p>Tuesday works.</p>') } },
            ],
          },
          { mimeType: 'application/pdf', filename: 'agenda.pdf', body: { attachmentId: 'att1', size: 10 } },
        ],
      },
    });
    expect(mail).toMatchObject({
      id: 'm1',
      threadId: 't1',
      from: { address: 'sam@acme.example', displayName: 'Sam' },
      to: [{ address: 'robin@assistant.example' }],
      cc: [{ address: 'pat@principal.example', displayName: 'Pat' }],
      subject: 'Meeting',
      rfcMessageId: '<a@acme.example>',
      inReplyTo: ['<b@assistant.example>'],
      references: ['<c@acme.example>', '<b@assistant.example>'],
      text: 'Tuesday works.',
      attachmentCount: 1,
    });
  });

  it('falls back to the text of an HTML-only message', () => {
    const mail = parseGmailMessage({
      id: 'm2',
      threadId: 't2',
      payload: {
        mimeType: 'text/html',
        headers: [],
        body: { data: data('<div>Hi<br>there &amp; you</div><script>x()</script>') },
      },
    });
    expect(mail.text).toBe('Hi\nthere & you');
  });
});

describe('a reply', () => {
  const base = {
    from: { address: 'robin@assistant.example', displayName: 'Robin' },
    subject: 'Re: Café plans',
    messageId: '<gws-ea.1@assistant.example>',
    inReplyTo: '<a@acme.example>',
    references: ['<c@acme.example>', '<a@acme.example>'],
    text: 'Tuesday at 10:00 works.\nSee you then.',
    date: new Date('2026-10-07T17:00:00.000Z'),
  };

  function headerNames(raw: string): string[] {
    return raw
      .slice(0, raw.indexOf('\r\n\r\n'))
      .split('\r\n')
      .filter((line) => !/^[ \t]/.test(line))
      .map((line) => line.slice(0, line.indexOf(':')));
  }

  it('is plain text in its thread, with no quote, and no Cc or Bcc when nobody is placed there', () => {
    const raw = buildOutboundMime({ ...base, to: ['sam@acme.example', 'pat@principal.example'], cc: [], bcc: [] });
    expect(raw).toContain('From: Robin <robin@assistant.example>\r\n');
    expect(raw).toContain('To: sam@acme.example, pat@principal.example\r\n');
    expect(raw).toContain('Subject: =?UTF-8?B?');
    expect(raw).toContain('Message-ID: <gws-ea.1@assistant.example>\r\n');
    expect(raw).toContain('In-Reply-To: <a@acme.example>\r\n');
    expect(raw).toContain('References: <c@acme.example> <a@acme.example>\r\n');
    expect(raw).toContain('Content-Type: text/plain; charset=UTF-8\r\n');
    expect(raw).not.toMatch(/^(Cc|Bcc):/im);
    const body = raw.slice(raw.indexOf('\r\n\r\n') + 4);
    expect(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8')).toBe(
      'Tuesday at 10:00 works.\r\nSee you then.',
    );
  });

  it('writes To, Cc, and Bcc with the other addressing headers, before the MIME headers Gmail stops reading at', () => {
    const raw = buildOutboundMime({
      ...base,
      to: ['sam@acme.example'],
      cc: ['ari@acme.example', 'lee@acme.example'],
      bcc: ['pat@principal.example'],
    });
    expect(raw).toContain('To: sam@acme.example\r\n');
    expect(raw).toContain('Cc: ari@acme.example, lee@acme.example\r\n');
    expect(raw).toContain('Bcc: pat@principal.example\r\n');
    const names = headerNames(raw);
    expect(names.indexOf('Bcc')).toBeLessThan(names.indexOf('MIME-Version'));
    expect(names.indexOf('Cc')).toBeLessThan(names.indexOf('Content-Type'));
  });

  it('can go to Cc alone, never to no one, and never to something that is not an address', () => {
    expect(buildOutboundMime({ ...base, to: [], cc: ['ari@acme.example'], bcc: [] })).not.toMatch(/^To:/im);
    expect(() => buildOutboundMime({ ...base, to: [], cc: [], bcc: [] })).toThrow(/at least one recipient/);
    expect(() =>
      buildOutboundMime({ ...base, to: ['sam@acme.example'], cc: [], bcc: ['x>, eve@evil.example'] }),
    ).toThrow(/Not an email address/);
  });

  it('cannot be given extra headers through a value', () => {
    const raw = buildOutboundMime({
      from: { address: 'robin@assistant.example' },
      to: ['sam@acme.example'],
      cc: [],
      bcc: [],
      subject: 'Hi\r\nBcc: eve@evil.example',
      messageId: '<x@assistant.example>',
      references: [],
      text: 'Hi',
      date: new Date(),
    });
    expect(raw).not.toMatch(/^Bcc:/im);
    expect(raw).toContain('Subject: Hi Bcc: eve@evil.example\r\n');
  });
});
