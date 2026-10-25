import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { onecliGatewayImage, type OnecliPins } from './onecli-compose.js';

/**
 * The gws-ea wrapper gateway image: the pinned OneCLI base plus an in-namespace
 * egress firewall applied before the gateway starts. The image is addressed by
 * its source files' bytes, so any edit to them, a comment included, forces a
 * rebuild, and a stale-ruled image fails identity verification.
 */

/** OCI label the wrapper stamps with its build-context content hash; read back at verify time. */
export const ONECLI_WRAPPER_LABEL = 'dev.gws-ea.onecli-wrapper' as const;

/** Must match the wrapper Dockerfile's `ARG` names. */
export const ONECLI_WRAPPER_BASE_ARG = 'ONECLI_BASE' as const;
export const ONECLI_WRAPPER_HASH_ARG = 'GATEWAY_WRAPPER_HASH' as const;

/** Files that make up the wrapper build context; the content hash covers these plus the base tag. */
const WRAPPER_SOURCE_FILES = ['Dockerfile', 'rules.sh', 'entrypoint.sh'] as const;

export function wrapperImageSourceDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'onecli-gateway-image');
}

/**
 * Keys both the image tag and the provenance label, so identical content reuses
 * one shared image and any change to the firewall (or the base) yields a new
 * identity.
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

const WRAPPER_IMAGE_REPOSITORY = 'gws-ea-onecli-gateway';
const WRAPPER_IMAGE_TAG = new RegExp(`^${WRAPPER_IMAGE_REPOSITORY}:([0-9a-f]{16})$`, 'u');

export function wrapperImageTag(hash: string): string {
  return `${WRAPPER_IMAGE_REPOSITORY}:${hash}`;
}

/** Undefined when `image` is not a wrapper tag. The image's provenance label must carry this hash. */
export function wrapperImageHash(image: string): string | undefined {
  return WRAPPER_IMAGE_TAG.exec(image)?.[1];
}

export async function resolveWrapperGatewayImage(
  pins: Pick<OnecliPins, 'gateway'>,
): Promise<{ readonly hash: string; readonly image: string }> {
  const hash = await computeWrapperImageHash(pins);
  return { hash, image: wrapperImageTag(hash) };
}
