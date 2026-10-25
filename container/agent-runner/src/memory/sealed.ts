/**
 * Sealed sessions: the runner half of the host's `conversation-context`
 * capability (src/capabilities.ts). A group without that key keeps its
 * sessions sealed, so nothing of one session reaches another. Group memory
 * (`/workspace/agent/memory/`) and the conversation archive
 * (`/workspace/agent/conversations/`) are shared by every session of a
 * group, so a sealed session keeps neither: the runner creates no memory
 * scaffold, installs no memory hook, and archives no conversation.
 */
import { ensureMemoryScaffold } from './scaffold.js';
import {
  MEMORY_SESSION_HOOK,
  SEALED_MEMORY_SESSION_HOOK,
  type MemorySessionHookRegistration,
} from './session-hook.js';

export const CONVERSATION_CONTEXT_CAPABILITY = 'conversation-context';

/** A missing capability list holds nothing, so its sessions are sealed. */
export function sessionsSealed(capabilities: ReadonlySet<string>): boolean {
  return !capabilities.has(CONVERSATION_CONTEXT_CAPABILITY);
}

export function prepareSessionMemory(sealed: boolean, baseDir?: string): MemorySessionHookRegistration {
  if (sealed) return SEALED_MEMORY_SESSION_HOOK;
  ensureMemoryScaffold(baseDir);
  return MEMORY_SESSION_HOOK;
}
