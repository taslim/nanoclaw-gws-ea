import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SecretSource } from './create-input.js';
import { createInteraction, PauseRequired, runStep, type InteractivePrompts, type RunEvent } from './events.js';
import { resolveControlPlanePaths } from './paths.js';
import type { ProvisionHumanPause } from './phases.js';
import { redact, REDACTED } from './redact.js';
import { startRunLog } from './run-log.js';
import { GwsEaError } from './types.js';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function run() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gws-ea-events-'));
  roots.push(root);
  const paths = resolveControlPlanePaths({
    configRoot: path.join(root, 'config'),
    stateRoot: path.join(root, 'state'),
  });
  return startRunLog({ paths, command: 'resume' });
}

const PAUSE: ProvisionHumanPause = {
  kind: 'human-action',
  phase: 'configure_channel',
  code: 'chat_configuration_required',
  message: 'Configure Google Chat.',
};

const NO_SECRETS: SecretSource = { get: () => undefined };

const ZONE = { accountName: 'Example', zoneId: 'b'.repeat(32), name: 'example.com', status: 'active' as const };

function ingressSetup(accountId = 'a'.repeat(32)) {
  let retained: string | undefined;
  return {
    discoverZones: vi.fn(async () => [{ ...ZONE, accountId }]),
    retainAccountToken: vi.fn((token: string) => {
      retained = token;
    }),
    requireAccountToken: vi.fn(() => {
      if (!retained) throw new GwsEaError('cloudflare_token_required', 'Token required');
      return retained;
    }),
  };
}

function prompts(overrides: Partial<InteractivePrompts> = {}): InteractivePrompts {
  return {
    providerCredential: vi.fn(async () => {
      throw new Error('unexpected provider prompt');
    }),
    cloudflareAccountToken: vi.fn(async () => {
      throw new Error('unexpected Cloudflare prompt');
    }),
    googleCloudSignIn: vi.fn(async () => undefined),
    googleAccount: vi.fn(async () => {
      throw new Error('unexpected Google account prompt');
    }),
    attendPause: vi.fn(async () => ({ kind: 'stop' as const })),
    ...overrides,
  };
}

describe('runStep', () => {
  it('reports start and completion and logs the step', async () => {
    const log = await run();
    const events: RunEvent[] = [];

    await expect(
      runStep(
        { emit: (event) => events.push(event), run: log },
        { id: 'start_onecli', label: 'Starting…' },
        async () => 7,
      ),
    ).resolves.toBe(7);

    expect(events).toEqual([
      { type: 'step-started', step: 'start_onecli', label: 'Starting…' },
      { type: 'step-completed', step: 'start_onecli' },
    ]);
    expect(await readFile(log.progressLog, 'utf8')).toMatch(/start_onecli \[\S+\] → success/u);
  });

  it('reports a pause instead of completion and marks the step paused', async () => {
    const log = await run();
    const events: RunEvent[] = [];

    await runStep(
      { emit: (event) => events.push(event), run: log },
      { id: 'configure_channel' },
      async () => ({ status: 'paused' as const, pause: PAUSE }),
      (result) => result.pause,
    );

    expect(events.at(-1)).toEqual({ type: 'step-paused', step: 'configure_channel', pause: PAUSE });
    expect(await readFile(log.progressLog, 'utf8')).toMatch(/configure_channel \[\S+\] → paused/u);
  });

  it('reports the innermost failing step with its raw log', async () => {
    const log = await run();
    const events: RunEvent[] = [];
    const reporter = { emit: (event: RunEvent) => events.push(event), run: log };
    const failure = new GwsEaError('boom', 'Boom');

    await expect(
      runStep(reporter, { id: 'provision' }, () =>
        runStep(reporter, { id: 'provision_gcp' }, async () => {
          throw failure;
        }),
      ),
    ).rejects.toBe(failure);

    const failed = events.filter((event) => event.type === 'step-failed');
    expect(failed.map((event) => event.step)).toEqual(['provision_gcp', 'provision']);
    expect(failed[0]).toMatchObject({ error: failure, rawLog: expect.stringMatching(/provision-gcp\.log$/u) });
  });

  it('records an input pause raised inside nested steps as paused, not failed', async () => {
    const log = await run();
    const events: RunEvent[] = [];
    const reporter = { emit: (event: RunEvent) => events.push(event), run: log };
    const pause = new PauseRequired('input_required', 'A credential is required.', ['Supply it.']);

    await expect(
      runStep(reporter, { id: 'provision' }, () =>
        runStep(reporter, { id: 'configure_provider' }, async () => {
          throw pause;
        }),
      ),
    ).rejects.toBe(pause);

    expect(events.filter((event) => event.type === 'step-failed')).toEqual([]);
    expect(events.filter((event) => event.type === 'step-paused').map((event) => event.step)).toEqual([
      'configure_provider',
      'provision',
    ]);
    const progress = await readFile(log.progressLog, 'utf8');
    expect(progress).toMatch(/configure_provider \[\S+\] → paused/u);
    expect(progress).toMatch(/provision \[\S+\] → paused/u);
    expect(progress).not.toContain('→ failed');
  });

  it('runs without a run log or listener', async () => {
    await expect(runStep({}, { id: 'bare' }, async () => 'ok')).resolves.toBe('ok');
  });
});

describe('Interaction port', () => {
  it('attends a pause only at a terminal, and carries decisions made there into later runs', async () => {
    const pause: ProvisionHumanPause = {
      kind: 'human-action',
      phase: 'configure_channel',
      code: 'chat_configuration_required',
      message: 'Finish the Google Chat app configuration, then confirm it.',
      resumeFlag: '--chat-configured',
    };
    const options = {
      decisions: { chatConfigured: false },
      secrets: { get: () => undefined },
      managedIngressSetup: ingressSetup(),
    };
    const signal = new AbortController().signal;

    await expect(createInteraction(options).attendPause(pause, signal)).resolves.toEqual({ kind: 'stop' });

    const terminal = { suspend: vi.fn(), resume: vi.fn() };
    const attendPause = vi.fn(async () => ({ kind: 'continue' as const, decisions: { chatConfigured: true } }));
    const interactive = createInteraction({ ...options, prompts: prompts({ attendPause }), terminal });
    await expect(interactive.attendPause(pause, signal)).resolves.toEqual({
      kind: 'continue',
      decisions: { chatConfigured: true },
    });
    expect(attendPause).toHaveBeenCalledWith(pause, signal);
    expect(terminal.suspend).toHaveBeenCalledOnce();

    const decided = interactive.withDecisions({ chatConfigured: true });
    expect(decided.decisions).toEqual({ chatConfigured: true });
    expect(interactive.decisions).toEqual({ chatConfigured: false });
  });

  it('uses a supplied provider credential without prompting', async () => {
    const terminal = { suspend: vi.fn(), resume: vi.fn() };
    const interaction = createInteraction({
      decisions: { chatConfigured: false },
      secrets: { get: (name) => (name === 'providerCredential' ? 'sk-ant-api03-supplied' : undefined) },
      prompts: prompts(),
      terminal,
      managedIngressSetup: ingressSetup(),
    });

    await expect(
      interaction.requestProviderCredential({
        providerId: 'claude',
        metadata: { name: 'Anthropic', type: 'anthropic', hostPattern: 'api.anthropic.com' },
      }),
    ).resolves.toEqual({
      name: 'Anthropic',
      type: 'anthropic',
      hostPattern: 'api.anthropic.com',
      value: 'sk-ant-api03-supplied',
    });
    expect(terminal.suspend).not.toHaveBeenCalled();
  });

  it('suspends progress around a prompt and registers the received secret', async () => {
    const order: string[] = [];
    const secret = `prompted-provider-secret-${Date.now()}`;
    const interaction = createInteraction({
      decisions: { chatConfigured: false },
      secrets: NO_SECRETS,
      prompts: prompts({
        providerCredential: async () => {
          order.push('prompt');
          return { name: 'Anthropic', type: 'anthropic', hostPattern: 'api.anthropic.com', value: secret };
        },
      }),
      terminal: { suspend: () => order.push('suspend'), resume: () => order.push('resume') },
      managedIngressSetup: ingressSetup(),
    });

    await interaction.requestProviderCredential({
      providerId: 'claude',
      metadata: { name: 'Anthropic', type: 'anthropic', hostPattern: 'api.anthropic.com' },
    });

    expect(order).toEqual(['suspend', 'prompt', 'resume']);
    expect(redact(`value ${secret}`)).toBe(`value ${REDACTED}`);
  });

  it('verifies and retains a Cloudflare token for the reserved account', async () => {
    const secret = `prompted-cloudflare-${Date.now()}`;
    const setup = ingressSetup();
    const cloudflareAccountToken = vi.fn(async () => secret);
    const interaction = createInteraction({
      decisions: { chatConfigured: false },
      secrets: NO_SECRETS,
      prompts: prompts({ cloudflareAccountToken }),
      managedIngressSetup: setup,
    });

    await expect(
      interaction.requestCloudflareAccountToken({ accountId: 'a'.repeat(32), reason: 'Listener drifted' }),
    ).resolves.toBe(secret);
    expect(cloudflareAccountToken).toHaveBeenCalledWith({ accountId: 'a'.repeat(32), reason: 'Listener drifted' });
    expect(setup.retainAccountToken).toHaveBeenCalledWith(secret);
    expect(redact(secret)).toBe(REDACTED);

    const foreign = createInteraction({
      decisions: { chatConfigured: false },
      secrets: { get: () => 'token-for-another-account' },
      managedIngressSetup: ingressSetup('f'.repeat(32)),
    });
    await expect(
      foreign.requestCloudflareAccountToken({ accountId: 'a'.repeat(32), reason: 'Repair' }),
    ).rejects.toMatchObject({ code: 'cloudflare_capability_missing' });
  });

  it('pauses naming how to supply each input when no person can be asked', async () => {
    const interaction = createInteraction({
      decisions: { chatConfigured: false },
      secrets: NO_SECRETS,
      managedIngressSetup: ingressSetup(),
    });

    const provider = await interaction
      .requestProviderCredential({
        providerId: 'claude',
        metadata: { name: 'Anthropic', type: 'anthropic', hostPattern: 'api.anthropic.com' },
      })
      .catch((error: unknown) => error);
    expect(provider).toBeInstanceOf(PauseRequired);
    expect((provider as PauseRequired).instructions.join('\n')).toContain('GWS_EA_PROVIDER_CREDENTIAL');

    const cloudflare = await interaction
      .requestCloudflareAccountToken({ accountId: 'a'.repeat(32), reason: 'Repair' })
      .catch((error: unknown) => error);
    expect(cloudflare).toBeInstanceOf(PauseRequired);
    expect((cloudflare as PauseRequired).instructions.join('\n')).toContain('GWS_EA_CLOUDFLARE_API_TOKEN');

    const signIn = await interaction.signInToGoogleCloud('operator@example.test').catch((error: unknown) => error);
    expect(signIn).toBeInstanceOf(PauseRequired);
    expect((signIn as PauseRequired).instructions.join('\n')).toContain(
      'gcloud auth login operator@example.test --force',
    );

    await expect(interaction.confirmGoogleAccount('operator@example.test')).rejects.toMatchObject({
      code: 'input_required',
      message: expect.stringContaining('--google-account operator@example.test'),
      details: { flag: '--google-account' },
    });
  });

  it('asks a person to confirm the Google account, with progress suspended', async () => {
    const order: string[] = [];
    const interaction = createInteraction({
      decisions: { chatConfigured: false },
      secrets: NO_SECRETS,
      prompts: prompts({
        googleAccount: async (account) => {
          order.push(`confirm ${account}`);
          return false;
        },
      }),
      terminal: { suspend: () => order.push('suspend'), resume: () => order.push('resume') },
      managedIngressSetup: ingressSetup(),
    });

    await expect(interaction.confirmGoogleAccount('operator@example.test')).resolves.toBe(false);
    expect(order).toEqual(['suspend', 'confirm operator@example.test', 'resume']);
  });

  it('hands the terminal to a sign-in child', async () => {
    const order: string[] = [];
    const interaction = createInteraction({
      decisions: { chatConfigured: true, messagingGroupId: 'gchat:spaces/AAA' },
      secrets: NO_SECRETS,
      prompts: prompts({ googleCloudSignIn: async () => void order.push('sign-in') }),
      terminal: { suspend: () => order.push('suspend'), resume: () => order.push('resume') },
      managedIngressSetup: ingressSetup(),
    });

    await interaction.signInToGoogleCloud('operator@example.test');
    expect(order).toEqual(['suspend', 'sign-in', 'resume']);
    expect(interaction.decisions).toEqual({ chatConfigured: true, messagingGroupId: 'gchat:spaces/AAA' });
  });
});
