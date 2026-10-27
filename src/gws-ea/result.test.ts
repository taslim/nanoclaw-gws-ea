import { describe, expect, it } from 'vitest';

import { registerSecret, REDACTED } from './redact.js';
import { managedResult, resultJson, type OperationData } from './result.js';
import type { AssistantListing } from './status.js';
import { expectResultContract } from './testing/result-contract.js';
import { GwsEaError } from './types.js';

describe('managed result redaction', () => {
  it.each(['create', 'resume', 'connect-google', 'update'])(
    'publishes the same recovery action contract for %s connector follow-ups and its envelope',
    (command) => {
      const actions = [
        { kind: 'command', argv: ['gws-ea', 'connectors', 'install', 'onepassword'] },
        { kind: 'external', instruction: 'Open the account console' },
        { kind: 'external', instruction: 'Open the account console', url: 'https://example.test/management' },
      ] as const;
      const result = JSON.parse(
        resultJson(
          managedResult(command, {
            outcome: 'paused',
            data: { connector_next_actions: actions },
            next_actions: actions,
          }),
        ),
      );
      expectResultContract(command, result);
      expect(result.data.connector_next_actions).toEqual(result.next_actions);
      expect(result.data.connector_next_actions[2].url).toBe('https://example.test/management');
    },
  );
  it('keeps native envelope identifiers while hiding the same credentials in raw text', () => {
    for (const secret of ['succeeded', 'invalid_arguments', 'connect-google', 'external', 'next_actions'])
      registerSecret(secret);
    const result = managedResult('connect-google', {
      outcome: 'succeeded',
      data: { raw: { code: 'invalid_arguments', outcome: 'succeeded', kind: 'external' } },
      error: new GwsEaError('invalid_arguments', 'Rejected connect-google with succeeded.'),
      next_actions: [{ kind: 'external', instruction: 'external', url: 'https://example.com/connect-google' }],
      diagnostics: { run_log: '/logs/succeeded.log' },
    });
    expect(JSON.parse(resultJson(result))).toEqual({
      schema_version: 1,
      command: 'connect-google',
      outcome: 'succeeded',
      changed: false,
      data: { raw: { code: REDACTED, outcome: REDACTED, kind: REDACTED } },
      error: { code: 'invalid_arguments', message: `Rejected ${REDACTED} with ${REDACTED}.` },
      next_actions: [{ kind: 'external', instruction: REDACTED, url: `https://example.com/${REDACTED}` }],
      diagnostics: { run_log: `/logs/${REDACTED}.log` },
    });
    expect(JSON.parse(resultJson(managedResult('next_actions', { outcome: 'failed' })))).toMatchObject({
      command: REDACTED,
      next_actions: [],
    });
  });

  it('keeps native nested error codes and resume syntax while hiding pause inputs and messages', () => {
    for (const secret of [
      'invalid_arguments',
      'confirmation_required',
      'configure_channel',
      '--chat-configured',
      '--google-client-file',
      'retained',
    ])
      registerSecret(secret);
    const data = {
      instance_id: 'invalid_arguments',
      preparation: { bootstrap_manifest: 'retained', reservation: 'unknown' },
      pause: {
        phase: 'configure_channel',
        code: 'confirmation_required',
        message: 'confirmation_required',
        details: ['retained'],
        resumeFlag: '--chat-configured --google-client-file <file>',
        choices: [{ id: '--chat-configured', label: 'retained' }],
      },
      cleanup: {
        checkout: '/retained',
        removed: ['retained'],
        error: { code: 'invalid_arguments', message: 'invalid_arguments' },
      },
    } satisfies OperationData;
    expect(JSON.parse(resultJson(managedResult('resume', { outcome: 'paused', data })))).toMatchObject({
      data: {
        instance_id: REDACTED,
        preparation: { bootstrap_manifest: 'retained', reservation: 'unknown' },
        pause: {
          phase: 'configure_channel',
          code: 'confirmation_required',
          message: REDACTED,
          details: [REDACTED],
          resumeFlag: '--chat-configured --google-client-file <file>',
          choices: [{ id: REDACTED, label: REDACTED }],
        },
        cleanup: {
          checkout: `/${REDACTED}`,
          removed: [REDACTED],
          error: { code: 'invalid_arguments', message: REDACTED },
        },
      },
    });
    expect(
      JSON.parse(
        resultJson(
          managedResult('resume', {
            outcome: 'paused',
            data: { pause: { ...data.pause, resumeFlag: '--google-client-file --chat-configured' } },
          }),
        ),
      ),
    ).toMatchObject({ data: { pause: { resumeFlag: `--google-client-file ${REDACTED}` } } });
  });

  it('keeps schema-defined native enums and union markers without exempting neighboring text', () => {
    for (const secret of ['invalid_arguments', 'not_installed', 'unreadable']) registerSecret(secret);
    const data = {
      observed_at: '2026-10-13T00:00:00.000Z',
      assistants: [
        {
          instance_id: 'not_installed',
          account: 'not_installed',
          track: 'unreadable',
          deployed_commit: 'unreadable',
          phase: { state: 'live', release: 'not_installed' },
          release: {
            deployed_commit: 'unreadable',
            tool_commit: null,
            behind_tool_release: null,
            reason: 'unreadable',
          },
          service: { state: 'not_installed', reason: 'not_installed' },
          operation: { state: 'unreadable', code: 'invalid_arguments', message: 'unreadable' },
          removal_in_progress: false,
        },
      ],
    } satisfies AssistantListing;
    expect(JSON.parse(resultJson(managedResult('list', { outcome: 'succeeded', data })))).toMatchObject({
      data: {
        assistants: [
          {
            instance_id: REDACTED,
            account: REDACTED,
            track: REDACTED,
            deployed_commit: REDACTED,
            phase: { state: 'live', release: REDACTED },
            release: { deployed_commit: REDACTED, reason: REDACTED },
            service: { state: 'not_installed', reason: REDACTED },
            operation: { state: 'unreadable', code: 'invalid_arguments', message: REDACTED },
          },
        ],
      },
    });
  });

  it('keeps recovery command grammar but consumes and redacts argument values', () => {
    for (const secret of [
      'connectors',
      '--secrets-file',
      '--source-remote',
      '--chat-configured',
      'large-v3-turbo-q5_0',
      'succeeded',
      'connect-google',
      'next_actions',
    ])
      registerSecret(secret);
    const result = managedResult('connectors install voice', {
      outcome: 'failed',
      next_actions: [
        { kind: 'command', argv: ['gws-ea', 'resume', '--id', 'succeeded', '--secrets-file', '--chat-configured'] },
        {
          kind: 'command',
          argv: ['gws-ea', 'update', '--source-remote=connect-google', '--quiet'],
        },
        { kind: 'command', argv: ['gws-ea', 'connectors', 'install', 'voice', '--model', 'large-v3-turbo-q5_0'] },
        { kind: 'command', argv: ['gws-ea', 'connectors', 'next_actions', '--chat-configured'] },
        { kind: 'command', argv: ['gws-ea', 'ncl', '--id', 'succeeded', '--', '--chat-configured'] },
      ],
    });
    expect(JSON.parse(resultJson(result))).toMatchObject({
      command: 'connectors install voice',
      next_actions: [
        { kind: 'command', argv: ['gws-ea', 'resume', '--id', REDACTED, '--secrets-file', REDACTED] },
        { kind: 'command', argv: ['gws-ea', 'update', `--source-remote=${REDACTED}`, '--quiet'] },
        { kind: 'command', argv: ['gws-ea', 'connectors', 'install', 'voice', '--model', REDACTED] },
        { kind: 'command', argv: ['gws-ea', REDACTED, REDACTED, REDACTED] },
        { kind: 'command', argv: ['gws-ea', 'ncl', '--id', REDACTED, '--', REDACTED] },
      ],
    });
  });
});
