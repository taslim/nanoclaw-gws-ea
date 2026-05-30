import { describe, it, expect } from 'vitest';

import { formatEmailForAgent } from './format.js';

describe('formatEmailForAgent', () => {
  const base = {
    from: 'sender@x.com',
    to: 'assistant@example.com',
    cc: '',
    subject: 'Question',
    date: 'Mon, 1 Jan 2026 12:00:00 -0500',
    body: 'Hi,\n\nCan we meet?',
    threadId: '19e3ed74a252689a',
  };

  it('renders required fields', () => {
    const text = formatEmailForAgent(base);
    expect(text).toContain('From: sender@x.com');
    expect(text).toContain('To: assistant@example.com');
    expect(text).toContain('Subject: Question');
    expect(text).toContain('Thread: 19e3ed74a252689a');
    expect(text).toContain('--- Email Body ---');
    expect(text).toContain('Hi,');
    expect(text).toContain('--- End Email Body ---');
  });

  it('omits Cc line when empty', () => {
    expect(formatEmailForAgent(base)).not.toContain('Cc:');
  });

  it('renders Cc when present', () => {
    expect(formatEmailForAgent({ ...base, cc: 'other@x.com' })).toContain('Cc: other@x.com');
  });

  it('renders thread history above the new message, oldest first', () => {
    const text = formatEmailForAgent({
      ...base,
      threadHistory: [
        { from: 'sender@x.com', to: 'assistant@example.com', cc: '', date: 'd1', body: 'first' },
        { from: 'assistant@example.com', to: 'sender@x.com', cc: '', date: 'd2', body: 'reply' },
      ],
    });
    expect(text).toContain('Thread History (2 prior messages, oldest first)');
    expect(text.indexOf('first')).toBeLessThan(text.indexOf('reply'));
    expect(text.indexOf('reply')).toBeLessThan(text.indexOf('--- Email Body ---'));
  });

  it('omits thread history block when empty', () => {
    expect(formatEmailForAgent({ ...base, threadHistory: [] })).not.toContain('Thread History');
  });
});
