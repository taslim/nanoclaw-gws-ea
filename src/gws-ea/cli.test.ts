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
import { acquireInstanceOperation, recordStepCompleted, reserveInstance } from './journal.js';
import { createOnecliRuntimeLayout } from './onecli-compose.js';
import { advanceOperation, beginOperation } from './operation.js';
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
import { createInstanceRuntimeConfig, persistInstanceRuntime, type InstanceRuntimeConfig } from './service.js';
import { hostLogFiles, type NanoclawServiceHandle, type NanoclawServiceHelpers } from './service-control.js';
import type { CreateTargetRequest } from './release-target.js';
import { resolveReleaseSource } from './release-tracks.js';
import { activeStep } from './run-log.js';
import { GwsEaError, PROVISION_STEPS, releaseOf, type InstanceReservationInput } from './types.js';

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
  rootlessDocker: false,
  account: 'operator@example.test',
};

function createRuntime(): Partial<CliRuntime> {
  return {
    collectCreateInputs: async () => setupAnswers(),
    checkPrerequisites: async () => PREREQUISITES,
    resolveReleaseTarget: async ({ track, source }) => ({
      release: { source_remote: source.remote, release_track: track, deployed_commit: 'b'.repeat(40) },
    }),
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
    expect(io.out[0]).toBe('Usage: gws-ea <command> [options]');
    expect(io.err).toEqual([]);
  });

  it('prints the usage for --help given before --, and only then', async () => {
    const io = lines();

    expect(await runCli(['ncl', '--help', '--id', 'x'], io.runtime)).toBe(0);
    expect(io.out[0]).toBe('Usage: gws-ea <command> [options]');
    expect(io.out.join('\n')).toContain('ncl --id <instance_id> -- <ncl arguments>');
    expect(io.out.join('\n')).toContain('logs --id <instance_id> [--errors] [--follow]');
  });

  it('names an unknown command before the usage and exits 1', async () => {
    const io = lines();

    expect(await runCli(['helpme'], io.runtime)).toBe(1);
    expect(io.err.slice(0, 2)).toEqual(['Unknown command.', 'Usage: gws-ea <command> [options]']);
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

  /**
   * Resumes the instance in a child process whose runCli runtime also has
   * `runtime` (source that may call `ready()`), sends it Ctrl-C once ready,
   * and returns its exit code and progress log.
   */
  async function interruptWhenReady(
    paths: ControlPlanePaths,
    instanceId: string,
    runtime: string,
  ): Promise<{ readonly exitCode: number | null; readonly progress: string }> {
    const readyFile = path.join(path.dirname(paths.configRoot), 'ready');
    const childScript = `
      import { writeFile } from 'node:fs/promises';
      import { runCli } from './src/gws-ea/cli.ts';
      import { runStep } from './src/gws-ea/events.ts';
      import { resolveControlPlanePaths } from './src/gws-ea/paths.ts';
      const ready = () => writeFile(process.env.TEST_READY, 'ready');
      process.exitCode = await runCli(['resume', '--id', process.env.TEST_INSTANCE], {
        paths: resolveControlPlanePaths(JSON.parse(process.env.TEST_PATHS)),
        stdout: () => undefined,
        stderr: () => undefined,
        checkPrerequisites: async () => JSON.parse(process.env.TEST_PREREQUISITES),
        ${runtime}
      });
    `;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', childScript], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TEST_INSTANCE: instanceId,
        TEST_PATHS: JSON.stringify({ configRoot: paths.configRoot, stateRoot: paths.stateRoot }),
        TEST_PREREQUISITES: JSON.stringify(PREREQUISITES),
        TEST_PAUSE: JSON.stringify(CHAT_PAUSE),
        TEST_READY: readyFile,
      },
      stdio: 'ignore',
    });
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));

    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (
        await stat(readyFile).then(
          () => true,
          () => false,
        )
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    child.kill('SIGINT');

    const exitCode = await exited;
    const runs = path.join(paths.logsRoot, instanceId);
    const [run] = await readdir(runs);
    return { exitCode, progress: await readFile(path.join(runs, run!, 'progress.log'), 'utf8') };
  }

  it('records a run stopped by Ctrl-C, naming the step it was in', async () => {
    const paths = await testPaths();
    const input = await reserveInstance(paths, reservation(paths));

    const { exitCode, progress } = await interruptWhenReady(
      paths,
      input.instance_id,
      `advanceProvision: (_operation, { runtime }) =>
        runStep(runtime, { id: 'establish_transport' }, async () => {
          await ready();
          await new Promise((resolve) => setTimeout(resolve, 60_000));
        }),`,
    );

    expect(exitCode).toBe(130);
    expect(progress).toMatch(/· interrupted at establish_transport \(SIGINT\)\n$/u);
    // The instance lock went with the process, so the next resume is not refused as busy.
    const operation = await acquireInstanceOperation(paths, input.instance_id);
    expect(operation).not.toBeNull();
    operation?.release();
  }, 30_000);

  it('stops only the wait when Ctrl-C arrives while a pause is attended, and reports the pause', async () => {
    const paths = await testPaths();
    const input = await reserveInstance(paths, reservation(paths));
    const unexpected = `async () => { throw new Error('unexpected question'); }`;

    const { exitCode, progress } = await interruptWhenReady(
      paths,
      input.instance_id,
      `advanceProvision: async () => ({ status: 'paused', pause: JSON.parse(process.env.TEST_PAUSE) }),
        prompts: {
          providerCredential: ${unexpected},
          cloudflareAccountToken: ${unexpected},
          googleCloudSignIn: ${unexpected},
          googleAccount: ${unexpected},
          attendPause: async (_pause, signal) => {
            await ready();
            // Held open as a real question holds the terminal, until the wait is stopped.
            const open = setTimeout(() => undefined, 60_000);
            await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
            clearTimeout(open);
            return { kind: 'stop' };
          },
        },`,
    );

    expect(exitCode).toBe(10);
    expect(progress).toMatch(/· paused at configure_channel \(chat_configuration_required\)\n$/u);
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

  it('refuses to resume mid-update instead of re-cloning the swapped-away checkout, naming what continues or reverts', async () => {
    const paths = await testPaths();
    const input = await reserveInstance(paths, reservation(paths));
    const target = { ...releaseOf(input), deployed_commit: 'b'.repeat(40) };
    const operation = await acquireInstanceOperation(paths, input.instance_id, { command: 'update', target });
    if (!operation) throw new Error('The test instance operation was busy');
    try {
      await beginOperation(operation, { kind: 'update', from: releaseOf(input), to: target });
      await advanceOperation(operation, 'stopped', { stop: { at: '2026-09-28T10:00:00.000Z', graceful: true } });
      await advanceOperation(operation, 'swapping');
      await advanceOperation(operation, 'swapped');
    } finally {
      operation.release();
    }
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
    const summary = io.err.join('\n');
    expect(summary).toContain('is unfinished (swapped)');
    expect(summary).toContain(`gws-ea update --id ${input.instance_id}`);
    expect(summary).toContain(`gws-ea rollback --id ${input.instance_id}`);
    expect(summary).not.toContain('Resume with');
    expect(summary).toMatch(/Log: \S+progress\.log/u);
    expect(preflight).not.toHaveBeenCalled();
    expect(advanceProvision).not.toHaveBeenCalled();
    await expect(stat(paths.checkoutRoot(input.instance_id))).rejects.toMatchObject({ code: 'ENOENT' });
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

  it("hands removal the driver's NanoClaw service helpers, which stop the host", async () => {
    const paths = await testPaths();
    const input = await reserveInstance(paths, reservation(paths));
    const remove = vi.fn(async () => ({ removed: ['instance-files' as const], abandoned: [] }));
    const serviceHelpers: NanoclawServiceHelpers = {
      createCommandRunner: vi.fn(),
      detectService: vi.fn(),
      stopService: vi.fn(),
      startService: vi.fn(),
      drainContainers: vi.fn(),
      verifyServiceHealth: vi.fn(),
    };

    expect(
      await runCli(['remove', '--id', input.instance_id, '--yes'], {
        paths,
        ...lines().runtime,
        removeAssistant: remove,
        serviceHelpers,
      }),
    ).toBe(0);
    expect(remove).toHaveBeenCalledExactlyOnceWith(
      paths,
      input.instance_id,
      expect.objectContaining({ serviceHelpers }),
    );
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
    const resolved: CreateTargetRequest[] = [];
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
        resolveReleaseTarget: async (request) => {
          resolved.push(request);
          return {
            release: {
              source_remote: request.source.remote,
              release_track: request.track,
              deployed_commit: 'b'.repeat(40),
            },
          };
        },
        advanceProvision: async () => ({ status: 'paused', pause: DM_PAUSE }),
      }),
    ).toBe(10);
    const dogfood = resolveReleaseSource('dogfood');
    expect(resolved).toEqual([{ track: 'dogfood', source: dogfood }]);
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
    const resolveReleaseTarget = vi.fn();
    const io = lines();

    expect(
      await runCli(['create', '--track', 'prod'], {
        paths,
        ...io.runtime,
        ...createRuntime(),
        collectCreateInputs,
        resolveReleaseTarget,
      }),
    ).toBe(1);
    expect(io.err.join('\n')).toContain('Release track prod has no release yet; use --track dogfood.');
    expect(collectCreateInputs).not.toHaveBeenCalled();
    expect(resolveReleaseTarget).not.toHaveBeenCalled();
    expect(io.out).toEqual([]);
  });

  it("reserves the tool's own commit, and reserves nothing when the tool cannot deploy", async () => {
    const deployed = await testPaths();
    expect(
      await runCli(['create', '--track', 'dogfood'], {
        paths: deployed,
        ...lines().runtime,
        ...createRuntime(),
        resolveReleaseTarget: async ({ track, source }) => ({
          release: { source_remote: source.remote, release_track: track, deployed_commit: 'c'.repeat(40) },
        }),
        advanceProvision: async () => ({ status: 'paused', pause: DM_PAUSE }),
      }),
    ).toBe(10);
    expect(Object.values((await readRegistry(deployed)).instances).map((instance) => instance.deployed_commit)).toEqual(
      ['c'.repeat(40)],
    );

    const refused = await testPaths();
    const io = lines();
    expect(
      await runCli(['create', '--track', 'dogfood'], {
        paths: refused,
        ...io.runtime,
        ...createRuntime(),
        resolveReleaseTarget: async () => {
          throw new GwsEaError('release_not_on_track', 'This tool is not on release track dogfood.');
        },
      }),
    ).toBe(1);
    expect(io.err.join('\n')).toContain('This tool is not on release track dogfood.');
    expect(io.err.join('\n')).toContain('Retry with: gws-ea create --track dogfood');
    expect(Object.keys((await readRegistry(refused)).instances)).toEqual([]);
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

/** The Docker endpoint a created assistant's runtime records. */
const DOCKER_ENDPOINT = 'unix:///var/run/docker.sock';

/** A stand-in for an assistant's `bin/ncl`: it prints each argument and the install it was given, then exits 7. */
const NCL_SCRIPT = `#!/bin/sh
printf '%s\\n' "$@"
printf 'install %s\\n' "$NANOCLAW_INSTALL_ID"
exit 7
`;

/** A reservation whose ports and claims differ from those of any other `port`. */
function assistantReservation(paths: ControlPlanePaths, port: number): InstanceReservationInput {
  const instanceId = allocateInstanceId();
  return {
    ...reservation(paths, instanceId),
    allocated_ports: { nanoclaw_webhook: port, onecli_app: port + 1, onecli_gateway: port + 2 },
    exclusive_resource_claims: {
      ingress: { mode: 'existing', endpoint_url: `https://a${port}.example.test/webhook/gchat` },
      gcp_project_id: `assistant-${port}`,
      gcp_account: 'operator@example.test',
      gchat_service_account: `gws-ea-chat@assistant-${port}.iam.gserviceaccount.com`,
      workspace_email: `assistant-${port}@example.test`,
      onecli_project: `gws-ea-${instanceId.replaceAll('-', '')}`,
    },
  };
}

/**
 * A fully created assistant: every provision step complete, and the runtime
 * record and `bin/ncl` in its checkout that its host was started with.
 */
async function createdAssistant(paths: ControlPlanePaths, port: number): Promise<InstanceRuntimeConfig> {
  const reserved = await reserveInstance(paths, assistantReservation(paths, port));
  const operation = await acquireInstanceOperation(paths, reserved.instance_id);
  if (!operation) throw new Error('The test instance operation was busy');
  try {
    for (const step of PROVISION_STEPS) await recordStepCompleted(operation, step);
  } finally {
    operation.release();
  }
  const home = path.join(path.dirname(paths.configRoot), 'home');
  await mkdir(home, { recursive: true, mode: 0o700 });
  const onecli = createOnecliRuntimeLayout({
    instanceId: reserved.instance_id,
    instanceRoot: paths.instanceRoot(reserved.instance_id),
    project: reserved.exclusive_resource_claims.onecli_project,
    appPort: reserved.allocated_ports.onecli_app,
    gatewayPort: reserved.allocated_ports.onecli_gateway,
    cliExecutable: '/usr/local/bin/onecli',
    dockerEndpoint: DOCKER_ENDPOINT,
  });
  const runtime = createInstanceRuntimeConfig(reserved, onecli, {
    nodePath: process.execPath,
    homeDirectory: home,
    selectedProvider: 'claude',
    dockerEndpoint: DOCKER_ENDPOINT,
  });
  await persistInstanceRuntime(runtime, () => undefined);
  await mkdir(path.join(runtime.checkout_realpath, 'bin'), { mode: 0o700 });
  await writeFile(path.join(runtime.checkout_realpath, 'bin', 'ncl'), NCL_SCRIPT, { mode: 0o700 });
  return runtime;
}

/** The host's two log files, written where its service definition sends them. */
async function writeHostLogs(checkout: string): Promise<{ readonly output: string; readonly errors: string }> {
  const logs = hostLogFiles(checkout);
  await mkdir(path.dirname(logs.output), { recursive: true });
  await writeFile(logs.output, 'host started\nhost ready\n');
  await writeFile(logs.errors, 'host warning\n');
  return logs;
}

interface ServiceCall {
  readonly helper: string;
  readonly install: string;
  readonly root?: string;
}

/**
 * NanoClaw's service helpers, faked per install: an install's service runs
 * while `running` says so, stopping and starting it flip that, and every call
 * records the install and checkout it targeted.
 */
function nanoclawServices(running: Record<string, boolean>, options: { readonly healthy?: boolean } = {}) {
  const calls: ServiceCall[] = [];
  const handle = (install: string): NanoclawServiceHandle => ({
    mode: 'launchd',
    active: running[install] === true,
    name: `com.nanoclaw-v2-${install}`,
    definition: `/Users/operator/Library/LaunchAgents/com.nanoclaw-v2-${install}.plist`,
  });
  const helpers = {
    createCommandRunner: vi.fn<NanoclawServiceHelpers['createCommandRunner']>(() => ({
      run: () => '',
      tryRun: () => ({ ok: true, stdout: '' }),
    })),
    detectService: vi.fn<NanoclawServiceHelpers['detectService']>((root, env) => {
      calls.push({ helper: 'detect', install: env.installSlug, root });
      return handle(env.installSlug);
    }),
    stopService: vi.fn<NanoclawServiceHelpers['stopService']>(async (_handle, env) => {
      calls.push({ helper: 'stop', install: env.installSlug });
      running[env.installSlug] = false;
    }),
    startService: vi.fn<NanoclawServiceHelpers['startService']>((_handle, root, env) => {
      calls.push({ helper: 'start', install: env.installSlug, root });
      running[env.installSlug] = true;
    }),
    drainContainers: vi.fn<NanoclawServiceHelpers['drainContainers']>(async (root, env) => {
      calls.push({ helper: 'drain', install: env.installSlug, root });
    }),
    verifyServiceHealth: vi.fn<NanoclawServiceHelpers['verifyServiceHealth']>(async (_handle, root, env) => {
      calls.push({ helper: 'health', install: env.installSlug, root });
      return options.healthy ?? true;
    }),
  } satisfies NanoclawServiceHelpers;
  return { helpers, calls, running };
}

interface Replacement {
  readonly file: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
}

/**
 * Run the CLI with process replacement recorded instead of performed: what
 * it would have replaced itself with, and from where, or its exit code when
 * it ended without replacing itself.
 */
async function runReplacing(
  args: readonly string[],
  runtime: Partial<CliRuntime>,
): Promise<{ readonly exitCode?: number; readonly replacement?: Replacement }> {
  const replaced = new Error('execve called');
  let replacement: Replacement | undefined;
  const execve = ((file: string, argv: readonly string[], env: NodeJS.ProcessEnv): never => {
    replacement = { file, args: argv, env, cwd: process.cwd() };
    throw replaced;
  }) as NonNullable<NodeJS.Process['execve']>;
  const originalCwd = process.cwd();
  try {
    return { exitCode: await runCli(args, { ...runtime, execve }) };
  } catch (error) {
    if (error !== replaced || !replacement) throw error;
    return { replacement };
  } finally {
    process.chdir(originalCwd);
  }
}

/** Run the CLI in a child process as the launcher runs it, so it really replaces itself. */
async function runCliInChild(
  paths: ControlPlanePaths,
  args: readonly string[],
): Promise<{ readonly exitCode: number | null; readonly stdout: string; readonly stderr: string }> {
  const childScript = `
    import { runCli } from './src/gws-ea/cli.ts';
    import { resolveControlPlanePaths } from './src/gws-ea/paths.ts';
    process.exitCode = await runCli(JSON.parse(process.env.TEST_ARGS), {
      paths: resolveControlPlanePaths(JSON.parse(process.env.TEST_PATHS)),
    });
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', childScript], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      TEST_ARGS: JSON.stringify(args),
      TEST_PATHS: JSON.stringify({ configRoot: paths.configRoot, stateRoot: paths.stateRoot }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  const exitCode = await new Promise<number | null>((resolve) => child.once('close', (code) => resolve(code)));
  return { exitCode, stdout, stderr };
}

/** Leave an update of the assistant open at `stopped`, as a cutover interrupted after its stop would. */
async function interruptUpdate(paths: ControlPlanePaths, instanceId: string): Promise<void> {
  const registered = releaseOf((await readRegistry(paths)).instances[instanceId]!);
  const target = { ...registered, deployed_commit: 'b'.repeat(40) };
  const operation = await acquireInstanceOperation(paths, instanceId, { command: 'update', target });
  if (!operation) throw new Error('The test instance operation was busy');
  try {
    await beginOperation(operation, { kind: 'update', from: registered, to: target });
    await advanceOperation(operation, 'stopped', { stop: { at: '2026-09-28T10:00:00.000Z', graceful: true } });
  } finally {
    operation.release();
  }
}

describe('gws-ea start, stop, and restart', () => {
  it("stops only the named assistant's host while another runs, and stops neither one's agent containers (AE3)", async () => {
    const paths = await testPaths();
    const a = await createdAssistant(paths, 35_001);
    const b = await createdAssistant(paths, 35_011);
    const { helpers, calls, running } = nanoclawServices({ [a.install_id]: true, [b.install_id]: true });
    const io = lines();

    expect(await runCli(['stop', '--id', a.instance_id], { paths, ...io.runtime, serviceHelpers: helpers })).toBe(0);

    expect(calls).toEqual([
      { helper: 'detect', install: a.install_id, root: a.checkout_realpath },
      { helper: 'stop', install: a.install_id },
      { helper: 'detect', install: a.install_id, root: a.checkout_realpath },
    ]);
    expect(running).toEqual({ [a.install_id]: false, [b.install_id]: true });
    expect(io.out).toContain(`Assistant ${a.instance_id} stopped.`);
    expect(io.out.join('\n')).toContain('agent containers keep running');
  });

  it('counts stopping an already-stopped assistant as success', async () => {
    const paths = await testPaths();
    const a = await createdAssistant(paths, 35_001);
    const { helpers, calls } = nanoclawServices({ [a.install_id]: false });
    const io = lines();

    expect(await runCli(['stop', '--id', a.instance_id], { paths, ...io.runtime, serviceHelpers: helpers })).toBe(0);

    expect(calls.map(({ helper }) => helper)).toEqual(['detect']);
    expect(io.out).toContain(`Assistant ${a.instance_id} is already stopped.`);
  });

  it.each([
    ['start', false, 'started', ['detect', 'start', 'detect', 'health']],
    ['restart', true, 'restarted', ['detect', 'stop', 'detect', 'start', 'detect', 'health']],
  ] as const)(
    '%s acts on the named service, then waits until its host answers, never draining its agents',
    async (command, wasRunning, outcome, sequence) => {
      const paths = await testPaths();
      const a = await createdAssistant(paths, 35_001);
      const { helpers, calls } = nanoclawServices({ [a.install_id]: wasRunning });
      const io = lines();

      expect(await runCli([command, '--id', a.instance_id], { paths, ...io.runtime, serviceHelpers: helpers })).toBe(0);

      expect(calls.map(({ helper }) => helper)).toEqual(sequence);
      expect(calls.every(({ install }) => install === a.install_id)).toBe(true);
      expect(io.out).toContain(`Assistant ${a.instance_id} ${outcome}.`);
    },
  );

  it('fails a start whose host never answers on its CLI socket, naming where its errors are', async () => {
    const paths = await testPaths();
    const a = await createdAssistant(paths, 35_001);
    const { helpers } = nanoclawServices({ [a.install_id]: false }, { healthy: false });
    const io = lines();

    expect(await runCli(['start', '--id', a.instance_id], { paths, ...io.runtime, serviceHelpers: helpers })).toBe(1);

    expect(helpers.startService).toHaveBeenCalledOnce();
    const summary = io.err.join('\n');
    expect(summary).toContain('never answered on its CLI socket');
    expect(summary).toContain(`gws-ea logs --id ${a.instance_id} --errors`);
    expect(summary).toContain(`Retry with: gws-ea start --id ${a.instance_id}`);
    expect(summary).toMatch(/Log: \S+progress\.log/u);
  });

  it("controls the host only through NanoClaw's helpers: gws-ea itself runs no launchctl, systemctl, or docker", async () => {
    const paths = await testPaths();
    const a = await createdAssistant(paths, 35_001);
    // Every service manager and container runtime gws-ea could reach records that it ran.
    const bin = path.join(path.dirname(paths.configRoot), 'bin');
    const ran = path.join(path.dirname(paths.configRoot), 'ran');
    await mkdir(bin);
    for (const tool of ['launchctl', 'systemctl', 'loginctl', 'docker']) {
      await writeFile(path.join(bin, tool), `#!/bin/sh\necho "${tool} $*" >> '${ran}'\nexit 1\n`, { mode: 0o755 });
    }
    vi.stubEnv('PATH', bin);
    try {
      for (const [command, wasRunning] of [
        ['stop', true],
        ['start', false],
        ['restart', true],
      ] as const) {
        const { helpers } = nanoclawServices({ [a.install_id]: wasRunning });
        expect(
          await runCli([command, '--id', a.instance_id], {
            paths,
            ...lines().runtime,
            environment: { PATH: bin },
            serviceHelpers: helpers,
          }),
        ).toBe(0);
      }
    } finally {
      vi.unstubAllEnvs();
    }

    await expect(readFile(ran, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('gws-ea ncl', () => {
  it("runs the named assistant's own bin/ncl with everything after -- untouched, in its CLI environment", async () => {
    const paths = await testPaths();
    const a = await createdAssistant(paths, 35_001);
    await createdAssistant(paths, 35_011);
    const io = lines();

    const { replacement } = await runReplacing(
      ['ncl', '--id', a.instance_id, '--', 'groups', 'list', '--json', '--help', '--', '-h'],
      {
        paths,
        ...io.runtime,
        environment: {
          PATH: '/usr/bin:relative/bin:/bin',
          LANG: 'C',
          HOME: '/Users/someone-else',
          NANOCLAW_INSTALL_ID: 'another-install',
          ANTHROPIC_API_KEY: 'provider-secret-canary',
        },
      },
    );

    const ncl = path.join(a.checkout_realpath, 'bin', 'ncl');
    expect(replacement).toEqual({
      file: ncl,
      args: [ncl, 'groups', 'list', '--json', '--help', '--', '-h'],
      env: { PATH: '/usr/bin:/bin', LANG: 'C', HOME: a.home_directory, NANOCLAW_INSTALL_ID: a.install_id },
      cwd: a.checkout_realpath,
    });
    expect(io.out).toEqual([]);
    expect(io.err).toEqual([]);
    // The instance lock was released before the handover, so ncl never holds it.
    const operation = await acquireInstanceOperation(paths, a.instance_id);
    expect(operation).not.toBeNull();
    operation?.release();
  });

  it("returns ncl's own output and exit code, and hands it a --help given after --", async () => {
    const paths = await testPaths();
    const a = await createdAssistant(paths, 35_001);

    const { exitCode, stdout } = await runCliInChild(paths, [
      'ncl',
      '--id',
      a.instance_id,
      '--',
      'groups',
      'list',
      '--json',
      '--help',
    ]);

    expect(exitCode).toBe(7);
    expect(stdout).toBe(`groups\nlist\n--json\n--help\ninstall ${a.install_id}\n`);
  }, 30_000);
});

describe('gws-ea logs', () => {
  it('shows the host log with cat, or the error log with --errors, and follows with tail -f, at the paths its service definition names', async () => {
    const paths = await testPaths();
    const a = await createdAssistant(paths, 35_001);
    const logs = await writeHostLogs(a.checkout_realpath);
    const environment = { PATH: '/usr/bin:/bin', ANTHROPIC_API_KEY: 'provider-secret-canary' };

    const shown = await runReplacing(['logs', '--id', a.instance_id], { paths, ...lines().runtime, environment });
    const followed = await runReplacing(['logs', '--id', a.instance_id, '--errors', '--follow'], {
      paths,
      ...lines().runtime,
      environment,
    });

    expect(shown.replacement).toMatchObject({ args: ['cat', logs.output], env: { PATH: '/usr/bin:/bin' } });
    expect(path.basename(shown.replacement!.file)).toBe('cat');
    expect(followed.replacement).toMatchObject({ args: ['tail', '-f', logs.errors], env: { PATH: '/usr/bin:/bin' } });
    expect(path.basename(followed.replacement!.file)).toBe('tail');
  });

  it('streams the host log as the file holds it', async () => {
    const paths = await testPaths();
    const a = await createdAssistant(paths, 35_001);
    await writeHostLogs(a.checkout_realpath);

    const { exitCode, stdout, stderr } = await runCliInChild(paths, ['logs', '--id', a.instance_id]);

    expect(exitCode).toBe(0);
    expect(stdout).toBe('host started\nhost ready\n');
    expect(stderr).toBe('');
  }, 30_000);

  it('names a log file that does not exist yet', async () => {
    const paths = await testPaths();
    const a = await createdAssistant(paths, 35_001);
    const io = lines();

    const { exitCode, replacement } = await runReplacing(['logs', '--id', a.instance_id, '--errors'], {
      paths,
      ...io.runtime,
    });

    expect(exitCode).toBe(1);
    expect(replacement).toBeUndefined();
    expect(io.err.join('\n')).toContain(`${hostLogFiles(a.checkout_realpath).errors} does not exist yet`);
  });
});

describe('gws-ea on an assistant that is not ready to operate', () => {
  it('refuses start, stop, restart, and ncl on an incomplete create, naming resume, while logs still shows the host log', async () => {
    const paths = await testPaths();
    const reserved = await reserveInstance(paths, assistantReservation(paths, 35_001));
    const id = reserved.instance_id;
    const logs = await writeHostLogs(reserved.checkout_realpath);
    const { helpers } = nanoclawServices({});

    for (const command of ['start', 'stop', 'restart', 'ncl']) {
      const io = lines();
      const { exitCode, replacement } = await runReplacing([command, '--id', id], {
        paths,
        ...io.runtime,
        serviceHelpers: helpers,
      });

      expect(exitCode).toBe(1);
      expect(replacement).toBeUndefined();
      const summary = io.err.join('\n');
      expect(summary).toContain('is not fully created');
      expect(summary).toContain(`gws-ea resume --id ${id}`);
      expect(summary).not.toContain('Retry with');
    }
    expect(helpers.detectService).not.toHaveBeenCalled();

    const { replacement } = await runReplacing(['logs', '--id', id], { paths, ...lines().runtime });
    expect(replacement?.args).toEqual(['cat', logs.output]);
  });

  it('refuses start, stop, restart, and ncl mid-update, naming what continues or reverts it, while logs names the update and still shows the host log', async () => {
    const paths = await testPaths();
    const a = await createdAssistant(paths, 35_001);
    const logs = await writeHostLogs(a.checkout_realpath);
    await interruptUpdate(paths, a.instance_id);
    const { helpers } = nanoclawServices({ [a.install_id]: false });

    for (const command of ['start', 'stop', 'restart', 'ncl']) {
      const io = lines();
      const { exitCode, replacement } = await runReplacing([command, '--id', a.instance_id], {
        paths,
        ...io.runtime,
        serviceHelpers: helpers,
      });

      expect(exitCode).toBe(1);
      expect(replacement).toBeUndefined();
      const summary = io.err.join('\n');
      expect(summary).toContain('is unfinished (stopped)');
      expect(summary).toContain(`gws-ea update --id ${a.instance_id}`);
      expect(summary).toContain(`gws-ea rollback --id ${a.instance_id}`);
      expect(summary).not.toContain('Retry with');
    }
    expect(helpers.detectService).not.toHaveBeenCalled();

    const io = lines();
    const { replacement } = await runReplacing(['logs', '--id', a.instance_id], { paths, ...io.runtime });
    expect(replacement?.args).toEqual(['cat', logs.output]);
    expect(io.err.join('\n')).toContain('is unfinished (stopped)');
    expect(io.err.join('\n')).toContain(`gws-ea update --id ${a.instance_id}`);
    expect(io.out).toEqual([]);
  });
});
