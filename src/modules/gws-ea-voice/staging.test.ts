import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readOriginalAudio } from './staging.js';
import { runVoiceProcess } from './process.js';

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-media-test-'));
});
afterEach(async () => {
  await fs.rm(root, { force: true, recursive: true });
});

describe('original recording admission', () => {
  it('preserves inline bytes and contained native WhatsApp bytes', async () => {
    await fs.writeFile(path.join(root, 'note.ogg'), 'recording');
    expect(await readOriginalAudio({ data: Buffer.from('recording').toString('base64') }, root)).toEqual(
      Buffer.from('recording'),
    );
    expect(await readOriginalAudio({ path: path.join(root, 'note.ogg') }, root)).toEqual(Buffer.from('recording'));
  });
  it('rejects external paths, URLs, symlinks, and malformed or missing bytes', async () => {
    const outside = path.join(root, '..', `voice-outside-${path.basename(root)}`);
    await fs.writeFile(outside, 'private');
    try {
      await fs.symlink(outside, path.join(root, 'link.ogg'));
      for (const attachment of [
        { path: outside },
        { path: 'https://private/note' },
        { path: path.join(root, 'link.ogg') },
        { data: '**not-base64**' },
        {},
      ]) {
        await expect(readOriginalAudio(attachment, root)).rejects.toThrow();
      }
    } finally {
      await fs.rm(outside, { force: true });
    }
  });
  it.skipIf(process.platform === 'win32')(
    'refuses a native FIFO rather than waiting forever for a writer',
    async () => {
      const fifo = path.join(root, 'recording.ogg');
      execFileSync('mkfifo', [fifo]);
      const source = new URL('./staging.ts', import.meta.url).href;
      const script = `import {readOriginalAudio} from ${JSON.stringify(source)}; const deadline=setTimeout(()=>{console.log('hung');process.exit(0)},200); readOriginalAudio({path:process.argv[1]},process.argv[2]).then(()=>{clearTimeout(deadline);console.log('accepted')},error=>{clearTimeout(deadline);console.log(error.code)});`;
      const result = await runVoiceProcess(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', script, fifo, root],
        { cwd: process.cwd(), timeoutMs: 2000, maxOutputBytes: 1024 },
      );
      expect(result.toString().trim()).toBe('unsafe-audio');
    },
  );
});
