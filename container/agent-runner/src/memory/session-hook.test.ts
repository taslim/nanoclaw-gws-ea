import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { MEMORY_SESSION_HOOK, memoryContextForSessionStart, type MemorySessionStartSource } from './session-hook.js';

let base: string;
let stateDir: string;

function writeIndex(index: string): void {
  fs.writeFileSync(path.join(base, 'memory', 'index.md'), index);
}

function contextFor(source: MemorySessionStartSource, sessionId = 'session-a'): string | undefined {
  return memoryContextForSessionStart(source, base, { id: sessionId, stateDir });
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-memory-hook-contract-'));
  stateDir = path.join(base, 'session-state');
  fs.mkdirSync(path.join(base, 'memory'), { recursive: true });
  writeIndex('# Memory Index\n');
});

afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

describe('memory SessionStart contract', () => {
  it('registers for startup, resume, clear and compact', () => {
    expect(MEMORY_SESSION_HOOK).toMatchObject({
      command: 'bun /app/src/memory/hook.ts',
      legacyCommands: ['bun /app/src/memory-hook.ts'],
      sources: ['startup', 'resume', 'clear', 'compact'],
    });
  });

  it('always injects at startup, clear and compact, even when nothing changed', () => {
    for (const source of ['startup', 'clear', 'compact', 'startup'] as const) {
      expect(contextFor(source), source).toContain('## Memory');
    }
  });

  it('injects on the first resume a session has', () => {
    expect(contextFor('resume')).toContain('# Memory Index');
  });

  it('injects nothing on a second resume when the section is unchanged', () => {
    contextFor('resume');

    expect(contextFor('resume')).toBeUndefined();
  });

  it('injects the new section on a resume after the index changed', () => {
    contextFor('startup');
    writeIndex('# Memory Index\n\n## Core Memory\n\n- 2026-10-19: Morgan keeps Fridays free.\n');

    expect(contextFor('resume')).toContain('Morgan keeps Fridays free.');
  });

  it("makes compaction's section the one the next resume compares against", () => {
    contextFor('startup');
    writeIndex('# Memory Index\n\n- 2026-10-19: a correction learned before the summary\n');
    expect(contextFor('compact')).toContain('a correction learned before the summary');

    expect(contextFor('resume')).toBeUndefined();
  });

  it('keeps each session to what was delivered to it', () => {
    contextFor('startup', 'session-a');

    expect(contextFor('resume', 'session-b')).toContain('## Memory');
    expect(contextFor('resume', 'session-a')).toBeUndefined();
  });

  it('injects nothing on a resume it cannot key to a session, as before', () => {
    expect(memoryContextForSessionStart('resume', base)).toBeUndefined();
    expect(memoryContextForSessionStart('startup', base)).toContain('## Memory');
  });

  it('still delivers the section when its fingerprint cannot be kept', () => {
    fs.writeFileSync(stateDir, 'a file where the state directory belongs');

    expect(contextFor('startup')).toContain('## Memory');
    expect(contextFor('resume')).toContain('## Memory');
  });
});
