/**
 * A request the host posts in Google Chat, as Chat receives it: through the
 * SDK's own Markdown converter. Nothing someone else supplied, quoted or not,
 * may reach Chat as a mention or a link.
 */
import { GoogleChatFormatConverter } from '@chat-adapter/gchat';
import { describe, expect, it } from 'vitest';

import { NAME_LIMIT, quoted } from '../approvals/request-text.js';
import { escapeChatRequestText } from './adapter.js';

const converter = new GoogleChatFormatConverter();
const posted = (markdown: string): string => converter.fromMarkdown(escapeChatRequestText(markdown));

const HOSTILE = [
  '<users/all>',
  '<https://evil.example|Approve now>',
  '&lt;users/all&gt;',
  '&lt;https://evil.example|Approve now&gt;',
  '&#60;https://evil.example|Approve&#62;',
  '[Approve](https://evil.example)',
];

describe('a Google Chat request', () => {
  it.each(HOSTILE)('carries no mention or link from a quoted value: %s', (value) => {
    const text = posted(`Name: ${quoted(value, NAME_LIMIT)}`);
    expect(text).not.toMatch(/<users\//u);
    expect(text).not.toMatch(/<https?:/u);
  });

  it.each(HOSTILE)('carries none from a value a request left unquoted: %s', (value) => {
    const text = posted(`I'd like to share my vault with ${value}.`);
    expect(text).not.toMatch(/<users\//u);
    expect(text).not.toMatch(/<https?:/u);
  });

  it('shows a Markdown link as written, so no text stands in for an address', () => {
    expect(posted('[Approve](https://evil.example)')).toBe('[Approve](https://evil.example)');
  });
});
