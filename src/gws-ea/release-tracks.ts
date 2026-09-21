import { GwsEaError } from './types.js';

export const GWS_EA_RELEASE_REMOTE = 'https://github.com/taslim/nanoclaw-gws-ea.git';

const RELEASE_SOURCES: Readonly<Record<string, string>> = {
  prod: GWS_EA_RELEASE_REMOTE,
  dogfood: GWS_EA_RELEASE_REMOTE,
};

export function configuredReleaseSource(track: string): string {
  const source = RELEASE_SOURCES[track];
  if (!source) {
    throw new GwsEaError(
      'invalid_arguments',
      `Release track ${track} has no configured source; provide --source-remote explicitly.`,
    );
  }
  return source;
}
