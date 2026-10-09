/**
 * A release repository and the boundaries staging a release crosses, for the
 * tests of create and of staging. Git, tar, and the files are real; the
 * release's frozen install and build, NanoClaw's image build, and Docker are
 * faked and recorded, and the install can be killed once part way through.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { CLOUDFLARED_IMAGE, ONECLI_GATEWAY_VERSION, ONECLI_SDK_VERSION } from '../pins.js';
import { runSanitizedCommand, type SanitizedCommand } from '../process.js';
import type { SetupCommand } from '../release-preflight.js';
import type { ReleaseStageSeams } from '../release-stage.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/**
 * The files a release needs for staging to find it whole: its package
 * manifest and gws-ea's pins (the receipt's cohort), the `ncl` launcher, the
 * agent image's build context and the script it sources, and an ignore file
 * that leaves its build output and its links to the assistant's state
 * untracked, as NanoClaw's own does.
 */
const RELEASE_FILES: Readonly<Record<string, { readonly contents: string; readonly mode?: number }>> = {
  '.gitignore': { contents: 'node_modules\ndist\n.env\ndata\ngroups\nstore\nlogs\n' },
  'package.json': {
    contents: `${JSON.stringify({
      name: 'nanoclaw',
      version: '2.3.0',
      packageManager: 'pnpm@10.0.0',
      dependencies: { '@onecli-sh/sdk': ONECLI_SDK_VERSION },
    })}\n`,
  },
  'src/gws-ea/versions.json': {
    contents: `${JSON.stringify({ 'onecli-gateway': ONECLI_GATEWAY_VERSION, cloudflared: CLOUDFLARED_IMAGE })}\n`,
  },
  'bin/ncl': { contents: '#!/bin/sh\n', mode: 0o755 },
  'container/Dockerfile': { contents: 'FROM scratch\n' },
  'setup/lib/install-slug.sh': { contents: '# names the image repository\n' },
};

export interface ReleaseRepository {
  /** The bare repository a reservation's `source_remote` names. */
  readonly remote: string;
  /** The one commit it holds. */
  readonly commit: string;
}

/** A release repository under `root`, its one commit served from a bare remote. */
export async function releaseRepository(root: string): Promise<ReleaseRepository> {
  const source = path.join(root, 'release-source');
  const remote = path.join(root, 'release.git');
  for (const [file, { contents, mode }] of Object.entries(RELEASE_FILES)) {
    await mkdir(path.dirname(path.join(source, file)), { recursive: true });
    await writeFile(path.join(source, file), contents, mode === undefined ? {} : { mode });
  }
  git(source, 'init', '--quiet', '-b', 'rebuild-v2');
  git(source, 'add', '.');
  git(source, '-c', 'user.name=Morgan Ellery', '-c', 'user.email=morgan@example.com', 'commit', '--quiet', '-m', 'r');
  git(root, 'clone', '--quiet', '--bare', source, remote);
  return { remote, commit: git(source, 'rev-parse', 'HEAD') };
}

/** What a killed install leaves in the release, relative to it. */
export const KILLED_INSTALL_LEFTOVER = path.join('node_modules', '.half-installed');

/** What staging ran through the fixture. */
export interface StagingWorld {
  /** Every Git subcommand staging ran, in order. */
  readonly git: string[];
  /** Every faked command: Docker, and NanoClaw's image build. */
  readonly faked: SanitizedCommand[];
  /** Every install and build of a release. */
  readonly setup: SetupCommand[];
  /** The next install leaves part of its work behind, then dies. */
  killInstall: boolean;
}

/** The seams staging runs with, and the world they record. */
export function stagingWorld(): { readonly world: StagingWorld; readonly seams: ReleaseStageSeams } {
  const world: StagingWorld = { git: [], faked: [], setup: [], killInstall: false };
  return {
    world,
    seams: {
      runCommand: async (command) => {
        if (command.command === 'git' || command.command === 'tar') {
          if (command.command === 'git') world.git.push(command.args.find((arg) => !arg.startsWith('-')) ?? '');
          return runSanitizedCommand(command);
        }
        world.faked.push(command);
        return { stdout: '', stderr: '' };
      },
      runSetupCommand: async (command) => {
        world.setup.push(command);
        const write = async (file: string, contents: string): Promise<void> => {
          await mkdir(path.dirname(path.join(command.cwd, file)), { recursive: true });
          await writeFile(path.join(command.cwd, file), contents);
        };
        if (command.args[0] === 'install') {
          if (world.killInstall) {
            world.killInstall = false;
            await write(KILLED_INSTALL_LEFTOVER, 'half installed\n');
            throw new Error('The install was killed');
          }
          await write('node_modules/.modules.yaml', 'installed\n');
          return;
        }
        await write('dist/index.js', 'host\n');
        await write('dist/gws-ea/process.js', 'launcher\n');
      },
    },
  };
}
