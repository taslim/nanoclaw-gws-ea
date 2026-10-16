import { describe, expect, it } from 'bun:test';

import { answerResult, requestTool } from './action-request.js';

const IMAGE = { mime_type: 'image/png', data: 'c2NyZWVuc2hvdA==' };

describe('a host answer as a tool returns it', () => {
  it('returns images as MCP image content and keeps their bytes out of the text', () => {
    const result = answerResult({ id: 'r-1', ok: true, data: { status: 'done', images: [IMAGE] } });
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify({ status: 'done' }) },
      { type: 'image', mimeType: 'image/png', data: IMAGE.data },
    ]);
  });

  it('keeps a message answer as its text alongside its images', () => {
    const result = answerResult({ id: 'r-2', ok: true, data: { message: 'Here it is.', images: [IMAGE] } });
    expect(result.content[0]).toEqual({ type: 'text', text: 'Here it is.' });
    expect(result.content).toHaveLength(2);
  });

  it('refuses an unreadable image answer instead of passing any of it on', () => {
    for (const images of [
      IMAGE,
      [{ ...IMAGE, mime_type: 'text/html' }],
      [{ ...IMAGE, data: 'not base64!' }],
      [{ ...IMAGE, data: '' }],
      [{ ...IMAGE, url: 'https://example.com/a.png' }],
    ]) {
      const result = answerResult({ id: 'r-3', ok: true, data: { status: 'done', images } });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{ type: 'text', text: "Error: The host's image answer was unreadable." }]);
    }
  });

  it('leaves an answer without images as it was', () => {
    expect(answerResult({ id: 'r-4', ok: true, data: { status: 'done' } }).content).toEqual([
      { type: 'text', text: JSON.stringify({ status: 'done' }) },
    ]);
  });
});

describe('a request tool schema', () => {
  const base = {
    name: 'fixture',
    description: 'A fixture request.',
    properties: { kind: { type: 'string' } },
    required: ['kind'],
    repeatable: false,
    timeoutMs: 1_000,
  } as const;

  it('is open, with no alternatives, unless the spec says otherwise', () => {
    expect(requestTool(base).tool.inputSchema).toEqual({
      type: 'object',
      properties: { kind: { type: 'string' } },
      required: ['kind'],
    });
  });

  it('closes its fields and lists its request shapes when the spec declares them', () => {
    const oneOf = [
      { properties: { kind: { const: 'a' } }, additionalProperties: false },
      { properties: { kind: { const: 'b' } }, additionalProperties: false },
    ];
    expect(requestTool({ ...base, additionalProperties: false, oneOf }).tool.inputSchema).toEqual({
      type: 'object',
      properties: { kind: { type: 'string' } },
      required: ['kind'],
      additionalProperties: false,
      oneOf,
    });
  });
});
