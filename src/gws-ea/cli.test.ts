import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runCli, type CliRuntime, type FailureReport } from './cli.js';
import type { CreatePromptContext } from './create-input.js';
import { runStep, withPendingAction, type InteractivePrompts, type PauseResponse } from './events.js';
import { RECORDED_GCLOUD_REAUTHENTICATION_FAILED } from './fixtures/recordings.js';
import { acquireInstanceOperation, reserveInstance } from './journal.js';
import { resolveControlPlanePaths, type ControlPlanePaths } from './paths.js';
import { ONECLI_CLI_VERSION } from './pins.js';
import type { ProvisionHumanPause } from './phases.js';
import {
  checkPrerequisites,
  type PrerequisiteDependencies,
  type PrerequisiteRequest,
  type Prerequisites,
} from './prerequisites.js';
import { runSanitizedCommand } from './process.js';
import { installProductionBootstrapManifest } from './provision.js';
import { allocateInstanceId, readRegistry } from './registry.js';
import { resolveReleaseSource } from './release-tracks.js';
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
      docker_endpoint: 'unix:///var/run/docker.sock',
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

const CHAT_PAUSE: ProvisionHumanPause = {
  kind: 'human-action',
  phase: 'configure_channel',
  code: 'chat_configuration_required',
  message: "Finish this assistant's Google Chat app configuration, then confirm it.",
  resumeFlag: '--chat-configured',
};

/** A terminal that is never asked anything but what a test adds. */
function terminalPrompts(): InteractivePrompts {
  return {
    providerCredential: vi.fn(),
    cloudflareAccountToken: vi.fn(),
    googleCloudSignIn: vi.fn(),
    googleAccount: vi.fn(),
    attendPause: async () => ({ kind: 'stop' }),
  };
}

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

describe('gws-ea usage', () => {
  it.each(['help', '--help', '-h'])('prints the usage for gws-ea %s and exits 0', async (argument) => {
    const io = lines();

    expect(await runCli([argument], io.runtime)).toBe(0);
    expect(io.out[0]).toBe('Usage: gws-ea <create|resume|remove> [options]');
    expect(io.err).toEqual([]);
  });

  it('names an unknown command before the usage and exits 1', async () => {
    const io = lines();

    expect(await runCli(['helpme'], io.runtime)).toBe(1);
    expect(io.err.slice(0, 2)).toEqual(['Unknown command.', 'Usage: gws-ea <create|resume|remove> [options]']);
    expect(io.out).toEqual([]);
  });
});

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

  it('attends a pause at a terminal and runs on in the same process with the decision made', async () => {
    const paths = await testPaths();
    const input = await reserveInstance(paths, reservation(paths));
    const io = lines();
    const decided: boolean[] = [];
    const attendPause = vi.fn(
      async (): Promise<PauseResponse> => ({
        kind: 'continue',
        decisions: { chatConfigured: true },
      }),
    );

    expect(
      await runCli(['resume', '--id', input.instance_id], {
        paths,
        ...io.runtime,
        checkPrerequisites: async () => PREREQUISITES,
        prompts: { ...terminalPrompts(), attendPause },
        advanceProvision: async (_operation, { interaction }) => {
          decided.push(interaction.decisions.chatConfigured);
          return decided.length === 1 ? { status: 'paused', pause: CHAT_PAUSE } : { status: 'ready' };
        },
      }),
    ).toBe(0);
    expect(decided).toEqual([false, true]);
    expect(attendPause).toHaveBeenCalledWith(CHAT_PAUSE, expect.any(AbortSignal));
    expect(io.out.join('\n')).not.toContain('Paused at');
  });

  it('reports a pause the person stops at, logged against the step that paused', async () => {
    const paths = await testPaths();
    const input = await reserveInstance(paths, reservation(paths));
    const io = lines();

    expect(
      await runCli(['resume', '--id', input.instance_id], {
        paths,
        ...io.runtime,
        checkPrerequisites: async () => PREREQUISITES,
        prompts: { ...terminalPrompts(), attendPause: async () => ({ kind: 'stop' }) },
        advanceProvision: async (_operation, { runtime }) => {
          // A later runtime check runs after the step that paused, as before a real human pause.
          await runStep(runtime, { id: 'establish_transport' }, async () => undefined);
          return { status: 'paused', pause: CHAT_PAUSE };
        },
      }),
    ).toBe(10);
    expect(io.out).toContain(`Paused at configure_channel: ${CHAT_PAUSE.message}`);
    expect(io.out).toContain(`Continue with: gws-ea resume --id ${input.instance_id} --chat-configured`);
    const log = io.out.at(-1)?.replace(/^Log: /u, '') ?? '';
    expect(await readFile(log, 'utf8')).toMatch(/· paused at configure_channel \(chat_configuration_required\)\n$/u);
  });

  it('records a run stopped by Ctrl-C, naming the step it was in', async () => {
    const paths = await testPaths();
    const input = await reserveInstance(paths, reservation(paths));
    const ready = path.join(path.dirname(paths.configRoot), 'inside-step');
    const childScript = `
      import { writeFile } from 'node:fs/promises';
      import { runCli } from './src/gws-ea/cli.ts';
      import { runStep } from './src/gws-ea/events.ts';
      import { resolveControlPlanePaths } from './src/gws-ea/paths.ts';
      await runCli(['resume', '--id', process.env.TEST_INSTANCE], {
        paths: resolveControlPlanePaths(JSON.parse(process.env.TEST_PATHS)),
        stdout: () => undefined,
        stderr: () => undefined,
        checkPrerequisites: async () => JSON.parse(process.env.TEST_PREREQUISITES),
        advanceProvision: (_operation, { runtime }) =>
          runStep(runtime, { id: 'establish_transport' }, async () => {
            await writeFile(process.env.TEST_READY, 'ready');
            await new Promise((resolve) => setTimeout(resolve, 60_000));
          }),
      });
    `;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', childScript], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TEST_INSTANCE: input.instance_id,
        TEST_PATHS: JSON.stringify({ configRoot: paths.configRoot, stateRoot: paths.stateRoot }),
        TEST_PREREQUISITES: JSON.stringify(PREREQUISITES),
        TEST_READY: ready,
      },
      stdio: 'ignore',
    });
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));

    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (
        await stat(ready).then(
          () => true,
          () => false,
        )
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    child.kill('SIGINT');

    expect(await exited).toBe(130);
    const runs = path.join(paths.logsRoot, input.instance_id);
    const [run] = await readdir(runs);
    const progress = await readFile(path.join(runs, run!, 'progress.log'), 'utf8');
    expect(progress).toMatch(/· interrupted at establish_transport \(SIGINT\)\n$/u);
    // The instance lock went with the process, so the next resume is not refused as busy.
    const operation = await acquireInstanceOperation(paths, input.instance_id);
    expect(operation).not.toBeNull();
    operation?.release();
  }, 30_000);

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
    expect(io.out.join('\n')).toContain('GWS_EA_PROVIDER_CREDENTIAL');
    expect(io.out).toContain(`Continue with: gws-ea resume --id ${input.instance_id}`);
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

    expect(
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
      }),
    ).toBe(10);

    expect(io.out).toEqual([
      'Configuring Google Cloud…',
      'Waiting for the service account…',
      `Paused at bind_principal: ${DM_PAUSE.message}`,
      `Continue with: gws-ea resume --id ${input.instance_id}`,
      expect.stringMatching(/^Log: \S+progress\.log$/u),
    ]);
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

describe('gws-ea run-scoped Cloudflare authority', () => {
  function managedIngressSetup() {
    return {
      discoverZones: vi.fn(),
      retainAccountToken: vi.fn(),
      requireAccountToken: vi.fn(),
      clearAccountToken: vi.fn(),
    };
  }

  it.each([
    ['create', 10],
    ['resume', 10],
    ['remove', 0],
  ] as const)('is cleared when %s exits', async (command, exitCode) => {
    const paths = await testPaths();
    const session = managedIngressSetup();
    const reserved = async (): Promise<string> => (await reserveInstance(paths, reservation(paths))).instance_id;
    const args =
      command === 'create'
        ? ['create', '--track', 'dogfood', '--source-remote', PRIVATE_REMOTE]
        : command === 'resume'
          ? ['resume', '--id', await reserved()]
          : ['remove', '--id', await reserved(), '--yes'];

    expect(
      await runCli(args, {
        paths,
        ...lines().runtime,
        ...createRuntime(),
        advanceProvision: async () => ({ status: 'paused', pause: DM_PAUSE }),
        removeAssistant: async () => undefined,
        managedIngressSetup: session,
      }),
    ).toBe(exitCode);
    expect(session.clearAccountToken).toHaveBeenCalledOnce();
  });

  it('is cleared when the run throws', async () => {
    const paths = await testPaths();
    const input = await reserveInstance(paths, reservation(paths));
    const session = managedIngressSetup();
    const crash = new Error('the failure loop crashed');

    await expect(
      runCli(['resume', '--id', input.instance_id], {
        paths,
        ...lines().runtime,
        checkPrerequisites: async () => PREREQUISITES,
        advanceProvision: async () => {
          throw new GwsEaError('onecli_unhealthy', 'OneCLI did not become healthy');
        },
        onFailure: async () => {
          throw crash;
        },
        managedIngressSetup: session,
      }),
    ).rejects.toBe(crash);
    expect(session.clearAccountToken).toHaveBeenCalledOnce();
  });
});

describe('gws-ea release sources', () => {
  it("installs dogfood from the public repository's integration branch without asking for a remote", async () => {
    const paths = await testPaths();
    const resolved: Array<readonly [string, string]> = [];
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
          resolved.push([sourceRemote, releaseRef]);
          return { sourceRemote, releaseRef, commit: 'b'.repeat(40) };
        },
        advanceProvision: async () => ({ status: 'paused', pause: DM_PAUSE }),
      }),
    ).toBe(10);
    const dogfood = resolveReleaseSource('dogfood');
    expect(resolved).toEqual([[dogfood.remote, dogfood.ref]]);
    expect(contexts).toEqual([expect.objectContaining({ sourceRemote: dogfood.remote, provided: {} })]);
    const registry = await readRegistry(paths);
    const instances = Object.values(registry.instances);
    expect(instances.map((instance) => [instance.release_track, instance.source_remote])).toEqual([
      ['dogfood', dogfood.remote],
    ]);
  });

  it('refuses prod before it has a release, before asking anything', async () => {
    const paths = await testPaths();
    const collectCreateInputs = vi.fn();
    const resolveRelease = vi.fn();
    const io = lines();

    expect(
      await runCli(['create', '--track', 'prod'], {
        paths,
        ...io.runtime,
        ...createRuntime(),
        collectCreateInputs,
        resolveRelease,
      }),
    ).toBe(1);
    expect(io.err.join('\n')).toContain('Release track prod has no release yet; use --track dogfood.');
    expect(collectCreateInputs).not.toHaveBeenCalled();
    expect(resolveRelease).not.toHaveBeenCalled();
    expect(io.out).toEqual([]);
  });

  it('needs --source-remote for a track that is not a product track', async () => {
    const paths = await testPaths();
    const io = lines();

    expect(await runCli(['create', '--track', 'canary'], { paths, ...io.runtime, ...createRuntime() })).toBe(1);
    expect(io.err.join('\n')).toContain('--source-remote');
    expect(io.out).toEqual([]);
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
          ? RECORDED_GCLOUD_REAUTHENTICATION_FAILED
          : ok('ya29.discard-me');
      }
      return ok();
    },
    resolvePersisted: async (command) => (path.basename(command) === 'onecli' ? command : process.execPath),
    // gws-ea's own OneCLI CLI, never downloaded in a test.
    ensureOnecliCli: async (paths, pin) => paths.onecliCliFile(pin?.version ?? ONECLI_CLI_VERSION),
    node: { version: 'v22.20.0', execPath: process.execPath, execve: neverCalled },
    platform: 'linux',
    // Never the operator's real NanoClaw mount allowlist.
    mountAllowlistFile: path.join(os.tmpdir(), `gws-ea-cli-no-allowlist-${process.pid}`, 'mount-allowlist.json'),
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

  it('pauses create without a TTY at an expired sign-in, as live Gate 1 did, with nothing reserved', async () => {
    const paths = await testPaths();
    const collectCreateInputs = vi.fn();
    const io = lines();
    const dockerHost = await runningDocker();
    const account = 'operator@example.test';

    const exitCode = await runCli(
      ['create', '--track', 'dogfood', '--source-remote', PRIVATE_REMOTE, '--google-account', account],
      {
        paths,
        ...io.runtime,
        ...createRuntime(),
        checkPrerequisites: (request, interaction) =>
          checkPrerequisites(request, interaction, hostDependencies(dockerHost, account, new Set([account]))),
        collectCreateInputs,
      },
    );

    expect(exitCode).toBe(10);
    const summary = io.out.join('\n');
    expect(summary).toContain(`Paused at prerequisites: Google Cloud sign-in is required for ${account}.`);
    expect(summary).toContain(`Sign in: gcloud auth login ${account} --force`);
    expect(summary).toContain('Continue with: gws-ea create --track dogfood (with the same options)');
    expect(io.err).toEqual([]);
    expect(collectCreateInputs).not.toHaveBeenCalled();
    expect(Object.keys((await readRegistry(paths)).instances)).toEqual([]);
    const progressLog = /Log: (\S+)/u.exec(summary)?.[1];
    expect(await readFile(progressLog!, 'utf8')).toMatch(/paused at prerequisites \(gcloud_sign_in_required\)/u);
  });

  it('names --google-account when no person can confirm the signed-in account', async () => {
    const paths = await testPaths();
    const io = lines();
    const dockerHost = await runningDocker();

    const exitCode = await runCli(['create', '--track', 'dogfood', '--source-remote', PRIVATE_REMOTE], {
      paths,
      ...io.runtime,
      ...createRuntime(),
      checkPrerequisites: (request, interaction) =>
        checkPrerequisites(request, interaction, hostDependencies(dockerHost)),
    });

    expect(exitCode).toBe(1);
    expect(io.err.join('\n')).toContain('--google-account operator@example.test');
    expect(Object.keys((await readRegistry(paths)).instances)).toEqual([]);
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

    expect(requests).toEqual([{ command: 'create', paths, account: 'owner@example.test' }]);
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
        attendPause: async () => ({ kind: 'stop' }),
      },
      checkPrerequisites: (request, interaction) =>
        checkPrerequisites(request, interaction, hostDependencies(dockerHost, 'someone@example.test', expired)),
      advanceProvision,
    });

    expect(exitCode).toBe(0);
    expect(googleCloudSignIn).toHaveBeenCalledExactlyOnceWith('operator@example.test');
    expect(advanceProvision).toHaveBeenCalledOnce();
  });

  it('passes the Docker endpoint and OneCLI CLI create recorded when resume checks prerequisites', async () => {
    const paths = await testPaths();
    const input = reservation(paths);
    await installProductionBootstrapManifest(paths, input.instance_id, {
      ...setupAnswers().bootstrapManifest,
      docker_endpoint: 'unix:///Users/operator/.docker/run/docker.sock',
    });
    await reserveInstance(paths, input);
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
      {
        command: 'resume',
        paths,
        account: 'operator@example.test',
        checkoutRoot: input.checkout_realpath,
        dockerEndpoint: 'unix:///Users/operator/.docker/run/docker.sock',
        onecliCliPath: '/usr/local/bin/onecli',
      },
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
