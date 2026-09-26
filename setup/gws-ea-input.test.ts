import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { runCli } from '../src/gws-ea/cli.js';
import type { SecretSource } from '../src/gws-ea/create-input.js';
import { resolveControlPlanePaths } from '../src/gws-ea/paths.js';
import type { Prerequisites } from '../src/gws-ea/prerequisites.js';
import type { SetupProviderEntry } from './providers/registry.js';
import { authenticateGwsEaProvider, collectGwsEaCreateInput } from './gws-ea-input.js';

const prerequisites: Prerequisites = {
  onecliCliPath: '/opt/homebrew/bin/onecli',
  nodePath: '/opt/homebrew/bin/node',
  homeDirectory: '/Users/principal',
  platform: 'macos',
  runningAsRoot: false,
  dockerEndpoint: 'unix:///Users/principal/.docker/run/docker.sock',
  account: 'operator@example.test',
};
const providerCapabilityDigest = 'a'.repeat(64);
const NO_SECRETS: SecretSource = { get: () => undefined };

function provider(value: string, label: string): SetupProviderEntry {
  return {
    value,
    label,
    hint: `${label} hint`,
    provisioning: {
      credentialMetadata: () => ({
        name: `${label} credential`,
        type: value,
        hostPattern: `api.${value}.example`,
      }),
      collectCredential: vi.fn(async () => ({
        credential: {
          name: `${label} credential`,
          type: value,
          value: `${value}-secret`,
          hostPattern: `api.${value}.example`,
        },
        method: 'test',
      })),
    },
  };
}

describe('GWS-EA interactive create input', () => {
  it('derives display names, defaults timezone from the system, auto-selects the sole provider, and keeps --endpoint off Cloudflare', async () => {
    const claude = provider('claude', 'Claude');
    const text = vi
      .fn()
      .mockResolvedValueOnce('Ada')
      .mockResolvedValueOnce('Lovelace')
      .mockResolvedValueOnce('Taslim')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('America/Los_Angeles');
    const select = vi.fn();
    const discoverZones = vi.fn();

    const result = await collectGwsEaCreateInput(
      {
        instanceId: '11111111-1111-4111-8111-111111111111',
        prerequisites,
        sourceRemote: 'https://example.test/nanoclaw.git',
        secrets: NO_SECRETS,
        track: 'dogfood',
        provided: {
          endpoint: 'https://assistant.example.test/webhook/gchat',
          'workspace-email': 'ada@example.test',
        },
        managedIngressSetup: { discoverZones, retainAccountToken: vi.fn(), clearAccountToken: vi.fn() },
      },
      {
        providers: [claude],
        detectedTimezone: 'America/Los_Angeles',
        providerCapabilityDigest,
        prompts: {
          note: vi.fn(),
          text,
          password: vi.fn(),
          confirm: vi.fn(),
          select,
          isCancel: () => false,
          logInfo: vi.fn(),
        },
      },
    );

    expect(select).not.toHaveBeenCalled();
    expect(discoverZones).not.toHaveBeenCalled();
    expect(text).toHaveBeenCalledTimes(5);
    expect(text).toHaveBeenNthCalledWith(
      5,
      expect.objectContaining({ message: 'Principal timezone', initialValue: 'America/Los_Angeles' }),
    );
    expect(result).toEqual({
      ingress: { mode: 'existing', endpointUrl: 'https://assistant.example.test/webhook/gchat' },
      assistantWorkspaceEmail: 'ada@example.test',
      bootstrapManifest: {
        schema_version: 1,
        onecli_cli_path: '/opt/homebrew/bin/onecli',
        node_path: '/opt/homebrew/bin/node',
        home_directory: '/Users/principal',
        platform: 'macos',
        running_as_root: false,
        docker_endpoint: 'unix:///Users/principal/.docker/run/docker.sock',
        provider_capability_digest: providerCapabilityDigest,
        provider: {
          id: 'claude',
          name: 'Claude credential',
          type: 'claude',
          host_pattern: 'api.claude.example',
          header_name: null,
          value_format: null,
          path_pattern: null,
          param_name: null,
          param_format: null,
        },
        identity: {
          assistant_display_name: 'Ada Lovelace',
          principal_display_name: 'Taslim',
          principal_timezone: 'America/Los_Angeles',
        },
        selected_messaging_group_id: null,
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/principal.*email/iu);
  });

  it('offers only composed providers and uses the selected provider metadata', async () => {
    const claude = provider('claude', 'Claude');
    const codex = provider('codex', 'Codex');
    const text = vi
      .fn()
      .mockResolvedValueOnce('Aya')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('Taslim')
      .mockResolvedValueOnce('Khan')
      .mockResolvedValueOnce('UTC');
    const select = vi.fn(async () => 'codex');

    const result = await collectGwsEaCreateInput(
      {
        instanceId: '11111111-1111-4111-8111-111111111111',
        prerequisites,
        sourceRemote: 'https://example.test/nanoclaw.git',
        secrets: NO_SECRETS,
        track: 'prod',
        provided: {
          endpoint: 'https://aya.example.test/webhook/gchat',
          'workspace-email': 'aya@example.test',
        },
      },
      {
        providers: [claude, codex],
        detectedTimezone: 'UTC',
        providerCapabilityDigest,
        prompts: {
          note: vi.fn(),
          text,
          password: vi.fn(),
          confirm: vi.fn(),
          select,
          isCancel: () => false,
          logInfo: vi.fn(),
        },
      },
    );

    expect(select).toHaveBeenCalledWith({
      message: 'Which agent runtime should power your assistant?',
      options: [
        { value: 'claude', label: 'Claude', hint: 'Claude hint' },
        { value: 'codex', label: 'Codex', hint: 'Codex hint' },
      ],
    });
    expect(result.bootstrapManifest.provider.id).toBe('codex');
    expect(result.bootstrapManifest.identity.principal_display_name).toBe('Taslim Khan');
  });

  it('attaches focused validation to prompted timezone, email, and endpoint fields', async () => {
    const validators = new Map<string, (value: string | undefined) => string | undefined>();
    const answers = ['Aya', '', 'Taslim', '', 'UTC', 'aya@example.test', 'https://example.test/webhook/gchat'];
    const prompts = {
      note: vi.fn(),
      text: vi.fn(
        async (options: { message: string; validate?: (value: string | undefined) => string | undefined }) => {
          if (options.validate) validators.set(options.message, options.validate);
          return answers.shift();
        },
      ),
      select: vi.fn(async () => 'existing'),
      password: vi.fn(),
      confirm: vi.fn(),
      isCancel: () => false,
      logInfo: vi.fn(),
    };

    await collectGwsEaCreateInput(
      {
        instanceId: '11111111-1111-4111-8111-111111111111',
        prerequisites,
        sourceRemote: 'https://example.test/nanoclaw.git',
        secrets: NO_SECRETS,
        track: 'prod',
        provided: {},
      },
      {
        providers: [provider('claude', 'Claude')],
        detectedTimezone: 'UTC',
        providerCapabilityDigest,
        prompts,
      },
    );

    expect(validators.get('Principal timezone')?.('Not/A_Timezone')).toMatch(/valid IANA timezone/u);
    expect(validators.get('Assistant Google Workspace email')?.('not-an-email')).toMatch(/valid email/u);
    expect(validators.get('Existing Google Chat webhook endpoint')?.('https://example.test/not-webhook')).toMatch(
      /webhook\/gchat/u,
    );
  });

  it('collects a managed Cloudflare claim without serializing the run-scoped token', async () => {
    const retained: string[] = [];
    const discoverZones = vi.fn(async (token: string) => {
      expect(token).toBe('cloudflare-token-canary');
      return [
        {
          accountId: 'a'.repeat(32),
          accountName: 'Principal account',
          zoneId: 'b'.repeat(32),
          name: 'example.com',
          status: 'active' as const,
        },
      ];
    });
    const text = vi
      .fn()
      .mockResolvedValueOnce('Aya')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('Taslim')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('UTC')
      .mockResolvedValueOnce('aya');
    const select = vi.fn(async () => 'managed-cloudflare');
    const password = vi.fn(async () => 'cloudflare-token-canary');
    const confirm = vi.fn(async () => true);

    const note = vi.fn();
    const result = await collectGwsEaCreateInput(
      {
        instanceId: '11111111-1111-4111-8111-111111111111',
        prerequisites,
        sourceRemote: 'https://example.test/nanoclaw.git',
        secrets: NO_SECRETS,
        track: 'prod',
        provided: {
          'workspace-email': 'aya@example.test',
        },
        managedIngressSetup: {
          discoverZones,
          retainAccountToken: (token) => retained.push(token),
          clearAccountToken: vi.fn(),
        },
      },
      {
        providers: [provider('claude', 'Claude')],
        detectedTimezone: 'UTC',
        providerCapabilityDigest,
        prompts: {
          note,
          text,
          password,
          confirm,
          select,
          isCancel: () => false,
          logInfo: vi.fn(),
        },
      },
    );

    expect(discoverZones).toHaveBeenCalledOnce();
    const cloudflareGuidance = note.mock.calls.find((call) => call[1] === 'Cloudflare access')?.[0];
    expect(cloudflareGuidance).toContain('https://dash.cloudflare.com/profile/api-tokens');
    expect(cloudflareGuidance).toContain('Account-owned tokens: https://dash.cloudflare.com/?to=/:account/api-tokens');
    expect(cloudflareGuidance).toContain('Cloudflare Tunnel: Edit');
    expect(cloudflareGuidance).toContain('Zone: Read');
    expect(cloudflareGuidance).toContain('DNS: Edit');
    expect(note.mock.invocationCallOrder[1]).toBeLessThan(password.mock.invocationCallOrder[0]!);
    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'How should Google Chat reach this assistant?',
      }),
    );
    expect(confirm).toHaveBeenCalledWith({
      message:
        'Reserve aya.example.com for this assistant?\nGoogle Chat callback: https://aya.example.com/webhook/gchat',
      initialValue: true,
    });
    expect(result.ingress).toEqual({
      mode: 'managed-cloudflare',
      accountId: 'a'.repeat(32),
      zoneId: 'b'.repeat(32),
      zoneName: 'example.com',
      hostname: 'aya.example.com',
      callbackUrl: 'https://aya.example.com/webhook/gchat',
    });
    expect(retained).toEqual(['cloudflare-token-canary']);
    expect(JSON.stringify(result)).not.toContain('cloudflare-token-canary');
  });

  it('prompts for a zone only when the token exposes more than one active zone', async () => {
    const zoneSelect = vi.fn(async (options: { message: string }) =>
      options.message === 'Which Cloudflare zone should host the assistant?' ? 'd'.repeat(32) : 'managed-cloudflare',
    );
    const text = vi
      .fn()
      .mockResolvedValueOnce('Aya')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('Taslim')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('UTC')
      .mockResolvedValueOnce('aya');

    const result = await collectGwsEaCreateInput(
      {
        instanceId: '11111111-1111-4111-8111-111111111111',
        prerequisites,
        sourceRemote: 'https://example.test/nanoclaw.git',
        secrets: NO_SECRETS,
        track: 'prod',
        provided: {
          'workspace-email': 'aya@example.test',
        },
        managedIngressSetup: {
          discoverZones: async () => [
            {
              accountId: 'a'.repeat(32),
              accountName: 'Principal account',
              zoneId: 'b'.repeat(32),
              name: 'example.com',
              status: 'active',
            },
            {
              accountId: 'c'.repeat(32),
              accountName: 'Second account',
              zoneId: 'd'.repeat(32),
              name: 'example.net',
              status: 'active',
            },
          ],
          retainAccountToken: vi.fn(),
          clearAccountToken: vi.fn(),
        },
      },
      {
        providers: [provider('claude', 'Claude')],
        detectedTimezone: 'UTC',
        providerCapabilityDigest,
        prompts: {
          note: vi.fn(),
          text,
          password: vi.fn(async () => 'token'),
          confirm: vi.fn(async () => true),
          select: zoneSelect,
          isCancel: () => false,
          logInfo: vi.fn(),
        },
      },
    );

    expect(result.ingress).toMatchObject({
      accountId: 'c'.repeat(32),
      zoneId: 'd'.repeat(32),
      hostname: 'aya.example.net',
    });
    expect(zoneSelect).toHaveBeenCalledTimes(2);
  });

  it('does not retain Cloudflare authority when hostname confirmation is declined', async () => {
    const retainAccountToken = vi.fn();
    const answers = ['Aya', '', 'Taslim', '', 'UTC', 'aya'];

    await expect(
      collectGwsEaCreateInput(
        {
          instanceId: '11111111-1111-4111-8111-111111111111',
          prerequisites,
          sourceRemote: 'https://example.test/nanoclaw.git',
          secrets: NO_SECRETS,
          track: 'prod',
          provided: {
            'workspace-email': 'aya@example.test',
          },
          managedIngressSetup: {
            discoverZones: async () => [
              {
                accountId: 'a'.repeat(32),
                accountName: 'Principal account',
                zoneId: 'b'.repeat(32),
                name: 'example.com',
                status: 'active',
              },
            ],
            retainAccountToken,
            clearAccountToken: vi.fn(),
          },
        },
        {
          providers: [provider('claude', 'Claude')],
          detectedTimezone: 'UTC',
          providerCapabilityDigest,
          prompts: {
            note: vi.fn(),
            text: vi.fn(async () => answers.shift()),
            password: vi.fn(async () => 'token'),
            confirm: vi.fn(async () => false),
            select: vi.fn(async () => 'managed-cloudflare'),
            isCancel: () => false,
            logInfo: vi.fn(),
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(retainAccountToken).not.toHaveBeenCalled();
  });
});

describe('GWS-EA provider authentication', () => {
  it('delegates credential collection to the selected composed provider', async () => {
    const claude = provider('claude', 'Claude');

    await expect(authenticateGwsEaProvider('claude', [claude])).resolves.toEqual({
      name: 'Claude credential',
      type: 'claude',
      value: 'claude-secret',
      hostPattern: 'api.claude.example',
    });
    expect(claude.provisioning?.collectCredential).toHaveBeenCalledWith({
      allowSkip: false,
      allowAmbientConfiguration: false,
    });
  });
});

describe('GWS-EA unattended create input', () => {
  const unattendedPrompts = {
    note: vi.fn(),
    text: vi.fn(async () => {
      throw new Error('unattended input must not prompt');
    }),
    password: vi.fn(async () => {
      throw new Error('unattended input must not prompt');
    }),
    confirm: vi.fn(async () => {
      throw new Error('unattended input must not prompt');
    }),
    select: vi.fn(async () => {
      throw new Error('unattended input must not prompt');
    }),
    isCancel: () => false,
    logInfo: vi.fn(),
  };
  const FLAGS = {
    'assistant-first-name': 'Aya',
    'principal-first-name': 'Taslim',
    'principal-last-name': 'Khan',
    'principal-timezone': 'America/Los_Angeles',
    'workspace-email': 'aya@example.test',
    endpoint: 'https://aya.example.test/webhook/gchat',
  } as const;

  function unattended(provided: Record<string, string>, secrets: SecretSource = NO_SECRETS, extra = {}) {
    return collectGwsEaCreateInput(
      {
        instanceId: '11111111-1111-4111-8111-111111111111',
        prerequisites,
        sourceRemote: 'https://example.test/nanoclaw.git',
        secrets,
        track: 'dogfood',
        provided,
        ...extra,
      },
      {
        interactive: false,
        providers: [provider('claude', 'Claude')],
        detectedTimezone: 'UTC',
        providerCapabilityDigest,
        prompts: unattendedPrompts,
      },
    );
  }

  it('builds the full answer from flags alone', async () => {
    const result = await unattended(FLAGS);

    expect(result.ingress).toEqual({ mode: 'existing', endpointUrl: 'https://aya.example.test/webhook/gchat' });
    expect(result.bootstrapManifest.identity).toEqual({
      assistant_display_name: 'Aya',
      principal_display_name: 'Taslim Khan',
      principal_timezone: 'America/Los_Angeles',
    });
    expect(unattendedPrompts.text).not.toHaveBeenCalled();
  });

  it.each(['assistant-first-name', 'principal-first-name', 'principal-timezone', 'workspace-email'] as const)(
    'names --%s when it is missing',
    async (flag) => {
      const { [flag]: _omitted, ...provided } = FLAGS;
      await expect(unattended(provided)).rejects.toMatchObject({
        code: 'input_required',
        message: expect.stringContaining(`--${flag}`),
      });
    },
  );

  it('validates flag values like prompted ones, naming the flag', async () => {
    await expect(unattended({ ...FLAGS, 'principal-timezone': 'Not/A_Zone' })).rejects.toMatchObject({
      code: 'invalid_arguments',
      message: expect.stringContaining('--principal-timezone'),
    });
    await expect(unattended({ ...FLAGS, 'workspace-email': 'not-an-email' })).rejects.toMatchObject({
      message: expect.stringContaining('--workspace-email'),
    });
    await expect(unattended({ ...FLAGS, 'workspace-email': 'aya@gmail.com' })).rejects.toMatchObject({
      code: 'invalid_arguments',
      message: expect.stringMatching(/--workspace-email.*Google Workspace/su),
    });
  });

  it('collects managed Cloudflare ingress from flags and the supplied token', async () => {
    const retained: string[] = [];
    const { endpoint: _endpoint, ...base } = FLAGS;
    const result = await unattended(
      { ...base, ingress: 'managed-cloudflare', 'cloudflare-zone': 'example.net', 'hostname-label': 'aya' },
      { get: (name) => (name === 'cloudflareAccountToken' ? 'supplied-cloudflare-token' : undefined) },
      {
        managedIngressSetup: {
          discoverZones: async () => [
            {
              accountId: 'a'.repeat(32),
              accountName: 'A',
              zoneId: 'b'.repeat(32),
              name: 'example.com',
              status: 'active',
            },
            {
              accountId: 'c'.repeat(32),
              accountName: 'C',
              zoneId: 'd'.repeat(32),
              name: 'example.net',
              status: 'active',
            },
          ],
          retainAccountToken: (token: string) => retained.push(token),
          clearAccountToken: vi.fn(),
        },
      },
    );

    expect(result.ingress).toEqual({
      mode: 'managed-cloudflare',
      accountId: 'c'.repeat(32),
      zoneId: 'd'.repeat(32),
      zoneName: 'example.net',
      hostname: 'aya.example.net',
      callbackUrl: 'https://aya.example.net/webhook/gchat',
    });
    expect(retained).toEqual(['supplied-cloudflare-token']);
  });

  it('names the Cloudflare token variable when managed ingress has no token', async () => {
    const { endpoint: _endpoint, ...base } = FLAGS;
    await expect(
      unattended(
        { ...base, ingress: 'managed-cloudflare', 'cloudflare-zone': 'example.com', 'hostname-label': 'aya' },
        NO_SECRETS,
        { managedIngressSetup: { discoverZones: vi.fn(), retainAccountToken: vi.fn(), clearAccountToken: vi.fn() } },
      ),
    ).rejects.toMatchObject({
      code: 'input_required',
      message: expect.stringContaining('GWS_EA_CLOUDFLARE_API_TOKEN'),
    });
  });

  it('requires --provider only when more than one provider is composed', async () => {
    const providers = [provider('claude', 'Claude'), provider('codex', 'Codex')];
    const dependencies = {
      interactive: false,
      providers,
      detectedTimezone: 'UTC',
      providerCapabilityDigest,
      prompts: unattendedPrompts,
    };
    const base = {
      instanceId: '11111111-1111-4111-8111-111111111111',
      prerequisites,
      sourceRemote: 'https://example.test/nanoclaw.git',
      secrets: NO_SECRETS,
      track: 'dogfood',
    };
    await expect(collectGwsEaCreateInput({ ...base, provided: FLAGS }, dependencies)).rejects.toMatchObject({
      message: expect.stringContaining('--provider'),
    });
    const chosen = await collectGwsEaCreateInput({ ...base, provided: { ...FLAGS, provider: 'codex' } }, dependencies);
    expect(chosen.bootstrapManifest.provider.id).toBe('codex');
  });

  it('reaches the first pause of a scripted create without a person', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gws-ea-unattended-'));
    try {
      const paths = resolveControlPlanePaths({
        configRoot: path.join(root, 'config'),
        stateRoot: path.join(root, 'state'),
      });
      const out: string[] = [];
      const exitCode = await runCli(
        [
          'create',
          '--track',
          'dogfood',
          '--source-remote',
          '/srv/git/nanoclaw.git',
          ...Object.entries(FLAGS).flatMap(([flag, value]) => [`--${flag}`, value]),
        ],
        {
          paths,
          stdout: (line) => out.push(line),
          stderr: (line) => out.push(line),
          environment: {},
          collectCreateInputs: (context) =>
            collectGwsEaCreateInput(context, {
              interactive: false,
              providers: [provider('claude', 'Claude')],
              providerCapabilityDigest,
            }),
          checkPrerequisites: async () => ({ ...prerequisites, nodePath: process.execPath }),
          resolveRelease: async (sourceRemote, releaseRef) => ({ sourceRemote, releaseRef, commit: 'b'.repeat(40) }),
          holdLoopbackPorts: async () => ({
            ports: { nanoclaw_webhook: 35_101, onecli_app: 35_102, onecli_gateway: 35_103 },
            release: async () => undefined,
          }),
          advanceProvision: async () => ({
            status: 'paused',
            pause: {
              kind: 'human-action',
              phase: 'configure_channel',
              code: 'chat_configuration_required',
              message: "Finish this assistant's Google Chat app configuration, then confirm it.",
              resumeFlag: '--chat-configured',
            },
          }),
        },
      );

      expect(exitCode).toBe(10);
      const instanceId = out[0]!.slice('instance_id: '.length);
      expect(out).toContain(`Continue with: gws-ea resume --id ${instanceId} --chat-configured`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
