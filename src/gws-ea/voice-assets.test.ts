import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  parseVoiceAssetReceipt,
  parseVoiceHostPolicy,
  readVoiceHostPolicy,
  verifyVoiceInstallation,
  VOICE_MODEL_CATALOG,
  VOICE_RECIPE_ID,
  VOICE_SOURCE_ARTIFACTS,
} from './voice-assets.js';
import { runVoiceProcess } from '../modules/gws-ea-voice/process.js';

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-assets-test-'));
});
afterEach(async () => {
  await fs.rm(root, { force: true, recursive: true });
});

describe('host voice policy and immutable assets', () => {
  it('reads one disabled policy without requiring an installation', async () => {
    const file = path.join(root, 'voice.json');
    await fs.writeFile(file, JSON.stringify({ schemaVersion: 1, enabled: false, installationDir: null }), {
      mode: 0o600,
    });
    expect(await readVoiceHostPolicy(file)).toEqual({ schemaVersion: 1, enabled: false, installationDir: null });
  });
  it('does not accept an enabled policy without a selected absolute installation', () => {
    expect(() => parseVoiceHostPolicy({ schemaVersion: 1, enabled: true, installationDir: null })).toThrow();
    expect(() =>
      parseVoiceHostPolicy({ schemaVersion: 1, enabled: true, installationDir: 'http://host/model' }),
    ).toThrow();
    expect(() => parseVoiceHostPolicy({ schemaVersion: 2, enabled: true, installationDir: root })).toThrow();
  });
  it('refuses a policy symlink and an unprovisioned installation without repairing either', async () => {
    const file = path.join(root, 'voice.json');
    await fs.writeFile(file, '{}');
    const link = path.join(root, 'policy-link');
    await fs.symlink(file, link);
    await expect(readVoiceHostPolicy(link)).rejects.toThrow();
    await expect(verifyVoiceInstallation(path.join(root, 'missing'))).rejects.toThrow();
    expect(await fs.readdir(root)).toEqual(['policy-link', 'voice.json']);
  });
  it('accepts only catalog-pinned model and VAD identities, never a self-asserted checksum', () => {
    const pinned = VOICE_MODEL_CATALOG.base;
    const vad = VOICE_SOURCE_ARTIFACTS.vad;
    const receipt = {
      schemaVersion: 1,
      recipe: VOICE_RECIPE_ID,
      platform: 'darwin',
      architecture: 'arm64',
      model: 'base',
      builtAt: new Date().toISOString(),
      artifacts: {
        ffmpeg: { file: 'bin/ffmpeg', size: 1, sha256: '0'.repeat(64) },
        whisperCli: { file: 'bin/whisper-cli', size: 1, sha256: '0'.repeat(64) },
        model: { file: `models/${pinned.filename}`, size: pinned.size, sha256: pinned.sha256 },
        vad: { file: `models/${vad.filename}`, size: vad.size, sha256: vad.sha256 },
      },
    };
    expect(parseVoiceAssetReceipt(receipt).model).toBe('base');
    expect(() =>
      parseVoiceAssetReceipt({
        ...receipt,
        artifacts: { ...receipt.artifacts, model: { ...receipt.artifacts.model, sha256: 'f'.repeat(64) } },
      }),
    ).toThrow();
    expect(() =>
      parseVoiceAssetReceipt({
        ...receipt,
        artifacts: { ...receipt.artifacts, vad: { ...receipt.artifacts.vad, size: 1 } },
      }),
    ).toThrow();
    expect(() =>
      parseVoiceAssetReceipt({
        ...receipt,
        artifacts: { ...receipt.artifacts, ffmpeg: { ...receipt.artifacts.ffmpeg, file: '../outside' } },
      }),
    ).toThrow();
  });
  it.skipIf(process.platform === 'win32')('rejects a policy FIFO without blocking optional readiness', async () => {
    const fifo = path.join(root, 'voice.json');
    execFileSync('mkfifo', [fifo]);
    const source = new URL('./voice-assets.ts', import.meta.url).href;
    const script = `import {readVoiceHostPolicy} from ${JSON.stringify(source)};const deadline=setTimeout(()=>{console.log('hung');process.exit(0)},200);readVoiceHostPolicy(process.argv[1]).then(()=>{clearTimeout(deadline);console.log('accepted')},error=>{clearTimeout(deadline);console.log(error.name)});`;
    const result = await runVoiceProcess(
      process.execPath,
      ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', script, fifo],
      { cwd: root, timeoutMs: 2000, maxOutputBytes: 1024 },
    );
    expect(result.toString().trim()).toBe('VoiceAssetsError');
  });
});
