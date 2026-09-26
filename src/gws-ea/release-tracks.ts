import { GwsEaError } from './types.js';

const GWS_EA_RELEASE_REMOTE = 'https://github.com/taslim/nanoclaw-gws-ea.git';

/**
 * The branch each product release track follows in the public repository, or
 * `null` while the track has no release. A track names a release line; which
 * branch carries it is configuration, so moving a line is a one-line change.
 */
const PRODUCT_TRACKS: Readonly<Record<string, string | null>> = {
  // Public `main` once the rebuild is promoted there; the pre-rebuild `main` is not a release.
  prod: null,
  // The integration line its operator runs first.
  dogfood: 'rebuild-v2',
};

export interface ReleaseSource {
  readonly remote: string;
  /** The branch ref the track resolves to an exact commit. */
  readonly ref: string;
}

/**
 * Where a release track installs from. A product track follows its branch of
 * the public repository, and `--source-remote` installs that branch from
 * another repository, such as a mirror. Any other track is the branch of the
 * same name in the repository `--source-remote` names.
 */
export function resolveReleaseSource(track: string, sourceRemote?: string): ReleaseSource {
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
