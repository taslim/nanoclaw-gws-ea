import productTracks from './release-tracks.json' with { type: 'json' };

import { GwsEaError } from './types.js';

const GWS_EA_RELEASE_REMOTE = 'https://github.com/taslim/nanoclaw-gws-ea.git';

/** What an assistant's record accepts as a track: also the branch a non-product track installs. */
export const RELEASE_TRACK_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const PRODUCT_TRACKS: Readonly<Record<string, string | null>> = productTracks;

export interface ReleaseSource {
  readonly remote: string;
  readonly ref: string;
}

/**
 * Where a release track installs from. A product track follows its branch of
 * the public repository, and `--source-remote` installs that branch from
 * another repository, such as a mirror. Any other track is the branch of the
 * same name in the repository `--source-remote` names.
 */
export function resolveReleaseSource(track: string, sourceRemote?: string): ReleaseSource {
  if (!RELEASE_TRACK_PATTERN.test(track)) {
    throw new GwsEaError(
      'invalid_release_track',
      `Release track ${track} is not a valid track name: use lowercase letters, digits, '.', '_', and '-', ` +
        `starting with a letter or digit, at most 64 characters. A branch with '/' in its name cannot be a track.`,
    );
  }
  const override = sourceRemote?.trim() || undefined;
  if (!Object.hasOwn(PRODUCT_TRACKS, track)) {
    if (!override) {
      throw new GwsEaError(
        'release_source_required',
        `Release track ${track} is not a product track; pass --source-remote to install its branch.`,
      );
    }
    return { remote: override, ref: `refs/heads/${track}` };
  }
  const branch = PRODUCT_TRACKS[track];
  if (!branch) {
    const released = Object.keys(PRODUCT_TRACKS).filter((name) => PRODUCT_TRACKS[name]);
    throw new GwsEaError(
      'release_unavailable',
      `Release track ${track} has no release yet; use --track ${released.join(' or --track ')}.`,
    );
  }
  return { remote: override ?? GWS_EA_RELEASE_REMOTE, ref: `refs/heads/${branch}` };
}
