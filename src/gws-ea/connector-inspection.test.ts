import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { managedResult } from './result.js';
import { expectResultContract } from './testing/result-contract.js';
import { connectorLines, inspectConnector } from './connector-inspection.js';
import { deriveGcpClaims } from './gcp-identity.js';
import { reserveInstance } from './journal.js';
import { resolveControlPlanePaths, type ControlPlanePaths } from './paths.js';
import { installOnePassword, ONEPASSWORD_CONTRACT } from './onepassword.js';
import { onePasswordUninstallFile } from './onepassword-uninstall.js';
import { claimInstanceWeb, readRegistry } from './registry.js';
import { centralDatabaseFile } from './verify.js';
import { webOperatorFiles, readWebOperatorConfig, writeWebOperatorConfig } from './web-cloudflare.js';
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

async function assistant(marker: 'compatible' | 'unsupported' | 'unknown' = 'compatible', firstName?: string) {
  const id = randomUUID();
  const offset = Object.keys((await readRegistry(paths)).instances).length * 10;
  const reserved = await reserveInstance(paths, {
    instance_id: id,
    release_track: 'dogfood',
    source_remote: 'https://example.test/repo.git',
    deployed_commit: 'a'.repeat(40),
    allocated_ports: { onecli_app: 3201 + offset, onecli_gateway: 3202 + offset },
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
  if (marker !== 'unsupported')
    await writeFile(
      path.join(runtime.checkout_root, 'src/gws-ea/web-compatibility.json'),
      marker === 'unknown' ? '{' : JSON.stringify({ schemaVersion: 1, contract: 'gws-ea-web-1' }),
    );
  if (firstName !== undefined) {
    const file = centralDatabaseFile(runtime.state_root);
    await mkdir(path.dirname(file), { recursive: true });
    const database = new Database(file);
    try {
      database.exec('CREATE TABLE gws_ea_profile (singleton INTEGER PRIMARY KEY, assistant_first_name TEXT NOT NULL)');
      database.prepare('INSERT INTO gws_ea_profile VALUES (1, ?)').run(firstName);
    } finally {
      database.close();
    }
  }
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
async function webConfig(zoneApex = 'example.test') {
  const files = webOperatorFiles(paths);
  const credentialFile = path.join(files.root, 'management-token');
  await mkdir(files.root, { recursive: true, mode: 0o700 });
  await writeFile(credentialFile, 'fixture-token', { mode: 0o600 });
  await writeWebOperatorConfig(files.configFile, {
    schemaVersion: 1,
    accountId: 'account',
    teamName: 'team',
    zoneId: 'zone',
    zoneApex,
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
  it.each(['voice', 'onepassword', 'web'] as const)(
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
  it('keeps local onepassword and web reads free of provider requests', async () => {
    const provider = await installedOnePassword();
    await webConfig();
    const calls = provider.calls.length;
    const send = vi.fn<typeof fetch>(() => {
      throw new Error('Local observation called provider');
    });
    const command = vi.fn(() => {
      throw new Error('Local observation ran process');
    });
    for (const name of ['onepassword', 'web'] as const) {
      expect(
        await inspectConnector(paths, name, {
          onePassword: provider.cli(),
          web: { fetch: send, runCommand: command },
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
    await webConfig();
    const requests: string[] = [];
    const send: typeof fetch = async (input, init) => {
      requests.push(`${init?.method} ${new URL(String(input)).pathname}`);
      return new Response(JSON.stringify({ success: false }), { status: 403 });
    };
    const observed = await inspectConnector(paths, 'web', {
      check: true,
      web: {
        fetch: send,
        runCommand: async () => ({ exitCode: 0, stdout: 'cloudflared version 2025.4.0', stderr: '' }),
      },
    });
    expect(observed.readiness).toEqual({ status: 'not_ready', checked: true });
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((request) => request.startsWith('GET '))).toBe(true);
  });
  it('readies a configured artifact host only after verifying its account, zone, team and executable', async () => {
    await webConfig();
    const requests: string[] = [];
    const send: typeof fetch = async (input, init) => {
      const resource = new URL(String(input)).pathname;
      requests.push(`${init?.method} ${resource}`);
      const result = resource.endsWith('/zones/zone')
        ? { id: 'zone', status: 'active', name: 'example.test', account: { id: 'account' } }
        : { auth_domain: 'team.cloudflareaccess.com' };
      return new Response(JSON.stringify({ success: true, result }));
    };
    const observed = await inspectConnector(paths, 'web', {
      check: true,
      web: {
        fetch: send,
        runCommand: async () => ({ exitCode: 0, stdout: 'cloudflared version 2025.4.0', stderr: '' }),
      },
    });
    expect(observed.readiness).toEqual({ status: 'ready', checked: true });
    expect(requests).toEqual(['GET /client/v4/zones/zone', 'GET /client/v4/accounts/account/access/organizations']);
  });
  it('reports invalid local artifact configuration without hiding other connector observations', async () => {
    const files = await webConfig();
    await writeFile(files.configFile, '{', { mode: 0o600 });
    expect(await inspectConnector(paths, 'web')).toMatchObject({
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

it('shows addresses and local no-label and holder reasons without calling a provider, process or host', async () => {
  await webConfig();
  const holder = await assistant('compatible', 'Aya');
  await claimInstanceWeb(paths, holder, { hostname: 'aya.example.test', listen_port: 34002 });
  const duplicate = await assistant('compatible', 'Aya');
  const noLabel = await assistant('compatible', '123');
  const fetch = vi.fn<typeof globalThis.fetch>(() => {
    throw new Error('Local show called Cloudflare');
  });
  const runCommand = vi.fn(() => {
    throw new Error('Local show started a process');
  });
  const ncl = vi.fn(async () => {
    throw new Error('Local show queried a host');
  });
  const observed = await inspectConnector(paths, 'web', { web: { fetch, runCommand, ncl } });
  expect(observed.assistants.find(({ instance_id }) => instance_id === duplicate)).toMatchObject({
    setup: 'pending',
    reasons: [
      `aya.example.test is already held by assistant ${holder}. Recreate this assistant under another first name, or remove the holder.`,
    ],
    next_actions: [],
  });
  expect(observed.assistants.find(({ instance_id }) => instance_id === noLabel)).toMatchObject({
    setup: 'pending',
    reasons: [
      '“123” has no Latin letter for a web address. Recreate this assistant under a first name with a Latin letter.',
    ],
    next_actions: [],
  });
  expect(connectorLines(observed).join('\n')).toContain('https://aya.example.test');
  expectResultContract(
    'connectors show web',
    managedResult('connectors show web', { outcome: 'succeeded', data: observed }),
  );
  expect(fetch).not.toHaveBeenCalled();
  expect(runCommand).not.toHaveBeenCalled();
  expect(ncl).not.toHaveBeenCalled();
});

it('reports an unclaimed foreign DNS record during check using only GETs and leaves ownership untouched', async () => {
  const files = await webConfig();
  const id = await assistant('compatible', 'Aya');
  const before = await readFile(files.configFile, 'utf8');
  const requests: string[] = [];
  const observed = await inspectConnector(paths, 'web', {
    check: true,
    web: {
      runCommand: async () => ({ exitCode: 0, stdout: 'cloudflared version 2025.4.0', stderr: '' }),
      fetch: async (input, init) => {
        const url = new URL(String(input));
        requests.push(`${init?.method} ${url.pathname}${url.search}`);
        const result = url.pathname.endsWith('/zones/zone')
          ? { id: 'zone', status: 'active', name: 'example.test', account: { id: 'account' } }
          : url.pathname.endsWith('/access/organizations')
            ? { auth_domain: 'team.cloudflareaccess.com' }
            : [{ id: 'foreign-dns', name: 'aya.example.test' }];
        return Response.json({ success: true, result });
      },
    },
  });
  expect(observed.assistants).toContainEqual(
    expect.objectContaining({
      instance_id: id,
      setup: 'pending',
      readiness: { status: 'not_ready', checked: true },
      reasons: [expect.stringContaining('DNS record aya.example.test (foreign-dns)')],
    }),
  );
  expect(requests).toContain('GET /client/v4/zones/zone/dns_records?name=aya.example.test&per_page=100&page=1');
  expect(requests.every((request) => request.startsWith('GET '))).toBe(true);
  expect(await readFile(files.configFile, 'utf8')).toBe(before);
  expect((await readRegistry(paths)).instances[id].exclusive_resource_claims.web).toBeUndefined();
});

it.each([false, true])(
  'reports an overlong derived web hostname without hostname preflight (check: %s)',
  async (check) => {
    const zoneApex = ['a'.repeat(63), 'b'.repeat(63), 'c'.repeat(63), 'd'.repeat(59)].join('.');
    const files = await webConfig(zoneApex);
    const id = await assistant('compatible', 'Aa');
    const before = await readFile(files.configFile, 'utf8');
    const requests: string[] = [];
    const observed = await inspectConnector(paths, 'web', {
      check,
      web: {
        runCommand: async () => ({ exitCode: 0, stdout: 'cloudflared version 2025.4.0', stderr: '' }),
        fetch: async (input) => {
          const resource = new URL(String(input)).pathname;
          requests.push(resource);
          if (resource.endsWith('/zones/zone'))
            return Response.json({
              success: true,
              result: { id: 'zone', status: 'active', name: zoneApex, account: { id: 'account' } },
            });
          if (resource.endsWith('/access/organizations'))
            return Response.json({ success: true, result: { auth_domain: 'team.cloudflareaccess.com' } });
          throw new Error('Invalid hostname reached Cloudflare preflight');
        },
      },
    });
    expect(observed.assistants).toContainEqual(
      expect.objectContaining({
        instance_id: id,
        setup: 'pending',
        reasons: [expect.stringContaining('253-character DNS hostname limit')],
        next_actions: [],
      }),
    );
    expect(requests).toEqual(
      check ? ['/client/v4/zones/zone', '/client/v4/accounts/account/access/organizations'] : [],
    );
    expect(await readFile(files.configFile, 'utf8')).toBe(before);
    expect((await readRegistry(paths)).instances[id].exclusive_resource_claims.web).toBeUndefined();
  },
);

it('reports a pre-web release unsupported with update recovery and leaves its Cloudflare resources untouched', async () => {
  const files = await webConfig();
  const id = await assistant('unsupported');
  const claimed = await claimInstanceWeb(paths, id, { hostname: 'aya.example.test', listen_port: 34002 });
  const config = await readWebOperatorConfig(files.configFile);
  if (!config || !claimed.exclusive_resource_claims.web) throw new Error('Missing fixture ownership');
  await writeWebOperatorConfig(files.configFile, {
    ...config,
    tunnelId: 'owned-tunnel',
    pin: { id: 'owned-pin', owned: true },
    assistants: {
      [id]: {
        claim: claimed.exclusive_resource_claims.web,
        applicationId: 'owned-app',
        policyId: 'owned-policy',
        aud: 'owned-aud',
        enabled: true,
      },
    },
    dns: { 'aya.example.test': { id: 'owned-dns', zoneId: 'zone' } },
  });
  const before = await readFile(files.configFile, 'utf8');
  const requests: string[] = [];
  const observed = await inspectConnector(paths, 'web', {
    check: true,
    instanceId: id,
    web: {
      runCommand: async () => ({ exitCode: 0, stdout: 'cloudflared version 2025.4.0', stderr: '' }),
      fetch: async (input, init) => {
        const resource = new URL(String(input)).pathname;
        requests.push(`${init?.method} ${resource}`);
        const result = resource.endsWith('/zones/zone')
          ? { id: 'zone', status: 'active', name: 'example.test', account: { id: 'account' } }
          : { auth_domain: 'team.cloudflareaccess.com' };
        return Response.json({ success: true, result });
      },
    },
  });
  expect(observed).toMatchObject({
    compatibility: 'unsupported',
    readiness: { status: 'not_ready' },
    assistants: [
      {
        compatibility: 'unsupported',
        readiness: { status: 'not_checked', checked: false },
        next_actions: [{ kind: 'command', argv: ['gws-ea', 'update', '--id', id] }],
      },
    ],
  });
  expect(requests).toEqual(['GET /client/v4/zones/zone', 'GET /client/v4/accounts/account/access/organizations']);
  expect(await readFile(files.configFile, 'utf8')).toBe(before);
});
