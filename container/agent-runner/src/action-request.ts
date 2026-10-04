/**
 * A typed request to the host, answered with an `action_response` (the
 * host's `writeActionResponse` in src/cli/delivery-action.ts).
 *
 * The request is a `system` message in the outbound mailbox whose
 * `requestId` is the id of that same message, so the host keys its side
 * effects on it and a replayed delivery returns the first answer. The tool
 * then polls the inbound mailbox for the answer, which the host files under
 * an id made from the `requestId`, and marks it completed. An answer that
 * comes after the tool stopped waiting stays in the mailbox, unseen by the
 * poll loop, and `request_status` reads it, as often as asked.
 *
 * `requestTool` makes a tool of one such request: the tool is named after
 * the action it sends, and its answer, or its timeout, is what the agent reads.
 */
import { setTimeout as sleep } from 'node:timers/promises';

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { getMessageIn, markCompleted } from './db/messages-in.js';
import { writeMessageOut } from './db/messages-out.js';
import type { McpToolDefinition } from './mcp-tools/types.js';

/** The host's answer: mirrors `ResponseFrame` in src/cli/frame.ts. */
export type ActionResponseFrame =
  | { readonly id: string; readonly ok: true; readonly data: unknown }
  | { readonly id: string; readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

export type ActionRequestResult =
  | { readonly status: 'answered'; readonly frame: ActionResponseFrame }
  /** No answer yet: the request may still go through, and `requestId` finds its answer later (`readAnswer`). */
  | { readonly status: 'timeout'; readonly requestId: string }
  | { readonly status: 'cancelled' };

export interface ActionRequestOptions {
  /** How long to wait for the host's answer. */
  readonly timeoutMs: number;
  /** How often to look for it; 500 ms by default. */
  readonly pollMs?: number;
  readonly signal?: AbortSignal;
  /**
   * The request's id, when the caller staged something under it first, such
   * as files in the outbox (`newRequestId`); a new one otherwise.
   */
  readonly requestId?: string;
}

export function newRequestId(): string {
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
 * The host's answer to one of this session's requests, once it has come; it
 * is marked completed as it is read. It is found by its id
 * (`writeActionResponse` in src/cli/delivery-action.ts), whatever its
 * status, so a second read still finds an answer the host has since filed
 * as completed. A session's mailbox holds only its own requests' answers.
 */
export function readAnswer(requestId: string): ActionResponseFrame | undefined {
  const answer = getMessageIn(`action-resp-${requestId}`);
  if (!answer) return undefined;
  markCompleted([answer.id]);
  return frameOf(answer.content, requestId);
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
  const requestId = options.requestId ?? newRequestId();
  await writeMessageOut({
    id: requestId,
    kind: 'system',
    content: JSON.stringify({ ...fields, action, requestId }),
  });

  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    if (signal?.aborted) return { status: 'cancelled' };
    const frame = readAnswer(requestId);
    if (frame) return { status: 'answered', frame };
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { status: 'timeout', requestId };
    try {
      await sleep(Math.min(options.pollMs ?? 500, remaining), undefined, { signal });
    } catch (error) {
      if (signal?.aborted) return { status: 'cancelled' };
      throw error;
    }
  }
}

/** An answer as a tool returns it: its `message` when it carries one, a refusal as an error. */
export function answerResult(frame: ActionResponseFrame): CallToolResult {
  if (!frame.ok) return { content: [{ type: 'text', text: `Error: ${frame.error.message}` }], isError: true };
  const data = frame.data;
  const message = isRecord(data) && typeof data.message === 'string' ? data.message : JSON.stringify(data);
  return { content: [{ type: 'text', text: message }] };
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text: `Error: ${text}` }], isError: true };
}

/** A tool that sends one host action, by default the one of its own name. */
export interface RequestToolSpec {
  /** The tool's name. */
  readonly name: string;
  /** The host action it sends, when not its own name. */
  readonly action?: string;
  readonly description: string;
  /** The fields the tool takes; only these are sent. */
  readonly properties: Readonly<Record<string, object>>;
  readonly required: readonly string[];
  /** Whether making the same call again is safe: a repeat changes nothing twice. */
  readonly repeatable: boolean;
  readonly timeoutMs: number;
  /**
   * The request's fields made ready under its id, such as files staged in the
   * outbox, or why the call cannot go as asked. Runs before anything is sent.
   */
  readonly prepare?: (fields: Record<string, unknown>, requestId: string) => Record<string, unknown> | string;
}

/** What a timeout tells the agent: the request may still go through, and whether to repeat it. */
function timeoutText(requestId: string, repeatable: boolean): string {
  return (
    `The host has not answered request ${requestId} yet, and it may still go through. ` +
    (repeatable
      ? 'Check it with request_status, or make the same call again: a repeat changes nothing twice.'
      : 'Check it with request_status before you do anything else, and do not send it again.')
  );
}

/**
 * A tool that sends one request, named after itself unless it names another
 * action, and returns the host's answer. The host checks what each request means, so the tool checks only
 * that the required fields are there, and sends no field it does not take.
 */
export function requestTool(spec: RequestToolSpec): McpToolDefinition {
  return {
    tool: {
      name: spec.name,
      description: spec.description,
      inputSchema: { type: 'object', properties: { ...spec.properties }, required: [...spec.required] },
    },
    async handler(args, context) {
      const missing = spec.required.find((field) => args[field] === undefined || args[field] === null);
      if (missing !== undefined) return errorResult(`${missing} is required`);
      const signal = context?.signal;
      if (signal?.aborted) return errorResult('The request was cancelled before the host answered.');
      const given = Object.fromEntries(
        Object.keys(spec.properties).flatMap((field) => (args[field] === undefined ? [] : [[field, args[field]]])),
      );
      const requestId = newRequestId();
      const fields = spec.prepare ? spec.prepare(given, requestId) : given;
      if (typeof fields === 'string') return errorResult(fields);
      const result = await requestAction(spec.action ?? spec.name, fields, {
        timeoutMs: spec.timeoutMs,
        signal,
        requestId,
      });
      switch (result.status) {
        case 'cancelled':
          return errorResult('The request was cancelled before the host answered.');
        case 'timeout':
          return errorResult(timeoutText(result.requestId, spec.repeatable));
        case 'answered':
          return answerResult(result.frame);
        default: {
          const unreachable: never = result;
          throw new Error(`Unknown request result ${JSON.stringify(unreachable)}`);
        }
      }
    },
  };
}
