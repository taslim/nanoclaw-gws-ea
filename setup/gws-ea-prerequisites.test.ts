import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GwsEaError } from '../src/gws-ea/types.js';
import { ensureGcloudReady } from './gws-ea-prerequisites.js';

function promptFixture(confirmAnswers: readonly boolean[] = [true]) {
  const answers = [...confirmAnswers];
  return {
    note: vi.fn(),
    confirm: vi.fn(async () => answers.shift() ?? true),
    isCancel: () => false,
  };
}

describe('GWS-EA Google Cloud prerequisite flow', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('signs back into the reserved account during resume', async () => {
    const prompts = promptFixture([true]);
    const check = vi
      .fn<() => Promise<{ readonly account: string }>>()
      .mockRejectedValueOnce(new GwsEaError('gcloud_auth_required', 'Google Cloud sign-in is required'))
      .mockResolvedValueOnce({ account: 'reserved@example.com' });
    const runLogin = vi.fn(async () => 0);

    await expect(
      ensureGcloudReady('/repo', {
        account: 'reserved@example.com',
        check,
        resolveExecutable: async () => '/opt/homebrew/bin/gcloud',
        runLogin,
        prompts,
      }),
    ).resolves.toEqual({ account: 'reserved@example.com' });

    expect(prompts.note).toHaveBeenCalledWith(expect.stringContaining('reserved@example.com'), 'Google Cloud');
    expect(runLogin).toHaveBeenCalledWith('/opt/homebrew/bin/gcloud', ['auth', 'login', 'reserved@example.com']);
  });

  it('continues one create flow through installation and interactive authentication', async () => {
    vi.stubEnv('PATH', '/custom/bin:/usr/bin');
    const check = vi
      .fn<() => Promise<{ readonly account: string }>>()
      .mockRejectedValueOnce(new GwsEaError('gcloud_required', 'Google Cloud CLI is required'))
      .mockRejectedValueOnce(new GwsEaError('gcloud_auth_required', 'Google Cloud sign-in is required'))
      .mockResolvedValueOnce({ account: 'operator@example.com' });
    const prompts = promptFixture([true, true]);
    const runLogin = vi.fn(async () => 0);
    const resolveExecutable = vi.fn(async () => '/Users/operator/google-cloud-sdk/bin/gcloud');

    await expect(
      ensureGcloudReady('/repo', {
        check,
        resolveExecutable,
        runLogin,
        prompts,
      }),
    ).resolves.toEqual({ account: 'operator@example.com' });

    expect(check).toHaveBeenCalledTimes(3);
    expect(prompts.note).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('https://cloud.google.com/sdk/docs/install'),
      'Google Cloud CLI',
    );
    expect(prompts.note).toHaveBeenNthCalledWith(2, expect.stringMatching(/sign in/iu), 'Google Cloud');
    expect(resolveExecutable).toHaveBeenCalledWith(
      ['/custom/bin:/usr/bin', path.join(os.homedir(), 'google-cloud-sdk', 'bin')].join(path.delimiter),
    );
    expect(process.env.PATH?.split(path.delimiter)[0]).toBe('/Users/operator/google-cloud-sdk/bin');
    expect(runLogin).toHaveBeenCalledWith('/Users/operator/google-cloud-sdk/bin/gcloud', ['auth', 'login']);
  });

  it('does not prompt or launch login when Google Cloud is already ready', async () => {
    const prompts = promptFixture();
    const runLogin = vi.fn(async () => 0);

    await expect(
      ensureGcloudReady('/repo', {
        check: async () => ({ account: 'operator@example.com' }),
        resolveExecutable: async () => '/opt/homebrew/bin/gcloud',
        runLogin,
        prompts,
      }),
    ).resolves.toEqual({ account: 'operator@example.com' });

    expect(prompts.note).not.toHaveBeenCalled();
    expect(prompts.confirm).not.toHaveBeenCalled();
    expect(runLogin).not.toHaveBeenCalled();
  });

  it('fails without allocating resources when interactive login does not complete', async () => {
    const prompts = promptFixture([true]);
    const runLogin = vi.fn(async () => 1);

    await expect(
      ensureGcloudReady('/repo', {
        check: async () => {
          throw new GwsEaError('gcloud_auth_required', 'Google Cloud sign-in is required');
        },
        resolveExecutable: async () => '/opt/homebrew/bin/gcloud',
        runLogin,
        prompts,
      }),
    ).rejects.toMatchObject({ code: 'gcloud_auth_failed' });
  });

  it('does not repeat a successful login when credentials remain unavailable', async () => {
    const prompts = promptFixture([true]);
    const check = vi.fn(async () => {
      throw new GwsEaError('gcloud_auth_required', 'Google Cloud sign-in is required');
    });
    const runLogin = vi.fn(async () => 0);

    await expect(
      ensureGcloudReady('/repo', {
        check,
        resolveExecutable: async () => '/opt/homebrew/bin/gcloud',
        runLogin,
        prompts,
      }),
    ).rejects.toMatchObject({ code: 'gcloud_auth_required' });

    expect(prompts.confirm).toHaveBeenCalledOnce();
    expect(runLogin).toHaveBeenCalledOnce();
  });

  it('does not launch login when the operator declines', async () => {
    const prompts = promptFixture([false]);
    const runLogin = vi.fn(async () => 0);

    await expect(
      ensureGcloudReady('/repo', {
        check: async () => {
          throw new GwsEaError('gcloud_auth_required', 'Google Cloud sign-in is required');
        },
        resolveExecutable: async () => '/opt/homebrew/bin/gcloud',
        runLogin,
        prompts,
      }),
    ).rejects.toMatchObject({ code: 'cancelled' });

    expect(runLogin).not.toHaveBeenCalled();
  });
});
