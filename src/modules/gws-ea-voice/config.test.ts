import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readVoiceReadiness } from './config.js';

let root: string;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'voice-readiness-test-')));
  vi.stubEnv('GWS_EA_VOICE_POLICY_FILE', path.join(root, 'voice.json'));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { force: true, recursive: true });
});

describe('optional readiness cannot reject normal routing', () => {
  it('bounds absent policy and absent selected artifacts as operator setup requirements', async () => {
    expect(await readVoiceReadiness()).toMatchObject({ status: 'unavailable', reason: 'operator-setup-required' });
    await fs.writeFile(
      path.join(root, 'voice.json'),
      JSON.stringify({ schemaVersion: 1, enabled: true, installationDir: path.join(root, 'unprovisioned') }),
    );
    expect(await readVoiceReadiness()).toEqual({
      status: 'unavailable',
      enabled: true,
      reason: 'operator-setup-required',
    });
    expect(await fs.readdir(root)).toEqual(['voice.json']);
  });
  it('bounds corrupt state and incompatible policy as explicit limitations', async () => {
    await fs.writeFile(path.join(root, 'voice.json'), '{invalid');
    expect(await readVoiceReadiness()).toMatchObject({ status: 'unavailable', reason: 'voice-installation-unhealthy' });
    await fs.writeFile(
      path.join(root, 'voice.json'),
      JSON.stringify({ schemaVersion: 2, enabled: true, installationDir: root }),
    );
    expect(await readVoiceReadiness()).toMatchObject({ status: 'unavailable', reason: 'operator-update-required' });
  });
});
