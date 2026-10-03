import { describe, expect, it } from 'bun:test';
import fs from 'fs';
import path from 'path';

// The unit tests drive prepareSessionMemory directly and stay green if the
// boot call is deleted. main() can't be driven in-process (it reads
// /workspace/agent/container.json and enters the poll loop), so the guard is
// structural: the call and its import must both be present in the real entry
// point, decided by the group's capabilities.
describe('memory scaffold boot wiring', () => {
  const indexSrc = fs.readFileSync(path.join(import.meta.dir, '..', 'index.ts'), 'utf-8');

  it('scaffolds memory in main() for every session that is not sealed', () => {
    expect(indexSrc).toContain('const sealed = sessionsSealed(config.capabilities);');
    expect(indexSrc).toContain('const memoryHook = prepareSessionMemory(sealed);');
    expect(indexSrc).not.toContain('ensureMemoryScaffold');
    expect(indexSrc).not.toContain('usesMemoryScaffold');
  });

  it('imports the sealed-session rule from the memory module', () => {
    expect(indexSrc).toContain("import { prepareSessionMemory, sessionsSealed } from './memory/sealed.js'");
  });
});
