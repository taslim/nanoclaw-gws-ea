import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { SanitizedCommandOutcomeRunner } from '../../gws-ea/process.js';
import { KeychainKey } from './key.js';
import { SealUnavailableError, StoreSeal, seal, unseal, type SealedFile } from './seal.js';

const KEY = Buffer.from('6b'.repeat(32), 'hex');
const SECRET = 'Lantern-harbor-41';

describe('seal and unseal', () => {
  it('round-trips with a fresh IV and refuses another label, another key, or a malformed value', () => {
    const value = Buffer.from(SECRET, 'utf8');
    const first = seal(value, KEY, 'gws-ea-connections:v1|alpha');
    const second = seal(value, KEY, 'gws-ea-connections:v1|alpha');
    expect(first.equals(second)).toBe(false);
    expect(first.includes(value)).toBe(false);
    expect(unseal(first, KEY, 'gws-ea-connections:v1|alpha').toString('utf8')).toBe(SECRET);
    expect(() => unseal(first, KEY, 'gws-ea-logins:v1|alpha')).toThrow();
    expect(() => unseal(first, randomBytes(32), 'gws-ea-connections:v1|alpha')).toThrow();
    expect(() => unseal(first.subarray(0, 27), KEY, 'gws-ea-connections:v1|alpha')).toThrow();
  });
});

/** An in-memory store file and a Keychain holding at most one key. */
function fixture(): {
  file: SealedFile & { secrets: boolean; check: Buffer | undefined };
  keychain: { value: string | undefined; unavailable: boolean; creates: number };
  storeSeal: (label?: string) => StoreSeal;
} {
  const keychain = { value: undefined as string | undefined, unavailable: false, creates: 0 };
  const runCommand: SanitizedCommandOutcomeRunner = async (command) => {
    if (keychain.unavailable) return { exitCode: 36, stdout: '', stderr: '' };
    if (command.args[0] === '-i') {
      keychain.creates++;
      keychain.value = command.input?.match(/-w ([a-f0-9]{64})/u)?.[1];
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    return keychain.value
      ? { exitCode: 0, stdout: keychain.value, stderr: '' }
      : { exitCode: 44, stdout: '', stderr: '' };
  };
  const file = {
    secrets: false,
    check: undefined as Buffer | undefined,
    hasSecrets: () => file.secrets,
    readCheck: () => file.check,
    writeCheck: (sealed: Buffer) => {
      file.check = sealed;
    },
  };
  const key = new KeychainKey({ service: 'gws-ea.connections', instanceId: 'alpha', runCommand });
  return {
    file,
    keychain,
    storeSeal: (label = 'gws-ea-connections:v1|alpha') =>
      new StoreSeal({ key, label, check: 'gws-ea-connections-key-check:v1' }),
  };
}

describe('StoreSeal', () => {
  it('creates a key only while its file holds no secrets, then proves later keys against the check', async () => {
    const { file, keychain, storeSeal } = fixture();
    const sealing = storeSeal();
    expect(await sealing.availability(file)).toEqual({ available: true });
    const sealed = await sealing.withKey(file, (key) => sealing.seal(Buffer.from(SECRET), key));
    file.secrets = true;
    expect(keychain.creates).toBe(1);
    expect(await sealing.withKey(file, (key) => sealing.unseal(sealed, key).toString('utf8'))).toBe(SECRET);

    keychain.value = undefined;
    expect(await sealing.availability(file)).toEqual({ available: false, reason: 'key_missing' });
    await expect(sealing.withKey(file, () => 'used')).rejects.toBeInstanceOf(SealUnavailableError);
    expect(keychain.creates).toBe(1);

    keychain.value = 'a1'.repeat(32);
    expect(await sealing.availability(file)).toEqual({ available: false, reason: 'key_mismatch' });
    await expect(sealing.withKey(file, () => 'used')).rejects.toBeInstanceOf(SealUnavailableError);

    keychain.unavailable = true;
    expect(await sealing.availability(file)).toEqual({ available: false, reason: 'keychain_unavailable' });
  });

  it('adopts a present key for an empty file and refuses a check sealed under another label', async () => {
    const { file, keychain, storeSeal } = fixture();
    keychain.value = '4c'.repeat(32);
    await storeSeal('gws-ea-other:v1|alpha').withKey(file, () => undefined);
    expect(keychain.creates).toBe(0);
    file.secrets = true;
    expect(await storeSeal().availability(file)).toEqual({ available: false, reason: 'key_mismatch' });
    expect(await storeSeal('gws-ea-other:v1|alpha').availability(file)).toEqual({ available: true });
  });
});
