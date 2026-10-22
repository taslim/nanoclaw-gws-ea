import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/** The whole section, header and definition included: Claude Code passes hook context under 10,000 characters inline. */
export const MEMORY_SECTION_BUDGET_CHARS = 10_000;
export const MEMORY_INDEX_PATH = '/workspace/agent/memory/index.md';
export const MEMORY_TRUNCATION_NOTICE = `[cut here to fit: the rest is in ${MEMORY_INDEX_PATH}. Move detail from the index into linked memory files, keeping every fact, so the index fits whole]`;

/** The memory definition in force: where the hook reads it, and the path the agent is shown. */
export interface MemoryDefinition {
  readonly file: string;
  readonly path: string;
}

/**
 * GWS-EA's definition ships with the release in the read-only `/app/src`
 * mount, so no copy in the agent's tree is read and none is seeded.
 */
export const RELEASE_MEMORY_DEFINITION: MemoryDefinition = {
  file: path.join(path.dirname(fileURLToPath(import.meta.url)), 'gws-ea-definition.md'),
  path: '/app/src/memory/gws-ea-definition.md',
};

/**
 * Render the always-loaded memory section inside the container: the agent's
 * index and the memory definition, within one budget. Only the index is cut.
 * Host-side composers never read agent-controlled memory.
 */
export function renderMemorySection(
  baseDir = '/workspace/agent',
  definition: MemoryDefinition = RELEASE_MEMORY_DEFINITION,
): string {
  const index = readMemoryFile(path.join(baseDir, 'memory', 'index.md'));
  const before = [
    '## Memory',
    '',
    'This section replaces any earlier memory section in this conversation. It is',
    'loaded at startup, on resume when memory has changed, after clear, and after',
    'compaction:',
    '',
    `- \`${MEMORY_INDEX_PATH}\` - your memory index, Core Memory first`,
    `- \`${definition.path}\` - how your memory works; it comes with this release and is read-only`,
    '',
    'That definition is the one in force: copies under `memory/system/` are not',
    'read. Your files on disk are authoritative: edit them directly, and follow',
    'links from the index when more detail is relevant.',
    '',
    '### memory/index.md',
    '',
    '',
  ].join('\n');
  const after = ['', '', '### Memory definition (read-only)', '', readMemoryFile(definition.file), ''].join('\n');

  return before + fitIndex(index, MEMORY_SECTION_BUDGET_CHARS - before.length - after.length) + after;
}

function readMemoryFile(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf-8').trim();
  } catch {
    return '(unavailable during this hook invocation)';
  }
}

/** Cut the index from its end to `room` characters, at a line end where there is one, and say where the rest is. */
function fitIndex(index: string, room: number): string {
  if (index.length <= room) return index;

  let kept = index.slice(0, Math.max(0, room - MEMORY_TRUNCATION_NOTICE.length - 1));
  const lineEnd = kept.lastIndexOf('\n');
  if (lineEnd > 0) kept = kept.slice(0, lineEnd);
  const last = kept.charCodeAt(kept.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) kept = kept.slice(0, -1);
  return `${kept.trimEnd()}\n${MEMORY_TRUNCATION_NOTICE}`;
}
