import * as clack from '@clack/prompts';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import type { ProvisionHumanPause } from '../src/gws-ea/phases.js';
import { attendPause } from './gws-ea-pause.js';

const CANCEL = Symbol('cancel');

function prompts(answer: unknown = true) {
  return {
    note: vi.fn(),
    info: vi.fn(),
    confirm: vi.fn(async () => answer),
    select: vi.fn(async () => answer),
    isCancel: (value: unknown) => value === CANCEL,
  };
}

/** Real clack questions on an in-memory terminal, so cancelling them is clack's own behavior. */
function clackPrompts() {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => input });
  const output = new PassThrough();
  return {
    note: vi.fn(),
    info: vi.fn(),
    confirm: (options: Parameters<typeof clack.confirm>[0]) => clack.confirm({ ...options, input, output }),
    select: (options: Parameters<typeof clack.select<string>>[0]) => clack.select({ ...options, input, output }),
    isCancel: clack.isCancel,
  };
}

function pause(overrides: Partial<ProvisionHumanPause> = {}): ProvisionHumanPause {
  return {
    kind: 'human-action',
    phase: 'bind_principal',
    code: 'principal_dm_required',
    message: 'Ask the principal to send a direct message to the configured Google Chat app.',
    details: ['Principal: Taslim Okunola (not bound yet)'],
    ...overrides,
  };
}

const PRINCIPAL_CHOICE = pause({
  code: 'principal_selection_required',
  choices: [
    { id: 'mg-1', label: 'Taslim Okunola (gchat:users/1)' },
    { id: 'mg-2', label: 'Someone Else (gchat:users/2)' },
  ],
});

const CHAT_CONFIGURATION = pause({
  phase: 'configure_channel',
  code: 'chat_configuration_required',
  message: "Finish this assistant's Google Chat app configuration, then confirm it.",
  details: ['App name: Soji'],
  actionUrl: 'https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat',
  resumeFlag: '--chat-configured',
});

describe('attending a pause at the terminal', () => {
  it('confirms the Google Chat configuration in place, with its values and link', async () => {
    const terminal = prompts(true);

    await expect(attendPause(CHAT_CONFIGURATION, new AbortController().signal, { prompts: terminal })).resolves.toEqual(
      {
        kind: 'continue',
        decisions: { chatConfigured: true },
      },
    );
    expect(terminal.note).toHaveBeenCalledWith(
      expect.stringContaining('App name: Soji\nOpen: https://console.cloud.google.com/'),
      'Google Chat app',
    );

    await expect(
      attendPause(CHAT_CONFIGURATION, new AbortController().signal, { prompts: prompts(false) }),
    ).resolves.toEqual({ kind: 'stop' });
  });

  it('lets the person choose the principal conversation, or stop', async () => {
    await expect(
      attendPause(PRINCIPAL_CHOICE, new AbortController().signal, { prompts: prompts('mg-2') }),
    ).resolves.toEqual({
      kind: 'continue',
      decisions: { messagingGroupId: 'mg-2' },
    });
    await expect(
      attendPause(PRINCIPAL_CHOICE, new AbortController().signal, { prompts: prompts(CANCEL) }),
    ).resolves.toEqual({
      kind: 'stop',
    });
  });

  it('closes an open question and stops when the wait is stopped, as by SIGTERM', async () => {
    for (const open of [PRINCIPAL_CHOICE, CHAT_CONFIGURATION]) {
      const waiting = new AbortController();
      const attended = attendPause(open, waiting.signal, { prompts: clackPrompts() });
      waiting.abort();
      await expect(attended).resolves.toEqual({ kind: 'stop' });
    }
  });

  it('waits for what the person was asked to do, then continues on its own', async () => {
    const answers = [false, false, true];
    const settled = vi.fn(async () => answers.shift() ?? true);
    const sleep = vi.fn(async () => undefined);
    const terminal = prompts();

    await expect(
      attendPause(pause({ settled }), new AbortController().signal, { prompts: terminal, sleep }),
    ).resolves.toEqual({ kind: 'continue' });
    expect(settled).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(terminal.info).toHaveBeenCalledWith(expect.stringContaining('Press Ctrl-C to stop and resume later'));
  });

  it('stops waiting when interrupted or when a check cannot finish, and at once for a pause it cannot attend', async () => {
    const waiting = new AbortController();
    const settled = vi.fn(async () => false);
    const sleep = vi.fn(async () => waiting.abort());

    await expect(attendPause(pause({ settled }), waiting.signal, { prompts: prompts(), sleep })).resolves.toEqual({
      kind: 'stop',
    });
    expect(settled).toHaveBeenCalledOnce();

    // A check that cannot finish, as one Ctrl-C interrupts, stops the wait rather than failing the run.
    const failing = vi.fn(async (): Promise<boolean> => {
      throw new Error('Command was terminated by SIGINT');
    });
    await expect(
      attendPause(pause({ settled: failing }), new AbortController().signal, { prompts: prompts(), sleep }),
    ).resolves.toEqual({ kind: 'stop' });

    const terminal = prompts();
    await expect(
      attendPause(pause({ code: 'existing_endpoint_required' }), new AbortController().signal, { prompts: terminal }),
    ).resolves.toEqual({ kind: 'stop' });
    expect(terminal.note).not.toHaveBeenCalled();
  });
});
