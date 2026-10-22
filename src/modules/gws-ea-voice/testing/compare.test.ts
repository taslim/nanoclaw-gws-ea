import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VOICE_RECIPE_ID, type VerifiedVoiceInstallation, type VoiceModelId } from '../../../gws-ea/voice-assets.js';
import { VoiceRecognitionError } from '../transcribe.js';
import { compareVoiceNotes, parseComparisonManifest, runComparisonCli } from './compare.js';

const seams = vi.hoisted(() => ({ verify: vi.fn(), transcribe: vi.fn() }));
vi.mock('../../../gws-ea/voice-assets.js', async (load) => ({
  ...(await load<typeof import('../../../gws-ea/voice-assets.js')>()),
  verifyVoiceInstallation: seams.verify,
}));
vi.mock('../transcribe.js', async (load) => ({
  ...(await load<typeof import('../transcribe.js')>()),
  transcribeAudio: seams.transcribe,
}));

let root: string;
const models: VoiceModelId[] = ['base', 'small', 'large-v3-turbo-q5_0'];

function manifest() {
  return {
    schemaVersion: 1,
    repetitions: 2,
    installations: Object.fromEntries(models.map((model) => [model, path.join(root, model)])),
    notes: [
      { id: 'correction', audioFile: path.join(root, 'human.m4a'), expectedIntent: 'Friday, after Remy confirms.' },
    ],
  };
}

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'voice-compare-test-')));
  for (const model of models) await fs.mkdir(path.join(root, model), { mode: 0o700 });
  await fs.writeFile(path.join(root, 'human.m4a'), Buffer.from('same original bytes'), { mode: 0o600 });
  seams.verify.mockReset();
  seams.transcribe.mockReset();
  seams.verify.mockImplementation(async (directory: string): Promise<VerifiedVoiceInstallation> => {
    const model = models.find((candidate) => path.basename(directory) === candidate);
    if (!model) throw new Error('Unknown fixture installation');
    return {
      installationDir: directory,
      ffmpeg: '/fixture/ffmpeg',
      whisperCli: '/fixture/whisper-cli',
      model: '/fixture/model',
      vad: '/fixture/vad',
      receipt: {
        schemaVersion: 1,
        recipe: VOICE_RECIPE_ID,
        model,
        platform: 'darwin',
        architecture: 'arm64',
        builtAt: '2026-10-12T00:00:00.000Z',
        artifacts: Object.fromEntries(
          ['ffmpeg', 'whisperCli', 'model', 'vad'].map((key) => [key, { file: key, size: 1, sha256: '0'.repeat(64) }]),
        ) as VerifiedVoiceInstallation['receipt']['artifacts'],
      },
    };
  });
  seams.transcribe.mockResolvedValue({ status: 'recognized', text: 'fixture result', language: 'en' });
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('private comparison evidence, never model qualification', () => {
  it('requires all three explicit candidates, real paths, unique notes, and human expected intent', () => {
    expect(parseComparisonManifest(manifest())).toMatchObject({ repetitions: 2 });
    for (const value of [
      { ...manifest(), schemaVersion: 2 },
      { ...manifest(), repetitions: 0 },
      { ...manifest(), installations: { base: '/base' } },
      { ...manifest(), notes: [] },
      { ...manifest(), notes: [manifest().notes[0], manifest().notes[0]] },
      { ...manifest(), notes: [{ ...manifest().notes[0], audioFile: 'relative.m4a' }] },
      { ...manifest(), notes: [{ ...manifest().notes[0], expectedIntent: '' }] },
    ])
      expect(() => parseComparisonManifest(value)).toThrow();
  });

  it('compares the same bytes through the production seam and retains faithful results and explicit pending gates', async () => {
    const output = path.join(root, 'results');
    const report = await compareVoiceNotes(parseComparisonManifest(manifest()), output, new AbortController().signal);
    expect(seams.verify).toHaveBeenCalledTimes(3);
    expect(seams.transcribe).toHaveBeenCalledTimes(6);
    for (const call of seams.transcribe.mock.calls) {
      expect(call[0]).toEqual(Buffer.from('same original bytes'));
      expect(call[2]).toBe(path.join(output, 'temporary'));
    }
    expect(report.qualification).toBe('pending');
    expect(report.measurement).toBe('decode-and-recognition-wall-time');
    expect(report.notes[0]).toMatchObject({
      expectedIntent: 'Friday, after Remy confirms.',
      sha256: createHash('sha256').update('same original bytes').digest('hex'),
      runs: expect.arrayContaining([
        expect.objectContaining({
          result: { status: 'recognized', text: 'fixture result', language: 'en' },
          wallMs: expect.any(Number),
        }),
      ]),
    });
    const saved = JSON.parse(await fs.readFile(path.join(output, 'comparison.json'), 'utf8')) as unknown;
    expect(saved).toEqual(report);
    expect((await fs.stat(output)).mode & 0o077).toBe(0);
    expect((await fs.stat(path.join(output, 'comparison.json'))).mode & 0o077).toBe(0);
    expect(await fs.readdir(output)).toEqual(['comparison.json']);
  });

  it('records a complete-note failure without claiming a successful prefix and continues the remaining candidates', async () => {
    seams.transcribe.mockRejectedValueOnce(new VoiceRecognitionError('duration-limit'));
    const report = await compareVoiceNotes(
      parseComparisonManifest(manifest()),
      path.join(root, 'results'),
      new AbortController().signal,
    );
    expect(report.notes[0].runs[0].result).toEqual({ status: 'failed', reason: 'duration-limit' });
    expect(report.notes[0].runs).toHaveLength(6);
    expect(report.qualification).toBe('pending');
  });

  it('refuses to overwrite evidence or put private audio/output inside a shared installation', async () => {
    const output = path.join(root, 'results');
    await fs.mkdir(output, { mode: 0o700 });
    await expect(
      compareVoiceNotes(parseComparisonManifest(manifest()), output, new AbortController().signal),
    ).rejects.toThrow();
    await expect(
      compareVoiceNotes(
        parseComparisonManifest(manifest()),
        path.join(root, 'base', 'results'),
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    const supplied = manifest();
    supplied.notes[0].audioFile = path.join(root, 'base', 'private.m4a');
    await expect(
      compareVoiceNotes(
        parseComparisonManifest(supplied),
        path.join(root, 'fresh-results'),
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(seams.transcribe).not.toHaveBeenCalled();
  });

  it('checks installation labels before recognition and rejects linked originals', async () => {
    const linked = path.join(root, 'linked.m4a');
    await fs.symlink(path.join(root, 'human.m4a'), linked);
    const supplied = manifest();
    supplied.notes[0].audioFile = linked;
    await expect(
      compareVoiceNotes(parseComparisonManifest(supplied), path.join(root, 'results'), new AbortController().signal),
    ).rejects.toThrow();
    expect(seams.transcribe).not.toHaveBeenCalled();
    seams.verify.mockImplementationOnce(async () => ({
      ...((await seams.verify(root + '/small')) as VerifiedVoiceInstallation),
    }));
    await expect(
      compareVoiceNotes(parseComparisonManifest(manifest()), path.join(root, 'results'), new AbortController().signal),
    ).rejects.toThrow(/model/i);
  });

  it('runs only with explicit private manifest/output arguments and prints no transcript', async () => {
    const file = path.join(root, 'notes.json');
    await fs.writeFile(file, JSON.stringify(manifest()), { mode: 0o600 });
    const write = vi.fn();
    expect(await runComparisonCli(['--manifest', file, '--output', path.join(root, 'results')], write)).toBe(0);
    expect(write).toHaveBeenCalledOnce();
    expect(write.mock.calls[0][0]).not.toContain('fixture result');
    await expect(runComparisonCli(['--manifest', file], write)).rejects.toThrow(/usage/i);
  });
});
