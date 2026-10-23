import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import { describe, expect, it, vi } from 'vitest';

import { runCli } from './cli.js';
import { resolveControlPlanePaths } from './paths.js';

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const checkPrerequisites = vi.fn();
  return {
    stdout,
    stderr,
    runtime: {
      paths: resolveControlPlanePaths({ configRoot: '/missing/gws-ea/config', stateRoot: '/missing/gws-ea/state' }),
      environment: {},
      stdout: (line: string) => stdout.push(line),
      stderr: (line: string) => stderr.push(line),
      checkPrerequisites,
    },
  };
}

describe('local CLI discovery and grammar', () => {
  it('declares only the four assistant browser actions with native scoped options', async () => {
    const io = capture();
    expect(await runCli(['schema', 'capabilities', '--json'], io.runtime)).toBe(0);
    const schema: { commands: { path: string[]; scope: string; options: { name: string; required: boolean }[] }[] } =
      JSON.parse(io.stdout.join('\n'));
    const browser = schema.commands.filter((command) => command.path[2] === 'browser');
    expect(browser.map((command) => command.path[1])).toEqual(['show', 'check', 'enable', 'disable']);
    expect(browser.every((command) => command.scope === 'assistant')).toBe(true);
    expect(browser.every((command) => command.options.some((option) => option.name === 'id' && option.required))).toBe(
      true,
    );
    const missing = capture();
    expect(await runCli(['capabilities', 'show', 'browser'], missing.runtime)).toBe(2);
    expect(missing.stderr.join('\n')).toContain('--id');
    const voice = capture();
    expect(
      await runCli(['capabilities', 'enable', 'voice', '--id', '00000000-0000-4000-8000-000000000001'], voice.runtime),
    ).toBe(2);
    expect(voice.stderr.join('\n')).toContain('Unknown option --id');
    for (const action of ['install', 'uninstall']) {
      const unsupported = capture();
      expect(await runCli(['capabilities', action, 'browser', '--json'], unsupported.runtime)).toBe(2);
    }
    const invalid = capture();
    expect(await runCli(['capabilities', 'check', 'browser', '--id', 'partial', '--json'], invalid.runtime)).toBe(2);
    expect(JSON.parse(invalid.stdout.join('\n')).command).toBe('capabilities check browser');
  });
  it('declares the host-wide 1Password actions, naming the account and an unproven attempt only on enable', async () => {
    const io = capture();
    expect(await runCli(['schema', 'capabilities', '--json'], io.runtime)).toBe(0);
    const schema: { commands: { path: string[]; scope: string; options: { name: string; required: boolean }[] }[] } =
      JSON.parse(io.stdout.join('\n'));
    const onepassword = schema.commands.filter((command) => command.path[2] === 'onepassword');
    expect(onepassword.map((command) => command.path[1])).toEqual(['show', 'check', 'enable', 'disable']);
    expect(onepassword.every((command) => command.scope === 'host')).toBe(true);
    const own = (action: string) =>
      onepassword
        .find((command) => command.path[1] === action)
        ?.options.filter((option) => !['help', 'json', 'no-input', 'quiet'].includes(option.name))
        .map((option) => [option.name, option.required]);
    expect(own('show')).toEqual([]);
    expect(own('check')).toEqual([]);
    expect(own('disable')).toEqual([]);
    expect(own('enable')).toEqual([
      ['account', false],
      ['discard-unproven', false],
    ]);
    const scoped = capture();
    expect(
      await runCli(
        ['capabilities', 'enable', 'onepassword', '--id', '00000000-0000-4000-8000-000000000001'],
        scoped.runtime,
      ),
    ).toBe(2);
    expect(scoped.stderr.join('\n')).toContain('Unknown option --id');
    for (const action of ['install', 'uninstall']) {
      const unsupported = capture();
      expect(await runCli(['capabilities', action, 'onepassword', '--json'], unsupported.runtime)).toBe(2);
    }
    const help = capture();
    expect(await runCli(['help', 'capabilities', 'enable', 'onepassword'], help.runtime)).toBe(0);
    expect(help.stdout.join('\n')).toContain('--account <account_id>');
    expect(help.stdout.join('\n')).toContain('Scope: host');
    // Enable names what the operator's host needs: a current `op` and the signed-in desktop app's CLI integration.
    expect(help.stdout.join('\n')).toMatch(/1Password CLI \(op\) 2\.29 or later/u);
    expect(help.stdout.join('\n')).toContain('Integrate with 1Password CLI');
    expect(help.runtime.checkPrerequisites).not.toHaveBeenCalled();
    // Removal never revokes a service account; its help names how the kept receipt is closed afterwards.
    const remove = capture();
    expect(await runCli(['help', 'remove'], remove.runtime)).toBe(0);
    expect(remove.stdout.join('\n')).toContain('--yes --abandon onepassword');
  });
  it.each([
    ['help', 'update'],
    ['update', '--help'],
    ['--help', 'update'],
  ])('prints scoped help for %j without runtime setup', async (...args) => {
    const io = capture();
    expect(await runCli(args, io.runtime)).toBe(0);
    const text = io.stdout.join('\n');
    expect(text).toContain('Usage: gws-ea update');
    expect(text).toContain('--id <instance_id>');
    expect(text).toContain('--all');
    expect(text).toContain('Scope:');
    expect(text).toContain('Effects:');
    expect(text).toContain('Prerequisites:');
    expect(text).toContain('Recovery:');
    expect(text).not.toContain('Usage: gws-ea create');
    expect(io.stderr).toEqual([]);
    expect(io.runtime.checkPrerequisites).not.toHaveBeenCalled();
  });

  it.each([
    ['status', '--help', '--json'],
    ['schema', '--help', '--json'],
    ['--json', '--help'],
    ['capabilities', 'install', '--help', '--json'],
  ])('rejects machine help %j with one JSON usage result and schema guidance', async (...args) => {
    const io = capture();
    expect(await runCli(args, io.runtime)).toBe(2);
    expect(JSON.parse(io.stdout.join('\n'))).toMatchObject({
      outcome: 'failed',
      changed: false,
      error: { code: 'invalid_arguments', message: expect.stringContaining('schema') },
    });
    expect(io.runtime.checkPrerequisites).not.toHaveBeenCalled();
  });

  it.each([
    ['misspelled', '--help'],
    ['help', 'misspelled'],
    ['completion', 'powershell'],
  ])('returns usage exit 2 for %j even during discovery', async (...args) => {
    const io = capture();
    expect(await runCli(args, io.runtime)).toBe(2);
    expect(io.stderr.join('\n')).toMatch(/Unknown command|shell/u);
    expect(io.stdout).toEqual([]);
    expect(io.runtime.checkPrerequisites).not.toHaveBeenCalled();
  });

  it.each([
    ['create', '--track=dogfood', '--track', 'prod'],
    ['create', '--track=dogfood', '--invented'],
    ['create', '-track', 'dogfood'],
    ['list', '--json=true'],
    ['list', '--json', '--json'],
    ['--json', 'logs', '--id=00000000-0000-4000-8000-000000000001'],
    ['ncl', '--id=00000000-0000-4000-8000-000000000001', '--json', '--', 'groups', 'list'],
  ])('rejects invalid outer syntax %j before any operation', async (...args) => {
    const io = capture();
    expect(await runCli(args, io.runtime)).toBe(2);
    const outer = args.slice(0, args.indexOf('--') < 0 ? args.length : args.indexOf('--'));
    if (outer.includes('--json'))
      expect(JSON.parse(io.stdout.join('\n'))).toMatchObject({
        outcome: 'failed',
        changed: false,
        error: { code: 'invalid_arguments' },
      });
    else expect(io.stdout).toEqual([]);
    expect(io.stderr.join('\n')).toMatch(
      /provided twice|Unknown option|does not take a value|does not support --json/u,
    );
    expect(io.runtime.checkPrerequisites).not.toHaveBeenCalled();
  });

  it.each([
    ['help', 'capabilities'],
    ['capabilities', '--help'],
    ['help', 'capabilities', 'install'],
    ['capabilities', 'install', '--help'],
  ])('discovers capability namespaces and operations for %j', async (...args) => {
    const io = capture();
    expect(await runCli(args, io.runtime)).toBe(0);
    expect(io.stdout.join('\n')).toContain('gws-ea capabilities');
    expect(io.stdout.join('\n')).toContain('host');
    expect(io.stdout.join('\n')).not.toContain('install-voice');
    expect(io.stderr).toEqual([]);
    expect(io.runtime.checkPrerequisites).not.toHaveBeenCalled();
  });

  it('renders identical help for both capability install forms', async () => {
    const direct = capture();
    const requested = capture();
    expect(await runCli(['capabilities', 'install', '--help'], direct.runtime)).toBe(0);
    expect(await runCli(['help', 'capabilities', 'install'], requested.runtime)).toBe(0);
    expect(direct.stdout).toEqual(requested.stdout);
    expect(direct.stdout.join('\n')).toContain('--model');
    expect(direct.stdout.join('\n')).toContain('--cmake');
  });

  it.each([
    { args: ['capabilities', 'install', 'voice', '--invented', '--json'], command: 'capabilities install' },
    { args: ['--json', 'capabilities', 'invented', 'voice'], command: 'capabilities invented voice' },
    { args: ['capabilities', 'enable', 'calendar', '--json'], command: 'capabilities enable' },
  ])('retains the requested nested path in usage for $command', async ({ args, command }) => {
    const io = capture();
    expect(await runCli(args, io.runtime)).toBe(2);
    expect(JSON.parse(io.stdout.join('\n'))).toMatchObject({
      schema_version: 1,
      command,
      outcome: 'failed',
      changed: false,
      error: { code: 'invalid_arguments' },
    });
    expect(io.stderr.join('\n')).toMatch(/Unknown option|Unknown command|voice/u);
    if (args.includes('invented')) expect(io.stderr.join('\n')).toContain('gws-ea help capabilities');
    if (args.includes('calendar')) expect(io.stderr.join('\n')).toContain('gws-ea capabilities list');
  });

  it('rejects removed root voice paths and retains their capability protocol beside browser leaves', async () => {
    const io = capture();
    expect(await runCli(['schema', 'capabilities', '--json'], io.runtime)).toBe(0);
    const schema = JSON.parse(io.stdout.join('\n')) as {
      commands: { path: string[]; arguments: { choices?: string[] }[] }[];
    };
    expect(schema.commands.map((command) => command.path.join(' '))).toEqual([
      'capabilities list',
      'capabilities show',
      'capabilities check',
      'capabilities install',
      'capabilities enable',
      'capabilities disable',
      'capabilities uninstall',
      'capabilities show browser',
      'capabilities check browser',
      'capabilities enable browser',
      'capabilities disable browser',
      'capabilities show artifacts',
      'capabilities check artifacts',
      'capabilities enable artifacts',
      'capabilities disable artifacts',
      'capabilities show onepassword',
      'capabilities check onepassword',
      'capabilities enable onepassword',
      'capabilities disable onepassword',
    ]);
    expect(schema.commands.slice(1, 7).every((command) => command.arguments[0].choices?.join() === 'voice')).toBe(true);
    for (const command of ['install-voice', 'enable-voice', 'disable-voice', 'uninstall-voice']) {
      const removed = capture();
      expect(await runCli([command], removed.runtime)).toBe(2);
      expect(removed.stderr.join('\n')).toContain('Unknown command');
    }
  });

  it('publishes parser options, scope, modes, and results in command schema', async () => {
    const io = capture();
    expect(await runCli(['schema', 'create', '--json'], io.runtime)).toBe(0);
    expect(JSON.parse(io.stdout.join('\n'))).toMatchObject({
      schema_version: 1,
      commands: [
        {
          path: ['create'],
          scope: 'new-assistant',
          options: expect.arrayContaining([
            expect.objectContaining({ name: 'track', type: 'string', required: true, repeatable: false }),
            expect.objectContaining({ name: 'principal-email', type: 'string', repeatable: true }),
          ]),
          output_modes: ['human', 'json'],
          result_schema: expect.objectContaining({
            type: 'object',
            required: [
              'schema_version',
              'command',
              'outcome',
              'changed',
              'data',
              'error',
              'next_actions',
              'diagnostics',
            ],
            additionalProperties: false,
            properties: expect.objectContaining({
              schema_version: { const: 1 },
              outcome: { type: 'string', enum: ['succeeded', 'paused', 'failed', 'busy', 'cancelled'] },
              data: {
                anyOf: [
                  expect.objectContaining({
                    type: 'object',
                    properties: expect.objectContaining({
                      instance_id: { type: 'string' },
                      pause: expect.objectContaining({ required: ['phase', 'code', 'message'] }),
                    }),
                  }),
                  { type: 'null' },
                ],
              },
            }),
          }),
        },
      ],
    });
    expect(io.stderr).toEqual([]);
  });

  it.each([['status'], ['status', '--id=partial']])(
    'requires an explicit full assistant ID for %j',
    async (...args) => {
      const io = capture();
      expect(await runCli(args, io.runtime)).toBe(2);
      expect(io.stderr.join('\n')).toMatch(/Missing required option --id|full assistant ID/u);
      expect(io.stdout).toEqual([]);
    },
  );

  it.each(['bad/track', 'canary'])(
    'reports invalid or incomplete initial release inputs for %s as usage',
    async (track) => {
      const io = capture();
      expect(await runCli(['create', `--track=${track}`], io.runtime)).toBe(2);
      expect(io.stderr.join('\n')).toMatch(/valid track name|--source-remote/u);
      expect(io.stdout).toEqual([]);
      expect(io.runtime.checkPrerequisites).not.toHaveBeenCalled();
    },
  );

  it.each(['zsh', 'bash', 'fish'])('generates %s completion from the schema command inventory', async (shell) => {
    const schemaIo = capture();
    const completionIo = capture();
    expect(await runCli(['schema', '--json'], schemaIo.runtime)).toBe(0);
    expect(await runCli(['completion', shell], completionIo.runtime)).toBe(0);
    const schema = JSON.parse(schemaIo.stdout.join('\n')) as {
      commands: readonly { path: readonly string[]; options: readonly { name: string }[] }[];
    };
    const completion = completionIo.stdout.join('\n');
    for (const command of schema.commands) {
      expect(completion).toContain(command.path.join(' '));
      for (const option of command.options) expect(completion).toContain(`--${option.name}`);
    }
    expect(completionIo.stderr).toEqual([]);
  });

  it('discovers the declared version path in scoped help and schema', async () => {
    const help = capture();
    expect(await runCli(['help', '--version'], help.runtime)).toBe(0);
    expect(help.stdout.join('\n')).toContain('distinct from an assistant');
    const schema = capture();
    expect(await runCli(['schema', '--version', '--json'], schema.runtime)).toBe(0);
    expect(JSON.parse(schema.stdout.join('\n')).commands[0].path).toEqual(['--version']);
  });

  it('reports the tool package release and actual checkout revision', async () => {
    const io = capture();
    const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    const { stdout: revision } = await promisify(execFile)('git', ['rev-parse', 'HEAD']);
    expect(await runCli(['--version'], io.runtime)).toBe(0);
    expect(io.stdout.join('\n')).toContain(manifest.version);
    expect(io.stdout.join('\n')).toContain(revision.trim());
    expect(io.stderr).toEqual([]);
    expect(io.runtime.checkPrerequisites).not.toHaveBeenCalled();
  });

  it('runs generated bash completion with scoped flags, equals values, and a native delimiter', async () => {
    const io = capture();
    expect(await runCli(['completion', 'bash'], io.runtime)).toBe(0);
    const generated = io.stdout.join('\n');
    const { stdout } = await promisify(execFile)('/bin/bash', [
      '-c',
      `${generated}
COMP_WORDS=(gws-ea --quiet update --s); COMP_CWORD=3; _gws_ea
printf '%s\\n' "\${COMPREPLY[@]}"
COMP_WORDS=(gws-ea capabilities install voice --model=small); COMP_CWORD=4; _gws_ea
printf '%s\\n' "\${COMPREPLY[@]}"
COMP_WORDS=(gws-ea ncl --id id -- groups --j); COMP_CWORD=6; _gws_ea
printf 'child-candidates:%s\\n' "\${#COMPREPLY[@]}"
`,
    ]);
    expect(stdout.trim().split('\n')).toEqual(['--source-remote', '--model=small', 'child-candidates:0']);
  });
});
