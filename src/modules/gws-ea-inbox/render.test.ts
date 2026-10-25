/**
 * Email that reads like a person's: the agent's markdown, its
 * sign-off included, as minimal HTML and as the text it wrote, with a reply's
 * quote.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  TIMEZONE: 'America/New_York',
}));

import { renderEmail } from './render.js';

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

describe('the body', () => {
  it('renders a paragraph, a short list, and a link as minimal HTML, and the same words as plain text', () => {
    const markdown =
      'Hi Remy,\n\nMorgan asked me to find 30 minutes with you. Would either of these work?\n\n' +
      '- Tuesday at 10:00\n- Wednesday at 14:00\n\nThe [agenda](https://example.com/agenda?week=41&day=2) is attached.';
    const email = renderEmail({ markdown });

    expect(email.html).toMatch(/^<div dir="ltr">/u);
    expect(email.html).toContain('<p>Hi Remy,</p>');
    expect(email.html).toContain('<ul>\n<li>Tuesday at 10:00</li>\n<li>Wednesday at 14:00</li>\n</ul>');
    expect(email.html).toContain('<a href="https://example.com/agenda?week=41&amp;day=2">agenda</a>');
    expect([...tags(email.html)].sort()).toEqual(['a', 'div', 'li', 'p', 'ul']);
    expect([...attributes(email.html)].sort()).toEqual(['dir', 'href']);
    expect(email.text).toBe(
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
        'Would **Tuesday at 3pm** or _Thursday_ work? Use the room code `B-12`.  ',
        'The details are [on the invite](https://cal.example/e?id=7&t=1), or at <https://cal.example/e>; ask juno@cal.example.',
        '',
        '1. Bring the deck',
        '2. Bring the budget',
        '   - last year’s too',
        '',
        '> Pat said: keep it short.',
        '',
        'Best,',
      ].join('\n'),
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
      ].join('\n'),
    );
    // The HTML part is markdown's, as before.
    expect(email.html).toContain('<h1>Next week</h1>');
    expect(email.html).toContain('<strong>Tuesday at 3pm</strong> or <em>Thursday</em>');
  });

  it('keeps a line break the writer made, as in an address', () => {
    const email = renderEmail({ markdown: 'We meet at:\n4 Harbour Lane\nSuite 2\n\nBest,' });
    expect(email.html).toContain('<p>We meet at:<br />\n4 Harbour Lane<br />\nSuite 2</p>');
    expect(email.text).toBe('We meet at:\n4 Harbour Lane\nSuite 2\n\nBest,');
  });

  it('escapes raw HTML and strips images, keeping their words', () => {
    const email = renderEmail({
      markdown:
        'Before <script>alert(1)</script> after.\n\n<img src="https://x.example/p.png" onerror="steal()">\n\n' +
        'Here is ![the floor plan](https://x.example/plan.png).',
    });
    expect(email.html).not.toMatch(/<(script|img)\b/u);
    expect(email.html).toContain('Before &lt;script&gt;alert(1)&lt;/script&gt; after.');
    expect(email.html).toContain('&lt;img src=&quot;https://x.example/p.png&quot; onerror=&quot;steal()&quot;&gt;');
    expect(email.html).toContain('<p>Here is the floor plan.<');
    expect(email.html).not.toContain('plan.png');
  });

  it('says in the text part every word the HTML part shows, in order, with no markdown left', () => {
    const markdown = [
      'Hi [Remy][r], see the **plan**[^1] and ~~old~~ _new_ times:',
      '',
      '| Day | Time |',
      '| --- | --- |',
      '| Tue | `10:00` |',
      '',
      '1. First',
      '   - [x] booked',
      '2. Second',
      '',
      '> Quoted *line*',
      '',
      '[r]: https://r.example/remy',
      '[^1]: Notes are at <https://n.example/1>.',
    ].join('\n');
    const email = renderEmail({ markdown });
    const shown = email.html
      .replace(/<[^>]+>/gu, ' ')
      .replace(
        /&(amp|lt|gt|quot);/gu,
        (_entity, name: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"' })[name] ?? '',
      )
      .split(/\s+/u)
      .filter(Boolean);
    let at = 0;
    for (const word of shown) {
      at = email.text.indexOf(word, at);
      expect(at, `"${word}" is missing from the text part`).toBeGreaterThanOrEqual(0);
      at += word.length;
    }
    expect(email.text).not.toMatch(/\*|~~|`|\]\(|\[\^|\[r\]/u);
    expect(email.text).toContain('Hi Remy (https://r.example/remy), see the plan1 and old new times:');
  });

  it('keeps http(s) and mailto links, and drops every other link to its words', () => {
    const email = renderEmail({
      markdown:
        '[safe](https://ok.example/path) [plain](http://ok.example) [mail](mailto:sam@acme.example) ' +
        '[bad](javascript:alert(1)) [data](data:text/html,hi) [relative](/inbox) [chat](irc://x.example)',
    });
    expect(hrefs(email.html)).toEqual(['https://ok.example/path', 'http://ok.example', 'mailto:sam@acme.example']);
    expect(email.html).toContain('</a> bad data relative chat<');
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
    const email = renderEmail({ markdown: 'Tuesday works.\n\nBest,', quote });

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
      quote: { ...quote, from: { address: 'sam@acme.example' } },
    });
    expect(email.text).toMatch(/, sam@acme\.example wrote:\n/u);
  });
});

describe('the sign-off', () => {
  it('is what the agent wrote: a signature under its closing is one paragraph, before the quote', () => {
    const email = renderEmail({
      markdown: 'Tuesday works.\n\nBest,\nJuno Hale | EA to Morgan Ellery',
      quote: { from: { address: 'sam@acme.example' }, sentAt: new Date('2026-10-07T14:00:00.000Z'), text: 'Hi' },
    });
    expect(email.text).toMatch(
      /^Tuesday works\.\n\nBest,\nJuno Hale \| EA to Morgan Ellery\n\nOn [^\n]+ wrote:\n\n> Hi$/u,
    );
    expect(email.html).toContain(
      '<p>Tuesday works.</p>\n<p>Best,<br />\nJuno Hale | EA to Morgan Ellery</p>\n</div>\n<br>\n<div class="gmail_quote">',
    );
    expect(tags(email.html)).not.toContain('table');
  });

  it('adds nothing to an email the agent left unsigned', () => {
    const email = renderEmail({ markdown: 'Done: your 3pm is now Thursday.' });
    expect(email).toEqual({
      text: 'Done: your 3pm is now Thursday.',
      html: '<div dir="ltr">\n<p>Done: your 3pm is now Thursday.</p>\n</div>',
    });
  });
});
