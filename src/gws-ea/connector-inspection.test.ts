import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { managedResult } from './result.js';
import { expectResultContract } from './testing/result-contract.js';
import { connectorLines, inspectConnector } from './connector-inspection.js';
import { deriveGcpClaims } from './gcp-identity.js';
import { reserveInstance } from './journal.js';
import { resolveControlPlanePaths, type ControlPlanePaths } from './paths.js';
import { installOnePassword, ONEPASSWORD_CONTRACT } from './onepassword.js';
import { onePasswordUninstallFile } from './onepassword-uninstall.js';
import { artifactsOperatorFiles, writeArtifactsOperatorConfig } from './artifacts-cloudflare.js';
import { ACCOUNT_ID, FakeOnePassword } from './testing/onepassword-fixture.js';
import { voiceInstallationDirectory } from './install-voice.js';
import { voicePolicyFile } from './local-voice.js';
import * as voiceAssets from './voice-assets.js';
import { writePrivate } from '../community-portal/private-file.js';
import { persistTestRuntime } from './testing/runtime-fixture.js';
import type { NanoclawServiceHelpers } from './service-control.js';

let root: string;
let paths: ControlPlanePaths;
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'connector-observer-')));
  paths = resolveControlPlanePaths({ configRoot: path.join(root, 'config'), stateRoot: path.join(root, 'state') });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

async function assistant(marker: 'compatible' | 'unsupported' | 'unknown' = 'compatible') {
  const id = randomUUID();
  const reserved = await reserveInstance(paths, {
    instance_id: id,
    release_track: 'dogfood',
    source_remote: 'https://example.test/repo.git',
    deployed_commit: 'a'.repeat(40),
    allocated_ports: { onecli_app: 3201, onecli_gateway: 3202 },
    exclusive_resource_claims: {
      ...deriveGcpClaims(id),
      gcp_account: 'operator@example.test',
      workspace_email: `${id}@example.test`,
      onecli_project: `gws-ea-${id.replaceAll('-', '')}`,
    },
  });
  const runtime = await persistTestRuntime(paths, reserved);
  await mkdir(path.join(runtime.checkout_root, 'src/gws-ea'), { recursive: true });
  if (marker !== 'unsupported')
    await writeFile(
      path.join(runtime.checkout_root, 'src/gws-ea/onepassword-compatibility.json'),
      marker === 'unknown' ? '{' : JSON.stringify({ schemaVersion: 1, contract: ONEPASSWORD_CONTRACT }),
    );
  return id;
}
function services(active: boolean): NanoclawServiceHelpers {
  return {
    createCommandRunner: () => ({ run: () => '', tryRun: () => ({ ok: false, stdout: '' }) }),
    detectService: () => ({ mode: 'none', active }),
    stopService: async () => undefined,
    startService: () => undefined,
    drainContainers: async () => undefined,
    verifyServiceHealth: async () => active,
  };
}
async function installedOnePassword() {
  const provider = new FakeOnePassword();
  await installOnePassword(paths, { accountId: ACCOUNT_ID }, { cli: provider.cli(), upsertEnvVars: () => undefined });
  return provider;
}
async function artifactsConfig() {
  const files = artifactsOperatorFiles(paths);
  const credentialFile = path.join(files.root, 'management-token');
  await mkdir(files.root, { recursive: true, mode: 0o700 });
  await writeFile(credentialFile, 'fixture-token', { mode: 0o600 });
  await writeArtifactsOperatorConfig(files.configFile, {
    schemaVersion: 1,
    accountId: 'account',
    teamName: 'team',
    zoneId: 'zone',
    hostname: 'views.example.test',
    credentialFile,
    cloudflaredPath: '/opt/homebrew/bin/cloudflared',
    dns: {},
    assistants: {},
  });
  return files;
}

async function voiceInstallation(model: voiceAssets.VoiceModelId = 'base') {
  const directory = voiceInstallationDirectory(paths, model);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const entry = (file: string, size: number, sha256: string) => ({ file, size, sha256 });
  const receipt: voiceAssets.VoiceAssetReceipt = {
    schemaVersion: 1,
    recipe: voiceAssets.VOICE_RECIPE_ID,
    platform: process.platform === 'linux' ? 'linux' : 'darwin',
    architecture: process.arch === 'x64' ? 'x64' : 'arm64',
    model,
    builtAt: new Date().toISOString(),
    artifacts: {
      ffmpeg: entry('bin/ffmpeg', 1, '0'.repeat(64)),
      whisperCli: entry('bin/whisper-cli', 1, '0'.repeat(64)),
      model: entry(
        `models/${voiceAssets.VOICE_MODEL_CATALOG[model].filename}`,
        voiceAssets.VOICE_MODEL_CATALOG[model].size,
        voiceAssets.VOICE_MODEL_CATALOG[model].sha256,
      ),
      vad: entry(
        `models/${voiceAssets.VOICE_SOURCE_ARTIFACTS.vad.filename}`,
        voiceAssets.VOICE_SOURCE_ARTIFACTS.vad.size,
        voiceAssets.VOICE_SOURCE_ARTIFACTS.vad.sha256,
      ),
    },
  };
  await writeFile(path.join(directory, 'receipt.json'), JSON.stringify(receipt), { mode: 0o600 });
  await writePrivate(voicePolicyFile(paths), { schemaVersion: 1, enabled: true, installationDir: directory });
  return {
    installationDir: directory,
    ffmpeg: path.join(directory, 'bin/ffmpeg'),
    whisperCli: path.join(directory, 'bin/whisper-cli'),
    model: path.join(directory, receipt.artifacts.model.file),
    vad: path.join(directory, receipt.artifacts.vad.file),
    receipt,
  };
}

describe('uniform connector observations', () => {
  it.each(['voice', 'onepassword', 'artifacts'] as const)(
    'reports absent %s locally and a failed check without creating setup',
    async (name) => {
      const local = await inspectConnector(paths, name);
      const checked = await inspectConnector(paths, name, { check: true });
      expect(local).toMatchObject({ setup: 'not_installed', readiness: { status: 'not_checked', checked: false } });
      expect(checked).toMatchObject({ setup: 'not_installed', readiness: { status: 'not_ready', checked: true } });
      expectResultContract(
        `connectors show ${name}`,
        managedResult(`connectors show ${name}`, { outcome: 'succeeded', data: local }),
      );
      expectResultContract(
        `connectors check ${name}`,
        managedResult(`connectors check ${name}`, {
          outcome: 'failed',
          data: checked,
          error: new Error(`${name} is not ready`),
        }),
      );
    },
  );
  it('excludes a stopped pending assistant from the host check, but requires a selected target ready', async () => {
    const provider = await installedOnePassword();
    const id = await assistant();
    const options = { check: true, onePassword: provider.cli(), serviceHelpers: services(false) };
    const observed = await inspectConnector(paths, 'onepassword', options);
    expect(observed).toMatchObject({
      readiness: { status: 'ready' },
      assistants: [{ instance_id: id, setup: 'pending', readiness: { status: 'not_checked', checked: false } }],
    });
    expect(await inspectConnector(paths, 'onepassword', { ...options, instanceId: id })).toMatchObject({
      readiness: { status: 'not_ready' },
    });
  });
  it('reports an unreachable assistant as not checked without treating it as a failed host prerequisite', async () => {
    const provider = await installedOnePassword();
    await assistant();
    const hostStatus = {
      queryHost: async () => {
        throw new Error('Host socket is unreachable');
      },
    };
    expect(
      await inspectConnector(paths, 'onepassword', {
        check: true,
        onePassword: provider.cli(),
        serviceHelpers: services(true),
        hostStatus,
      }),
    ).toMatchObject({
      readiness: { status: 'ready' },
      assistants: [{ readiness: { status: 'not_checked', checked: false } }],
    });
  });
  it('fails an observed pending assistant and reports its setup fix', async () => {
    const provider = await installedOnePassword();
    await assistant();
    const observed = await inspectConnector(paths, 'onepassword', {
      check: true,
      onePassword: provider.cli(),
      serviceHelpers: services(true),
    });
    expect(observed.readiness.status).toBe('not_ready');
    expect(observed.assistants[0]).toMatchObject({
      setup: 'pending',
      next_actions: [{ kind: 'command', argv: ['gws-ea', 'connectors', 'install', 'onepassword'] }],
    });
  });
  it('excludes unsupported releases and reports update, while malformed markers stay unknown', async () => {
    const provider = await installedOnePassword();
    const id = await assistant('unsupported');
    const options = { check: true, onePassword: provider.cli(), serviceHelpers: services(true) };
    const observed = await inspectConnector(paths, 'onepassword', options);
    expect(observed.readiness.status).toBe('ready');
    expect(observed.assistants[0]).toMatchObject({
      compatibility: 'unsupported',
      next_actions: [{ kind: 'command', argv: ['gws-ea', 'update', '--id', id] }],
    });
    expect(await inspectConnector(paths, 'onepassword', { ...options, instanceId: id })).toMatchObject({
      readiness: { status: 'not_ready' },
    });
    const marker = path.join(paths.checkoutRoot(id), 'src/gws-ea/onepassword-compatibility.json');
    await writeFile(marker, '{');
    expect(await inspectConnector(paths, 'onepassword', options)).toMatchObject({
      readiness: { status: 'not_ready' },
      assistants: [{ compatibility: 'unknown' }],
    });
  });
  it('reads an installed voice receipt without hashing any asset or querying a host', async () => {
    await voiceInstallation();
    const verify = vi.spyOn(voiceAssets, 'verifyVoiceInstallation');
    const ncl = vi.fn(() => {
      throw new Error('Local observation queried host');
    });
    const observed = await inspectConnector(paths, 'voice', { voice: { ncl } });
    expect(observed).toMatchObject({
      setup: 'installed',
      readiness: { status: 'not_checked' },
      details: { assets: { status: 'recorded', selected_model: 'base' } },
    });
    expect(verify).not.toHaveBeenCalled();
    expect(ncl).not.toHaveBeenCalled();
  });
  it('checks voice host assets but does not query a stopped consumer', async () => {
    const installed = await voiceInstallation();
    vi.spyOn(voiceAssets, 'verifyVoiceInstallation').mockResolvedValue(installed);
    const id = await assistant();
    await writeFile(
      path.join(paths.checkoutRoot(id), 'src/gws-ea/voice-compatibility.json'),
      JSON.stringify({ schemaVersion: 1, recipe: voiceAssets.VOICE_RECIPE_ID }),
    );
    const ncl = vi.fn(() => {
      throw new Error('Stopped assistant queried');
    });
    expect(
      await inspectConnector(paths, 'voice', { check: true, voice: { ncl }, serviceHelpers: services(false) }),
    ).toMatchObject({
      readiness: { status: 'ready' },
      assistants: [{ instance_id: id, readiness: { status: 'not_checked' } }],
    });
    expect(ncl).not.toHaveBeenCalled();
  });
  it('preserves the selected non-default model in installed, stopped voice recovery', async () => {
    const installed = await voiceInstallation('small');
    await writePrivate(voicePolicyFile(paths), {
      schemaVersion: 1,
      enabled: false,
      installationDir: installed.installationDir,
    });
    const observed = await inspectConnector(paths, 'voice');
    expect(observed.next_actions).toContainEqual({
      kind: 'command',
      argv: ['gws-ea', 'connectors', 'install', 'voice', '--model', 'small'],
    });
    expect(observed.reasons).toContain(
      'Installed, stopped. Run gws-ea connectors install voice --model small to make recognition available.',
    );
  });
  it('preserves the selected non-default model in not-ready voice consumer recovery', async () => {
    const installed = await voiceInstallation('small');
    vi.spyOn(voiceAssets, 'verifyVoiceInstallation').mockResolvedValue(installed);
    const id = await assistant();
    await writeFile(
      path.join(paths.checkoutRoot(id), 'src/gws-ea/voice-compatibility.json'),
      JSON.stringify({ schemaVersion: 1, recipe: voiceAssets.VOICE_RECIPE_ID }),
    );
    const observed = await inspectConnector(paths, 'voice', {
      check: true,
      voice: {
        ncl: async () => ({
          schemaVersion: 1,
          recipe: voiceAssets.VOICE_RECIPE_ID,
          enabled: true,
          readiness: 'unavailable',
          queued: 0,
          inflight: 0,
          lastOutcome: null,
          lastFailure: null,
        }),
      },
    });
    expect(observed.assistants[0]?.next_actions).toContainEqual({
      kind: 'command',
      argv: ['gws-ea', 'connectors', 'install', 'voice', '--model', 'small'],
    });
  });
  it('keeps local onepassword and artifacts reads free of provider requests', async () => {
    const provider = await installedOnePassword();
    await artifactsConfig();
    const calls = provider.calls.length;
    const send = vi.fn<typeof fetch>(() => {
      throw new Error('Local observation called provider');
    });
    const command = vi.fn(() => {
      throw new Error('Local observation ran process');
    });
    for (const name of ['onepassword', 'artifacts'] as const) {
      expect(
        await inspectConnector(paths, name, {
          onePassword: provider.cli(),
          artifacts: { fetch: send, runCommand: command },
        }),
      ).toMatchObject({ setup: 'installed', readiness: { checked: false, status: 'not_checked' } });
    }
    expect(provider.calls).toHaveLength(calls);
    expect(send).not.toHaveBeenCalled();
    expect(command).not.toHaveBeenCalled();
  });
  it('keeps account usage and untested writes in the human details', async () => {
    const provider = await installedOnePassword();
    const observation = await inspectConnector(paths, 'onepassword', { check: true, onePassword: provider.cli() });
    const human = connectorLines(observation).join('\n');
    expect(human).toContain('Account type: families');
    expect(human).toContain('Daily requests:');
    expect(human).toContain('a recorded write grant is not a tested write');
  });
  it('verifies artifact host prerequisites even when no assistant exists', async () => {
    await artifactsConfig();
    const requests: string[] = [];
    const send: typeof fetch = async (input, init) => {
      requests.push(`${init?.method} ${new URL(String(input)).pathname}`);
      return new Response(JSON.stringify({ success: false }), { status: 403 });
    };
    const observed = await inspectConnector(paths, 'artifacts', {
      check: true,
      artifacts: {
        fetch: send,
        runCommand: async () => ({ exitCode: 0, stdout: 'cloudflared version 2025.4.0', stderr: '' }),
      },
    });
    expect(observed.readiness).toEqual({ status: 'not_ready', checked: true });
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((request) => request.startsWith('GET '))).toBe(true);
  });
  it('readies a configured artifact host only after verifying its account, zone, team and executable', async () => {
    await artifactsConfig();
    const requests: string[] = [];
    const send: typeof fetch = async (input, init) => {
      const resource = new URL(String(input)).pathname;
      requests.push(`${init?.method} ${resource}`);
      const result = resource.endsWith('/zones/zone')
        ? { id: 'zone', status: 'active', name: 'example.test', account: { id: 'account' } }
        : { auth_domain: 'team.cloudflareaccess.com' };
      return new Response(JSON.stringify({ success: true, result }));
    };
    const observed = await inspectConnector(paths, 'artifacts', {
      check: true,
      artifacts: {
        fetch: send,
        runCommand: async () => ({ exitCode: 0, stdout: 'cloudflared version 2025.4.0', stderr: '' }),
      },
    });
    expect(observed.readiness).toEqual({ status: 'ready', checked: true });
    expect(requests).toEqual(['GET /client/v4/zones/zone', 'GET /client/v4/accounts/account/access/organizations']);
  });
  it('reports invalid local artifact configuration without hiding other connector observations', async () => {
    const files = await artifactsConfig();
    await writeFile(files.configFile, '{', { mode: 0o600 });
    expect(await inspectConnector(paths, 'artifacts')).toMatchObject({
      setup: 'unknown',
      readiness: { checked: false },
    });
  });
  it('shows incomplete uninstall and the rerun command without querying provider', async () => {
    const provider = await installedOnePassword();
    const file = onePasswordUninstallFile(paths);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(
      file,
      JSON.stringify({
        schema_version: 1,
        account_id: ACCOUNT_ID,
        management_service_account_id: null,
        management_creation_unproven: false,
        started_at: new Date().toISOString(),
        assistants: {},
        completed: false,
        history: [],
      }),
      { mode: 0o600 },
    );
    const calls = provider.calls.length;
    const observed = await inspectConnector(paths, 'onepassword', { check: true, onePassword: provider.cli() });
    expect(observed).toMatchObject({
      setup: 'uninstall_incomplete',
      readiness: { status: 'not_ready' },
      next_actions: [{ kind: 'command', argv: ['gws-ea', 'connectors', 'uninstall', 'onepassword'] }],
    });
    expect(provider.calls).toHaveLength(calls);
  });
});
