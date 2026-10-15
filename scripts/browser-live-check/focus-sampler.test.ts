import { describe, expect, it } from 'vitest';

import { assessQuietOperation } from './focus-sampler.js';

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
