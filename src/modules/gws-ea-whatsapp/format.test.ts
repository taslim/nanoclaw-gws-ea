import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { transportHarness, type TransportHarness } from './testing/harness.js';

let h: TransportHarness;
beforeEach(async () => {
  h = await transportHarness();
});
afterEach(async () => {
  await h.close();
});
describe('markdown at the WhatsApp send boundary', () => {
  it.each([
    ['**bold** and *italic*', '*bold* and _italic_'],
    ['## Heading\n\n[Site](https://example.com)\n---', '*Heading*\n\nSite (https://example.com)\n'],
    ['```ts\nconst bold = "**literal**";\n```\n**outside**', '```ts\nconst bold = "**literal**";\n```\n*outside*'],
    ['`*literal* @15551112222` and **normal**', '`*literal* @15551112222` and *normal*'],
    ['**spaced words**\n*short*', '*spaced words*\n_short_'],
  ])('converts %s', async (input, expected) => {
    const adapter = await h.start();
    await adapter.deliver('team@g.us', null, { kind: 'chat', content: { text: input } }, 'format');
    expect(h.socket().sends[0].content).toMatchObject({ text: expected });
  });
  it.each([
    ['@15551234567 hi', ['15551234567@s.whatsapp.net']],
    ['@15551234567 ping @15551234567 again', ['15551234567@s.whatsapp.net']],
    ['write to test@1234567890.com', []],
    ['see issue @123 for details', []],
    ['thanks @15551234567!', ['15551234567@s.whatsapp.net']],
    ['(@15551234567) wrote this', ['15551234567@s.whatsapp.net']],
  ])('preserves upstream mention boundaries for %s', async (input, mentions) => {
    const adapter = await h.start();
    await adapter.deliver('team@g.us', null, { kind: 'chat', content: { text: input } }, 'mention-boundary');
    expect(h.socket().sends[0].content).toEqual({ text: input, mentions });
  });

  it('extracts real phone mentions, normalizes plus signs and leaves code untagged', async () => {
    const adapter = await h.start();
    await adapter.deliver(
      'team@g.us',
      null,
      { kind: 'chat', content: { text: 'Hi @+15551112222 and @15553334444. `@15559998888` email@example.com' } },
      'mentions',
    );
    expect(h.socket().sends[0].content).toEqual({
      text: 'Hi @15551112222 and @15553334444. `@15559998888` email@example.com',
      mentions: ['15551112222@s.whatsapp.net', '15553334444@s.whatsapp.net'],
    });
  });
});
