/**
 * What an assistant keeps with each release besides its checkout (KTD6,
 * KTD8, KTD19): the files a cutover gathers from the live release before its
 * swap moves them to `previous/`, and the manifest that says which release
 * they were and whose. Update, rollback, and the cutover between them all
 * read and write kept releases through here.
 */
import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import { writePrivate } from '../community-portal/private-file.js';
import type { ControlPlanePaths } from './paths.js';
import { validateReleaseCoordinates } from './registry.js';
import { readOwnerOnlyFile, readOwnerOnlyJson, writePrivateTextFile } from './secrets.js';
import { GwsEaError, type ReleaseCoordinates } from './types.js';
import { isRecord, requireCanonicalTimestamp } from './validation.js';

/**
 * What an assistant keeps with each release besides its checkout, so a
 * rollback can put the release back as it ran (KTD6, KTD8): its manifest, its
 * receipt, its OneCLI Compose file, its service definition, and gws-ea's
 * `.env` keys.
 */
export interface KeptReleaseFiles {
  readonly manifest: string;
  readonly receipt: string;
  readonly compose: string;
  readonly serviceDefinition: string;
  readonly hostEnvironment: string;
}

/** Where a release slot (`<instance>/<slot>/`) keeps its release's files. */
export function keptReleaseFiles(releaseRoot: string): KeptReleaseFiles {
  return {
    manifest: path.join(releaseRoot, 'release-manifest.json'),
    receipt: path.join(releaseRoot, 'release-preflight.json'),
    compose: path.join(releaseRoot, 'onecli-compose.yaml'),
    serviceDefinition: path.join(releaseRoot, 'service-definition'),
    hostEnvironment: path.join(releaseRoot, 'host-environment.json'),
  };
}

export const KEPT_RELEASE_MANIFEST_SCHEMA_VERSION = 1 as const;

/**
 * What a kept release is: the assistant it belongs to, the release it ran
 * (source, track, and commit, which its marker alone does not name), and when
 * its host stopped for the cutover that kept it, so its checkout's state is
 * as of then. Readers ignore unknown fields.
 */
export interface KeptReleaseManifest {
  readonly schema_version: typeof KEPT_RELEASE_MANIFEST_SCHEMA_VERSION;
  readonly instance_id: string;
  readonly release: ReleaseCoordinates;
  readonly snapshot_at: string;
}

/** A kept release's manifest, refused when it belongs to another assistant: a release is restorable only into its own. */
export async function readKeptReleaseManifest(releaseRoot: string, instanceId: string): Promise<KeptReleaseManifest> {
  const file = keptReleaseFiles(releaseRoot).manifest;
  const value = await readOwnerOnlyJson(file, 'Kept release manifest', 'invalid_kept_release');
  const invalid = (detail: string): GwsEaError =>
    new GwsEaError('invalid_kept_release', `The kept release manifest ${file} ${detail}.`);
  if (!isRecord(value) || value.schema_version !== KEPT_RELEASE_MANIFEST_SCHEMA_VERSION) {
    throw invalid('was written by a different gws-ea');
  }
  if (value.instance_id !== instanceId) {
    throw new GwsEaError(
      'kept_release_mismatch',
      `The release kept in ${releaseRoot} belongs to another assistant, so it cannot be restored into ${instanceId}.`,
    );
  }
  let release: ReleaseCoordinates;
  try {
    release = validateReleaseCoordinates(value.release);
  } catch (error) {
    if (!(error instanceof GwsEaError)) throw error;
    throw invalid('names no valid release');
  }
  return {
    schema_version: KEPT_RELEASE_MANIFEST_SCHEMA_VERSION,
    instance_id: instanceId,
    release,
    snapshot_at: requireCanonicalTimestamp(value.snapshot_at, 'invalid_kept_release', `${file} names no snapshot time`),
  };
}

/** The live release's files a cutover keeps. */
export interface KeptReleaseSources {
  readonly manifest: KeptReleaseManifest;
  readonly receipt: string;
  readonly compose: string;
  /** Undefined when the release has no service definition installed. */
  readonly serviceDefinition: string | undefined;
  readonly hostEnvironment: Readonly<Record<string, string>>;
}

/** Where a cutover gathers the live release's files before its swap moves them to `previous/`. */
export function stagedKeptFilesRoot(paths: ControlPlanePaths, instanceId: string): string {
  return path.join(paths.releaseRoot(instanceId, 'next'), 'previous');
}

/** Copy the live release's files into `root`, owner-only, replacing whatever an earlier attempt left there. */
export async function keepReleaseFiles(root: string, sources: KeptReleaseSources): Promise<void> {
  const building = `${root}.building`;
  await rm(building, { recursive: true, force: true });
  await mkdir(building, { mode: 0o700 });
  const kept = keptReleaseFiles(building);
  await writePrivate(kept.manifest, sources.manifest);
  await writePrivateTextFile(kept.receipt, await readOwnerOnlyFile(sources.receipt));
  await writePrivateTextFile(kept.compose, await readOwnerOnlyFile(sources.compose));
  if (sources.serviceDefinition !== undefined) {
    await writePrivateTextFile(kept.serviceDefinition, await readFile(sources.serviceDefinition, 'utf8'));
  }
  await writePrivate(kept.hostEnvironment, sources.hostEnvironment);
  await rm(root, { recursive: true, force: true });
  await rename(building, root);
}
