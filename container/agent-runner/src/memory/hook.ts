import fs from 'fs';

import {
  MEMORY_SESSION_HOOK,
  memoryContextForSessionStart,
  recordMemoryDelivered,
  type MemoryHookSession,
  type MemorySessionStartSource,
} from './session-hook.js';

interface MemoryHookInput {
  readonly source: MemorySessionStartSource;
  readonly sessionId?: string;
}

function readInput(): MemoryHookInput | undefined {
  try {
    const input: unknown = JSON.parse(fs.readFileSync(0, 'utf-8'));
    if (!input || typeof input !== 'object' || !('source' in input)) return undefined;
    const source = input.source;
    const validSources: readonly unknown[] = MEMORY_SESSION_HOOK.sources;
    if (!validSources.includes(source)) return undefined;
    const sessionId =
      'session_id' in input && typeof input.session_id === 'string' && input.session_id ? input.session_id : undefined;
    return { source: source as MemorySessionStartSource, sessionId };
  } catch {
    // Invalid hook input fails closed: no additional context is emitted.
  }
  return undefined;
}

// Tests pass the agent folder and the state directory; the registered command passes neither.
const input = readInput();
const session: MemoryHookSession | undefined = input?.sessionId
  ? { id: input.sessionId, stateDir: process.argv[3] }
  : undefined;
const context = input ? memoryContextForSessionStart(input.source, process.argv[2], session) : undefined;
if (context) {
  // Print before recording, and print synchronously so a failed write throws:
  // a section recorded but never printed would be skipped by the next resume.
  writeStdout(`${context}\n`);
  if (session) recordMemoryDelivered(session, context);
}

function writeStdout(text: string): void {
  const bytes = Buffer.from(text, 'utf-8');
  for (let offset = 0; offset < bytes.length; ) offset += fs.writeSync(1, bytes, offset);
}
