/**
 * Agent images shared by content. The key names exactly what NanoClaw's
 * `container/build.sh` builds an image from, its `.env` flags read as the
 * script itself reads them (proven by running the script against a
 * recording container runtime), and the lookup takes up only an image some
 * tag names whose label carries exactly the key, the newest first.
 */
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AGENT_IMAGE_KEY_LABEL,
  agentImageBuildFlags,
  agentImageKey,
  findSharedAgentImage,
  provideSharedAgentImage,
  type AgentImageBuildFlags,
  type ImageDocker,
} from './agent-image.js';
import { CONTROL_PLANE_ROOT } from './paths.js';
import type { SanitizedCommand } from './process.js';
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
