/**
 * Email that reads like a person's (R61, KTD6): the agent's markdown as
 * minimal HTML and as the text it wrote, signed once, with a reply's quote.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  TIMEZONE: 'America/New_York',
}));

import { emailSignature, renderEmail } from './render.js';

const signature = emailSignature({ assistant_display_name: 'Juno Hale', principal_display_name: 'Morgan Ellery' });

function tags(html: string): Set<string> {
  return new Set([...html.matchAll(/<\/?([a-z][a-z0-9]*)/gu)].map((match) => match[1]));
}

/** Attribute names; text holds no `name="`, because rendering escapes every quote in it. */
function attributes(html: string): Set<string> {
  return new Set([...html.matchAll(/\s([a-z-]+)="/gu)].map((match) => match[1]));
}

function hrefs(html: string): string[] {
  return [...html.matchAll(/<a href="([^"]*)">/gu)].map((match) => match[1]);
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('the body', () => {
  it('renders a paragraph, a short list, and a link as minimal HTML, and the same words as plain text', () => {
    const markdown =
      'Hi Remy,\n\nMorgan asked me to find 30 minutes with you. Would either of these work?\n\n' +
      '- Tuesday at 10:00\n- Wednesday at 14:00\n\nThe [agenda](https://example.com/agenda?week=41&day=2) is attached.';
    const email = renderEmail({ markdown, signature });

    expect(email.html).toMatch(/^<div dir="ltr">/u);
    expect(email.html).toContain('<p>Hi Remy,</p>');
    expect(email.html).toContain('<ul>\n<li>Tuesday at 10:00</li>\n<li>Wednesday at 14:00</li>\n</ul>');
    expect(email.html).toContain('<a href="https://example.com/agenda?week=41&amp;day=2">agenda</a>');
    expect([...tags(email.html)].sort()).toEqual(['a', 'br', 'div', 'li', 'p', 'ul']);
    expect([...attributes(email.html)].sort()).toEqual(['dir', 'href']);
    expect(email.text.slice(0, email.text.indexOf('\n\n-- \n'))).toBe(
      'Hi Remy,\n\nMorgan asked me to find 30 minutes with you. Would either of these work?\n\n' +
        '- Tuesday at 10:00\n- Wednesday at 14:00\n\n' +
        'The agenda (https://example.com/agenda?week=41&day=2) is attached.',
    );
  });

  it('writes the text part as a person types an email: no markdown left, links spelled out, bullets and breaks kept', () => {
    const email = renderEmail({
      markdown: [
        '# Next week',
        '',
        'Would **Tuesday at 3pm** or _Thursday_ work? Use the room code `B-12`.',
        'The details are [on the invite](https://cal.example/e?id=7&t=1), or at <https://cal.example/e>; ask juno@cal.example.',
        '',
        '1. Bring the deck',
        '2. Bring the budget',
        '   - last year’s too',
        '',
        '> Pat said: keep it short.',
        '',
        'Best,  ',
        'Juno',
      ].join('\n'),
      signature,
    });

    expect(email.text).toBe(
      [
        'Next week',
        '',
        'Would Tuesday at 3pm or Thursday work? Use the room code B-12.',
        'The details are on the invite (https://cal.example/e?id=7&t=1), or at https://cal.example/e; ask juno@cal.example.',
        '',
        '1. Bring the deck',
        '2. Bring the budget',
        '   - last year’s too',
        '',
        '> Pat said: keep it short.',
        '',
        'Best,',
        'Juno',
        '',
        '-- ',
        'Juno Hale',
        'Assistant to Morgan Ellery',
      ].join('\n'),
    );
    // The HTML part is markdown's, as before.
    expect(email.html).toContain('<h1>Next week</h1>');
    expect(email.html).toContain('<strong>Tuesday at 3pm</strong> or <em>Thursday</em>');
  });

  it('keeps a line break the writer made, as in a closing', () => {
    const email = renderEmail({ markdown: 'Tuesday works.\n\nBest,\nJuno', signature });
    expect(email.html).toContain('<p>Best,<br />\nJuno</p>');
    expect(email.text.startsWith('Tuesday works.\n\nBest,\nJuno\n')).toBe(true);
  });

  it('escapes raw HTML and strips images, keeping their words', () => {
    const email = renderEmail({
      markdown:
        'Before <script>alert(1)</script> after.\n\n<img src="https://x.example/p.png" onerror="steal()">\n\n' +
        'Here is ![the floor plan](https://x.example/plan.png).',
      signature,
    });
    expect(email.html).not.toMatch(/<(script|img)\b/u);
    expect(email.html).toContain('Before &lt;script&gt;alert(1)&lt;/script&gt; after.');
    expect(email.html).toContain('&lt;img src=&quot;https://x.example/p.png&quot; onerror=&quot;steal()&quot;&gt;');
    expect(email.html).toContain('<p>Here is the floor plan.</p>');
    expect(email.html).not.toContain('plan.png');
  });

  it('keeps http(s) and mailto links, and drops every other link to its words', () => {
    const email = renderEmail({
      markdown:
        '[safe](https://ok.example/path) [plain](http://ok.example) [mail](mailto:sam@acme.example) ' +
        '[bad](javascript:alert(1)) [data](data:text/html,hi) [relative](/inbox) [chat](irc://x.example)',
      signature,
    });
    expect(hrefs(email.html)).toEqual(['https://ok.example/path', 'http://ok.example', 'mailto:sam@acme.example']);
    expect(email.html).toContain('</a> bad data relative chat</p>');
    expect(email.html).not.toMatch(/javascript|data:|irc:|"\/inbox"/u);
  });
});

describe('a reply', () => {
  const quote = {
    from: { address: 'sam@acme.example', displayName: 'Sam\nLee' },
    sentAt: new Date('2026-10-07T14:00:00.000Z'),
    text: 'Can we meet <next> week?\r\nTea & cake on me.\u0007\n\n> Earlier words',
  };

  it("quotes only the anchor's sanitized text, under an On <date>, <name> wrote: line in the install timezone", () => {
    const email = renderEmail({ markdown: 'Tuesday works.\n\nBest,\nJuno', signature, quote });

    const attribution = /On Oct 7, 2026, 10:00\sAM, Sam Lee <sam@acme\.example> wrote:/u;
    const textQuote = email.text.slice(email.text.indexOf('\nOn ') + 1);
    expect(textQuote).toMatch(attribution);
    expect(textQuote.slice(textQuote.indexOf('\n'))).toBe(
      '\n\n> Can we meet <next> week?\n> Tea & cake on me.\n>\n> > Earlier words',
    );

    const htmlQuote = email.html.slice(email.html.indexOf('<div class="gmail_quote">'));
    expect(htmlQuote).toMatch(/On Oct 7, 2026, 10:00\sAM, Sam Lee &lt;sam@acme\.example&gt; wrote:/u);
    expect(htmlQuote).toContain(
      '<blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px #ccc solid;padding-left:1ex">' +
        'Can we meet &lt;next&gt; week?<br>\nTea &amp; cake on me.<br>\n<br>\n&gt; Earlier words</blockquote></div>',
    );
    expect(email.html).not.toContain('\u0007');
    expect(email.text).not.toContain('\u0007');
  });

  it('names the writer by address alone when its From gave no name', () => {
    const email = renderEmail({
      markdown: 'Yes.',
      signature,
      quote: { ...quote, from: { address: 'sam@acme.example' } },
    });
    expect(email.text).toMatch(/, sam@acme\.example wrote:\n/u);
  });
});

describe('the signature', () => {
  it("is the assistant's name, then whose assistant it is", () => {
    expect(signature).toEqual(['Juno Hale', 'Assistant to Morgan Ellery']);
  });

  it('cannot be built without both names', () => {
    expect(() => emailSignature({ assistant_display_name: 'Juno Hale', principal_display_name: null })).toThrow(
      /names/u,
    );
  });

  it('appears exactly once in each part, after the closing and before the quote', () => {
    const email = renderEmail({
      markdown: 'Tuesday works.\n\nBest,\nJuno',
      signature,
      quote: { from: { address: 'sam@acme.example' }, sentAt: new Date('2026-10-07T14:00:00.000Z'), text: 'Hi' },
    });
    expect(count(email.text, 'Juno Hale')).toBe(1);
    expect(count(email.html, 'Juno Hale')).toBe(1);
    expect(email.text).toContain('Best,\nJuno\n\n-- \nJuno Hale\nAssistant to Morgan Ellery\n\nOn ');
    expect(email.html).toContain(
      '<p>Juno Hale<br>Assistant to Morgan Ellery</p>\n</div>\n<br>\n<div class="gmail_quote">',
    );
  });

  it('is escaped in HTML', () => {
    const email = renderEmail({
      markdown: 'Hi',
      signature: emailSignature({ assistant_display_name: 'R & D <Bot>', principal_display_name: 'Pat' }),
    });
    expect(email.html).toContain('<p>R &amp; D &lt;Bot&gt;<br>Assistant to Pat</p>');
  });
});
