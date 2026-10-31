import { describe, expect, it } from 'vitest';

import { COMMAND_DEFINITIONS } from './command-definitions.js';
import { runCli } from './cli.js';
import { parseInvocation } from './command-parser.js';

describe('connector command contract', () => {
  it('gives each connector the four lifecycle and inspection actions as complete paths', () => {
    for (const name of ['voice', 'web']) {
      const commands = COMMAND_DEFINITIONS.filter(
        (command) => command.path[0] === 'connectors' && command.path[2] === name,
      );
      expect(commands.map((command) => command.path[1]).sort()).toEqual(['check', 'install', 'show', 'uninstall']);
      for (const command of commands) expect(parseInvocation(command.path).definition).toBe(command);
    }
  });

  it('has no retired capability namespace, connector switches or browser command', () => {
    for (const args of [
      ['capabilities', 'list'],
      ['connectors', 'enable', 'voice'],
      ['connectors', 'disable', 'onepassword'],
      ['connectors', 'check', 'browser'],
      ['connectors', 'install', 'artifacts'],
      ['browser', 'enable'],
    ])
      expect(() => parseInvocation(args)).toThrow();
  });

  it('targets connector inspections optionally and alias identity explicitly', () => {
    const id = '00000000-0000-4000-8000-000000000001';
    for (const name of ['voice', 'web'])
      expect(parseInvocation(['connectors', 'check', name, '--id', id]).options.id).toBe(id);
    expect(parseInvocation(['alias', '--id', id]).definition.path).toEqual(['alias']);
    expect(() => parseInvocation(['alias'])).toThrow('--id');
  });
});

it('keeps the connector catalog limited to optional voice and web setup', () => {
  expect(
    COMMAND_DEFINITIONS.filter((command) => command.path[0] === 'connectors' && command.path[1] === 'install').map(
      (command) => command.path[2],
    ),
  ).toEqual(['voice', 'web']);
  expect(() => parseInvocation(['connectors', 'install', 'onepassword'])).toThrow();
});
it.each([['--delete-vault'], ['--abandon', 'onepassword'], ['--abandon', 'login-key']])(
  'refuses retired removal options %j',
  async (...options) => {
    const output: string[] = [];
    expect(
      await runCli(['remove', '--id', '00000000-0000-4000-8000-000000000001', ...options], {
        stdout: (line) => output.push(line),
        stderr: (line) => output.push(line),
      }),
    ).toBe(2);
  },
);
