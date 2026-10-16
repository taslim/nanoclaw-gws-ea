import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { completionScript } from './command-discovery.js';

const execute = promisify(execFile);
let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'gws-ea-completion-'));
  await mkdir(path.join(root, 'config files'));
  await writeFile(path.join(root, 'config files', 'client file.json'), '{}');
});
afterEach(async () => rm(root, { recursive: true, force: true }));

const scenarios = [
  {
    words: ['gws-ea', 'create', '--assistant-first-name', 'capabilities', ''],
    includes: '--track',
    excludes: 'install',
  },
  { words: ['gws-ea', 'help', 'capabilities', ''], includes: 'install', excludes: 'create' },
  { words: ['gws-ea', 'schema', 'capabilities', ''], includes: 'install', excludes: 'create' },
  { words: ['gws-ea', 'help', '--version', ''], includes: '--help', excludes: 'create' },
  { words: ['gws-ea', 'capabilities', 'install', 'voice', ''], includes: '--model', excludes: 'voice' },
  { words: ['gws-ea', 'capabilities', 'enable', 'browser', ''], includes: '--id', excludes: '--model' },
  { words: ['gws-ea', 'capabilities', 'check', 'browser', ''], includes: '--id', excludes: '--model' },
  { words: ['gws-ea', 'capabilities', 'enable', ''], includes: 'onepassword', excludes: '--id' },
  { words: ['gws-ea', 'capabilities', 'enable', 'onepassword', ''], includes: '--account', excludes: '--id' },
  { words: ['gws-ea', 'capabilities', 'check', 'onepassword', ''], includes: '--json', excludes: '--account' },
  {
    words: ['gws-ea', 'capabilities', 'install', 'voice', '--model', '=', 'sm'],
    includes: 'small',
    excludes: '--model',
  },
  { words: ['gws-ea', 'ncl', '--id', 'id', '--', 'groups', ''], includes: null, excludes: '--json' },
] as const;
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

describe('executed shell completion', () => {
  it.each(scenarios)('bash respects the grammar for $words', async ({ words, includes, excludes }) => {
    const { stdout } = await execute('/bin/bash', [
      '--noprofile',
      '--norc',
      '-c',
      `${completionScript('bash')}
COMP_WORDS=(${words.map(quote).join(' ')}); COMP_CWORD=${words.length - 1}; _gws_ea
printf '%s\\n' "\${COMPREPLY[@]}"`,
    ]);
    const candidates = stdout.trim().split('\n').filter(Boolean);
    if (includes) expect(candidates).toContain(includes);
    else expect(candidates).toEqual([]);
    expect(candidates).not.toContain(excludes);
  });

  it('bash completes a file value with spaces without splitting it or reading assistant state', async () => {
    const value = path.join(root, 'config files', 'client ');
    const { stdout } = await execute('/bin/bash', [
      '--noprofile',
      '--norc',
      '-c',
      `${completionScript('bash')}
COMP_WORDS=(gws-ea connect-google --google-client-file ${quote(value)}); COMP_CWORD=3; _gws_ea
printf '%s\\n' "\${COMPREPLY[@]}"`,
    ]);
    expect(stdout.trim()).toBe(path.join(root, 'config files', 'client file.json'));
  });

  it.each(scenarios.filter(({ words }) => !words.some((word) => word === '=')))(
    'zsh executes scoped traversal for $words',
    async ({ words, includes, excludes }) => {
      // compadd consumes candidates inside zsh's completion widget. Capturing that handoff
      // lets this noninteractive shell assert grammar without changing shell configuration.
      const { stdout } = await execute('/bin/zsh', [
        '-f',
        '-c',
        `compdef() { :; }
compadd() { while [[ "$1" != -- && $# -gt 0 ]]; do shift; done; shift; printf '%s\\n' "$@"; }
${completionScript('zsh')}
words=(${words.map(quote).join(' ')}); CURRENT=${words.length}; _gws_ea`,
      ]);
      const candidates = stdout.trim().split('\n').filter(Boolean);
      if (includes) expect(candidates).toContain(includes);
      else expect(candidates).toEqual([]);
      expect(candidates).not.toContain(excludes);
    },
  );

  const fish = process.env.GWS_EA_FISH_TEST_BINARY;
  it.skipIf(!fish)(
    'fish completes nested discovery, consumed capability names, option values and escaped files',
    async () => {
      const script = path.join(root, 'completion.fish');
      await writeFile(script, completionScript('fish'));
      const { stdout } = await execute(
        fish!,
        [
          '--no-config',
          '--private',
          '-c',
          `source ${quote(script)}
for input in 'gws-ea help capabilities ' 'gws-ea schema capabilities ' 'gws-ea create --assistant-first-name capabilities --t' 'gws-ea capabilities install voice '
  echo SCENARIO
  complete -C "$input"
end
 echo SCENARIO
 complete -C ${quote(`gws-ea connect-google --google-client-file '${path.join(root, 'config files', 'client ')}'`)}
 echo SCENARIO
 complete -C 'gws-ea ncl --id id -- groups '`,
        ],
        { env: { ...process.env, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root } },
      );
      const parts = stdout
        .split('SCENARIO\n')
        .slice(1)
        .map((part) =>
          part
            .trim()
            .split('\n')
            .map((line) => line.split('\t')[0])
            .filter(Boolean),
        );
      expect(parts[0]).toContain('install');
      expect(parts[1]).toContain('install');
      expect(parts[2]).toContain('--track');
      expect(parts[3]).not.toContain('voice');
      expect(parts[4]).toEqual([path.join(root, 'config files', 'client file.json')]);
      expect(parts[5]).toEqual([]);
    },
  );
});
