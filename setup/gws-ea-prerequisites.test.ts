import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PrerequisiteRequest, Prerequisites } from '../src/gws-ea/prerequisites.js';
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
  onecliCliPath: '/Users/operator/.local/bin/onecli',
  dockerEndpoint: 'unix:///Users/operator/.docker/run/docker.sock',
  account: 'operator@example.com',
};

const REQUEST: PrerequisiteRequest = {
  command: 'create',
  paths: {
    configRoot: '/Users/operator/.config/gws-ea',
    stateRoot: '/Users/operator/.local/share/gws-ea',
    logsRoot: '/Users/operator/.local/share/gws-ea/logs',
    instancesRoot: '/Users/operator/.local/share/gws-ea/instances',
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

  it('guides a Google Cloud CLI install, then continues the same run', async () => {
    vi.stubEnv('PATH', '/custom/bin:/usr/bin');
    const check = vi
      .fn<(request: PrerequisiteRequest) => Promise<Prerequisites>>()
      .mockRejectedValueOnce(new GwsEaError('gcloud_required', 'Google Cloud CLI is required'))
      .mockResolvedValueOnce(READY);
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
      ['/custom/bin:/usr/bin', path.join(os.homedir(), 'google-cloud-sdk', 'bin')].join(path.delimiter),
    );
    expect(process.env.PATH?.split(path.delimiter)[0]).toBe('/Users/operator/google-cloud-sdk/bin');
  });

  it('stops with the install link when the CLI is still missing', async () => {
    const check = vi.fn(async () => {
      throw new GwsEaError('gcloud_required', 'Google Cloud CLI is required');
    });

    await expect(
      ensurePrerequisites(REQUEST, terminal().interaction, {
        check,
        resolveExecutable: async () => {
          throw new GwsEaError('executable_not_found', 'gcloud was not found on PATH');
        },
        prompts: promptFixture([true]),
      }),
    ).rejects.toMatchObject({
      code: 'gcloud_required',
      message: expect.stringContaining('https://cloud.google.com/sdk/docs/install'),
    });
    expect(check).toHaveBeenCalledOnce();
  });

  it('does not continue when the operator declines to install', async () => {
    const check = vi.fn(async () => {
      throw new GwsEaError('gcloud_required', 'Google Cloud CLI is required');
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

  it('passes every other prerequisite failure through without guidance', async () => {
    const stopped = new GwsEaError('docker_stopped', 'Docker is not running');
    const prompts = promptFixture();

    await expect(
      ensurePrerequisites(REQUEST, terminal().interaction, {
        check: async () => {
          throw stopped;
        },
        prompts,
      }),
    ).rejects.toBe(stopped);
    expect(prompts.note).not.toHaveBeenCalled();
  });
});
