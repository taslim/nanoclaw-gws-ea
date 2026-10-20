import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import path from 'path';

import { runBun, type RunBunResult } from '../test-utils/run-bun.js';

const BASE = '/tmp/nanoclaw-memory-hook-test';
const STATE = path.join(BASE, 'session-state');

function runHook(input: string): Promise<RunBunResult> {
  return runBun([path.join(import.meta.dir, 'hook.ts'), BASE, STATE], input);
}

beforeEach(() => {
  fs.rmSync(BASE, { recursive: true, force: true });
  fs.mkdirSync(path.join(BASE, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(BASE, 'memory', 'index.md'), '# Memory Index\n');
});

afterEach(() => fs.rmSync(BASE, { recursive: true, force: true }));

describe('memory-hook script', () => {
  it('prints live memory for a new context', async () => {
    const proc = await runHook(JSON.stringify({ source: 'startup', session_id: 'session-a' }));

    expect(proc.exitCode).toBe(0);
    expect(proc.stdout).toContain('## Memory');
  });

  it("prints memory on a session's first resume, and nothing on a resume with nothing new", async () => {
    const resume = JSON.stringify({ source: 'resume', session_id: 'session-a' });

    expect((await runHook(resume)).stdout).toContain('## Memory');
    const again = await runHook(resume);
    expect(again.exitCode).toBe(0);
    expect(again.stdout).toBe('');
  });

  it('fails closed for missing or malformed source input', async () => {
    expect((await runHook('{}')).stdout).toBe('');
    expect((await runHook('{not-json')).stdout).toBe('');
    expect((await runHook(JSON.stringify({ source: 'fork', session_id: 'session-a' }))).stdout).toBe('');
  });
});
