import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import { WHISPER_BIN, WHISPER_MODEL } from './config.js';
import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

/**
 * Transcribe an audio file using local whisper.cpp.
 * Converts to 16kHz mono WAV via ffmpeg, then runs whisper-cli.
 * Returns the transcript text, or null on failure.
 */
export async function transcribe(audioPath: string): Promise<string | null> {
  const wavPath = path.join(
    os.tmpdir(),
    `nanoclaw-${process.pid}-${Date.now()}.wav`,
  );

  try {
    await execFileAsync(
      'ffmpeg',
      ['-i', audioPath, '-ar', '16000', '-ac', '1', '-f', 'wav', '-y', wavPath],
      { timeout: 30_000 },
    );

    const { stdout } = await execFileAsync(
      WHISPER_BIN,
      ['-m', WHISPER_MODEL, '-f', wavPath, '--no-timestamps', '-nt'],
      { timeout: 60_000 },
    );

    const text = stdout.trim();
    if (!text) return null;

    logger.info({ chars: text.length }, 'Transcribed audio message');
    return text;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      { audioPath, error: message },
      'whisper.cpp transcription failed',
    );
    return null;
  } finally {
    try {
      fs.unlinkSync(wavPath);
    } catch {
      /* ignore */
    }
  }
}
