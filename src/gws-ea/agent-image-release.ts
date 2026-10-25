/**
 * Agent images under the release layout. Each kept release has its own tag,
 * `<base>:r-<release>`, and its host runs that tag through `CONTAINER_IMAGE`,
 * so switching or rolling back a release moves no tag. Identical releases
 * share one image, found by its content-key label and tagged, never rebuilt.
 *
 * The build is hermetic: `container/build.sh` runs in a scratch export of only
 * the key's `container/` tree and the script it sources, so no `.env` and
 * nothing a release links to the assistant's state is within its reach, and
 * gws-ea passes every flag the script would read from a `.env`. The key is
 * therefore exactly the build context and those flags, whether a release is
 * staged, resumed, or rebuilt for a rollback.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { readEnvFile } from '../env.js';
import { getInstallScopedNames } from '../install-slug.js';
import { agentImageKey, inspectImage, provideSharedAgentImage, removeImage, type ImageDocker } from './agent-image.js';
import { prepareReleaseCommandEnvironments } from './checkout.js';
import type { InstanceLayout } from './release-layout.js';
import { GwsEaError } from './types.js';

const RELEASE_NAME = /^[0-9a-f]{8}$/u;
const TREE_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const BUILDING_TAG = 'building';
/**
 * What `container/build.sh` reads from its project besides `container/` and
 * the `.env` an export never holds; the test's inventory keeps this complete.
 */
const SOURCED_FILES = ['setup/lib/install-slug.sh'] as const;
/** Long enough for a first build of the agent image, not only a cached one. */
const IMAGE_BUILD_TIMEOUT_MS = 20 * 60_000;

export interface ReleaseImageInputs {
  /** The Git tree ID of the release's `container/`, the build context. */
  readonly contextTree: string;
  readonly installCjkFonts: boolean;
}

/**
 * The key every self-built agent image is labeled with, so images built before
 * releases had their own tags are shared too.
 */
export function releaseImageKey(inputs: ReleaseImageInputs): string {
  return agentImageKey({ ...inputs, hardenedImage: false });
}

export function readInstallCjkFonts(stateRoot: string): boolean {
  return readEnvFile(['INSTALL_CJK_FONTS'], stateRoot).INSTALL_CJK_FONTS === 'true';
}

export function releaseImageTag(base: string, release: string): string {
  if (!RELEASE_NAME.test(release)) {
    throw new GwsEaError('invalid_release', `${JSON.stringify(release)} is not a release name`);
  }
  return `${base}:r-${release}`;
}

export interface ReleaseImageRequest {
  readonly layout: InstanceLayout;
  readonly release: string;
  readonly installId: string;
  readonly inputs: ReleaseImageInputs;
}

async function buildReleaseImage(docker: ImageDocker, request: ReleaseImageRequest): Promise<void> {
  const { contextTree, installCjkFonts } = request.inputs;
  if (!TREE_ID.test(contextTree)) {
    throw new GwsEaError('invalid_release', `${JSON.stringify(contextTree)} is not a Git tree ID`);
  }
  const releaseRoot = request.layout.release(request.release);
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'gws-ea-image-'));
  try {
    const project = path.join(scratch, 'project');
    await mkdir(project, { mode: 0o700 });
    const environments = await prepareReleaseCommandEnvironments(scratch);
    const exportFromRelease = async (name: string, args: readonly string[]): Promise<void> => {
      const archive = path.join(scratch, `${name}.tar`);
      await docker.run({
        command: 'git',
        args: ['archive', '--format=tar', `--output=${archive}`, ...args],
        cwd: releaseRoot,
        env: { ...environments.git, GIT_NO_LAZY_FETCH: '1' },
      });
      await docker.run({
        command: 'tar',
        args: ['-xf', archive, '-C', project],
        cwd: scratch,
        env: environments.common,
      });
    };
    await exportFromRelease('context', ['--prefix=container/', contextTree]);
    await exportFromRelease('sourced', ['HEAD', '--', ...SOURCED_FILES]);
    await docker.run({
      command: 'bash',
      args: [path.join(project, 'container', 'build.sh'), BUILDING_TAG],
      cwd: project,
      env: {
        ...docker.env,
        INSTALL_CJK_FONTS: installCjkFonts ? 'true' : 'false',
        NANOCLAW_HARDENED_IMAGE: 'false',
        NANOCLAW_INSTALL_ID: request.installId,
      },
      timeoutMs: IMAGE_BUILD_TIMEOUT_MS,
      stream: true,
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function provideReleaseImage(
  docker: ImageDocker,
  request: ReleaseImageRequest,
): Promise<'shared' | 'built'> {
  const base = getInstallScopedNames(request.installId).containerImageBase;
  return provideSharedAgentImage(docker, {
    key: releaseImageKey(request.inputs),
    target: releaseImageTag(base, request.release),
    building: `${base}:${BUILDING_TAG}`,
    build: () => buildReleaseImage(docker, request),
  });
}

export async function removeReleaseImage(docker: ImageDocker, base: string, release: string): Promise<void> {
  await removeImage(docker, releaseImageTag(base, release));
}

/**
 * Delete the image a group-image rebuild displaced, by the ID recorded before
 * the rebuild, since no tag is left to remove it by. Any tag still on it (the
 * rebuild produced the same image, or another tag or assistant names it)
 * keeps it: Docker deleting an image by ID takes its tags with it.
 */
export async function reclaimImage(docker: ImageDocker, imageId: string): Promise<void> {
  const image = await inspectImage(docker, imageId);
  if (image === undefined || image.tags.length > 0) return;
  await removeImage(docker, imageId);
}
