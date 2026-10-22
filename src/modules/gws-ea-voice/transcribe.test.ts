import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseWhisperOutput, transcribeAudio } from './transcribe.js';
import { VOICE_RECIPE_ID, type VerifiedVoiceInstallation } from '../../gws-ea/voice-assets.js';

let root: string;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'voice-transcribe-test-')));
});
afterEach(async () => {
  await fs.rm(root, { force: true, recursive: true });
});

function transcript(texts = [' Schedule Friday', ' if Remy confirms.']): unknown {
  return {
    params: { language: 'auto', translate: false, model: '/model' },
    result: { language: 'es' },
    transcription: texts.map((text, i) => ({ offsets: { from: i * 250, to: (i + 1) * 250 }, text })),
  };
}

describe('validated complete structured recognition', () => {
  it('preserves source wording, all segments, and detected language without translation', () => {
    expect(parseWhisperOutput(transcript(), '/model', 1000)).toEqual({
      status: 'recognized',
      text: 'Schedule Friday if Remy confirms.',
      language: 'es',
    });
    expect(parseWhisperOutput(transcript([]), '/model', 1000)).toEqual({ status: 'no-speech' });
  });
  it('rejects false-success, translated, wrong-input, malformed, and over-duration output', () => {
    for (const output of [
      {},
      { ...(transcript() as object), transcription: [{ text: 'prefix' }] },
      { ...(transcript() as object), params: { language: 'en', translate: true, model: '/model' } },
      { ...(transcript() as object), transcription: [{ offsets: { from: 0, to: 5000 }, text: 'prefix' }] },
    ]) {
      expect(() => parseWhisperOutput(output, '/model', 1000)).toThrow();
    }
    expect(() => parseWhisperOutput(transcript(), '/another-model', 1000)).toThrow();
  });
  it('runs complete decode and recognition children with private files, cleaning success and invalid JSON', async () => {
    const decoder = path.join(root, 'decoder');
    const recognizer = path.join(root, 'recognizer');
    const decodedWav = (channels: number) =>
      `#!${process.execPath}\nconst b=Buffer.alloc(32044);b.write('RIFF');b.writeUInt32LE(32036,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(${channels},22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(32000,40);require('node:fs').writeFileSync(process.argv.at(-1),b);`;
    await fs.writeFile(decoder, decodedWav(1), { mode: 0o700 });
    await fs.writeFile(
      recognizer,
      `#!${process.execPath}\nconst fs=require('node:fs');const a=process.argv;fs.writeFileSync(a[a.indexOf('-of')+1]+'.json',JSON.stringify({params:{language:'auto',translate:false,model:a[a.indexOf('-m')+1]},result:{language:'fr'},transcription:[{offsets:{from:0,to:1000},text:' ne réserve pas vendredi'}]}));`,
      { mode: 0o700 },
    );
    const installation: VerifiedVoiceInstallation = {
      installationDir: root,
      ffmpeg: decoder,
      whisperCli: recognizer,
      model: '/model',
      vad: '/vad',
      receipt: {
        schemaVersion: 1,
        recipe: VOICE_RECIPE_ID,
        platform: 'darwin',
        architecture: 'arm64',
        model: 'base',
        builtAt: new Date().toISOString(),
        artifacts: {
          ffmpeg: { file: 'bin/ffmpeg', size: 1, sha256: '0'.repeat(64) },
          whisperCli: { file: 'bin/whisper-cli', size: 1, sha256: '0'.repeat(64) },
          model: { file: 'models/ggml-base.bin', size: 1, sha256: '0'.repeat(64) },
          vad: { file: 'models/ggml-silero-v6.2.0.bin', size: 1, sha256: '0'.repeat(64) },
        },
      },
    };
    const temp = path.join(root, 'private');
    expect(
      await transcribeAudio(Buffer.from('source'), installation, temp, new AbortController().signal),
    ).toMatchObject({ status: 'recognized', text: 'ne réserve pas vendredi', language: 'fr' });
    expect(await fs.readdir(temp)).toEqual([]);
    await fs.writeFile(decoder, decodedWav(2), { mode: 0o700 });
    await expect(
      transcribeAudio(Buffer.from('source'), installation, temp, new AbortController().signal),
    ).rejects.toThrow();
    expect(await fs.readdir(temp)).toEqual([]);
    await fs.writeFile(decoder, decodedWav(1), { mode: 0o700 });
    await fs.writeFile(
      recognizer,
      `#!${process.execPath}\nconst fs=require('node:fs');const a=process.argv;fs.writeFileSync(a[a.indexOf('-of')+1]+'.json','{}');`,
      { mode: 0o700 },
    );
    await expect(
      transcribeAudio(Buffer.from('source'), installation, temp, new AbortController().signal),
    ).rejects.toThrow();
    expect(await fs.readdir(temp)).toEqual([]);
  });
});
