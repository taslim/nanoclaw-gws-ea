/**
 * Agent images under the release layout (design C, KTD6). Each release an
 * assistant keeps has its own tag, `<base>:r-<release>`, and its host runs
 * that tag (`CONTAINER_IMAGE`, which NanoClaw's `src/config.ts` honors), so
 * switching or rolling back a release moves no tag at all. Identical releases
 * share one image: it is found by the content key its label carries and
 * tagged, never rebuilt (`provideSharedAgentImage`). A release's image goes
 * only when the assistant removes its own tag, which Docker does in one step
 * and only for the last tag naming it, so no assistant deletes an image
 * another tags.
 *
 * The build is hermetic by construction: NanoClaw's `container/build.sh` runs
 * in a scratch export of exactly what it reads from a project, the key's
 * `container/` tree and the script it sources, so neither a `.env` nor
 * anything a release links to the assistant's state is within its reach, and
 * gws-ea passes every flag the script would read from one. The key is then
 * exactly the build context and those flags, whenever a release is built:
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
/** The tag NanoClaw's build gives a release's image, before it is labeled with its key and tagged as the release's. */
const BUILDING_TAG = 'building';
/**
 * What `container/build.sh` reads from its project besides its own directory,
 * `container/`, and the `.env` an export never holds (its inventory test).
 */
const SOURCED_FILES = ['setup/lib/install-slug.sh'] as const;
/** As long as an update's build of the agent image may take, a first one included. */
const IMAGE_BUILD_TIMEOUT_MS = 20 * 60_000;

/** What a release's agent image is built from. */
export interface ReleaseImageInputs {
  /** The Git tree ID of the release's `container/`, the build context. */
  readonly contextTree: string;
  /** `INSTALL_CJK_FONTS`, as the assistant's state sets it (`readInstallCjkFonts`). */
  readonly installCjkFonts: boolean;
}

/**
 * The content key a release's image is labeled and shared under: the key
 * shared images carry since #34 for every install that builds its own image,
 * so assistants on identical releases share one image, and images built
 * before releases had their own tags are shared too.
 */
export function releaseImageKey(inputs: ReleaseImageInputs): string {
  return agentImageKey({ ...inputs, hardenedImage: false });
}

/** `INSTALL_CJK_FONTS` from the assistant's state, read with NanoClaw's own `.env` reader. */
export function readInstallCjkFonts(stateRoot: string): boolean {
  return readEnvFile(['INSTALL_CJK_FONTS'], stateRoot).INSTALL_CJK_FONTS === 'true';
}

/** The tag release `release`'s image has in the assistant's repository `base`: the image its host runs. */
export function releaseImageTag(base: string, release: string): string {
  if (!RELEASE_NAME.test(release)) {
    throw new GwsEaError('invalid_release', `${JSON.stringify(release)} is not a release name`);
  }
  return `${base}:r-${release}`;
}

/** A release that needs its image. */
export interface ReleaseImageRequest {
  readonly layout: InstanceLayout;
  /** The release's name; its directory is a checkout of its commit. */
  readonly release: string;
  /** The assistant's install ID, which names its image repository. */
  readonly installId: string;
  readonly inputs: ReleaseImageInputs;
}

/**
 * Build the image `request.inputs` names with NanoClaw's own
 * `container/build.sh`, tagged `building` for `provideReleaseImage` to label.
 * The script runs in a scratch directory, owner-only and always removed,
 * holding only the key's `container/` tree and what the script sources,
 * exported from the release's Git objects: whatever else the release
 * directory holds, its links to the assistant's state included, is out of the
 * build's reach. Its flags come from gws-ea alone: the key's
 * `INSTALL_CJK_FONTS`, `NANOCLAW_HARDENED_IMAGE=false` (an assistant always
 * builds its own image), and the install ID its repository is named from.
 */
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

/**
 * Give a release its image tag: the image shared under its key, tagged, or
 * one built from the release once and labeled (`provideSharedAgentImage`).
 */
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

/** Remove a pruned release's tag; Docker deletes the image with it only when no other tag names it. */
export async function removeReleaseImage(docker: ImageDocker, base: string, release: string): Promise<void> {
  await removeImage(docker, releaseImageTag(base, release));
}

/**
 * Delete the image a rebuild of an agent group's own image displaced, by the
 * ID recorded before the rebuild (KTD6): the rebuild moved the group's tag
 * off it and left it no tag to remove. It is deleted only when it is still
 * there and Docker reports no tag on it: the rebuild produced the same image,
 * or another assistant or tag still names it, and Docker deletes an image of
 * one repository by ID together with its tags, another assistant's included.
 */
export async function reclaimImage(docker: ImageDocker, imageId: string): Promise<void> {
  const image = await inspectImage(docker, imageId);
  if (image === undefined || image.tags.length > 0) return;
  await removeImage(docker, imageId);
}
