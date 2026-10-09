/**
 * Agent images shared by content. The key names exactly what NanoClaw's
 * `container/build.sh` builds an image from, its `.env` flags read as the
 * script itself reads them (proven by running the script against a
 * recording container runtime), and the lookup takes up only an image some
 * tag names whose label carries exactly the key, the newest first. An image
 * is held under a tag of the assistant's own while it may be needed, and
 * released only by removing that tag, never deleted by ID.
 */
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AGENT_IMAGE_KEY_LABEL,
  adoptSharedAgentImage,
  agentImageBuildFlags,
  agentImageKey,
  findSharedAgentImage,
  heldImageTag,
  moveHoldingImages,
  provideSharedAgentImage,
  releaseImage,
  type AgentImageBuildFlags,
  type ImageDocker,
} from './agent-image.js';
import { CONTROL_PLANE_ROOT } from './paths.js';
import type { SanitizedCommand } from './process.js';
import { imageBase, imageId, isHold, runner, tag, world, type World } from './testing/cutover-fixture.js';
import { GwsEaError } from './types.js';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const INPUTS = { contextTree: 'a'.repeat(40), installCjkFonts: false, hardenedImage: false } as const;

describe('the agent image key', () => {
  it('is the same for the same inputs and changes with each input it names', () => {
    const key = agentImageKey(INPUTS);

    expect(key).toMatch(/^[0-9a-f]{64}$/u);
    expect(agentImageKey({ ...INPUTS })).toBe(key);
    const changed = [
      agentImageKey({ ...INPUTS, contextTree: 'b'.repeat(40) }),
      agentImageKey({ ...INPUTS, installCjkFonts: true }),
      agentImageKey({ ...INPUTS, hardenedImage: true }),
    ];
    expect(new Set([key, ...changed]).size).toBe(4);
  });
});

/** What NanoClaw's own `container/build.sh` did with a checkout's `.env`: built, with or without CJK fonts, or refused. */
interface BuildScriptOutcome {
  readonly status: number | null;
  readonly builds: readonly string[];
}

/**
 * Run the release's `container/build.sh`, copied with what it sources into a
 * scratch project holding `environment` as its `.env`, against a container
 * runtime that only records its arguments.
 */
async function runBuildScript(
  environment: string | undefined,
  callerEnvironment: Readonly<Record<string, string>> = {},
): Promise<BuildScriptOutcome> {
  const project = await mkdtemp(path.join(os.tmpdir(), 'gws-ea-build-script-'));
  roots.push(project);
  const copy = async (file: string): Promise<void> => {
    await mkdir(path.dirname(path.join(project, file)), { recursive: true });
    await copyFile(path.join(CONTROL_PLANE_ROOT, file), path.join(project, file));
  };
  await Promise.all([copy('container/build.sh'), copy('setup/lib/install-slug.sh')]);
  await mkdir(path.join(project, 'container', 'agent-runner'), { recursive: true });
  await writeFile(path.join(project, 'container', 'agent-runner', 'bun.lock'), 'lock\n');
  if (environment !== undefined) await writeFile(path.join(project, '.env'), environment);
  const runtime = path.join(project, 'runtime');
  const log = path.join(project, 'runtime.log');
  await writeFile(runtime, '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$RUNTIME_LOG"\n', { mode: 0o755 });
  const result = spawnSync('bash', [path.join(project, 'container', 'build.sh'), 'building'], {
    cwd: project,
    env: {
      PATH: process.env.PATH,
      CONTAINER_RUNTIME: runtime,
      RUNTIME_LOG: log,
      NANOCLAW_INSTALL_ID: '0123456789abcdef0123456789abcdef',
      ...callerEnvironment,
    },
    encoding: 'utf8',
  });
  const calls = await readFile(log, 'utf8').then(
    (text) => text.split('\n').filter(Boolean),
    () => [],
  );
  return { status: result.status, builds: calls.filter((call) => call.startsWith('build ')) };
}

/** The flags a build.sh outcome shows it read: it refuses only a hardened install, and passes CJK fonts as a build argument. */
function flagsShown(outcome: BuildScriptOutcome): AgentImageBuildFlags {
  const [build] = outcome.builds;
  if (outcome.builds.length === 0) {
    expect(outcome.status).toBe(3);
    return { installCjkFonts: false, hardenedImage: true };
  }
  expect(outcome).toMatchObject({ status: 0, builds: [expect.any(String)] });
  return { installCjkFonts: build!.includes('--build-arg INSTALL_CJK_FONTS=true'), hardenedImage: false };
}

describe("the agent image's build flags", () => {
  it.each([
    ['no .env', undefined],
    ['an .env without either flag', 'WEBHOOK_PORT=1\n'],
    ['CJK fonts', 'INSTALL_CJK_FONTS=true\n'],
    ['CJK fonts quoted', 'INSTALL_CJK_FONTS="true"\n'],
    ['CJK fonts with quotes and spaces inside', "INSTALL_CJK_FONTS=' t rue '\n"],
    ['CJK fonts on a CRLF line', 'INSTALL_CJK_FONTS=true\r\n'],
    ['CJK fonts in capitals, which build.sh does not accept', 'INSTALL_CJK_FONTS=TRUE\n'],
    ['CJK fonts set twice, the last line winning', 'INSTALL_CJK_FONTS=true\nINSTALL_CJK_FONTS=false\n'],
    ['CJK fonts set twice, the last line enabling them', 'INSTALL_CJK_FONTS=false\nINSTALL_CJK_FONTS=true\n'],
    ['CJK fonts exported, which build.sh does not read', 'export INSTALL_CJK_FONTS=true\n'],
    ['CJK fonts indented, which build.sh does not read', ' INSTALL_CJK_FONTS=true\n'],
    ['CJK fonts with an equals sign in the value', 'INSTALL_CJK_FONTS=true=1\n'],
    ['a hardened image', 'NANOCLAW_HARDENED_IMAGE=true\n'],
    ['a hardened image in any case, quoted', 'NANOCLAW_HARDENED_IMAGE="True"\n'],
    ['no hardened image', 'NANOCLAW_HARDENED_IMAGE=false\nINSTALL_CJK_FONTS=true\n'],
    ['a hardened image then not', 'NANOCLAW_HARDENED_IMAGE=true\nNANOCLAW_HARDENED_IMAGE=no\n'],
  ])('reads %s exactly as container/build.sh does', async (_label, environment) => {
    const outcome = await runBuildScript(environment);

    expect(agentImageBuildFlags(environment ?? '')).toEqual(flagsShown(outcome));
  });

  it("builds with the caller's INSTALL_CJK_FONTS over .env's, so the key's flag is the one built", async () => {
    expect(flagsShown(await runBuildScript('INSTALL_CJK_FONTS=true\n', { INSTALL_CJK_FONTS: 'false' }))).toEqual({
      installCjkFonts: false,
      hardenedImage: false,
    });
    expect(flagsShown(await runBuildScript(undefined, { INSTALL_CJK_FONTS: 'true' }))).toEqual({
      installCjkFonts: true,
      hardenedImage: false,
    });
  });
});

/** One image as a stub Docker holds it. */
interface StubImage {
  readonly id: string;
  readonly tags: readonly string[];
  readonly created: string;
  readonly key?: string;
}

/** A Docker that lists every image `images` holds for any filter, so the lookup itself must choose. */
function stubDocker(images: readonly StubImage[], calls: string[] = []): ImageDocker {
  return {
    cwd: '/',
    env: {},
    run: async (command: SanitizedCommand) => {
      calls.push(command.args.join(' '));
      const [group, verb] = command.args;
      if (group === 'image' && verb === 'ls') return { stdout: images.map(({ id }) => `${id}\n`).join(''), stderr: '' };
      if (group === 'image' && verb === 'inspect') {
        const image = images.find(({ id }) => id === command.args.at(-1));
        if (!image) {
          throw new GwsEaError('command_failed', 'docker exited with code 1', {
            details: { exitCode: 1, stderrTail: `Error: No such image: ${command.args.at(-1)}` },
          });
        }
        return {
          stdout: JSON.stringify([
            {
              Id: image.id,
              RepoTags: image.tags,
              Created: image.created,
              Config: { Labels: image.key === undefined ? null : { [AGENT_IMAGE_KEY_LABEL]: image.key } },
            },
          ]),
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    },
  };
}

function id(digit: string): string {
  return `sha256:${digit.repeat(64)}`;
}

describe('the image shared under a key', () => {
  const key = agentImageKey(INPUTS);

  it('is the newest tagged image whose label carries exactly the key, asked for by that label', async () => {
    const calls: string[] = [];
    const docker = stubDocker(
      [
        { id: id('1'), tags: ['nanoclaw-agent-v2-a:latest'], created: '2026-09-28T10:00:00Z', key },
        { id: id('2'), tags: ['nanoclaw-agent-v2-b:latest'], created: '2026-09-28T11:00:00.5Z', key },
        // Newer, but another key, one that merely starts with it, and none at all.
        { id: id('3'), tags: ['nanoclaw-agent-v2-c:latest'], created: '2026-09-29T00:00:00Z', key: 'f'.repeat(64) },
        { id: id('4'), tags: ['nanoclaw-agent-v2-d:latest'], created: '2026-09-29T00:00:00Z', key: `${key}0` },
        { id: id('5'), tags: ['nanoclaw-agent-v2-e:latest'], created: '2026-09-29T00:00:00Z' },
      ],
      calls,
    );

    expect(await findSharedAgentImage(docker, key)).toBe(id('2'));
    expect(calls[0]).toBe(
      `image ls --quiet --no-trunc --filter dangling=false --filter label=${AGENT_IMAGE_KEY_LABEL}=${key}`,
    );
  });

  it('breaks a tie in creation time by the greater ID, so every assistant takes the same image', async () => {
    const created = '2026-09-28T10:00:00Z';
    const docker = stubDocker([
      { id: id('7'), tags: ['nanoclaw-agent-v2-a:latest'], created, key },
      { id: id('9'), tags: ['nanoclaw-agent-v2-b:latest'], created, key },
      { id: id('8'), tags: ['nanoclaw-agent-v2-c:latest'], created, key },
    ]);

    expect(await findSharedAgentImage(docker, key)).toBe(id('9'));
  });

  it("never takes up an agent group's own image, built on the keyed one and so carrying its label too", async () => {
    const docker = stubDocker([
      { id: id('1'), tags: ['nanoclaw-agent-v2-a:previous'], created: '2026-09-28T10:00:00Z', key },
      // Newer, and inheriting the key's label, but tagged only as agent groups' own images, or not as an agent's.
      { id: id('2'), tags: ['nanoclaw-agent-v2-a:ag-research'], created: '2026-09-29T00:00:00Z', key },
      { id: id('3'), tags: ['someone-elses-image:latest'], created: '2026-09-29T00:00:00Z', key },
      { id: id('4'), tags: ['nanoclaw-agent-v2-a:building'], created: '2026-09-29T00:00:00Z', key },
    ]);

    expect(await findSharedAgentImage(docker, key)).toBe(id('1'));
  });

  it("takes up an image a kept release's tag names, and no tag merely shaped like one", async () => {
    const docker = stubDocker([
      { id: id('1'), tags: ['nanoclaw-agent-v2-a:r-8774b4dc'], created: '2026-09-28T10:00:00Z', key },
      // Newer, but under tags no release has.
      {
        id: id('2'),
        tags: ['nanoclaw-agent-v2-b:r-8774B4DC', 'nanoclaw-agent-v2-b:r-8774b4dc0', 'nanoclaw-agent-v2-b:r-'],
        created: '2026-09-29T00:00:00Z',
        key,
      },
    ]);

    expect(await findSharedAgentImage(docker, key)).toBe(id('1'));
  });

  it('never takes up an image no tag names, or one gone since Docker listed it', async () => {
    const docker = stubDocker([
      { id: id('1'), tags: [], created: '2026-09-28T10:00:00Z', key },
      { id: id('2'), tags: ['nanoclaw-agent-v2-b:latest'], created: '2026-09-28T09:00:00Z', key: 'f'.repeat(64) },
    ]);
    const vanishing: ImageDocker = {
      ...docker,
      run: async (command) => (command.args[1] === 'ls' ? { stdout: `${id('6')}\n`, stderr: '' } : docker.run(command)),
    };

    expect(await findSharedAgentImage(docker, key)).toBeUndefined();
    expect(await findSharedAgentImage(vanishing, key)).toBeUndefined();
  });

  it("tags the shared image as the assistant's, building nothing, and builds and labels one when there is none", async () => {
    const calls: string[] = [];
    const builds: string[] = [];
    const request = {
      key,
      target: 'nanoclaw-agent-v2-b:next',
      building: 'nanoclaw-agent-v2-b:building',
      build: async () => void builds.push('build.sh building'),
    };
    const shared = stubDocker(
      [{ id: id('2'), tags: ['nanoclaw-agent-v2-a:latest'], created: '2026-09-28T10:00:00Z', key }],
      calls,
    );

    expect(await provideSharedAgentImage(shared, request)).toBe('shared');
    expect(builds).toEqual([]);
    expect(calls.at(-1)).toBe(`tag ${id('2')} nanoclaw-agent-v2-b:next`);

    calls.length = 0;
    expect(await provideSharedAgentImage(stubDocker([], calls), request)).toBe('built');
    expect(builds).toEqual(['build.sh building']);
    expect(calls.slice(1)).toEqual([
      `build --label ${AGENT_IMAGE_KEY_LABEL}=${key} --tag nanoclaw-agent-v2-b:next -`,
      'image rm nanoclaw-agent-v2-b:building',
    ]);
  });
});

describe('holding and releasing an image', () => {
  const a = { install_id: 'a'.repeat(32) };
  const b = { install_id: 'b'.repeat(32) };
  const key = agentImageKey(INPUTS);
  const docker = (state: World): ImageDocker => ({ run: runner(state), cwd: '/', env: {} });
  const namesOf = (state: World, image: string) =>
    [...state.tags].filter(([, id]) => id === image).map(([name]) => name);
  const holdsOf = (state: World) => [...state.tags.keys()].filter(isHold).sort();
  const removedById = (state: World) =>
    state.commands.some((command) => /^image rm sha256:/u.test(command.args.join(' ')));

  it('deletes an image only with the last tag naming it, by removing its own hold', async () => {
    const state = world(a);
    const image = state.tags.get(`${imageBase(a)}:latest`)!;
    // B shares the image A moved off.
    tag(state, image, `${imageBase(b)}:latest`);
    state.tags.delete(`${imageBase(a)}:latest`);

    await releaseImage(docker(state), imageBase(a), image);
    expect(namesOf(state, image)).toEqual([`${imageBase(b)}:latest`]);

    state.tags.delete(`${imageBase(b)}:latest`);
    await releaseImage(docker(state), imageBase(b), image);
    expect(state.ids.has(image)).toBe(false);
    // One already gone is released, and nothing was ever deleted by ID.
    await releaseImage(docker(state), imageBase(a), image);
    expect(removedById(state)).toBe(false);
  });

  it('keeps an image another assistant tags while it is being released', async () => {
    const state = world(a);
    const image = state.tags.get(`${imageBase(a)}:latest`)!;
    state.tags.delete(`${imageBase(a)}:latest`);
    const run = runner(state);
    // B's update tags the image as its :next just as A, finding no tag on it, is releasing it.
    const racing: ImageDocker = {
      cwd: '/',
      env: {},
      run: async (command) => {
        if (command.args[0] === 'image' && command.args[1] === 'rm') tag(state, image, `${imageBase(b)}:next`);
        return run(command);
      },
    };

    await releaseImage(racing, imageBase(a), image);

    expect(namesOf(state, image)).toEqual([`${imageBase(b)}:next`]);
  });

  it('holds every image a move names, and keeps the hold only on one the move leaves without a tag of its own', async () => {
    const state = world(a);
    const base = imageBase(a);
    const ran = state.tags.get(`${base}:latest`)!;
    const built = imageId();
    const kept = imageId();
    state.ids.add(built).add(kept);
    state.tags.set(`${base}:next`, built).set(`${base}:previous`, kept);
    const during: string[][] = [];

    await moveHoldingImages(docker(state), base, [built, ran, ran, kept], async () => {
      during.push(holdsOf(state));
      tag(state, built, `${base}:latest`);
      tag(state, ran, `${base}:previous`);
      state.tags.delete(`${base}:next`);
    });

    expect(during).toEqual([[built, ran, kept].map((id) => heldImageTag(base, id)).sort()]);
    expect(holdsOf(state)).toEqual([heldImageTag(base, kept)]);
    expect(namesOf(state, built)).toEqual([`${base}:latest`]);
    expect(namesOf(state, ran)).toEqual([`${base}:previous`]);
  });

  it('builds the image when the shared one is gone by the time it is tagged', async () => {
    const builds: string[] = [];
    const shared = stubDocker([
      { id: id('2'), tags: ['nanoclaw-agent-v2-a:latest'], created: '2026-09-28T10:00:00Z', key },
    ]);
    const vanishing: ImageDocker = {
      ...shared,
      run: async (command) => {
        if (command.args[0] !== 'tag') return shared.run(command);
        throw new GwsEaError('command_failed', 'docker exited with code 1', {
          details: { exitCode: 1, stderrTail: `Error response from daemon: No such image: ${id('2')}` },
        });
      },
    };

    expect(
      await provideSharedAgentImage(vanishing, {
        key,
        target: 'nanoclaw-agent-v2-b:next',
        building: 'nanoclaw-agent-v2-b:building',
        build: async () => void builds.push('build.sh building'),
      }),
    ).toBe('built');
    expect(builds).toEqual(['build.sh building']);
  });

  it("adopts nothing, keeping the new assistant's :latest, when the shared image is gone before it is tagged", async () => {
    const state = world(a);
    const base = imageBase(a);
    const own = state.tags.get(`${base}:latest`)!;
    const shared = imageId();
    state.ids.add(shared);
    state.labels.set(shared, key);
    state.tags.set(`${imageBase(b)}:latest`, shared);
    const run = runner(state);
    // B's removal drops the shared image's last tag as A tags it.
    const racing: ImageDocker = {
      cwd: '/',
      env: {},
      run: async (command) => {
        if (command.args[0] === 'tag' && command.args[1] === shared) {
          state.tags.delete(`${imageBase(b)}:latest`);
          state.ids.delete(shared);
        }
        return run(command);
      },
    };

    expect(await adoptSharedAgentImage(racing, key, base, `${base}:latest`)).toBe(false);
    expect(namesOf(state, own)).toEqual([`${base}:latest`]);
    expect(holdsOf(state)).toEqual([]);
  });

  it('converges from a create killed between adopting the shared image and releasing the one it displaced', async () => {
    const state = world(a);
    const base = imageBase(a);
    const own = state.tags.get(`${base}:latest`)!;
    const shared = imageId();
    state.ids.add(shared);
    state.labels.set(shared, key);
    state.tags.set(`${imageBase(b)}:latest`, shared);
    state.hangAt = 'release';
    const reached = new Promise<void>((resolve) => (state.reached = resolve));

    void adoptSharedAgentImage(docker(state), key, base, `${base}:latest`);
    await reached;
    expect(state.tags.get(`${base}:latest`)).toBe(shared);
    expect(namesOf(state, own)).toEqual([heldImageTag(base, own)]);

    state.hangAt = undefined;
    expect(await adoptSharedAgentImage(docker(state), key, base, `${base}:latest`)).toBe(true);
    expect(state.ids.has(own)).toBe(false);
    expect(holdsOf(state)).toEqual([]);
    expect(namesOf(state, shared).sort()).toEqual([`${base}:latest`, `${imageBase(b)}:latest`]);
  });
});
