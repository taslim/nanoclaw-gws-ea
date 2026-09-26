import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PrerequisiteRequest, Prerequisites } from '../src/gws-ea/prerequisites.js';
import type { SanitizedCommandOutcome } from '../src/gws-ea/process.js';
import { GwsEaError } from '../src/gws-ea/types.js';
import { confirmGoogleAccount, ensurePrerequisites, signInToGoogleCloud } from './gws-ea-prerequisites.js';

function promptFixture(confirmAnswers: readonly unknown[] = [true]) {
  const answers = [...confirmAnswers];
  return {
    note: vi.fn(),
    confirm: vi.fn(async () => answers.shift() ?? true),
    isCancel: (value: unknown) => value === CANCEL,
  };
}

const CANCEL = Symbol('cancel');

const READY: Prerequisites = {
  platform: 'macos',
  homeDirectory: '/Users/operator',
  runningAsRoot: false,
  nodePath: '/opt/homebrew/bin/node',
  onecliCliPath: '/Users/operator/.local/share/gws-ea/tools/onecli/2.2.5/onecli',
  dockerEndpoint: 'unix:///Users/operator/.docker/run/docker.sock',
  rootlessDocker: false,
  account: 'operator@example.com',
};

const REQUEST: PrerequisiteRequest = {
  command: 'create',
  paths: {
    configRoot: '/Users/operator/.config/gws-ea',
    stateRoot: '/Users/operator/.local/share/gws-ea',
    logsRoot: '/Users/operator/.local/share/gws-ea/logs',
    instancesRoot: '/Users/operator/.local/share/gws-ea/instances',
    onecliCliFile: (version) => `/Users/operator/.local/share/gws-ea/tools/onecli/${version}/onecli`,
  },
};

function terminal() {
  const order: string[] = [];
  return {
    order,
    interaction: {
      signInToGoogleCloud: vi.fn(async () => undefined),
      confirmGoogleAccount: vi.fn(async () => true),
      withTerminal: async <T>(work: () => Promise<T>): Promise<T> => {
        order.push('suspend');
        try {
          return await work();
        } finally {
          order.push('resume');
        }
      },
    },
  };
}

describe('GWS-EA Google Cloud sign-in', () => {
  it('always runs the browser flow with --force, for the reserved account or a new one', async () => {
    const runLogin = vi.fn(async () => 0);
    const prompts = promptFixture([true, true]);

    await signInToGoogleCloud('reserved@example.com', {
      resolveExecutable: async () => '/opt/homebrew/bin/gcloud',
      runLogin,
      prompts,
    });
    await signInToGoogleCloud(undefined, {
      resolveExecutable: async () => '/opt/homebrew/bin/gcloud',
      runLogin,
      prompts,
    });

    expect(prompts.note).toHaveBeenNthCalledWith(1, expect.stringContaining('reserved@example.com'), 'Google Cloud');
    expect(runLogin.mock.calls).toEqual([
      ['/opt/homebrew/bin/gcloud', ['auth', 'login', 'reserved@example.com', '--force']],
      ['/opt/homebrew/bin/gcloud', ['auth', 'login', '--force']],
    ]);
  });

  it('fails when the login does not complete, and never launches it when declined', async () => {
    await expect(
      signInToGoogleCloud('reserved@example.com', {
        resolveExecutable: async () => '/opt/homebrew/bin/gcloud',
        runLogin: async () => 1,
        prompts: promptFixture([true]),
      }),
    ).rejects.toMatchObject({ code: 'gcloud_auth_failed' });

    const runLogin = vi.fn(async () => 0);
    await expect(
      signInToGoogleCloud('reserved@example.com', {
        resolveExecutable: async () => '/opt/homebrew/bin/gcloud',
        runLogin,
        prompts: promptFixture([false]),
      }),
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(runLogin).not.toHaveBeenCalled();
  });

  // Recorded divergence: upstream's setup/lib/inherit-script.ts has no `error`
  // listener, so a login that cannot start crashes the driver instead.
  it('fails the sign-in when gcloud cannot start, through the real interactive runner', async () => {
    // Locating gcloud puts its directory on PATH; restore it afterwards.
    vi.stubEnv('PATH', process.env.PATH ?? '');
    try {
      await expect(
        signInToGoogleCloud('reserved@example.com', {
          resolveExecutable: async () => path.join(os.tmpdir(), 'gws-ea-missing-gcloud', 'gcloud'),
          prompts: promptFixture([true]),
        }),
      ).rejects.toMatchObject({ code: 'gcloud_auth_failed' });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('GWS-EA Google account confirmation', () => {
  it('returns the operator’s answer and treats cancel as cancelling setup', async () => {
    const prompts = promptFixture([true, false, CANCEL]);

    await expect(confirmGoogleAccount('operator@example.com', { prompts })).resolves.toBe(true);
    await expect(confirmGoogleAccount('operator@example.com', { prompts })).resolves.toBe(false);
    await expect(confirmGoogleAccount('operator@example.com', { prompts })).rejects.toMatchObject({
      code: 'cancelled',
    });
    expect(prompts.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('operator@example.com') }),
    );
  });
});

describe('GWS-EA guided prerequisites', () => {
  afterEach(() => vi.unstubAllEnvs());

  const ENDPOINT = 'unix:///Users/operator/.docker/run/docker.sock';
  const missingGcloud = () => new GwsEaError('gcloud_required', 'Google Cloud CLI is required');
  const stoppedDocker = () =>
    new GwsEaError('docker_stopped', 'Docker is not running', { details: { endpoint: ENDPOINT } });

  function failingThen(...errors: GwsEaError[]) {
    const check = vi.fn<(request: PrerequisiteRequest) => Promise<Prerequisites>>();
    for (const error of errors) check.mockRejectedValueOnce(error);
    return check.mockResolvedValue(READY);
  }

  it('guides a Google Cloud CLI install, then continues the same run', async () => {
    vi.stubEnv('PATH', '/custom/bin:/usr/bin');
    const check = failingThen(missingGcloud());
    const prompts = promptFixture([true]);
    const resolveExecutable = vi.fn(async () => '/Users/operator/google-cloud-sdk/bin/gcloud');
    const { order, interaction } = terminal();
    prompts.note.mockImplementation(() => void order.push('guidance'));

    await expect(ensurePrerequisites(REQUEST, interaction, { check, resolveExecutable, prompts })).resolves.toBe(READY);

    expect(check).toHaveBeenCalledTimes(2);
    expect(check).toHaveBeenNthCalledWith(2, REQUEST, interaction);
    expect(prompts.note).toHaveBeenCalledWith(
      expect.stringContaining('https://cloud.google.com/sdk/docs/install'),
      'Google Cloud CLI',
    );
    expect(order).toEqual(['suspend', 'guidance', 'resume']);
    expect(resolveExecutable).toHaveBeenCalledWith(
      'gcloud',
      ['/custom/bin:/usr/bin', path.join(os.homedir(), 'google-cloud-sdk', 'bin')].join(path.delimiter),
    );
    expect(process.env.PATH?.split(path.delimiter)[0]).toBe('/Users/operator/google-cloud-sdk/bin');
  });

  it('guides again while a tool is still missing, then lets its failure stand', async () => {
    const check = vi.fn(async (): Promise<Prerequisites> => {
      throw missingGcloud();
    });
    const prompts = promptFixture([true, true, true]);

    await expect(
      ensurePrerequisites(REQUEST, terminal().interaction, {
        check,
        resolveExecutable: async () => {
          throw new GwsEaError('executable_not_found', 'gcloud was not found on PATH');
        },
        prompts,
      }),
    ).rejects.toMatchObject({ code: 'gcloud_required' });
    expect(check).toHaveBeenCalledTimes(4);
    expect(prompts.note.mock.calls.map(([message]) => String(message).startsWith('Still not ready.'))).toEqual([
      false,
      true,
      true,
    ]);
  });

  it('does not continue when the operator declines to install', async () => {
    const check = vi.fn(async (): Promise<Prerequisites> => {
      throw missingGcloud();
    });

    await expect(
      ensurePrerequisites(REQUEST, terminal().interaction, {
        check,
        resolveExecutable: async () => '/opt/homebrew/bin/gcloud',
        prompts: promptFixture([false]),
      }),
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(check).toHaveBeenCalledOnce();
  });

  it('starts Docker Desktop on macOS when the operator agrees, and waits for its daemon', async () => {
    const check = failingThen(stoppedDocker());
    const prompts = promptFixture([true]);
    const runCommand = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
    const answers = [false, false, true];
    const dockerAnswers = vi.fn(async () => answers.shift() ?? true);
    const sleep = vi.fn(async () => undefined);

    await expect(
      ensurePrerequisites(REQUEST, terminal().interaction, {
        check,
        prompts,
        platform: 'darwin',
        runCommand,
        dockerAnswers,
        sleep,
      }),
    ).resolves.toBe(READY);

    expect(prompts.confirm).toHaveBeenCalledWith(expect.objectContaining({ message: 'Start Docker Desktop now?' }));
    expect(runCommand).toHaveBeenCalledWith(expect.objectContaining({ command: 'open', args: ['-a', 'Docker'] }));
    expect(dockerAnswers).toHaveBeenCalledWith(ENDPOINT);
    expect(sleep).toHaveBeenCalledOnce();
    expect(prompts.note).toHaveBeenCalledOnce();
    expect(prompts.note).toHaveBeenCalledWith('Waiting up to 90 seconds for Docker to start…', 'Docker');
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('lets a stopped Docker stand once it never answers within the guided waits', async () => {
    const stopped = stoppedDocker();
    const check = vi.fn(async (): Promise<Prerequisites> => {
      throw stopped;
    });
    const sleep = vi.fn(async () => undefined);

    await expect(
      ensurePrerequisites(REQUEST, terminal().interaction, {
        check,
        prompts: promptFixture(),
        platform: 'linux',
        dockerAnswers: async () => false,
        sleep,
      }),
    ).rejects.toBe(stopped);
    expect(check).toHaveBeenCalledTimes(4);
    // Each of the three guided rounds waits 90 seconds in 2-second polls, then gives up.
    expect(sleep).toHaveBeenCalledTimes(3 * 45);
  });

  it('says why starting Docker failed, then shows the manual step', async () => {
    const check = failingThen(stoppedDocker());
    const prompts = promptFixture([true, true]);
    const runCommand = vi.fn(async (): Promise<SanitizedCommandOutcome> => {
      throw new GwsEaError('executable_not_found', 'open was not found on PATH');
    });

    await expect(
      ensurePrerequisites(REQUEST, terminal().interaction, {
        check,
        prompts,
        platform: 'darwin',
        runCommand,
        dockerAnswers: async () => true,
      }),
    ).resolves.toBe(READY);

    expect(prompts.note.mock.calls.map(([message]) => String(message))).toEqual([
      'open was not found on PATH',
      'Start Docker Desktop, then return to this terminal.',
    ]);
  });

  it('shows how to start Docker on Linux, then waits for its daemon', async () => {
    const check = failingThen(stoppedDocker());
    const prompts = promptFixture([true]);
    const runCommand = vi.fn();
    const dockerAnswers = vi.fn(async () => true);

    await expect(
      ensurePrerequisites(REQUEST, terminal().interaction, {
        check,
        prompts,
        platform: 'linux',
        runCommand,
        dockerAnswers,
      }),
    ).resolves.toBe(READY);

    expect(prompts.note).toHaveBeenCalledWith(expect.stringContaining('sudo systemctl start docker'), 'Docker');
    expect(runCommand).not.toHaveBeenCalled();
    expect(dockerAnswers).toHaveBeenCalledWith(ENDPOINT);
  });

  it.each([
    ['pnpm_required', 'darwin', 'corepack enable pnpm'],
    ['git_required', 'darwin', 'xcode-select --install'],
    ['git_required', 'linux', 'sudo apt install git'],
    ['docker_required', 'linux', 'https://docs.docker.com/engine/install/'],
  ] as const)('guides %s on %s with its install step', async (code, platform, step) => {
    const prompts = promptFixture([true]);

    await expect(
      ensurePrerequisites(REQUEST, terminal().interaction, {
        check: failingThen(new GwsEaError(code, 'missing')),
        prompts,
        platform,
        resolveExecutable: async () => '/usr/bin/docker',
      }),
    ).resolves.toBe(READY);
    expect(prompts.note).toHaveBeenCalledWith(expect.stringContaining(step), expect.any(String));
  });

  it('passes a failure it cannot guide through untouched', async () => {
    const denied = new GwsEaError('docker_permission_denied', 'This user may not use the Docker daemon');
    const prompts = promptFixture();

    await expect(
      ensurePrerequisites(REQUEST, terminal().interaction, {
        check: async () => {
          throw denied;
        },
        prompts,
      }),
    ).rejects.toBe(denied);
    expect(prompts.note).not.toHaveBeenCalled();
    expect(prompts.confirm).not.toHaveBeenCalled();
  });
});
