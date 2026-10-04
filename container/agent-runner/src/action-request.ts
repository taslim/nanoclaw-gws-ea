/**
 * A typed request to the host, answered with an `action_response` (the
 * host's `writeActionResponse` in src/cli/delivery-action.ts).
 *
 * The request is a `system` message in the outbound mailbox whose
 * `requestId` is the id of that same message, so the host keys its side
 * effects on it and a replayed delivery returns the first answer. The tool
 * then polls the inbound mailbox for the answer carrying its `requestId`,
 * the same lookup `ncl` uses (the mailbox's `findCliResponse`, named for the
 * CLI bridge that first used it), and marks it completed.
 */
import { setTimeout as sleep } from 'node:timers/promises';

import { findCliResponse, markCompleted } from './db/messages-in.js';
import { writeMessageOut } from './db/messages-out.js';

/** The host's answer: mirrors `ResponseFrame` in src/cli/frame.ts. */
export type ActionResponseFrame =
  | { readonly id: string; readonly ok: true; readonly data: unknown }
  | { readonly id: string; readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

export type ActionRequestResult =
  | { readonly status: 'answered'; readonly frame: ActionResponseFrame }
  | { readonly status: 'timeout' }
  | { readonly status: 'cancelled' };

export interface ActionRequestOptions {
  /** How long to wait for the host's answer. */
  readonly timeoutMs: number;
  /** How often to look for it; 500 ms by default. */
  readonly pollMs?: number;
  readonly signal?: AbortSignal;
}

function newRequestId(): string {
  return `act-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The frame an answer row carries; an unreadable one is answered as a transport error. */
function frameOf(content: string, requestId: string): ActionResponseFrame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    parsed = undefined;
  }
  const frame = isRecord(parsed) ? parsed.frame : undefined;
  if (isRecord(frame) && frame.ok === true) return { id: requestId, ok: true, data: frame.data };
  if (
    isRecord(frame) &&
    frame.ok === false &&
    isRecord(frame.error) &&
    typeof frame.error.code === 'string' &&
    typeof frame.error.message === 'string'
  ) {
    return { id: requestId, ok: false, error: { code: frame.error.code, message: frame.error.message } };
  }
  return { id: requestId, ok: false, error: { code: 'transport-error', message: "The host's answer was unreadable" } };
}

/**
 * Send `action` with `fields` to the host and wait for its answer. The action
 * name and request id are set here and never taken from `fields`.
 */
export async function requestAction(
  action: string,
  fields: Readonly<Record<string, unknown>>,
  options: ActionRequestOptions,
): Promise<ActionRequestResult> {
  const { signal } = options;
  if (signal?.aborted) return { status: 'cancelled' };
  const requestId = newRequestId();
  await writeMessageOut({
    id: requestId,
    kind: 'system',
    content: JSON.stringify({ ...fields, action, requestId }),
  });

  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    if (signal?.aborted) return { status: 'cancelled' };
    const answer = findCliResponse(requestId);
    if (answer) {
      markCompleted([answer.id]);
      return { status: 'answered', frame: frameOf(answer.content, requestId) };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { status: 'timeout' };
    try {
      await sleep(Math.min(options.pollMs ?? 500, remaining), undefined, { signal });
    } catch (error) {
      if (signal?.aborted) return { status: 'cancelled' };
      throw error;
    }
  }
}
