import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import { log } from './log.js';

const execFileAsync = promisify(execFile);

const WHISPER_BIN = process.env.WHISPER_BIN || 'whisper-cli';
const WHISPER_MODEL = process.env.WHISPER_MODEL || 'data/models/ggml-base.bin';

/**
 * Transcribe audio using local whisper.cpp.
 *
 * Source is either a Buffer (base64-decoded from message JSON) or an
 * absolute path to an existing audio file on the host (already-saved by an
 * adapter). The buffer form writes a temp file; the path form skips the
 * round-trip and lets ffmpeg read the existing file directly.
 *
 * ffmpeg normalises to 16 kHz mono WAV, then whisper-cli emits the
 * transcript. Returns trimmed text, or null on any failure (missing model,
 * missing binary, timeout, empty output). Never throws.
 */
export async function transcribeAudio(source: Buffer | { path: string }, hint?: string): Promise<string | null> {
  if (!fs.existsSync(WHISPER_MODEL)) {
    log.debug('whisper model not present, skipping transcription', { model: WHISPER_MODEL, hint });
    return null;
  }

  const stem = `nanoclaw-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const wavPath = path.join(os.tmpdir(), `${stem}.wav`);
  const ownsSrc = Buffer.isBuffer(source);
  const srcPath = ownsSrc ? path.join(os.tmpdir(), `${stem}.bin`) : source.path;

  try {
    if (ownsSrc) fs.writeFileSync(srcPath, source);

    await execFileAsync('ffmpeg', ['-i', srcPath, '-ar', '16000', '-ac', '1', '-f', 'wav', '-y', wavPath], {
      timeout: 30_000,
    });

    const { stdout } = await execFileAsync(
      WHISPER_BIN,
      ['-m', WHISPER_MODEL, '-f', wavPath, '--no-timestamps', '-nt'],
      { timeout: 60_000 },
    );

    const text = stdout.trim();
    if (!text) return null;

    log.info('Transcribed audio attachment', { chars: text.length, hint });
    return text;
  } catch (err) {
    log.warn('Audio transcription failed', { hint, err });
    return null;
  } finally {
    if (ownsSrc) {
      try {
        fs.unlinkSync(srcPath);
      } catch {
        /* ignore */
      }
    }
    try {
      fs.unlinkSync(wavPath);
    } catch {
      /* ignore */
    }
  }
}
