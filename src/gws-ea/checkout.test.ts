import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { assertReleaseCheckoutAgreement, materializeReleaseCheckout, resolveReleaseCommit } from './checkout.js';
import { resolveControlPlanePaths, type ControlPlanePaths } from './paths.js';
import { TOOL_ENVIRONMENT_KEYS, runSanitizedCommand } from './process.js';
import { allocateInstanceId, reserveInstance } from './registry.js';
import type { InstanceReservationInput } from './types.js';

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function write(root: string, relativePath: string, contents: string): Promise<void> {
  const file = path.join(root, relativePath);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents);
}

function commit(root: string, message: string): string {
  git(root, 'add', '.');
  git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', message);
  return git(root, 'rev-parse', 'HEAD');
}

interface SourceFixture {
  remote: string;
  source: string;
  firstCommit: string;
}

async function sourceFixture(): Promise<SourceFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gws-ea-release-source-'));
  roots.push(root);
  const source = path.join(root, 'source');
  const remote = path.join(root, 'remote.git');
  await mkdir(source);
  git(source, 'init', '-b', 'dogfood');
  await write(source, '.gitignore', 'data/\nnode_modules/\ndist/\n');
  await write(source, 'release.txt', 'first\n');
  const firstCommit = commit(source, 'first release');
  git(root, 'clone', '--bare', source, remote);
  git(source, 'remote', 'add', 'origin', remote);
  return { remote, source, firstCommit };
}

async function controlPlanePaths(): Promise<ControlPlanePaths> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gws-ea-checkout-state-'));
  roots.push(root);
  return resolveControlPlanePaths({
    configRoot: path.join(root, 'config'),
    stateRoot: path.join(root, 'state'),
  });
}

function reservation(
  paths: ControlPlanePaths,
  instanceId: string,
  sourceRemote: string,
  deployedCommit: string,
): InstanceReservationInput {
  return {
    instance_id: instanceId,
    checkout_realpath: paths.checkoutRoot(instanceId),
    release_track: 'dogfood',
    source_remote: sourceRemote,
    deployed_commit: deployedCommit,
    allocated_ports: { nanoclaw_webhook: 33_001, onecli_app: 33_002, onecli_gateway: 33_003 },
    exclusive_resource_claims: {
      ingress: { mode: 'existing', endpoint_url: 'https://checkout.example.test/webhook/gchat' },
      gcp_project_id: 'checkout-project',
      gcp_account: 'operator@example.test',
      gchat_service_account: 'gws-ea-chat@checkout-project.iam.gserviceaccount.com',
      workspace_email: 'checkout@example.test',
      onecli_project: `gws-ea-${instanceId.replaceAll('-', '')}`,
    },
  };
}

function stagingRoot(paths: ControlPlanePaths, instanceId: string): string {
  return `${paths.checkoutRoot(instanceId)}.staging`;
}

function expectSanitizedEnvironment(
  environment: Readonly<Record<string, string>> | undefined,
  expectedHome?: string,
  additions: readonly string[] = [],
): void {
  if (expectedHome) expect(environment?.HOME).toBe(expectedHome);
  else expect(environment?.HOME).toMatch(/\.release-home$/);
  expect(environment?.GIT_CONFIG_NOSYSTEM).toBe('1');
  expect(environment?.GIT_TERMINAL_PROMPT).toBe('0');
  for (const key of Object.keys(environment ?? {})) {
    expect([...TOOL_ENVIRONMENT_KEYS, 'HOME', 'GIT_CONFIG_NOSYSTEM', 'GIT_TERMINAL_PROMPT', ...additions]).toContain(
      key,
    );
  }
}

describe('exact release checkout', () => {
  it('materializes the recorded commit even when the release branch moves after resolution', async () => {
    const source = await sourceFixture();
    const resolved = await resolveReleaseCommit(source.remote, 'refs/heads/dogfood');
    expect(resolved.commit).toBe(source.firstCommit);

    await write(source.source, 'release.txt', 'second\n');
    const movedCommit = commit(source.source, 'move release branch');
    git(source.source, 'push', 'origin', 'dogfood');
    expect(movedCommit).not.toBe(resolved.commit);

    const paths = await controlPlanePaths();
    const instanceId = allocateInstanceId();
    await reserveInstance(paths, reservation(paths, instanceId, source.remote, resolved.commit));

    await materializeReleaseCheckout(paths, instanceId, resolved);

    expect(git(paths.checkoutRoot(instanceId), 'rev-parse', 'HEAD')).toBe(source.firstCommit);
    expect(git(paths.checkoutRoot(instanceId), 'branch', '--show-current')).toBe('');
    expect(git(paths.checkoutRoot(instanceId), 'status', '--porcelain')).toBe('');
    expect(await assertReleaseCheckoutAgreement(paths, instanceId)).toMatchObject({
      instance_id: instanceId,
      deployed_commit: source.firstCommit,
    });
    expect(JSON.parse(await readFile(paths.markerFile(instanceId), 'utf8'))).toEqual({
      schema_version: 1,
      instance_id: instanceId,
      deployed_commit: source.firstCommit,
    });
  });

  it('rejects a ref that peels to a non-commit object', async () => {
    const source = await sourceFixture();
    const blob = git(source.source, 'hash-object', '-w', '--stdin');
    git(source.source, 'update-ref', 'refs/tags/not-a-commit', blob);
    git(source.source, 'push', 'origin', 'refs/tags/not-a-commit');

    await expect(resolveReleaseCommit(source.remote, 'refs/tags/not-a-commit')).rejects.toMatchObject({
      code: 'release_ref_not_commit',
    });
  });

  it('rejects an invalid release ref before fetching it', async () => {
    const source = await sourceFixture();

    await expect(resolveReleaseCommit(source.remote, 'refs/heads/../dogfood')).rejects.toMatchObject({
      code: 'invalid_release_ref',
    });
  });

  it('does not propagate hostile ambient configuration into release Git children', async () => {
    const source = await sourceFixture();
    vi.stubEnv('GIT_CONFIG_GLOBAL', '/tmp/hostile-gitconfig');
    vi.stubEnv('GIT_DIR', '/tmp/hostile-git-dir');
    vi.stubEnv('GIT_ASKPASS', '/tmp/hostile-askpass');
    vi.stubEnv('SSH_AUTH_SOCK', '/tmp/hostile-agent.sock');
    vi.stubEnv('NPM_CONFIG_USERCONFIG', '/tmp/hostile-npmrc');
    vi.stubEnv('PNPM_HOME', '/tmp/hostile-pnpm');
    vi.stubEnv('ONECLI_HOME', '/tmp/hostile-onecli');
    vi.stubEnv('ANTHROPIC_API_KEY', 'must-not-propagate');
    vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', '/tmp/hostile-google-key');
    const observed: Array<{ args: readonly string[]; env: Readonly<Record<string, string>> | undefined }> = [];

    const resolved = await resolveReleaseCommit(source.remote, 'refs/heads/dogfood', {
      fetchAuthentication: {
        askPassProgram: '/owned/askpass',
        sshAgentSocket: '/owned/agent.sock',
      },
      runCommand: async (spec) => {
        observed.push({ args: spec.args, env: spec.env });
        return runSanitizedCommand(spec);
      },
    });

    expect(resolved.commit).toBe(source.firstCommit);
    expect(observed.length).toBeGreaterThan(0);
    for (const command of observed) {
      const isFetch = command.args[0] === 'fetch';
      expectSanitizedEnvironment(command.env, undefined, isFetch ? ['GIT_ASKPASS', 'SSH_AUTH_SOCK'] : []);
      expect(command.env?.GIT_ASKPASS).toBe(isFetch ? '/owned/askpass' : undefined);
      expect(command.env?.SSH_AUTH_SOCK).toBe(isFetch ? '/owned/agent.sock' : undefined);
    }
  });

  it('rejects an existing checkout instead of reusing or overwriting it', async () => {
    const source = await sourceFixture();
    const resolved = await resolveReleaseCommit(source.remote, 'refs/heads/dogfood');
    const paths = await controlPlanePaths();
    const instanceId = allocateInstanceId();
    await reserveInstance(paths, reservation(paths, instanceId, source.remote, resolved.commit));
    await mkdir(paths.checkoutRoot(instanceId), { recursive: true });
    await write(paths.checkoutRoot(instanceId), 'owner.txt', 'someone else\n');

    await expect(materializeReleaseCheckout(paths, instanceId, resolved)).rejects.toMatchObject({
      code: 'checkout_exists',
    });
    expect(await readFile(path.join(paths.checkoutRoot(instanceId), 'owner.txt'), 'utf8')).toBe('someone else\n');
  });

  it('rejects a checkout path reached through a symlink', async () => {
    const source = await sourceFixture();
    const resolved = await resolveReleaseCommit(source.remote, 'refs/heads/dogfood');
    const paths = await controlPlanePaths();
    const instanceId = allocateInstanceId();
    await reserveInstance(paths, reservation(paths, instanceId, source.remote, resolved.commit));
    await mkdir(paths.instanceRoot(instanceId), { recursive: true });
    const target = path.join(path.dirname(paths.stateRoot), 'foreign-checkout');
    await mkdir(target);
    await symlink(target, paths.checkoutRoot(instanceId));

    await expect(materializeReleaseCheckout(paths, instanceId, resolved)).rejects.toMatchObject({
      code: 'unsafe_checkout',
    });
  });

  it('rejects a resolved release that disagrees with the immutable reservation', async () => {
    const source = await sourceFixture();
    const resolved = await resolveReleaseCommit(source.remote, 'refs/heads/dogfood');
    const paths = await controlPlanePaths();
    const instanceId = allocateInstanceId();
    await reserveInstance(paths, reservation(paths, instanceId, source.remote, 'f'.repeat(40)));

    await expect(materializeReleaseCheckout(paths, instanceId, resolved)).rejects.toMatchObject({
      code: 'release_mismatch',
    });
  });

  it('removes a newly-created partial checkout when exact-commit fetch fails', async () => {
    const source = await sourceFixture();
    const resolved = await resolveReleaseCommit(source.remote, 'refs/heads/dogfood');
    const paths = await controlPlanePaths();
    const instanceId = allocateInstanceId();
    await reserveInstance(paths, reservation(paths, instanceId, source.remote, resolved.commit));

    await expect(
      materializeReleaseCheckout(paths, instanceId, resolved, {
        runCommand: async (spec) => {
          if (spec.cwd === stagingRoot(paths, instanceId) && spec.args[0] === 'fetch') {
            throw new Error('fixture fetch failure');
          }
          return runSanitizedCommand(spec);
        },
      }),
    ).rejects.toThrow(/fixture fetch failure/);
    await expect(stat(paths.checkoutRoot(instanceId))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(stagingRoot(paths, instanceId))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('publishes the checkout atomically only after staging verification', async () => {
    const source = await sourceFixture();
    const resolved = await resolveReleaseCommit(source.remote, 'refs/heads/dogfood');
    const paths = await controlPlanePaths();
    const instanceId = allocateInstanceId();
    await reserveInstance(paths, reservation(paths, instanceId, source.remote, resolved.commit));
    const expectedHome = path.join(paths.instanceRoot(instanceId), '.release-home');

    await materializeReleaseCheckout(paths, instanceId, resolved, {
      runCommand: async (spec) => {
        expectSanitizedEnvironment(spec.env, expectedHome);
        if (spec.cwd === stagingRoot(paths, instanceId)) {
          await expect(stat(paths.checkoutRoot(instanceId))).rejects.toMatchObject({ code: 'ENOENT' });
        }
        return runSanitizedCommand(spec);
      },
    });

    expect(git(paths.checkoutRoot(instanceId), 'rev-parse', 'HEAD')).toBe(resolved.commit);
    await expect(stat(stagingRoot(paths, instanceId))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('publishes a complete owned staging checkout after an interrupted rename', async () => {
    const source = await sourceFixture();
    const resolved = await resolveReleaseCommit(source.remote, 'refs/heads/dogfood');
    const paths = await controlPlanePaths();
    const instanceId = allocateInstanceId();
    await reserveInstance(paths, reservation(paths, instanceId, source.remote, resolved.commit));
    await materializeReleaseCheckout(paths, instanceId, resolved);
    await rename(paths.checkoutRoot(instanceId), stagingRoot(paths, instanceId));
    const commands: string[] = [];

    await materializeReleaseCheckout(paths, instanceId, resolved, {
      runCommand: async (spec) => {
        commands.push(spec.args[0] ?? '');
        return runSanitizedCommand(spec);
      },
    });

    expect(commands).not.toContain('init');
    expect(commands).not.toContain('fetch');
    expect(commands).not.toContain('checkout');
    expect(git(paths.checkoutRoot(instanceId), 'rev-parse', 'HEAD')).toBe(resolved.commit);
  });

  it('cleans an owned partial staging checkout before retrying materialization', async () => {
    const source = await sourceFixture();
    const resolved = await resolveReleaseCommit(source.remote, 'refs/heads/dogfood');
    const paths = await controlPlanePaths();
    const instanceId = allocateInstanceId();
    await reserveInstance(paths, reservation(paths, instanceId, source.remote, resolved.commit));
    await mkdir(paths.instanceRoot(instanceId), { recursive: true, mode: 0o700 });
    await mkdir(stagingRoot(paths, instanceId), { mode: 0o700 });
    await write(stagingRoot(paths, instanceId), 'partial.txt', 'interrupted\n');

    await materializeReleaseCheckout(paths, instanceId, resolved);

    await expect(stat(path.join(paths.checkoutRoot(instanceId), 'partial.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(git(paths.checkoutRoot(instanceId), 'rev-parse', 'HEAD')).toBe(resolved.commit);
  });

  it('does not clean a staging path that is a symlink', async () => {
    const source = await sourceFixture();
    const resolved = await resolveReleaseCommit(source.remote, 'refs/heads/dogfood');
    const paths = await controlPlanePaths();
    const instanceId = allocateInstanceId();
    await reserveInstance(paths, reservation(paths, instanceId, source.remote, resolved.commit));
    await mkdir(paths.instanceRoot(instanceId), { recursive: true, mode: 0o700 });
    const foreign = path.join(path.dirname(paths.stateRoot), 'foreign-staging');
    await mkdir(foreign);
    await write(foreign, 'owner.txt', 'preserve me\n');
    await symlink(foreign, stagingRoot(paths, instanceId));

    await expect(materializeReleaseCheckout(paths, instanceId, resolved)).rejects.toMatchObject({
      code: 'unsafe_checkout',
    });
    expect(await readFile(path.join(foreign, 'owner.txt'), 'utf8')).toBe('preserve me\n');
  });

  it('does not replace an unmarked final directory created while staging', async () => {
    const source = await sourceFixture();
    const resolved = await resolveReleaseCommit(source.remote, 'refs/heads/dogfood');
    const paths = await controlPlanePaths();
    const instanceId = allocateInstanceId();
    await reserveInstance(paths, reservation(paths, instanceId, source.remote, resolved.commit));

    await expect(
      materializeReleaseCheckout(paths, instanceId, resolved, {
        runCommand: async (spec) => {
          const result = await runSanitizedCommand(spec);
          if (spec.cwd === stagingRoot(paths, instanceId) && spec.args[0] === 'status') {
            await mkdir(paths.checkoutRoot(instanceId), { mode: 0o700 });
            await write(paths.checkoutRoot(instanceId), 'owner.txt', 'preserve me\n');
          }
          return result;
        },
      }),
    ).rejects.toMatchObject({ code: 'checkout_exists' });
    expect(await readFile(path.join(paths.checkoutRoot(instanceId), 'owner.txt'), 'utf8')).toBe('preserve me\n');
    await expect(stat(stagingRoot(paths, instanceId))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
