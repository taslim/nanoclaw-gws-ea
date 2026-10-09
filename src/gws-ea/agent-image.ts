/**
 * Agent images, shared by content (KTD7). Every assistant keeps its own tags
 * in its own repository, `nanoclaw-agent-v2-<install>`: `:latest`, `:previous`,
 * an update's `:next`, and each agent group's `:<agentGroupId>`. The base
 * image those tags name is built once per content key (see `agentImageKey`)
 * and labeled with it, and every other assistant that needs the same key tags
 * that image instead of building its own, so identical images take one copy
 * of disk, like the content-addressed gateway image (`onecli-gateway-image.ts`).
 *
 * No tag is shared, and none is added for sharing: an image lives exactly as
 * long as some assistant's tag names it. An image an assistant still needs
 * while no other tag of its own names it, one a switch took a tag off, is held
 * under a tag of its own (`holdImage`). Nothing is deleted by ID: an image
 * goes only when an assistant removes a tag of its own that was the last to
 * name it, which Docker decides in one step (`releaseImage`), so another
 * assistant's tag always keeps it.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { isErrno } from '../community-portal/errors.js';
import { committedTree, type CheckoutRuntime } from './checkout.js';
import type { SanitizedCommandRunner } from './process.js';
import { GwsEaError } from './types.js';
import { isRecord, parseJson } from './validation.js';

/** The label an agent image carries its content key under, in gws-ea's `dev.gws-ea.*` namespace. */
export const AGENT_IMAGE_KEY_LABEL = 'dev.gws-ea.agent-key' as const;

/** Names the key's definition, so a change to what it covers can never collide with an older key. */
const AGENT_IMAGE_KEY_VERSION = 'gws-ea agent image key 1';
const AGENT_IMAGE_KEY = /^[0-9a-f]{64}$/u;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/u;
/**
 * A tag that names an assistant's agent image itself: a kept release's
 * `:r-<release>` (`agent-image-release.ts`), `:latest`, `:previous`, or an
 * update's `:next`, in an assistant's repository (`nanoclaw-agent-v2-` and its
 * install slug, `src/install-slug.ts`). An agent group's own image,
 * `:<agentGroupId>`, is built `FROM` the agent image and inherits its labels,
 * the key's included, so only these tags make an image the one a key names.
 */
const AGENT_IMAGE_TAG = /^nanoclaw-agent-v2-[a-z0-9][a-z0-9_-]{0,31}:(?:latest|previous|next|r-[0-9a-f]{8})$/u;
/** How a hold's tag starts (see `heldImageTag`); an agent group's ID starts `ag-`, so none is taken for one. */
const HELD_TAG_PREFIX = 'held-';
const DOCKER_TIMEOUT_MS = 60_000;
/** The label build adds no layer, but Docker still exports an image, which a busy daemon can take a while over. */
const LABEL_BUILD_TIMEOUT_MS = 5 * 60_000;

/** The flags NanoClaw's `container/build.sh` reads from the checkout's `.env` that change what it builds. */
export interface AgentImageBuildFlags {
  /** `INSTALL_CJK_FONTS`: build.sh adds the CJK fonts only for exactly `true`. */
  readonly installCjkFonts: boolean;
  /** `NANOCLAW_HARDENED_IMAGE`: `true`, in any case, has build.sh overlay a pulled image or refuse, never build. */
  readonly hardenedImage: boolean;
}

/** Everything an agent image is built from (see `agentImageKey`). */
export interface AgentImageInputs extends AgentImageBuildFlags {
  /** The Git tree ID of the release's `container/`, the build context. */
  readonly contextTree: string;
}

/**
 * The content key of the agent image NanoClaw's `container/build.sh` builds:
 * a SHA-256 over exactly the inputs that decide it.
 *
 * - `contextTree`: the release's build context, `container/`, as the ID of
 *   its Git tree at the release commit. It covers the Dockerfile, every file
 *   the build copies (the agent-runner's `package.json` and `bun.lock`,
 *   `cli-tools.json`, `install-cli-tools.sh`, `entrypoint.sh`), and the one
 *   build argument build.sh derives from them, `AGENT_RUNNER_LOCK_SHA256`,
 *   the hash of `container/agent-runner/bun.lock`.
 * - `installCjkFonts`: `INSTALL_CJK_FONTS` from the assistant's `.env`, the
 *   only other build argument build.sh passes.
 * - `hardenedImage`: `NANOCLAW_HARDENED_IMAGE` from the same `.env`, which
 *   decides whether build.sh builds at all.
 *
 * Nothing else reaches the build. The image's repository and tag name it
 * without changing it, and gws-ea hands build.sh no other variable it reads:
 * only `HOME`, `DOCKER_HOST`, `NANOCLAW_INSTALL_ID`, the operator's tools,
 * and `INSTALL_CJK_FONTS` as the key names it.
 */
export function agentImageKey(inputs: AgentImageInputs): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        AGENT_IMAGE_KEY_VERSION,
        inputs.contextTree,
        inputs.installCjkFonts ? 'cjk-fonts' : 'no-cjk-fonts',
        inputs.hardenedImage ? 'hardened' : 'built',
      ]),
    )
    .digest('hex');
}

/**
 * The value build.sh reads for `name` from `.env` text: its last line that
 * starts `name=`, everything after the first `=`, with every quote and
 * whitespace character removed (`grep '^name=' | tail -n1 | cut -d= -f2- |
 * tr -d '"' | tr -d "'" | tr -d '[:space:]'`). Empty when no line sets it.
 */
function buildScriptSetting(environment: string, name: string): string {
  const line = environment
    .split('\n')
    .filter((candidate) => candidate.startsWith(`${name}=`))
    .at(-1);
  return line === undefined ? '' : line.slice(name.length + 1).replace(/["' \t\n\v\f\r]/gu, '');
}

/** The build flags in `.env` text, read exactly as build.sh reads them. */
export function agentImageBuildFlags(environment: string): AgentImageBuildFlags {
  return {
    installCjkFonts: buildScriptSetting(environment, 'INSTALL_CJK_FONTS') === 'true',
    hardenedImage: buildScriptSetting(environment, 'NANOCLAW_HARDENED_IMAGE').toLowerCase() === 'true',
  };
}

/** Where a release's agent image inputs are read. */
export interface AgentImageSource {
  /** A Git repository holding the release commit. */
  readonly repository: string;
  readonly commit: string;
  /** The checkout whose `.env` build.sh reads. */
  readonly checkout: string;
}

/** Read an agent image's inputs: the release's `container/` tree and the checkout's `.env` build flags. */
export async function readAgentImageInputs(
  source: AgentImageSource,
  runtime: CheckoutRuntime = {},
): Promise<AgentImageInputs> {
  const [contextTree, environment] = await Promise.all([
    committedTree(source.repository, source.commit, 'container', runtime),
    readFile(path.join(source.checkout, '.env'), 'utf8').catch((error: unknown) => {
      // build.sh reads no flag from a checkout without a `.env`.
      if (isErrno(error, 'ENOENT')) return '';
      throw error;
    }),
  ]);
  return { contextTree, ...agentImageBuildFlags(environment) };
}

/** Docker as one assistant runs it: the runner, its working directory, and the assistant's Docker environment. */
export interface ImageDocker {
  readonly run: SanitizedCommandRunner;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

function docker(context: ImageDocker, args: readonly string[], options: { input?: string; timeoutMs?: number } = {}) {
  return context.run({
    command: 'docker',
    args,
    cwd: context.cwd,
    env: context.env,
    timeoutMs: options.timeoutMs ?? DOCKER_TIMEOUT_MS,
    ...(options.input === undefined ? {} : { input: options.input }),
  });
}

/** Whether a failed Docker command failed only because the image it named is gone. */
function noSuchImage(error: unknown): boolean {
  return (
    error instanceof GwsEaError &&
    error.code === 'command_failed' &&
    /No such image/iu.test(String(error.details?.stderrTail ?? ''))
  );
}

/** The ID of the image `reference` names, or undefined when it names none. */
export async function taggedImageId(context: ImageDocker, reference: string): Promise<string | undefined> {
  const listed = new Set(
    (await docker(context, ['image', 'ls', '--quiet', '--no-trunc', reference])).stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean),
  );
  const [id, ...others] = listed;
  if (id === undefined) return undefined;
  if (others.length > 0 || !IMAGE_ID.test(id)) {
    throw new GwsEaError('invalid_child_output', `Docker reported no single image ID for ${reference}`);
  }
  return id;
}

/** An image's `RepoTags` as Docker reports them: an image no tag names has an empty list, or none at all. */
function repoTags(tags: unknown): readonly string[] {
  if (tags === null || tags === undefined) return [];
  if (!Array.isArray(tags) || !tags.every((tag): tag is string => typeof tag === 'string')) {
    throw new GwsEaError('invalid_child_output', 'Docker reported invalid image tags');
  }
  return tags;
}

/** The tags `docker image inspect --format '{{json .RepoTags}}'` reports. */
function imageTags(output: string): readonly string[] {
  let tags: unknown;
  try {
    tags = JSON.parse(output);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new GwsEaError('invalid_child_output', 'Docker reported invalid image tags', { cause: error });
  }
  return repoTags(tags);
}

/** The tag an assistant holds an image under, in its repository `base`, named by the image (see `holdImage`). */
export function heldImageTag(base: string, imageId: string): string {
  return `${base}:${HELD_TAG_PREFIX}${imageId.slice('sha256:'.length, 'sha256:'.length + 12)}`;
}

/**
 * Hold an image under a tag of the assistant's own (`heldImageTag`), so no
 * assistant's release deletes it while this one may still need it. One
 * already gone is not held.
 */
export async function holdImage(context: ImageDocker, base: string, imageId: string): Promise<void> {
  try {
    await docker(context, ['tag', imageId, heldImageTag(base, imageId)]);
  } catch (error) {
    if (!noSuchImage(error)) throw error;
  }
}

/**
 * Release an image the assistant no longer needs (KTD19): hold it, then
 * remove the hold. Docker deletes an image with the last tag that names it,
 * in one step, so the image goes only if no tag of any assistant's still
 * names it, and a tag another assistant adds meanwhile keeps it. One already
 * gone is released.
 */
export async function releaseImage(context: ImageDocker, base: string, imageId: string): Promise<void> {
  const held = heldImageTag(base, imageId);
  try {
    await docker(context, ['tag', imageId, held]);
  } catch (error) {
    if (noSuchImage(error)) return;
    throw error;
  }
  await docker(context, ['image', 'rm', held]);
}

/**
 * Move an assistant's image tags (`move`) with every image in `imageIds`,
 * those its record names, held while they move. After the move, an image a
 * tag of the assistant's own names again gives up its hold. One the move left
 * without such a tag keeps it until its record's follow-ups release it, or
 * until a later move names it again.
 */
export async function moveHoldingImages(
  context: ImageDocker,
  base: string,
  imageIds: readonly string[],
  move: () => Promise<void>,
): Promise<void> {
  const held = [...new Set(imageIds)];
  for (const id of held) await holdImage(context, base, id);
  await move();
  for (const id of held) {
    let tags: readonly string[];
    try {
      tags = imageTags((await docker(context, ['image', 'inspect', '--format', '{{json .RepoTags}}', id])).stdout);
    } catch (error) {
      if (noSuchImage(error)) continue;
      throw error;
    }
    const hold = heldImageTag(base, id);
    const named = tags.some((tag) => tag.startsWith(`${base}:`) && !tag.startsWith(`${base}:${HELD_TAG_PREFIX}`));
    if (named && tags.includes(hold)) await docker(context, ['image', 'rm', hold]);
  }
}

/** Release every image the assistant holds: its holds as `docker image ls` lists them in its repository `base`. */
async function releaseHeldImages(context: ImageDocker, base: string): Promise<void> {
  const holds = (await docker(context, ['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}', base])).stdout
    .split(/\r?\n/u)
    .map((reference) => reference.trim())
    .filter((reference) => reference.startsWith(`${base}:${HELD_TAG_PREFIX}`));
  for (const hold of holds) await docker(context, ['image', 'rm', hold]);
}

/**
 * `docker image rm reference`, Docker deciding what goes: a tag is removed,
 * and its image with it only when no other tag names it; an image ID deletes
 * the image with every tag of its one repository. One already gone is removed.
 */
export async function removeImage(context: ImageDocker, reference: string): Promise<void> {
  try {
    await docker(context, ['image', 'rm', reference]);
  } catch (error) {
    if (!noSuchImage(error)) throw error;
  }
}

/** What `docker image inspect` says of one image that matters for sharing it. */
interface InspectedImage {
  readonly id: string;
  readonly tags: readonly string[];
  readonly created: number;
  readonly key: string | undefined;
}

/** One image as `docker image inspect` reports it, or undefined when it is gone. */
export async function inspectImage(context: ImageDocker, imageId: string): Promise<InspectedImage | undefined> {
  let stdout: string;
  try {
    ({ stdout } = await docker(context, ['image', 'inspect', imageId]));
  } catch (error) {
    if (noSuchImage(error)) return undefined;
    throw error;
  }
  const parsed = parseJson(stdout, 'Docker image inspection', 'invalid_child_output');
  const image: unknown = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : undefined;
  const invalid = () => new GwsEaError('invalid_child_output', `Docker reported an invalid inspection of ${imageId}`);
  if (!isRecord(image) || image.Id !== imageId || typeof image.Created !== 'string') throw invalid();
  const created = Date.parse(image.Created);
  if (Number.isNaN(created)) throw invalid();
  const labels = isRecord(image.Config) ? image.Config.Labels : undefined;
  if (labels !== undefined && labels !== null && !isRecord(labels)) throw invalid();
  const key = isRecord(labels) ? labels[AGENT_IMAGE_KEY_LABEL] : undefined;
  return {
    id: imageId,
    tags: repoTags(image.RepoTags),
    created,
    key: typeof key === 'string' ? key : undefined,
  };
}

/**
 * The image shared under `key`, or undefined when there is none: of the
 * images whose label carries exactly `key` and that some assistant tags as its
 * agent image (see `AGENT_IMAGE_TAG`), the newest, ties going to the greater
 * ID. An image no such tag names is either on its way out (held by the
 * assistant that displaced it until it releases it), so never taken up again,
 * or an agent group's own image built on the keyed one.
 */
export async function findSharedAgentImage(context: ImageDocker, key: string): Promise<string | undefined> {
  if (!AGENT_IMAGE_KEY.test(key)) throw new GwsEaError('invalid_agent_image_key', 'The agent image key is invalid');
  const { stdout } = await docker(context, [
    'image',
    'ls',
    '--quiet',
    '--no-trunc',
    '--filter',
    'dangling=false',
    '--filter',
    `label=${AGENT_IMAGE_KEY_LABEL}=${key}`,
  ]);
  const listed = [
    ...new Set(
      stdout
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
  if (listed.some((id) => !IMAGE_ID.test(id))) {
    throw new GwsEaError('invalid_child_output', 'Docker reported an invalid image ID');
  }
  const shared: InspectedImage[] = [];
  for (const id of listed) {
    const image = await inspectImage(context, id);
    if (image && image.key === key && image.tags.some((tag) => AGENT_IMAGE_TAG.test(tag))) shared.push(image);
  }
  shared.sort((left, right) => right.created - left.created || (left.id < right.id ? 1 : -1));
  return shared[0]?.id;
}

/**
 * Tag the image found shared as `target`, and say whether it could: one whose
 * last tag went since it was found is gone.
 */
async function tagShared(context: ImageDocker, shared: string, target: string): Promise<boolean> {
  try {
    await docker(context, ['tag', shared, target]);
    return true;
  } catch (error) {
    if (noSuchImage(error)) return false;
    throw error;
  }
}

/** How an assistant gets the agent image its release's key names. */
export interface SharedAgentImageRequest {
  readonly key: string;
  /** The tag the assistant needs the image under. */
  readonly target: string;
  /** The tag NanoClaw's own build gives the image before it is labeled, which nothing else writes. */
  readonly building: string;
  /** NanoClaw's own build of the image, tagged `building`. */
  readonly build: () => Promise<void>;
}

/**
 * Tag the image shared under the request's key as `target`, or, when there is
 * none, build it with NanoClaw's own build and label it: the label is added by
 * a metadata-only build `FROM` the built image, which adds no filesystem
 * layer, tagged `target`; then the `building` tag goes, and with it the
 * unlabeled image unless another tag names it. Until then the `building` tag
 * holds the unlabeled image, so a run killed anywhere in between leaves only
 * the assistant's own tags, which its next update's discard of the staging
 * removes, as does `remove`. A shared image gone by the time it is tagged is
 * built instead. Returns whether the image was shared or built.
 */
export async function provideSharedAgentImage(
  context: ImageDocker,
  request: SharedAgentImageRequest,
): Promise<'shared' | 'built'> {
  const shared = await findSharedAgentImage(context, request.key);
  if (shared && (await tagShared(context, shared, request.target))) return 'shared';
  await request.build();
  await docker(context, ['build', '--label', `${AGENT_IMAGE_KEY_LABEL}=${request.key}`, '--tag', request.target, '-'], {
    input: `FROM ${request.building}\n`,
    timeoutMs: LABEL_BUILD_TIMEOUT_MS,
  });
  await docker(context, ['image', 'rm', request.building]);
  return 'built';
}

/**
 * Point `target`, a tag of the new assistant's own in its repository `base`,
 * at the image shared under `key`, when there is one, and say whether it did.
 * The image `target` named before is held while the tag moves, then
 * released. A create cut short leaves only that hold behind, and the next
 * attempt releases every hold first: an assistant being created has recorded
 * nothing that needs an image it holds.
 */
export async function adoptSharedAgentImage(
  context: ImageDocker,
  key: string,
  base: string,
  target: string,
): Promise<boolean> {
  await releaseHeldImages(context, base);
  const shared = await findSharedAgentImage(context, key);
  if (!shared) return false;
  const displaced = await taggedImageId(context, target);
  if (displaced === shared) return true;
  if (displaced) await holdImage(context, base, displaced);
  const adopted = await tagShared(context, shared, target);
  if (displaced) await releaseImage(context, base, displaced);
  return adopted;
}
