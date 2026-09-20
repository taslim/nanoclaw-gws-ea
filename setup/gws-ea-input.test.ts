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
        prompts: { note: vi.fn(), text, select, isCancel: () => false, logInfo: vi.fn() },
      },
    );

    expect(select).not.toHaveBeenCalled();
    expect(text).toHaveBeenNthCalledWith(
      5,
      expect.objectContaining({ message: 'Principal timezone', initialValue: 'America/Los_Angeles' }),
    );
    expect(result).toEqual({
      sourceRemote: 'https://example.test/nanoclaw.git',
      endpoint: 'https://assistant.example.test/webhook/gchat',
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
        prompts: { note: vi.fn(), text, select, isCancel: () => false, logInfo: vi.fn() },
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
    const answers = ['Aya', '', 'Taslim', '', 'UTC', 'invalid-email', 'https://example.test/not-webhook'];
    const prompts = {
      note: vi.fn(),
      text: vi.fn(
        async (options: { message: string; validate?: (value: string | undefined) => string | undefined }) => {
          if (options.validate) validators.set(options.message, options.validate);
          return answers.shift();
        },
      ),
      select: vi.fn(),
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
