/**
 * Agent images, shared by content. Each assistant tags only in its own
 * repository, `nanoclaw-agent-v2-<install>`: each kept release's
 * `:r-<release>` and each agent group's `:<agentGroupId>`. A release's image
 * is built once per content key and labeled with it; any other assistant that
 * needs the same key tags that image instead of building, so identical images
 * take one copy of disk.
 *
 * No tag is shared and none is added for sharing: an image lives while some
 * assistant's tag names it, and Docker deletes it in one step with the last
 * such tag (`removeImage`), so another assistant's tag always keeps it.
 */
import { createHash } from 'node:crypto';

import type { SanitizedCommandRunner } from './process.js';
import { GwsEaError } from './types.js';
import { isRecord, parseJson } from './validation.js';

export const AGENT_IMAGE_KEY_LABEL = 'dev.gws-ea.agent-key' as const;

/** Names the key's definition, so a change to what it covers can never collide with an older key. */
const AGENT_IMAGE_KEY_VERSION = 'gws-ea agent image key 1';
const AGENT_IMAGE_KEY = /^[0-9a-f]{64}$/u;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/u;
/**
 * A tag naming an assistant's agent image itself: a kept release's
 * `:r-<release>`, or the `:latest`, `:previous` and `:next` of the layout
 * before releases had their own tags. An agent group's `:<agentGroupId>` image
 * is built `FROM` the agent image and inherits its key label, so only these
 * tags make an image the one a key names.
 */
const AGENT_IMAGE_TAG = /^nanoclaw-agent-v2-[a-z0-9][a-z0-9_-]{0,31}:(?:latest|previous|next|r-[0-9a-f]{8})$/u;
const DOCKER_TIMEOUT_MS = 60_000;
/** The label build adds no layer, but Docker still exports an image, which a busy daemon can take a while over. */
const LABEL_BUILD_TIMEOUT_MS = 5 * 60_000;

export interface AgentImageInputs {
  /** The Git tree ID of the release's `container/`, the build context. */
  readonly contextTree: string;
  /** `INSTALL_CJK_FONTS`: build.sh adds the CJK fonts only for exactly `true`. */
  readonly installCjkFonts: boolean;
  /** `NANOCLAW_HARDENED_IMAGE`: `true`, in any case, has build.sh overlay a pulled image or refuse, never build. */
  readonly hardenedImage: boolean;
}

/**
 * A SHA-256 over exactly the inputs that decide the image `container/build.sh`
 * builds. `contextTree` covers the Dockerfile, every file the build copies,
 * and `AGENT_RUNNER_LOCK_SHA256`, which build.sh derives from
 * `container/agent-runner/bun.lock`; `INSTALL_CJK_FONTS` is the only other
 * build argument; `NANOCLAW_HARDENED_IMAGE` decides whether build.sh builds at
 * all. The repository and tag name the image without changing it, and no other
 * variable gws-ea hands build.sh (`buildReleaseImage`) changes it.
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

/** Docker as one assistant runs it, with that assistant's Docker environment. */
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

function noSuchImage(error: unknown): boolean {
  return (
    error instanceof GwsEaError &&
    error.code === 'command_failed' &&
    /No such image/iu.test(String(error.details?.stderrTail ?? ''))
  );
}

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

/** Docker reports an untagged image's `RepoTags` as an empty list or not at all. */
function repoTags(tags: unknown): readonly string[] {
  if (tags === null || tags === undefined) return [];
  if (!Array.isArray(tags) || !tags.every((tag): tag is string => typeof tag === 'string')) {
    throw new GwsEaError('invalid_child_output', 'Docker reported invalid image tags');
  }
  return tags;
}

/**
 * Docker decides what goes: a tag is removed, with its image only when no
 * other tag names it; an image ID deletes the image with every tag of its one
 * repository. An image already gone counts as removed.
 */
export async function removeImage(context: ImageDocker, reference: string): Promise<void> {
  try {
    await docker(context, ['image', 'rm', reference]);
  } catch (error) {
    if (!noSuchImage(error)) throw error;
  }
}

interface InspectedImage {
  readonly id: string;
  readonly tags: readonly string[];
  readonly created: number;
  readonly key: string | undefined;
}

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
 * Only an image some assistant tags as its agent image (`AGENT_IMAGE_TAG`)
 * qualifies. Any other image with the key is either on its way out, never to
 * be taken up again, or an agent group's own image built on the keyed one.
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

/** False when the image was deleted, with its last tag, after it was found. */
async function tagShared(context: ImageDocker, shared: string, target: string): Promise<boolean> {
  try {
    await docker(context, ['tag', shared, target]);
    return true;
  } catch (error) {
    if (noSuchImage(error)) return false;
    throw error;
  }
}

export interface SharedAgentImageRequest {
  readonly key: string;
  readonly target: string;
  /** The tag `build` must give the unlabeled image; nothing else writes it. */
  readonly building: string;
  readonly build: () => Promise<void>;
}

/**
 * The label goes on through a metadata-only build `FROM` the built image,
 * which adds no filesystem layer. Until the `building` tag is removed it names
 * the unlabeled image, so a run killed in between leaves only the assistant's
 * own tags, which `remove` removes.
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
