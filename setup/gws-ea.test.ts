import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CliRuntime, FailureReport } from '../src/gws-ea/cli.js';
import type { Interaction } from '../src/gws-ea/events.js';

const fixture = vi.hoisted(() => {
  const spinner = {
    start: vi.fn(),
    message: vi.fn(),
    stop: vi.fn(),
    error: vi.fn(),
    clear: vi.fn(),
  };
  return {
    runCli: vi.fn(async (_args: readonly string[], _runtime: unknown) => 0),
    collect: vi.fn(async (_context: unknown, _dependencies: unknown) => ({ marker: 'collected' })),
    authenticate: vi.fn(async (_provider: string, _providers: unknown) => ({ marker: 'authenticated' })),
    providers: [{ value: 'claude' }],
    spinner,
    log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), message: vi.fn(), step: vi.fn() },
    note: vi.fn(),
    password: vi.fn(async () => 'fresh-cloudflare-token'),
    confirm: vi.fn(async () => true),
    ensurePrerequisites: vi.fn(async () => ({ account: 'operator@example.com' })),
    signIn: vi.fn(async () => undefined),
    confirmAccount: vi.fn(async () => true),
    offerDiagnosis: vi.fn(async () => 'answered'),
    dump: vi.fn(),
  };
});

vi.mock('@clack/prompts', () => ({
  log: fixture.log,
  note: fixture.note,
  password: fixture.password,
  confirm: fixture.confirm,
  spinner: () => fixture.spinner,
  isCancel: () => false,
}));
vi.mock('../src/gws-ea/cli.js', () => ({ runCli: fixture.runCli }));
vi.mock('./gws-ea-input.js', () => ({
  collectGwsEaCreateInput: fixture.collect,
  authenticateGwsEaProvider: fixture.authenticate,
  CLOUDFLARE_API_TOKEN_GUIDANCE: 'cloudflare-token-guidance',
}));
vi.mock('./gws-ea-prerequisites.js', () => ({
  ensurePrerequisites: fixture.ensurePrerequisites,
  signInToGoogleCloud: fixture.signIn,
  confirmGoogleAccount: fixture.confirmAccount,
}));
vi.mock('./gws-ea-assist.js', () => ({ offerDiagnosis: fixture.offerDiagnosis }));
vi.mock('./lib/runner.js', () => ({ dumpTranscriptOnFailure: fixture.dump }));
vi.mock('./providers/registry.js', () => ({ listSetupProviders: () => fixture.providers }));
vi.mock('./providers/index.js', () => ({}));

const { createTerminalPresenter, main } = await import('./gws-ea.js');

function runtimeOf(call = 0): CliRuntime {
  return fixture.runCli.mock.calls[call]![1] as CliRuntime;
}

function report(overrides: Partial<FailureReport> = {}): FailureReport {
  return {
    command: 'resume',
    step: 'start_onecli',
    code: 'onecli_unhealthy',
    cause: 'OneCLI did not become healthy',
    nextAction: 'Resume with: gws-ea resume --id x',
    progressLog: '/logs/progress.log',
    runDirectory: '/logs',
    ...overrides,
  };
}

describe('GWS-EA driver', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('runs unattended without a TTY: no spinner, prompts, gcloud guidance, or failure loop', async () => {
    await main(['create', '--track', 'prod'], { interactive: false });

    expect(fixture.runCli).toHaveBeenCalledOnce();
    const runtime = runtimeOf();
    expect(fixture.runCli.mock.calls[0]![0]).toEqual(['create', '--track', 'prod']);
    expect(runtime.presenter).toBeUndefined();
    expect(runtime.prompts).toBeUndefined();
    expect(runtime.onFailure).toBeUndefined();
    expect(runtime.checkPrerequisites).toBeUndefined();
    expect(runtime.confirmRemoval).toBeUndefined();
    await runtime.collectCreateInputs!({ marker: 'context' } as never);
    expect(fixture.collect).toHaveBeenCalledWith(
      { marker: 'context' },
      { providers: fixture.providers, interactive: false },
    );
  });

  it('wires the spinner, prompts, gcloud guidance, and failure loop on a TTY', async () => {
    await main(['resume', '--id', 'x'], { interactive: true });
    const runtime = runtimeOf();

    expect(runtime.presenter).toBeDefined();
    await runtime.collectCreateInputs!({ marker: 'context' } as never);
    expect(fixture.collect).toHaveBeenCalledWith(
      { marker: 'context' },
      { providers: fixture.providers, interactive: true },
    );

    await runtime.prompts!.providerCredential('claude');
    expect(fixture.authenticate).toHaveBeenCalledWith('claude', fixture.providers);

    await expect(
      runtime.prompts!.cloudflareAccountToken({ accountId: 'a'.repeat(32), reason: 'The listener drifted.' }),
    ).resolves.toBe('fresh-cloudflare-token');
    expect(fixture.log.warn).toHaveBeenCalledWith('The listener drifted.');
    expect(fixture.note).toHaveBeenCalledWith('cloudflare-token-guidance', 'Cloudflare access');
    expect(fixture.log.warn.mock.invocationCallOrder[0]).toBeLessThan(fixture.password.mock.invocationCallOrder[0]!);
    expect(fixture.note.mock.invocationCallOrder[0]).toBeLessThan(fixture.password.mock.invocationCallOrder[0]!);

    await runtime.prompts!.googleCloudSignIn('reserved@example.com');
    expect(fixture.signIn).toHaveBeenCalledWith('reserved@example.com');
    await expect(runtime.prompts!.googleAccount('operator@example.com')).resolves.toBe(true);
    expect(fixture.confirmAccount).toHaveBeenCalledWith('operator@example.com');

    const interaction = { marker: 'interaction' } as unknown as Interaction;
    const request = { command: 'resume', instancesRoot: '/instances', account: 'reserved@example.com' } as const;
    await runtime.checkPrerequisites!(request, interaction);
    expect(fixture.ensurePrerequisites).toHaveBeenCalledWith(request, interaction);
  });

  it('offers diagnosis, then a retry, after an interactive failure', async () => {
    await main(['resume', '--id', 'x'], { interactive: true });
    const { onFailure } = runtimeOf();

    await expect(onFailure!(report())).resolves.toBe('retry');
    expect(fixture.offerDiagnosis).toHaveBeenCalledWith(report());
    expect(fixture.offerDiagnosis.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.confirm.mock.invocationCallOrder[0]!,
    );
    expect(fixture.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/retry/iu) }),
    );

    fixture.confirm.mockResolvedValueOnce(false);
    await expect(onFailure!(report())).resolves.toBe('stop');
  });

  it('asks before removal on a TTY', async () => {
    await main(['remove', '--id', 'x'], { interactive: true });
    fixture.confirm.mockResolvedValueOnce(false);
    await expect(runtimeOf().confirmRemoval!({ instanceId: 'x', gcpProject: 'p' } as never)).resolves.toBe(false);
  });
});

describe('GWS-EA terminal presenter', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('renders a labeled step as a spinner that shows its waiting reason and elapsed time', () => {
    vi.useFakeTimers();
    const presenter = createTerminalPresenter();

    presenter.event({ type: 'step-started', step: 'provision_gcp', label: 'Configuring Google Cloud…' });
    expect(fixture.spinner.start).toHaveBeenCalledWith(expect.stringContaining('Configuring Google Cloud'));
    presenter.event({ type: 'step-waiting', step: 'provision_gcp', reason: 'Waiting for the service account…' });
    vi.advanceTimersByTime(1000);
    expect(fixture.spinner.message).toHaveBeenLastCalledWith(
      expect.stringContaining('Waiting for the service account'),
    );
    presenter.event({ type: 'step-completed', step: 'provision_gcp' });
    expect(fixture.spinner.stop).toHaveBeenCalledWith(expect.stringContaining('Configuring Google Cloud'));
  });

  it('hands the terminal over and back without losing the running step', () => {
    const presenter = createTerminalPresenter();

    presenter.event({ type: 'step-started', step: 'configure_provider', label: 'Connecting the AI provider…' });
    presenter.suspend();
    presenter.suspend();
    expect(fixture.spinner.clear).toHaveBeenCalledOnce();
    presenter.resume();
    presenter.resume();
    expect(fixture.spinner.start).toHaveBeenCalledTimes(2);
    presenter.event({ type: 'step-failed', step: 'configure_provider', error: new Error('x') });
    expect(fixture.spinner.error).toHaveBeenCalledWith(expect.stringContaining('Connecting the AI provider'));
    presenter.resume();
    expect(fixture.spinner.start).toHaveBeenCalledTimes(2);
  });

  it('ignores unlabeled steps and renders the failure summary with its redacted tail', () => {
    const presenter = createTerminalPresenter();

    presenter.event({ type: 'step-started', step: 'inputs' });
    expect(fixture.spinner.start).not.toHaveBeenCalled();
    presenter.report({
      outcome: 'failed',
      headline: 'Stopped at start_onecli: OneCLI did not become healthy',
      details: ['Log: /logs/progress.log'],
      tail: 'last stderr line',
    });
    expect(fixture.log.error).toHaveBeenCalledWith('Stopped at start_onecli: OneCLI did not become healthy');
    expect(fixture.log.message).toHaveBeenCalledWith('Log: /logs/progress.log');
    expect(fixture.dump).toHaveBeenCalledWith('last stderr line');
  });
});
