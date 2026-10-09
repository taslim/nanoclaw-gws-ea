/**
 * Agent images shared by content. The key names exactly what NanoClaw's
 * `container/build.sh` builds an image from, and the lookup takes up only an
 * image some tag names whose label carries exactly the key, the newest first.
 */
import { describe, expect, it } from 'vitest';

import {
  AGENT_IMAGE_KEY_LABEL,
  agentImageKey,
  findSharedAgentImage,
  provideSharedAgentImage,
  type ImageDocker,
} from './agent-image.js';
import type { SanitizedCommand } from './process.js';
import { GwsEaError } from './types.js';

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
      target: 'nanoclaw-agent-v2-b:r-0123abcd',
      building: 'nanoclaw-agent-v2-b:building',
      build: async () => void builds.push('build.sh building'),
    };
    const shared = stubDocker(
      [{ id: id('2'), tags: ['nanoclaw-agent-v2-a:latest'], created: '2026-09-28T10:00:00Z', key }],
      calls,
    );

    expect(await provideSharedAgentImage(shared, request)).toBe('shared');
    expect(builds).toEqual([]);
    expect(calls.at(-1)).toBe(`tag ${id('2')} nanoclaw-agent-v2-b:r-0123abcd`);

    calls.length = 0;
    expect(await provideSharedAgentImage(stubDocker([], calls), request)).toBe('built');
    expect(builds).toEqual(['build.sh building']);
    expect(calls.slice(1)).toEqual([
      `build --label ${AGENT_IMAGE_KEY_LABEL}=${key} --tag nanoclaw-agent-v2-b:r-0123abcd -`,
      'image rm nanoclaw-agent-v2-b:building',
    ]);
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
        target: 'nanoclaw-agent-v2-b:r-0123abcd',
        building: 'nanoclaw-agent-v2-b:building',
        build: async () => void builds.push('build.sh building'),
      }),
    ).toBe('built');
    expect(builds).toEqual(['build.sh building']);
  });
});
