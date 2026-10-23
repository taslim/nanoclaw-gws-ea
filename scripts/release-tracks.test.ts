import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const repository = fileURLToPath(new URL('../', import.meta.url));
const roots: string[] = [];
const workflow = `name: CI
on:
  pull_request:
    # release-tracks:start
    branches: [stale]
    # release-tracks:end
  push:
    # release-tracks:start
    branches: [stale]
    # release-tracks:end
jobs:
  test:
    runs-on: ubuntu-latest
`;
const review = `reviews:
  profile: chill
  auto_review:
    # release-tracks:start
    base_branches: [stale]
    # release-tracks:end
`;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gws-ea-track-config-'));
  roots.push(root);
  for (const directory of ['scripts', 'src/gws-ea', '.github/workflows']) {
    await mkdir(path.join(root, directory), { recursive: true });
  }
  for (const file of ['scripts/release-tracks.ts', 'src/gws-ea/release-tracks.ts', 'src/gws-ea/types.ts']) {
    await cp(path.join(repository, file), path.join(root, file));
  }
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  await writeFile(
    path.join(root, 'src/gws-ea/release-tracks.json'),
    JSON.stringify({ prod: null, dogfood: 'integration.v3+trial' }),
  );
  await writeFile(path.join(root, '.github/workflows/ci.yml'), workflow);
  await writeFile(path.join(root, '.coderabbit.yaml'), review);
  return root;
}

function run(root: string, ...args: string[]) {
  return spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), 'scripts/release-tracks.ts', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

async function configs(root: string): Promise<readonly [string, string]> {
  return Promise.all([
    readFile(path.join(root, '.github/workflows/ci.yml'), 'utf8'),
    readFile(path.join(root, '.coderabbit.yaml'), 'utf8'),
  ]);
}

describe('release track tooling', () => {
  it('prints only the configured branch for operational shell commands', async () => {
    const root = await fixture();
    expect(run(root, '--branch', 'dogfood')).toMatchObject({ status: 0, stdout: 'integration.v3+trial\n', stderr: '' });
    expect(await configs(root)).toEqual([workflow, review]);
  });

  it('generates native branch filters and exact review patterns, preserving other configuration', async () => {
    const root = await fixture();
    expect(run(root, '--generate')).toMatchObject({ status: 0, stderr: '' });
    const [ci, rabbit] = await configs(root);
    expect(parse(ci)).toEqual({
      name: 'CI',
      on: {
        pull_request: { branches: ['main', 'integration.v3\\+trial'] },
        push: { branches: ['main', 'integration.v3\\+trial'] },
      },
      jobs: { test: { 'runs-on': 'ubuntu-latest' } },
    });
    expect(parse(rabbit)).toEqual({
      reviews: { profile: 'chill', auto_review: { base_branches: ['^main$', '^integration\\.v3\\+trial$'] } },
    });
    expect(run(root, '--check')).toMatchObject({ status: 0, stderr: '' });
    expect(run(root, '--generate')).toMatchObject({ status: 0, stderr: '' });
    expect(await configs(root)).toEqual([ci, rabbit]);
  });

  it('reports drift without writing either configuration', async () => {
    const root = await fixture();
    const result = run(root, '--check');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('.github/workflows/ci.yml');
    expect(result.stderr).toContain('.coderabbit.yaml');
    expect(result.stderr).toContain('pnpm run release-tracks:generate');
    expect(await configs(root)).toEqual([workflow, review]);
  });

  it('regenerates both consumers after a track moves and deduplicates the public branch', async () => {
    const root = await fixture();
    expect(run(root, '--generate').status).toBe(0);
    await writeFile(
      path.join(root, 'src/gws-ea/release-tracks.json'),
      JSON.stringify({ prod: 'main', dogfood: 'next/integration' }),
    );
    expect(run(root, '--check').status).toBe(1);
    expect(run(root, '--generate').status).toBe(0);
    expect(run(root, '--branch', 'dogfood')).toMatchObject({ status: 0, stdout: 'next/integration\n' });
    expect(run(root, '--branch', 'prod')).toMatchObject({ status: 0, stdout: 'main\n' });
    const [ci, rabbit] = await configs(root);
    expect(parse(ci)).toMatchObject({
      on: {
        pull_request: { branches: ['main', 'next/integration'] },
        push: { branches: ['main', 'next/integration'] },
      },
    });
    expect(parse(rabbit)).toMatchObject({
      reviews: { auto_review: { base_branches: ['^main$', '^next/integration$'] } },
    });
    expect(ci).not.toContain('integration.v3');
    expect(run(root, '--check').status).toBe(0);
  });

  it('refuses unavailable or unknown tracks and invalid invocations without changing configuration', async () => {
    const root = await fixture();
    for (const args of [['--branch', 'prod'], ['--branch', 'missing'], ['--branch'], ['--generate', 'extra'], []]) {
      const result = run(root, ...args);
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe('');
    }
    expect(run(root, '--branch', 'prod').stderr).toContain('no release yet');
    expect(await configs(root)).toEqual([workflow, review]);
  });

  it('refuses missing configuration markers before writing any file', async () => {
    const root = await fixture();
    const unmarked = 'reviews: {}\n';
    await writeFile(path.join(root, '.coderabbit.yaml'), unmarked);
    expect(run(root, '--generate').status).toBe(1);
    expect(await configs(root)).toEqual([workflow, unmarked]);
  });
});
