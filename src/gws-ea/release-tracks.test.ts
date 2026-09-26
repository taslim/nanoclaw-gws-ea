import { describe, expect, it } from 'vitest';

import { resolveReleaseSource } from './release-tracks.js';

const MIRROR = 'https://github.com/example/nanoclaw-gws-ea-mirror.git';

describe('release sources', () => {
  it('follows the dogfood line on the public repository without asking for a remote', () => {
    expect(resolveReleaseSource('dogfood')).toEqual({
      remote: 'https://github.com/taslim/nanoclaw-gws-ea.git',
      ref: 'refs/heads/rebuild-v2',
    });
  });

  it('refuses prod until it has a release, naming the track that has one', () => {
    expect(() => resolveReleaseSource('prod')).toThrow(
      expect.objectContaining({
        code: 'release_unavailable',
        message: 'Release track prod has no release yet; use --track dogfood.',
      }),
    );
    expect(() => resolveReleaseSource('prod', MIRROR)).toThrow(
      expect.objectContaining({ code: 'release_unavailable' }),
    );
  });

  it("installs a product track's branch from another repository with --source-remote", () => {
    expect(resolveReleaseSource('dogfood', ` ${MIRROR} `)).toEqual({ remote: MIRROR, ref: 'refs/heads/rebuild-v2' });
  });

  it('installs any other track from the branch of its name in the repository --source-remote names', () => {
    expect(resolveReleaseSource('canary', MIRROR)).toEqual({ remote: MIRROR, ref: 'refs/heads/canary' });
    expect(() => resolveReleaseSource('canary')).toThrow(
      expect.objectContaining({ code: 'release_source_required', message: expect.stringContaining('--source-remote') }),
    );
    expect(() => resolveReleaseSource('canary', '   ')).toThrow(
      expect.objectContaining({ code: 'release_source_required' }),
    );
  });

  it('treats only its own tracks as product tracks', () => {
    expect(() => resolveReleaseSource('toString')).toThrow(
      expect.objectContaining({ code: 'release_source_required' }),
    );
  });
});
