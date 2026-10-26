import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runCli } from './cli.js';
import { capabilityLines, inspectVoiceCapability } from './connectors.js';
import { writePrivate } from '../community-portal/private-file.js';
import { processLock } from '../community-portal/process-lock.js';
import { deriveGcpClaims } from './gcp-identity.js';
import type { NanoclawServiceHelpers } from './service-control.js';
import { createOnecliRuntimeLayout } from './onecli-compose.js';
import { CONTROL_PLANE_ROOT, resolveControlPlanePaths, type ControlPlanePaths } from './paths.js';
import { reserveInstance } from './journal.js';
import {
  createInstanceRuntimeConfig,
  persistInstanceRuntime,
  type InstanceRuntimeConfig,
  type UpsertEnvVars,
} from './service.js';
import {
  VOICE_RECIPE_ID,
  VOICE_MODEL_CATALOG,
  VOICE_SOURCE_ARTIFACTS,
  type VerifiedVoiceInstallation,
} from './voice-assets.js';
import { voiceInstallationDirectory } from './install-voice.js';
import {
  disableLocalVoice,
  enableLocalVoice,
  installLocalVoice,
  observeLocalVoice,
  readLocalVoicePolicy,
  uninstallLocalVoice,
  voicePolicyFile,
} from './local-voice.js';

const installed = vi.hoisted(() => new Map<string, VerifiedVoiceInstallation>());
vi.mock('./voice-assets.js', async (original) => {
  const actual = await original<typeof import('./voice-assets.js')>();
  return {
    ...actual,
    verifyVoiceInstallation: vi.fn(async (directory: string) => {
      const result = installed.get(directory);
      if (!result) throw new Error('Unverified assets');
      return result;
    }),
  };
});
const installer = vi.hoisted(() => ({ build: vi.fn<() => Promise<VerifiedVoiceInstallation>>() }));
vi.mock('./install-voice.js', async (original) => ({
  ...(await original<typeof import('./install-voice.js')>()),
  installVoiceAssets: installer.build,
}));
const hostProbe = vi.hoisted(() =>
  vi.fn<(runtime: InstanceRuntimeConfig, args: readonly string[]) => Promise<unknown>>(),
);
vi.mock('./ncl.js', async (original) => ({
  ...(await original<typeof import('./ncl.js')>()),
  runInstanceNclJson: hostProbe,
}));
const { upsertEnvVars } = (await import(path.join(CONTROL_PLANE_ROOT, 'setup/set-env.ts'))) as {
  upsertEnvVars: UpsertEnvVars;
};

let root: string;
let paths: ControlPlanePaths;
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'voice-operator-')));
  paths = resolveControlPlanePaths({
    configRoot: path.join(root, 'custom-config'),
    stateRoot: path.join(root, 'custom-state'),
  });
  installed.clear();
  installer.build.mockReset();
  hostProbe.mockReset();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function assets(
  model: 'base' | 'small' = 'base',
  builtAt = new Date().toISOString(),
): Promise<VerifiedVoiceInstallation> {
  const directory = voiceInstallationDirectory(paths, model);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const installation = {
    installationDir: directory,
    ffmpeg: path.join(directory, 'bin/ffmpeg'),
    whisperCli: path.join(directory, 'bin/whisper-cli'),
    model: path.join(directory, 'models/model.bin'),
    vad: path.join(directory, 'models/vad.bin'),
    receipt: {
      schemaVersion: 1,
      recipe: VOICE_RECIPE_ID,
      platform: 'darwin',
      architecture: 'arm64',
      model,
      builtAt,
      artifacts: {
        ffmpeg: { file: 'bin/ffmpeg', size: 1, sha256: '0'.repeat(64) },
        whisperCli: { file: 'bin/whisper-cli', size: 1, sha256: '0'.repeat(64) },
        model: {
          file: `models/${VOICE_MODEL_CATALOG[model].filename}`,
          size: VOICE_MODEL_CATALOG[model].size,
          sha256: VOICE_MODEL_CATALOG[model].sha256,
        },
        vad: {
          file: `models/${VOICE_SOURCE_ARTIFACTS.vad.filename}`,
          size: VOICE_SOURCE_ARTIFACTS.vad.size,
          sha256: VOICE_SOURCE_ARTIFACTS.vad.sha256,
        },
      },
    },
  } satisfies VerifiedVoiceInstallation;
  installed.set(directory, installation);
  return installation;
}
async function policy(installation: VerifiedVoiceInstallation, enabled = false): Promise<void> {
  await writePrivate(voicePolicyFile(paths), {
    schemaVersion: 1,
    enabled,
    installationDir: installation.installationDir,
  });
}
async function assistant(port: number, compatible = true): Promise<InstanceRuntimeConfig> {
  const instanceId = randomUUID();
  const reservation = await reserveInstance(paths, {
    instance_id: instanceId,
    release_track: 'dogfood',
    source_remote: 'https://example.test/ea.git',
    deployed_commit: 'a'.repeat(40),
    allocated_ports: { onecli_app: port, onecli_gateway: port + 1 },
    exclusive_resource_claims: {
      ...deriveGcpClaims(instanceId),
      gcp_account: 'operator@example.test',
      workspace_email: `${instanceId}@example.test`,
      onecli_project: `gws-ea-${instanceId.replaceAll('-', '')}`,
    },
  });
  const release = paths.instanceLayout(instanceId).release('aaaaaaaa');
  await mkdir(path.join(release, 'src/gws-ea'), { recursive: true, mode: 0o700 });
  if (compatible)
    await writeFile(
      path.join(release, 'src/gws-ea/voice-compatibility.json'),
      JSON.stringify({ schemaVersion: 1, recipe: VOICE_RECIPE_ID }),
    );
  await symlink('aaaaaaaa', paths.checkoutRoot(instanceId));
  const onecli = createOnecliRuntimeLayout({
    instanceId,
    instanceRoot: paths.instanceRoot(instanceId),
    project: reservation.exclusive_resource_claims.onecli_project,
    appPort: port,
    gatewayPort: port + 1,
    dockerEndpoint: 'unix:///var/run/docker.sock',
  });
  const runtime = createInstanceRuntimeConfig(paths, reservation, onecli, {
    nodePath: process.execPath,
    homeDirectory: root,
    selectedProvider: 'claude',
    dockerEndpoint: 'unix:///var/run/docker.sock',
  });
  await persistInstanceRuntime(runtime, upsertEnvVars, paths.configRoot);
  return runtime;
}
function health(overrides: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: 1,
    recipe: VOICE_RECIPE_ID,
    enabled: false,
    readiness: 'unavailable',
    reason: 'operator-enablement-required',
    queued: 0,
    inflight: 0,
    lastOutcome: null,
    lastFailure: null,
    ...overrides,
  };
}

describe('human voice observation timestamps', () => {
  it('shows consumer readiness separately from actual recognition in human catalog facts', async () => {
    const runtime = await assistant(34900);
    const installation = await assets();
    await policy(installation, true);
    hostProbe.mockResolvedValue(health({ enabled: true, readiness: 'ready' }));
    const ready = await inspectVoiceCapability(paths, { checkConsumers: true });
    expect(capabilityLines(ready, true, 'America/Los_Angeles').join('\n')).toContain('Last recognition: unobserved');
    const at = '2026-09-28T14:00:00.000Z';
    hostProbe.mockResolvedValue(
      health({ enabled: true, readiness: 'ready', lastOutcome: { status: 'recognized', at } }),
    );
    const recognized = await inspectVoiceCapability(paths, { checkConsumers: true });
    const lines = capabilityLines(recognized, true, 'America/Los_Angeles');
    expect(lines).toContain(`  Assistant ${runtime.instance_id}`);
    expect(lines).toContain('    Last recognition: recognized Sep 28, 2026, 7:00 AM');
    expect(recognized.assistants[0]?.last_outcome?.at).toBe(at);
  });

  it('formats verified receipt timestamps locally without rewriting the stored provenance', async () => {
    const builtAt = '2026-09-28T14:00:00.000Z';
    const installation = await assets('base', builtAt);
    await policy(installation);
    const observed = await inspectVoiceCapability(paths);
    const lines = capabilityLines(observed, true, 'America/Los_Angeles');
    expect(lines).toContain('  Verified build: Sep 28, 2026, 7:00 AM');
    expect(observed.assets.provenance?.builtAt).toBe(builtAt);
    expect(observed.observed_at).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/u);
    expect(lines.at(-1)).toMatch(/^Observed: [A-Z][a-z]{2} /u);
  });
});

describe('shared voice operator lifecycle', () => {
  it('installs without enabling and serializes concurrent shared mutations', async () => {
    const installation = await assets();
    let complete!: () => void;
    installer.build.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        complete = resolve;
      });
      return installation;
    });
    const first = installLocalVoice(paths);
    await vi.waitFor(() => expect(installer.build).toHaveBeenCalledOnce());
    await expect(enableLocalVoice(paths)).rejects.toMatchObject({ code: 'voice_busy' });
    complete();
    expect(await first).toEqual(installation);
    expect(await readLocalVoicePolicy(paths)).toEqual({
      schemaVersion: 1,
      enabled: false,
      installationDir: installation.installationDir,
    });
    expect(await readFile(voicePolicyFile(paths), 'utf8')).not.toContain('instance_id');
  });
  it('does not install while enabling absent assets or bypass a corrupt selection', async () => {
    await expect(enableLocalVoice(paths)).rejects.toMatchObject({ code: 'voice_not_installed' });
    const installation = await assets();
    await policy(installation);
    installed.clear();
    await expect(enableLocalVoice(paths)).rejects.toMatchObject({ code: 'voice_assets_invalid' });
    expect(installer.build).not.toHaveBeenCalled();
    expect((await readLocalVoicePolicy(paths)).enabled).toBe(false);
  });
  it('binds two current assistants and a later create to the same custom-root policy without opt-in', async () => {
    const first = await assistant(32000);
    const second = await assistant(32100);
    for (const runtime of [first, second]) {
      const file = path.join(runtime.state_root, '.env');
      await writeFile(
        file,
        (await readFile(file, 'utf8'))
          .split('\n')
          .filter((line) => !line.startsWith('GWS_EA_VOICE_POLICY_FILE='))
          .join('\n'),
        { mode: 0o600 },
      );
    }
    const installation = await assets();
    await policy(installation);
    await enableLocalVoice(paths, { upsertEnvVars });
    const third = await assistant(32200);
    for (const runtime of [first, second, third]) {
      expect(await readFile(path.join(runtime.state_root, '.env'), 'utf8')).toContain(
        `GWS_EA_VOICE_POLICY_FILE=${voicePolicyFile(paths)}`,
      );
      expect(
        Object.keys(JSON.parse(await readFile(paths.runtimeFile(runtime.instance_id), 'utf8')) as object).some((key) =>
          key.includes('voice'),
        ),
      ).toBe(false);
    }
    expect((await readLocalVoicePolicy(paths)).enabled).toBe(true);
    await disableLocalVoice(paths);
    expect((await readLocalVoicePolicy(paths)).enabled).toBe(false);
    expect(await readFile(path.join(third.state_root, '.env'), 'utf8')).toContain(voicePolicyFile(paths));
  });
  it('will not enable across a concurrent instance operation and leaves policy disabled', async () => {
    const runtime = await assistant(32300);
    const installation = await assets();
    await policy(installation);
    const release = await processLock(paths.instanceLock(runtime.instance_id));
    try {
      await expect(enableLocalVoice(paths, { upsertEnvVars })).rejects.toMatchObject({ code: 'instance_busy' });
    } finally {
      release?.();
    }
    expect((await readLocalVoicePolicy(paths)).enabled).toBe(false);
  });
  it('reports registry contention as busy with an exact enable retry and no policy change', async () => {
    const installation = await assets();
    await policy(installation);
    const release = await processLock(paths.registryLock);
    const output: string[] = [];
    try {
      const exit = await runCli(['connectors', 'enable', 'voice', '--json'], {
        paths,
        stdout: (line) => output.push(line),
        stderr: () => undefined,
      });
      expect(exit).toBe(75);
      expect(JSON.parse(output.join('\n'))).toMatchObject({
        outcome: 'busy',
        changed: false,
        error: { code: 'registry_busy' },
        next_actions: [
          { kind: 'external', instruction: expect.any(String) },
          { kind: 'command', argv: ['gws-ea', 'connectors', 'enable', 'voice'] },
        ],
      });
      expect((await readLocalVoicePolicy(paths)).enabled).toBe(false);
    } finally {
      release?.();
    }
  }, 10_000);
  it('requires explicit disablement and preserves assets while old preparation is queued', async () => {
    await assistant(32400);
    const installation = await assets();
    await policy(installation, true);
    await expect(uninstallLocalVoice(paths)).rejects.toMatchObject({ code: 'voice_enabled' });
    await disableLocalVoice(paths);
    await expect(
      uninstallLocalVoice(paths, { ncl: async () => health({ queued: 1 }), fileHolders: async () => [] }),
    ).rejects.toMatchObject({ code: 'voice_not_drained' });
    expect((await readLocalVoicePolicy(paths)).installationDir).toBe(installation.installationDir);
  });
  it('refuses unobserved live work and orphaned consumers of an older installed model', async () => {
    const runtime = await assistant(32500);
    const older = await assets('base');
    const current = await assets('small');
    await policy(current);
    await expect(
      uninstallLocalVoice(paths, {
        ncl: async () => {
          throw new Error('host unavailable');
        },
        fileHolders: async () => [],
      }),
    ).rejects.toMatchObject({ code: 'voice_drain_unproven' });
    await expect(
      uninstallLocalVoice(paths, {
        ncl: async () => health(),
        fileHolders: async (directory) =>
          directory === older.installationDir ? [{ pid: 44, command: 'whisper-cli', file: older.model }] : [],
      }),
    ).rejects.toMatchObject({ code: 'voice_not_drained' });
    await rm(paths.runtimeFile(runtime.instance_id));
    await expect(
      uninstallLocalVoice(paths, { ncl: async () => health(), fileHolders: async () => [] }),
    ).rejects.toMatchObject({
      code: 'voice_drain_unproven',
      message: expect.stringContaining(runtime.instance_id),
    });
    expect((await readLocalVoicePolicy(paths)).installationDir).toBe(current.installationDir);
    expect((await lstat(older.installationDir)).isDirectory()).toBe(true);
    expect((await lstat(current.installationDir)).isDirectory()).toBe(true);
  });
  it('removes only owned recipe directories after all preparations and orphaned children drain', async () => {
    await assistant(32600);
    const installation = await assets();
    await policy(installation);
    const privateFile = path.join(paths.stateRoot, 'voice', 'operator-file.txt');
    await writeFile(privateFile, 'keep');
    const observed: string[] = [];
    await uninstallLocalVoice(paths, {
      ncl: async () => health(),
      fileHolders: async (directory) => {
        observed.push(directory);
        return [];
      },
    });
    expect(observed).toEqual([installation.installationDir]);
    expect(await readLocalVoicePolicy(paths)).toEqual({ schemaVersion: 1, enabled: false, installationDir: null });
    expect(await readFile(privateFile, 'utf8')).toBe('keep');
    await expect(readFile(path.join(installation.installationDir, 'receipt.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
  it('never deletes an operator selection outside this recipe-owned cache', async () => {
    const installation = await assets();
    await policy({ ...installation, installationDir: root });
    await expect(uninstallLocalVoice(paths, { fileHolders: async () => [] })).rejects.toMatchObject({
      code: 'voice_assets_unowned',
    });
  });
  it('preserves an external selection ownership error instead of recommending an impossible removal', async () => {
    const installation = await assets();
    const external = { ...installation, installationDir: root };
    installed.set(root, external);
    await policy(external);
    await expect(enableLocalVoice(paths)).rejects.toMatchObject({ code: 'voice_assets_unowned' });
    expect((await readLocalVoicePolicy(paths)).enabled).toBe(false);
  });
  it('retains the selected small model in corrupt-asset recovery', async () => {
    const installation = await assets('small');
    await policy(installation);
    installed.delete(installation.installationDir);
    await expect(enableLocalVoice(paths)).rejects.toMatchObject({
      code: 'voice_assets_invalid',
      details: { model: 'small' },
    });
  });
  it.each(['quiet', 'holding', 'live'] as const)(
    'can recover unknown release removal only when managed, stopped, and %s',
    async (state) => {
      const runtime = await assistant(32700);
      await writeFile(path.join(runtime.checkout_root, 'src/gws-ea/voice-compatibility.json'), '{bad json');
      const installation = await assets();
      await policy(installation);
      const helpers: NanoclawServiceHelpers = {
        createCommandRunner: () => ({ run: () => '', tryRun: () => ({ ok: true, stdout: '' }) }),
        detectService: () => ({ mode: 'launchd', active: state === 'live' }),
        stopService: async () => undefined,
        startService: () => undefined,
        drainContainers: async () => undefined,
        verifyServiceHealth: async () => true,
      };
      const operation = uninstallLocalVoice(paths, {
        serviceHelpers: helpers,
        quiescence: {
          platform: 'darwin',
          runCommand: async (command) => {
            if (command.command === 'ps')
              return {
                stdout: state === 'holding' ? `44 node ${runtime.instance_root}/src/index.ts\n` : '',
                stderr: '',
              };
            return { stdout: '', stderr: '' };
          },
        },
        fileHolders: async () => [],
        ncl: async () => {
          throw new Error('Unknown release must not be queried');
        },
      });
      if (state === 'quiet') {
        await operation;
        expect((await readLocalVoicePolicy(paths)).installationDir).toBeNull();
        await expect(lstat(installation.installationDir)).rejects.toMatchObject({ code: 'ENOENT' });
      } else {
        await expect(operation).rejects.toMatchObject({
          code: 'voice_drain_unproven',
          details: { instanceId: runtime.instance_id },
        });
        expect((await readLocalVoicePolicy(paths)).installationDir).toBe(installation.installationDir);
      }
    },
  );
  it('clears a missing recipe-owned selection so explicit repair can reinstall it', async () => {
    const installation = await assets();
    await policy(installation);
    await rm(installation.installationDir, { recursive: true });
    await uninstallLocalVoice(paths, { fileHolders: async () => [] });
    expect(await readLocalVoicePolicy(paths)).toEqual({ schemaVersion: 1, enabled: false, installationDir: null });
  });
  it('refuses a symlinked cache ancestor before touching an external owned directory', async () => {
    await mkdir(paths.stateRoot, { recursive: true, mode: 0o700 });
    const external = path.join(root, 'external');
    await mkdir(external, { mode: 0o700 });
    await symlink(external, path.join(paths.stateRoot, 'voice'));
    const marker = path.join(external, 'keep.txt');
    await writeFile(marker, 'keep');
    await expect(uninstallLocalVoice(paths, { fileHolders: async () => [] })).rejects.toMatchObject({
      code: 'unsafe_path',
    });
    expect(await readFile(marker, 'utf8')).toBe('keep');
  });
});

describe('voice readiness observation', () => {
  it('keeps preparing work and recent failure observable after host-wide disablement', async () => {
    const runtime = await assistant(33000);
    const installation = await assets();
    await policy(installation);
    const at = new Date().toISOString();
    expect(
      await observeLocalVoice(paths, runtime, async () =>
        health({ queued: 1, lastFailure: { reason: 'recognition-timeout', at } }),
      ),
    ).toMatchObject({
      enabled: false,
      readiness: 'unavailable',
      queued: 1,
      last_failure: { reason: 'recognition-timeout', at },
    });
  });
  it('separates host enablement, supported release, readiness, and a real successful outcome', async () => {
    const runtime = await assistant(32700);
    const installation = await assets();
    await policy(installation, true);
    const ready = { enabled: true, readiness: 'ready' };
    expect(await observeLocalVoice(paths, runtime, async () => health(ready))).toMatchObject({
      status: 'unknown',
      enabled: true,
      assets: 'verified',
      compatibility: 'compatible',
      readiness: 'ready',
      last_outcome: null,
    });
    const at = new Date().toISOString();
    expect(
      await observeLocalVoice(paths, runtime, async () =>
        health({ ...ready, lastOutcome: { status: 'recognized', at } }),
      ),
    ).toMatchObject({ status: 'ok', last_outcome: { status: 'recognized', at } });
    expect(
      await observeLocalVoice(paths, runtime, async () =>
        health({ ...ready, lastFailure: { reason: 'recognition-timeout', at } }),
      ),
    ).toMatchObject({ status: 'degraded', reason: 'recognition-timeout' });
  });
  it('reports unsupported releases independently, without querying or disabling their peer', async () => {
    const unsupported = await assistant(32800, false);
    const supported = await assistant(32900);
    const installation = await assets();
    await policy(installation, true);
    const ncl = vi.fn(async () => health({ enabled: true, readiness: 'ready' }));
    expect(await observeLocalVoice(paths, unsupported, ncl)).toMatchObject({
      compatibility: 'unsupported',
      status: 'degraded',
      enabled: true,
    });
    expect(ncl).not.toHaveBeenCalled();
    expect(await observeLocalVoice(paths, supported, ncl)).toMatchObject({
      compatibility: 'compatible',
      status: 'unknown',
      enabled: true,
    });
    expect((await readLocalVoicePolicy(paths)).enabled).toBe(true);
  });
});

describe('native public capability journeys', () => {
  it('observes independent consumers while an earlier probe waits and retains sorted results', async () => {
    const first = await assistant(34600);
    const second = await assistant(34700);
    const ids = [first.instance_id, second.instance_id].sort();
    let releaseFirst = (): void => undefined;
    const firstWaiting = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let probesStarted = 0;
    const observed = await inspectVoiceCapability(paths, {
      checkConsumers: true,
      ncl: async (runtime) => {
        probesStarted += 1;
        if (probesStarted === 1) await firstWaiting;
        else releaseFirst();
        return health({ queued: runtime.instance_id === first.instance_id ? 2 : 3 });
      },
    });
    expect(observed.assistants.map((consumer) => consumer.instance_id)).toEqual(ids);
    expect(observed.assistants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ instance_id: first.instance_id, consumer: expect.objectContaining({ queued: 2 }) }),
        expect.objectContaining({ instance_id: second.instance_id, consumer: expect.objectContaining({ queued: 3 }) }),
      ]),
    );
  });

  async function invoke(args: readonly string[]) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exit = await runCli([...args, '--json'], {
      paths,
      upsertEnvVars,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      environment: {},
    });
    return { exit, result: JSON.parse(stdout.join('\n')) as Record<string, unknown>, stderr };
  }
  it('lists supported voice separately from absent assets and disabled policy without creating state', async () => {
    const answer = await invoke(['connectors', 'list']);
    expect(answer).toMatchObject({
      exit: 0,
      result: {
        command: 'connectors list',
        changed: false,
        next_actions: [{ kind: 'command', argv: ['gws-ea', 'connectors', 'install', 'voice'] }],
        data: {
          capabilities: [
            {
              name: 'voice',
              scope: 'host',
              availability: { status: 'supported' },
              assets: { status: 'absent' },
              activation: { status: 'disabled' },
            },
            {
              name: 'browser',
              scope: 'assistant',
              actions: ['show', 'check', 'enable', 'disable'],
              assistant_ids: [],
            },
            {
              name: 'onepassword',
              scope: 'host',
              actions: ['show', 'check', 'enable', 'disable'],
              activation: 'disabled',
            },
            {
              name: 'artifacts',
              scope: 'assistant',
              actions: ['show', 'check', 'enable', 'disable'],
              assistant_ids: [],
            },
          ],
        },
      },
    });
    await expect(readFile(voicePolicyFile(paths))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(hostProbe).not.toHaveBeenCalled();
    expect(installer.build).not.toHaveBeenCalled();
  });
  it.each([false, true])('repairs a missing selected small model when enabled=%s', async (enabled) => {
    const installation = await assets('small');
    await policy(installation, enabled);
    await rm(installation.installationDir, { recursive: true });
    expect(await invoke(['connectors', 'show', 'voice'])).toMatchObject({
      exit: 0,
      result: {
        data: { assets: { status: 'absent', selected_model: 'small', provenance: null } },
        next_actions: [
          ...(enabled ? [{ kind: 'command', argv: ['gws-ea', 'connectors', 'disable', 'voice'] }] : []),
          { kind: 'command', argv: ['gws-ea', 'connectors', 'install', 'voice', '--model', 'small'] },
        ],
      },
    });
    if (enabled) {
      const human: string[] = [];
      expect(
        await runCli(['connectors', 'show', 'voice'], {
          paths,
          stdout: (line) => human.push(line),
          stderr: (line) => human.push(line),
          environment: {},
        }),
      ).toBe(0);
      expect(human.join('\n')).toContain('gws-ea connectors disable voice');
      expect(human.join('\n')).toContain('gws-ea connectors install voice --model small');
      expect((await invoke(['connectors', 'disable', 'voice'])).exit).toBe(0);
    }
    installer.build.mockResolvedValue(installation);
    expect((await invoke(['connectors', 'install', 'voice', '--model', 'small'])).exit).toBe(0);
    expect(installer.build).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ model: 'small' }),
      expect.anything(),
    );
  });
  it('offers complete human and JSON recovery for a corrupt selected small model', async () => {
    const installation = await assets('small');
    await policy(installation);
    installed.delete(installation.installationDir);
    const answer = await invoke(['connectors', 'enable', 'voice']);
    expect(answer).toMatchObject({
      exit: 1,
      result: {
        error: { code: 'voice_assets_invalid' },
        next_actions: [
          { kind: 'command', argv: ['gws-ea', 'connectors', 'disable', 'voice'] },
          { kind: 'command', argv: ['gws-ea', 'connectors', 'uninstall', 'voice'] },
          { kind: 'command', argv: ['gws-ea', 'connectors', 'install', 'voice', '--model', 'small'] },
        ],
      },
    });
    const human: string[] = [];
    expect(
      await runCli(['connectors', 'enable', 'voice'], {
        paths,
        upsertEnvVars,
        stdout: (line) => human.push(line),
        stderr: (line) => human.push(line),
        environment: {},
      }),
    ).toBe(1);
    const text = human.join('\n');
    expect(text).toContain('gws-ea connectors disable voice');
    expect(text).toContain('gws-ea connectors uninstall voice');
    expect(text).toContain('gws-ea connectors install voice --model small');
  });
  it('installs inactive, enables two compatible assistants once, and retains unknown compatibility', async () => {
    const first = await assistant(34000);
    const second = await assistant(34100);
    const unknown = await assistant(34200);
    await writeFile(path.join(unknown.checkout_root, 'src/gws-ea/voice-compatibility.json'), '{');
    const installation = await assets();
    installer.build.mockResolvedValue(installation);
    expect(await invoke(['connectors', 'install', 'voice', '--model', 'base'])).toMatchObject({
      exit: 0,
      result: { command: 'connectors install', changed: true, data: { enabled: false } },
    });
    expect(await invoke(['connectors', 'show', 'voice'])).toMatchObject({
      exit: 0,
      result: {
        changed: false,
        data: {
          activation: { status: 'disabled' },
          assets: { status: 'verified', selected_model: 'base', provenance: { model: 'base' } },
        },
        next_actions: [
          { kind: 'command', argv: ['gws-ea', 'connectors', 'enable', 'voice'] },
          { kind: 'external', instruction: expect.stringContaining(unknown.instance_id) },
          { kind: 'command', argv: ['gws-ea', 'status', '--id', unknown.instance_id] },
        ],
      },
    });
    const enabled = await invoke(['connectors', 'enable', 'voice']);
    expect(enabled).toMatchObject({
      exit: 0,
      result: {
        data: {
          enabled: true,
          compatible_assistant_ids: expect.arrayContaining([first.instance_id, second.instance_id]),
          unknown_assistant_ids: [unknown.instance_id],
          future_compatible_assistants: true,
        },
      },
    });
    for (const runtime of [first, second])
      expect(await readFile(path.join(runtime.state_root, '.env'), 'utf8')).toContain(voicePolicyFile(paths));
    expect(hostProbe).not.toHaveBeenCalled();
    hostProbe.mockResolvedValue(health({ enabled: true, readiness: 'ready' }));
    expect(await invoke(['connectors', 'check', 'voice'])).toMatchObject({
      exit: 0,
      result: {
        changed: false,
        data: {
          activation: { status: 'enabled' },
          assets: { status: 'verified' },
          assistants: expect.arrayContaining([
            expect.objectContaining({ instance_id: first.instance_id, readiness: 'ready', last_outcome: null }),
            expect.objectContaining({
              instance_id: unknown.instance_id,
              compatibility: 'unknown',
              readiness: 'unknown',
            }),
          ]),
        },
      },
    });
  });
  it('checks independent consumer facts with corrupt assets and retains unreachable consumers', async () => {
    const active = await assistant(34300);
    const unreachable = await assistant(34400);
    const unsupported = await assistant(34500, false);
    const installation = await assets();
    await policy(installation);
    installed.clear();
    hostProbe.mockImplementation(async (runtime) => {
      if (runtime.instance_id === unreachable.instance_id) throw new Error('host unreachable');
      return health({ queued: 2, inflight: 1 });
    });
    const before = await readFile(voicePolicyFile(paths), 'utf8');
    const beforeMetadata = await lstat(voicePolicyFile(paths));
    const answer = await invoke(['connectors', 'check', 'voice']);
    expect(answer).toMatchObject({
      exit: 0,
      result: {
        changed: false,
        data: {
          assets: { status: 'invalid' },
          activation: { status: 'disabled' },
          assistants: expect.arrayContaining([
            expect.objectContaining({
              instance_id: active.instance_id,
              compatibility: 'compatible',
              consumer: { status: 'observed', queued: 2, inflight: 1, enabled: false },
              readiness: 'unavailable',
            }),
            expect.objectContaining({
              instance_id: unreachable.instance_id,
              compatibility: 'compatible',
              consumer: { status: 'unknown', queued: null, inflight: null, enabled: null },
              readiness: 'unknown',
            }),
            expect.objectContaining({
              instance_id: unsupported.instance_id,
              compatibility: 'unsupported',
              consumer: { status: 'not-applicable', queued: null, inflight: null, enabled: null },
            }),
          ]),
        },
      },
    });
    expect(await readFile(voicePolicyFile(paths), 'utf8')).toBe(before);
    const afterMetadata = await lstat(voicePolicyFile(paths));
    expect([afterMetadata.ino, afterMetadata.mtimeMs, afterMetadata.ctimeMs]).toEqual([
      beforeMetadata.ino,
      beforeMetadata.mtimeMs,
      beforeMetadata.ctimeMs,
    ]);
    expect(installer.build).not.toHaveBeenCalled();
    await writePrivate(voicePolicyFile(paths), { schemaVersion: 1, enabled: false, installationDir: null });
    expect(await invoke(['connectors', 'check', 'voice'])).toMatchObject({
      exit: 0,
      result: {
        data: {
          assets: { status: 'absent' },
          assistants: expect.arrayContaining([
            expect.objectContaining({
              instance_id: active.instance_id,
              consumer: { status: 'observed', queued: 2, inflight: 1, enabled: false },
            }),
          ]),
        },
      },
    });
    await policy(installation);
    hostProbe.mockRejectedValue(new Error('host unreachable'));
    expect(await invoke(['connectors', 'uninstall', 'voice'])).toMatchObject({
      exit: 1,
      result: {
        changed: false,
        error: { code: 'voice_drain_unproven' },
        next_actions: expect.arrayContaining([{ kind: 'command', argv: ['gws-ea', 'connectors', 'check', 'voice'] }]),
      },
    });
  });
  it('retains policy uncertainty and excludes external verified bytes from installed ownership', async () => {
    const installation = await assets();
    const external = { ...installation, installationDir: root };
    installed.set(root, external);
    await policy(external);
    expect(await invoke(['connectors', 'show', 'voice'])).toMatchObject({
      exit: 0,
      result: { data: { assets: { status: 'invalid' } } },
    });
    await writeFile(voicePolicyFile(paths), '{');
    expect(await invoke(['connectors', 'show', 'voice'])).toMatchObject({
      exit: 0,
      result: { data: { activation: { status: 'unknown', enabled: null }, assets: { status: 'unknown' } } },
    });
  });
});
