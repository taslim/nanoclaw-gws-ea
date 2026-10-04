import { describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { prepareSessionMemory, sessionsSealed } from './sealed.js';
import { MEMORY_SESSION_HOOK, SEALED_MEMORY_SESSION_HOOK } from './session-hook.js';

function tempBase(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-sealed-'));
}

describe('sealed sessions', () => {
  it('are those of a group without conversation-context, including one with no list at all', () => {
    expect(sessionsSealed(new Set(['reply', 'gws-ea-meetings-external']))).toBe(true);
    expect(sessionsSealed(new Set())).toBe(true);
    expect(sessionsSealed(new Set(['reply', 'conversation-context']))).toBe(false);
  });

  it('keep no group memory: no scaffold, and the sealed hook registration', () => {
    const base = tempBase();
    try {
      const hook = prepareSessionMemory(true, base);

      expect(hook).toBe(SEALED_MEMORY_SESSION_HOOK);
      expect(fs.existsSync(path.join(base, 'memory'))).toBe(false);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('leave an unsealed session its shared memory tree and hook, as before', () => {
    const base = tempBase();
    try {
      expect(prepareSessionMemory(false, base)).toBe(MEMORY_SESSION_HOOK);
      expect(fs.existsSync(path.join(base, 'memory', 'index.md'))).toBe(true);
      expect(fs.existsSync(path.join(base, 'memory', 'system', 'definition.md'))).toBe(true);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
