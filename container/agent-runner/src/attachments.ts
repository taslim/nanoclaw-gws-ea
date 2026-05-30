/**
 * Builds Anthropic-shaped image / document blocks from inbound message
 * attachments the active provider can ingest natively. Caller passes the
 * provider's supported mime set; everything outside it stays out of the
 * returned blocks and falls through to the formatter's text annotation.
 */
import { promises as fs } from 'fs';
import path from 'path';

import type { MessageInRow } from './db/messages-in.js';

export type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
export type DocumentMediaType = 'application/pdf';

export const IMAGE_MIME_TYPES: readonly ImageMediaType[] = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
export const PDF_MIME_TYPE: DocumentMediaType = 'application/pdf';

export type InlineAttachmentBlock =
  | { type: 'image'; source: { type: 'base64'; media_type: ImageMediaType; data: string } }
  | { type: 'document'; source: { type: 'base64'; media_type: DocumentMediaType; data: string }; title?: string };

export interface InlineAttachmentSelection {
  blocks: InlineAttachmentBlock[];
  /** localPath values that were inlined — used by the formatter to suppress duplicate text annotations. */
  inlinedPaths: ReadonlySet<string>;
}

// Under Anthropic's 32MB / 5MB native-ingest caps with headroom for
// multipart envelope overhead.
const MB = 1024 * 1024;
const MAX_PDF_BYTES = 30 * MB;
const MAX_IMAGE_BYTES = 4.5 * MB;

const IMAGE_TYPE_SET = new Set<ImageMediaType>(IMAGE_MIME_TYPES);

function log(msg: string): void {
  console.error(`[attachments] ${msg}`);
}

interface RawAttachment {
  name?: unknown;
  mimeType?: unknown;
  localPath?: unknown;
}

function parseContent(json: string): { attachments?: unknown } {
  try {
    return JSON.parse(json) as { attachments?: unknown };
  } catch {
    return {};
  }
}

function isImage(mime: string): mime is ImageMediaType {
  return IMAGE_TYPE_SET.has(mime as ImageMediaType);
}

// Defense-in-depth read-side check; host already validates on write.
function resolveInsideWorkspace(workspaceRoot: string, localPath: string): string | null {
  const root = path.resolve(workspaceRoot);
  const abs = path.resolve(root, localPath);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

interface Candidate {
  raw: RawAttachment;
  mime: string;
  localPath: string;
  abs: string;
}

function pickCandidate(
  raw: RawAttachment,
  supportedTypes: ReadonlySet<string>,
  workspaceRoot: string,
): Candidate | null {
  const mime = typeof raw.mimeType === 'string' ? raw.mimeType.toLowerCase() : '';
  const localPath = typeof raw.localPath === 'string' ? raw.localPath : '';
  if (!mime || !localPath) return null;
  if (!supportedTypes.has(mime)) return null;

  const abs = resolveInsideWorkspace(workspaceRoot, localPath);
  if (!abs) {
    log(`refusing localPath that escapes workspace: ${localPath}`);
    return null;
  }
  return { raw, mime, localPath, abs };
}

async function readBlock(c: Candidate): Promise<InlineAttachmentBlock | null> {
  let stat;
  try {
    stat = await fs.stat(c.abs);
  } catch (err) {
    log(`stat failed for ${c.abs}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  if (!stat.isFile()) return null;

  const limit = c.mime === PDF_MIME_TYPE ? MAX_PDF_BYTES : MAX_IMAGE_BYTES;
  if (stat.size > limit) {
    log(`skipping ${c.localPath} (${stat.size}B > ${limit}B for ${c.mime})`);
    return null;
  }

  let data: string;
  try {
    data = (await fs.readFile(c.abs)).toString('base64');
  } catch (err) {
    log(`read failed for ${c.abs}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  if (c.mime === PDF_MIME_TYPE) {
    const title = typeof c.raw.name === 'string' && c.raw.name ? c.raw.name : undefined;
    return {
      type: 'document',
      source: { type: 'base64', media_type: PDF_MIME_TYPE, data },
      ...(title ? { title } : {}),
    };
  }
  if (isImage(c.mime)) {
    return { type: 'image', source: { type: 'base64', media_type: c.mime, data } };
  }
  return null;
}

export async function gatherInlineAttachments(
  messages: MessageInRow[],
  supportedTypes: ReadonlySet<string>,
  workspaceRoot: string,
): Promise<InlineAttachmentSelection> {
  if (supportedTypes.size === 0) return { blocks: [], inlinedPaths: new Set() };

  const candidates: Candidate[] = [];
  for (const msg of messages) {
    const parsed = parseContent(msg.content);
    const atts = parsed.attachments;
    if (!Array.isArray(atts)) continue;
    for (const raw of atts as RawAttachment[]) {
      const c = pickCandidate(raw, supportedTypes, workspaceRoot);
      if (c) candidates.push(c);
    }
  }

  const settled = await Promise.all(candidates.map(readBlock));

  const blocks: InlineAttachmentBlock[] = [];
  const inlined = new Set<string>();
  for (let i = 0; i < settled.length; i++) {
    const block = settled[i];
    if (!block) continue;
    blocks.push(block);
    inlined.add(candidates[i].localPath);
  }
  return { blocks, inlinedPaths: inlined };
}
