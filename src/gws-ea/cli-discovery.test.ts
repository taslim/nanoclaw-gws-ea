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
  it('guides namespace help to complete named connector commands', async () => {
    const root = capture();
    expect(await runCli(['help', 'connectors'], root.runtime)).toBe(0);
    expect(root.stdout.join('\n')).toContain('gws-ea help connectors <action> <name>');
    expect(root.stdout.join('\n')).toContain('gws-ea help connectors install voice');
    expect(root.stdout.join('\n')).toContain('Installation: host; configuration: host; resources: host.');
    expect(root.stdout.join('\n')).toContain('Installation: host; configuration: host; resources: assistant.');
    expect(root.stdout.join('\n')).toContain('Every compatible managed assistant; recordings remain private.');
    expect(root.stdout.join('\n')).toContain('Scope: assistant-or-registry');
    const action = capture();
    expect(await runCli(['help', 'connectors', 'install'], action.runtime)).toBe(0);
    expect(action.stdout.join('\n')).toContain('gws-ea help connectors install <name>');
  });
  it('publishes four host lifecycle and targeted inspection paths for every connector', async () => {
    const io = capture();
    expect(await runCli(['schema', 'connectors', '--json'], io.runtime)).toBe(0);
    const schema: { commands: { path: string[]; scope: string; options: { name: string; required: boolean }[] }[] } =
      JSON.parse(io.stdout.join('\n'));
    expect(schema.commands).toHaveLength(13);
    expect(schema.commands.some((command) => command.path.includes('browser'))).toBe(false);
    for (const name of ['voice', 'onepassword', 'artifacts']) {
      const commands = schema.commands.filter((command) => command.path[2] === name);
      expect(commands.map((command) => command.path[1])).toEqual(['install', 'uninstall', 'show', 'check']);
      for (const command of commands) {
        const targeted = ['show', 'check'].includes(command.path[1]);
        expect(command.options.some((option) => option.name === 'id' && !option.required)).toBe(targeted);
      }
    }
    const help = capture();
    expect(await runCli(['help', 'connectors', 'install', 'onepassword'], help.runtime)).toBe(0);
    expect(help.stdout.join('\n')).toContain('--account <account_id>');
    expect(help.stdout.join('\n')).toContain('Integrate with 1Password CLI');
    expect(help.runtime.checkPrerequisites).not.toHaveBeenCalled();
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
    ['connectors', 'install', 'voice', '--help', '--json'],
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
    ['help', 'connectors'],
    ['connectors', '--help'],
    ['help', 'connectors', 'install', 'voice'],
    ['connectors', 'install', 'voice', '--help'],
  ])('discovers capability namespaces and operations for %j', async (...args) => {
    const io = capture();
    expect(await runCli(args, io.runtime)).toBe(0);
    expect(io.stdout.join('\n')).toContain('gws-ea connectors');
    expect(io.stdout.join('\n')).toContain('host');
    expect(io.stdout.join('\n')).not.toContain('install-voice');
    expect(io.stderr).toEqual([]);
    expect(io.runtime.checkPrerequisites).not.toHaveBeenCalled();
  });

  it('renders identical help for both capability install forms', async () => {
    const direct = capture();
    const requested = capture();
    expect(await runCli(['connectors', 'install', 'voice', '--help'], direct.runtime)).toBe(0);
    expect(await runCli(['help', 'connectors', 'install', 'voice'], requested.runtime)).toBe(0);
    expect(direct.stdout).toEqual(requested.stdout);
    expect(direct.stdout.join('\n')).toContain('--model');
    expect(direct.stdout.join('\n')).toContain('--cmake');
  });

  it.each([
    { args: ['connectors', 'install', 'voice', '--invented', '--json'], command: 'connectors install voice' },
    { args: ['--json', 'connectors', 'invented', 'voice'], command: 'connectors invented voice' },
    { args: ['connectors', 'install', 'calendar', '--json'], command: 'connectors install calendar' },
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
    if (args.includes('invented')) expect(io.stderr.join('\n')).toContain('gws-ea help connectors');
    if (args.includes('calendar')) expect(io.stderr.join('\n')).toContain('gws-ea help connectors');
  });

  it('rejects removed root voice paths', async () => {
    for (const command of ['install-voice', 'enable-voice', 'disable-voice', 'uninstall-voice']) {
      const io = capture();
      expect(await runCli([command], io.runtime)).toBe(2);
      expect(io.stderr.join('\n')).toContain('Unknown command');
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
COMP_WORDS=(gws-ea connectors install voice --model=small); COMP_CWORD=4; _gws_ea
printf '%s\\n' "\${COMPREPLY[@]}"
COMP_WORDS=(gws-ea ncl --id id -- groups --j); COMP_CWORD=6; _gws_ea
printf 'child-candidates:%s\\n' "\${#COMPREPLY[@]}"
`,
    ]);
    expect(stdout.trim().split('\n')).toEqual(['--source-remote', '--model=small', 'child-candidates:0']);
  });
});
