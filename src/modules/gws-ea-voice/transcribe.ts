import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SpeechResult } from '../../channels/inbound-content.js';
import type { VerifiedVoiceInstallation } from '../../gws-ea/voice-assets.js';
import { runVoiceProcess } from './process.js';
import { withVoiceTemp } from './staging.js';

export const MAX_VOICE_DURATION_SECONDS = 30 * 60;
export const MAX_TRANSCRIPT_JSON_BYTES = 4 * 1024 * 1024;
const SAMPLE_RATE = 16000;
const SAMPLE_BYTES = 2;

export class VoiceRecognitionError extends Error {
  constructor(
    readonly code: 'invalid-output' | 'duration-limit' | 'empty-decoding',
    cause?: unknown,
  ) {
    super(`Local voice recognition ${code}`, cause === undefined ? undefined : { cause });
    this.name = 'VoiceRecognitionError';
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new VoiceRecognitionError('invalid-output');
  return value as Record<string, unknown>;
}

/** Validate whisper.cpp's complete JSON, including its actual language/mode. */
export function parseWhisperOutput(value: unknown, modelPath: string, durationMs: number): SpeechResult {
  const output = record(value);
  const params = record(output.params);
  const result = record(output.result);
  if (
    params.language !== 'auto' ||
    params.translate !== false ||
    params.model !== modelPath ||
    typeof result.language !== 'string' ||
    !/^[a-z]{2,3}$/.test(result.language) ||
    result.language === 'auto' ||
    !Array.isArray(output.transcription)
  )
    throw new VoiceRecognitionError('invalid-output');
  const segments: string[] = [];
  let previousStart = -1;
  let textBytes = 0;
  for (const raw of output.transcription) {
    const segment = record(raw);
    const offsets = record(segment.offsets);
    if (
      typeof segment.text !== 'string' ||
      typeof offsets.from !== 'number' ||
      typeof offsets.to !== 'number' ||
      !Number.isFinite(offsets.from) ||
      !Number.isFinite(offsets.to) ||
      offsets.from < 0 ||
      offsets.from < previousStart ||
      offsets.to < offsets.from ||
      offsets.to > durationMs + 1000
    )
      throw new VoiceRecognitionError('invalid-output');
    previousStart = offsets.from;
    textBytes += Buffer.byteLength(segment.text, 'utf8');
    if (textBytes > 512 * 1024) throw new VoiceRecognitionError('invalid-output');
    segments.push(segment.text);
  }
  const text = segments.join('').trim();
  return text ? { status: 'recognized', text, language: result.language } : { status: 'no-speech' };
}

function pcmWav(pcm: Buffer): Buffer {
  if (!pcm.length || pcm.length % SAMPLE_BYTES !== 0) throw new VoiceRecognitionError('empty-decoding');
  if (pcm.length > MAX_VOICE_DURATION_SECONDS * SAMPLE_RATE * SAMPLE_BYTES)
    throw new VoiceRecognitionError('duration-limit');
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(pcm.length + 36, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * SAMPLE_BYTES, 28);
  header.writeUInt16LE(SAMPLE_BYTES, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function decodedPcm(wav: Buffer): Buffer {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new VoiceRecognitionError('empty-decoding');
  }
  const declared = wav.readUInt32LE(4);
  if (declared + 8 !== wav.length) throw new VoiceRecognitionError('invalid-output');
  let format = false;
  let pcm: Buffer | undefined;
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const kind = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    offset += 8;
    if (offset + size > wav.length) throw new VoiceRecognitionError('invalid-output');
    if (kind === 'fmt ') {
      if (
        format ||
        size < 16 ||
        wav.readUInt16LE(offset) !== 1 ||
        wav.readUInt16LE(offset + 2) !== 1 ||
        wav.readUInt32LE(offset + 4) !== SAMPLE_RATE ||
        wav.readUInt32LE(offset + 8) !== SAMPLE_RATE * SAMPLE_BYTES ||
        wav.readUInt16LE(offset + 12) !== SAMPLE_BYTES ||
        wav.readUInt16LE(offset + 14) !== 16
      ) {
        throw new VoiceRecognitionError('invalid-output');
      }
      format = true;
    } else if (kind === 'data') {
      if (pcm !== undefined || !format) throw new VoiceRecognitionError('invalid-output');
      pcm = wav.subarray(offset, offset + size);
    }
    offset += size + (size % 2);
  }
  if (offset !== wav.length || !format || pcm === undefined) throw new VoiceRecognitionError('invalid-output');
  return pcm;
}

export async function transcribeAudio(
  original: Buffer,
  installation: VerifiedVoiceInstallation,
  tempRoot: string,
  signal: AbortSignal,
): Promise<SpeechResult> {
  return withVoiceTemp(tempRoot, async (directory) => {
    const input = path.join(directory, 'original');
    const wav = path.join(directory, 'normalized.wav');
    const output = path.join(directory, 'recognized');
    await writeFile(input, original, { flag: 'wx', mode: 0o600 });
    // Only self-contained audio/video containers: playlists cannot make a
    // local recording read arbitrary referenced files or network resources.
    const maxWavBytes = MAX_VOICE_DURATION_SECONDS * SAMPLE_RATE * SAMPLE_BYTES + 65536;
    await runVoiceProcess(
      installation.ffmpeg,
      [
        '-nostdin',
        '-v',
        'error',
        '-max_alloc',
        '67108864',
        '-threads',
        '1',
        '-protocol_whitelist',
        'file',
        '-format_whitelist',
        'ogg,wav,mp3,aac,mov,matroska,webm,flac,amr',
        '-i',
        input,
        '-map',
        '0:a:0',
        '-vn',
        '-sn',
        '-dn',
        '-ac',
        '1',
        '-ar',
        String(SAMPLE_RATE),
        '-c:a',
        'pcm_s16le',
        '-f',
        'wav',
        '-fs',
        String(maxWavBytes),
        wav,
      ],
      {
        cwd: directory,
        signal,
        timeoutMs: 120000,
        maxOutputBytes: 65536,
        watchedFile: { path: wav, maxBytes: maxWavBytes },
      },
    );
    const decoded = await stat(wav);
    // -fs bounds hostile expansion; any output reaching it is discarded,
    // never handed to recognition as if it were the complete source note.
    if (!decoded.isFile() || decoded.size >= maxWavBytes) throw new VoiceRecognitionError('duration-limit');
    const normalized = await readFile(wav);
    const pcm = decodedPcm(normalized);
    await writeFile(wav, pcmWav(pcm), { mode: 0o600 });
    await runVoiceProcess(
      installation.whisperCli,
      [
        '-l',
        'auto',
        '-oj',
        '-of',
        output,
        '--vad',
        '--vad-model',
        installation.vad,
        '-t',
        '4',
        '-m',
        installation.model,
        '-f',
        wav,
      ],
      {
        cwd: directory,
        signal,
        timeoutMs: 10 * 60 * 1000,
        maxOutputBytes: MAX_TRANSCRIPT_JSON_BYTES,
        watchedFile: { path: `${output}.json`, maxBytes: MAX_TRANSCRIPT_JSON_BYTES },
      },
    );
    const info = await stat(`${output}.json`);
    if (!info.isFile() || info.size === 0 || info.size > MAX_TRANSCRIPT_JSON_BYTES)
      throw new VoiceRecognitionError('invalid-output');
    const speech = parseWhisperOutput(
      JSON.parse(await readFile(`${output}.json`, 'utf8')) as unknown,
      installation.model,
      (pcm.length * 1000) / (SAMPLE_RATE * SAMPLE_BYTES),
    );
    return { ...speech, engine: 'whisper.cpp-1.9.5', model: installation.receipt.model };
  });
}
