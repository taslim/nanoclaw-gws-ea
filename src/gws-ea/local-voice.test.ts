import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboundPreparationRequest } from '../inbound-preparation.js';

import { capabilityLines, inspectVoiceCapability } from './voice-inspection.js';
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
  verifyVoiceInstallation,
  VOICE_RECIPE_ID,
  VOICE_MODEL_CATALOG,
  VOICE_SOURCE_ARTIFACTS,
  type VerifiedVoiceInstallation,
} from './voice-assets.js';
import { voiceInstallationDirectory } from './install-voice.js';
import {
  installLocalVoice,
  observeLocalVoice,
  readLocalVoicePolicy,
  uninstallLocalVoice,
  voicePolicyFile,
} from './local-voice.js';

async function runCli(...args: Parameters<typeof import('./cli.js').runCli>) {
  return (await import('./cli.js')).runCli(...args);
}

const recognition = vi.hoisted(() => ({
  dataRoot: '',
  beforeNormalizedRead: undefined as (() => Promise<void>) | undefined,
}));
vi.mock('../config.js', async (original) => ({
  ...(await original<typeof import('../config.js')>()),
  get DATA_DIR() {
    return recognition.dataRoot;
  },
}));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      if (typeof args[0] === 'string' && args[0].endsWith('/normalized.wav'))
        await recognition.beforeNormalizedRead?.();
      return actual.readFile(...args);
    },
  };
});

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
  recognition.dataRoot = root;
  recognition.beforeNormalizedRead = undefined;
  paths = resolveControlPlanePaths({
    configRoot: path.join(root, 'custom-config'),
    stateRoot: path.join(root, 'custom-state'),
  });
  installed.clear();
  installer.build.mockReset();
  hostProbe.mockReset();
});
afterEach(async () => {
  vi.unstubAllEnvs();
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
  await writeFile(path.join(directory, 'receipt.json'), JSON.stringify(installation.receipt), { mode: 0o600 });
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
  it('installs available and serializes concurrent shared mutations', async () => {
    const installation = await assets();
    let complete!: () => void;
    installer.build.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        complete = resolve;
      });
      return installation;
    });
    const first = installLocalVoice(paths, {}, { fileHolders: async () => [] });
    await vi.waitFor(() => expect(installer.build).toHaveBeenCalledOnce());
    await expect(installLocalVoice(paths)).rejects.toMatchObject({ code: 'voice_busy' });
    complete();
    expect(await first).toEqual(installation);
    expect(await readLocalVoicePolicy(paths)).toEqual({
      schemaVersion: 1,
      enabled: true,
      installationDir: installation.installationDir,
    });
    expect(await readFile(voicePolicyFile(paths), 'utf8')).not.toContain('instance_id');
  });
  it('binds current assistants and a later create to one host policy without opt-in', async () => {
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
    installer.build.mockResolvedValue(installation);
    await installLocalVoice(paths, {}, { upsertEnvVars, fileHolders: async () => [] });
    const third = await assistant(32200);
    for (const runtime of [first, second, third])
      expect(await readFile(path.join(runtime.state_root, '.env'), 'utf8')).toContain(
        `GWS_EA_VOICE_POLICY_FILE=${voicePolicyFile(paths)}`,
      );
    expect((await readLocalVoicePolicy(paths)).enabled).toBe(true);
  });
  it('reports a busy assistant while binding its peers and making voice available', async () => {
    const busy = await assistant(32300);
    const peer = await assistant(32310);
    const file = path.join(peer.state_root, '.env');
    await writeFile(file, '', { mode: 0o600 });
    const installation = await assets();
    installer.build.mockResolvedValue(installation);
    const release = await processLock(paths.instanceLock(busy.instance_id));
    const progress: string[] = [];
    try {
      await installLocalVoice(
        paths,
        {},
        { upsertEnvVars, fileHolders: async () => [], progress: (line) => progress.push(line) },
      );
    } finally {
      release?.();
    }
    expect(progress.join('\n')).toContain(busy.instance_id);
    expect(await readFile(file, 'utf8')).toContain(voicePolicyFile(paths));
    expect((await readLocalVoicePolicy(paths)).enabled).toBe(true);
  });
  it('swaps models while retaining held old assets and removes them on the next install', async () => {
    const old = await assets('base');
    const current = await assets('small');
    await policy(old, true);
    installer.build.mockResolvedValue(current);
    const holder = { pid: 44, command: 'whisper-cli', file: old.model };
    await installLocalVoice(
      paths,
      { model: 'small' },
      { fileHolders: async (directory) => (directory === old.installationDir ? [holder] : []) },
    );
    expect(await readLocalVoicePolicy(paths)).toMatchObject({
      enabled: true,
      installationDir: current.installationDir,
    });
    expect((await lstat(old.installationDir)).isDirectory()).toBe(true);
    await installLocalVoice(paths, { model: 'small' }, { fileHolders: async () => [] });
    await expect(lstat(old.installationDir)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await lstat(current.installationDir)).isDirectory()).toBe(true);
  });
  it('retains an admitted model between decoding and recognition, then prunes it after completion', async () => {
    const runtime = await assistant(32320);
    const old = await assets('base');
    const current = await assets('small');
    await policy(old, true);
    installer.build.mockResolvedValue(current);
    await mkdir(path.dirname(old.ffmpeg), { recursive: true, mode: 0o700 });
    await mkdir(path.dirname(old.model), { recursive: true, mode: 0o700 });
    await writeFile(old.model, 'old model');
    await writeFile(old.vad, 'old VAD');
    await writeFile(
      old.ffmpeg,
      `#!${process.execPath}\nconst b=Buffer.alloc(32044);b.write('RIFF');b.writeUInt32LE(32036,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(32000,40);require('node:fs').writeFileSync(process.argv.at(-1),b);`,
      { mode: 0o700 },
    );
    await writeFile(
      old.whisperCli,
      `#!${process.execPath}\nconst fs=require('node:fs');const a=process.argv;const model=a[a.indexOf('-m')+1];fs.readFileSync(model);fs.readFileSync(a[a.indexOf('--vad-model')+1]);fs.writeFileSync(a[a.indexOf('-of')+1]+'.json',JSON.stringify({params:{language:'auto',translate:false,model},result:{language:'en'},transcription:[{offsets:{from:0,to:1000},text:'Keep the admitted recording.'}]}));`,
      { mode: 0o700 },
    );
    let resume = (): void => undefined;
    const normalizedRead = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let paused = false;
    recognition.beforeNormalizedRead = () => {
      // runVoiceProcess has awaited ffmpeg's exit; whisper has not spawned.
      paused = true;
      return normalizedRead;
    };
    vi.stubEnv('GWS_EA_VOICE_POLICY_FILE', voicePolicyFile(paths));
    const voice = await import('../modules/gws-ea-voice/index.js');
    const timestamp = new Date().toISOString();
    const request: InboundPreparationRequest = {
      content: JSON.stringify({
        attachments: [{ type: 'audio', mimeType: 'audio/ogg', data: Buffer.from('recording').toString('base64') }],
      }),
      channelType: 'future-channel',
      instance: 'future-instance',
      platformId: 'conversation',
      messageId: 'admitted-note',
      timestamp,
      session: {
        id: 'voice-session',
        agent_group_id: 'main',
        messaging_group_id: 'conversation',
        thread_id: null,
        agent_provider: null,
        status: 'active',
        container_status: 'stopped',
        last_active: null,
        created_at: timestamp,
      },
      messagingGroup: {
        id: 'conversation',
        channel_type: 'future-channel',
        platform_id: 'conversation',
        name: null,
        is_group: 1,
        unknown_sender_policy: 'strict',
        created_at: timestamp,
      },
    };
    const admitted = voice.prepareVoiceContent(request);
    const ncl = vi.fn(async () => voice.voiceHealth());
    try {
      await vi.waitFor(() => expect(paused).toBe(true));
      expect(await voice.voiceHealth()).toMatchObject({ queued: 0, inflight: 1 });
      await installLocalVoice(paths, { model: 'small' }, { upsertEnvVars, ncl, fileHolders: async () => [] });
      expect(await readLocalVoicePolicy(paths)).toMatchObject({
        enabled: true,
        installationDir: current.installationDir,
      });
      expect(await readFile(old.model, 'utf8')).toBe('old model');
      expect(ncl).toHaveBeenCalledOnce();
      recognition.beforeNormalizedRead = undefined;
      resume();
      const prepared: unknown = JSON.parse(await admitted);
      expect(prepared).toMatchObject({
        attachments: [{ speech: { status: 'recognized', text: 'Keep the admitted recording.', model: 'base' } }],
      });
      expect(await voice.voiceHealth()).toMatchObject({ enabled: true, queued: 0, inflight: 0 });
      await installLocalVoice(
        paths,
        { model: 'small' },
        {
          upsertEnvVars,
          ncl,
          fileHolders: async () => {
            const release = await processLock(paths.instanceLock(runtime.instance_id));
            try {
              expect(release).toBeNull();
            } finally {
              release?.();
            }
            return [];
          },
        },
      );
      await expect(lstat(old.installationDir)).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await lstat(current.installationDir)).isDirectory()).toBe(true);
    } finally {
      recognition.beforeNormalizedRead = undefined;
      resume();
      await admitted;
      await (await import('../host-lifecycle.js')).stopHostModules();
    }
  });
  it.each(['queued', 'unreachable', 'busy', 'missing-runtime', 'holders-unobservable'] as const)(
    'keeps old assets when a managed consumer is %s without failing the model install',
    async (state) => {
      const runtime = await assistant(32330);
      const old = await assets('base');
      const current = await assets('small');
      await policy(old, true);
      installer.build.mockResolvedValue(current);
      const release = state === 'busy' ? await processLock(paths.instanceLock(runtime.instance_id)) : null;
      if (state === 'missing-runtime') await rm(paths.runtimeFile(runtime.instance_id));
      try {
        await installLocalVoice(
          paths,
          { model: 'small' },
          {
            upsertEnvVars,
            ncl: async () => {
              if (state === 'unreachable') throw new Error('host unavailable');
              return health({ enabled: true, readiness: 'ready', queued: state === 'queued' ? 1 : 0 });
            },
            fileHolders: async () => {
              if (state === 'holders-unobservable') throw new Error('file holders unavailable');
              return [];
            },
          },
        );
      } finally {
        release?.();
      }
      expect(await readLocalVoicePolicy(paths)).toMatchObject({
        enabled: true,
        installationDir: current.installationDir,
      });
      expect((await lstat(old.installationDir)).isDirectory()).toBe(true);
      expect((await lstat(current.installationDir)).isDirectory()).toBe(true);
    },
  );
  it('installs over a legacy installed, stopped policy without a second activation step', async () => {
    const installation = await assets();
    await policy(installation);
    installer.build.mockResolvedValue(installation);
    await installLocalVoice(paths, {}, { fileHolders: async () => [] });
    expect((await readLocalVoicePolicy(paths)).enabled).toBe(true);
  });
  it.each([{ queued: 1 }, { enabled: true }])(
    'requires disabled, idle consumers before uninstall: %o',
    async (activity) => {
      await assistant(32400);
      const installation = await assets();
      await policy(installation, true);
      await expect(
        uninstallLocalVoice(paths, { ncl: async () => health(activity), fileHolders: async () => [] }),
      ).rejects.toMatchObject({ code: 'voice_not_drained' });
      expect(await readLocalVoicePolicy(paths)).toEqual({ schemaVersion: 1, enabled: false, installationDir: null });
      expect((await lstat(installation.installationDir)).isDirectory()).toBe(true);
      await uninstallLocalVoice(paths, { ncl: async () => health(), fileHolders: async () => [] });
      await expect(lstat(installation.installationDir)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );
  it('stops admission even when an assistant is busy and assets cannot yet be removed', async () => {
    const runtime = await assistant(32410);
    const installation = await assets();
    await policy(installation, true);
    const release = await processLock(paths.instanceLock(runtime.instance_id));
    try {
      await expect(uninstallLocalVoice(paths)).rejects.toMatchObject({ code: 'instance_busy' });
    } finally {
      release?.();
    }
    expect(await readLocalVoicePolicy(paths)).toEqual({ schemaVersion: 1, enabled: false, installationDir: null });
    expect((await lstat(installation.installationDir)).isDirectory()).toBe(true);
  });
  it('retains all assets when live work, an older consumer, or a missing runtime cannot be proved idle', async () => {
    const runtime = await assistant(32500);
    const older = await assets('base');
    const current = await assets('small');
    await policy(current, true);
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
    ).rejects.toMatchObject({ code: 'voice_drain_unproven', message: expect.stringContaining(runtime.instance_id) });
    expect((await lstat(current.installationDir)).isDirectory()).toBe(true);
    expect((await lstat(older.installationDir)).isDirectory()).toBe(true);
    expect((await readLocalVoicePolicy(paths)).installationDir).toBeNull();
  });
  it('removes only recipe-owned assets and preserves unrelated files', async () => {
    await assistant(32600);
    const installation = await assets();
    await policy(installation, true);
    const privateFile = path.join(paths.stateRoot, 'voice', 'operator-file.txt');
    await writeFile(privateFile, 'keep');
    await uninstallLocalVoice(paths, { ncl: async () => health(), fileHolders: async () => [] });
    expect(await readFile(privateFile, 'utf8')).toBe('keep');
    await expect(lstat(installation.installationDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('never deletes an operator selection outside the recipe-owned cache', async () => {
    const installation = await assets();
    await policy({ ...installation, installationDir: root }, true);
    await expect(uninstallLocalVoice(paths, { fileHolders: async () => [] })).rejects.toMatchObject({
      code: 'voice_assets_unowned',
    });
    expect((await readLocalVoicePolicy(paths)).enabled).toBe(false);
  });
  it.each(['quiet', 'holding', 'live'] as const)(
    'removes unknown-release assets only when managed, stopped and %s',
    async (state) => {
      const runtime = await assistant(32700);
      await writeFile(path.join(runtime.checkout_root, 'src/gws-ea/voice-compatibility.json'), '{bad json');
      const installation = await assets();
      await policy(installation, true);
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
          runCommand: async (command) => ({
            stdout:
              command.command === 'ps' && state === 'holding' ? `44 node ${runtime.instance_root}/src/index.ts\n` : '',
            stderr: '',
          }),
        },
        fileHolders: async () => [],
        ncl: async () => {
          throw new Error('Unknown release must not be queried');
        },
      });
      if (state === 'quiet') {
        await operation;
        await expect(lstat(installation.installationDir)).rejects.toMatchObject({ code: 'ENOENT' });
      } else {
        await expect(operation).rejects.toMatchObject({
          code: 'voice_drain_unproven',
          details: { instanceId: runtime.instance_id },
        });
        expect((await lstat(installation.installationDir)).isDirectory()).toBe(true);
      }
      expect((await readLocalVoicePolicy(paths)).installationDir).toBeNull();
    },
  );
  it('clears a missing selection so a subsequent install can repair it', async () => {
    const installation = await assets();
    await policy(installation);
    await rm(installation.installationDir, { recursive: true });
    await uninstallLocalVoice(paths, { fileHolders: async () => [] });
    expect((await readLocalVoicePolicy(paths)).installationDir).toBeNull();
  });
  it('refuses a symlinked cache ancestor before touching external directories', async () => {
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
  it.each([false, true])('reuses one inspected snapshot while preserving recent failure=%s', async (failed) => {
    const runtime = await assistant(33100);
    const installation = await assets();
    await policy(installation, true);
    const at = new Date().toISOString();
    const ncl = vi.fn(async () =>
      health({
        enabled: true,
        readiness: 'ready',
        reason: undefined,
        lastOutcome: { status: 'recognized', at },
        lastFailure: failed ? { reason: 'recognition-timeout', at } : null,
      }),
    );
    const inspection = await inspectVoiceCapability(paths, {
      instanceId: runtime.instance_id,
      checkConsumers: true,
      ncl,
    });
    const assetReads = vi.mocked(verifyVoiceInstallation).mock.calls.length;
    const observation = await observeLocalVoice(paths, runtime, ncl, inspection);
    expect(observation).toMatchObject({
      status: failed ? 'degraded' : 'ok',
      readiness: 'ready',
      last_outcome: { status: 'recognized', at },
      last_failure: failed ? { reason: 'recognition-timeout', at } : null,
    });
    expect(ncl).toHaveBeenCalledOnce();
    expect(vi.mocked(verifyVoiceInstallation).mock.calls.length).toBe(assetReads);
  });

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
  it('lists local connector records without hashing assets, querying a host, or installing anything', async () => {
    const installation = await assets();
    await policy(installation, true);
    const { verifyVoiceInstallation } = await import('./voice-assets.js');
    vi.mocked(verifyVoiceInstallation).mockClear();
    const answer = await invoke(['connectors', 'list']);
    expect(answer).toMatchObject({
      exit: 0,
      result: {
        command: 'connectors list',
        changed: false,
        data: {
          connectors: expect.arrayContaining([
            expect.objectContaining({
              name: 'voice',
              setup: 'installed',
              readiness: { status: 'not_checked', checked: false },
              details: expect.objectContaining({ assets: expect.objectContaining({ status: 'recorded' }) }),
            }),
          ]),
        },
      },
    });
    expect(verifyVoiceInstallation).not.toHaveBeenCalled();
    expect(hostProbe).not.toHaveBeenCalled();
    expect(installer.build).not.toHaveBeenCalled();
  });
  it('installs once for two current assistants and reports automatic host availability', async () => {
    const first = await assistant(34000);
    const second = await assistant(34100);
    const installation = await assets();
    installer.build.mockResolvedValue(installation);
    expect(await invoke(['connectors', 'install', 'voice', '--model', 'base'])).toMatchObject({
      exit: 0,
      result: { command: 'connectors install voice', changed: true, data: { enabled: true } },
    });
    for (const runtime of [first, second])
      expect(await readFile(path.join(runtime.state_root, '.env'), 'utf8')).toContain(voicePolicyFile(paths));
    expect(await invoke(['connectors', 'show', 'voice'])).toMatchObject({
      exit: 0,
      result: {
        changed: false,
        data: {
          setup: 'installed',
          readiness: { status: 'not_checked', checked: false },
          details: { activation: { status: 'enabled' }, assets: { status: 'recorded', selected_model: 'base' } },
        },
      },
    });
    expect(hostProbe).not.toHaveBeenCalled();
  });
  it('returns a failed check with independent observed, unreachable and unsupported consumer facts without repair', async () => {
    const active = await assistant(34300);
    const unreachable = await assistant(34400);
    const unsupported = await assistant(34500, false);
    const installation = await assets();
    await policy(installation, true);
    installed.clear();
    hostProbe.mockImplementation(async (runtime) => {
      if (runtime.instance_id === unreachable.instance_id) throw new Error('host unreachable');
      return health({ queued: 2, inflight: 1 });
    });
    const before = await readFile(voicePolicyFile(paths), 'utf8');
    const beforeMetadata = await lstat(voicePolicyFile(paths));
    expect(await invoke(['connectors', 'check', 'voice'])).toMatchObject({
      exit: 1,
      result: {
        changed: false,
        error: { code: 'voice_not_ready' },
        data: {
          details: {
            assets: { status: 'invalid' },
            assistants: expect.arrayContaining([
              expect.objectContaining({
                instance_id: active.instance_id,
                consumer: { status: 'observed', queued: 2, inflight: 1, enabled: false },
              }),
              expect.objectContaining({
                instance_id: unreachable.instance_id,
                consumer: { status: 'unknown', queued: null, inflight: null, enabled: null },
              }),
              expect.objectContaining({
                instance_id: unsupported.instance_id,
                compatibility: 'unsupported',
                consumer: expect.objectContaining({ status: 'not-applicable' }),
              }),
            ]),
          },
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
  });
  it('retains policy uncertainty and excludes external bytes from managed installation', async () => {
    const installation = await assets();
    const external = { ...installation, installationDir: root };
    installed.set(root, external);
    await policy(external);
    expect(await invoke(['connectors', 'show', 'voice'])).toMatchObject({
      exit: 0,
      result: { data: { details: { assets: { status: 'invalid' } } } },
    });
    await writeFile(voicePolicyFile(paths), '{');
    expect(await invoke(['connectors', 'show', 'voice'])).toMatchObject({
      exit: 0,
      result: {
        data: { details: { activation: { status: 'unknown', enabled: null }, assets: { status: 'unknown' } } },
      },
    });
  });
});
