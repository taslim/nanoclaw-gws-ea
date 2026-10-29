import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  MEMORY_INDEX_PATH,
  MEMORY_SECTION_BUDGET_CHARS,
  MEMORY_TRUNCATION_NOTICE,
  RELEASE_MEMORY_DEFINITION,
  renderMemorySection,
} from './context.js';

let baseDir: string;
const RELEASE_DEFINITION = fs.readFileSync(RELEASE_MEMORY_DEFINITION.file, 'utf-8').trim();

function writeIndex(index: string): void {
  fs.mkdirSync(path.join(baseDir, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(baseDir, 'memory', 'index.md'), index);
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
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-memory-context-'));
});

afterEach(() => fs.rmSync(baseDir, { recursive: true, force: true }));

describe('renderMemorySection', () => {
  it('fits the whole section, header included, in 10,000 characters, cutting an oversized index from its end', () => {
    expect(MEMORY_SECTION_BUDGET_CHARS).toBe(10_000);
    const index = indexWithMap('- 2026-10-19: Morgan keeps mornings free.', 400);
    expect(index.length).toBeGreaterThan(20_000);
    writeIndex(index);

    const section = renderMemorySection(baseDir);

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

    const section = renderMemorySection(baseDir);

    expect(section).toContain(index.trim());
    expect(section).not.toContain(MEMORY_TRUNCATION_NOTICE);
  });

  it('keeps all of a leading Core Memory when an oversized index is cut', () => {
    const core = Array.from({ length: 12 }, (_, i) => `- 2026-10-${10 + i}: correction ${i}, in Morgan's words.`).join(
      '\n',
    );
    writeIndex(indexWithMap(core, 600));

    const section = renderMemorySection(baseDir);

    expect(section).toContain(core);
    expect(section).toContain(MEMORY_TRUNCATION_NOTICE);
  });

  it('cuts at a line end, so no fact is shown half-written', () => {
    writeIndex(indexWithMap('- 2026-10-19: Morgan keeps mornings free.', 400));

    const kept = renderedIndex(renderMemorySection(baseDir)).replace(MEMORY_TRUNCATION_NOTICE, '').trimEnd();

    expect(kept).toMatch(/- a matter to recall$/u);
  });

  it('cuts an index with no line ends without splitting a surrogate pair', () => {
    // Place the emoji so the cut falls between its two halves, wherever the header leaves the index's room.
    const room = MEMORY_SECTION_BUDGET_CHARS - renderMemorySectionWithIndex('').length;
    const tail = 'y'.repeat(MEMORY_TRUNCATION_NOTICE.length + 50);
    writeIndex(`${'x'.repeat(room - MEMORY_TRUNCATION_NOTICE.length - 2)}😀${tail}`);

    const section = renderMemorySection(baseDir);

    expect(section.length).toBeLessThanOrEqual(MEMORY_SECTION_BUDGET_CHARS);
    expect(section).toContain(MEMORY_TRUNCATION_NOTICE);
    expect(section).not.toContain('\ud83d\n');
  });

  it("leaves the index at least 3,500 characters beside the release's definition", () => {
    expect(MEMORY_SECTION_BUDGET_CHARS - renderMemorySectionWithIndex('').length).toBeGreaterThanOrEqual(3_500);
  });

  it('keeps the index as a map and dedicated stores as the single home for their facts', () => {
    const definition = RELEASE_DEFINITION.replace(/\s+/gu, ' ');

    expect(definition).not.toContain('Core Memory');
    expect(definition).toContain('the Manual');
    expect(definition).toContain('scheduling preferences');
    expect(definition).toContain('memory points to it rather than copying');
    expect(definition).toContain('the smallest useful file');
  });

  it('remembers the principal and the people served for them, within the portable file contract', () => {
    const definition = RELEASE_DEFINITION.replace(/\s+/gu, ' ');

    expect(definition).toContain('the principal and the people you work with for them');
    expect(definition).not.toMatch(/\buser(?:'s)?\b/iu);
    expect(definition).toContain('Open Knowledge Format (OKF)');
    expect(definition).toContain('One Markdown concept per file');
    expect(definition).toContain('`type`');
    expect(definition).toContain('`index.md` and `log.md`');
    expect(definition).toContain('`okf_version: "0.1"`');
    expect(definition).toContain('never drop frontmatter fields you do not recognize');
    expect(definition).toContain('Missing or malformed frontmatter never makes a memory unusable.');
  });

  it('seeds new indexes in terms of the principal', () => {
    const template = fs.readFileSync(path.join(import.meta.dir, 'templates', 'index.md'), 'utf-8');

    expect(template).toMatch(/the principal/iu);
    expect(template).toContain('## Map');
    expect(template).not.toContain('Core Memory');
    expect(template).not.toContain('who the user is');
  });

  it("reads the definition from the release, never from a copy in the agent's tree", () => {
    writeIndex('# Memory Index\n');
    fs.mkdirSync(path.join(baseDir, 'memory', 'system'), { recursive: true });
    fs.writeFileSync(path.join(baseDir, 'memory', 'system', 'definition.md'), 'agent-edited doctrine\n');

    const section = renderMemorySection(baseDir);

    expect(section).toContain(RELEASE_DEFINITION);
    expect(section).not.toContain('agent-edited doctrine');
  });

  it('says the release definition is in force and read-only, that copies are not read, and that it replaces earlier sections', () => {
    writeIndex('# Memory Index\n');

    const section = renderMemorySection(baseDir);
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

    const section = renderMemorySection(baseDir);

    expect(section).toContain('## Memory');
    expect(section).toContain('files on disk are authoritative');
    expect(section).toContain('Open Knowledge Format (OKF)');
    expect(section).toContain('- [Casa](projects/casa.md)');
  });

  it('degrades without throwing when the index is missing', () => {
    expect(renderMemorySection(baseDir)).toContain('unavailable during this hook invocation');
  });
});

function renderMemorySectionWithIndex(index: string): string {
  writeIndex(index);
  return renderMemorySection(baseDir);
}
