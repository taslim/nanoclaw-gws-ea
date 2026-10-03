import { renderMemorySection } from './context.js';

const MEMORY_CONTEXT_SOURCES = ['startup', 'clear', 'compact'] as const;

export type MemorySessionHookSource = (typeof MEMORY_CONTEXT_SOURCES)[number];
export type MemorySessionStartSource = MemorySessionHookSource | 'resume';

export interface MemorySessionHookRegistration {
  readonly command: string;
  readonly legacyCommands: readonly string[];
  /** When the hook injects memory. None means memory is off: no hook is installed, and any earlier one is removed. */
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

/** Return memory only when a provider is establishing a new context window. */
export function memoryContextForSessionStart(source: MemorySessionStartSource, baseDir?: string): string | undefined {
  return source === 'resume' ? undefined : renderMemorySection(baseDir);
}
