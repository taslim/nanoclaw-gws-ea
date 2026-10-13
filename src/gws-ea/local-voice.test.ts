import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { writePrivate } from '../community-portal/private-file.js';
import { processLock } from '../community-portal/process-lock.js';
import { deriveGcpClaims } from './gcp-identity.js';
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
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function assets(model: 'base' | 'small' = 'base'): Promise<VerifiedVoiceInstallation> {
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
      builtAt: new Date().toISOString(),
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
  await persistInstanceRuntime(runtime, upsertEnvVars, voicePolicyFile(paths));
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
    await assistant(32500);
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
    expect((await readLocalVoicePolicy(paths)).installationDir).toBe(current.installationDir);
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
