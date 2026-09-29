import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertDeploymentCheckoutUnmodified,
  assertReleaseCheckoutAgreement,
  locateAgainstToolRelease,
  locateOnTrack,
  materializeReleaseCheckout,
  observeLiveCheckout,
  resolveToolCommit,
} from './checkout.js';
import { resolveControlPlanePaths, type ControlPlanePaths } from './paths.js';
import { TOOL_ENVIRONMENT_KEYS, runSanitizedCommand, type SanitizedCommand } from './process.js';
import { reserveInstance } from './journal.js';
import { allocateInstanceId, readInstanceMarkerFile } from './registry.js';
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

async function reserved(paths: ControlPlanePaths, sourceRemote: string, deployedCommit: string) {
  const instanceId = allocateInstanceId();
  return reserveInstance(paths, reservation(paths, instanceId, sourceRemote, deployedCommit));
}

describe('release track history', () => {
  it('rejects a ref that peels to a non-commit object', async () => {
    const source = await sourceFixture();
    const blob = git(source.source, 'hash-object', '-w', '--stdin');
    git(source.source, 'update-ref', 'refs/tags/not-a-commit', blob);
    git(source.source, 'push', 'origin', 'refs/tags/not-a-commit');

    await expect(
      locateOnTrack({ remote: source.remote, ref: 'refs/tags/not-a-commit' }, { commit: source.firstCommit }),
    ).rejects.toMatchObject({ code: 'release_ref_not_commit' });
  });

  it('rejects an invalid release ref before fetching it', async () => {
    const source = await sourceFixture();

    await expect(
      locateOnTrack({ remote: source.remote, ref: 'refs/heads/../dogfood' }, { commit: source.firstCommit }),
    ).rejects.toMatchObject({ code: 'invalid_release_ref' });
  });

  it('runs every Git child with an owned environment, fetches history without blobs, and never fetches lazily', async () => {
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
    const observed: Array<{ args: readonly string[]; cwd: string; env: Readonly<Record<string, string>> | undefined }> =
      [];
    const runtime = {
      fetchAuthentication: { askPassProgram: '/owned/askpass', sshAgentSocket: '/owned/agent.sock' },
      runCommand: async (spec: SanitizedCommand) => {
        observed.push({ args: spec.args, cwd: spec.cwd, env: spec.env });
        return runSanitizedCommand(spec);
      },
    };

    expect(await resolveToolCommit(source.source, runtime)).toBe(source.firstCommit);
    await expect(
      locateOnTrack({ remote: source.remote, ref: 'refs/heads/dogfood' }, { commit: source.firstCommit }, runtime),
    ).resolves.toEqual({ onTrack: true });

    const fetches = observed.filter((command) => command.args[0] === 'fetch');
    expect(fetches).toHaveLength(1);
    expect(fetches[0]?.args).toContain('--filter=blob:none');
    for (const command of observed) {
      const isFetch = command.args[0] === 'fetch';
      const inTool = command.cwd === source.source;
      expectSanitizedEnvironment(command.env, undefined, [
        ...(isFetch ? ['GIT_ASKPASS', 'SSH_AUTH_SOCK'] : []),
        ...(isFetch || inTool ? [] : ['GIT_NO_LAZY_FETCH']),
      ]);
      expect(command.env?.GIT_ASKPASS).toBe(isFetch ? '/owned/askpass' : undefined);
      expect(command.env?.SSH_AUTH_SOCK).toBe(isFetch ? '/owned/agent.sock' : undefined);
      expect(command.env?.GIT_NO_LAZY_FETCH).toBe(isFetch || inTool ? undefined : '1');
    }
  });
});

describe('exact release checkout', () => {
  it('materializes the reserved commit even when the release branch has moved on', async () => {
    const source = await sourceFixture();
    await write(source.source, 'release.txt', 'second\n');
    const movedCommit = commit(source.source, 'move release branch');
    git(source.source, 'push', 'origin', 'dogfood');
    expect(movedCommit).not.toBe(source.firstCommit);

    const paths = await controlPlanePaths();
    const reservation = await reserved(paths, source.remote, source.firstCommit);
    const instanceId = reservation.instance_id;

    await materializeReleaseCheckout(paths, reservation);

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

  it("stages an update's target reservation view in its release slot from the target's source, leaving the live release in place", async () => {
    const dogfood = await sourceFixture();
    const paths = await controlPlanePaths();
    const deployed = await reserved(paths, dogfood.remote, dogfood.firstCommit);
    const instanceId = deployed.instance_id;
    await materializeReleaseCheckout(paths, deployed);
    // A prod repository whose history carries the deployed commit, one commit ahead of it.
    const prodRoot = await mkdtemp(path.join(os.tmpdir(), 'gws-ea-prod-source-'));
    roots.push(prodRoot);
    const prodWork = path.join(prodRoot, 'work');
    git(prodRoot, 'clone', '--quiet', dogfood.remote, prodWork);
    git(prodWork, 'checkout', '--quiet', '-b', 'main');
    await write(prodWork, 'release.txt', 'prod\n');
    const prodCommit = commit(prodWork, 'prod release');
    const prodRemote = path.join(prodRoot, 'remote.git');
    git(prodRoot, 'clone', '--quiet', '--bare', prodWork, prodRemote);
    const view = { ...deployed, source_remote: prodRemote, release_track: 'prod', deployed_commit: prodCommit };

    await expect(materializeReleaseCheckout(paths, view, {}, 'next')).resolves.toEqual(view);

    const staged = paths.releaseCheckoutRoot(instanceId, 'next');
    expect(git(staged, 'rev-parse', 'HEAD')).toBe(prodCommit);
    expect(git(staged, 'branch', '--show-current')).toBe('');
    expect(git(staged, 'status', '--porcelain')).toBe('');
    expect(await readInstanceMarkerFile(path.join(staged, 'data', 'gws-ea', 'instance.json'))).toEqual({
      schema_version: 1,
      instance_id: instanceId,
      deployed_commit: prodCommit,
    });
    await expect(stat(`${staged}.staging`)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(git(paths.checkoutRoot(instanceId), 'rev-parse', 'HEAD')).toBe(dogfood.firstCommit);
    expect(await assertReleaseCheckoutAgreement(paths, instanceId)).toEqual(deployed);
  });

  it('rejects an existing checkout instead of reusing or overwriting it', async () => {
    const source = await sourceFixture();
    const paths = await controlPlanePaths();
    const reservation = await reserved(paths, source.remote, source.firstCommit);
    const instanceId = reservation.instance_id;
    await mkdir(paths.checkoutRoot(instanceId), { recursive: true });
    await write(paths.checkoutRoot(instanceId), 'owner.txt', 'someone else\n');

    await expect(materializeReleaseCheckout(paths, reservation)).rejects.toMatchObject({
      code: 'checkout_exists',
    });
    expect(await readFile(path.join(paths.checkoutRoot(instanceId), 'owner.txt'), 'utf8')).toBe('someone else\n');
  });

  it('rejects a checkout path reached through a symlink', async () => {
    const source = await sourceFixture();
    const paths = await controlPlanePaths();
    const reservation = await reserved(paths, source.remote, source.firstCommit);
    const instanceId = reservation.instance_id;
    await mkdir(paths.instanceRoot(instanceId), { recursive: true });
    const target = path.join(path.dirname(paths.stateRoot), 'foreign-checkout');
    await mkdir(target);
    await symlink(target, paths.checkoutRoot(instanceId));

    await expect(materializeReleaseCheckout(paths, reservation)).rejects.toMatchObject({
      code: 'unsafe_checkout',
    });
  });

  it('refuses to publish into the live checkout a release the registry does not record', async () => {
    const source = await sourceFixture();
    const paths = await controlPlanePaths();
    const reservation = await reserved(paths, source.remote, 'f'.repeat(40));

    await expect(
      materializeReleaseCheckout(paths, { ...reservation, deployed_commit: source.firstCommit }),
    ).rejects.toMatchObject({ code: 'release_mismatch' });
    await expect(stat(paths.checkoutRoot(reservation.instance_id))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes a newly-created partial checkout when exact-commit fetch fails', async () => {
    const source = await sourceFixture();
    const paths = await controlPlanePaths();
    const reservation = await reserved(paths, source.remote, source.firstCommit);
    const instanceId = reservation.instance_id;

    await expect(
      materializeReleaseCheckout(paths, reservation, {
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
    const paths = await controlPlanePaths();
    const reservation = await reserved(paths, source.remote, source.firstCommit);
    const instanceId = reservation.instance_id;
    const expectedHome = path.join(paths.instanceRoot(instanceId), '.release-home');

    await materializeReleaseCheckout(paths, reservation, {
      runCommand: async (spec) => {
        expectSanitizedEnvironment(spec.env, expectedHome);
        if (spec.cwd === stagingRoot(paths, instanceId)) {
          await expect(stat(paths.checkoutRoot(instanceId))).rejects.toMatchObject({ code: 'ENOENT' });
        }
        return runSanitizedCommand(spec);
      },
    });

    expect(git(paths.checkoutRoot(instanceId), 'rev-parse', 'HEAD')).toBe(source.firstCommit);
    await expect(stat(stagingRoot(paths, instanceId))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('publishes a complete owned staging checkout after an interrupted rename', async () => {
    const source = await sourceFixture();
    const paths = await controlPlanePaths();
    const reservation = await reserved(paths, source.remote, source.firstCommit);
    const instanceId = reservation.instance_id;
    await materializeReleaseCheckout(paths, reservation);
    await rename(paths.checkoutRoot(instanceId), stagingRoot(paths, instanceId));
    const commands: string[] = [];

    await materializeReleaseCheckout(paths, reservation, {
      runCommand: async (spec) => {
        commands.push(spec.args[0] ?? '');
        return runSanitizedCommand(spec);
      },
    });

    expect(commands).not.toContain('init');
    expect(commands).not.toContain('fetch');
    expect(commands).not.toContain('checkout');
    expect(git(paths.checkoutRoot(instanceId), 'rev-parse', 'HEAD')).toBe(source.firstCommit);
  });

  it('cleans an owned partial staging checkout before retrying materialization', async () => {
    const source = await sourceFixture();
    const paths = await controlPlanePaths();
    const reservation = await reserved(paths, source.remote, source.firstCommit);
    const instanceId = reservation.instance_id;
    await mkdir(paths.instanceRoot(instanceId), { recursive: true, mode: 0o700 });
    await mkdir(stagingRoot(paths, instanceId), { mode: 0o700 });
    await write(stagingRoot(paths, instanceId), 'partial.txt', 'interrupted\n');

    await materializeReleaseCheckout(paths, reservation);

    await expect(stat(path.join(paths.checkoutRoot(instanceId), 'partial.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(git(paths.checkoutRoot(instanceId), 'rev-parse', 'HEAD')).toBe(source.firstCommit);
  });

  it('does not clean a staging path that is a symlink', async () => {
    const source = await sourceFixture();
    const paths = await controlPlanePaths();
    const reservation = await reserved(paths, source.remote, source.firstCommit);
    const instanceId = reservation.instance_id;
    await mkdir(paths.instanceRoot(instanceId), { recursive: true, mode: 0o700 });
    const foreign = path.join(path.dirname(paths.stateRoot), 'foreign-staging');
    await mkdir(foreign);
    await write(foreign, 'owner.txt', 'preserve me\n');
    await symlink(foreign, stagingRoot(paths, instanceId));

    await expect(materializeReleaseCheckout(paths, reservation)).rejects.toMatchObject({
      code: 'unsafe_checkout',
    });
    expect(await readFile(path.join(foreign, 'owner.txt'), 'utf8')).toBe('preserve me\n');
  });

  it('does not replace an unmarked final directory created while staging', async () => {
    const source = await sourceFixture();
    const paths = await controlPlanePaths();
    const reservation = await reserved(paths, source.remote, source.firstCommit);
    const instanceId = reservation.instance_id;

    await expect(
      materializeReleaseCheckout(paths, reservation, {
        runCommand: async (spec) => {
          const result = await runSanitizedCommand(spec);
          if (spec.cwd === stagingRoot(paths, instanceId) && spec.args.includes('status')) {
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

/** Git's index as it is on disk: a read that refreshed it would change its bytes or its modification time. */
async function indexState(checkoutRoot: string): Promise<{ readonly bytes: string; readonly modified: number }> {
  const index = path.join(checkoutRoot, '.git', 'index');
  return { bytes: (await readFile(index)).toString('base64'), modified: (await stat(index)).mtimeMs };
}

/** Make Git's cached stat of a tracked file stale without changing it, so an ordinary `git status` rewrites the index. */
async function staleIndexEntry(checkoutRoot: string, relativePath: string): Promise<void> {
  const later = new Date(Date.now() + 60_000);
  await utimes(path.join(checkoutRoot, relativePath), later, later);
}

describe('read-only observation', () => {
  it("places an assistant's commit against the tool's own release from the tool's history, never fetching", async () => {
    const source = await sourceFixture();
    await write(source.source, 'release.txt', 'second\n');
    const second = commit(source.source, 'second release');
    const subcommands: string[] = [];
    const runtime = {
      runCommand: async (spec: SanitizedCommand) => {
        subcommands.push(spec.args.find((argument) => !argument.startsWith('-')) ?? '');
        return runSanitizedCommand(spec);
      },
    };

    await expect(locateAgainstToolRelease(source.source, source.firstCommit, runtime)).resolves.toEqual({
      toolCommit: second,
      position: 'behind',
    });
    await expect(locateAgainstToolRelease(source.source, second, runtime)).resolves.toEqual({
      toolCommit: second,
      position: 'same',
    });
    // A commit the tool's history does not hold cannot be placed.
    await expect(locateAgainstToolRelease(source.source, 'f'.repeat(40), runtime)).resolves.toEqual({
      toolCommit: second,
      position: 'unknown',
    });
    // A tool older than the assistant's release is not ahead of it.
    git(source.source, 'checkout', '--quiet', '--detach', source.firstCommit);
    await expect(locateAgainstToolRelease(source.source, second, runtime)).resolves.toEqual({
      toolCommit: source.firstCommit,
      position: 'elsewhere',
    });
    expect(subcommands).not.toContain('fetch');
  });

  it("never refreshes the tool checkout's index while placing a commit", async () => {
    const source = await sourceFixture();
    await staleIndexEntry(source.source, 'release.txt');
    const before = await indexState(source.source);

    await locateAgainstToolRelease(source.source, source.firstCommit);

    expect(await indexState(source.source)).toEqual(before);
  });

  it('observes the live checkout without creating anything under the instance or refreshing its index', async () => {
    const source = await sourceFixture();
    const paths = await controlPlanePaths();
    const reservation = await reserved(paths, source.remote, source.firstCommit);
    const instanceId = reservation.instance_id;
    const checkout = paths.checkoutRoot(instanceId);
    await materializeReleaseCheckout(paths, reservation);
    const helper = path.join(paths.instanceRoot(instanceId), '.release-home');
    await rm(helper, { recursive: true, force: true });
    await staleIndexEntry(checkout, 'release.txt');
    const before = await indexState(checkout);

    await expect(observeLiveCheckout(reservation, [source.firstCommit])).resolves.toBe(source.firstCommit);

    await expect(stat(helper)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await indexState(checkout)).toEqual(before);
    // The fixture is sensitive: an ordinary status does rewrite this index.
    git(checkout, 'status', '--porcelain');
    expect(await indexState(checkout)).not.toEqual(before);
  });

  it('accepts only the commits the live checkout may hold, and refuses a tracked edit', async () => {
    const source = await sourceFixture();
    const paths = await controlPlanePaths();
    const reservation = await reserved(paths, source.remote, source.firstCommit);
    const checkout = paths.checkoutRoot(reservation.instance_id);
    await materializeReleaseCheckout(paths, reservation);
    const operationTarget = 'e'.repeat(40);

    // An unfinished operation's commits are accepted alongside the registry's.
    await expect(observeLiveCheckout(reservation, [operationTarget, source.firstCommit])).resolves.toBe(
      source.firstCommit,
    );
    await expect(observeLiveCheckout(reservation, [operationTarget])).rejects.toMatchObject({
      code: 'marker_mismatch',
    });
    await write(checkout, 'release.txt', 'edited\n');
    await expect(observeLiveCheckout(reservation, [source.firstCommit])).rejects.toMatchObject({
      code: 'checkout_drift',
    });
  });

  it('lets an update move a live checkout whose only changes are untracked, without touching its index', async () => {
    const source = await sourceFixture();
    const paths = await controlPlanePaths();
    const reservation = await reserved(paths, source.remote, source.firstCommit);
    const checkout = paths.checkoutRoot(reservation.instance_id);
    await materializeReleaseCheckout(paths, reservation);
    await write(checkout, 'notes.txt', 'an agent wrote this; it belongs to no release\n');
    await staleIndexEntry(checkout, 'release.txt');
    const before = await indexState(checkout);

    await expect(assertDeploymentCheckoutUnmodified(reservation)).resolves.toBeUndefined();

    expect(await indexState(checkout)).toEqual(before);
  });

  it('refuses to move a live checkout with tracked edits, naming each edited file', async () => {
    const source = await sourceFixture();
    await write(source.source, 'second.txt', 'second\n');
    const commitWithTwoFiles = commit(source.source, 'two tracked files');
    git(source.source, 'push', 'origin', 'dogfood');
    const paths = await controlPlanePaths();
    const reservation = await reserved(paths, source.remote, commitWithTwoFiles);
    const checkout = paths.checkoutRoot(reservation.instance_id);
    await materializeReleaseCheckout(paths, reservation);
    await write(checkout, 'release.txt', 'edited\n');
    await rm(path.join(checkout, 'second.txt'));
    await write(checkout, 'notes.txt', 'untracked\n');

    const refusal = assertDeploymentCheckoutUnmodified(reservation);

    await expect(refusal).rejects.toMatchObject({
      code: 'deployment_checkout_modified',
      message: expect.stringMatching(/release\.txt, second\.txt/u),
      details: { files: ['release.txt', 'second.txt'] },
    });
    await expect(refusal).rejects.toSatisfy((error: Error) => !error.message.includes('notes.txt'));
  });

  it('refuses to move a live checkout that is not at the release the registry records', async () => {
    const source = await sourceFixture();
    const paths = await controlPlanePaths();
    const reservation = await reserved(paths, source.remote, source.firstCommit);
    const checkout = paths.checkoutRoot(reservation.instance_id);
    await materializeReleaseCheckout(paths, reservation);
    await write(checkout, 'release.txt', 'moved\n');
    git(checkout, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qam', 'local commit');

    await expect(assertDeploymentCheckoutUnmodified(reservation)).rejects.toMatchObject({ code: 'release_mismatch' });
  });
});
