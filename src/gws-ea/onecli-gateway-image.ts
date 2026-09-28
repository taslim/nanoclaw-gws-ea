import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { onecliGatewayImage, type OnecliPins } from './onecli-compose.js';

/**
 * The gws-ea wrapper gateway image: the pinned OneCLI base plus an in-namespace
 * egress firewall applied before the gateway starts (see docs/gateway-seam.md and
 * the plan's KTD1/KTD5/KTD6). This module owns the build-context identity — the
 * source lives in the gws-ea tree, and the image is content-addressed so a rules
 * change forces a rebuild and a stale-ruled image fails identity verification.
 */

/** OCI label the wrapper stamps with its build-context content hash; read back at verify time (KTD6). */
export const ONECLI_WRAPPER_LABEL = 'dev.gws-ea.onecli-wrapper' as const;

/** Docker build args the wrapper Dockerfile consumes. */
export const ONECLI_WRAPPER_BASE_ARG = 'ONECLI_BASE' as const;
export const ONECLI_WRAPPER_HASH_ARG = 'GATEWAY_WRAPPER_HASH' as const;

/** Files that make up the wrapper build context; the content hash covers these plus the base tag. */
const WRAPPER_SOURCE_FILES = ['Dockerfile', 'rules.sh', 'entrypoint.sh'] as const;

/** Absolute path to the in-tree wrapper image source directory (gws-ea owns it — KTD5). */
export function wrapperImageSourceDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'onecli-gateway-image');
}

/**
 * Content hash of the wrapper build context: each source file's name and bytes,
 * plus the pinned base image tag. Keys both the image tag and the provenance
 * label, so identical content reuses one shared image and any change to the
 * firewall (or the base) yields a new identity (KTD5/KTD6).
 */
export async function computeWrapperImageHash(pins: Pick<OnecliPins, 'gateway'>): Promise<string> {
  const dir = wrapperImageSourceDir();
  const hash = createHash('sha256');
  for (const name of WRAPPER_SOURCE_FILES) {
    hash.update(name);
    hash.update('\0');
    hash.update(await readFile(path.join(dir, name)));
    hash.update('\0');
  }
  hash.update(onecliGatewayImage(pins));
  return hash.digest('hex').slice(0, 16);
}

/** The local, content-addressed wrapper image reference. Shared across instances built from the same content. */
export function wrapperImageTag(hash: string): string {
  return `gws-ea-onecli-gateway:${hash}`;
}

/** Resolve the wrapper's content hash and image reference together — the single source for the hash→tag pairing. */
export async function resolveWrapperGatewayImage(
  pins: Pick<OnecliPins, 'gateway'>,
): Promise<{ readonly hash: string; readonly image: string }> {
  const hash = await computeWrapperImageHash(pins);
  return { hash, image: wrapperImageTag(hash) };
}
