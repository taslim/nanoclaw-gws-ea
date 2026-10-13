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
    expect(io.stdout).toEqual([]);
    expect(io.stderr.join('\n')).toMatch(
      /provided twice|Unknown option|does not take a value|does not support --json/u,
    );
    expect(io.runtime.checkPrerequisites).not.toHaveBeenCalled();
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
          result_schema: expect.objectContaining({ type: 'object' }),
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
COMP_WORDS=(gws-ea install-voice --model=small); COMP_CWORD=2; _gws_ea
printf '%s\\n' "\${COMPREPLY[@]}"
COMP_WORDS=(gws-ea ncl --id id -- groups --j); COMP_CWORD=6; _gws_ea
printf 'child-candidates:%s\\n' "\${#COMPREPLY[@]}"
`,
    ]);
    expect(stdout.trim().split('\n')).toEqual(['--source-remote', '--model=small', 'child-candidates:0']);
  });
});
