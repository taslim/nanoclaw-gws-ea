import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { reserveInstance } from './journal.js';
import { createOnecliRuntimeLayout, ONECLI_POSTGRES_IMAGE, renderOnecliCompose } from './onecli-compose.js';
import { wrapperImageTag } from './onecli-gateway-image.js';
import { resolveControlPlanePaths, type ControlPlanePaths } from './paths.js';
import { ONECLI_GATEWAY_VERSION, ONECLI_SDK_VERSION } from './pins.js';
import { runSanitizedCommand, type SanitizedCommandRunner } from './process.js';

import { resolveReleaseTarget, type ToolProviderSetup } from './release-target.js';
import type { ReleaseSource } from './release-tracks.js';
import { createInstanceRuntimeConfig, persistInstanceRuntime } from './service.js';
import type { InstanceReservation, ReleaseCoordinates } from './types.js';
import type { ProviderCredentialMetadata } from '../provider-credential.js';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const TRACK_BRANCH = 'rebuild-v2';
const CREDENTIAL: ProviderCredentialMetadata = {
  name: 'Anthropic',
  type: 'anthropic',
  hostPattern: 'api.anthropic.com',
  headerName: 'x-api-key',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function commitFile(repository: string, file: string, contents: string): Promise<string> {
  await writeFile(path.join(repository, file), contents);
  git(repository, 'add', '.');
  git(repository, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', `write ${file}`);
  return git(repository, 'rev-parse', 'HEAD');
}

interface Repository {
  /** A bare remote that serves blob-less fetches, as a hosted one does. */
  readonly remote: string;
  /** A working clone that commits and pushes to the remote. */
  readonly work: string;
}

/** A release repository whose `branch` starts at one commit, optionally on top of another repository's history. */
async function releaseRepository(branch: string, basedOn?: Repository): Promise<Repository & { first: string }> {
  const root = await temporaryRoot('gws-ea-release-repository-');
  const work = path.join(root, 'work');
  if (basedOn) {
    git(root, 'clone', '--quiet', basedOn.remote, work);
    git(work, 'checkout', '--quiet', '-b', branch);
  } else {
    await mkdir(work);
    git(work, 'init', '--quiet', '-b', branch);
  }
  const first = await commitFile(work, 'release.txt', `${branch} ${root}\n`);
  const remote = path.join(root, 'remote.git');
  git(root, 'clone', '--quiet', '--bare', work, remote);
  git(remote, 'config', 'uploadpack.allowFilter', 'true');
  git(work, 'remote', basedOn ? 'set-url' : 'add', 'origin', remote);
  return { remote, work, first };
}

async function push(repository: Repository, file: string, branch = TRACK_BRANCH): Promise<string> {
  const commit = await commitFile(repository.work, file, `${file}\n`);
  git(repository.work, 'push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`);
  return commit;
}

/** The tool: a clone of the remote, as an operator runs gws-ea from. */
async function toolClone(remote: string, commit?: string): Promise<string> {
  const tool = path.join(await temporaryRoot('gws-ea-tool-'), 'tool');
  git(path.dirname(tool), 'clone', '--quiet', remote, tool);
  if (commit) git(tool, 'checkout', '--quiet', '--detach', commit);
  return tool;
}

function trackSource(remote: string, branch = TRACK_BRANCH): ReleaseSource {
  return { remote, ref: `refs/heads/${branch}` };
}

async function controlPlanePaths(): Promise<ControlPlanePaths> {
  const root = await temporaryRoot('gws-ea-release-target-state-');
  return resolveControlPlanePaths({ configRoot: path.join(root, 'config'), stateRoot: path.join(root, 'state') });
}

interface AssistantRecord {
  readonly onecli?: { readonly gateway: string; readonly sdk: string };
  readonly postgresImage?: string;
  readonly providerCredential?: ProviderCredentialMetadata;
}

/**
 * An assistant create finished: its reservation at `release`, and its own
 * record of what it runs (runtime, release receipt, and OneCLI Compose file),
 * on this tool's OneCLI cohort unless `record` says otherwise.
 */
async function deployedAssistant(
  paths: ControlPlanePaths,
  release: ReleaseCoordinates,
  record: AssistantRecord = {},
): Promise<InstanceReservation> {
  const instanceId = randomUUID();
  const reserved = await reserveInstance(paths, {
    instance_id: instanceId,
    ...release,
    allocated_ports: { nanoclaw_webhook: 35_101, onecli_app: 35_102, onecli_gateway: 35_103 },
    exclusive_resource_claims: {
      ingress: { mode: 'existing', endpoint_url: 'https://target.example.test/webhook/gchat' },
      gcp_project_id: 'target-project',
      gcp_account: 'operator@example.test',
      gchat_service_account: 'gws-ea-chat@target-project.iam.gserviceaccount.com',
      workspace_email: 'target@example.test',
      onecli_project: `gws-ea-${instanceId.replaceAll('-', '')}`,
    },
  });
  const onecli = createOnecliRuntimeLayout({
    instanceId,
    instanceRoot: paths.instanceRoot(instanceId),
    project: reserved.exclusive_resource_claims.onecli_project,
    appPort: reserved.allocated_ports.onecli_app,
    gatewayPort: reserved.allocated_ports.onecli_gateway,
    dockerEndpoint: 'unix:///var/run/docker.sock',
  });
  await persistInstanceRuntime(
    createInstanceRuntimeConfig(paths, reserved, onecli, {
      nodePath: process.execPath,
      homeDirectory: path.dirname(paths.stateRoot),
      selectedProvider: 'claude',
      dockerEndpoint: 'unix:///var/run/docker.sock',
    }),
    () => undefined,
  );
  const cohort = record.onecli ?? { gateway: ONECLI_GATEWAY_VERSION, sdk: ONECLI_SDK_VERSION };
  const receipt = paths.releasePreflightFile(instanceId, release.deployed_commit);
  await mkdir(path.dirname(receipt), { recursive: true, mode: 0o700 });
  await writeFile(
    receipt,
    `${JSON.stringify({
      schema_version: 1,
      instance_id: instanceId,
      deployed_commit: release.deployed_commit,
      provider: 'claude',
      providerCredential: record.providerCredential ?? CREDENTIAL,
      packageManager: 'pnpm@10.34.5',
      onecli: cohort,
    })}\n`,
    { mode: 0o600 },
  );
  await mkdir(onecli.rootDirectory, { recursive: true, mode: 0o700 });
  const compose = renderOnecliCompose(onecli, cohort, wrapperImageTag('0'.repeat(16)));
  await writeFile(
    onecli.composeFile,
    record.postgresImage ? compose.replaceAll(ONECLI_POSTGRES_IMAGE, record.postgresImage) : compose,
    { mode: 0o600 },
  );
  return reserved;
}

function toolProviderSetup(credential: ProviderCredentialMetadata = CREDENTIAL): ToolProviderSetup {
  return {
    credentialMetadata: (provider) => (provider === 'claude' ? credential : undefined),
  };
}

/** A runner that records each Git subcommand, so a test can tell whether the track was fetched. */
function recordingRunner(subcommands: string[]): SanitizedCommandRunner {
  return async (spec) => {
    subcommands.push(spec.args.find((argument) => !argument.startsWith('-')) ?? '');
    return runSanitizedCommand(spec);
  };
}

describe('the release create and update deploy', () => {
  it("deploys the tool's own commit, whether the tool is at the track tip or behind it", async () => {
    const dogfood = await releaseRepository(TRACK_BRANCH);
    const tool = await toolClone(dogfood.remote);

    await expect(
      resolveReleaseTarget({ track: 'dogfood', source: trackSource(dogfood.remote) }, { toolRoot: tool }),
    ).resolves.toEqual({
      release: { source_remote: dogfood.remote, release_track: 'dogfood', deployed_commit: dogfood.first },
    });

    const tip = await push(dogfood, 'second.txt');
    expect(tip).not.toBe(dogfood.first);
    await expect(
      resolveReleaseTarget({ track: 'dogfood', source: trackSource(dogfood.remote) }, { toolRoot: tool }),
    ).resolves.toEqual({
      release: { source_remote: dogfood.remote, release_track: 'dogfood', deployed_commit: dogfood.first },
    });
  });

  it('refuses a tool whose commit is not on the track, naming the track, even when the remote has it on another branch', async () => {
    const dogfood = await releaseRepository(TRACK_BRANCH);
    const side = await push(dogfood, 'side.txt', 'side');
    const tool = await toolClone(dogfood.remote, side);

    await expect(
      resolveReleaseTarget({ track: 'dogfood', source: trackSource(dogfood.remote) }, { toolRoot: tool }),
    ).rejects.toMatchObject({
      code: 'release_not_on_track',
      message: expect.stringContaining('release track dogfood'),
      details: { track: 'dogfood', commit: side },
    });
  });

  it('refuses a commit off the track even where Git fetches it on demand, as Git before 2.44 does', async () => {
    const dogfood = await releaseRepository(TRACK_BRANCH);
    const side = await push(dogfood, 'side.txt', 'side');
    const tool = await toolClone(dogfood.remote, side);
    // Older Git ignores GIT_NO_LAZY_FETCH: the blob-less history fetches the side commit when asked about it,
    // so only its ancestry keeps it off the track.
    const olderGit: SanitizedCommandRunner = async (spec) => {
      const env = { ...spec.env };
      delete env.GIT_NO_LAZY_FETCH;
      return runSanitizedCommand({ ...spec, env });
    };

    await expect(
      resolveReleaseTarget(
        { track: 'dogfood', source: trackSource(dogfood.remote) },
        { toolRoot: tool, runCommand: olderGit },
      ),
    ).rejects.toMatchObject({ code: 'release_not_on_track', details: { track: 'dogfood', commit: side } });
  });

  it('refuses a tool checkout with tracked changes, naming the files, before fetching the track', async () => {
    const dogfood = await releaseRepository(TRACK_BRANCH);
    const tool = await toolClone(dogfood.remote);
    await writeFile(path.join(tool, 'release.txt'), 'edited\n');
    await writeFile(path.join(tool, 'notes.txt'), 'untracked notes are not part of the release\n');
    const subcommands: string[] = [];

    const refusal = resolveReleaseTarget(
      { track: 'dogfood', source: trackSource(dogfood.remote) },
      { toolRoot: tool, runCommand: recordingRunner(subcommands) },
    );

    await expect(refusal).rejects.toMatchObject({
      code: 'tool_checkout_modified',
      message: expect.stringContaining('release.txt'),
      details: { files: ['release.txt'] },
    });
    await expect(refusal).rejects.toSatisfy((error: Error) => !error.message.includes('notes.txt'));
    expect(subcommands).not.toContain('fetch');
  });

  it('refuses a tool that does not run from a Git checkout', async () => {
    const dogfood = await releaseRepository(TRACK_BRANCH);
    const unpacked = await temporaryRoot('gws-ea-unpacked-tool-');

    await expect(
      resolveReleaseTarget({ track: 'dogfood', source: trackSource(dogfood.remote) }, { toolRoot: unpacked }),
    ).rejects.toMatchObject({ code: 'tool_checkout_unknown' });
  });
});

describe('the release an update deploys', () => {
  it("moves an assistant forward to the tool's commit and carries its provider setup to the staged preflight", async () => {
    const paths = await controlPlanePaths();
    const dogfood = await releaseRepository(TRACK_BRANCH);
    const assistant = await deployedAssistant(paths, {
      source_remote: dogfood.remote,
      release_track: 'dogfood',
      deployed_commit: dogfood.first,
    });
    const next = await push(dogfood, 'next.txt');
    const tool = await toolClone(dogfood.remote);

    await expect(
      resolveReleaseTarget(
        {
          track: 'dogfood',
          source: trackSource(dogfood.remote),
          update: { paths, reservation: assistant, providerSetup: toolProviderSetup() },
        },
        { toolRoot: tool },
      ),
    ).resolves.toEqual({
      release: { source_remote: dogfood.remote, release_track: 'dogfood', deployed_commit: next },
      preflight: { provider: 'claude', providerCredential: CREDENTIAL },
    });
  });

  it('moves an assistant to a prod repository whose history contains its deployed commit (AE1)', async () => {
    const paths = await controlPlanePaths();
    const dogfood = await releaseRepository(TRACK_BRANCH);
    const prod = await releaseRepository('main', dogfood);
    const assistant = await deployedAssistant(paths, {
      source_remote: dogfood.remote,
      release_track: 'dogfood',
      deployed_commit: dogfood.first,
    });
    const tool = await toolClone(prod.remote);

    const target = await resolveReleaseTarget(
      {
        track: 'prod',
        source: trackSource(prod.remote, 'main'),
        update: { paths, reservation: assistant, providerSetup: toolProviderSetup() },
      },
      { toolRoot: tool },
    );

    expect(target.release).toEqual({ source_remote: prod.remote, release_track: 'prod', deployed_commit: prod.first });
  });

  it.each([
    ['a newer commit than the tool', 'newer'],
    ['a history the track does not contain', 'unrelated'],
  ] as const)('refuses an update from %s, pointing to rollback', async (_label, deployed) => {
    const paths = await controlPlanePaths();
    const dogfood = await releaseRepository(TRACK_BRANCH);
    const tool = await toolClone(dogfood.remote);
    const other = deployed === 'unrelated' ? await releaseRepository(TRACK_BRANCH) : dogfood;
    const deployedCommit = deployed === 'newer' ? await push(dogfood, 'newer.txt') : other.first;
    const assistant = await deployedAssistant(paths, {
      source_remote: other.remote,
      release_track: 'dogfood',
      deployed_commit: deployedCommit,
    });

    await expect(
      resolveReleaseTarget(
        {
          track: 'dogfood',
          source: trackSource(dogfood.remote),
          update: { paths, reservation: assistant, providerSetup: toolProviderSetup() },
        },
        { toolRoot: tool },
      ),
    ).rejects.toMatchObject({
      code: 'release_not_newer',
      message: expect.stringContaining(`gws-ea rollback --id ${assistant.instance_id}`),
      details: { deployed: deployedCommit, release: dogfood.first },
    });
  });

  it('refuses an update to the release the assistant already runs', async () => {
    const paths = await controlPlanePaths();
    const dogfood = await releaseRepository(TRACK_BRANCH);
    const tool = await toolClone(dogfood.remote);
    const assistant = await deployedAssistant(paths, {
      source_remote: dogfood.remote,
      release_track: 'dogfood',
      deployed_commit: dogfood.first,
    });

    await expect(
      resolveReleaseTarget(
        {
          track: 'dogfood',
          source: trackSource(dogfood.remote),
          update: { paths, reservation: assistant, providerSetup: toolProviderSetup() },
        },
        { toolRoot: tool },
      ),
    ).rejects.toMatchObject({ code: 'release_not_newer', message: expect.stringContaining('nothing to update') });
  });

  it.each([
    [
      'OneCLI gateway',
      { onecli: { gateway: '1.41.0', sdk: ONECLI_SDK_VERSION } },
      CREDENTIAL,
      'onecli_version_changed',
    ],
    ['Postgres image', { postgresImage: 'postgres:17-alpine' }, CREDENTIAL, 'postgres_version_changed'],
    [
      "provider's credential metadata",
      {},
      { ...CREDENTIAL, hostPattern: 'api.example.test' },
      'provider_setup_changed',
    ],
  ] as const)(
    "refuses a release that changes the assistant's %s before fetching the track",
    async (_label, record, toolCredential, code) => {
      const paths = await controlPlanePaths();
      const dogfood = await releaseRepository(TRACK_BRANCH);
      const assistant = await deployedAssistant(
        paths,
        { source_remote: dogfood.remote, release_track: 'dogfood', deployed_commit: dogfood.first },
        record,
      );
      await push(dogfood, 'next.txt');
      const tool = await toolClone(dogfood.remote);
      const subcommands: string[] = [];

      await expect(
        resolveReleaseTarget(
          {
            track: 'dogfood',
            source: trackSource(dogfood.remote),
            update: { paths, reservation: assistant, providerSetup: toolProviderSetup(toolCredential) },
          },
          { toolRoot: tool, runCommand: recordingRunner(subcommands) },
        ),
      ).rejects.toMatchObject({ code });
      expect(subcommands).not.toContain('fetch');
    },
  );
});
