import { describe, expect, it, vi } from 'vitest';

import type { SetupProviderEntry } from './providers/registry.js';
import { authenticateGwsEaProvider, collectGwsEaCreateInput } from './gws-ea-input.js';

const runtime = {
  onecliCliPath: '/opt/homebrew/bin/onecli',
  nodePath: '/opt/homebrew/bin/node',
  homeDirectory: '/Users/principal',
  platform: 'macos' as const,
  runningAsRoot: false,
};
const providerCapabilityDigest = 'a'.repeat(64);

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
  it('derives display names, defaults timezone from the system, and auto-selects the sole composed provider', async () => {
    const claude = provider('claude', 'Claude');
    const text = vi
      .fn()
      .mockResolvedValueOnce('Ada')
      .mockResolvedValueOnce('Lovelace')
      .mockResolvedValueOnce('Taslim')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('America/Los_Angeles');
    const select = vi.fn();

    const result = await collectGwsEaCreateInput(
      {
        instanceId: '11111111-1111-4111-8111-111111111111',
        track: 'dogfood',
        provided: {
          'source-remote': 'https://example.test/nanoclaw.git',
          endpoint: 'https://assistant.example.test/webhook/gchat',
          'workspace-email': 'ada@example.test',
        },
      },
      {
        providers: [claude],
        detectedRuntime: runtime,
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
    expect(text).toHaveBeenNthCalledWith(
      5,
      expect.objectContaining({ message: 'Principal timezone', initialValue: 'America/Los_Angeles' }),
    );
    expect(result).toEqual({
      sourceRemote: 'https://example.test/nanoclaw.git',
      ingress: { mode: 'existing', endpointUrl: 'https://assistant.example.test/webhook/gchat' },
      assistantWorkspaceEmail: 'ada@example.test',
      bootstrapManifest: {
        schema_version: 1,
        onecli_cli_path: '/opt/homebrew/bin/onecli',
        node_path: '/opt/homebrew/bin/node',
        home_directory: '/Users/principal',
        platform: 'macos',
        running_as_root: false,
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
        track: 'prod',
        provided: {
          'source-remote': 'git@github.com:example/nanoclaw.git',
          endpoint: 'https://aya.example.test/webhook/gchat',
          'workspace-email': 'aya@example.test',
        },
      },
      {
        providers: [claude, codex],
        detectedRuntime: runtime,
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
        track: 'prod',
        provided: { 'source-remote': 'https://example.test/nanoclaw.git' },
      },
      {
        providers: [provider('claude', 'Claude')],
        detectedRuntime: runtime,
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

    const result = await collectGwsEaCreateInput(
      {
        instanceId: '11111111-1111-4111-8111-111111111111',
        track: 'prod',
        provided: {
          'source-remote': 'https://example.test/nanoclaw.git',
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
        detectedRuntime: runtime,
        detectedTimezone: 'UTC',
        providerCapabilityDigest,
        prompts: {
          note: vi.fn(),
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
        track: 'prod',
        provided: {
          'source-remote': 'https://example.test/nanoclaw.git',
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
        detectedRuntime: runtime,
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

  it('keeps --endpoint on the existing path without consulting Cloudflare', async () => {
    const discoverZones = vi.fn();
    const select = vi.fn();
    const text = vi
      .fn()
      .mockResolvedValueOnce('Aya')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('Taslim')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('UTC');

    const result = await collectGwsEaCreateInput(
      {
        instanceId: '11111111-1111-4111-8111-111111111111',
        track: 'prod',
        provided: {
          'source-remote': 'https://example.test/nanoclaw.git',
          endpoint: 'https://aya.example.test/webhook/gchat',
          'workspace-email': 'aya@example.test',
        },
        managedIngressSetup: {
          discoverZones,
          retainAccountToken: vi.fn(),
          clearAccountToken: vi.fn(),
        },
      },
      {
        providers: [provider('claude', 'Claude')],
        detectedRuntime: runtime,
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

    expect(result.ingress).toEqual({
      mode: 'existing',
      endpointUrl: 'https://aya.example.test/webhook/gchat',
    });
    expect(discoverZones).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
  });

  it('does not retain Cloudflare authority when hostname confirmation is declined', async () => {
    const retainAccountToken = vi.fn();
    const answers = ['Aya', '', 'Taslim', '', 'UTC', 'aya'];

    await expect(
      collectGwsEaCreateInput(
        {
          instanceId: '11111111-1111-4111-8111-111111111111',
          track: 'prod',
          provided: {
            'source-remote': 'https://example.test/nanoclaw.git',
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
          detectedRuntime: runtime,
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

  it.each([
    [
      'inactive zone',
      {
        accountId: 'a'.repeat(32),
        accountName: 'Principal account',
        zoneId: 'b'.repeat(32),
        name: 'example.com',
        status: 'pending',
      },
    ],
    [
      'partial zone',
      {
        accountId: 'a'.repeat(32),
        accountName: 'Principal account',
        zoneId: '',
        name: 'example.com',
        status: 'active',
      },
    ],
    [
      'malformed zone',
      {
        accountId: 'a'.repeat(32),
        accountName: 'Principal account',
        zoneId: 'b'.repeat(32),
        name: 'not a zone',
        status: 'active',
      },
    ],
  ])('rejects an %s returned by the discovery seam', async (_label, zone) => {
    const answers = ['Aya', '', 'Taslim', '', 'UTC'];
    await expect(
      collectGwsEaCreateInput(
        {
          instanceId: '11111111-1111-4111-8111-111111111111',
          track: 'prod',
          provided: {
            'source-remote': 'https://example.test/nanoclaw.git',
            'workspace-email': 'aya@example.test',
          },
          managedIngressSetup: {
            discoverZones: async () => [zone as never],
            retainAccountToken: vi.fn(),
            clearAccountToken: vi.fn(),
          },
        },
        {
          providers: [provider('claude', 'Claude')],
          detectedRuntime: runtime,
          detectedTimezone: 'UTC',
          providerCapabilityDigest,
          prompts: {
            note: vi.fn(),
            text: vi.fn(async () => answers.shift()),
            password: vi.fn(async () => 'token'),
            confirm: vi.fn(),
            select: vi.fn(async () => 'managed-cloudflare'),
            isCancel: () => false,
            logInfo: vi.fn(),
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'invalid_cloudflare_zone' });
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
