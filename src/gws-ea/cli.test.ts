import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runCli, type CliRuntime, type FailureReport } from './cli.js';
import type { CreatePromptContext } from './create-input.js';
import { runStep, withPendingAction, type Interaction } from './events.js';
import { acquireInstanceOperation } from './journal.js';
import { resolveControlPlanePaths, type ControlPlanePaths } from './paths.js';
import { ONECLI_CLI_VERSION } from './onecli-compose.js';
import type { ProvisionHumanPause } from './phases.js';
import {
  checkPrerequisites,
  type PrerequisiteDependencies,
  type PrerequisiteRequest,
  type Prerequisites,
} from './prerequisites.js';
import { runSanitizedCommand } from './process.js';
import { allocateInstanceId, readRegistry, reserveInstance } from './registry.js';
import { DOGFOOD_SOURCE_FILE, GWS_EA_RELEASE_REMOTE } from './release-tracks.js';
import { activeStep } from './run-log.js';
import { GwsEaError, type InstanceReservationInput } from './types.js';

const roots: string[] = [];
const servers: Server[] = [];

function neverCalled(): never {
  throw new Error('process.execve is only called by the service launcher');
}
const PRIVATE_REMOTE = 'git@github.com:example/nanoclaw-gws-ea-private.git';

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function testPaths(): Promise<ControlPlanePaths> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gws-ea-cli-'));
  roots.push(root);
  const paths = resolveControlPlanePaths({
    configRoot: path.join(root, 'config'),
    stateRoot: path.join(root, 'state'),
  });
  await mkdir(paths.configRoot, { recursive: true, mode: 0o700 });
  return paths;
}

function reservation(paths: ControlPlanePaths, instanceId = allocateInstanceId()): InstanceReservationInput {
  return {
    instance_id: instanceId,
    checkout_realpath: paths.checkoutRoot(instanceId),
    release_track: 'dogfood',
    source_remote: PRIVATE_REMOTE,
    deployed_commit: 'a'.repeat(40),
    allocated_ports: { nanoclaw_webhook: 31_001, onecli_app: 31_002, onecli_gateway: 31_003 },
    exclusive_resource_claims: {
      ingress: { mode: 'existing', endpoint_url: 'https://assistant.example.test/webhook/gchat' },
      gcp_project_id: 'assistant-project',
      gcp_account: 'operator@example.test',
      gchat_service_account: 'gws-ea-chat@assistant-project.iam.gserviceaccount.com',
      workspace_email: 'assistant@example.test',
      onecli_project: `gws-ea-${instanceId.replaceAll('-', '')}`,
    },
  };
}

function setupAnswers() {
  return {
    ingress: { mode: 'existing', endpointUrl: 'https://assistant.example.test/webhook/gchat' },
    assistantWorkspaceEmail: 'assistant@example.test',
    bootstrapManifest: {
      schema_version: 1,
      onecli_cli_path: '/usr/local/bin/onecli',
      node_path: process.execPath,
      home_directory: '/Users/operator',
      platform: process.platform === 'darwin' ? 'macos' : 'linux',
      running_as_root: false,
      provider_capability_digest: 'd'.repeat(64),
      provider: {
        id: 'claude',
        name: 'Anthropic',
        type: 'anthropic',
        host_pattern: 'api.anthropic.com',
        header_name: null,
        value_format: null,
        path_pattern: null,
        param_name: null,
        param_format: null,
      },
      identity: {
        assistant_display_name: 'Aya',
        principal_display_name: 'Principal',
        principal_timezone: 'America/Los_Angeles',
      },
      selected_messaging_group_id: null,
    },
  } as const;
}

const PREREQUISITES: Prerequisites = {
  platform: process.platform === 'darwin' ? 'macos' : 'linux',
  homeDirectory: '/Users/operator',
  runningAsRoot: false,
  nodePath: process.execPath,
  onecliCliPath: '/usr/local/bin/onecli',
  dockerEndpoint: 'unix:///var/run/docker.sock',
  account: 'operator@example.test',
};

function createRuntime(): Partial<CliRuntime> {
  return {
    collectCreateInputs: async () => setupAnswers(),
    checkPrerequisites: async () => PREREQUISITES,
    resolveRelease: async (sourceRemote, releaseRef) => ({ sourceRemote, releaseRef, commit: 'b'.repeat(40) }),
    holdLoopbackPorts: async () => ({
      ports: { nanoclaw_webhook: 34_101, onecli_app: 34_102, onecli_gateway: 34_103 },
      release: async () => undefined,
    }),
  };
}

const DM_PAUSE: ProvisionHumanPause = {
  kind: 'human-action',
  phase: 'bind_principal',
  code: 'principal_dm_required',
  message: 'Ask the principal to send a direct message to the configured Google Chat app, then resume.',
};

async function writeOwnerFile(file: string, contents: string, mode = 0o600): Promise<void> {
  await writeFile(file, contents, { mode });
  await chmod(file, mode);
}

async function filesUnder(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) found.push(path.join(entry.parentPath, entry.name));
  }
  return found;
}

function lines(): { readonly out: string[]; readonly err: string[]; readonly runtime: Partial<CliRuntime> } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, runtime: { stdout: (line) => out.push(line), stderr: (line) => err.push(line) } };
}

describe('gws-ea stop summaries and exit codes', () => {
  it('prints the failing step, cause, next action, log paths, and redacted tail, then exits 1', async () => {
    const paths = await testPaths();
    const input = await reserveInstance(paths, reservation(paths));
    const secret = `sk-ant-api03-${'q'.repeat(24)}`;
    const io = lines();

    const exitCode = await runCli(['resume', '--id', input.instance_id], {
      paths,
      ...io.runtime,
      checkPrerequisites: async () => PREREQUISITES,
      advanceProvision: async (_operation, { runtime }) =>
        runStep(runtime, { id: 'provision_gcp', label: 'Configuring Google Cloud…' }, () =>
          runSanitizedCommand({
            command: process.execPath,
            args: ['-e', `process.stderr.write('first\\nkey ${secret}\\nlast line\\n'); process.exit(2)`],
            cwd: os.tmpdir(),
          }).then(() => ({ status: 'ready' as const })),
        ),
    });

    expect(exitCode).toBe(1);
    const summary = io.err.join('\n');
    expect(summary).toContain('provision_gcp');
    expect(summary).toContain('Command failed (exit code 2)');
    expect(summary).toContain('Exit: code 2');
    expect(summary).toContain(`Resume with: gws-ea resume --id ${input.instance_id}`);
    expect(summary).toContain('last line');
    expect(summary).not.toContain(secret);
    const progressLog = /Log: (\S+)/u.exec(summary)?.[1];
    const rawLog = /Step log: (\S+)/u.exec(summary)?.[1];
    expect(progressLog).toBeDefined();
    expect(rawLog).toMatch(/provision-gcp\.log$/u);
    expect(await readFile(progressLog!, 'utf8')).toContain('aborted at provision_gcp (err=command_failed)');
    expect(await readFile(rawLog!, 'utf8')).not.toContain(secret);
    expect(path.relative(paths.instanceLogsRoot(input.instance_id), progressLog!).startsWith('..')).toBe(false);
  });

  it('exits 10 on a pause, naming the human action and the resume command', async () => {
    const paths = await testPaths();
    const input = await reserveInstance(paths, reservation(paths));
    const io = lines();

    expect(
      await runCli(['resume', '--id', input.instance_id], {
        paths,
        ...io.runtime,
        checkPrerequisites: async () => PREREQUISITES,
        advanceProvision: async () => ({ status: 'paused', pause: DM_PAUSE }),
      }),
    ).toBe(10);
    expect(io.out).toContain(`Paused at bind_principal: ${DM_PAUSE.message}`);
    expect(io.out).toContain(`Continue with: gws-ea resume --id ${input.instance_id}`);
    expect(io.out.at(-1)).toMatch(/^Log: \S+progress\.log$/u);
  });

  it('exits 75 without advancing while another operation holds the instance lock', async () => {
    const paths = await testPaths();
    const input = await reserveInstance(paths, reservation(paths));
    const held = await acquireInstanceOperation(paths, input.instance_id);
    const advanceProvision = vi.fn();
    const io = lines();
    try {
      expect(
        await runCli(['resume', '--id', input.instance_id], {
          paths,
          ...io.runtime,
          checkPrerequisites: async () => PREREQUISITES,
          advanceProvision,
        }),
      ).toBe(75);
    } finally {
      held?.release();
    }
    expect(advanceProvision).not.toHaveBeenCalled();
    expect(io.err.join('\n')).toMatch(/already in progress/u);
  });

  it('still prints a pending human action when a failure blocks it', async () => {
    const paths = await testPaths();
    const input = await reserveInstance(paths, reservation(paths));
    const io = lines();

    expect(
      await runCli(['resume', '--id', input.instance_id], {
        paths,
        ...io.runtime,
        checkPrerequisites: async () => PREREQUISITES,
        advanceProvision: async () => {
          throw withPendingAction(new GwsEaError('nanoclaw_not_ready', 'NanoClaw did not become ready'), DM_PAUSE);
        },
      }),
    ).toBe(1);
    const summary = io.err.join('\n');
    expect(summary).toContain('NanoClaw did not become ready');
    expect(summary).toContain(`Pending human action: ${DM_PAUSE.message}`);
  });

  it('never prints an unexpected error message, which may carry a secret', async () => {
    const paths = await testPaths();
    const input = await reserveInstance(paths, reservation(paths));
    const io = lines();

    expect(
      await runCli(['resume', '--id', input.instance_id], {
        paths,
        ...io.runtime,
        checkPrerequisites: async () => PREREQUISITES,
        advanceProvision: async () => {
          throw new Error('secret-canary-must-not-print');
        },
      }),
    ).toBe(1);
    expect(io.err.join('\n')).toContain('Unexpected control-plane failure.');
    expect(`${io.out.join('\n')}${io.err.join('\n')}`).not.toContain('secret-canary-must-not-print');
  });
});

describe('gws-ea without a TTY', () => {
  it('pauses with exit 10 naming the variable when a provider credential is needed mid-run', async () => {
    const paths = await testPaths();
    const input = await reserveInstance(paths, reservation(paths));
    const io = lines();

    expect(
      await runCli(['resume', '--id', input.instance_id], {
        paths,
        ...io.runtime,
        environment: {},
        checkPrerequisites: async () => PREREQUISITES,
        advanceProvision: async (_operation, { interaction }) => {
          await interaction.requestProviderCredential({
            providerId: 'claude',
            metadata: { name: 'Anthropic', type: 'anthropic', hostPattern: 'api.anthropic.com' },
          });
          return { status: 'ready' };
        },
      }),
    ).toBe(10);
    expect(io.out.join('\n')).toContain('GWS_EA_PROVIDER_CREDENTIAL');
    expect(io.out).toContain(`Continue with: gws-ea resume --id ${input.instance_id}`);
  });

  it('names the step an input pause stopped at and logs it as paused, not failed', async () => {
    const paths = await testPaths();
    const input = await reserveInstance(paths, reservation(paths));
    const io = lines();

    expect(
      await runCli(['resume', '--id', input.instance_id], {
        paths,
        ...io.runtime,
        environment: {},
        checkPrerequisites: async () => PREREQUISITES,
        advanceProvision: async (_operation, { interaction, runtime }) =>
          runStep(runtime, { id: 'configure_provider', label: 'Connecting the AI provider…' }, async () => {
            await interaction.requestProviderCredential({
              providerId: 'claude',
              metadata: { name: 'Anthropic', type: 'anthropic', hostPattern: 'api.anthropic.com' },
            });
            return { status: 'ready' as const };
          }),
      }),
    ).toBe(10);
    expect(io.out.join('\n')).toContain('Paused at configure_provider:');
    const progressLog = /Log: (\S+)/u.exec(io.out.join('\n'))?.[1];
    const progress = await readFile(progressLog!, 'utf8');
    expect(progress).toMatch(/configure_provider \[\S+\] → paused/u);
    expect(progress).not.toContain('→ failed');
    expect(progress).toContain('paused at configure_provider (input_required)');
  });

  it('refuses an instance from an earlier gws-ea before asking for sign-in', async () => {
    const paths = await testPaths();
    const input = await reserveInstance(paths, reservation(paths));
    await writeFile(
      paths.journalFile(input.instance_id),
      JSON.stringify({ schema_version: 1, instance_id: input.instance_id, phases: {} }),
      { mode: 0o600 },
    );
    const preflight = vi.fn(async () => PREREQUISITES);
    const advanceProvision = vi.fn();
    const io = lines();

    expect(
      await runCli(['resume', '--id', input.instance_id], {
        paths,
        ...io.runtime,
        checkPrerequisites: preflight,
        advanceProvision,
      }),
    ).toBe(1);
    expect(io.err.join('\n')).toContain(`gws-ea remove --id ${input.instance_id}, then create it again`);
    expect(preflight).not.toHaveBeenCalled();
    expect(advanceProvision).not.toHaveBeenCalled();
  });

  it('pauses with exit 10 naming the variable when a Cloudflare token is needed mid-run', async () => {
    const paths = await testPaths();
    const input = await reserveInstance(paths, reservation(paths));
    const io = lines();

    expect(
      await runCli(['resume', '--id', input.instance_id], {
        paths,
        ...io.runtime,
        environment: {},
        checkPrerequisites: async () => PREREQUISITES,
        advanceProvision: async (_operation, { interaction }) => {
          await interaction.requestCloudflareAccountToken({ accountId: 'a'.repeat(32), reason: 'Listener drifted' });
          return { status: 'ready' };
        },
      }),
    ).toBe(10);
    expect(io.out.join('\n')).toContain('GWS_EA_CLOUDFLARE_API_TOKEN');
  });

  it('refuses removal without --yes, naming the flag', async () => {
    const paths = await testPaths();
    const input = await reserveInstance(paths, reservation(paths));
    const remove = vi.fn();
    const io = lines();

    expect(await runCli(['remove', '--id', input.instance_id], { paths, ...io.runtime, removeAssistant: remove })).toBe(
      1,
    );
    expect(io.err.join('\n')).toContain('--yes');
    expect(remove).not.toHaveBeenCalled();
  });

  it('prints durable, deduplicated progress lines', async () => {
    const paths = await testPaths();
    const input = await reserveInstance(paths, reservation(paths));
    const io = lines();

    await runCli(['resume', '--id', input.instance_id], {
      paths,
      ...io.runtime,
      checkPrerequisites: async () => PREREQUISITES,
      advanceProvision: async (_operation, { runtime }) =>
        runStep(runtime, { id: 'provision_gcp', label: 'Configuring Google Cloud…' }, async () => {
          runtime.emit?.({ type: 'step-waiting', step: 'provision_gcp', reason: 'Waiting for the service account…' });
          runtime.emit?.({ type: 'step-waiting', step: 'provision_gcp', reason: 'Waiting for the service account…' });
          return { status: 'paused' as const, pause: DM_PAUSE };
        }),
    });

    expect(io.out.slice(0, 2)).toEqual(['Configuring Google Cloud…', 'Waiting for the service account…']);
  });
});

describe('gws-ea secrets inputs', () => {
  it('refuses a secrets file outside the config root', async () => {
    const paths = await testPaths();
    const input = await reserveInstance(paths, reservation(paths));
    const outside = path.join(path.dirname(paths.configRoot), 'secrets.env');
    await writeOwnerFile(outside, 'GWS_EA_PROVIDER_CREDENTIAL=sk-ant-api03-outside\n');
    const advanceProvision = vi.fn();
    const io = lines();

    expect(
      await runCli(['resume', '--id', input.instance_id, '--secrets-file', outside], {
        paths,
        ...io.runtime,
        advanceProvision,
      }),
    ).toBe(1);
    expect(io.err.join('\n')).toContain(paths.configRoot);
    expect(advanceProvision).not.toHaveBeenCalled();
  });

  it('refuses a secrets file readable by others', async () => {
    const paths = await testPaths();
    const input = await reserveInstance(paths, reservation(paths));
    const file = path.join(paths.configRoot, 'secrets.env');
    await writeOwnerFile(file, 'GWS_EA_PROVIDER_CREDENTIAL=sk-ant-api03-loose\n', 0o644);
    const io = lines();

    expect(
      await runCli(['resume', '--id', input.instance_id, '--secrets-file', file], {
        paths,
        ...io.runtime,
        advanceProvision: vi.fn(),
      }),
    ).toBe(1);
    expect(io.err.join('\n')).toMatch(/0600/u);
  });

  it('uses supplied secrets without persisting them to the registry, journal, or logs', async () => {
    const paths = await testPaths();
    const providerSecret = `sk-ant-api03-${'p'.repeat(40)}`;
    const cloudflareSecret = `cf-token-${'c'.repeat(40)}`;
    const secretsFile = path.join(paths.configRoot, 'secrets.env');
    await writeOwnerFile(secretsFile, `GWS_EA_PROVIDER_CREDENTIAL=${providerSecret}\n`);
    const accountId = 'a'.repeat(32);
    const managedIngressSetup = {
      discoverZones: vi.fn(async () => [
        { accountId, accountName: 'Example', zoneId: 'b'.repeat(32), name: 'example.com', status: 'active' as const },
      ]),
      retainAccountToken: vi.fn(),
      requireAccountToken: vi.fn(() => cloudflareSecret),
      clearAccountToken: vi.fn(),
    };
    let collectedToken: string | undefined;
    const io = lines();

    const exitCode = await runCli(
      ['create', '--track', 'dogfood', '--source-remote', PRIVATE_REMOTE, '--secrets-file', secretsFile],
      {
        paths,
        ...io.runtime,
        ...createRuntime(),
        environment: { GWS_EA_CLOUDFLARE_API_TOKEN: cloudflareSecret },
        managedIngressSetup,
        collectCreateInputs: async (context) => {
          collectedToken = context.secrets.get('cloudflareAccountToken');
          return setupAnswers();
        },
        advanceProvision: async (_operation, { interaction, runtime }) =>
          runStep(runtime, { id: 'configure_provider' }, async () => {
            const credential = await interaction.requestProviderCredential({
              providerId: 'claude',
              metadata: { name: 'Anthropic', type: 'anthropic', hostPattern: 'api.anthropic.com' },
            });
            const token = await interaction.requestCloudflareAccountToken({ accountId, reason: 'Repair' });
            activeStep()?.write(`accidentally logged ${credential.value} and ${token}\n`);
            return { status: 'paused' as const, pause: DM_PAUSE };
          }),
      },
    );

    expect(exitCode).toBe(10);
    expect(collectedToken).toBe(cloudflareSecret);
    expect(managedIngressSetup.discoverZones).toHaveBeenCalledWith(cloudflareSecret);
    const persisted = [...(await filesUnder(paths.stateRoot)), ...(await filesUnder(paths.configRoot))].filter(
      (file) => file !== secretsFile,
    );
    expect(persisted.some((file) => file.endsWith('progress.log'))).toBe(true);
    for (const file of persisted) {
      const contents = await readFile(file, 'utf8');
      expect(contents, file).not.toContain(providerSecret);
      expect(contents, file).not.toContain(cloudflareSecret);
    }
  });
});

describe('gws-ea release sources', () => {
  it('resolves dogfood from the owner-only source file and never asks for or resolves the public repo', async () => {
    const paths = await testPaths();
    await writeOwnerFile(path.join(paths.configRoot, DOGFOOD_SOURCE_FILE), `${PRIVATE_REMOTE}\n`);
    const resolved: string[] = [];
    const contexts: unknown[] = [];
    const io = lines();

    expect(
      await runCli(['create', '--track', 'dogfood'], {
        paths,
        ...io.runtime,
        ...createRuntime(),
        collectCreateInputs: async (context) => {
          contexts.push(context);
          return setupAnswers();
        },
        resolveRelease: async (sourceRemote, releaseRef) => {
          resolved.push(sourceRemote);
          return { sourceRemote, releaseRef, commit: 'b'.repeat(40) };
        },
        advanceProvision: async () => ({ status: 'paused', pause: DM_PAUSE }),
      }),
    ).toBe(10);
    expect(resolved).toEqual([PRIVATE_REMOTE]);
    expect(contexts).toEqual([expect.objectContaining({ sourceRemote: PRIVATE_REMOTE, provided: {} })]);
    const registry = await readRegistry(paths);
    expect(Object.values(registry.instances).map((instance) => instance.source_remote)).toEqual([PRIVATE_REMOTE]);
  });

  it('refuses a dogfood source file naming the public origin', async () => {
    const paths = await testPaths();
    await writeOwnerFile(path.join(paths.configRoot, DOGFOOD_SOURCE_FILE), 'git@github.com:taslim/nanoclaw-gws-ea\n');
    const collectCreateInputs = vi.fn();
    const resolveRelease = vi.fn();
    const io = lines();

    expect(
      await runCli(['create', '--track', 'dogfood'], {
        paths,
        ...io.runtime,
        ...createRuntime(),
        collectCreateInputs,
        resolveRelease,
      }),
    ).toBe(1);
    expect(io.err.join('\n')).toContain('public');
    expect(collectCreateInputs).not.toHaveBeenCalled();
    expect(resolveRelease).not.toHaveBeenCalled();
  });

  it('fails dogfood create without a source file or --source-remote, naming both', async () => {
    const paths = await testPaths();
    const io = lines();

    expect(await runCli(['create', '--track', 'dogfood'], { paths, ...io.runtime, ...createRuntime() })).toBe(1);
    const summary = io.err.join('\n');
    expect(summary).toContain('--source-remote');
    expect(summary).toContain(path.join(paths.configRoot, DOGFOOD_SOURCE_FILE));
    expect(io.out).toEqual([]);
  });

  it('maps only prod to the public repository', async () => {
    const paths = await testPaths();
    const resolved: string[] = [];
    const io = lines();

    expect(
      await runCli(['create', '--track', 'prod'], {
        paths,
        ...io.runtime,
        ...createRuntime(),
        resolveRelease: async (sourceRemote, releaseRef) => {
          resolved.push(sourceRemote);
          return { sourceRemote, releaseRef, commit: 'b'.repeat(40) };
        },
        advanceProvision: async () => ({ status: 'ready' }),
      }),
    ).toBe(0);
    expect(resolved).toEqual([GWS_EA_RELEASE_REMOTE]);
    expect(await runCli(['create', '--track', 'canary'], { paths, ...createRuntime(), ...lines().runtime })).toBe(1);
  });
});

/**
 * A stubbed host for the real prerequisite checks: Docker at `dockerHost`,
 * gcloud signed in as `active`, and `expired` accounts that must sign in again.
 */
function hostDependencies(
  dockerHost: string,
  active = 'operator@example.test',
  expired: ReadonlySet<string> = new Set(),
): PrerequisiteDependencies {
  return {
    runCommand: async (command) => {
      const signature = [path.basename(command.command), ...command.args].join(' ');
      const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0 });
      if (signature === 'docker context inspect') {
        return ok(JSON.stringify([{ Name: 'default', Endpoints: { docker: { Host: dockerHost } } }]));
      }
      if (signature === 'onecli version') return ok(JSON.stringify({ version: ONECLI_CLI_VERSION }));
      if (signature.startsWith('gcloud auth list ')) return ok(`${active}\n`);
      if (signature.startsWith('gcloud auth print-access-token ')) {
        return [...expired].some((account) => signature.includes(`--account=${account} `))
          ? { stdout: '', stderr: 'ERROR: (gcloud.auth.print-access-token) Reauthentication required.', exitCode: 1 }
          : ok('ya29.discard-me');
      }
      return ok();
    },
    resolvePersisted: async (command) => (command === 'onecli' ? '/usr/local/bin/onecli' : process.execPath),
    node: { version: 'v22.20.0', execPath: process.execPath, execve: neverCalled },
    platform: 'linux',
  };
}

async function runningDocker(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gws-ea-docker-'));
  roots.push(directory);
  const socket = path.join(directory, 'docker.sock');
  const server = createServer((_request, response) => response.writeHead(200).end('OK'));
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  servers.push(server);
  return `unix://${socket}`;
}

describe('gws-ea prerequisites', () => {
  it.each([
    ['Docker is stopped', 'unix:///nonexistent/gws-ea/docker.sock', 'docker_stopped', /not running.*Start Docker/su],
    [
      'the Docker context is remote',
      'tcp://192.0.2.10:2376',
      'docker_remote',
      /tcp:\/\/192\.0\.2\.10:2376.*unix:\/\//su,
    ],
  ])('stops create before reservation when %s, with guidance', async (_case, dockerHost, code, guidance) => {
    const paths = await testPaths();
    const collectCreateInputs = vi.fn();
    const io = lines();

    const exitCode = await runCli(['create', '--track', 'dogfood', '--source-remote', PRIVATE_REMOTE], {
      paths,
      ...io.runtime,
      ...createRuntime(),
      checkPrerequisites: (request, interaction) =>
        checkPrerequisites(request, interaction, hostDependencies(dockerHost)),
      collectCreateInputs,
    });

    expect(exitCode).toBe(1);
    const summary = io.err.join('\n');
    expect(summary).toMatch(guidance);
    expect(summary).toContain('Stopped at prerequisites:');
    expect(summary).toContain('Retry with: gws-ea create --track dogfood');
    expect(collectCreateInputs).not.toHaveBeenCalled();
    expect(io.out.some((line) => line.startsWith('instance_id:'))).toBe(false);
    expect(Object.keys((await readRegistry(paths)).instances)).toEqual([]);
    const progressLog = /Log: (\S+)/u.exec(summary)?.[1];
    expect(await readFile(progressLog!, 'utf8')).toContain(`aborted at prerequisites (err=${code})`);
  });

  it('refuses a consumer Google account before reservation', async () => {
    const paths = await testPaths();
    const io = lines();

    const exitCode = await runCli(['create', '--track', 'dogfood', '--source-remote', PRIVATE_REMOTE], {
      paths,
      ...io.runtime,
      ...createRuntime(),
      checkPrerequisites: async (request, interaction) =>
        checkPrerequisites(request, interaction, hostDependencies(await runningDocker(), 'operator@gmail.com')),
    });

    expect(exitCode).toBe(1);
    expect(io.err.join('\n')).toMatch(/operator@gmail\.com.*Google Workspace/su);
    expect(Object.keys((await readRegistry(paths)).instances)).toEqual([]);
  });

  it('names --google-account when no person can confirm the signed-in account', async () => {
    const paths = await testPaths();
    const io = lines();
    const args = ['create', '--track', 'dogfood', '--source-remote', PRIVATE_REMOTE];
    const dockerHost = await runningDocker();
    const runtime = {
      paths,
      ...io.runtime,
      ...createRuntime(),
      checkPrerequisites: (request: PrerequisiteRequest, interaction: Interaction) =>
        checkPrerequisites(request, interaction, hostDependencies(dockerHost)),
      advanceProvision: async () => ({ status: 'paused' as const, pause: DM_PAUSE }),
    };

    expect(await runCli(args, runtime)).toBe(1);
    expect(io.err.join('\n')).toContain('--google-account operator@example.test');
    expect(Object.keys((await readRegistry(paths)).instances)).toEqual([]);

    expect(await runCli([...args, '--google-account', 'operator@example.test'], runtime)).toBe(10);
    const [reserved] = Object.values((await readRegistry(paths)).instances);
    expect(reserved?.exclusive_resource_claims.gcp_account).toBe('operator@example.test');
  });

  it('hands create inputs the checked host and reserves the confirmed account', async () => {
    const paths = await testPaths();
    const requests: PrerequisiteRequest[] = [];
    const contexts: CreatePromptContext[] = [];
    const confirmed = { ...PREREQUISITES, account: 'owner@example.test' };

    expect(
      await runCli(
        ['create', '--track', 'dogfood', '--source-remote', PRIVATE_REMOTE, '--google-account', 'owner@example.test'],
        {
          paths,
          ...lines().runtime,
          ...createRuntime(),
          checkPrerequisites: async (request) => {
            requests.push(request);
            return confirmed;
          },
          collectCreateInputs: async (context) => {
            contexts.push(context);
            return setupAnswers();
          },
          advanceProvision: async () => ({ status: 'paused', pause: DM_PAUSE }),
        },
      ),
    ).toBe(10);

    expect(requests).toEqual([
      { command: 'create', instancesRoot: paths.instancesRoot, account: 'owner@example.test' },
    ]);
    expect(contexts[0]?.prerequisites).toBe(confirmed);
    const [reserved] = Object.values((await readRegistry(paths)).instances);
    expect(reserved?.exclusive_resource_claims.gcp_account).toBe('owner@example.test');
  });

  it('renews an expired sign-in through the browser flow, then continues the same resume', async () => {
    const paths = await testPaths();
    const input = await reserveInstance(paths, reservation(paths));
    const expired = new Set(['operator@example.test']);
    const dockerHost = await runningDocker();
    const googleCloudSignIn = vi.fn(async (account?: string) => void expired.delete(account ?? ''));
    const advanceProvision = vi.fn(async () => ({ status: 'ready' as const }));

    const exitCode = await runCli(['resume', '--id', input.instance_id], {
      paths,
      ...lines().runtime,
      prompts: {
        providerCredential: vi.fn(),
        cloudflareAccountToken: vi.fn(),
        googleCloudSignIn,
        googleAccount: vi.fn(),
      },
      checkPrerequisites: (request, interaction) =>
        checkPrerequisites(request, interaction, hostDependencies(dockerHost, 'someone@example.test', expired)),
      advanceProvision,
    });

    expect(exitCode).toBe(0);
    expect(googleCloudSignIn).toHaveBeenCalledExactlyOnceWith('operator@example.test');
    expect(advanceProvision).toHaveBeenCalledOnce();
  });

  it('checks the reserved account on resume', async () => {
    const paths = await testPaths();
    const input = await reserveInstance(paths, reservation(paths));
    const requests: PrerequisiteRequest[] = [];

    await runCli(['resume', '--id', input.instance_id], {
      paths,
      ...lines().runtime,
      checkPrerequisites: async (request) => {
        requests.push(request);
        return PREREQUISITES;
      },
      advanceProvision: async () => ({ status: 'paused', pause: DM_PAUSE }),
    });

    expect(requests).toEqual([
      { command: 'resume', instancesRoot: paths.instancesRoot, account: 'operator@example.test' },
    ]);
  });
});

describe('gws-ea interactive failure loop', () => {
  it('releases the lock before the failure hook, then retries through prerequisites and resume', async () => {
    const paths = await testPaths();
    const input = await reserveInstance(paths, reservation(paths));
    const preflight = vi.fn(async () => PREREQUISITES);
    const reports: FailureReport[] = [];
    let lockFree = false;
    let attempts = 0;
    const io = lines();

    const exitCode = await runCli(['resume', '--id', input.instance_id], {
      paths,
      ...io.runtime,
      checkPrerequisites: preflight,
      advanceProvision: async (_operation, { runtime }) =>
        runStep(runtime, { id: 'start_onecli', label: 'Starting the credential vault…' }, async () => {
          attempts += 1;
          if (attempts === 1) throw new GwsEaError('onecli_unhealthy', 'OneCLI did not become healthy');
          return { status: 'ready' as const };
        }),
      onFailure: async (report) => {
        reports.push(report);
        const probe = await acquireInstanceOperation(paths, input.instance_id);
        lockFree = probe !== null;
        probe?.release();
        return 'retry';
      },
    });

    expect(exitCode).toBe(0);
    expect(lockFree).toBe(true);
    expect(preflight).toHaveBeenCalledTimes(2);
    expect(attempts).toBe(2);
    expect(reports).toEqual([
      expect.objectContaining({
        step: 'start_onecli',
        cause: 'OneCLI did not become healthy',
        instanceId: input.instance_id,
      }),
    ]);
    expect((await stat(reports[0]!.progressLog)).isFile()).toBe(true);
    expect(reports[0]!.rawLog).toMatch(/start-onecli\.log$/u);
  });

  it('stops with exit 1 when the operator declines the retry', async () => {
    const paths = await testPaths();
    const input = await reserveInstance(paths, reservation(paths));
    const advanceProvision = vi.fn(async () => {
      throw new GwsEaError('onecli_unhealthy', 'OneCLI did not become healthy');
    });

    expect(
      await runCli(['resume', '--id', input.instance_id], {
        paths,
        ...lines().runtime,
        checkPrerequisites: async () => PREREQUISITES,
        advanceProvision,
        onFailure: async () => 'stop',
      }),
    ).toBe(1);
    expect(advanceProvision).toHaveBeenCalledOnce();
  });
});
