/**
 * The paths of a NanoClaw checkout that hold the install's own state rather
 * than its release's code, relative to the checkout root. An update carries
 * them from one checkout to the next and snapshots them for rollback;
 * everything else in a checkout belongs to the release.
 */
export const MUTABLE_PATHS = ['.env', 'data', 'groups', 'store', 'start-nanoclaw.sh', 'nanoclaw.pid'] as const;

export type MutablePath = (typeof MUTABLE_PATHS)[number];
