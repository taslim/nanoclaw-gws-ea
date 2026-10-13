import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runVoiceProcess } from './process.js';

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-child-test-'));
});
afterEach(async () => {
  await fs.rm(root, { force: true, recursive: true });
});

describe('bounded local recognition children', () => {
  it('returns complete output without interpreting shell arguments', async () => {
    const output = await runVoiceProcess(
      process.execPath,
      ['-e', 'process.stdout.write(process.argv[1])', '$(never); data'],
      { cwd: root, timeoutMs: 2000, maxOutputBytes: 1024 },
    );
    expect(output.toString()).toBe('$(never); data');
  });
  it('rejects nonzero exits and output overflow instead of returning a prefix', async () => {
    await expect(
      runVoiceProcess(process.execPath, ['-e', 'process.stdout.write("partial"); process.exit(2)'], {
        cwd: root,
        timeoutMs: 2000,
        maxOutputBytes: 1024,
      }),
    ).rejects.toThrow();
    await expect(
      runVoiceProcess(process.execPath, ['-e', 'process.stdout.write("a".repeat(4096))'], {
        cwd: root,
        timeoutMs: 2000,
        maxOutputBytes: 100,
      }),
    ).rejects.toThrow();
  });
  it('terminates timeout and shutdown children before settling', async () => {
    await expect(
      runVoiceProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
        cwd: root,
        timeoutMs: 50,
        maxOutputBytes: 1024,
      }),
    ).rejects.toThrow();
    const stop = new AbortController();
    const operation = runVoiceProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      cwd: root,
      timeoutMs: 2000,
      maxOutputBytes: 1024,
      signal: stop.signal,
    });
    stop.abort();
    await expect(operation).rejects.toThrow();
  });
  it("kills descendants that would otherwise keep the exited parent's pipes open", async () => {
    const output = await runVoiceProcess(
      process.execPath,
      [
        '-e',
        `require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});process.stdout.write('complete');process.exit(0);`,
      ],
      { cwd: root, timeoutMs: 150, maxOutputBytes: 1024 },
    );
    expect(output.toString()).toBe('complete');
  });
});
