import { describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';

const fixture = vi.hoisted(() => ({
  confirm: vi.fn(),
  open: vi.fn(),
  headless: vi.fn(() => false),
  ensure: vi.fn((value: unknown) => value),
}));
vi.mock('@clack/prompts', () => ({
  confirm: fixture.confirm,
  isCancel: (value: unknown) => typeof value === 'symbol',
  log: { info: vi.fn() },
}));
vi.mock('child_process', () => ({ spawn: fixture.open }));
vi.mock('../platform.js', () => ({ isHeadless: fixture.headless }));
vi.mock('./runner.js', () => ({ ensureAnswer: fixture.ensure }));
import { confirmThenOpen } from './browser.js';

describe('browser readiness for managed callers', () => {
  it.each([false, Symbol('cancel')])('does not open after a declined or cancelled readiness prompt', async (answer) => {
    vi.clearAllMocks();
    fixture.confirm.mockResolvedValue(answer);
    fixture.open.mockReturnValue({ on: vi.fn(), unref: vi.fn() });
    const declined = vi.fn(() => {
      throw new Error('managed cancellation');
    });
    await expect(confirmThenOpen('https://example.test/consent', 'Ready?', { onDecline: declined })).rejects.toThrow(
      'managed cancellation',
    );
    expect(declined).toHaveBeenCalledOnce();
    expect(fixture.open).not.toHaveBeenCalled();
    expect(fixture.ensure).not.toHaveBeenCalled();
  });

  it('keeps a headless copyable URL on the caller stream', async () => {
    fixture.headless.mockReturnValueOnce(true);
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
    await confirmThenOpen('https://example.test/consent', 'Ready?', { output });
    expect(chunks.join('')).toBe('\nhttps://example.test/consent\n\n');
  });
});
