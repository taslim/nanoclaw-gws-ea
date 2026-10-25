import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import { renderMemorySection } from './context.js';

const MEMORY_CONTEXT_SOURCES = ['startup', 'resume', 'clear', 'compact'] as const;

export type MemorySessionHookSource = (typeof MEMORY_CONTEXT_SOURCES)[number];
export type MemorySessionStartSource = MemorySessionHookSource;

/**
 * Where the hook keeps a fingerprint of the section it last delivered to each
 * provider session: the NanoClaw session's own host-backed workspace, which
 * outlives the container and is never shared with another session's.
 */
export const MEMORY_DELIVERY_STATE_DIR = '/workspace/.memory-delivered';

export interface MemorySessionHookRegistration {
  readonly command: string;
  readonly legacyCommands: readonly string[];
  /** Empty means memory is off: no hook is installed, and any earlier one is removed. */
  readonly sources: readonly MemorySessionHookSource[];
}

export const MEMORY_SESSION_HOOK: MemorySessionHookRegistration = {
  command: 'bun /app/src/memory/hook.ts',
  legacyCommands: ['bun /app/src/memory-hook.ts'],
  sources: MEMORY_CONTEXT_SOURCES,
};

/**
 * A sealed session's registration (./sealed.ts): it keeps no group memory,
 * so no session-start hook injects it. The commands stay named so a
 * provider removes one an earlier registration installed.
 */
export const SEALED_MEMORY_SESSION_HOOK: MemorySessionHookRegistration = {
  command: MEMORY_SESSION_HOOK.command,
  legacyCommands: MEMORY_SESSION_HOOK.legacyCommands,
  sources: [],
};

/** `id` is the provider's session id, as the hook input names it. */
export interface MemoryHookSession {
  readonly id: string;
  readonly stateDir?: string;
}

/**
 * A new context window (startup, clear, compact) always gets it. A resumed
 * one already holds the section last delivered to it, so it gets the section
 * only when that changed: an unchanged section would only grow the context
 * toward compaction on every respawn. A resume the hook cannot key to a
 * session gets nothing, as it can't tell what that session holds.
 *
 * This records nothing: the caller records the section with
 * `recordMemoryDelivered` once it has handed it to the provider, so a section
 * that never arrives is offered again on the next resume instead of skipped.
 */
export function memoryContextForSessionStart(
  source: MemorySessionStartSource,
  baseDir?: string,
  session?: MemoryHookSession,
): string | undefined {
  if (!session) return source === 'resume' ? undefined : renderMemorySection(baseDir);

  const section = renderMemorySection(baseDir);
  if (source === 'resume' && readFingerprint(fingerprintFile(session)) === fingerprintOf(section)) return undefined;
  return section;
}

export function recordMemoryDelivered(session: MemoryHookSession, section: string): void {
  writeFingerprint(fingerprintFile(session), fingerprintOf(section));
}

function fingerprintFile(session: MemoryHookSession): string {
  return path.join(session.stateDir ?? MEMORY_DELIVERY_STATE_DIR, fingerprintOf(session.id));
}

function fingerprintOf(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function readFingerprint(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return undefined;
  }
}

/** Best effort: a fingerprint that can't be kept only means the next resume delivers the section again. */
function writeFingerprint(file: string, fingerprint: string): void {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temporary, fingerprint);
    fs.renameSync(temporary, file);
  } catch {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // Nothing was written where the state directory should be.
    }
  }
}
