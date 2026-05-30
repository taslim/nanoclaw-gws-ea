/**
 * Context file IO for matters.
 *
 * Files live at `groups/main/matters/<id>.md`. The host is the sole writer
 * (via system actions); containers read the projection of the file content
 * stored alongside the row in `inbound.db`. Files are optional — a matter
 * can exist without one and an existing file can be purged for resolved
 * matters without affecting the row or its artifact links.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../../config.js';

const MAIN_GROUP_FOLDER = 'main';
const MATTERS_DIR_NAME = 'matters';

function mattersDir(): string {
  return path.resolve(GROUPS_DIR, MAIN_GROUP_FOLDER, MATTERS_DIR_NAME);
}

export function contextFilePath(matterId: number): string {
  return path.join(mattersDir(), `${matterId}.md`);
}

export function readContextFile(matterId: number): string | null {
  try {
    return fs.readFileSync(contextFilePath(matterId), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export function writeContextFile(matterId: number, content: string): void {
  fs.mkdirSync(mattersDir(), { recursive: true });
  fs.writeFileSync(contextFilePath(matterId), content);
}

// Header for the trust-laundering Pending section. Heartbeat sweep tags
// `has_pending` on a substring match; keep wording stable.
export const PENDING_SECTION_HEADER = '## Pending (untrusted — awaiting heartbeat review)';

// Strip structural markdown so an injected entry can't smuggle a section
// header or code fence past the host into the canonical log on promotion.
export function sanitizePendingEntry(raw: string): string {
  return raw
    .replace(/[\r\n]+/g, ' ')
    .replace(/`/g, "'")
    .replace(/^#+\s*/, '')
    .trim();
}

export function appendToPendingSection(existing: string | null, line: string): string {
  const body = existing ?? '';
  const headerIdx = body.indexOf(PENDING_SECTION_HEADER);
  if (headerIdx === -1) {
    const trimmed = body.replace(/\n+$/, '');
    const sep = trimmed === '' ? '' : '\n\n';
    return `${trimmed}${sep}${PENDING_SECTION_HEADER}\n${line}\n`;
  }
  const after = body.slice(headerIdx + PENDING_SECTION_HEADER.length);
  const nextSectionOffset = after.search(/\n## /);
  if (nextSectionOffset === -1) {
    const trimmed = body.replace(/\n+$/, '');
    return `${trimmed}\n${line}\n`;
  }
  const sectionEnd = headerIdx + PENDING_SECTION_HEADER.length + nextSectionOffset;
  const before = body.slice(0, sectionEnd).replace(/\n+$/, '');
  const rest = body.slice(sectionEnd).replace(/^\n+/, '');
  return `${before}\n${line}\n\n${rest}`;
}
