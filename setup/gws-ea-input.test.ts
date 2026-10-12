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
  nodePath: '/opt/homebrew/bin/node',
  homeDirectory: '/Users/principal',
  platform: 'macos',
  runningAsRoot: false,
  dockerEndpoint: 'unix:///Users/principal/.docker/run/docker.sock',
  account: 'operator@example.test',
};
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
  it('derives display names, defaults timezone from the system, and auto-selects the sole provider', async () => {
    const claude = provider('claude', 'Claude');
    const text = vi
      .fn()
      .mockResolvedValueOnce('Ada')
      .mockResolvedValueOnce('Lovelace')
      .mockResolvedValueOnce('Morgan')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce(' Morgan@Example.test, t@other.test ,morgan@example.test')
      .mockResolvedValueOnce(' T@Other.test')
      .mockResolvedValueOnce('America/Los_Angeles');
    const select = vi.fn();

    const result = await collectGwsEaCreateInput(
      {
        instanceId: '11111111-1111-4111-8111-111111111111',
        prerequisites,
        sourceRemote: 'https://example.test/nanoclaw.git',
        providedPrincipalEmails: [],
        secrets: NO_SECRETS,
        track: 'dogfood',
        provided: { 'assistant-workspace-email': 'ada@example.test' },
      },
      {
        providers: [claude],
        detectedTimezone: 'America/Los_Angeles',
        prompts: {
          note: vi.fn(),
          text,
          select,
          isCancel: () => false,
          logInfo: vi.fn(),
        },
      },
    );

    expect(select).not.toHaveBeenCalled();
    // Asked about one person at a time: the assistant, then the principal.
    expect(text.mock.calls.map(([options]) => (options as { message: string }).message)).toEqual([
      'Assistant first name',
      'Assistant last name',
      'Principal first name',
      'Principal last name',
      'Principal email addresses',
      'Principal Google Chat address',
      'Principal timezone',
    ]);
    expect(text).toHaveBeenNthCalledWith(
      7,
      expect.objectContaining({ message: 'Principal timezone', initialValue: 'America/Los_Angeles' }),
    );
    // Which of them the principal uses for Google Chat, prefilled with the first; it must be one of theirs.
    expect(text).toHaveBeenNthCalledWith(
      6,
      expect.objectContaining({
        message: 'Principal Google Chat address',
        initialValue: 'morgan@example.test',
      }),
    );
    const [{ validate }] = text.mock.calls[5] as [{ validate: (value: string) => string | undefined }];
    expect(validate('remy.vance@example.test')).toBe(
      "Use one of the principal's addresses: morgan@example.test, t@other.test",
    );
    expect(validate('T@other.test')).toBeUndefined();
    expect(result).toEqual({
      assistantWorkspaceEmail: 'ada@example.test',
      bootstrapManifest: {
        schema_version: 1,
        node_path: '/opt/homebrew/bin/node',
        home_directory: '/Users/principal',
        platform: 'macos',
        running_as_root: false,
        docker_endpoint: 'unix:///Users/principal/.docker/run/docker.sock',
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
          principal_display_name: 'Morgan',
          principal_timezone: 'America/Los_Angeles',
          principal_emails: ['morgan@example.test', 't@other.test'],
          principal_chat_email: 't@other.test',
        },
      },
    });
  });

  it("asks again for the principal's addresses when one reaches the assistant or repeats another's spelling", async () => {
    const text = vi
      .fn()
      .mockResolvedValueOnce('Ada')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('Morgan')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('morganellery@gmail.com')
      .mockResolvedValueOnce('UTC');

    await collectGwsEaCreateInput(
      {
        instanceId: '11111111-1111-4111-8111-111111111111',
        prerequisites,
        sourceRemote: 'https://example.test/nanoclaw.git',
        providedPrincipalEmails: [],
        secrets: NO_SECRETS,
        track: 'dogfood',
        provided: { 'assistant-workspace-email': 'ada@example.test' },
      },
      {
        providers: [provider('claude', 'Claude')],
        detectedTimezone: 'UTC',
        prompts: {
          note: vi.fn(),
          text,
          select: vi.fn(),
          isCancel: () => false,
          logInfo: vi.fn(),
        },
      },
    );

    const [{ validate }] = text.mock.calls[4] as [{ validate: (value: string) => string | undefined }];
    expect(validate('morgan@example.test, Ada+x@Example.test')).toBe(
      "ada+x@example.test is the assistant's own address, not one of the principal's",
    );
    expect(validate('morganellery@gmail.com, Morgan.Ellery@gmail.com')).toBe(
      "morgan.ellery@gmail.com is another spelling of morganellery@gmail.com, already one of the principal's addresses",
    );
    expect(validate('morgan@example.test, morgan+x@example.test')).toBeUndefined();
  });

  it('offers only composed providers and uses the selected provider metadata', async () => {
    const claude = provider('claude', 'Claude');
    const codex = provider('codex', 'Codex');
    const text = vi
      .fn()
      .mockResolvedValueOnce('Aya')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('Morgan')
      .mockResolvedValueOnce('Ellery')
      .mockResolvedValueOnce('UTC');
    const select = vi.fn(async () => 'codex');

    const result = await collectGwsEaCreateInput(
      {
        instanceId: '11111111-1111-4111-8111-111111111111',
        prerequisites,
        sourceRemote: 'https://example.test/nanoclaw.git',
        providedPrincipalEmails: ['morgan@example.test'],
        secrets: NO_SECRETS,
        track: 'prod',
        provided: { 'assistant-workspace-email': 'aya@example.test' },
      },
      {
        providers: [claude, codex],
        detectedTimezone: 'UTC',
        prompts: {
          note: vi.fn(),
          text,
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
    expect(result.bootstrapManifest.identity.principal_display_name).toBe('Morgan Ellery');
  });

  it('attaches focused validation to prompted timezone and email fields', async () => {
    const validators = new Map<string, (value: string | undefined) => string | undefined>();
    const answers = ['Aya', '', 'aya@example.test', 'Morgan', '', 'UTC'];
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
        prerequisites,
        sourceRemote: 'https://example.test/nanoclaw.git',
        providedPrincipalEmails: ['morgan@example.test'],
        secrets: NO_SECRETS,
        track: 'prod',
        provided: {},
      },
      {
        providers: [provider('claude', 'Claude')],
        detectedTimezone: 'UTC',
        prompts,
      },
    );

    expect(prompts.text.mock.calls.map(([options]) => options.message)).toEqual([
      'Assistant first name',
      'Assistant last name',
      'Assistant Google Workspace email',
      'Principal first name',
      'Principal last name',
      'Principal timezone',
    ]);
    expect(validators.get('Principal timezone')?.('Not/A_Timezone')).toMatch(/valid IANA timezone/u);
    // Main's container runs in it, and a container's TZ reads an offset with its sign flipped.
    expect(validators.get('Principal timezone')?.('+05:30')).toMatch(/valid IANA timezone/u);
    expect(validators.get('Assistant Google Workspace email')?.('not-an-email')).toMatch(/valid email/u);
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
    select: vi.fn(async () => {
      throw new Error('unattended input must not prompt');
    }),
    isCancel: () => false,
    logInfo: vi.fn(),
  };
  const FLAGS = {
    'assistant-first-name': 'Aya',
    'principal-first-name': 'Morgan',
    'principal-last-name': 'Ellery',
    'principal-timezone': 'America/Los_Angeles',
    'assistant-workspace-email': 'aya@example.test',
  } as const;

  function unattended(
    provided: Record<string, string>,
    providedPrincipalEmails: readonly string[] = ['morgan@example.test'],
  ) {
    return collectGwsEaCreateInput(
      {
        instanceId: '11111111-1111-4111-8111-111111111111',
        prerequisites,
        sourceRemote: 'https://example.test/nanoclaw.git',
        providedPrincipalEmails,
        secrets: NO_SECRETS,
        track: 'dogfood',
        provided,
      },
      {
        interactive: false,
        providers: [provider('claude', 'Claude')],
        detectedTimezone: 'UTC',
        prompts: unattendedPrompts,
      },
    );
  }

  it('builds the full answer from flags alone', async () => {
    const result = await unattended(FLAGS);

    expect(result.assistantWorkspaceEmail).toBe('aya@example.test');
    expect(result.bootstrapManifest.identity).toEqual({
      assistant_display_name: 'Aya',
      principal_display_name: 'Morgan Ellery',
      principal_timezone: 'America/Los_Angeles',
      principal_emails: ['morgan@example.test'],
      // Their only address is the one the assistant opens its DM with.
      principal_chat_email: 'morgan@example.test',
    });
    expect(unattendedPrompts.text).not.toHaveBeenCalled();
  });

  it("takes the principal's Google Chat address from its flag, as one of their addresses", async () => {
    const emails = ['morgan@example.test', 'morgan@home.example.test'];

    const result = await unattended({ ...FLAGS, 'principal-chat-email': 'Morgan@Home.example.test' }, emails);

    expect(result.bootstrapManifest.identity).toMatchObject({
      principal_emails: emails,
      principal_chat_email: 'morgan@home.example.test',
    });
  });

  it('names --principal-chat-email when the principal has several addresses and none is named', async () => {
    await expect(unattended(FLAGS, ['morgan@example.test', 'morgan@home.example.test'])).rejects.toMatchObject({
      code: 'input_required',
      message: expect.stringContaining('--principal-chat-email'),
    });
  });

  it("refuses a Google Chat address that is not one of the principal's", async () => {
    await expect(unattended({ ...FLAGS, 'principal-chat-email': 'remy.vance@example.test' })).rejects.toMatchObject({
      code: 'invalid_arguments',
      message: "--principal-chat-email: Use one of the principal's addresses: morgan@example.test",
    });
  });

  it("holds the principal's timezone in the zone's own spelling, which a container's TZ reads", async () => {
    const result = await unattended({ ...FLAGS, 'principal-timezone': 'europe/london' });

    expect(result.bootstrapManifest.identity.principal_timezone).toBe('Europe/London');
  });

  it('names --principal-email when no principal address is given', async () => {
    await expect(unattended(FLAGS, [])).rejects.toMatchObject({
      code: 'input_required',
      message: expect.stringContaining('--principal-email'),
    });
  });

  it("refuses the assistant's own address as the principal's", async () => {
    await expect(unattended(FLAGS, ['aya@example.test'])).rejects.toMatchObject({
      code: 'invalid_arguments',
      message: expect.stringContaining('--principal-email'),
    });
  });

  it.each([
    [
      "a plus-addressed spelling of the assistant's own",
      ['morgan@example.test', 'aya+x@example.test'],
      /assistant's own/u,
    ],
    [
      'two spellings of one Gmail address',
      ['morganellery@gmail.com', 'morgan.ellery+x@googlemail.com'],
      /another spelling of morganellery@gmail\.com/u,
    ],
  ])('refuses principal addresses with %s, naming --principal-email', async (_case, emails, message) => {
    await expect(unattended(FLAGS, emails)).rejects.toMatchObject({
      code: 'invalid_arguments',
      message: expect.stringMatching(new RegExp(`^--principal-email: .*${message.source}`, 'u')),
    });
  });

  it.each(['assistant-first-name', 'principal-first-name', 'principal-timezone', 'assistant-workspace-email'] as const)(
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
    await expect(unattended({ ...FLAGS, 'assistant-workspace-email': 'not-an-email' })).rejects.toMatchObject({
      message: expect.stringContaining('--assistant-workspace-email'),
    });
    await expect(unattended({ ...FLAGS, 'assistant-workspace-email': 'aya@gmail.com' })).rejects.toMatchObject({
      code: 'invalid_arguments',
      message: expect.stringMatching(/--assistant-workspace-email.*Google Workspace/su),
    });
  });

  it('requires --provider only when more than one provider is composed', async () => {
    const providers = [provider('claude', 'Claude'), provider('codex', 'Codex')];
    const dependencies = {
      interactive: false,
      providers,
      detectedTimezone: 'UTC',
      prompts: unattendedPrompts,
    };
    const base = {
      instanceId: '11111111-1111-4111-8111-111111111111',
      prerequisites,
      sourceRemote: 'https://example.test/nanoclaw.git',
      providedPrincipalEmails: ['morgan@example.test'],
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
          '--principal-email',
          'morgan@example.test',
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
            }),
          checkPrerequisites: async () => ({ ...prerequisites, nodePath: process.execPath }),
          resolveReleaseTarget: async ({ track, source }) => ({
            release: { source_remote: source.remote, release_track: track, deployed_commit: 'b'.repeat(40) },
          }),
          holdLoopbackPorts: async () => ({
            ports: { onecli_app: 35_102, onecli_gateway: 35_103 },
            release: async () => undefined,
          }),
          advanceProvision: async () => ({
            status: 'paused',
            pause: {
              kind: 'human-action',
              phase: 'configure_channel',
              code: 'chat_configuration_required',
              message: "Configure the Google Chat API for this assistant's project, then confirm it.",
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
