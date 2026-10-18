import * as clack from '@clack/prompts';
import os from 'node:os';
import path from 'node:path';
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
    text: vi.fn(async () => answer),
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
    text: (options: Parameters<typeof clack.text>[0]) => clack.text({ ...options, input, output }),
    isCancel: clack.isCancel,
  };
}

function pause(overrides: Partial<ProvisionHumanPause> = {}): ProvisionHumanPause {
  return {
    kind: 'human-action',
    phase: 'verify_conversation',
    code: 'later_principal_message_missing',
    message: "Ask the principal to reply to the assistant's welcome in Google Chat.",
    details: ['Bound principal: Morgan Ellery (gchat:users/2001)'],
    ...overrides,
  };
}

const BILLING_CHOICE = pause({
  phase: 'provision_gcp',
  code: 'gcp_billing_account_choice_required',
  message: 'Choose the billing account that pays for Google Cloud project gws-ea-juno.',
  details: [],
  choices: [
    { id: '01A2B3-C4D5E6-F7A8B9', label: 'Northwind (01A2B3-C4D5E6-F7A8B9)' },
    { id: '0B1C2D-3E4F5A-6B7C8D', label: 'Juno Hale personal (0B1C2D-3E4F5A-6B7C8D)' },
  ],
  resumeFlag: '--billing-account',
});

const CHAT_CONFIGURATION = pause({
  phase: 'configure_channel',
  code: 'chat_configuration_required',
  message: "Configure the Google Chat API for this assistant's project, then confirm it.",
  details: ['App name: Juno'],
  actionUrl: 'https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat',
  resumeFlag: '--chat-configured',
});

const GOOGLE_CLIENT = pause({
  phase: 'sign_in_google',
  code: 'google_client_required',
  message: "Create the assistant's Google sign-in client, then continue with its file.",
  details: ['Under Clients, create an OAuth client of type Desktop app and download its JSON.'],
  actionUrl: 'https://console.cloud.google.com/auth/clients?project=gws-ea-juno',
  resumeFlag: '--google-client-file <file>',
});

const ALIAS_REQUIRED = pause({
  phase: 'provision_alias',
  code: 'alias_required',
  message: 'Add onuj@example.test as an alias of juno@example.test in the Google Admin console, then confirm it.',
  details: ['Add the alternate email onuj on example.test, then Save'],
  actionUrl: 'https://admin.google.com/ac/users',
  resumeFlag: '--alias-added',
});

describe("attending the web alias's pauses", () => {
  it('shows where to add the alias, then records that it is added, taken, or named otherwise', async () => {
    const added = prompts('added');
    await expect(attendPause(ALIAS_REQUIRED, new AbortController().signal, { prompts: added })).resolves.toEqual({
      kind: 'continue',
      decisions: { alias: { kind: 'added' } },
    });
    expect(added.note).toHaveBeenCalledWith(
      'Add the alternate email onuj on example.test, then Save\nOpen: https://admin.google.com/ac/users',
      "The assistant's web alias",
    );
    expect(added.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: ALIAS_REQUIRED.message,
        options: [
          { value: 'added', label: 'It is added' },
          { value: 'taken', label: 'The Admin console says it is already in use' },
          { value: 'named', label: 'Use a name of my own' },
        ],
      }),
    );

    await expect(
      attendPause(ALIAS_REQUIRED, new AbortController().signal, { prompts: prompts('taken') }),
    ).resolves.toEqual({ kind: 'continue', decisions: { alias: { kind: 'taken' } } });

    const named = prompts('named');
    named.text.mockResolvedValueOnce('postmaster').mockResolvedValueOnce(' Juno.Web ');
    await expect(attendPause(ALIAS_REQUIRED, new AbortController().signal, { prompts: named })).resolves.toEqual({
      kind: 'continue',
      decisions: { alias: { kind: 'named', name: 'Juno.Web' } },
    });
    // A name the Admin console would refuse, or a role address, is asked for again.
    expect(named.info).toHaveBeenCalledWith(expect.stringContaining('role address'));
    expect(named.text).toHaveBeenCalledTimes(2);

    await expect(
      attendPause(ALIAS_REQUIRED, new AbortController().signal, { prompts: prompts(CANCEL) }),
    ).resolves.toEqual({ kind: 'stop' });
  });

  it('checks again for a test message not yet arrived, without sending another', async () => {
    const waiting = pause({
      phase: 'provision_alias',
      code: 'alias_not_delivered',
      message: 'The test message to onuj@example.test has not arrived yet.',
      details: [],
    });
    const terminal = prompts('check');

    await expect(attendPause(waiting, new AbortController().signal, { prompts: terminal })).resolves.toEqual({
      kind: 'continue',
      decisions: { alias: undefined },
    });
    expect(terminal.select).toHaveBeenCalledWith(
      expect.objectContaining({
        options: [
          { value: 'check', label: 'Check again' },
          { value: 'taken', label: 'The Admin console says it is already in use' },
          { value: 'named', label: 'Use a name of my own' },
        ],
      }),
    );
  });

  it('asks for a name when the assistant has none to offer, and stops while its host is down', async () => {
    const unnamed = pause({
      phase: 'provision_alias',
      code: 'alias_name_required',
      message: 'Name Aaa\'s web alias: "Aaa" reads the same reversed and rotated.',
      details: [],
      resumeFlag: '--alias <name>',
    });
    await expect(attendPause(unnamed, new AbortController().signal, { prompts: prompts('aaa.web') })).resolves.toEqual({
      kind: 'continue',
      decisions: { alias: { kind: 'named', name: 'aaa.web' } },
    });

    const stopped = prompts('added');
    await expect(
      attendPause(
        pause({ phase: 'provision_alias', code: 'alias_host_unavailable', message: 'The host did not answer.' }),
        new AbortController().signal,
        { prompts: stopped },
      ),
    ).resolves.toEqual({ kind: 'stop' });
    expect(stopped.select).not.toHaveBeenCalled();
  });
});

describe('attending a pause at the terminal', () => {
  it('asks for the downloaded Google client file in place, with its instructions and link', async () => {
    const terminal = prompts('~/Downloads/client.json');

    await expect(attendPause(GOOGLE_CLIENT, new AbortController().signal, { prompts: terminal })).resolves.toEqual({
      kind: 'continue',
      decisions: { googleClientFile: path.join(os.homedir(), 'Downloads', 'client.json') },
    });
    expect(terminal.note).toHaveBeenCalledWith(
      expect.stringContaining(
        'Desktop app and download its JSON.\nOpen: https://console.cloud.google.com/auth/clients',
      ),
      "The assistant's Google sign-in client",
    );

    await expect(
      attendPause(GOOGLE_CLIENT, new AbortController().signal, { prompts: prompts(CANCEL) }),
    ).resolves.toEqual({ kind: 'stop' });
    await expect(
      attendPause(GOOGLE_CLIENT, new AbortController().signal, { prompts: prompts('   ') }),
    ).resolves.toEqual({ kind: 'stop' });
  });

  it('confirms the Google Chat configuration in place, with its values and link', async () => {
    const terminal = prompts(true);

    await expect(attendPause(CHAT_CONFIGURATION, new AbortController().signal, { prompts: terminal })).resolves.toEqual(
      {
        kind: 'continue',
        decisions: { chatConfigured: true },
      },
    );
    expect(terminal.note).toHaveBeenCalledWith(
      expect.stringContaining('App name: Juno\nOpen: https://console.cloud.google.com/'),
      'Google Chat API',
    );

    await expect(
      attendPause(CHAT_CONFIGURATION, new AbortController().signal, { prompts: prompts(false) }),
    ).resolves.toEqual({ kind: 'stop' });
  });

  it('takes the Chat confirmation and the sign-in client file in one console visit when the pause asks for both', async () => {
    const both = { ...CHAT_CONFIGURATION, resumeFlag: '--chat-configured --google-client-file <file>' };
    const terminal = prompts(true);
    terminal.text.mockResolvedValueOnce('~/Downloads/client.json');

    await expect(attendPause(both, new AbortController().signal, { prompts: terminal })).resolves.toEqual({
      kind: 'continue',
      decisions: { chatConfigured: true, googleClientFile: path.join(os.homedir(), 'Downloads', 'client.json') },
    });
    expect(terminal.note).toHaveBeenCalledWith(expect.stringContaining('App name: Juno'), 'Google Cloud console');

    // Left blank, the Chat configuration still counts, and the sign-in asks for the file again.
    const blank = prompts(true);
    blank.text.mockResolvedValueOnce('   ');
    await expect(attendPause(both, new AbortController().signal, { prompts: blank })).resolves.toEqual({
      kind: 'continue',
      decisions: { chatConfigured: true },
    });

    // Cancelled, as Ctrl-C does, the run stops.
    const cancelled = prompts(true);
    cancelled.text.mockResolvedValueOnce(CANCEL);
    await expect(attendPause(both, new AbortController().signal, { prompts: cancelled })).resolves.toEqual({
      kind: 'stop',
    });
  });

  it('lets the person make the choice a pause offers, as the decision its resume flag records, or stop', async () => {
    const terminal = prompts('0B1C2D-3E4F5A-6B7C8D');

    await expect(attendPause(BILLING_CHOICE, new AbortController().signal, { prompts: terminal })).resolves.toEqual({
      kind: 'continue',
      decisions: { billingAccount: '0B1C2D-3E4F5A-6B7C8D' },
    });
    expect(terminal.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: BILLING_CHOICE.message,
        options: [
          { value: '01A2B3-C4D5E6-F7A8B9', label: 'Northwind (01A2B3-C4D5E6-F7A8B9)' },
          { value: '0B1C2D-3E4F5A-6B7C8D', label: 'Juno Hale personal (0B1C2D-3E4F5A-6B7C8D)' },
        ],
      }),
    );
    await expect(
      attendPause(BILLING_CHOICE, new AbortController().signal, { prompts: prompts(CANCEL) }),
    ).resolves.toEqual({
      kind: 'stop',
    });
  });

  it('stops, asking nothing, at a choice whose resume flag records no decision', async () => {
    const terminal = prompts('anything');

    await expect(
      attendPause({ ...BILLING_CHOICE, resumeFlag: '--unknown-choice' }, new AbortController().signal, {
        prompts: terminal,
      }),
    ).resolves.toEqual({ kind: 'stop' });
    expect(terminal.select).not.toHaveBeenCalled();
  });

  it('closes an open question and stops when the wait is stopped, as by SIGTERM', async () => {
    for (const open of [BILLING_CHOICE, CHAT_CONFIGURATION]) {
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

    // A pause with nothing to choose, confirm, locate, or wait for: the person acts elsewhere, then resumes.
    const terminal = prompts();
    const policyAdmin = pause({
      phase: 'provision_gcp',
      code: 'gcp_policy_permission_required',
      message: 'Google Cloud refused to change the service-account key-creation policy on project gws-ea-juno.',
      details: [],
    });
    await expect(attendPause(policyAdmin, new AbortController().signal, { prompts: terminal })).resolves.toEqual({
      kind: 'stop',
    });
    expect(terminal.note).not.toHaveBeenCalled();
  });
});
