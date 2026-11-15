import { expect, it } from 'vitest';
import type { SanitizedCommand, SanitizedCommandOutcomeRunner } from '../../gws-ea/process.js';
import { KeychainKey } from './key.js';

const INSTANCE = '5f0c2b1e-8a43-4d0e-9c7b-2e6f1a9d3c50';

/** A fake Keychain holding generic passwords by service and account, as /usr/bin/security does. */
function fakeKeychain(): { runCommand: SanitizedCommandOutcomeRunner; calls: SanitizedCommand[] } {
  const items = new Map<string, string>();
  const calls: SanitizedCommand[] = [];
  const option = (args: readonly string[], flag: string): string => args[args.indexOf(flag) + 1] ?? '';
  const runCommand: SanitizedCommandOutcomeRunner = async (command) => {
    calls.push(command);
    const args = command.args[0] === '-i' ? (command.input ?? '').trim().split(' ') : command.args;
    const item = `${option(args, '-s')}|${option(args, '-a')}`;
    switch (args[0]) {
      case 'add-generic-password':
        if (items.has(item)) return { exitCode: 45, stdout: '', stderr: '' };
        items.set(item, option(args, '-w'));
        return { exitCode: 0, stdout: '', stderr: '' };
      case 'find-generic-password': {
        const value = items.get(item);
        return value ? { exitCode: 0, stdout: `${value}\n`, stderr: '' } : { exitCode: 44, stdout: '', stderr: '' };
      }
      case 'delete-generic-password':
        return { exitCode: items.delete(item) ? 0 : 44, stdout: '', stderr: '' };
      default:
        return { exitCode: 1, stdout: '', stderr: '' };
    }
  };
  return { runCommand, calls };
}

it('keeps each service’s key independent under the same assistant, including removal', async () => {
  const { runCommand, calls } = fakeKeychain();
  const logins = new KeychainKey({ service: 'gws-ea.saved-logins', instanceId: INSTANCE, runCommand });
  const connections = new KeychainKey({ service: 'gws-ea.connections', instanceId: INSTANCE, runCommand });

  const first = await logins.create();
  expect(await connections.read()).toEqual({ status: 'missing' });
  const second = await connections.create();
  if (first.status !== 'ready' || second.status !== 'ready') throw new Error('Both keys should be created');
  expect(first.key.equals(second.key)).toBe(false);

  expect(await connections.remove()).toEqual({ status: 'removed' });
  expect(await connections.read()).toEqual({ status: 'missing' });
  const remaining = await logins.read();
  expect(remaining.status).toBe('ready');
  if (remaining.status === 'ready') expect(remaining.key.equals(first.key)).toBe(true);

  expect(calls.filter((call) => call.args.includes('gws-ea.connections')).map((call) => call.args[0])).toEqual([
    'find-generic-password',
    'find-generic-password',
    'delete-generic-password',
    'find-generic-password',
  ]);
  expect(calls.find((call) => call.args[0] === '-i')?.input).toMatch(/^add-generic-password -s gws-ea\.saved-logins /u);
});

it.each([
  ['service', { service: 'gws-ea connections', instanceId: INSTANCE }],
  ['service', { service: '-w', instanceId: INSTANCE }],
  ['account', { service: 'gws-ea.connections', instanceId: `${INSTANCE}\ndelete-keychain` }],
])('refuses a %s that could change the interactive Keychain command', (_part, options) => {
  expect(
    () => new KeychainKey({ ...options, runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '' }) }),
  ).toThrow();
});
