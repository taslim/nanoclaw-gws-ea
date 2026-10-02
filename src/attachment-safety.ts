import { createHash } from 'crypto';
import path from 'path';

/**
 * Is `name` safe to use as the last segment of a path inside an
 * attachment-staging directory? Filenames originate from untrusted sources —
 * channel messages from any chat participant, agent-to-agent forwards from
 * a possibly-compromised peer agent — and land in `path.join(dir, name)`
 * sinks on the host. Without this guard, a `..`-laden name escapes the
 * inbox and writes anywhere the host process has filesystem permission.
 *
 * Rejects:
 *   - non-string / empty
 *   - `.` / `..` (traversal sentinels that path.basename returns as-is)
 *   - anything containing a path separator (`/` or `\`) or NUL
 *   - any value where `path.basename(name) !== name`, catching OS-specific
 *     separators and covering drives/prefixes on Windows runtimes
 */
export function isSafeAttachmentName(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0) return false;
  if (name === '.' || name === '..') return false;
  if (/[\\/\0]/.test(name)) return false;
  return path.basename(name) === name;
}

/**
 * The inbox folder for a message's attachments. A platform message ID that is
 * already a safe file name names it directly; any other ID, such as a Google
 * Chat ID (`spaces/…/messages/…`), names it by a hash, so its attachments are
 * kept instead of refused.
 */
export function inboxFolderName(messageId: string): string {
  return isSafeAttachmentName(messageId)
    ? messageId
    : `msg-${createHash('sha256').update(messageId).digest('hex').slice(0, 32)}`;
}
