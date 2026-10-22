import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Create the agent's persistent memory scaffold, container-side, at boot.
 *
 * The runner owns its own workspace: it writes the memory tree straight into
 * `/workspace/agent` (the host-backed, RW group dir, so it persists across the
 * ephemeral container). No host-side step, nothing mounted in.
 *
 * The default memory files live as real markdown templates next to this module
 * (under `templates/`) — not as strings in code — so the
 * doctrine is editable as markdown and the agent receives an unescaped copy.
 * They ship in the mounted `/app/src` tree, so no image change is needed.
 *
 * Idempotent — only writes what's missing, so the agent's own edits and
 * accumulated memory are never clobbered on a later wake. Every provider uses
 * the same tree.
 *
 * Only the index is seeded. The memory definition comes from the release
 * (context.ts), so `templates/system/` is no longer copied, and a copy an
 * earlier release seeded stays on disk unread.
 */
const TEMPLATES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'templates');

export function ensureMemoryScaffold(baseDir = '/workspace/agent'): void {
  const memoryDir = path.join(baseDir, 'memory');

  fs.mkdirSync(memoryDir, { recursive: true });

  copyTemplateIfMissing('index.md', path.join(memoryDir, 'index.md'));
}

function copyTemplateIfMissing(template: string, dest: string): void {
  try {
    fs.copyFileSync(path.join(TEMPLATES_DIR, template), dest, fs.constants.COPYFILE_EXCL);
  } catch (err) {
    if (typeof err !== 'object' || err === null || !('code' in err) || err.code !== 'EEXIST') throw err;
  }
}
