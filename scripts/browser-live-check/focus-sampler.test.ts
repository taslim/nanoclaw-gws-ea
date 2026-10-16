import { afterEach, describe, expect, it, vi } from 'vitest';

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: execFileMock }));

import { assessQuietOperation, FocusSampler } from './focus-sampler.js';

afterEach(() => {
  vi.useRealTimers();
  execFileMock.mockReset();
});

describe('quiet-operation observations', () => {
  const reading = {
    sampledAt: '2026-10-15T02:00:00.000Z',
    frontmostApp: 'com.apple.Terminal',
    clipboardChangeCount: 42,
    space: 'desktop-1',
    errors: [],
  };

  it('reports a frontmost application change, including a change back', () => {
    expect(assessQuietOperation([reading, { ...reading, frontmostApp: 'com.google.Chrome' }, reading])).toMatchObject({
      status: 'failed',
      changes: ['frontmost_app'],
    });
  });

  it('reports unchanged complete observations as passed', () => {
    expect(assessQuietOperation([reading, reading])).toMatchObject({
      status: 'passed',
      changes: [],
    });
  });

  it('fails when the Space or clipboard changes without reading clipboard contents', () => {
    expect(assessQuietOperation([reading, { ...reading, space: 'desktop-2', clipboardChangeCount: 43 }])).toMatchObject(
      { status: 'failed', changes: ['space', 'clipboard'] },
    );
  });

  it('does not claim quiet operation when the Space cannot be sampled', () => {
    expect(
      assessQuietOperation([
        { ...reading, space: null },
        { ...reading, space: null },
      ]),
    ).toMatchObject({ status: 'not-run', unavailable: ['space'] });
  });

  it('does not treat a locked login window as active-desktop evidence', () => {
    expect(
      assessQuietOperation([
        { ...reading, frontmostApp: 'com.apple.loginwindow' },
        { ...reading, frontmostApp: 'com.apple.loginwindow' },
      ]),
    ).toMatchObject({ status: 'not-run', unavailable: ['active_desktop'] });
  });
});

describe('slow desktop sampling', () => {
  it('serializes boundary reads and coalesces timer ticks instead of building a backlog', async () => {
    vi.useFakeTimers();
    const complete: Array<() => void> = [];
    execFileMock.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: object,
        callback: (error: Error | null, result: { stdout: string; stderr: string }) => void,
      ) => {
        complete.push(() =>
          callback(null, {
            stdout: JSON.stringify({ frontmostApp: 'com.apple.Terminal', clipboardChangeCount: 42 }),
            stderr: '',
          }),
        );
      },
    );
    const sampler = new FocusSampler();
    const start = sampler.start();
    complete.shift()?.();
    await start;
    const first = sampler.sample();
    const boundary = sampler.sample();
    expect(execFileMock).toHaveBeenCalledTimes(2);
    complete.shift()?.();
    await first;
    await Promise.resolve();
    expect(execFileMock).toHaveBeenCalledTimes(3);
    complete.shift()?.();
    await boundary;
    await vi.advanceTimersByTimeAsync(750);
    expect(execFileMock).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(7_500);
    expect(execFileMock).toHaveBeenCalledTimes(4);
    const stopped = sampler.stop();
    complete.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(execFileMock).toHaveBeenCalledTimes(5);
    complete.shift()?.();
    await stopped;
    expect(sampler.observations).toHaveLength(5);
  });
});
