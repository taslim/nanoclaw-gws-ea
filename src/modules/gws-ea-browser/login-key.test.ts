import { describe, expect, it } from 'vitest';
import type { SanitizedCommand, SanitizedCommandOutcomeRunner } from '../../gws-ea/process.js';
import { GwsEaError } from '../../gws-ea/types.js';
import { LoginKey } from './login-key.js';

const INSTANCE = '38d6fb28-6c7f-4cc4-afaf-2919e8868cce';
const HEX = 'c3'.repeat(32);

it('creates through private stdin and confirms the Keychain value without placing a key in argv or env', async () => {
  const calls: SanitizedCommand[] = [];
  let generatedKey = '';
  const runCommand: SanitizedCommandOutcomeRunner = async (command) => {
    calls.push(command);
    if (command.args[0] === '-i') {
      generatedKey = command.input?.match(/-w ([a-f0-9]{64})/u)?.[1] ?? '';
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    return { exitCode: 0, stdout: `${generatedKey}\n`, stderr: '' };
  };
  const result = await new LoginKey({ instanceId: INSTANCE, runCommand }).create();
  expect(result.status).toBe('ready');
  if (result.status === 'ready') expect(result.key.toString('hex')).toBe(generatedKey);
  expect(calls).toHaveLength(2);
  expect(calls[0].args).toEqual(['-i']);
  expect(calls[0].input).toMatch(
    new RegExp(`^add-generic-password -s gws-ea\\.saved-logins -a ${INSTANCE} -w [a-f0-9]{64}\\n$`, 'u'),
  );
  const generated = calls[0].input?.match(/-w ([a-f0-9]{64})/u)?.[1];
  expect(generated).toBeDefined();
  for (const call of calls) {
    expect(call.command).toBe('/usr/bin/security');
    expect(call.privateOutput).toBe(true);
    expect(call.timeoutMs).toBeGreaterThan(0);
    expect(JSON.stringify({ args: call.args, env: call.env })).not.toContain(generated);
  }
  expect(calls[1].args).toEqual(['find-generic-password', '-s', 'gws-ea.saved-logins', '-a', INSTANCE, '-w']);
});

it('reads freshly on every use', async () => {
  let reads = 0;
  const runCommand: SanitizedCommandOutcomeRunner = async () => ({
    exitCode: ++reads === 1 ? 0 : 44,
    stdout: reads === 1 ? HEX : '',
    stderr: '',
  });
  const key = new LoginKey({ instanceId: INSTANCE, runCommand });
  expect((await key.read()).status).toBe('ready');
  expect(await key.read()).toEqual({ status: 'missing' });
  expect(reads).toBe(2);
});

describe('constant Keychain outcomes', () => {
  it.each([36, 51, 1])('maps exit %i to unavailable', async (exitCode) => {
    const key = new LoginKey({
      instanceId: INSTANCE,
      runCommand: async () => ({ exitCode, stdout: HEX, stderr: 'secret error detail' }),
    });
    expect(await key.read()).toEqual({ status: 'unavailable' });
  });
  it('maps missing to missing and a timeout to unavailable without exposing the process error', async () => {
    const missing = new LoginKey({
      instanceId: INSTANCE,
      runCommand: async () => ({ exitCode: 44, stdout: '', stderr: '' }),
    });
    expect(await missing.read()).toEqual({ status: 'missing' });
    const timedOut = new LoginKey({
      instanceId: INSTANCE,
      runCommand: async () => {
        throw new GwsEaError('command_timeout', HEX);
      },
    });
    expect(await timedOut.read()).toEqual({ status: 'unavailable' });
  });
  it('refuses a malformed key and verifies creation even when interactive security reports success', async () => {
    const key = new LoginKey({
      instanceId: INSTANCE,
      runCommand: async () => ({ exitCode: 0, stdout: 'not a key', stderr: '' }),
    });
    expect(await key.read()).toEqual({ status: 'unavailable' });
    expect(await key.create()).toEqual({ status: 'unavailable' });
  });
  it.each([0, 44])('treats delete exit %i as removed', async (exitCode) => {
    const calls: SanitizedCommand[] = [];
    const key = new LoginKey({
      instanceId: INSTANCE,
      runCommand: async (command) => {
        calls.push(command);
        return { exitCode, stdout: '', stderr: '' };
      },
    });
    expect(await key.remove()).toEqual({ status: 'removed' });
    expect(calls[0].args).toEqual(['delete-generic-password', '-s', 'gws-ea.saved-logins', '-a', INSTANCE]);
    expect(calls[0].privateOutput).toBe(true);
    expect(calls[0].timeoutMs).toBeGreaterThan(0);
  });
});

it('refuses a successful create whose readback contains a different key', async () => {
  const key = new LoginKey({
    instanceId: INSTANCE,
    runCommand: async (command) => ({ exitCode: 0, stdout: command.args[0] === '-i' ? '' : HEX, stderr: '' }),
  });
  expect(await key.create()).toEqual({ status: 'unavailable' });
});

it('reports an unreachable delete without throwing secret-bearing process errors', async () => {
  const key = new LoginKey({
    instanceId: INSTANCE,
    runCommand: async () => {
      throw new Error(HEX);
    },
  });
  expect(await key.remove()).toEqual({ status: 'unavailable' });
});
