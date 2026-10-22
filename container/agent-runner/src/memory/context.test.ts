import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import path from 'path';

import {
  MEMORY_INDEX_PATH,
  MEMORY_SECTION_BUDGET_CHARS,
  MEMORY_TRUNCATION_NOTICE,
  RELEASE_MEMORY_DEFINITION,
  renderMemorySection,
} from './context.js';

const BASE = '/tmp/nanoclaw-memory-context-test';
const RELEASE_DEFINITION = fs.readFileSync(RELEASE_MEMORY_DEFINITION.file, 'utf-8').trim();

function writeIndex(index: string): void {
  fs.mkdirSync(path.join(BASE, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(BASE, 'memory', 'index.md'), index);
}

/** An index whose Core Memory leads it, then a Map of `entries` linked files. */
function indexWithMap(core: string, entries: number): string {
  const map = Array.from({ length: entries }, (_, i) => `- [Matter ${i}](matters/matter-${i}.md) - a matter to recall`);
  return ['# Memory Index', '', '## Core Memory', '', core, '', '## Map', '', ...map, ''].join('\n');
}

/** The index as the section renders it: between its heading and the definition's. */
function renderedIndex(section: string): string {
  return section.slice(section.indexOf('### memory/index.md'), section.indexOf('### Memory definition'));
}

beforeEach(() => {
  fs.rmSync(BASE, { recursive: true, force: true });
  fs.mkdirSync(BASE, { recursive: true });
});

afterEach(() => fs.rmSync(BASE, { recursive: true, force: true }));

describe('renderMemorySection', () => {
  it('fits the whole section, header included, in 10,000 characters, cutting an oversized index from its end', () => {
    expect(MEMORY_SECTION_BUDGET_CHARS).toBe(10_000);
    const index = indexWithMap('- 2026-10-19: Morgan keeps mornings free.', 400);
    expect(index.length).toBeGreaterThan(20_000);
    writeIndex(index);

    const section = renderMemorySection(BASE);

    expect(section.length).toBeLessThanOrEqual(MEMORY_SECTION_BUDGET_CHARS);
    expect(renderedIndex(section).trimEnd().endsWith(MEMORY_TRUNCATION_NOTICE)).toBe(true);
    expect(section).toContain(RELEASE_DEFINITION);
  });

  it('gives the cut index its path on disk and asks for detail to move into linked files, never for facts to go', () => {
    expect(MEMORY_TRUNCATION_NOTICE).toContain(MEMORY_INDEX_PATH);
    expect(MEMORY_TRUNCATION_NOTICE).toContain('linked memory files');
    expect(MEMORY_TRUNCATION_NOTICE).not.toMatch(/\b(?:delete|remove|prune|slim)\b/iu);
  });

  it('renders a small index whole, with no cut notice', () => {
    const index = indexWithMap('- 2026-10-19: Morgan keeps mornings free.', 3);
    writeIndex(index);

    const section = renderMemorySection(BASE);

    expect(section).toContain(index.trim());
    expect(section).not.toContain(MEMORY_TRUNCATION_NOTICE);
  });

  it('keeps all of a leading Core Memory when an oversized index is cut', () => {
    const core = Array.from({ length: 12 }, (_, i) => `- 2026-10-${10 + i}: correction ${i}, in Morgan's words.`).join(
      '\n',
    );
    writeIndex(indexWithMap(core, 600));

    const section = renderMemorySection(BASE);

    expect(section).toContain(core);
    expect(section).toContain(MEMORY_TRUNCATION_NOTICE);
  });

  it('cuts at a line end, so no fact is shown half-written', () => {
    writeIndex(indexWithMap('- 2026-10-19: Morgan keeps mornings free.', 400));

    const kept = renderedIndex(renderMemorySection(BASE)).replace(MEMORY_TRUNCATION_NOTICE, '').trimEnd();

    expect(kept).toMatch(/- a matter to recall$/u);
  });

  it('cuts an index with no line ends without splitting a surrogate pair', () => {
    // Place the emoji so the cut falls between its two halves, wherever the header leaves the index's room.
    const room = MEMORY_SECTION_BUDGET_CHARS - renderMemorySectionWithIndex('').length;
    const tail = 'y'.repeat(MEMORY_TRUNCATION_NOTICE.length + 50);
    writeIndex(`${'x'.repeat(room - MEMORY_TRUNCATION_NOTICE.length - 2)}😀${tail}`);

    const section = renderMemorySection(BASE);

    expect(section.length).toBeLessThanOrEqual(MEMORY_SECTION_BUDGET_CHARS);
    expect(section).toContain(MEMORY_TRUNCATION_NOTICE);
    expect(section).not.toContain('\ud83d\n');
  });

  it("leaves the index at least 3,500 characters beside the release's definition", () => {
    expect(MEMORY_SECTION_BUDGET_CHARS - renderMemorySectionWithIndex('').length).toBeGreaterThanOrEqual(3_500);
  });

  it('gives a correction that governs every conversation its own Core Memory line, even when a file also keeps it', () => {
    // An existing preferences file is the faithful reading of "update that entity's existing file"; only
    // Core Memory is in front of the agent every time, so the rule itself must live there too (R15).
    const definition = RELEASE_DEFINITION.replace(/\s+/gu, ' ');

    expect(definition).toContain(
      'A correction that governs every conversation gets its own short dated line in Core Memory, even when a file for preferences or corrections also keeps it:',
    );
    expect(definition).toContain('a linked file is read only when you think to open it.');
    expect(definition).toContain('Beyond Core Memory, write to the smallest useful file');
  });

  it("reads the definition from the release, never from a copy in the agent's tree", () => {
    writeIndex('# Memory Index\n');
    fs.mkdirSync(path.join(BASE, 'memory', 'system'), { recursive: true });
    fs.writeFileSync(path.join(BASE, 'memory', 'system', 'definition.md'), 'agent-edited doctrine\n');

    const section = renderMemorySection(BASE);

    expect(section).toContain(RELEASE_DEFINITION);
    expect(section).not.toContain('agent-edited doctrine');
  });

  it('says the release definition is in force and read-only, that copies are not read, and that it replaces earlier sections', () => {
    writeIndex('# Memory Index\n');

    const section = renderMemorySection(BASE);
    const header = section.slice(0, section.indexOf('### memory/index.md')).replace(/\s+/gu, ' ');

    expect(header).toContain(`\`${RELEASE_MEMORY_DEFINITION.path}\``);
    expect(header).toContain('read-only');
    expect(header).toContain('copies under `memory/system/` are not read');
    expect(header).toContain('replaces any earlier memory section in this conversation');
  });

  it('names a release path that exists in the shipped runner tree', () => {
    const shipped = path.join(import.meta.dir, '..', path.relative('/app/src', RELEASE_MEMORY_DEFINITION.path));

    expect(fs.realpathSync(shipped)).toBe(fs.realpathSync(RELEASE_MEMORY_DEFINITION.file));
  });

  it('inlines existing untyped memory without blocking it', () => {
    writeIndex('# Memory Index\n- [Casa](projects/casa.md)\n');

    const section = renderMemorySection(BASE);

    expect(section).toContain('## Memory');
    expect(section).toContain('files on disk are authoritative');
    expect(section).toContain('Open Knowledge Format (OKF)');
    expect(section).toContain('- [Casa](projects/casa.md)');
  });

  it('degrades without throwing when the index is missing', () => {
    expect(renderMemorySection(BASE)).toContain('unavailable during this hook invocation');
  });
});

function renderMemorySectionWithIndex(index: string): string {
  writeIndex(index);
  return renderMemorySection(BASE);
}
