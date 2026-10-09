/**
 * Agent images under the release layout. A release's image is built from an
 * export of the release, never from the release directory (proven by running
 * NanoClaw's own `container/build.sh` in a release whose links reach state
 * that would change the build), and its key is exactly what reaches the
 * build: an inventory of the script's, what it sources', and the
 * Dockerfile's inputs fails when one is added. Identical releases share one
 * image, and an image goes only with the last tag naming it, whatever order
 * two assistants' provides and prunes interleave in. A per-group rebuild's
 * displaced image is deleted only when no tag names it.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { AGENT_IMAGE_KEY_LABEL, agentImageKey, type ImageDocker } from './agent-image.js';
import {
  provideReleaseImage,
  readInstallCjkFonts,
  releaseImageKey,
  releaseImageTag,
  reclaimImage,
  removeReleaseImage,
  type ReleaseImageInputs,
} from './agent-image-release.js';
import { CONTROL_PLANE_ROOT } from './paths.js';
import { runSanitizedCommand, TOOL_ENVIRONMENT_KEYS, type SanitizedCommand } from './process.js';
import { createState, instanceLayout, linkReleaseState, type InstanceLayout } from './release-layout.js';
import { GwsEaError } from './types.js';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function scratch(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function source(file: string): string {
  return readFileSync(path.join(CONTROL_PLANE_ROOT, file), 'utf8');
}

/** Shell text without its comment lines. */
function code(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
}

/**
 * The variables a shell script may take from its caller: those it reads and
 * never assigns, and those it reads with a default (`${NAME:-…}`), which is
 * how a script spells "the caller's, else". Bash's own are left out. Some
 * found by the second rule are the script's own; the inventory below names
 * them so, and any name added or dropped fails the test until classified.
 */
function callerVariables(text: string): string[] {
  const body = code(text);
  const read = new Set([...body.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/gu)].map((match) => match[1]!));
  const assigned = new Set([
    ...[...body.matchAll(/^\s*(?:local\s+|export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/gmu)].map((match) => match[1]!),
    ...[...body.matchAll(/\blocal\s+([A-Za-z_][\w ]*)/gu)].flatMap((match) => match[1]!.split(/\s+/u)),
  ]);
  const defaulted = [...body.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*):?[-=]/gu)].map((match) => match[1]!);
  const bash = new Set(['BASH_SOURCE', 'PIPESTATUS']);
  return [...new Set([...[...read].filter((name) => !assigned.has(name)), ...defaulted])]
    .filter((name) => !bash.has(name))
    .sort();
}

/** The `.env` keys a script reads with `grep '^KEY='`. */
function dotEnvKeys(text: string): string[] {
  return [...new Set([...code(text).matchAll(/grep '\^([A-Z0-9_]+)='[^\n]*\.env/gu)].map((match) => match[1]!))].sort();
}

/** The paths a script reads from its project outside its own directory: `$PROJECT_ROOT/…`, `$SCRIPT_DIR/../…`, `../…`. */
function projectPaths(text: string): string[] {
  const reference = /(?:\$\{?PROJECT_ROOT\}?|\$\{?SCRIPT_DIR\}?\/\.\.|(?<![\w./$}])\.\.)\/([\w./-]+)/gu;
  return [...new Set([...code(text).matchAll(reference)].map((match) => match[1]!))].sort();
}

/** The build arguments a Dockerfile declares, however many one `ARG` line names. */
function dockerfileArguments(text: string): string[] {
  const declared = [...text.matchAll(/^\s*ARG\s+(.+)$/gimu)].flatMap((match) =>
    match[1]!.split(/\s+/u).map((argument) => argument.split('=')[0]!),
  );
  return [...new Set(declared)].sort();
}

/**
 * Every input of `container/build.sh` and why the key does or need not name
 * it. A new one fails the inventory until it is placed here: in the key and
 * passed by gws-ea, or shown not to change the image.
 */
const BUILD_SCRIPT_INPUTS: Readonly<Record<string, string>> = {
  INSTALL_CJK_FONTS: 'in the key; gws-ea passes it',
  NANOCLAW_HARDENED_IMAGE: 'gws-ea passes false: an assistant always builds its own image',
  CONTAINER_RUNTIME: 'never in the tool environment, so always docker',
  HARDENED: "the script's own, from NANOCLAW_HARDENED_IMAGE",
  IMAGE_LOCK: "the script's own, read from an existing image only on the hardened path",
  LOCK_SHA: "the script's own, hashed from container/agent-runner/bun.lock, in the context tree",
};

const INSTALL_SLUG_INPUTS: Readonly<Record<string, string>> = {
  NANOCLAW_INSTALL_ID: 'names the repository, not the image; gws-ea passes it',
  NANOCLAW_PROJECT_ROOT: 'slug fallback, unused while NANOCLAW_INSTALL_ID is set',
  PROJECT_ROOT: 'slug fallback, unused while NANOCLAW_INSTALL_ID is set',
  PWD: 'slug fallback, unused while NANOCLAW_INSTALL_ID is set',
};

/** Every path build.sh reaches in its project outside `container/`, and whether the export holds it. */
const PROJECT_PATHS: Readonly<Record<string, { readonly exported: boolean; readonly why: string }>> = {
  'setup/lib/install-slug.sh': { exported: true, why: 'sourced; names the repository from NANOCLAW_INSTALL_ID' },
  '.env': { exported: false, why: 'gws-ea passes each flag the script reads from it' },
  '.env.bak': { exported: false, why: "sed's backup when the script rewrites a .env, which needs one" },
};

/** The `.env` keys build.sh reads, as gws-ea passes them for `installCjkFonts`. */
function passedFlags(installCjkFonts: boolean): Readonly<Record<string, string>> {
  return { INSTALL_CJK_FONTS: String(installCjkFonts), NANOCLAW_HARDENED_IMAGE: 'false' };
}

/** The Dockerfile's build arguments, and where each value comes from. */
const DOCKERFILE_ARGUMENTS: Readonly<Record<string, string>> = {
  INSTALL_CJK_FONTS: 'build.sh passes it from the key',
  AGENT_RUNNER_LOCK_SHA256: 'build.sh passes the hash of bun.lock, in the context tree',
  BUN_VERSION: 'its default, in the context tree',
  PNPM_VERSION: 'its default, in the context tree',
  NPM_VERSION: 'its default, in the context tree',
  GOGCLI_VERSION: 'its default, in the context tree',
  GOGCLI_SHA256_AMD64: 'its default, in the context tree',
  GOGCLI_SHA256_ARM64: 'its default, in the context tree',
  TARGETARCH: "BuildKit's, the one platform of the machine's Docker",
  IMAGE_SOURCE: 'its default, in the context tree',
};

describe("the inputs of NanoClaw's agent image build", () => {
  it('are exactly the inventoried ones, so a new input fails here until the key names it or it is shown inert', () => {
    const script = source('container/build.sh');
    expect(callerVariables(script)).toEqual(Object.keys(BUILD_SCRIPT_INPUTS).sort());
    expect(callerVariables(source('setup/lib/install-slug.sh'))).toEqual(Object.keys(INSTALL_SLUG_INPUTS).sort());
    expect(projectPaths(script)).toEqual(Object.keys(PROJECT_PATHS).sort());
    expect(projectPaths(source('setup/lib/install-slug.sh'))).toEqual([]);
    expect(dotEnvKeys(script)).toEqual(Object.keys(passedFlags(false)).sort());
    expect(dockerfileArguments(source('container/Dockerfile'))).toEqual(Object.keys(DOCKERFILE_ARGUMENTS).sort());
    const passed = [...code(script).matchAll(/--build-arg\s+"?([A-Z0-9_]+)=/gu)].map((match) => match[1]!);
    expect([...new Set(passed)].sort()).toEqual(['AGENT_RUNNER_LOCK_SHA256', 'INSTALL_CJK_FONTS']);
  });

  it('take nothing from the environment every tool inherits', () => {
    const inputs = [...Object.keys(BUILD_SCRIPT_INPUTS), ...Object.keys(INSTALL_SLUG_INPUTS)];
    expect(inputs.filter((name) => (TOOL_ENVIRONMENT_KEYS as readonly string[]).includes(name))).toEqual([]);
  });
});

describe('the release image key', () => {
  const inputs: ReleaseImageInputs = { contextTree: 'a'.repeat(40), installCjkFonts: false };

  it('is the key shared images carry since #34, so images built before release tags are shared too', () => {
    expect(releaseImageKey(inputs)).toBe(agentImageKey({ ...inputs, hardenedImage: false }));
    // The label #34 gives an image built from this tree without CJK fonts.
    expect(releaseImageKey(inputs)).toBe('1f6e0a7ade0d3c5767542b2eaa4240ae37f8bcda25197f9c7c60488686d3234d');
  });

  it('changes with each input and with nothing else', () => {
    expect(releaseImageKey({ ...inputs })).toBe(releaseImageKey(inputs));
    expect(releaseImageKey({ ...inputs, contextTree: 'b'.repeat(40) })).not.toBe(releaseImageKey(inputs));
    expect(releaseImageKey({ ...inputs, installCjkFonts: true })).not.toBe(releaseImageKey(inputs));
  });

  it("reads INSTALL_CJK_FONTS from the assistant's state with NanoClaw's own reader", async () => {
    const state = await scratch('gws-ea-image-state-');
    await writeFile(path.join(state, '.env'), 'WEBHOOK_PORT=4100\nINSTALL_CJK_FONTS="true"\n');
    expect(readInstallCjkFonts(state)).toBe(true);
    await writeFile(path.join(state, '.env'), 'INSTALL_CJK_FONTS=false\n');
    expect(readInstallCjkFonts(state)).toBe(false);
  });
});

describe('the tag a release runs', () => {
  it("is its own in the assistant's repository, named by the release", () => {
    expect(releaseImageTag('nanoclaw-agent-v2-abc', '8774b4dc')).toBe('nanoclaw-agent-v2-abc:r-8774b4dc');
    for (const name of ['8774b4d', '8774B4DC', '8774b4dc0', 'latest']) {
      expect(() => releaseImageTag('nanoclaw-agent-v2-abc', name)).toThrow(GwsEaError);
    }
  });
});

/**
 * Docker's image store as the commands gws-ea runs see it, with Docker's tag
 * rule: `image rm <tag>` removes the tag, and the image with it only when no
 * other tag names it; `image rm <id>` deletes the image with its tags when
 * they are all in one repository, and refuses when they are in several.
 * NanoClaw's build (`bash container/build.sh <tag>`) adds an unlabeled image
 * under that tag in the repository `NANOCLAW_INSTALL_ID` names.
 */
class ImageStore {
  readonly tags = new Map<string, string>();
  readonly images = new Map<string, { readonly label?: string; readonly created: number }>();
  readonly commands: string[] = [];
  builds = 0;
  private clock = 0;

  add(label?: string): string {
    this.clock += 1;
    const id = `sha256:${this.clock.toString(16).padStart(64, '0')}`;
    this.images.set(id, { ...(label === undefined ? {} : { label }), created: this.clock });
    return id;
  }

  /** A new image, tagged `reference`. */
  addTagged(reference: string, label?: string): string {
    const id = this.add(label);
    this.tags.set(reference, id);
    return id;
  }

  private resolve(reference: string): string | undefined {
    return this.tags.get(reference) ?? (this.images.has(reference) ? reference : undefined);
  }

  private missing(reference: string): GwsEaError {
    return new GwsEaError('command_failed', 'docker exited with code 1', {
      details: { exitCode: 1, stderrTail: `Error response from daemon: No such image: ${reference}` },
    });
  }

  private namesOf(id: string): string[] {
    return [...this.tags].filter(([, named]) => named === id).map(([name]) => name);
  }

  private removeById(id: string): void {
    if (!this.images.has(id)) throw this.missing(id);
    const names = this.namesOf(id);
    if (new Set(names.map((name) => name.split(':')[0])).size > 1) {
      throw new GwsEaError('command_failed', 'docker exited with code 1', {
        details: {
          exitCode: 1,
          stderrTail: `conflict: unable to delete ${id} - image is referenced in multiple repositories`,
        },
      });
    }
    for (const name of names) this.tags.delete(name);
    this.images.delete(id);
  }

  run(args: readonly string[], input?: string): string {
    const joined = args.join(' ');
    this.commands.push(joined);
    if (args[0] === 'tag') {
      const id = this.resolve(args[1]!);
      if (!id) throw this.missing(args[1]!);
      this.tags.set(args[2]!, id);
      return '';
    }
    if (joined.startsWith('image rm ')) {
      const reference = args[2]!;
      if (reference.startsWith('sha256:')) {
        this.removeById(reference);
        return '';
      }
      const id = this.tags.get(reference);
      if (!id) throw this.missing(reference);
      this.tags.delete(reference);
      if (![...this.tags.values()].includes(id)) this.images.delete(id);
      return '';
    }
    if (joined.startsWith('image ls --quiet --no-trunc --filter dangling=false --filter label=')) {
      const key = joined.split(`label=${AGENT_IMAGE_KEY_LABEL}=`)[1];
      const tagged = new Set(this.tags.values());
      return [...this.images]
        .filter(([id, image]) => image.label === key && tagged.has(id))
        .map(([id]) => `${id}\n`)
        .join('');
    }
    if (joined.startsWith('image ls --quiet --no-trunc ') && args.length === 5) {
      const id = this.tags.get(args[4]!);
      return id === undefined ? '' : `${id}\n`;
    }
    if (joined.startsWith('image inspect ')) {
      const id = args[2]!;
      const image = this.images.get(id);
      if (!image) throw this.missing(id);
      return JSON.stringify([
        {
          Id: id,
          RepoTags: this.namesOf(id),
          Created: new Date(image.created * 1000).toISOString(),
          Config: { Labels: image.label === undefined ? null : { [AGENT_IMAGE_KEY_LABEL]: image.label } },
        },
      ]);
    }
    if (args[0] === 'build' && args[1] === '--label') {
      const from = /^FROM (\S+)\n$/u.exec(input ?? '')?.[1];
      if (!from || !this.resolve(from)) throw this.missing(from ?? '');
      this.addTagged(args[4]!, args[2]!.split('=')[1]);
      return '';
    }
    throw new Error(`unexpected docker ${joined}`);
  }

  /** NanoClaw's build, as `container/build.sh` does it: an unlabeled image under its tag argument. */
  private nanoclawBuild(command: SanitizedCommand): void {
    this.builds += 1;
    this.addTagged(`nanoclaw-agent-v2-${command.env?.NANOCLAW_INSTALL_ID}:${command.args[1]}`);
  }

  /** The assistant's Docker; `before` runs ahead of every command, and Git and tar do nothing. */
  docker(before: () => void = () => undefined): ImageDocker {
    return {
      cwd: '/',
      env: {},
      run: async (command: SanitizedCommand) => {
        before();
        if (command.command === 'bash') this.nanoclawBuild(command);
        if (command.command !== 'docker') return { stdout: '', stderr: '' };
        return { stdout: this.run(command.args, command.input), stderr: '' };
      },
    };
  }
}

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const X = `nanoclaw-agent-v2-${A}`;
const Y = `nanoclaw-agent-v2-${B}`;
const INPUTS: ReleaseImageInputs = { contextTree: 'c'.repeat(40), installCjkFonts: false };
const LAYOUT = instanceLayout(path.join(os.tmpdir(), 'gws-ea-image-unused-instance'));

function provide(store: ImageStore, installId: string, release: string, before?: () => void) {
  return provideReleaseImage(store.docker(before), { layout: LAYOUT, release, installId, inputs: INPUTS });
}

describe("release images shared across assistants by Docker's tag rule", () => {
  it('builds identical releases once, and each assistant keeps its own tag on the one image', async () => {
    const store = new ImageStore();
    expect(await provide(store, A, '8774b4dc')).toBe('built');
    expect(await provide(store, B, '8774b4dc')).toBe('shared');

    expect(store.builds).toBe(1);
    expect(store.images.size).toBe(1);
    const image = store.tags.get(releaseImageTag(X, '8774b4dc'));
    expect(store.tags.get(releaseImageTag(Y, '8774b4dc'))).toBe(image);
    expect(store.images.get(image!)?.label).toBe(releaseImageKey(INPUTS));
    expect([...store.tags.keys()].some((name) => name.endsWith(':building'))).toBe(false);
  });

  it("keeps an image while another assistant's tag names it, and deletes it with the last, leaving nothing untagged", async () => {
    const store = new ImageStore();
    await provide(store, A, '037f6b1f');
    await provide(store, B, '037f6b1f');

    await removeReleaseImage(store.docker(), X, '037f6b1f');
    expect(store.images.size).toBe(1);
    await removeReleaseImage(store.docker(), Y, '037f6b1f');
    // A prune cut short repeats its removals, and a tag already gone is removed.
    await removeReleaseImage(store.docker(), Y, '037f6b1f');
    expect(store.images.size).toBe(0);
  });

  it('never loses an image a kept release names, wherever one assistant’s prune falls in another’s provide', async () => {
    let commands = 0;
    await provide(new ImageStore(), B, '8774b4dc', () => (commands += 1));
    for (let at = 0; at <= commands + 4; at += 1) {
      const store = new ImageStore();
      await provide(store, A, '8774b4dc');
      store.addTagged(releaseImageTag(X, '47f74909'), 'another key');
      let made = 0;
      const pruneX = (): void => {
        if (made++ === at) store.run(['image', 'rm', releaseImageTag(X, '8774b4dc')]);
      };

      await provide(store, B, '8774b4dc', pruneX);
      if (made <= at) store.run(['image', 'rm', releaseImageTag(X, '8774b4dc')]);

      // Every tag names an image there; B's release has its image, labeled with its key; nothing is left untagged.
      for (const id of store.tags.values()) expect(store.images.has(id)).toBe(true);
      const own = store.tags.get(releaseImageTag(Y, '8774b4dc'));
      expect(store.images.get(own!)?.label).toBe(releaseImageKey(INPUTS));
      expect(store.tags.has(releaseImageTag(X, '47f74909'))).toBe(true);
      const tagged = new Set(store.tags.values());
      expect([...store.images.keys()].filter((id) => !tagged.has(id))).toEqual([]);
      expect(store.builds).toBeLessThanOrEqual(2);
    }
  });
});

/** Run `git` for a test fixture, with no operator configuration. */
function git(cwd: string, home: string, ...args: string[]): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: home,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Morgan Ellery',
      GIT_AUTHOR_EMAIL: 'morgan@example.com',
      GIT_COMMITTER_NAME: 'Morgan Ellery',
      GIT_COMMITTER_EMAIL: 'morgan@example.com',
    },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

/** Every file under `root`, relative to it. */
async function filesUnder(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => !entry.isDirectory())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
    .sort();
}

const RELEASE = '0123abcd';
const STATE_ENV = 'INSTALL_CJK_FONTS=true\nNANOCLAW_HARDENED_IMAGE=true\n';

/**
 * An instance holding release `RELEASE`, committed with NanoClaw's own
 * `container/build.sh` and what it sources, and then linked to the
 * assistant's state the way a resumed create or a rollback finds it: state
 * whose `.env` would have the script build with CJK fonts, refuse to build at
 * all, and rewrite that `.env`. Its working tree has drifted from the commit
 * too, which no build may see.
 */
async function linkedRelease(): Promise<{ readonly layout: InstanceLayout; readonly contextTree: string }> {
  const root = await scratch('gws-ea-image-instance-');
  const home = await scratch('gws-ea-image-home-');
  const layout = instanceLayout(root);
  const checkout = layout.release(RELEASE);
  await mkdir(path.join(checkout, 'container', 'agent-runner'), { recursive: true });
  await mkdir(path.join(checkout, 'setup', 'lib'), { recursive: true });
  for (const file of ['container/build.sh', 'setup/lib/install-slug.sh']) {
    await copyFile(path.join(CONTROL_PLANE_ROOT, file), path.join(checkout, file));
  }
  await writeFile(path.join(checkout, 'container', 'agent-runner', 'bun.lock'), 'committed lock\n');
  await writeFile(path.join(checkout, 'README.md'), 'not a build input\n');
  git(checkout, home, 'init', '--quiet');
  git(checkout, home, 'add', '--all');
  git(checkout, home, 'commit', '--quiet', '--message', 'release');

  await createState(layout);
  await linkReleaseState(layout, RELEASE);
  await writeFile(path.join(layout.state, '.env'), STATE_ENV);
  await writeFile(path.join(checkout, 'container', 'agent-runner', 'bun.lock'), 'drifted lock\n');
  await writeFile(path.join(checkout, 'container', 'stray'), 'untracked\n');
  return { layout, contextTree: git(checkout, home, 'rev-parse', 'HEAD:container') };
}

/** What NanoClaw's build did: the container runtime's calls, the build's command, and the export it ran in. */
interface ObservedBuild {
  readonly runtimeCalls: readonly string[];
  readonly command: SanitizedCommand | undefined;
  /** The scratch directory's and the export's modes while the build ran. */
  readonly modes: readonly number[];
  readonly exported: readonly string[];
  readonly capture: string;
}

/**
 * The assistant's Docker for a real build: Git, tar, and NanoClaw's own
 * `container/build.sh` run for real, with a container runtime that records
 * its calls and copies the export it was run in; Docker's image store is
 * `store`, and the runtime's build adds an unlabeled image under its tag.
 */
async function realBuild(
  store: ImageStore,
  options: { readonly fail?: boolean } = {},
): Promise<{ readonly docker: ImageDocker; observed(): Promise<ObservedBuild> }> {
  const tools = await scratch('gws-ea-image-tools-');
  const runtime = path.join(tools, 'runtime');
  const log = path.join(tools, 'runtime.log');
  const capture = path.join(tools, 'export');
  await writeFile(
    runtime,
    [
      '#!/bin/sh',
      'printf "%s\\n" "$PWD $*" >> "$RUNTIME_LOG"',
      'mkdir -p "$CAPTURE" && (cd .. && tar -cf - .) | (cd "$CAPTURE" && tar -xf -)',
      `exit ${options.fail ? 1 : 0}`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  let command: SanitizedCommand | undefined;
  const modes: number[] = [];
  const docker: ImageDocker = {
    cwd: '/',
    env: { PATH: process.env.PATH ?? '', HOME: tools, CONTAINER_RUNTIME: runtime, RUNTIME_LOG: log, CAPTURE: capture },
    run: async (sanitized) => {
      if (sanitized.command === 'docker') return { stdout: store.run(sanitized.args, sanitized.input), stderr: '' };
      if (sanitized.command === 'bash') {
        command = sanitized;
        modes.push(statSync(path.dirname(sanitized.cwd)).mode & 0o777, statSync(sanitized.cwd).mode & 0o777);
      }
      const result = await runSanitizedCommand(sanitized);
      if (sanitized.command === 'bash') {
        const built = /-t (\S+) \.$/u.exec((await readFile(log, 'utf8')).trim().split('\n').at(-1)!)?.[1];
        store.addTagged(built!);
      }
      return result;
    },
  };
  return {
    docker,
    observed: async () => ({
      runtimeCalls: (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean),
      command,
      modes,
      exported: existsSync(capture) ? await filesUnder(capture) : [],
      capture,
    }),
  };
}

describe("a release's image build", () => {
  it.each([false, true])(
    "builds the export of the key's tree with the key's flags, out of reach of the release's state (CJK fonts %s)",
    async (installCjkFonts) => {
      const { layout, contextTree } = await linkedRelease();
      const store = new ImageStore();
      const build = await realBuild(store);
      const inputs: ReleaseImageInputs = { contextTree, installCjkFonts };

      expect(await provideReleaseImage(build.docker, { layout, release: RELEASE, installId: A, inputs })).toBe('built');

      const observed = await build.observed();
      const lockSha = createHash('sha256').update('committed lock\n').digest('hex');
      const cjk = installCjkFonts ? '--build-arg INSTALL_CJK_FONTS=true ' : '';
      const context = path.join(observed.command!.cwd, 'container');
      expect(observed.runtimeCalls).toEqual([
        `${context} build ${cjk}--build-arg AGENT_RUNNER_LOCK_SHA256=${lockSha} -t ${X}:building .`,
      ]);
      // The export is the committed container/ tree and what build.sh sources, nothing else.
      const sourced = Object.entries(PROJECT_PATHS).flatMap(([file, { exported }]) => (exported ? [file] : []));
      expect(observed.exported).toEqual(['container/agent-runner/bun.lock', 'container/build.sh', ...sourced].sort());
      expect(await readFile(path.join(observed.capture, 'container/agent-runner/bun.lock'), 'utf8')).toBe(
        'committed lock\n',
      );
      // Every flag build.sh would read from a .env is passed, from the key; the install ID names the repository.
      const env = observed.command!.env!;
      expect(Object.fromEntries(dotEnvKeys(source('container/build.sh')).map((key) => [key, env[key]]))).toEqual(
        passedFlags(installCjkFonts),
      );
      expect(env.NANOCLAW_INSTALL_ID).toBe(A);
      // Built in an owner-only scratch directory outside the release, removed afterwards.
      expect(observed.modes).toEqual([0o700, 0o700]);
      expect(context.startsWith(layout.root)).toBe(false);
      expect(existsSync(path.dirname(observed.command!.cwd))).toBe(false);
      // The state build.sh could have reached, and the release's link to it, are untouched.
      expect(await readFile(path.join(layout.state, '.env'), 'utf8')).toBe(STATE_ENV);
      expect(lstatSync(path.join(layout.release(RELEASE), '.env')).isSymbolicLink()).toBe(true);
      // The release's image is labeled with its key, and the build's tag is gone.
      const image = store.tags.get(releaseImageTag(X, RELEASE));
      expect(store.images.get(image!)?.label).toBe(releaseImageKey(inputs));
      expect(store.tags.has(`${X}:building`)).toBe(false);
    },
  );

  it('removes its scratch directory when the build fails, and tags nothing', async () => {
    const { layout, contextTree } = await linkedRelease();
    const store = new ImageStore();
    const build = await realBuild(store, { fail: true });

    await expect(
      provideReleaseImage(build.docker, {
        layout,
        release: RELEASE,
        installId: A,
        inputs: { contextTree, installCjkFonts: false },
      }),
    ).rejects.toMatchObject({ code: 'command_failed' });

    const observed = await build.observed();
    expect(observed.runtimeCalls).toHaveLength(1);
    expect(existsSync(path.dirname(observed.command!.cwd))).toBe(false);
    expect(store.tags.size).toBe(0);
  });
});

describe("the image an agent group's rebuild displaced", () => {
  const group = `${X}:ag-research`;

  it('is deleted once the rebuild moved its tag off it and no tag names it', async () => {
    const store = new ImageStore();
    store.addTagged(releaseImageTag(X, '8774b4dc'), releaseImageKey(INPUTS));
    const displaced = store.addTagged(group);
    store.addTagged(group);

    await reclaimImage(store.docker(), displaced);

    expect(store.images.has(displaced)).toBe(false);
    expect(store.images.has(store.tags.get(group)!)).toBe(true);
    expect(store.tags.has(releaseImageTag(X, '8774b4dc'))).toBe(true);
    // Reclaimed again, as a retried follow-up does, it is gone already.
    await reclaimImage(store.docker(), displaced);
  });

  it('is kept when the rebuild produced the same image, which the group still names', async () => {
    const store = new ImageStore();
    const same = store.addTagged(group);

    await reclaimImage(store.docker(), same);

    expect(store.tags.get(group)).toBe(same);
    expect(store.commands.filter((command) => command.startsWith('image rm'))).toEqual([]);
  });

  it.each([
    ['another assistant', `${Y}:ag-research`],
    ['another tag of its own', `${X}:ag-research-copy`],
  ])('is kept while %s still tags it', async (_label, elsewhere) => {
    const store = new ImageStore();
    const displaced = store.addTagged(group);
    store.tags.set(elsewhere, displaced);
    store.addTagged(group);

    await reclaimImage(store.docker(), displaced);

    expect(store.tags.get(elsewhere)).toBe(displaced);
    expect(store.images.has(displaced)).toBe(true);
    expect(store.commands.filter((command) => command.startsWith('image rm'))).toEqual([]);
  });
});
